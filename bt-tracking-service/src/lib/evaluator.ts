// The on-ingest evaluator (D-014).
//
// Runs once per accepted GPS fix, fired by bt-booking-service after it has written the
// Redis live position and the throttled breadcrumb. Everything read-time in this service
// answers "where is the truck NOW"; this is the only place that can answer "what HAPPENED",
// because an enter/exit/threshold crossing exists only at the instant it occurs.
//
// CONTRACT POSITION: this does NOT ingest GPS and does NOT write location_history — both
// stay owned by bt-booking-service (§3.1 §1, D-007). It consumes a fix that has already
// been ingested and writes only DERIVED state: trip_telemetry, geofence_events, route_alerts.
//
// FAILURE POSTURE: every path here is best-effort. The caller fires and forgets, and a
// geometry or DB fault must never cost the platform a GPS fix — the live position is
// already safe in Redis before this runs. Errors are logged by the route and swallowed.

import {
  distanceToPolylineMeters,
  haversineMeters,
  decodePolyline,
  isInsideCircle,
  isNightIST,
  type LatLng,
} from './geo.js'
import { redis, routeKey, fenceStateKey, FENCE_STATE_TTL_SECONDS } from './redis.js'
import * as repo from './repository.js'
import type { ComputedRoute } from './google.js'
import { positiveIntEnv } from './env.js'

// ── Thresholds ───────────────────────────────────────────────────────────────
// The first three are LOCKED by D-012 and must not be changed without a new decision.
export const OFF_ROUTE_METERS = 500
export const IDLE_SECONDS = 15 * 60
export const NEAR_DROP_METERS = 2000

/** Below this the truck is parked; above it, rolling. Matches the fleet map's own constant. */
export const MOVING_KMH = 5
/**
 * Speeding threshold. NOT locked by D-012 — that decision covers only off-route/idle/
 * near-drop — so this is a new, tunable number rather than a frozen one. 80 km/h is the
 * MoRTH ceiling for goods carriages on expressways; state highways are often lower, so this
 * flags the clear cases and is expected to be re-tuned after the first corridor drive.
 */
export const SPEEDING_KMH = positiveIntEnv('SPEEDING_LIMIT_KMH', 80)

/**
 * Two consecutive fixes further apart than this are treated as a GAP, not travel: the app
 * was backgrounded, the phone lost signal, or the driver crossed a dead zone. Counting the
 * straight line across such a gap as driven distance and its whole duration as moving time
 * would silently inflate both. The gap is recorded in neither bucket.
 */
export const MAX_FIX_GAP_SECONDS = 10 * 60

/** Implicit pickup/drop fence radius. Wide enough for a yard, tight enough to mean "here". */
export const IMPLICIT_FENCE_RADIUS_M = 500

export interface GpsFix {
  booking_id: string
  driver_id: string | null
  vehicle_id: string | null
  lat: number
  lng: number
  speed_kmh: number | null
  heading: number | null
  recorded_at: string
}

type FenceState = Record<string, string> // fenceKey -> ISO instant the truck entered

/**
 * Base route polyline, from cache only.
 *
 * DELIBERATELY never computes on a miss. A Routes API call on the ingest path would be one
 * billed Google request per GPS fix per truck — the exact cost blow-up §3.1 §6.4 exists to
 * prevent. A cold cache simply means the off-route check is skipped for this fix; the first
 * shipper or driver to open the map warms it, and the check resumes.
 */
async function loadRoutePath(bookingId: string): Promise<LatLng[]> {
  const cached = await redis.get(routeKey(bookingId))
  if (cached) {
    const route = JSON.parse(cached) as ComputedRoute
    return decodePolyline(route.polyline)
  }
  // Durable fallback — trip_routes is written whenever a route is computed, so a Redis
  // eviction does not disable off-route detection for the rest of the trip.
  const stored = await repo.getStoredRoute(bookingId)
  return stored ? decodePolyline(stored.polyline) : []
}

async function loadFenceState(bookingId: string): Promise<FenceState> {
  const cached = await redis.get(fenceStateKey(bookingId))
  if (cached) return JSON.parse(cached) as FenceState

  // Rebuild from the durable log. An 'enter' with no later 'exit' is an open stay — the
  // same rule the schema comment states, so cache and DB can never disagree on meaning.
  const events = await repo.listGeofenceEvents(bookingId, 200)
  const state: FenceState = {}
  for (const e of events) {
    const key = e.geofence_id ?? `implicit:${e.kind}`
    if (e.event === 'enter') state[key] = e.occurred_at
    else delete state[key]
  }
  return state
}

async function saveFenceState(bookingId: string, state: FenceState): Promise<void> {
  await redis.set(fenceStateKey(bookingId), JSON.stringify(state), 'EX', FENCE_STATE_TTL_SECONDS)
}

interface Fence {
  key: string
  geofence_id: string | null
  kind: string
  name: string | null
  centre: LatLng
  radius_m: number
}

/**
 * Every fence this fix must be tested against: the booking's own pickup and drop (implicit,
 * derived from the booking row so they can never drift from it) plus whatever the owning
 * fleet has drawn by hand.
 */
async function fencesFor(
  booking: { source_lat: number; source_lng: number; dest_lat: number; dest_lng: number },
  vehicleId: string | null,
): Promise<Fence[]> {
  const fences: Fence[] = [
    {
      key: 'implicit:pickup',
      geofence_id: null,
      kind: 'pickup',
      name: 'Pickup',
      centre: { lat: booking.source_lat, lng: booking.source_lng },
      radius_m: IMPLICIT_FENCE_RADIUS_M,
    },
    {
      key: 'implicit:drop',
      geofence_id: null,
      kind: 'drop',
      name: 'Drop',
      centre: { lat: booking.dest_lat, lng: booking.dest_lng },
      radius_m: IMPLICIT_FENCE_RADIUS_M,
    },
  ]

  const fleetOwnerId = await repo.getVehicleFleetOwner(vehicleId)
  for (const g of await repo.listActiveGeofences(fleetOwnerId)) {
    fences.push({
      key: g.id,
      geofence_id: g.id,
      kind: g.kind,
      name: g.name,
      centre: { lat: g.lat, lng: g.lng },
      radius_m: g.radius_m,
    })
  }
  return fences
}

export interface EvaluationResult {
  distance_added_m: number
  alerts_opened: string[]
  alerts_resolved: string[]
  geofence_events: string[]
  skipped_reason?: string
}

/**
 * Evaluate one GPS fix. Idempotent-ish by construction: alerts dedupe on the partial unique
 * index, geofence events only fire on a state CHANGE, and telemetry deltas are computed
 * against the stored last fix, so a replayed fix adds ~zero distance rather than doubling it.
 */
export async function evaluateFix(fix: GpsFix): Promise<EvaluationResult> {
  const result: EvaluationResult = {
    distance_added_m: 0,
    alerts_opened: [],
    alerts_resolved: [],
    geofence_events: [],
  }

  const booking = await repo.getBookingForTracking(fix.booking_id)
  if (!booking) return { ...result, skipped_reason: 'booking_not_found' }

  const now: LatLng = { lat: fix.lat, lng: fix.lng }
  const at = new Date(fix.recorded_at)
  if (Number.isNaN(at.getTime())) return { ...result, skipped_reason: 'bad_recorded_at' }

  const prev = await repo.getTelemetry(fix.booking_id)

  // ── deltas against the previous fix ────────────────────────────────────────
  let distanceAdded = 0
  let movingAdded = 0
  let idleAdded = 0
  let nightAdded = 0
  let stopCountAdded = 0

  const speed = fix.speed_kmh ?? 0
  const isMoving = speed >= MOVING_KMH
  let stoppedSince: string | null = prev?.stopped_since ?? null

  if (prev?.last_fix_at && prev.last_lat !== null && prev.last_lng !== null) {
    const prevAt = new Date(prev.last_fix_at)
    const dtSeconds = (at.getTime() - prevAt.getTime()) / 1000

    // Out-of-order or replayed fix: keep the rollup, add nothing.
    if (dtSeconds <= 0) return { ...result, skipped_reason: 'stale_fix' }

    if (dtSeconds <= MAX_FIX_GAP_SECONDS) {
      distanceAdded = haversineMeters({ lat: prev.last_lat, lng: prev.last_lng }, now)
      if (isMoving) movingAdded = dtSeconds
      else idleAdded = dtSeconds
      // Night counts MOVING time only. The signal being tracked is night DRIVING — the
      // window where interstate accident rates spike and cargo insurers price differently
      // — and a truck parked at a dhaba at 2 a.m. carries none of that risk. Counting
      // stopped time here would have made every overnight halt look like a hard night run.
      // Attributed by the interval's END rather than its midpoint: a ~12 s breadcrumb never
      // straddles the boundary meaningfully.
      if (isMoving && isNightIST(at)) nightAdded = dtSeconds
    }
  }

  // A stop BEGINS the first time we see the truck below the moving threshold, and the
  // counter increments then — not on every subsequent stationary fix.
  if (!isMoving && stoppedSince === null) {
    stoppedSince = fix.recorded_at
    stopCountAdded = 1
  } else if (isMoving) {
    stoppedSince = null
  }

  // ── off-route ──────────────────────────────────────────────────────────────
  const path = await loadRoutePath(fix.booking_id)
  let deviationM: number | null = null
  if (path.length > 1) {
    deviationM = distanceToPolylineMeters(now, path)
    if (deviationM > OFF_ROUTE_METERS) {
      await repo.openAlert({
        booking_id: fix.booking_id,
        type: 'off_route',
        severity: 'warning',
        message: `Truck is ${Math.round(deviationM)} m off the planned route.`,
        lat: fix.lat,
        lng: fix.lng,
        driver_id: fix.driver_id,
        vehicle_id: fix.vehicle_id,
        meta: { deviation_m: Math.round(deviationM), threshold_m: OFF_ROUTE_METERS },
      })
      result.alerts_opened.push('off_route')
    } else {
      await repo.resolveAlert(fix.booking_id, 'off_route')
      result.alerts_resolved.push('off_route')
    }
  }

  // ── idle ───────────────────────────────────────────────────────────────────
  if (stoppedSince) {
    const stoppedFor = (at.getTime() - new Date(stoppedSince).getTime()) / 1000
    if (stoppedFor >= IDLE_SECONDS) {
      await repo.openAlert({
        booking_id: fix.booking_id,
        type: 'idle',
        severity: 'warning',
        message: `Truck has not moved for ${Math.round(stoppedFor / 60)} minutes.`,
        lat: fix.lat,
        lng: fix.lng,
        driver_id: fix.driver_id,
        vehicle_id: fix.vehicle_id,
        meta: { idle_seconds: Math.round(stoppedFor), threshold_seconds: IDLE_SECONDS },
      })
      result.alerts_opened.push('idle')
    }
  } else {
    await repo.resolveAlert(fix.booking_id, 'idle')
    result.alerts_resolved.push('idle')
  }

  // ── near drop ──────────────────────────────────────────────────────────────
  const toDrop = haversineMeters(now, { lat: booking.dest_lat, lng: booking.dest_lng })
  if (toDrop <= NEAR_DROP_METERS) {
    await repo.openAlert({
      booking_id: fix.booking_id,
      type: 'near_drop',
      severity: 'info',
      message: `Truck is ${(toDrop / 1000).toFixed(1)} km from the drop point.`,
      lat: fix.lat,
      lng: fix.lng,
      driver_id: fix.driver_id,
      vehicle_id: fix.vehicle_id,
      meta: { remaining_m: Math.round(toDrop), threshold_m: NEAR_DROP_METERS },
    })
    result.alerts_opened.push('near_drop')
  } else {
    // Symmetry matters here: a route that merely passes within 2 km of the drop early on
    // would otherwise leave a "near drop" banner pinned to the trip for the rest of the
    // run, and an alert that is permanently on is an alert nobody reads.
    await repo.resolveAlert(fix.booking_id, 'near_drop')
    result.alerts_resolved.push('near_drop')
  }

  // ── speeding ───────────────────────────────────────────────────────────────
  let speedingAdded = 0
  if (speed > SPEEDING_KMH) {
    speedingAdded = 1
    await repo.openAlert({
      booking_id: fix.booking_id,
      type: 'speeding',
      severity: 'critical',
      message: `Truck is doing ${Math.round(speed)} km/h (limit ${SPEEDING_KMH}).`,
      lat: fix.lat,
      lng: fix.lng,
      driver_id: fix.driver_id,
      vehicle_id: fix.vehicle_id,
      meta: { speed_kmh: Math.round(speed), limit_kmh: SPEEDING_KMH },
    })
    result.alerts_opened.push('speeding')
  } else {
    await repo.resolveAlert(fix.booking_id, 'speeding')
    result.alerts_resolved.push('speeding')
  }

  // ── geofences ──────────────────────────────────────────────────────────────
  const state = await loadFenceState(fix.booking_id)
  let stateChanged = false

  for (const fence of await fencesFor(booking, fix.vehicle_id)) {
    const inside = isInsideCircle(now, fence.centre, fence.radius_m)
    const wasInside = state[fence.key] !== undefined

    if (inside && !wasInside) {
      await repo.insertGeofenceEvent({
        booking_id: fix.booking_id,
        geofence_id: fence.geofence_id,
        kind: fence.kind,
        name: fence.name,
        event: 'enter',
        lat: fix.lat,
        lng: fix.lng,
        occurred_at: fix.recorded_at,
        dwell_seconds: null,
        driver_id: fix.driver_id,
        vehicle_id: fix.vehicle_id,
      })
      state[fence.key] = fix.recorded_at
      stateChanged = true
      result.geofence_events.push(`enter:${fence.kind}`)
    } else if (!inside && wasInside) {
      const enteredAt = new Date(state[fence.key])
      const dwell = Math.max(0, Math.round((at.getTime() - enteredAt.getTime()) / 1000))
      await repo.insertGeofenceEvent({
        booking_id: fix.booking_id,
        geofence_id: fence.geofence_id,
        kind: fence.kind,
        name: fence.name,
        event: 'exit',
        lat: fix.lat,
        lng: fix.lng,
        occurred_at: fix.recorded_at,
        dwell_seconds: dwell,
        driver_id: fix.driver_id,
        vehicle_id: fix.vehicle_id,
      })
      delete state[fence.key]
      stateChanged = true
      result.geofence_events.push(`exit:${fence.kind}`)
    }
  }
  if (stateChanged) await saveFenceState(fix.booking_id, state)

  // ── persist the rollup ─────────────────────────────────────────────────────
  await repo.upsertTelemetry({
    booking_id: fix.booking_id,
    driver_id: fix.driver_id,
    vehicle_id: fix.vehicle_id,
    point_count: (prev?.point_count ?? 0) + 1,
    distance_m: (prev?.distance_m ?? 0) + distanceAdded,
    moving_seconds: Math.round((prev?.moving_seconds ?? 0) + movingAdded),
    idle_seconds: Math.round((prev?.idle_seconds ?? 0) + idleAdded),
    night_seconds: Math.round((prev?.night_seconds ?? 0) + nightAdded),
    max_speed_kmh: Math.max(prev?.max_speed_kmh ?? 0, speed),
    speed_sum_kmh_s: (prev?.speed_sum_kmh_s ?? 0) + speed * movingAdded,
    stop_count: (prev?.stop_count ?? 0) + stopCountAdded,
    speeding_count: (prev?.speeding_count ?? 0) + speedingAdded,
    max_deviation_m: Math.max(prev?.max_deviation_m ?? 0, deviationM ?? 0),
    first_fix_at: prev?.first_fix_at ?? fix.recorded_at,
    last_fix_at: fix.recorded_at,
    last_lat: fix.lat,
    last_lng: fix.lng,
    stopped_since: stoppedSince,
  })

  result.distance_added_m = Math.round(distanceAdded)
  return result
}
