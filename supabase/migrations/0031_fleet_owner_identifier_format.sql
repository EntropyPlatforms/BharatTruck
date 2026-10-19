-- migration 0031: fleet_owners.gstin / .pan are enforced by FORMAT in the database.
--
-- WHY THIS EXISTS:
--   users.gstin has carried a real format CHECK (users_gstin_format) for a long time, so a
--   shipper's GSTIN cannot be stored malformed no matter which client writes it. fleet_owners had
--   NOTHING — the API validated length only (`.length(15)` / `.length(10)`), which is not
--   validation: fifteen letters passed as a GSTIN.
--
--   PR #146 replaced that with real regexes in bt-fleet-service's OwnerProfileBody. This migration
--   puts the SAME patterns underneath the API, so the guarantee does not depend on every future
--   writer going through that one Zod schema. The GSTIN pattern is character-for-character the one
--   in users_gstin_format and in bt-auth-service/src/routes/identity.ts — a GSTIN must not be valid
--   for a shipper and invalid for a fleet.
--
-- WHY GSTIN IS VALIDATED AND PAN IS NOT VALID:
--   Checked against production 2026-08-14: zero fleet rows fail the GSTIN pattern, so that
--   constraint is added normally and is enforced for existing AND future rows immediately.
--
--   ONE row fails the PAN pattern — 'Joshi Freight Lines' holds pan 'ABCDE123FG', which is exactly
--   ten characters (so the old length rule accepted it) and is not a PAN, because characters 6-9
--   must be digits. A validated CHECK would therefore FAIL TO APPLY.
--
--   NOT VALID is the deliberate answer, not a workaround. It enforces the format on every INSERT
--   and every UPDATE from this moment on, while leaving the existing row untouched — so the
--   constraint ships today without this migration silently rewriting somebody's production data,
--   which is a decision for a human and not for a DDL file.
--
--   TO FINISH THE JOB once that row is corrected (a one-line UPDATE, deliberately not included
--   here), run:
--
--     ALTER TABLE public.fleet_owners VALIDATE CONSTRAINT fleet_owners_pan_format;
--
--   That takes only a SHARE UPDATE EXCLUSIVE lock — it does not block reads or writes — and
--   promotes the constraint to fully enforced. Until then the single legacy row is the only
--   value in the table that the constraint does not describe.
--
-- STRICTLY ADDITIVE: two constraints on one table. No existing object is altered, no existing
-- query changes its answer, and no row is modified. Idempotent via the catalog guards below —
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS form for CHECK constraints.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fleet_owners'::regclass AND conname = 'fleet_owners_gstin_format'
  ) THEN
    ALTER TABLE public.fleet_owners
      ADD CONSTRAINT fleet_owners_gstin_format
      CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fleet_owners'::regclass AND conname = 'fleet_owners_pan_format'
  ) THEN
    ALTER TABLE public.fleet_owners
      ADD CONSTRAINT fleet_owners_pan_format
      CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$') NOT VALID;
  END IF;
END $$;
