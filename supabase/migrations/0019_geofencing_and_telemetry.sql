-- migration 019: geofencing, durable route alerts, and the per-trip telemetry rollup.
--
-- WHY THIS EXISTS (D-014, appended to BIBLE §3.2): every tracking surface built so far is
-- computed ON READ — /route, /eta and /track all answer "where is the truck now" from caches.
-- That model cannot express an EVENT. "The truck entered the drop geofence at 14:32 and sat
-- there 90 minutes" exists only at the instant it happens; a poll ten minutes later cannot
-- reconstruct it. Geofencing, detention and alerting therefore need evaluation on EVERY GPS
-- fix, and that needs somewhere durable to write to. These three tables are that place.
--
-- OWNERSHIP: written by bt-tracking-service's evaluator (POST /internal/evaluate), which
-- bt-booking-service fires after each accepted /location/update. Raw GPS ingestion does NOT
-- move — bt-booking-service still owns loc:* and location_history (frozen contract §3.1 §1,
-- D-007). Only DERIVED geometry lands here, which is where D-001 put it.
--
-- NO PostGIS: lat/lng are plain decimals and every distance is haversine in app code, per
-- D-007. (The live DB does carry a stray PostGIS extension — BIBLE §5.4 item 12 — but it is
-- deliberately unused, so this schema stays portable.)
--
-- Forward-only + idempotent. Safe to apply before or after the baseline pull.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. geofences — explicit, fleet-defined circles (depot, warehouse, checkpoint).
--
-- Pickup and drop are deliberately NOT rows here: every booking already carries
-- source_lat/lng and dest_lat/lng, so materialising a fence per booking would duplicate
-- the truth and let the two drift. The evaluator treats those two as IMPLICIT fences
-- (geofence_events.geofence_id IS NULL) and this table holds only the ones a fleet owner
-- draws by hand.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.geofences (
  id             uuid primary key default gen_random_uuid(),
  fleet_owner_id uuid         null references public.fleet_owners(id) on delete cascade,
  name           text        not null check (length(btrim(name)) between 1 and 120),
  kind           text        not null check (kind in ('depot','warehouse','checkpoint','custom')),
  lat            double precision not null check (lat between -90  and 90),
  lng            double precision not null check (lng between -180 and 180),
  -- 50 m floor: consumer GPS on a cheap Android is routinely 20-40 m off, so a tighter
  -- circle would flap enter/exit on a parked truck. 50 km ceiling stops a fat-fingered
  -- radius from swallowing a whole corridor and firing on every trip.
  radius_m       integer     not null check (radius_m between 50 and 50000),
  active         boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The evaluator's hot path: "which fences does this fleet have switched on?"
create index if not exists geofences_owner_active_idx
  on public.geofences (fleet_owner_id, active) where active;

comment on table public.geofences is
  'Fleet-defined circular geofences. Pickup/drop are implicit (derived from bookings), not rows here. WRITE owner = bt-tracking-service.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. geofence_events — the enter/exit log. This is the detention substrate.
--
-- dwell_seconds is written on the EXIT row (how long the truck sat inside), so an open
-- stay is an 'enter' row with no matching 'exit' — queryable without a state column.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.geofence_events (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid        not null references public.bookings(id)  on delete cascade,
  -- NULL = an implicit pickup/drop fence derived from the booking's own coordinates.
  geofence_id   uuid            null references public.geofences(id) on delete cascade,
  kind          text        not null check (kind in ('pickup','drop','depot','warehouse','checkpoint','custom')),
  name          text            null,
  event         text        not null check (event in ('enter','exit')),
  lat           double precision not null check (lat between -90  and 90),
  lng           double precision not null check (lng between -180 and 180),
  occurred_at   timestamptz not null,
  -- Set on 'exit' only: seconds between the matching 'enter' and this row.
  dwell_seconds integer         null check (dwell_seconds is null or dwell_seconds >= 0),
  driver_id     uuid            null,
  vehicle_id    uuid            null references public.vehicles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists geofence_events_booking_idx
  on public.geofence_events (booking_id, occurred_at desc);
create index if not exists geofence_events_fence_idx
  on public.geofence_events (geofence_id, occurred_at desc) where geofence_id is not null;

comment on table public.geofence_events is
  'Geofence enter/exit log. dwell_seconds is set on the exit row; an enter with no exit is an open stay. WRITE owner = bt-tracking-service evaluator.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. route_alerts — widen the pre-existing table (it predates the migrations directory)
--    and, critically, make it DEDUPED.
--
-- Without the partial unique index below, an evaluator running on every GPS fix would
-- insert one 'off_route' row every ~12 s for as long as the truck stays off route — tens
-- of thousands of rows and an unusable alert inbox. With it, an alert has a lifecycle:
-- at most ONE open row per (booking, type), which the evaluator closes by stamping
-- resolved_at when the condition clears. Re-entering the condition then opens a new row.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.route_alerts
  add column if not exists severity    text        not null default 'warning',
  add column if not exists resolved_at timestamptz     null,
  add column if not exists driver_id   uuid            null,
  add column if not exists vehicle_id  uuid            null,
  -- Per-type payload: off_route carries deviation_m, idle carries idle_seconds, speeding
  -- carries speed_kmh + limit_kmh. Typed columns would be mostly-null; the readers are
  -- display surfaces, not aggregates.
  add column if not exists meta        jsonb       not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'route_alerts_severity_check'
  ) then
    alter table public.route_alerts
      add constraint route_alerts_severity_check check (severity in ('info','warning','critical'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'route_alerts_type_check'
  ) then
    alter table public.route_alerts
      add constraint route_alerts_type_check
      check (type in ('off_route','idle','near_drop','speeding','night_driving','geofence_dwell','no_signal'));
  end if;
end $$;

-- The dedup rule. Partial: resolved rows are history and may repeat freely.
create unique index if not exists route_alerts_open_unique
  on public.route_alerts (booking_id, type) where resolved_at is null;

create index if not exists route_alerts_open_idx
  on public.route_alerts (booking_id, created_at desc) where resolved_at is null;

comment on column public.route_alerts.resolved_at is
  'NULL = still firing. Set by the evaluator when the condition clears; route_alerts_open_unique allows exactly one open row per (booking, type).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. trip_telemetry — the per-trip rollup, maintained incrementally.
--
-- One row per booking, updated on each breadcrumb. last_lat/last_lng/last_fix_at are held
-- HERE rather than in Redis on purpose: they are the left-hand side of every delta the
-- evaluator computes, so a Redis eviction would silently corrupt distance and idle time.
-- Postgres is the durable ledger; Redis stays a pure cache.
--
-- distance_m is the truck's ACTUALLY DRIVEN distance (sum of haversine deltas between
-- consecutive fixes), which is a different number from trip_routes.distance_m (the planned
-- road route). The gap between them is the deviation the fleet owner is billed for.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.trip_telemetry (
  booking_id       uuid primary key references public.bookings(id) on delete cascade,
  driver_id        uuid             null,
  vehicle_id       uuid             null references public.vehicles(id) on delete set null,

  point_count      integer      not null default 0 check (point_count >= 0),
  distance_m       double precision not null default 0 check (distance_m >= 0),
  moving_seconds   integer      not null default 0 check (moving_seconds >= 0),
  idle_seconds     integer      not null default 0 check (idle_seconds  >= 0),
  -- Night = 22:00-06:00 IST, the window in which Indian interstate accident rates spike
  -- and most cargo insurers price differently.
  night_seconds    integer      not null default 0 check (night_seconds >= 0),

  max_speed_kmh    double precision not null default 0 check (max_speed_kmh >= 0),
  -- Sum of (speed x seconds); avg speed is this / moving_seconds. Kept as a running total
  -- so the average stays exact under incremental update instead of drifting.
  speed_sum_kmh_s  double precision not null default 0 check (speed_sum_kmh_s >= 0),

  stop_count       integer      not null default 0 check (stop_count >= 0),
  speeding_count   integer      not null default 0 check (speeding_count >= 0),
  max_deviation_m  double precision not null default 0 check (max_deviation_m >= 0),

  first_fix_at     timestamptz      null,
  last_fix_at      timestamptz      null,
  last_lat         double precision null check (last_lat is null or last_lat between -90  and 90),
  last_lng         double precision null check (last_lng is null or last_lng between -180 and 180),
  -- Truthy while the truck is below the moving threshold; the evaluator uses it to decide
  -- when a pause has become a stop (and later, an idle alert).
  stopped_since    timestamptz      null,

  updated_at       timestamptz  not null default now()
);

create index if not exists trip_telemetry_vehicle_idx
  on public.trip_telemetry (vehicle_id, last_fix_at desc) where vehicle_id is not null;

comment on table public.trip_telemetry is
  'Per-trip rollup maintained incrementally by the bt-tracking-service evaluator. distance_m is DRIVEN distance (haversine over breadcrumbs), not the planned trip_routes.distance_m.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: every service reads and writes with the service-role key, which bypasses RLS.
-- Enabling it with no policy is therefore deny-by-default for anon/authenticated, which
-- is the posture the rest of the schema already has (BIBLE §5.6 item 1).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.geofences       enable row level security;
alter table public.geofence_events enable row level security;
alter table public.trip_telemetry  enable row level security;
