import { supabase } from './supabase.js'
import type { TrackingBooking } from './types.js'
import type { ComputedRoute } from './google.js'

// ── bookings (owned by bt-booking-service — read only) ───────────────────────
export async function getBookingForTracking(id: string): Promise<TrackingBooking | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, shipper_id, driver_id, status, source_lat, source_lng, dest_lat, dest_lng')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`DB select failed: ${error.message}`)
  return data as TrackingBooking | null
}

// getBookingFleetColumns — fleet_owner_id / vehicle_id, fetched SEPARATELY and only
// for a fleet_owner caller.
//
// These columns arrive in migration 0016. They are deliberately NOT in the select
// above: that list is on the hot path of every tracking endpoint for shippers and
// drivers, and PostgREST fails the entire query when it names a column the table
// does not have (42703) — so widening it would take the live map, ETA and route
// down for every solo driver and shipper the moment this image deploys, before
// 0016 lands. Shipper/driver/admin therefore pay nothing for this feature.
//
// A missing column here means the fleet schema simply is not deployed yet, which
// is indistinguishable from "this booking belongs to no fleet" — so we return
// nulls and let the caller deny access, rather than 500.
export async function getBookingFleetColumns(
  id: string,
): Promise<{ fleet_owner_id: string | null; vehicle_id: string | null }> {
  const { data, error } = await supabase
    .from('bookings')
    .select('fleet_owner_id, vehicle_id')
    .eq('id', id)
    .maybeSingle()
  if (error) return { fleet_owner_id: null, vehicle_id: null }
  return {
    fleet_owner_id: (data?.fleet_owner_id as string | null) ?? null,
    vehicle_id: (data?.vehicle_id as string | null) ?? null,
  }
}

// getBookingConsignee — consignee_user_id, fetched SEPARATELY from the hot-path select for
// the same reason getBookingFleetColumns is: this column arrives in migration 0026, and
// naming it in getBookingForTracking's select would 42703-fail every tracking endpoint for
// shipper and driver on any database that predates it. A claimed consignee (users.id) reads
// their inbound trip through this; an unclaimed one is null and simply never matches.
//
// A missing column (pre-0026) is indistinguishable from "this booking has no consignee" — so
// we return null and let the caller deny, which fails CLOSED, rather than 500.
export async function getBookingConsignee(id: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('consignee_user_id')
    .eq('id', id)
    .maybeSingle()
  if (error) return null
  return (data?.consignee_user_id as string | null) ?? null
}

// ── trip_routes (owned here) — durable backup of the cached route ────────────
// Best-effort: a DB hiccup must not fail a route response (Redis is the hot path).
export async function upsertTripRoute(bookingId: string, route: ComputedRoute): Promise<void> {
  const { error } = await supabase.from('trip_routes').upsert(
    {
      booking_id: bookingId,
      polyline: route.polyline,
      distance_m: route.distance_m,
      static_duration_s: route.static_duration_s,
      ne_lat: route.bounds.ne_lat,
      ne_lng: route.bounds.ne_lng,
      sw_lat: route.bounds.sw_lat,
      sw_lng: route.bounds.sw_lng,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'booking_id' },
  )
  if (error) throw new Error(`trip_routes upsert failed: ${error.message}`)
}

/**
 * The durable copy of a computed route.
 *
 * The evaluator reads this when Redis has evicted `trk:route:*`, so off-route detection
 * survives a cache flush without spending a Routes API call on the ingest path.
 */
export async function getStoredRoute(
  bookingId: string,
): Promise<{ polyline: string; distance_m: number; static_duration_s: number } | null> {
  const { data, error } = await supabase
    .from('trip_routes')
    .select('polyline, distance_m, static_duration_s')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) return null
  return (data as { polyline: string; distance_m: number; static_duration_s: number } | null) ?? null
}

// ── route_alerts (owned here) — Phase 5 raises them; read-through lists them ──
export type AlertRow = {
  id: string
  type: string
  message: string | null
  lat: number | null
  lng: number | null
  acknowledged: boolean
  created_at: string
  /** Columns added by migration 0019 — see openAlert/resolveAlert for the lifecycle. */
  severity: 'info' | 'warning' | 'critical'
  resolved_at: string | null
  meta: Record<string, unknown>
}

export async function getAlerts(bookingId: string): Promise<AlertRow[]> {
  const { data, error } = await supabase
    .from('route_alerts')
    .select('id, type, message, lat, lng, acknowledged, created_at, severity, resolved_at, meta')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) return []
  return (data ?? []) as AlertRow[]
}

// ── location_history (owned by bt-booking-service — READ ONLY here) ──────────
// D-007 is explicit: the breadcrumb WRITE belongs to the ingestion path. Nothing in
// this service may insert here.

export type BreadcrumbRow = {
  lat: number
  lng: number
  speed_kmh: number | null
  heading: number | null
  recorded_at: string
}

export async function getLocationHistory(
  bookingId: string,
  opts: { since?: string; limit: number },
): Promise<BreadcrumbRow[]> {
  let q = supabase
    .from('location_history')
    .select('lat, lng, speed_kmh, heading, recorded_at')
    .eq('booking_id', bookingId)
    .order('recorded_at', { ascending: true })
    .limit(opts.limit)

  if (opts.since) q = q.gte('recorded_at', opts.since)

  const { data, error } = await q
  if (error) throw new Error(`location_history select failed: ${error.message}`)
  return (data ?? []) as BreadcrumbRow[]
}

// ── trip_telemetry (owned here) — the incremental per-trip rollup ────────────

export type TelemetryRow = {
  booking_id: string
  driver_id: string | null
  vehicle_id: string | null
  point_count: number
  distance_m: number
  moving_seconds: number
  idle_seconds: number
  night_seconds: number
  max_speed_kmh: number
  speed_sum_kmh_s: number
  stop_count: number
  speeding_count: number
  max_deviation_m: number
  first_fix_at: string | null
  last_fix_at: string | null
  last_lat: number | null
  last_lng: number | null
  stopped_since: string | null
}

export async function getTelemetry(bookingId: string): Promise<TelemetryRow | null> {
  const { data, error } = await supabase
    .from('trip_telemetry')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) return null
  return (data as TelemetryRow | null) ?? null
}

/** Batch variant for the fleet roster — one query for every live booking on the map. */
export async function getTelemetryForBookings(bookingIds: string[]): Promise<Map<string, TelemetryRow>> {
  if (bookingIds.length === 0) return new Map()
  const { data, error } = await supabase.from('trip_telemetry').select('*').in('booking_id', bookingIds)
  if (error) return new Map()
  return new Map(((data ?? []) as TelemetryRow[]).map((r) => [r.booking_id, r]))
}

export async function upsertTelemetry(row: Partial<TelemetryRow> & { booking_id: string }): Promise<void> {
  const { error } = await supabase
    .from('trip_telemetry')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'booking_id' })
  if (error) throw new Error(`trip_telemetry upsert failed: ${error.message}`)
}

// ── geofences + geofence_events (owned here) ─────────────────────────────────

export type GeofenceRow = {
  id: string
  fleet_owner_id: string | null
  name: string
  kind: 'depot' | 'warehouse' | 'checkpoint' | 'custom'
  lat: number
  lng: number
  radius_m: number
  active: boolean
  created_at: string
  updated_at: string
}

export async function listGeofences(fleetOwnerId: string): Promise<GeofenceRow[]> {
  const { data, error } = await supabase
    .from('geofences')
    .select('*')
    .eq('fleet_owner_id', fleetOwnerId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`geofences select failed: ${error.message}`)
  return (data ?? []) as GeofenceRow[]
}

/**
 * Active fences the evaluator must test this fix against.
 *
 * Returns [] rather than throwing when the table is missing or the query fails: a geofence
 * lookup problem must degrade to "no fences" and let GPS ingestion continue, never break it.
 */
export async function listActiveGeofences(fleetOwnerId: string | null): Promise<GeofenceRow[]> {
  if (!fleetOwnerId) return []
  const { data, error } = await supabase
    .from('geofences')
    .select('*')
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('active', true)
  if (error) return []
  return (data ?? []) as GeofenceRow[]
}

export async function createGeofence(row: {
  fleet_owner_id: string
  name: string
  kind: GeofenceRow['kind']
  lat: number
  lng: number
  radius_m: number
}): Promise<GeofenceRow> {
  const { data, error } = await supabase.from('geofences').insert(row).select('*').single()
  if (error) throw new Error(`geofence insert failed: ${error.message}`)
  return data as GeofenceRow
}

export async function deleteGeofence(fleetOwnerId: string, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('geofences')
    .delete()
    .eq('id', id)
    .eq('fleet_owner_id', fleetOwnerId)
    .select('id')
  if (error) throw new Error(`geofence delete failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

export type GeofenceEventRow = {
  id: string
  booking_id: string
  geofence_id: string | null
  kind: string
  name: string | null
  event: 'enter' | 'exit'
  lat: number
  lng: number
  occurred_at: string
  dwell_seconds: number | null
  driver_id: string | null
  vehicle_id: string | null
}

export async function insertGeofenceEvent(row: Omit<GeofenceEventRow, 'id'>): Promise<void> {
  const { error } = await supabase.from('geofence_events').insert(row)
  if (error) throw new Error(`geofence_events insert failed: ${error.message}`)
}

export async function listGeofenceEvents(bookingId: string, limit = 100): Promise<GeofenceEventRow[]> {
  const { data, error } = await supabase
    .from('geofence_events')
    .select('*')
    .eq('booking_id', bookingId)
    .order('occurred_at', { ascending: true })
    .limit(limit)
  if (error) return []
  return (data ?? []) as GeofenceEventRow[]
}

// ── route_alerts write side — the open/resolve lifecycle ─────────────────────
// route_alerts_open_unique (migration 0019) allows at most ONE unresolved row per
// (booking_id, type). These two helpers are the only sanctioned way to move an alert
// through that lifecycle.

export async function openAlert(row: {
  booking_id: string
  type: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  lat: number | null
  lng: number | null
  driver_id: string | null
  vehicle_id: string | null
  meta: Record<string, unknown>
}): Promise<void> {
  // The unique index makes a duplicate open a no-op rather than an error, so the evaluator
  // can call this on every fix while the condition holds without checking first.
  const { error } = await supabase.from('route_alerts').insert(row)
  if (error && !/duplicate key|23505/i.test(error.message)) {
    throw new Error(`route_alerts insert failed: ${error.message}`)
  }
}

export async function resolveAlert(bookingId: string, type: string): Promise<void> {
  const { error } = await supabase
    .from('route_alerts')
    .update({ resolved_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .eq('type', type)
    .is('resolved_at', null)
  if (error) throw new Error(`route_alerts resolve failed: ${error.message}`)
}

export async function getOpenAlertsForBookings(bookingIds: string[]): Promise<Map<string, AlertRow[]>> {
  const out = new Map<string, AlertRow[]>()
  if (bookingIds.length === 0) return out

  const { data, error } = await supabase
    .from('route_alerts')
    .select('id, booking_id, type, message, lat, lng, acknowledged, created_at, severity, resolved_at, meta')
    .in('booking_id', bookingIds)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
  if (error) return out

  for (const row of (data ?? []) as (AlertRow & { booking_id: string })[]) {
    const list = out.get(row.booking_id) ?? []
    list.push(row)
    out.set(row.booking_id, list)
  }
  return out
}

// ── the fleet roster — VEHICLE-first, not driver-first ──────────────────────
//
// bt-fleet-service's GET /fleet/live starts from the fleet's DRIVER set, so a truck with
// nobody assigned to it does not appear at all. That is the wrong shape for an owner's
// dashboard: the trucks sitting idle in the yard are exactly the ones costing money, and
// their absence reads as "everything is fine". This starts from `vehicles` so every asset
// the owner has is on the board, and a missing driver/trip/fix becomes a REASON attached to
// that truck rather than a silently dropped row.

export type FleetVehicleRow = {
  id: string
  rc_number: string | null
  maker_model: string | null
  model_category: string | null
  emission_norm: string | null
  body_type: string | null
  capacity_tons: number | null
  is_active: boolean
  current_odometer_km: number | null
  rc_expiry: string | null
}

export async function listFleetVehicles(fleetOwnerId: string): Promise<FleetVehicleRow[]> {
  const { data, error } = await supabase
    .from('vehicles')
    .select(
      'id, rc_number, maker_model, model_category, emission_norm, body_type, capacity_tons, is_active, current_odometer_km, rc_expiry',
    )
    .eq('fleet_owner_id', fleetOwnerId)
    .order('rc_number', { ascending: true })
  if (error) throw new Error(`vehicles select failed: ${error.message}`)
  return (data ?? []) as FleetVehicleRow[]
}

export type LiveAssignmentRow = {
  booking_id: string
  vehicle_id: string
  driver_id: string
  assigned_at: string
}

export async function listLiveAssignments(fleetOwnerId: string): Promise<LiveAssignmentRow[]> {
  const { data, error } = await supabase
    .from('vehicle_assignments')
    .select('booking_id, vehicle_id, driver_id, assigned_at')
    .eq('fleet_owner_id', fleetOwnerId)
    .is('released_at', null)
  if (error) return []
  return (data ?? []) as LiveAssignmentRow[]
}

export type RosterBookingRow = {
  id: string
  status: string
  source_address: string | null
  dest_address: string | null
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  pickup_date: string | null
}

/**
 * NOTE THE ALIAS: the column is `destination_address`, NOT `dest_address` — even though the
 * latitude/longitude pair is `dest_lat`/`dest_lng`. Naming the wrong column here does not
 * return a null field: PostgREST fails the ENTIRE query with 42703, so every booking goes
 * missing at once and every assigned truck renders as "assigned to a trip that is still
 * unknown". That is the same trap `getBookingFleetColumns` above documents, and it cost a
 * debugging cycle on this exact function.
 */
export async function getBookingsForRoster(bookingIds: string[]): Promise<Map<string, RosterBookingRow>> {
  if (bookingIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, status, source_address, dest_address:destination_address, source_lat, source_lng, dest_lat, dest_lng, pickup_date',
    )
    .in('id', bookingIds)

  if (error) {
    // Deliberately loud. Swallowing this silently is what made the 42703 above look like
    // "this fleet has no live bookings" instead of "the query is wrong".
    console.error(`[tracking] getBookingsForRoster failed: ${error.message}`)
    return new Map()
  }
  return new Map(((data ?? []) as RosterBookingRow[]).map((b) => [b.id, b]))
}

export type DriverIdentity = { driver_id: string; full_name: string | null; phone_number: string | null }

/**
 * drivers.id -> the human behind it, in two bounded queries.
 *
 * Two hops because the name lives on `users` and the id the rest of the platform uses is
 * `drivers.id` — the identity gotcha that has caused repeated cross-service bugs. Explicit
 * joins rather than PostgREST embedding so this does not depend on FK-name inference.
 */
export async function hydrateDriverIdentities(driverIds: string[]): Promise<Map<string, DriverIdentity>> {
  const out = new Map<string, DriverIdentity>()
  if (driverIds.length === 0) return out

  const { data: drivers, error: dErr } = await supabase
    .from('drivers')
    .select('id, user_id')
    .in('id', driverIds)
  if (dErr || !drivers?.length) return out

  const rows = drivers as { id: string; user_id: string }[]
  const { data: users, error: uErr } = await supabase
    .from('users')
    .select('id, full_name, phone_number')
    .in('id', rows.map((r) => r.user_id))
  if (uErr) return out

  const userById = new Map(
    ((users ?? []) as { id: string; full_name: string | null; phone_number: string | null }[]).map((u) => [u.id, u]),
  )

  for (const r of rows) {
    const u = userById.get(r.user_id)
    out.set(r.id, { driver_id: r.id, full_name: u?.full_name ?? null, phone_number: u?.phone_number ?? null })
  }
  return out
}

/** The fleet that owns a truck — used to resolve which geofences apply to a fix. */
export async function getVehicleFleetOwner(vehicleId: string | null): Promise<string | null> {
  if (!vehicleId) return null
  const { data, error } = await supabase
    .from('vehicles')
    .select('fleet_owner_id')
    .eq('id', vehicleId)
    .maybeSingle()
  if (error) return null
  return (data?.fleet_owner_id as string | null) ?? null
}

export async function getVehicleForFuel(
  vehicleId: string | null,
): Promise<{ model_category: string | null; emission_norm: string | null } | null> {
  if (!vehicleId) return null
  const { data, error } = await supabase
    .from('vehicles')
    .select('model_category, emission_norm')
    .eq('id', vehicleId)
    .maybeSingle()
  if (error) return null
  return (data as { model_category: string | null; emission_norm: string | null } | null) ?? null
}
