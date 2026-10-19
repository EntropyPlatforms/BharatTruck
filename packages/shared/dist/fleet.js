/**
 * Resolve the fleet party for a JWT `userId`, or null if this user is not a fleet owner.
 * A `role='fleet_owner'` token with no row here means registration did not complete —
 * treat it as "no fleet", never as "all fleets".
 */
export async function resolveFleetOwnerByUserId(supabase, userId) {
    const { data, error } = await supabase
        .from('fleet_owners')
        .select('id, user_id, company_name, is_active')
        .eq('user_id', userId)
        .maybeSingle();
    if (error)
        throw new Error(`fleet_owners lookup failed: ${error.message}`);
    return data ?? null;
}
/**
 * The driver's live affiliation (`pending` or `active`), or null if they are a solo driver.
 * `fleet_drivers_one_live_per_driver` (migration 0015) guarantees at most one, which is why
 * this can be a single unambiguous lookup rather than a scan.
 */
export async function getLiveFleetAffiliation(supabase, driverId) {
    const { data, error } = await supabase
        .from('fleet_drivers')
        .select('id, fleet_owner_id, driver_id, status')
        .eq('driver_id', driverId)
        .in('status', ['pending', 'active'])
        .maybeSingle();
    if (error)
        throw new Error(`fleet_drivers lookup failed: ${error.message}`);
    return data ?? null;
}
/**
 * Is this driver fleet-controlled? Drives the driver-app deltas: a fleet driver loses the
 * load board and never sees trip price (Q14/Q16).
 *
 * `driverId` is `drivers.id`, NOT `users.id` — resolve via getDriverByUserId first.
 * Only `status='active'` counts: a pending invite has not been accepted, so the driver is
 * still operating as a solo driver until they say yes.
 */
export async function isFleetAffiliatedDriver(supabase, driverId) {
    const affiliation = await getLiveFleetAffiliation(supabase, driverId);
    return affiliation?.status === 'active';
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
export async function canFleetAccessBooking(supabase, fleetOwnerId, booking) {
    if (booking.fleet_owner_id && booking.fleet_owner_id === fleetOwnerId)
        return true;
    if (booking.vehicle_id) {
        const { data, error } = await supabase
            .from('vehicles')
            .select('id')
            .eq('id', booking.vehicle_id)
            .eq('fleet_owner_id', fleetOwnerId)
            .maybeSingle();
        if (error)
            throw new Error(`vehicles ownership lookup failed: ${error.message}`);
        if (data)
            return true;
    }
    // Covers a released assignment too (released_at set), which is exactly the history case.
    const { data: assignment, error: assignmentError } = await supabase
        .from('vehicle_assignments')
        .select('id')
        .eq('booking_id', booking.id)
        .eq('fleet_owner_id', fleetOwnerId)
        .limit(1)
        .maybeSingle();
    if (assignmentError)
        throw new Error(`vehicle_assignments lookup failed: ${assignmentError.message}`);
    if (assignment)
        return true;
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
        const affiliation = await getLiveFleetAffiliation(supabase, booking.driver_id);
        if (affiliation?.status === 'active' && affiliation.fleet_owner_id === fleetOwnerId)
            return true;
    }
    return false;
}
