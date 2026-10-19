/**
 * bt-fleet-service — the P&L model against the SEEDED cost norms.
 *
 * The norm rows below are copied verbatim from supabase/migrations/
 * 0018_vehicle_cost_norms.sql, and the service-cost figures from
 * vehicle_service_cost_by_age, so this test fails if either the formula or the
 * seed drifts from the founder's CV parc workbook.
 *
 * Run: npm test   (or: npx tsx test/economics.test.mts)
 */
import type { CostNorms, ConsumablePrices } from '../src/lib/economics.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

// --- seeded reference data (migration 0018) --------------------------------

const HCV_25_31: CostNorms = {
  model_category: 'HCV Cargo 25-31T', super_category: 'MHCV Cargo', vehicle_class: 'HCV',
  kms_per_year: 72000, payload_tons_typical: 28, volume_cuft_typical: 2048,
  kmpl_bs6: 4.03, kmpl_bs4: 4.13, def_pct_bs6: 0.0464, def_pct_bs4: 0.0315,
  eng_oil_km_bs6ph2: 120000, eng_oil_km_bs6: 120000, eng_oil_km_bs4: 80000, eng_oil_km_old: 40000,
  eng_oil_l_bs6ph2: 24.5, eng_oil_l_bs6: 24.5, eng_oil_l_bs4: 21.5, eng_oil_l_old: 20.1,
  gear_oil_km_bs6ph2: 160000, gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_km_old: 100000,
  gear_oil_l_bs6ph2: 9.75, gear_oil_l_bs6: 9.75, gear_oil_l_bs4: 7.8, gear_oil_l_old: 7.56,
  wage_weight: 2.0, tyre_cost_per_km: 2.0,
}

const MCV_15_19: CostNorms = {
  model_category: 'MCV Cargo (15-19T)', super_category: 'MHCV Cargo', vehicle_class: 'MCV',
  kms_per_year: 66000, payload_tons_typical: 17, volume_cuft_typical: 1500,
  kmpl_bs6: 4.98, kmpl_bs4: 5.0, def_pct_bs6: 0.0508, def_pct_bs4: 0.0197,
  eng_oil_km_bs6ph2: 120000, eng_oil_km_bs6: 80000, eng_oil_km_bs4: 60000, eng_oil_km_old: 40000,
  eng_oil_l_bs6ph2: 22.5, eng_oil_l_bs6: 22.5, eng_oil_l_bs4: 20.0, eng_oil_l_old: 19.8,
  gear_oil_km_bs6ph2: 160000, gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_km_old: 100000,
  gear_oil_l_bs6ph2: 9.6, gear_oil_l_bs6: 9.6, gear_oil_l_bs4: 7.8, gear_oil_l_old: 7.6,
  wage_weight: 1.6, tyre_cost_per_km: 1.4,
}

// kmpl_bs4 is NULL on the light categories — the pre-BS4 fallback must survive it.
const SCV_CARGO: CostNorms = {
  model_category: 'SCV Cargo', super_category: 'SCV Cargo', vehicle_class: 'SCV',
  kms_per_year: 24000, payload_tons_typical: 1.5, volume_cuft_typical: 300,
  kmpl_bs6: 14.92, kmpl_bs4: null, def_pct_bs6: 0.0346, def_pct_bs4: 0,
  eng_oil_km_bs6ph2: 20000, eng_oil_km_bs6: 20000, eng_oil_km_bs4: 10000, eng_oil_km_old: 10000,
  eng_oil_l_bs6ph2: 4.5, eng_oil_l_bs6: 4.5, eng_oil_l_bs4: 3.0, eng_oil_l_old: 2.2,
  gear_oil_km_bs6ph2: 120000, gear_oil_km_bs6: 120000, gear_oil_km_bs4: 80000, gear_oil_km_old: 40000,
  gear_oil_l_bs6ph2: 2.4, gear_oil_l_bs6: 2.4, gear_oil_l_bs4: 1.3, gear_oil_l_old: 1.3,
  wage_weight: 1.0, tyre_cost_per_km: 0.35,
}

// fleet_cost_settings defaults.
const PRICES: ConsumablePrices = {
  diesel_price_inr: 90, def_price_inr: 45, engine_oil_price_inr: 420, gear_oil_price_inr: 390,
}

// vehicle_service_cost_by_age
const MHCV_AGE_3 = 209098
const MHCV_AGE_1 = 108313
const SCV_AGE_10 = 27376

async function main() {
  const {
    allocateDriverWage, computeTripEconomics, dieselLitres, mileageKmpl, vehicleAgeYears,
  } = await import('../src/lib/economics.js')

  console.log('\n── HCV Cargo 25-31T, BS6, 1000 km (fully worked example) ──')
  // litres = 1000/4.03 = 248.138958
  //   fuel    = 248.138958 * 90                     = 22332.51
  //   def     = 248.138958 * 0.0464 * 45            =   518.11
  //   eng oil = 1000/120000 * 24.50 * 420           =    85.75
  //   gear oil= 1000/160000 *  9.75 * 390           =    23.77
  //   service = 209098 / 72000 * 1000               =  2904.14
  //   tyres   = 1000 * 2.00                         =  2000.00
  //   wage                                          = 20000.00
  const hcv = computeTripEconomics({
    distance_km: 1000, revenue_inr: 60000, norms: HCV_25_31, prices: PRICES,
    emission_norm: 'BS6', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 20000,
  })
  check('HCV/BS6 fuel_cost_est_inr=22332.51', hcv.fuel_cost_est_inr === 22332.51, `(got ${hcv.fuel_cost_est_inr})`)
  check('HCV/BS6 def_cost_est_inr=518.11', hcv.def_cost_est_inr === 518.11, `(got ${hcv.def_cost_est_inr})`)
  check('HCV/BS6 engine_oil_cost_inr=85.75', hcv.engine_oil_cost_inr === 85.75, `(got ${hcv.engine_oil_cost_inr})`)
  check('HCV/BS6 gear_oil_cost_inr=23.77', hcv.gear_oil_cost_inr === 23.77, `(got ${hcv.gear_oil_cost_inr})`)
  check('HCV/BS6 service_cost_inr=2904.14', hcv.service_cost_inr === 2904.14, `(got ${hcv.service_cost_inr})`)
  check('HCV/BS6 tyre_cost_inr=2000', hcv.tyre_cost_inr === 2000, `(got ${hcv.tyre_cost_inr})`)
  check('HCV/BS6 running_cost_inr=47864.27', hcv.running_cost_inr === 47864.27, `(got ${hcv.running_cost_inr})`)
  check('HCV/BS6 net_profit_inr=12135.73', hcv.net_profit_inr === 12135.73, `(got ${hcv.net_profit_inr})`)
  check('HCV/BS6 running cost ~= 47.86/km (market floor is ~45/km)',
    Math.abs(hcv.running_cost_inr / 1000 - 47.86) < 0.01)

  console.log('\n── service cost is age-dependent, not flat per km ──')
  const youngTruck = computeTripEconomics({
    distance_km: 1000, revenue_inr: 60000, norms: HCV_25_31, prices: PRICES,
    emission_norm: 'BS6', service_annual_cost_inr: MHCV_AGE_1, driver_wage_alloc_inr: 20000,
  })
  check('age 1 service_cost_inr=1504.35', youngTruck.service_cost_inr === 1504.35, `(got ${youngTruck.service_cost_inr})`)
  check('age 3 costs ~1.93x age 1 in service',
    Math.abs(hcv.service_cost_inr / youngTruck.service_cost_inr - 1.93) < 0.01)

  console.log('\n── emission norm selects the consumable columns ──')
  // MCV engine-oil interval differs between BS6_PH2 (120000 km) and BS6 (80000 km).
  const mcvPh2 = computeTripEconomics({
    distance_km: 1000, revenue_inr: 0, norms: MCV_15_19, prices: PRICES,
    emission_norm: 'BS6_PH2', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 0,
  })
  const mcvBs6 = computeTripEconomics({
    distance_km: 1000, revenue_inr: 0, norms: MCV_15_19, prices: PRICES,
    emission_norm: 'BS6', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 0,
  })
  check('MCV BS6_PH2 engine_oil=78.75 (120000 km interval)', mcvPh2.engine_oil_cost_inr === 78.75, `(got ${mcvPh2.engine_oil_cost_inr})`)
  check('MCV BS6 engine_oil=118.13 (80000 km interval)', mcvBs6.engine_oil_cost_inr === 118.13, `(got ${mcvBs6.engine_oil_cost_inr})`)
  check('BS6_PH2 reads the BS6 mileage column (4.98)', mileageKmpl(MCV_15_19, 'BS6_PH2') === 4.98)
  check('BS4 reads its own mileage column (5.00)', mileageKmpl(MCV_15_19, 'BS4') === 5.0)

  const mcvBs4 = computeTripEconomics({
    distance_km: 1000, revenue_inr: 0, norms: MCV_15_19, prices: PRICES,
    emission_norm: 'BS4', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 0,
  })
  // 1000/5.00 = 200 L; def = 200 * 0.0197 * 45 = 177.30
  check('MCV BS4 def_cost_est_inr=177.30', mcvBs4.def_cost_est_inr === 177.3, `(got ${mcvBs4.def_cost_est_inr})`)
  check('BS4 burns less DEF than BS6 per km', mcvBs4.def_cost_est_inr < mcvBs6.def_cost_est_inr)

  console.log('\n── pre-BS4 (null norm) falls back to the *_old columns ──')
  // SCV Cargo has kmpl_bs4 = NULL, so a pre-BS4 truck must fall back to kmpl_bs6.
  const scvOld = computeTripEconomics({
    distance_km: 500, revenue_inr: 0, norms: SCV_CARGO, prices: PRICES,
    emission_norm: null, service_annual_cost_inr: SCV_AGE_10, driver_wage_alloc_inr: 0,
  })
  check('pre-BS4 SCV falls back to kmpl_bs6 (14.92)', mileageKmpl(SCV_CARGO, null) === 14.92)
  check('pre-BS4 SCV fuel=3016.09', scvOld.fuel_cost_est_inr === 3016.09, `(got ${scvOld.fuel_cost_est_inr})`)
  check('pre-BS4 SCV burns no DEF', scvOld.def_cost_est_inr === 0, `(got ${scvOld.def_cost_est_inr})`)
  check('pre-BS4 SCV engine_oil=46.2 (10000 km / 2.2 L)', scvOld.engine_oil_cost_inr === 46.2, `(got ${scvOld.engine_oil_cost_inr})`)
  check('pre-BS4 SCV gear_oil=6.34 (40000 km / 1.3 L)', scvOld.gear_oil_cost_inr === 6.34, `(got ${scvOld.gear_oil_cost_inr})`)
  check('pre-BS4 SCV service=570.33', scvOld.service_cost_inr === 570.33, `(got ${scvOld.service_cost_inr})`)
  check('pre-BS4 SCV running_cost=3813.96', scvOld.running_cost_inr === 3813.96, `(got ${scvOld.running_cost_inr})`)
  check('zero revenue makes net_profit the negative of running cost', scvOld.net_profit_inr === -3813.96, `(got ${scvOld.net_profit_inr})`)

  console.log('\n── actuals are recorded but excluded from running_cost ──')
  const withActuals = computeTripEconomics({
    distance_km: 1000, revenue_inr: 60000, norms: HCV_25_31, prices: PRICES,
    emission_norm: 'BS6', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 20000,
    fuel_cost_actual_inr: 24000, toll_cost_inr: 3200, other_cost_inr: 500,
  })
  check('actual fuel is stored', withActuals.fuel_cost_actual_inr === 24000)
  check('toll is stored', withActuals.toll_cost_inr === 3200)
  check('running_cost is unchanged by actuals', withActuals.running_cost_inr === hcv.running_cost_inr)
  check('fuel_cost_actual_inr stays null when no receipt exists', hcv.fuel_cost_actual_inr === null)

  console.log('\n── diesel litres ──')
  check('1000 km at 4.03 kmpl = 248.14 L', Math.abs(dieselLitres(1000, HCV_25_31, 'BS6') - 248.1389578) < 1e-6)

  console.log('\n── vehicle age clamps to the 1..10 service curve ──')
  const now = new Date('2026-07-26T00:00:00Z')
  check('2023 truck in 2026 is age 3', vehicleAgeYears(2023, now) === 3)
  check('2026 truck is clamped up to age 1', vehicleAgeYears(2026, now) === 1)
  check('2005 truck is clamped down to age 10', vehicleAgeYears(2005, now) === 10)
  check('missing manufacture year is treated as age 1', vehicleAgeYears(null, now) === 1)

  console.log('\n── driver wage allocation (Q18: km x wage_weight) ──')
  // 30000 salary over 1000 km on an HCV (weight 2.0) and 1000 km on an SCV (1.0):
  // weighted 2000 : 1000 -> 20000 / 10000.
  const alloc = allocateDriverWage(30000, [
    { booking_id: 'hcv-trip', distance_km: 1000, wage_weight: 2.0 },
    { booking_id: 'scv-trip', distance_km: 1000, wage_weight: 1.0 },
  ])
  check('heavier truck carries 20000 of the salary', alloc.get('hcv-trip') === 20000, `(got ${alloc.get('hcv-trip')})`)
  check('lighter truck carries 10000 of the salary', alloc.get('scv-trip') === 10000, `(got ${alloc.get('scv-trip')})`)
  check('the month sums to exactly one monthly salary',
    (alloc.get('hcv-trip')! + alloc.get('scv-trip')!) === 30000)

  const idleMonth = allocateDriverWage(30000, [{ booking_id: 'no-km', distance_km: 0, wage_weight: 2.0 }])
  check('a zero-km month allocates nothing per trip', idleMonth.get('no-km') === 0)
  const unpaid = allocateDriverWage(0, [{ booking_id: 't', distance_km: 500, wage_weight: 1 }])
  check('no recorded salary allocates nothing', unpaid.get('t') === 0)

  console.log('\n── revenue under a D-7 fleet↔driver split ──')
  // The truck's P&L is the FLEET OWNER's book. Before D-7 the whole freight was
  // the owner's, because the bidder was the only payee and `payouts` held one
  // row per booking. bt-payment-service now writes one row PER PAYEE, and the
  // read here used maybeSingle() — which answers PGRST116 on two rows rather
  // than returning either. resolveRevenue threw, rollUpTripEconomics threw, and
  // emitTripEconomics is fire-and-forget, so every split fleet settlement lost
  // its trip_economics row to a warning log.
  const { fleetOwnerRevenue } = await import('../src/lib/economics.js')
  const booking = { id: 'b-1', quoted_price: 5500, final_price: 6000 } as any
  check('no payout rows yet -> the booking price (unchanged pre-D-7 fallback)',
    fleetOwnerRevenue([], booking) === 6000, `(got ${fleetOwnerRevenue([], booking)})`)
  check('salaried fleet trip -> the whole freight, exactly as before',
    fleetOwnerRevenue([{ amount: 6000, payee_type: 'fleet_owner' }], booking) === 6000)
  check('a 30% split books the OWNER\'s share, not the whole freight',
    fleetOwnerRevenue([
      { amount: 4200, payee_type: 'fleet_owner' },
      { amount: 1800, payee_type: 'driver' },
    ], booking) === 4200, `(got ${fleetOwnerRevenue([{ amount: 4200, payee_type: 'fleet_owner' }, { amount: 1800, payee_type: 'driver' }], booking)})`)
  // share = 100 leaves no owner row at all. That is a real zero — the owner
  // passed the freight straight through — and must NOT fall back to the booking
  // price, which would book revenue the owner never received.
  check('share = 100 -> zero owner revenue, not the booking price',
    fleetOwnerRevenue([{ amount: 6000, payee_type: 'driver' }], booking) === 0,
    `(got ${fleetOwnerRevenue([{ amount: 6000, payee_type: 'driver' }], booking)})`)
  // A solo-driver booking never reaches here (rollUpTripEconomics returns early
  // without a fleet_owner_id), but a row written before migration 0016 carries
  // no payee_type and is the driver's by that column's own default.
  check('a pre-0016 row without payee_type is not counted as the owner\'s',
    fleetOwnerRevenue([{ amount: 6000 }], booking) === 0)
  check('the split rows still sum to the settlement (owner + driver)',
    fleetOwnerRevenue([{ amount: 4200, payee_type: 'fleet_owner' }, { amount: 1800, payee_type: 'driver' }], booking)
    + 1800 === 6000)

  console.log('\n── guards ──')
  let threw = false
  try {
    computeTripEconomics({
      distance_km: 0, revenue_inr: 0, norms: HCV_25_31, prices: PRICES,
      emission_norm: 'BS6', service_annual_cost_inr: MHCV_AGE_3, driver_wage_alloc_inr: 0,
    })
  } catch { threw = true }
  check('a zero-distance trip is rejected, not divided by zero', threw)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
