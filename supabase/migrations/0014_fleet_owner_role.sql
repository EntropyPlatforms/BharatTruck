-- migration 014: add the fleet_owner role to user_role.
--
-- WHY THIS IS ITS OWN FILE: `alter type ... add value` cannot be used in the SAME
-- transaction that later references the new label (Postgres restriction). Migration
-- 015 checks against 'fleet_owner', so the label must be committed first.
-- Run this file, commit, THEN run 015.
--
-- LIVE-SCHEMA NOTE (verified against rxbdzbcndpzznvqcbimg on 2026-07-26 via PostgREST
-- introspection, not from these files): the live user_role enum is
--   ('shipper','driver','admin')
-- bt-auth-service already ACCEPTS role='fleet_owner' in its Zod register schema
-- (bt-auth-service/src/routes/auth.ts:95) and would 500 on insert today. This closes
-- that gap. It is also review finding #9 in supabase/migrations/README.md.

alter type public.user_role add value if not exists 'fleet_owner';
