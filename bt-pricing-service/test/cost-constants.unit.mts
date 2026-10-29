/**
 * One source for the operating numbers (cost-constants.ts, diesel.ts) — the 18 Oct audit found
 * km/day, tolls and diesel each carrying different values in the quote, the cost floor and the
 * bid breakdown. Pins: the bid breakdown and the cost floor use the SAME km/day and toll table;
 * the quote's own km/day is a named constant (founder ₹60/km anchor); every path reads diesel
 * from the same resolver (state → national DB row → env → 90).
 *
 * The bid breakdown is the trip estimate now (trip-estimate.ts), built on the cost floor, so it shares
 * the floor's km/day, tolls and diesel by construction.
 *
 * Run: npx tsx test/cost-constants.unit.mts
 */
process.env.NODE_ENV = 'test'
delete process.env.DIESEL_PRICE_INR
delete process.env.COST_KM_PER_DAY
delete process.env.QUOTE_KM_PER_DAY

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const cc = await import('../src/lib/cost-constants.js')
  const diesel = await import('../src/lib/diesel.js')
  const engine = await import('../src/lib/cost-engine.js')
  const cto = await import('../src/lib/cto-cost.js')
  const { buildTripEstimate } = await import('../src/lib/trip-estimate.js')
  const est = (km: number, weight_kg: number, model_category: string) =>
    buildTripEstimate({ distance_km: km, weight_kg, load_type: 'general', model_category, floor: null })

  console.log('\n── km per day ──')
  check('cost floor and the shared constant are the same 300', engine.AVG_KM_PER_DAY === 300 && cc.KM_PER_DAY === 300)
  check("the quote's running day is the named QUOTE_KM_PER_DAY (400), not a stray literal", cto.AVG_KM_PER_DAY === cc.QUOTE_KM_PER_DAY && cc.QUOTE_KM_PER_DAY === 400)
  const b600 = est(600, 20_000, 'HCV Cargo 25-31T')
  check('bid estimate counts trip days on the cost floor\'s 300 km/day (600 km → 2 days)', b600.trip_days === 2, String(b600.trip_days))

  console.log('\n── tolls ──')
  check('class from weight: 1t SCV, 5t LCV, 12t MCV, 25t HCV', cc.classForWeightKg(1000) === 'SCV' && cc.classForWeightKg(5000) === 'LCV' && cc.classForWeightKg(12000) === 'MCV' && cc.classForWeightKg(25000) === 'HCV')
  const heavy = est(1000, 25_000, 'HCV Cargo 25-31T')
  const light = est(1000, 1_000, 'SCV Cargo')
  check('without a route toll, the estimate uses the cost floor table by class (HCV 1.80/km → ₹1800 on 1000 km)', heavy.tolls.amount === 1800 && heavy.tolls.basis === 'class_rate', JSON.stringify(heavy.tolls))
  check('…and a light truck pays the SCV rate (1.20/km → ₹1200)', light.tolls.amount === 1200, JSON.stringify(light.tolls))

  console.log('\n── diesel ──')
  check('before any database load: env fallback ₹90', diesel.dieselPriceInr() === 90)
  process.env.DIESEL_PRICE_INR = '93'
  check('…the env still overrides that fallback', diesel.dieselPriceInr() === 93)
  delete process.env.DIESEL_PRICE_INR
  diesel.__setDieselPricesForTests({ national: 91.5, byState: { '27': 94.2, '24': 89.1 } })
  check('the national DB row wins over the env once loaded', diesel.dieselPriceInr() === 91.5)
  check('a known state uses its own price (Maharashtra 27 → 94.2)', diesel.dieselPriceInr('27') === 94.2)
  check('an unknown state falls back to national', diesel.dieselPriceInr('99') === 91.5)
  check('the quote reads the SAME resolver', cto.dieselPriceInr() === 91.5)
  const withDb = est(450, 20_000, 'HCV Cargo 25-31T')
  check('the estimate reads it too (class-typical HCV fuel = 450 / 3.5 × 91.5)', withDb.operating.fuel === Math.round((450 / 3.5) * 91.5) && withDb.diesel_price_inr === 91.5, String(withDb.operating.fuel))

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
