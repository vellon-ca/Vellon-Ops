-- Vellon Ops hub: chargeback cost tracking (runs against the vellon-ops
-- Supabase project, NOT any tenant project). Apply via the Supabase SQL editor.
--
-- WHY THIS EXISTS
-- When a passenger disputes a card charge, Stripe takes more than the fare back
-- off Vellon's balance. Observed on a real $25.94 CAD disputed ride:
--
--   dispute.balance_transactions[0]  type=adjustment  amount=-2594  fee=1500
--     fee_details: [{ description: 'Dispute fee', amount: 1500 }]
--   charge.balance_transaction       type=charge      amount= 2594  fee= 126
--
--   -$25.94  fare withdrawn      → returned only if Vellon wins the dispute
--   -$15.00  flat dispute fee    → NEVER refunded (see below)
--   -$ 1.26  original processing → Stripe keeps it either way
--   ────────
--   -$16.26  cost of a lost/open dispute;  -$15.00 if won
--
-- WINNING DOES NOT REFUND THE $15. Verified by forcing a test dispute to
-- 'won' and reading the balance transactions: the win posts a "Chargeback
-- reversal" adjustment returning the fare with fee 0, and no dispute-fee
-- refund is created anywhere. Stripe's docs confirm it's policy, not a
-- test-mode gap — "for businesses outside Mexico, the fee for receiving a
-- dispute is non-refundable". A win only neutralizes the processing fee,
-- because the charge then stands and that fee becomes the ordinary cost of
-- a completed ride.
--
-- None of that touches rides settlement math — it is not the driver's cost and
-- not the taxi company's cost. It is pure Vellon cost-of-business, and before
-- this table it silently eroded the platform Stripe balance with zero
-- visibility anywhere.
--
-- HOW IT IS POPULATED
-- Pulled from Stripe on demand by revenue/actions.ts::syncDisputeCosts(), not
-- by a webhook. The only time-sensitive reaction to a dispute (reversing an
-- already-sent driver/company Transfer) already happens in mgcj's
-- stripe-webhook; what is left here is pure cost reporting with nothing to
-- react to. A sync is idempotent and self-healing where a missed webhook
-- leaves a permanent hole, and it avoids standing up a second public
-- signature-verified endpoint on the ops console.
--
-- FREEZING DISCIPLINE (mirrors invoices' draft → sent/paid lock)
-- An OPEN dispute is re-synced freely: its status can still flip to won/lost
-- and that changes the cost. A CLOSED dispute is terminal — is_closed rows are
-- skipped by the sync and never recomputed. Same rule as sent/paid invoices,
-- and the same reason: a cost figure must never be re-derived later from data
-- that has moved on.
--
-- No FK to mgcj (separate database); company_id is the mgcj companies.id and
-- is NULLABLE — an unmatched dispute is recorded with a null company rather
-- than failing the whole sync.
--
-- Security model matches the rest of the hub: RLS enabled, deny-all; all
-- access server-side via the service role.

create table if not exists public.dispute_costs (
  id                    uuid primary key default gen_random_uuid(),
  project_slug          text not null default 'mgcj',

  -- Stripe identifiers. stripe_dispute_id is the sync's idempotency key.
  stripe_dispute_id     text not null,
  charge_id             text,
  payment_intent_id     text,

  -- Attribution, snapshotted at sync. Resolved dispute → payment_intent →
  -- rides.stripe_payment_intent_id via the mgcj connector. Null when the
  -- charge can't be matched to a ride (e.g. a non-ride charge, or test data).
  company_id            uuid,
  company_name          text,
  ride_id               uuid,

  -- Amounts, all in cents, all read from Stripe — never estimated.
  currency              text not null default 'cad',
  -- The fare itself. Recorded for context only: it nets to zero against the
  -- original payment, so it is deliberately NOT part of net_cost_cents.
  disputed_amount_cents integer not null default 0,
  -- sum(dispute.balance_transactions[].fee). Stays 1500 on a win: the
  -- reversal adjustment carries fee 0, so this is also unaffected by whether
  -- that second balance transaction has posted yet.
  dispute_fee_cents     integer not null default 0,
  -- The original charge's processing fee, which Stripe keeps win or lose.
  -- Only a COST when the dispute is not won — see net_cost_cents.
  processing_fee_cents  integer not null default 0,
  -- The frozen bottom line: dispute fees + (processing fee, unless won).
  -- The dispute fee is charged either way; only the processing fee falls off
  -- on a win, since the charge stands and it becomes ordinary ride cost.
  net_cost_cents        integer not null default 0,

  -- Stripe's dispute.status verbatim (warning_needs_response, needs_response,
  -- under_review, won, lost, ...). is_closed is the freeze flag.
  status                text not null,
  reason                text,
  is_closed             boolean not null default false,

  opened_at             timestamptz not null,
  -- When the sync FIRST OBSERVED the dispute closed, not Stripe's own close
  -- time — the dispute object exposes `created` but no closed timestamp. It is
  -- accurate to within one sync interval, and is a freeze marker rather than a
  -- reporting axis (costs bucket by opened_at). Don't report off it.
  closed_at             timestamptz,
  synced_at             timestamptz not null default now(),

  unique (project_slug, stripe_dispute_id)
);
alter table public.dispute_costs enable row level security;

-- Costs are period-bucketed by opened_at — the moment the money actually left
-- Vellon's balance.
create index if not exists dispute_costs_period
  on public.dispute_costs (project_slug, opened_at desc);

create index if not exists dispute_costs_company
  on public.dispute_costs (project_slug, company_id, opened_at desc);

comment on table public.dispute_costs is
  'Vellon-side chargeback costs pulled from Stripe. Open disputes re-sync; closed ones are frozen.';
comment on column public.dispute_costs.net_cost_cents is
  'Frozen bottom line in cents: sum of dispute balance-transaction fees (charged win or lose), plus the unrecovered processing fee when the dispute was not won. Excludes the disputed fare.';
