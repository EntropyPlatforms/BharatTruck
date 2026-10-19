-- migration 023: move the payout idempotency anchor from the BOOKING to the (booking, payee).
--
-- WHY THIS EXISTS:
--   Decision D-7 (docs/ARCHITECTURE_UNIFIED_IDENTITY.md) puts a revenue split on the fleet<->driver
--   affiliation: `fleet_drivers.revenue_share_pct` (migration 0022). A fleet-won booking with a
--   non-zero share pays TWO parties for one trip — the owner keeps the remainder, the driver takes
--   their percentage. `payouts` cannot express that today because migration 011 declared
--   `booking_id uuid not null unique`: one booking, at most one payout row, forever.
--
-- WHY THIS IS DELICATE:
--   That UNIQUE(booking_id) is not decoration. It is the anchor the entire settle path is built
--   on, and it is the reason bt-payment-service writes the PAYOUT BEFORE THE PAYMENT: the payments
--   row is what short-circuits a retry, so if the payment were written first and the payout write
--   then failed, the retry would skip both writes, flip the booking to 'paid' and leave the payee
--   with no payout row at all. Writing the payout first inverts that failure — a crash leaves no
--   payments row, so the retry replays both writes onto the SAME payout rows.
--
--   Replacing the anchor with a WEAKER one would reintroduce double-payout on exactly that replay.
--   UNIQUE(booking_id, payee_type) is not weaker: `payee_type` is NOT NULL with a default and is
--   confined by 0016's CHECK to ('driver','fleet_owner'), so the pair still admits at most one row
--   per party per booking — which is precisely the invariant that matters once a booking can
--   legitimately pay two parties. A replayed settle re-writes both rows and changes nothing.
--
-- NO DEPLOY ORDERING — THE SERVICE DOES NOT DEPEND ON THIS HAVING BEEN APPLIED:
--   Migrations here are applied BY HAND, while .github/workflows/deploy.yml path-filters
--   bt-payment-service on `bt-payment-service/**` and auto-deploys it on merge. Anything the
--   service needed this file for first would be an outage of unbounded length between the two.
--   So it needs nothing: payout writes are read-then-INSERT-or-UPDATE and name no ON CONFLICT
--   arbiter, which is what a pre-0023 schema would reject (42P10 on the FIRST write of every
--   settlement). The same service code settles correctly on both schemas; the only thing a
--   pre-0023 table cannot do is hold the SECOND row of a D-7 split, and its own surviving
--   UNIQUE(booking_id) refuses that write outright (23505, nothing recorded, retriable) instead
--   of letting one payee overwrite the other. Splits also require 0022's revenue_share_pct, so
--   on a schema older than that every settlement resolves to a single payee and this file is
--   not yet load-bearing at all.
--
--   What the constraint below IS load-bearing for is concurrency: two settles racing on the same
--   booking both read "no row" and both INSERT, and this is what turns the loser into a 23505
--   rather than a duplicate payout row.
--
-- ADDITIVE FOR EVERY LIVE ROW: all 620 seeded affiliations carry revenue_share_pct = 0 (salaried),
-- which resolves to a single fleet_owner payee — byte-identical to today. Nothing here rewrites,
-- deletes or re-keys an existing payouts row.

-- ---------------------------------------------------------------
-- (1) drop the old single-row-per-booking anchor.
--
-- Dropped by SHAPE rather than by name on purpose. The live schema was not built from these
-- migrations (see supabase/migrations/README.md "Step 0"), so the constraint backing
-- `booking_id ... unique` may carry the Postgres-generated `payouts_booking_id_key` or any name a
-- dashboard edit gave it, and it may be a bare unique index rather than a constraint. Guessing the
-- name and being wrong is silent: the DROP no-ops, the new anchor is added, and the FIRST split
-- settlement then fails on the surviving old constraint — in production, on real money. So find
-- every unique thing whose column set is exactly {booking_id} and remove it.
-- ---------------------------------------------------------------
do $$
declare
  r record;
begin
  -- Constraints first: dropping the constraint also drops the index it owns, and an index owned by
  -- a constraint cannot be dropped directly (Postgres refuses with "cannot drop index ... because
  -- constraint ... requires it"), so the reverse order would leave the constraint standing.
  for r in
    select con.conname
    from   pg_constraint con
    join   pg_class     rel on rel.oid = con.conrelid
    join   pg_namespace nsp on nsp.oid = rel.relnamespace
    where  nsp.nspname = 'public'
      and  rel.relname = 'payouts'
      and  con.contype = 'u'
      and  con.conkey  = array[(
             select att.attnum from pg_attribute att
             where att.attrelid = rel.oid and att.attname = 'booking_id' and not att.attisdropped
           )]::int2[]
  loop
    execute format('alter table public.payouts drop constraint %I', r.conname);
  end loop;

  -- Then any free-standing unique index with the same single-column shape.
  for r in
    select cls.relname
    from   pg_index      idx
    join   pg_class      cls on cls.oid = idx.indexrelid
    join   pg_class      rel on rel.oid = idx.indrelid
    join   pg_namespace  nsp on nsp.oid = rel.relnamespace
    where  nsp.nspname = 'public'
      and  rel.relname = 'payouts'
      and  idx.indisunique
      and  idx.indnkeyatts = 1
      and  idx.indpred is null
      and  idx.indkey[0] = (
             select att.attnum from pg_attribute att
             where att.attrelid = rel.oid and att.attname = 'booking_id' and not att.attisdropped
           )
  loop
    execute format('drop index public.%I', r.relname);
  end loop;
end
$$;

-- ---------------------------------------------------------------
-- (2) the new anchor: one payout per PARTY per booking.
--
-- A named constraint (not a bare index) because a constraint is what the next person greps for
-- when they ask "what stops a double payout?", and the name is what a 23505 puts in the log line.
--
-- `payee_type` is NOT NULL DEFAULT 'driver' since 0016, so every pre-existing row already has a
-- value and this constraint is satisfiable without a backfill. It is added VALID (no NOT VALID
-- escape) deliberately: a unique constraint has to build its index over the whole table anyway, and
-- `payouts` is small — the live table holds well under a thousand rows.
-- ---------------------------------------------------------------
alter table public.payouts
  drop constraint if exists payouts_one_per_payee;

alter table public.payouts
  add constraint payouts_one_per_payee unique (booking_id, payee_type);

comment on constraint payouts_one_per_payee on public.payouts is
  'Idempotency anchor for the settle path: at most one payout per party per booking. Replaces '
  'UNIQUE(booking_id), which could not express the D-7 fleet/driver revenue split. A retried '
  'settlement re-writes these same rows instead of creating a second one; a CONCURRENT one is '
  'stopped here, with a 23505 rather than a duplicate payout.';

-- The old UNIQUE(booking_id) also served every "what did this booking pay out?" lookup. The new
-- composite constraint's index is usable for that (booking_id is its leading column), so
-- `payouts_booking_idx` from 011 is now redundant — left in place regardless: dropping it buys a
-- few kilobytes and risks a plan regression on a table nobody is trying to shrink.

comment on table public.payouts is
  'Payout records, one row per PAYEE per booking. Solo trip -> the driver. Fleet trip -> the fleet '
  'owner, plus the driver when fleet_drivers.revenue_share_pct > 0 (D-7). Pilot: recorded, not '
  'transferred — the Razorpay Route disbursement (D-12) is a separate, currently inert path.';
