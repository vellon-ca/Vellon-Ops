-- The passenger booking fee on CASH rides, on the monthly fee document.
-- Design: mgcj-app .claude/notes/booking-fee-design.md ("Who gets what").
--
-- On a cash ride the passenger pays the driver fare + booking fee (rounded up
-- to the dollar), and the booking fee is Vellon's. The company holds it and
-- pays it over on this document as its own line, "Booking fees (N rides)",
-- pre-tax; its GST/HST is part of the one tax line at the bottom (tax_amount).
--
-- amount_due keeps its meaning: Vellon's whole cash-side fee before tax, which
-- now = the percentage fee + cash_booking_fee_total. The revenue rollup sums
-- amount_due as revenue, and the booking fee IS Vellon's revenue.
-- Card rides get no line: a card ride's booking fee is the company's (it pays
-- Stripe), and Vellon's per-ride part of it is already inside the card fee.
--
-- NULL on every row generated before this migration = no booking fees.

alter table public.invoices
  add column if not exists cash_booking_fee_total numeric(12,2),
  add column if not exists cash_booking_fee_count integer;

comment on column public.invoices.cash_booking_fee_total is
  'Passenger booking fees on cash rides this period, pre-tax, owed to Vellon. '
  'INCLUDED in amount_due; its tax is in tax_amount.';
comment on column public.invoices.cash_booking_fee_count is
  'Cash rides this period that carried a booking fee.';
