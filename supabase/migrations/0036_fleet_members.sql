-- migration 0036: delegated fleet-staff access — the `fleet_members` grant table.
--
-- WHY THIS EXISTS
-- ARCHITECTURE_UNIFIED_IDENTITY.md D-1 locked "one account = one human, no staff logins",
-- and §7 named the exact deferred case: "a distributor with dispatch clerks cannot delegate".
-- This is that seam, opened. It does NOT reintroduce a `role` column — the platform's rule is
-- "permissions come from facts, not labels" — so a person's authority over a fleet they do not
-- own is itself a FACT stored here: a row granting specific ACTIONS on a specific fleet.
--
-- The grant is the same shape as fleet_drivers (a person <-> fleet relationship), but keyed on
-- users.id (the grantee human) rather than drivers.id, and carrying a list of action grants
-- instead of a salary. fleet_owners.user_id stays UNIQUE (one owner per fleet) — delegation
-- lives here, never by relaxing ownership.
--
-- Grants are ACTIONS, never job titles:
--   dispatch        — assign trucks/drivers to bookings
--   bid             — bid in auctions on the fleet's behalf
--   settle          — record a payment/settlement (NEVER see bank details — those are the
--                     owner's personal bank_accounts, unreachable by any fleet route)
--   documents       — issue the fleet's LR / freight documents
--   manage_drivers  — invite / edit / remove the fleet's drivers
--   manage_assets   — add / edit the fleet's vehicles and their finance/permits/lanes
--   view_analytics  — see the fleet's money: P&L, fuel, surplus (THIS is the money-visibility gate)
--   admin           — all of the above
--
-- Money/bank/KYC stay with the owner: analytics is gated by view_analytics (per fleet), and the
-- owner's bank details + GSTIN/KYC live on their own user/profile with no fleet-scoped read path.
--
-- For the pilot there is no management UI — ops set grants directly in this table (~20 users).
-- Grants are looked up PER REQUEST (never baked into the JWT), so revoking a member takes effect
-- on their next call. Forward-only, idempotent; baseline regenerated from prod after apply.

create table if not exists public.fleet_members (
  id             uuid        default gen_random_uuid() not null primary key,
  fleet_owner_id uuid        not null references public.fleet_owners(id) on delete cascade,
  -- The grantee human. users.id, NOT drivers.id — a dispatch clerk need not be a driver.
  user_id        uuid        not null references public.users(id) on delete cascade,
  -- Action grants. Constrained to the known set by array-containment so an unknown grant can
  -- never be stored (keep in sync with FleetGrant in bt-fleet-service/src/lib/fleet-access.ts
  -- and @bharattruck/shared/src/fleet.ts).
  grants         text[]      not null default '{}'
                   check (grants <@ array[
                     'dispatch','bid','settle','documents',
                     'manage_drivers','manage_assets','view_analytics','admin'
                   ]::text[]),
  -- Looked up per request; only 'active' grants access, so flipping to suspended/revoked cuts a
  -- member off immediately.
  status         text        not null default 'active'
                   check (status in ('active','suspended','revoked')),
  invited_by     uuid        references public.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One membership row per (fleet, person). Re-granting updates this row rather than adding a
  -- second — the per-request resolver expects at most one row per (user, fleet).
  unique (fleet_owner_id, user_id)
);

comment on table public.fleet_members is
  'Delegated fleet-staff access (D-1/§7 seam). A users.id granted specific ACTION grants on a fleet_owners.id — never a role. Owner authority stays via fleet_owners.user_id; this is for non-owner delegates. Grants looked up per request.';

-- The per-request hot path is "what may this user do, and on which fleets?" -> by user_id.
create index if not exists fleet_members_user_idx on public.fleet_members (user_id, status);
-- "who are this fleet's staff?" -> by fleet_owner_id.
create index if not exists fleet_members_fleet_idx on public.fleet_members (fleet_owner_id, status);

-- Service-only, deny-all for anon/authenticated; service_role bypasses. The rule 0033 enforces.
alter table public.fleet_members enable row level security;

-- ── Audit: which fleet an actor was acting FOR ────────────────────────────────────────
-- ops_overrides records actor_user_id (who) but not the fleet they acted on behalf of, so a
-- delegated action could not be traced to a fleet. Additive + nullable: rows predating this,
-- and ops actions with no fleet context, carry null. (Truck assignment itself is already
-- traceable via vehicle_assignments.assigned_by + fleet_owner_id.)
alter table public.ops_overrides
  add column if not exists acted_for_fleet_owner_id uuid references public.fleet_owners(id);

comment on column public.ops_overrides.acted_for_fleet_owner_id is
  'The fleet this override was performed on behalf of (D-1/§7 delegation audit). NULL on rows predating migration 0036 or actions with no fleet context.';
