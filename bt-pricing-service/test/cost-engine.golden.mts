/**
 * cost-engine golden test — the REAL CV-Parc cost floor against the founder
 * pricing workbook (BharatTruck_Test_Dataset.xlsx, sheet "Test Dataset").
 *
 * The engine loads its norms from supabase in production; here __loadCostEngineFixtures
 * seeds the migration-0018 rows (test/fixtures/cv-parc-norms.ts) so the run is
 * offline and deterministic. Each row asserts Fuel + Crew to the RUPEE (they are
 * driven purely by seeded norms + the calibrated crew model) and Total Direct
 * within ±3% (toll/allowance carry route-instance variance a general engine
 * cannot reproduce exactly — see docs/tasks/feat-pricing-engine.md).
 *
 * Run: npx tsx test/cost-engine.golden.mts   (or: npm test)
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

// The ±3% tolerance the founder set for Total Direct.
const TOL = 0.03

// 15 workbook rows spanning all 9 mapped categories, ages 2 & 5, clean
// (no monsoon/harvest/urgent), General handling. wb_* are the workbook's own
// COST BREAKDOWN / PROFITABILITY columns.
type Row = {
  id: string; model_category: string; distance_km: number; truck_age: number
  diesel_price_inr: number; weight_kg: number; load_type: string
  wb_fuel: number; wb_crew: number; wb_total_direct: number; wb_floor: number
}
const ROWS: Row[] = [
  { id: 'Q4396', model_category: 'SCV Cargo', distance_km: 337, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 800, load_type: 'general', wb_fuel: 2129, wb_crew: 2692, wb_total_direct: 6665, wb_floor: 7132 },
  { id: 'Q4397', model_category: 'SCV Cargo', distance_km: 337, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 700, load_type: 'general', wb_fuel: 2129, wb_crew: 2692, wb_total_direct: 6747, wb_floor: 7220 },
  { id: 'Q4324', model_category: 'LCV (4-7 T)', distance_km: 551, truck_age: 2, diesel_price_inr: 90.35, weight_kg: 3600, load_type: 'general', wb_fuel: 6810, wb_crew: 2692, wb_total_direct: 12027, wb_floor: 12869 },
  { id: 'Q4325', model_category: 'LCV (4-7 T)', distance_km: 551, truck_age: 5, diesel_price_inr: 90.35, weight_kg: 2900, load_type: 'general', wb_fuel: 6810, wb_crew: 2692, wb_total_direct: 11880, wb_floor: 12712 },
  { id: 'Q3045', model_category: 'ICV Cargo (Upto 14T)', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 7200, load_type: 'general', wb_fuel: 21744, wb_crew: 10577, wb_total_direct: 39751, wb_floor: 42534 },
  { id: 'Q3046', model_category: 'ICV Cargo (Upto 14T)', distance_km: 1437, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 5900, load_type: 'general', wb_fuel: 21744, wb_crew: 10577, wb_total_direct: 39035, wb_floor: 41768 },
  { id: 'Q3056', model_category: 'MCV Cargo (15-19T)', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 9600, load_type: 'general', wb_fuel: 27202, wb_crew: 10577, wb_total_direct: 47483, wb_floor: 50808 },
  { id: 'Q3057', model_category: 'MCV Cargo (15-19T)', distance_km: 1437, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 7800, load_type: 'general', wb_fuel: 27202, wb_crew: 10577, wb_total_direct: 46480, wb_floor: 49734 },
  // ANCHOR — Q3001, Mumbai → Delhi.
  { id: 'Q3001', model_category: 'HCV Cargo 25-31T', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 16800, load_type: 'general', wb_fuel: 33614, wb_crew: 10577, wb_total_direct: 53887, wb_floor: 57660 },
  { id: 'Q3002', model_category: 'HCV Cargo 25-31T', distance_km: 1437, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 13700, load_type: 'general', wb_fuel: 33614, wb_crew: 10577, wb_total_direct: 52873, wb_floor: 56575 },
  { id: 'Q3012', model_category: 'HCV Cargo 35-40T', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 21600, load_type: 'general', wb_fuel: 42070, wb_crew: 10577, wb_total_direct: 62875, wb_floor: 67277 },
  { id: 'Q3013', model_category: 'HCV Cargo 35-40T', distance_km: 1437, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 17600, load_type: 'general', wb_fuel: 42070, wb_crew: 10577, wb_total_direct: 61834, wb_floor: 66163 },
  { id: 'Q3023', model_category: 'HCV Cargo 42-48T', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 26400, load_type: 'general', wb_fuel: 40317, wb_crew: 10577, wb_total_direct: 61264, wb_floor: 65552 },
  { id: 'Q3024', model_category: 'HCV Cargo 42-48T', distance_km: 1437, truck_age: 5, diesel_price_inr: 94.27, weight_kg: 21400, load_type: 'general', wb_fuel: 40317, wb_crew: 10577, wb_total_direct: 60193, wb_floor: 64407 },
  { id: 'Q3034', model_category: 'HCV Cargo 49-55T', distance_km: 1437, truck_age: 2, diesel_price_inr: 94.27, weight_kg: 32000, load_type: 'general', wb_fuel: 53333, wb_crew: 10577, wb_total_direct: 74895, wb_floor: 80139 },
]

async function main() {
  const {
    __loadCostEngineFixtures, __resetCostEngineCaches, resolveCostFloor,
    computeCostBreakdown, resolveModelCategory, VEHICLE_TYPE_TO_MODEL_CATEGORY,
  } = await import('../src/lib/cost-engine.js')
  const { CV_PARC_NORMS, CV_PARC_SERVICE_CURVE, FLEET_COST_SETTINGS_DEFAULT } =
    await import('./fixtures/cv-parc-norms.js')

  __resetCostEngineCaches()
  __loadCostEngineFixtures({
    norms: CV_PARC_NORMS,
    serviceCurve: CV_PARC_SERVICE_CURVE,
    prices: FLEET_COST_SETTINGS_DEFAULT,
  })

  console.log('\n── 15 workbook rows: Fuel & Crew to the rupee, Total Direct within ±3% ──')
  let worst = 0
  for (const r of ROWS) {
    const b = await resolveCostFloor({
      model_category: r.model_category,
      distance_km: r.distance_km,
      weight_kg: r.weight_kg,
      load_type: r.load_type,
      truck_age: r.truck_age,
      diesel_price_inr: r.diesel_price_inr,
    })
    check(`${r.id} fuel=${r.wb_fuel} (to the rupee)`, b.fuel === r.wb_fuel, `(got ${b.fuel})`)
    check(`${r.id} crew=${r.wb_crew} (to the rupee)`, b.crew === r.wb_crew, `(got ${b.crew})`)
    const err = Math.abs(b.total_direct - r.wb_total_direct) / r.wb_total_direct
    worst = Math.max(worst, err)
    check(`${r.id} total_direct ${b.total_direct} within ±3% of ${r.wb_total_direct} (${(err * 100).toFixed(2)}%)`, err <= TOL)
    // running never includes tyres (workbook Running definition), but the tyre
    // line is still computed for the future market/quote layers.
    check(`${r.id} running excludes tyres`, b.running === b.fuel + b.def + b.engine_oil + b.gear_oil + b.service + b.crew && b.tyres > 0)
    // floor is round(total_direct × 1.07), to the rupee.
    check(`${r.id} floor = round(total_direct × 1.07)`, b.floor === Math.round(b.total_direct * 1.07), `(got ${b.floor})`)
  }
  console.log(`\n  worst Total-Direct error across the 15 rows: ${(worst * 100).toFixed(2)}%`)

  console.log('\n── the anchor (Q3001) reproduces the sheet ──')
  const anchor = await resolveCostFloor({
    model_category: 'HCV Cargo 25-31T', distance_km: 1437, weight_kg: 16800,
    load_type: 'general', truck_age: 2, diesel_price_inr: 94.27,
  })
  // Fuel = 1437/4.03 × 94.27 = 33614; Crew = ceil(1437/300)=5 × (55000/26) = 10577.
  check('anchor fuel = 33614 (to the rupee)', anchor.fuel === 33614, `(got ${anchor.fuel})`)
  check('anchor crew = 10577 (to the rupee)', anchor.crew === 10577, `(got ${anchor.crew})`)
  check('anchor service = 3723 (age-2 MHCV curve, to the rupee)', anchor.service === 3723, `(got ${anchor.service})`)
  check('anchor handling = 504 (16.8 t × ₹30/t General, to the rupee)', anchor.handling === 504, `(got ${anchor.handling})`)
  check('anchor trip_days = 5', anchor.trip_days === 5, `(got ${anchor.trip_days})`)
  check('anchor floor = round(total_direct × 1.07) to the rupee', anchor.floor === Math.round(anchor.total_direct * 1.07), `(got ${anchor.floor})`)
  check('anchor floor within ±3% of the sheet floor 57660', Math.abs(anchor.floor - 57660) / 57660 <= TOL, `(got ${anchor.floor})`)
  check('anchor total_direct within ±3% of the sheet 53887', Math.abs(anchor.total_direct - 53887) / 53887 <= TOL, `(got ${anchor.total_direct})`)

  console.log('\n── diesel move flows straight into fuel ──')
  const cheap = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1000, weight_kg: 20000, load_type: 'general', truck_age: 2, diesel_price_inr: 80 })
  const dear = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1000, weight_kg: 20000, load_type: 'general', truck_age: 2, diesel_price_inr: 100 })
  check('higher diesel → higher fuel and floor', dear.fuel > cheap.fuel && dear.floor > cheap.floor, `(${cheap.fuel}/${cheap.floor} → ${dear.fuel}/${dear.floor})`)

  console.log('\n── service cost is age-tiered, not flat ──')
  const young = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1437, weight_kg: 16800, load_type: 'general', truck_age: 1, diesel_price_inr: 94.27 })
  const old = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1437, weight_kg: 16800, load_type: 'general', truck_age: 3, diesel_price_inr: 94.27 })
  // age 3 (₹209,098/yr) peaks well above age 1 (₹108,313/yr).
  check('age-3 service > age-1 service (non-linear curve)', old.service > young.service, `(${young.service} → ${old.service})`)

  console.log('\n── handling scales by load_type per tonne ──')
  const gen = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1000, weight_kg: 10000, load_type: 'general', truck_age: 2 })
  const frag = await resolveCostFloor({ model_category: 'HCV Cargo 25-31T', distance_km: 1000, weight_kg: 10000, load_type: 'fragile', truck_age: 2 })
  check('general handling = 10 t × ₹30 = 300', gen.handling === 300, `(got ${gen.handling})`)
  check('fragile handling = 10 t × ₹300 = 3000', frag.handling === 3000, `(got ${frag.handling})`)

  console.log('\n── legacy vehicle_type → model_category resolver ──')
  check('mini_truck → SCV Cargo', resolveModelCategory({ vehicle_type: 'mini_truck' }) === 'SCV Cargo')
  check('lcv → LCV (4-7 T)', resolveModelCategory({ vehicle_type: 'lcv' }) === 'LCV (4-7 T)')
  check('hcv → HCV Cargo 25-31T', resolveModelCategory({ vehicle_type: 'hcv' }) === 'HCV Cargo 25-31T')
  check('trailer → HCV Cargo 42-48T', resolveModelCategory({ vehicle_type: 'trailer' }) === 'HCV Cargo 42-48T')
  check('explicit model_category overrides vehicle_type', resolveModelCategory({ vehicle_type: 'hcv', model_category: 'MCV Cargo (15-19T)' }) === 'MCV Cargo (15-19T)')
  check('the 4 legacy types all map to a seeded category',
    (['mini_truck', 'lcv', 'hcv', 'trailer'] as const).every(v => CV_PARC_NORMS.some(n => n.model_category === VEHICLE_TYPE_TO_MODEL_CATEGORY[v])))

  console.log('\n── a legacy vehicle_type quote resolves the real floor ──')
  const legacy = await resolveCostFloor({ vehicle_type: 'hcv', distance_km: 1437, weight_kg: 16800, load_type: 'general', truck_age: 2, diesel_price_inr: 94.27 })
  check('vehicle_type hcv gives the same floor as model_category HCV Cargo 25-31T', legacy.floor === anchor.floor, `(${legacy.floor} vs ${anchor.floor})`)

  console.log('\n── pure computeCostBreakdown guards a zero-distance trip ──')
  let threw = false
  try {
    computeCostBreakdown({
      distance_km: 0, weight_tons: 1, load_type: 'general', norms: CV_PARC_NORMS[0],
      service_annual_cost_inr: 24376, prices: FLEET_COST_SETTINGS_DEFAULT,
      emission_norm: 'bs6', crew_monthly_inr: 35000, allowance_per_day_inr: 440, toll_per_km: 1.2,
    })
  } catch { threw = true }
  check('zero-distance trip is rejected, not divided by zero', threw)

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
