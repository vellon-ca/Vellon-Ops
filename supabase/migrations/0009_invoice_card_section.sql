-- The monthly fee document covers CARD fees too.
-- Design: mgcj-app .claude/notes/direct-charges-design.md (§6, §17).
--
-- Until now an invoice was the cash side only: Vellon's fee on cash fares, to
-- be paid. Under direct charges Vellon's fee on a CARD fare is taken by Stripe
-- at capture — and once Vellon is GST/HST-registered that fee carries tax, so
-- the taxi company needs a document stating it to claim its input tax credit.
-- One document per company per month, two sections:
--
--   cash — fee + tax, PAYABLE          (amount_due, tax_amount, total_due)
--   card — fee + tax, ALREADY COLLECTED (the columns below; never payable)
--
-- amount_due and total_due keep their meaning exactly (0008): the cash fee,
-- and what the company owes. The card columns are informational on the
-- payable side and are NOT added to either. NULL on every row generated
-- before this migration — read as "no card section", never as zero rides.
--
-- tax_amount is the CASH tax, summed from per-ride cents on the spoke
-- (mgcj 20261013000000), no longer round(fee x rate) at invoice level: with a
-- registration date inside the month only some rides carry tax, and the cash
-- and card sections of one document must round the same way.

alter table public.invoices
  add column if not exists card_fares_total numeric(12,2),
  add column if not exists card_fee_total   numeric(12,2),
  add column if not exists card_tax_amount  numeric(12,2),
  add column if not exists card_ride_count  integer;

comment on column public.invoices.card_fee_total is
  'Vellon''s fee on card fares this period, already collected through Stripe '
  'at capture. NOT part of amount_due or total_due.';
comment on column public.invoices.card_tax_amount is
  'GST/HST on card_fee_total, already collected. Summed from what Stripe took '
  'per ride (rides.application_fee_tax_cents).';
