import { QUOTE_KM_PER_DAY } from './cost-constants.js'
import { dieselPriceInr } from './diesel.js'
// -----------------------------------------------------------
// CTO cost-breakdown engine (PRD Appendix A — the deterministic MVP
// price anchor). Given (vehicle_class, distance) it returns a
// transparent operating-cost breakdown: fuel / driver / per-km / handling.
// RL/LinUCB is explicitly OUT of MVP; this is pure deterministic arithmetic.
//
// VEHICLE-CLASS RECONCILIATION (founder Q9 dependency — FLAGGED):
//   • PRD Appendix A CTO engine taxonomy: SCV / LCV / MCV / HCV  ← adopted here
//   • Frozen tracking fuel-estimate (D-009): MCV / HCV only
//   • Legacy pricing /quote enum: mini_truck / lcv / hcv / trailer
//   MCV & HCV mileage are aligned to the FROZEN tracking values (D-009:
//   MCV 6.0, HCV 3.5 kmpl). SCV & LCV mileage and ALL non-fuel constants are
//   ASSUMPTIONS (Appendix A's numbers live in cto_data.py, not in this repo) —
//   each is marked `ASSUMPTION` and listed in the T-BE-5 report for the founder
//   to confirm against real fleet numbers.
// -----------------------------------------------------------

export type VehicleClass = 'SCV' | 'LCV' | 'MCV' | 'HCV'

// Mileage (kmpl) prefilled by class. MCV/HCV match frozen tracking D-009.
export const MILEAGE_KMPL: Record<VehicleClass, number> = {
  SCV: 12.0, // ASSUMPTION (Q9)
  LCV: 9.0,  // ASSUMPTION (Q9)
  MCV: 6.0,  // aligned with tracking D-009
  HCV: 3.5,  // aligned with tracking D-009
}

// Per-km operating cost beyond fuel + driver: maintenance, oil, AdBlue/DEF,
// tyres, fixed-cost amortization. ASSUMPTIONS (Q9).
export const OPEX_PER_KM: Record<VehicleClass, number> = { SCV: 3, LCV: 4, MCV: 6, HCV: 8 }

// Object-handling / loading base by class (Appendix A "handling extra"). ASSUMPTIONS (Q9).
export const HANDLING_BASE: Record<VehicleClass, number> = { SCV: 300, LCV: 500, MCV: 800, HCV: 1000 }

// These class typicals are the fallback for the trip estimate when the CV-Parc norm tables cannot
// be read (trip-estimate.ts), and the legacy cost_breakdown on a quote.

// Driver wage — per-day, prorated over an average daily distance. ASSUMPTIONS (Q9).
export const DRIVER_WAGE_PER_DAY = 1200
// The quote's running day — see QUOTE_KM_PER_DAY in cost-constants.ts for why it is not the
// cost floor's 300.
export const AVG_KM_PER_DAY = QUOTE_KM_PER_DAY

// Diesel ₹/litre: the same national reference row the cost floor uses (diesel.ts), with the
// DIESEL_PRICE_INR env only as the fallback before the first database load.
export { dieselPriceInr } from './diesel.js'

// Map the legacy /quote `vehicle_type` enum → CTO cost class.
// ASSUMPTIONS (Q9): mini_truck→SCV; trailer→HCV (trailer is absent from the
// Appendix A taxonomy, treated as the heaviest class).
export const VEHICLE_TYPE_TO_CLASS: Record<string, VehicleClass> = {
  mini_truck: 'SCV', // ASSUMPTION (Q9)
  lcv: 'LCV',
  hcv: 'HCV',
  trailer: 'HCV',    // ASSUMPTION (Q9)
}

export type CostBreakdown = {
  vehicle_class: VehicleClass
  distance_km: number
  mileage_kmpl: number
  diesel_price_inr: number
  fuel_cost: number
  driver_wage: number
  per_km_operating_cost: number
  handling: number
  operating_cost_total: number
}

// breakdown(category, distance) — deterministic operating-cost breakdown.
// fuel = distance_km / mileage_kmpl * diesel_price  (PRD + tracking D-009).
export function costBreakdown(vehicleClass: VehicleClass, distanceKm: number): CostBreakdown {
  const mileage = MILEAGE_KMPL[vehicleClass]
  const diesel = dieselPriceInr()

  const fuel = Math.ceil((distanceKm / mileage) * diesel)
  const driver = Math.ceil((distanceKm / AVG_KM_PER_DAY) * DRIVER_WAGE_PER_DAY)
  const opex = Math.ceil(distanceKm * OPEX_PER_KM[vehicleClass])
  const handling = HANDLING_BASE[vehicleClass]

  return {
    vehicle_class: vehicleClass,
    distance_km: distanceKm,
    mileage_kmpl: mileage,
    diesel_price_inr: diesel,
    fuel_cost: fuel,
    driver_wage: driver,
    per_km_operating_cost: opex,
    handling,
    operating_cost_total: fuel + driver + opex + handling,
  }
}
