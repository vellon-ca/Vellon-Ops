-- Rides billed to a business account, on the monthly fee document.
-- Design: mgcj-app .claude/notes/business-accounts-design.md (phase 2a) and
-- business-accounts-payment-method-audit.md #41.
--
-- An account ride (payment_method 'account', invoice billing) is billed to a
-- business by the taxi company; the driver collected nothing and Vellon took
-- nothing at the time. So, like cash, Vellon's percentage fee is owed on this
-- document, and so is the WHOLE booking fee (no cash changed hands, so there
-- is no round-up and no company share). Before this, the generator skipped
-- account rows entirely and they never reached an invoice.
--
-- Its own section ("Account rides"), payable like cash. amount_due keeps its
-- meaning: everything Vellon is owed on this document before tax, which now =
-- cash fee + cash booking fees + account fee + account booking fees. The tax on
-- all of it is the one tax_amount line; total_due = amount_due + tax_amount.
--
-- NULL on every row generated before this migration = no account rides.
-- Apply with 0010 (booking fee): neither is on the hub yet.

alter table public.invoices
  add column if not exists account_fares_total       numeric(12,2),
  add column if not exists account_ride_count        integer,
  add column if not exists account_fee_total         numeric(12,2),
  add column if not exists account_booking_fee_total numeric(12,2),
  add column if not exists account_booking_fee_count integer;

comment on column public.invoices.account_fares_total is
  'Fares on rides billed to business accounts this period (the business pays the taxi company).';
comment on column public.invoices.account_fee_total is
  'Vellon''s percentage fee on those fares, pre-tax. INCLUDED in amount_due; its tax is in tax_amount.';
comment on column public.invoices.account_booking_fee_total is
  'Booking fees on account rides, pre-tax, all owed to Vellon. INCLUDED in amount_due; its tax is in tax_amount.';
comment on column public.invoices.account_booking_fee_count is
  'Account rides this period that carried a booking fee.';
