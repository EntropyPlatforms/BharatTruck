// "Justify-a-price" allocation — Mode B of the pricing engine (P4).
//
// The other mode (POST /quote) PRODUCES a price from truck + route + load. This one does the inverse:
// a fleet owner or truck owner names their OWN bid at auction, and the engine reverse-generates a
// plausible cost breakdown that sums to EXACTLY that bid — so the shipper sees the bid justified,
// not just a bare number.
//
// Three hard rules from the founder brief:
//   1. Truck-AGNOSTIC. It uses only the load and the route (distance, load type, weight). No mileage,
//      age, emission norm, or any other truck/stakeholder input — the shape is identical for every
//      bidder on the same load, because it describes the LOAD's cost to move, not a specific truck.
//   2. It NEVER nudges. A bid below a typical operating cost is reported as exactly that; the engine
//      does not push the bidder to raise it. It just redistributes the breakdown to match the price.
//   3. It ALWAYS reconciles to the named price: components (+ margin) sum to `amount` to the rupee.
//
// The per-unit costs below are class-agnostic national typicals, and fuel — the largest — is tied to
// the SAME DIESEL_PRICE_INR the rest of the engine uses, so a diesel move carries through here too
// (the anti-drift rule from lib/pricing.ts). They are deliberately NOT a specific truck's norms.

/** Read a positive number from the environment, falling back when unset/invalid. */
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// Class-agnostic typicals. Documented provenance, not magic numbers:
//  - BLENDED_KMPL: a median laden mileage across LCV→HCV; DIESEL/BLENDED gives fuel ₹/km.
//  - TOLL_PER_KM: NHAI FASTag FTL average across corridors.
//  - MAINT_PER_KM: tyres + periodic service + lubricants, blended per-km.
//  - DRIVER_PER_DAY: single-crew allowance+wage per running day.
//  - AVG_KM_PER_DAY: interstate running day, for trip-day count.
const BLENDED_KMPL = 4.5
const TOLL_PER_KM = 2.2
const MAINT_PER_KM = 4.0
const DRIVER_PER_DAY = 1200
const AVG_KM_PER_DAY = 350

// Fixed per-trip loading/handling by load kind (labour + securing), with a heavy-load surcharge.
const HANDLING_BASE: Record<string, number> = {
  general: 800, fragile: 1200, perishable: 1100, hazardous: 1600, heavy_machinery: 1400,
}
const HANDLING_DEFAULT = 800

export type JustifyInput = {
  /** The bidder's own named price — the total the breakdown must sum to. */
  amount: number
  distance_km: number
  /** general | fragile | perishable | hazardous | heavy_machinery. Unknown → general handling. */
  load_type: string
  weight_kg: number
}

export type JustifyComponents = {
  fuel: number
  tolls: number
  driver: number
  maintenance: number
  handling: number
}

export type JustifyBreakdown = {
  /** Echo of the named bid; components + margin === amount, to the rupee. */
  amount: number
  /** Sum of the cost components (excludes margin). Equals amount when the bid is below cost. */
  cost_subtotal: number
  /** amount − cost_subtotal, or 0 when the bid is below the typical operating cost. */
  margin: number
  position: 'margin' | 'below_typical_cost'
  components: JustifyComponents
  /** One shipper-facing sentence, ready to render verbatim. Never nudges. */
  note: string
}

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`

/**
 * Distribute a residual (from integer rounding, or from scaling) onto the largest cost component so
 * the parts sum to `target` EXACTLY. Mutates and returns the same object.
 */
function reconcileToTotal(c: JustifyComponents, target: number): JustifyComponents {
  const keys = Object.keys(c) as (keyof JustifyComponents)[]
  const sum = keys.reduce((s, k) => s + c[k], 0)
  const residual = target - sum
  if (residual !== 0) {
    const largest = keys.reduce((a, b) => (c[b] > c[a] ? b : a), keys[0])
    c[largest] += residual
  }
  return c
}

/**
 * Reverse-generate a cost breakdown that sums to `amount`, from the load and route ALONE.
 *
 * If the bid covers the typical cost, the surplus is `margin`. If it does not, the cost components
 * are scaled down proportionally to fit the bid (margin 0) and the note says so — plainly, without
 * pushing the bidder to change the number. Either way the breakdown reconciles to the bid exactly.
 */
export function justifyPrice(input: JustifyInput): JustifyBreakdown {
  const amount = Math.round(input.amount)
  const distance = Math.max(0, input.distance_km)
  const tripDays = Math.max(1, Math.ceil(distance / AVG_KM_PER_DAY))
  const fuelPerKm = envNum('DIESEL_PRICE_INR', 90) / BLENDED_KMPL

  const handlingBase = HANDLING_BASE[input.load_type] ?? HANDLING_DEFAULT
  const heavySurcharge = input.weight_kg > 5000 ? Math.ceil((input.weight_kg - 5000) / 1000) * 80 : 0

  // Truck-agnostic typical cost of moving THIS load over THIS route.
  const raw: JustifyComponents = {
    fuel: fuelPerKm * distance,
    tolls: TOLL_PER_KM * distance,
    driver: DRIVER_PER_DAY * tripDays,
    maintenance: MAINT_PER_KM * distance,
    handling: handlingBase + heavySurcharge,
  }
  const typicalCost = raw.fuel + raw.tolls + raw.driver + raw.maintenance + raw.handling

  let components: JustifyComponents
  let margin: number
  let position: JustifyBreakdown['position']
  let note: string

  if (amount >= typicalCost) {
    // The bid covers cost; the remainder is the bidder's margin.
    components = reconcileToTotal(
      {
        fuel: Math.round(raw.fuel),
        tolls: Math.round(raw.tolls),
        driver: Math.round(raw.driver),
        maintenance: Math.round(raw.maintenance),
        handling: Math.round(raw.handling),
      },
      Math.round(typicalCost),
    )
    const cost_subtotal = Math.round(typicalCost)
    margin = amount - cost_subtotal
    position = 'margin'
    note = `Covers a typical operating cost of ${inr(cost_subtotal)} to move this load over ${Math.round(distance)} km; the remaining ${inr(margin)} is your margin.`
    return { amount, cost_subtotal, margin, position, components, note }
  }

  // Bid is below the typical cost — scale the components to fit it. No nudge: we state the gap and
  // let the price stand.
  const k = typicalCost > 0 ? amount / typicalCost : 0
  components = reconcileToTotal(
    {
      fuel: Math.round(raw.fuel * k),
      tolls: Math.round(raw.tolls * k),
      driver: Math.round(raw.driver * k),
      maintenance: Math.round(raw.maintenance * k),
      handling: Math.round(raw.handling * k),
    },
    amount,
  )
  margin = 0
  position = 'below_typical_cost'
  note = `This bid is below a typical operating cost of ${inr(Math.round(typicalCost))} for this ${Math.round(distance)} km route; the breakdown is scaled to your price.`
  return { amount, cost_subtotal: amount, margin, position, components, note }
}
