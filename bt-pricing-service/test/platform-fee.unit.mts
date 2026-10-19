/**
 * Platform fee — DISABLED for the pilot (founder, 2026-08).
 *
 * The bug: computeQuote billed a 10% platform fee (platform_fee = ceil(total * 0.10)) and the
 * post page showed it as a "Platform fee" line, while bt-payment-service settles the WHOLE amount
 * to the payees — so the quote both broke the "no fee, never shown" rule AND under-reported the
 * carrier's take. The fee is now pinned to 0 (PLATFORM_FEE_ENABLED = false) so the quote matches
 * what settlement actually does. The eventual model is a flat ₹151 auction-only fee, off by default.
 *
 * Pure function, no database. Run: npx tsx test/platform-fee.unit.mts
 */
import { computeQuote, PLATFORM_FEE_ENABLED } from '../src/lib/pricing.js'
import type { QuoteInput } from '../src/lib/pricing.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const cases: QuoteInput[] = [
  { distance_km: 50,   vehicle_type: 'hcv',        load_type: 'general',         weight_kg: 8000 },
  { distance_km: 1200, vehicle_type: 'trailer',    load_type: 'heavy_machinery', weight_kg: 24000 },
  { distance_km: 15,   vehicle_type: 'mini_truck', load_type: 'fragile',         weight_kg: 800, booking_type: 'auction' },
]

console.log('\n── platform fee is off and never eats into the carrier take')
check('flag is disabled for the pilot', PLATFORM_FEE_ENABLED === false)
for (const input of cases) {
  const q = computeQuote(input)
  const tag = `${input.vehicle_type}/${input.distance_km}km`
  check(`${tag}: platform_fee is 0`, q.platform_fee === 0, `got ${q.platform_fee}`)
  check(`${tag}: shipper_pays === total_price`, q.shipper_pays === q.total_price, `${q.shipper_pays} vs ${q.total_price}`)
  check(`${tag}: carrier receives the whole amount`, q.driver_receives === q.total_price, `${q.driver_receives} vs ${q.total_price}`)
}

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
