/**
 * bt-fleet-service — scoreRunningCost, the number the dashboard headlines as "Net profit".
 *
 * Locks the all-in definition: surplus = revenue − running − (toll + other) − fixed × months.
 * Tolls and "other" are real cash the owner paid. They stay OUT of running_cost_inr (the
 * modelled, comparable cost of moving the asset) but MUST come off the bottom line. The
 * regression this guards: a fleet that was gross-positive but underwater once its toll bill
 * was counted used to read as covered / green on the dashboard.
 *
 * Run: npx tsx test/running-cost-score.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { scoreRunningCost } = await import('../src/lib/analytics.js')
  type Rows = Parameters<typeof scoreRunningCost>[0]

  // Only the columns the score reads; nothing else on a trip_economics row matters here.
  const trip = (revenue: number, running: number, toll: number | null, other: number | null) =>
    ({ revenue_inr: revenue, running_cost_inr: running, toll_cost_inr: toll, other_cost_inr: other })
  const rows = [trip(50000, 30000, 3000, 500), trip(40000, 28000, 2000, null)] as unknown as Rows
  // Σrevenue 90000 · Σrunning 58000 · gross 32000 · tolls + other 5500

  console.log('\n── surplus nets running cost, tolls & other, AND pro-rated fixed cost ──')
  const s = scoreRunningCost(rows, 20000, 15000, 1)
  check('revenue is summed', s.revenue_inr === 90000, `(got ${s.revenue_inr})`)
  check('running cost is summed and stays MODELLED (no tolls in it)', s.running_cost_inr === 58000, `(got ${s.running_cost_inr})`)
  check('gross margin = revenue − running, before actuals and fixed', s.gross_margin_inr === 32000, `(got ${s.gross_margin_inr})`)
  check('toll_other = Σtoll + Σother, a null counted as 0', s.toll_other_inr === 5500, `(got ${s.toll_other_inr})`)
  check('fixed = monthly fixed × months', s.fixed_cost_inr === 20000, `(got ${s.fixed_cost_inr})`)
  check('emi = monthly EMI × months', s.emi_inr === 15000, `(got ${s.emi_inr})`)
  check('surplus = 90000 − 58000 − 5500 − 20000 = 6500', s.surplus_inr === 6500, `(got ${s.surplus_inr})`)
  check('covered when surplus >= 0', s.covered === true)

  console.log('\n── the regression: gross-positive, but underwater once the toll bill is counted ──')
  const tight = scoreRunningCost(rows, 28000, 20000, 1)
  check('the old formula (revenue − running − fixed) would have said +4000 …',
    tight.gross_margin_inr - tight.fixed_cost_inr === 4000)
  check('… but the all-in surplus is −1500', tight.surplus_inr === -1500, `(got ${tight.surplus_inr})`)
  check('so the asset is NOT covered', tight.covered === false)
  check('the old headline overstated by exactly tolls + other',
    tight.gross_margin_inr - tight.fixed_cost_inr - tight.surplus_inr === tight.toll_other_inr)

  console.log('\n── pro-rating over a longer window ──')
  const two = scoreRunningCost(rows, 20000, 15000, 2)
  check('fixed doubles over 2 months', two.fixed_cost_inr === 40000, `(got ${two.fixed_cost_inr})`)
  check('emi doubles over 2 months', two.emi_inr === 30000, `(got ${two.emi_inr})`)
  check('surplus = 90000 − 58000 − 5500 − 40000 = −13500', two.surplus_inr === -13500, `(got ${two.surplus_inr})`)
  check('tolls are per-trip actuals: NOT scaled by months', two.toll_other_inr === 5500)

  console.log('\n── edge cases ──')
  const none = scoreRunningCost([] as unknown as Rows, 20000, 15000, 1)
  check('no trips: surplus is minus the fixed cost carried', none.surplus_inr === -20000, `(got ${none.surplus_inr})`)
  check('no trips: no tolls', none.toll_other_inr === 0)
  check('no trips but a fixed cost: not covered', none.covered === false)
  const free = scoreRunningCost([] as unknown as Rows, 0, 0, 1)
  check('no trips and nothing owed: surplus 0, covered', free.surplus_inr === 0 && free.covered === true)
  const frac = scoreRunningCost([trip(10000, 5000, 1234.567, 0.004)] as unknown as Rows, 0, 0, 1)
  check('money rounds to paise', frac.toll_other_inr === 1234.57 && frac.surplus_inr === 3765.43,
    `(got ${frac.toll_other_inr}, ${frac.surplus_inr})`)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
