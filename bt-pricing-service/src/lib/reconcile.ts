// Quote ↔ floor ↔ market reconciliation (pricing-engine P3).
//
// The three layers of the engine are computed independently: the CV-Parc operating-cost FLOOR
// (lib/cost-engine.ts), the cost-derived commercial QUOTE (lib/pricing.ts), and the FR8 live-corridor
// MARKET reference (lib/market-engine.ts). This places the headline quote against the other two and
// says, in one UI-ready sentence, where it sits.
//
// It is DELIBERATELY additive and never mutates the headline. `shipper_pays` is the locked price
// (booking-create binds to it — "SHOWN == CHARGED", see routes/pricing.ts), so this layer only
// DESCRIBES that number; it does not move it. It also never nudges: a back-haul lane whose market
// rate is below cost is reported as exactly that, not silently rounded up or hidden.

export type QuotePosition =
  | 'below_floor'        // headline < operating-cost floor (short-trip fixed-cost under-recovery)
  | 'floor_to_market'    // floor ≤ headline ≤ market — the healthy band
  | 'above_market'       // headline > market — the shipper would pay above the lane's going rate
  | 'market_below_floor' // market < floor — a back-haul imbalance; the lane won't bear cost
  | 'unknown'            // neither floor nor market available

export type Reconciliation = {
  /** Operating-cost floor (₹), or null when the norm tables could not be read. */
  cost_floor: number | null
  /** FR8/national market reference (₹), or null when no lane/class rate resolved. */
  market_ref: number | null
  /** The headline quote (₹) — identical to shipper_pays; carried here for a self-contained panel. */
  quoted: number
  position: QuotePosition
  /** (quoted − floor) / floor × 100, 1 dp. null without a floor. Negative ⇒ under the floor. */
  margin_over_floor_pct: number | null
  /** (quoted − market) / market × 100, 1 dp. null without a market. Negative ⇒ under the market. */
  vs_market_pct: number | null
  /** One shipper-facing sentence, ready to render verbatim. */
  note: string
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`

/**
 * Place `quoted` against the operating-cost `floor` and the `market` reference. Pure; both
 * references are optional so a norms/market outage degrades to a partial picture rather than
 * failing. Never mutates the quote — reconciliation is a read on it.
 */
export function reconcile(quoted: number, floor: number | null, market: number | null): Reconciliation {
  const margin_over_floor_pct = floor != null && floor > 0 ? round1(((quoted - floor) / floor) * 100) : null
  const vs_market_pct = market != null && market > 0 ? round1(((quoted - market) / market) * 100) : null

  let position: QuotePosition
  let note: string

  if (floor == null && market == null) {
    position = 'unknown'
    note = 'Reference floor and market rate are unavailable for this lane — showing the cost-derived quote only.'
  } else if (floor != null && market != null && market < floor) {
    // The directional insight: on a back-haul the going rate can sit below what the truck costs to
    // run. The quote holds at a cost-covering level; we say so plainly rather than pretend the lane
    // pays more than it does.
    position = 'market_below_floor'
    note = `The live market rate on this lane (${inr(market)}) is below the operating-cost floor (${inr(floor)}) — a typical back-haul imbalance. The quote holds at a cost-covering level.`
  } else if (floor != null && quoted < floor) {
    position = 'below_floor'
    note = `The quote is ${Math.abs(margin_over_floor_pct!)}% under the estimated operating-cost floor of ${inr(floor)} — short trips carry fixed loading and crew cost that a per-km price under-recovers.`
  } else if (market != null && quoted > market) {
    position = 'above_market'
    note = `The quote is ${vs_market_pct!}% above the live market reference of ${inr(market)} for this lane.`
  } else {
    // floor ≤ quoted ≤ market (or one anchor missing but quoted on the healthy side of the other).
    position = 'floor_to_market'
    const floorPart = floor != null ? `${margin_over_floor_pct}% above the operating-cost floor (${inr(floor)})` : null
    const marketPart = market != null
      ? `${Math.abs(vs_market_pct!)}% ${vs_market_pct! <= 0 ? 'below' : 'above'} the market reference (${inr(market)})`
      : null
    const parts = [floorPart, marketPart].filter(Boolean).join(' and ')
    note = `The quote sits in the healthy band — ${parts}.`
  }

  return {
    cost_floor: floor,
    market_ref: market,
    quoted,
    position,
    margin_over_floor_pct,
    vs_market_pct,
    note,
  }
}
