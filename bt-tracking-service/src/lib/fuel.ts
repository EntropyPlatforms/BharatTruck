// Fuel & DEF cost model.
//
// D-009 froze the SHAPE — `fuel = distance_km / mileage_kmpl x diesel_price`, mileage
// prefilled by vehicle class, diesel price editable via DIESEL_PRICE_INR. It also tagged the
// actual mileage numbers `(INFERRED — confirm)`: MCV ~6.0, HCV ~3.5 kmpl.
//
// Those inferred numbers are WRONG against the founder's own data. `vehicle_cost_norms`
// (migration 0018, seeded from CV_Parc_Tables.xlsx) says MCV Cargo 15-19T is 4.98 kmpl and
// HCV ranges 2.54-4.03 by tonnage — a 30-40% overestimate of range at the inferred values,
// which on a Mumbai-Delhi run is thousands of rupees of understated fuel. Since D-009 marked
// them explicitly non-frozen and pending confirmation, this module PINS them to the real
// table instead (recorded as D-015).
//
// Three tiers, most specific first, because a fleet truck and a solo driver's truck carry
// very different amounts of known metadata and BOTH have to produce a number:
//   1. vehicle_norms  — the truck's own model_category + emission_norm -> exact kmpl + DEF %.
//   2. vehicle_class  — no model_category (unregistered/solo truck): average over the class.
//   3. default        — norms unreachable or class unknown: a last-resort constant.
// Every estimate reports which tier produced it so the UI can say so rather than presenting
// a guess with the same confidence as measured data.

import { supabase } from './supabase.js'
import { positiveIntEnv } from './env.js'

export type FuelBasis = 'vehicle_norms' | 'vehicle_class' | 'default'
export type VehicleClass = 'SCV' | 'LCV' | 'MCV' | 'HCV'

/** Editable diesel price (D-009). Env is the default; callers may override per request. */
export const DEFAULT_DIESEL_PRICE_INR = positiveIntEnv('DIESEL_PRICE_INR', 90)

/**
 * Last-resort mileage when even the class average is unavailable. Deliberately pessimistic
 * (the heavy end of the parc) — understating a fleet owner's fuel bill is the more damaging
 * error, because it is the number they price a lane against.
 */
const LAST_RESORT_KMPL = 3.5
/** BS6 SCR engines burn DEF at ~3-5.5% of diesel volume; mid-range when unknown. */
const LAST_RESORT_DEF_PCT = 0.04

export interface MileageLookup {
  mileage_kmpl: number
  def_pct: number
  basis: FuelBasis
  basis_note: string
  model_category: string | null
  emission_norm: string | null
  vehicle_class: VehicleClass | null
}

export type NormRow = {
  model_category: string
  vehicle_class: string
  kmpl_bs6: number | string | null
  kmpl_bs4: number | string | null
  def_pct_bs6: number | string | null
  def_pct_bs4: number | string | null
}

/** Supabase returns `numeric` as a string; coerce and reject the non-usable values. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Pick the kmpl/DEF pair matching the truck's emission norm.
 *
 * `BS6_PH2` is a real value in the live `vehicles` table but has no dedicated column in
 * `vehicle_cost_norms` — phase 2 changed aftertreatment, not fuel maps — so it reads the BS6
 * figures. Anything unrecognised (including NULL) also takes BS6: it is the current norm, so
 * it is the better guess for a truck whose paperwork was never filled in.
 *
 * `kmpl_bs4` is NULL for every LCV/ICV/SCV row (those categories were never sold in BS4 in
 * this parc), so a BS4 light truck falls back to the BS6 figure rather than returning null.
 */
function pickByNorm(row: NormRow, emissionNorm: string | null): { kmpl: number; defPct: number } | null {
  const isBs4 = (emissionNorm ?? '').toUpperCase().startsWith('BS4')

  const kmpl = isBs4 ? num(row.kmpl_bs4) ?? num(row.kmpl_bs6) : num(row.kmpl_bs6) ?? num(row.kmpl_bs4)
  if (kmpl === null) return null

  const defRaw = isBs4 ? row.def_pct_bs4 ?? row.def_pct_bs6 : row.def_pct_bs6 ?? row.def_pct_bs4
  // DEF legitimately IS 0 for pre-SCR trucks, so `num()`'s >0 rule is wrong here.
  const defParsed = defRaw === null || defRaw === undefined ? NaN : parseFloat(String(defRaw))
  const defPct = Number.isFinite(defParsed) && defParsed >= 0 ? defParsed : LAST_RESORT_DEF_PCT

  return { kmpl, defPct }
}

/**
 * Resolve mileage for a truck, degrading through the three tiers.
 *
 * NEVER throws and never returns null: a fuel figure is a display value on a dashboard, and
 * a fleet owner seeing "—" because a reference table hiccuped is worse than seeing a clearly
 * labelled class average. Every failure path lands on a lower tier with an honest note.
 */
export async function resolveMileage(
  vehicle: { model_category: string | null; emission_norm: string | null } | null,
): Promise<MileageLookup> {
  return resolveMileageFrom(await loadNorms(), vehicle)
}

/**
 * The whole norms table — nine rows, so this is one small query rather than a filtered one.
 *
 * The fleet board resolves mileage for EVERY truck on every poll. Querying per vehicle would
 * be a textbook N+1 (12 trucks x 6 polls/min), so the roster loads this once and resolves in
 * memory. Returns [] on failure, which lands every truck on the default tier with an honest
 * note rather than failing the whole dashboard.
 */
export async function loadNorms(): Promise<NormRow[]> {
  const { data, error } = await supabase
    .from('vehicle_cost_norms')
    .select('model_category, vehicle_class, kmpl_bs6, kmpl_bs4, def_pct_bs6, def_pct_bs4')
  if (error) return []
  return (data ?? []) as NormRow[]
}

/** Pure resolution against a pre-loaded norms table. See the three-tier note at the top. */
export function resolveMileageFrom(
  norms: NormRow[],
  vehicle: { model_category: string | null; emission_norm: string | null } | null,
): MileageLookup {
  const modelCategory = vehicle?.model_category ?? null
  const emissionNorm = vehicle?.emission_norm ?? null

  // Tier 1 — this exact model.
  if (modelCategory) {
    const row = norms.find((n) => n.model_category === modelCategory)
    if (row) {
      const picked = pickByNorm(row, emissionNorm)
      if (picked) {
        return {
          mileage_kmpl: picked.kmpl,
          def_pct: picked.defPct,
          basis: 'vehicle_norms',
          basis_note: `Mileage for ${row.model_category} (${emissionNorm ?? 'BS6 assumed'}), from the fleet cost norms.`,
          model_category: row.model_category,
          emission_norm: emissionNorm,
          vehicle_class: (row.vehicle_class as VehicleClass) ?? null,
        }
      }
    }
  }

  // Tier 2 — average across the class. Reached when the truck has no model_category (solo
  // drivers register an RC number and little else) or its category is not in the norms table.
  const inferredClass = inferClassFromCategory(modelCategory)
  if (inferredClass) {
    const picked = norms
      .filter((n) => n.vehicle_class === inferredClass)
      .map((n) => pickByNorm(n, emissionNorm))
      .filter((p): p is { kmpl: number; defPct: number } => p !== null)

    if (picked.length) {
      return {
        mileage_kmpl: picked.reduce((s, p) => s + p.kmpl, 0) / picked.length,
        def_pct: picked.reduce((s, p) => s + p.defPct, 0) / picked.length,
        basis: 'vehicle_class',
        basis_note: `No model-specific norms for this truck — using the ${inferredClass} class average.`,
        model_category: modelCategory,
        emission_norm: emissionNorm,
        vehicle_class: inferredClass,
      }
    }
  }

  // Tier 3 — nothing known.
  return {
    mileage_kmpl: LAST_RESORT_KMPL,
    def_pct: LAST_RESORT_DEF_PCT,
    basis: 'default',
    basis_note:
      'This truck has no model category on file, so fuel is a platform-wide default. Add the model to the vehicle for an accurate figure.',
    model_category: modelCategory,
    emission_norm: emissionNorm,
    vehicle_class: inferredClass,
  }
}

/**
 * Best-effort class from a free-text model category.
 *
 * The live `vehicles.model_category` values are the norms table's own keys ("HCV Cargo
 * 42-48T", "ICV Cargo (Upto 14T)"), so a prefix match is reliable. ICV is folded into LCV
 * because that is how the norms table itself classifies it.
 */
function inferClassFromCategory(category: string | null): VehicleClass | null {
  if (!category) return null
  const c = category.toUpperCase()
  if (c.startsWith('HCV')) return 'HCV'
  if (c.startsWith('MCV')) return 'MCV'
  if (c.startsWith('ICV') || c.startsWith('LCV')) return 'LCV'
  if (c.startsWith('SCV') || c.startsWith('PICKUP')) return 'SCV'
  return null
}

export interface FuelEstimate {
  distance_km: number
  mileage_kmpl: number
  diesel_price_inr: number
  litres_required: number
  diesel_cost_inr: number
  /** Diesel Exhaust Fluid (AdBlue) — a real consumable on every BS6 truck, ~3-5.5% of diesel. */
  def_cost_inr: number
  estimated_fuel_cost_inr: number
  vehicle_class: VehicleClass | null
  model_category: string | null
  emission_norm: string | null
  basis: FuelBasis
  basis_note: string
  inputs_overridden: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The arithmetic. No Google call, no I/O — `lookup` is resolved by the caller.
 *
 * DEF is priced as a percentage of the DIESEL COST rather than of litres, matching how
 * `vehicle_cost_norms.def_pct_*` was defined in migration 0018 ("DEF as % of diesel").
 */
export function computeFuel(params: {
  distanceKm: number
  lookup: MileageLookup
  mileageOverride?: number
  dieselPriceOverride?: number
  overridden: string[]
}): FuelEstimate {
  const { distanceKm, lookup, mileageOverride, dieselPriceOverride, overridden } = params

  const mileage = mileageOverride ?? lookup.mileage_kmpl
  const dieselPrice = dieselPriceOverride ?? DEFAULT_DIESEL_PRICE_INR

  const litres = mileage > 0 ? distanceKm / mileage : 0
  const dieselCost = litres * dieselPrice
  const defCost = dieselCost * lookup.def_pct

  return {
    distance_km: round2(distanceKm),
    mileage_kmpl: round2(mileage),
    diesel_price_inr: round2(dieselPrice),
    litres_required: round2(litres),
    diesel_cost_inr: round2(dieselCost),
    def_cost_inr: round2(defCost),
    estimated_fuel_cost_inr: round2(dieselCost + defCost),
    vehicle_class: lookup.vehicle_class,
    model_category: lookup.model_category,
    emission_norm: lookup.emission_norm,
    // An overridden mileage is the caller's number, not the norms table's — say so.
    basis: mileageOverride !== undefined ? 'default' : lookup.basis,
    basis_note:
      mileageOverride !== undefined
        ? 'Mileage was supplied by the caller, overriding the fleet cost norms.'
        : lookup.basis_note,
    inputs_overridden: overridden,
  }
}
