/**
 * Quote ↔ floor ↔ market reconciliation (pricing-engine P3).
 *
 * Pins the five positions the headline quote can take against the operating-cost floor and the FR8
 * market reference — above all the DIRECTIONAL one (`market_below_floor`), where a back-haul lane's
 * going rate sits below what the truck costs to run. Also pins the invariant that reconciliation is
 * a READ: it never alters the quoted number. Pure function, no database. Run: npx tsx test/reconcile.test.mts
 */
import { reconcile } from '../src/lib/reconcile.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

console.log('\n── the healthy band: floor ≤ quote ≤ market')
const healthy = reconcile(90000, 72000, 95000)
check('position is floor_to_market', healthy.position === 'floor_to_market', JSON.stringify(healthy))
check('margin over floor is +25%', healthy.margin_over_floor_pct === 25, `(${healthy.margin_over_floor_pct})`)
check('vs market is negative (under market)', healthy.vs_market_pct !== null && healthy.vs_market_pct < 0, `(${healthy.vs_market_pct})`)
check('note names the healthy band', /healthy band/.test(healthy.note))

console.log('\n── 🔴 back-haul: market rate below the operating-cost floor')
const backhaul = reconcile(76000, 72000, 50000) // Delhi→Mumbai style: FR8 lane cheaper than cost
check('position is market_below_floor', backhaul.position === 'market_below_floor', JSON.stringify(backhaul))
check('the quote is NOT altered (still 76000)', backhaul.quoted === 76000)
check('note flags the back-haul imbalance', /back-haul|below the operating-cost floor/.test(backhaul.note))

console.log('\n── short trip: per-km quote under the fixed-cost floor')
const short = reconcile(3000, 3400, 3800) // 50km run, fixed crew/handling dominate the floor
check('position is below_floor', short.position === 'below_floor', JSON.stringify(short))
check('margin over floor is negative', short.margin_over_floor_pct !== null && short.margin_over_floor_pct < 0, `(${short.margin_over_floor_pct})`)
check('note explains fixed cost under-recovery', /fixed loading and crew|under-recovers/.test(short.note))

console.log('\n── quote above the market reference')
const above = reconcile(120000, 72000, 95000)
check('position is above_market', above.position === 'above_market', JSON.stringify(above))
check('vs market is +26.3%', above.vs_market_pct === round1(((120000 - 95000) / 95000) * 100), `(${above.vs_market_pct})`)

console.log('\n── degraded inputs')
const noRefs = reconcile(90000, null, null)
check('no floor + no market → unknown', noRefs.position === 'unknown', JSON.stringify(noRefs))
check('percentages are null when refs missing', noRefs.margin_over_floor_pct === null && noRefs.vs_market_pct === null)
const floorOnly = reconcile(90000, 72000, null)
check('floor only, quote above it → floor_to_market', floorOnly.position === 'floor_to_market', JSON.stringify(floorOnly))
check('floor only still reports margin', floorOnly.margin_over_floor_pct === 25 && floorOnly.vs_market_pct === null)

console.log('\n── invariant: reconciliation never changes the quote')
for (const q of [1, 3000, 76000, 90000, 250000]) {
  const r = reconcile(q, 72000, 95000)
  check(`quoted preserved for ${q}`, r.quoted === q)
}

function round1(n: number): number { return Math.round(n * 10) / 10 }

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
