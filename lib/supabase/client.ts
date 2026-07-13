import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client (anon key only — safe to expose).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
