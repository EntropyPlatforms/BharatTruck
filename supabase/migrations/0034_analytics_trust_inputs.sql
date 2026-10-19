-- migration 0034: analytics trust — honest inputs to the (already-sound) fleet P&L.
--
-- WHY THIS EXISTS
-- The economics/analytics engine (bt-fleet-service/src/lib/economics.ts + analytics.ts)
-- is mathematically sound, but three inputs feeding it were weak enough to make the
-- numbers untrustworthy, and the dashboard could not tell an owner which numbers to
-- trust. This migration is the schema half of the fix (the code half is in the same PR):
--
--   1. DISTANCE BASIS. The roll-up fell back to a straight-line haversine x 1.3 circuity
--      constant whenever a trip had no GPS trail and no price-lock, fabricating a distance
--      that then drove fuel/tyre/service/wage on that trip. We now prefer the REAL road
--      distance already cached by bt-tracking-service in trip_routes.distance_m, and record
--      WHICH basis fed each row so the UI can label it. `distance_km_planned` stores the
--      routed road distance; `distance_basis` records the basis actually used.
--
--   2. EXPENSE CATEGORY. trip_expenses.category is free text, and the pilferage/derate
--      signal (fuelComparison) depended on a substring match over it — i.e. on the driver's
--      spelling of "fuel"/"diesel". `category_code` is a controlled vocabulary constrained
--      at the write boundary; the classifier keys off it and falls back to the substring
--      match only for legacy rows where it is null.
--
--   3. DIESEL PRICE. A single national default (fleet_cost_settings, Rs.90) ignored the
--      Rs.8-10/L variation across states. `diesel_prices` is a per-state, effective-dated
--      reference table; the resolver prefers a fleet's explicit override, then the per-state
--      price, then the national default.
--
-- Forward-only and idempotent (IF EXISTS / IF NOT EXISTS). Baseline is regenerated from
-- production AFTER this is applied by hand (supabase/schema/README.md) — do not hand-edit it.

-- 1. ── distance basis on the per-trip roll-up ────────────────────────────────────────
-- Additive and nullable: existing rows keep their meaning, new roll-ups populate them.
alter table public.trip_economics
  add column if not exists distance_km_planned numeric(10,2);

alter table public.trip_economics
  add column if not exists distance_basis text
    check (distance_basis is null or distance_basis in ('measured', 'routed', 'estimated'));

comment on column public.trip_economics.distance_km_planned is
  'Real road distance from bt-tracking-service (trip_routes.distance_m / on-demand Routes call). NULL when tracking had no cached route and was unreachable at roll-up.';
comment on column public.trip_economics.distance_basis is
  'Which distance drove this row: measured = GPS breadcrumb trail (driven), routed = real road distance from tracking, estimated = the sold/price-lock distance (last resort). Replaces the dropped haversine x 1.3 fabrication.';

-- 2. ── controlled expense vocabulary ─────────────────────────────────────────────────
-- Nullable so legacy free-text rows are untouched; the CHECK constrains every NEW write
-- to the canonical set. bt-fleet-service/src/lib/expense-categories.ts is the source of
-- truth for this list and must stay in sync with the CHECK below.
alter table public.trip_expenses
  add column if not exists category_code text
    check (
      category_code is null or category_code in (
        'fuel', 'def', 'toll', 'tyre', 'repair', 'parking',
        'weighbridge', 'fine', 'loading_unloading', 'driver_allowance', 'permit', 'other'
      )
    );

comment on column public.trip_expenses.category_code is
  'Controlled expense category (source of truth: bt-fleet-service/src/lib/expense-categories.ts). Free-text `category` is kept for display and legacy rows; the pilferage classifier keys off category_code when present.';

-- 3. ── per-state diesel price reference ───────────────────────────────────────────────
-- Keyed by the GST 2-digit state code, to line up with the rest of the system
-- (freight_invoices.*_state_code, documents/rules.ts stateCodeOfGstin). Effective-dated so
-- "what was the price on the date of that trip" stays answerable; the resolver takes the
-- newest row with effective_from <= the trip date.
create table if not exists public.diesel_prices (
  state_code     text        not null check (state_code ~ '^[0-9]{2}$'),
  state_name     text        not null,
  price_inr      numeric(8,2) not null check (price_inr > 0),
  effective_from date        not null default current_date,
  source         text        not null default 'seed_2026_approx',
  note           text,
  created_at     timestamptz not null default now(),
  primary key (state_code, effective_from)
);

comment on table public.diesel_prices is
  'Per-state, effective-dated retail diesel price reference (GST state code). Seed values are approximate and owner/ops-refreshable — the point is the state VARIATION, not a live feed.';

-- RLS: service-only, deny-all for anon/authenticated (every bt-* service uses service_role,
-- which bypasses RLS). Same posture as every other reference table here; this is the rule
-- migration 0033 exists to enforce.
alter table public.diesel_prices enable row level security;

-- Seed — approximate late-2026 retail diesel by state. Deliberately flagged approximate:
-- these are placeholders to be refreshed, exactly like the tyre_cost_per_km placeholder in
-- 0018. Where a trip's state is unpriced or unresolved, the resolver falls back to the
-- national default in fleet_cost_settings (Rs.90), so a missing state is never fatal.
insert into public.diesel_prices (state_code, state_name, price_inr, note) values
  ('07', 'Delhi',            87.67, 'seed — refresh from a live source'),
  ('27', 'Maharashtra',      92.15, 'seed — refresh from a live source'),
  ('29', 'Karnataka',        91.02, 'seed — refresh from a live source'),
  ('33', 'Tamil Nadu',       92.43, 'seed — refresh from a live source'),
  ('32', 'Kerala',           95.20, 'seed — refresh from a live source'),
  ('24', 'Gujarat',          90.42, 'seed — refresh from a live source'),
  ('09', 'Uttar Pradesh',    89.76, 'seed — refresh from a live source'),
  ('08', 'Rajasthan',        90.70, 'seed — refresh from a live source'),
  ('36', 'Telangana',        95.65, 'seed — refresh from a live source'),
  ('37', 'Andhra Pradesh',   97.00, 'seed — refresh from a live source'),
  ('28', 'Andhra Pradesh',   97.00, 'seed — legacy pre-2014 AP GST code; refresh from a live source'),
  ('19', 'West Bengal',      92.76, 'seed — refresh from a live source'),
  ('23', 'Madhya Pradesh',   89.00, 'seed — refresh from a live source'),
  ('03', 'Punjab',           88.20, 'seed — refresh from a live source'),
  ('06', 'Haryana',          87.50, 'seed — refresh from a live source'),
  ('10', 'Bihar',            91.90, 'seed — refresh from a live source'),
  ('21', 'Odisha',           92.50, 'seed — refresh from a live source'),
  ('22', 'Chhattisgarh',     92.60, 'seed — refresh from a live source'),
  ('20', 'Jharkhand',        91.50, 'seed — refresh from a live source'),
  ('18', 'Assam',            89.60, 'seed — refresh from a live source'),
  ('02', 'Himachal Pradesh', 87.00, 'seed — refresh from a live source'),
  ('05', 'Uttarakhand',      89.90, 'seed — refresh from a live source'),
  ('04', 'Chandigarh',       88.10, 'seed — refresh from a live source'),
  ('30', 'Goa',              88.50, 'seed — refresh from a live source')
on conflict (state_code, effective_from) do nothing;
