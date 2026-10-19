-- migration 018: vehicle cost norms — the reference data the per-asset P&L is built on.
--
-- SOURCE: founder-supplied CV parc workbook `CV_Parc_Tables.xlsx` (2026-07-26), sheets
--   'Parc FY25 Fuel & DEF'   -> kmpl + DEF-as-%-of-diesel, by emission norm
--   'Parc FY26 Engine Oil'   -> engine-oil change interval (km) + quantity (L)
--   'Parc FY26 Gear Oil'     -> gear-oil change interval (km) + quantity (L)
--   'Service Cost by Age'    -> total service cost per vehicle per YEAR, by age 1..10
-- These replace the ASSUMPTION constants in bt-pricing-service/src/lib/cto-cost.ts
-- (OPEX_PER_KM / MILEAGE_KMPL / HANDLING_BASE), which were flagged `ASSUMPTION (Q9)`
-- pending exactly this data. Passenger categories (buses, SCV Pass) and Tippers are
-- excluded: BharatTruck is interstate freight only.
--
-- Payload/volume typicals are cross-checked against live Indian market listings
-- (fr8.in truck-size table, read 2026-07-26): 32ft MXL 15-18t/~2048cuft,
-- 24ft container up to 14t/~1260cuft, 20ft container up to 10t/~1050cuft.

create table if not exists public.vehicle_cost_norms (
  model_category   text primary key,
  super_category   text not null,
  -- Legacy 4-way taxonomy used by bt-pricing-service so the two stay reconcilable.
  vehicle_class    text not null check (vehicle_class in ('SCV','LCV','MCV','HCV')),

  kms_per_year     int  not null check (kms_per_year > 0),
  payload_tons_typical numeric(6,2),
  volume_cuft_typical  numeric(8,2),

  kmpl_bs6         numeric(6,2) check (kmpl_bs6 is null or kmpl_bs6 > 0),
  kmpl_bs4         numeric(6,2) check (kmpl_bs4 is null or kmpl_bs4 > 0),
  def_pct_bs6      numeric(6,4) not null default 0,
  def_pct_bs4      numeric(6,4) not null default 0,

  eng_oil_km_bs6ph2 int, eng_oil_km_bs6 int, eng_oil_km_bs4 int, eng_oil_km_old int,
  eng_oil_l_bs6ph2  numeric(6,2), eng_oil_l_bs6 numeric(6,2), eng_oil_l_bs4 numeric(6,2), eng_oil_l_old numeric(6,2),

  gear_oil_km_bs6ph2 int, gear_oil_km_bs6 int, gear_oil_km_bs4 int, gear_oil_km_old int,
  gear_oil_l_bs6ph2  numeric(6,2), gear_oil_l_bs6 numeric(6,2), gear_oil_l_bs4 numeric(6,2), gear_oil_l_old numeric(6,2),

  -- Q18: driver wage is spread across trucks weighted BY VEHICLE TYPE. A 49T HCV
  -- carries more of the wage bill than an SCV for the same km.
  wage_weight      numeric(4,2) not null default 1.0 check (wage_weight > 0),
  -- Tyres are absent from the workbook; per-km placeholder, owner-overridable.
  tyre_cost_per_km numeric(8,4) not null default 0,

  source           text not null default 'CV_Parc_Tables.xlsx',
  created_at       timestamptz not null default now()
);

comment on table public.vehicle_cost_norms is
  'Per-model-category running-cost norms from the founder CV parc workbook. Reference data.';

insert into public.vehicle_cost_norms (
  model_category, super_category, vehicle_class, kms_per_year,
  payload_tons_typical, volume_cuft_typical,
  kmpl_bs6, kmpl_bs4, def_pct_bs6, def_pct_bs4,
  eng_oil_km_bs6ph2, eng_oil_km_bs6, eng_oil_km_bs4, eng_oil_km_old,
  eng_oil_l_bs6ph2,  eng_oil_l_bs6,  eng_oil_l_bs4,  eng_oil_l_old,
  gear_oil_km_bs6ph2, gear_oil_km_bs6, gear_oil_km_bs4, gear_oil_km_old,
  gear_oil_l_bs6ph2,  gear_oil_l_bs6,  gear_oil_l_bs4,  gear_oil_l_old,
  wage_weight, tyre_cost_per_km
) values
  ('SCV Cargo',            'SCV Cargo',  'SCV', 24000,  1.50,  300,  14.92, null,  0.0346, 0.0000,
    20000,  20000,  10000, 10000,  4.50,  4.50,  3.00,  2.20,
   120000, 120000,  80000, 40000,  2.40,  2.40,  1.30,  1.30,  1.00, 0.35),
  ('Pickups',              'PU',         'SCV', 30000,  1.00,  250,  14.92, null,  0.0346, 0.0000,
    20000,  20000,  10000, 10000,  7.50,  7.50,  6.54,  5.80,
    20000,  20000,  10000, 40000,  4.10,  4.10,  2.70,  1.80,  1.00, 0.30),
  ('LCV (4-7 T)',          'LCV Cargo',  'LCV', 40000,  6.00, 1050,   7.31, null,  0.0196, 0.0000,
   100000,  80000,  60000, 20000, 11.00, 11.00,  9.00,  7.00,
   120000, 120000,  80000, 60000,  6.30,  6.30,  5.70,  5.70,  1.20, 0.70),
  ('ICV Cargo (Upto 14T)', 'ICV Cargo',  'LCV', 56000, 14.00, 1260,   6.23, null,  0.0324, 0.0000,
   100000,  80000,  60000, 20000, 12.00, 12.00, 11.00,  9.80,
   160000, 160000, 120000,100000, 12.00, 12.00, 10.00,  9.65,  1.40, 1.00),
  ('MCV Cargo (15-19T)',   'MHCV Cargo', 'MCV', 66000, 17.00, 1500,   4.98, 5.00,  0.0508, 0.0197,
   120000,  80000,  60000, 40000, 22.50, 22.50, 20.00, 19.80,
   160000, 160000, 120000,100000,  9.60,  9.60,  7.80,  7.60,  1.60, 1.40),
  ('HCV Cargo 25-31T',     'MHCV Cargo', 'HCV', 72000, 28.00, 2048,   4.03, 4.13,  0.0464, 0.0315,
   120000, 120000,  80000, 40000, 24.50, 24.50, 21.50, 20.10,
   160000, 160000, 120000,100000,  9.75,  9.75,  7.80,  7.56,  2.00, 2.00),
  ('HCV Cargo 35-40T',     'MHCV Cargo', 'HCV', 72000, 37.00, 2048,   3.22, 3.54,  0.0526, 0.0319,
   120000, 120000,  80000, 40000, 25.00, 25.00, 22.00, 20.10,
   160000, 160000, 120000,100000, 11.20, 11.20, 10.00,  9.78,  2.00, 2.30),
  ('HCV Cargo 42-48T',     'MHCV Cargo', 'HCV', 72000, 45.00, 2048,   3.36, 2.90,  0.0545, 0.0320,
   120000, 120000,  80000, 40000, 25.00, 25.00, 22.00, 20.10,
   160000, 160000, 120000,100000, 13.20, 13.20, 11.50, 11.50,  2.00, 2.60),
  ('HCV Cargo 49-55T',     'MHCV Cargo', 'HCV', 72000, 52.00, 2048,   2.54, 2.60,  0.0556, 0.0337,
   120000, 120000,  80000, 40000, 25.00, 25.00, 22.00, 20.10,
   160000, 160000, 120000,100000, 13.20, 13.20, 11.50, 11.50,  2.00, 2.90)
on conflict (model_category) do nothing;

-- ---------------------------------------------------------------
-- Service cost per vehicle per YEAR, by age. Non-linear: it peaks around age 3 and
-- falls away as owners defer work on old trucks — so a flat per-km maintenance
-- number (what cto-cost.ts assumes today) is wrong at both ends of the curve.
-- ---------------------------------------------------------------
create table if not exists public.vehicle_service_cost_by_age (
  super_category text not null,
  age_years      int  not null check (age_years between 1 and 10),
  annual_cost_inr numeric(12,2) not null check (annual_cost_inr >= 0),
  source         text not null default 'CV_Parc_Tables.xlsx',
  primary key (super_category, age_years)
);

insert into public.vehicle_service_cost_by_age (super_category, age_years, annual_cost_inr) values
  ('MHCV Cargo',1,108313),('MHCV Cargo',2,186542),('MHCV Cargo',3,209098),('MHCV Cargo',4,195710),('MHCV Cargo',5,140402),
  ('MHCV Cargo',6,107454),('MHCV Cargo',7, 79837),('MHCV Cargo',8, 72365),('MHCV Cargo',9, 86298),('MHCV Cargo',10,60789),
  ('ICV Cargo', 1, 58330),('ICV Cargo', 2, 89101),('ICV Cargo', 3, 87613),('ICV Cargo', 4, 66368),('ICV Cargo', 5, 62049),
  ('ICV Cargo', 6, 43898),('ICV Cargo', 7, 33648),('ICV Cargo', 8, 32583),('ICV Cargo', 9, 32245),('ICV Cargo',10, 28532),
  ('LCV Cargo', 1, 31414),('LCV Cargo', 2, 41418),('LCV Cargo', 3, 38910),('LCV Cargo', 4, 32763),('LCV Cargo', 5, 31828),
  ('LCV Cargo', 6, 20882),('LCV Cargo', 7, 19099),('LCV Cargo', 8, 18985),('LCV Cargo', 9, 18569),('LCV Cargo',10, 16384),
  ('SCV Cargo', 1, 24376),('SCV Cargo', 2, 36998),('SCV Cargo', 3, 35193),('SCV Cargo', 4, 41608),('SCV Cargo', 5, 43066),
  ('SCV Cargo', 6, 32228),('SCV Cargo', 7, 21082),('SCV Cargo', 8, 21285),('SCV Cargo', 9, 27095),('SCV Cargo',10, 27376),
  ('PU',        1, 24376),('PU',        2, 36998),('PU',        3, 35193),('PU',        4, 41608),('PU',        5, 43066),
  ('PU',        6, 32228),('PU',        7, 21082),('PU',        8, 21285),('PU',        9, 27095),('PU',       10, 27376)
on conflict (super_category, age_years) do nothing;

-- ---------------------------------------------------------------
-- Consumable prices. One global row (fleet_owner_id NULL) + optional per-fleet override.
-- ---------------------------------------------------------------
create table if not exists public.fleet_cost_settings (
  id             uuid primary key default gen_random_uuid(),
  fleet_owner_id uuid unique references public.fleet_owners(id) on delete cascade,
  diesel_price_inr    numeric(8,2) not null default 90.00 check (diesel_price_inr > 0),
  def_price_inr       numeric(8,2) not null default 45.00 check (def_price_inr > 0),
  engine_oil_price_inr numeric(8,2) not null default 420.00 check (engine_oil_price_inr > 0),
  gear_oil_price_inr  numeric(8,2) not null default 390.00 check (gear_oil_price_inr > 0),
  updated_at     timestamptz not null default now()
);
-- Exactly one global default row.
create unique index if not exists fleet_cost_settings_one_global
  on public.fleet_cost_settings ((fleet_owner_id is null)) where fleet_owner_id is null;
insert into public.fleet_cost_settings (fleet_owner_id) values (null) on conflict do nothing;

alter table public.vehicle_cost_norms          enable row level security;
alter table public.vehicle_service_cost_by_age enable row level security;
alter table public.fleet_cost_settings         enable row level security;
