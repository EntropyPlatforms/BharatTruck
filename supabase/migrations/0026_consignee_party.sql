-- migration 026: the consignee is a first-class freight party (D-22).
--
-- WHY THIS EXISTS:
--   Today the receiver of a shipment is one nullable string — `bookings.receiver_email`. That
--   string is the whole of what the platform knows about the party the goods are FOR, and it is
--   wrong in three separate directions at once:
--
--     a) COMPLIANCE. An LR and an e-way bill require a consignee NAME, a GSTIN-or-URP and an
--        ADDRESS (docs/INDIA_FREIGHT_COMPLIANCE.md §2). An email address supplies none of them, so
--        migration 0024's documents have to be handed those fields by whoever happens to be typing
--        the request, with nothing to read them back from.
--     b) DELIVERY. The POD code is emailed. Consignees in this market are reached on a PHONE, and
--        672 of 677 live bookings carry no receiver email at all — a trip whose receiver has no
--        contact on file can never be closed by the receiver-OTP flow, so it dead-ends short of
--        'completed' and short of the payout that gates.
--     c) IDENTITY. The receiver is a shipper-KIND party: the moment they ship something outbound
--        they are the same kind of entity as the human who consigned to them. A string cannot
--        become an account, so every delivery today throws away a shipper.
--
-- THE MODEL, IN ONE LINE (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §9.2, LOCKED — do not redesign):
--   A consignee is a `public.users` row in one of two states.
--
--     UNCLAIMED  — created by whoever posted the load. NO credential at all: no password_hash, no
--                  google_sub. It is a RECORD, not a weak account; it cannot be logged into, only
--                  claimed. Never mint a password for one.
--     CLAIMED    — the same row, after the human authenticates (phone OTP), inheriting the
--                  shipment history already attached to it.
--
--   Documents need a RECORD; actions need a LOGIN. Those are different requirements and only the
--   second one needs authentication, which is why one entity kind covers both. A separate
--   `freight_parties` table was considered and REJECTED: the moment a consignee also ships
--   outbound it would give one human two identities — exactly what the unified model exists to
--   kill — and claiming would then need a merge migration.
--
-- VERIFIED AGAINST THE LIVE DATABASE BEFORE WRITING (2026-08-07):
--   • `public.users` has 48 rows, 21 of them already passwordless. A credential-less users row is
--     an ORDINARY shape here, not an anomaly: accounts are created today phone-only (verify-otp
--     inserts `{phone_number, role}` and nothing else), email-only and Google-only, and
--     password-reset already handles `password_hash IS NULL`. Nothing new has to tolerate it.
--   • `users_phone_number_key` is a UNIQUE index on `users(phone_number)`. Postgres allows many
--     NULLs in a unique index, so the email-only rows coexist with it untouched. THIS INDEX IS THE
--     DEDUP MECHANISM for consignees — see (3).
--   • `users` already carries address / city / state / pincode, so a consignee's address needs no
--     new table. It has NO gstin column, which is what (1) adds.
--   • 677 bookings, 672 with `receiver_email` NULL, the remainder mostly terminal.
--
-- STRICTLY ADDITIVE. Nothing existing changes meaning:
--   Two nullable columns on `users`, one nullable column plus an index on `bookings`, and one
--   backfill of a column that did not exist a statement earlier. Not one existing column is
--   altered, not one existing query changes its answer, and every one of the 677 live bookings
--   behaves identically whether or not this file has been applied.
--
--   `bookings.receiver_email` IS DELIBERATELY NOT DROPPED. It is still read by the live POD path in
--   bt-cargo-ledger (via bt-booking-service's getPodContext) and by PATCH /bookings/:id/receiver-email.
--   Both columns are kept and both are populated. receiver_email is SUPERSEDED, not replaced;
--   removing it is a later migration, and only once POD is re-pointed at the consignee's phone
--   (D-26, the Twilio work). Dropping it here would take delivery confirmation down.
--
-- DEPLOY ORDERING (CLAUDE.md: migrations are applied BY HAND, CD deploys services on merge):
--   The service ships before this file is applied, so bt-booking-service treats every column here
--   as optional and the contract is the one 0024 set:
--     READS degrade — a booking read on a pre-0026 database simply has no consignee block, which
--     is the truth and keeps every existing screen rendering.
--     WRITES fail loudly — a create that NAMES a consignee 503s with a message naming this
--     migration, rather than silently discarding the party the goods are for.
--   A legacy create that supplies only `receiver_email` never touches a column below, so it keeps
--   working on a pre-0026 database with no change whatsoever.

-- ---------------------------------------------------------------
-- (1) users.gstin — the consignee's tax identity, and the shipper's.
--
-- Added to `users` rather than to a consignee-specific table BECAUSE there is no consignee-specific
-- table: the party who receives today ships tomorrow, and a GSTIN belongs to the business, not to
-- the direction of one consignment. `fleet_owners.gstin` already exists for the carrier side
-- (migration 0015); this is the same fact for the shipper/consignee side.
--
-- FORMAT. A GSTIN is exactly 15 characters and its shape is fixed by the GST registration scheme:
--
--     33  AABCV3609C  1  Z  J
--     ^   ^           ^  ^  ^
--     |   |           |  |  +-- checksum, alphanumeric
--     |   |           |  +----- 'Z' by default for a regular registration
--     |   |           +-------- entity code for that PAN in that state
--     |   +-------------------- the holder's 10-character PAN
--     +------------------------ 2-digit GST state code
--
-- The CHECK is anchored and case-sensitive on purpose: a GSTIN is canonically UPPERCASE, and the
-- first two digits are read as a state code by rules.stateCodeOfGstin() in bt-booking-service,
-- which decides intra- vs inter-state supply on an invoice. Storing 'null'/''/lowercase junk here
-- would produce a confidently WRONG tax treatment downstream, so the malformed value is rejected at
-- the column instead. The 14th character is NOT pinned to 'Z' — it varies for OIDAR and UN-body
-- registrations, and rejecting a real registration is worse than accepting an unusual one.
--
-- NULL is meaningful and is the common case: it means UNREGISTERED, which prints as 'URP' on an LR
-- and an e-way bill (§2). We deliberately do NOT store the literal string 'URP' — that is a
-- rendering of "no GSTIN", and a column that holds both NULL and 'URP' has two spellings for one
-- fact.
-- ---------------------------------------------------------------
alter table public.users
  add column if not exists gstin text;

alter table public.users
  drop constraint if exists users_gstin_format;

alter table public.users
  add constraint users_gstin_format
    check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$');

comment on column public.users.gstin is
  'GSTIN of this party, 15 chars, uppercase, format-checked. NULL = unregistered, which renders as '
  '''URP'' on an LR / e-way bill — the literal ''URP'' is never stored. First two digits are the GST '
  'state code and drive the intra- vs inter-state supply decision on an invoice.';

-- ---------------------------------------------------------------
-- (2) users.claimed_at — the line between a RECORD and an ACCOUNT.
--
-- NULL     = an unclaimed party record. Somebody else created it while posting a load; the human it
--            describes has never authenticated and cannot log in, because there is no credential.
-- NOT NULL = the human has authenticated at least once. The row is a full account.
--
-- WHY A TIMESTAMP AND NOT A BOOLEAN: "when did this stop being someone else's record of you" is the
-- audit question that actually gets asked, and a boolean cannot answer it. Same reason
-- `users.kyc_verified_at` is a timestamp.
--
-- WHY THE BACKFILL IS NOT OPTIONAL: without it every one of the 48 existing users reads as
-- UNCLAIMED — each of them a real signup who authenticated to exist — and the first piece of code
-- to gate on `claimed_at IS NULL` would lock out the entire live user base. `created_at` is the
-- honest value: for a row created BY the human, the moment it was created is the moment they
-- authenticated.
--
-- WHY THE BACKFILL IS GUARDED ON THE COLUMN BEING NEW: this file is written to be re-runnable, and
-- an unguarded `update users set claimed_at = created_at` on a second run would CLAIM every
-- unclaimed consignee record created since the first run — silently converting records into
-- accounts. The guard makes the backfill a one-time event tied to the column's creation.
--
-- WHY THE DEFAULT IS SET AFTERWARDS, NOT ON THE ADD: `add column ... default now()` would stamp all
-- 48 existing rows with the migration's own clock instead of their real created_at. Adding the
-- column bare, backfilling from created_at, and only THEN attaching the default gets both halves
-- right. The default is what keeps this additive for every EXISTING writer: bt-auth-service creates
-- users in four places and knows nothing about this column, and every row it creates is by
-- definition a human who just authenticated, so `now()` is the correct answer for all of them. The
-- ONE writer that must opt out — the consignee upsert in bt-booking-service — passes an EXPLICIT
-- NULL, which is the single place in the codebase that creates a credential-less record.
-- ---------------------------------------------------------------
do $$
declare
  column_is_new boolean;
begin
  select not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'claimed_at'
  ) into column_is_new;

  alter table public.users add column if not exists claimed_at timestamptz;

  if column_is_new then
    update public.users set claimed_at = created_at where claimed_at is null;
    raise notice 'consignee-party: backfilled claimed_at = created_at for % existing user(s)',
      (select count(*) from public.users where claimed_at is not null);
  else
    raise notice 'consignee-party: users.claimed_at already existed — backfill SKIPPED (re-run)';
  end if;
end $$;

alter table public.users
  alter column claimed_at set default now();

comment on column public.users.claimed_at is
  'When this human first authenticated. NULL = an UNCLAIMED party record created by someone else '
  'while posting a load — no credential, cannot be logged into, only claimed (phone OTP -> set '
  'password, which is when this is stamped). Defaults to now() so every ordinary signup path is '
  'correct without knowing about this column; only the consignee upsert passes an explicit NULL.';

-- ---------------------------------------------------------------
-- (3) bookings.consignee_user_id — the party the goods are for.
--
-- NULLABLE, and it has to be: 672 of the 677 live bookings have no consignee recorded at all and
-- must keep working exactly as they do. A NOT NULL column here would either fail the migration or
-- force a fabricated party onto every historical trip, which would be a false document.
--
-- MATCHING, AND WHY THE UNIQUE INDEX ON users(phone_number) IS THE MECHANISM: at posting time a
-- consignee whose phone already belongs to a users row LINKS to that row rather than creating a
-- duplicate, so the load appears under that party's inbound list and, once they claim, their whole
-- history is already there. Phone is the natural key because it is the one channel this market
-- actually reaches a receiver on, and `users_phone_number_key` already enforces it — the service
-- inserts with ON CONFLICT DO NOTHING against that index, so two bookings naming the same new
-- consignee in the same instant produce ONE party, not a duplicate and not a 500.
--
-- NO CASCADE on the FK (plain NO ACTION): a consignee who is a party to a completed trip cannot be
-- deleted out from under the LR that names them. That is the correct answer for a document trail —
-- if a user must go, the bookings referencing them are the conversation to have first, not a
-- silent NULL-out of the receiver on a delivered consignment.
--
-- PARTIAL INDEX, matching migration 0022's vehicles indexes: every lookup is "the bookings
-- consigned to this party", which can never match a NULL, so the 672 legacy rows have no business
-- in the index.
-- ---------------------------------------------------------------
alter table public.bookings
  add column if not exists consignee_user_id uuid references public.users(id);

create index if not exists bookings_consignee_user_idx
  on public.bookings (consignee_user_id) where consignee_user_id is not null;

comment on column public.bookings.consignee_user_id is
  'The receiving party (D-22), a shipper-KIND users row that may be UNCLAIMED (no credential). '
  'Matched by phone against users_phone_number_key at posting time, so an existing party is linked '
  'rather than duplicated. NULL on the 672 legacy bookings that predate the model. SUPERSEDES '
  'bookings.receiver_email, which is kept and still populated until POD is re-pointed at the '
  'consignee phone (D-26); dropping it is a later migration.';

comment on column public.bookings.receiver_email is
  'SUPERSEDED by bookings.consignee_user_id (migration 0026 / D-22). Still the address the '
  'receiver-OTP POD code is emailed to, so it is still written on create — do not drop it until '
  'the POD flow sends to the consignee''s phone (D-26).';

-- ---------------------------------------------------------------
-- (4) Sanity report — no writes, and it cannot fail the migration.
--
-- Prints what the deploy actually did against live data, so the person running this by hand sees
-- the real numbers instead of assuming them. The one number worth staring at is unclaimed users:
-- immediately after this migration it MUST be zero, because every existing row is a real signup.
-- Any other answer means the backfill guard above did not fire and something is about to be
-- treated as a record when it is an account.
-- ---------------------------------------------------------------
do $$
declare
  unclaimed_users     integer;
  credentialed_ghosts integer;
  consigned_bookings  integer;
begin
  select count(*) into unclaimed_users
  from public.users where claimed_at is null;

  -- The anti-goal from §9.2, checked rather than asserted: an unclaimed record must have NO
  -- credential. A row that is both unclaimed AND holds a password_hash or a google_sub is a
  -- loggable account nobody has claimed, which is the one shape this model must never produce.
  select count(*) into credentialed_ghosts
  from public.users
  where claimed_at is null and (password_hash is not null or google_sub is not null);

  select count(*) into consigned_bookings
  from public.bookings where consignee_user_id is not null;

  raise notice 'consignee-party: % unclaimed user record(s), % booking(s) with a consignee',
    unclaimed_users, consigned_bookings;

  if credentialed_ghosts > 0 then
    raise warning 'consignee-party: % user row(s) are UNCLAIMED but hold a credential — an unclaimed record must never be loggable (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §9.2). Investigate before anything gates on claimed_at.',
      credentialed_ghosts;
  end if;
end $$;
