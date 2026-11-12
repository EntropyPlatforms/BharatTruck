// ============================================================
// src/lib/preferred/service.ts
//
// A shipper's Preferred carriers: the automatic half (finished trips, from bookings) merged
// with the starred half (shipper_preferred_carriers, migration 0044), plus the directory
// search the Post-a-Load picker falls back to for everyone else.
//
// SCOPE. Every read here is keyed on the CALLER's users.id as bookings.shipper_id /
// shipper_preferred_carriers.shipper_id — there is no parameter that names another
// shipper, so no request can read someone else's list. Carrier details are the public
// face only (name, city, truck number, last four phone digits); nothing financial, no
// documents, no full phone.
//
// DEGRADE, DON'T 500. Migrations are applied by hand and CD can ship this first (see the
// "migration hand-apply gate" in .github/workflows/ci.yml). Until 0044 lands, a read treats
// the stars table as empty — the automatic list and search keep working — and a star or
// unstar answers 503 naming the migration.
// ============================================================

import { supabase } from '../supabase.js'
import { isMissingRelation } from '../db-errors.js'
import { BookingError } from '../types.js'
import {
  type CarrierCard,
  type CarrierKind,
  type CarrierSearch,
  type TripTally,
  FINISHED_TRIP_STATUSES,
  carrierKey,
  maskPhone,
  rankPreferred,
  reasonsFor,
  tallyFinishedTrips,
} from './rules.js'

const STARS = 'shipper_preferred_carriers'

/** Bounded reads: a shipper with more history than this still gets a correct top of list. */
const MAX_FINISHED_TRIPS = 2000
const MAX_STARS = 200
const MAX_SEARCH_RESULTS = 20

export interface PreferredList {
  carriers: CarrierCard[]
  /** False until migration 0044 is applied — the app hides the star toggle. */
  stars_enabled: boolean
}

interface StarRow { carrier_kind: CarrierKind; carrier_id: string; created_at: string | null }
interface Ref { kind: CarrierKind; id: string }

function starsNotMigrated(): BookingError {
  return new BookingError(
    'Starring carriers is not switched on yet: the preferred-carriers table (migration 0044) is not applied to this database',
    'UPSTREAM_ERROR',
    503,
  )
}

// -----------------------------------------------------------
// Reads
// -----------------------------------------------------------

async function finishedTripTallies(shipperUserId: string): Promise<TripTally[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('driver_id, fleet_owner_id, updated_at')
    .eq('shipper_id', shipperUserId)
    .in('status', [...FINISHED_TRIP_STATUSES])
    .order('updated_at', { ascending: false })
    .limit(MAX_FINISHED_TRIPS)
  if (error) throw new Error(`finished trips select failed: ${error.message}`)
  return tallyFinishedTrips((data ?? []) as Array<{ driver_id: string | null; fleet_owner_id: string | null; updated_at: string | null }>)
}

async function starsOf(shipperUserId: string): Promise<{ rows: StarRow[]; enabled: boolean }> {
  const { data, error } = await supabase
    .from(STARS)
    .select('carrier_kind, carrier_id, created_at')
    .eq('shipper_id', shipperUserId)
    .order('created_at', { ascending: false })
    .limit(MAX_STARS)
  if (error) {
    if (isMissingRelation(error)) return { rows: [], enabled: false }
    throw new Error(`${STARS} select failed: ${error.message}`)
  }
  return { rows: (data ?? []) as StarRow[], enabled: true }
}

type Face = Omit<CarrierCard, 'trips_with_you' | 'last_trip_at' | 'starred' | 'preferred' | 'reasons'> & { user_id: string | null }

/**
 * The public face of each referenced carrier, keyed by carrierKey. Plain `in` reads
 * rather than PostgREST embeds, so a carrier whose user row is somehow missing still
 * shows (nameless) instead of vanishing. A ref whose carrier no longer exists is simply
 * absent from the map — callers drop it, which is how a star on a deleted carrier fades.
 */
async function facesOf(refs: Ref[]): Promise<Map<string, Face>> {
  const out = new Map<string, Face>()
  const driverIds = [...new Set(refs.filter((r) => r.kind === 'driver').map((r) => r.id))]
  const fleetIds = [...new Set(refs.filter((r) => r.kind === 'fleet_owner').map((r) => r.id))]

  if (driverIds.length) {
    const { data, error } = await supabase
      .from('drivers')
      .select('id, user_id, truck_number, home_base_city')
      .in('id', driverIds)
    if (error) throw new Error(`drivers select failed: ${error.message}`)
    const drivers = (data ?? []) as Array<{ id: string; user_id: string | null; truck_number: string | null; home_base_city: string | null }>
    const users = await usersById(drivers.map((d) => d.user_id).filter((x): x is string => !!x))
    const targetable = await directTargetable(drivers.map((d) => d.id))
    for (const d of drivers) {
      const u = d.user_id ? users.get(d.user_id) : undefined
      out.set(carrierKey('driver', d.id), {
        kind: 'driver',
        id: d.id,
        user_id: d.user_id,
        name: u?.full_name ?? null,
        phone_masked: maskPhone(u?.phone_number),
        city: d.home_base_city ?? u?.city ?? null,
        truck_number: d.truck_number ?? null,
        direct_targetable: targetable.has(d.id),
      })
    }
  }

  if (fleetIds.length) {
    const { data, error } = await supabase
      .from('fleet_owners')
      .select('id, user_id, company_name, contact_phone, city, is_active')
      .in('id', fleetIds)
    if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
    for (const f of (data ?? []) as Array<{ id: string; user_id: string | null; company_name: string | null; contact_phone: string | null; city: string | null; is_active: boolean | null }>) {
      if (f.is_active === false) continue
      out.set(carrierKey('fleet_owner', f.id), {
        kind: 'fleet_owner',
        id: f.id,
        user_id: f.user_id,
        name: f.company_name ?? null,
        phone_masked: maskPhone(f.contact_phone),
        city: f.city ?? null,
        truck_number: null,
        direct_targetable: false,
      })
    }
  }
  return out
}

async function usersById(ids: string[]): Promise<Map<string, { full_name: string | null; phone_number: string | null; city: string | null }>> {
  const out = new Map<string, { full_name: string | null; phone_number: string | null; city: string | null }>()
  const unique = [...new Set(ids)]
  if (!unique.length) return out
  const { data, error } = await supabase.from('users').select('id, full_name, phone_number, city').in('id', unique)
  if (error) throw new Error(`users select failed: ${error.message}`)
  for (const u of (data ?? []) as Array<{ id: string; full_name: string | null; phone_number: string | null; city: string | null }>) out.set(u.id, u)
  return out
}

/**
 * Which of these drivers can be sent a direct load: everyone EXCEPT a fleet-employed
 * driver (affiliated to a fleet AND owning no truck). The batch form of fleet.ts
 * isEmployedDriver — the same rule acceptBooking and submitQuote enforce, so the picker
 * never offers a target the booking would then strand. Fails toward "targetable" on a
 * missing relation exactly as isEmployedDriver does (no fleet table → nobody employed).
 */
async function directTargetable(driverIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(driverIds)]
  const out = new Set(ids)
  if (!ids.length) return out
  const { data: aff, error: affErr } = await supabase
    .from('fleet_drivers')
    .select('driver_id')
    .in('driver_id', ids)
    .eq('status', 'active')
  if (affErr) {
    if (isMissingRelation(affErr)) return out
    throw new Error(`fleet_drivers select failed: ${affErr.message}`)
  }
  const affiliated = new Set(((aff ?? []) as Array<{ driver_id: string }>).map((r) => r.driver_id))
  if (!affiliated.size) return out
  const { data: own, error: ownErr } = await supabase
    .from('vehicles')
    .select('driver_id')
    .in('driver_id', [...affiliated])
  if (ownErr && !isMissingRelation(ownErr)) throw new Error(`vehicles select failed: ${ownErr.message}`)
  const owners = new Set(((own ?? []) as Array<{ driver_id: string }>).map((r) => r.driver_id))
  for (const id of affiliated) if (!owners.has(id)) out.delete(id)
  return out
}

// -----------------------------------------------------------
// Public API
// -----------------------------------------------------------

/**
 * GET /me/carriers — every Preferred carrier of the caller, automatic and starred merged
 * (one card per carrier, both reasons when both apply), ranked by rankPreferred. The
 * caller's OWN driver row / fleet is never listed: you do not hire yourself (a
 * distributor moves their own loads by direct-attach).
 */
export async function listPreferredCarriers(shipperUserId: string): Promise<PreferredList> {
  const [tallies, stars] = await Promise.all([finishedTripTallies(shipperUserId), starsOf(shipperUserId)])

  const merged = new Map<string, { ref: Ref; trips: number; last: string | null; starredAt: string | null; starred: boolean }>()
  for (const t of tallies) {
    merged.set(carrierKey(t.kind, t.id), { ref: { kind: t.kind, id: t.id }, trips: t.trips, last: t.last_trip_at, starredAt: null, starred: false })
  }
  for (const s of stars.rows) {
    const key = carrierKey(s.carrier_kind, s.carrier_id)
    const m = merged.get(key) ?? { ref: { kind: s.carrier_kind, id: s.carrier_id }, trips: 0, last: null, starredAt: null, starred: false }
    m.starred = true
    m.starredAt = s.created_at
    merged.set(key, m)
  }

  const faces = await facesOf([...merged.values()].map((m) => m.ref))
  const cards: Array<CarrierCard & { starred_at: string | null }> = []
  for (const [key, m] of merged) {
    const face = faces.get(key)
    if (!face || face.user_id === shipperUserId) continue
    const { user_id: _u, ...pub } = face
    cards.push({
      ...pub,
      trips_with_you: m.trips,
      last_trip_at: m.last,
      starred: m.starred,
      preferred: true,
      reasons: reasonsFor(m.trips, m.starred),
      starred_at: m.starredAt,
    })
  }
  return {
    carriers: rankPreferred(cards).map(({ starred_at: _s, ...c }) => c),
    stars_enabled: stars.enabled,
  }
}

/**
 * GET /me/carriers/search?q= — drivers and fleets by name or full mobile number (see
 * parseCarrierSearch), so a shipper can still pick someone they have not worked with.
 * Each hit is annotated with the caller's own preference facts, so a preferred carrier
 * found by search still wears its label. Capped at MAX_SEARCH_RESULTS.
 */
export async function searchCarriers(shipperUserId: string, search: CarrierSearch): Promise<CarrierCard[]> {
  const refs: Ref[] = []

  if (search.by === 'phone') {
    const { data: users, error } = await supabase.from('users').select('id').eq('phone_number', search.phone).limit(5)
    if (error) throw new Error(`users select failed: ${error.message}`)
    const userIds = ((users ?? []) as Array<{ id: string }>).map((u) => u.id)
    refs.push(...(await carriersOwnedBy(userIds)))
    const { data: fleets, error: fErr } = await supabase.from('fleet_owners').select('id').eq('contact_phone', search.phone).limit(5)
    if (fErr) throw new Error(`fleet_owners select failed: ${fErr.message}`)
    refs.push(...((fleets ?? []) as Array<{ id: string }>).map((f) => ({ kind: 'fleet_owner' as const, id: f.id })))
  } else {
    const { data: users, error } = await supabase.from('users').select('id').ilike('full_name', search.pattern).limit(MAX_SEARCH_RESULTS)
    if (error) throw new Error(`users select failed: ${error.message}`)
    const userIds = ((users ?? []) as Array<{ id: string }>).map((u) => u.id)
    refs.push(...(await carriersOwnedBy(userIds, 'driver')))
    const { data: fleets, error: fErr } = await supabase.from('fleet_owners').select('id').ilike('company_name', search.pattern).limit(MAX_SEARCH_RESULTS)
    if (fErr) throw new Error(`fleet_owners select failed: ${fErr.message}`)
    refs.push(...((fleets ?? []) as Array<{ id: string }>).map((f) => ({ kind: 'fleet_owner' as const, id: f.id })))
  }

  const unique = [...new Map(refs.map((r) => [carrierKey(r.kind, r.id), r])).values()]
  if (!unique.length) return []

  const [faces, preferred] = await Promise.all([facesOf(unique), listPreferredCarriers(shipperUserId)])
  const prefByKey = new Map(preferred.carriers.map((c) => [carrierKey(c.kind, c.id), c]))

  const out: CarrierCard[] = []
  for (const r of unique) {
    const key = carrierKey(r.kind, r.id)
    const pref = prefByKey.get(key)
    if (pref) { out.push(pref); continue }
    const face = faces.get(key)
    if (!face || face.user_id === shipperUserId) continue
    const { user_id: _u, ...pub } = face
    out.push({ ...pub, trips_with_you: 0, last_trip_at: null, starred: false, preferred: false, reasons: [] })
  }
  // Preferred hits first (in their own rank order), then everyone else by name.
  const rank = new Map(preferred.carriers.map((c, i) => [carrierKey(c.kind, c.id), i]))
  out.sort((a, b) => {
    const ra = rank.get(carrierKey(a.kind, a.id)) ?? Infinity
    const rb = rank.get(carrierKey(b.kind, b.id)) ?? Infinity
    return ra !== rb ? ra - rb : (a.name ?? '').localeCompare(b.name ?? '')
  })
  return out.slice(0, MAX_SEARCH_RESULTS)
}

async function carriersOwnedBy(userIds: string[], only?: CarrierKind): Promise<Ref[]> {
  const ids = [...new Set(userIds)]
  if (!ids.length) return []
  const out: Ref[] = []
  if (only !== 'fleet_owner') {
    const { data, error } = await supabase.from('drivers').select('id').in('user_id', ids)
    if (error) throw new Error(`drivers select failed: ${error.message}`)
    out.push(...((data ?? []) as Array<{ id: string }>).map((d) => ({ kind: 'driver' as const, id: d.id })))
  }
  if (only !== 'driver') {
    const { data, error } = await supabase.from('fleet_owners').select('id').in('user_id', ids)
    if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
    out.push(...((data ?? []) as Array<{ id: string }>).map((f) => ({ kind: 'fleet_owner' as const, id: f.id })))
  }
  return out
}

/**
 * PUT /me/carriers/:kind/:id/star — idempotent. The carrier must exist (there is no FK:
 * carrier_id points at one of two tables) and must not be the caller themselves.
 */
export async function starCarrier(shipperUserId: string, ref: Ref): Promise<{ kind: CarrierKind; id: string; starred: true }> {
  const face = (await facesOf([ref])).get(carrierKey(ref.kind, ref.id))
  if (!face) throw new BookingError('Carrier not found', 'NOT_FOUND', 404)
  if (face.user_id === shipperUserId) {
    throw new BookingError('You cannot mark yourself as a preferred carrier', 'VALIDATION_ERROR', 400)
  }
  const { error } = await supabase
    .from(STARS)
    .insert({ shipper_id: shipperUserId, carrier_kind: ref.kind, carrier_id: ref.id })
  // 23505 = already starred: the desired end state, not a failure.
  if (error && error.code !== '23505') {
    if (isMissingRelation(error)) throw starsNotMigrated()
    throw new Error(`${STARS} insert failed: ${error.message}`)
  }
  return { kind: ref.kind, id: ref.id, starred: true }
}

/**
 * DELETE /me/carriers/:kind/:id/star — idempotent; un-starring something not starred is
 * a no-op success. Removes the STAR only: a carrier with finished trips stays Preferred,
 * because that half is a record of what happened, not a setting.
 */
export async function unstarCarrier(shipperUserId: string, ref: Ref): Promise<{ kind: CarrierKind; id: string; starred: false }> {
  const { error } = await supabase
    .from(STARS)
    .delete()
    .eq('shipper_id', shipperUserId)
    .eq('carrier_kind', ref.kind)
    .eq('carrier_id', ref.id)
  if (error) {
    if (isMissingRelation(error)) throw starsNotMigrated()
    throw new Error(`${STARS} delete failed: ${error.message}`)
  }
  return { kind: ref.kind, id: ref.id, starred: false }
}
