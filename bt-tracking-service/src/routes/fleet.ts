import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { resolveFleetOwnerByUserId } from '@bharattruck/shared/fleet'
import { supabase } from '../lib/supabase.js'
import { redis, driverLocationKey } from '../lib/redis.js'
import { fixMatchesBooking } from '../lib/live-fix.js'
import { loadNorms, resolveMileageFrom, computeFuel } from '../lib/fuel.js'
import * as repo from '../lib/repository.js'
import { TrackingError, type AuthenticatedUser, type LiveLocation } from '../lib/types.js'

// -----------------------------------------------------------
// The fleet owner's tracking surface (mounted at /tracking/fleet).
//
// WHY THIS EXISTS ALONGSIDE bt-fleet-service's GET /fleet/live: that endpoint is
// DRIVER-centric — it starts from the fleet's driver set, so a truck with nobody assigned
// to it does not appear on the map at all. For an owner's dashboard that is backwards. The
// trucks earning nothing in the yard are precisely the ones costing money, and a board that
// silently omits them reads as "all good" while half the fleet is idle.
//
// So this starts from `vehicles`. Every asset the owner has is a row, always. A missing
// driver, trip, or GPS fix becomes an explicit STATUS and REASON on that truck rather than
// a dropped row — the owner should always be able to see the difference between "this truck
// is fine and parked" and "this truck should be moving and we have lost it".
//
// COST: one Redis MGET and a bounded set of Postgres queries per poll, independent of fleet
// size. Deliberately NO Google call — route and ETA stay lazy, one selected truck at a time,
// exactly as bt-fleet-service's own cost note requires (§3.1 §6.4).
// -----------------------------------------------------------

/**
 * A Redis position key lives 30 s (LOCATION_TTL_SECONDS in booking-service). Treat anything
 * within 90 s as live: that survives one missed poll and a slow write without flapping the
 * board between "moving" and "lost signal" while a truck passes under a flyover.
 */
const LIVE_WINDOW_SECONDS = 90
/** Matches the evaluator's MOVING_KMH and the existing fleet map page. */
const MOVING_KMH = 5
/**
 * The booking statuses in which a GPS fix is EXPECTED — the mirror of
 * ACTIVE_TRIP_STATUSES in bt-booking-service/src/lib/repository.ts, which is what
 * /location/update actually enforces. The two must agree: this list only decides what
 * the owner is TOLD, so a list that is narrower than the ingester's turns a truck that
 * is reporting normally into "assigned, not started" and sends the owner chasing a
 * driver who is doing nothing wrong.
 *
 * 'delivery_asserted' is in it because ingestion accepts it: the driver has claimed a
 * delivery the receiver could not confirm and ops has not closed the trip yet, so the
 * truck is still at the drop and still reporting (migration 0025).
 */
const GPS_EXPECTED_STATUSES = ['accepted', 'in_transit', 'delivery_asserted']

type VehicleStatus =
  | 'moving'
  | 'idle'
  | 'no_signal'
  | 'assigned_not_started'
  | 'parked'
  | 'inactive'

type HealthLevel = 'ok' | 'degraded' | 'missing'

// Authorization here is by ASSET, not by the JWT `role` string (D-27): completing fleet
// registration creates the `fleet_owners` row, and that row IS the 'operate' tenant identity —
// whatever the account's primary persona. A distributor who runs their own trucks reaches this
// surface exactly as a dedicated fleet owner does, and neither one is gated on a role enum.
//
// The admin case is unchanged and still carries the known quirk: an ops admin with no fleet
// profile of their own resolves to null and gets a 404, because this surface has no "all fleets"
// view and no way to name a target fleet. Fixing it would mean threading an explicit fleet id
// through /overview and the geofence routes — a cross-tenant ops board is a separate endpoint,
// not a widening of this one — so it stays a documented quirk rather than a cheap fix.
async function requireFleetOwner(user: AuthenticatedUser) {
  const fleet = await resolveFleetOwnerByUserId(supabase, user.userId)
  if (!fleet) {
    throw new TrackingError(
      'No fleet profile found for this account. Complete fleet registration first.',
      'NOT_FOUND',
      404,
    )
  }
  return fleet
}

/**
 * Classify one truck and explain the classification.
 *
 * The `reason` strings are the product here, not decoration. "No data" on a logistics
 * dashboard is worse than useless — the owner cannot tell whether the driver forgot to open
 * the app, the truck is legitimately parked, or the platform is broken. Each branch below
 * names the actual cause and, where the owner can act, what to do about it.
 */
function classify(args: {
  isActive: boolean
  hasAssignment: boolean
  bookingStatus: string | null
  position: LiveLocation | null
  positionAgeSeconds: number | null
  lastFixAt: string | null
}): { status: VehicleStatus; status_label: string; health: HealthLevel; reason: string } {
  const { isActive, hasAssignment, bookingStatus, position, positionAgeSeconds, lastFixAt } = args

  if (!isActive) {
    return {
      status: 'inactive',
      status_label: 'Inactive',
      health: 'ok',
      reason: 'This truck is marked inactive in your fleet, so it is not being tracked.',
    }
  }

  if (!hasAssignment) {
    return {
      status: 'parked',
      status_label: 'Parked',
      health: 'ok',
      reason: 'Not assigned to a trip. Assign it to a booking to start tracking.',
    }
  }

  // The truck has a live assignment but its booking row could not be read. That is a
  // PLATFORM fault, not a driver one, and it must not be dressed up as a trip-status
  // message — the owner would go chase a driver over our bug.
  if (bookingStatus === null) {
    return {
      status: 'assigned_not_started',
      status_label: 'Assigned',
      health: 'degraded',
      reason:
        'Assigned to a trip, but we could not load that trip just now. Live location may be delayed — this is a platform issue, not a driver one.',
    }
  }

  // Assigned, but the trip has not reached a state where GPS is expected. booking-service
  // rejects /location/update outside GPS_EXPECTED_STATUSES, so absence of a fix here is
  // correct behaviour, not a fault.
  if (!GPS_EXPECTED_STATUSES.includes(bookingStatus)) {
    return {
      status: 'assigned_not_started',
      status_label: 'Assigned',
      health: 'ok',
      reason: `Assigned to a trip that is still '${bookingStatus}'. Live location starts once the trip is accepted.`,
    }
  }

  if (!position || positionAgeSeconds === null || positionAgeSeconds > LIVE_WINDOW_SECONDS) {
    // "Last reported" must quote the FRESHEST evidence we hold, not just the telemetry
    // rollup. A position can outlive the 90 s live window while still being far newer than
    // the last persisted breadcrumb (breadcrumbs are throttled to ~1/12 s and the rollup
    // lags), and quoting the older of the two produced a row that said "last reported
    // 73 min ago" directly above a live "58 km/h" — self-contradictory, and it would send an
    // owner chasing a driver who is plainly on the road.
    const candidates = [position?.updated_at, lastFixAt]
      .filter((t): t is string => typeof t === 'string')
      .map((t) => new Date(t).getTime())
      .filter((t) => Number.isFinite(t))

    // Distinguishing "never reported" from "stopped reporting" is the whole point: the first
    // is a setup problem the owner can fix by calling the driver, the second is usually a
    // network dead zone that will resolve itself.
    if (candidates.length === 0) {
      return {
        status: 'no_signal',
        status_label: 'No signal',
        health: 'missing',
        reason:
          'This truck has never reported a location on this trip. Ask the driver to open the driver app and allow location access.',
      }
    }

    const mins = Math.round((Date.now() - Math.max(...candidates)) / 60000)
    return {
      status: 'no_signal',
      status_label: 'No signal',
      health: 'degraded',
      reason: `Last reported ${mins < 1 ? 'less than a minute' : `${mins} min`} ago. The driver app may be closed or out of network coverage.`,
    }
  }

  const speed = position.speed_kmh ?? 0
  if (speed >= MOVING_KMH) {
    return {
      status: 'moving',
      status_label: 'Moving',
      health: 'ok',
      reason: `On the move at ${Math.round(speed)} km/h.`,
    }
  }
  return {
    status: 'idle',
    status_label: 'Stopped',
    health: 'ok',
    reason: 'Reporting location but not moving — likely a halt, a checkpoint, or loading.',
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

const GeofenceBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['depot', 'warehouse', 'checkpoint', 'custom']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().int().min(50).max(50000),
})

const IdParam = z.object({ id: z.string().uuid() })

export async function fleetTrackingRoutes(app: FastifyInstance) {
  /**
   * GET /tracking/fleet/overview — every truck in the fleet, with live position, current
   * trip, telemetry, fuel and open alerts.
   *
   * This is the dashboard's single call. It is deliberately not cached in Redis: the payload
   * is per-fleet and already cheap (one MGET + ~6 bounded queries), and an 8 s cache on a
   * 10 s poll would mostly serve the owner a stale board for no saved work.
   */
  app.get('/overview', async (req, reply) => {
    const fleet = await requireFleetOwner(req.user)

    const [vehicles, assignments, norms] = await Promise.all([
      repo.listFleetVehicles(fleet.id),
      repo.listLiveAssignments(fleet.id),
      loadNorms(),
    ])

    const assignmentByVehicle = new Map(assignments.map((a) => [a.vehicle_id, a]))
    const bookingIds = assignments.map((a) => a.booking_id)
    const driverIds = [...new Set(assignments.map((a) => a.driver_id))]

    const [bookings, telemetry, alerts, identities, positions] = await Promise.all([
      repo.getBookingsForRoster(bookingIds),
      repo.getTelemetryForBookings(bookingIds),
      repo.getOpenAlertsForBookings(bookingIds),
      repo.hydrateDriverIdentities(driverIds),
      // One MGET for the whole fleet — never a per-vehicle round trip.
      driverIds.length ? redis.mget(driverIds.map(driverLocationKey)) : Promise.resolve([]),
    ])

    const positionByDriver = new Map<string, LiveLocation>()
    driverIds.forEach((id, i) => {
      const raw = positions[i]
      if (raw) {
        try {
          positionByDriver.set(id, JSON.parse(raw) as LiveLocation)
        } catch {
          // A malformed value is indistinguishable from no value for our purposes; the
          // truck simply reads as no_signal rather than taking the whole board down.
        }
      }
    })

    const now = Date.now()

    const rows = vehicles.map((v) => {
      const assignment = assignmentByVehicle.get(v.id) ?? null
      const booking = assignment ? bookings.get(assignment.booking_id) ?? null : null
      const tel = assignment ? telemetry.get(assignment.booking_id) ?? null : null
      const driver = assignment ? identities.get(assignment.driver_id) ?? null : null
      const rawPosition = assignment ? positionByDriver.get(assignment.driver_id) ?? null : null
      // The per-driver fix may belong to the driver's OTHER concurrent trip; only surface it on
      // the board against the booking it was actually pushed for (review F26).
      const position = assignment && rawPosition && fixMatchesBooking(rawPosition, assignment.booking_id)
        ? rawPosition : null

      const positionAgeSeconds = position ? Math.round((now - new Date(position.updated_at).getTime()) / 1000) : null

      const state = classify({
        isActive: v.is_active,
        hasAssignment: assignment !== null,
        bookingStatus: booking?.status ?? null,
        position,
        positionAgeSeconds,
        lastFixAt: tel?.last_fix_at ?? null,
      })

      // Rated economy is a property of the TRUCK, so it is reported even when parked — an
      // owner comparing assets wants it on every row, not only the ones on the road.
      const mileage = resolveMileageFrom(norms, v)

      const drivenKm = (tel?.distance_m ?? 0) / 1000
      const tripFuel =
        drivenKm > 0
          ? computeFuel({ distanceKm: drivenKm, lookup: mileage, overridden: [] })
          : null

      return {
        vehicle_id: v.id,
        rc_number: v.rc_number,
        maker_model: v.maker_model,
        model_category: v.model_category,
        emission_norm: v.emission_norm,
        body_type: v.body_type,
        capacity_tons: v.capacity_tons,
        is_active: v.is_active,
        current_odometer_km: v.current_odometer_km,
        rc_expiry: v.rc_expiry,

        status: state.status,
        status_label: state.status_label,
        data_health: { level: state.health, reason: state.reason },

        driver: driver
          ? { driver_id: driver.driver_id, name: driver.full_name, phone: driver.phone_number }
          : null,

        booking: booking
          ? {
              booking_id: booking.id,
              status: booking.status,
              source_address: booking.source_address,
              dest_address: booking.dest_address,
              pickup_date: booking.pickup_date,
              destination: { lat: booking.dest_lat, lng: booking.dest_lng },
            }
          : null,

        position: position
          ? {
              lat: position.lat,
              lng: position.lng,
              heading: position.heading,
              speed_kmh: position.speed_kmh,
              updated_at: position.updated_at,
              age_seconds: positionAgeSeconds,
            }
          : null,

        trip: tel
          ? {
              driven_km: round1(drivenKm),
              moving_hours: round2(tel.moving_seconds / 3600),
              idle_hours: round2(tel.idle_seconds / 3600),
              night_hours: round2(tel.night_seconds / 3600),
              avg_moving_speed_kmh:
                tel.moving_seconds > 0 ? round1(tel.speed_sum_kmh_s / tel.moving_seconds) : null,
              max_speed_kmh: round1(tel.max_speed_kmh),
              stop_count: tel.stop_count,
              speeding_fixes: tel.speeding_count,
              max_deviation_m: Math.round(tel.max_deviation_m),
              point_count: tel.point_count,
              last_fix_at: tel.last_fix_at,
            }
          : null,

        fuel: {
          mileage_kmpl: round2(mileage.mileage_kmpl),
          basis: mileage.basis,
          basis_note: mileage.basis_note,
          trip: tripFuel
            ? {
                distance_km: tripFuel.distance_km,
                litres: tripFuel.litres_required,
                diesel_cost_inr: tripFuel.diesel_cost_inr,
                def_cost_inr: tripFuel.def_cost_inr,
                total_cost_inr: tripFuel.estimated_fuel_cost_inr,
              }
            : null,
        },

        alerts: assignment ? alerts.get(assignment.booking_id) ?? [] : [],
      }
    })

    const count = (s: VehicleStatus) => rows.filter((r) => r.status === s).length

    return reply.send({
      success: true,
      data: {
        fleet_owner_id: fleet.id,
        company_name: fleet.company_name,
        generated_at: new Date().toISOString(),
        summary: {
          vehicle_count: rows.length,
          moving: count('moving'),
          idle: count('idle'),
          no_signal: count('no_signal'),
          assigned_not_started: count('assigned_not_started'),
          parked: count('parked'),
          inactive: count('inactive'),
          on_trip: rows.filter((r) => r.booking !== null).length,
          alert_count: rows.reduce((s, r) => s + r.alerts.length, 0),
          // Total diesel currently committed across every running trip — the number an
          // owner watches day to day.
          trip_fuel_cost_inr: round2(
            rows.reduce((s, r) => s + (r.fuel.trip?.total_cost_inr ?? 0), 0),
          ),
          driven_km: round1(rows.reduce((s, r) => s + (r.trip?.driven_km ?? 0), 0)),
        },
        vehicles: rows,
      },
    })
  })

  // ── geofence management ────────────────────────────────────────────────────

  app.get('/geofences', async (req, reply) => {
    const fleet = await requireFleetOwner(req.user)
    return reply.send({ success: true, data: await repo.listGeofences(fleet.id) })
  })

  app.post('/geofences', async (req, reply) => {
    const fleet = await requireFleetOwner(req.user)
    const parsed = GeofenceBody.safeParse(req.body)
    if (!parsed.success) throw new TrackingError(parsed.error.errors[0].message, 'VALIDATION_ERROR', 400)

    const created = await repo.createGeofence({ fleet_owner_id: fleet.id, ...parsed.data })
    return reply.status(201).send({ success: true, data: created })
  })

  app.delete('/geofences/:id', async (req, reply) => {
    const fleet = await requireFleetOwner(req.user)
    const parsed = IdParam.safeParse(req.params)
    if (!parsed.success) throw new TrackingError('Invalid geofence id', 'VALIDATION_ERROR', 400)

    // Scoped delete: the fleet filter is in the query, so one owner cannot remove another's
    // fence by guessing an id — a miss is a 404, never someone else's row.
    const deleted = await repo.deleteGeofence(fleet.id, parsed.data.id)
    if (!deleted) throw new TrackingError('Geofence not found', 'NOT_FOUND', 404)
    return reply.send({ success: true, data: { id: parsed.data.id, deleted: true } })
  })
}
