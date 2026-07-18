-- Vellon's own business details (hub-local, not tied to any spoke project).
-- Vellon isn't incorporated yet, so every field is nullable and the invoice
-- PDF builder must tolerate any/all of them being blank. Single-row config
-- table, same deny-all RLS / service-role-only model as the rest of the hub
-- schema in 0001_hub_schema.sql.

create table if not exists public.platform_settings (
  id                   int primary key default 1,
  legal_name           text,
  business_number      text,   -- once incorporated
  hst_number           text,   -- once GST/HST-registered
  mailing_address      text,
  payment_instructions text,   -- free text, e.g. e-transfer details
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id),
  constraint platform_settings_singleton check (id = 1)
);
alter table public.platform_settings enable row level security;

insert into public.platform_settings (id) values (1)
on conflict do nothing;
