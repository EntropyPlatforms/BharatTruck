/**
 * bt-fleet-service — every dashboard KPI, pinned against hand-computed fixtures.
 *
 * The pure half of analytics.ts (computeUtilization, analyseVehicle, computeFleetSummary,
 * computeDriverAnalytics, computeFuelComparison, the period helpers) is exercised WITHOUT a
 * database, in the style of economics.test.mts. Every expected value below was worked by hand
 * from the fixture — if a number here moves, a formula moved.
 *
 * The period is EXACTLY one pro-rating month (30.4375 days = 365.25/12), so `months` is 1.0
 * and the fixed-cost figures are whole rupees rather than 0.9856× fractions.
 *
 * Run: npx tsx test/analytics-kpis.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const near = (a: number | null, b: number, eps = 0.011) => a !== null && Math.abs(a - b) < eps

async function main() {
  const {
    resolvePeriod, daysInPeriod, monthsInPeriod, computeUtilization, monthlyFixedForVehicle,
    analyseVehicle, computeFleetSummary, computeDriverAnalytics, computeFuelComparison, costBreakdown,
  } = await import('../src/lib/analytics.js')
  type Rows = Parameters<typeof computeUtilization>[0]
  type Row = Rows[number]

  // ── the period: 2026-08-01 00:00 → 2026-08-31 10:30 UTC = 30.4375 days = exactly 1 month ──
  const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T10:30:00.000Z' }

  console.log('\n── period helpers ──')
  check('30 days + 10.5 h = 30.4375 days', daysInPeriod(period) === 30.4375, `(got ${daysInPeriod(period)})`)
  check('… which is exactly 1.0 pro-rating month (365.25 / 12)', monthsInPeriod(period) === 1)
  const now = new Date('2026-09-27T00:00:00.000Z')
  const dflt = resolvePeriod(undefined, undefined, now)
  check('default window ends now', dflt.to === now.toISOString())
  check('default window starts 30 days earlier', dflt.from === '2026-08-28T00:00:00.000Z', `(got ${dflt.from})`)
  check('a 30-day window is 0.9856 months, not 1 (EMI is pro-rated by days)', near(monthsInPeriod(dflt), 0.985626, 1e-5))
  check('a zero-length window still counts as 1 day (no divide-by-zero)', daysInPeriod({ from: dflt.to, to: dflt.to }) === 1)
  check('explicit from/to are honoured verbatim', resolvePeriod(period.from, period.to, now).from === period.from)

  // ── the fixture: one HCV with three trips, one idle SCV ──
  // Every component column sums to running_cost_inr, so breakdown and score agree by construction.
  const trip = (o: Partial<Row>): Row => ({
    booking_id: 'b', fleet_owner_id: 'f', vehicle_id: 'v1', driver_id: 'd1',
    revenue_inr: 0, fuel_cost_est_inr: 0, def_cost_est_inr: 0, engine_oil_cost_inr: 0, gear_oil_cost_inr: 0,
    service_cost_inr: 0, tyre_cost_inr: 0, driver_wage_alloc_inr: 0, fuel_cost_actual_inr: null,
    toll_cost_inr: 0, other_cost_inr: 0, running_cost_inr: 0, net_profit_inr: 0,
    distance_km_quoted: null, distance_km_actual: null, distance_km_planned: null, distance_basis: null,
    laden_weight_kg: null, capacity_kg: null, volume_used_cuft: null, capacity_cuft: null,
    started_at: null, completed_at: '2026-08-10T00:00:00.000Z', model_version: 'fleet-pnl-v1', computed_at: '2026-08-10T00:00:00.000Z',
    ...o,
  } as unknown as Row)

  const T1 = trip({ booking_id: 't1', driver_id: 'd1', revenue_inr: 50000, running_cost_inr: 30000, net_profit_inr: 20000,
    fuel_cost_est_inr: 20000, def_cost_est_inr: 1000, engine_oil_cost_inr: 100, gear_oil_cost_inr: 30, service_cost_inr: 2000, tyre_cost_inr: 1600, driver_wage_alloc_inr: 5270,
    fuel_cost_actual_inr: 22000, toll_cost_inr: 3000, other_cost_inr: 500,
    distance_km_actual: 800, distance_km_planned: 780, distance_km_quoted: 750, distance_basis: 'measured',
    laden_weight_kg: 20000, capacity_kg: 28000, volume_used_cuft: 1200, capacity_cuft: 2048 })
  const T2 = trip({ booking_id: 't2', driver_id: 'd1', revenue_inr: 40000, running_cost_inr: 28000, net_profit_inr: 12000,
    fuel_cost_est_inr: 18000, def_cost_est_inr: 900, engine_oil_cost_inr: 90, gear_oil_cost_inr: 25, service_cost_inr: 1800, tyre_cost_inr: 1400, driver_wage_alloc_inr: 5785,
    fuel_cost_actual_inr: null, toll_cost_inr: 2000, other_cost_inr: 0,
    distance_km_planned: 700, distance_km_quoted: 650, distance_basis: 'routed',
    laden_weight_kg: 18000, capacity_kg: 28000, volume_used_cuft: null, capacity_cuft: 2048 })
  // A pre-0034 row: no stored basis, only the sold distance — basis must be inferred.
  const T3 = trip({ booking_id: 't3', driver_id: 'd2', revenue_inr: 30000, running_cost_inr: 20000, net_profit_inr: 10000,
    fuel_cost_est_inr: 12000, def_cost_est_inr: 600, engine_oil_cost_inr: 60, gear_oil_cost_inr: 20, service_cost_inr: 1200, tyre_cost_inr: 1000, driver_wage_alloc_inr: 5120,
    fuel_cost_actual_inr: 11000, toll_cost_inr: 0, other_cost_inr: 200,
    distance_km_quoted: 500, distance_basis: null,
    laden_weight_kg: 15000, capacity_kg: 28000, volume_used_cuft: null, capacity_cuft: 2048 })
  const rows = [T1, T2, T3]

  const norms = new Map([['HCV Cargo 25-31T', { kms_per_year: 72000 }], ['SCV Cargo', { kms_per_year: 24000 }]])
  const v1 = { id: 'v1', rc_number: 'MH12AB1234', model_category: 'HCV Cargo 25-31T', emission_norm: 'BS6' }
  const v2 = { id: 'v2', rc_number: 'MH12CD5678', model_category: 'SCV Cargo', emission_norm: 'BS6' }
  const finance = new Map([
    ['v1', { emi_amount_inr: 50000, insurance_annual_inr: 24000, permit_annual_inr: 12000, fitness_annual_inr: 6000 }],
    ['v2', { emi_amount_inr: 30000, insurance_annual_inr: 0, permit_annual_inr: 0, fitness_annual_inr: 0 }],
  ])
  const owner = { monthly_overhead_inr: 4000 } // two trucks → ₹2,000 each per month
  // Expected km: 72000/365 × 30.4375 = 6004.1096 (v1); 24000/365 × 30.4375 = 2001.3699 (v2)
  const EXP_V1 = 6004.109589, EXP_V2 = 2001.369863

  console.log('\n── computeUtilization: paired ratios, basis inference, sample sizes ──')
  const u = computeUtilization(rows, EXP_V1)
  check('tonnage = 53000 / 84000 = 63.1% over all 3 trips (weight always declared)', u.tonnage_pct === 63.1 && u.tonnage_trips === 3, `(got ${u.tonnage_pct}, n=${u.tonnage_trips})`)
  check('volume = 1200 / 2048 = 58.59% over the ONE trip that declared a volume', u.volume_pct === 58.59 && u.volume_trips === 1, `(got ${u.volume_pct}, n=${u.volume_trips})`)
  check('the paired sums are what the UI shows: 1200 used of 2048 offered, not of 6144', u.volume_used_cuft === 1200 && u.capacity_cuft === 2048)
  check('distance sums every basis: 800 measured + 700 routed + 500 estimated = 2000', u.distance_km === 2000 && u.distance_basis_km.measured === 800 && u.distance_basis_km.routed === 700 && u.distance_basis_km.estimated === 500)
  check('a legacy row with no stored basis is classed by which column it has (quoted → estimated)', u.distance_basis_km.estimated === 500)
  check('measured_distance_pct = (800 + 700) / 2000 = 75%', u.measured_distance_pct === 75)
  check('distance_pct = 2000 / 6004.11 = 33.31%', near(u.distance_pct, 33.31), `(got ${u.distance_pct})`)
  check('expected_distance_km is rounded to paise-style 2dp', u.expected_distance_km === 6004.11)

  const noVolume = computeUtilization([T2, T3], EXP_V1)
  check('REGRESSION: no trip declared a volume → volume_pct is null (unknown), NOT 0%', noVolume.volume_pct === null && noVolume.volume_trips === 0, `(got ${noVolume.volume_pct})`)
  check('… while tonnage still reads from the two declared weights: 33000 / 56000 = 58.93%', near(noVolume.tonnage_pct, 58.93), `(got ${noVolume.tonnage_pct})`)
  const noCap = computeUtilization([trip({ laden_weight_kg: 10000, capacity_kg: null }), T1], EXP_V1)
  check('a trip whose truck has no recorded capacity is left out of tonnage, not counted as 0 capacity', noCap.tonnage_trips === 1 && noCap.laden_weight_kg === 20000)
  const empty = computeUtilization([], EXP_V1)
  check('no trips: ratios null, distance 0, distance_pct 0% of expected (an idle truck IS 0% worked)', empty.tonnage_pct === null && empty.volume_pct === null && empty.distance_km === 0 && empty.distance_pct === 0 && empty.measured_distance_pct === null)
  check('no expected km (unknown category) → distance_pct null, never a divide', computeUtilization(rows, null).distance_pct === null)
  const inferred = computeUtilization([trip({ distance_km_actual: 100, distance_km_planned: 90, distance_basis: null }), trip({ distance_km_planned: 90, distance_basis: null })], null)
  check('legacy inference prefers actual (measured) over planned (routed) when both exist', inferred.distance_basis_km.measured === 100 && inferred.distance_basis_km.routed === 90)

  console.log('\n── monthlyFixedForVehicle ──')
  const f1 = monthlyFixedForVehicle(finance.get('v1'), 2000)
  check('EMI 50000 + annuals 42000/12 + overhead share 2000 = 55500 per month', f1.total === 55500 && f1.emi === 50000, `(got ${f1.total})`)
  check('no finance row: only the overhead share is carried', monthlyFixedForVehicle(undefined, 2000).total === 2000)

  console.log('\n── analyseVehicle: the per-truck P&L row ──')
  const a1 = analyseVehicle(v1, rows, norms, finance.get('v1'), 2000, 1, 30.4375)
  check('revenue 120000, running 78000, gross margin 42000', a1.score.revenue_inr === 120000 && a1.score.running_cost_inr === 78000 && a1.score.gross_margin_inr === 42000)
  check('tolls + other = 5000 + 700 = 5700', a1.score.toll_other_inr === 5700)
  check('fixed = 55500 × 1 month; EMI = 50000', a1.score.fixed_cost_inr === 55500 && a1.score.emi_inr === 50000)
  check('surplus = 120000 − 78000 − 5700 − 55500 = −19200 → not covered', a1.score.surplus_inr === -19200 && a1.score.covered === false, `(got ${a1.score.surplus_inr})`)
  check('net_profit_inr (Σ per-trip contribution) = 42000 = gross margin', a1.net_profit_inr === 42000)
  check('cost/km = 78000 / 2000 = 39; revenue/km = 60', a1.cost_per_km_inr === 39 && a1.revenue_per_km_inr === 60)
  check('3 trips is a low sample', a1.trips === 3 && a1.low_sample === true)
  const bd = a1.cost_breakdown_inr
  check('breakdown sums each line: fuel 50000, DEF 2500, oils 250/75, service 5000, tyres 4000, wage 16175, toll 5000, other 700',
    bd.fuel === 50000 && bd.def === 2500 && bd.engine_oil === 250 && bd.gear_oil === 75 && bd.service === 5000 && bd.tyres === 4000 && bd.driver_wage === 16175 && bd.toll === 5000 && bd.other === 700)
  check('breakdown lines re-add to the running cost the score used (no line double-counted or missing)',
    bd.fuel + bd.def + bd.engine_oil + bd.gear_oil + bd.service + bd.tyres + bd.driver_wage === a1.score.running_cost_inr)
  check('utilisation on the row is the paired version (volume from 1 trip)', a1.utilization.volume_trips === 1 && a1.utilization.tonnage_trips === 3)
  const a2 = analyseVehicle(v2, [], norms, finance.get('v2'), 2000, 1, 30.4375)
  check('idle truck: surplus = −(30000 + 2000) = −32000, not covered, no per-km figures, not low-sample', a2.score.surplus_inr === -32000 && a2.score.covered === false && a2.cost_per_km_inr === null && a2.low_sample === false)
  check('idle truck: expected 2001.37 km, 0% of it driven', a2.utilization.expected_distance_km === 2001.37 && a2.utilization.distance_pct === 0)
  const aNoNorm = analyseVehicle({ ...v1, model_category: 'Unknown' }, rows, norms, finance.get('v1'), 2000, 1, 30.4375)
  check('unknown category: expected km null → distance_pct null (never fabricated)', aNoNorm.utilization.expected_distance_km === null && aNoNorm.utilization.distance_pct === null)

  console.log('\n── computeFleetSummary: the six dashboard numbers ──')
  const s = computeFleetSummary({ owner, period, rows, vehicles: [v1, v2], norms, finance })
  check('trips 3 (low sample), active_vehicles 2, overhead 4000', s.trips === 3 && s.low_sample === true && s.active_vehicles === 2 && s.monthly_overhead_inr === 4000)
  check('fleet fixed = 55500 + 32000 = 87500; EMI = 80000', s.score.fixed_cost_inr === 87500 && s.score.emi_inr === 80000)
  check('overhead is counted ONCE across the fleet (2 × 2000 = 4000, not 8000)', s.score.fixed_cost_inr - 50000 - 30000 - 3500 === 4000)
  check('fleet surplus = 120000 − 78000 − 5700 − 87500 = −51200 → not covered', s.score.surplus_inr === -51200 && s.score.covered === false, `(got ${s.score.surplus_inr})`)
  check('vehicles_covering_emi = 0 (v1 short, v2 idle)', s.vehicles_covering_emi === 0)
  check('expected km sums each truck\'s own norm: 6004.11 + 2001.37 = 8005.48', s.utilization.expected_distance_km === 8005.48, `(got ${s.utilization.expected_distance_km})`)
  check('fleet distance_pct = 2000 / 8005.48 = 24.98%', near(s.utilization.distance_pct, 24.98), `(got ${s.utilization.distance_pct})`)
  check('fleet net_profit_inr = 42000 = gross margin (it is NOT the headline; surplus is)', s.net_profit_inr === 42000 && s.net_profit_inr === s.score.gross_margin_inr)
  check('fleet breakdown = same lines as the truck (only truck with trips)', JSON.stringify(s.cost_breakdown_inr) === JSON.stringify(costBreakdown(rows)))

  // Push T1's revenue up: v1 clears everything, v2 stays idle.
  const richer = [trip({ ...T1, revenue_inr: 150000, net_profit_inr: 120000 }), T2, T3]
  const s2 = computeFleetSummary({ owner, period, rows: richer, vehicles: [v1, v2], norms, finance })
  check('with 220000 revenue: v1 surplus 220000−78000−5700−55500 = 80800 → covering_emi = 1 of 2', s2.vehicles_covering_emi === 1)
  check('fleet surplus 220000−78000−5700−87500 = 48800 → covered', s2.score.surplus_inr === 48800 && s2.score.covered === true)
  const s0 = computeFleetSummary({ owner, period, rows: [], vehicles: [], norms, finance: new Map() })
  check('no trucks at all: expected km null, ratios null, surplus 0, nothing covering', s0.utilization.expected_distance_km === null && s0.utilization.tonnage_pct === null && s0.score.surplus_inr === 0 && s0.vehicles_covering_emi === 0)

  console.log('\n── computeDriverAnalytics: the leaderboard ──')
  const ids = new Map([['d1', { full_name: 'Ramesh', phone_number: '9999999999' }]])
  const d = computeDriverAnalytics(rows, ids)
  check('two drivers, ranked by net profit: d1 (32000) above d2 (10000)', d.length === 2 && d[0].driver_id === 'd1' && d[0].net_profit_inr === 32000 && d[1].net_profit_inr === 10000)
  check('d1: 1500 km, revenue 90000, running 58000, wage 11055, 21.33/km', d[0].distance_km === 1500 && d[0].revenue_inr === 90000 && d[0].running_cost_inr === 58000 && d[0].wage_allocated_inr === 11055 && d[0].net_profit_per_km_inr === 21.33)
  check('d2: 500 km, 20/km, identity unknown → nulls, low sample', d[1].net_profit_per_km_inr === 20 && d[1].full_name === null && d[1].phone_number === null && d[1].low_sample === true)
  check('d1 identity hydrated', d[0].full_name === 'Ramesh' && d[0].phone_number === '9999999999')
  check('driver net profit is the contribution (excl. tolls/other): 32000, not 32000 − 5500', d[0].net_profit_inr === 32000)
  check('a row with no driver is dropped, not credited to anyone', computeDriverAnalytics([trip({ driver_id: null as unknown as string, revenue_inr: 1 })], ids).length === 0)

  console.log('\n── computeFuelComparison: modelled vs filled ──')
  const fRows = [
    trip({ booking_id: 'a', vehicle_id: 'v1', fuel_cost_est_inr: 20000, fuel_cost_actual_inr: 22000 }),
    trip({ booking_id: 'b', vehicle_id: 'v2', fuel_cost_est_inr: 10000, fuel_cost_actual_inr: 9000 }),
    trip({ booking_id: 'c', vehicle_id: 'v1', fuel_cost_est_inr: 15000, fuel_cost_actual_inr: null }),
  ]
  const fc = computeFuelComparison(period, fRows, new Map([['v1', 'MH12AB1234']]))
  check('only trips WITH an actual are compared: 2 of 3', fc.trips_with_actuals === 2 && fc.trips === 3)
  check('estimated 30000 vs actual 31000 → +1000, +3.33% (over-consumption reads positive)', fc.estimated_inr === 30000 && fc.actual_inr === 31000 && fc.variance_inr === 1000 && fc.variance_pct === 3.33, `(got ${fc.variance_pct})`)
  check('the trip without a receipt does not drag the estimate up (15000 excluded)', fc.estimated_inr === 30000)
  check('per-vehicle, worst variance first: v1 +2000 (+10%), then v2 −1000 (−10%)', fc.by_vehicle[0].vehicle_id === 'v1' && fc.by_vehicle[0].variance_inr === 2000 && fc.by_vehicle[0].variance_pct === 10 && fc.by_vehicle[1].variance_inr === -1000 && fc.by_vehicle[1].variance_pct === -10)
  check('an RC we cannot resolve renders empty, not undefined', fc.by_vehicle[0].rc_number === 'MH12AB1234' && fc.by_vehicle[1].rc_number === '')
  const fNone = computeFuelComparison(period, [fRows[2]], new Map())
  check('no actuals at all: zero totals, variance_pct null (no divide), nothing per vehicle', fNone.estimated_inr === 0 && fNone.variance_pct === null && fNone.by_vehicle.length === 0)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
