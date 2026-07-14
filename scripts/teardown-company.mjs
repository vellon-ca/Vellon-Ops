// Delete a company and everything the onboarding wizard created for it, from
// the mgcj production backend. Use ONLY for removing test companies.
//
//   node --experimental-websocket scripts/teardown-company.mjs <company_id>
//
import { createClient } from "../node_modules/@supabase/supabase-js/dist/index.mjs";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const companyId = process.argv[2];
if (!companyId) {
  console.error("usage: teardown-company.mjs <company_id>");
  process.exit(1);
}

const mgcj = createClient(
  env.MGCJ_SUPABASE_URL,
  env.MGCJ_SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } },
);

// 1. delete invites
const { count: invCount } = await mgcj
  .from("driver_invites")
  .delete({ count: "exact" })
  .eq("company_id", companyId);
console.log(`deleted ${invCount ?? 0} invite(s)`);

// 2. delete profiles scoped to this company + their auth users
const { data: profiles } = await mgcj
  .from("profiles")
  .select("id, name, role")
  .eq("company_id", companyId);
for (const p of profiles ?? []) {
  await mgcj.from("profiles").delete().eq("id", p.id);
  await mgcj.auth.admin.deleteUser(p.id);
  console.log(`deleted ${p.role} ${p.name} (${p.id}) + auth user`);
}

// 3. delete the company
const { error } = await mgcj.from("companies").delete().eq("id", companyId);
console.log(error ? `company delete error: ${error.message}` : "deleted company");
