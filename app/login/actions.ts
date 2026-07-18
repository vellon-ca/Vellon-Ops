"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    redirect("/login?error=1");
  }

  // Enforce the allowlist at sign-in too, so a valid-but-unauthorized auth user
  // is signed straight back out rather than left with a live session.
  const { data: owner } = await supabaseAdmin
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (!owner) {
    await supabase.auth.signOut();
    redirect("/login?denied=1");
  }

  redirect("/projects");
}
