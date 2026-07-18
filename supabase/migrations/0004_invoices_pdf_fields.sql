-- Fields needed to generate and deliver a real PDF cash invoice, rather than
-- just tracking a status. invoice_number is deterministic (stamped at
-- generation) and pdf_path points at the invoices Storage bucket.

alter table public.invoices
  add column if not exists invoice_number text,
  add column if not exists pdf_path       text;
