import { z } from 'zod'
import {
  type VehicleClass,
  VEHICLE_TYPE_TO_CLASS,
  costBreakdown,
  type CostBreakdown,
} from './cto-cost.js'
import type { CostFloorBreakdown } from './cost-engine.js'
import { buildTripEstimate, categoryForWeightKg, type TripEstimate } from './trip-estimate.js'
import { resolveModelCategory } from './cost-engine.js'

// -----------------------------------------------------------
// The shipper's price is the INDICATIVE RATE of the trip estimate (lib/trip-estimate.ts):
//
//   trip cost (truck running + driver & helper + handling + route tolls)
//   + the fleet operator's return (18% of trip cost)
//   × market correction (1.05)
//
// It replaced a ₹/km rate card (operating cost × 1.63, anchored on ₹60/km for an HCV) on the
// founder's brief of 29 Oct 2026, so the shipper's number is built from the same lines a fleet
// sees when it bids — a truck-specific cost, a stated carrier margin, and one market factor.
// -----------------------------------------------------------

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
  /** Trip cost before handling (truck running + crew + tolls). */
  base_price: number
  /** Retired with the rate card; weight now enters through the truck and handling. Always 0. */
  weight_surcharge: number
  /** Loading/unloading for this load's weight and type. */
  handling_fee: number
  /** The indicative rate per km, so the caller can show its working. */
  rate_per_km: number
  total_price: number
  platform_fee: number
  shipper_pays: number
  driver_receives: number
  currency: 'INR'
  version: string
  /** The legacy flat class breakdown (kept on the wire for vehicle_class and older readers). */
  cost_breakdown: CostBreakdown
  /**
   * The REAL operating-cost floor from the CV-Parc norms (lib/cost-engine.ts), when it could be
   * resolved; null when the norm tables could not be read. Used for the floor/quote/market
   * reconciliation, not for the price.
   */
  cost_floor: CostFloorBreakdown | null
  /** Every line of the price: trip cost, carrier return, market correction. */
  trip_estimate: TripEstimate
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

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

/**
 * The shipper-facing sentence explaining the number. Kept next to the maths so
 * the wording cannot drift from the arithmetic it describes.
 */
function quoteBasis(kind: QuoteKind, e: TripEstimate): string {
  const derivation =
    `Indicative rate for a ${e.model_category} over ${Math.round(e.distance_km)} km: trip cost ${inr(e.trip_cost)} ` +
    `(truck running, driver & helper, tolls, handling) + ${e.carrier_return_pct}% carrier margin, × ${e.market_correction} market correction`
  return kind === 'advisory'
    // Names the actual payee. "Indicative"/"approximate" would only soften the
    // number while still implying the platform is the one charging it.
    ? `Reference estimate — ${derivation}. You pay the winning carrier's bid — this is a benchmark, not the price.`
    : `${derivation}. This is the price charged for this booking.`
}

/**
 * @param estimate The trip estimate resolved by the route (truck norms + route tolls). The norm
 *   loaders are async, so the route resolves it and passes it in; computeQuote stays synchronous
 *   and pure. Omitted, it is built here from class typicals and class toll rates — the same
 *   structure, without the truck's own norms.
 * @param costFloor The CV-Parc floor the estimate was built on, carried for the reconciliation.
 */
export function computeQuote(
  input: QuoteInput,
  estimate?: TripEstimate | null,
  costFloor?: CostFloorBreakdown | null,
): QuoteResult {
  const { distance_km, vehicle_type } = input
  const vehicleClass: VehicleClass = VEHICLE_TYPE_TO_CLASS[vehicle_type] ?? 'MCV'
  const e = estimate ?? buildTripEstimate({
    distance_km,
    weight_kg: input.weight_kg,
    load_type: input.load_type,
    model_category: input.model_category || (vehicle_type ? resolveModelCategory(input) : categoryForWeightKg(input.weight_kg)),
    emission_norm: input.emission_norm,
    truck_age: input.truck_age,
    floor: null,
  })

  const total = e.shipper_indicative
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
    base_price: e.trip_cost - e.handling,
    weight_surcharge: 0,
    handling_fee: e.handling,
    rate_per_km: Math.round((total / distance_km) * 100) / 100,
    total_price: total,
    platform_fee,
    shipper_pays: total,
    driver_receives: total - platform_fee,
    currency: 'INR',
    version: 'v3-trip-estimate',
    cost_breakdown: costBreakdown(vehicleClass, distance_km),
    cost_floor: costFloor ?? null,
    trip_estimate: e,
    quote_kind: kind,
    basis: quoteBasis(kind, e),
  }
}
