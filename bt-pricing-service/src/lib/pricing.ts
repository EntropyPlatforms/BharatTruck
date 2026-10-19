import { z } from 'zod'
import {
  type VehicleClass,
  VEHICLE_TYPE_TO_CLASS,
  HANDLING_BASE,
  costBreakdown,
  variableCostPerKm,
  type CostBreakdown,
} from './cto-cost.js'
import type { CostFloorBreakdown } from './cost-engine.js'

// -----------------------------------------------------------
// Commercial split (what the shipper is charged) PLUS the CTO deterministic
// cost-breakdown anchor (Appendix A) so the shipper sees where the price comes
// from. Both are returned together.
//
// THE RATE CARD IS DERIVED FROM THE COST MODEL, NOT HARDCODED.
//
// It used to be a second, independent table of magic numbers — hcv: 22 — sitting
// next to a cost engine that says an HCV costs 90/3.5 + 1200/400 + 8 = ~36.7 per
// km to run. Every class was underwater, worst at HCV, where the platform quoted
// 22 against a 36.7 cost and the carrier ate ~15/km. That is what put negative
// margins on the fleet P&L dashboards.
//
// Two hardcoded tables cannot stay in sync, and the failure is silent and
// one-directional: raise DIESEL_PRICE_INR and the cost side moves while the rate
// side does not, so the same bug quietly comes back and deepens with every fuel
// move. Deriving the rate from the cost makes "priced below cost" structurally
// unreachable for any positive margin multiple.
// -----------------------------------------------------------

/** Read a positive number from the environment, falling back when unset/invalid. */
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * Gross margin over operating cost.
 *
 * Anchored on the only real market numbers we have (founder, 2026-08-02): an HCV
 * costs about 36/km to run and moves at about 60/km in the market. 36.71 * 1.63
 * = 59.8, which reproduces that 60 from the cost model alone — so one constant
 * carries the whole card instead of four independently-guessed rates.
 */
export const MARGIN_MULTIPLE = envNum('PRICE_MARGIN_MULTIPLE', 1.63)

/**
 * Commercial rate (INR/km) for a vehicle type.
 *
 * Derived from the cost model, with a per-type env escape hatch —
 * `RATE_PER_KM_HCV=60` — for when the founder has a real number for a lane and
 * wants it used verbatim rather than computed. Overrides are deliberately NOT
 * floored at cost: an operator setting a rate is making a commercial decision
 * (a loss-leader on a return leg is a real strategy) and the platform should not
 * silently overrule it. The default path is the one that must never go
 * underwater, and it cannot.
 */
export function ratePerKm(vehicleType: string): number {
  const override = envNum(`RATE_PER_KM_${vehicleType.toUpperCase()}`, 0)
  if (override) return override
  const cls: VehicleClass = VEHICLE_TYPE_TO_CLASS[vehicleType] ?? 'MCV'
  return Math.round(variableCostPerKm(cls) * MARGIN_MULTIPLE)
}

export const LOAD_MULT: Record<string, number>   = { general: 1.0, fragile: 1.2, perishable: 1.15, hazardous: 1.5, heavy_machinery: 1.3 }

// Platform fee — DISABLED for the pilot, and NEVER shown inside a customer quote.
// Founder rule (2026-08): no platform fee until at least 5 transporters are onboarded,
// and a fee must never appear in a quotation (it kills first-trip conversion). The
// eventual model is a FLAT ₹151 per load charged ONLY on loads booked through OUR
// auctions — never a percentage, never on direct/instant bookings. Kept as one flag +
// one constant so switching it on is a one-line change, scoped to the auction path,
// not a re-derivation. bt-payment-service already settles the WHOLE amount to the
// payees (no fee taken), so a zero fee is what keeps the quote honest about the money.
export const PLATFORM_FEE_ENABLED = false
export const PLATFORM_FEE_PER_LOAD_INR = 151

// -----------------------------------------------------------
// ADVISORY vs BINDING — what the number MEANS (D-11).
//
// On an auction the platform does not have a price. The shipper is shown a
// benchmark; the charge is the winning carrier's bid. Until now the response
// said nothing about which of those it was, so the distinction lived only in the
// shipper form's local `bookingType` state — the server asserted a price and the
// client decided, on its own, whether to believe it. Nothing in the persisted
// price_quotes row recorded the difference, so a row read back later could not
// answer "was this quote the charge, or a reference?".
//
// Which is why the classification is only half the fix. quote_kind is worth
// nothing unless the caller tells the server which booking it is quoting: an
// auction stored as `binding` is not a missing label, it is a WRONG one, and a
// wrong one written down. The shipper booking form therefore sends its
// booking_type on every quote, and the round-trip is pinned in test/.
//
// This is not only a product decision. Under Indian GST, a platform that SETS
// the freight price drifts toward being a "goods transport agency" — a tax and
// cargo-liability characterisation, not a labelling exercise. Price DISCOVERY
// (a benchmark derived from an operating-cost model) is safe; price SETTING is
// the exposure. See INDIA_FREIGHT_COMPLIANCE.md §1.3 red line 3, which lists
// "the platform sets the freight price" as one of three tells that pull toward
// GTA characterisation, and §9.4, which names this service. Founder decision
// Q20 ("the platform never has its own price") and the legal constraint point
// the same way, which is why they must be kept pointing the same way.
//
// So: do NOT "simplify" this by dropping quote_kind and letting every quote be
// a price. The label is the substance — it is what makes the auction number a
// reference rather than a rate the platform charges.
// -----------------------------------------------------------

/**
 * The booking_type union. MUST stay identical to the canonical declaration in
 * bt-booking-service/src/lib/types.ts (`type BookingType = 'direct' | 'auction'`),
 * which is also the CreateBookingBody enum, what shipper/ and driver/ declare, and
 * the only two values bookings.booking_type has ever held in production.
 *
 * Two values, no more. An earlier draft of this file carried a third — 'instant' —
 * that exists nowhere else in the system, and the damage was not the dead enum
 * member: quoteKind() classifies everything that is not 'auction' as binding, so a
 * value no caller can send simply never arrives, while the surrounding comments and
 * tests describe a booking mode that does not exist. That reads as though the
 * binding path were the exotic case ('instant'/'direct') when in fact 'direct' IS
 * the binding case and the whole of it. Anyone reasoning about the advisory line
 * from this file would have been reasoning about the wrong system.
 *
 * If a third booking mode is ever added, it lands in bt-booking-service first and
 * is mirrored here — never the other way round.
 */
export const BOOKING_TYPES = ['direct', 'auction'] as const
export type BookingType = (typeof BOOKING_TYPES)[number]

/** Whether the quoted number is the charge (`binding`) or a benchmark (`advisory`). */
export type QuoteKind = 'advisory' | 'binding'

/**
 * Classify a quote by the booking it was requested for.
 *
 * 'direct' → binding: one named carrier, no bidding, so the quoted number is the
 * freight. 'auction' → advisory: the charge is the winning bid.
 *
 * Absent booking_type means `binding`. That is a COMPATIBILITY default, not a
 * legal opinion: a caller that predates this field — bt-booking-service's
 * quote-lock saga, which resolves the charge from the locked row — must keep
 * behaving exactly as it does today. Widening the default to advisory would
 * silently unbind the direct price lock, which is the one thing this change must
 * not do.
 *
 * The default is also the reason the shipper form must SEND its booking_type
 * rather than lean on it. Production is overwhelmingly auctions, so a caller that
 * stays silent does not get a harmless "unknown" — it gets a positive, stored
 * assertion that the platform is charging that price, on precisely the bookings
 * where it is not. See routes/pricing.ts and the shipper booking form.
 */
export function quoteKind(bookingType?: BookingType): QuoteKind {
  return bookingType === 'auction' ? 'advisory' : 'binding'
}

export const QuoteBody = z.object({
  distance_km:  z.number().positive(),
  vehicle_type: z.enum(['mini_truck', 'lcv', 'hcv', 'trailer']),
  load_type:    z.enum(['general', 'fragile', 'perishable', 'hazardous', 'heavy_machinery']),
  weight_kg:    z.number().positive(),
  // Optional so existing callers are byte-identical (see quoteKind above).
  booking_type: z.enum(BOOKING_TYPES).optional(),
  // Richer, OPTIONAL cost-engine inputs. Absent → the vehicle_type-derived
  // defaults are used, so the existing request shape is unchanged; present →
  // they refine the real CV-Parc cost floor (see lib/cost-engine.ts).
  model_category: z.string().optional(),
  emission_norm:  z.enum(['bs6', 'bs4']).optional(),
  truck_age:      z.number().int().positive().optional(),
  diesel_price_inr: z.number().positive().optional(),
})
export type QuoteInput = z.infer<typeof QuoteBody>

export type QuoteResult = {
  base_price: number
  weight_surcharge: number
  /** Fixed per-trip loading/handling cost, passed through at cost. */
  handling_fee: number
  /** Derived rate actually used, so the caller can show its working. */
  rate_per_km: number
  total_price: number
  platform_fee: number
  shipper_pays: number
  driver_receives: number
  currency: 'INR'
  version: string
  cost_breakdown: CostBreakdown
  /**
   * The REAL operating-cost floor from the CV-Parc norms (lib/cost-engine.ts),
   * when it could be resolved. This is the additive, data-backed successor to the
   * flat `cost_breakdown` above: every line item + running + total_direct + floor.
   *
   * null when the norm tables could not be read — the commercial split above does
   * not depend on it, so a norms outage degrades to a quote without the floor
   * rather than a failed quote. In production the tables are seeded, so it is
   * populated. Carried in breakdown_json; adds no top-level contract break.
   */
  cost_floor: CostFloorBreakdown | null
  /** Whether this number is the charge or a benchmark. See quoteKind. */
  quote_kind: QuoteKind
  /**
   * One human-readable sentence naming where the number came from, meant to be
   * shown to the shipper verbatim.
   *
   * It exists so the disclosure travels WITH the quote instead of being
   * reassembled by each client. A UI that has to compose this itself will
   * eventually compose it wrong, or omit it — and an auction number displayed
   * without "this is a reference" is exactly the fact pattern §1.3 warns about.
   */
  basis: string
}

/**
 * The shipper-facing sentence explaining the number. Kept next to the maths so
 * the wording cannot drift from the arithmetic it describes.
 */
function quoteBasis(kind: QuoteKind, vehicleClass: VehicleClass, rate: number, distanceKm: number): string {
  const derivation = `₹${rate}/km for a ${vehicleClass} over ${distanceKm} km, derived from BharatTruck's operating-cost model`
  return kind === 'advisory'
    // Names the actual payee. "Indicative"/"approximate" would only soften the
    // number while still implying the platform is the one charging it.
    ? `Reference estimate: ${derivation}. You pay the winning carrier's bid — this is a benchmark, not the price.`
    : `${derivation}. This is the price charged for this booking.`
}

/**
 * @param costFloor Pre-resolved REAL cost floor from lib/cost-engine.ts, or null.
 *   The engine's loaders are async (they read the seeded norm tables), so the
 *   route resolves the floor and passes it in here; computeQuote itself stays
 *   synchronous and pure. Omitting the argument yields `cost_floor: null`, which
 *   is byte-compatible with every caller that predates this field.
 */
export function computeQuote(input: QuoteInput, costFloor?: CostFloorBreakdown | null): QuoteResult {
  const { distance_km, vehicle_type, load_type, weight_kg } = input

  const vehicleClass: VehicleClass = VEHICLE_TYPE_TO_CLASS[vehicle_type] ?? 'MCV'
  const rate = ratePerKm(vehicle_type)

  const base         = Math.ceil(distance_km * rate * (LOAD_MULT[load_type] ?? 1.0))
  const wt_surcharge = weight_kg > 5000 ? Math.ceil((weight_kg - 5000) / 1000) * 500 : 0

  // Handling is a FIXED per-trip cost (loading/unloading labour), so a purely
  // per-km price leaves it uncovered — and the shorter the trip, the bigger the
  // hole. A 50km HCV run bills 3,000 against 2,836 of cost, of which 1,000 is
  // this. Passed through at cost, not marked up: the margin is on the movement.
  const handling     = HANDLING_BASE[vehicleClass]

  const total        = base + wt_surcharge + handling
  // No platform fee during the pilot (see PLATFORM_FEE_ENABLED). The field stays on the
  // quote for wire stability, pinned to 0: settlement pays the payees the whole amount,
  // so the quote must not imply — or show — a cut that is never taken.
  const platform_fee = PLATFORM_FEE_ENABLED ? PLATFORM_FEE_PER_LOAD_INR : 0

  // Classification only — it changes no arithmetic above. An advisory quote is
  // the SAME number as a binding one; what differs is whether the platform is
  // charging it. Deliberately not a discount or a range: a benchmark that moved
  // the number would stop being a benchmark.
  const kind = quoteKind(input.booking_type)

  return {
    base_price: base,
    weight_surcharge: wt_surcharge,
    handling_fee: handling,
    rate_per_km: rate,
    total_price: total,
    platform_fee,
    shipper_pays: total,
    driver_receives: total - platform_fee,
    currency: 'INR',
    version: 'v2-cost-derived',
    cost_breakdown: costBreakdown(vehicleClass, distance_km),
    cost_floor: costFloor ?? null,
    quote_kind: kind,
    basis: quoteBasis(kind, vehicleClass, rate, distance_km),
  }
}
