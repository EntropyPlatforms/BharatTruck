-- migration 015: the fleet-owner persona core — owner party, driver affiliation,
-- and the vehicle-ownership pivot.
--
-- LIVE-SCHEMA BASELINE (introspected from rxbdzbcndpzznvqcbimg on 2026-07-26; these
-- files are NOT the source of truth for what exists — the live DB is):
--   users.role enum      = ('shipper','driver','admin') + 'fleet_owner' from mig 014
--   vehicles.driver_id   = uuid NOT NULL references drivers(id)   <-- pivoted below
--   quotes.driver_id     = uuid NOT NULL references drivers(id)   <-- pivoted in 016
--   bookings             = no vehicle_id, no fleet_owner_id       <-- added in 016
--
-- MODEL (locked with the founder 2026-07-26):
--   * A fleet owner NEVER drives. A driver drives exactly one truck per trip.
--   * Solo drivers stay hardcoded to their own truck (vehicles.driver_id) — untouched.
--   * Fleet drivers own NO truck. The truck they ran is recorded per-ORDER
--     (vehicle_assignments + bookings.vehicle_id), which is their whole truck history.
--   * The owner invites an EXISTING driver account; the driver accepts. We never
--     create driver identities on the owner's behalf.

-- ---------------------------------------------------------------
-- (1) fleet_owners — the owning party. One row per fleet_owner user.
-- ---------------------------------------------------------------
create table if not exists public.fleet_owners (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references public.users(id) on delete cascade,
  company_name  text not null,
  gstin         text,
  pan           text,
  contact_phone text,
  billing_address text,
  city          text,
  state         text,
  -- Monthly fixed overhead not attributable to any one truck (office, staff,
  -- parking). Spread across active vehicles in the P&L roll-up.
  monthly_overhead_inr numeric(12,2) not null default 0 check (monthly_overhead_inr >= 0),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.fleet_owners is
  'Fleet-owner party. Owns vehicles + employs drivers; never drives, never owns a drivers row.';

-- ---------------------------------------------------------------
-- (2) fleet_drivers — affiliation between a fleet and an EXISTING driver.
-- The owner sends the request (status=pending); the driver accepts/rejects.
-- ---------------------------------------------------------------
create table if not exists public.fleet_drivers (
  id              uuid primary key default gen_random_uuid(),
  fleet_owner_id  uuid not null references public.fleet_owners(id) on delete cascade,
  driver_id       uuid not null references public.drivers(id) on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending','active','rejected','suspended','left')),
  -- Q17: monthly salary only. Fixed cost allocated across the trucks this driver ran.
  monthly_salary_inr numeric(12,2) check (monthly_salary_inr >= 0),
  invited_by      uuid references public.users(id),
  invited_at      timestamptz not null default now(),
  responded_at    timestamptz,
  left_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A driver may hold at most ONE live affiliation (pending or active) at a time, but
-- may accumulate any number of historical (rejected/left/suspended) rows. This is what
-- makes "is this driver fleet-controlled?" a single unambiguous lookup.
create unique index if not exists fleet_drivers_one_live_per_driver
  on public.fleet_drivers (driver_id) where status in ('pending','active');
create index if not exists fleet_drivers_owner_idx  on public.fleet_drivers (fleet_owner_id, status);
create index if not exists fleet_drivers_driver_idx on public.fleet_drivers (driver_id, status);

comment on table public.fleet_drivers is
  'Fleet <-> existing-driver affiliation. Owner invites (pending), driver accepts (active).';

-- ---------------------------------------------------------------
-- (3) vehicles ownership pivot — a truck is owned by EITHER a solo driver OR a fleet.
-- ---------------------------------------------------------------
alter table public.vehicles
  add column if not exists fleet_owner_id uuid references public.fleet_owners(id) on delete restrict;

-- Live column is NOT NULL; fleet-owned trucks have no owning driver.
alter table public.vehicles alter column driver_id drop not null;

-- Exactly one owner. Existing rows all have driver_id set, so this validates as-is.
alter table public.vehicles drop constraint if exists vehicles_exactly_one_owner;
alter table public.vehicles add constraint vehicles_exactly_one_owner
  check (num_nonnulls(driver_id, fleet_owner_id) = 1);

-- The pricing/cost taxonomy the truck belongs to. NULL on legacy rows; the fleet
-- service requires it on create so per-asset economics are always computable.
-- Values match vehicle_cost_norms.model_category (migration 017).
alter table public.vehicles add column if not exists model_category text;
alter table public.vehicles add column if not exists emission_norm  text
  check (emission_norm is null or emission_norm in ('BS4','BS6','BS6_PH2'));
-- Age drives the service-cost curve (xlsx 'Service Cost by Age'), so we need the year.
alter table public.vehicles add column if not exists manufacture_year int
  check (manufacture_year is null or manufacture_year between 1990 and 2100);
alter table public.vehicles add column if not exists volume_cuft numeric(10,2)
  check (volume_cuft is null or volume_cuft > 0);
alter table public.vehicles add column if not exists current_odometer_km int
  check (current_odometer_km is null or current_odometer_km >= 0);

create index if not exists vehicles_fleet_owner_idx on public.vehicles (fleet_owner_id)
  where fleet_owner_id is not null;

-- ---------------------------------------------------------------
-- RLS: service-role only, consistent with payments/payouts (migration 011).
-- Tenant isolation is enforced in bt-fleet-service, not by RLS, because every
-- service connects with the service-role key.
-- ---------------------------------------------------------------
alter table public.fleet_owners  enable row level security;
alter table public.fleet_drivers enable row level security;
