"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  getHealth,
  type Health,
  type CronJob,
} from "@/app/(app)/[slug]/health/actions";

const card = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-4";
const muted = "text-xs text-zinc-500";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Light staleness heuristic: only for simple every-N-minutes schedules — either
// `* * * * *` (every minute) or `*/N * * * *`. A job that hasn't run in >3× its
// interval is likely stalled. Non-trivial schedules (hourly/daily) get no flag —
// we don't guess.
function isStalled(job: CronJob): boolean {
  if (!job.active || !job.last_run) return false;
  const s = job.schedule.trim();
  let interval: number | null = null;
  if (/^\* \* \* \* \*$/.test(s)) interval = 1;
  else {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(s);
    if (m) interval = Number(m[1]);
  }
  if (interval === null) return false;
  const ageMin = (Date.now() - new Date(job.last_run).getTime()) / 60_000;
  return ageMin > Math.max(interval * 3, 10);
}

function Stat({
  label,
  value,
  tone = "default",
  sub,
}: {
  label: string;
  value: string | number;
  tone?: "default" | "warn" | "bad" | "good";
  sub?: string;
}) {
  const color =
    tone === "bad"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "good"
          ? "text-emerald-300"
          : "text-zinc-100";
  return (
    <div className={card}>
      <p className="text-sm text-zinc-400">{label}</p>
      <p className={"mt-2 text-2xl font-semibold " + color}>{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-600">{sub}</p>}
    </div>
  );
}

export function HealthDashboard({ slug }: { slug: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getHealth(slug);
      if (res.ok) {
        setHealth(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (auto) timer.current = setInterval(load, 30_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, load]);

  const problems = health?.detectors.filter((d) => d.count > 0).length ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">DB / Ops health</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Row counts, pg_cron last-run/success, cron→function HTTP health, and
            stuck-state detectors. Live, read-only.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Auto (30s)
          </label>
          <button
            onClick={load}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50"
          >
            Refresh
          </button>
        </div>
      </div>

      {health && (
        <p className="mt-2 text-xs text-zinc-600">
          Updated {relTime(health.generatedAt)} ·{" "}
          {problems === 0 ? (
            <span className="text-emerald-400">all detectors clear</span>
          ) : (
            <span className="text-amber-400">
              {problems} detector{problems === 1 ? "" : "s"} firing
            </span>
          )}
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {!health && !error && (
        <p className="mt-6 text-sm text-zinc-500">Loading…</p>
      )}

      {health && (
        <div className="mt-6 space-y-8">
          {/* ── Stuck-state detectors ── */}
          <section>
            <h2 className="text-sm font-semibold text-zinc-300">
              Stuck-state detectors
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {health.detectors.map((d) => {
                const bad = d.count > 0;
                return (
                  <div
                    key={d.key}
                    className={
                      "rounded-xl border p-4 " +
                      (bad
                        ? "border-red-900/50 bg-red-950/20"
                        : "border-zinc-800 bg-zinc-900/40")
                    }
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-zinc-300">{d.label}</p>
                      <span
                        className={
                          "text-lg font-semibold " +
                          (bad ? "text-red-300" : "text-emerald-400")
                        }
                      >
                        {bad ? d.count : "✓"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-600">{d.hint}</p>
                    {bad && d.sampleIds.length > 0 && (
                      <p className="mt-2 font-mono text-[11px] text-zinc-500">
                        {d.sampleIds.map((id) => id.slice(0, 8)).join(", ")}
                        {d.count > d.sampleIds.length && " …"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── pg_cron health ── */}
          <section>
            <h2 className="text-sm font-semibold text-zinc-300">
              Scheduled jobs (pg_cron)
            </h2>
            {health.systemError ? (
              <p className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300/90">
                {health.systemError}
              </p>
            ) : health.system ? (
              <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                      <th className="px-4 py-2.5 font-medium">Job</th>
                      <th className="px-4 py-2.5 font-medium">Schedule</th>
                      <th className="px-4 py-2.5 font-medium">Last run</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Fails 24h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.system.cron.map((j) => {
                      const stalled = isStalled(j);
                      const failed = j.last_status === "failed";
                      return (
                        <tr
                          key={j.jobid}
                          className="border-b border-zinc-900 last:border-0"
                        >
                          <td className="px-4 py-2.5 text-zinc-200">
                            {j.jobname ?? `#${j.jobid}`}
                            {!j.active && (
                              <span className="ml-2 text-xs text-zinc-600">
                                (disabled)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">
                            {j.schedule}
                          </td>
                          <td
                            className={
                              "px-4 py-2.5 " +
                              (stalled ? "text-red-300" : "text-zinc-400")
                            }
                          >
                            {relTime(j.last_run)}
                            {stalled && " ⚠ stalled"}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={
                                failed
                                  ? "text-red-300"
                                  : j.last_status === "succeeded"
                                    ? "text-emerald-300"
                                    : "text-zinc-500"
                              }
                            >
                              {j.last_status ?? "—"}
                            </span>
                          </td>
                          <td
                            className={
                              "px-4 py-2.5 " +
                              (j.failures_24h > 0
                                ? "text-red-300"
                                : "text-zinc-500")
                            }
                          >
                            {j.failures_24h}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          {/* ── HTTP proxy + bloat ── */}
          {health.system && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-300">
                Cron→function HTTP &amp; internal-table size
              </h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="HTTP calls (24h)"
                  value={health.system.http.total_24h}
                  sub={`${health.system.http.failed_24h} non-2xx`}
                  tone={health.system.http.failed_24h > 0 ? "warn" : "good"}
                />
                <Stat
                  label="HTTP fails (1h)"
                  value={health.system.http.failed_1h}
                  sub={`of ${health.system.http.total_1h} calls`}
                  tone={health.system.http.failed_1h > 0 ? "bad" : "good"}
                />
                <Stat
                  label="cron.job_run_details"
                  value={health.system.bloat.job_run_details_rows.toLocaleString()}
                  sub={`oldest ${relTime(health.system.bloat.job_run_details_oldest)} — cleanup caps ~3d`}
                  tone={
                    health.system.bloat.job_run_details_rows > 200_000
                      ? "warn"
                      : "default"
                  }
                />
                <Stat
                  label="net._http_response"
                  value={health.system.bloat.http_response_rows.toLocaleString()}
                  sub={`oldest ${relTime(health.system.bloat.http_response_oldest)} — cleanup caps ~3d`}
                  tone={
                    health.system.bloat.http_response_rows > 200_000
                      ? "warn"
                      : "default"
                  }
                />
              </div>
              <p className="mt-2 text-xs text-zinc-600">
                A row count far above ~3 days of runs, or an oldest-row age well
                past 3 days, means the nightly cleanup-cron-logs job has died.
              </p>
            </section>
          )}

          {/* ── Row counts ── */}
          <section>
            <h2 className="text-sm font-semibold text-zinc-300">Table row counts</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {health.counts.map((c) => (
                <div key={c.table} className={card}>
                  <p className="truncate text-xs text-zinc-500">{c.table}</p>
                  <p className="mt-1 text-lg font-semibold text-zinc-100">
                    {c.count.toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
