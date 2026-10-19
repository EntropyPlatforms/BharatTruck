-- 0032_eway_status_actor.sql
--
-- Review S-7 remainder: "make every document action traceable to a user."
-- eway_bill_records already records WHO filed the bill (recorded_by) and WHEN a
-- cancel/reject happened (status_changed_at) — but not WHO performed the status
-- change. A cancellation of a statutory record whose actor is unrecoverable is
-- exactly the audit gap the review named.
--
-- Additive and nullable: existing rows have no actor to backfill (the data was
-- never captured), and the write path stamps it from the session from now on.
-- No index — it is an audit column, read by investigation queries, never by a
-- hot path.

alter table public.eway_bill_records
  add column if not exists status_changed_by uuid references public.users(id);

comment on column public.eway_bill_records.status_changed_by is
  'users.id of whoever filed the cancel/reject (audit; null on rows predating 0032)';
