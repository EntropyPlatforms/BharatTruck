-- migration 0038: user_kyc — the KYC verification record the kyc module targets but which never existed.
--
-- WHY THIS EXISTS
-- bt-auth-service/src/modules/kyc/{repository,fraud}.ts read and write a `user_kyc` table that was
-- never created — every call threw at runtime. This creates it, wired to the provider seam
-- (provider.ts) that now fronts the aggregators. One row per user; per-document results live in the
-- `verifications` JSONB.
--
-- PRIVACY RULE (founder's call): NEVER store a full Aadhaar number. We keep only
--   • a SHA-256 hash (one-way) for cross-account duplicate detection,
--   • the last 4 digits, and
--   • the provider's reference id (in verifications), i.e. a reference KEY, not the number.
-- The same posture is applied to PAN (hash only). `verifications` holds status + provider_ref +
-- verified_at per document — deliberately NOT the raw provider response, which carries name / dob /
-- address / masked number PII. All hangs off users.id (D-4: one KYC identity per person).
--
-- KYC does NOT gate use at MVP (D-5/D-31): this records verification state for informational
-- badges and Ops review; nothing here blocks an action. Forward-only, idempotent; baseline
-- regenerated from prod after apply.

create table if not exists public.user_kyc (
  id            uuid        default gen_random_uuid() not null primary key,
  user_id       uuid        not null references public.users(id) on delete cascade,
  role          text,
  kyc_level     text        not null default 'L0' check (kyc_level in ('L0', 'L1', 'L2', 'L3')),
  -- Per-document results: { aadhaar: {status, provider_ref, verified_at}, pan: {...}, ... }.
  -- No raw provider PII, no full ID numbers.
  verifications jsonb       not null default '{}'::jsonb,
  -- Cross-account dedup keys. A HASH, never the number; the partial indexes below make the lookup
  -- (does this Aadhaar/PAN already belong to a different user?) a single indexed probe.
  aadhaar_hash  text,
  aadhaar_last4 varchar(4),
  pan_hash      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)
);

comment on table public.user_kyc is
  'Per-user KYC verification record (D-4). Stores document verification STATUS + a reference key, never a full ID number: Aadhaar/PAN keep only a SHA-256 hash (dedup) + last-4. KYC does not gate use (D-5/D-31).';

create index if not exists user_kyc_aadhaar_hash_idx on public.user_kyc (aadhaar_hash) where aadhaar_hash is not null;
create index if not exists user_kyc_pan_hash_idx     on public.user_kyc (pan_hash)     where pan_hash is not null;

-- Service-only, deny-all for anon/authenticated; service_role bypasses. The rule 0033 enforces.
alter table public.user_kyc enable row level security;
