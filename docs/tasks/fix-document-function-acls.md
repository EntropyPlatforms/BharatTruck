# Task: `fix/document-function-acls`

**Relates to:** migration `0024_freight_documents.sql` §10 (RLS + grants) and `supabase/migrations/README.md`
finding **#7** ("`REVOKE` the anon/authenticated data-API grants"). One migration, no service code.

## The defect

0024 §10 ends with `revoke execute on function … from public` over the five document functions, under
a comment asserting that revoking anon/authenticated *by name* "achieves NOTHING while the PUBLIC
grant survives". On stock PostgreSQL that is exactly right. On Supabase it is **inverted**, and the
five functions are executable by `anon` and `authenticated` in production right now.

**Mechanism.** Supabase ships a standing
`alter default privileges in schema public grant execute on functions to postgres, anon, authenticated, service_role`
for both the `postgres` and `supabase_admin` owners — both rows are in `pg_default_acl`. A
default-privileges entry **replaces** the built-in "EXECUTE to PUBLIC" default rather than layering on
top of it, so every function born in `public` carries **direct, individually-held** grants to those
roles. Revoking PUBLIC subtracts only the PUBLIC entry; the direct grants decide the answer and they
survive.

The live ACLs settle it — the five 0024 functions are the only public functions in this database
**missing** the leading `=X/postgres` (PUBLIC) entry, which is 0024's revoke landing correctly on the
one grantee that was not carrying the privilege:

```
allocate_document_number  {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
accept_booking          {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
                         ^^^^^^^^^^^ PUBLIC, still there on everything 0024 did not touch
```

## Severity: defense in depth, not an open door

Verified, not assumed. All five are `SECURITY INVOKER` (`prosecdef = false`), so a browser-key RPC runs
**as** anon/authenticated; the four document tables have RLS **enabled with zero policies**; and neither
role has `rolbypassrls`. RLS with no policy denies everything, so such a call reaches the function body
and then fails at the table. **No document has been or can be minted this way.** The layer that is
supposed to hold is the one that is open — one policy added later for a legitimate read converts
"contained" into "issuable", invisibly, from a file that claims to have done the restricting.

## The fix — `supabase/migrations/0027_document_function_acls.sql`

- `revoke execute … from anon` and `from authenticated`, each guarded on the role existing (a local/CI
  Postgres has no Supabase roles). The PUBLIC revoke is kept: a no-op here, and the statement that
  matters on a non-Supabase Postgres.
- `grant execute … to service_role` re-stated verbatim rather than trusted to still be there.
- A `do $$` block that reports the **resulting** ACL per function per role via `raise notice` — using
  `has_function_privilege`, not an ACL string match, because reading the ACL text is precisely the
  mistake being undone — and then **raises** (rolling the transaction back, ACL unchanged) if
  `service_role` has lost EXECUTE on any of them. A privilege migration that silently breaks issuance
  is worse than the exposure it closes.
- Idempotent: REVOKE/GRANT are absolute states. Note that re-running 0024 would not undo this —
  `create or replace function` preserves an existing ACL; only a drop + recreate resets it.

**0024 stays as history.** It is applied to production; its §10 comment is superseded by 0027's header,
not edited in place.

### `indian_financial_year` — exemption KEPT, deliberately

0024 §(6) documents it as a pure, `stable`, argument-only date label: it reads no table, allocates no
number, observes nothing about the platform, and its entire output is derivable from a calendar.
Restricting it protects no fact. It is also a callee of the two `SECURITY INVOKER` issuance functions,
so the caller needs EXECUTE on it — closing it buys zero confidentiality and adds one more privilege
that must be correct for issuance to work at all.

## Same shape elsewhere (reported, NOT changed — out of scope for this migration)

`public.accept_booking(uuid, uuid)`, `public.start_trip(uuid)`, `public.complete_trip(uuid, numeric)` —
all `SECURITY INVOKER`, all `anon`/`authenticated` executable, all lifecycle-mutating and evidently
service-only. Same containment applies (invoker rights + RLS), so same severity. They belong to the
lifecycle feature, not the documents feature; changing them here would smuggle a second decision into a
privilege fix. `update_updated_at` / `update_updated_at_column` are trigger functions and are not
directly callable in any way that matters.

## Acceptance criteria

- [x] `anon` and `authenticated` are named in the revoke, not only PUBLIC.
- [x] `service_role` retains EXECUTE, and the migration refuses to commit if it does not.
- [x] Re-runnable; degrades cleanly on a Postgres with no Supabase roles.
- [x] Header explains the `pg_default_acl` mechanism and does not rewrite or blame 0024.
- [x] Resulting ACL reported by `raise notice`, per function, per role.

## Verification

No TypeScript changed, so no service build or suite is in scope. The `do $$` report/assert block was
executed **read-only** against production (it contains no revoke or grant) to validate the plpgsql,
the `regprocedure` casts and the `raise` placeholders: it ran clean and confirmed `service_role` holds
EXECUTE on all five.

## Risk and rollout

Low, and one-directional: it removes a privilege from two roles that cannot use it today and re-grants
the one the services actually hold.

**⚠️ 0027 MUST BE HAND-APPLIED.** Migrations here are applied by hand (CLAUDE.md); merging this PR
deploys nothing. Until someone runs it against `bharattruck-mvp`, the ACL is unchanged. Read the
notices when applying — the expected line for each of the five is `anon=f authenticated=f service_role=t`.
