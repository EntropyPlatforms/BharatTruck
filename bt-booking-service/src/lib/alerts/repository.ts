// ============================================================
// src/lib/alerts/repository.ts
//
// Data access for the alert sweep: the facts the rules read, and the alerts table
// (migration 0042). Every audience lookup does the documented two-hop identity
// (drivers.id / fleet_owners.id -> users.id) — bookings never name a users.id for the
// carrier side, and getting this wrong resolves nobody without erroring.
// ============================================================

import { supabase } from '../supabase.js'
import { isMissingRelation } from '../db-errors.js'
import type { BookingStatus } from '../types.js'
import type { Audience, BookingFact } from './rules.js'
import { AlertsNotMigratedError, type AlertDraft, type AlertKind, type AlertRow } from './types.js'

const CHUNK = 200
const BOOKING_FACT_COLUMNS =
  'id, status, shipper_id, driver_id, fleet_owner_id, source_address, destination_address, ' +
  'pickup_date, updated_at, quoted_price, final_price'
const ALERT_COLUMNS =
  'id, audience_user_id, persona, kind, severity, subject_type, subject_id, title, detail, ' +
  'dedupe_key, opened_at, last_seen_at, acknowledged_at, resolved_at'

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}
const unique = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((x): x is string => !!x))]

// ── Facts ────────────────────────────────────────────────────────────────────

export async function listBookingsByStatus(statuses: BookingStatus[]): Promise<BookingFact[]> {
  const { data, error } = await supabase.from('bookings').select(BOOKING_FACT_COLUMNS).in('status', statuses)
  if (error) throw new Error(`bookings select failed: ${error.message}`)
  return (data ?? []) as unknown as BookingFact[]
}

/**
 * The newest breadcrumb per trip. One indexed lookup per in-transit trip — bounded by
 * how many trucks are on the road right now, which is the set this rule is about.
 */
export async function lastFixByBooking(bookingIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(bookingIds.map(async (id) => {
    const { data, error } = await supabase
      .from('location_history')
      .select('recorded_at')
      .eq('booking_id', id)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`location_history select failed: ${error.message}`)
    const at = (data as { recorded_at?: string } | null)?.recorded_at
    if (at) out.set(id, at)
  }))
  return out
}

/** users.id behind each drivers.id and fleet_owners.id (the two-hop identities). */
export async function loadAudience(driverIds: Array<string | null>, fleetOwnerIds: Array<string | null>): Promise<Audience> {
  const driverUser = new Map<string, string>()
  const fleetOwnerUser = new Map<string, string>()
  for (const ids of chunks(unique(driverIds))) {
    const { data, error } = await supabase.from('drivers').select('id, user_id').in('id', ids)
    if (error) throw new Error(`drivers select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; user_id: string | null }>) if (r.user_id) driverUser.set(r.id, r.user_id)
  }
  for (const ids of chunks(unique(fleetOwnerIds))) {
    const { data, error } = await supabase.from('fleet_owners').select('id, user_id').in('id', ids)
    if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; user_id: string | null }>) if (r.user_id) fleetOwnerUser.set(r.id, r.user_id)
  }
  return { driverUser, fleetOwnerUser }
}

/**
 * Drivers whose LATEST licence expires on or before `cutoff` (YYYY-MM-DD). A driver can
 * hold more than one licence row (a renewal scanned in later), and the newest expiry is
 * the one that counts — so a renewed licence never raises an alert off its stale row.
 */
export async function listLicencesExpiringBy(cutoff: string): Promise<Array<{ driver_id: string; expiry_date: string }>> {
  const { data, error } = await supabase
    .from('driver_licenses')
    .select('driver_id')
    .not('expiry_date', 'is', null)
    .lte('expiry_date', cutoff)
  if (error) throw new Error(`driver_licenses select failed: ${error.message}`)
  const candidates = unique(((data ?? []) as Array<{ driver_id: string }>).map((r) => r.driver_id))
  if (candidates.length === 0) return []

  const latest = new Map<string, string>()
  for (const ids of chunks(candidates)) {
    const { data: all, error: allErr } = await supabase
      .from('driver_licenses')
      .select('driver_id, expiry_date')
      .in('driver_id', ids)
      .not('expiry_date', 'is', null)
    if (allErr) throw new Error(`driver_licenses select failed: ${allErr.message}`)
    for (const r of (all ?? []) as Array<{ driver_id: string; expiry_date: string }>) {
      const seen = latest.get(r.driver_id)
      if (!seen || r.expiry_date > seen) latest.set(r.driver_id, r.expiry_date)
    }
  }
  return [...latest.entries()]
    .filter(([, expiry]) => expiry <= cutoff)
    .map(([driver_id, expiry_date]) => ({ driver_id, expiry_date }))
}

/** fleet_owners.id of every fleet each driver holds an ACTIVE seat with. */
export async function activeSeatsForDrivers(driverIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const ids of chunks(unique(driverIds))) {
    const { data, error } = await supabase
      .from('fleet_drivers')
      .select('driver_id, fleet_owner_id')
      .in('driver_id', ids)
      .eq('status', 'active')
    if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ driver_id: string; fleet_owner_id: string }>) {
      out.set(r.driver_id, [...(out.get(r.driver_id) ?? []), r.fleet_owner_id])
    }
  }
  return out
}

// ── The alerts table ─────────────────────────────────────────────────────────

/** Throws AlertsNotMigratedError until migration 0042 is applied. */
export async function assertAlertsTable(): Promise<void> {
  const { error } = await supabase.from('alerts').select('id').limit(1)
  if (!error) return
  if (isMissingRelation(error)) throw new AlertsNotMigratedError()
  throw new Error(`alerts select failed: ${error.message}`)
}

export async function getAlertsByKeys(keys: string[]): Promise<Map<string, AlertRow>> {
  const out = new Map<string, AlertRow>()
  for (const part of chunks(unique(keys))) {
    const { data, error } = await supabase.from('alerts').select(ALERT_COLUMNS).in('dedupe_key', part)
    if (error) throw new Error(`alerts select failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as AlertRow[]) out.set(r.dedupe_key, r)
  }
  return out
}

/**
 * Open a new alert. False when an overlapping sweep opened the same one first — the unique
 * dedupe_key refuses the second insert (23505), and the run that won counts and emails it.
 */
export async function insertAlert(row: AlertDraft & { opened_at: string; last_seen_at: string }): Promise<boolean> {
  const { error } = await supabase.from('alerts').insert(row)
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`alerts insert failed: ${error.message}`)
}

/**
 * Reopen a resolved alert as a new episode. The update matches only while the row is still
 * resolved, so when two sweeps overlap exactly one reopens it (and emails); the other gets false.
 */
export async function reopenAlert(id: string, patch: Partial<Omit<AlertRow, 'id'>>): Promise<boolean> {
  const { data, error } = await supabase
    .from('alerts')
    .update(patch)
    .eq('id', id)
    .not('resolved_at', 'is', null)
    .select('id')
  if (error) throw new Error(`alerts reopen failed: ${error.message}`)
  return (data ?? []).length > 0
}

export async function updateAlert(id: string, patch: Partial<Omit<AlertRow, 'id'>>): Promise<void> {
  const { error } = await supabase.from('alerts').update(patch).eq('id', id)
  if (error) throw new Error(`alerts update failed: ${error.message}`)
}

export async function listOpenAlertsByKinds(kinds: AlertKind[]): Promise<AlertRow[]> {
  if (kinds.length === 0) return []
  const { data, error } = await supabase
    .from('alerts')
    .select(ALERT_COLUMNS)
    .in('kind', kinds)
    .is('resolved_at', null)
  if (error) throw new Error(`alerts select failed: ${error.message}`)
  return (data ?? []) as unknown as AlertRow[]
}

/**
 * The caller's open alerts, newest first — for the Home feed and the dashboard panels.
 * Before 0042 is applied there is no table and nobody has alerts: that is an empty list,
 * not an error, so the feed does not report a degraded source for a pending migration.
 */
export async function listOpenAlertsForUser(userId: string, limit = 50): Promise<AlertRow[]> {
  const { data, error } = await supabase
    .from('alerts')
    .select(ALERT_COLUMNS)
    .eq('audience_user_id', userId)
    .is('resolved_at', null)
    .order('opened_at', { ascending: false })
    .limit(limit)
  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(`alerts select failed: ${error.message}`)
  }
  return (data ?? []) as unknown as AlertRow[]
}

// ── Wave 1 facts (rules-wave1.ts) ────────────────────────────────────────────

/** The standing (active, newest recorded) e-way bill per booking. */
export async function standingEwbByBooking(bookingIds: string[]): Promise<Map<string, { ewb_number: string | null; valid_upto: string }>> {
  const out = new Map<string, { ewb_number: string | null; valid_upto: string }>()
  for (const ids of chunks(unique(bookingIds))) {
    const { data, error } = await supabase
      .from('eway_bill_records')
      .select('booking_id, ewb_number, valid_upto, recorded_at')
      .in('booking_id', ids)
      .eq('status', 'active')
      .order('recorded_at', { ascending: false })
    if (error) throw new Error(`eway_bill_records select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ booking_id: string; ewb_number: string | null; valid_upto: string }>) {
      if (!out.has(r.booking_id)) out.set(r.booking_id, { ewb_number: r.ewb_number, valid_upto: r.valid_upto })
    }
  }
  return out
}

/**
 * How far from the drop each delivery happened: the distance recorded when the delivery code
 * was requested (pod_audit_log otp_gate_*, detail.distance_m) and on the truck-at-drop photo
 * (pod_evidence kind 'vehicle'). The largest wins.
 */
export async function deliveryDistances(bookingIds: string[]): Promise<Map<string, { distanceM: number; source: 'code_issue' | 'delivery_photo' }>> {
  const out = new Map<string, { distanceM: number; source: 'code_issue' | 'delivery_photo' }>()
  const keep = (id: string, d: number, source: 'code_issue' | 'delivery_photo') => {
    if (!Number.isFinite(d)) return
    const cur = out.get(id)
    if (!cur || d > cur.distanceM) out.set(id, { distanceM: d, source })
  }
  for (const ids of chunks(unique(bookingIds))) {
    const { data: logs, error: e1 } = await supabase
      .from('pod_audit_log')
      .select('booking_id, action, detail')
      .in('booking_id', ids)
      .in('action', ['otp_gate_pass', 'otp_gate_block', 'otp_gate_degraded'])
    if (e1) throw new Error(`pod_audit_log select failed: ${e1.message}`)
    for (const r of (logs ?? []) as Array<{ booking_id: string; detail: { distance_m?: number | null } | null }>) {
      if (r.detail?.distance_m != null) keep(r.booking_id, Number(r.detail.distance_m), 'code_issue')
    }
    const { data: photos, error: e2 } = await supabase
      .from('pod_evidence')
      .select('booking_id, geofence_distance_m')
      .in('booking_id', ids)
      .eq('kind', 'vehicle')
    if (e2) throw new Error(`pod_evidence select failed: ${e2.message}`)
    for (const r of (photos ?? []) as Array<{ booking_id: string; geofence_distance_m: number | string | null }>) {
      if (r.geofence_distance_m != null) keep(r.booking_id, Number(r.geofence_distance_m), 'delivery_photo')
    }
  }
  return out
}

/** Bookings with a live (unreleased) vehicle assignment. */
export async function liveAssignmentBookings(bookingIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const ids of chunks(unique(bookingIds))) {
    const { data, error } = await supabase.from('vehicle_assignments').select('booking_id').in('booking_id', ids).is('released_at', null)
    if (error) throw new Error(`vehicle_assignments select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ booking_id: string }>) out.add(r.booking_id)
  }
  return out
}

/** The latest drop-fence event per booking (written by bt-tracking-service's evaluator). */
export async function latestDropEvents(bookingIds: string[]): Promise<Map<string, { event: string; occurred_at: string }>> {
  const out = new Map<string, { event: string; occurred_at: string }>()
  for (const ids of chunks(unique(bookingIds))) {
    const { data, error } = await supabase
      .from('geofence_events')
      .select('booking_id, event, occurred_at')
      .in('booking_id', ids)
      .eq('kind', 'drop')
      .order('occurred_at', { ascending: false })
    if (error) throw new Error(`geofence_events select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ booking_id: string; event: string; occurred_at: string }>) {
      if (!out.has(r.booking_id)) out.set(r.booking_id, { event: r.event, occurred_at: r.occurred_at })
    }
  }
  return out
}

/** Damage reports at delivery: booking id to when and how much. */
export async function damageReports(): Promise<Map<string, { reported_at: string; delta: number | null; unit: string | null }>> {
  const { data, error } = await supabase.from('pod_discrepancies').select('booking_id, created_at, delta, quantity_unit').eq('reason', 'damage')
  if (error) throw new Error(`pod_discrepancies select failed: ${error.message}`)
  const out = new Map<string, { reported_at: string; delta: number | null; unit: string | null }>()
  for (const r of (data ?? []) as Array<{ booking_id: string; created_at: string; delta: number | string | null; quantity_unit: string | null }>) {
    out.set(r.booking_id, { reported_at: r.created_at, delta: r.delta == null ? null : Number(r.delta), unit: r.quantity_unit })
  }
  return out
}

export async function bookingFactsByIds(ids: string[]): Promise<BookingFact[]> {
  const out: BookingFact[] = []
  for (const part of chunks(unique(ids))) {
    const { data, error } = await supabase.from('bookings').select(BOOKING_FACT_COLUMNS).in('id', part)
    if (error) throw new Error(`bookings select failed: ${error.message}`)
    out.push(...((data ?? []) as unknown as BookingFact[]))
  }
  return out
}

/** When the driver marked each delivery done (pod_state.asserted_at). */
export async function assertedAtByBooking(bookingIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const ids of chunks(unique(bookingIds))) {
    const { data, error } = await supabase.from('pod_state').select('booking_id, asserted_at').in('booking_id', ids)
    if (error) throw new Error(`pod_state select failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ booking_id: string; asserted_at: string | null }>) if (r.asserted_at) out.set(r.booking_id, r.asserted_at)
  }
  return out
}

/** Open loads with what decides "open to bids", plus their live bid count. */
export async function openLoadsWithBids(): Promise<Array<{ booking: BookingFact; createdAt: string; openToBids: boolean; bidCount: number }>> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_FACT_COLUMNS + ', created_at, booking_type, target_driver_id')
    .in('status', ['pending', 'negotiating'])
  if (error) throw new Error(`bookings select failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<BookingFact & { created_at: string; booking_type: string | null; target_driver_id: string | null }>
  const counts = new Map<string, number>()
  for (const ids of chunks(rows.map((r) => r.id))) {
    const { data: q, error: qe } = await supabase.from('quotes').select('booking_id, status').in('booking_id', ids)
    if (qe) throw new Error(`quotes select failed: ${qe.message}`)
    for (const r of (q ?? []) as Array<{ booking_id: string; status: string }>) {
      if (!['withdrawn', 'expired', 'rejected'].includes(r.status)) counts.set(r.booking_id, (counts.get(r.booking_id) ?? 0) + 1)
    }
  }
  return rows.map((r) => ({
    booking: r,
    createdAt: r.created_at,
    // An auction is open to every carrier; a direct booking sent to one named driver is not.
    openToBids: r.booking_type === 'auction' || !r.target_driver_id,
    bidCount: counts.get(r.id) ?? 0,
  }))
}

/** Active trucks with their last working day and whether they are on a trip now. */
export async function truckActivity(): Promise<Array<{ vehicle_id: string; rc_number: string | null; fleet_owner_id: string | null; driver_id: string | null; lastActiveAt: string; busy: boolean }>> {
  const { data: vs, error } = await supabase.from('vehicles').select('id, rc_number, fleet_owner_id, driver_id, is_active, created_at')
  if (error) throw new Error(`vehicles select failed: ${error.message}`)
  const vehicles = ((vs ?? []) as Array<{ id: string; rc_number: string | null; fleet_owner_id: string | null; driver_id: string | null; is_active: boolean | null; created_at: string }>)
    .filter((v) => v.is_active !== false && (v.fleet_owner_id || v.driver_id))
  const OPEN = ['accepted', 'in_transit', 'delivery_asserted']
  const WORKED = ['accepted', 'in_transit', 'delivery_asserted', 'completed', 'paid']
  const last = new Map<string, string>()
  const busy = new Set<string>()
  const note = (vid: string, at: string, status: string) => {
    if (OPEN.includes(status)) busy.add(vid)
    const seen = last.get(vid)
    if (!seen || at > seen) last.set(vid, at)
  }
  // Fleet trucks are named on the booking; a solo truck's trips are its driver's solo bookings.
  const fleetIds = vehicles.filter((v) => v.fleet_owner_id).map((v) => v.id)
  for (const ids of chunks(fleetIds)) {
    const { data, error: e } = await supabase.from('bookings').select('vehicle_id, status, updated_at').in('vehicle_id', ids).in('status', WORKED)
    if (e) throw new Error(`bookings select failed: ${e.message}`)
    for (const r of (data ?? []) as Array<{ vehicle_id: string; status: string; updated_at: string }>) note(r.vehicle_id, r.updated_at, r.status)
    const { data: live, error: le } = await supabase.from('vehicle_assignments').select('vehicle_id').in('vehicle_id', ids).is('released_at', null)
    if (le) throw new Error(`vehicle_assignments select failed: ${le.message}`)
    for (const r of (live ?? []) as Array<{ vehicle_id: string }>) busy.add(r.vehicle_id)
  }
  const soloByDriver = new Map(vehicles.filter((v) => !v.fleet_owner_id && v.driver_id).map((v) => [v.driver_id as string, v.id]))
  for (const ids of chunks([...soloByDriver.keys()])) {
    const { data, error: e } = await supabase.from('bookings').select('driver_id, status, updated_at').in('driver_id', ids).is('fleet_owner_id', null).in('status', WORKED)
    if (e) throw new Error(`bookings select failed: ${e.message}`)
    for (const r of (data ?? []) as Array<{ driver_id: string; status: string; updated_at: string }>) {
      const vid = soloByDriver.get(r.driver_id)
      if (vid) note(vid, r.updated_at, r.status)
    }
  }
  return vehicles.map((v) => ({
    vehicle_id: v.id, rc_number: v.rc_number, fleet_owner_id: v.fleet_owner_id, driver_id: v.fleet_owner_id ? null : v.driver_id,
    lastActiveAt: last.get(v.id) ?? v.created_at, busy: busy.has(v.id),
  }))
}
