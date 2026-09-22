"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import {
  loadSpoke,
  spokeSupabase,
  spokeStripeGet,
  spokeStripePost,
  spokeStripeConfigured,
  assertHubWritable,
  assertEmailAllowed,
  SpokeWriteBlocked,
  type Spoke,
} from "@/lib/connectors/spoke";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { getPlatformSettings } from "@/app/(app)/[slug]/configuration/actions";
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
  refund_total: number; // Vellon's realized loss from refunds (card-only)
};

export type RevenueSummary = {
  from: string;
  to: string;
  totals: {
    fares: number;
    fee: number; // NET of refunds
    cardFee: number; // NET of refunds (refunds are card-only)
    cashFee: number;
    refunds: number; // realized refund loss, netted out of fee/cardFee above
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

// Turns a gate refusal into the same { ok: false } shape every caller already
// renders. A blocked write is an expected outcome on a dev spoke, not a crash.
function blocked(e: unknown): { ok: false; error: string } | null {
  return e instanceof SpokeWriteBlocked ? { ok: false, error: e.message } : null;
}

async function fetchRevRows(
  spoke: Spoke,
  fromISO: string,
  toISO: string,
): Promise<RevRow[]> {
  const mgcj = spokeSupabase(spoke);
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
    refund_total: Number(r.refund_total ?? 0),
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

export async function getRevenue(
  slug: string,
  input: {
  fromISO: string;
  toISO: string;
  },
): Promise<{ ok: true; data: RevenueSummary } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    const rows = await fetchRevRows(spoke, input.fromISO, input.toISO);

    const totals = { fares: 0, fee: 0, cardFee: 0, cashFee: 0, refunds: 0, rides: 0 };
    const companies = new Map<string, RevenueSummary["byCompany"][number]>();
    const months = new Map<string, RevenueSummary["byMonth"][number]>();

    for (const r of rows) {
      const isCard = r.payment_method === "card";
      // Net Vellon's realized refund loss out of the fee. Refunds are card-only
      // (refund_total is 0 on cash rows), so this only ever reduces card fees —
      // cardFee + cashFee still equals totalFee.
      const netFee = r.fee_total - r.refund_total;
      totals.fares += r.fares_total;
      totals.fee += netFee;
      totals.refunds += r.refund_total;
      totals.rides += r.ride_count;
      if (isCard) totals.cardFee += netFee;
      else totals.cashFee += netFee;

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
      c.totalFee += netFee;
      c.rides += r.ride_count;
      c.fares += r.fares_total;
      if (isCard) c.cardFee += netFee;
      else c.cashFee += netFee;
      companies.set(r.company_id, c);

      const mo =
        months.get(r.month) ??
        { month: r.month, cardFee: 0, cashFee: 0, totalFee: 0 };
      mo.totalFee += netFee;
      if (isCard) mo.cardFee += netFee;
      else mo.cashFee += netFee;
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
          refunds: fix(totals.refunds),
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

// ── Settlement reconciliation (live from mgcj) ──────────────────────
// "Where did each company's card money actually go this period?" — the
// company-wide rollup by settlement_route the per-ride views can't answer
// ("did my drivers get paid this week?"). Sums the frozen transfer_amount_cents
// snapshot per route; see 20260732_ops_settlement_reconciliation.sql for why
// that column (never a live re-derivation) and why card-only.
//
// Raw routes are folded into a handful of health-lensed STATES so the UI reads
// as an answer, not a taxonomy. Any route string not mapped here lands in
// 'other' rather than vanishing, so a future settlement_route value still shows.

export type SettlementState =
  | "paid_drivers"
  | "paid_companies"
  | "held"
  | "reversed"
  | "attention"
  | "unsettled"
  | "other";

// Note: reversed/clawed-back routes carry the ORIGINAL transfer_amount_cents,
// which slightly overstates a *partial* driver_fault refund (refund_reversed) —
// the snapshot isn't reduced by the clawed-back amount. Acceptable for this
// rollup (it lives in the non-additive 'other'/reversed bucket, not a paid-out
// figure); revisit only if partial refunds become common.
const ROUTE_STATE: Record<string, SettlementState> = {
  driver_transfer: "paid_drivers",
  company_transfer: "paid_companies",
  platform_invoiced: "held",
  transfer_reversed: "reversed",
  refund_reversed: "reversed",
  transfer_failed: "attention",
  reversal_failed: "attention",
  retransfer_failed: "attention",
  refund_review: "attention",
  unsettled: "unsettled",
};

const stateOf = (route: string): SettlementState => ROUTE_STATE[route] ?? "other";

type ReconRow = {
  company_id: string;
  company_name: string;
  settlement_route: string;
  ride_count: number;
  transfer_total: number; // dollars
  fares_total: number;
};

export type SettlementReconciliation = {
  from: string;
  to: string;
  // Money + ride counts per health state, over the period.
  byState: Record<SettlementState, { amount: number; rides: number }>;
  totalTransferred: number; // everything, all states
  totalRides: number;
  attentionRides: number; // rides in the 'attention' state — the thing to act on
  // Per company, the driver/company share split by state. The columns are
  // exhaustive — paidDrivers + paidCompanies + held + attention + other == total
  // for every row (and the footer) — so the table always reconciles. `other`
  // folds reversed/unsettled/other-route money, which isn't cleanly "paid",
  // "held", or "actionable" but must still be somewhere for the row to balance.
  byCompany: {
    companyId: string;
    companyName: string;
    paidDrivers: number;
    paidCompanies: number;
    held: number;
    attention: number;
    other: number;
    total: number;
    rides: number;
  }[];
  // The raw route breakdown, for the detail table (most money first).
  byRoute: { route: string; state: SettlementState; amount: number; rides: number }[];
};

const emptyState = (): SettlementReconciliation["byState"] => ({
  paid_drivers: { amount: 0, rides: 0 },
  paid_companies: { amount: 0, rides: 0 },
  held: { amount: 0, rides: 0 },
  reversed: { amount: 0, rides: 0 },
  attention: { amount: 0, rides: 0 },
  unsettled: { amount: 0, rides: 0 },
  other: { amount: 0, rides: 0 },
});

export async function getSettlementReconciliation(
  slug: string,
  input: {
  fromISO: string;
  toISO: string;
  },
): Promise<
  { ok: true; data: SettlementReconciliation } | { ok: false; error: string }
> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    const mgcj = spokeSupabase(spoke);
    const { data, error } = await mgcj.rpc("ops_settlement_reconciliation", {
      p_from: input.fromISO,
      p_to: input.toISO,
    });
    if (error) {
      const msg = isMissingSchema(error)
        ? "Settlement reconciliation needs 20260732_ops_settlement_reconciliation.sql applied in the mgcj SQL editor (then NOTIFY pgrst, 'reload schema')."
        : error.message;
      return { ok: false, error: msg };
    }

    const rows: ReconRow[] = (data ?? []).map((r: ReconRow) => ({
      company_id: r.company_id,
      company_name: r.company_name,
      settlement_route: r.settlement_route,
      ride_count: Number(r.ride_count),
      transfer_total: Number(r.transfer_total),
      fares_total: Number(r.fares_total),
    }));

    const byState = emptyState();
    const byRoute = new Map<string, SettlementReconciliation["byRoute"][number]>();
    const companies = new Map<string, SettlementReconciliation["byCompany"][number]>();
    let totalTransferred = 0;
    let totalRides = 0;

    for (const r of rows) {
      const state = stateOf(r.settlement_route);
      byState[state].amount = round2(byState[state].amount + r.transfer_total);
      byState[state].rides += r.ride_count;
      totalTransferred = round2(totalTransferred + r.transfer_total);
      totalRides += r.ride_count;

      const rt =
        byRoute.get(r.settlement_route) ??
        { route: r.settlement_route, state, amount: 0, rides: 0 };
      rt.amount = round2(rt.amount + r.transfer_total);
      rt.rides += r.ride_count;
      byRoute.set(r.settlement_route, rt);

      const c =
        companies.get(r.company_id) ??
        {
          companyId: r.company_id,
          companyName: r.company_name,
          paidDrivers: 0,
          paidCompanies: 0,
          held: 0,
          attention: 0,
          other: 0,
          total: 0,
          rides: 0,
        };
      // Accumulate raw (unrounded) so the final round can't leave the columns
      // failing to sum to the total.
      if (state === "paid_drivers") c.paidDrivers += r.transfer_total;
      else if (state === "paid_companies") c.paidCompanies += r.transfer_total;
      else if (state === "held") c.held += r.transfer_total;
      else if (state === "attention") c.attention += r.transfer_total;
      // reversed / unsettled / other — clawed-back or never-transferred money;
      // parked here so every dollar lands in exactly one column.
      else c.other += r.transfer_total;
      c.rides += r.ride_count;
      companies.set(r.company_id, c);
    }

    // Round each column once, then define total as the sum of the rounded
    // columns — guarantees the row (and footer) reconciles to the cent.
    const byCompany = [...companies.values()].map((c) => {
      const paidDrivers = round2(c.paidDrivers);
      const paidCompanies = round2(c.paidCompanies);
      const held = round2(c.held);
      const attention = round2(c.attention);
      const other = round2(c.other);
      return {
        companyId: c.companyId,
        companyName: c.companyName,
        paidDrivers,
        paidCompanies,
        held,
        attention,
        other,
        total: round2(paidDrivers + paidCompanies + held + attention + other),
        rides: c.rides,
      };
    });

    return {
      ok: true,
      data: {
        from: input.fromISO,
        to: input.toISO,
        byState,
        totalTransferred: round2(totalTransferred),
        totalRides,
        attentionRides: byState.attention.rides,
        byCompany: byCompany.sort((a, b) => b.total - a.total),
        byRoute: [...byRoute.values()].sort((a, b) => b.amount - a.amount),
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

export async function listInvoices(
  slug: string,
  input: {
  month?: string; // 'YYYY-MM'
  },
): Promise<{ ok: true; data: Invoice[] } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  let q = supabaseAdmin
    .from("invoices")
    .select("*")
    .eq("project_slug", spoke.slug)
    .order("period_month", { ascending: false })
    .order("company_name", { ascending: true });
  if (input.month) q = q.eq("period_month", monthBounds(input.month).first);
  const { data, error } = await q;
  if (error) return { ok: false, error: missingMigrationMsg(error) ?? error.message };
  return { ok: true, data: (data ?? []) as Invoice[] };
}

// Generate/refresh DRAFT cash invoices for a month from live mgcj data.
// Never overwrites an invoice already marked sent/paid (those are locked).
export async function generateInvoices(
  slug: string,
  input: {
  month: string; // 'YYYY-MM'
  },
): Promise<{ ok: true; data: Invoice[] } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  // The hub is ONE Supabase project across local/Preview/Production, so these
  // rows land in the same table production bills from, regardless of spoke.
  // Dev mgcj is a restored copy full of real-looking rides — ungated, this
  // generates real invoices from fake data.
  try {
    assertHubWritable(spoke, "Generating invoices");
  } catch (e) {
    const b = blocked(e);
    if (b) return b;
    throw e;
  }
  const { start, next, first } = monthBounds(input.month);

  let rows: RevRow[];
  try {
    rows = await fetchRevRows(spoke, start, next);
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
    .eq("project_slug", spoke.slug)
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
      project_slug: spoke.slug,
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
      projectSlug: spoke.slug,
      action: "invoices.generate",
      target: first,
      after: { month: input.month, count: toUpsert.length },
    });
  }

  return listInvoices(slug, { month: input.month });
}

export async function updateInvoiceStatus(
  slug: string,
  input: {
  id: string;
  status: "draft" | "sent" | "paid" | "void";
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    assertHubWritable(spoke, "Changing an invoice's status");
  } catch (e) {
    const b = blocked(e);
    if (b) return b;
    throw e;
  }
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
    projectSlug: spoke.slug,
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
  spoke: Spoke,
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

  const mgcj = spokeSupabase(spoke);
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
export async function previewInvoicePdf(
  slug: string,
  input: {
  id: string;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  const built = await buildAndStoreInvoicePdf(spoke, input.id);
  if (!built.ok) return built;
  return getInvoicePdfUrl(slug, { pdfPath: built.data.pdfPath });
}

// Generate the PDF and email it to the company's billing contact, then flip
// the invoice to sent.
export async function sendInvoice(
  slug: string,
  input: {
  id: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  // RESEND_API_KEY is the LIVE key in every environment and Resend has no test
  // mode, so this gate is the only thing between a dev spoke and a real
  // invoice landing in a real company's inbox. It also flips the invoice to
  // `sent`, which locks it — a hub write in its own right.
  try {
    assertEmailAllowed(spoke, "Sending an invoice");
    assertHubWritable(spoke, "Sending an invoice");
  } catch (e) {
    const b = blocked(e);
    if (b) return b;
    throw e;
  }

  const built = await buildAndStoreInvoicePdf(spoke, input.id);
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
    projectSlug: spoke.slug,
    action: "invoice.send",
    target: input.id,
    after: { billing_email: billingEmail, pdf_path: pdfPath },
  });

  return { ok: true };
}

export async function getInvoicePdfUrl(
  slug: string,
  input: {
  pdfPath: string;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
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
export async function syncDisputeCosts(
  slug: string,
): Promise<
  { ok: true; synced: number; skipped: number } | { ok: false; error: string }
> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  // This is the exact write that put four sandbox disputes into the hub on
  // 2026-09-22, two of them closed and therefore frozen against any re-sync.
  try {
    assertHubWritable(spoke, "Syncing dispute costs");
  } catch (e) {
    const b = blocked(e);
    if (b) return b;
    throw e;
  }
  if (!spokeStripeConfigured(spoke)) {
    return { ok: false, error: "Stripe not configured (MGCJ_STRIPE_SECRET missing)." };
  }

  try {
    // Which disputes are already frozen — don't re-read or re-write those.
    const { data: frozenRows, error: frozenErr } = await supabaseAdmin
      .from("dispute_costs")
      .select("stripe_dispute_id")
      .eq("project_slug", spoke.slug)
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

      const res = await spokeStripeGet(spoke, `/disputes?${qs.toString()}`);
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
      const mgcj = spokeSupabase(spoke);
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

      // Summed rather than hardcoded at $15 so an unexpected extra fee line
      // is picked up rather than silently dropped.
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
      // WINNING A DISPUTE DOES NOT REFUND THE $15. Verified 2026-07-21 by
      // forcing du_1TvT1p0... to 'won' (evidence[uncategorized_text]=
      // winning_evidence) and reading the resulting balance transactions:
      //
      //   txn_1TvT1q… adjustment  amount -2594  fee 1500  "Chargeback withdrawal"
      //   txn_1TvZ7N… adjustment  amount +2594  fee    0  "Chargeback reversal"
      //
      // The win returns the FARE and nothing else — the reversal carries
      // fee 0, and no dispute-fee-refund balance transaction is created
      // anywhere. Stripe's docs confirm this is policy, not a test-mode gap:
      // "For businesses outside Mexico, the fee for receiving a dispute is
      // non-refundable" / "we never return the dispute received fee."
      // (Only the separate dispute COUNTERED fee comes back on a win, and
      // this account isn't charged one.)
      //
      // So the dispute fee is summed, never zeroed on a win. The sum is also
      // race-proof: because the reversal's fee is 0, it evaluates to 1500
      // whether or not that second balance transaction has posted by the time
      // the status flips to 'won' and freezes the row.
      //
      // The PROCESSING fee is the one thing a win does neutralize — the
      // charge stands, so that $1.26 is just the ordinary cost of a completed
      // ride, already in the ride's settlement math rather than a dispute
      // cost. Open disputes count it: the money is out of the balance now,
      // and lost is the outcome if nothing changes.
      const netCost = disputeFee + (isWon ? 0 : processingFee);

      return {
        project_slug: spoke.slug,
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
      projectSlug: spoke.slug,
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
export async function getDisputeCosts(
  slug: string,
  input: {
  fromISO: string;
  toISO: string;
  },
): Promise<{ ok: true; data: DisputeCosts } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);

  // Currency-scoped: totals below sum cents across rows, which would be
  // meaningless if a non-CAD dispute ever landed. Filtering rather than
  // converting keeps the number honest — a USD dispute would go uncounted and
  // visibly missing, not silently folded in at a 1:1 rate.
  const { data, error } = await supabaseAdmin
    .from("dispute_costs")
    .select("*")
    .eq("project_slug", spoke.slug)
    .eq("currency", "cad")
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
//   refund_review     — a refund was issued STRAIGHT IN STRIPE (bypassing the
//                       Refunds flow), so the webhook had no reason metadata and
//                       wouldn't guess a driver's fault. Needs Victor to decide
//                       and manually claw back (or absorb) the driver's payout.
//
// Deliberately NOT period-scoped, matching the reasoning on mgcj's Needs
// Attention list: these are outstanding todos, not historical stats. Resolved
// rows (settlement_resolved_at set by dispatch) drop off.
export type StrandedSettlements = {
  unrecovered: { count: number; amount: number }; // reversal_failed — loss
  owedToDrivers: { count: number; amount: number }; // retransfer_failed — liability
  refundReview: { count: number; amount: number }; // refund_review — needs a decision
  byCompany: {
    companyId: string;
    companyName: string;
    unrecovered: number;
    owedToDrivers: number;
    refundReview: number;
  }[];
};

export async function getStrandedSettlements(
  slug: string,
): Promise<
  { ok: true; data: StrandedSettlements } | { ok: false; error: string }
> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    const mgcj = spokeSupabase(spoke);
    const { data, error } = await mgcj
      .from("rides")
      .select("id, company_id, settlement_route, transfer_amount_cents, refunded_amount_cents")
      .in("settlement_route", ["reversal_failed", "retransfer_failed", "refund_review"])
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
      refundReview: { count: 0, amount: 0 },
      byCompany: [],
    };
    const byCompany = new Map<string, StrandedSettlements["byCompany"][number]>();

    for (const r of rows) {
      const route = r.settlement_route;
      // For refund_review the money under review is the driver's payout capped at
      // the refund; for the two failed routes it's the whole transfer. Null
      // transfer_amount_cents (Stripe fee unreadable at capture) counts as zero —
      // understates rather than inventing a number.
      const transfer = (r.transfer_amount_cents ?? 0) / 100;
      const amount =
        route === "refund_review"
          ? Math.min(transfer, (r.refunded_amount_cents ?? 0) / 100)
          : transfer;

      const bucket =
        route === "reversal_failed"
          ? out.unrecovered
          : route === "retransfer_failed"
            ? out.owedToDrivers
            : out.refundReview;
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
          refundReview: 0,
        };
      if (route === "reversal_failed") e.unrecovered = round2(e.unrecovered + amount);
      else if (route === "retransfer_failed") e.owedToDrivers = round2(e.owedToDrivers + amount);
      else e.refundReview = round2(e.refundReview + amount);
      byCompany.set(key, e);
    }

    out.byCompany = [...byCompany.values()].sort(
      (a, b) =>
        b.unrecovered + b.owedToDrivers + b.refundReview -
        (a.unrecovered + a.owedToDrivers + a.refundReview),
    );
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Refunds ──────────────────────────────────────────────────────────
// Vellon-issued refunds against a completed CARD ride, after Victor
// investigates a passenger complaint (there is no self-serve refund anywhere
// in the app/dashboard — this is the only refund surface). The REASON picks who
// absorbs the money:
//
//   driver_fault     -> the driver/company's transfer is clawed back, DRIVER-FIRST
//   platform_mistake -> Vellon absorbs it (no clawback)
//   goodwill         -> Vellon absorbs it (no clawback)
//
// This action only ISSUES the Stripe refund and stamps the decision as refund
// metadata. The transfer clawback itself is done by mgcj's stripe-webhook
// `charge.refunded` handler — the single place transfer reversals happen, same
// as disputes — which reads that metadata so it never races this write. So a
// driver_fault clawback completes a moment later via the webhook, not inline.
// See mgcj-app migration 20260729_ride_refund_fields.sql.

export type RefundReason = "driver_fault" | "platform_mistake" | "goodwill";

const REFUND_ABSORBED_BY: Record<RefundReason, "driver_company" | "vellon"> = {
  driver_fault: "driver_company",
  platform_mistake: "vellon",
  goodwill: "vellon",
};

export type RefundableRide = {
  id: string;
  companyName: string;
  driverName: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  completedAt: string | null;
  fareFinal: number | null; // dollars
  chargedCents: number | null; // fare in cents — the refund ceiling
  refundedCents: number; // already refunded
  settlementRoute: string | null;
  refundable: boolean; // passes every guard below
  blockedReason: string | null; // why not, if refundable === false
};

// Find a passenger's completed card rides by phone, newest first, annotated with
// whether each can still be refunded. Phone match is a loose suffix contains —
// operators paste whatever format the passenger gave them.
export async function searchRefundableRides(
  slug: string,
  input: {
  phone: string;
  },
): Promise<{ ok: true; data: RefundableRide[] } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    if (!spokeStripeConfigured(spoke)) {
      return { ok: false, error: "Stripe is not configured (MGCJ_STRIPE_SECRET)." };
    }
    const digits = input.phone.replace(/[^0-9]/g, "");
    if (digits.length < 4) {
      return { ok: false, error: "Enter at least 4 digits of the passenger's phone." };
    }

    const mgcj = spokeSupabase(spoke);

    // Passengers whose phone contains the entered digits.
    const { data: passengers, error: pErr } = await mgcj
      .from("profiles")
      .select("id, name, phone")
      .ilike("phone", `%${digits}%`)
      .limit(25);
    if (pErr) throw new Error(pErr.message);
    if (!passengers || passengers.length === 0) return { ok: true, data: [] };

    const passengerById = new Map(passengers.map((p) => [p.id, p]));

    const { data: rides, error: rErr } = await mgcj
      .from("rides")
      .select(
        "id, company_id, driver_id, passenger_id, completed_at, fare_final, payment_method, payment_status, stripe_payment_intent_id, stripe_dispute_id, refunded_amount_cents, settlement_route",
      )
      .in("passenger_id", [...passengerById.keys()])
      .eq("payment_method", "card")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(50);
    if (rErr) throw new Error(rErr.message);
    if (!rides || rides.length === 0) return { ok: true, data: [] };

    // Resolve company + driver display names in bulk.
    const companyIds = [...new Set(rides.map((r) => r.company_id).filter(Boolean))];
    const driverIds = [...new Set(rides.map((r) => r.driver_id).filter(Boolean))];
    const companyNames = new Map<string, string>();
    const driverNames = new Map<string, string>();
    if (companyIds.length) {
      const { data } = await mgcj.from("companies").select("id, name").in("id", companyIds);
      for (const c of data ?? []) companyNames.set(c.id, c.name);
    }
    if (driverIds.length) {
      const { data } = await mgcj.from("profiles").select("id, name").in("id", driverIds);
      for (const d of data ?? []) driverNames.set(d.id, d.name);
    }

    const out: RefundableRide[] = rides.map((r) => {
      const passenger = passengerById.get(r.passenger_id);
      const chargedCents = r.fare_final != null ? Math.round(r.fare_final * 100) : null;
      const refundedCents = r.refunded_amount_cents ?? 0;

      let blockedReason: string | null = null;
      if (r.stripe_dispute_id) blockedReason = "Charge is disputed — resolve the dispute, don't refund.";
      else if (!r.stripe_payment_intent_id) blockedReason = "No payment intent on this ride.";
      else if (r.payment_status !== "succeeded") {
        blockedReason =
          r.payment_status === "refunded"
            ? "Already fully refunded."
            : `Payment not captured (status: ${r.payment_status ?? "unknown"}).`;
      } else if (chargedCents == null) blockedReason = "No final fare recorded.";
      else if (refundedCents >= chargedCents) blockedReason = "Already fully refunded.";

      return {
        id: r.id,
        companyName: companyNames.get(r.company_id) ?? "Unknown company",
        driverName: r.driver_id ? driverNames.get(r.driver_id) ?? null : null,
        passengerName: passenger?.name ?? null,
        passengerPhone: passenger?.phone ?? null,
        completedAt: r.completed_at,
        fareFinal: r.fare_final,
        chargedCents,
        refundedCents,
        settlementRoute: r.settlement_route,
        refundable: blockedReason === null,
        blockedReason,
      };
    });

    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function refundRide(
  slug: string,
  input: {
  rideId: string;
  amountCents?: number; // omit for a full refund of the remaining balance
  reason: RefundReason;
  },
): Promise<
  | { ok: true; refundId: string; amountCents: number; clawback: boolean }
  | { ok: false; error: string }
> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    if (!spokeStripeConfigured(spoke)) {
      return { ok: false, error: "Stripe is not configured (MGCJ_STRIPE_SECRET)." };
    }
    const absorbedBy = REFUND_ABSORBED_BY[input.reason];
    if (!absorbedBy) return { ok: false, error: "Unknown refund reason." };

    const mgcj = spokeSupabase(spoke);
    const { data: ride, error: rErr } = await mgcj
      .from("rides")
      .select(
        "id, company_id, payment_method, payment_status, stripe_payment_intent_id, stripe_dispute_id, fare_final, refunded_amount_cents",
      )
      .eq("id", input.rideId)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!ride) return { ok: false, error: "Ride not found." };

    // Guards — mirror searchRefundableRides so a stale UI can't push a bad refund.
    if (ride.payment_method !== "card") return { ok: false, error: "Not a card ride." };
    if (ride.stripe_dispute_id)
      return { ok: false, error: "Charge is disputed — resolve the dispute instead of refunding." };
    if (!ride.stripe_payment_intent_id)
      return { ok: false, error: "No payment intent on this ride." };
    if (ride.payment_status !== "succeeded")
      return { ok: false, error: `Payment not captured (status: ${ride.payment_status ?? "unknown"}).` };
    if (ride.fare_final == null) return { ok: false, error: "No final fare recorded." };

    const chargedCents = Math.round(ride.fare_final * 100);
    const priorRefunded = ride.refunded_amount_cents ?? 0;
    const remaining = chargedCents - priorRefunded;
    if (remaining <= 0) return { ok: false, error: "Already fully refunded." };

    const amount = input.amountCents ?? remaining;
    if (!Number.isInteger(amount) || amount <= 0)
      return { ok: false, error: "Refund amount must be a positive whole number of cents." };
    if (amount > remaining)
      return { ok: false, error: `Refund exceeds the remaining balance ($${round2(remaining / 100)}).` };

    // Issue the refund. metadata carries the who-absorbs-it decision to the
    // webhook so it applies the clawback without racing our own DB write. The
    // idempotency key folds in the prior-refunded total so a genuine second
    // partial isn't collapsed into the first, but a double-submit of the SAME
    // partial is.
    const refund = await spokeStripePost(
      spoke,
      "/refunds",
      {
        payment_intent: ride.stripe_payment_intent_id,
        amount: amount.toString(),
        "metadata[ride_id]": ride.id,
        "metadata[reason]": input.reason,
        "metadata[absorbed_by]": absorbedBy,
      },
      `refund-${ride.id}-${priorRefunded}-${amount}`,
    );
    if (refund.error) {
      return { ok: false, error: refund.error.message ?? "Stripe refused the refund." };
    }

    const newRefunded = priorRefunded + (refund.amount ?? amount);
    const fullyRefunded = newRefunded >= chargedCents;

    // Record for immediate display. The webhook will also write these (and, for
    // driver_fault, perform the transfer clawback) — every field here is
    // idempotent with it, so whichever lands second is harmless.
    const patch: Record<string, unknown> = {
      refunded_amount_cents: newRefunded,
      refunded_at: new Date().toISOString(),
      stripe_refund_id: refund.id,
      refund_reason: input.reason,
      refund_absorbed_by: absorbedBy,
    };
    if (fullyRefunded) patch.payment_status = "refunded";
    await mgcj.from("rides").update(patch).eq("id", ride.id);

    await writeAudit({
      actorUserId: owner.id,
      projectSlug: spoke.slug,
      action: "ride.refund",
      target: ride.id,
      after: {
        amountCents: amount,
        reason: input.reason,
        absorbedBy,
        refundId: refund.id,
        fullyRefunded,
      },
    });

    return {
      ok: true,
      refundId: refund.id,
      amountCents: amount,
      clawback: absorbedBy === "driver_company",
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Refunds by reason (live from mgcj) ──────────────────────────────
// Turns the single blended "refunds netted out of fees" figure on the Revenue
// KPI into an accountable breakdown by WHY. Parallels Dispute costs: money
// Vellon spent on refunds, billed to no company.
//
// Money figures per row (all mechanical, never re-derived from a live rate):
//   grossRefunded = refunded_amount_cents          (what left Vellon's balance)
//   clawedBack    = transfer_reversed_cents         (what came back off the driver/
//                                                     company transfer)
//   absorbed      = max(0, gross·(1 − pct/100) − clawed)   (Vellon's REAL loss)
//
// Why absorbed is NOT gross − clawed: the fare is transfer + Vellon-fee + Stripe
// (see 20260730_ops_revenue_net_refunds.sql). The passenger paid the fee INSIDE
// the fare and gets it back in the refund — money in, money out, a wash for
// Vellon. gross − clawed is ops_revenue's *netting term* (only a loss once
// subtracted from the booked fee); standalone it double-counts that fee. So we
// strip the fee's share of the refund (gross·pct/100) and subtract the clawback.
// Verified across cases (pct = the frozen platform_fee_percent_at_completion):
//   • full vellon (clawed 0)       -> gross·(1−pct/100) = transfer + Stripe
//   • full driver_fault (clawed=transfer) -> ≈ Stripe fee only (~$0)
//   • partial driver_fault (clawed=refund) -> 0 (fee covers it)
//   • FAILED driver_fault clawback (clawed 0) -> full transfer+Stripe, correctly
//                                                 until it's manually recovered
// max(0, …) guards the case where the fee alone exceeds the un-clawed remainder.
// If pct is null (old/seeded rides), it falls back to gross − clawed — the safe
// over-estimate. Refunds issued out-of-band (straight in Stripe) carry no reason
// metadata and fall in 'uncategorized' rather than being dropped.
//
// Bucketed by refunded_at — when Vellon actually paid it — like Dispute costs
// bucket by opened_at (a cost-incurred lens, deliberately NOT the ride's
// completion month that ops_revenue nets against). Direct select rather than an
// RPC: refunds are rare events, comfortably under the 1000-row page cap, same as
// getStrandedSettlements.

export type RefundReasonKey =
  | "driver_fault"
  | "platform_mistake"
  | "goodwill"
  | "uncategorized";

function reasonKeyOf(reason: string | null): RefundReasonKey {
  if (reason === "driver_fault" || reason === "platform_mistake" || reason === "goodwill") {
    return reason;
  }
  return "uncategorized";
}

type RefundBucket = {
  count: number;
  grossRefunded: number;
  clawedBack: number;
  absorbed: number;
};

export type RefundsByReason = {
  from: string;
  to: string;
  totals: RefundBucket;
  byReason: ({ reason: RefundReasonKey } & RefundBucket)[];
  byCompany: {
    companyId: string;
    companyName: string;
    count: number;
    absorbed: number;
  }[];
  recent: {
    id: string;
    companyName: string | null;
    reason: RefundReasonKey;
    grossRefunded: number;
    absorbed: number;
    refundedAt: string;
  }[];
};

export async function getRefundsByReason(
  slug: string,
  input: {
  fromISO: string;
  toISO: string;
  },
): Promise<{ ok: true; data: RefundsByReason } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  try {
    const mgcj = spokeSupabase(spoke);
    const { data, error } = await mgcj
      .from("rides")
      .select(
        "id, company_id, refund_reason, refund_absorbed_by, refunded_amount_cents, transfer_reversed_cents, platform_fee_percent_at_completion, refunded_at",
      )
      .not("refunded_at", "is", null)
      .gt("refunded_amount_cents", 0)
      .gte("refunded_at", input.fromISO)
      .lt("refunded_at", input.toISO)
      .order("refunded_at", { ascending: false });
    if (error) throw new Error(error.message);

    // Vellon's real loss on a refund: strip the fee's share (a wash — see the
    // header comment) and the clawback, floored at zero.
    const absorbedOf = (
      refundedCents: number | null,
      reversedCents: number | null,
      feePct: number | null,
    ): number => {
      const gross = (refundedCents ?? 0) / 100;
      const clawed = (reversedCents ?? 0) / 100;
      const pct = Number(feePct) || 0; // null/NaN -> 0 -> safe over-estimate
      return Math.max(0, gross * (1 - pct / 100) - clawed);
    };

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

    const emptyBucket = (): RefundBucket => ({
      count: 0,
      grossRefunded: 0,
      clawedBack: 0,
      absorbed: 0,
    });
    const totals = emptyBucket();
    const byReason = new Map<RefundReasonKey, RefundBucket>();
    const byCompany = new Map<string, RefundsByReason["byCompany"][number]>();

    for (const r of rows) {
      const gross = (r.refunded_amount_cents ?? 0) / 100;
      const clawed = (r.transfer_reversed_cents ?? 0) / 100;
      const absorbed = absorbedOf(
        r.refunded_amount_cents,
        r.transfer_reversed_cents,
        r.platform_fee_percent_at_completion,
      );
      const key = reasonKeyOf(r.refund_reason);

      const add = (b: RefundBucket) => {
        b.count += 1;
        b.grossRefunded += gross;
        b.clawedBack += clawed;
        b.absorbed += absorbed;
      };
      add(totals);
      const rb = byReason.get(key) ?? emptyBucket();
      add(rb);
      byReason.set(key, rb);

      const ck = r.company_id ?? "unattributed";
      const c =
        byCompany.get(ck) ??
        {
          companyId: ck,
          companyName: names.get(ck) ?? "Unattributed",
          count: 0,
          absorbed: 0,
        };
      c.count += 1;
      c.absorbed = round2(c.absorbed + absorbed);
      byCompany.set(ck, c);
    }

    const finishBucket = (b: RefundBucket): RefundBucket => ({
      count: b.count,
      grossRefunded: round2(b.grossRefunded),
      clawedBack: round2(b.clawedBack),
      absorbed: round2(b.absorbed),
    });

    // Stable, meaningful order for the reason table.
    const REASON_ORDER: RefundReasonKey[] = [
      "platform_mistake",
      "goodwill",
      "driver_fault",
      "uncategorized",
    ];

    return {
      ok: true,
      data: {
        from: input.fromISO,
        to: input.toISO,
        totals: finishBucket(totals),
        byReason: REASON_ORDER.filter((k) => byReason.has(k)).map((k) => ({
          reason: k,
          ...finishBucket(byReason.get(k)!),
        })),
        byCompany: [...byCompany.values()]
          .map((c) => ({ ...c, absorbed: round2(c.absorbed) }))
          .sort((a, b) => b.absorbed - a.absorbed),
        recent: rows.slice(0, 25).map((r) => ({
          id: r.id,
          companyName: r.company_id ? names.get(r.company_id) ?? null : null,
          reason: reasonKeyOf(r.refund_reason),
          grossRefunded: round2((r.refunded_amount_cents ?? 0) / 100),
          absorbed: round2(
            absorbedOf(
              r.refunded_amount_cents,
              r.transfer_reversed_cents,
              r.platform_fee_percent_at_completion,
            ),
          ),
          refundedAt: r.refunded_at,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Combined dashboard load ─────────────────────────────────────────
// The Revenue dashboard's five on-mount reads collapse into this single
// server action. Two wins over calling them separately from the client:
//   1. Next.js serializes concurrent server actions, so five separate calls
//      ran back-to-back; here the five reads run in parallel via Promise.all.
//   2. requirePlatformOwner() is called once for the whole request — the
//      per-action guards inside each read hit the request-scoped cache()
//      instead of re-verifying, so there's one auth check, not five.
// Invoices (their own month selector) and the refund search (interactive)
// stay separate on purpose.
export async function getRevenueOverview(
  slug: string,
  input: {
  fromISO: string;
  toISO: string;
  },
): Promise<{
  revenue: Awaited<ReturnType<typeof getRevenue>>;
  settlement: Awaited<ReturnType<typeof getSettlementReconciliation>>;
  disputeCosts: Awaited<ReturnType<typeof getDisputeCosts>>;
  stranded: Awaited<ReturnType<typeof getStrandedSettlements>>;
  refunds: Awaited<ReturnType<typeof getRefundsByReason>>;
}> {
  await requirePlatformOwner();
  const [revenue, settlement, disputeCosts, stranded, refunds] =
    await Promise.all([
      getRevenue(slug, input),
      getSettlementReconciliation(slug, input),
      getDisputeCosts(slug, input),
      getStrandedSettlements(slug),
      getRefundsByReason(slug, input),
    ]);
  return { revenue, settlement, disputeCosts, stranded, refunds };
}
