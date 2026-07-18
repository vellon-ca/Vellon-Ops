-- Private Storage bucket for generated invoice PDFs. First Storage usage in
-- this repo. No storage.objects RLS policies needed — all reads/writes go
-- through the service-role client (sendInvoice action, signed download URLs),
-- which bypasses RLS same as every other hub table.

insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;
