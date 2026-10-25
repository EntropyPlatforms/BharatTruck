/**
 * One source for the operating numbers (cost-constants.ts, diesel.ts) — the 18 Oct audit found
 * km/day, tolls and diesel each carrying different values in the quote, the cost floor and the
 * bid breakdown. Pins: the bid breakdown and the cost floor use the SAME km/day and toll table;
 * the quote's own km/day is a named constant (founder ₹60/km anchor); every path reads diesel
 * from the same resolver (state → national DB row → env → 90).
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
  const { justifyPrice } = await import('../src/lib/justify.js')

  console.log('\n── km per day ──')
  check('cost floor and the shared constant are the same 300', engine.AVG_KM_PER_DAY === 300 && cc.KM_PER_DAY === 300)
  check("the quote's running day is the named QUOTE_KM_PER_DAY (400), not a stray literal", cto.AVG_KM_PER_DAY === cc.QUOTE_KM_PER_DAY && cc.QUOTE_KM_PER_DAY === 400)
  const b600 = justifyPrice({ amount: 50_000, distance_km: 600, load_type: 'general', weight_kg: 20_000 })
  check('bid breakdown counts driver days on the cost floor\'s 300 km/day (600 km → 2 days)', b600.components.driver === 2 * 1200 || Math.round(b600.components.driver) === 2400, JSON.stringify(b600.components))

  console.log('\n── tolls ──')
  check('class from weight: 1t SCV, 5t LCV, 12t MCV, 25t HCV', cc.classForWeightKg(1000) === 'SCV' && cc.classForWeightKg(5000) === 'LCV' && cc.classForWeightKg(12000) === 'MCV' && cc.classForWeightKg(25000) === 'HCV')
  const heavy = justifyPrice({ amount: 100_000, distance_km: 1000, load_type: 'general', weight_kg: 25_000 })
  const light = justifyPrice({ amount: 100_000, distance_km: 1000, load_type: 'general', weight_kg: 1_000 })
  check('bid breakdown tolls use the cost floor table by class (HCV 1.80/km → ₹1800 on 1000 km)', Math.round(heavy.components.tolls) === 1800, String(heavy.components.tolls))
  check('…and a light load pays the SCV rate (1.20/km → ₹1200), not the old flat 2.20', Math.round(light.components.tolls) === 1200, String(light.components.tolls))

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
  const withDb = justifyPrice({ amount: 50_000, distance_km: 450, load_type: 'general', weight_kg: 20_000 })
  check('the bid breakdown reads it too (fuel = 91.5 / 4.5 × 450)', Math.round(withDb.components.fuel) === Math.round((91.5 / 4.5) * 450), String(withDb.components.fuel))

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
