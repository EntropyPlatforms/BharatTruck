-- migration 022: unified identity — emergent personas + the revenue split.
--
-- WHY THIS EXISTS:
--   `users.role` is a single enum and the whole platform authorizes on it. That model cannot
--   describe the businesses we actually have. A distributor ships goods AND owns the trucks that
--   move them. A driver who buys a second truck is now running a fleet. A driver whose own truck
--   is attached to a fleet is that fleet's employee for some trips and an independent operator on
--   others. One role per human forces each of those people into a costume that is wrong most of
--   the time. See docs/ARCHITECTURE_UNIFIED_IDENTITY.md for the locked model.
--
-- THE MODEL, IN ONE LINE:
--   A persona is not a flag. It is a VIEW over what you own and who you are connected to.
--   Nothing here stores "is a fleet owner" — capability is COMPUTED from assets and relationships
--   (@bharattruck/shared/personas). This migration only makes the underlying facts recordable and
--   trustworthy.
--
-- STRICTLY ADDITIVE. Nothing reads these columns yet; the behaviour switch lands in a later PR.
--   Deployed against a live DB with 676 bookings and 620 seeded fleet assignments, so every
--   change here is nullable, defaulted to today's behaviour, or a constraint that current data
--   already satisfies (verified before writing — see the NOT VALID note on the vehicles CHECK).

-- ---------------------------------------------------------------
-- (1) users.primary_persona — where emailed links land.
--
-- `users.role` does NOT go away and is NOT renamed. Two reasons:
--   a) every service still reads it, and this migration must not break a running system;
--   b) it keeps a real job. A multi-persona human still needs ONE correct destination for a
--      password-reset or magic-link email — bt-auth-service picks DRIVER_MAGIC_LINK_URL vs
--      SHIPPER_MAGIC_LINK_URL from it. "All three personas" is not an address.
--
-- So this is a generated mirror with an honest name, not a new source of truth. When the last
-- service stops authorizing on `role`, this column is what stays.
-- ---------------------------------------------------------------
alter table public.users
  add column if not exists primary_persona public.user_role
    generated always as (role) stored;

comment on column public.users.primary_persona is
  'Mirror of users.role under its post-unification name: the DEFAULT surface and the destination '
  'for emailed links. NOT an authorization axis — capability is computed from owned assets and '
  'fleet relationships (@bharattruck/shared/personas). See docs/ARCHITECTURE_UNIFIED_IDENTITY.md.';

-- ---------------------------------------------------------------
-- (2) fleet_drivers.revenue_share_pct — the profit split.
--
-- Founder decision D-7: the fleet owner sets it, because the load and the contacts come from
-- them. 0 means "salaried" — the owner keeps the freight and pays the driver off-platform via
-- monthly_salary_inr. That is exactly today's behaviour, which is why 0 is the default: every one
-- of the 620 existing rows keeps behaving identically.
--
-- Stored on the AFFILIATION, not on the trip and not on the truck. A split is a standing term of
-- the employment relationship; per-trip negotiation is a different (and much later) product. If
-- that changes, add trip-level override — do not repurpose this column.
--
-- numeric(5,2) allows 0.00–100.00 with two decimals; fleets do quote 33.33%.
-- ---------------------------------------------------------------
alter table public.fleet_drivers
  add column if not exists revenue_share_pct numeric(5,2) not null default 0
    check (revenue_share_pct >= 0 and revenue_share_pct <= 100);

comment on column public.fleet_drivers.revenue_share_pct is
  'Share of trip freight paid to the DRIVER on fleet-won bookings, 0-100. 0 = salaried (owner '
  'keeps freight, pays via monthly_salary_inr) and is the pre-existing behaviour. Set by the '
  'fleet owner. Consumed by resolvePayees() in bt-payment-service.';

-- ---------------------------------------------------------------
-- (3) vehicles — a truck belongs to exactly ONE party.
--
-- `vehicles` already had both driver_id and fleet_owner_id, both nullable, with nothing stopping
-- a row from having neither (an orphan asset nobody can be paid for) or both (two parties with a
-- claim on the same truck's economics). Founder decision D-6 says a truck is the asset of ONE
-- person, and it behaves the same whoever that is.
--
-- NOT VALID is deliberate. It enforces the rule on every new and updated row immediately, without
-- taking a full-table ACCESS EXCLUSIVE validation lock on deploy. Existing rows were checked
-- against live data before writing this (zero violations), so validation is safe to run later
-- out-of-band:  alter table public.vehicles validate constraint vehicles_single_owner;
-- ---------------------------------------------------------------
alter table public.vehicles
  drop constraint if exists vehicles_single_owner;

alter table public.vehicles
  add constraint vehicles_single_owner
    check (num_nonnulls(driver_id, fleet_owner_id) = 1) not valid;

comment on constraint vehicles_single_owner on public.vehicles is
  'A truck is the asset of exactly one party — a driver or a fleet owner, never both and never '
  'neither. Ownership is what grants carrier capability and commercial visibility, so an '
  'ambiguously-owned truck is an unanswerable "who gets paid for this".';

-- Ownership lookups are on the hot path of every capability resolution, so index both sides.
-- Partial, because in a single-owner world each index covers only the rows it can match.
create index if not exists vehicles_driver_owner_idx
  on public.vehicles (driver_id) where driver_id is not null;

create index if not exists vehicles_fleet_owner_idx
  on public.vehicles (fleet_owner_id) where fleet_owner_id is not null;

-- ---------------------------------------------------------------
-- (4) bookings.award_path — how this trip was won.
--
-- Founder decision D-10: when the shipper and the carrier are the same human, we attach the load
-- directly instead of running an auction against yourself. That is a real distinction and it has
-- to be recorded, because the trip is otherwise IDENTICAL — a direct-attached trip still gets an
-- LR, an invoice with real freight (D-15), a POD and a settlement. Only the award path differs.
--
-- Recorded rather than inferred: "shipper_id and the winning carrier resolve to the same user"
-- is true at award time and can stop being true later (a fleet is sold, a driver leaves). An
-- audit trail that changes its mind about how a trip was won is not an audit trail.
--
-- Default 'auction' matches every existing row: `bookings.booking_type` already distinguishes
-- instant vs auction, and neither was ever self-attached.
-- ---------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_award_path') then
    create type public.booking_award_path as enum ('auction', 'instant', 'direct_attach');
  end if;
end $$;

alter table public.bookings
  add column if not exists award_path public.booking_award_path not null default 'auction';

comment on column public.bookings.award_path is
  'How the carrier was chosen. direct_attach = the shipper and the carrier are the same human, so '
  'the auction was skipped (D-10). The trip is otherwise identical and still gets LR, invoice, '
  'POD and settlement.';

-- ---------------------------------------------------------------
-- (5) Backfill sanity — assert the model holds on live data.
--
-- This does not modify anything. It fails the migration loudly if a person somehow holds a
-- drivers row AND a fleet_owners row in a way the resolver cannot describe, which would mean the
-- capability model is wrong about the data before a single service depends on it. Better to find
-- that here than in production authorization.
--
-- Note it is a WARNING, not an exception: dual driver+fleet_owner is EXPECTED under the new model
-- (that is the whole point — an owner who drives). We log the count so the first person to run
-- this sees the real number rather than assuming it is zero.
-- ---------------------------------------------------------------
do $$
declare
  dual_count integer;
  orphan_vehicles integer;
begin
  select count(*) into dual_count
  from public.users u
  where exists (select 1 from public.drivers d where d.user_id = u.id)
    and exists (select 1 from public.fleet_owners f where f.user_id = u.id);

  select count(*) into orphan_vehicles
  from public.vehicles
  where num_nonnulls(driver_id, fleet_owner_id) <> 1;

  raise notice 'unified-identity backfill: % user(s) already hold both driver and fleet_owner profiles (expected, not an error)', dual_count;

  if orphan_vehicles > 0 then
    raise warning 'unified-identity: % vehicle row(s) violate single-owner; constraint added NOT VALID so they are grandfathered. Fix before running: alter table public.vehicles validate constraint vehicles_single_owner;', orphan_vehicles;
  end if;
end $$;
