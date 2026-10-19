/**
 * bt-fleet-service — the pure input helpers behind the analytics-trust fixes (migration
 * 0034): distance-basis selection, the expense classifier, and state-code normalisation.
 * These are the pieces that decide WHICH number the P&L trusts, so they are unit-tested
 * without a database.
 *
 * Run: npx tsx test/analytics-inputs.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { chooseDistance } = await import('../src/lib/economics.js')
  const { classifyExpense, isExpenseCategoryCode, EXPENSE_CATEGORIES } = await import('@bharattruck/shared/expenses')
  const { gstStateCode } = await import('@bharattruck/shared/india-states')

  console.log('\n── chooseDistance: measured -> routed -> estimated, never fabricated ──')
  check('measured wins over routed and sold',
    JSON.stringify(chooseDistance({ measured: 800, routed: 850, sold: 900 })) === JSON.stringify({ distance_km: 800, basis: 'measured' }))
  check('routed wins when there is no measured trail',
    JSON.stringify(chooseDistance({ measured: null, routed: 850, sold: 900 })) === JSON.stringify({ distance_km: 850, basis: 'routed' }))
  check('sold is the estimated last resort',
    JSON.stringify(chooseDistance({ measured: null, routed: null, sold: 900 })) === JSON.stringify({ distance_km: 900, basis: 'estimated' }))
  check('no signal at all -> null (skip the trip, never invent a distance)',
    chooseDistance({ measured: null, routed: null, sold: null }) === null)
  check('a zero measured is ignored, not chosen',
    chooseDistance({ measured: 0, routed: 850, sold: 900 })?.basis === 'routed')
  check('a negative distance is treated as absent',
    chooseDistance({ measured: -5, routed: null, sold: null }) === null)
  check('the old haversine x 1.3 path is gone: no lock + no routed + no trail = skip',
    chooseDistance({ measured: null, routed: null, sold: null }) === null)

  console.log('\n── classifyExpense: controlled code beats free-text spelling ──')
  check('code fuel -> fuel bucket', classifyExpense('fuel', null) === 'fuel')
  check('code toll -> toll bucket', classifyExpense('toll', null) === 'toll')
  check('code def -> other bucket', classifyExpense('def', null) === 'other')
  check('code tyre -> other bucket', classifyExpense('tyre', null) === 'other')
  check('the code is authoritative over a misleading free text',
    classifyExpense('fuel', 'toll plaza') === 'fuel')
  check('legacy row (no code): "diesel top-up" still reads as fuel',
    classifyExpense(null, 'diesel top-up') === 'fuel')
  check('legacy row (no code): "Toll Plaza" still reads as toll',
    classifyExpense(null, 'Toll Plaza') === 'toll')
  check('legacy row (no code): "dhaba food" is other', classifyExpense(null, 'dhaba food') === 'other')
  check('a misspelled legacy "diseal" is NOT caught (the exact bug the code fixes going forward)',
    classifyExpense(null, 'diseal') === 'other')
  check('but the SAME expense with a code is caught', classifyExpense('fuel', 'diseal') === 'fuel')
  check('empty everything -> other', classifyExpense(null, null) === 'other')
  check('an unknown code falls back to the free text', classifyExpense('bogus', 'fuel filling') === 'fuel')
  check('isExpenseCategoryCode accepts a real code', isExpenseCategoryCode('weighbridge'))
  check('isExpenseCategoryCode rejects junk', !isExpenseCategoryCode('nonsense'))
  check('every category maps to a real bucket',
    EXPENSE_CATEGORIES.every(c => c.bucket === 'fuel' || c.bucket === 'toll' || c.bucket === 'other'))
  check('exactly one category is the fuel bucket (the pilferage signal)',
    EXPENSE_CATEGORIES.filter(c => c.bucket === 'fuel').length === 1)

  console.log('\n── gstStateCode: free-text state -> GST 2-digit code, null when unknown ──')
  check('full name Maharashtra -> 27', gstStateCode('Maharashtra') === '27')
  check('case-insensitive maharashtra -> 27', gstStateCode('maharashtra') === '27')
  check('two-letter MH -> 27', gstStateCode('MH') === '27')
  check('already a GST code 27 -> 27', gstStateCode('27') === '27')
  check('Tamil Nadu -> 33', gstStateCode('Tamil Nadu') === '33')
  check('Karnataka -> 29', gstStateCode('Karnataka') === '29')
  check('Delhi -> 07', gstStateCode('Delhi') === '07')
  check('variant spelling Orissa -> 21', gstStateCode('Orissa') === '21')
  check('Andhra Pradesh -> 37 (current code)', gstStateCode('Andhra Pradesh') === '37')
  check('whitespace is trimmed', gstStateCode('  Gujarat  ') === '24')
  check('an unknown state -> null (falls back to national default)', gstStateCode('Atlantis') === null)
  check('null -> null', gstStateCode(null) === null)
  check('empty string -> null', gstStateCode('') === null)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
