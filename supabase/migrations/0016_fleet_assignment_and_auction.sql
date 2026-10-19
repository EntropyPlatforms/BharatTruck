-- migration 016: let a fleet bid in the auction, and bind driver+truck to the trip.
--
-- FLOW (locked with the founder 2026-07-26):
--   1. Fleet owner bids on an auction        -> quotes.fleet_owner_id set, driver_id NULL
--   2. Shipper awards the quote              -> bookings.fleet_owner_id set, driver_id NULL
--   3. Owner assigns a driver AND a truck    -> vehicle_assignments row + bookings.driver_id/vehicle_id
--   4. Trip runs EXACTLY as the solo-driver flow does. No fork in the state machine.
-- A fleet may bid on unlimited auctions (Q9) and may bid with no free truck (Q10);
-- the assignment in step 3 is what gates 'accepted' -> 'in_transit'.

-- ---------------------------------------------------------------
-- (1) quotes — a bid may come from a solo driver OR a fleet owner.
-- Live column driver_id is NOT NULL; a fleet bid names no driver yet.
-- ---------------------------------------------------------------
alter table public.quotes
  add column if not exists fleet_owner_id uuid references public.fleet_owners(id) on delete cascade;

alter table public.quotes alter column driver_id drop not null;

alter table public.quotes drop constraint if exists quotes_exactly_one_bidder;
alter table public.quotes add constraint quotes_exactly_one_bidder
  check (num_nonnulls(driver_id, fleet_owner_id) = 1);

create index if not exists quotes_fleet_owner_idx on public.quotes (fleet_owner_id)
  where fleet_owner_id is not null;

-- One live bid per bidder per booking (a fleet bids once per load, not once per truck).
create unique index if not exists quotes_one_live_bid_per_fleet
  on public.quotes (booking_id, fleet_owner_id)
  where fleet_owner_id is not null and status in ('submitted','countered');

-- ---------------------------------------------------------------
-- (2) bookings — who won it, and which physical truck ran it.
-- bookings.driver_id already exists and stays THE driver of record for the trip,
-- so tracking / POD / location ingestion need no change at all.
-- ---------------------------------------------------------------
alter table public.bookings
  add column if not exists fleet_owner_id uuid references public.fleet_owners(id) on delete set null,
  add column if not exists vehicle_id     uuid references public.vehicles(id)     on delete set null;

create index if not exists bookings_fleet_owner_idx on public.bookings (fleet_owner_id)
  where fleet_owner_id is not null;
create index if not exists bookings_vehicle_idx on public.bookings (vehicle_id)
  where vehicle_id is not null;

-- ---------------------------------------------------------------
-- (3) vehicle_assignments — the per-trip driver<->truck pairing, and the
-- affiliated driver's entire truck history (they own no truck of their own).
-- ---------------------------------------------------------------
create table if not exists public.vehicle_assignments (
  id             uuid primary key default gen_random_uuid(),
  fleet_owner_id uuid not null references public.fleet_owners(id) on delete cascade,
  booking_id     uuid not null references public.bookings(id) on delete cascade,
  vehicle_id     uuid not null references public.vehicles(id)  on delete restrict,
  driver_id      uuid not null references public.drivers(id)   on delete restrict,
  assigned_by    uuid not null references public.users(id),
  assigned_at    timestamptz not null default now(),
  released_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- One live assignment per booking: no double-booking a load.
create unique index if not exists vehicle_assignments_one_live_per_booking
  on public.vehicle_assignments (booking_id) where released_at is null;
-- A truck runs one trip at a time; a driver drives one truck at a time.
create unique index if not exists vehicle_assignments_one_live_per_vehicle
  on public.vehicle_assignments (vehicle_id) where released_at is null;
create unique index if not exists vehicle_assignments_one_live_per_driver
  on public.vehicle_assignments (driver_id) where released_at is null;

create index if not exists vehicle_assignments_fleet_idx   on public.vehicle_assignments (fleet_owner_id, assigned_at desc);
create index if not exists vehicle_assignments_vehicle_idx on public.vehicle_assignments (vehicle_id, assigned_at desc);
create index if not exists vehicle_assignments_driver_idx  on public.vehicle_assignments (driver_id, assigned_at desc);

comment on table public.vehicle_assignments is
  'Per-trip driver<->truck pairing. For fleet drivers this IS their truck history; they own no vehicle.';

-- ---------------------------------------------------------------
-- (4) payouts — the money goes to WHOEVER MADE THE BID (Q15).
-- Live payouts.driver_id is already nullable, so no destructive change.
-- ---------------------------------------------------------------
alter table public.payouts
  add column if not exists fleet_owner_id uuid references public.fleet_owners(id) on delete set null,
  add column if not exists payee_type     text not null default 'driver'
    check (payee_type in ('driver','fleet_owner'));

alter table public.payouts drop constraint if exists payouts_payee_matches_type;
alter table public.payouts add constraint payouts_payee_matches_type check (
  (payee_type = 'driver'      and driver_id      is not null) or
  (payee_type = 'fleet_owner' and fleet_owner_id is not null)
);

create index if not exists payouts_fleet_owner_idx on public.payouts (fleet_owner_id)
  where fleet_owner_id is not null;

-- ---------------------------------------------------------------
-- (5) location_history + trips — attribute movement to the ASSET, not just the
-- person, so per-vehicle distance utilization is computable.
-- ---------------------------------------------------------------
alter table public.location_history
  add column if not exists vehicle_id uuid references public.vehicles(id) on delete set null;
alter table public.trips
  add column if not exists vehicle_id uuid references public.vehicles(id) on delete set null;

create index if not exists location_history_vehicle_idx on public.location_history (vehicle_id, recorded_at desc)
  where vehicle_id is not null;
create index if not exists trips_vehicle_idx on public.trips (vehicle_id) where vehicle_id is not null;

alter table public.vehicle_assignments enable row level security;
