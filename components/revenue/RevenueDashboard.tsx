"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  getRevenue,
  generateInvoices,
  listInvoices,
  updateInvoiceStatus,
  sendInvoice,
  previewInvoicePdf,
  syncDisputeCosts,
  getDisputeCosts,
  getStrandedSettlements,
  getSettlementReconciliation,
  getRefundsByReason,
  searchRefundableRides,
  refundRide,
  type RevenueSummary,
  type Invoice,
  type DisputeCosts,
  type StrandedSettlements,
  type SettlementReconciliation,
  type SettlementState,
  type RefundsByReason,
  type RefundReasonKey,
  type RefundableRide,
  type RefundReason,
} from "@/app/(app)/revenue/actions";

// Dark-mode categorical slots 1 (blue) & 2 (aqua) — validated CVD-safe pair.
const CARD = "#3987e5";
const CASH = "#199e70";

const cad = (n: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(n);

const card = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-4";

// UTC month helpers (match the RPC's UTC bucketing).
function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(first: string) {
  // first = 'YYYY-MM-DD'
  const [y, m] = first.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-CA", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Preset = { label: string; months: number };
const PRESETS: Preset[] = [
  { label: "This month", months: 1 },
  { label: "3 months", months: 3 },
  { label: "6 months", months: 6 },
  { label: "12 months", months: 12 },
];

function rangeFor(months: number): { fromISO: string; toISO: string } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
  );
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

export function RevenueDashboard() {
  const [preset, setPreset] = useState(2); // "6 months"
  const [rev, setRev] = useState<RevenueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    const { fromISO, toISO } = rangeFor(PRESETS[preset].months);
    startTransition(async () => {
      const res = await getRevenue({ fromISO, toISO });
      if (res.ok) {
        setRev(res.data);
        setError(null);
      } else setError(res.error);
    });
  }, [preset]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Revenue</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Platform fees by company, card vs cash, over time. Cash fees are
            billed monthly — generate invoices below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-zinc-800 p-0.5">
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                onClick={() => setPreset(i)}
                className={
                  "rounded px-2.5 py-1 text-xs " +
                  (i === preset
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300")
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50"
          >
            {pending ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {rev && (
        <div className="mt-6 space-y-8">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Platform fees"
              value={cad(rev.totals.fee)}
              accent
              sub={rev.totals.refunds > 0 ? `net of ${cad(rev.totals.refunds)} refunded` : undefined}
            />
            <Tile
              label="Card fees"
              value={cad(rev.totals.cardFee)}
              dot={CARD}
              sub={rev.totals.refunds > 0 ? "auto-collected, net of refunds" : "auto-collected"}
            />
            <Tile
              label="Cash fees"
              value={cad(rev.totals.cashFee)}
              dot={CASH}
              sub="billed monthly"
            />
            <Tile label="Completed rides" value={rev.totals.rides.toLocaleString()} />
          </div>

          <FeeTrend data={rev.byMonth} />

          {/* By company */}
          <section>
            <h2 className="text-sm font-semibold text-zinc-300">By company</h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[600px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-2.5 font-medium">Company</th>
                    <th className="px-4 py-2.5 text-right font-medium">Card fee</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cash fee</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total fee</th>
                    <th className="px-4 py-2.5 text-right font-medium">Rides</th>
                  </tr>
                </thead>
                <tbody>
                  {rev.byCompany.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                        No completed rides in this range.
                      </td>
                    </tr>
                  )}
                  {rev.byCompany.map((c) => (
                    <tr key={c.companyId} className="border-b border-zinc-900 last:border-0">
                      <td className="px-4 py-2.5 text-zinc-200">{c.companyName}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-400">{cad(c.cardFee)}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-400">{cad(c.cashFee)}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-zinc-100">{cad(c.totalFee)}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-500">{c.rides}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <SettlementSection
            fromISO={rangeFor(PRESETS[preset].months).fromISO}
            toISO={rangeFor(PRESETS[preset].months).toISO}
          />

          <DisputeSection
            fromISO={rangeFor(PRESETS[preset].months).fromISO}
            toISO={rangeFor(PRESETS[preset].months).toISO}
          />

          <RefundsByReasonSection
            fromISO={rangeFor(PRESETS[preset].months).fromISO}
            toISO={rangeFor(PRESETS[preset].months).toISO}
          />

          <RefundSection />

          <InvoiceSection />
        </div>
      )}
    </div>
  );
}

// ── Settlement reconciliation ───────────────────────────────────────
// Company-wide answer to "where did each company's card money actually go this
// period?" — the rollup by settlement state that per-ride views can't give.
// Sums the frozen transfer_amount_cents snapshot; see getSettlementReconciliation.

// Human labels for the raw settlement_route values, for the detail table.
const ROUTE_LABEL: Record<string, string> = {
  driver_transfer: "Paid to driver",
  company_transfer: "Paid to company",
  platform_invoiced: "Held on platform",
  transfer_failed: "Transfer failed",
  transfer_reversed: "Reversed (dispute)",
  refund_reversed: "Clawed back (refund)",
  reversal_failed: "Clawback failed",
  retransfer_failed: "Re-payment failed",
  refund_review: "Refunded out-of-band",
  unsettled: "Unsettled",
};
const routeLabel = (r: string) => ROUTE_LABEL[r] ?? r.replace(/_/g, " ");

const STATE_META: Record<
  SettlementState,
  { label: string; dot: string; sub: string }
> = {
  paid_drivers: {
    label: "Paid to drivers",
    dot: "#199e70",
    sub: "driver_direct, straight to their account",
  },
  paid_companies: {
    label: "Paid to companies",
    dot: "#3987e5",
    sub: "company settles with drivers",
  },
  held: {
    label: "Held / pending sweep",
    dot: "#c99a3a",
    sub: "no Connect account yet — swept hourly",
  },
  reversed: {
    label: "Reversed",
    dot: "#8a8f98",
    sub: "clawed back by a dispute or refund",
  },
  attention: {
    label: "Needs attention",
    dot: "#e5484d",
    sub: "failed transfers / manual review",
  },
  unsettled: {
    label: "Unsettled",
    dot: "#6a6f78",
    sub: "completed card ride, no transfer recorded",
  },
  other: {
    label: "Other",
    dot: "#6a6f78",
    sub: "unrecognized settlement route",
  },
};

// Order the state tiles by operational salience, not amount.
const STATE_ORDER: SettlementState[] = [
  "paid_drivers",
  "paid_companies",
  "held",
  "attention",
  "reversed",
  "unsettled",
  "other",
];

function SettlementSection({ fromISO, toISO }: { fromISO: string; toISO: string }) {
  const [data, setData] = useState<SettlementReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getSettlementReconciliation({ fromISO, toISO });
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
    });
  }, [fromISO, toISO]);

  useEffect(() => {
    load();
  }, [load]);

  // Only render a state tile if it has activity — keeps the row focused on what
  // actually happened this period rather than a grid of zeros.
  const activeStates = data
    ? STATE_ORDER.filter((s) => data.byState[s].rides > 0)
    : [];

  // Footer sums the per-company columns (not byState) so it reconciles to the
  // exact same cent as the rows above it — total == the five columns' sum.
  const footer = useMemo(() => {
    const f = { paidDrivers: 0, paidCompanies: 0, held: 0, attention: 0, other: 0, total: 0 };
    for (const c of data?.byCompany ?? []) {
      f.paidDrivers += c.paidDrivers;
      f.paidCompanies += c.paidCompanies;
      f.held += c.held;
      f.attention += c.attention;
      f.other += c.other;
      f.total += c.total;
    }
    return f;
  }, [data]);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">
            Settlement reconciliation
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Where each company&apos;s <em>card</em> money landed this period —
            the driver/company share, by settlement state.
          </p>
        </div>
        {pending && <span className="text-xs text-zinc-600">…</span>}
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {data && data.totalRides === 0 && !error && (
        <p className="mt-3 rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No completed card rides in this range.
        </p>
      )}

      {data && data.totalRides > 0 && (
        <>
          {data.attentionRides > 0 && (
            <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {data.attentionRides} ride{data.attentionRides === 1 ? "" : "s"} in a
              failed or manual-review state ({cad(data.byState.attention.amount)}).
              See the routes below — these are also on the Needs Attention list.
            </p>
          )}

          {/* State tiles */}
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {activeStates.map((s) => (
              <Tile
                key={s}
                label={STATE_META[s].label}
                value={cad(data.byState[s].amount)}
                dot={STATE_META[s].dot}
                sub={`${data.byState[s].rides} ride${
                  data.byState[s].rides === 1 ? "" : "s"
                } · ${STATE_META[s].sub}`}
              />
            ))}
          </div>

          {/* By company. Columns are exhaustive and reconcile: drivers +
              company + held + attention + other == total, per row and footer. */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 text-right font-medium">To drivers</th>
                  <th className="px-4 py-2.5 text-right font-medium">To company</th>
                  <th className="px-4 py-2.5 text-right font-medium">Held</th>
                  <th className="px-4 py-2.5 text-right font-medium">Attention</th>
                  <th className="px-4 py-2.5 text-right font-medium">Other</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 text-right font-medium">Rides</th>
                </tr>
              </thead>
              <tbody>
                {data.byCompany.map((c) => (
                  <tr key={c.companyId} className="border-b border-zinc-900 last:border-0">
                    <td className="px-4 py-2.5 text-zinc-200">{c.companyName}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">
                      {c.paidDrivers > 0 ? cad(c.paidDrivers) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">
                      {c.paidCompanies > 0 ? cad(c.paidCompanies) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-amber-300/80">
                      {c.held > 0 ? cad(c.held) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-red-300/80">
                      {c.attention > 0 ? cad(c.attention) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">
                      {c.other !== 0 ? cad(c.other) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-zinc-100">
                      {cad(c.total)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">{c.rides}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-800 text-sm">
                  <td className="px-4 py-2.5 text-zinc-500">All companies</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {cad(footer.paidDrivers)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {cad(footer.paidCompanies)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-amber-300/80">
                    {cad(footer.held)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-red-300/80">
                    {cad(footer.attention)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">
                    {cad(footer.other)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-zinc-100">
                    {cad(footer.total)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">
                    {data.totalRides}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Raw route detail — the exact settlement_route breakdown */}
          <details className="mt-3 rounded-xl border border-zinc-800">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-300">
              Route detail
            </summary>
            <div className="overflow-x-auto border-t border-zinc-800">
              <table className="w-full min-w-[480px] text-left text-sm">
                <tbody>
                  {data.byRoute.map((r) => (
                    <tr key={r.route} className="border-b border-zinc-900 last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2 text-zinc-300">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: STATE_META[r.state].dot }}
                          />
                          {routeLabel(r.route)}
                          <code className="text-[10px] text-zinc-600">{r.route}</code>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-500">{r.rides}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-zinc-200">
                        {cad(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

// ── Dispute costs ───────────────────────────────────────────────────
// Vellon's own cost of chargebacks — money that touches no ride's settlement
// math and is therefore invisible everywhere else on the platform.
function DisputeSection({ fromISO, toISO }: { fromISO: string; toISO: string }) {
  const [costs, setCosts] = useState<DisputeCosts | null>(null);
  const [stranded, setStranded] = useState<StrandedSettlements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const [c, s] = await Promise.all([
        getDisputeCosts({ fromISO, toISO }),
        getStrandedSettlements(),
      ]);
      if (c.ok) setCosts(c.data);
      else setError(c.error);
      if (s.ok) setStranded(s.data);
    });
  }, [fromISO, toISO]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = () => {
    startTransition(async () => {
      const res = await syncDisputeCosts();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setNote(
        `Synced ${res.synced} dispute${res.synced === 1 ? "" : "s"}` +
          (res.skipped > 0 ? ` · ${res.skipped} already closed and frozen` : ""),
      );
      load();
    });
  };

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">Dispute costs</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Vellon&apos;s own cost of chargebacks — not billed to any company.
          </p>
        </div>
        <button
          onClick={sync}
          disabled={pending}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
        >
          {pending ? "…" : "Sync from Stripe"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400">
          {note}
        </p>
      )}

      {costs && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Net dispute cost"
              value={"−" + cad(costs.totals.netCost)}
              sub="this period"
            />
            <Tile
              label="Dispute fees"
              value={cad(costs.totals.disputeFees)}
              sub="$15 flat, never refunded"
            />
            <Tile
              label="Unrecovered processing"
              value={cad(costs.totals.processingFees)}
              sub="Stripe keeps it either way"
            />
            <Tile
              label="Disputes"
              value={String(costs.totals.count)}
              sub={
                costs.totals.openCount > 0
                  ? `${costs.totals.openCount} still open`
                  : "all closed"
              }
            />
          </div>

          {costs.totals.openCount > 0 && (
            <p className="mt-2 text-xs text-zinc-600">
              Open disputes are counted at their full cost — the money is out
              of the balance now. Stripe never refunds the $15 dispute fee, win
              or lose; winning only returns the fare and the $1.26 processing
              fee, dropping a dispute to $15.00 on the next sync.
            </p>
          )}

          {costs.recent.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-2.5 font-medium">Opened</th>
                    <th className="px-4 py-2.5 font-medium">Company</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Fare</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cost to us</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.recent.map((d) => (
                    <tr key={d.id} className="border-b border-zinc-900 last:border-0">
                      <td className="px-4 py-2.5 text-zinc-400">
                        {new Date(d.openedAt).toLocaleDateString("en-CA")}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-200">
                        {d.companyName ?? (
                          <span className="text-zinc-600">Unattributed</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-xs " +
                            (d.status === "won"
                              ? "bg-emerald-950/60 text-emerald-300"
                              : d.isClosed
                                ? "bg-red-950/50 text-red-300"
                                : "bg-amber-950/50 text-amber-300")
                          }
                        >
                          {d.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-500">
                        {cad(d.disputedAmount)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-zinc-100">
                        {d.netCost === 0 ? "—" : "−" + cad(d.netCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {costs.totals.count === 0 && (
            <p className="mt-3 rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
              No disputes in this range. Hit &ldquo;Sync from Stripe&rdquo; if
              you&apos;re expecting some.
            </p>
          )}
        </>
      )}

      {/* Stranded settlement money. Deliberately outside the period filter —
          these are outstanding todos, not historical stats. */}
      {stranded &&
        (stranded.unrecovered.count > 0 ||
          stranded.owedToDrivers.count > 0 ||
          stranded.refundReview.count > 0) && (
          <div className="mt-4 rounded-xl border border-zinc-800 p-4">
            <p className="text-sm font-medium text-zinc-300">
              Stranded settlement money
              <span className="ml-2 text-xs font-normal text-zinc-600">
                outstanding, all time
              </span>
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-sm text-zinc-400">Unrecovered</p>
                <p className="mt-1 text-xl font-semibold text-red-300">
                  −{cad(stranded.unrecovered.amount)}
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  {stranded.unrecovered.count} ride
                  {stranded.unrecovered.count === 1 ? "" : "s"} paid out, then
                  disputed — clawback failed. A real loss.
                </p>
              </div>
              <div>
                <p className="text-sm text-zinc-400">Owed to drivers</p>
                <p className="mt-1 text-xl font-semibold text-amber-300">
                  {cad(stranded.owedToDrivers.amount)}
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  {stranded.owedToDrivers.count} ride
                  {stranded.owedToDrivers.count === 1 ? "" : "s"} won on appeal
                  but the re-send failed. Held, not lost — we still owe it.
                </p>
              </div>
              {stranded.refundReview.count > 0 && (
                <div>
                  <p className="text-sm text-zinc-400">Refunds to review</p>
                  <p className="mt-1 text-xl font-semibold text-amber-300">
                    {cad(stranded.refundReview.amount)}
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    {stranded.refundReview.count} ride
                    {stranded.refundReview.count === 1 ? "" : "s"} refunded outside
                    the Refunds flow — decide who absorbs it and claw back manually
                    in Stripe.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  dot,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  dot?: string;
  accent?: boolean;
}) {
  return (
    <div className={card}>
      <div className="flex items-center gap-1.5">
        {dot && (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: dot }}
          />
        )}
        <p className="text-sm text-zinc-400">{label}</p>
      </div>
      <p
        className={
          "mt-2 text-2xl font-semibold " +
          (accent ? "text-accent" : "text-zinc-100")
        }
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-zinc-600">{sub}</p>}
    </div>
  );
}

// Round a scale max up to a "clean" step (1/2/2.5/5/10 × a power of ten) so
// axis ticks read as real numbers, not fractions of whatever the biggest bar happened to be.
function niceCeil(n: number): number {
  if (n <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
  const residual = n / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((s) => s >= residual) ?? 10;
  return step * magnitude;
}

const compactCad = (n: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);

// ── Monthly fee trend: stacked bars (cash + card) with axis + hover tooltip ──
function FeeTrend({ data }: { data: RevenueSummary["byMonth"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const niceMax = niceCeil(Math.max(1, ...data.map((d) => d.totalFee)));
  const ticks = [niceMax, (niceMax * 3) / 4, niceMax / 2, niceMax / 4, 0];
  const PLOT_H = 208; // px — matches h-52 below

  if (data.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">
          Platform fees over time
        </h2>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: CARD }} />
            Card
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: CASH }} />
            Cash
          </span>
        </div>
      </div>

      <div className="mt-4 flex gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        {/* y-axis ticks */}
        <div
          className="flex shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-zinc-600"
          style={{ height: PLOT_H }}
        >
          {ticks.map((t) => (
            <span key={t}>{compactCad(t)}</span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* gridlines — hairline, recessive, one step off the surface */}
          <div
            className="absolute inset-x-0 top-0 flex flex-col justify-between"
            style={{ height: PLOT_H }}
          >
            {ticks.map((t) => (
              <div key={t} className="border-t border-zinc-800/60" />
            ))}
          </div>

          <div className="relative flex items-end gap-1" style={{ height: PLOT_H }}>
            {data.map((d, i) => {
              // Pixel heights, not percentages — the stack wrapper below has
              // no explicit height of its own (it sizes to content), so a
              // percentage height on its children resolves against nothing
              // and renders at 0px. Anchoring to PLOT_H sidesteps that.
              const cardHpx = d.cardFee > 0 ? Math.max((d.cardFee / niceMax) * PLOT_H, 2) : 0;
              const cashHpx = d.cashFee > 0 ? Math.max((d.cashFee / niceMax) * PLOT_H, 2) : 0;
              const active = hover === i;
              const hasCard = d.cardFee > 0;
              const hasCash = d.cashFee > 0;
              return (
                <div
                  key={d.month}
                  className="group relative flex h-full flex-1 flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  {d.totalFee > 0 && (
                    <div className="pointer-events-none mb-1 text-center text-[10px] tabular-nums text-zinc-300">
                      {cad(d.totalFee)}
                    </div>
                  )}
                  {/* capped-width stacked column: card (free end, rounded) on
                      top, cash on the baseline (square) — 2px surface gap between */}
                  <div className="mx-auto flex w-full max-w-[22px] flex-col items-stretch justify-end">
                    {hasCard && (
                      <div
                        style={{
                          height: `${cardHpx}px`,
                          background: CARD,
                          opacity: active || hover === null ? 1 : 0.5,
                        }}
                        className="rounded-t-[4px]"
                      />
                    )}
                    {hasCash && (
                      <div
                        style={{
                          height: `${cashHpx}px`,
                          background: CASH,
                          marginTop: hasCard ? 2 : 0,
                          opacity: active || hover === null ? 1 : 0.5,
                        }}
                        className={hasCard ? "" : "rounded-t-[4px]"}
                      />
                    )}
                  </div>

                  {active && (
                    <div className="pointer-events-none absolute -top-2 left-1/2 z-10 w-36 -translate-x-1/2 -translate-y-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-xs shadow-xl">
                      <p className="font-medium text-zinc-200">{monthLabel(d.month)}</p>
                      <div className="mt-1.5 space-y-1">
                        <Row color={CARD} label="Card" value={cad(d.cardFee)} />
                        <Row color={CASH} label="Cash" value={cad(d.cashFee)} />
                        <div className="mt-1 flex justify-between border-t border-zinc-800 pt-1 text-zinc-300">
                          <span>Total</span>
                          <span className="tabular-nums">{cad(d.totalFee)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* baseline — solid, one step brighter than the gridlines */}
          <div className="border-t border-zinc-700" />

          <div className="mt-1.5 flex gap-1">
            {data.map((d) => (
              <div key={d.month} className="flex-1 text-center text-[10px] text-zinc-500">
                {monthLabel(d.month)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-zinc-400">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// ── Cash invoices ──────────────────────────────────────────────────
const STATUS_STYLE: Record<Invoice["status"], string> = {
  draft: "border-zinc-700 bg-zinc-800/40 text-zinc-300",
  sent: "border-blue-900/40 bg-blue-950/30 text-blue-300",
  paid: "border-emerald-900/40 bg-emerald-950/30 text-emerald-300",
  void: "border-zinc-800 bg-zinc-900 text-zinc-600 line-through",
};

function InvoiceSection() {
  const [month, setMonth] = useState(() => {
    const n = new Date();
    // Default to last completed month.
    const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
    return monthKey(d);
  });
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback((m: string) => {
    startTransition(async () => {
      const res = await listInvoices({ month: m });
      if (res.ok) {
        setInvoices(res.data);
        setError(null);
      } else setError(res.error);
    });
  }, []);

  useEffect(() => {
    refresh(month);
  }, [month, refresh]);

  const generate = () => {
    startTransition(async () => {
      const res = await generateInvoices({ month });
      if (res.ok) {
        setInvoices(res.data);
        setError(null);
      } else setError(res.error);
    });
  };

  const setStatus = (id: string, status: Invoice["status"]) => {
    startTransition(async () => {
      const res = await updateInvoiceStatus({ id, status });
      if (res.ok) refresh(month);
      else setError(res.error);
    });
  };

  const send = (id: string) => {
    startTransition(async () => {
      const res = await sendInvoice({ id });
      if (res.ok) refresh(month);
      else setError(res.error);
    });
  };

  // Generates (or regenerates) the PDF and opens it — works before sending
  // (preview what will go out) and regardless of whether the company has a
  // billing email on file (manual-delivery fallback).
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const preview = (id: string) => {
    setPreviewingId(id);
    startTransition(async () => {
      const res = await previewInvoicePdf({ id });
      if (res.ok) window.open(res.url, "_blank");
      else setError(res.error);
      setPreviewingId(null);
    });
  };

  const total = useMemo(
    () => invoices.filter((i) => i.status !== "void").reduce((s, i) => s + Number(i.amount_due), 0),
    [invoices],
  );

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-300">
          Monthly cash invoices
        </h2>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
          />
          <button
            onClick={generate}
            disabled={pending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? "…" : "Generate / refresh drafts"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        Bills each company the platform fee on their <em>cash</em> rides for the
        month. Regenerating updates drafts only — sent/paid invoices are locked.
      </p>

      {error && (
        <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-2.5 font-medium">Company</th>
              <th className="px-4 py-2.5 text-right font-medium">Cash fares</th>
              <th className="px-4 py-2.5 text-right font-medium">Rate</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount due</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  No invoices for {monthLabel(month + "-01")}. Click generate to
                  create drafts from cash rides.
                </td>
              </tr>
            )}
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-zinc-900 last:border-0">
                <td className="px-4 py-2.5 text-zinc-200">{inv.company_name}</td>
                <td className="px-4 py-2.5 text-right text-zinc-400">
                  {cad(Number(inv.cash_fares_total))}
                  <span className="ml-1 text-xs text-zinc-600">
                    ({inv.ride_count})
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-500">
                  {Number(inv.fee_percent)}%
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-zinc-100">
                  {cad(Number(inv.amount_due))}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={
                      "inline-block rounded-full border px-2 py-0.5 text-xs " +
                      STATUS_STYLE[inv.status]
                    }
                  >
                    {inv.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <ActBtn onClick={() => preview(inv.id)} muted>
                      {previewingId === inv.id ? "…" : "Preview / Download PDF"}
                    </ActBtn>
                    {inv.status === "draft" && (
                      <ActBtn onClick={() => send(inv.id)}>Send invoice</ActBtn>
                    )}
                    {inv.status === "sent" && (
                      <ActBtn onClick={() => setStatus(inv.id, "paid")}>
                        Mark paid
                      </ActBtn>
                    )}
                    {inv.status !== "void" && inv.status !== "paid" && (
                      <ActBtn onClick={() => setStatus(inv.id, "void")} muted>
                        Void
                      </ActBtn>
                    )}
                    {inv.status === "void" && (
                      <ActBtn onClick={() => setStatus(inv.id, "draft")} muted>
                        Restore
                      </ActBtn>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {invoices.length > 0 && (
            <tfoot>
              <tr className="border-t border-zinc-800 text-sm">
                <td className="px-4 py-2.5 text-zinc-500" colSpan={3}>
                  Billable this month (excl. void)
                </td>
                <td className="px-4 py-2.5 text-right font-semibold text-accent">
                  {cad(total)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

function ActBtn({
  children,
  onClick,
  muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md border px-2.5 py-1 text-xs " +
        (muted
          ? "border-zinc-800 text-zinc-500 hover:bg-zinc-800/40"
          : "border-zinc-700 text-zinc-300 hover:bg-zinc-800/50")
      }
    >
      {children}
    </button>
  );
}

// ── Refunds by reason ───────────────────────────────────────────────
// The blended "refunds netted out of fees" figure on the KPI row, broken out by
// WHY — so platform mistakes (a signal to fix) read separately from goodwill (a
// deliberate spend). Vellon's own cost of refunds, parallel to Dispute costs.
const REASON_META: Record<
  RefundReasonKey,
  { label: string; dot: string; note: string }
> = {
  platform_mistake: {
    label: "Platform mistake",
    dot: "#e5484d",
    note: "Vellon absorbs — a signal worth fixing",
  },
  goodwill: {
    label: "Goodwill",
    dot: "#c99a3a",
    note: "Vellon absorbs — deliberate spend",
  },
  driver_fault: {
    label: "Driver / company at fault",
    dot: "#199e70",
    note: "recovered via clawback — only the Stripe fee sticks (unless it failed)",
  },
  uncategorized: {
    label: "Uncategorized",
    dot: "#8a8f98",
    note: "refunded out-of-band, no reason recorded",
  },
};

function RefundsByReasonSection({ fromISO, toISO }: { fromISO: string; toISO: string }) {
  const [data, setData] = useState<RefundsByReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getRefundsByReason({ fromISO, toISO });
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
    });
  }, [fromISO, toISO]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">Refunds by reason</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            What Vellon absorbed on refunds, and why — bucketed by refund date.
          </p>
        </div>
        {pending && <span className="text-xs text-zinc-600">…</span>}
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {data && data.totals.count === 0 && !error && (
        <p className="mt-3 rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No refunds in this range.
        </p>
      )}

      {data && data.totals.count > 0 && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Absorbed by Vellon"
              value={"−" + cad(data.totals.absorbed)}
              accent
              sub="net of driver/company clawbacks"
            />
            <Tile
              label="Gross refunded"
              value={cad(data.totals.grossRefunded)}
              sub="total paid back to passengers"
            />
            <Tile
              label="Clawed back"
              value={cad(data.totals.clawedBack)}
              dot="#199e70"
              sub="recovered from drivers/companies"
            />
            <Tile
              label="Refunds"
              value={String(data.totals.count)}
              sub="in this range"
            />
          </div>

          <p className="mt-2 text-xs text-zinc-600">
            &ldquo;Absorbed&rdquo; is Vellon&apos;s real loss — the refund minus
            the clawback <em>and</em> minus the platform fee, which the passenger
            paid inside the fare and got back, a wash. So it&apos;s less than
            gross minus clawback, and a fully clawed-back driver-fault refund
            nets to just the Stripe fee.
          </p>

          {/* By reason — Gross and Absorbed only; clawback lives in the tile
              above, since gross − clawed does NOT equal absorbed (the fee is
              also netted out) and adjacent columns shouldn't imply it does. */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Reason</th>
                  <th className="px-4 py-2.5 text-right font-medium">Refunds</th>
                  <th className="px-4 py-2.5 text-right font-medium">Gross</th>
                  <th className="px-4 py-2.5 text-right font-medium">Vellon absorbed</th>
                </tr>
              </thead>
              <tbody>
                {data.byReason.map((r) => (
                  <tr key={r.reason} className="border-b border-zinc-900 last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 text-zinc-200">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: REASON_META[r.reason].dot }}
                        />
                        {REASON_META[r.reason].label}
                      </span>
                      <span className="ml-4 text-xs text-zinc-600">
                        {REASON_META[r.reason].note}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">{r.count}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">
                      {cad(r.grossRefunded)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-zinc-100">
                      {r.absorbed === 0 ? "—" : "−" + cad(r.absorbed)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-800 text-sm">
                  <td className="px-4 py-2.5 text-zinc-500">All reasons</td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">
                    {data.totals.count}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {cad(data.totals.grossRefunded)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-accent">
                    {"−" + cad(data.totals.absorbed)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* By company — only where Vellon actually absorbed something */}
          {data.byCompany.some((c) => c.absorbed > 0) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.byCompany
                .filter((c) => c.absorbed > 0)
                .map((c) => (
                  <div
                    key={c.companyId}
                    className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                  >
                    <span className="truncate text-sm text-zinc-300">{c.companyName}</span>
                    <span className="ml-2 shrink-0 text-sm font-medium text-zinc-100">
                      −{cad(c.absorbed)}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Refunds ─────────────────────────────────────────────────────────
// Look up a passenger's completed card rides and issue a refund after
// investigating a complaint. The reason chosen in the modal decides who
// absorbs it (driver/company vs Vellon); the driver clawback, if any, runs a
// moment later via mgcj's stripe-webhook. See refundRide in actions.ts.
const REASON_OPTIONS: {
  value: RefundReason;
  label: string;
  blurb: string;
}[] = [
  {
    value: "driver_fault",
    label: "Driver / company at fault",
    blurb: "Clawed back from the driver's payout, driver-first. Vellon keeps its fee.",
  },
  {
    value: "platform_mistake",
    label: "Platform mistake",
    blurb: "Vellon absorbs it — the driver keeps their payout.",
  },
  {
    value: "goodwill",
    label: "Goodwill gesture",
    blurb: "Vellon absorbs it — the driver keeps their payout.",
  },
];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RefundSection() {
  const [phone, setPhone] = useState("");
  const [rides, setRides] = useState<RefundableRide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState<RefundableRide | null>(null); // ride being refunded
  const [pending, startTransition] = useTransition();

  const search = useCallback(() => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await searchRefundableRides({ phone });
      if (res.ok) setRides(res.data);
      else setError(res.error);
    });
  }, [phone]);

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-300">Refunds</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Look up a passenger&apos;s completed card rides by phone and issue a
        refund. Cash rides aren&apos;t refundable here — they&apos;re invoiced
        monthly.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Passenger phone (e.g. 902 555 0134)"
          className="w-64 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <button
          onClick={search}
          disabled={pending}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
        >
          {pending ? "…" : "Search"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {note && (
        <p className="mt-3 rounded-md border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      {rides && rides.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500">
          No completed card rides for that number.
        </p>
      )}

      {rides && rides.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">Driver</th>
                <th className="px-4 py-2.5 text-right font-medium">Fare</th>
                <th className="px-4 py-2.5 text-right font-medium">Refunded</th>
                <th className="px-4 py-2.5 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rides.map((r) => (
                <tr key={r.id} className="border-b border-zinc-900 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-300">{fmtDate(r.completedAt)}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{r.companyName}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{r.driverName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">
                    {r.fareFinal != null ? cad(r.fareFinal) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {r.refundedCents > 0 ? cad(r.refundedCents / 100) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.refundable ? (
                      <button
                        onClick={() => setActive(r)}
                        className="rounded-md border border-amber-800/60 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-950/40"
                      >
                        Refund
                      </button>
                    ) : (
                      <span className="text-xs text-zinc-600" title={r.blockedReason ?? ""}>
                        {r.blockedReason ?? "—"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <RefundModal
          ride={active}
          onClose={() => setActive(null)}
          onDone={(msg) => {
            setActive(null);
            setNote(msg);
            search(); // refresh so the row reflects the new refunded total
          }}
        />
      )}
    </section>
  );
}

function RefundModal({
  ride,
  onClose,
  onDone,
}: {
  ride: RefundableRide;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const remainingCents = (ride.chargedCents ?? 0) - ride.refundedCents;
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [dollars, setDollars] = useState("");
  const [reason, setReason] = useState<RefundReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const partialCents =
    mode === "partial" ? Math.round(parseFloat(dollars || "0") * 100) : remainingCents;
  const amountCents = mode === "full" ? remainingCents : partialCents;
  const amountValid = amountCents > 0 && amountCents <= remainingCents;

  const submit = () => {
    if (!reason) {
      setError("Pick a reason.");
      return;
    }
    if (!amountValid) {
      setError(`Enter an amount between $0.01 and ${cad(remainingCents / 100)}.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await refundRide({
        rideId: ride.id,
        amountCents: mode === "full" ? undefined : amountCents,
        reason,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onDone(
        `Refunded ${cad(res.amountCents / 100)}` +
          (res.clawback
            ? " — the driver/company clawback will complete via Stripe shortly."
            : " — absorbed by Vellon."),
      );
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-zinc-100">Refund ride</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {ride.companyName} · {ride.passengerName ?? ride.passengerPhone ?? "passenger"} ·{" "}
          {fmtDate(ride.completedAt)}
        </p>
        <p className="mt-2 text-sm text-zinc-400">
          Fare {ride.fareFinal != null ? cad(ride.fareFinal) : "—"}
          {ride.refundedCents > 0 && (
            <> · already refunded {cad(ride.refundedCents / 100)}</>
          )}
          <> · up to {cad(remainingCents / 100)} refundable</>
        </p>

        {/* Amount */}
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => setMode("full")}
              className={
                "rounded-md border px-3 py-1.5 text-sm " +
                (mode === "full"
                  ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/40")
              }
            >
              Full ({cad(remainingCents / 100)})
            </button>
            <button
              onClick={() => setMode("partial")}
              className={
                "rounded-md border px-3 py-1.5 text-sm " +
                (mode === "partial"
                  ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/40")
              }
            >
              Partial
            </button>
            {mode === "partial" && (
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-zinc-500">
                  $
                </span>
                <input
                  autoFocus
                  value={dollars}
                  onChange={(e) => setDollars(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-6 pr-2 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
                />
              </div>
            )}
          </div>
        </div>

        {/* Reason */}
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Reason</p>
          <div className="mt-2 space-y-1.5">
            {REASON_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setReason(o.value)}
                className={
                  "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left " +
                  (reason === o.value
                    ? "border-zinc-500 bg-zinc-800/60"
                    : "border-zinc-800 hover:bg-zinc-800/30")
                }
              >
                <span className="text-sm text-zinc-200">{o.label}</span>
                <span className="text-xs text-zinc-500">{o.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending || !reason || !amountValid}
            className="rounded-md border border-amber-700 bg-amber-900/30 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-900/50 disabled:opacity-50"
          >
            {pending ? "Refunding…" : `Refund ${amountValid ? cad(amountCents / 100) : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
