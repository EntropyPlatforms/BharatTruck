// -----------------------------------------------------------
// trip-estimate — the ONE cost structure behind both prices (founder brief, 29 Oct 2026).
//
//   Trip cost (what the fleet spends to execute the trip)
//     operating   fuel + DEF + lubricants + maintenance + tyres     (the truck's CV-Parc norms)
//     crew        driver salary + helper salary for the trip days, + daily allowance
//     handling    loading/unloading, ₹ per tonne by load type
//     tolls       the tolls on the actual route, at the truck's axle-class rate
//
//   Fleet operator's estimate  = trip cost + CARRIER_RETURN_PCT (18%) of trip cost
//   Shipper's indicative rate  = fleet operator's estimate × market correction (1.05)
//
// The fleet sees the first when bidding (routes /justify), the shipper the second on a quote
// (/quote). Both read this module, so they can never disagree about what a trip costs.
//
// TOLLS. bt-tracking-service asks Google Routes for the tolls on the route. Google prices them for a
// CAR, so they are scaled by the truck/car ratio of the National Highways Fee Rules 2008 base
// rates (₹/km: car 0.65, LCV 1.05, 2-axle truck 2.20, 3-axle 2.40, 4–6 axle 3.45). Same ratio
// the NHAI uses at every plaza, so it carries over to current rates. When Google has no price
// (or tracking is down), the class ₹/km from the cost workbook is used instead — `tolls.basis`
// says which.
// -----------------------------------------------------------

import {
  CARRIER_RETURN_PCT, TOLL_PER_KM, classForWeightKg, marketCorrectionFactor, type CostClass,
} from './cost-constants.js'
import {
  DRIVER_MONTHLY_INR, HELPER_MONTHLY_INR, allowancePerDayInr, handlingInr, isDriverOnly,
  resolveCostFloor, resolveModelCategory, salaryForTrip, tripDaysFor,
  type CostEmissionNorm, type CostFloorBreakdown,
} from './cost-engine.js'
import { MILEAGE_KMPL, OPEX_PER_KM } from './cto-cost.js'
import { dieselPriceInr } from './diesel.js'

/** What bt-tracking-service reported for the route's tolls (car rates). */
export type RouteToll =
  | { status: 'priced'; car_toll_inr: number }
  | { status: 'none' }
  | { status: 'unknown' }

export type TollAxleClass = 'lcv' | 'two_axle' | 'three_axle' | 'multi_axle'

const NH_BASE_PER_KM: Record<TollAxleClass | 'car', number> = {
  car: 0.65, lcv: 1.05, two_axle: 2.2, three_axle: 2.4, multi_axle: 3.45,
}

const AXLE_CLASS_BY_CATEGORY: Record<string, TollAxleClass> = {
  'SCV Cargo': 'lcv',
  'Pickups': 'lcv',
  'LCV (4-7 T)': 'lcv',
  'ICV Cargo (Upto 14T)': 'two_axle',
  'MCV Cargo (15-19T)': 'two_axle',
  'HCV Cargo 25-31T': 'three_axle',
  'HCV Cargo 35-40T': 'multi_axle',
  'HCV Cargo 42-48T': 'multi_axle',
  'HCV Cargo 49-55T': 'multi_axle',
}

export function tollAxleClass(modelCategory: string): TollAxleClass {
  return AXLE_CLASS_BY_CATEGORY[modelCategory] ?? 'two_axle'
}

/** How many times a car's toll this truck pays at a plaza. */
export function truckTollMultiplier(axle: TollAxleClass): number {
  return NH_BASE_PER_KM[axle] / NH_BASE_PER_KM.car
}

/** The 4-way class of a model category, for the paths that need it without the norm tables. */
export function classOfCategory(modelCategory: string): CostClass {
  if (modelCategory.startsWith('HCV')) return 'HCV'
  if (modelCategory.startsWith('MCV')) return 'MCV'
  if (modelCategory.startsWith('LCV') || modelCategory.startsWith('ICV')) return 'LCV'
  return 'SCV'
}

/** The typical truck for a load when the caller names none (a bid before a truck is picked). */
export function categoryForWeightKg(weightKg: number): string {
  return ({ SCV: 'SCV Cargo', LCV: 'LCV (4-7 T)', MCV: 'MCV Cargo (15-19T)', HCV: 'HCV Cargo 25-31T' } as const)[classForWeightKg(weightKg)]
}

export type TripEstimate = {
  model_category: string
  vehicle_class: CostClass
  emission_norm: CostEmissionNorm | null
  truck_age: number | null
  distance_km: number
  trip_days: number
  diesel_price_inr: number
  /** 'cv_parc_norms' = the truck's own norms; 'class_typicals' = norms unavailable, class averages. */
  operating_basis: 'cv_parc_norms' | 'class_typicals'
  operating: { fuel: number; def: number; lubricants: number; maintenance: number; tyres: number; total: number }
  crew: {
    driver_salary: number
    helper_salary: number
    allowance: number
    total: number
    has_helper: boolean
    driver_monthly_inr: number
    helper_monthly_inr: number
  }
  handling: number
  tolls: { amount: number; basis: 'route' | 'class_rate'; axle_class: TollAxleClass; car_toll_inr: number | null }
  /** Everything the fleet spends to execute the trip. */
  trip_cost: number
  carrier_return_pct: number
  carrier_return: number
  /** Trip cost + the carrier's return: the fleet operator's estimate for a bid. */
  carrier_estimate: number
  market_correction: number
  market_correction_amount: number
  /** Carrier estimate × market correction: the shipper's indicative rate. */
  shipper_indicative: number
}

export type TripEstimateInput = {
  distance_km: number
  weight_kg: number
  load_type: string
  model_category: string
  emission_norm?: CostEmissionNorm | null
  truck_age?: number | null
  /** The CV-Parc cost floor for this truck, or null when the norm tables could not be read. */
  floor: CostFloorBreakdown | null
  route_toll?: RouteToll | null
}

/** PURE. Same inputs, same estimate — no database, no network. */
export function buildTripEstimate(input: TripEstimateInput): TripEstimate {
  const { distance_km, model_category, floor } = input
  if (!(distance_km > 0)) throw new Error('distance_km must be greater than zero to estimate a trip')
  const vehicle_class = floor?.vehicle_class ?? classOfCategory(model_category)
  const trip_days = floor?.trip_days ?? tripDaysFor(distance_km)
  const diesel = floor?.diesel_price_inr ?? dieselPriceInr()

  // Truck running cost. The class-typical fallback has no DEF/lubricant/tyre split: its per-km
  // figure already covers maintenance, oil and tyres, so it is reported as maintenance.
  const operating = floor
    ? { fuel: floor.fuel, def: floor.def, lubricants: floor.lubricants, maintenance: floor.service, tyres: floor.tyres }
    : {
        fuel: Math.round((distance_km / MILEAGE_KMPL[vehicle_class]) * diesel),
        def: 0, lubricants: 0,
        maintenance: Math.round(distance_km * OPEX_PER_KM[vehicle_class]),
        tyres: 0,
      }
  const operatingTotal = operating.fuel + operating.def + operating.lubricants + operating.maintenance + operating.tyres

  // Salaries are monthly; the trip carries its days' share of each.
  const has_helper = !isDriverOnly(model_category)
  const driver_salary = salaryForTrip(DRIVER_MONTHLY_INR, trip_days)
  const helper_salary = has_helper ? salaryForTrip(HELPER_MONTHLY_INR, trip_days) : 0
  const allowance = floor?.allowance ?? Math.round(trip_days * allowancePerDayInr(model_category))

  const handling = floor?.handling ?? handlingInr(input.weight_kg / 1000, input.load_type)

  const axle_class = tollAxleClass(model_category)
  const rt = input.route_toll
  const tolls = rt?.status === 'priced'
    ? { amount: Math.round(rt.car_toll_inr * truckTollMultiplier(axle_class)), basis: 'route' as const, axle_class, car_toll_inr: rt.car_toll_inr }
    : rt?.status === 'none'
      ? { amount: 0, basis: 'route' as const, axle_class, car_toll_inr: 0 }
      : { amount: floor?.toll ?? Math.round(distance_km * TOLL_PER_KM[vehicle_class]), basis: 'class_rate' as const, axle_class, car_toll_inr: null }

  const crewTotal = driver_salary + helper_salary + allowance
  const trip_cost = operatingTotal + crewTotal + handling + tolls.amount
  const carrier_return = Math.round(trip_cost * CARRIER_RETURN_PCT)
  const carrier_estimate = trip_cost + carrier_return
  const market_correction = marketCorrectionFactor()
  const shipper_indicative = Math.round(carrier_estimate * market_correction)

  return {
    model_category,
    vehicle_class,
    emission_norm: input.emission_norm ?? floor?.emission_norm ?? null,
    truck_age: input.truck_age ?? null,
    distance_km,
    trip_days,
    diesel_price_inr: diesel,
    operating_basis: floor ? 'cv_parc_norms' : 'class_typicals',
    operating: { ...operating, total: operatingTotal },
    crew: {
      driver_salary, helper_salary, allowance, total: crewTotal, has_helper,
      driver_monthly_inr: DRIVER_MONTHLY_INR, helper_monthly_inr: has_helper ? HELPER_MONTHLY_INR : 0,
    },
    handling,
    tolls,
    trip_cost,
    carrier_return_pct: Math.round(CARRIER_RETURN_PCT * 1000) / 10,
    carrier_return,
    carrier_estimate,
    market_correction,
    market_correction_amount: shipper_indicative - carrier_estimate,
    shipper_indicative,
  }
}

export type ResolveTripEstimateInput = {
  distance_km: number
  weight_kg: number
  load_type: string
  vehicle_type?: string | null
  model_category?: string | null
  emission_norm?: CostEmissionNorm | null
  truck_age?: number | null
  diesel_price_inr?: number | null
  route_toll?: RouteToll | null
}

/**
 * Resolve the truck's cost floor from the norm tables, then build the estimate. A norm-table
 * outage degrades to class typicals (operating_basis says so) instead of failing the price.
 */
export async function resolveTripEstimate(
  input: ResolveTripEstimateInput,
  onFloorError?: (err: unknown) => void,
): Promise<{ estimate: TripEstimate; floor: CostFloorBreakdown | null }> {
  const model_category = input.model_category || (input.vehicle_type ? resolveModelCategory(input) : categoryForWeightKg(input.weight_kg))
  let floor: CostFloorBreakdown | null = null
  try {
    floor = await resolveCostFloor({
      distance_km: input.distance_km,
      weight_kg: input.weight_kg,
      load_type: input.load_type,
      model_category,
      emission_norm: input.emission_norm,
      truck_age: input.truck_age,
      diesel_price_inr: input.diesel_price_inr,
    })
  } catch (err) {
    onFloorError?.(err)
  }
  const estimate = buildTripEstimate({
    distance_km: input.distance_km,
    weight_kg: input.weight_kg,
    load_type: input.load_type,
    model_category,
    emission_norm: input.emission_norm,
    truck_age: input.truck_age,
    floor,
    route_toll: input.route_toll,
  })
  return { estimate, floor }
}
