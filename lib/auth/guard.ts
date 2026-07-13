import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The access wall for Vellon Ops.
 *
 * Verifies (1) there is a valid authenticated session and (2) that user is in
 * the `platform_owners` allowlist — checked with the service role, which bypasses
 * RLS, so the browser never needs (and never gets) read access to that table.
 *
 * Call this at the top of every protected layout / server action. Redirects to
 * /login on failure; returns the authenticated owner User on success.
 */
export async function requirePlatformOwner(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data, error } = await supabaseAdmin
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) redirect("/login?denied=1");

  return user;
}
