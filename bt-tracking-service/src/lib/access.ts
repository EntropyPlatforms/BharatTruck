import type { BookingRelation } from '@bharattruck/shared/personas'

/**
 * Tracking authorization — the RELATION half of the decision, kept pure so every allow/deny
 * is testable without a database (the same split @bharattruck/shared/personas draws between
 * `capabilitiesFrom` and `resolvePersonas`). The async caller resolves who the viewer is and
 * what they relate to; this decides whether that relation, on its own, opens the map.
 */

/**
 * The booking statuses in which a CONSIGNEE may watch their inbound load (D-25). This mirrors
 * ACTIVE_TRIP_STATUSES in bt-booking-service/src/lib/repository.ts — the set in which live GPS
 * exists at all, because /location/update rejects fixes outside it. A consignee is a stakeholder
 * in the SHIPMENT, not the booking: they have a reason to see the truck while it is on the road
 * to them, and none to see a load that has not dispatched or is already closed and paid. Keeping
 * this in lockstep with the ingester's set means a consignee is never shown a "tracking" screen
 * that can only ever be empty.
 */
export const CONSIGNEE_TRACKABLE_STATUSES = ['accepted', 'in_transit', 'delivery_asserted']

/**
 * Does the viewer's relation to this booking grant a tracking read outright?
 *
 * Shipper (posted it) and carrier/driver (run it) read unconditionally — exactly what the old
 * `role === 'shipper' | 'driver'` branches granted, so a single-persona user's decision is
 * unchanged. The consignee is the one relation that is status-scoped, per D-25.
 *
 * A `false` here is NOT a final denial: the fleet tenant-reach test (canFleetAccessBooking) is
 * broader than a direct relation and needs a query, so it stays with the async caller. This
 * function only answers the part that can be answered from the relation set alone.
 */
export function relationGrantsTracking(relations: BookingRelation[], status: string): boolean {
  if (relations.includes('shipper') || relations.includes('carrier') || relations.includes('driver')) {
    return true
  }
  if (relations.includes('consignee') && CONSIGNEE_TRACKABLE_STATUSES.includes(status)) {
    return true
  }
  return false
}
