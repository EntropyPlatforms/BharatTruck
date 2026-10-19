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
