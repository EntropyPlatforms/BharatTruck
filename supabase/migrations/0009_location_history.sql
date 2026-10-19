-- migration 009: location_history (dense GPS breadcrumbs)
-- Source of truth: frozen docs/MAPS_TRACKING_PLAN.md §4.1 / §4.2 (schema shape is now CONFIRMED, not INFERRED —
-- it matches bt-booking-service insertLocationBreadcrumb on feat/lifecycle-close@09896dd, verified by CTO 2026-07-04).
-- No PostGIS: lat/lng are plain decimals. WRITE owner = bt-booking-service ingestion; bt-tracking-service is READ-only (D-007).
-- Forward-only + idempotent (create ... if not exists), safe to apply before/after the baseline pull.

create table if not exists public.location_history (
  id           bigint generated always as identity primary key,
  booking_id   uuid        not null references public.bookings(id) on delete cascade,
  driver_id    uuid        not null references public.drivers(id)  on delete cascade,
  lat          double precision not null check (lat between -90  and 90),
  lng          double precision not null check (lng between -180 and 180),
  heading      double precision     null check (heading is null or (heading >= 0 and heading <= 360)),
  speed_kmh    double precision     null check (speed_kmh is null or speed_kmh >= 0),
  accuracy_m   double precision     null check (accuracy_m is null or accuracy_m >= 0),
  recorded_at  timestamptz not null,                 -- device/ingest capture time (ordering + `since`)
  created_at   timestamptz not null default now()    -- row insert time
);

-- Primary read pattern: GET /api/tracking/history/:bookingId?since=... ordered by recorded_at for one booking.
create index if not exists location_history_booking_recorded_idx
  on public.location_history (booking_id, recorded_at desc);

-- Idle detection & latest-point lookups by driver.
create index if not exists location_history_driver_recorded_idx
  on public.location_history (driver_id, recorded_at desc);

comment on table public.location_history is
  'Dense GPS breadcrumbs (~1 point / 10-15s). WRITE owner = bt-booking-service ingestion; READ-only for bt-tracking-service.';

-- RLS: service-role bypasses RLS (both booking-service write and tracking-service read use it).
-- No public policies — no anon/authenticated client should touch this table directly (§4.2).
alter table public.location_history enable row level security;
