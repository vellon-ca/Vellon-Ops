import "server-only";
import { createClient } from "@supabase/supabase-js";

// Privileged, service-role client. Bypasses RLS — SERVER ONLY.
// `server-only` makes the build fail if this is ever imported into client code.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);
