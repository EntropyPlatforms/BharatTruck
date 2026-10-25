import { getSupabase } from './supabase.js'
import {
  asRow,
  asRowOrNull,
  asRows,
  FleetError,
  UNIQUE_VIOLATION,
  type FleetDriverRow,
  type FleetDriverStatus,
  type FleetOwnerRow,
} from './types.js'
import type { AuthenticatedUser } from '../plugins/auth.js'

// -----------------------------------------------------------
// fleet-repo — tenancy resolution and the fleet_owners / fleet_drivers tables.
//
// TENANCY IS THE TOP RISK OF THIS SLICE. Every owner-scoped route resolves its
// fleet_owner_id here, from the JWT's users.id, and scopes every subsequent query
// by it. A fleet_owner_id arriving in a request body is NEVER trusted — there is
// deliberately no code path that reads one.
// -----------------------------------------------------------

const OWNER_COLUMNS =
  'id, user_id, company_name, gstin, pan, contact_phone, billing_address, city, state, ' +
  'monthly_overhead_inr, is_active, created_at, updated_at'

// requireFleetOwner — THE tenancy gate. Call this first on every owner-scoped
// route; the returned row's `id` is the only fleet_owner_id the request may touch.
//
// D-27 DE-ROLE (§10.3 item 1 — fleet-service was the one domain the earlier de-role
// skipped): authorize on the RESOLVED fleet-owner PROFILE, never the JWT `role` string.
// An owner-driver (role='driver') who has grown into a fleet — created a fleet_owners
// row via POST /identity/fleet-owners/me — IS a fleet owner for this request, and the
// stale `role` is not the truth of who owns the fleet. Tenancy is unchanged and is the
// real gate: getFleetOwnerByUserId scopes to the caller's OWN user_id, so a caller with
// no fleet profile still gets a 404 and no caller can ever reach another fleet's estate.
export async function requireFleetOwner(user: AuthenticatedUser): Promise<FleetOwnerRow> {
  const owner = await getFleetOwnerByUserId(user.userId)
  if (!owner) {
    throw new FleetError('Fleet profile not found — register one at POST /fleet/owners', 'NOT_FOUND', 404)
  }
  if (!owner.is_active) {
    throw new FleetError('This fleet account is deactivated', 'FORBIDDEN', 403)
  }
  return owner
}

// requireDriver — D-27 DE-ROLE (§10.3, mirror of requireFleetOwner above): authorize on
// the RESOLVED drivers PROFILE, never the JWT `role` string. A shipper-turned-driver
// (role='shipper') who completed driver onboarding via POST /drivers/me — and so holds a
// drivers row — IS a driver for this request; the stale `role` is not the truth of it. The
// drivers-row lookup is the real gate: it scopes to the caller's OWN user_id, so a caller
// with no driver profile still gets a 404 and a fleet_owner token (which holds no drivers
// row at all) can never reach the invite inbox — exactly as the old role check refused it.
export async function requireDriver(user: AuthenticatedUser): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from('drivers')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle()
  if (error) throw new Error(`Driver lookup failed: ${error.message}`)
  if (!data) throw new FleetError('Driver profile not found', 'NOT_FOUND', 404)
  return data as { id: string }
}

export async function getFleetOwnerByUserId(userId: string): Promise<FleetOwnerRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_owners')
    .select(OWNER_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
  return asRowOrNull<FleetOwnerRow>(data)
}

// getFleetOwnerById — the fleet's profile row by fleet_owners.id (the tenant key). Used by the
// delegated-access gate (fleet-access.ts) to load the target fleet a member is acting on, which
// is NOT the caller's own user_id. A fleet_owner_id reaching this has already been proven to be
// one the caller owns or holds a live grant on — it is never taken raw from a request body.
export async function getFleetOwnerById(fleetOwnerId: string): Promise<FleetOwnerRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_owners')
    .select(OWNER_COLUMNS)
    .eq('id', fleetOwnerId)
    .maybeSingle()
  if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
  return asRowOrNull<FleetOwnerRow>(data)
}

export type CreateFleetOwnerInput = {
  user_id: string
  company_name: string
  gstin?: string | null
  pan?: string | null
  contact_phone?: string | null
  billing_address?: string | null
  city?: string | null
  state?: string | null
  monthly_overhead_inr?: number
}

export async function createFleetOwner(input: CreateFleetOwnerInput): Promise<FleetOwnerRow> {
  const { data, error } = await getSupabase()
    .from('fleet_owners')
    .insert(input)
    .select(OWNER_COLUMNS)
    .single()
  if (error) {
    // fleet_owners.user_id is UNIQUE — a second registration is a conflict, not a 500.
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError('A fleet profile already exists for this account', 'CONFLICT', 409)
    }
    throw new Error(`fleet_owners insert failed: ${error.message}`)
  }
  return asRow<FleetOwnerRow>(data)
}

export async function updateFleetOwner(
  fleetOwnerId: string,
  patch: Partial<Omit<CreateFleetOwnerInput, 'user_id'>>,
): Promise<FleetOwnerRow> {
  const { data, error } = await getSupabase()
    .from('fleet_owners')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', fleetOwnerId)
    .select(OWNER_COLUMNS)
    .single()
  if (error) throw new Error(`fleet_owners update failed: ${error.message}`)
  return asRow<FleetOwnerRow>(data)
}

// -----------------------------------------------------------
// fleet_drivers — affiliation lifecycle
// -----------------------------------------------------------

const AFFILIATION_COLUMNS =
  'id, fleet_owner_id, driver_id, status, monthly_salary_inr, invited_by, ' +
  'invited_at, responded_at, left_at, created_at, updated_at'

export type DriverIdentity = {
  driver_id: string
  user_id: string
  full_name: string | null
  phone_number: string | null
  kyc_status: string | null
  average_rating: number | null
  total_trips: number | null
}

// findDriverByPhone / findDriverByEmail — an owner invites an EXISTING driver by ONE of two
// channels they pick (D-…, dual-channel invites). Both resolve <channel> -> users row ->
// drivers.id; a target IS a driver iff they hold a drivers row (D-27 de-role), never by a
// role string. Only the way the user is found differs, so it is one shared projection.

type UserLookupRow = { id: string; full_name: string | null; phone_number: string | null; kyc_status: string | null }
const USER_LOOKUP_COLS = 'id, full_name, phone_number, kyc_status'

async function driverIdentityForUser(user: UserLookupRow | null, noAccountMsg: string): Promise<DriverIdentity> {
  if (!user) throw new FleetError(noAccountMsg, 'NOT_FOUND', 404)
  const { data: driver, error: driverErr } = await getSupabase()
    .from('drivers')
    .select('id, average_rating, total_trips')
    .eq('user_id', user.id)
    .maybeSingle()
  if (driverErr) throw new Error(`drivers select failed: ${driverErr.message}`)
  if (!driver) throw new FleetError('That driver has not completed driver onboarding yet', 'NOT_FOUND', 404)
  const d = driver as { id: string; average_rating: number | null; total_trips: number | null }
  const counted = (await completedTripCounts([d.id]))?.get(d.id)
  if (counted !== undefined) d.total_trips = counted
  return {
    driver_id: d.id,
    user_id: user.id,
    full_name: user.full_name,
    phone_number: user.phone_number,
    kyc_status: user.kyc_status,
    average_rating: d.average_rating,
    total_trips: d.total_trips,
  }
}

/**
 * Canonicalise an Indian mobile to the bare 10-digit form bt-auth-service STORES it in
 * (verify-otp inserts `phone_number` matching /^[6-9]\d{9}$/). An owner may type the number with
 * a +91 / 91 country code, a domestic '0' trunk prefix, or spaces/dashes — every spelling must
 * resolve to the SAME account. Returns null for anything that is not a valid Indian mobile.
 * Exported (and pure) so the exact rule can be unit-tested without a database. Review F23.
 */
export function toCanonicalPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  const local =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits
  return /^[6-9]\d{9}$/.test(local) ? local : null
}

/**
 * Escape PostgREST ILIKE metacharacters so a lookup value matches LITERALLY. Without it a driver's
 * real email containing an underscore ('ravi_kumar@…', very common) is a LIKE single-char wildcard
 * that can match a look-alike account or return multiple rows. Review F24.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

export async function findDriverByPhone(phone: string): Promise<DriverIdentity> {
  const canonical = toCanonicalPhone(phone)
  if (!canonical) {
    throw new FleetError(
      "That is not a valid Indian mobile number — enter the driver's 10-digit number",
      'VALIDATION_ERROR',
      400,
    )
  }
  const { data, error } = await getSupabase()
    .from('users').select(USER_LOOKUP_COLS).eq('phone_number', canonical).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  return driverIdentityForUser(
    data as UserLookupRow | null,
    'No BharatTruck account exists for that phone number — the driver must sign up first',
  )
}

export async function findDriverByEmail(email: string): Promise<DriverIdentity> {
  // ilike gives the case-insensitivity an owner expects; escapeLikePattern keeps %/_ LITERAL so an
  // underscore in the local part is a real character, not a wildcard — a case-insensitive EXACT
  // match (review F24). The old "no wildcards" comment was untrue for the common underscore email.
  const { data, error } = await getSupabase()
    .from('users').select(USER_LOOKUP_COLS).ilike('email', escapeLikePattern(email.trim())).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  return driverIdentityForUser(
    data as UserLookupRow | null,
    'No BharatTruck account exists for that email — the driver must sign up first',
  )
}

// hydrateDriverIdentities — batch drivers.id -> name/phone/KYC in two bounded
// queries. Explicit joins rather than PostgREST embedding so the roster does not
// depend on FK-name inference.
export async function hydrateDriverIdentities(driverIds: string[]): Promise<Map<string, DriverIdentity>> {
  const out = new Map<string, DriverIdentity>()
  if (driverIds.length === 0) return out

  const supabase = getSupabase()
  const { data: drivers, error: driverErr } = await supabase
    .from('drivers')
    .select('id, user_id, average_rating, total_trips')
    .in('id', driverIds)
  if (driverErr) throw new Error(`drivers select failed: ${driverErr.message}`)

  const driverRows = (drivers ?? []) as {
    id: string; user_id: string; average_rating: number | null; total_trips: number | null
  }[]
  if (driverRows.length === 0) return out

  const counts = await completedTripCounts(driverRows.map((d) => d.id))
  if (counts) for (const d of driverRows) d.total_trips = counts.get(d.id) ?? 0

  const { data: users, error: userErr } = await supabase
    .from('users')
    .select('id, full_name, phone_number, kyc_status')
    .in('id', driverRows.map(d => d.user_id))
  if (userErr) throw new Error(`users select failed: ${userErr.message}`)

  const userById = new Map(
    ((users ?? []) as { id: string; full_name: string | null; phone_number: string | null; kyc_status: string | null }[])
      .map(u => [u.id, u]),
  )
  for (const d of driverRows) {
    const u = userById.get(d.user_id)
    out.set(d.id, {
      driver_id: d.id,
      user_id: d.user_id,
      full_name: u?.full_name ?? null,
      phone_number: u?.phone_number ?? null,
      kyc_status: u?.kyc_status ?? null,
      average_rating: d.average_rating,
      total_trips: d.total_trips,
    })
  }
  return out
}

export async function inviteDriver(
  fleetOwnerId: string,
  driverId: string,
  invitedBy: string,
): Promise<FleetDriverRow> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .insert({ fleet_owner_id: fleetOwnerId, driver_id: driverId, invited_by: invitedBy, status: 'pending' })
    .select(AFFILIATION_COLUMNS)
    .single()
  if (error) {
    // fleet_drivers_one_live_per_driver: the driver already has a pending or active
    // affiliation (possibly with a DIFFERENT fleet — which we must not disclose).
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError(
        'That driver already has a pending or active fleet affiliation',
        'CONFLICT',
        409,
      )
    }
    throw new Error(`fleet_drivers insert failed: ${error.message}`)
  }
  return asRow<FleetDriverRow>(data)
}

export async function listFleetDrivers(
  fleetOwnerId: string,
  statuses?: FleetDriverStatus[],
): Promise<FleetDriverRow[]> {
  let query = getSupabase()
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
  if (statuses?.length) query = query.in('status', statuses)

  const { data, error } = await query.order('invited_at', { ascending: false })
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
  return asRows<FleetDriverRow>(data)
}

// getFleetDriverById — always scoped by fleet_owner_id so one fleet can never
// address another fleet's affiliation row by guessing its uuid.
export async function getFleetDriverById(
  fleetOwnerId: string,
  affiliationId: string,
): Promise<FleetDriverRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('id', affiliationId)
    .eq('fleet_owner_id', fleetOwnerId)
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
  return asRowOrNull<FleetDriverRow>(data)
}

// getActiveAffiliation — the assignment guard: is this driver actually employed by
// THIS fleet right now?
export async function getActiveAffiliation(
  fleetOwnerId: string,
  driverId: string,
): Promise<FleetDriverRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('driver_id', driverId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
  return asRowOrNull<FleetDriverRow>(data)
}

// getLatestAffiliation — the salary source for the wage allocation. Deliberately
// NOT filtered to 'active': a driver who has since left still earned a salary
// during the months whose economics we are rolling up.
export async function getLatestAffiliation(
  fleetOwnerId: string,
  driverId: string,
): Promise<FleetDriverRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('driver_id', driverId)
    .order('invited_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
  return asRowOrNull<FleetDriverRow>(data)
}

export async function updateFleetDriver(
  affiliationId: string,
  patch: Partial<Pick<FleetDriverRow, 'status' | 'monthly_salary_inr' | 'responded_at' | 'left_at'>>,
): Promise<FleetDriverRow> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', affiliationId)
    .select(AFFILIATION_COLUMNS)
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError(
        'That driver already has a pending or active affiliation elsewhere',
        'CONFLICT',
        409,
      )
    }
    throw new Error(`fleet_drivers update failed: ${error.message}`)
  }
  return asRow<FleetDriverRow>(data)
}

// listPendingInvitesForDriver — driver-side inbox, joined to the inviting fleet's
// company name (a driver must know WHO is asking before accepting).
export async function listPendingInvitesForDriver(
  driverId: string,
): Promise<(FleetDriverRow & { company_name: string | null; fleet_city: string | null })[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('driver_id', driverId)
    .eq('status', 'pending')
    .order('invited_at', { ascending: false })
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)

  const invites = asRows<FleetDriverRow>(data)
  if (invites.length === 0) return []

  const { data: owners, error: ownerErr } = await supabase
    .from('fleet_owners')
    .select('id, company_name, city')
    .in('id', invites.map(i => i.fleet_owner_id))
  if (ownerErr) throw new Error(`fleet_owners select failed: ${ownerErr.message}`)

  const ownerById = new Map(
    ((owners ?? []) as { id: string; company_name: string; city: string | null }[]).map(o => [o.id, o]),
  )
  return invites.map(i => ({
    ...i,
    company_name: ownerById.get(i.fleet_owner_id)?.company_name ?? null,
    fleet_city: ownerById.get(i.fleet_owner_id)?.city ?? null,
  }))
}

// countVehiclesOwnedByDriver — trucks this driver owns OUTRIGHT.
//
// `vehicles.driver_id` references drivers(id), and migration 0022's
// vehicles_single_owner CHECK guarantees a truck has exactly one owner, so a hit
// here is unambiguous ownership — not "is driving", not "is assigned to", OWNS.
//
// This is the discriminator that separates a commercial partner from an
// employee. It is the fleet-service twin of driverOwnsAnyVehicle() in
// bt-booking-service/src/lib/fleet.ts, and the two MUST agree: if they drift,
// the app renders one product while the API enforces the other, which is the
// exact class of bug the affiliation signal was added to fix.
export async function countVehiclesOwnedByDriver(driverId: string): Promise<number> {
  const supabase = getSupabase()
  const { count, error } = await supabase
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('driver_id', driverId)
  if (error) throw new Error(`vehicles count failed: ${error.message}`)
  return count ?? 0
}

// getAffiliationForDriver — the driver-side "who do I drive for?" lookup.
//
// This is the signal the driver app needs to know WHICH product it is: an
// affiliated driver has no load board and never bids (founder Q14), so the app
// must render assigned trips rather than a marketplace. Without it the client
// cannot tell the two apart — `/invites/mine` only ever returns 'pending' rows,
// so the moment a driver accepts, the affiliation becomes invisible to them.
//
// Keyed on status='active' to match isFleetAffiliatedDriver() in
// bt-booking-service/src/lib/fleet.ts — the two MUST agree, or the client would
// render one product while the API enforces the other.
export async function getAffiliationForDriver(
  driverId: string,
): Promise<(FleetDriverRow & { company_name: string | null; fleet_city: string | null }) | null> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('driver_id', driverId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)

  const affiliation = asRowOrNull<FleetDriverRow>(data)
  if (!affiliation) return null

  const { data: owner, error: ownerErr } = await supabase
    .from('fleet_owners')
    .select('company_name, city')
    .eq('id', affiliation.fleet_owner_id)
    .maybeSingle()
  if (ownerErr) throw new Error(`fleet_owners select failed: ${ownerErr.message}`)

  const ownerRow = owner as { company_name: string; city: string | null } | null
  return {
    ...affiliation,
    company_name: ownerRow?.company_name ?? null,
    fleet_city: ownerRow?.city ?? null,
  }
}

// getInviteForDriver — scoped by driver_id: a driver may only respond to an
// invitation addressed to them.
export async function getInviteForDriver(
  driverId: string,
  affiliationId: string,
): Promise<FleetDriverRow | null> {
  const { data, error } = await getSupabase()
    .from('fleet_drivers')
    .select(AFFILIATION_COLUMNS)
    .eq('id', affiliationId)
    .eq('driver_id', driverId)
    .maybeSingle()
  if (error) throw new Error(`fleet_drivers select failed: ${error.message}`)
  return asRowOrNull<FleetDriverRow>(data)
}

// getActiveDriverIds — authoritative membership from Postgres. GET /fleet/live
// serves from the Redis set and falls back to this on a cold/evicted key, so the
// live map is self-healing rather than silently empty after a Redis restart.
export async function getActiveDriverIds(fleetOwnerId: string): Promise<string[]> {
  const rows = await listFleetDrivers(fleetOwnerId, ['active'])
  return rows.map(r => r.driver_id)
}

// Finished trips per driver, counted from bookings (completed or paid). drivers.total_trips is
// only ever written by the complete_trip() database function, which no code calls — so it reads
// 0 for every driver. Counting is self-correcting and includes every past trip. Returns null for
// the whole batch when the count cannot be read, so callers fall back rather than show a wrong 0.
export async function completedTripCounts(driverIds: string[]): Promise<Map<string, number> | null> {
  const ids = [...new Set(driverIds.filter(Boolean))]
  const out = new Map<string, number>(ids.map((id) => [id, 0]))
  if (ids.length === 0) return out
  const { data, error } = await getSupabase()
    .from('bookings')
    .select('driver_id')
    .in('driver_id', ids)
    .in('status', ['completed', 'paid'])
  if (error) return null
  for (const r of (data ?? []) as { driver_id: string }[]) out.set(r.driver_id, (out.get(r.driver_id) ?? 0) + 1)
  return out
}
