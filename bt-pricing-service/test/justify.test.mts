/**
 * "Justify-a-price" allocation — Mode B (pricing-engine P4).
 *
 * Pins the three hard rules of the founder brief:
 *   1. It reconciles to the named bid EXACTLY (components + margin === amount) for every amount.
 *   2. It is truck-AGNOSTIC — the breakdown depends only on the load and route, never on truck facts.
 *   3. It NEVER nudges — a below-cost bid is reported and the breakdown scaled to it, not raised.
 * Pure function, no database. Run: npx tsx test/justify.test.mts
 */
import { justifyPrice, type JustifyComponents } from '../src/lib/justify.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const sumComponents = (c: JustifyComponents) => c.fuel + c.tolls + c.driver + c.maintenance + c.handling

console.log('\n── invariant: components + margin === amount, to the rupee (every amount)')
{
  let allExact = true, allNonNeg = true
  for (const amount of [1, 5000, 25000, 49999, 50000, 76000, 90000, 123456, 250000, 1000000]) {
    const b = justifyPrice({ amount, distance_km: 1437, load_type: 'general', weight_kg: 12000 })
    const total = sumComponents(b.components) + b.margin
    if (total !== amount) { allExact = false; console.log(`    drift at ${amount}: total ${total}`) }
    if (Object.values(b.components).some((v) => v < 0) || b.margin < 0) allNonNeg = false
  }
  check('reconciles to the exact bid for all amounts', allExact)
  check('no component or margin ever goes negative', allNonNeg)
}

console.log('\n── a healthy bid: cost is covered, remainder is margin')
{
  const b = justifyPrice({ amount: 120000, distance_km: 1437, load_type: 'general', weight_kg: 12000 })
  check('position is margin', b.position === 'margin', JSON.stringify(b.position))
  check('margin is positive', b.margin > 0, `(${b.margin})`)
  check('cost_subtotal + margin === amount', b.cost_subtotal + b.margin === 120000, `(${b.cost_subtotal}+${b.margin})`)
  check('note names the cost and the margin', /typical operating cost/.test(b.note) && /margin/.test(b.note))
}

console.log('\n── 🔴 a below-cost bid: scaled to the price, margin 0, NO nudge')
{
  const b = justifyPrice({ amount: 8000, distance_km: 1437, load_type: 'general', weight_kg: 12000 })
  check('position is below_typical_cost', b.position === 'below_typical_cost', JSON.stringify(b.position))
  check('margin is exactly 0', b.margin === 0, `(${b.margin})`)
  check('components still sum to the bid', sumComponents(b.components) === 8000, `(${sumComponents(b.components)})`)
  check('note states the gap but does not tell the bidder to raise it', /below a typical operating cost/.test(b.note) && !/should|increase|raise|recommend/i.test(b.note))
}

console.log('\n── truck-agnostic: identical route+load → identical breakdown regardless of any truck fact')
{
  // The input type carries NO truck fields; prove two callers who differ only in (hypothetical)
  // truck intent get byte-identical breakdowns because only load+route are inputs.
  const a = justifyPrice({ amount: 90000, distance_km: 1200, load_type: 'fragile', weight_kg: 8000 })
  const b = justifyPrice({ amount: 90000, distance_km: 1200, load_type: 'fragile', weight_kg: 8000 })
  check('same load+route+bid → identical components', JSON.stringify(a.components) === JSON.stringify(b.components))
  check('handling reflects load_type (fragile > general)', a.components.handling >
    justifyPrice({ amount: 90000, distance_km: 1200, load_type: 'general', weight_kg: 8000 }).components.handling)
}

console.log('\n── route sensitivity: fuel scales with distance, driver with trip-days')
{
  const short = justifyPrice({ amount: 200000, distance_km: 200, load_type: 'general', weight_kg: 3000 })
  const long = justifyPrice({ amount: 200000, distance_km: 2000, load_type: 'general', weight_kg: 3000 })
  check('longer route → more fuel', long.components.fuel > short.components.fuel, `(${long.components.fuel} vs ${short.components.fuel})`)
  check('longer route → more driver days', long.components.driver > short.components.driver, `(${long.components.driver} vs ${short.components.driver})`)
  check('heavy load adds handling', justifyPrice({ amount: 200000, distance_km: 200, load_type: 'general', weight_kg: 20000 }).components.handling > short.components.handling)
}

console.log('\n── degenerate: zero distance still reconciles (handling-only)')
{
  const b = justifyPrice({ amount: 3000, distance_km: 0, load_type: 'general', weight_kg: 1000 })
  check('zero-distance breakdown sums to the bid', sumComponents(b.components) + b.margin === 3000, JSON.stringify(b))
}

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
