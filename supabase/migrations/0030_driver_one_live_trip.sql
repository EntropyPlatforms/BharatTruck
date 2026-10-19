-- migration 0030: one driver, one live trip — enforced by the database, not by application code.
--
-- WHY THIS EXISTS:
--   bt-fleet-service already guarantees this for ITS dispatch path: vehicle_assignments carries
--   three partial-unique indexes from 0016 (one live row per booking, per vehicle, per driver).
--   That table is the FLEET's dispatch ledger, and a solo driver never gets a row in it, so those
--   indexes cannot see the three other paths that bind bookings.driver_id:
--
--     awardBooking        — a solo driver wins an auction
--     acceptBooking       — a solo driver takes a load off the board
--     directAttachBooking — a solo owner-driver carries their own load
--
--   `bookings` has only PLAIN, non-unique indexes on driver_id (idx_bookings_driver_id,
--   idx_bookings_status_driver), so nothing stopped one owner-driver being bound to five live
--   trips at once — a physically impossible schedule, and wrong for everything keyed on
--   bookings.driver_id: live location, POD, wage allocation, utilisation.
--
--   PR #140 closed those three paths in application code with assertDriverAvailable(). That check
--   is read-then-write, so unlike an index it cannot win a race: two shippers accepting the same
--   driver's bids in the same instant can still both pass. THIS INDEX is the durable half. The
--   application check stays — it is what turns a raw 23505 into a refusal that names the blocking
--   trip, exactly as assertVehicleAvailable does in front of the 0016 indexes.
--
-- THE PREDICATE IS "THE TRIP IS OVER", NOT "THE ROW IS FROZEN.
--   The four statuses below are bt-fleet-service's TRIP_END_FREE_STATUSES (booking-status.ts) and
--   bt-booking-service's driver-schedule.ts TRIP_END_FREE_STATUSES — deliberately NOT state.ts's
--   TERMINAL_BOOKING_STATUSES, which means "this booking will never move again" and holds only
--   'paid' and 'cancelled'. A driver who has DELIVERED ('completed') is physically free while the
--   money is still outstanding; using the terminal list here would strand every driver between
--   delivery and settlement, and the index would refuse their next load.
--
--   If that set ever changes, THREE places move together or they disagree about the same trip:
--   this predicate, driver-schedule.ts, and bt-fleet-service/src/lib/booking-status.ts.
--
-- SAFE TO APPLY AS-IS: verified against production 2026-08-14 — zero drivers currently hold more
-- than one live booking, so the index builds without a backfill. Written idempotently and
-- forward-only. Built non-CONCURRENTLY on purpose: `bookings` is small (tens of rows at pilot
-- scale) and CREATE INDEX CONCURRENTLY cannot run inside a transaction block, which is how this
-- is applied. Revisit if the table grows before this ships to a busy tenant.
--
-- NOT NULL is stated explicitly even though NULLs are already distinct in a unique index: it keeps
-- the index off every unassigned booking rather than merely tolerating them, which at pilot scale
-- is most of the table.

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_live_trip_per_driver
  ON public.bookings (driver_id)
  WHERE driver_id IS NOT NULL
    AND status NOT IN ('completed', 'delivery_asserted', 'paid', 'cancelled');

COMMENT ON INDEX public.bookings_one_live_trip_per_driver IS
  'D-19 for solo drivers: at most one non-finished booking per driver. Mirrors '
  'vehicle_assignments_one_live_per_driver (0016), which only covers fleet dispatch. '
  'Predicate = TRIP_END_FREE_STATUSES, not TERMINAL_BOOKING_STATUSES — a delivered driver '
  'awaiting payment is free. Keep in step with driver-schedule.ts and booking-status.ts.';
