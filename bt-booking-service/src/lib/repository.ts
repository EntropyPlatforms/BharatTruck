import { supabase } from './supabase.js'
import { consigneeSchemaNotMigrated, isConsigneeSchemaMissing } from './consignee/repository.js'
import { BookingError } from './types.js'
import type {
  AuthenticatedUser,
  BookingStatus,
  BookingWithProfiles,
  CreateBookingBody,
  DbBooking,
} from './types.js'

// -----------------------------------------------------------
// createBooking
// Inserts a new pending booking. Shipper identity comes from
// the authenticated actor — never from the request body.
//
// consigneeUserId is the users.id already resolved by the service layer (linked
// to an existing party, or a fresh unclaimed record) — null when the caller took
// the legacy receiver_email-only path.
// -----------------------------------------------------------

// Geocoding columns (D-020 / migration 0035). Each is included ONLY when the client actually
// sent it — the same "omit entirely, never write null" trick the consignee columns use — so a
// legacy client (hand-typed coords, no place_id) writes the exact column set it always has and
// keeps working on a database where 0035 has not landed.
const GEOCODE_FIELDS = [
  'source_place_id', 'source_pincode', 'source_state_code',
  'dest_place_id', 'dest_pincode', 'dest_state_code',
  'source_gate_lat', 'source_gate_lng', 'dest_gate_lat', 'dest_gate_lng',
] as const

function geocodeColumns(body: CreateBookingBody): Record<string, unknown> {
  const cols: Record<string, unknown> = {}
  for (const f of GEOCODE_FIELDS) {
    const v = (body as Record<string, unknown>)[f]
    if (v !== undefined) cols[f] = v
  }
  return cols
}

export async function createBooking(
  body: CreateBookingBody,
  actor: AuthenticatedUser,
  quotedPrice: number,
  consigneeUserId: string | null = null,
): Promise<DbBooking> {
  // Fetch shipper profile from DB — JWT only carries userId + role
  const { data: userRow } = await supabase
    .from('users')
    .select('full_name, phone_number, email')
    .eq('id', actor.userId)
    .single()

  const shipperName    = userRow?.full_name ?? userRow?.email ?? 'Unknown'
  const shipperContact = userRow?.phone_number ?? userRow?.email ?? ''

  const { data, error } = await supabase
    .from('bookings')
    .insert({
      shipper_id:           actor.userId,
      shipper_name:         shipperName,
      shipper_contact:      shipperContact,
      source_address:       body.source_address,
      source_lat:           body.source_lat,
      source_lng:           body.source_lng,
      destination_address:  body.destination_address,
      dest_lat:             body.dest_lat,
      dest_lng:             body.dest_lng,
      load_type:            body.load_type,
      weight_kg:            body.weight_kg,
      quoted_price:         quotedPrice,
      pickup_date:          body.pickup_date,
      pickup_time_slot:     body.pickup_time_slot ?? null,
      special_instructions: body.special_instructions ?? null,
      // Still written, and still the address bt-cargo-ledger emails the POD code
      // to. Taken from the consignee's email when one was given, so a client that
      // has moved to `consignee` keeps the POD flow working unchanged. It is
      // NEVER read off a LINKED party's profile — echoing a stranger's stored
      // email back onto the caller's booking would turn "post a load naming this
      // phone number" into an address-lookup oracle.
      receiver_email:       body.consignee?.email ?? body.receiver_email ?? null,
      booking_type:         body.booking_type ?? 'direct',
      target_driver_id:     body.target_driver_id ?? null,
      auction_deadline:     body.auction_deadline ?? null,
      dimensions_json:      body.dimensions_json ?? null,
      status:               'pending',
      // Omitted ENTIRELY when there is no consignee, rather than sent as null —
      // the same trick LocationBreadcrumb uses for vehicle_id. A legacy
      // receiver_email-only create therefore writes the exact column set it
      // always has and keeps working on a database where 0026 has not landed.
      ...(consigneeUserId ? { consignee_user_id: consigneeUserId } : {}),
      // Only the geocode columns the client actually sent (see geocodeColumns) — a legacy
      // hand-typed create writes none of them and works on a pre-0035 database.
      ...geocodeColumns(body),
    })
    .select('*')
    .single()

  if (error) {
    // A create that NAMES a consignee on a pre-0026 database. Loud 503 naming
    // the migration, never a silent drop: the consignee is the party the goods
    // are for and the only contact that can close the trip, so pretending the
    // booking was recorded correctly is the one outcome worse than failing.
    if (consigneeUserId && isConsigneeSchemaMissing(error)) {
      throw consigneeSchemaNotMigrated('Recording a booking with a consignee')
    }
    throw new Error(`DB insert failed: ${error.message}`)
  }
  return data as DbBooking
}

// -----------------------------------------------------------
// deleteBooking
// Compensation for the quote-lock saga: if consuming the price-lock
// fails AFTER the booking row was inserted, roll the just-created
// booking back so it never becomes visible to anyone. Guarded on the
// PRE-ACCEPTED statuses (a fresh booking is 'pending'; an auction one may
// have moved to 'negotiating') — broadening past 'pending' shrinks the
// insert→consume interleaving window. Any pre-accepted booking has no
// payments/payouts/location_history FKs yet, so this delete is safe; once a
// driver has accepted, the guard intentionally no longer matches.
// -----------------------------------------------------------

const PRE_ACCEPTED_STATUSES: BookingStatus[] = ['pending', 'negotiating']

export async function deleteBooking(bookingId: string): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('id', bookingId)
    .in('status', PRE_ACCEPTED_STATUSES)

  if (error) throw new Error(`DB delete failed: ${error.message}`)
}

// -----------------------------------------------------------
// getBookingById
// Returns the booking with nested driver + user profile.
// Uses .maybeSingle() so null is returned (not thrown) on miss.
// -----------------------------------------------------------

export async function getBookingById(id: string): Promise<BookingWithProfiles | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      *,
      driver:drivers!bookings_driver_id_fkey (
        id,
        truck_number,
        truck_type,
        truck_capacity_kg,
        average_rating,
        total_trips,
        user:users!drivers_user_id_fkey (
          id,
          full_name,
          phone_number
        )
      )
    `)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(`DB select failed: ${error.message}`)
  return data as BookingWithProfiles | null
}

// -----------------------------------------------------------
// ACTIVE_TRIP_STATUSES / getActiveBookingsForDriver
//
// The trips a driver is CURRENTLY executing. This is the server-side answer to
// "which trip does this GPS fix belong to?" and to "is this driver on a trip at
// all right now?" — the two questions that make a live position a property of a
// TRIP rather than of a person.
//
// Normally 0 or 1 row. Two is legitimate and reachable (one booking accepted
// while another is already in_transit), so the caller — not this query — decides
// what an ambiguous pair means. Ordered most-recently-touched first.
//
// driverId is drivers.id, NOT the JWT's users.id (see the identity gotcha in
// CLAUDE.md); bookings.driver_id references drivers(id).
// -----------------------------------------------------------

// 'delivery_asserted' (migration 0025) is ACTIVE. The driver has claimed a delivery
// the receiver could not confirm, and ops — not the driver — closes it; until they do,
// the truck is still at the drop and the trip still has a position. Ending the trip at
// the assertion would let a driver drop off the map by pressing a button, precisely on
// the branch that carries the WEAKEST proof and therefore needs the trail most. Inert
// on a pre-0025 database, where no booking can hold this status.
export const ACTIVE_TRIP_STATUSES: BookingStatus[] = ['accepted', 'in_transit', 'delivery_asserted']

export async function getActiveBookingsForDriver(driverId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('driver_id', driverId)
    .in('status', ACTIVE_TRIP_STATUSES)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`DB active-trip lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listBookings
// Role-scoped: shipper→own rows, driver→see below, admin→all.
//
// `driver` is passed ONLY for a caller the service has already resolved to a
// drivers row, and it decides which slice of the board that driver gets:
//   fleet-employed → their assignments ONLY (they have no load board, Q14)
//   solo           → the open 'pending' pool PLUS the trips already theirs
// Absent driverId + canBrowseMarketplace → pending board only (fleet/ops
// carriers browsing without being the assigned driver). Absent both → only
// shipper_id=self (FB-11: a JWT 'driver' with no drivers row sees nothing).
//
// driverId is drivers.id, NOT the JWT's users.id: bookings.driver_id
// references drivers(id) (see the auth/identity gotcha in CLAUDE.md).
// -----------------------------------------------------------

export type DriverListScope = {
  driverId:        string
  /**
   * True only for an EMPLOYEE: affiliated to a fleet AND owning no truck.
   *
   * Was `fleetAffiliated`, which was too broad — it also caught the owner-driver
   * whose own truck is attached to a fleet, and took away the load board they
   * are entitled to. Ownership, not affiliation, is what decides
   * (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §1.1). Resolved by isEmployedDriver().
   */
  employed:        boolean
}

export type BookingListScope =
  | { kind: 'admin' }
  | {
      kind: 'persona'
      userId: string
      driverId: string | null
      employed: boolean
      canBrowseMarketplace: boolean
    }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Guards an id destined for an interpolated PostgREST .or() term. See listBookingsForScope. */
function scopeUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`refusing to build booking scope filter with a non-uuid ${field}`)
  }
  return value
}

export async function listBookingsForScope(scope: BookingListScope): Promise<DbBooking[]> {
  let query = supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false })

  if (scope.kind === 'admin') {
    const { data, error } = await query
    if (error) throw new Error(`DB list failed: ${error.message}`)
    return (data ?? []) as DbBooking[]
  }

  // The .or() grammar is string-interpolated and supabase-js does NOT escape its contents,
  // so on this tenant-isolation filter the ids must be hard-guarded as UUIDs — not merely
  // assumed to be. bookings.shipper_id/driver_id are uuid columns and userId is the JWT
  // subject, so a non-uuid here means a malformed token, never legitimate input; refuse it
  // rather than let a PostgREST metacharacter inject an extra OR-term into the scope.
  const parts: string[] = [`shipper_id.eq.${scopeUuid(scope.userId, 'userId')}`]
  if (scope.driverId) {
    parts.push(`driver_id.eq.${scopeUuid(scope.driverId, 'driverId')}`)
    if (!scope.employed && scope.canBrowseMarketplace) parts.push('status.eq.pending')
  } else if (scope.canBrowseMarketplace) {
    parts.push('status.eq.pending')
  }

  query = query.or(parts.join(','))
  const { data, error } = await query
  if (error) throw new Error(`DB list failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

/** @deprecated Prefer listBookingsForScope — kept for older e2e suites.
 *  Scopes from capabilities when possible; JWT role is only the admin carve-out
 *  and a last-resort fallback for suites that do not resolve personas. */
export async function listBookings(
  actor: AuthenticatedUser,
  driver?: DriverListScope,
): Promise<DbBooking[]> {
  if (actor.role === 'admin') return listBookingsForScope({ kind: 'admin' })
  // Fallback for deprecated callers: treat role as a coarse persona hint.
  // New code must go through service.listBookings → listBookingsForScope.
  if (actor.role === 'shipper') {
    return listBookingsForScope({
      kind: 'persona', userId: actor.userId, driverId: null, employed: false, canBrowseMarketplace: false,
    })
  }
  if (actor.role === 'driver') {
    return listBookingsForScope({
      kind: 'persona', userId: actor.userId,
      driverId: driver?.driverId ?? null, employed: driver?.employed ?? false,
      // Only a resolved (non-employed) driver browses the board; a 'driver' token with no
      // drivers row sees nothing but their own posts (matches the header contract).
      canBrowseMarketplace: driver ? !driver.employed : false,
    })
  }
  if (actor.role === 'fleet_owner') {
    return listBookingsForScope({
      kind: 'persona', userId: actor.userId, driverId: null, employed: false, canBrowseMarketplace: true,
    })
  }
  throw new Error(`listBookings: unhandled role ${actor.role}`)
}

// -----------------------------------------------------------
// acceptBooking
// Atomically sets driver_id + transitions to 'accepted'.
// The WHERE status='pending' guard is optimistic concurrency:
// only one driver wins when two race to accept the same booking.
//
// award_path='instant' is written in THIS statement, not a follow-up UPDATE.
// The column defaults to 'auction' (migration 0022), so a self-accepted load
// used to be recorded as though it had been through an auction that never ran —
// and a second statement can fail on its own and leave the row claiming a
// history it does not have. One statement means the carrier and the story of how
// they got the trip commit together or not at all.
// -----------------------------------------------------------

export async function acceptBooking(
  bookingId: string,
  driverId: string,
): Promise<DbBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      driver_id:  driverId,
      status:     'accepted',
      award_path: 'instant',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB accept failed: ${error.message}`)
  return data as DbBooking | null
}

// -----------------------------------------------------------
// transitionBookingStatus
// Atomically moves a booking fromStatus → toStatus for the
// booking assigned to driverId. The WHERE status=fromStatus AND
// driver_id=driverId guard is optimistic concurrency + a
// defence-in-depth ownership check on top of the service-layer
// 403: only the assigned driver, and only from the expected
// state, wins the update. Returns null if nothing matched
// (state changed underneath us, or not the assigned driver).
// -----------------------------------------------------------

export async function transitionBookingStatus(
  bookingId: string,
  driverId: string,
  fromStatus: BookingStatus,
  toStatus: BookingStatus,
): Promise<DbBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      status:     toStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .eq('status', fromStatus)
    .eq('driver_id', driverId)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB transition failed: ${error.message}`)
  return data as DbBooking | null
}

// -----------------------------------------------------------
// insertLocationBreadcrumb
// Durable dense-GPS breadcrumb write for location_history
// (migration 009, owned by bt-booking-service per D-007).
// Column shape matches docs/MAPS_TRACKING_PLAN.md §4.1 so the
// bt-tracking-service reader and infra's migration 009 line up.
// -----------------------------------------------------------

// vehicle_id (migration 016) attributes the movement to the ASSET as well as
// the person, which is what makes per-truck distance utilization computable for
// a fleet. It is OPTIONAL and omitted entirely when the booking names no
// vehicle: a solo booking then writes the exact same column set it always has,
// which also keeps ingestion working on a database where 016 has not landed.
export type LocationBreadcrumb = {
  booking_id:  string
  driver_id:   string
  vehicle_id?: string
  lat:         number
  lng:         number
  heading:     number | null
  speed_kmh:   number | null
  accuracy_m:  number | null
  recorded_at: string
}

export async function insertLocationBreadcrumb(row: LocationBreadcrumb): Promise<void> {
  const { error } = await supabase.from('location_history').insert(row)
  if (error) throw new Error(`DB breadcrumb insert failed: ${error.message}`)
}

// -----------------------------------------------------------
// cancelBooking
// Cancels from any of the provided statuses (caller decides
// which statuses are valid — business rule stays in service).
// -----------------------------------------------------------

export async function cancelBooking(
  bookingId: string,
  cancellableStatuses: BookingStatus[],
): Promise<DbBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      status:     'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .in('status', cancellableStatuses)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB cancel failed: ${error.message}`)
  return data as DbBooking | null
}

// -----------------------------------------------------------
// setReceiverEmail
// The ONLY write path for bookings.receiver_email after creation.
//
// Until this existed the column was settable exactly once, inside createBooking,
// and there was no way to correct or supply it later — so any booking created
// before the field became mandatory (or through ops/seed) could never reach
// 'completed' through POD, because the driver's OTP request has no address to
// send to. The driver app told the shipper to "add one"; the platform had no
// route that could.
//
// Guarded on status by the CALLER (service.ts) rather than here, so the repo
// stays a thin data layer. The optimistic `in` filter on status is a second
// line: it stops a booking that reached a terminal state between the caller's
// read and this write from being edited anyway.
// -----------------------------------------------------------

export async function setReceiverEmail(
  bookingId: string,
  receiverEmail: string,
  allowedStatuses: BookingStatus[],
): Promise<BookingWithProfiles | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({ receiver_email: receiverEmail, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .in('status', allowedStatuses)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB update receiver_email failed: ${error.message}`)
  return data as BookingWithProfiles | null
}

// -----------------------------------------------------------
// getDriverByUserId
// Bridge: JWT gives us users.id; accept/cancel need drivers.id.
// -----------------------------------------------------------

export async function getDriverByUserId(
  userId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('drivers')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(`Driver lookup failed: ${error.message}`)
  return data
}

// -----------------------------------------------------------
// getDriverById
// Validate that a drivers.id exists (used by ops reassign).
// -----------------------------------------------------------

export async function getDriverById(
  driverId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('drivers')
    .select('id')
    .eq('id', driverId)
    .maybeSingle()

  if (error) throw new Error(`Driver lookup failed: ${error.message}`)
  return data
}

// -----------------------------------------------------------
// forceTransitionByStatus
// Ops override: atomically move a booking to toStatus from any of the
// allowed source statuses, WITHOUT the assigned-driver guard (ops acts on
// behalf of the platform). Optimistic on status only — returns null if the
// booking is not in one of fromStatuses (already moved / illegal source).
// -----------------------------------------------------------

export async function forceTransitionByStatus(
  bookingId: string,
  fromStatuses: BookingStatus[],
  toStatus: BookingStatus,
): Promise<DbBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      status:     toStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .in('status', fromStatuses)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB force-transition failed: ${error.message}`)
  return data as DbBooking | null
}

// -----------------------------------------------------------
// reassignDriver
// Ops override: set bookings.driver_id, keeping the current status. Status-scoped by the caller
// (`allowedStatuses`) so the swap lands ONLY on an in-flight booking — a booking that transitioned
// out of an allowed status between the service read and this write matches no row and returns null.
// -----------------------------------------------------------

export async function reassignDriver(
  bookingId: string,
  driverId: string,
  allowedStatuses: BookingStatus[],
): Promise<DbBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      driver_id:  driverId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .in('status', allowedStatuses)
    .select('*')
    .maybeSingle()

  if (error) {
    // The ops override deliberately skips the availability pre-check, so the 0030
    // one-live-trip-per-driver index is the guard that fires when the target driver is
    // already out. That refusal is a CONFLICT ops can act on — pick another driver or
    // release the blocking trip — not an internal failure (review C-2 follow-up).
    if (error.code === '23505') {
      throw new BookingError(
        'That driver is already on another live trip — release it before reassigning them',
        'CONFLICT',
        409,
      )
    }
    throw new Error(`DB reassign failed: ${error.message}`)
  }
  return data as DbBooking | null
}
