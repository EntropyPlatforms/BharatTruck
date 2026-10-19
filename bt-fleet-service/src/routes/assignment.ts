import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getActiveDriverIds, hydrateDriverIdentities } from '../lib/fleet-repo.js'
import { requireFleetAccess } from '../lib/fleet-access.js'
import { assignDriverAndVehicle, listFleetBookings, listLiveAssignments } from '../lib/assignment.js'
import { listFleetVehicles } from '../lib/vehicles-repo.js'
import { driverLocationKey, fleetDriversKey, getRedis, type LivePosition } from '../lib/redis.js'
import { parseOrThrow } from '../lib/types.js'

// -----------------------------------------------------------
// assignmentRoutes — the pairing step, the fleet booking list, and the live map
// (mounted at /fleet).
// -----------------------------------------------------------

const AssignBody = z.object({
  driver_id: z.string().uuid('driver_id must be a valid UUID'),
  vehicle_id: z.string().uuid('vehicle_id must be a valid UUID'),
})

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })

const BookingListQuery = z.object({
  status: z.string().trim().min(1).max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function assignmentRoutes(app: FastifyInstance) {
  // POST /fleet/bookings/:id/assign — { driver_id, vehicle_id }.
  //
  // driver_id here is drivers.id, NOT users.id: it is the value the roster returns
  // and the value bookings.driver_id / the Redis loc:* keys use.
  app.post('/bookings/:id/assign', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'dispatch')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(AssignBody, req.body)

    const result = await assignDriverAndVehicle({
      fleetOwnerId: owner.id,
      bookingId: params.id,
      driverId: body.driver_id,
      vehicleId: body.vehicle_id,
      assignedBy: req.user.userId,
    })

    return reply.status(201).send({
      success: true,
      data: { assignment: result.assignment, booking: result.booking },
    })
  })

  // GET /fleet/bookings — fleet-scoped booking list.
  app.get('/bookings', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const query = parseOrThrow(BookingListQuery, req.query)

    const [bookings, live] = await Promise.all([
      listFleetBookings(owner.id, query),
      listLiveAssignments(owner.id),
    ])
    const assignmentByBooking = new Map(live.map(a => [a.booking_id, a]))

    return reply.send({
      success: true,
      data: bookings.map(b => ({ ...b, current_assignment: assignmentByBooking.get(b.id) ?? null })),
    })
  })

  // GET /fleet/live — EVERY truck's position in ONE SMEMBERS + ONE MGET.
  //
  // This is the endpoint the whole Redis-set design exists for. A per-driver
  // fan-out (or worse, a Google-backed /tracking call per vehicle) is 100 req/s at
  // 1000 trucks on a 10s poll. Route and ETA stay LAZY — one selected vehicle at a
  // time, fetched by the client from bt-tracking-service.
  app.get('/live', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const redis = getRedis()

    // Self-heal: a cold or evicted set would otherwise render an empty map for a
    // fleet that is very much on the road.
    let driverIds = await redis.smembers(fleetDriversKey(owner.id))
    if (driverIds.length === 0) {
      driverIds = await getActiveDriverIds(owner.id)
      if (driverIds.length > 0) await redis.sadd(fleetDriversKey(owner.id), ...driverIds)
    }

    const [live, vehicles] = await Promise.all([
      listLiveAssignments(owner.id),
      listFleetVehicles(owner.id),
    ])

    const positions = driverIds.length === 0
      ? []
      : await redis.mget(driverIds.map(driverLocationKey))

    const assignmentByDriver = new Map(live.map(a => [a.driver_id, a]))
    const rcByVehicle = new Map(vehicles.map(v => [v.id, v.rc_number]))
    const identities = await hydrateDriverIdentities(driverIds)

    const data = driverIds.map((driverId, i) => {
      const raw = positions[i]
      // A missing key means the 30s TTL lapsed: the driver is offline, not lost.
      const position = raw ? (JSON.parse(raw) as LivePosition) : null
      const assignment = assignmentByDriver.get(driverId) ?? null
      return {
        driver_id: driverId,
        driver_name: identities.get(driverId)?.full_name ?? null,
        vehicle_id: assignment?.vehicle_id ?? null,
        rc_number: assignment ? rcByVehicle.get(assignment.vehicle_id) ?? null : null,
        booking_id: assignment?.booking_id ?? position?.booking_id ?? null,
        is_online: position !== null,
        lat: position?.lat ?? null,
        lng: position?.lng ?? null,
        heading: position?.heading ?? null,
        speed_kmh: position?.speed_kmh ?? null,
        updated_at: position?.updated_at ?? null,
      }
    })

    return reply.send({
      success: true,
      data: {
        fleet_owner_id: owner.id,
        driver_count: data.length,
        online_count: data.filter(d => d.is_online).length,
        on_trip_count: live.length,
        positions: data,
      },
    })
  })
}
