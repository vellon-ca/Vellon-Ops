"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  getRevenue,
  generateInvoices,
  listInvoices,
  updateInvoiceStatus,
  sendInvoice,
  previewInvoicePdf,
  type RevenueSummary,
  type Invoice,
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
            <Tile label="Platform fees" value={cad(rev.totals.fee)} accent />
            <Tile
              label="Card fees"
              value={cad(rev.totals.cardFee)}
              dot={CARD}
              sub="auto-collected"
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

          <InvoiceSection />
        </div>
      )}
    </div>
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
