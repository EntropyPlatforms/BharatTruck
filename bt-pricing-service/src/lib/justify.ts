// Bid estimate — what a fleet operator sees when bidding on a load (routes /justify).
//
// The fleet gets the trip estimate for the truck it would send (lib/trip-estimate.ts): the truck's
// operating cost, the driver and helper salary for the trip days, handling, tolls on the route,
// and the carrier's 18% return on that trip cost. That sum is the estimate to bid at.
//
// When the fleet has typed a bid, it is placed against the same trip cost: what it leaves over
// cost and the return that makes on the money spent. Stated, never adjusted — the bid stays the
// fleet's own number.

import type { TripEstimate } from './trip-estimate.js'

export type BidPosition = 'at_or_above_estimate' | 'covers_cost' | 'below_cost'

export type BidEstimate = {
  estimate: TripEstimate
  /** The fleet's typed bid, or null before one is typed. */
  amount: number | null
  /** amount − trip cost (negative when the bid is below cost); null without a bid. */
  margin: number | null
  /** margin as a % of trip cost, one decimal; null without a bid. */
  return_pct: number | null
  position: BidPosition | null
  /** One sentence, ready to render verbatim. */
  note: string
}

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`

export function bidEstimate(estimate: TripEstimate, amount?: number | null): BidEstimate {
  const e = estimate
  const km = Math.round(e.distance_km)
  if (amount == null || !(amount > 0)) {
    return {
      estimate: e, amount: null, margin: null, return_pct: null, position: null,
      note: `Trip cost ${inr(e.trip_cost)} for a ${e.model_category} over ${km} km; with a ${e.carrier_return_pct}% return the estimate is ${inr(e.carrier_estimate)}.`,
    }
  }
  const bid = Math.round(amount)
  const margin = bid - e.trip_cost
  const return_pct = Math.round((margin / e.trip_cost) * 1000) / 10
  const position: BidPosition = bid >= e.carrier_estimate ? 'at_or_above_estimate' : margin >= 0 ? 'covers_cost' : 'below_cost'
  const note = margin >= 0
    ? `Your bid leaves ${inr(margin)} over the ${inr(e.trip_cost)} trip cost — a ${return_pct}% return.`
    : `Your bid is ${inr(-margin)} below the ${inr(e.trip_cost)} trip cost for this truck and route.`
  return { estimate: e, amount: bid, margin, return_pct, position, note }
}
