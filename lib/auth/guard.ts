import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type PlatformOwner = { id: string; email: string | null };

/**
 * The access wall for Vellon Ops.
 *
 * Verifies (1) there is a valid authenticated session and (2) that user is in
 * the `platform_owners` allowlist — checked with the service role, which bypasses
 * RLS, so the browser never needs (and never gets) read access to that table.
 *
 * Call this at the top of every protected layout / server action. Redirects to
 * /login on failure; returns the authenticated owner on success.
 *
 * Two performance/security notes:
 *
 * - `getClaims()` verifies the JWT signature *locally* via cached JWKS when the
 *   project uses asymmetric signing keys — no round-trip to the auth server on
 *   every call (that round-trip was the bulk of the old `getUser()` latency).
 *   On a legacy HS256 (shared-secret) project it transparently falls back to a
 *   `getUser()` network call, so this is never *weaker* than `getUser()` — only
 *   faster once asymmetric keys are enabled (Supabase dashboard → Auth →
 *   Signing Keys). It is NOT `getSession()`, which skips signature verification
 *   entirely and must never be trusted server-side.
 *
 * - Wrapped in React `cache()` so multiple guard calls *within the same request*
 *   (e.g. an action that guards and also calls a helper that guards) collapse to
 *   one verification + one allowlist lookup. `cache()` is request-scoped: it is
 *   discarded after each request and never shared across requests or users.
 */
export const requirePlatformOwner = cache(
  async (): Promise<PlatformOwner> => {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (error || !claims?.sub) redirect("/login");

    const { data: owner, error: ownerErr } = await supabaseAdmin
      .from("platform_owners")
      .select("user_id")
      .eq("user_id", claims.sub)
      .maybeSingle();

    if (ownerErr || !owner) redirect("/login?denied=1");

    return {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
    };
  },
);
