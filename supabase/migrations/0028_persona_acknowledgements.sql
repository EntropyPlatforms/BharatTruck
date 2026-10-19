-- migration 0028: persona_acknowledgements — the recorded self-declarations behind D-31.
--
-- WHY THIS EXISTS:
--   D-31 (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §10.1): KYC PROMPTS, NEVER GATES. A capability unlocks
--   on EITHER a verified document OR a recorded self-declaration — both are evidence, neither is a wall.
--   The declaration is the STRONGER legal position of the two, because a signed acknowledgement is an
--   affirmative artifact whereas a missing KYC record is merely an absence. That only holds if we can
--   prove WHAT the user agreed to and WHEN, which a boolean flag cannot do. This table stores the exact
--   versioned TEXT the user signed, next to the user, verbatim.
--
--   It is the persistence behind:
--     • POST /me/acknowledgements  — writes one row per signed declaration.
--     • GET  /me/completeness      — reads the kinds on file; a signed kind flips its completeness item
--                                    from 'missing' to 'declared' (D-33). It NEVER unlocks a capability —
--                                    capabilities come from owned assets (@bharattruck/shared/personas).
--
--   The canonical (kind -> version + statement) map is server-owned in
--   bt-auth-service/src/lib/acknowledgements.ts. This table records what was served; the code owns what
--   is currently served. A `version` bump there leaves every existing row here exactly as it was signed.
--
-- STRICTLY ADDITIVE: one new table, one new index. No existing object is altered, no existing query
-- changes its answer. The service ships before this is applied; until then POST /me/acknowledgements
-- 500s on the missing table (loud, correct) and GET /me/completeness simply reports every declarable
-- item as 'missing' rather than 'declared' — completeness is display-only, so nothing breaks and no
-- gate exists to fail closed. Written idempotently (IF NOT EXISTS) and forward-only.
--
-- NOT APPLIED BY THIS BRANCH. Migrations are applied BY HAND (CLAUDE.md / supabase/migrations/README.md),
-- never by CD. Apply this, verify the object exists, regenerate baseline.sql, then tick the catalog.

-- ---------------------------------------------------------------
-- persona_acknowledgements — one row per signed declaration.
--
-- HISTORY, NOT STATE: we deliberately do NOT upsert-to-latest on (user_id, kind). Re-signing after a
-- version bump appends a new row, so the full trail of what a user agreed to, and when, survives. The
-- completeness read only asks "is there ANY acknowledgement of this kind", so duplicates are harmless;
-- the audit value of keeping them is the whole point.
--
-- statement is NOT NULL: a row with no text is exactly the bare-flag shape D-31 exists to avoid. The
-- version+statement are written together from the server-owned registry, so an empty statement can only
-- be a bug, and the constraint catches it.
--
-- ON DELETE CASCADE: an acknowledgement is meaningless without the user it belongs to. If a user row is
-- ever hard-deleted, their declarations go with it — this is personal attestation data, not a document
-- trail a third party relies on (contrast bookings.consignee_user_id, which is NO ACTION for exactly
-- that reason). Matches kyc_documents_user_id_fkey, the sibling evidence table.
-- ---------------------------------------------------------------
create table if not exists public.persona_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null,
  version         text not null,
  statement       text not null,
  acknowledged_at timestamptz not null default now()
);

comment on table public.persona_acknowledgements is
  'Recorded self-declarations behind D-31 (KYC prompts, never gates). One row per signed '
  'acknowledgement, storing the exact versioned TEXT served (not a boolean), so the declaration is a '
  'provable artifact. Read by GET /me/completeness to flip an item to ''declared''; never gates a '
  'capability. Canonical kind->version->statement map: bt-auth-service/src/lib/acknowledgements.ts.';

comment on column public.persona_acknowledgements.kind is
  'The acknowledgement kind, e.g. ''gst_under_threshold''. Constrained to the server-owned registry in '
  'code, not by a DB check — the valid set changes with the code that serves the text, not with a '
  'migration.';

comment on column public.persona_acknowledgements.statement is
  'The exact wording the user agreed to, stored verbatim. A boolean proves nothing later; this is the '
  'artifact.';

-- Every read is "the acknowledgements for this user" (GET /me/completeness), so index user_id.
create index if not exists persona_acknowledgements_user_idx
  on public.persona_acknowledgements (user_id);
