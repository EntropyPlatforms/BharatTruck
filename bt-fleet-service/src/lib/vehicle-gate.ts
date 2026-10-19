import { getSupabase } from './supabase.js'
import { FleetError, type FleetOwnerRow } from './types.js'

// -----------------------------------------------------------
// vehicle-gate — "you can only add a truck once your business identity is on file".
//
// Product rule (2026-09-30): a driver joins BharatTruck with just their own details
// (DL, profile, bank) and no truck. Putting a TRUCK on the platform is a business act —
// it is what gets billed on invoices and e-way bills — so it needs the business's GST
// registration first. This gate sits in front of every route that INSERTS a vehicle:
// POST /fleet/vehicles, POST /fleet/vehicles/bulk (here) and POST /onboarding/vehicle
// (bt-auth-service, same rule against users.gstin). Editing, retiring or reading a truck
// that already exists is NOT gated — the rule is about adding assets, not about locking
// people out of the ones they already run.
//
// "GST on file" means EITHER the fleet profile's GSTIN (fleet_owners.gstin — what the
// company puts on an invoice) OR the owner's own account GSTIN (users.gstin — the FB-04
// shipper path). Both are format-checked on write, so a non-null value is a well-formed
// GSTIN. PAN is not asked for separately: characters 3–12 of a GSTIN ARE the PAN.
// -----------------------------------------------------------

export const GST_REQUIRED_CODE = 'GSTIN_REQUIRED' as const

export type BusinessIdentityFacts = {
  /** fleet_owners.gstin */
  fleet_gstin: string | null
  /** users.gstin of the fleet OWNER (not of a delegated member acting on the fleet). */
  owner_user_gstin: string | null
}

function present(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

// canAddVehicle — PURE. Unit-tested. The one place the rule is written down.
export function canAddVehicle(facts: BusinessIdentityFacts): boolean {
  return present(facts.fleet_gstin) || present(facts.owner_user_gstin)
}

export const GST_REQUIRED_MESSAGE =
  'Add your GST registration (GSTIN) in Settings before adding a truck. ' +
  'Drivers can complete their own profile without a truck; trucks need the business\'s GSTIN.'

// requireBusinessIdentity — the DB-touching half. Loads the owner's account GSTIN only when the
// fleet profile has none (the common case is one indexed read that short-circuits).
export async function requireBusinessIdentity(owner: FleetOwnerRow): Promise<void> {
  let ownerUserGstin: string | null = null
  if (!present(owner.gstin)) {
    const { data, error } = await getSupabase()
      .from('users')
      .select('gstin')
      .eq('id', owner.user_id)
      .maybeSingle()
    if (error) throw new Error(`users select failed: ${error.message}`)
    ownerUserGstin = (data as { gstin: string | null } | null)?.gstin ?? null
  }
  if (!canAddVehicle({ fleet_gstin: owner.gstin, owner_user_gstin: ownerUserGstin })) {
    throw new FleetError(GST_REQUIRED_MESSAGE, GST_REQUIRED_CODE, 403)
  }
}
