import { getSupabase } from './supabase.js'
import { asRows, FleetError, type BookingRow } from './types.js'
import { TRIP_END_FREE_STATUSES } from './booking-status.js'

// -----------------------------------------------------------
// vehicle-schedule — D-19's read side: is this truck busy, and UNTIL WHEN.
//
// SCOPE NOTE — READ THIS BEFORE ADDING A DATE-WINDOW OVERLAP CHECK HERE.
// D-19 says "the truck carries the schedule; accepting work locks it for the
// window", and the obvious reading is a calendar: refuse a second load whose dates
// overlap, allow one whose dates do not. This module deliberately does NOT do that,
// because the schema makes the state such a check would guard against unreachable,
// and shipping the check anyway would mean shipping a guard whose refusals are all
// already made underneath it, plus prose describing a system we do not have:
//
//   - vehicle_assignments_one_live_per_vehicle (0016) is a partial unique index on
//     (vehicle_id) where released_at is null. It refuses ANY second live assignment
//     on a truck, overlapping or not. An overlap rule in front of it can only ever
//     refuse a SUBSET of what it already refuses — it can never turn an allow into
//     a refusal, which is the only way it could prevent a double-booking.
//   - vehicles_exactly_one_owner (0015) and vehicles_single_owner (0022) both assert
//     num_nonnulls(driver_id, fleet_owner_id) = 1. A truck has exactly ONE owner, so
//     "fleet A and fleet B commit the same truck" is not a hole, it is
//     unrepresentable — and mayExecuteFor scopes every assignment to the
//     owning fleet regardless.
//   - by that same constraint a fleet-owned truck has driver_id NULL, so it has no
//     "own driver" to self-select marketplace work with; a driver-owned truck has
//     fleet_owner_id NULL, so no fleet can assign it.
//   - fleet_drivers_one_live_per_driver (0015) still permits a driver only ONE live
//     affiliation, so D-8's multi-fleet driver does not exist in the schema yet
//     either.
//
// What is genuinely unanswerable today is "the truck is busy — until when?". The
// index is a bit: on trip or idle, with no horizon. That is what this module adds,
// so an owner can plan the next load, plus a refusal that names the trip the truck
// is on instead of "already has a live assignment". When D-8 actually lands in the
// schema, the overlap check becomes worth writing — with the 0016 index relaxed in
// the same migration, since it is what makes the check dead today.
//
// THE ONE RULE: is_free here means exactly what the 0016 index means — no live
// commitment, for any dates. Answering from date windows instead would report a
// truck free for the 20th while it is out on the 10th, and then watch the
// assignment call for the 20th fail on the index every single time. An availability
// API that can disagree with the assignment API is worse than no availability API.
// -----------------------------------------------------------

// A truck's day is not the UTC day. pickup_date is a plain calendar date keyed in
// by an Indian shipper, so anchoring it at UTC midnight would date the estimate from
// 18:30 the evening before — half a working day wrong, every time.
const IST_START_OF_DAY = 'T00:00:00+05:30'

const DAY_MS = 24 * 60 * 60 * 1000

const EARTH_RADIUS_KM = 6371
// Straight-line km underestimates road distance. Same 1.3 circuity factor
// economics.ts and bt-pricing-service/src/lib/geo.ts use — the FROZEN maps rule
// keeps the Google server key in bt-tracking-service alone, so no other service may
// ask Routes for a real road distance.
const ROAD_WINDING_FACTOR = 1.3

// What a loaded truck actually covers in a day on the pilot corridor: driving-hour
// reality plus halts, not vehicle speed. Overridable because it is a fleet operating
// fact, not a constant. It shapes an ESTIMATE shown to a planner and nothing else —
// no assignment is ever allowed or refused on the strength of it, so getting it
// wrong costs a misleading date, not a trip that cannot run.
const DEFAULT_KM_PER_DAY = 300

function kmPerDay(): number {
  const raw = Number(process.env.TRUCK_SCHEDULE_KM_PER_DAY)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KM_PER_DAY
}

// One commitment holding a truck. `source` records which table proved it:
// 'assignment' is a fleet dispatch, 'booking' is a trip still running while its
// assignment row is gone (see buildSchedule).
export type ScheduleEntry = {
  booking_id: string
  assignment_id: string | null
  source: 'assignment' | 'booking'
  status: string
  description: string
  // Estimated moment the truck comes back into the pool. NULL means unknown — no
  // usable pickup_date, or a trip we cannot date — never "free now". The truck is
  // occupied until released_at is stamped; this is a planning hint, not the release.
  estimated_free_from: string | null
}

// Once a booking reaches one of these the truck is free again. Same list
// assignment.ts sweeps on, kept in step deliberately: a status that frees the truck
// there but not here would make the two guards disagree about the same trip.
const TERMINAL_BOOKING_STATUSES = TRIP_END_FREE_STATUSES as unknown as string[]

const SCHEDULE_BOOKING_COLUMNS =
  'id, vehicle_id, source_address, source_lat, source_lng, destination_address, ' +
  'dest_lat, dest_lng, pickup_date, status'

type ScheduleBooking = Pick<
  BookingRow,
  'id' | 'vehicle_id' | 'source_address' | 'source_lat' | 'source_lng' |
  'destination_address' | 'dest_lat' | 'dest_lng' | 'pickup_date' | 'status'
>

type LiveAssignment = {
  id: string
  booking_id: string
  released_at: string | null
}

// -----------------------------------------------------------
// Pure date arithmetic, kept free of the database so it is testable without one.
// -----------------------------------------------------------

function toMs(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

export function istStartOfDay(date: string): string | null {
  const ms = toMs(`${date}${IST_START_OF_DAY}`)
  return ms === null ? null : new Date(ms).toISOString()
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * How many days this trip is expected to take the truck out of the pool.
 *
 * Coordinates that are not usable fall back to ONE day rather than to a very long
 * estimate. Nothing is refused on this number, so the cost of being wrong is a date
 * an owner plans around; a data defect quietly reporting a truck busy for a fortnight
 * is the more damaging way to be wrong.
 */
export function transitDays(booking: Pick<ScheduleBooking, 'source_lat' | 'source_lng' | 'dest_lat' | 'dest_lng'>): number {
  // Typed unknown, not number: BookingRow describes the columns as NOT NULL, but the
  // live DB is the authority here (see types.ts) and legacy rows predate that.
  const raw: unknown[] = [booking.source_lat, booking.source_lng, booking.dest_lat, booking.dest_lng]
  // Number(null) is 0, not NaN. Screening for nullish BEFORE the cast is what stops
  // a missing coordinate reading as the Gulf of Guinea and turning a Mumbai pickup
  // into a fortnight-long estimate. PostgREST can hand numerics back as strings, so
  // the cast itself has to stay.
  if (raw.some(v => v === null || v === undefined || v === '')) return 1
  const coords = raw.map(Number)
  if (!coords.every(Number.isFinite)) return 1
  const km = haversineKm(coords[0], coords[1], coords[2], coords[3]) * ROAD_WINDING_FACTOR
  return Math.max(1, Math.ceil(km / kmPerDay()))
}

/**
 * When this trip is expected to hand the truck back.
 *
 * NULL when the booking has no usable pickup_date — unknown, and reported as such.
 * Guessing "now" would show a loaded truck as free tomorrow, and guessing far out
 * would park it indefinitely in the planner; an owner who is told "busy, return date
 * unknown" can go and look at the trip.
 */
export function estimatedFreeFrom(
  booking: Pick<ScheduleBooking, 'pickup_date' | 'source_lat' | 'source_lng' | 'dest_lat' | 'dest_lng'>,
): string | null {
  const start = typeof booking.pickup_date === 'string' && booking.pickup_date
    ? istStartOfDay(booking.pickup_date)
    : null
  if (!start) return null
  return new Date(Date.parse(start) + transitDays(booking) * DAY_MS).toISOString()
}

function describeBooking(booking: Pick<ScheduleBooking, 'source_address' | 'destination_address' | 'pickup_date'>): string {
  const lane = `${booking.source_address} → ${booking.destination_address}`
  return booking.pickup_date ? `${lane}, pickup ${booking.pickup_date}` : lane
}

// -----------------------------------------------------------
// Reads. Deliberately NOT fleet-scoped: the truck is held by whoever committed it,
// and the caller has already proved tenancy on the vehicle itself.
// -----------------------------------------------------------

/**
 * Turn raw rows into the list of commitments currently holding this truck.
 *
 * Two sources, because neither alone is complete:
 *   - vehicle_assignments — the fleet dispatch, which the 0016 index caps at one;
 *   - non-terminal bookings holding this vehicle_id with no live assignment row —
 *     a trip still on the road after its assignment was released (a swept stale row,
 *     or the roll-up firing on a booking whose status later moved backwards).
 *     Reading assignments alone would show that truck as free while it is loaded,
 *     and this is the ONE case where this module refuses something the 0016 index
 *     does not catch.
 *
 * The two rules that free a truck — released_at is stamped, or the trip reached a
 * terminal status — are applied HERE and not only in the WHERE clause. The SQL
 * filters are an index-backed narrowing so the query stays cheap; this is where the
 * rule itself lives, in one place, exercisable without a database.
 */
export function buildSchedule(
  vehicleId: string,
  assignments: LiveAssignment[],
  bookings: ScheduleBooking[],
): ScheduleEntry[] {
  const byId = new Map(bookings.map(b => [b.id, b]))
  const entries: ScheduleEntry[] = []
  const claimed = new Set<string>()

  for (const assignment of assignments) {
    if (assignment.released_at !== null) continue
    const booking = byId.get(assignment.booking_id)
    // A live assignment on a finished trip is a stale row, not a commitment — the
    // same judgement releaseFinishedAssignments makes when it sweeps them, and the
    // reason a missed roll-up hook does not retire a truck. An assignment whose
    // booking could not be read stays blocking: unreadable is not evidence of
    // freedom.
    if (booking && TERMINAL_BOOKING_STATUSES.includes(booking.status)) continue
    claimed.add(assignment.booking_id)
    entries.push({
      booking_id: assignment.booking_id,
      assignment_id: assignment.id,
      source: 'assignment',
      status: booking?.status ?? 'unknown',
      description: booking ? describeBooking(booking) : 'a trip that is no longer readable',
      estimated_free_from: booking ? estimatedFreeFrom(booking) : null,
    })
  }

  for (const booking of bookings) {
    // vehicle_id is re-checked because the caller also fetches bookings by id (to
    // name the trips its assignments point at); one of those may have been
    // re-crewed onto a different truck and must not block this one.
    if (booking.vehicle_id !== vehicleId) continue
    if (claimed.has(booking.id) || TERMINAL_BOOKING_STATUSES.includes(booking.status)) continue
    entries.push({
      booking_id: booking.id,
      assignment_id: null,
      source: 'booking',
      status: booking.status,
      description: describeBooking(booking),
      estimated_free_from: estimatedFreeFrom(booking),
    })
  }

  return entries
}

/**
 * The date the truck is expected to be free, across every commitment holding it.
 *
 * A single unknown makes the whole answer unknown. Reporting the latest KNOWN date
 * while one commitment has no return date at all would hand a planner a date the
 * truck may well blow straight through — worse than admitting we cannot say.
 */
export function scheduleFreeFrom(entries: ScheduleEntry[]): string | null {
  if (entries.length === 0) return null
  let latest = 0
  for (const entry of entries) {
    const ms = toMs(entry.estimated_free_from)
    if (ms === null) return null
    if (ms > latest) latest = ms
  }
  return new Date(latest).toISOString()
}

export async function listVehicleCommitments(vehicleId: string): Promise<ScheduleEntry[]> {
  const supabase = getSupabase()

  const [assignmentsRes, bookingsRes] = await Promise.all([
    supabase
      .from('vehicle_assignments')
      .select('id, booking_id, released_at')
      .eq('vehicle_id', vehicleId)
      .is('released_at', null),
    supabase
      .from('bookings')
      .select(SCHEDULE_BOOKING_COLUMNS)
      .eq('vehicle_id', vehicleId)
      .not('status', 'in', `(${TERMINAL_BOOKING_STATUSES.join(',')})`),
  ])
  if (assignmentsRes.error) throw new Error(`vehicle_assignments select failed: ${assignmentsRes.error.message}`)
  if (bookingsRes.error) throw new Error(`bookings select failed: ${bookingsRes.error.message}`)

  const assignments = asRows<LiveAssignment>(assignmentsRes.data)
  const bookings = asRows<ScheduleBooking>(bookingsRes.data)

  // An assignment can point at a booking that no longer names this vehicle (the
  // booking update in assignDriverAndVehicle is a second, non-transactional write),
  // so the trips those rows describe still have to be fetched to be named — and to
  // be recognised as finished.
  const known = new Set(bookings.map(b => b.id))
  const unfetched = assignments.map(a => a.booking_id).filter(id => !known.has(id))
  if (unfetched.length > 0) {
    const { data, error } = await supabase
      .from('bookings')
      .select(SCHEDULE_BOOKING_COLUMNS)
      .in('id', unfetched)
    if (error) throw new Error(`bookings select failed: ${error.message}`)
    bookings.push(...asRows<ScheduleBooking>(data))
  }

  return buildSchedule(vehicleId, assignments, bookings)
}

export type VehicleAvailability = {
  vehicle_id: string
  is_free: boolean
  // Only ever set when is_free is false: the estimated date the truck returns, or
  // null if that cannot be estimated. A free truck's answer is "now", which this
  // field does not try to express — is_free already says it.
  estimated_free_from: string | null
  commitments: ScheduleEntry[]
}

/**
 * is_free is the COUNT of commitments and nothing else — never a date comparison.
 *
 * This is the line that keeps availability and assignment from contradicting each
 * other, so it is a named function rather than an inline expression: it can be
 * asserted on without a database, and a future change that starts asking "free
 * BETWEEN these dates" has to come through here and past that test. The reason it
 * must stay a count is that vehicle_assignments_one_live_per_vehicle refuses a
 * second live assignment on ANY dates, so any date-sensitive answer here is a slot
 * this service promises and the very next call refuses.
 */
export function summariseAvailability(vehicleId: string, commitments: ScheduleEntry[]): VehicleAvailability {
  return {
    vehicle_id: vehicleId,
    is_free: commitments.length === 0,
    estimated_free_from: scheduleFreeFrom(commitments),
    commitments,
  }
}

/**
 * Is this truck free, and if not, when is it expected back.
 *
 * There is no date range to ask about, and that is the point — see
 * summariseAvailability.
 *
 * `exceptBookingId` excludes the trip being asked about from its own answer — the
 * caller re-checking a booking that already holds this truck must not be told the
 * truck is taken by itself.
 */
export async function getVehicleAvailability(
  vehicleId: string,
  opts: { exceptBookingId?: string } = {},
): Promise<VehicleAvailability> {
  const commitments = (await listVehicleCommitments(vehicleId))
    .filter(e => e.booking_id !== opts.exceptBookingId)
  return summariseAvailability(vehicleId, commitments)
}

/**
 * Refuse an assignment onto a truck that is already committed.
 *
 * This does NOT add a refusal the database would not make — 0016's partial unique
 * index refuses the same insert a moment later, and being a read-then-write check
 * this one cannot win a race against a second dispatcher anyway. It runs for two
 * reasons the index cannot serve:
 *   - "already has a live assignment" tells a dispatcher nothing they can act on,
 *     whereas the lane, pickup date and booking id of the blocking trip tell them
 *     immediately whether to release it or pick another truck;
 *   - a booking still running with no live assignment row holds the truck
 *     physically but violates no index, and is refused here and nowhere else.
 */
export async function assertVehicleAvailable(
  vehicleId: string,
  opts: { exceptBookingId?: string } = {},
): Promise<void> {
  const conflict = (await getVehicleAvailability(vehicleId, opts)).commitments[0]
  if (!conflict) return

  const until = conflict.estimated_free_from
    ? ` (expected free ${conflict.estimated_free_from.slice(0, 10)})`
    : ''
  throw new FleetError(
    `This truck is already on ${conflict.description} (booking ${conflict.booking_id}, ` +
    `${conflict.status})${until} — release that trip or assign another truck`,
    'INVALID_TRANSITION',
    409,
  )
}
