import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { canFleetAccessBooking } from '@bharattruck/shared/fleet'
import { resolvePersonas, relationsToBooking } from '@bharattruck/shared/personas'
import { supabase } from '../lib/supabase.js'
import { liveFixForBooking } from '../lib/live-fix.js'
import {
  redis,
  driverLocationKey,
  routeKey,
  etaKey,
  pumpsKey,
  historyKey,
  ROUTE_TTL_SECONDS,
  ETA_TTL_SECONDS,
  PUMPS_TTL_SECONDS,
  HISTORY_TTL_SECONDS,
} from '../lib/redis.js'
import { getOrCompute, computeAndSet } from '../lib/cache.js'
import { computeRoute, computeEta, searchPetrolPumps, type ComputedRoute } from '../lib/google.js'
import {
  getBookingForTracking,
  getBookingFleetColumns,
  getBookingConsignee,
  upsertTripRoute,
  getAlerts,
  getLocationHistory,
  getStoredRoute,
  getTelemetry,
  listGeofenceEvents,
  getVehicleForFuel,
  type GeofenceEventRow,
} from '../lib/repository.js'
import { decodePolyline, distanceToPolylineMeters, haversineMeters } from '../lib/geo.js'
import { resolveMileage, computeFuel } from '../lib/fuel.js'
import {
  OFF_ROUTE_METERS,
  IDLE_SECONDS,
  NEAR_DROP_METERS,
  SPEEDING_KMH,
} from '../lib/evaluator.js'
import { relationGrantsTracking } from '../lib/access.js'
import {
  TrackingError,
  type AuthenticatedUser,
  type TrackingBooking,
  type LiveLocation,
} from '../lib/types.js'

const BookingIdParam = z.object({ bookingId: z.string().uuid() })

// §3.1 §4.3 pins the default at 500 and the ceiling at 2000. A 1400 km trip at ~1 point
// per 12 s is ~7000 breadcrumbs, so the cap is a real truncation, not a formality — the
// response reports point_count so a caller can page with `since` when it hits the ceiling.
const HISTORY_DEFAULT_LIMIT = 500

const HistoryQuery = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(HISTORY_DEFAULT_LIMIT),
})

const PumpsQuery = z.object({
  // 8 is LOCKED by D-011 as the default; the cap keeps one caller from widening the Places
  // bill for everyone.
  limit: z.coerce.number().int().min(1).max(20).default(8),
  radius_m: z.coerce.number().int().min(500).max(50000).default(5000),
})

const FuelQuery = z.object({
  vehicle_class: z.enum(['SCV', 'LCV', 'MCV', 'HCV']).optional(),
  mileage_kmpl: z.coerce.number().positive().max(50).optional(),
  diesel_price: z.coerce.number().positive().max(1000).optional(),
  distance_km: z.coerce.number().nonnegative().max(10000).optional(),
})

function parseBookingId(params: unknown): string {
  const parsed = BookingIdParam.safeParse(params)
  if (!parsed.success) throw new TrackingError('Invalid bookingId', 'VALIDATION_ERROR', 400)
  return parsed.data.bookingId
}

async function loadBookingOrThrow(bookingId: string): Promise<TrackingBooking> {
  const booking = await getBookingForTracking(bookingId)
  if (!booking) throw new TrackingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  return booking
}

// Authz: who may read a booking's tracking is decided by the caller's RELATION to that booking
// plus their capabilities (D-27), never by the JWT `role` string — the role gates are being
// removed platform-wide (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §10.3). resolvePersonas answers
// "who is this human and what do they own" once; relationsToBooking answers "what are they to
// THIS trip". A single-persona user resolves to exactly the relation their old role granted, so
// every existing allow/deny is preserved; a multi-capability human (a distributor who ships AND
// carries with their own fleet, an owner-driver) additionally gets the relations the role string
// used to hide. Closed by default — no relation and no fleet reach is a 403.
//
// The fleet reach is deliberately NOT folded into relationsToBooking: it is broader than a direct
// fleet_owner_id match (an owned truck, an assignment in history, an affiliated driver on an
// unowned trip) and is the one tenant-isolation rule, so it stays in @bharattruck/shared/fleet
// where booking/payment/fleet cannot drift from it.
async function assertCanAccess(booking: TrackingBooking, user: AuthenticatedUser): Promise<void> {
  // Admin keeps its platform-wide bypass — an ops user is not a tenant of any one booking, so no
  // persona resolution applies to them.
  if (user.role === 'admin') return

  // The JWT role is passed only as resolvePersonas' `primaryPersona` (the caller's default
  // surface, users.primary_persona under an honest name) — it is NOT an authorization axis here.
  // consignee_user_id is read alongside, off the hot-path select, for the same pre-migration
  // reason as the fleet columns (see getBookingConsignee).
  const [snapshot, consigneeUserId] = await Promise.all([
    resolvePersonas(supabase, user.userId, user.role),
    getBookingConsignee(booking.id),
  ])

  const relations = relationsToBooking(
    { shipper_id: booking.shipper_id, driver_id: booking.driver_id, consignee_user_id: consigneeUserId },
    snapshot,
  )
  if (relationGrantsTracking(relations, booking.status)) return

  // Only a caller with a real fleet_owners row (the 'operate' tenant identity) can reach a
  // booking indirectly through its truck or driver. A caller without one has no fleet to check.
  if (snapshot.fleet_owner_id) {
    // fleet_owner_id / vehicle_id are read HERE, not in the shared booking select, so a pre-0016
    // database cannot break the shipper and driver paths. See getBookingFleetColumns.
    const fleetCols = await getBookingFleetColumns(booking.id)
    if (await canFleetAccessBooking(supabase, snapshot.fleet_owner_id, { ...booking, ...fleetCols })) {
      return
    }
  }

  throw new TrackingError('Forbidden', 'FORBIDDEN', 403)
}

// READ-ONLY: live fix written by bt-booking-service into loc:driver:{id}.
async function getLiveLocation(driverId: string, bookingId: string): Promise<LiveLocation | null> {
  // Booking-scoped: the per-driver key is shared across a driver's concurrent trips, so a fix
  // pushed for a DIFFERENT booking must not be returned here (review F26).
  return liveFixForBooking(bookingId, await redis.get(driverLocationKey(driverId)))
}

function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} hr ${mm} min` : `${h} hr`
}

function routeResponse(route: ComputedRoute, cached: boolean) {
  return {
    polyline: route.polyline,
    distance_m: route.distance_m,
    static_duration_s: route.static_duration_s,
    bounds: route.bounds,
    cached,
  }
}

async function computeRouteFor(booking: TrackingBooking): Promise<ComputedRoute> {
  const route = await computeRoute(
    { lat: booking.source_lat, lng: booking.source_lng },
    { lat: booking.dest_lat, lng: booking.dest_lng },
  )
  // Durable backup — best-effort; a DB hiccup must not fail the response.
  await upsertTripRoute(booking.id, route).catch(() => {})
  return route
}

type EtaData = {
  eta_s: number
  eta_text: string
  remaining_m: number
  traffic: string
  computed_at: string
  stale: boolean
}

async function freshEta(booking: TrackingBooking, live: LiveLocation): Promise<EtaData> {
  const e = await computeEta(
    { lat: live.lat, lng: live.lng },
    { lat: booking.dest_lat, lng: booking.dest_lng },
  )
  const data: EtaData = {
    eta_s: e.eta_s,
    eta_text: fmtDuration(e.eta_s),
    remaining_m: e.remaining_m,
    traffic: e.traffic,
    computed_at: new Date().toISOString(),
    stale: false,
  }
  await redis.set(etaKey(booking.id), JSON.stringify(data), 'EX', ETA_TTL_SECONDS)
  return data
}

export async function trackingRoutes(app: FastifyInstance) {
  // #1 POST /tracking/route/:bookingId — force compute + cache
  app.post('/route/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const route = await computeAndSet(routeKey(bookingId), ROUTE_TTL_SECONDS, () => computeRouteFor(booking))
    return reply.send({ success: true, data: routeResponse(route, false) })
  })

  // #2 GET /tracking/route/:bookingId — cached (computes if missing)
  app.get('/route/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const { value, cached } = await getOrCompute(routeKey(bookingId), ROUTE_TTL_SECONDS, () =>
      computeRouteFor(booking),
    )
    return reply.send({ success: true, data: routeResponse(value, cached) })
  })

  // #3 GET /tracking/eta/:bookingId — traffic-aware live ETA (Pro tier, D-003)
  app.get('/eta/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const live = booking.driver_id ? await getLiveLocation(booking.driver_id, bookingId) : null
    if (live) {
      return reply.send({ success: true, data: await freshEta(booking, live) })
    }
    // Offline: return the last cached ETA, marked stale (contract §3).
    const cached = await redis.get(etaKey(bookingId))
    if (cached) {
      return reply.send({ success: true, data: { ...(JSON.parse(cached) as EtaData), stale: true } })
    }
    throw new TrackingError('Driver location unavailable', 'NO_LOCATION', 404)
  })

  // #8 GET /tracking/track/:bookingId — the read-through (location + route + eta)
  app.get('/track/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const live = booking.driver_id ? await getLiveLocation(booking.driver_id, bookingId) : null
    const { value: route } = await getOrCompute(routeKey(bookingId), ROUTE_TTL_SECONDS, () =>
      computeRouteFor(booking),
    )

    // ETA: reuse the cached value (TTL 45s) if present; else compute when live.
    let eta: EtaData | null = null
    const cachedEta = await redis.get(etaKey(bookingId))
    if (cachedEta) {
      eta = { ...(JSON.parse(cachedEta) as EtaData), stale: !live }
    } else if (live) {
      eta = await freshEta(booking, live)
    }

    const alerts = await getAlerts(bookingId)

    return reply.send({
      success: true,
      data: {
        booking_id: booking.id,
        status: booking.status,
        location: live
          ? {
              lat: live.lat,
              lng: live.lng,
              heading: live.heading,
              speed_kmh: live.speed_kmh,
              updated_at: live.updated_at,
            }
          : null,
        route: { polyline: route.polyline, distance_m: route.distance_m, bounds: route.bounds },
        eta,
        destination: { lat: booking.dest_lat, lng: booking.dest_lng },
        alerts,
      },
    })
  })

  // #3 GET /tracking/history/:bookingId — traveled breadcrumb trail (§3.1 §4.3).
  //
  // READ-ONLY on location_history (D-007). Empty is a legitimate answer — a booking whose
  // driver has not started moving returns point_count 0, never a 404, so the map's trail
  // layer has one code path instead of two.
  app.get('/history/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const q = HistoryQuery.safeParse(req.query)
    if (!q.success) throw new TrackingError(q.error.errors[0].message, 'VALIDATION_ERROR', 400)

    // Only the unfiltered first page is cached; a `since` cursor is per-caller and would
    // poison the shared key for everyone else on the same booking.
    const cacheable = !q.data.since && q.data.limit === HISTORY_DEFAULT_LIMIT

    const load = async () => {
      const points = await getLocationHistory(bookingId, { since: q.data.since, limit: q.data.limit })
      return { point_count: points.length, points }
    }

    if (!cacheable) {
      return reply.send({ success: true, data: { booking_id: bookingId, ...(await load()), cached: false } })
    }

    const { value, cached } = await getOrCompute(historyKey(bookingId), HISTORY_TTL_SECONDS, load)
    return reply.send({ success: true, data: { booking_id: bookingId, ...value, cached } })
  })

  // #4 GET /tracking/pumps/:bookingId — top-8 nearest petrol pumps (§3.1 §4.4, D-011).
  //
  // Anchored at the truck's live position, degrading to its last breadcrumb and then to the
  // pickup point. A driver whose GPS just dropped still needs to find diesel, and pumps near
  // the last known position beat an error page.
  app.get('/pumps/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const q = PumpsQuery.safeParse(req.query)
    if (!q.success) throw new TrackingError(q.error.errors[0].message, 'VALIDATION_ERROR', 400)

    const anchor = await resolvePumpAnchor(booking)

    // Cached on the ROUNDED anchor, not the booking: a truck doing 60 km/h leaves a 5 km
    // search radius in five minutes, so a booking-keyed cache would hand back pumps well
    // behind the driver. ~1.1 km cells at 2 decimal places, which is the right granularity
    // for a fuel stop and still collapses a whole dhaba stop into one Places call.
    const cell = `${anchor.point.lat.toFixed(2)},${anchor.point.lng.toFixed(2)}`
    const key = `${pumpsKey(bookingId)}:${cell}:${q.data.limit}:${q.data.radius_m}`

    const { value, cached } = await getOrCompute(key, PUMPS_TTL_SECONDS, async () => {
      const found = await searchPetrolPumps(anchor.point, q.data.radius_m, q.data.limit)
      return found
        .map((p) => ({ ...p, distance_m: Math.round(haversineMeters(anchor.point, { lat: p.lat, lng: p.lng })) }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, q.data.limit)
    })

    return reply.send({
      success: true,
      data: {
        booking_id: bookingId,
        origin: anchor.point,
        origin_source: anchor.source,
        limit: q.data.limit,
        radius_m: q.data.radius_m,
        pump_count: value.length,
        pumps: value,
        cached,
      },
    })
  })

  // #5 GET /tracking/fuel/:bookingId — fuel + DEF estimate (§3.1 §4.5, D-009/D-015).
  //
  // Pure arithmetic, no Google call. Distance defaults to the cached route's planned
  // distance; once the truck has actually driven, `basis=driven` uses real telemetry, which
  // is the number that matches the diesel actually burned.
  app.get('/fuel/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const q = FuelQuery.safeParse(req.query)
    if (!q.success) throw new TrackingError(q.error.errors[0].message, 'VALIDATION_ERROR', 400)

    const overridden: string[] = []
    for (const k of ['distance_km', 'mileage_kmpl', 'diesel_price', 'vehicle_class'] as const) {
      if (q.data[k] !== undefined) overridden.push(k)
    }

    const distance = await resolveFuelDistance(bookingId, q.data.distance_km)
    const fleetCols = await getBookingFleetColumns(bookingId)
    const vehicle = await getVehicleForFuel(fleetCols.vehicle_id)
    const lookup = await resolveMileage(vehicle)

    const estimate = computeFuel({
      distanceKm: distance.km,
      lookup,
      mileageOverride: q.data.mileage_kmpl,
      dieselPriceOverride: q.data.diesel_price,
      overridden,
    })

    return reply.send({
      success: true,
      data: {
        booking_id: bookingId,
        vehicle_id: fleetCols.vehicle_id,
        distance_basis: distance.basis,
        distance_note: distance.note,
        ...estimate,
      },
    })
  })

  // #6 GET /tracking/alerts/:bookingId — route alerts (§3.1 §4.6, D-012).
  //
  // Two halves, deliberately. `alerts` is the DURABLE log the evaluator wrote at the moment
  // each condition crossed its threshold — the only record that survives the truck moving on.
  // `current` is recomputed here from the live position, so a booking whose evaluator never
  // ran (anything predating D-014) still gets a useful answer instead of an empty list.
  app.get('/alerts/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const [stored, live, telemetry] = await Promise.all([
      getAlerts(bookingId),
      booking.driver_id ? getLiveLocation(booking.driver_id, bookingId) : Promise.resolve(null),
      getTelemetry(bookingId),
    ])

    let current: {
      lat: number
      lng: number
      deviation_m: number | null
      off_route: boolean | null
      distance_to_drop_m: number
      near_drop: boolean
      idle_seconds: number | null
      idle: boolean | null
    } | null = null

    if (live) {
      const at = { lat: live.lat, lng: live.lng }
      const path = await loadCachedRoutePath(bookingId)
      const deviation = path.length > 1 ? distanceToPolylineMeters(at, path) : null
      const toDrop = haversineMeters(at, { lat: booking.dest_lat, lng: booking.dest_lng })
      const idleFor = telemetry?.stopped_since
        ? Math.round((Date.now() - new Date(telemetry.stopped_since).getTime()) / 1000)
        : null

      current = {
        lat: live.lat,
        lng: live.lng,
        deviation_m: deviation === null ? null : Math.round(deviation),
        off_route: deviation === null ? null : deviation > OFF_ROUTE_METERS,
        distance_to_drop_m: Math.round(toDrop),
        near_drop: toDrop <= NEAR_DROP_METERS,
        idle_seconds: idleFor,
        idle: idleFor === null ? null : idleFor >= IDLE_SECONDS,
      }
    }

    return reply.send({
      success: true,
      data: {
        booking_id: bookingId,
        evaluated_at: new Date().toISOString(),
        thresholds: {
          off_route_m: OFF_ROUTE_METERS,
          idle_seconds: IDLE_SECONDS,
          near_drop_m: NEAR_DROP_METERS,
          speeding_kmh: SPEEDING_KMH,
        },
        current_location: current,
        open_count: stored.filter((a) => !a.resolved_at).length,
        alerts: stored,
      },
    })
  })

  // GET /tracking/summary/:bookingId — the post-trip analytics record.
  //
  // Not a contract endpoint: §3.1 predates trip_telemetry. Added because "planned vs actually
  // driven" is the number a fleet owner reconciles a trip against, and it exists nowhere else
  // — trip_routes holds the plan and location_history holds the truth, but nothing joined them.
  app.get('/summary/:bookingId', async (req, reply) => {
    const bookingId = parseBookingId(req.params)
    const booking = await loadBookingOrThrow(bookingId)
    await assertCanAccess(booking, req.user)

    const [telemetry, events, planned] = await Promise.all([
      getTelemetry(bookingId),
      listGeofenceEvents(bookingId),
      getStoredRoute(bookingId),
    ])

    if (!telemetry) {
      return reply.send({
        success: true,
        data: {
          booking_id: bookingId,
          status: booking.status,
          has_telemetry: false,
          reason:
            'No GPS telemetry recorded for this trip yet. Telemetry accrues once the driver starts sending location from the driver app.',
          planned_distance_km: planned ? round1(planned.distance_m / 1000) : null,
          geofence_events: events,
        },
      })
    }

    const drivenKm = telemetry.distance_m / 1000
    const plannedKm = planned ? planned.distance_m / 1000 : null

    return reply.send({
      success: true,
      data: {
        booking_id: bookingId,
        status: booking.status,
        has_telemetry: true,
        vehicle_id: telemetry.vehicle_id,
        driver_id: telemetry.driver_id,

        planned_distance_km: plannedKm === null ? null : round1(plannedKm),
        driven_distance_km: round1(drivenKm),
        // Positive = the truck drove further than the plan. The interesting cases are a long
        // detour (a real deviation) and a large NEGATIVE gap, which usually means the trip is
        // still in progress rather than that the truck took a shortcut.
        deviation_km: plannedKm === null ? null : round1(drivenKm - plannedKm),
        max_deviation_m: Math.round(telemetry.max_deviation_m),

        moving_hours: round2(telemetry.moving_seconds / 3600),
        idle_hours: round2(telemetry.idle_seconds / 3600),
        night_hours: round2(telemetry.night_seconds / 3600),
        // Average over MOVING time only. Including stopped time would report a Mumbai-Delhi
        // run at ~25 km/h and make every truck look identical.
        avg_moving_speed_kmh:
          telemetry.moving_seconds > 0 ? round1(telemetry.speed_sum_kmh_s / telemetry.moving_seconds) : null,
        max_speed_kmh: round1(telemetry.max_speed_kmh),

        stop_count: telemetry.stop_count,
        speeding_fixes: telemetry.speeding_count,
        point_count: telemetry.point_count,
        first_fix_at: telemetry.first_fix_at,
        last_fix_at: telemetry.last_fix_at,

        geofence_events: events,
        // Time parked inside pickup/drop — the detention substrate. Sums closed stays only;
        // an open stay has no dwell_seconds yet by design.
        dwell_by_kind: summariseDwell(events),
      },
    })
  })
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

function summariseDwell(events: GeofenceEventRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of events) {
    if (e.event === 'exit' && e.dwell_seconds !== null) {
      out[e.kind] = (out[e.kind] ?? 0) + e.dwell_seconds
    }
  }
  return out
}

/** Cache/DB only — never a fresh Routes call, which would bill per alert poll. */
async function loadCachedRoutePath(bookingId: string) {
  const cached = await redis.get(routeKey(bookingId))
  if (cached) return decodePolyline((JSON.parse(cached) as ComputedRoute).polyline)
  const stored = await getStoredRoute(bookingId)
  return stored ? decodePolyline(stored.polyline) : []
}

/**
 * Where to search for pumps: live position, else the last breadcrumb, else pickup.
 * The chosen tier is returned so the UI can say "near your last known position".
 */
async function resolvePumpAnchor(booking: TrackingBooking) {
  if (booking.driver_id) {
    const live = await getLiveLocation(booking.driver_id, booking.id)
    if (live) return { point: { lat: live.lat, lng: live.lng }, source: 'live_position' as const }
  }
  const recent = await getLocationHistory(booking.id, { limit: 1 })
  if (recent.length) {
    return { point: { lat: recent[0].lat, lng: recent[0].lng }, source: 'last_breadcrumb' as const }
  }
  return {
    point: { lat: booking.source_lat, lng: booking.source_lng },
    source: 'pickup_point' as const,
  }
}

/**
 * Distance for the fuel estimate, most truthful source first: an explicit override, then
 * what the truck actually drove, then the planned route.
 *
 * Driven distance only wins once there is a real amount of it — a trip three fixes old has
 * driven ~0 km, and reporting a ₹0 fuel bill for it would read as "this trip is free" rather
 * than "this trip has barely started".
 */
const MIN_DRIVEN_KM_FOR_FUEL = 1

async function resolveFuelDistance(
  bookingId: string,
  override: number | undefined,
): Promise<{ km: number; basis: 'override' | 'driven' | 'planned' | 'unknown'; note: string }> {
  if (override !== undefined) {
    return { km: override, basis: 'override', note: 'Distance supplied by the caller.' }
  }

  const telemetry = await getTelemetry(bookingId)
  const drivenKm = (telemetry?.distance_m ?? 0) / 1000
  if (drivenKm >= MIN_DRIVEN_KM_FOR_FUEL) {
    return {
      km: drivenKm,
      basis: 'driven',
      note: 'Based on distance actually driven, measured from GPS breadcrumbs.',
    }
  }

  const planned = await getStoredRoute(bookingId)
  if (planned) {
    return {
      km: planned.distance_m / 1000,
      basis: 'planned',
      note: 'Based on the planned route — the truck has not driven far enough yet to measure.',
    }
  }

  return {
    km: 0,
    basis: 'unknown',
    note: 'No route has been computed for this booking yet, so distance is unknown. Open the trip map once to compute it.',
  }
}
