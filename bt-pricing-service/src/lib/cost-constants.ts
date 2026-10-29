// -----------------------------------------------------------
// cost-constants — ONE source for the operating numbers every price path uses.
//
// The 18 Oct audit found the same quantity carried different values in different places:
//   km per day   300 (cost floor) · 400 (headline quote) · 350 (bid breakdown)
//   toll ₹/km    1.20–1.80 by class (cost floor) · 2.20 flat (bid breakdown) · none (quote)
//   diesel ₹/l   DB national row (cost floor) · env DIESEL_PRICE_INR (quote, breakdown)
// so a shipper's quote, the floor it is checked against and a carrier's bid breakdown could
// disagree about the same trip. They now all read from here (and diesel from diesel.ts).
//
// Values: the cost floor's workbook-calibrated figures (cost-engine.ts reproduces the
// workbook's Trip Days and Toll ₹ exactly), because they are the only ones derived from data.
// Each is env-overridable for tuning without a release.
// -----------------------------------------------------------

export type CostClass = 'SCV' | 'LCV' | 'MCV' | 'HCV'

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** A running day's distance for COST trip-day counts: the cost floor and a carrier's bid breakdown. */
export const KM_PER_DAY = envNum('COST_KM_PER_DAY', 300)

/**
 * The headline quote's running day. Deliberately NOT KM_PER_DAY: the shipper-facing rate card is
 * calibrated so a heavy truck lands on the founder's market anchor of ₹60/km (pinned in
 * test/pricing.e2e.mts). Moving it to 300 raises every quote's driver line by a third and breaks
 * that anchor — a pricing decision for the founder, not a constant clean-up. Named here so the
 * difference is visible and owned, instead of a stray literal.
 */
export const QUOTE_KM_PER_DAY = envNum('QUOTE_KM_PER_DAY', 400)

/** Toll ₹/km by class — clean-row medians from the cost workbook. */
export const TOLL_PER_KM: Record<CostClass, number> = { SCV: 1.2, LCV: 1.6, MCV: 1.7, HCV: 1.8 }

/** The class a load of this weight needs (mirrors the app's weight → vehicle picker). */
export function classForWeightKg(weightKg: number): CostClass {
  if (!Number.isFinite(weightKg) || weightKg <= 1_500) return 'SCV'
  if (weightKg <= 7_000) return 'LCV'
  if (weightKg <= 16_000) return 'MCV'
  return 'HCV'
}

// ── Trip estimate structure (founder brief, 29 Oct) ──────────────────────────
//   carrier estimate   = trip cost × (1 + CARRIER_RETURN_PCT)
//   shipper indicative = carrier estimate × MARKET_CORRECTION
// Trip cost is the truck's operating cost + driver & helper salary for the trip days + handling
// + tolls on the route (trip-estimate.ts).

/** The fleet operator's return on the money spent to execute the trip (0.18 = 18%). */
export const CARRIER_RETURN_PCT = envNum('CARRIER_RETURN_PCT', 0.18)

/**
 * Market correction on the shipper's indicative rate — a starting value protecting the fleet's
 * margin while keeping the shipper's price close to cost. To be derived from booked history and
 * market references later; marketCorrectionFactor() is the one place that logic will go.
 */
export const MARKET_CORRECTION = envNum('MARKET_CORRECTION_FACTOR', 1.05)

export function marketCorrectionFactor(): number {
  return MARKET_CORRECTION
}
