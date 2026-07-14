import "server-only";
import { createClient } from "@supabase/supabase-js";

// ── mgcj connector ──────────────────────────────────────────────────
// The first (and currently only) spoke. Privileged access to the mgcj
// Supabase project via its service role — SERVER ONLY, bypasses RLS.
//
// This is deliberately a plain factory (not a shared singleton) so the
// connector pattern generalizes to future spokes with their own creds.

export function mgcjSupabase() {
  const url = process.env.MGCJ_SUPABASE_URL;
  const key = process.env.MGCJ_SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new Error("mgcj connector not configured (MGCJ_SUPABASE_* missing)");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Stripe REST helper (mirrors mgcj's own edge functions — raw fetch, no SDK).
// Returns parsed JSON; callers check for a `.error` field.
export async function stripePost(
  path: string,
  body: Record<string, string> = {},
) {
  const key = process.env.MGCJ_STRIPE_SECRET;
  if (!key) throw new Error("Stripe not configured (MGCJ_STRIPE_SECRET missing)");
  if (!key.startsWith("sk_")) {
    // Guard against pasting a publishable (pk_) key by mistake.
    throw new Error(
      "MGCJ_STRIPE_SECRET must be a secret key (sk_...), not a publishable key.",
    );
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

export function stripeConfigured() {
  return (process.env.MGCJ_STRIPE_SECRET ?? "").startsWith("sk_");
}
