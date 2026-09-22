"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import {
  loadSpoke,
  spokeSupabase,
  spokeStripeGet,
  spokeStripePost,
  spokeStripeConfigured,
  type Spoke,
} from "@/lib/connectors/spoke";

export type PlatformSettings = {
  legalName: string | null;
  businessNumber: string | null;
  hstNumber: string | null;
  mailingAddress: string | null;
  paymentInstructions: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// NOTE: platform_settings is HUB-GLOBAL and deliberately takes no slug and no
// write gate. It holds Vellon's OWN legal name, business/HST numbers and
// payment instructions — the invoice letterhead — not anything derived from a
// spoke. Gating it on environment would only stop you editing Vellon's own
// details while a dev spoke happens to be selected, which protects nothing.
// This is not a missed Tier 1 gate; do not "fix" it into one.
export async function getPlatformSettings(): Promise<Result<PlatformSettings>> {
  await requirePlatformOwner();

  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("legal_name, business_number, hst_number, mailing_address, payment_instructions")
    .eq("id", 1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    data: {
      legalName: data?.legal_name ?? null,
      businessNumber: data?.business_number ?? null,
      hstNumber: data?.hst_number ?? null,
      mailingAddress: data?.mailing_address ?? null,
      paymentInstructions: data?.payment_instructions ?? null,
    },
  };
}

export async function updatePlatformSettings(
  input: PlatformSettings,
): Promise<Result<PlatformSettings>> {
  const owner = await requirePlatformOwner();

  const { data: before } = await supabaseAdmin
    .from("platform_settings")
    .select("legal_name, business_number, hst_number, mailing_address, payment_instructions")
    .eq("id", 1)
    .maybeSingle();

  const after = {
    legal_name: input.legalName?.trim() || null,
    business_number: input.businessNumber?.trim() || null,
    hst_number: input.hstNumber?.trim() || null,
    mailing_address: input.mailingAddress?.trim() || null,
    payment_instructions: input.paymentInstructions?.trim() || null,
    updated_at: new Date().toISOString(),
    updated_by: owner.id,
  };

  const { error } = await supabaseAdmin
    .from("platform_settings")
    .update(after)
    .eq("id", 1);
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    action: "platform_settings.update",
    target: "platform_settings",
    before,
    after,
  });

  return { ok: true, data: input };
}

// ── Payout timing config ─────────────────────────────────────────────
// Lives in the mgcj (spoke) project's payout_config table so mgcj's
// create-connect-account edge function can read it directly. We reach it via
// the service-role connector, and (per Victor's call) also push the values to
// every existing Stripe connected account on save — drivers vs companies told
// apart by whether the account carries a supabase_user_id in its metadata.

export type PayoutConfig = {
  driverDelayDays: number;
  companyDelayDays: number;
};

export type PayoutPushSummary = {
  updated: number;   // accounts set to exactly the requested value
  flooredToStripeMin: number; // accounts Stripe floored above our target
  failed: number;    // accounts that errored for some other reason
  skipped: boolean;  // Stripe not configured -> DB saved, no push attempted
};

const DAYS_MIN = 0;
const DAYS_MAX = 31;

function clampDays(n: unknown): number | null {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < DAYS_MIN || v > DAYS_MAX) return null;
  return v;
}

export async function getPayoutConfig(
  slug: string,
): Promise<Result<PayoutConfig>> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);

  const { data, error } = await spokeSupabase(spoke)
    .from("payout_config")
    .select("driver_delay_days, company_delay_days")
    .eq("id", 1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    data: {
      driverDelayDays: data?.driver_delay_days ?? 2,
      companyDelayDays: data?.company_delay_days ?? 2,
    },
  };
}

// Set one account's automatic payout delay. Stripe floors delay_days at the
// account's country minimum (~2-3 business days for CA); if it rejects our
// target as too low, retry letting Stripe pick its own minimum so the account
// still lands as fast as allowed rather than erroring. Returns which happened.
async function applyDelayToAccount(
  spoke: Spoke,
  accountId: string,
  days: number,
): Promise<"updated" | "floored" | "failed"> {
  const res = await spokeStripePost(spoke, `/accounts/${accountId}`, {
    "settings[payouts][schedule][interval]": "daily",
    "settings[payouts][schedule][delay_days]": String(days),
  });
  if (!res.error) return "updated";

  if (String(res.error?.param ?? "").includes("delay_days")) {
    // Below the country floor — set interval only, let Stripe apply its min.
    const retry = await spokeStripePost(spoke, `/accounts/${accountId}`, {
      "settings[payouts][schedule][interval]": "daily",
    });
    return retry.error ? "failed" : "floored";
  }
  return "failed";
}

async function pushDelaysToStripe(
  spoke: Spoke,
  cfg: PayoutConfig,
): Promise<PayoutPushSummary> {
  const summary: PayoutPushSummary = {
    updated: 0,
    flooredToStripeMin: 0,
    failed: 0,
    skipped: false,
  };

  if (!spokeStripeConfigured(spoke)) {
    summary.skipped = true;
    return summary;
  }

  // Page through all connected accounts (the platform has a handful today).
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const list = await spokeStripeGet(spoke, `/accounts?${qs.toString()}`);
    if (list.error || !Array.isArray(list.data)) break;

    for (const acct of list.data) {
      // A driver's own Express account is stamped with supabase_user_id at
      // creation (see create-connect-account); a company account isn't.
      const isDriver = Boolean(acct?.metadata?.supabase_user_id);
      const days = isDriver ? cfg.driverDelayDays : cfg.companyDelayDays;
      const outcome = await applyDelayToAccount(spoke, acct.id, days);
      if (outcome === "updated") summary.updated++;
      else if (outcome === "floored") summary.flooredToStripeMin++;
      else summary.failed++;
    }

    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  return summary;
}

export async function updatePayoutConfig(
  slug: string,
  input: PayoutConfig,
): Promise<Result<{ config: PayoutConfig; push: PayoutPushSummary }>> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);

  const driverDelayDays = clampDays(input.driverDelayDays);
  const companyDelayDays = clampDays(input.companyDelayDays);
  if (driverDelayDays === null || companyDelayDays === null) {
    return { ok: false, error: `Delay days must be whole numbers between ${DAYS_MIN} and ${DAYS_MAX}.` };
  }

  const mgcj = spokeSupabase(spoke);

  const { data: before } = await mgcj
    .from("payout_config")
    .select("driver_delay_days, company_delay_days")
    .eq("id", 1)
    .maybeSingle();

  const after = {
    driver_delay_days: driverDelayDays,
    company_delay_days: companyDelayDays,
    updated_at: new Date().toISOString(),
    updated_by: owner.id,
  };

  // Upsert the singleton (row is seeded by migration, but be resilient).
  const { error } = await mgcj
    .from("payout_config")
    .upsert({ id: 1, ...after });
  if (error) return { ok: false, error: error.message };

  // Push to existing Stripe accounts. A push failure must NOT lose the saved
  // config — it's already persisted above — so we surface it in the summary
  // rather than throwing.
  const push = await pushDelaysToStripe(spoke, { driverDelayDays, companyDelayDays });

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "payout_config.update",
    target: "payout_config",
    before,
    after: { ...after, _stripe_push: push },
  });

  return { ok: true, data: { config: { driverDelayDays, companyDelayDays }, push } };
}
