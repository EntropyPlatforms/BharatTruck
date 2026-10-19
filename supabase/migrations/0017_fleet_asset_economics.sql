-- migration 017: per-asset economics — finance (EMI), permits/corridor, actual
-- expenses, and the trip_economics roll-up that every fleet dashboard reads.
--
-- WHY A ROLL-UP TABLE: the fleet dashboard serves 100-1000 vehicles over arbitrary
-- date ranges. Aggregating bookings x payouts x trip_expenses x location_history at
-- request time does not survive that. trip_economics is written ONCE when a booking
-- reaches 'paid' and is the only table the analytics endpoints read.

-- ---------------------------------------------------------------
-- (1) vehicle_finance — the loan/EMI the owner enters per truck (Q19).
-- The whole point of the feature: "has this asset cleared its own EMI?"
-- ---------------------------------------------------------------
create table if not exists public.vehicle_finance (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null unique references public.vehicles(id) on delete cascade,
  lender          text,
  loan_account_no text,
  principal_inr   numeric(12,2) check (principal_inr is null or principal_inr > 0),
  emi_amount_inr  numeric(12,2) not null check (emi_amount_inr >= 0),
  emi_day_of_month int check (emi_day_of_month between 1 and 31),
  tenure_months   int check (tenure_months is null or tenure_months > 0),
  interest_rate_pct numeric(5,2),
  start_date      date,
  end_date        date,
  outstanding_inr numeric(12,2) check (outstanding_inr is null or outstanding_inr >= 0),
  -- Other fixed monthly carrying costs the owner keys in once.
  insurance_annual_inr numeric(12,2) not null default 0 check (insurance_annual_inr >= 0),
  permit_annual_inr    numeric(12,2) not null default 0 check (permit_annual_inr >= 0),
  fitness_annual_inr   numeric(12,2) not null default 0 check (fitness_annual_inr >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.vehicle_finance is
  'Owner-entered EMI + fixed annual carrying costs per truck. Drives the "cleared its EMI?" score.';

-- ---------------------------------------------------------------
-- (2) vehicle_permits — which states the truck is legally allowed into.
-- Permits are why a truck mostly lives on one corridor; the corridor is a
-- CONSEQUENCE, not a hardcoded route, so we store the permit and the observed lane.
-- ---------------------------------------------------------------
create table if not exists public.vehicle_permits (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  permit_type  text not null default 'national'
                 check (permit_type in ('national','state','contract_carriage','goods')),
  -- ISO-ish state codes (e.g. 'MH','KA','TN'). Empty for a national permit.
  allowed_states text[] not null default '{}',
  permit_number text,
  issued_on    date,
  expiry_date  date,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists vehicle_permits_vehicle_idx on public.vehicle_permits (vehicle_id) where is_active;

-- The corridor the truck actually runs. Changeable — not hardcoded — and defaulted
-- from observed trips. Mirrors the existing driver-side `saved_lanes` concept.
create table if not exists public.vehicle_lanes (
  id             uuid primary key default gen_random_uuid(),
  vehicle_id     uuid not null references public.vehicles(id) on delete cascade,
  origin_city    text not null,
  destination_city text not null,
  origin_lat     numeric, origin_lng numeric,
  dest_lat       numeric, dest_lng   numeric,
  typical_distance_km numeric(10,2) check (typical_distance_km is null or typical_distance_km > 0),
  is_primary     boolean not null default false,
  trips_observed int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists vehicle_lanes_one_primary
  on public.vehicle_lanes (vehicle_id) where is_primary;
create index if not exists vehicle_lanes_vehicle_idx on public.vehicle_lanes (vehicle_id);

-- ---------------------------------------------------------------
-- (3) trip_expenses — extend the EXISTING live table for driver-side fuel entry (Q21).
-- Live shape: (id, driver_id NOT NULL, trip_id, category, amount, description,
-- receipt_path, expense_date, created_at). We add the asset + fuel-specific fields.
-- ---------------------------------------------------------------
alter table public.trip_expenses
  add column if not exists vehicle_id  uuid references public.vehicles(id) on delete set null,
  add column if not exists booking_id  uuid references public.bookings(id) on delete set null,
  add column if not exists litres      numeric(8,2) check (litres is null or litres > 0),
  add column if not exists odometer_km int          check (odometer_km is null or odometer_km >= 0),
  add column if not exists rate_per_litre numeric(8,2),
  add column if not exists verified_by uuid references public.users(id),
  add column if not exists verified_at timestamptz;

create index if not exists trip_expenses_vehicle_idx on public.trip_expenses (vehicle_id, expense_date desc)
  where vehicle_id is not null;
create index if not exists trip_expenses_booking_idx on public.trip_expenses (booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------
-- (4) trip_economics — the per-trip P&L roll-up. One row per booking, written once.
-- ---------------------------------------------------------------
create table if not exists public.trip_economics (
  booking_id     uuid primary key references public.bookings(id) on delete cascade,
  fleet_owner_id uuid references public.fleet_owners(id) on delete cascade,
  vehicle_id     uuid references public.vehicles(id) on delete set null,
  driver_id      uuid references public.drivers(id)  on delete set null,

  revenue_inr        numeric(12,2) not null default 0,

  -- Modelled costs (from vehicle_cost_norms + the truck's age/emission norm).
  fuel_cost_est_inr     numeric(12,2) not null default 0,
  def_cost_est_inr      numeric(12,2) not null default 0,
  engine_oil_cost_inr   numeric(12,2) not null default 0,
  gear_oil_cost_inr     numeric(12,2) not null default 0,
  service_cost_inr      numeric(12,2) not null default 0,
  tyre_cost_inr         numeric(12,2) not null default 0,
  driver_wage_alloc_inr numeric(12,2) not null default 0,

  -- Actuals (from trip_expenses). NULL until the driver/owner records them.
  fuel_cost_actual_inr numeric(12,2),
  toll_cost_inr        numeric(12,2) not null default 0,
  other_cost_inr       numeric(12,2) not null default 0,

  running_cost_inr numeric(12,2) not null default 0,
  net_profit_inr   numeric(12,2) not null default 0,

  distance_km_quoted numeric(10,2),
  distance_km_actual numeric(10,2),
  laden_weight_kg    numeric(10,2),
  capacity_kg        numeric(10,2),
  volume_used_cuft   numeric(10,2),
  capacity_cuft      numeric(10,2),

  started_at   timestamptz,
  completed_at timestamptz,
  model_version text not null default 'fleet-pnl-v1',
  computed_at  timestamptz not null default now()
);

create index if not exists trip_economics_fleet_idx   on public.trip_economics (fleet_owner_id, completed_at desc);
create index if not exists trip_economics_vehicle_idx on public.trip_economics (vehicle_id, completed_at desc);
create index if not exists trip_economics_driver_idx  on public.trip_economics (driver_id, completed_at desc);

comment on table public.trip_economics is
  'Per-trip P&L roll-up, written once at completed->paid. The ONLY table fleet analytics reads.';

alter table public.vehicle_finance     enable row level security;
alter table public.vehicle_permits     enable row level security;
alter table public.vehicle_lanes       enable row level security;
alter table public.trip_economics      enable row level security;
