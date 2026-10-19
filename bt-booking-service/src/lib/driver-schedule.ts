import { supabase } from './supabase.js'
import { BookingError } from './types.js'

// -----------------------------------------------------------
// driver-schedule — one driver, one live trip.
//
// WHY THIS EXISTS. bt-fleet-service already enforces this for its own dispatch:
// vehicle_assignments carries three partial-unique indexes (0016 — one live row per
// booking, per vehicle, per DRIVER), with assertVehicleAvailable in front of them to
// name the blocking trip. That is airtight for the path it covers.
//
// It covers one path. THREE places bind bookings.driver_id:
//
//   fleet-service assignDriverAndVehicle  → writes vehicle_assignments  → guarded
//   awardBooking      (a solo driver wins an auction)                   → no row, no guard
//   acceptBooking     (a solo driver takes a load off the board)        → no row, no guard
//   directAttachBooking (a solo owner-driver carries their own load)    → no row, no guard
//
// A solo driver never gets a vehicle_assignments row — that table is the FLEET's
// dispatch ledger — so the indexes protecting fleet drivers cannot see them at all,
// and `bookings` itself has only plain non-unique indexes on driver_id. The result:
// one owner-driver could win five auctions running at once and be bound to all five,
// which is a physically impossible schedule and quietly wrong for everything keyed on
// bookings.driver_id — live location, POD, wage allocation, utilisation.
//
// WHAT THIS IS NOT. It is a read-then-write check, so it cannot win a race the way a
// unique index does; two shippers accepting the same driver's bids in the same instant
// can still both pass. It closes the ordinary case (which is every case seen so far)
// and names the blocking trip. The durable fix is a partial unique index on
// bookings(driver_id) WHERE the trip is live — that needs a migration and a backfill
// decision for any existing overlap, so it is deliberately NOT bundled here.
// -----------------------------------------------------------

// -----------------------------------------------------------
// TRIP_END_FREE_STATUSES — the trip is over and the driver goes back in the pool.
//
// DELIBERATELY NOT state.ts's TERMINAL_BOOKING_STATUSES, and the difference is
// load-bearing. That list means "this booking will never move again" (derived from
// VALID_TRANSITIONS, used to stop documents being minted against dead trips), so it
// holds only 'paid' and 'cancelled'. A driver who has DELIVERED — 'completed', money
// still pending — is physically free and must be able to take the next load. Reusing
// the document list here would strand every driver between delivery and settlement.
//
// This is the same set as bt-fleet-service's booking-status.ts TRIP_END_FREE_STATUSES,
// duplicated rather than imported because bt-fleet-service does not depend on
// @bharattruck/shared (see .github/workflows/ci.yml — it has no packages/shared filter)
// and giving it one to share four strings is a bigger change than the strings are
// worth. THEY MUST NOT DRIFT: a status that frees the driver there but not here would
// make the fleet console and the marketplace disagree about whether the same person is
// available.
// -----------------------------------------------------------

export const TRIP_END_FREE_STATUSES = [
  'completed',
  'delivery_asserted',
  'paid',
  'cancelled',
] as const

export function tripFreesDriver(status: string): boolean {
  return (TRIP_END_FREE_STATUSES as readonly string[]).includes(status)
}

/** One live trip holding a driver. Enough to name it in a refusal, nothing more. */
export type DriverCommitment = {
  booking_id: string
  status: string
  description: string
}

type CommitmentRow = {
  id: string
  status: string
  source_address: string | null
  destination_address: string | null
  pickup_date: string | null
}

const COMMITMENT_COLUMNS = 'id, status, source_address, destination_address, pickup_date'

/**
 * Turn rows into the commitments holding this driver.
 *
 * Pure, so the rule can be asserted on without a database — the same reason
 * bt-fleet-service keeps buildSchedule separate from its query. The status filter is
 * applied HERE as well as in the WHERE clause: the SQL narrowing is for cost, this is
 * where the rule lives.
 */
export function buildDriverCommitments(
  rows: CommitmentRow[],
  opts: { exceptBookingId?: string } = {},
): DriverCommitment[] {
  return rows
    .filter(r => r.id !== opts.exceptBookingId)
    .filter(r => !tripFreesDriver(r.status))
    .map(r => ({
      booking_id: r.id,
      status: r.status,
      description: [r.source_address, r.destination_address].filter(Boolean).join(' → ')
        || 'a trip with no lane recorded',
    }))
}

export async function listDriverCommitments(
  driverId: string,
  opts: { exceptBookingId?: string } = {},
): Promise<DriverCommitment[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(COMMITMENT_COLUMNS)
    .eq('driver_id', driverId)
    .not('status', 'in', `(${TRIP_END_FREE_STATUSES.join(',')})`)

  if (error) throw new Error(`DB driver-commitment lookup failed: ${error.message}`)
  return buildDriverCommitments((data ?? []) as CommitmentRow[], opts)
}

/**
 * Refuse to bind a driver who is already out on a trip.
 *
 * `exceptBookingId` excludes the booking being decided from its own answer, so a
 * replay — the same request arriving twice — is never blocked by the effect of its
 * own first run. Every caller passes it.
 *
 * The refusal NAMES the blocking trip rather than saying "driver unavailable": the
 * shipper accepting the bid did not create this clash and cannot see the driver's
 * other work, so the lane and booking id are the only things that let them (or ops)
 * act on it. Mirrors assertVehicleAvailable's wording for the same reason.
 */
export async function assertDriverAvailable(
  driverId: string,
  opts: { exceptBookingId?: string } = {},
): Promise<void> {
  const conflict = (await listDriverCommitments(driverId, opts))[0]
  if (!conflict) return

  throw new BookingError(
    `That driver is already on ${conflict.description} (booking ${conflict.booking_id}, ` +
    `${conflict.status}) — they must finish or be released from it first`,
    'INVALID_TRANSITION',
    409,
  )
}
