-- migration 020: let a fleet owner appear in the negotiation log.
--
-- THE BUG THIS FIXES: `negotiations.actor_role` carries a CHECK that predates the fleet
-- persona and allows only ('shipper','driver'). Migration 0016 made a fleet a first-class
-- BIDDER (quotes.fleet_owner_id), and bt-booking-service writes actor_role='fleet_owner'
-- for every fleet bid and counter — so every one of those inserts has been rejected by
-- this constraint since the fleet persona shipped.
--
-- The rejection was invisible. quote-service.ts recordNegotiation() deliberately catches
-- and logs it for the fleet branch only, because failing a real bid over an audit row
-- would be the worse trade — its comment says, verbatim, "widen the
-- negotiations.actor_role check". This is that widening.
--
-- Symptom in the product: a fleet's bid succeeds, but its price history is permanently
-- EMPTY. Verified 2026-07-31 against live — both of Shree Balaji Roadlines' quotes had
-- `neg_rows = 0`, so the console's Price history dialog could only ever say "No history
-- yet", no matter how many times a price was exchanged.
--
-- Forward-only and idempotent. Widening a CHECK cannot invalidate an existing row (every
-- stored value is still permitted), so no NOT VALID / re-validate dance is needed.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.negotiations'::regclass
      and conname  = 'negotiations_actor_role_check'
  ) then
    alter table public.negotiations drop constraint negotiations_actor_role_check;
  end if;

  alter table public.negotiations
    add constraint negotiations_actor_role_check
    check (actor_role in ('shipper', 'driver', 'fleet_owner'));
end $$;

comment on column public.negotiations.actor_role is
  'Who made this offer: shipper | driver | fleet_owner. fleet_owner added in migration 0020 — a fleet is a first-class bidder (quotes.fleet_owner_id, migration 0016) and its entries were being silently rejected before that.';
