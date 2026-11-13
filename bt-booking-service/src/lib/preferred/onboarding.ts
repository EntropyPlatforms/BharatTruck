// ============================================================
// src/lib/preferred/onboarding.ts
//
// How a shipper brings carriers onto their Preferred list without starring them one by one:
//
//   * the INVITE LINK (invite-link.ts): a fleet owner, or a driver with their own truck, opens
//     it, signs in and accepts; they become Preferred for that shipper.
//   * BULK (a CSV of name + mobile): every row that is already a carrier on BharatTruck is
//     starred at once; every other row comes back with a reason, and the app offers the shipper
//     their invite link to send to those numbers.
//
// WHO CAN BE A PREFERRED CARRIER. The same people who can carry a load: a fleet (its owner
// accepts on its behalf) or a driver who owns at least one active truck. A driver with no truck
// of their own cannot take a load (they drive for a fleet, whose owner bids), so they are told
// to add their truck first, never silently starred. A fleet wins over the owner's own driver
// profile, because loads from this shipper would go to the fleet.
//
// Nothing here creates an account, sends a message, or reveals anything about another person
// beyond what the shipper already typed (their own CSV) or the public card (name, city, last
// four digits) the Preferred list already shows.
// ============================================================

import { supabase } from '../supabase.js'
import { BookingError } from '../types.js'
import { normalizeIndianMobile } from '../consignee/rules.js'
import type { CarrierKind } from './rules.js'
import { starCarrier } from './service.js'
import { resolveCarrierInvite } from './invite-link.js'

export type CarrierIdentity =
  | { status: 'fleet_owner'; id: string }
  | { status: 'driver'; id: string }
  | { status: 'driver_no_truck'; id: string }
  | { status: 'none' }

/** What one user can be on a shipper's Preferred list. */
export async function carrierIdentityOf(userId: string): Promise<CarrierIdentity> {
  const { data: fleet, error: fErr } = await supabase
    .from('fleet_owners')
    .select('id, is_active')
    .eq('user_id', userId)
    .maybeSingle()
  if (fErr) throw new Error(`fleet_owners select failed: ${fErr.message}`)
  const f = fleet as { id: string; is_active: boolean | null } | null
  if (f && f.is_active !== false) return { status: 'fleet_owner', id: f.id }

  const { data: driver, error: dErr } = await supabase.from('drivers').select('id').eq('user_id', userId).maybeSingle()
  if (dErr) throw new Error(`drivers select failed: ${dErr.message}`)
  const d = driver as { id: string } | null
  if (!d) return { status: 'none' }

  const { count, error: vErr } = await supabase
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('driver_id', d.id)
    .eq('is_active', true)
  if (vErr) throw new Error(`vehicles select failed: ${vErr.message}`)
  return (count ?? 0) >= 1 ? { status: 'driver', id: d.id } : { status: 'driver_no_truck', id: d.id }
}

/** The name a carrier sees on the join page: the shipper's name, nothing else. */
async function shipperPublicName(shipperId: string): Promise<string | null> {
  const { data, error } = await supabase.from('users').select('full_name').eq('id', shipperId).maybeSingle()
  if (error) return null
  return (data as { full_name: string | null } | null)?.full_name ?? null
}

/** POST /me/carriers/join/preview — public: who sent this link, and until when it works. */
export async function previewCarrierInvite(token: unknown): Promise<{ shipper_name: string | null; expires_at: string }> {
  const link = await resolveCarrierInvite(token)
  return { shipper_name: await shipperPublicName(link.shipperId), expires_at: link.expiresAt }
}

export type AcceptResult = {
  shipper_name: string | null
  kind: CarrierKind
  /** False when they were already starred by this shipper (opening the link twice is harmless). */
  added: boolean
}

/** POST /me/carriers/join/accept — the signed-in carrier joins the shipper's Preferred list. */
export async function acceptCarrierInvite(userId: string, token: unknown): Promise<AcceptResult> {
  const link = await resolveCarrierInvite(token)
  if (link.shipperId === userId) {
    throw new BookingError('This is your own invite link. Share it with the fleet owners and truck drivers you want to work with.', 'CONFLICT', 409)
  }
  const who = await carrierIdentityOf(userId)
  if (who.status === 'driver_no_truck') {
    throw new BookingError(
      'Only drivers with their own truck can join a shipper\'s preferred carriers. Add your truck on the Vehicles page, then open this link again.',
      'FORBIDDEN',
      403,
    )
  }
  if (who.status === 'none') {
    throw new BookingError(
      'This link is for fleet owners and truck drivers. Set up your fleet or your driver profile with your truck, then open this link again.',
      'FORBIDDEN',
      403,
    )
  }
  const already = await isStarred(link.shipperId, who.status, who.id)
  if (!already) await starCarrier(link.shipperId, { kind: who.status, id: who.id })
  return { shipper_name: await shipperPublicName(link.shipperId), kind: who.status, added: !already }
}

async function isStarred(shipperId: string, kind: CarrierKind, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('shipper_preferred_carriers')
    .select('carrier_id')
    .eq('shipper_id', shipperId)
    .eq('carrier_kind', kind)
    .eq('carrier_id', id)
    .limit(1)
  // A missing table is answered by starCarrier's own 503 a moment later.
  if (error) return false
  return ((data ?? []) as unknown[]).length > 0
}

// -----------------------------------------------------------
// Bulk
// -----------------------------------------------------------

export const MAX_BULK_ROWS = 200

export type BulkRowInput = { name?: string | null; mobile: string }

export type BulkRowStatus =
  | 'added'            // starred now
  | 'already_added'    // was already on the list (starred)
  | 'not_on_bharattruck' // nobody with this mobile carries loads on BharatTruck yet: send the invite link
  | 'needs_truck'      // a driver without a truck of their own
  | 'invalid_mobile'
  | 'duplicate'        // the same mobile earlier in this file
  | 'self'             // the shipper's own number

export type BulkRowResult = {
  row: number
  name: string | null
  mobile: string
  status: BulkRowStatus
  /** Public card fields for a matched carrier only. */
  carrier: { kind: CarrierKind; id: string; name: string | null } | null
}

export type BulkPlanRow =
  | { row: number; name: string | null; mobile: string; status: 'invalid_mobile' | 'duplicate' }
  | { row: number; name: string | null; mobile: string; status: 'lookup' }

/** Pure: normalise numbers, flag bad and repeated ones. Pinned by test/preferred-onboarding.unit.mts. */
export function planBulkRows(rows: BulkRowInput[]): BulkPlanRow[] {
  const seen = new Set<string>()
  return rows.map((r, i) => {
    const name = (r.name ?? '').trim().slice(0, 120) || null
    const raw = String(r.mobile ?? '').trim()
    const mobile = normalizeIndianMobile(raw)
    if (!mobile) return { row: i + 1, name, mobile: raw.slice(0, 20), status: 'invalid_mobile' as const }
    if (seen.has(mobile)) return { row: i + 1, name, mobile, status: 'duplicate' as const }
    seen.add(mobile)
    return { row: i + 1, name, mobile, status: 'lookup' as const }
  })
}

/** Phone formats an account may have been stored in. */
function phoneVariants(m: string): string[] {
  return [m, `+91${m}`, `91${m}`]
}

/** POST /me/carriers/bulk — per-row outcome, never all-or-nothing. */
export async function bulkAddCarriers(shipperId: string, rows: BulkRowInput[]): Promise<BulkRowResult[]> {
  if (rows.length === 0) throw new BookingError('The file has no rows', 'VALIDATION_ERROR', 400)
  if (rows.length > MAX_BULK_ROWS) {
    throw new BookingError(`Up to ${MAX_BULK_ROWS} rows at a time. Split the file and upload the rest separately.`, 'VALIDATION_ERROR', 400)
  }
  const plan = planBulkRows(rows)
  const out: BulkRowResult[] = []
  for (const p of plan) {
    if (p.status !== 'lookup') { out.push({ ...p, carrier: null }); continue }
    out.push(await bulkOne(shipperId, p))
  }
  return out
}

async function bulkOne(shipperId: string, p: { row: number; name: string | null; mobile: string }): Promise<BulkRowResult> {
  const base = { row: p.row, name: p.name, mobile: p.mobile }
  const { data: users, error } = await supabase.from('users').select('id').in('phone_number', phoneVariants(p.mobile)).limit(5)
  if (error) throw new Error(`users select failed: ${error.message}`)
  const userIds = ((users ?? []) as Array<{ id: string }>).map((u) => u.id)
  if (userIds.includes(shipperId)) return { ...base, status: 'self', carrier: null }

  // A fleet can also be found by its business contact number.
  const { data: fleets, error: fErr } = await supabase
    .from('fleet_owners')
    .select('id, user_id, is_active')
    .in('contact_phone', phoneVariants(p.mobile))
    .limit(5)
  if (fErr) throw new Error(`fleet_owners select failed: ${fErr.message}`)
  const fleetRows = ((fleets ?? []) as Array<{ id: string; user_id: string | null; is_active: boolean | null }>).filter((f) => f.is_active !== false)
  if (fleetRows.some((f) => f.user_id === shipperId)) return { ...base, status: 'self', carrier: null }

  let match: { kind: CarrierKind; id: string } | null = fleetRows[0] ? { kind: 'fleet_owner', id: fleetRows[0].id } : null
  let noTruck = false
  for (const uid of userIds) {
    if (match) break
    const who = await carrierIdentityOf(uid)
    if (who.status === 'fleet_owner' || who.status === 'driver') match = { kind: who.status, id: who.id }
    else if (who.status === 'driver_no_truck') noTruck = true
  }
  if (!match) return { ...base, status: noTruck ? 'needs_truck' : 'not_on_bharattruck', carrier: null }

  const already = await isStarred(shipperId, match.kind, match.id)
  if (!already) await starCarrier(shipperId, match)
  return { ...base, status: already ? 'already_added' : 'added', carrier: { ...match, name: await carrierName(match) } }
}

async function carrierName(ref: { kind: CarrierKind; id: string }): Promise<string | null> {
  if (ref.kind === 'fleet_owner') {
    const { data } = await supabase.from('fleet_owners').select('company_name').eq('id', ref.id).maybeSingle()
    return (data as { company_name: string | null } | null)?.company_name ?? null
  }
  const { data } = await supabase.from('drivers').select('user_id').eq('id', ref.id).maybeSingle()
  const uid = (data as { user_id: string | null } | null)?.user_id
  if (!uid) return null
  const { data: u } = await supabase.from('users').select('full_name').eq('id', uid).maybeSingle()
  return (u as { full_name: string | null } | null)?.full_name ?? null
}

