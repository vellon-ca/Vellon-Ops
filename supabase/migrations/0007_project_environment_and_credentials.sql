-- Vellon Ops hub: make `projects` a ROUTER, not just a launcher.
-- Apply via the Supabase SQL editor of the VELLON-OPS project (not mgcj's).
--
-- WHY THIS EXISTS
-- Until now every module reached its spoke through mgcjSupabase(), which read
-- MGCJ_SUPABASE_URL / MGCJ_SUPABASE_SERVICE_ROLE / MGCJ_STRIPE_SECRET straight
-- off process.env. One set of env vars, so one spoke, so the console could only
-- ever look at production. Clicking a project card just navigated; no module
-- took a project id. This table was a launcher.
--
-- The alternative considered and rejected was per-environment Vercel env vars
-- (Preview points at dev, Production at prod). That binds "which customer
-- database" to "which deployment you are running", which is a category error:
-- you would have to be on a preview deploy to look at dev data, and N customers
-- x 2 environments multiplies Vercel config forever. The environment is a
-- property of the SPOKE, so it belongs in the spoke registry.
--
-- WHAT A ROW NOW CARRIES
--
--   environment     'prod' | 'dev'  — states what a guard would otherwise have
--                   to infer from a hostname. Write-gating keys off this.
--
--   credential_key  a HANDLE, e.g. 'MGCJ' or 'MGCJ_DEV', resolved at runtime to
--                   a QUAD of env vars by prefix:
--                       <KEY>_SUPABASE_URL
--                       <KEY>_SUPABASE_SERVICE_ROLE
--                       <KEY>_STRIPE_SECRET
--                   (see lib/connectors/spoke.ts)
--
-- NEVER STORE THE CREDENTIALS THEMSELVES IN THIS TABLE. A service-role key is
-- an RLS bypass for an entire customer database; putting one in a hub row makes
-- the hub the crown jewels for every customer at once, reachable by anything
-- that can read one table. The registry is DATA; the secrets stay in the env
-- store. The handle is the whole point — it names a credential without being one.
--
-- WHY THE STRIPE KEY IS PART OF THE QUAD AND NOT LEFT GLOBAL
-- MGCJ_STRIPE_SECRET was read as a single global in stripePost/stripeGet/
-- stripeConfigured. If the picker scoped Supabase per-spoke and left Stripe
-- global, a dev spoke would run the LIVE Stripe key against dev data. That is
-- precisely the crossed pair (test Stripe key + prod Supabase) that on
-- 2026-09-22 wrote four sandbox disputes into the hub's dispute_costs table,
-- two of them closed and therefore frozen forever. Scoping Supabase without
-- scoping Stripe would not fix that bug, it would make it structural.
--
-- ENVIRONMENT IS NOT A SUBSTITUTE FOR THE HUB BEING SHARED
-- The hub itself is ONE Supabase project across local, Preview and Production.
-- So a 'dev' spoke still writes hub rows (invoices, dispute_costs) into the
-- same tables production reads. That is exactly why write-gating on this column
-- must ship WITH the router and not after it.

alter table public.projects
  add column if not exists environment text not null default 'prod',
  add column if not exists credential_key text;

-- Deliberately a CHECK rather than an enum: adding a value to an enum in
-- Postgres is a heavier operation than editing a check constraint, and this
-- set is expected to grow (e.g. 'staging') before it stabilises.
alter table public.projects
  drop constraint if exists projects_environment_check;
alter table public.projects
  add constraint projects_environment_check
  check (environment in ('prod', 'dev'));

-- The handle must look like an env-var prefix, because that is literally what
-- it is interpolated into. Rejecting anything else here stops a malformed row
-- from turning into a confusing undefined-env-var failure at request time.
alter table public.projects
  drop constraint if exists projects_credential_key_format;
alter table public.projects
  add constraint projects_credential_key_format
  check (credential_key is null or credential_key ~ '^[A-Z][A-Z0-9_]*$');

-- Backfill the one existing row. It is the production mgcj spoke, and its
-- credentials are the MGCJ_* vars that already exist — so this is a rename of
-- an existing arrangement, not a new one, and nothing has to move in the env
-- store for the router to work on day one.
update public.projects
   set environment    = 'prod',
       credential_key = 'MGCJ'
 where slug = 'mgcj'
   and credential_key is null;

comment on column public.projects.environment is
  'Which environment this spoke points at. Write-gating keys off this: a dev spoke may not write hub tables (invoices/dispute_costs), send email via Resend, or create/modify Stripe Connect accounts.';
comment on column public.projects.credential_key is
  'Env-var PREFIX resolving to <KEY>_SUPABASE_URL, <KEY>_SUPABASE_SERVICE_ROLE and <KEY>_STRIPE_SECRET. A handle, never a credential — see lib/connectors/spoke.ts.';
