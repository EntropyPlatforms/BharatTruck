import type { BookingStatus, QuoteStatus } from './types.js'
import { BookingError } from './types.js'

// -----------------------------------------------------------
// VALID_TRANSITIONS
// Maps each status to its legal next states.
// Terminal states (completed, cancelled) have empty arrays.
// -----------------------------------------------------------

export const VALID_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending:      ['accepted', 'cancelled', 'negotiating'],
  negotiating:  ['accepted', 'cancelled'],
  accepted:     ['in_transit', 'cancelled'],
  // in_transit forks: the receiver-OTP path closes straight to 'completed'
  // (confirmed proof), while a delivery the receiver cannot confirm branches to
  // 'delivery_asserted' (migration 0025, evidence-only proof). Adding the second
  // target does NOT change the first: an OTP completion is byte-identical to
  // before, and on a pre-0025 database the enum value does not exist so the
  // assert branch is simply unreachable.
  in_transit:   ['completed', 'delivery_asserted'],
  // delivery_asserted is closed by OPS, not the driver — force-complete moves it
  // to 'completed' (the money loop then proceeds normally), or ops cancels a bad
  // assertion. pod_state keeps pod_strength='asserted' across the close, so the
  // weaker proof is never silently upgraded (§6.3).
  delivery_asserted: ['completed', 'cancelled'],
  completed:    ['paid'],       // cash-recorded settlement closes the money loop
  paid:         [],
  cancelled:    [],
}

// -----------------------------------------------------------
// TERMINAL_BOOKING_STATUSES
//
// Derived from VALID_TRANSITIONS rather than written out again, because a second
// hand-maintained list of "frozen" statuses is a list that goes stale. A status
// with no legal next state is terminal by definition: the booking will never move
// again, so anything that hangs a new artefact off it is rewriting history rather
// than recording it.
//
// This exists so the freight-document issuance gates (lib/documents/service.ts)
// cannot drift from the lifecycle. A tax invoice or a consignment note minted
// against a cancelled booking burns a serial out of a GAPLESS, legally sequenced
// series for a trip that never ran, and migration 0024 has no void or cancel
// concept that could take it back.
// -----------------------------------------------------------

export const TERMINAL_BOOKING_STATUSES: BookingStatus[] =
  (Object.keys(VALID_TRANSITIONS) as BookingStatus[])
    .filter(status => VALID_TRANSITIONS[status].length === 0)

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.includes(status)
}

// -----------------------------------------------------------
// CANCELLABLE_BOOKING_STATUSES
//
// Every status the state machine allows a booking to be cancelled FROM — derived from
// VALID_TRANSITIONS (like TERMINAL_BOOKING_STATUSES) so a second hand-written list cannot drift
// from the lifecycle. This is the LEGAL set; WHO may cancel from each is an authorization rule
// the service applies on top (a shipper/driver may cancel before the goods move; voiding a
// 'delivery_asserted' trip is an OPS action only — see cancelBooking + the state.ts note on
// delivery_asserted). The service must not carry its own narrower copy of this list, which is the
// bug review F14 fixed: a hardcoded ['pending','accepted'] silently made a legally-cancellable
// 'delivery_asserted' booking uncancellable by anyone, ops included.
// -----------------------------------------------------------

export const CANCELLABLE_BOOKING_STATUSES: BookingStatus[] =
  (Object.keys(VALID_TRANSITIONS) as BookingStatus[])
    .filter(status => VALID_TRANSITIONS[status].includes('cancelled'))

// -----------------------------------------------------------
// assertValidTransition
// Pure synchronous guard — throws BookingError on illegal moves.
// The repository executes the actual DB UPDATE after this passes.
// -----------------------------------------------------------

export function assertValidTransition(from: BookingStatus, to: BookingStatus): void {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new BookingError(
      `Cannot transition booking from '${from}' to '${to}'`,
      'INVALID_TRANSITION',
      409,
    )
  }
}

// -----------------------------------------------------------
// assertFleetAssignmentReady
// Extra guard on accepted → in_transit for FLEET-won bookings only.
//
// A fleet may bid with no free truck (founder Q10), so the award leaves
// bookings.driver_id NULL and binds nothing physical. The owner then pairs a
// driver and a truck in bt-fleet-service, which writes the vehicle_assignments
// row. Until that row exists the trip has no truck of record, so its distance,
// fuel and per-asset P&L would be unattributable — hence the trip cannot start.
//
// Pure and synchronous like the transition guards above: the caller does the
// lookup and only for a booking that actually carries fleet_owner_id, so a solo
// booking (fleet_owner_id NULL) never reaches this function at all.
// -----------------------------------------------------------

export function assertFleetAssignmentReady(hasLiveAssignment: boolean): void {
  if (!hasLiveAssignment) {
    throw new BookingError(
      'This trip was won by a fleet and has no driver+truck assigned yet — ' +
      'the fleet owner must assign a driver and a truck before the trip can start',
      'INVALID_TRANSITION',
      409,
    )
  }
}

// -----------------------------------------------------------
// AuctionStatus — high-level lifecycle for auction-mode bookings
// -----------------------------------------------------------

export type AuctionStatus = 'open' | 'negotiating' | 'awarded' | 'in_transit' | 'completed' | 'cancelled' | 'expired'

// -----------------------------------------------------------
// VALID_QUOTE_TRANSITIONS
// Maps each QuoteStatus to its legal next states.
// Terminal states (accepted, rejected, withdrawn, expired) are frozen.
// -----------------------------------------------------------

export const VALID_QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  submitted:  ['countered', 'accepted', 'rejected', 'withdrawn', 'expired'],
  countered:  ['countered', 'accepted', 'rejected', 'withdrawn', 'expired'],
  accepted:   [],
  rejected:   [],
  withdrawn:  [],
  expired:    [],
}

// -----------------------------------------------------------
// assertValidQuoteTransition
// Pure synchronous guard — throws BookingError on illegal moves.
// -----------------------------------------------------------

export function assertValidQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  const allowed = VALID_QUOTE_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new BookingError(
      `Cannot transition quote from '${from}' to '${to}'`,
      'INVALID_TRANSITION',
      409,
    )
  }
}
