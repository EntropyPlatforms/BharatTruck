-- 0041_booking_status_events.sql
--
-- History for booking status. bookings.updated_at is overwritten on every change, so until
-- now the platform could say what a trip IS but never WHEN it was accepted, started,
-- delivered or paid. This table is written by a TRIGGER, so every writer is recorded —
-- every service, an ops override, a database function — and no new code path can forget.
--
-- Forward-safe (additive): a new table, a new view, and a trigger whose only effect is an
-- INSERT into the new table. The trigger can never fail a booking write: an error inside it
-- is caught and raised as a WARNING, because recording history must not block the business
-- operation it describes.
--
-- Backfill: one row per existing booking for its CURRENT status, stamped with its last
-- update and flagged backfilled = true. Earlier milestones of old trips are unknowable and
-- stay null; history is exact from the day this is applied.
--
-- Readers: bt-booking-service (GET /me/summary, the alert sweep) via the
-- booking_milestones view. Both degrade to "no milestone" while this is unapplied.

create table if not exists public.booking_status_events (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  from_status public.booking_status,
  to_status   public.booking_status not null,
  changed_at  timestamptz not null default now(),
  backfilled  boolean not null default false
);

create index if not exists booking_status_events_booking_idx
  on public.booking_status_events (booking_id, changed_at);

-- Service-only, like every table here (supabase/migrations/README.md, "Why 0033 exists").
alter table public.booking_status_events enable row level security;

create or replace function public.record_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not null
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    begin
      insert into public.booking_status_events (booking_id, from_status, to_status)
      values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status);
    exception when others then
      -- Never fail the booking write over its history row.
      raise warning 'booking_status_events insert failed for booking %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

-- A trigger function is not an API. Same hygiene as 0027.
revoke all on function public.record_booking_status() from public, anon, authenticated;

drop trigger if exists trg_booking_status_events on public.bookings;
create trigger trg_booking_status_events
after insert or update of status on public.bookings
for each row execute function public.record_booking_status();

-- The milestone times per booking. security_invoker so the view can never widen access
-- beyond the table's own RLS, and no grants to the client roles.
create or replace view public.booking_milestones
with (security_invoker = true) as
select booking_id,
       min(changed_at) filter (where to_status = 'accepted')                          as accepted_at,
       min(changed_at) filter (where to_status = 'in_transit')                        as started_at,
       min(changed_at) filter (where to_status in ('delivery_asserted', 'completed')) as delivered_at,
       min(changed_at) filter (where to_status = 'paid')                              as paid_at,
       min(changed_at) filter (where to_status = 'cancelled')                         as cancelled_at,
       bool_or(backfilled)                                                            as has_backfill
from public.booking_status_events
group by booking_id;

revoke all on public.booking_milestones from anon, authenticated;

-- Backfill: the current status of every existing booking, once. Re-running is a no-op.
insert into public.booking_status_events (booking_id, from_status, to_status, changed_at, backfilled)
select b.id, null, b.status, coalesce(b.updated_at, b.created_at, now()), true
from public.bookings b
where b.status is not null
  and not exists (select 1 from public.booking_status_events e where e.booking_id = b.id);
