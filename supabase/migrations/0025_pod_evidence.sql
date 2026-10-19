-- migration 0025: POD evidence hardening — camera-only capture, on-device hash,
-- server-authoritative time, geofence-gated OTP, structured discrepancy, and the
-- delivery_asserted lifecycle branch. (feat/pod-rebuild.)
--
-- WHY THIS EXISTS: the receiver-OTP POD that ships today (migration 0010) proves a
-- code reached the consignee's inbox. That is one control. INDIA_FREIGHT_COMPLIANCE.md
-- §5.5 is blunt that a single control loses a contested dispute — a photo alone is
-- "trivially defeated", a geotag alone "collapses once contested". The strength comes
-- from the COMBINATION: an on-device hash nobody can recompute, a server clock the
-- driver cannot reset, a live GPS trail that has to stay internally consistent for
-- hours, and a server-held quantity the driver cannot edit. These tables are where
-- those controls become durable. The OTP path is NOT replaced; it is the confirmed
-- tier of a two-tier proof (§5, D-13/D-14, ARCHITECTURE_UNIFIED_IDENTITY.md §6.3).
--
-- STRICTLY ADDITIVE + IDEMPOTENT. Runs against the live DB (677 bookings) with no
-- backfill and no destructive change: add-column-if-not-exists, create-table-if-not-
-- exists, and the enum value behind `add value if not exists`. Every existing row is
-- untouched and every existing query keeps its shape. It references only its own new
-- objects plus tables that predate the whole 002x series (bookings, drivers, users),
-- so its number is a filename, not a dependency.
--
-- OUT-OF-ORDER APPLY IS EXPECTED AND SAFE. 0022/0023/0024 and 0026 are already live on
-- production; this file never was, and it keeps its number (0026 and 0027 are taken) so
-- it lands AFTER a higher number. That is fine in both directions:
--   * nothing here reads or alters anything 0026 added. 0026 touches users (gstin,
--     claimed_at) and bookings (consignee_user_id); this file adds different columns to
--     bookings and references public.users(id) only — a key that has existed since 001.
--   * pod_discrepancies.consignee_user_id below points at users(id), NOT at
--     bookings.consignee_user_id, so it does not require 0026 either. The value is
--     COPIED from the booking by the service at acknowledgement time; on a database
--     without 0026 the booking simply has none and the ack records NULL, which is the
--     same honest answer an unclaimed consignee produces.
-- The enum `add value if not exists` and every `if not exists` guard mean a re-run is a
-- no-op, so a partial apply can be repeated rather than untangled.
--
-- APPLY IS GATED on live-Supabase access and is done BY HAND (BLOCKERS.md B-0 precedent,
-- CLAUDE.md migration procedure). The service code tolerates a database where this has
-- not landed yet: READS answer "no evidence", the geofence gate stays OFF, and the
-- existing email-OTP POD behaves EXACTLY as it does today. WRITES on the new endpoints
-- fail loud with a 503 rather than silently pretending to store legal evidence — the
-- same missing-relation contract fleet.ts and documents/repository.ts already use.
--
-- NO PostGIS (frozen contract §3.1 D-007): lat/lng are plain decimals; every distance
-- is haversine in app code. This schema stays portable.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lifecycle: the delivery_asserted branch.
--
-- WHY A NEW STATE, not a flag: when the receiver CANNOT confirm — no smartphone, a
-- night drop, a warehouse hand-off to a loader who will not touch an OTP — the driver
-- still delivered, but there is no consignee-held secret to prove it. Folding that into
-- 'completed' would make a weaker proof silently indistinguishable from an OTP-confirmed
-- one (ARCHITECTURE_UNIFIED_IDENTITY.md §6.3). So the trip moves in_transit →
-- delivery_asserted (evidence captured, receiver absent), and ops — not the driver —
-- closes it to 'completed'. The strength tier is carried on pod_state below, so a trip
-- that ops closes from delivery_asserted is NEVER retroactively upgraded to 'confirmed'.
--
-- The value is ADDED but never USED in this migration (no default, no CHECK references
-- it): Postgres forbids using a freshly-added enum label in the same transaction that
-- adds it, and migration 0011 established this exact pattern (add 'paid', create tables).
alter type booking_status add value if not exists 'delivery_asserted';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pod_evidence — the capture record. One row per photo (a delivery may need
--    several: the goods, the stamped LR, a damaged carton).
--
-- 🔴 THE INTEGRITY STORY THIS TABLE IS BUILT AROUND (§5.2, §5.4):
--   * sha256_original is hashed ON THE DEVICE before upload and stored VERBATIM. The
--     server never recomputes it from bytes it re-encoded — server-side-only hashing
--     would only prove integrity from the server onward, exactly the segment nobody
--     disputes. sha256_received is filled ONLY when the WORM object store is wired and
--     asserts equality against the original; until then it is NULL (storage is inert).
--   * The original bytes are NEVER re-encoded (IT Act s.7(b)). This service records
--     metadata only and hands the pixels straight to object storage; re-compressing a
--     POD photo on upload is the single most common way logistics apps destroy their
--     own evidence, so the byte path deliberately never passes through app code.
--   * captured_at_server is authoritative; captured_at_device is a CLAIM; the gap is
--     stored as clock_skew_seconds because a large skew is itself a fraud signal (§5.4).
--   * capture_method is CHECK-constrained to camera-only. Gallery import destroys
--     provenance and is the most common fraud vector (§5.4 rule 1), so a gallery-sourced
--     row cannot exist at the storage layer, not merely at the API. The column exists so
--     the control is auditable, and the CHECK is what makes it enforceable.
--   * mock_location_detected + gps_source + gps_accuracy_m are recorded, not blocked:
--     an honest phone with developer options on can false-positive, so a mock fix is
--     captured on the row and on the audit trail as a signal for dispute review, rather
--     than hard-rejecting what may be a real delivery.
create table if not exists public.pod_evidence (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid        not null references public.bookings(id) on delete cascade,
  -- drivers.id (NOT users.id) — the party who captured, matching bookings.driver_id.
  driver_id             uuid            null references public.drivers(id) on delete set null,

  -- On-device SHA-256, 64 lowercase hex. Stored as sent; the app's hash IS the anchor.
  sha256_original       text        not null check (sha256_original ~ '^[0-9a-f]{64}$'),
  -- Server re-hash of the bytes the WORM store received; asserted == sha256_original.
  -- NULL while storage is inert (no bucket) — the metadata is real, the bytes no-op.
  sha256_received       text            null check (sha256_received is null or sha256_received ~ '^[0-9a-f]{64}$'),

  -- 🔴 Camera-only. Gallery import is refused at the DB, not just the API.
  capture_method        text        not null default 'camera' check (capture_method in ('camera')),

  -- Time: server authoritative, device a claim, skew a signal. Skew is stored SIGNED
  -- (device ahead = positive) so a reader can tell a fast clock from a slow one; the
  -- fraud test is on its magnitude.
  captured_at_server    timestamptz not null default now(),
  captured_at_device    timestamptz     null,
  clock_skew_seconds    integer         null,

  -- Position at capture, evaluated against the Rule 46(o) delivery address.
  lat                   double precision null check (lat is null or lat between -90  and 90),
  lng                   double precision null check (lng is null or lng between -180 and 180),
  gps_accuracy_m        double precision null check (gps_accuracy_m is null or gps_accuracy_m >= 0),
  gps_source            text            null,
  mock_location_detected boolean    not null default false,
  -- Distance in metres from the booking's dest_lat/dest_lng at capture time, plus a
  -- coarse verdict. 'unknown' when no fix was available.
  geofence_distance_m   double precision null check (geofence_distance_m is null or geofence_distance_m >= 0),
  geofence_result       text        not null default 'unknown'
                          check (geofence_result in ('inside','outside','unknown')),

  -- Provenance metadata (§5.4). exif_raw is preserved VERBATIM but never relied on
  -- alone — EXIF is freely rewritable (§5.3), so it is corroboration, not the anchor.
  device_id             text            null,
  os_version            text            null,
  app_version           text            null,
  lr_number             text            null,
  exif_raw              jsonb           null,

  -- WORM object-store handle for the original bytes (GCS object-lock — see the storage
  -- rationale in bt-booking-service/src/lib/pod/storage.ts). NULL + storage_status
  -- 'no_op' while the bucket is unprovisioned (BLOCKERS.md B-8).
  original_bytes_uri    text            null,
  storage_status        text        not null default 'pending'
                          check (storage_status in ('pending','stored','no_op','failed')),

  created_at            timestamptz not null default now()
);

-- IDEMPOTENCY ANCHOR: re-submitting the SAME capture (same booking, same on-device
-- hash) must be a no-op, never a duplicate row. A driver on a flaky rural connection
-- retries; the unique index turns the retry into a 23505 the service reads as "already
-- recorded" and returns the existing row.
create unique index if not exists pod_evidence_booking_hash_uidx
  on public.pod_evidence (booking_id, sha256_original);

create index if not exists pod_evidence_booking_idx
  on public.pod_evidence (booking_id, created_at desc);

comment on table public.pod_evidence is
  'POD capture evidence (camera-only, on-device SHA-256, server-authoritative time). One row per photo; (booking_id, sha256_original) is the idempotency key. WRITE owner = bt-booking-service. Originals live in WORM object storage, never re-encoded (IT Act s.7(b)).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pod_state — the per-booking proof-strength ledger. One row per booking.
--
-- WHY SEPARATE from bookings.status: two trips both end 'completed', but one was
-- OTP-confirmed by the consignee and one was ops-closed from an asserted delivery. The
-- status column cannot tell them apart, and it must not — a claim adjuster needs to
-- know which proof they are holding. pod_strength is that discriminator, and it is
-- written at the moment strength is DECIDED (OTP verified → 'confirmed'; evidence-only
-- assertion → 'asserted') and NEVER silently upgraded afterwards.
create table if not exists public.pod_state (
  booking_id            uuid primary key references public.bookings(id) on delete cascade,
  pod_strength          text        not null check (pod_strength in ('confirmed','asserted')),

  -- The confirmed tier (receiver OTP verified upstream in bt-cargo-ledger).
  confirmed_at          timestamptz     null,
  confirmed_via         text            null,

  -- The asserted tier (receiver could not confirm). assert_reason is a typed enum so
  -- "why was there no consignee confirmation" is queryable, not buried in free text.
  asserted_at           timestamptz     null,
  asserted_by_driver_id uuid            null references public.drivers(id) on delete set null,
  assert_reason         text            null
                          check (assert_reason is null or assert_reason in
                            ('no_smartphone','night_delivery','warehouse_handoff','receiver_refused_confirm','no_receiver_present','other')),

  -- Set when ops closes a delivery_asserted trip to 'completed'. pod_strength stays
  -- 'asserted' through this — the weaker proof is on the record permanently.
  closed_by_ops_at      timestamptz     null,
  closed_by_ops_user_id uuid            null references public.users(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.pod_state is
  'Per-booking POD proof-strength ledger. pod_strength=confirmed (receiver OTP) vs asserted (evidence only, receiver absent). Written by bt-booking-service; an asserted trip closed by ops stays asserted — never upgraded.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. pod_discrepancies — structured shortage/damage capture (§5.7).
--
-- 🔴 THE CONTROL: expected_quantity is SERVER-HELD (snapshotted from
-- bookings.pod_expected_quantity, which only a shipper/ops can set — never the driver)
-- and the driver supplies only actual_quantity. Pilferage works by making the paperwork
-- agree with the reduced quantity; if the driver can type both sides, the control is
-- theatre. Free-text remarks are the most under-built part of every ePOD (§5.7) — this
-- is two numeric fields, a typed reason, a mandatory geofenced photo when they differ,
-- and BOTH parties on record.
create table if not exists public.pod_discrepancies (
  id                    uuid primary key default gen_random_uuid(),
  -- One discrepancy record per booking (idempotency + "the note on the LR"): UNIQUE.
  booking_id            uuid        not null unique references public.bookings(id) on delete cascade,

  -- Server-held expected vs driver-reported actual. delta is stored (not generated) so
  -- a NULL expected — an older booking with no pod_expected_quantity set — still yields
  -- a row; the app computes and flags it.
  expected_quantity     numeric         null,
  actual_quantity       numeric     not null check (actual_quantity >= 0),
  delta                 numeric         null,
  quantity_unit         text            null,

  reason                text        not null
                          check (reason in ('shortage','damage','wrong_goods','refusal','partial_acceptance')),

  -- Mandatory geofenced+timestamped photo when delta <> 0 (enforced in the service,
  -- which will not accept a non-zero delta without an evidence row). FK keeps it real.
  evidence_id           uuid            null references public.pod_evidence(id) on delete set null,

  -- 🔴 DUAL ACKNOWLEDGEMENT — the digital analogue of a joint certificate. The driver is
  -- on record at submission; the consignee ack lands when they verify the OTP (or, on a
  -- delivery_asserted trip, never — which is itself the record).
  driver_ack_at         timestamptz not null default now(),
  driver_id             uuid            null references public.drivers(id) on delete set null,
  consignee_ack_at      timestamptz     null,
  consignee_ack_via     text            null,
  -- WHO acknowledged as the consignee. A joint damage certificate is signed by two NAMED
  -- parties; a timestamp alone names one of them and leaves the other as "someone typed
  -- the code", which is exactly the half-evidence §5.7 warns a free-text remark becomes.
  -- Copied from bookings.consignee_user_id (0026) when the ack lands, and NULL when the
  -- consignee is UNCLAIMED — which is most of them: a receiver with a name and a phone
  -- and no login, whose access path is the POD OTP (D-13), not a session. Nullable and
  -- never inferred, so "we do not know who" cannot be mistaken for "nobody".
  consignee_user_id     uuid            null references public.users(id) on delete set null,

  -- Claim-clock anchors, snapshotted so the record is self-contained years later.
  -- booking_date drives the 180-day pre-suit notice (Carriage by Road Act s.16 — runs
  -- from BOOKING, not delivery or discovery); delivery_date drives the 7-day insurance
  -- intimation. Surfacing both turns POD from a record into a claims-preservation tool
  -- (§5.7): on a long haul a paper POD returns in 10-20 days and burns much of the window.
  booking_date          date            null,
  delivery_date         timestamptz     null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists pod_discrepancies_booking_idx
  on public.pod_discrepancies (booking_id);

comment on table public.pod_discrepancies is
  'Structured delivery discrepancy (§5.7): server-held expected vs driver actual, typed reason, mandatory photo when delta<>0, dual NAMED driver+consignee acknowledgement (consignee_user_id NULL for an unclaimed receiver), and snapshotted 180-day (booking) / 7-day (delivery) claim-clock anchors.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. pod_audit_log — append-only trail of access, export and modification (§5.4 rule 5).
--
-- WHY: the hash and the timestamps are only credible if you can show nobody tampered
-- with the record after the fact. This log is what makes every other control believable
-- in a dispute (§5.5, "makes all the others credible"). APPEND-ONLY by construction —
-- the service only ever INSERTs; there is no update or delete path in code — and it is
-- retained as long as the evidence it describes.
create table if not exists public.pod_audit_log (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid        not null references public.bookings(id) on delete cascade,
  evidence_id           uuid            null references public.pod_evidence(id) on delete cascade,
  action                text        not null
                          check (action in (
                            'evidence_captured','evidence_access','evidence_export','modify_attempt',
                            'discrepancy_logged','otp_gate_pass','otp_gate_block','otp_gate_degraded',
                            'delivery_asserted','pod_confirmed','consignee_ack','ops_closed'
                          )),
  actor_user_id         uuid            null references public.users(id) on delete set null,
  actor_role            text            null,
  detail                jsonb       not null default '{}'::jsonb,
  occurred_at           timestamptz not null default now()
);

create index if not exists pod_audit_log_booking_idx
  on public.pod_audit_log (booking_id, occurred_at desc);
create index if not exists pod_audit_log_evidence_idx
  on public.pod_audit_log (evidence_id, occurred_at desc) where evidence_id is not null;

comment on table public.pod_audit_log is
  'Append-only POD access/export/modification trail (§5.4 rule 5). INSERT-only by construction; retained as long as the evidence. WRITE owner = bt-booking-service.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. bookings — the server-held expected quantity for discrepancy reconciliation.
--
-- Nullable and additive: every existing booking gets NULL, which the discrepancy flow
-- reads as "no server-held count" (delta uncomputable, flagged) rather than failing.
-- Only a shipper or ops writes this (PATCH /bookings/:id/expected-quantity, mirroring
-- setReceiverEmail) — the driver CANNOT, which is the whole point (§5.5, §5.7).
alter table public.bookings add column if not exists pod_expected_quantity numeric
  check (pod_expected_quantity is null or pod_expected_quantity >= 0);
alter table public.bookings add column if not exists pod_quantity_unit text;

comment on column public.bookings.pod_expected_quantity is
  'Server-held expected delivery quantity for POD discrepancy reconciliation. Set by shipper/ops only — NEVER the driver (§5.7). NULL on pre-0025 bookings.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: every service reads/writes with the service-role key, which bypasses RLS.
-- Enabling with no policy is deny-by-default for anon/authenticated — the posture the
-- rest of the schema already holds (BIBLE §5.6 item 1, pod_receipts in 0010).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.pod_evidence      enable row level security;
alter table public.pod_state         enable row level security;
alter table public.pod_discrepancies enable row level security;
alter table public.pod_audit_log     enable row level security;
