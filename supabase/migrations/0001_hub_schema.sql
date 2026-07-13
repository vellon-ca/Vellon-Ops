-- Vellon Ops hub schema (runs against the dedicated vellon-ops Supabase project,
-- NOT any tenant project). Apply via the Supabase SQL editor.
--
-- Security model: every table has RLS enabled with NO permissive policies, i.e.
-- deny-all to anon/authenticated. All access is server-side via the service role
-- (which bypasses RLS). The browser must never read these tables directly.

-- ── platform_owners ────────────────────────────────────────────────
-- The access allowlist. A user_id here == authorized to use Vellon Ops.
create table if not exists public.platform_owners (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  added_at   timestamptz not null default now()
);
alter table public.platform_owners enable row level security;

-- ── projects ───────────────────────────────────────────────────────
-- Spoke registry. Seeded with mgcj; future projects register here.
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  icon        text,
  color       text,
  status      text not null default 'active',
  links       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.projects enable row level security;

-- ── audit_log ──────────────────────────────────────────────────────
-- Immutable, append-only record of every mutating platform-owner action.
create table if not exists public.audit_log (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid references auth.users (id),
  project_id     uuid references public.projects (id),
  action         text not null,
  target         text,
  before         jsonb,
  after          jsonb,
  created_at     timestamptz not null default now()
);
alter table public.audit_log enable row level security;

-- ── metric_snapshots ───────────────────────────────────────────────
-- Cached expensive reads (e.g. revenue) so the UI renders instantly;
-- refreshed on a schedule and on demand via the "Refresh" button.
create table if not exists public.metric_snapshots (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects (id),
  key          text not null,
  value        jsonb not null,
  captured_at  timestamptz not null default now()
);
alter table public.metric_snapshots enable row level security;

create index if not exists metric_snapshots_lookup
  on public.metric_snapshots (project_id, key, captured_at desc);

-- ── seed: mgcj as the first spoke ──────────────────────────────────
insert into public.projects (name, slug, color, links)
values ('M&G C&J', 'mgcj', '#E8500A',
        '{"dashboard": "https://mgcj-dashboard.vercel.app"}'::jsonb)
on conflict (slug) do nothing;

-- ── access bootstrap ───────────────────────────────────────────────
-- After creating your auth user (Supabase → Authentication → Add user),
-- authorize yourself by inserting your user_id here. Example:
--
--   insert into public.platform_owners (user_id, email)
--   select id, email from auth.users where email = 'you@example.com';
