"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { mgcjSupabase, stripeGet, stripeConfigured } from "@/lib/connectors/mgcj";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { getPlatformSettings } from "@/app/(app)/configuration/actions";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import { buildInvoiceEmailHtml } from "@/lib/email/invoiceEmail";

const RESEND_FROM_ADDRESS = "Vellon <billing@vellon.ca>";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Turn a "migration not applied yet" PostgREST error into an actionable message
// (mirrors the graceful degradation in the Health module). Returns null for any
// other error so real failures aren't masked.
function isMissingSchema(err: { code?: string; message: string }): boolean {
  return (
    err.code === "PGRST202" || // RPC not found
    err.code === "PGRST205" || // table not found in schema cache
    /could not find|does not exist|not find the function|schema cache/i.test(
      err.message,
    )
  );
}

function missingMigrationMsg(err: {
  code?: string;
  message: string;
}): string | null {
  return isMissingSchema(err)
    ? "Revenue needs four migrations applied, in order: 20260718_ride_completed_at.sql, 20260714_ops_revenue.sql, then 20260719_ride_fee_percent_snapshot.sql in the mgcj SQL editor (then NOTIFY pgrst, 'reload schema'), and 0002_invoices.sql in the vellon-ops hub SQL editor."
    : null;
}

// Dispute costs live in their own table with their own migration — point at
// that one rather than the Revenue list, which would send you to the wrong
// SQL editor entirely.
function missingDisputeMigrationMsg(err: {
  code?: string;
  message: string;
}): string | null {
  return isMissingSchema(err)
    ? "Dispute costs need 0006_dispute_costs.sql applied in the vellon-ops hub SQL editor (not the mgcj one)."
    : null;
}

// One row of the ops_revenue RPC (per company × month × payment_method).
type RevRow = {
  company_id: string;
  company_name: string;
  fee_percent: number;
  month: string; // 'YYYY-MM-DD' (first of month, UTC)
  payment_method: string;
  ride_count: number;
  fares_total: number;
  fee_total: number;
};

export type RevenueSummary = {
  from: string;
  to: string;
  totals: {
    fares: number;
    fee: number;
    cardFee: number;
    cashFee: number;
    rides: number;
  };
  byCompany: {
    companyId: string;
    companyName: string;
    cardFee: number;
    cashFee: number;
    totalFee: number;
    rides: number;
    fares: number;
  }[];
  byMonth: { month: string; cardFee: number; cashFee: number; totalFee: number }[];
};

async function fetchRevRows(fromISO: string, toISO: string): Promise<RevRow[]> {
  const mgcj = mgcjSupabase();
  const { data, error } = await mgcj.rpc("ops_revenue", {
    p_from: fromISO,
    p_to: toISO,
  });
  if (error) throw new Error(missingMigrationMsg(error) ?? error.message);
  return (data ?? []).map((r: RevRow) => ({
    ...r,
    fee_percent: Number(r.fee_percent),
    ride_count: Number(r.ride_count),
    fares_total: Number(r.fares_total),
    fee_total: Number(r.fee_total),
  }));
}

// Contiguous list of UTC month-firsts ('YYYY-MM-01') in [fromISO, toISO). Used
// to zero-fill months with no rides so charts show a real axis, not a compressed
// one that omits empty months and mis-highlights the latest point.
function enumerateMonths(fromISO: string, toISO: string): string[] {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (d < to) {
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`,
    );
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// UTC month bounds. month = 'YYYY-MM'.
function monthBounds(month: string): { start: string; next: string; first: string } {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  return {
    start: start.toISOString(),
    next: next.toISOString(),
    first: start.toISOString().slice(0, 10),
  };
}

export async function getRevenue(input: {
  fromISO: string;
  toISO: string;
}): Promise<{ ok: true; data: RevenueSummary } | { ok: false; error: string }> {
  await requirePlatformOwner();
  try {
    const rows = await fetchRevRows(input.fromISO, input.toISO);

    const totals = { fares: 0, fee: 0, cardFee: 0, cashFee: 0, rides: 0 };
    const companies = new Map<string, RevenueSummary["byCompany"][number]>();
    const months = new Map<string, RevenueSummary["byMonth"][number]>();

    for (const r of rows) {
      const isCard = r.payment_method === "card";
      totals.fares += r.fares_total;
      totals.fee += r.fee_total;
      totals.rides += r.ride_count;
      if (isCard) totals.cardFee += r.fee_total;
      else totals.cashFee += r.fee_total;

      const c =
        companies.get(r.company_id) ??
        {
          companyId: r.company_id,
          companyName: r.company_name,
          cardFee: 0,
          cashFee: 0,
          totalFee: 0,
          rides: 0,
          fares: 0,
        };
      c.totalFee += r.fee_total;
      c.rides += r.ride_count;
      c.fares += r.fares_total;
      if (isCard) c.cardFee += r.fee_total;
      else c.cashFee += r.fee_total;
      companies.set(r.company_id, c);

      const mo =
        months.get(r.month) ??
        { month: r.month, cardFee: 0, cashFee: 0, totalFee: 0 };
      mo.totalFee += r.fee_total;
      if (isCard) mo.cardFee += r.fee_total;
      else mo.cashFee += r.fee_total;
      months.set(r.month, mo);
    }

    const fix = (n: number) => round2(n);
    return {
      ok: true,
      data: {
        from: input.fromISO,
        to: input.toISO,
        totals: {
          fares: fix(totals.fares),
          fee: fix(totals.fee),
          cardFee: fix(totals.cardFee),
          cashFee: fix(totals.cashFee),
          rides: totals.rides,
        },
        byCompany: [...companies.values()]
          .map((c) => ({
            ...c,
            cardFee: fix(c.cardFee),
            cashFee: fix(c.cashFee),
            totalFee: fix(c.totalFee),
            fares: fix(c.fares),
          }))
          .sort((a, b) => b.totalFee - a.totalFee),
        // Zero-filled across the full requested range so a month with no rides
        // shows as an empty slot, not a gap the chart silently collapses.
        byMonth: enumerateMonths(input.fromISO, input.toISO).map((month) => {
          const m = months.get(month);
          return {
            month,
            cardFee: fix(m?.cardFee ?? 0),
            cashFee: fix(m?.cashFee ?? 0),
            totalFee: fix(m?.totalFee ?? 0),
          };
        }),
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Invoices (hub DB) ───────────────────────────────────────────────
export type Invoice = {
  id: string;
  company_id: string;
  company_name: string;
  period_month: string;
  cash_fares_total: number;
  fee_percent: number;
  amount_due: number;
  ride_count: number;
  status: "draft" | "sent" | "paid" | "void";
  generated_at: string;
  sent_at: string | null;
  paid_at: string | null;
  invoice_number: string | null;
  pdf_path: string | null;
};

export async function listInvoices(input: {
  month?: string; // 'YYYY-MM'
}): Promise<{ ok: true; data: Invoice[] } | { ok: false; error: string }> {
  await requirePlatformOwner();
  let q = supabaseAdmin
    .from("invoices")
    .select("*")
    .eq("project_slug", "mgcj")
    .order("period_month", { ascending: false })
    .order("company_name", { ascending: true });
  if (input.month) q = q.eq("period_month", monthBounds(input.month).first);
  const { data, error } = await q;
  if (error) return { ok: false, error: missingMigrationMsg(error) ?? error.message };
  return { ok: true, data: (data ?? []) as Invoice[] };
}

// Generate/refresh DRAFT cash invoices for a month from live mgcj data.
// Never overwrites an invoice already marked sent/paid (those are locked).
export async function generateInvoices(input: {
  month: string; // 'YYYY-MM'
}): Promise<{ ok: true; data: Invoice[] } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();
  const { start, next, first } = monthBounds(input.month);

  let rows: RevRow[];
  try {
    rows = await fetchRevRows(start, next);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Cash fees per company for the month (RPC already groups by month/method,
  // but sum defensively in case of any boundary duplication).
  const perCompany = new Map<
    string,
    { name: string; feePct: number; fares: number; feeTotal: number; rides: number }
  >();
  for (const r of rows) {
    if (r.payment_method !== "cash") continue;
    const e =
      perCompany.get(r.company_id) ??
      { name: r.company_name, feePct: r.fee_percent, fares: 0, feeTotal: 0, rides: 0 };
    e.fares += r.fares_total;
    e.feeTotal += r.fee_total;
    e.rides += r.ride_count;
    e.feePct = r.fee_percent;
    e.name = r.company_name;
    perCompany.set(r.company_id, e);
  }

  // Existing invoices for the month — skip regenerating locked (sent/paid) ones.
  const { data: existing } = await supabaseAdmin
    .from("invoices")
    .select("company_id, status")
    .eq("project_slug", "mgcj")
    .eq("period_month", first);
  const locked = new Set(
    (existing ?? [])
      .filter((i) => i.status === "sent" || i.status === "paid")
      .map((i) => i.company_id),
  );

  // Deterministic — same company/month always yields the same number, so
  // regenerating a draft never reassigns it.
  const yyyymm = first.slice(0, 4) + first.slice(5, 7);
  const invoiceNumber = (companyId: string) =>
    `INV-${yyyymm}-${companyId.slice(0, 6)}`;

  const toUpsert = [...perCompany.entries()]
    .filter(([companyId, e]) => e.fares > 0 && !locked.has(companyId))
    .map(([companyId, e]) => ({
      project_slug: "mgcj",
      company_id: companyId,
      company_name: e.name,
      period_month: first,
      cash_fares_total: round2(e.fares),
      fee_percent: e.feePct,
      // Sourced from the RPC's own per-ride fee_total (frozen per-ride rate),
      // never re-derived from fares*feePct — a mid-period rate change means
      // feePct is only a blended display value, not something the dollar
      // amount can be recomputed from.
      amount_due: round2(e.feeTotal),
      ride_count: e.rides,
      status: "draft",
      generated_by: owner.id,
      generated_at: new Date().toISOString(),
      invoice_number: invoiceNumber(companyId),
    }));

  if (toUpsert.length > 0) {
    const { error } = await supabaseAdmin
      .from("invoices")
      .upsert(toUpsert, { onConflict: "project_slug,company_id,period_month" });
    if (error) return { ok: false, error: error.message };
    await writeAudit({
      actorUserId: owner.id,
      projectSlug: "mgcj",
      action: "invoices.generate",
      target: first,
      after: { month: input.month, count: toUpsert.length },
    });
  }

  return listInvoices({ month: input.month });
}

export async function updateInvoiceStatus(input: {
  id: string;
  status: "draft" | "sent" | "paid" | "void";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();
  const patch: Record<string, unknown> = { status: input.status };
  if (input.status === "sent") patch.sent_at = new Date().toISOString();
  if (input.status === "paid") patch.paid_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("invoices")
    .update(patch)
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "invoice.status",
    target: input.id,
    after: { status: input.status },
  });
  return { ok: true };
}

type BuiltInvoicePdf = {
  pdfBytes: Uint8Array;
  pdfPath: string;
  invoiceNumber: string;
  companyName: string;
  periodLabel: string;
  cashFaresTotal: number;
  feePercent: number;
  rideCount: number;
  amountDue: number;
  paymentInstructions: string | null;
  mailingAddress: string | null;
  billingEmail: string | null;
};

// Shared by sendInvoice and previewInvoicePdf: builds the PDF from current
// invoice/company/platform-settings data, uploads it (upsert — regenerating
// is always safe, drafts can still change up until sent/paid locks them), and
// stamps pdf_path. Deliberately doesn't require a billing_email — Preview and
// the manual-delivery path both need to work for companies that don't have
// one yet.
async function buildAndStoreInvoicePdf(
  invoiceId: string,
): Promise<{ ok: true; data: BuiltInvoicePdf } | { ok: false; error: string }> {
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from("invoices")
    .select(
      "id, company_id, company_name, period_month, cash_fares_total, fee_percent, ride_count, amount_due, invoice_number",
    )
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr) return { ok: false, error: invErr.message };
  if (!invoice) return { ok: false, error: "Invoice not found." };

  const mgcj = mgcjSupabase();
  const { data: company, error: companyErr } = await mgcj
    .from("companies")
    .select("billing_email, billing_address")
    .eq("id", invoice.company_id)
    .maybeSingle();
  if (companyErr) return { ok: false, error: companyErr.message };

  const settingsRes = await getPlatformSettings();
  if (!settingsRes.ok) return { ok: false, error: settingsRes.error };

  const periodLabel = new Date(invoice.period_month + "T00:00:00Z").toLocaleDateString(
    "en-CA",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
  const issueDate = new Date().toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const invoiceNumber = invoice.invoice_number ?? `INV-${invoice.id.slice(0, 8).toUpperCase()}`;

  const pdfBytes = await buildInvoicePdf({
    invoiceNumber,
    periodLabel,
    issueDate,
    companyName: invoice.company_name,
    billingAddress: company?.billing_address ?? null,
    cashFaresTotal: Number(invoice.cash_fares_total),
    feePercent: Number(invoice.fee_percent),
    rideCount: invoice.ride_count,
    amountDue: Number(invoice.amount_due),
    vellon: settingsRes.data,
  });

  const pdfPath = `mgcj/${invoice.company_id}/${invoice.period_month}.pdf`;
  const { error: uploadErr } = await supabaseAdmin.storage
    .from("invoices")
    .upload(pdfPath, Buffer.from(pdfBytes), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadErr) return { ok: false, error: uploadErr.message };

  const { error: updateErr } = await supabaseAdmin
    .from("invoices")
    .update({ pdf_path: pdfPath })
    .eq("id", invoiceId);
  if (updateErr) return { ok: false, error: updateErr.message };

  return {
    ok: true,
    data: {
      pdfBytes,
      pdfPath,
      invoiceNumber,
      companyName: invoice.company_name,
      periodLabel,
      cashFaresTotal: Number(invoice.cash_fares_total),
      feePercent: Number(invoice.fee_percent),
      rideCount: invoice.ride_count,
      amountDue: Number(invoice.amount_due),
      paymentInstructions: settingsRes.data.paymentInstructions,
      mailingAddress: settingsRes.data.mailingAddress,
      billingEmail: company?.billing_email ?? null,
    },
  };
}

// Generate/refresh the PDF and return a signed download URL — used for the
// "Preview / Download PDF" button, before or instead of sending. Same builder
// sendInvoice uses, just without emailing or touching status.
export async function previewInvoicePdf(input: {
  id: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const built = await buildAndStoreInvoicePdf(input.id);
  if (!built.ok) return built;
  return getInvoicePdfUrl({ pdfPath: built.data.pdfPath });
}

// Generate the PDF and email it to the company's billing contact, then flip
// the invoice to sent.
export async function sendInvoice(input: {
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();

  const built = await buildAndStoreInvoicePdf(input.id);
  if (!built.ok) return built;
  const {
    pdfBytes,
    pdfPath,
    invoiceNumber,
    companyName,
    periodLabel,
    cashFaresTotal,
    feePercent,
    rideCount,
    amountDue,
    paymentInstructions,
    mailingAddress,
    billingEmail,
  } = built.data;

  if (!billingEmail) {
    return {
      ok: false,
      error:
        "Add a billing email for this company first (Companies → Edit) — or use Preview / Download PDF to send it manually.",
    };
  }

  const base64Pdf = Buffer.from(pdfBytes).toString("base64");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM_ADDRESS,
      to: billingEmail,
      subject: `Your Vellon platform fee invoice for ${periodLabel} — $${amountDue.toFixed(2)} due`,
      html: buildInvoiceEmailHtml({
        companyName,
        invoiceNumber,
        periodLabel,
        amountDue,
        cashFaresTotal,
        feePercent,
        rideCount,
        paymentInstructions,
        mailingAddress,
      }),
      attachments: [
        { filename: `${invoiceNumber}.pdf`, content: base64Pdf, content_type: "application/pdf" },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: `Resend error: ${errText}` };
  }

  const { error: updateErr } = await supabaseAdmin
    .from("invoices")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", input.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "invoice.send",
    target: input.id,
    after: { billing_email: billingEmail, pdf_path: pdfPath },
  });

  return { ok: true };
}

export async function getInvoicePdfUrl(input: {
  pdfPath: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const { data, error } = await supabaseAdmin.storage
    .from("invoices")
    .createSignedUrl(input.pdfPath, 60 * 10); // 10 min
  if (error || !data) return { ok: false, error: error?.message ?? "Could not sign URL." };
  return { ok: true, url: data.signedUrl };
}

// ── Dispute costs (hub DB, synced from Stripe) ──────────────────────
// See supabase/migrations/0006_dispute_costs.sql for the full rationale.
// Short version: a chargeback costs Vellon the $15 dispute fee plus the
// original processing fee Stripe never gives back — money that touches no
// ride's settlement math and was previously tracked nowhere.

const cents = (n: number) => round2(n / 100);

type StripeBalanceTxn = { fee?: number };
type StripeDispute = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  created: number;
  payment_intent: string | { id: string } | null;
  charge: string | { id: string; balance_transaction?: string | StripeBalanceTxn } | null;
  balance_transactions?: StripeBalanceTxn[];
};

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

// Stripe never reopens a closed dispute, so these are terminal.
const CLOSED_STATUSES = new Set(["won", "lost", "warning_closed", "charge_refunded"]);

// Pull Vellon's platform-account disputes, attribute them to companies via the
// mgcj connector, and upsert into the hub. Idempotent — safe to run repeatedly.
// Disputes already recorded as closed are skipped (frozen), so a re-sync only
// ever touches still-open ones.
export async function syncDisputeCosts(): Promise<
  { ok: true; synced: number; skipped: number } | { ok: false; error: string }
> {
  const owner = await requirePlatformOwner();
  if (!stripeConfigured()) {
    return { ok: false, error: "Stripe not configured (MGCJ_STRIPE_SECRET missing)." };
  }

  try {
    // Which disputes are already frozen — don't re-read or re-write those.
    const { data: frozenRows, error: frozenErr } = await supabaseAdmin
      .from("dispute_costs")
      .select("stripe_dispute_id")
      .eq("project_slug", "mgcj")
      .eq("is_closed", true);
    if (frozenErr) {
      return { ok: false, error: missingDisputeMigrationMsg(frozenErr) ?? frozenErr.message };
    }
    const frozen = new Set((frozenRows ?? []).map((r) => r.stripe_dispute_id));

    // Page through every dispute on the platform account.
    const disputes: StripeDispute[] = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ limit: "100" });
      qs.append("expand[]", "data.balance_transactions");
      qs.append("expand[]", "data.charge.balance_transaction");
      if (startingAfter) qs.set("starting_after", startingAfter);

      const res = await stripeGet(`/disputes?${qs.toString()}`);
      if (res.error) return { ok: false, error: `Stripe: ${res.error.message}` };
      disputes.push(...(res.data as StripeDispute[]));
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1].id;
    }

    const pending = disputes.filter((d) => !frozen.has(d.id));
    if (pending.length === 0) {
      return { ok: true, synced: 0, skipped: disputes.length };
    }

    // Attribute to a company: dispute → payment_intent → rides. This path is
    // used rather than rides.stripe_dispute_id because it doesn't depend on
    // mgcj's webhook having fired for this dispute.
    const piIds = pending.map((d) => idOf(d.payment_intent)).filter(Boolean) as string[];
    const rideByPi = new Map<string, { id: string; company_id: string | null }>();
    const companyNames = new Map<string, string>();

    if (piIds.length > 0) {
      const mgcj = mgcjSupabase();
      const { data: rides, error: ridesErr } = await mgcj
        .from("rides")
        .select("id, company_id, stripe_payment_intent_id")
        .in("stripe_payment_intent_id", piIds);
      if (ridesErr) return { ok: false, error: `mgcj: ${ridesErr.message}` };

      for (const r of rides ?? []) {
        rideByPi.set(r.stripe_payment_intent_id, {
          id: r.id,
          company_id: r.company_id,
        });
      }

      const companyIds = [
        ...new Set((rides ?? []).map((r) => r.company_id).filter(Boolean)),
      ] as string[];
      if (companyIds.length > 0) {
        const { data: companies } = await mgcj
          .from("companies")
          .select("id, name")
          .in("id", companyIds);
        for (const c of companies ?? []) companyNames.set(c.id, c.name);
      }
    }

    const rows = pending.map((d) => {
      const piId = idOf(d.payment_intent);
      const ride = piId ? rideByPi.get(piId) : undefined;

      // Summed rather than hardcoded at $15: a won dispute appends a reversing
      // adjustment with a negative fee, so the sum collapses to 0 by itself
      // instead of needing a status branch.
      const disputeFee = (d.balance_transactions ?? []).reduce(
        (sum, bt) => sum + (bt.fee ?? 0),
        0,
      );

      const chargeBt =
        typeof d.charge === "object" && typeof d.charge?.balance_transaction === "object"
          ? d.charge.balance_transaction
          : null;
      const processingFee = chargeBt?.fee ?? 0;

      const isWon = d.status === "won";
      // On a win Vellon keeps the fare, so the processing fee is just the
      // ordinary cost of a completed ride — already accounted for in that
      // ride's settlement math, not a dispute cost. Open disputes count it:
      // the money is out of the balance right now, and lost is the default
      // outcome if nothing changes.
      const netCost = disputeFee + (isWon ? 0 : processingFee);

      return {
        project_slug: "mgcj",
        stripe_dispute_id: d.id,
        charge_id: idOf(d.charge),
        payment_intent_id: piId,
        company_id: ride?.company_id ?? null,
        company_name: ride?.company_id
          ? (companyNames.get(ride.company_id) ?? null)
          : null,
        ride_id: ride?.id ?? null,
        currency: d.currency,
        disputed_amount_cents: d.amount,
        dispute_fee_cents: disputeFee,
        processing_fee_cents: processingFee,
        net_cost_cents: netCost,
        status: d.status,
        reason: d.reason,
        is_closed: CLOSED_STATUSES.has(d.status),
        closed_at: CLOSED_STATUSES.has(d.status) ? new Date().toISOString() : null,
        opened_at: new Date(d.created * 1000).toISOString(),
        synced_at: new Date().toISOString(),
      };
    });

    const { error: upsertErr } = await supabaseAdmin
      .from("dispute_costs")
      .upsert(rows, { onConflict: "project_slug,stripe_dispute_id" });
    if (upsertErr) {
      return { ok: false, error: missingDisputeMigrationMsg(upsertErr) ?? upsertErr.message };
    }

    await writeAudit({
      actorUserId: owner.id,
      projectSlug: "mgcj",
      action: "disputes.sync",
      target: "stripe",
      after: { synced: rows.length, skipped: disputes.length - rows.length },
    });

    return { ok: true, synced: rows.length, skipped: disputes.length - rows.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type DisputeCosts = {
  totals: {
    count: number;
    openCount: number;
    disputeFees: number;
    processingFees: number;
    netCost: number;
  };
  byCompany: {
    companyId: string | null;
    companyName: string;
    count: number;
    netCost: number;
  }[];
  recent: {
    id: string;
    disputeId: string;
    companyName: string | null;
    status: string;
    reason: string | null;
    disputedAmount: number;
    netCost: number;
    openedAt: string;
    isClosed: boolean;
  }[];
};

// Bucketed by opened_at — when the money actually left Vellon's balance.
export async function getDisputeCosts(input: {
  fromISO: string;
  toISO: string;
}): Promise<{ ok: true; data: DisputeCosts } | { ok: false; error: string }> {
  await requirePlatformOwner();

  const { data, error } = await supabaseAdmin
    .from("dispute_costs")
    .select("*")
    .eq("project_slug", "mgcj")
    .gte("opened_at", input.fromISO)
    .lt("opened_at", input.toISO)
    .order("opened_at", { ascending: false });
  if (error)
    return { ok: false, error: missingDisputeMigrationMsg(error) ?? error.message };

  const rows = data ?? [];
  const totals = {
    count: rows.length,
    openCount: rows.filter((r) => !r.is_closed).length,
    disputeFees: cents(rows.reduce((s, r) => s + r.dispute_fee_cents, 0)),
    processingFees: cents(rows.reduce((s, r) => s + r.processing_fee_cents, 0)),
    netCost: cents(rows.reduce((s, r) => s + r.net_cost_cents, 0)),
  };

  const byCompany = new Map<string, DisputeCosts["byCompany"][number]>();
  for (const r of rows) {
    const key = r.company_id ?? "unattributed";
    const e =
      byCompany.get(key) ??
      {
        companyId: r.company_id,
        companyName: r.company_name ?? "Unattributed",
        count: 0,
        netCost: 0,
      };
    e.count += 1;
    e.netCost = round2(e.netCost + r.net_cost_cents / 100);
    byCompany.set(key, e);
  }

  return {
    ok: true,
    data: {
      totals,
      byCompany: [...byCompany.values()].sort((a, b) => b.netCost - a.netCost),
      recent: rows.slice(0, 25).map((r) => ({
        id: r.id,
        disputeId: r.stripe_dispute_id,
        companyName: r.company_name,
        status: r.status,
        reason: r.reason,
        disputedAmount: cents(r.disputed_amount_cents),
        netCost: cents(r.net_cost_cents),
        openedAt: r.opened_at,
        isClosed: r.is_closed,
      })),
    },
  };
}

// ── Stranded settlements (live from mgcj) ───────────────────────────
// Two settlement_route states leave money in the wrong place, in OPPOSITE
// directions — kept apart deliberately, because netting them would hide both:
//
//   reversal_failed   — a driver/company was paid, then a dispute pulled the
//                       fare back off Vellon's balance and the clawback
//                       failed. Vellon is OUT that money. A real loss.
//   retransfer_failed — Vellon WON a dispute and owes the driver their share,
//                       but the re-send failed. Vellon is HOLDING money it
//                       owes. A liability, not a loss.
//
// Deliberately NOT period-scoped, matching the reasoning on mgcj's Needs
// Attention list: these are outstanding todos, not historical stats. Resolved
// rows (settlement_resolved_at set by dispatch) drop off.
export type StrandedSettlements = {
  unrecovered: { count: number; amount: number }; // reversal_failed — loss
  owedToDrivers: { count: number; amount: number }; // retransfer_failed — liability
  byCompany: {
    companyId: string;
    companyName: string;
    unrecovered: number;
    owedToDrivers: number;
  }[];
};

export async function getStrandedSettlements(): Promise<
  { ok: true; data: StrandedSettlements } | { ok: false; error: string }
> {
  await requirePlatformOwner();
  try {
    const mgcj = mgcjSupabase();
    const { data, error } = await mgcj
      .from("rides")
      .select("id, company_id, settlement_route, transfer_amount_cents")
      .in("settlement_route", ["reversal_failed", "retransfer_failed"])
      .is("settlement_resolved_at", null);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const companyIds = [...new Set(rows.map((r) => r.company_id).filter(Boolean))];
    const names = new Map<string, string>();
    if (companyIds.length > 0) {
      const { data: companies } = await mgcj
        .from("companies")
        .select("id, name")
        .in("id", companyIds);
      for (const c of companies ?? []) names.set(c.id, c.name);
    }

    const out: StrandedSettlements = {
      unrecovered: { count: 0, amount: 0 },
      owedToDrivers: { count: 0, amount: 0 },
      byCompany: [],
    };
    const byCompany = new Map<string, StrandedSettlements["byCompany"][number]>();

    for (const r of rows) {
      // Null when Stripe's real fee was unreadable at capture. Counting it as
      // zero understates rather than inventing a number — the per-ride Needs
      // Attention list in mgcj-dashboard is where those get chased down.
      const amount = (r.transfer_amount_cents ?? 0) / 100;
      const isLoss = r.settlement_route === "reversal_failed";
      const bucket = isLoss ? out.unrecovered : out.owedToDrivers;
      bucket.count += 1;
      bucket.amount = round2(bucket.amount + amount);

      const key = r.company_id ?? "unattributed";
      const e =
        byCompany.get(key) ??
        {
          companyId: key,
          companyName: names.get(key) ?? "Unattributed",
          unrecovered: 0,
          owedToDrivers: 0,
        };
      if (isLoss) e.unrecovered = round2(e.unrecovered + amount);
      else e.owedToDrivers = round2(e.owedToDrivers + amount);
      byCompany.set(key, e);
    }

    out.byCompany = [...byCompany.values()].sort(
      (a, b) => b.unrecovered + b.owedToDrivers - (a.unrecovered + a.owedToDrivers),
    );
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
