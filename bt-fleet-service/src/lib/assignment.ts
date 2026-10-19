import { bookingFreesTruck, TRIP_END_FREE_STATUSES } from './booking-status.js'
import { getSupabase } from './supabase.js'
import { getActiveAffiliation } from './fleet-repo.js'
import { getFleetVehicle } from './vehicles-repo.js'
import { assertVehicleAvailable } from './vehicle-schedule.js'
import {
  asRow,
  asRowOrNull,
  asRows,
  FleetError,
  UNIQUE_VIOLATION,
  type BookingRow,
  type VehicleAssignmentRow,
} from './types.js'

// -----------------------------------------------------------
// assignment — the pairing step. Award -> assign(driver, vehicle) -> the trip runs
// EXACTLY as the solo-driver flow does; there is no fork in the booking state
// machine, which is why assignment writes bookings.driver_id/vehicle_id and then
// gets out of the way.
//
// CONCURRENCY: the three partial-unique indexes from migration 0016
// (one live assignment per booking, per vehicle, per driver) are the guard. We
// INSERT and catch 23505 rather than pre-checking — a check-then-insert has a race
// window in which two dispatchers can both hand the same truck to two loads.
//
// The D-19 commitment check sits IN FRONT of that insert and does not weaken it.
// It is not a second mutual-exclusion rule and must never be mistaken for one: a
// read-then-write check cannot win a race, and it refuses on exactly the condition
// the vehicle index already refuses on. It runs to turn "already has a live
// assignment" into a refusal that names the trip, and to catch the one commitment
// no index sees — a booking still running whose assignment row is gone.
// -----------------------------------------------------------

const BOOKING_COLUMNS =
  'id, shipper_id, driver_id, fleet_owner_id, vehicle_id, source_address, source_lat, source_lng, ' +
  'destination_address, dest_lat, dest_lng, load_type, weight_kg, quoted_price, final_price, ' +
  'pickup_date, status, booking_type, dimensions_json, created_at, updated_at'

const ASSIGNMENT_COLUMNS =
  'id, fleet_owner_id, booking_id, vehicle_id, driver_id, assigned_by, assigned_at, released_at, created_at'

// Bookings the fleet won but has not yet crewed. Assigning before award has nothing
// to assign to; assigning after departure is mid-trip reassignment, which is
// explicitly out of v1 (Q13).
const ASSIGNABLE_STATUSES = ['accepted']

// Once a booking reaches one of these, its truck and driver are free again.
// Shared with vehicle-schedule.ts via booking-status.ts (FB-01).
const TERMINAL_BOOKING_STATUSES = TRIP_END_FREE_STATUSES

export async function getFleetBooking(fleetOwnerId: string, bookingId: string): Promise<BookingRow | null> {
  const { data, error } = await getSupabase()
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('id', bookingId)
    .eq('fleet_owner_id', fleetOwnerId)
    .maybeSingle()
  if (error) throw new Error(`bookings select failed: ${error.message}`)
  return asRowOrNull<BookingRow>(data)
}

export async function listFleetBookings(
  fleetOwnerId: string,
  opts: { status?: string; limit: number; offset: number },
): Promise<BookingRow[]> {
  let query = getSupabase()
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
  if (opts.status) query = query.eq('status', opts.status)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1)
  if (error) throw new Error(`bookings select failed: ${error.message}`)
  return asRows<BookingRow>(data)
}

export type AssignInput = {
  fleetOwnerId: string
  bookingId: string
  driverId: string
  vehicleId: string
  assignedBy: string
}

export type AssignResult = {
  assignment: VehicleAssignmentRow
  booking: BookingRow
}

// The two ownership reads the seam below rests on. Injected, with the live repos as
// the default, so the policy itself can be asserted on without a database — which is
// how the rest of this service's suite is written.
export type ExecutionLookups = {
  vehicle(fleetOwnerId: string, vehicleId: string): Promise<{ id: string } | null>
  affiliation(fleetOwnerId: string, driverId: string): Promise<{ id: string } | null>
}

const LIVE_LOOKUPS: ExecutionLookups = {
  vehicle: getFleetVehicle,
  affiliation: getActiveAffiliation,
}

// mayExecuteFor — THE sub-contract seam (D-24), and the ONLY place that couples the
// carrier who WON the work to the truck and driver that EXECUTE it.
//
// D-24 records those as separate facts: the commercial counterparty is whoever's bid
// the shipper accepted, the executing assets are whatever actually rolls, and no
// code may assume they coincide. Today's answer says they must — a fleet dispatches
// its own truck, crewed by a driver holding a live affiliation with it — and that
// answer is UNCHANGED here. What changes is that it is one named question instead of
// two guards sitting a few lines apart, so when sub-contracting lands (post-MVP)
// this is the function that gets relaxed, and a reader can see what today's policy
// IS rather than reconstructing it from the order of the statements around it.
//
// Returns the refusal instead of throwing it, so both facts and their deliberately
// different refusals sit side by side: a truck that is not this carrier's reads as a
// 404 — never as somebody else's truck, which would confirm its existence to a fleet
// that has no business knowing — while a driver without a live affiliation is a 403,
// because the refusal there is about the relationship, not the driver.
//
// NOT a mutual-exclusion check. Whether the truck is FREE is the vehicle_assignments
// insert's job, with D-19's read in front of it for a refusal that names the trip.
// This answers only "whose assets are these".
export async function mayExecuteFor(
  carrier: { fleetOwnerId: string },
  assets: { vehicleId: string; driverId: string },
  lookups: ExecutionLookups = LIVE_LOOKUPS,
): Promise<FleetError | null> {
  // The truck must be the carrier's own. Scoped by fleet_owner_id, so another
  // fleet's truck — or a solo driver's — is indistinguishable from one that does not
  // exist at all.
  const vehicle = await lookups.vehicle(carrier.fleetOwnerId, assets.vehicleId)
  if (!vehicle) return new FleetError('Vehicle not found in this fleet', 'NOT_FOUND', 404)

  // The driver must hold an ACTIVE affiliation with the carrier. Pending, suspended
  // and left drivers cannot be dispatched.
  const affiliation = await lookups.affiliation(carrier.fleetOwnerId, assets.driverId)
  if (!affiliation) return new FleetError('Driver is not an active member of this fleet', 'FORBIDDEN', 403)

  return null
}

/**
 * Decide what an assign must do to a booking that may ALREADY hold a live crew (review F25). An
 * ASSIGNABLE booking can be re-crewed before departure; because vehicle_assignments has a
 * one-live-per-booking index, the prior assignment must be released before the new one inserts.
 * Pure so the rule is unit-testable without a database.
 *   needsRelease  — the booking currently names a crew that differs from the requested one.
 *   driverChanged — that difference includes the driver, so the NEW driver's freeness must be
 *                   proven before the release (a truck-only swap keeps the same, already-held driver).
 */
export function reCrewPlan(
  current: Pick<BookingRow, 'driver_id' | 'vehicle_id'>,
  requested: { driverId: string; vehicleId: string },
): { needsRelease: boolean; driverChanged: boolean } {
  const needsRelease =
    current.driver_id != null &&
    (current.driver_id !== requested.driverId || current.vehicle_id !== requested.vehicleId)
  return { needsRelease, driverChanged: needsRelease && requested.driverId !== current.driver_id }
}

/**
 * assertVehicleWithinCapacity — a truck may not be dispatched under a load heavier than
 * it can carry (founder: "2t truck taking a 5t load"). weight_kg is the shipper's declared
 * load; capacity_tons is the fleet's own spec for the truck (1 t = 1000 kg). Pure so the
 * rule is unit-testable without a database.
 *
 * Enforced ONLY when capacity is KNOWN: a null capacity_tons cannot prove an overload, and
 * refusing on a blank spec would block dispatch on a data-entry gap the fleet may not have
 * filled yet. The fix for that is prompting fleets to record capacity, not failing closed here.
 */
export function assertVehicleWithinCapacity(
  booking: Pick<BookingRow, 'weight_kg'>,
  vehicle: { capacity_tons?: number | null; rc_number?: string | null },
): void {
  if (vehicle.capacity_tons == null) return
  const capacityKg = vehicle.capacity_tons * 1000
  if (booking.weight_kg > capacityKg) {
    const truck = vehicle.rc_number ? `${vehicle.rc_number} ` : 'This truck '
    throw new FleetError(
      `${truck}carries ${vehicle.capacity_tons} t but this load is ` +
      `${(booking.weight_kg / 1000).toFixed(2)} t — assign a bigger truck or split the load`,
      'CAPACITY_EXCEEDED',
      409,
    )
  }
}

/**
 * assertDriverFreeAcrossBookings — refuse a driver who is already carrying a live
 * trip ANYWHERE, not just in this fleet's assignment ledger. Reads bookings by
 * driver_id (solo accepts, direct-attaches and other fleets' dispatches all land
 * there), excludes the booking being crewed (re-crewing your own trip is not a
 * conflict), and names the blocking trip so the dispatcher can act on the refusal.
 */
export async function assertDriverFreeAcrossBookings(
  driverId: string,
  exceptBookingId: string,
): Promise<void> {
  const { data, error } = await getSupabase()
    .from('bookings')
    .select('id, source_address, destination_address, status')
    .eq('driver_id', driverId)
    .neq('id', exceptBookingId)
    .not('status', 'in', `(${TRIP_END_FREE_STATUSES.join(',')})`)
    .limit(1)
  if (error) throw new Error(`bookings select failed: ${error.message}`)

  const trip = asRows<Pick<BookingRow, 'id' | 'source_address' | 'destination_address' | 'status'>>(data)[0]
  if (trip) {
    throw new FleetError(
      `That driver is already on ${trip.source_address} → ${trip.destination_address} ` +
      `(booking ${trip.id}, ${trip.status}) — that trip has to finish or be released first`,
      'CONFLICT',
      409,
    )
  }
}

export async function assignDriverAndVehicle(input: AssignInput): Promise<AssignResult> {
  const supabase = getSupabase()

  // (1) The booking must be THIS fleet's, and in a state that can be crewed.
  const booking = await getFleetBooking(input.fleetOwnerId, input.bookingId)
  if (!booking) throw new FleetError('Booking not found for this fleet', 'NOT_FOUND', 404)
  if (!ASSIGNABLE_STATUSES.includes(booking.status)) {
    throw new FleetError(
      `Booking is '${booking.status}' — a driver and truck can only be assigned to an accepted booking`,
      'INVALID_TRANSITION',
      409,
    )
  }

  // (2) THE SEAM (D-24) — may this truck and this driver execute work won by this
  // carrier? The carrier is the booking's own fleet_owner_id, which (1) has just
  // proved to be input.fleetOwnerId by scoping the read on it; passing it as a named
  // argument is what keeps "who won the work" and "whose assets run it" two facts
  // rather than one. mayExecuteFor is where they are (still) required to coincide.
  const refusal = await mayExecuteFor(
    { fleetOwnerId: input.fleetOwnerId },
    { vehicleId: input.vehicleId, driverId: input.driverId },
  )
  if (refusal) throw refusal

  // (2.5) CAPACITY — the truck must be able to carry the load. mayExecuteFor just proved
  // the truck is this fleet's; re-read it for its capacity (one indexed, tenancy-scoped
  // lookup) and refuse an overload BEFORE we commit a crew. A load exceeding the truck's
  // rated capacity is a booking that cannot lawfully or safely move, so it is refused at
  // the binding point regardless of how the booking arrived (auction award or direct-attach).
  const vehicleForCapacity = await getFleetVehicle(input.fleetOwnerId, input.vehicleId)
  if (vehicleForCapacity) assertVehicleWithinCapacity(booking, vehicleForCapacity)

  // (3) D-19 — the truck is committed to one trip at a time. The insert below is
  // still the authority; this runs first so the dispatcher is told WHICH trip the
  // truck is on, and so a commitment recorded outside vehicle_assignments (a trip
  // still running after its assignment row was released) is seen at all. The
  // booking excludes itself: re-assigning a booking that already holds this truck
  // must not report the truck as taken by that same booking.
  await assertVehicleAvailable(input.vehicleId, { exceptBookingId: input.bookingId })

  // (3.2) D-19 for the DRIVER — including trips the assignment ledger cannot see
  // (review C-2 follow-up). The 0016 per-driver index guards only vehicle_assignments,
  // and a driver on a live SOLO trip has no assignment row: bookings.driver_id is the
  // only record. Until this check, that overlap was caught solely by the 0030 unique
  // index at step (5) — correct, but surfacing as a raw DB error instead of telling
  // the dispatcher WHICH trip holds the driver. Ask the bookings table directly and
  // refuse by name, exactly as (3) does for the truck. The insert and the 0030 index
  // remain the race-proof authority; this is the readable refusal in front of them.
  await assertDriverFreeAcrossBookings(input.driverId, input.bookingId)

  // (3.5) RE-CREW (review F25). An ASSIGNABLE booking may already hold a live crew — the owner is
  // swapping the driver and/or truck before departure (Q13 rules out only MID-TRIP reassignment).
  // vehicle_assignments_one_live_per_booking refuses the new row while the old is live, and
  // releaseFinishedAssignments only sweeps TERMINAL bookings, so without this a re-crew of an
  // 'accepted' booking dead-ends at a 409 with no way out. Release the booking's OWN prior
  // assignment first. This cannot strand the booking: the new vehicle is already proven free
  // above, and when the DRIVER is changing we prove the new driver is free too, so the release is
  // only ever followed by an insert that succeeds. (Re-submitting the SAME crew skips this and
  // falls through to the existing insert path unchanged.)
  const recrew = reCrewPlan(booking, input)
  if (recrew.needsRelease) {
    if (recrew.driverChanged && await hasLiveAssignmentForDriver(input.fleetOwnerId, input.driverId)) {
      throw new FleetError(
        'That driver is already on another live trip — free them before assigning this one',
        'INVALID_TRANSITION',
        409,
      )
    }
    await releaseAssignmentForBooking(input.bookingId)
  }

  // (4) The insert IS the mutual-exclusion check.
  let created = await insertAssignment(input)
  if (!created) {
    // A unique violation can mean two things: a genuine live conflict, or a stale
    // row from a trip that has already ended. Sweep the stale ones (the roll-up
    // hook may never have fired) and try once more before refusing. Note (3) cannot
    // pre-empt this: it treats a live assignment on a finished booking as already
    // released, exactly so a missed hook does not retire the truck here either.
    const swept = await releaseFinishedAssignments(input)
    created = swept ? await insertAssignment(input) : null
    if (!created) {
      throw new FleetError(
        'This booking, truck or driver already has a live assignment — finish or release it before assigning again',
        'INVALID_TRANSITION',
        409,
      )
    }
  }

  // (5) Bind the booking to the crew. bookings.driver_id is what tracking, POD and
  // GPS ingestion key off, so from here the trip is indistinguishable from a solo
  // driver's. Guarded on the status we validated in (1) so a booking that moved on
  // between the two reads is not silently re-crewed.
  const { data: updated, error: updateErr } = await supabase
    .from('bookings')
    .update({ driver_id: input.driverId, vehicle_id: input.vehicleId, updated_at: new Date().toISOString() })
    .eq('id', input.bookingId)
    .eq('fleet_owner_id', input.fleetOwnerId)
    .in('status', ASSIGNABLE_STATUSES)
    .select(BOOKING_COLUMNS)
    .maybeSingle()

  if (updateErr || !updated) {
    // Compensate: an assignment row that no booking points at would permanently
    // block that truck and driver via the partial-unique indexes.
    await releaseAssignment(created.id)
    if (updateErr) {
      // The 0030 one-live-trip-per-driver index refusing the bind is a CONFLICT the
      // dispatcher can act on (the driver is out on another live trip — likely a solo
      // one that raced past the (3.2) pre-check), not an internal failure. Everything
      // else genuinely is one.
      if (updateErr.code === UNIQUE_VIOLATION) {
        throw new FleetError(
          'That driver is already on another live trip — free them before assigning this one',
          'CONFLICT',
          409,
        )
      }
      throw new Error(`bookings update failed: ${updateErr.message}`)
    }
    throw new FleetError('Booking changed state during assignment — retry', 'INVALID_TRANSITION', 409)
  }

  return { assignment: created, booking: asRow<BookingRow>(updated) }
}

// insertAssignment — returns null on a unique violation so the caller can decide
// whether it is a real conflict or a stale row worth sweeping.
async function insertAssignment(input: AssignInput): Promise<VehicleAssignmentRow | null> {
  const { data, error } = await getSupabase()
    .from('vehicle_assignments')
    .insert({
      fleet_owner_id: input.fleetOwnerId,
      booking_id: input.bookingId,
      vehicle_id: input.vehicleId,
      driver_id: input.driverId,
      assigned_by: input.assignedBy,
    })
    .select(ASSIGNMENT_COLUMNS)
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null
    throw new Error(`vehicle_assignments insert failed: ${error.message}`)
  }
  return asRow<VehicleAssignmentRow>(data)
}

// releaseFinishedAssignments — a truck is physically free the moment its trip ends,
// but released_at is normally stamped by the trip-end emit (completed /
// delivery_asserted) or the paid roll-up hook. This closes the gap when either
// hook was missed: any live assignment whose booking has reached a trip-end
// status is released here.
// Returns true if anything was released.
async function releaseFinishedAssignments(input: AssignInput): Promise<boolean> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('vehicle_assignments')
    .select('id, booking_id')
    .eq('fleet_owner_id', input.fleetOwnerId)
    .is('released_at', null)
    .or(`booking_id.eq.${input.bookingId},vehicle_id.eq.${input.vehicleId},driver_id.eq.${input.driverId}`)
  if (error) throw new Error(`vehicle_assignments select failed: ${error.message}`)

  const candidates = asRows<{ id: string; booking_id: string }>(data)
  if (candidates.length === 0) return false

  const { data: bookings, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, status')
    .in('id', candidates.map(c => c.booking_id))
    .in('status', TERMINAL_BOOKING_STATUSES)
  if (bookingErr) throw new Error(`bookings select failed: ${bookingErr.message}`)

  const finished = new Set(asRows<{ id: string }>(bookings).map(b => b.id))
  const stale = candidates.filter(c => finished.has(c.booking_id))
  for (const assignment of stale) await releaseAssignment(assignment.id)
  return stale.length > 0
}

export async function releaseAssignment(assignmentId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('vehicle_assignments')
    .update({ released_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .is('released_at', null)
  if (error) throw new Error(`vehicle_assignments release failed: ${error.message}`)
}

/**
 * Pure filter used by listLiveAssignments (and unit-tested): drop live assignment
 * rows whose booking has already reached a trip-end status.
 */
export function liveAssignmentsAfterTripEndSweep<T extends { booking_id: string }>(
  live: T[],
  bookings: Array<{ id: string; status: string }>,
): T[] {
  const free = new Set(bookings.filter(b => bookingFreesTruck(b.status)).map(b => b.id))
  return live.filter(a => !free.has(a.booking_id))
}

// listLiveAssignments — every un-released assignment for one fleet. Sweeps
// finished trips first (FB-01) so the fleet UI shows trucks free even when the
// trip-end emit or paid roll-up was missed.
export async function listLiveAssignments(fleetOwnerId: string): Promise<VehicleAssignmentRow[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('vehicle_assignments')
    .select(ASSIGNMENT_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
    .is('released_at', null)
  if (error) throw new Error(`vehicle_assignments select failed: ${error.message}`)

  const live = asRows<VehicleAssignmentRow>(data)
  if (live.length === 0) return live

  const { data: bookings, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, status')
    .in('id', live.map(a => a.booking_id))
  if (bookingErr) throw new Error(`bookings select failed: ${bookingErr.message}`)

  const rows = asRows<{ id: string; status: string }>(bookings)
  for (const b of rows) {
    if (bookingFreesTruck(b.status)) await releaseAssignmentForBooking(b.id)
  }
  return liveAssignmentsAfterTripEndSweep(live, rows)
}

export async function hasLiveAssignmentForDriver(fleetOwnerId: string, driverId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('vehicle_assignments')
    .select('id')
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('driver_id', driverId)
    .is('released_at', null)
    .limit(1)
  if (error) throw new Error(`vehicle_assignments select failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

// releaseAssignmentForBooking — called by the trip-economics roll-up: the trip is
// over, so the truck and the driver go back into the pool. Idempotent (the
// released_at IS NULL filter makes a second call a no-op).
export async function releaseAssignmentForBooking(bookingId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('vehicle_assignments')
    .update({ released_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .is('released_at', null)
  if (error) throw new Error(`vehicle_assignments release failed: ${error.message}`)
}
