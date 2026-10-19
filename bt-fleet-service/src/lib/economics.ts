import { getSupabase } from './supabase.js'
import { releaseAssignmentForBooking } from './assignment.js'
import { getLatestAffiliation } from './fleet-repo.js'
import { classifyExpense } from '@bharattruck/shared/expenses'
import { gstStateCode } from '@bharattruck/shared/india-states'
import { defaultRouteDistanceClient } from './tracking-client.js'
import {
  asRow,
  asRows,
  FleetError,
  type BookingRow,
  type EmissionNorm,
  type TripEconomicsRow,
  type VehicleRow,
} from './types.js'

// -----------------------------------------------------------
// economics — the per-trip P&L model (task contract §3), derived from the
// founder's CV parc workbook and seeded into vehicle_cost_norms /
// vehicle_service_cost_by_age / fleet_cost_settings by migration 0018.
//
//   diesel_l   = distance_km / kmpl
//   fuel       = diesel_l * diesel_price
//   def        = diesel_l * def_pct * def_price
//   engine_oil = distance_km / eng_oil_km * eng_oil_l * engine_oil_price
//   gear_oil   = distance_km / gear_oil_km * gear_oil_l * gear_oil_price
//   service    = annual_cost(super_category, age) / kms_per_year * distance_km
//   tyres      = distance_km * tyre_cost_per_km
//   running_cost = fuel + def + engine_oil + gear_oil + service + tyres + driver_wage_alloc
//   net_profit   = revenue - running_cost
//
// Service cost is age-dependent and NON-LINEAR (MHCV Cargo peaks at ~₹209k in year
// 3 and falls to ₹61k by year 10), which is exactly why a flat per-km maintenance
// constant — what bt-pricing-service/src/lib/cto-cost.ts uses today — is wrong at
// both ends of the curve.
//
// computeTripEconomics is PURE: it takes plain numbers and returns the
// trip_economics column subset, so the model is unit-testable without a database.
// -----------------------------------------------------------

export type CostNorms = {
  model_category: string
  super_category: string
  vehicle_class: string
  kms_per_year: number
  payload_tons_typical: number | null
  volume_cuft_typical: number | null
  kmpl_bs6: number | null
  kmpl_bs4: number | null
  def_pct_bs6: number
  def_pct_bs4: number
  eng_oil_km_bs6ph2: number | null
  eng_oil_km_bs6: number | null
  eng_oil_km_bs4: number | null
  eng_oil_km_old: number | null
  eng_oil_l_bs6ph2: number | null
  eng_oil_l_bs6: number | null
  eng_oil_l_bs4: number | null
  eng_oil_l_old: number | null
  gear_oil_km_bs6ph2: number | null
  gear_oil_km_bs6: number | null
  gear_oil_km_bs4: number | null
  gear_oil_km_old: number | null
  gear_oil_l_bs6ph2: number | null
  gear_oil_l_bs6: number | null
  gear_oil_l_bs4: number | null
  gear_oil_l_old: number | null
  wage_weight: number
  tyre_cost_per_km: number
}

export type ConsumablePrices = {
  diesel_price_inr: number
  def_price_inr: number
  engine_oil_price_inr: number
  gear_oil_price_inr: number
}

export type ComputeTripEconomicsInput = {
  distance_km: number
  revenue_inr: number
  norms: CostNorms
  prices: ConsumablePrices
  /** null = older than BS4; picks the *_old consumable columns. */
  emission_norm: EmissionNorm | null
  /** vehicle_service_cost_by_age.annual_cost_inr for (super_category, clamped age). */
  service_annual_cost_inr: number
  /** Share of the driver's monthly salary carried by this trip (see allocateDriverWage). */
  driver_wage_alloc_inr: number
  fuel_cost_actual_inr?: number | null
  toll_cost_inr?: number
  other_cost_inr?: number
}

/** The computed numeric columns of a trip_economics row. */
export type TripEconomicsCosts = {
  revenue_inr: number
  fuel_cost_est_inr: number
  def_cost_est_inr: number
  engine_oil_cost_inr: number
  gear_oil_cost_inr: number
  service_cost_inr: number
  tyre_cost_inr: number
  driver_wage_alloc_inr: number
  fuel_cost_actual_inr: number | null
  toll_cost_inr: number
  other_cost_inr: number
  running_cost_inr: number
  net_profit_inr: number
}

export const MODEL_VERSION = 'fleet-pnl-v1'

// The service-cost curve is only tabulated for ages 1..10; anything outside is
// clamped to the nearest end rather than dropped, so an ancient truck still costs
// something and a brand-new one is not free.
export const MIN_AGE_YEARS = 1
export const MAX_AGE_YEARS = 10

// Every money column is numeric(12,2); rounding here keeps the number we computed
// identical to the number Postgres stores, so a re-computation is a true no-op.
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function vehicleAgeYears(manufactureYear: number | null | undefined, now = new Date()): number {
  // A vehicle with no recorded manufacture year is treated as newest — that is the
  // cheapest point on the curve, so it under- rather than over-states cost, and
  // POST /fleet/vehicles requires the year precisely so fleet trucks never land here.
  if (!manufactureYear) return MIN_AGE_YEARS
  const age = now.getUTCFullYear() - manufactureYear
  return Math.min(MAX_AGE_YEARS, Math.max(MIN_AGE_YEARS, age))
}

// Consumable intervals/quantities are tabulated per emission norm. Mileage and DEF
// only have BS6 and BS4 columns in the workbook, so BS6_PH2 reads the BS6 figure
// and a pre-BS4 truck reads the BS4 one (the oldest available), with a fallback for
// the light categories where kmpl_bs4 was never published.
function pickByNorm<T>(norm: EmissionNorm | null, bs6ph2: T, bs6: T, bs4: T, old: T): T {
  switch (norm) {
    case 'BS6_PH2': return bs6ph2
    case 'BS6':     return bs6
    case 'BS4':     return bs4
    default:        return old
  }
}

export function mileageKmpl(norms: CostNorms, norm: EmissionNorm | null): number {
  const kmpl = norm === 'BS6' || norm === 'BS6_PH2'
    ? norms.kmpl_bs6 ?? norms.kmpl_bs4
    : norms.kmpl_bs4 ?? norms.kmpl_bs6
  if (!kmpl || kmpl <= 0) {
    throw new FleetError(
      `No mileage norm for ${norms.model_category} (${norm ?? 'pre-BS4'}) — cost cannot be modelled`,
      'MISCONFIGURED',
      500,
    )
  }
  return kmpl
}

export function defPct(norms: CostNorms, norm: EmissionNorm | null): number {
  return norm === 'BS6' || norm === 'BS6_PH2' ? norms.def_pct_bs6 : norms.def_pct_bs4
}

// dieselLitres — exported separately from the row shape because trip_economics has
// no litres column, but the fuel-variance report and the tests both need it.
export function dieselLitres(distanceKm: number, norms: CostNorms, norm: EmissionNorm | null): number {
  return distanceKm / mileageKmpl(norms, norm)
}

// An oil cost needs BOTH a change interval and a quantity; the workbook leaves
// either null for combinations that do not exist, in which case the line is zero
// rather than NaN.
function consumableCost(
  distanceKm: number,
  intervalKm: number | null,
  litres: number | null,
  pricePerLitre: number,
): number {
  if (!intervalKm || intervalKm <= 0 || !litres || litres <= 0) return 0
  return (distanceKm / intervalKm) * litres * pricePerLitre
}

// computeTripEconomics — PURE. Same inputs always produce the same row, which is
// what makes the internal roll-up safely idempotent.
export function computeTripEconomics(input: ComputeTripEconomicsInput): TripEconomicsCosts {
  const { distance_km, norms, prices, emission_norm } = input
  if (!(distance_km > 0)) {
    throw new FleetError('distance_km must be greater than zero to compute economics', 'VALIDATION_ERROR', 400)
  }

  const litres = dieselLitres(distance_km, norms, emission_norm)
  const fuel = litres * prices.diesel_price_inr
  const def = litres * defPct(norms, emission_norm) * prices.def_price_inr

  const engineOil = consumableCost(
    distance_km,
    pickByNorm(emission_norm, norms.eng_oil_km_bs6ph2, norms.eng_oil_km_bs6, norms.eng_oil_km_bs4, norms.eng_oil_km_old),
    pickByNorm(emission_norm, norms.eng_oil_l_bs6ph2, norms.eng_oil_l_bs6, norms.eng_oil_l_bs4, norms.eng_oil_l_old),
    prices.engine_oil_price_inr,
  )
  const gearOil = consumableCost(
    distance_km,
    pickByNorm(emission_norm, norms.gear_oil_km_bs6ph2, norms.gear_oil_km_bs6, norms.gear_oil_km_bs4, norms.gear_oil_km_old),
    pickByNorm(emission_norm, norms.gear_oil_l_bs6ph2, norms.gear_oil_l_bs6, norms.gear_oil_l_bs4, norms.gear_oil_l_old),
    prices.gear_oil_price_inr,
  )

  const service = (input.service_annual_cost_inr / norms.kms_per_year) * distance_km
  const tyres = distance_km * norms.tyre_cost_per_km
  const wage = input.driver_wage_alloc_inr

  // Tolls and "other" actuals are recorded but deliberately NOT in running_cost:
  // the contract defines running cost as the modelled cost of MOVING the asset, so
  // the estimate stays comparable across trips whether or not receipts came in.
  const running = fuel + def + engineOil + gearOil + service + tyres + wage

  return {
    revenue_inr: round2(input.revenue_inr),
    fuel_cost_est_inr: round2(fuel),
    def_cost_est_inr: round2(def),
    engine_oil_cost_inr: round2(engineOil),
    gear_oil_cost_inr: round2(gearOil),
    service_cost_inr: round2(service),
    tyre_cost_inr: round2(tyres),
    driver_wage_alloc_inr: round2(wage),
    fuel_cost_actual_inr: input.fuel_cost_actual_inr == null ? null : round2(input.fuel_cost_actual_inr),
    toll_cost_inr: round2(input.toll_cost_inr ?? 0),
    other_cost_inr: round2(input.other_cost_inr ?? 0),
    running_cost_inr: round2(running),
    net_profit_inr: round2(input.revenue_inr - running),
  }
}

// allocateDriverWage — Q18: a driver's monthly salary is spread over the trucks
// they actually ran that month, pro-rata by km_on_that_truck × wage_weight(model).
// PURE so the month-end redistribution is testable; `trips` is the driver's full
// set of trips for one calendar month, including the one just rolled up.
export function allocateDriverWage(
  monthlySalaryInr: number,
  trips: { booking_id: string; distance_km: number; wage_weight: number }[],
): Map<string, number> {
  const weighted = trips.map(t => ({ booking_id: t.booking_id, w: Math.max(0, t.distance_km) * t.wage_weight }))
  const total = weighted.reduce((sum, t) => sum + t.w, 0)
  const out = new Map<string, number>()
  // A zero-distance month cannot be apportioned by km; charging nothing is correct —
  // the salary shows up as unabsorbed monthly fixed cost instead.
  if (total <= 0 || monthlySalaryInr <= 0) {
    for (const t of weighted) out.set(t.booking_id, 0)
    return out
  }
  for (const t of weighted) out.set(t.booking_id, round2(monthlySalaryInr * (t.w / total)))
  return out
}

// -----------------------------------------------------------
// Reference-data reads. Norms and the service curve are small, immutable seed
// tables, so they are cached for the process lifetime; consumable prices are
// owner-editable and therefore always read fresh.
// -----------------------------------------------------------

const NORM_COLUMNS =
  'model_category, super_category, vehicle_class, kms_per_year, payload_tons_typical, volume_cuft_typical, ' +
  'kmpl_bs6, kmpl_bs4, def_pct_bs6, def_pct_bs4, ' +
  'eng_oil_km_bs6ph2, eng_oil_km_bs6, eng_oil_km_bs4, eng_oil_km_old, ' +
  'eng_oil_l_bs6ph2, eng_oil_l_bs6, eng_oil_l_bs4, eng_oil_l_old, ' +
  'gear_oil_km_bs6ph2, gear_oil_km_bs6, gear_oil_km_bs4, gear_oil_km_old, ' +
  'gear_oil_l_bs6ph2, gear_oil_l_bs6, gear_oil_l_bs4, gear_oil_l_old, ' +
  'wage_weight, tyre_cost_per_km'

let normsCache: Map<string, CostNorms> | null = null

export async function loadCostNorms(): Promise<Map<string, CostNorms>> {
  if (normsCache) return normsCache
  const { data, error } = await getSupabase().from('vehicle_cost_norms').select(NORM_COLUMNS)
  if (error) throw new Error(`vehicle_cost_norms select failed: ${error.message}`)
  normsCache = new Map((asRows<CostNorms>(data)).map(n => [n.model_category, n]))
  return normsCache
}

export async function getCostNorms(modelCategory: string | null): Promise<CostNorms> {
  if (!modelCategory) {
    throw new FleetError('Vehicle has no model_category — its economics cannot be modelled', 'VALIDATION_ERROR', 400)
  }
  const norms = (await loadCostNorms()).get(modelCategory)
  if (!norms) {
    throw new FleetError(`Unknown model_category '${modelCategory}'`, 'VALIDATION_ERROR', 400)
  }
  return norms
}

export async function listModelCategories(): Promise<string[]> {
  return [...(await loadCostNorms()).keys()]
}

let serviceCurveCache: Map<string, number> | null = null

// Key is `${super_category}:${age_years}` — the curve is a small dense table.
async function loadServiceCurve(): Promise<Map<string, number>> {
  if (serviceCurveCache) return serviceCurveCache
  const { data, error } = await getSupabase()
    .from('vehicle_service_cost_by_age')
    .select('super_category, age_years, annual_cost_inr')
  if (error) throw new Error(`vehicle_service_cost_by_age select failed: ${error.message}`)
  serviceCurveCache = new Map(
    ((data ?? []) as { super_category: string; age_years: number; annual_cost_inr: number }[])
      .map(r => [`${r.super_category}:${r.age_years}`, Number(r.annual_cost_inr)]),
  )
  return serviceCurveCache
}

export async function getAnnualServiceCost(superCategory: string, ageYears: number): Promise<number> {
  const clamped = Math.min(MAX_AGE_YEARS, Math.max(MIN_AGE_YEARS, ageYears))
  const cost = (await loadServiceCurve()).get(`${superCategory}:${clamped}`)
  if (cost === undefined) {
    throw new FleetError(
      `No service-cost curve for super_category '${superCategory}'`,
      'MISCONFIGURED',
      500,
    )
  }
  return cost
}

const PRICE_COLUMNS = 'fleet_owner_id, diesel_price_inr, def_price_inr, engine_oil_price_inr, gear_oil_price_inr'

// getConsumablePrices — the consumable unit prices for one trip's roll-up.
//
// Diesel varies by state (migration 0034, public.diesel_prices), so the diesel line is
// resolved with an explicit precedence, while DEF/oil stay a single owner-or-national
// figure (they do not vary materially by state):
//
//   1. the fleet's OWN diesel_price_inr override, if it set one (a deliberate owner number)
//   2. the per-STATE reference price for the trip's state (the fix for one national price)
//   3. the national default (the global fleet_cost_settings row seeded by 0018)
//
// stateCode is the trip's GST state code (Phase A: the fleet owner's state; Phase C: the
// booking's geocoded source state). null/unknown simply skips step 2, so a missing state is
// never fatal — it lands on the national default exactly as before.
export async function getConsumablePrices(
  fleetOwnerId: string | null,
  stateCode?: string | null,
): Promise<ConsumablePrices> {
  const supabase = getSupabase()

  let fleetRow: Record<string, unknown> | null = null
  if (fleetOwnerId) {
    const { data, error } = await supabase
      .from('fleet_cost_settings')
      .select(PRICE_COLUMNS)
      .eq('fleet_owner_id', fleetOwnerId)
      .maybeSingle()
    if (error) throw new Error(`fleet_cost_settings select failed: ${error.message}`)
    fleetRow = data ? asRow<Record<string, unknown>>(data) : null
  }

  const { data: globalData, error: globalErr } = await supabase
    .from('fleet_cost_settings')
    .select(PRICE_COLUMNS)
    .is('fleet_owner_id', null)
    .maybeSingle()
  if (globalErr) throw new Error(`fleet_cost_settings select failed: ${globalErr.message}`)
  if (!globalData) {
    throw new FleetError('No global fleet_cost_settings row — reference data is not seeded', 'MISCONFIGURED', 500)
  }
  const globalRow = asRow<Record<string, unknown>>(globalData)

  // DEF/oil: the fleet's own override row if it has one, else the national row (unchanged).
  const base = fleetRow ?? globalRow

  // Diesel: fleet override > per-state > national.
  let diesel: number | null = fleetRow ? Number(fleetRow.diesel_price_inr) : null
  if (diesel == null && stateCode) diesel = await dieselPriceForState(stateCode)
  if (diesel == null) diesel = Number(globalRow.diesel_price_inr)

  return {
    diesel_price_inr: diesel,
    def_price_inr: Number(base.def_price_inr),
    engine_oil_price_inr: Number(base.engine_oil_price_inr),
    gear_oil_price_inr: Number(base.gear_oil_price_inr),
  }
}

// dieselPriceForState — the newest diesel_prices row for a GST state code whose
// effective_from has already passed, or null when the state is unpriced (caller then uses
// the national default).
async function dieselPriceForState(stateCode: string): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from('diesel_prices')
    .select('price_inr, effective_from')
    .eq('state_code', stateCode)
    .lte('effective_from', new Date().toISOString().slice(0, 10))
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`diesel_prices select failed: ${error.message}`)
  if (!data) return null
  const price = Number((data as { price_inr: number }).price_inr)
  return price > 0 ? price : null
}

// -----------------------------------------------------------
// The roll-up itself: bookings + payouts + trip_expenses + breadcrumbs -> ONE
// trip_economics row, written when a booking reaches 'paid'. This is the only
// place those tables are aggregated; every dashboard reads the row, never the
// sources. Idempotent on booking_id, so a retried webhook is a no-op.
// -----------------------------------------------------------

const EARTH_RADIUS_KM = 6371

// haversineKm — great-circle km between two points. Used ONLY to sum a dense GPS breadcrumb
// trail (consecutive fixes are close, so straight-line between them tracks the road). It is
// deliberately NOT used to estimate a whole trip's road distance any more: the old
// haversine x 1.3 circuity fudge is gone, replaced by the real road distance from
// bt-tracking-service (resolveRoutedDistance).
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export type DistanceBasis = 'measured' | 'routed' | 'estimated'

export type DistanceInputs = {
  /** GPS breadcrumb trail distance — what the truck actually rolled. */
  measured: number | null
  /** Real road distance from bt-tracking-service (trip_routes cache / on-demand Routes). */
  routed: number | null
  /** The distance the trip was sold on (price-lock). Last-resort basis only. */
  sold: number | null
}

// chooseDistance — PURE. Picks the trip's P&L distance and records WHICH basis it came
// from, so the dashboard can tell an owner whether a number was driven, routed, or merely
// the sold estimate. Priority: what the truck actually drove (measured) -> the real road
// distance (routed) -> the sold number (estimated). The old haversine x 1.3 fabrication is
// gone: a trip with none of the three has no usable distance and is skipped, never invented.
export function chooseDistance(inputs: DistanceInputs): { distance_km: number; basis: DistanceBasis } | null {
  if (inputs.measured != null && inputs.measured > 0) return { distance_km: inputs.measured, basis: 'measured' }
  if (inputs.routed != null && inputs.routed > 0) return { distance_km: inputs.routed, basis: 'routed' }
  if (inputs.sold != null && inputs.sold > 0) return { distance_km: inputs.sold, basis: 'estimated' }
  return null
}

export type RollUpResult =
  | { skipped: true; reason: string; booking_id: string }
  | { skipped: false; economics: TripEconomicsRow }

const BOOKING_COLUMNS =
  'id, shipper_id, driver_id, fleet_owner_id, vehicle_id, source_address, source_lat, source_lng, ' +
  'destination_address, dest_lat, dest_lng, source_state_code, load_type, weight_kg, quoted_price, ' +
  'final_price, pickup_date, status, booking_type, dimensions_json, created_at, updated_at'

const VEHICLE_COLUMNS =
  'id, driver_id, fleet_owner_id, rc_number, capacity_tons, body_type, axle_config, maker_model, ' +
  'fuel_type, rc_expiry, model_category, emission_norm, manufacture_year, volume_cuft, ' +
  'current_odometer_km, created_at'

export async function rollUpTripEconomics(bookingId: string): Promise<RollUpResult> {
  const supabase = getSupabase()

  const { data: bookingData, error: bookingErr } = await supabase
    .from('bookings').select(BOOKING_COLUMNS).eq('id', bookingId).maybeSingle()
  if (bookingErr) throw new Error(`bookings select failed: ${bookingErr.message}`)
  if (!bookingData) throw new FleetError('Booking not found', 'NOT_FOUND', 404)
  const booking = asRow<BookingRow>(bookingData)

  // Solo-driver trips have no fleet and no vehicle of record, so there is nothing
  // to attribute to an asset. Skipping is reported, not thrown: bt-payment-service
  // fires this hook for EVERY booking that reaches 'paid'.
  if (!booking.fleet_owner_id || !booking.vehicle_id) {
    return { skipped: true, reason: 'Not a fleet booking with an assigned vehicle', booking_id: bookingId }
  }

  const { data: vehicleData, error: vehicleErr } = await supabase
    .from('vehicles').select(VEHICLE_COLUMNS).eq('id', booking.vehicle_id).maybeSingle()
  if (vehicleErr) throw new Error(`vehicles select failed: ${vehicleErr.message}`)
  if (!vehicleData) throw new FleetError('Assigned vehicle no longer exists', 'NOT_FOUND', 404)
  const vehicle = asRow<VehicleRow>(vehicleData)

  const dieselStateCode = await resolveDieselStateCode(booking)
  const [norms, prices, distances, revenue, actuals] = await Promise.all([
    getCostNorms(vehicle.model_category),
    getConsumablePrices(booking.fleet_owner_id, dieselStateCode),
    resolveDistances(booking),
    resolveRevenue(booking),
    resolveActuals(bookingId),
  ])

  const ageYears = vehicleAgeYears(vehicle.manufacture_year)
  const serviceAnnual = await getAnnualServiceCost(norms.super_category, ageYears)
  const chosen = chooseDistance({ measured: distances.measured, routed: distances.routed, sold: distances.sold })
  if (!chosen) {
    return { skipped: true, reason: 'Trip has no usable distance', booking_id: bookingId }
  }
  const distanceKm = chosen.distance_km

  // Wage starts at zero and is set by the month-wide reallocation below; a trip's
  // share of a monthly salary is only knowable relative to the driver's other trips.
  const costs = computeTripEconomics({
    distance_km: distanceKm,
    revenue_inr: revenue,
    norms,
    prices,
    emission_norm: vehicle.emission_norm,
    service_annual_cost_inr: serviceAnnual,
    driver_wage_alloc_inr: 0,
    fuel_cost_actual_inr: actuals.fuel,
    toll_cost_inr: actuals.toll,
    other_cost_inr: actuals.other,
  })

  const capacityKg = vehicle.capacity_tons == null ? null : Number(vehicle.capacity_tons) * 1000
  const row = {
    booking_id: bookingId,
    fleet_owner_id: booking.fleet_owner_id,
    vehicle_id: booking.vehicle_id,
    driver_id: booking.driver_id,
    ...costs,
    distance_km_quoted: distances.sold,
    distance_km_actual: distances.measured,
    distance_km_planned: distances.routed,
    distance_basis: chosen.basis,
    laden_weight_kg: booking.weight_kg,
    capacity_kg: capacityKg,
    volume_used_cuft: resolveVolumeUsed(booking),
    capacity_cuft: vehicle.volume_cuft ?? norms.volume_cuft_typical,
    started_at: distances.started_at,
    completed_at: distances.completed_at ?? booking.updated_at,
    model_version: MODEL_VERSION,
    computed_at: new Date().toISOString(),
  }

  const { error: upsertErr } = await supabase
    .from('trip_economics')
    .upsert(row, { onConflict: 'booking_id' })
  if (upsertErr) throw new Error(`trip_economics upsert failed: ${upsertErr.message}`)

  // The trip is over and paid: put the truck and the driver back in the pool.
  // Idempotent, so a redelivered hook does not disturb a newer assignment.
  await releaseAssignmentForBooking(bookingId)

  if (booking.driver_id) {
    await reallocateDriverWageForMonth(booking.fleet_owner_id, booking.driver_id, row.completed_at)
  }

  const { data: finalRow, error: readErr } = await supabase
    .from('trip_economics').select('*').eq('booking_id', bookingId).single()
  if (readErr) throw new Error(`trip_economics select failed: ${readErr.message}`)
  return { skipped: false, economics: finalRow as TripEconomicsRow }
}

// resolveDistances — the three real distance signals for one trip, plus its clock.
//   measured = the GPS breadcrumb trail (what the truck actually drove)
//   routed   = the real road distance from bt-tracking-service (trip_routes cache, or an
//              on-demand /internal/route/point call) — this REPLACES the old haversine x1.3
//   sold     = the price-lock distance the trip was quoted on (last-resort basis only)
// location_history is read here and ONLY here, once per trip, never at dashboard request time.
async function resolveDistances(booking: BookingRow): Promise<{
  measured: number | null
  routed: number | null
  sold: number | null
  started_at: string | null
  completed_at: string | null
}> {
  const supabase = getSupabase()

  // sold: the number the trip was actually priced on. No longer fabricated from
  // haversine x 1.3 when there is no lock — an absent sold distance stays null and the
  // routed distance carries the trip instead.
  const { data: lock, error: lockErr } = await supabase
    .from('price_quotes')
    .select('distance_km')
    .eq('consumed_by_booking_id', booking.id)
    .maybeSingle()
  if (lockErr) throw new Error(`price_quotes select failed: ${lockErr.message}`)
  const sold = lock ? Number((lock as { distance_km: number }).distance_km) : null

  // routed: the real road distance, with the Google key kept in bt-tracking-service.
  const routed = await resolveRoutedDistance(booking)

  // measured: the driven distance from the breadcrumb trail.
  const { data: points, error: pointsErr } = await supabase
    .from('location_history')
    .select('lat, lng, recorded_at')
    .eq('booking_id', booking.id)
    .order('recorded_at', { ascending: true })
  if (pointsErr) throw new Error(`location_history select failed: ${pointsErr.message}`)

  const trail = (points ?? []) as { lat: number; lng: number; recorded_at: string }[]
  if (trail.length < 2) {
    return { measured: null, routed, sold, started_at: trail[0]?.recorded_at ?? null, completed_at: null }
  }

  // Raw great-circle between consecutive breadcrumbs — no circuity factor, since
  // the trail already follows the road.
  let travelled = 0
  for (let i = 1; i < trail.length; i++) {
    travelled += haversineKm(trail[i - 1].lat, trail[i - 1].lng, trail[i].lat, trail[i].lng)
  }
  return {
    measured: Math.round(travelled * 100) / 100,
    routed,
    sold,
    started_at: trail[0].recorded_at,
    completed_at: trail[trail.length - 1].recorded_at,
  }
}

// resolveRoutedDistance — the real road distance for a trip, keeping the Google Maps key
// in bt-tracking-service. First the row tracking already cached in trip_routes (a plain DB
// read, no Google call); only if absent, an on-demand internal call to tracking (which
// caches by lane). Returns null when neither is available — tracking down AND no cached
// route — and the caller falls back to the sold distance.
async function resolveRoutedDistance(booking: BookingRow): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from('trip_routes')
    .select('distance_m')
    .eq('booking_id', booking.id)
    .maybeSingle()
  if (error) throw new Error(`trip_routes select failed: ${error.message}`)
  const cachedM = data ? Number((data as { distance_m: number }).distance_m) : null
  if (cachedM != null && cachedM > 0) return Math.round((cachedM / 1000) * 100) / 100

  const client = defaultRouteDistanceClient()
  if (!client) return null
  const km = await client.routeDistanceKm({
    source_lat: booking.source_lat,
    source_lng: booking.source_lng,
    dest_lat: booking.dest_lat,
    dest_lng: booking.dest_lng,
  })
  return km != null && km > 0 ? Math.round(km * 100) / 100 : null
}

// resolveDieselStateCode — the GST state code whose diesel price this trip should use.
// Preference order: the booking's GEOCODED origin state (the trip's true fuel-purchase start,
// captured at post time once the load was placed with an address pick — D-020 / migration 0035);
// then the fleet owner's (free-text) base state, normalised; then null -> national default. A
// legacy hand-typed booking has no source_state_code and lands on the fleet-state fallback
// exactly as before.
async function resolveDieselStateCode(booking: BookingRow): Promise<string | null> {
  if (booking.source_state_code && /^[0-9]{2}$/.test(booking.source_state_code)) {
    return booking.source_state_code
  }
  if (!booking.fleet_owner_id) return null
  const { data, error } = await getSupabase()
    .from('fleet_owners')
    .select('state')
    .eq('id', booking.fleet_owner_id)
    .maybeSingle()
  if (error) throw new Error(`fleet_owners select failed: ${error.message}`)
  return gstStateCode((data as { state: string | null } | null)?.state ?? null)
}

// A payout row as this roll-up needs to read it. `payee_type` arrives in
// migration 0016 and is optional here only because a row written before it
// carries no value — never because the column may be missing on a table this
// code reaches. rollUpTripEconomics returns early unless the booking names a
// fleet_owner_id, and a fleet booking cannot exist before 0016, so every
// payouts row this function ever sees comes from a post-0016 table.
type PayoutShare = { amount: number; payee_type?: string | null }

// fleetOwnerRevenue — the revenue side of a TRUCK's P&L, which is the fleet
// owner's book and nobody else's.
//
// Before D-7 this was trivially the whole freight, because the whole freight
// went to the bidder and `payouts` held exactly one row per booking. A D-7
// revenue split makes that false: the freight is divided at settlement between
// the owner and the driver who ran the trip, and the driver's cut never lands
// on the owner's side of the ledger. Booking the full freight as the owner's
// revenue would overstate the margin on every split trip by exactly the
// driver's share — the fleet console's whole reason to exist is that number.
//
// The driver's cut is not netted off as a cost either: the wage line
// (driver_wage_alloc_inr) is a MONTH-level allocation of a salary, and treating
// a revenue share as if it were salary would double-count against a salaried
// driver and corrupt the month-wide reallocation. Taking only the owner's rows
// keeps the two mechanisms separate and each one true.
//
//   no payout rows at all -> not settled yet; fall back to the booking price
//                            (unchanged pre-D-7 behaviour)
//   owner row(s)          -> what the owner actually took
//   driver row(s) only    -> share = 100: the owner passed the whole freight
//                            through, so their revenue on this trip is 0
//
// That last case is why "no rows" and "no OWNER row" must not collapse into the
// same branch. Zero is a fact about a share-100 trip; the booking price is a
// stand-in for a trip that has not settled.
export function fleetOwnerRevenue(payouts: PayoutShare[], booking: BookingRow): number {
  if (payouts.length === 0) return Number(booking.final_price ?? booking.quoted_price)
  // Summed rather than picked: 0023's UNIQUE(booking_id, payee_type) allows only
  // one owner row, so this equals that row — but a sum cannot throw, and the
  // whole reason this function was rewritten is that a read which throws here
  // takes the entire trip_economics row down with it (emitTripEconomics is
  // fire-and-forget, so the loss is silent).
  return payouts
    .filter((p) => (p.payee_type ?? 'driver') === 'fleet_owner')
    .reduce((sum, p) => sum + Number(p.amount), 0)
}

// resolveRevenue — the owner's take on this trip (Q15: the money goes to whoever
// bid; D-7: the bidder may then share it with their driver).
//
// NOT maybeSingle(). A D-7 split booking holds two payout rows and PostgREST's
// maybeSingle() answers PGRST116 ("multiple rows returned") rather than either
// of them, so this threw, rollUpTripEconomics threw, and the fire-and-forget
// emit turned that into a log line — every split fleet settlement silently
// losing the per-truck P&L row it exists to produce.
async function resolveRevenue(booking: BookingRow): Promise<number> {
  const { data, error } = await getSupabase()
    .from('payouts')
    .select('amount, payee_type')
    .eq('booking_id', booking.id)
  if (error) throw new Error(`payouts select failed: ${error.message}`)
  return fleetOwnerRevenue((data ?? []) as PayoutShare[], booking)
}

// resolveActuals — what the driver actually spent (Q21), bucketed by classifyExpense.
// The controlled category_code (migration 0034) is authoritative; a legacy row carrying
// only free-text `category` still falls back to the loose substring match, so no historical
// row is reclassified — new rows simply stop depending on the driver's spelling of "fuel".
async function resolveActuals(bookingId: string): Promise<{ fuel: number | null; toll: number; other: number }> {
  const { data, error } = await getSupabase()
    .from('trip_expenses')
    .select('category, category_code, amount')
    .eq('booking_id', bookingId)
  if (error) throw new Error(`trip_expenses select failed: ${error.message}`)

  const rows = (data ?? []) as { category: string | null; category_code: string | null; amount: number }[]
  let fuel: number | null = null
  let toll = 0
  let other = 0
  for (const row of rows) {
    const amount = Number(row.amount) || 0
    switch (classifyExpense(row.category_code, row.category)) {
      case 'fuel': fuel = (fuel ?? 0) + amount; break
      case 'toll': toll += amount; break
      default: other += amount
    }
  }
  return { fuel, toll, other }
}

// resolveVolumeUsed — bookings.dimensions_json is free-form. We take a volume the
// shipper stated outright, and otherwise derive it from L×W×H in feet; anything
// else stays null rather than becoming a fabricated utilization number.
function resolveVolumeUsed(booking: BookingRow): number | null {
  const dims = booking.dimensions_json
  if (!dims) return null
  const stated = Number(dims.volume_cuft)
  if (Number.isFinite(stated) && stated > 0) return Math.round(stated * 100) / 100

  const l = Number(dims.length_ft), w = Number(dims.width_ft), h = Number(dims.height_ft)
  if ([l, w, h].every(v => Number.isFinite(v) && v > 0)) return Math.round(l * w * h * 100) / 100
  return null
}

// reallocateDriverWageForMonth — Q18's allocation is a MONTH-level share, so
// writing one trip changes every other trip that driver ran that month. We
// redistribute the whole month on each roll-up: the set is one driver's trips in
// one month (tens of rows), and the invariant it buys — the month's allocations sum
// to exactly one monthly salary — is not obtainable trip-at-a-time.
export async function reallocateDriverWageForMonth(
  fleetOwnerId: string,
  driverId: string,
  withinMonthIso: string,
): Promise<void> {
  const supabase = getSupabase()
  const anchor = new Date(withinMonthIso)
  const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1))

  const affiliation = await getLatestAffiliation(fleetOwnerId, driverId)
  const salary = Number(affiliation?.monthly_salary_inr ?? 0)

  const { data, error } = await supabase
    .from('trip_economics')
    .select('booking_id, vehicle_id, distance_km_actual, distance_km_planned, distance_km_quoted, ' +
            'driver_wage_alloc_inr, revenue_inr, fuel_cost_est_inr, def_cost_est_inr, engine_oil_cost_inr, ' +
            'gear_oil_cost_inr, service_cost_inr, tyre_cost_inr')
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('driver_id', driverId)
    .gte('completed_at', monthStart.toISOString())
    .lt('completed_at', monthEnd.toISOString())
  if (error) throw new Error(`trip_economics select failed: ${error.message}`)

  type MonthRow = {
    booking_id: string
    vehicle_id: string | null
    distance_km_actual: number | null
    distance_km_planned: number | null
    distance_km_quoted: number | null
    driver_wage_alloc_inr: number
    revenue_inr: number
    fuel_cost_est_inr: number
    def_cost_est_inr: number
    engine_oil_cost_inr: number
    gear_oil_cost_inr: number
    service_cost_inr: number
    tyre_cost_inr: number
  }
  const rows = asRows<MonthRow>(data)
  if (rows.length === 0) return

  // wage_weight is per model_category (a 49T HCV carries more of the wage bill than
  // an SCV for the same km), so we need each trip's truck.
  const vehicleIds = [...new Set(rows.map(r => r.vehicle_id).filter((v): v is string => v !== null))]
  const weightByVehicle = new Map<string, number>()
  if (vehicleIds.length > 0) {
    const { data: vehicles, error: vehicleErr } = await supabase
      .from('vehicles').select('id, model_category').in('id', vehicleIds)
    if (vehicleErr) throw new Error(`vehicles select failed: ${vehicleErr.message}`)
    const norms = await loadCostNorms()
    for (const v of (vehicles ?? []) as { id: string; model_category: string | null }[]) {
      weightByVehicle.set(v.id, (v.model_category ? norms.get(v.model_category)?.wage_weight : undefined) ?? 1)
    }
  }

  const allocation = allocateDriverWage(salary, rows.map(r => ({
    booking_id: r.booking_id,
    distance_km: Number(r.distance_km_actual ?? r.distance_km_planned ?? r.distance_km_quoted ?? 0),
    wage_weight: r.vehicle_id ? weightByVehicle.get(r.vehicle_id) ?? 1 : 1,
  })))

  for (const row of rows) {
    const wage = allocation.get(row.booking_id) ?? 0
    // Skip untouched rows: a re-run of the same month must not churn the table.
    if (Math.abs(wage - Number(row.driver_wage_alloc_inr)) < 0.01) continue

    const running =
      Number(row.fuel_cost_est_inr) + Number(row.def_cost_est_inr) + Number(row.engine_oil_cost_inr) +
      Number(row.gear_oil_cost_inr) + Number(row.service_cost_inr) + Number(row.tyre_cost_inr) + wage

    const { error: updateErr } = await supabase
      .from('trip_economics')
      .update({
        driver_wage_alloc_inr: wage,
        running_cost_inr: Math.round(running * 100) / 100,
        net_profit_inr: Math.round((Number(row.revenue_inr) - running) * 100) / 100,
      })
      .eq('booking_id', row.booking_id)
    if (updateErr) throw new Error(`trip_economics update failed: ${updateErr.message}`)
  }
}
