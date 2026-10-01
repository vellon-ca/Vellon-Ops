-- Tax on Vellon's OWN fee invoice. §3 of mgcj-app's
-- .claude/notes/financial-document-defects.md.
--
-- The defect: lib/pdf/invoice.ts prints `HST Reg: <number>` whenever Vellon has
-- one configured, and the document carries NO tax line at all. If Vellon is
-- registered — and it is printing a registration number — the platform fee is a
-- taxable supply and the tax is owed to CRA whether or not it was invoiced, i.e.
-- straight out of a 10% margin. The company also needs the line stated to claim
-- its own input tax credit. That is the same shape as the receipt defect fixed
-- in mgcj's 20260930000000, inverted: there a document asserted tax nobody
-- collected; here it asserts a registration beside no tax at all.
--
-- TWO GATES, and they are genuinely independent — collapsing them is the easy
-- mistake because they sit one join apart:
--
--   WHETHER the fee is taxed   -> VELLON's registration (platform_settings.hst_number)
--   WHETHER the FARE is taxed  -> the COMPANY's registration (companies.hst_number)
--
-- An unregistered small-supplier taxi company issues every receipt with no tax
-- line and still owes tax on Vellon's invoice, if Vellon is registered. As of
-- 2026-10-01 Vellon is neither incorporated nor GST/HST-registered, so the
-- correct document today is the tax-free one — the bug is only that the reg line
-- prints independently of the split, which this closes by putting both behind
-- the one gate.
--
-- The RATE is the recipient's: a B2B supply of a service is rated at the
-- customer's place of supply, so it comes from the billed company's
-- jurisdiction (mgcj companies.tax_rate_percent / tax_label), NOT from Vellon's
-- province. Once Vellon sells outside Nova Scotia this is not one constant.
-- Flagged for the accountant hour (mgcj .claude/notes/accountant-brief.md
-- question 3), which is also the question blocking the card-side fee document.
--
-- Tax here is EXCLUSIVE — the fee is quoted as a percentage and tax goes ON TOP.
-- That is the inverse of the passenger receipt, where the fare is tax-INCLUSIVE
-- because the quoted taxi price is the price paid. Both are business decisions
-- and neither should be left implied by an arithmetic operator.

alter table public.invoices
  add column if not exists tax_label        text,
  add column if not exists tax_rate_percent numeric(5,2),
  add column if not exists tax_amount       numeric(12,2),
  add column if not exists total_due        numeric(12,2);

-- SNAPSHOTTED at generation, like company_name/fee_percent/amount_due already
-- are. The PDF builder reads the invoice ROW and never the live company row, so
-- a later change to a company's rate or label cannot rewrite an issued tax
-- document — and if the accountant rules the fee is rated differently, that
-- changes a source going forward rather than rewriting history.
comment on column public.invoices.tax_rate_percent is
  'Tax rate applied to the platform fee on this invoice, snapshotted at '
  'generation from the BILLED COMPANY''s place of supply (not Vellon''s). NULL = '
  'no tax line was printed, which is correct whenever Vellon is not registered.';

comment on column public.invoices.tax_label is
  'What the tax is called on this invoice (HST / GST / ''GST + QST''), '
  'snapshotted from the billed company. NULL alongside a NULL rate.';

comment on column public.invoices.tax_amount is
  'Tax as ROUNDED ONTO the document, not recomputed from amount_due and the '
  'rate later. EXCLUSIVE: added to the fee, not extracted from it.';

-- amount_due KEEPS meaning "the platform fee", and nothing may redefine it:
-- RevenueDashboard sums it across non-void invoices and reads that sum as fee
-- revenue, and the PDF prints it as the fee line item. Quietly turning it into
-- fee+tax would restate revenue — the same class of error as bucketing revenue
-- off updated_at.
--
-- So the payable figure is a SEPARATE column. NULL means "no tax computed", and
-- every row that exists today stays NULL forever (no backfill: generation skips
-- sent/paid invoices, so re-running cannot touch them). Readers must therefore
-- treat NULL as `amount_due`, never as zero.
comment on column public.invoices.total_due is
  'What the company actually owes: amount_due + tax_amount. NULL on any invoice '
  'generated before tax was modelled — read it as `total_due ?? amount_due`, '
  'never as 0. amount_due stays the FEE alone because the revenue rollup sums '
  'it as revenue.';


-- ── Verify after applying ───────────────────────────────────────────────────
--
--   select invoice_number, status, amount_due, tax_rate_percent, tax_amount,
--          total_due
--     from invoices order by period_month desc, company_name;
--
-- Expect NULL tax on every pre-existing row, and on every new row too until
-- Vellon has an hst_number in platform_settings. A tax_amount sitting beside a
-- NULL total_due would mean the generator wrote one and not the other.
