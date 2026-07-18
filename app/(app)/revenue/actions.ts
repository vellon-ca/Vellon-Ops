"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { mgcjSupabase } from "@/lib/connectors/mgcj";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { getPlatformSettings } from "@/app/(app)/configuration/actions";
import { buildInvoicePdf } from "@/lib/pdf/invoice";

const RESEND_FROM_ADDRESS = "billing@vellon.ca";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Turn a "migration not applied yet" PostgREST error into an actionable message
// (mirrors the graceful degradation in the Health module). Returns null for any
// other error so real failures aren't masked.
function missingMigrationMsg(err: {
  code?: string;
  message: string;
}): string | null {
  const missing =
    err.code === "PGRST202" || // RPC not found
    err.code === "PGRST205" || // table not found in schema cache
    /could not find|does not exist|not find the function|schema cache/i.test(
      err.message,
    );
  return missing
    ? "Revenue needs three migrations applied, in order: 20260718_ride_completed_at.sql then 20260714_ops_revenue.sql in the mgcj SQL editor (then NOTIFY pgrst, 'reload schema'), and 0002_invoices.sql in the vellon-ops hub SQL editor."
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
    { name: string; feePct: number; fares: number; rides: number }
  >();
  for (const r of rows) {
    if (r.payment_method !== "cash") continue;
    const e =
      perCompany.get(r.company_id) ??
      { name: r.company_name, feePct: r.fee_percent, fares: 0, rides: 0 };
    e.fares += r.fares_total;
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
    `MGCJ-${yyyymm}-${companyId.slice(0, 6)}`;

  const toUpsert = [...perCompany.entries()]
    .filter(([companyId, e]) => e.fares > 0 && !locked.has(companyId))
    .map(([companyId, e]) => ({
      project_slug: "mgcj",
      company_id: companyId,
      company_name: e.name,
      period_month: first,
      cash_fares_total: round2(e.fares),
      fee_percent: e.feePct,
      amount_due: round2((e.fares * e.feePct) / 100),
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

// Generate the PDF (if needed) and email it to the company's billing contact,
// then flip the invoice to sent. Regenerates the PDF fresh every call — drafts
// can still change up until sent/paid locks them, so there's no staleness risk
// worth caching against.
export async function sendInvoice(input: {
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();

  const { data: invoice, error: invErr } = await supabaseAdmin
    .from("invoices")
    .select(
      "id, company_id, company_name, period_month, cash_fares_total, fee_percent, ride_count, amount_due, invoice_number, status",
    )
    .eq("id", input.id)
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
  if (!company?.billing_email) {
    return {
      ok: false,
      error: "Add a billing email for this company first (Companies → Edit).",
    };
  }

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
  const invoiceNumber = invoice.invoice_number ?? `MGCJ-${invoice.id.slice(0, 8).toUpperCase()}`;

  const pdfBytes = await buildInvoicePdf({
    invoiceNumber,
    periodLabel,
    issueDate,
    companyName: invoice.company_name,
    billingAddress: company.billing_address,
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

  const base64Pdf = Buffer.from(pdfBytes).toString("base64");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM_ADDRESS,
      to: company.billing_email,
      subject: `${invoiceNumber} — ${invoice.company_name} platform fee invoice (${periodLabel})`,
      html: `<p>Attached is your platform fee invoice for ${periodLabel} — $${Number(invoice.amount_due).toFixed(2)} due.</p>`,
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
    .update({ status: "sent", sent_at: new Date().toISOString(), pdf_path: pdfPath })
    .eq("id", input.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "invoice.send",
    target: input.id,
    after: { billing_email: company.billing_email, pdf_path: pdfPath },
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
