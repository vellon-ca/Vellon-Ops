-- Vellon Ops hub: monthly cash-fee invoices (runs against the vellon-ops
-- Supabase project, NOT any tenant project). Apply via the Supabase SQL editor.
--
-- Card platform fees are auto-collected via Stripe application fees. CASH fares
-- are not — Vellon bills each company monthly for the platform fee on their cash
-- rides. This table is the billing record for those cash invoices: one row per
-- company per month, generated from live mgcj data and then tracked to paid.
--
-- Amounts/fee_percent/company_name are SNAPSHOTTED at generation, so the invoice
-- is a stable record even if the company's fee% or name later changes in mgcj.
-- No FK to mgcj (separate database); company_id is the mgcj companies.id.
--
-- Security model matches the rest of the hub: RLS enabled, deny-all; all access
-- server-side via the service role.

create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  project_slug      text not null default 'mgcj',
  company_id        uuid not null,
  company_name      text not null,
  -- First day of the billed month, e.g. 2026-06-01 for June 2026.
  period_month      date not null,
  cash_fares_total  numeric(12,2) not null,
  fee_percent       numeric(5,2)  not null,
  amount_due        numeric(12,2) not null,
  ride_count        integer       not null default 0,
  -- draft (regenerable) → sent → paid; void to cancel.
  status            text not null default 'draft'
                      check (status in ('draft', 'sent', 'paid', 'void')),
  generated_by      uuid references auth.users (id),
  generated_at      timestamptz not null default now(),
  sent_at           timestamptz,
  paid_at           timestamptz,
  -- One invoice per company per month per spoke.
  unique (project_slug, company_id, period_month)
);
alter table public.invoices enable row level security;

create index if not exists invoices_lookup
  on public.invoices (project_slug, period_month desc, company_name);
