/**
 * Bid estimate (POST /justify) — what a fleet operator sees when bidding: the trip estimate for its
 * truck (cost + 18% return) and, once a bid is typed, where that bid lands against the trip cost.
 * The bid is never adjusted.
 *
 * Run: npx tsx test/justify.test.mts
 */
process.env.NODE_ENV = 'test'
delete process.env.DIESEL_PRICE_INR

import { bidEstimate } from '../src/lib/justify.js'
import { buildTripEstimate } from '../src/lib/trip-estimate.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const e = buildTripEstimate({ distance_km: 1437, weight_kg: 12_000, load_type: 'general', model_category: 'MCV Cargo (15-19T)', floor: null, route_toll: { status: 'priced', car_toll_inr: 1500 } })

console.log('\n── before a bid is typed: the estimate alone ──')
const none = bidEstimate(e)
check('no amount → no margin/return/position', none.amount === null && none.margin === null && none.return_pct === null && none.position === null)
check('carries the full trip estimate', none.estimate === e)
check('note states trip cost and the 18% estimate', none.note.includes('18%') && none.note.includes(e.carrier_estimate.toLocaleString('en-IN')), none.note)

console.log('\n── a bid at or above the estimate ──')
const high = bidEstimate(e, e.carrier_estimate + 5000)
check('position at_or_above_estimate', high.position === 'at_or_above_estimate')
check('margin = bid − trip cost', high.margin === e.carrier_estimate + 5000 - e.trip_cost)
check('return % on trip cost, one decimal', high.return_pct === Math.round((high.margin! / e.trip_cost) * 1000) / 10 && high.return_pct! > 18)
check('the bid is echoed unchanged', high.amount === e.carrier_estimate + 5000)

console.log('\n── a bid that covers cost but under the 18% estimate ──')
const mid = bidEstimate(e, e.trip_cost + 1000)
check('position covers_cost, margin 1000', mid.position === 'covers_cost' && mid.margin === 1000)
check('return under 18%', mid.return_pct! < 18 && mid.return_pct! > 0)

console.log('\n── a bid below cost ──')
const low = bidEstimate(e, 8000)
check('position below_cost with a negative margin', low.position === 'below_cost' && low.margin === 8000 - e.trip_cost && low.margin! < 0)
check('note states the gap, never a different price', low.note.includes('below') && low.amount === 8000, low.note)

console.log('\n── rounding ──')
check('fractional bids are rounded to the rupee', bidEstimate(e, 50_000.6).amount === 50_001)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
