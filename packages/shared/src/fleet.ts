/**
 * Fleet-owner tenant isolation — THE single implementation of "may this fleet see this?".
 *
 * WHY THIS IS SHARED AND NOT PER-SERVICE: every authorization check in the platform was
 * written as a binary `shipper | driver` branch. The fleet persona adds a third tenant
 * whose reach is indirect — a fleet may touch a booking it never appears on directly,
 * because its truck or its driver ran it. One service getting that predicate subtly wrong
 * leaks one fleet's assets to another, and a copy-pasted predicate drifts. So the rule
 * lives here once and services call it.
 *
 * IDENTITY CONTRACT (see ./auth.ts — violating it silently authorizes the wrong tenant):
 *   • JWT `userId` is `public.users.id`.
 *   • `fleet_owners.user_id`  -> users.id
 *   • `fleet_drivers.driver_id`, `vehicle_assignments.driver_id`, `bookings.driver_id`
 *     -> drivers.id, which is a DIFFERENT row from users.id.
 *
 * Schema source: supabase/migrations/0015_fleet_owner_core.sql and
 * 0016_fleet_assignment_and_auction.sql.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The fleet party behind a `role='fleet_owner'` JWT. */
export interface FleetOwnerRef {
  /** fleet_owners.id — the tenant key. NOT users.id. */
  id: string
  /** users.id this profile belongs to. */
  user_id: string
  company_name: string
  /**
   * false once ops deactivates the fleet. Read-only access (history, tracking) is still
   * legitimate for an inactive fleet; callers gating *privileged* actions (bidding,
   * assigning) must check this themselves.
   */
  is_active: boolean
}

/** A driver's live tie to a fleet. `pending` counts as live — the seat is already taken. */
export interface FleetAffiliation {
  id: string
  fleet_owner_id: string
  driver_id: string
  status: 'pending' | 'active' | 'rejected' | 'suspended' | 'left'
}

/**
 * The booking fields the access rule needs. Deliberately structural, not a full booking
 * row: each service selects its own columns, and they only have to include these three.
 * A column the caller did not select must be passed as `null`/undefined, never omitted
 * silently from a `select` and then assumed absent — that would fail open.
 */
export interface FleetAccessibleBooking {
  id: string
  fleet_owner_id?: string | null
  vehicle_id?: string | null
  driver_id?: string | null
}

/**
 * Resolve the fleet party for a JWT `userId`, or null if this user is not a fleet owner.
 * A `role='fleet_owner'` token with no row here means registration did not complete —
 * treat it as "no fleet", never as "all fleets".
 */
export async function resolveFleetOwnerByUserId(
  supabase: SupabaseClient,
  userId: string,
): Promise<FleetOwnerRef | null> {
  const { data, error } = await supabase
    .from('fleet_owners')
    .select('id, user_id, company_name, is_active')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`fleet_owners lookup failed: ${error.message}`)
  return (data as FleetOwnerRef | null) ?? null
}

/**
 * The driver's live affiliation (`pending` or `active`), or null if they are a solo driver.
 * `fleet_drivers_one_live_per_driver` (migration 0015) guarantees at most one, which is why
 * this can be a single unambiguous lookup rather than a scan.
 */
export async function getLiveFleetAffiliation(
  supabase: SupabaseClient,
  driverId: string,
): Promise<FleetAffiliation | null> {
  const { data, error } = await supabase
    .from('fleet_drivers')
    .select('id, fleet_owner_id, driver_id, status')
    .eq('driver_id', driverId)
    .in('status', ['pending', 'active'])
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers lookup failed: ${error.message}`)
  return (data as FleetAffiliation | null) ?? null
}

/**
 * Is this driver fleet-controlled? Drives the driver-app deltas: a fleet driver loses the
 * load board and never sees trip price (Q14/Q16).
 *
 * `driverId` is `drivers.id`, NOT `users.id` — resolve via getDriverByUserId first.
 * Only `status='active'` counts: a pending invite has not been accepted, so the driver is
 * still operating as a solo driver until they say yes.
 */
export async function isFleetAffiliatedDriver(
  supabase: SupabaseClient,
  driverId: string,
): Promise<boolean> {
  const affiliation = await getLiveFleetAffiliation(supabase, driverId)
  return affiliation?.status === 'active'
}

/**
 * May this fleet see this booking? True when ANY of:
 *   1. the fleet won the auction        — bookings.fleet_owner_id
 *   2. the fleet's truck ran it         — bookings.vehicle_id -> vehicles.fleet_owner_id,
 *                                         or a vehicle_assignments row for this booking
 *   3. the fleet's driver ran it        — an active fleet_drivers affiliation
 *
 * (2) and (3) are not redundant with (1). A booking awarded to a solo driver who has since
 * joined a fleet, or run on a fleet truck via an ops override, has no fleet_owner_id but is
 * genuinely that fleet's trip — and the fleet needs it for its P&L and its live map.
 * Conversely the vehicle_assignments check keeps *history* visible after a driver leaves:
 * the trip still belongs to the fleet that ran it.
 *
 * Checks are ordered cheapest-first and short-circuit, so the common case (1) costs no query.
 */
export async function canFleetAccessBooking(
  supabase: SupabaseClient,
  fleetOwnerId: string,
  booking: FleetAccessibleBooking,
): Promise<boolean> {
  if (booking.fleet_owner_id && booking.fleet_owner_id === fleetOwnerId) return true

  if (booking.vehicle_id) {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id')
      .eq('id', booking.vehicle_id)
      .eq('fleet_owner_id', fleetOwnerId)
      .maybeSingle()
    if (error) throw new Error(`vehicles ownership lookup failed: ${error.message}`)
    if (data) return true
  }

  // Covers a released assignment too (released_at set), which is exactly the history case.
  const { data: assignment, error: assignmentError } = await supabase
    .from('vehicle_assignments')
    .select('id')
    .eq('booking_id', booking.id)
    .eq('fleet_owner_id', fleetOwnerId)
    .limit(1)
    .maybeSingle()
  if (assignmentError) throw new Error(`vehicle_assignments lookup failed: ${assignmentError.message}`)
  if (assignment) return true

  // (3) The driver-affiliation grant, and the ONLY clause with no fleet_owner_id filter of its
  // own — so it must carry its own guard. It is restricted to UNOWNED bookings.
  //
  // Without `!booking.fleet_owner_id` this clause leaks across tenants: clause (1) grants on
  // equality but never DENIES on inequality, so a booking owned by fleet X falls through to
  // here, and hiring X's ex-driver is enough to make it resolve true for fleet Y. That state is
  // reachable through shipped routes — `fleet_drivers_one_live_per_driver` is a PARTIAL unique
  // index over ('pending','active') only (migration 0015), DELETE /fleet/drivers/:id soft-sets
  // status='left', and invite does not check prior affiliations — so a driver can hold a live
  // affiliation with Y while bookings.driver_id still points at them on X's historical trips.
  // bt-tracking-service gates /route, /eta and /track on this helper, so the leak was X's trip
  // geometry (including the consignee's coordinates) to a competitor.
  //
  // Unowned-only is exactly what the docstring above always promised: a trip awarded to a solo
  // driver who has since joined this fleet. Once a booking names an owning fleet, membership in
  // a different fleet is never a reason to see it.
  if (booking.driver_id && !booking.fleet_owner_id) {
    const affiliation = await getLiveFleetAffiliation(supabase, booking.driver_id)
    if (affiliation?.status === 'active' && affiliation.fleet_owner_id === fleetOwnerId) return true
  }

  return false
}
