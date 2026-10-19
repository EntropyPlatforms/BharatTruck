import type { LiveLocation } from './types.js'

/**
 * The live-fix Redis key is per-DRIVER (loc:driver:{id}), but a driver can hold two concurrent
 * active trips (D-25 / booking ACTIVE_TRIP_STATUSES: one accepted while another is in_transit).
 * Every fix records the booking it was pushed for, so a booking-scoped read must reject a fix that
 * belongs to the driver's OTHER trip — otherwise a shipper tracking booking A sees the truck's
 * position and ETA from trip B, off A's route, with no staleness flag (review F26). A legacy fix
 * that carries no booking_id is NOT filtered, so behaviour for a single-trip driver is unchanged.
 */
export function fixMatchesBooking(fix: Pick<LiveLocation, 'booking_id'>, bookingId: string): boolean {
  return !fix.booking_id || fix.booking_id === bookingId
}

/** Parse a raw Redis fix, returning it only when it belongs to `bookingId` (see fixMatchesBooking). */
export function liveFixForBooking(bookingId: string, raw: string | null): LiveLocation | null {
  if (!raw) return null
  const fix = JSON.parse(raw) as LiveLocation
  return fixMatchesBooking(fix, bookingId) ? fix : null
}
