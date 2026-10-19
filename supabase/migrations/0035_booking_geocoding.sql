-- migration 0035: geocoding on bookings — place_id, pincode, GST state code, and the two-pin
-- (address vs exact-gate) model, plus a per-user saved-address book.
--
-- WHY THIS EXISTS
-- Pickup/drop coordinates were typed BY HAND on the post-load form, with the address a
-- separate free-text box. A mistyped coordinate silently corrupts the POD geofence gate and
-- the routed distance, and the booking never captured the pincode/state the e-way bill Part A
-- needs (INDIA_FREIGHT_COMPLIANCE.md §4.3). D-020 added the geocoding endpoints on
-- bt-tracking-service; this migration is the storage half:
--
--   1. GEOCODE RESULT on the booking — place_id, pincode, state_code for both ends, resolved
--      from a picked address (not typed).
--   2. THE TWO-PIN MODEL — source_lat/lng and dest_lat/lng stay the ADDRESS pin (the geocoded
--      centroid, used for distance). *_gate_lat/lng is the pin the user DRAGS to the exact gate,
--      used for the POD geofence. Distance on the address pin, geofence on the gate pin — the
--      address centroid can sit 300 m from the actual loading dock, which is exactly the gap
--      that leaves a driver stuck outside a geofence.
--   3. A SAVED-ADDRESS BOOK — shippers reuse the same 4-5 pickup points; this stores them per
--      user so the next load is two taps, not a re-typed address and a re-dragged pin.
--
-- All booking columns are additive and nullable: existing bookings and every code path that
-- reads source_lat/lng are unchanged. Forward-only and idempotent.
-- Baseline is regenerated from prod AFTER this is applied by hand — do not hand-edit it.

-- 1 + 2. ── geocode result + gate pins on bookings ────────────────────────────────────
alter table public.bookings add column if not exists source_place_id   text;
alter table public.bookings add column if not exists source_pincode     text;
alter table public.bookings add column if not exists source_state_code  text;
alter table public.bookings add column if not exists dest_place_id      text;
alter table public.bookings add column if not exists dest_pincode       text;
alter table public.bookings add column if not exists dest_state_code    text;

-- The dragged exact-gate pins. numeric(10,8)/(11,8) mirrors source_lat/source_lng.
alter table public.bookings add column if not exists source_gate_lat numeric(10,8);
alter table public.bookings add column if not exists source_gate_lng numeric(11,8);
alter table public.bookings add column if not exists dest_gate_lat   numeric(10,8);
alter table public.bookings add column if not exists dest_gate_lng   numeric(11,8);

-- GST state codes are the same 2-digit shape used across the e-way-bill domain
-- (freight_invoices.*_state_code, documents/rules.ts). Guard the format; NULL is always fine.
do $$ begin
  alter table public.bookings
    add constraint bookings_source_state_code_format
    check (source_state_code is null or source_state_code ~ '^[0-9]{2}$') not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.bookings
    add constraint bookings_dest_state_code_format
    check (dest_state_code is null or dest_state_code ~ '^[0-9]{2}$') not valid;
exception when duplicate_object then null; end $$;

comment on column public.bookings.source_place_id  is 'Google place_id of the picked pickup address (D-020). NULL for hand-typed legacy bookings.';
comment on column public.bookings.source_pincode   is 'PIN code of the pickup, from place details — feeds e-way Part A fromPincode.';
comment on column public.bookings.source_state_code is 'GST 2-digit state code of the pickup, from place details — feeds e-way Part A actFromStateCode.';
comment on column public.bookings.source_gate_lat  is 'The exact-gate pin the user DRAGGED for pickup. Distance uses source_lat/lng (the address pin); a gate pin is for geofencing/navigation. NULL = address pin is the gate.';
comment on column public.bookings.dest_gate_lat    is 'The exact-gate pin the user DRAGGED for drop. The POD geofence measures against this when present, else dest_lat/lng.';

-- 3. ── saved-address book ─────────────────────────────────────────────────────────────
create table if not exists public.saved_addresses (
  id                uuid        default gen_random_uuid() not null primary key,
  user_id           uuid        not null references public.users(id) on delete cascade,
  label             text,                                   -- "Main warehouse", optional
  place_id          text,
  formatted_address text        not null,
  lat               numeric(10,8) not null,
  lng               numeric(11,8) not null,
  gate_lat          numeric(10,8),                          -- optional saved exact gate
  gate_lng          numeric(11,8),
  pincode           text,
  state_code        text        check (state_code is null or state_code ~ '^[0-9]{2}$'),
  use_count         integer     not null default 0,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.saved_addresses is
  'A user''s reused pickup/drop points (D-020). Reduces the post-load form to a pick, not a re-typed address + re-dragged pin.';

create index if not exists saved_addresses_user_idx on public.saved_addresses (user_id, last_used_at desc);

-- One saved place per (user, place_id) when a place_id is present — re-saving the same place
-- bumps use_count rather than duplicating. Partial, so hand-pinned rows with a NULL place_id
-- are never blocked.
create unique index if not exists saved_addresses_user_place_uniq
  on public.saved_addresses (user_id, place_id) where place_id is not null;

-- Service-only, deny-all for anon/authenticated; service_role bypasses RLS. The rule migration
-- 0033 exists to enforce — every new public table enables RLS in the SAME migration.
alter table public.saved_addresses enable row level security;
