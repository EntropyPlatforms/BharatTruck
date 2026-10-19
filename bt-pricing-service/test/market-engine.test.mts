/**
 * Market-rate layer (pricing-engine P2).
 *
 * Pins the mechanics — coords → nearest seeded city → FR8 corridor rate, national ₹/km fallback —
 * and, above all, the DIRECTIONAL asymmetry that makes freight pricing what it is: the same corridor
 * priced head-haul vs back-haul is a very different number (Mumbai→Delhi ₹59.5/km, Delhi→Mumbai
 * ₹35.5/km, DS 1.80 vs 0.65). Pure functions, no database. Run: npx tsx test/market-engine.test.mts
 */
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { resolveMarketFrom, nearestCity, contextMultiplier } from '../src/lib/market-engine.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const cities = [
  { city: 'Mumbai', lat: 19.076, lng: 72.877 },
  { city: 'Delhi', lat: 28.614, lng: 77.209 },
]
const lanes = new Map([
  ['Mumbai Delhi', { inr_per_km: 59.5, mxl_inr: 85500, ds_ratio: 1.80 }],
  ['Delhi Mumbai', { inr_per_km: 35.5, mxl_inr: 50000, ds_ratio: 0.65 }],
])
const nationalPerKm = new Map([['HCV', 62.86], ['MCV', 92.39], ['LCV', 92.39], ['SCV', 68.91]])
const ref = { cities, lanes, nationalPerKm }

console.log('\n── coords → nearest seeded city (radius-gated)')
check('a point near Mumbai resolves to Mumbai', nearestCity(19.08, 72.88, cities) === 'Mumbai')
check('a point near Delhi resolves to Delhi', nearestCity(28.60, 77.21, cities) === 'Delhi')
check('a point far from every seeded city → null (→ national fallback)', nearestCity(0, 0, cities) === null)

console.log('\n── FR8 corridor rate + the DIRECTIONAL asymmetry')
const head = resolveMarketFrom({ source_lat: 19.076, source_lng: 72.877, dest_lat: 28.614, dest_lng: 77.209, distance_km: 1437, vehicle_class: 'HCV' }, ref)
check('head-haul Mumbai→Delhi uses the FR8 lane rate', head.market_basis === 'lane_fr8' && head.inr_per_km === 59.5, JSON.stringify(head))
check('head-haul market = ₹59.5/km × 1437', head.market_price === Math.round(59.5 * 1437), `(got ${head.market_price})`)
check('head-haul carries the DS ratio 1.80', head.ds_ratio === 1.80)

const back = resolveMarketFrom({ source_lat: 28.614, source_lng: 77.209, dest_lat: 19.076, dest_lng: 72.877, distance_km: 1407, vehicle_class: 'HCV' }, ref)
check('🔴 back-haul Delhi→Mumbai is a DIFFERENT, cheaper rate (₹35.5/km, DS 0.65)', back.inr_per_km === 35.5 && back.ds_ratio === 0.65, JSON.stringify(back))
check('🔴 back-haul market is far below head-haul (lane imbalance)', back.market_price < head.market_price * 0.7, `(${back.market_price} vs ${head.market_price})`)

console.log('\n── fallbacks')
const unknown = resolveMarketFrom({ source_lat: 0, source_lng: 0, dest_lat: 10, dest_lng: 10, distance_km: 1000, vehicle_class: 'HCV' }, ref)
check('an unknown corridor falls back to the national ₹/km', unknown.market_basis === 'national' && unknown.inr_per_km === 62.86, JSON.stringify(unknown))
const lcv = resolveMarketFrom({ source_lat: 19.076, source_lng: 72.877, dest_lat: 28.614, dest_lng: 77.209, distance_km: 1437, vehicle_class: 'LCV' }, ref)
check('a non-HCV class on a seeded corridor uses national (no per-lane FR8 rate)', lcv.market_basis === 'national' && lcv.inr_per_km === 92.39, JSON.stringify(lcv))

console.log('\n── context multiplier (light for P2)')
check('urgent × monsoon compounds', Math.abs(contextMultiplier({ urgent: true, monsoon: true }) - 1.155) < 1e-9)
check('no flags → 1.0', contextMultiplier({}) === 1)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
