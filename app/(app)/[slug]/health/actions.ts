"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { loadSpoke, spokeSupabase } from "@/lib/connectors/spoke";

// ── Types ───────────────────────────────────────────────────────────
export type Detector = {
  key: string;
  label: string;
  hint: string;
  count: number;
  sampleIds: string[];
};

export type CronJob = {
  jobid: number;
  jobname: string | null;
  schedule: string;
  active: boolean;
  last_run: string | null;
  last_status: string | null;
  failures_24h: number;
};

export type SystemHealth = {
  cron: CronJob[];
  bloat: {
    job_run_details_rows: number;
    job_run_details_oldest: string | null;
    http_response_rows: number;
    http_response_oldest: string | null;
  };
  http: {
    total_24h: number;
    failed_24h: number;
    total_1h: number;
    failed_1h: number;
  };
};

export type Health = {
  generatedAt: string;
  counts: { table: string; count: number }[];
  detectors: Detector[];
  // null until the mgcj migration is applied; carries a hint when unreachable.
  system: SystemHealth | null;
  systemError: string | null;
};

const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

// A detector is a filtered query that returns a small id sample plus the exact
// total in one round-trip (select("id", { count: "exact" }).limit(5)).
async function runDetector(
  meta: { key: string; label: string; hint: string },
  query: PromiseLike<{
    data: { id: string }[] | null;
    count: number | null;
  }>,
): Promise<Detector> {
  const { data, count } = await query;
  return {
    ...meta,
    count: count ?? 0,
    sampleIds: (data ?? []).map((r) => r.id),
  };
}

export async function getHealth(
  slug: string,
): Promise<{ ok: true; data: Health } | { ok: false; error: string }> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  // ── Row counts (public tables) ────────────────────────────────────
  const countTables = [
    "companies",
    "profiles",
    "drivers",
    "rides",
    "driver_invites",
    "ride_reviews",
    "payment_methods",
  ];
  const countResults = await Promise.all(
    countTables.map(async (t) => {
      const { count } = await mgcj
        .from(t)
        .select("*", { count: "exact", head: true });
      return { table: t, count: count ?? 0 };
    }),
  );

  // ── Stuck-state detectors. Thresholds sit *above* each pipeline's SLA +
  // cron cadence so a ride that's legitimately mid-cycle doesn't flag. ──
  const detectors = await Promise.all([
    // expire-pending-rides cancels immediate pending at ~5 min (on a cron), so
    // >8 min pending is genuinely stuck, not just between ticks.
    runDetector(
      {
        key: "pending_stuck",
        label: "Immediate rides stuck pending",
        hint: "assign-ride never placed them; expire-pending-rides should have cancelled by ~5 min.",
      },
      mgcj
        .from("rides")
        .select("id", { count: "exact" })
        .eq("status", "pending")
        .lt("created_at", mins(8))
        .is("scheduled_at", null)
        .limit(5),
    ),
    // reassign-stale-rides cycles offered rides at 60s; >4 min means it isn't.
    runDetector(
      {
        key: "offered_stuck",
        label: "Rides stuck offered",
        hint: "reassign-stale-rides cycles offers at ~60s; these aren't moving.",
      },
      mgcj
        .from("rides")
        .select("id", { count: "exact" })
        .eq("status", "offered")
        .lt("offered_at", mins(4))
        .limit(5),
    ),
    // expire-pending-rides auto-cancels missed scheduled rides at 20 min past;
    // >25 min still open means that cleanup isn't firing.
    runDetector(
      {
        key: "scheduled_missed",
        label: "Scheduled rides past pickup, still open",
        hint: "expire-pending-rides should mark these missed_window ~20 min past pickup.",
      },
      mgcj
        .from("rides")
        .select("id", { count: "exact" })
        .in("status", ["scheduled", "pending", "offered"])
        .not("scheduled_at", "is", null)
        .lt("scheduled_at", mins(25))
        .limit(5),
    ),
    // in_progress for hours = a ride the driver never completed.
    runDetector(
      {
        key: "in_progress_long",
        label: "Rides in-progress for 4h+",
        hint: "Likely a driver who never tapped complete; fare/receipt is stranded.",
      },
      mgcj
        .from("rides")
        .select("id", { count: "exact" })
        .eq("status", "in_progress")
        .lt("updated_at", hours(4))
        .limit(5),
    ),
    // Completed card ride whose PaymentIntent never captured/succeeded. Capture
    // is async (driver completes → capture-payment → Stripe webhook flips
    // payment_status), so a just-completed ride sits uncaptured for a few
    // seconds legitimately — only flag ones stuck >10 min. `updated_at` resets
    // on every ride UPDATE, so on a stuck ride it ≈ completion time. The
    // is-null arm catches rows whose payment_status was never set (NOT IN drops
    // NULLs), which would otherwise slip past the exact case we're hunting.
    runDetector(
      {
        key: "payment_stuck",
        label: "Completed card rides not captured",
        hint: "capture-payment failed or never ran (>10 min); revenue not collected.",
      },
      mgcj
        .from("rides")
        .select("id", { count: "exact" })
        .eq("status", "completed")
        .eq("payment_method", "card")
        .lt("updated_at", mins(10))
        .or("payment_status.is.null,payment_status.not.in.(succeeded,refunded)")
        .limit(5),
    ),
    // Driver flagged online but hasn't broadcast a location in 5 min = a ghost
    // in the dispatch pool (app suspended/crashed without going offline).
    runDetector(
      {
        key: "ghost_online",
        label: "Ghost-online drivers",
        hint: "is_active with a stale location (>5 min); assign-ride may pick a driver who's actually gone.",
      },
      mgcj
        .from("drivers")
        .select("id", { count: "exact" })
        .eq("is_active", true)
        .not("current_lat", "is", null)
        .lt("updated_at", mins(5))
        .limit(5),
    ),
  ]);

  // ── System schemas via the mgcj RPC (Path 2). Degrades gracefully until
  // the migration is applied (or while PostgREST's schema cache is stale). ──
  let system: SystemHealth | null = null;
  let systemError: string | null = null;
  const { data: sys, error: sysErr } = await mgcj.rpc("ops_health_system");
  if (sysErr) {
    systemError =
      sysErr.code === "PGRST202" || /not find|does not exist/i.test(sysErr.message)
        ? "ops_health_system() not found — apply supabase/migrations/20260714_ops_health_system.sql in the mgcj SQL editor, then NOTIFY pgrst, 'reload schema'."
        : sysErr.message;
  } else {
    system = sys as SystemHealth;
  }

  return {
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      counts: countResults,
      detectors,
      system,
      systemError,
    },
  };
}
