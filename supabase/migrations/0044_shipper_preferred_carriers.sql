-- 0044_shipper_preferred_carriers.sql
--
-- A shipper's hand-picked carriers. "Preferred" on the Post-a-Load picker and on bid cards
-- has TWO sources, and only one of them needs storage:
--
--   * automatic — every driver / fleet that has finished a trip (status completed or paid)
--     for this shipper. That is DERIVED from bookings on every read and never stored here,
--     so it can never drift from the trips themselves.
--   * starred   — the shipper explicitly marked a carrier Preferred (or one they have not
--     worked with yet, e.g. a transporter they already use off-platform). That intent
--     exists nowhere else, so it gets this one small table.
--
-- carrier_id is drivers.id when carrier_kind = 'driver' and fleet_owners.id when
-- carrier_kind = 'fleet_owner' — the same two ids quotes and bookings already carry.
-- It has no FK because it points at one of two tables; bt-booking-service checks the
-- carrier exists before starring and drops stars whose carrier is gone when it reads.
-- shipper_id is users.id (the account that posts loads), cascading with the account.
--
-- Numbered 0044, not 0043: 0043 is taken by the unmerged feat/whatsapp-bot branch.
--
-- Additive and forward-safe: a new table nothing else depends on. bt-booking-service reads
-- a missing table as "no stars" (the automatic list still works) and refuses star/unstar
-- with a clear 503 until this is applied. Service-only (RLS on, no policies) like every
-- table here — see supabase/migrations/README.md, "Why 0033 exists".

create table if not exists public.shipper_preferred_carriers (
  id           uuid primary key default gen_random_uuid(),
  shipper_id   uuid not null references public.users(id) on delete cascade,
  carrier_kind text not null check (carrier_kind in ('driver', 'fleet_owner')),
  carrier_id   uuid not null,
  created_at   timestamptz not null default now(),
  constraint shipper_preferred_carriers_uniq unique (shipper_id, carrier_kind, carrier_id)
);

-- The unique constraint's index leads with shipper_id, so it already serves the only read
-- ("this shipper's stars"); no second index.

alter table public.shipper_preferred_carriers enable row level security;

comment on table public.shipper_preferred_carriers is
  'Carriers a shipper starred as Preferred. Automatic preference (past completed trips) is derived from bookings, not stored here.';
