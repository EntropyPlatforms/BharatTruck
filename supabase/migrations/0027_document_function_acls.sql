-- migration 027: finish the document-function privilege hardening that 0024 §10 set out to do.
--
-- WHY THIS EXISTS:
--   Migration 0024 §10 states the intent exactly right — the five document functions MINT LEGAL
--   DOCUMENTS and a browser-side key must never reach them — and then executes a revoke that, on
--   THIS database, removes a grant the roles were not relying on. The five functions are still
--   executable by `anon` and by `authenticated` today. This file closes that, and only that.
--
-- THE MECHANISM 0024 COULD NOT HAVE SEEN FROM THE SQL ALONE:
--   In stock PostgreSQL, a newly created function's ACL is NULL, which means "owner plus the
--   built-in default", and the built-in default for a function is EXECUTE to PUBLIC. There, naming
--   anon/authenticated in a revoke really is useless — they hold nothing of their own, they inherit
--   through PUBLIC — and revoking PUBLIC really is the whole job. 0024 §10 describes that Postgres,
--   and against a plain Postgres its statement is correct.
--
--   Supabase is not that Postgres. It ships a standing
--
--       alter default privileges in schema public
--         grant execute on functions to postgres, anon, authenticated, service_role;
--
--   for both the `postgres` and `supabase_admin` owners — both rows are visible in `pg_default_acl`
--   right now. A default-privileges entry does not layer on top of the built-in default; it REPLACES
--   it. So every function created in `public` is born with an explicit ACL carrying DIRECT,
--   individually-held grants to anon, authenticated and service_role. Revoking PUBLIC then subtracts
--   only the PUBLIC entry, and the direct grants — the ones that actually decide the answer — survive
--   untouched. The revoke did run and it did do something; what it did was not what was needed.
--
--   The live ACLs are the proof, and they are unambiguous (read 2026-08-07, `pg_proc.proacl`):
--
--     allocate_document_number      {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--     next_free_document_serial     (identical)
--     sync_document_series_counter  (identical)
--     issue_lorry_receipt           (identical)
--     issue_freight_invoice         (identical)
--
--   Note what is ABSENT from those five and present on every other public function in this database
--   (accept_booking, start_trip, complete_trip, indian_financial_year, ...): the leading `=X/postgres`
--   entry, which is PUBLIC's. That absence is 0024's revoke, landed and working, on exactly the one
--   grantee that was not carrying the privilege. `has_function_privilege('anon', ..., 'execute')`
--   returns true for all five.
--
-- THIS IS DEFENSE IN DEPTH, NOT AN OPEN DOOR. Verified, not assumed:
--   • All five functions are SECURITY INVOKER (`prosecdef = false`), so an RPC arriving on the
--     browser key executes AS anon/authenticated — it does not borrow the owner's rights.
--   • `document_series`, `lorry_receipts`, `freight_invoices` and `eway_bill_records` all have RLS
--     ENABLED with ZERO policies, and neither anon nor authenticated has `rolbypassrls`. RLS with no
--     policy denies everything, so every insert and update those functions attempt on behalf of such
--     a caller is refused by the table.
--   • Net effect today: a browser-key call reaches the function body and then fails at the table. No
--     document has been or can be minted this way.
--   That is the second layer holding while the first one is open. The first layer is the one that is
--   supposed to hold — a future policy added for a legitimate read, or one table created without RLS,
--   silently converts "contained" into "issuable", and the containment is invisible from the file
--   that claims to have done the restricting. Hence: fix the grant, not the containment.
--
-- 0024 IS HISTORY AND STAYS AS WRITTEN. It is applied to production; editing it would change a file
-- the database has already run and would leave no record of why the follow-up exists. Its §10 comment
-- is superseded by this header, not corrected in place.
--
-- WHAT ABOUT indian_financial_year? THE EXEMPTION IS KEPT, DELIBERATELY.
--   0024 §(6) documents it as what it is: a pure, `stable`, argument-only date label — it computes the
--   1-April boundary in Asia/Kolkata and returns '2026-27'. It reads no table, touches no counter,
--   allocates no number and observes nothing about the platform. Its entire output is derivable from a
--   wall clock and a calendar by anyone who wants it, so revoking it protects no fact.
--   It is also a dependency of the two issuance functions, which are SECURITY INVOKER — the caller
--   needs EXECUTE on the callee. Restricting it would therefore buy zero confidentiality while adding
--   one more privilege that has to be correct for issuance to work at all. Left executable, on purpose.
--
-- IDEMPOTENT AND RE-RUNNABLE. REVOKE and GRANT are absolute states, not deltas: running this file
-- twice leaves the identical ACL. Both role-touching steps are guarded on the role existing, because a
-- local or CI Postgres has no Supabase roles and there the owner's own EXECUTE is what the tests use.
-- Note that re-running 0024 would NOT undo this: `create or replace function` preserves an existing
-- function's ACL. Only a `drop function` + recreate resets it — if one of these five is ever dropped
-- and recreated, this file must be re-applied after it.
--
-- NOTHING IN ANY SERVICE CHANGES. bt-booking-service reaches Postgres on the service-role key
-- (`src/lib/documents/*`), which is the one role explicitly granted below and asserted before this
-- transaction is allowed to commit.

-- ---------------------------------------------------------------
-- (1) Revoke EXECUTE from the roles that actually hold it.
--
-- PUBLIC is revoked again alongside them. It is a no-op here (0024 already removed that entry) and it
-- is kept for two reasons: this file must state the whole intended end state rather than a diff
-- against one specific database, and on a non-Supabase Postgres — a developer's local, a CI service
-- container — PUBLIC is the entry that matters and anon/authenticated do not exist at all.
--
-- Signatures are spelled out in full, exactly as in 0024 §10. Postgres identifies a function by its
-- argument types; a bare name would be ambiguous the day one of these is overloaded, and would fail
-- the migration rather than silently miss.
-- ---------------------------------------------------------------
revoke execute on function
  public.allocate_document_number(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
  public.next_free_document_serial(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
  public.sync_document_series_counter(public.document_series_kind, public.document_issuer_kind, uuid, text),
  public.issue_lorry_receipt(uuid, public.document_issuer_kind, uuid, text, jsonb),
  public.issue_freight_invoice(uuid, uuid, text, jsonb)
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function
      public.allocate_document_number(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.next_free_document_serial(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.sync_document_series_counter(public.document_series_kind, public.document_issuer_kind, uuid, text),
      public.issue_lorry_receipt(uuid, public.document_issuer_kind, uuid, text, jsonb),
      public.issue_freight_invoice(uuid, uuid, text, jsonb)
    from anon;
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function
      public.allocate_document_number(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.next_free_document_serial(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.sync_document_series_counter(public.document_series_kind, public.document_issuer_kind, uuid, text),
      public.issue_lorry_receipt(uuid, public.document_issuer_kind, uuid, text, jsonb),
      public.issue_freight_invoice(uuid, uuid, text, jsonb)
    from authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------
-- (2) Hand EXECUTE back to service_role, unconditionally.
--
-- Repeated verbatim from 0024 §10 rather than trusted to still be there. This file's whole subject is
-- an ACL that was not what the SQL implied, so it re-states the grant it depends on instead of reading
-- the previous migration's intent off the page. Granting a privilege the role already holds is free.
-- ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.allocate_document_number(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.next_free_document_serial(public.document_series_kind, public.document_issuer_kind, uuid, text, text),
      public.sync_document_series_counter(public.document_series_kind, public.document_issuer_kind, uuid, text),
      public.issue_lorry_receipt(uuid, public.document_issuer_kind, uuid, text, jsonb),
      public.issue_freight_invoice(uuid, uuid, text, jsonb)
    to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------
-- (3) Report the RESULTING ACL, then refuse to commit if issuance is broken.
--
-- The report exists because this whole migration is the consequence of reading a revoke statement and
-- believing what it looked like it did. Nobody should have to believe this one either: it prints the
-- answer `has_function_privilege` actually gives, per function, per role, after the statements above
-- have run. The expected line for each of the five is `anon=f auth=f service_role=t`.
--
-- The assertion is not decoration. A privilege migration that silently strips the service's own
-- EXECUTE is strictly worse than the exposure it was written to close: document issuance would start
-- 500-ing on the first LR after deploy, and the cause would be a file whose whole visible effect was
-- "security hardening". So it raises, which rolls the transaction back and leaves the database exactly
-- as it was — with the notices above already on the client, naming the function that lost the grant.
--
-- Notices come first for the same reason: they are flushed to the client as they are raised, so they
-- survive the rollback and are still on screen when the exception explains itself.
-- ---------------------------------------------------------------
do $$
declare
  v_sig      text;
  v_oid      oid;
  v_anon     boolean;
  v_auth     boolean;
  v_service  boolean;
  v_broken   text[] := array[]::text[];
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_has_svc  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  if not v_has_svc then
    -- A local or CI Postgres. There are no Supabase roles to report on and the owner holds EXECUTE
    -- directly, which is what the test suite runs as. Say so rather than printing five useless lines.
    raise notice 'document-function acls: no Supabase roles on this database (local/CI) — nothing to restrict, owner retains EXECUTE.';
    return;
  end if;

  foreach v_sig in array array[
    'public.allocate_document_number(public.document_series_kind, public.document_issuer_kind, uuid, text, text)',
    'public.next_free_document_serial(public.document_series_kind, public.document_issuer_kind, uuid, text, text)',
    'public.sync_document_series_counter(public.document_series_kind, public.document_issuer_kind, uuid, text)',
    'public.issue_lorry_receipt(uuid, public.document_issuer_kind, uuid, text, jsonb)',
    'public.issue_freight_invoice(uuid, uuid, text, jsonb)'
  ] loop
    v_oid := v_sig::regprocedure::oid;

    -- has_function_privilege, not a proacl string match: it resolves PUBLIC and role inheritance the
    -- way a real call does. Reading the ACL text is exactly the mistake this migration is undoing.
    v_anon    := v_has_anon and has_function_privilege('anon',          v_oid, 'execute');
    v_auth    := v_has_auth and has_function_privilege('authenticated', v_oid, 'execute');
    v_service := has_function_privilege('service_role', v_oid, 'execute');

    raise notice 'document-function acls: % -> anon=% authenticated=% service_role=%',
      v_oid::regproc, v_anon, v_auth, v_service;

    if v_anon or v_auth then
      raise warning 'document-function acls: % is STILL executable by a browser-side role after this migration — check pg_default_acl and any role that GRANTed it back.',
        v_oid::regproc;
    end if;

    if not v_service then
      v_broken := v_broken || v_oid::regproc::text;
    end if;
  end loop;

  -- The pure date helper, reported because the exemption in the header is a decision and a decision
  -- should be visible in the output, not only in a comment nobody re-reads.
  raise notice 'document-function acls: indian_financial_year(timestamptz) left executable on purpose — pure date label, leaks nothing, and the SECURITY INVOKER issuance functions call it.';

  if array_length(v_broken, 1) is not null then
    raise exception 'service_role lost EXECUTE on % — document issuance would fail on the next lorry receipt. Rolling back; the ACL is unchanged.',
      array_to_string(v_broken, ', ')
      using errcode = 'insufficient_privilege';
  end if;
end $$;
