import { can, relationsToBooking, resolvePersonas } from '@bharattruck/shared/personas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { canFleetAccessBooking, resolveFleetOwnerByUserId } from '@bharattruck/shared/fleet'
import {
  redis,
  driverLocationKey,
  driverBookingKey,
  bookingDriverKey,
  breadcrumbGateKey,
  LOCATION_TTL_SECONDS,
  BREADCRUMB_THROTTLE_SECONDS,
} from '../lib/redis.js'
import { supabase } from '../lib/supabase.js'
import { BookingError, type AuthenticatedUser, type BookingStatus, type DbBooking } from '../lib/types.js'
import * as repo from '../lib/repository.js'
import { emitLocationFix } from '../lib/tracking-emit.js'

const UpdateLocationBody = z.object({
  lat:        z.number().min(-90).max(90),
  lng:        z.number().min(-180).max(180),
  heading:    z.number().min(0).max(360).optional(),
  speed_kmh:  z.number().min(0).optional(),
  accuracy_m: z.number().min(0).optional(),
  booking_id: z.string().uuid().optional(),
})

const DriverIdParam  = z.object({ driver_id:  z.string().uuid() })
const BookingIdParam = z.object({ booking_id: z.string().uuid() })

type LocationData = {
  driver_id:  string
  lat:        number
  lng:        number
  heading:    number | null
  speed_kmh:  number | null
  accuracy_m: number | null
  booking_id: string | null
  updated_at: string
}

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

async function getLocation(driverId: string, bookingId?: string): Promise<LocationData | null> {
  const raw = await redis.get(driverLocationKey(driverId))
  if (!raw) return null
  const loc = JSON.parse(raw) as LocationData
  // A booking-scoped read (GET /location/booking/:id) must reject a fix the driver pushed for a
  // DIFFERENT concurrent trip — the key is per-driver (review F26). The by-driver read passes no
  // bookingId and returns the latest fix as-is. A legacy fix with no booking_id is not filtered.
  if (bookingId && loc.booking_id && loc.booking_id !== bookingId) return null
  return loc
}

// -----------------------------------------------------------
// Read authorization — CLOSED BY DEFAULT.
//
// THE BUG THESE EXIST FOR: both read routes below branched on `role === 'driver'`
// and `role === 'shipper'` and then simply continued. Every other role matched
// NEITHER branch and fell through with no check at all, so a fleet_owner token
// (live since migration 0014) could read ANY driver's current coordinates by
// uuid — a cross-tenant leak of a person's position, not just of a trip.
//
// Now keyed on capabilities + relations (FB-11), mirroring bt-tracking-service's
// assertCanAccess. Fleet reach stays in @bharattruck/shared/fleet so neither
// service can drift. Closed by default — no match reaches the throw.
// -----------------------------------------------------------

async function assertCanAccessBooking(booking: DbBooking, user: AuthenticatedUser): Promise<void> {
  if (user.role === 'admin') return
  const snapshot = await resolvePersonas(supabase, user.userId, user.role)
  const relations = relationsToBooking(booking, snapshot)
  if (relations.includes('shipper') || relations.includes('driver') || relations.includes('carrier')) return
  // Fleet reach beyond direct carrier relation (affiliated assets on this trip).
  const fleet = await resolveFleetOwnerByUserId(supabase, user.userId)
  if (fleet && await canFleetAccessBooking(supabase, fleet.id, booking)) return
  throw new BookingError('Forbidden', 'FORBIDDEN', 403)
}

async function assertCanAccessDriverLocation(driverId: string, user: AuthenticatedUser): Promise<void> {
  // Ops carve-out (no 'admin' capability). Everything else is capability + relation.
  if (user.role === 'admin') return

  const snapshot = await resolvePersonas(supabase, user.userId, user.role)

  // Own live fix: 'drive' capability == drivers row; multi-persona humans keep this
  // even when their JWT role string is shipper/fleet_owner.
  if (snapshot.driver_id === driverId) return

  // Shipper of an active trip this driver is on (userId match, not JWT role).
  if (await shipperHasActiveBookingWithDriver(user.userId, driverId)) return

  // Fleet operate: this route names a PERSON, not a trip — grant is only "this driver
  // is running a trip this fleet may see right now". Employment alone is not enough.
  if (snapshot.fleet_owner_id) {
    for (const booking of await repo.getActiveBookingsForDriver(driverId)) {
      if (await canFleetAccessBooking(supabase, snapshot.fleet_owner_id, booking)) return
    }
    throw new BookingError(
      'You can only view location for drivers currently running a trip for your fleet',
      'FORBIDDEN',
      403,
    )
  }

  throw new BookingError('Forbidden', 'FORBIDDEN', 403)
}

// -----------------------------------------------------------
// Trip association for an incoming fix — MANDATORY.
//
// THE BUG THESE EXIST FOR: booking_id was optional AND every trip/status check
// sat inside `if (booking_id)`, so a payload that simply omitted it skipped all
// of them and still wrote loc:driver:{id}. That cached a driver's position while
// they were off duty, and bt-fleet-service's GET /fleet/live MGETs that key for
// every driver on the roster regardless of assignment — turning a personal phone
// into a tracker the fleet owner could watch on a rest day.
//
// booking_id stays OPTIONAL on the wire so the deployed driver app and the GPS
// test harness keep working unchanged; what is now mandatory is the ASSOCIATION,
// which we resolve server-side when the client did not name a trip.
// -----------------------------------------------------------

// -----------------------------------------------------------
// Location tracking window — when a trip has a position at all.
//
// 'delivery_asserted' IS tracked, and that is a decision, not an oversight. The state
// means the driver claims to have delivered with no receiver to confirm it (migration
// 0025); the trip is NOT over — ops still has to close it, and until they do the truck
// is physically at the drop with cargo possibly still coming off.
//
// Going dark at the moment of assertion would be exactly backwards. The assertion is
// the WEAKEST proof the platform accepts, so the window right after it is when the
// positional record matters most: it is the only thing that can corroborate the driver
// stayed at the address they claimed to deliver to, and — with POD_GEOFENCE_GATE off
// for the pilot — the only thing that can contradict an assertion filed from 40 km out.
// Cutting the trail there would hand a driver a way to erase themselves from the map by
// pressing a button, and would 409 the driver app's 10s poll into a visible error the
// instant they assert. It also keeps this list identical to EVIDENCE_CAPTURABLE in
// lib/pod/service.ts: the camera and the GPS trail that dates its photos stay live
// together, which is the whole basis of the "internally consistent for hours" control.
//
// Tracking still ends at 'completed'/'paid'/'cancelled' — the ops close is the event
// that ends the trip, and it is the same terminal boundary as before 0025.
//
// The list is repo.ACTIVE_TRIP_STATUSES rather than a local copy: it is the SAME
// question ("is this driver on a trip right now?") that resolveDriverActiveBooking and
// the fleet-reach check below already ask. A second list here is how the write path
// starts accepting a fix the read path then refuses to hand back.
// -----------------------------------------------------------

function isLocationTracked(status: BookingStatus): boolean {
  return repo.ACTIVE_TRIP_STATUSES.includes(status)
}

// The client named a trip: it must be this driver's, and it must be live.
async function loadDriverActiveBooking(bookingId: string, driverId: string): Promise<DbBooking> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  if (booking.driver_id !== driverId) throw new BookingError('You are not assigned to this booking', 'FORBIDDEN', 403)
  if (!isLocationTracked(booking.status)) {
    throw new BookingError(
      `Booking is in '${booking.status}' status — location tracking only allowed for ${repo.ACTIVE_TRIP_STATUSES.join(', ')} bookings`,
      'INVALID_TRANSITION',
      409,
    )
  }
  return booking
}

// No trip named: find the one the driver is running. Costs one query — the same
// single booking read the booking_id path has always done — and only on the
// payload shape that omits the field, so the driver app's hot path is unchanged.
async function resolveDriverActiveBooking(driverId: string): Promise<DbBooking> {
  const active = await repo.getActiveBookingsForDriver(driverId)
  if (active.length === 0) {
    throw new BookingError(
      'No active trip — location is only tracked while you are running an accepted or in_transit booking',
      'INVALID_TRANSITION',
      409,
    )
  }
  if (active.length > 1) {
    // Guessing would file this fix and its breadcrumb against the wrong trip, which
    // is worse than making the client say which one it means.
    throw new BookingError(
      'You have more than one active trip — send booking_id to say which one this location belongs to',
      'VALIDATION_ERROR',
      400,
    )
  }
  return active[0]
}

export async function locationRoutes(app: FastifyInstance) {

  // POST /location/update
  app.post('/update', async (req, reply) => {
    const snapshot = await resolvePersonas(supabase, req.user.userId, req.user.role)
    if (!can(snapshot, 'drive')) {
      throw new BookingError('Only drivers can update location', 'FORBIDDEN', 403)
    }

    const parsed = UpdateLocationBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      })
    }

    const { lat, lng, heading, speed_kmh, accuracy_m, booking_id } = parsed.data

    const driverRow = await repo.getDriverByUserId(req.user.userId)
    if (!driverRow) throw new BookingError('Driver profile not found', 'NOT_FOUND', 404)

    const driverId = driverRow.id

    // A location fix is a property of an ACTIVE TRIP, never of a person: past this
    // line there is always a booking, so no path can cache a position for a driver
    // who is off duty. Both helpers refuse rather than fall through.
    const booking = booking_id
      ? await loadDriverActiveBooking(booking_id, driverId)
      : await resolveDriverActiveBooking(driverId)

    const bookingId = booking.id

    // The truck running this booking, when one is bound (fleet trips get it
    // from the owner's assignment step). NULL for every solo booking.
    const vehicleId: string | null = booking.vehicle_id ?? null

    const now = new Date().toISOString()
    const locationData: LocationData = {
      driver_id:  driverId,
      lat,
      lng,
      heading:    heading ?? null,
      speed_kmh:  speed_kmh ?? null,
      accuracy_m: accuracy_m ?? null,
      booking_id: bookingId,
      updated_at: now,
    }

    // The keys stay `loc:driver:{driverId}` on purpose. Re-keying the live fix to
    // the trip is the natural follow-up now that a fix cannot exist without one,
    // but bt-fleet-service (GET /fleet/live) and bt-tracking-service both READ
    // these keys, so it is a coordinated cross-service change and not this PR's.
    const pipeline = redis.pipeline()
    pipeline.set(driverLocationKey(driverId), JSON.stringify(locationData), 'EX', LOCATION_TTL_SECONDS)
    pipeline.set(driverBookingKey(driverId), bookingId, 'EX', LOCATION_TTL_SECONDS)
    pipeline.set(bookingDriverKey(bookingId), driverId, 'EX', LOCATION_TTL_SECONDS)
    await pipeline.exec()

    // Durable dense-GPS breadcrumb (location_history, D-007). Owned here in
    // bt-booking-service; bt-tracking-service only READS it. Throttled to
    // ~1 point / BREADCRUMB_THROTTLE_SECONDS per booking via an atomic
    // SET NX EX gate — the first update in each window wins the insert.
    // Best-effort: a breadcrumb failure must never break live GPS ingestion
    // (Redis above is the source of truth for the live position), so we log
    // and swallow rather than 500 the request. This also lets ingestion keep
    // working before infra's migration 009 lands the table.
    try {
      const fresh = await redis.set(
        breadcrumbGateKey(bookingId), '1', 'EX', BREADCRUMB_THROTTLE_SECONDS, 'NX',
      )
      if (fresh === 'OK') {
        await repo.insertLocationBreadcrumb({
          booking_id:  bookingId,
          driver_id:   driverId,
          // Asset attribution is additive: the key is present only when the
          // booking actually names a truck, so a solo breadcrumb is written
          // exactly as before.
          ...(vehicleId ? { vehicle_id: vehicleId } : {}),
          lat,
          lng,
          heading:     heading ?? null,
          speed_kmh:   speed_kmh ?? null,
          accuracy_m:  accuracy_m ?? null,
          recorded_at: now,
        })

        // Hand the fix to bt-tracking-service's evaluator (D-014) — geofence
        // crossings, route alerts, trip telemetry. Fired INSIDE the breadcrumb
        // gate, not on every update, so evaluation runs at exactly the same
        // ~1/12s cadence as the breadcrumbs it derives from: the telemetry
        // deltas then line up 1:1 with persisted points instead of drifting
        // ahead of them, and a driver polling faster than the throttle cannot
        // multiply the evaluator's write load.
        emitLocationFix(
          {
            booking_id:  bookingId,
            driver_id:   driverId,
            vehicle_id:  vehicleId,
            lat,
            lng,
            speed_kmh:   speed_kmh ?? null,
            heading:     heading ?? null,
            recorded_at: now,
          },
          app.log,
        )
      }
    } catch (err) {
      app.log.warn({ err, driver_id: driverId, booking_id: bookingId }, 'Breadcrumb persist failed (live tracking unaffected)')
    }

    app.log.info({ driver_id: driverId, lat, lng, booking_id: bookingId }, 'Location updated')

    return reply.send({
      success: true,
      data: { driver_id: driverId, lat, lng, booking_id: bookingId, updated_at: now, ttl_seconds: LOCATION_TTL_SECONDS },
    })
  })

  // GET /location/driver/:driver_id
  app.get('/driver/:driver_id', async (req, reply) => {
    const paramParsed = DriverIdParam.safeParse(req.params)
    if (!paramParsed.success) {
      return reply.status(400).send({ success: false, error: paramParsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }

    const { driver_id } = paramParsed.data

    await assertCanAccessDriverLocation(driver_id, req.user)

    const location = await getLocation(driver_id)
    return reply.send({
      success: true,
      data: location,
      ...(location ? {} : { message: 'No recent location available — driver may be offline' }),
    })
  })

  // GET /location/booking/:booking_id
  app.get('/booking/:booking_id', async (req, reply) => {
    const paramParsed = BookingIdParam.safeParse(req.params)
    if (!paramParsed.success) {
      return reply.status(400).send({ success: false, error: paramParsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }

    const { booking_id } = paramParsed.data

    const booking = await repo.getBookingById(booking_id)
    if (!booking) throw new BookingError(`Booking ${booking_id} not found`, 'NOT_FOUND', 404)

    await assertCanAccessBooking(booking, req.user)

    if (!booking.driver_id) {
      return reply.send({ success: true, data: null, message: 'No driver assigned to this booking yet' })
    }

    if (!isLocationTracked(booking.status)) {
      return reply.send({
        success: true,
        data: null,
        message: `Booking is in '${booking.status}' status — live tracking only available for ${repo.ACTIVE_TRIP_STATUSES.join(', ')} bookings`,
      })
    }

    const location = await getLocation(booking.driver_id, booking_id)
    return reply.send({
      success: true,
      data: location,
      ...(location ? {} : { message: 'Driver assigned but no recent location — driver may be offline' }),
    })
  })
}

async function shipperHasActiveBookingWithDriver(shipperId: string, driverId: string): Promise<boolean> {
  // Uses the module-level `supabase` handle now that the authz helpers above need it too;
  // the dynamic import this replaced only ever shadowed the same lazy Proxy client.
  const { data, error } = await supabase
    .from('bookings')
    .select('id')
    .eq('shipper_id', shipperId)
    .eq('driver_id', driverId)
    // Same window as every other "is this trip live?" test here — see the note above
    // ACTIVE_TRIP_STATUSES. A shipper must not lose sight of their driver at the exact
    // moment the driver asserts a delivery they cannot yet confirm.
    .in('status', repo.ACTIVE_TRIP_STATUSES)
    .limit(1)

  if (error) throw new Error(`DB query failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}
