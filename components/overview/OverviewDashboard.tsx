"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { getOverview, type Overview } from "@/app/(app)/overview/actions";

const cad = (n: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);
const cad2 = (n: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(n);

const tile =
  "block rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70";

function relTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Single-series sparkline (total monthly platform fees), accent-colored.
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 132;
  const h = 34;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = h - ((p - min) / span) * (h - 4) - 2;
    return [x, y] as const;
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={d} fill="none" stroke="#E8500A" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2.5} fill="#E8500A" />
    </svg>
  );
}

const STATUS_PILL: Record<Overview["portfolio"][number]["onboardStatus"], { text: string; cls: string }> = {
  needs_setup: { text: "Needs setup", cls: "border-zinc-700 bg-zinc-800/40 text-zinc-300" },
  cash_ready: { text: "Cash-ready", cls: "border-amber-900/40 bg-amber-950/30 text-amber-300/90" },
  fully_ready: { text: "Fully ready", cls: "border-emerald-900/40 bg-emerald-950/30 text-emerald-300" },
};

export function OverviewDashboard() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getOverview();
      if (res.ok) {
        setOv(res.data);
        setError(null);
      } else setError(res.error);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const delta =
    ov && ov.revenue.available && ov.revenue.prevFee > 0
      ? (ov.revenue.mtdFee - ov.revenue.prevFee) / ov.revenue.prevFee
      : null;

  const healthTone =
    ov?.health.status === "bad"
      ? "text-red-300"
      : ov?.health.status === "warn"
        ? "text-amber-300"
        : "text-emerald-300";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Overview</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Portfolio at a glance. Today: M&amp;G C&amp;J (mgcj).
          </p>
        </div>
        <div className="flex items-center gap-3">
          {ov && <span className="text-xs text-zinc-600">Updated {relTime(ov.generatedAt)}</span>}
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

      {!ov && !error && <p className="mt-6 text-sm text-zinc-500">Loading…</p>}

      {ov && (
        <div className="mt-6 space-y-8">
          {/* ── Headline tiles ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* Companies */}
            <Link href="/onboarding" className={tile}>
              <p className="text-sm text-zinc-400">Companies</p>
              <p className="mt-2 text-3xl font-semibold text-zinc-100">
                {ov.companies.total}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {ov.companies.ready} fully ready
                {ov.companies.attention.length > 0 && (
                  <span className="text-amber-400">
                    {" "}
                    · {ov.companies.attention.length} need attention
                  </span>
                )}
              </p>
            </Link>

            {/* Revenue MTD */}
            <Link href="/revenue" className={tile}>
              <div className="flex items-start justify-between">
                <p className="text-sm text-zinc-400">Platform fees (MTD)</p>
                {ov.revenue.available && <Sparkline points={ov.revenue.spark.map((s) => s.fee)} />}
              </div>
              <p className="mt-2 text-3xl font-semibold text-accent">
                {ov.revenue.available ? cad2(ov.revenue.mtdFee) : "—"}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {ov.revenue.available ? (
                  <>
                    {delta === null ? (
                      <span className="text-zinc-600">no prior month</span>
                    ) : (
                      <span className={delta >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(0)}% vs last month
                      </span>
                    )}
                    {"  ·  "}
                    <span className="text-zinc-600">
                      {cad(ov.revenue.mtdCard)} card / {cad(ov.revenue.mtdCash)} cash
                    </span>
                  </>
                ) : (
                  <span className="text-amber-400">migrations not applied</span>
                )}
              </p>
            </Link>

            {/* Ops health */}
            <Link href="/health" className={tile}>
              <p className="text-sm text-zinc-400">Ops health</p>
              <p className={"mt-2 text-3xl font-semibold " + healthTone}>
                {ov.health.status === "ok"
                  ? "All clear"
                  : ov.health.status === "warn"
                    ? "Partial"
                    : `${ov.health.detectorsFiring + ov.health.cronIssues} issue${ov.health.detectorsFiring + ov.health.cronIssues === 1 ? "" : "s"}`}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {ov.health.detectorsFiring} detector{ov.health.detectorsFiring === 1 ? "" : "s"} firing
                {" · "}
                {ov.health.available ? (
                  `${ov.health.cronIssues} cron issue${ov.health.cronIssues === 1 ? "" : "s"}`
                ) : (
                  <span className="text-amber-400">cron data unavailable</span>
                )}
              </p>
            </Link>
          </div>

          {/* ── Needs attention ── */}
          {ov.companies.attention.length > 0 && (
            <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
              <p className="text-sm font-medium text-amber-200">Needs attention</p>
              <ul className="mt-2 space-y-1">
                {ov.companies.attention.map((a) => (
                  <li key={a.name} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-300">{a.name}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-amber-300/80">{a.issue}</span>
                      <Link href="/onboarding" className="text-xs text-accent hover:text-accent-hover">
                        Resume →
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Portfolio ── */}
          <section>
            <h2 className="text-sm font-semibold text-zinc-300">Portfolio</h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[600px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-2.5 font-medium">Company</th>
                    <th className="px-4 py-2.5 font-medium">Onboarding</th>
                    <th className="px-4 py-2.5 font-medium">Stripe</th>
                    <th className="px-4 py-2.5 text-right font-medium">Fees (MTD)</th>
                    <th className="px-4 py-2.5 text-right font-medium">Rides (MTD)</th>
                  </tr>
                </thead>
                <tbody>
                  {ov.portfolio.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                        No companies yet. <Link href="/onboarding" className="text-accent">Onboard one →</Link>
                      </td>
                    </tr>
                  )}
                  {ov.portfolio.map((c) => {
                    const p = STATUS_PILL[c.onboardStatus];
                    return (
                      <tr key={c.companyId} className="border-b border-zinc-900 last:border-0">
                        <td className="px-4 py-2.5 text-zinc-200">{c.name}</td>
                        <td className="px-4 py-2.5">
                          <span className={"inline-block rounded-full border px-2 py-0.5 text-xs " + p.cls}>
                            {p.text}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400">
                          {c.stripeReady ? (
                            <span className="text-emerald-300">✅ Onboarded</span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-zinc-100">
                          {ov.revenue.available ? cad2(c.mtdFee) : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-zinc-500">
                          {ov.revenue.available ? c.mtdRides : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
