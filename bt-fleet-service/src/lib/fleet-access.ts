import { getSupabase } from './supabase.js'
import { FleetError, type FleetOwnerRow } from './types.js'
import { getFleetOwnerByUserId, getFleetOwnerById } from './fleet-repo.js'
import type { AuthenticatedUser } from '../plugins/auth.js'

// -----------------------------------------------------------
// fleet-access — delegated fleet-staff authorization (D-1/§7 seam, migration 0036).
//
// requireFleetAccess SUPERSEDES requireFleetOwner on operational routes. The old gate asked
// "does this user OWN a fleet?"; the new one asks "may this user do THIS action on THIS fleet?"
// — where authority is either ownership (all actions) or a live `fleet_members` grant. It still
// returns the target fleet's FleetOwnerRow, so a call site keeps using owner.id unchanged.
//
// Grants are looked up PER REQUEST here, never from the JWT, so revoking a member takes effect on
// their next call. The fleet is NEVER taken from an arbitrary request body — an explicit fleetId
// only DISAMBIGUATES among fleets the caller is already authorized on.
//
// Owner-only surfaces (registering a fleet, the owner's GSTIN/profile, bank details) deliberately
// keep calling requireFleetOwner — you cannot delegate creating a fleet or seeing its KYC/bank.
// -----------------------------------------------------------

export type FleetGrant =
  | 'dispatch'        // assign trucks/drivers to bookings
  | 'bid'             // bid in auctions
  | 'settle'          // record a payment/settlement (never see bank details)
  | 'documents'       // issue the fleet's freight documents
  | 'manage_drivers'  // invite/edit/remove drivers
  | 'manage_assets'   // add/edit vehicles + finance/permits/lanes
  | 'view_analytics'  // see the fleet's money (P&L, fuel, surplus) — the money-visibility gate
  | 'admin'           // all of the above

// 'any' = any live grant on the fleet (or ownership). For READS a member must do their job:
// a dispatch clerk has to see the fleet's trucks and bookings to assign them.
export type GrantNeed = FleetGrant | 'any'

// Keep in sync with the CHECK on fleet_members.grants (migration 0036).
export const ALL_GRANTS: readonly FleetGrant[] = [
  'dispatch', 'bid', 'settle', 'documents', 'manage_drivers', 'manage_assets', 'view_analytics', 'admin',
]

const GRANT_SET = new Set<string>(ALL_GRANTS)

// getLiveFleetGrants — the fleets this user holds a LIVE (active) delegated grant on, and which
// grants. users.id -> Map<fleet_owner_id, FleetGrant[]>. Unknown grant strings are dropped
// defensively even though the DB CHECK already forbids them.
export async function getLiveFleetGrants(userId: string): Promise<Map<string, FleetGrant[]>> {
  const { data, error } = await getSupabase()
    .from('fleet_members')
    .select('fleet_owner_id, grants')
    .eq('user_id', userId)
    .eq('status', 'active')
  if (error) throw new Error(`fleet_members select failed: ${error.message}`)
  const out = new Map<string, FleetGrant[]>()
  for (const r of (data ?? []) as { fleet_owner_id: string; grants: string[] | null }[]) {
    out.set(r.fleet_owner_id, (r.grants ?? []).filter((g): g is FleetGrant => GRANT_SET.has(g)))
  }
  return out
}

// grantSatisfies — PURE. Owner and 'admin' satisfy everything; 'any' is satisfied by holding any
// grant; otherwise the exact grant must be present. Unit-tested.
export function grantSatisfies(need: GrantNeed, grants: readonly FleetGrant[], isOwner: boolean): boolean {
  if (isOwner) return true
  if (grants.includes('admin')) return true
  if (need === 'any') return grants.length > 0
  return grants.includes(need)
}

type Candidate = { fleetId: string; isOwner: boolean; grants: FleetGrant[] }

// resolveFleetCandidates — PURE. The fleets a caller may act on: the owned fleet (implicit
// all-grants) plus each fleet they hold a live grant on (owner wins when both exist).
export function resolveFleetCandidates(
  ownedFleetId: string | null,
  grantsByFleet: Map<string, FleetGrant[]>,
): Candidate[] {
  const candidates: Candidate[] = []
  if (ownedFleetId) candidates.push({ fleetId: ownedFleetId, isOwner: true, grants: [...ALL_GRANTS] })
  for (const [fleetId, grants] of grantsByFleet) {
    if (ownedFleetId && fleetId === ownedFleetId) continue
    candidates.push({ fleetId, isOwner: false, grants })
  }
  return candidates
}

// pickFleet — PURE. Choose the target fleet from the candidates: an explicit fleetId (must be a
// candidate), else the sole candidate, else the owned one, else ambiguous. Returns a FleetError
// code the caller throws, keeping this pure/testable.
export function pickFleet(
  candidates: Candidate[],
  fleetId: string | undefined,
): { ok: true; chosen: Candidate } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'AMBIGUOUS' } {
  if (candidates.length === 0) return { ok: false, code: 'NOT_FOUND' }
  if (fleetId) {
    const match = candidates.find(c => c.fleetId === fleetId)
    return match ? { ok: true, chosen: match } : { ok: false, code: 'FORBIDDEN' }
  }
  if (candidates.length === 1) return { ok: true, chosen: candidates[0] }
  const owned = candidates.find(c => c.isOwner)
  return owned ? { ok: true, chosen: owned } : { ok: false, code: 'AMBIGUOUS' }
}

// requireFleetAccess — THE delegated tenancy gate. Returns the target fleet's FleetOwnerRow, or
// throws 404/403/400. Drop-in for requireFleetOwner: `const owner = await requireFleetAccess(...)`.
export async function requireFleetAccess(
  user: AuthenticatedUser,
  need: GrantNeed,
  opts: { fleetId?: string } = {},
): Promise<FleetOwnerRow> {
  const [owned, grantsByFleet] = await Promise.all([
    getFleetOwnerByUserId(user.userId),
    getLiveFleetGrants(user.userId),
  ])

  const candidates = resolveFleetCandidates(owned?.id ?? null, grantsByFleet)
  const pick = pickFleet(candidates, opts.fleetId)
  if (!pick.ok) {
    if (pick.code === 'NOT_FOUND') {
      throw new FleetError('No fleet to act on — you neither own a fleet nor hold a grant on one', 'NOT_FOUND', 404)
    }
    if (pick.code === 'FORBIDDEN') {
      throw new FleetError('You do not have access to that fleet', 'FORBIDDEN', 403)
    }
    throw new FleetError('You hold grants on more than one fleet — pass fleet=<fleet_owner_id> to say which', 'VALIDATION_ERROR', 400)
  }

  if (!grantSatisfies(need, pick.chosen.grants, pick.chosen.isOwner)) {
    throw new FleetError(`This action needs the '${need}' grant on this fleet`, 'FORBIDDEN', 403)
  }

  // Load the target fleet's profile (the owned row if we already have it, else by id).
  const owner = pick.chosen.isOwner && owned ? owned : await getFleetOwnerById(pick.chosen.fleetId)
  if (!owner) throw new FleetError('Fleet not found', 'NOT_FOUND', 404)
  if (!owner.is_active) throw new FleetError('This fleet account is deactivated', 'FORBIDDEN', 403)
  return owner
}
