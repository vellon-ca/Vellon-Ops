"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { listCompanies } from "@/app/(app)/onboarding/actions";
import { getHealth } from "@/app/(app)/health/actions";
import { getRevenue } from "@/app/(app)/revenue/actions";

// UTC month bounds (match the revenue RPC's bucketing).
function thisMonthRange() {
  const n = new Date();
  const from = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  const to = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1));
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}
function sixMonthRange() {
  const n = new Date();
  const from = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 5, 1));
  const to = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1));
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}
function lastMonthKey(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Same staleness heuristic as the Health dashboard (every-minute or */N jobs).
function stalled(schedule: string, lastRun: string | null, active: boolean): boolean {
  if (!active || !lastRun) return false;
  const s = schedule.trim();
  let interval: number | null = null;
  if (/^\* \* \* \* \*$/.test(s)) interval = 1;
  else {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(s);
    if (m) interval = Number(m[1]);
  }
  if (interval === null) return false;
  const ageMin = (Date.now() - new Date(lastRun).getTime()) / 60_000;
  return ageMin > Math.max(interval * 3, 10);
}

export type Overview = {
  generatedAt: string;
  companies: {
    total: number;
    ready: number;
    attention: { name: string; issue: string }[];
  };
  revenue: {
    available: boolean;
    mtdFee: number;
    mtdCard: number;
    mtdCash: number;
    mtdRides: number;
    prevFee: number;
    spark: { month: string; fee: number }[];
    perCompany: Record<string, { fee: number; rides: number }>;
  };
  health: {
    available: boolean;
    status: "ok" | "warn" | "bad";
    detectorsFiring: number;
    cronIssues: number;
  };
  portfolio: {
    companyId: string;
    name: string;
    onboardStatus: "needs_setup" | "cash_ready" | "fully_ready";
    stripeReady: boolean;
    mtdFee: number;
    mtdRides: number;
  }[];
};

export async function getOverview(): Promise<
  { ok: true; data: Overview } | { ok: false; error: string }
> {
  await requirePlatformOwner();

  const { fromISO: mFrom, toISO: mTo } = thisMonthRange();
  const { fromISO: sFrom, toISO: sTo } = sixMonthRange();

  const [companiesRes, healthRes, revMonthRes, revSixRes] = await Promise.all([
    listCompanies(),
    getHealth(),
    getRevenue({ fromISO: mFrom, toISO: mTo }),
    getRevenue({ fromISO: sFrom, toISO: sTo }),
  ]);

  if (!companiesRes.ok) return { ok: false, error: companiesRes.error };
  const companies = companiesRes.data;

  // ── Companies rollup ──
  const attention: { name: string; issue: string }[] = [];
  let ready = 0;
  for (const c of companies) {
    if (!c.dispatcherName) attention.push({ name: c.name, issue: "No dispatcher yet" });
    else if (!c.stripeOnboarded)
      attention.push({ name: c.name, issue: "Stripe not finished" });
    else ready++;
  }

  // ── Revenue rollup ──
  const revenue: Overview["revenue"] = {
    available: revMonthRes.ok,
    mtdFee: 0,
    mtdCard: 0,
    mtdCash: 0,
    mtdRides: 0,
    prevFee: 0,
    spark: [],
    perCompany: {},
  };
  if (revMonthRes.ok) {
    revenue.mtdFee = revMonthRes.data.totals.fee;
    revenue.mtdCard = revMonthRes.data.totals.cardFee;
    revenue.mtdCash = revMonthRes.data.totals.cashFee;
    revenue.mtdRides = revMonthRes.data.totals.rides;
    for (const c of revMonthRes.data.byCompany)
      revenue.perCompany[c.companyId] = { fee: c.totalFee, rides: c.rides };
  }
  if (revSixRes.ok) {
    revenue.spark = revSixRes.data.byMonth.map((m) => ({
      month: m.month,
      fee: m.totalFee,
    }));
    const prev = revSixRes.data.byMonth.find((m) => m.month === lastMonthKey());
    revenue.prevFee = prev?.totalFee ?? 0;
  }

  // ── Health rollup ──
  const detectorsFiring = healthRes.ok
    ? healthRes.data.detectors.filter((d) => d.count > 0).length
    : 0;
  let cronIssues = 0;
  const systemAvailable = healthRes.ok && !!healthRes.data.system;
  if (healthRes.ok && healthRes.data.system) {
    for (const j of healthRes.data.system.cron) {
      if (
        j.last_status === "failed" ||
        j.failures_24h > 0 ||
        stalled(j.schedule, j.last_run, j.active)
      )
        cronIssues++;
    }
  }
  const health: Overview["health"] = {
    available: systemAvailable,
    status:
      detectorsFiring > 0 || cronIssues > 0
        ? "bad"
        : systemAvailable
          ? "ok"
          : "warn",
    detectorsFiring,
    cronIssues,
  };

  // ── Portfolio table ──
  const portfolio: Overview["portfolio"] = companies.map((c) => ({
    companyId: c.id,
    name: c.name,
    onboardStatus: !c.dispatcherName
      ? "needs_setup"
      : c.stripeOnboarded
        ? "fully_ready"
        : "cash_ready",
    stripeReady: c.stripeOnboarded,
    mtdFee: revenue.perCompany[c.id]?.fee ?? 0,
    mtdRides: revenue.perCompany[c.id]?.rides ?? 0,
  }));

  return {
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      companies: { total: companies.length, ready, attention },
      revenue,
      health,
      portfolio,
    },
  };
}
