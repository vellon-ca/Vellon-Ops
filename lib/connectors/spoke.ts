import "server-only";
import { cache } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";

// ── spoke resolver ──────────────────────────────────────────────────
// Turns a route slug into a connected project ("spoke") and the privileged
// credentials for it. Replaces lib/connectors/mgcj.ts's process.env reads,
// which could only ever name one spoke.
//
// SERVER ONLY. Every client this hands back bypasses RLS on a customer
// database — it must never be constructed anywhere reachable from a browser.

export type SpokeEnvironment = "prod" | "dev";

export type Spoke = {
  id: string;
  slug: string;
  name: string;
  environment: SpokeEnvironment;
  credentialKey: string;
};

export class SpokeError extends Error {}

// Cached per-request so N server actions on one page don't each re-query the
// hub for the same row. React's cache() is request-scoped, so this cannot
// leak one request's spoke into another's.
export const loadSpoke = cache(async (slug: string): Promise<Spoke> => {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, slug, name, environment, credential_key, status")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw new SpokeError(`Could not load project "${slug}": ${error.message}`);
  if (!data) throw new SpokeError(`No such project: "${slug}".`);
  if (data.status !== "active") {
    throw new SpokeError(`Project "${slug}" is ${data.status}, not active.`);
  }
  // A row predating migration 0007, or one added by hand without a handle.
  // Failing loudly beats resolving `undefined_SUPABASE_URL` at request time.
  if (!data.credential_key) {
    throw new SpokeError(
      `Project "${slug}" has no credential_key — it cannot be connected to. ` +
        `Set one (see supabase/migrations/0007_project_environment_and_credentials.sql).`,
    );
  }

  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    environment: data.environment as SpokeEnvironment,
    credentialKey: data.credential_key,
  };
});

// ── credential resolution ───────────────────────────────────────────
// The handle is an env-var PREFIX, resolved to a quad. Credentials live in the
// env store and never in the hub table — see the migration for why.

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new SpokeError(
      `Missing environment variable ${key}. Every spoke needs ` +
        `<KEY>_SUPABASE_URL, <KEY>_SUPABASE_SERVICE_ROLE and <KEY>_STRIPE_SECRET.`,
    );
  }
  return v;
}

export function spokeSupabase(spoke: Spoke): SupabaseClient {
  const url = requireEnv(`${spoke.credentialKey}_SUPABASE_URL`);
  const key = requireEnv(`${spoke.credentialKey}_SUPABASE_SERVICE_ROLE`);
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Stripe, scoped to the spoke ─────────────────────────────────────
// Deliberately NOT a global process.env read. A dev spoke resolving the live
// Stripe key is the crossed pair that on 2026-09-22 put four sandbox disputes
// (livemode=false) into the hub's dispute_costs table, two of them frozen and
// therefore permanent. Scoping Supabase but not Stripe would have made that
// bug structural rather than accidental.

// A spoke's Stripe key must MATCH its environment. This is the structural
// form of the 2026-09-22 incident: .env.local paired a test Stripe key with
// the PROD mgcj Supabase project, and a local syncDisputeCosts() wrote four
// sandbox disputes (livemode=false) into the hub's dispute_costs table — two
// closed, and therefore frozen and unfixable by any re-sync.
//
// Enforced in BOTH directions, because both are wrong in the same way:
//   prod spoke + sk_test  -> sandbox data presented as real money
//   dev  spoke + sk_live  -> real charges/refunds driven from test data
//
// A MISSING key is deliberately not this error — requireEnv says so more
// clearly, and "not configured" is a legitimate local state.
function assertKeyMatchesEnvironment(spoke: Spoke, key: string): string | null {
  if (!key.startsWith("sk_")) {
    // Guards a pasted publishable (pk_) key.
    return `${spoke.credentialKey}_STRIPE_SECRET must be a secret key (sk_...), not a publishable key.`;
  }
  // Only sk_live_/sk_test_ are judged. An unprefixed sk_ value (CI's dummy) is
  // left alone so `npm run build` stays green without real credentials.
  if (spoke.environment === "prod" && key.startsWith("sk_test_")) {
    return `Project "${spoke.slug}" is a prod spoke but ${spoke.credentialKey}_STRIPE_SECRET is a TEST key. Sandbox data would be reported as real revenue.`;
  }
  if (spoke.environment !== "prod" && key.startsWith("sk_live_")) {
    return `Project "${spoke.slug}" is a ${spoke.environment} spoke but ${spoke.credentialKey}_STRIPE_SECRET is a LIVE key. Test data would drive real charges.`;
  }
  return null;
}

function stripeKey(spoke: Spoke): string {
  const key = requireEnv(`${spoke.credentialKey}_STRIPE_SECRET`);
  const problem = assertKeyMatchesEnvironment(spoke, key);
  if (problem) throw new SpokeError(problem);
  return key;
}

// Must return false for an INCOHERENT pair, not just a missing one. Callers
// use this to decide whether to attempt Stripe at all (e.g. pushDelaysToStripe
// sets summary.skipped). If it returned true here, stripeKey() would throw
// mid-action — and in updatePayoutConfig that happens AFTER payout_config is
// already saved, leaving the config persisted and the push state unknown.
export function spokeStripeConfigured(spoke: Spoke): boolean {
  const key = process.env[`${spoke.credentialKey}_STRIPE_SECRET`];
  if (!key) return false;
  return assertKeyMatchesEnvironment(spoke, key) === null;
}

export async function spokeStripePost(
  spoke: Spoke,
  path: string,
  body: Record<string, string> = {},
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeKey(spoke)}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Lets a double-submitted refund reach Stripe as the SAME refund, not two.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

export async function spokeStripeGet(spoke: Spoke, path: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${stripeKey(spoke)}` },
  });
  return res.json();
}

// ── write gates ─────────────────────────────────────────────────────
// Three tiers, keyed off spoke.environment. A flat "dev cannot write" would
// remove the reason to have a dev spoke at all — the point is to exercise the
// console against dev data. What must not happen is an effect that lands
// somewhere SHARED or OUTSIDE.
//
// These are server-side checks, not disabled buttons. This repo has no test
// runner and CI builds with dummy env, so nothing at runtime catches a
// wrong-spoke write for us.

export class SpokeWriteBlocked extends Error {}

// TIER 1 — hub tables (invoices, dispute_costs, metric_snapshots).
// The hub is ONE Supabase project across local, Preview and Production, so a
// dev spoke's hub write lands in the same rows production reads. This is the
// tier that does not care how careful the spoke credentials are.
export function assertHubWritable(spoke: Spoke, what: string): void {
  if (spoke.environment !== "prod") {
    throw new SpokeWriteBlocked(
      `${what} is blocked on the "${spoke.name}" (${spoke.environment}) spoke. ` +
        `Hub tables are shared by every environment, so this would write into ` +
        `production's records using ${spoke.environment} data.`,
    );
  }
}

// TIER 2 — outbound email. Resend has no test mode and RESEND_API_KEY is the
// live key in all three environments, so this gate is the ONLY thing standing
// between a dev spoke and a real invoice landing in a real inbox.
export function assertEmailAllowed(spoke: Spoke, what: string): void {
  if (spoke.environment !== "prod") {
    throw new SpokeWriteBlocked(
      `${what} is blocked on the "${spoke.name}" (${spoke.environment}) spoke. ` +
        `Resend has no test mode — this would send a real email.`,
    );
  }
}

// There is deliberately NO tier for Stripe Connect account creation. An
// earlier draft blocked it on dev, but that was guarding against a
// misconfigured key rather than against the operation: with a coherent quad a
// dev spoke holds a TEST key, so creating a Connect account provisions a test
// account and escapes nothing. assertKeyMatchesEnvironment() guards the real
// hazard directly, at the credential boundary, instead of asking every call
// site to remember a gate.
