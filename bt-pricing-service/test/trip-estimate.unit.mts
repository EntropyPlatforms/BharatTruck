/**
 * Trip estimate — the one cost structure behind the fleet's bid estimate and the shipper's rate
 * (founder brief, 29 Oct 2026):
 *   trip cost = truck operating (CV-Parc norms) + driver & helper salary for the trip days
 *               + allowance + handling + route tolls (axle-scaled)
 *   carrier estimate   = trip cost + 18%
 *   shipper indicative = carrier estimate × 1.05
 *
 * Offline: the CV-Parc norms come from test/fixtures (migration 0018 verbatim).
 * Run: npx tsx test/trip-estimate.unit.mts
 */
process.env.NODE_ENV = 'test'
delete process.env.DIESEL_PRICE_INR
delete process.env.CARRIER_RETURN_PCT
delete process.env.MARKET_CORRECTION_FACTOR

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const te = await import('../src/lib/trip-estimate.js')
  const engine = await import('../src/lib/cost-engine.js')
  const { CV_PARC_NORMS, CV_PARC_SERVICE_CURVE, FLEET_COST_SETTINGS_DEFAULT } = await import('./fixtures/cv-parc-norms.js')
  engine.__resetCostEngineCaches()
  engine.__loadCostEngineFixtures({ norms: CV_PARC_NORMS, serviceCurve: CV_PARC_SERVICE_CURVE, prices: FLEET_COST_SETTINGS_DEFAULT })

  console.log('\n── an HCV (25-31T), 1000 km, 20 t general, on its own norms ──')
  const { estimate: e, floor } = await te.resolveTripEstimate({ distance_km: 1000, weight_kg: 20_000, load_type: 'general', model_category: 'HCV Cargo 25-31T', emission_norm: 'bs6', truck_age: 3 })
  check('built on the truck\'s CV-Parc norms', e.operating_basis === 'cv_parc_norms' && floor !== null)
  check('operating = the floor\'s fuel, DEF, lubricants, service and tyres', e.operating.fuel === floor!.fuel && e.operating.def === floor!.def && e.operating.lubricants === floor!.lubricants && e.operating.maintenance === floor!.service && e.operating.tyres === floor!.tyres)
  check('operating total is the sum of its lines', e.operating.total === e.operating.fuel + e.operating.def + e.operating.lubricants + e.operating.maintenance + e.operating.tyres)
  check('tyres are IN the trip cost (they are a real per-km operating cost)', e.operating.tyres > 0)
  check('1000 km at 300 km/day → 4 trip days', e.trip_days === 4)
  check('driver salary = 4 days × ₹35,000 / 26 = ₹5,385', e.crew.driver_salary === 5385, String(e.crew.driver_salary))
  check('helper salary = 4 days × ₹20,000 / 26 = ₹3,077', e.crew.helper_salary === 3077 && e.crew.has_helper, String(e.crew.helper_salary))
  check('allowance = 4 days × ₹320', e.crew.allowance === 1280, String(e.crew.allowance))
  check('crew total = driver + helper + allowance', e.crew.total === 5385 + 3077 + 1280)
  check('handling = 20 t × ₹30 (general)', e.handling === 600, String(e.handling))
  check('no route toll given → class rate, HCV ₹1.80/km = ₹1,800', e.tolls.amount === 1800 && e.tolls.basis === 'class_rate')
  check('trip cost = operating + crew + handling + tolls', e.trip_cost === e.operating.total + e.crew.total + e.handling + e.tolls.amount)
  check('carrier return = 18% of trip cost', e.carrier_return === Math.round(e.trip_cost * 0.18) && e.carrier_return_pct === 18)
  check('carrier estimate = trip cost + return', e.carrier_estimate === e.trip_cost + e.carrier_return)
  check('shipper indicative = carrier estimate × 1.05', e.shipper_indicative === Math.round(e.carrier_estimate * 1.05) && e.market_correction === 1.05)
  check('market correction amount = the difference', e.market_correction_amount === e.shipper_indicative - e.carrier_estimate)
  console.log(`    trip cost ₹${e.trip_cost} → carrier ₹${e.carrier_estimate} → shipper ₹${e.shipper_indicative} (₹${(e.shipper_indicative / 1000).toFixed(2)}/km)`)

  console.log('\n── driver-only trucks carry no helper ──')
  const scv = (await te.resolveTripEstimate({ distance_km: 300, weight_kg: 800, load_type: 'general', model_category: 'SCV Cargo' })).estimate
  check('SCV: helper salary 0, driver for 1 day', scv.crew.helper_salary === 0 && !scv.crew.has_helper && scv.crew.driver_salary === Math.round(35000 / 26))
  const icv = (await te.resolveTripEstimate({ distance_km: 300, weight_kg: 7000, load_type: 'general', model_category: 'ICV Cargo (Upto 14T)' })).estimate
  check('ICV is crewed (driver + helper), as in the cost workbook', icv.crew.has_helper && icv.crew.helper_salary > 0)

  console.log('\n── tolls on the route, at the truck\'s axle rate ──')
  const base = { distance_km: 1000, weight_kg: 20_000, load_type: 'general', floor: null }
  const priced = (cat: string, car: number) => te.buildTripEstimate({ ...base, model_category: cat, route_toll: { status: 'priced', car_toll_inr: car } }).tolls
  check('3-axle HCV pays 2.40/0.65 of a car (₹1000 → ₹3692)', priced('HCV Cargo 25-31T', 1000).amount === 3692 && priced('HCV Cargo 25-31T', 1000).basis === 'route')
  check('multi-axle 42-48T pays 3.45/0.65 (₹1000 → ₹5308)', priced('HCV Cargo 42-48T', 1000).amount === 5308)
  check('2-axle MCV pays 2.20/0.65 (₹1000 → ₹3385)', priced('MCV Cargo (15-19T)', 1000).amount === 3385)
  check('LCV/SCV pay the LCV rate 1.05/0.65 (₹1000 → ₹1615)', priced('LCV (4-7 T)', 1000).amount === 1615 && priced('SCV Cargo', 1000).amount === 1615)
  check('the car toll is kept for the record', priced('HCV Cargo 25-31T', 1000).car_toll_inr === 1000)
  const none = te.buildTripEstimate({ ...base, model_category: 'HCV Cargo 25-31T', route_toll: { status: 'none' } }).tolls
  check('a route with no tolls costs ₹0 (from the route, not the class average)', none.amount === 0 && none.basis === 'route')
  const unknown = te.buildTripEstimate({ ...base, model_category: 'HCV Cargo 25-31T', route_toll: { status: 'unknown' } }).tolls
  check('tolls of unknown price fall back to the class rate', unknown.amount === 1800 && unknown.basis === 'class_rate')
  const withToll = te.buildTripEstimate({ ...base, model_category: 'HCV Cargo 25-31T', route_toll: { status: 'priced', car_toll_inr: 1000 } })
  const noToll = te.buildTripEstimate({ ...base, model_category: 'HCV Cargo 25-31T', route_toll: { status: 'none' } })
  check('route tolls flow into every downstream number', withToll.trip_cost - noToll.trip_cost === 3692 && withToll.shipper_indicative > noToll.shipper_indicative)

  console.log('\n── the truck changes the estimate ──')
  const bs4old = (await te.resolveTripEstimate({ distance_km: 1000, weight_kg: 20_000, load_type: 'general', model_category: 'HCV Cargo 25-31T', emission_norm: 'bs4', truck_age: 9 })).estimate
  check('an old BS4 truck costs more to run than a 3-year BS6 (service curve + mileage)', bs4old.operating.total !== e.operating.total, `${bs4old.operating.total} vs ${e.operating.total}`)
  const big = (await te.resolveTripEstimate({ distance_km: 1000, weight_kg: 20_000, load_type: 'general', model_category: 'HCV Cargo 42-48T' })).estimate
  check('a 42-48T trailer costs more than a 25-31T on the same trip', big.trip_cost > e.trip_cost)
  check('no truck named → the typical truck for the weight (20 t → HCV 25-31T)', (await te.resolveTripEstimate({ distance_km: 1000, weight_kg: 20_000, load_type: 'general' })).estimate.model_category === 'HCV Cargo 25-31T')
  check('…12 t → MCV, 5 t → LCV, 1 t → SCV', te.categoryForWeightKg(12_000) === 'MCV Cargo (15-19T)' && te.categoryForWeightKg(5_000) === 'LCV (4-7 T)' && te.categoryForWeightKg(1_000) === 'SCV Cargo')
  const fragile = (await te.resolveTripEstimate({ distance_km: 1000, weight_kg: 20_000, load_type: 'fragile', model_category: 'HCV Cargo 25-31T', emission_norm: 'bs6', truck_age: 3 })).estimate
  check('fragile handling is ₹300/t (20 t → ₹6,000)', fragile.handling === 6000)

  console.log('\n── norm tables unavailable → class typicals, same structure ──')
  engine.__resetCostEngineCaches()
  process.env.SUPABASE_URL = 'http://127.0.0.1:9' // nothing listens: the norm read fails fast
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'
  let logged = false
  const fb = (await te.resolveTripEstimate({ distance_km: 700, weight_kg: 20_000, load_type: 'general', model_category: 'HCV Cargo 25-31T' }, () => { logged = true })).estimate
  check('degrades instead of failing, and reports the error', fb.operating_basis === 'class_typicals' && logged)
  check('class-typical fuel = 700 / 3.5 × ₹90', fb.operating.fuel === 18000, String(fb.operating.fuel))
  check('…maintenance from the class per-km (HCV ₹8/km)', fb.operating.maintenance === 5600)
  check('…and the same crew/handling/toll/return structure', fb.crew.driver_salary === Math.round(3 * 35000 / 26) && fb.handling === 600 && fb.tolls.amount === 1260 && fb.carrier_estimate === fb.trip_cost + Math.round(fb.trip_cost * 0.18))

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
