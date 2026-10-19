import { getSupabase } from './supabase.js'

// -----------------------------------------------------------
// cost-engine — the REAL deterministic operating-cost floor, built on the
// founder's CV-Parc norms (seeded by migration 0018 into vehicle_cost_norms /
// vehicle_service_cost_by_age / fleet_cost_settings) instead of the flat
// ASSUMPTION constants in lib/cto-cost.ts.
//
// It MIRRORS the formulas in bt-fleet-service/src/lib/economics.ts (copied, not
// imported — no cross-service dependency), and calibrates the "free" lines the
// workbook adds on top of the norms (crew / toll / allowance / handling) so the
// output reproduces the founder pricing sheet (BharatTruck_Test_Dataset.xlsx,
// sheet "Test Dataset"). See docs/tasks/feat-pricing-engine.md for the evidence
// behind every calibrated constant.
//
//   diesel_l   = distance_km / kmpl                (kmpl_bs6/bs4 by model_category)
//   fuel       = diesel_l * diesel_price
//   def        = diesel_l * def_pct * def_price
//   engine_oil = distance_km / eng_oil_km * eng_oil_l * engine_oil_price
//   gear_oil   = distance_km / gear_oil_km * gear_oil_l * gear_oil_price
//   service    = annual_service_cost(super_category, age_1..10) / kms_per_year * distance_km
//   crew       = trip_days * (crew_monthly / working_days)  (trip_days = ceil(distance/avg_km_day))
//   running      = fuel + def + engine_oil + gear_oil + service + crew
//   toll       = distance_km * toll_per_km
//   allowance  = trip_days * allowance_per_day
//   handling   = weight_tons * handling_per_ton[load_type]
//   total_direct = running + toll + allowance + handling
//   floor        = round(total_direct * 1.07)
//
// TYRES ARE NOT IN `running`. The workbook's `Running ₹` column is exactly
// Fuel+DEF+Eng.Oil+Gear Oil+Service+Crew (verified to the rupee on the anchor:
// 33614+910+120+31+3723+10577 = 48975) and carries no tyre line; Total Direct is
// that running + toll + allowance + handling. economics.ts (a per-ASSET P&L
// model) does include tyres — this is the pricing FLOOR calibrated to the pricing
// sheet, so it matches the sheet. The tyre line is still computed and returned as
// an informational field for the future market/quote layers.
// -----------------------------------------------------------

export type CostVehicleClass = 'SCV' | 'LCV' | 'MCV' | 'HCV'
/**
 * Pricing distinguishes only BS6 vs BS4 (the two columns that drive kmpl + DEF).
 * bt-fleet-service's richer BS6_PH2/old split is not needed for the floor.
 */
export type CostEmissionNorm = 'bs6' | 'bs4'

/** The subset of vehicle_cost_norms the cost floor needs. */
export type CostNorms = {
  model_category: string
  super_category: string
  vehicle_class: CostVehicleClass
  kms_per_year: number
  payload_tons_typical: number | null
  volume_cuft_typical: number | null
  kmpl_bs6: number | null
  kmpl_bs4: number | null
  def_pct_bs6: number
  def_pct_bs4: number
  eng_oil_km_bs6: number | null
  eng_oil_km_bs4: number | null
  eng_oil_l_bs6: number | null
  eng_oil_l_bs4: number | null
  gear_oil_km_bs6: number | null
  gear_oil_km_bs4: number | null
  gear_oil_l_bs6: number | null
  gear_oil_l_bs4: number | null
  tyre_cost_per_km: number
}

export type ConsumablePrices = {
  diesel_price_inr: number
  def_price_inr: number
  engine_oil_price_inr: number
  gear_oil_price_inr: number
}

// -----------------------------------------------------------
// Calibrated constants — see docs/tasks/feat-pricing-engine.md for the workbook
// evidence. These reproduce Trip Days / Crew ₹ for 100% of rows and keep Total
// Direct within ±3% for 83% of the 4,394 freight rows (median abs error 0.5%).
// -----------------------------------------------------------

/** crew = trip_days × crew_monthly / WORKING_DAYS_PER_MONTH. Reproduces Crew ₹ exactly. */
export const WORKING_DAYS_PER_MONTH = 26
/** trip_days = ceil(distance_km / AVG_KM_PER_DAY). Reproduces Trip Days exactly. */
export const AVG_KM_PER_DAY = 300
/** floor = round(total_direct × FLOOR_MARKUP). Matches the workbook "Floor ₹ (×1.07)". */
export const FLOOR_MARKUP = 1.07

export const MIN_AGE_YEARS = 1
export const MAX_AGE_YEARS = 10

// Crew model per model_category: light freight runs a driver only (₹35k/mo);
// ICV and heavier carry a helper (₹55k/mo). Note ICV is vehicle_class 'LCV' but
// still crewed, so this keys on model_category, not the 4-way class.
const DRIVER_ONLY_CATEGORIES = new Set(['SCV Cargo', 'Pickups', 'LCV (4-7 T)'])
const CREW_MONTHLY_DRIVER_ONLY_INR = 35000
const CREW_MONTHLY_WITH_HELPER_INR = 55000
const ALLOWANCE_PER_DAY_DRIVER_ONLY_INR = 440
const ALLOWANCE_PER_DAY_WITH_CREW_INR = 320

// Toll ₹/km by vehicle_class — clean-row (no monsoon/harvest/urgent) medians.
// Route/NH instance variance is not modelled in P0 (the shipper flow has no NH);
// resolveCostFloor accepts a toll_per_km override for P1 when tracking supplies
// the real route.
const TOLL_PER_KM: Record<CostVehicleClass, number> = { SCV: 1.20, LCV: 1.60, MCV: 1.70, HCV: 1.80 }

// Handling ₹ per tonne by load_type — a rock-solid per-tonne constant in the
// workbook (General 30, Fragile 300, Hazmat 180, Reefer 144, ODC ~852). The API
// load_type enum maps onto the workbook's handling classes.
const HANDLING_PER_TON_INR: Record<string, number> = {
  general: 30,
  fragile: 300,
  hazardous: 180,   // Hazmat
  perishable: 144,  // Reefer
  heavy_machinery: 852, // ODC
}

// Legacy /quote vehicle_type → CV-Parc model_category. Keeps the existing request
// shape working; richer callers pass model_category directly.
export const VEHICLE_TYPE_TO_MODEL_CATEGORY: Record<string, string> = {
  mini_truck: 'SCV Cargo',
  lcv: 'LCV (4-7 T)',
  hcv: 'HCV Cargo 25-31T',
  trailer: 'HCV Cargo 42-48T',
}

// Unknown vehicle_type falls back to the mid MCV class, matching cto-cost.ts's
// `?? 'MCV'` default so the two engines agree on the fallback.
const DEFAULT_MODEL_CATEGORY = 'MCV Cargo (15-19T)'

export function isDriverOnly(modelCategory: string): boolean {
  return DRIVER_ONLY_CATEGORIES.has(modelCategory)
}

export function crewMonthlyInr(modelCategory: string): number {
  return isDriverOnly(modelCategory) ? CREW_MONTHLY_DRIVER_ONLY_INR : CREW_MONTHLY_WITH_HELPER_INR
}

export function allowancePerDayInr(modelCategory: string): number {
  return isDriverOnly(modelCategory) ? ALLOWANCE_PER_DAY_DRIVER_ONLY_INR : ALLOWANCE_PER_DAY_WITH_CREW_INR
}

/** model_category from an explicit value, else the legacy vehicle_type map, else the MCV fallback. */
export function resolveModelCategory(input: { model_category?: string | null; vehicle_type?: string | null }): string {
  if (input.model_category) return input.model_category
  if (input.vehicle_type && VEHICLE_TYPE_TO_MODEL_CATEGORY[input.vehicle_type]) {
    return VEHICLE_TYPE_TO_MODEL_CATEGORY[input.vehicle_type]
  }
  return DEFAULT_MODEL_CATEGORY
}

function clampAge(age: number): number {
  return Math.min(MAX_AGE_YEARS, Math.max(MIN_AGE_YEARS, Math.round(age)))
}

function mileageKmpl(norms: CostNorms, norm: CostEmissionNorm): number {
  const kmpl = norm === 'bs6' ? (norms.kmpl_bs6 ?? norms.kmpl_bs4) : (norms.kmpl_bs4 ?? norms.kmpl_bs6)
  if (!kmpl || kmpl <= 0) {
    throw new Error(`No mileage norm for ${norms.model_category} (${norm}) — cost cannot be modelled`)
  }
  return kmpl
}

function defPct(norms: CostNorms, norm: CostEmissionNorm): number {
  return norm === 'bs6' ? norms.def_pct_bs6 : norms.def_pct_bs4
}

// An oil line needs BOTH a change interval and a quantity; either null (a
// combination that does not exist in the workbook) makes the line zero, not NaN.
function consumableCost(distanceKm: number, intervalKm: number | null, litres: number | null, price: number): number {
  if (!intervalKm || intervalKm <= 0 || !litres || litres <= 0) return 0
  return (distanceKm / intervalKm) * litres * price
}

export type CostBreakdownInput = {
  distance_km: number
  weight_tons: number
  load_type: string
  norms: CostNorms
  /** vehicle_service_cost_by_age.annual_cost_inr for (super_category, clamped age). */
  service_annual_cost_inr: number
  prices: ConsumablePrices
  emission_norm: CostEmissionNorm
  crew_monthly_inr: number
  allowance_per_day_inr: number
  toll_per_km: number
}

/** Every line item, the running subtotal, total_direct, the floor, and a basis note. */
export type CostFloorBreakdown = {
  model_category: string
  super_category: string
  vehicle_class: CostVehicleClass
  emission_norm: CostEmissionNorm
  distance_km: number
  trip_days: number
  diesel_price_inr: number
  fuel: number
  def: number
  engine_oil: number
  gear_oil: number
  /** engine_oil + gear_oil — the workbook "Lub. ₹" subtotal. */
  lubricants: number
  service: number
  crew: number
  /** Informational — real tyre cost, NOT summed into running/total_direct (see header). */
  tyres: number
  running: number
  toll: number
  allowance: number
  handling: number
  total_direct: number
  floor: number
  currency: 'INR'
  basis: string
}

// computeCostBreakdown — PURE. Same inputs always produce the same breakdown, so
// it is unit-testable without a database. Line items are rounded to whole rupees
// (the workbook presents whole rupees) and `running` is the sum of the rounded
// lines, exactly as the sheet totals them.
export function computeCostBreakdown(input: CostBreakdownInput): CostFloorBreakdown {
  const { distance_km, weight_tons, load_type, norms, prices, emission_norm } = input
  if (!(distance_km > 0)) {
    throw new Error('distance_km must be greater than zero to compute a cost floor')
  }

  const kmpl = mileageKmpl(norms, emission_norm)
  const litres = distance_km / kmpl

  const fuel = Math.round(litres * prices.diesel_price_inr)
  const def = Math.round(litres * defPct(norms, emission_norm) * prices.def_price_inr)
  const engine_oil = Math.round(consumableCost(
    distance_km,
    emission_norm === 'bs6' ? norms.eng_oil_km_bs6 : norms.eng_oil_km_bs4,
    emission_norm === 'bs6' ? norms.eng_oil_l_bs6 : norms.eng_oil_l_bs4,
    prices.engine_oil_price_inr,
  ))
  const gear_oil = Math.round(consumableCost(
    distance_km,
    emission_norm === 'bs6' ? norms.gear_oil_km_bs6 : norms.gear_oil_km_bs4,
    emission_norm === 'bs6' ? norms.gear_oil_l_bs6 : norms.gear_oil_l_bs4,
    prices.gear_oil_price_inr,
  ))
  const service = Math.round((input.service_annual_cost_inr / norms.kms_per_year) * distance_km)
  const tyres = Math.round(distance_km * norms.tyre_cost_per_km)

  const trip_days = Math.ceil(distance_km / AVG_KM_PER_DAY)
  const crew = Math.round(trip_days * (input.crew_monthly_inr / WORKING_DAYS_PER_MONTH))

  const running = fuel + def + engine_oil + gear_oil + service + crew

  const toll = Math.round(distance_km * input.toll_per_km)
  const allowance = Math.round(trip_days * input.allowance_per_day_inr)
  const handling = Math.round(weight_tons * (HANDLING_PER_TON_INR[load_type] ?? HANDLING_PER_TON_INR.general))

  const total_direct = running + toll + allowance + handling
  const floor = Math.round(total_direct * FLOOR_MARKUP)

  return {
    model_category: norms.model_category,
    super_category: norms.super_category,
    vehicle_class: norms.vehicle_class,
    emission_norm,
    distance_km,
    trip_days,
    diesel_price_inr: prices.diesel_price_inr,
    fuel,
    def,
    engine_oil,
    gear_oil,
    lubricants: engine_oil + gear_oil,
    service,
    crew,
    tyres,
    running,
    toll,
    allowance,
    handling,
    total_direct,
    floor,
    currency: 'INR',
    basis:
      `Cost floor from CV-Parc norms (${norms.model_category}, ${emission_norm.toUpperCase()}, ` +
      `age-tiered service) over ${distance_km} km at ₹${prices.diesel_price_inr}/L diesel; ` +
      `toll/allowance/handling at typical class parameters. ` +
      `Tyres (₹${tyres}) shown for reference, excluded from the floor per the founder pricing model.`,
  }
}

// -----------------------------------------------------------
// Reference-data reads. The norm and service-curve tables are small immutable
// seed data, cached for the process lifetime; the global consumable-price row is
// cached too (it changes rarely and this is the platform default, not a per-fleet
// override — the per-fleet path belongs to bt-fleet-service). __loadCostEngineFixtures
// injects all three so tests run without a database.
// -----------------------------------------------------------

const NORM_COLUMNS =
  'model_category, super_category, vehicle_class, kms_per_year, payload_tons_typical, volume_cuft_typical, ' +
  'kmpl_bs6, kmpl_bs4, def_pct_bs6, def_pct_bs4, ' +
  'eng_oil_km_bs6, eng_oil_km_bs4, eng_oil_l_bs6, eng_oil_l_bs4, ' +
  'gear_oil_km_bs6, gear_oil_km_bs4, gear_oil_l_bs6, gear_oil_l_bs4, tyre_cost_per_km'

let normsCache: Map<string, CostNorms> | null = null
let serviceCurveCache: Map<string, number> | null = null
let pricesCache: ConsumablePrices | null = null

async function loadNorms(): Promise<Map<string, CostNorms>> {
  if (normsCache) return normsCache
  const { data, error } = await getSupabase().from('vehicle_cost_norms').select(NORM_COLUMNS)
  if (error) throw new Error(`vehicle_cost_norms select failed: ${error.message}`)
  normsCache = new Map(((data ?? []) as unknown as CostNorms[]).map(n => [n.model_category, n]))
  return normsCache
}

async function loadServiceCurve(): Promise<Map<string, number>> {
  if (serviceCurveCache) return serviceCurveCache
  const { data, error } = await getSupabase()
    .from('vehicle_service_cost_by_age')
    .select('super_category, age_years, annual_cost_inr')
  if (error) throw new Error(`vehicle_service_cost_by_age select failed: ${error.message}`)
  serviceCurveCache = new Map(
    ((data ?? []) as unknown as { super_category: string; age_years: number; annual_cost_inr: number }[])
      .map(r => [`${r.super_category}:${r.age_years}`, Number(r.annual_cost_inr)]),
  )
  return serviceCurveCache
}

async function loadPrices(): Promise<ConsumablePrices> {
  if (pricesCache) return pricesCache
  const { data, error } = await getSupabase()
    .from('fleet_cost_settings')
    .select('diesel_price_inr, def_price_inr, engine_oil_price_inr, gear_oil_price_inr')
    .is('fleet_owner_id', null)
    .maybeSingle()
  if (error) throw new Error(`fleet_cost_settings select failed: ${error.message}`)
  if (!data) throw new Error('No global fleet_cost_settings row — cost reference data is not seeded')
  const row = data as Record<string, unknown>
  pricesCache = {
    diesel_price_inr: Number(row.diesel_price_inr),
    def_price_inr: Number(row.def_price_inr),
    engine_oil_price_inr: Number(row.engine_oil_price_inr),
    gear_oil_price_inr: Number(row.gear_oil_price_inr),
  }
  return pricesCache
}

/** Test-injection seam — populate all three caches, bypassing supabase entirely. */
export function __loadCostEngineFixtures(f: {
  norms: CostNorms[]
  serviceCurve: { super_category: string; age_years: number; annual_cost_inr: number }[]
  prices: ConsumablePrices
}): void {
  normsCache = new Map(f.norms.map(n => [n.model_category, n]))
  serviceCurveCache = new Map(f.serviceCurve.map(r => [`${r.super_category}:${r.age_years}`, Number(r.annual_cost_inr)]))
  pricesCache = f.prices
}

/** Drop the caches (test isolation). */
export function __resetCostEngineCaches(): void {
  normsCache = null
  serviceCurveCache = null
  pricesCache = null
}

export type CostFloorInput = {
  distance_km: number
  weight_kg: number
  load_type: string
  vehicle_type?: string | null
  /** Richer overrides — win over the vehicle_type-derived defaults when present. */
  model_category?: string | null
  emission_norm?: CostEmissionNorm | null
  truck_age?: number | null
  diesel_price_inr?: number | null
  /** P1: tracking supplies the real route toll rate; overrides the class default. */
  toll_per_km?: number | null
}

// resolveCostFloor — the orchestrator. Resolves norms / service cost / prices
// (from the cache or supabase) and calls the pure computeCostBreakdown.
export async function resolveCostFloor(input: CostFloorInput): Promise<CostFloorBreakdown> {
  const modelCategory = resolveModelCategory(input)
  const norms = (await loadNorms()).get(modelCategory)
  if (!norms) throw new Error(`Unknown model_category '${modelCategory}' — no CV-Parc norm row`)

  const emission_norm: CostEmissionNorm = input.emission_norm ?? 'bs6'
  const age = clampAge(input.truck_age ?? MIN_AGE_YEARS)
  const service_annual_cost_inr = (await loadServiceCurve()).get(`${norms.super_category}:${age}`)
  if (service_annual_cost_inr === undefined) {
    throw new Error(`No service-cost curve for super_category '${norms.super_category}'`)
  }

  const base = await loadPrices()
  const prices: ConsumablePrices = input.diesel_price_inr && input.diesel_price_inr > 0
    ? { ...base, diesel_price_inr: input.diesel_price_inr }
    : base

  return computeCostBreakdown({
    distance_km: input.distance_km,
    weight_tons: input.weight_kg / 1000,
    load_type: input.load_type,
    norms,
    service_annual_cost_inr,
    prices,
    emission_norm,
    crew_monthly_inr: crewMonthlyInr(modelCategory),
    allowance_per_day_inr: allowancePerDayInr(modelCategory),
    toll_per_km: input.toll_per_km && input.toll_per_km > 0 ? input.toll_per_km : TOLL_PER_KM[norms.vehicle_class],
  })
}
