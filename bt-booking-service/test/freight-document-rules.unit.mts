/**
 * Freight-document compliance rules.
 *
 * Every check here pins a provision, not a preference. The failure each one
 * prevents is written next to it, because the cost of getting these wrong is not
 * a bug report:
 *
 *   - a uuid in a document-number field is an INVALID GST document (§3.3), and
 *     the doc calls it out as a common bug in logistics SaaS;
 *   - a prefix that leaves too few serials locks an owner's series for the rest
 *     of the financial year, with no way to renumber or reshape it (Rule 46(b));
 *   - an e-way bill threshold checked on the PRE-TAX value moves a truck without
 *     a bill it needed — a s.129 detention, not a ₹1,000 penalty (§4.1) — and a
 *     threshold answered CONFIDENTLY on an intra-state move is the same failure
 *     wearing a different hat (§4.2);
 *   - a locally recomputed valid_upto tells a driver they are covered while the
 *     bill is already dead (§4.4, the midnight rule).
 *
 * The last section is structural rather than legal: it fails if this module grows
 * an export that production never calls. A rules file whose only caller is its own
 * test reports a large green number while shipping nothing.
 *
 * Pure functions, no Postgres.
 *
 * Run: npx tsx test/freight-document-rules.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import * as rules from '../src/lib/documents/rules.js'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}
function throws(label: string, fn: () => unknown) {
  let threw = false
  try { fn() } catch { threw = true }
  check(label, threw)
}

console.log('\n── Rule 46(b): the document-number format')
{
  // The two shapes real operators print (§11.1 specimens).
  check("accepts the Destinio shape '2026-27/11'", rules.isGstDocumentNumber('2026-27/11'))
  check("accepts the Maru shape 'MA/4135/2526'", rules.isGstDocumentNumber('MA/4135/2526'))
  check('accepts exactly 16 characters', rules.isGstDocumentNumber('ABCD/2026-27/999'))

  // The bugs.
  check(
    'REJECTS a uuid — an invalid GST document number',
    !rules.isGstDocumentNumber('11111111-1111-4111-8111-111111111111'),
  )
  check('REJECTS a 20-character slug', !rules.isGstDocumentNumber('LR20260806ABCDEFGHIJ'))
  check('REJECTS 17 characters', !rules.isGstDocumentNumber('ABCDE/2026-27/999'))
  check('REJECTS characters outside [A-Za-z0-9/-]', !rules.isGstDocumentNumber('INV#11'))
  check('REJECTS an underscore', !rules.isGstDocumentNumber('INV_11'))
  check('REJECTS a space', !rules.isGstDocumentNumber('INV 11'))
  check('REJECTS the empty string', !rules.isGstDocumentNumber(''))
  check('16 is the cap', rules.MAX_GST_DOCUMENT_NUMBER_LENGTH === 16)
}

console.log('\n── the serial budget: a prefix spends digits (§3.3 + Rule 46(b))')
{
  // 🔴 The defect this section pins. A 4-character prefix caps an owner at 999
  // documents for the WHOLE financial year: 'ABCD/2026-27/999' is exactly 16
  // characters and '/1000' is 17. Reaching that is not a soft failure — the
  // series cannot advance past the bad number, cannot be renumbered (Rule 46(b)),
  // and its prefix cannot be shortened because the shape of a series in flight is
  // frozen at its first document. The owner is locked out until 1 April.
  //
  // A fleet issuing 1,000 consignment notes in a year is an ordinary fleet, so
  // the budget — not the prefix's looks — is what has to be constrained.
  check('a 4-char prefix would buy only 999 documents a year', rules.serialBudgetForPrefix('ABCD') === 999)
  check('3 chars, 9,999', rules.serialBudgetForPrefix('ABC') === 9_999)
  check('2 chars, 99,999', rules.serialBudgetForPrefix('MA') === 99_999)
  check('1 char, 999,999', rules.serialBudgetForPrefix('M') === 999_999)
  check('unprefixed, 99,999,999', rules.serialBudgetForPrefix(null) === 99_999_999)
  check('and null and undefined mean the same unprefixed series',
    rules.serialBudgetForPrefix() === rules.serialBudgetForPrefix(null))

  // The arithmetic above, checked against the actual assembled string rather than
  // trusted: the largest legal number for a prefix must be exactly 16 characters,
  // and one more digit must not be.
  const largest = (prefix: string | null) =>
    `${prefix ? `${prefix}/` : ''}2026-27/${rules.serialBudgetForPrefix(prefix)}`
  check("'MA/2026-27/99999' is exactly the Rule 46(b) limit",
    largest('MA').length === 16 && rules.isGstDocumentNumber(largest('MA')))
  check('one serial past the budget no longer fits',
    !rules.isGstDocumentNumber(`MA/2026-27/${rules.serialBudgetForPrefix('MA') + 1}`))
  check("the unprefixed ceiling is 16 characters too", largest(null).length === 16)

  // THE FIX. The cap is derived from the floor, so the two cannot disagree.
  check('a financial year must hold at least 99,999 documents',
    rules.MIN_SERIALS_PER_FINANCIAL_YEAR === 99_999)
  check('which makes 2 characters the longest admissible prefix',
    rules.MAX_SERIES_PREFIX_LENGTH === 2)
  check('every admissible prefix clears the floor',
    rules.serialBudgetForPrefix('x'.repeat(rules.MAX_SERIES_PREFIX_LENGTH)) >= rules.MIN_SERIALS_PER_FINANCIAL_YEAR)
  check('and one character more does not',
    rules.serialBudgetForPrefix('x'.repeat(rules.MAX_SERIES_PREFIX_LENGTH + 1)) < rules.MIN_SERIALS_PER_FINANCIAL_YEAR)

  // The validation a caller actually hits, built from the same number.
  check("the Maru specimen's 'MA' is still accepted", rules.SERIES_PREFIX_PATTERN.test('MA'))
  check('a 4-character prefix is REFUSED at the door — this is the wedge, closed',
    !rules.SERIES_PREFIX_PATTERN.test('ABCD'))
  check('a 3-character prefix is refused too', !rules.SERIES_PREFIX_PATTERN.test('ABC'))
  check('a prefix carrying a slash is refused — the DB owns the separator',
    !rules.SERIES_PREFIX_PATTERN.test('M/'))
  check('the empty prefix is not a prefix', !rules.SERIES_PREFIX_PATTERN.test(''))
}

console.log('\n── weight: actual AND charged (§11.2)')
{
  check('charged falls back to actual when nothing cubes out', rules.chargedWeightKg(9000) === 9000)
  check('charged is the volumetric weight when it is higher', rules.chargedWeightKg(9000, 12500) === 12500)
  check('charged is the actual weight when volumetric is lower', rules.chargedWeightKg(9000, 4000) === 9000)
  check('charged is never below actual', rules.chargedWeightKg(9000, 8999.9) === 9000)
  throws('a non-positive actual weight is refused', () => rules.chargedWeightKg(0))
}

console.log('\n── charge lines sum to a total, never one lump figure (§11.2)')
{
  check(
    'freight + stationary + hamali',
    rules.lrChargeTotalInr({ freightInr: 18000, stationaryInr: 50, handlingInr: 900 }) === 18950,
  )
  check('missing lines are zero, not undefined', rules.lrChargeTotalInr({ freightInr: 18000 }) === 18000)
  check(
    'paise survive the sum',
    rules.lrChargeTotalInr({ freightInr: 0.1, stationaryInr: 0.2 }) === 0.3,
  )
  throws('a negative charge line is refused', () => rules.lrChargeTotalInr({ freightInr: -1 }))
}

console.log('\n── consignment value INCLUDES GST (§4.1, Rule 138 Explanation 2)')
{
  // The worked example from the doc: ₹48,000 + 5% = ₹50,400, which is over the
  // line. A pre-tax check says ₹48,000 and lets the truck leave without a bill.
  const value = rules.consignmentValueInr({ taxableValueInr: 48000, cgstInr: 1200, sgstInr: 1200 })
  check('₹48,000 + 5% GST = ₹50,400', value === 50400)
  check('…and that DOES need an e-way bill', rules.interStateEwayBillRequired(value) === true)
  check(
    'while the pre-tax figure alone would NOT — the bug this prevents',
    rules.interStateEwayBillRequired(48000) === false,
  )

  check('IGST counts the same as CGST+SGST', rules.consignmentValueInr({ taxableValueInr: 48000, igstInr: 2400 }) === 50400)
  check('cess is included', rules.consignmentValueInr({ taxableValueInr: 100, cessInr: 10 }) === 110)
  check(
    'the exempt component is subtracted on a mixed invoice',
    rules.consignmentValueInr({ taxableValueInr: 60000, igstInr: 3000, exemptValueInr: 20000 }) === 43000,
  )
  check('a wholly taxable invoice subtracts nothing', rules.consignmentValueInr({ taxableValueInr: 60000 }) === 60000)

  // Rule 138(1) says "exceeds", so the boundary itself is below the line.
  check('the threshold is ₹50,000', rules.INTER_STATE_EWB_THRESHOLD_INR === 50000)
  check('exactly ₹50,000 does not need one ("exceeds")', rules.interStateEwayBillRequired(50000) === false)
  check('₹50,000.01 does', rules.interStateEwayBillRequired(50000.01) === true)

  check(
    'float noise does not leak into a statutory figure',
    rules.consignmentValueInr({ taxableValueInr: 0.1, igstInr: 0.2 }) === 0.3,
  )
  throws('a negative tax component is refused', () =>
    rules.consignmentValueInr({ taxableValueInr: 100, igstInr: -1 }))
}

console.log('\n── the §9.2 threshold gate refuses to guess')
{
  // The requirement §9.2 lists first — "threshold check on GST-INCLUSIVE
  // consignment value" — as the single answer the issuance path puts in front of
  // a user. The §4.1 worked example, end to end.
  const hubballiToPune = rules.ewayBillRequirement({
    consignmentValueInr: 50400, fromStateCode: '29', toStateCode: '27',
  })
  check('inter-state above the line: an e-way bill IS required', hubballiToPune.required === true)
  check('classified as inter-state', hubballiToPune.movement === 'inter_state')
  check('against the ₹50,000 figure no state may vary', hubballiToPune.threshold_inr === 50000)
  check('and the value it judged is the GST-INCLUSIVE one', hubballiToPune.consignment_value_inr === 50400)

  check('the same movement at ₹48,000 pre-tax would NOT have been flagged',
    rules.ewayBillRequirement({ consignmentValueInr: 48000, fromStateCode: '29', toStateCode: '27' }).required === false)
  check('exactly ₹50,000 does not need one ("exceeds")',
    rules.ewayBillRequirement({ consignmentValueInr: 50000, fromStateCode: '29', toStateCode: '27' }).required === false)

  // 🔴 THE REFUSAL. §4.2's intra-state table is per-state, effective-dated and
  // partly contested (Rajasthan ₹2,00,000 intra-city, MP none intra-district, Goa
  // only for 22 goods). Answering `false` here would read as "no e-way bill
  // needed" on a movement whose real threshold this codebase does not know.
  const intra = rules.ewayBillRequirement({
    consignmentValueInr: 500000, fromStateCode: '29', toStateCode: '29',
  })
  check('intra-state is classified, not answered', intra.movement === 'intra_state' && intra.required === null)
  check('even at ₹5,00,000 — silence, not a confident "no"', intra.required !== false)
  check('no national threshold is asserted for it', intra.threshold_inr === null)
  check('and the reason points the user at the state rule', /state/i.test(intra.reason))

  const unknown = rules.ewayBillRequirement({ consignmentValueInr: 200000, fromStateCode: '29' })
  check('one end missing is "unknown", never "not required"',
    unknown.movement === 'unknown' && unknown.required === null)
  check('with a reason that says what is missing', /state code|GSTIN/i.test(unknown.reason))

  // The GSTIN's first two digits ARE the state code, which is how a movement gets
  // classified without asking the user for the state a second time.
  check('a state code is read off a GSTIN', rules.stateCodeOfGstin('29AABCV3609C1ZJ') === '29')
  check('a non-GSTIN yields nothing rather than a wrong state', rules.stateCodeOfGstin('NOTAGSTIN') === null)
  check('and so does a missing one', rules.stateCodeOfGstin(null) === null)
}

console.log('\n── every export earns its place')
{
  // 🔴 The structural check that would have caught an entire module of dead code.
  //
  // A helper whose only caller is this file inflates the pass count while
  // exercising nothing that ships, which is worse than having no code at all —
  // the green number says the opposite of the truth. Four helpers and a constant
  // in this module were once in exactly that state while ~118 checks reported on
  // them.
  //
  // "Used" means REACHABLE FROM PRODUCTION, not merely mentioned: an export is
  // live if some other file under src/ names it, or if a live export of this
  // module names it. A pair of dead helpers calling each other does not count.
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')

  const rulesPath = new URL('../src/lib/documents/rules.ts', import.meta.url).pathname
  const rulesSrc = readFileSync(rulesPath, 'utf8')

  const otherSrc: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (p.endsWith('.ts') && p !== rulesPath) otherSrc.push(readFileSync(p, 'utf8'))
    }
  }
  walk(new URL('../src', import.meta.url).pathname)
  const outside = otherSrc.join('\n')

  // Carve rules.ts into one chunk per export so "X is referenced by Y" can be
  // attributed to the right Y instead of to the file as a whole.
  const decl = /export\s+(?:const|function|type)\s+(\w+)/g
  const chunks: Array<{ name: string; start: number }> = []
  for (let m = decl.exec(rulesSrc); m; m = decl.exec(rulesSrc)) {
    chunks.push({ name: m[1], start: m.index })
  }
  const bodyOf = new Map<string, string>()
  chunks.forEach((c, i) => {
    bodyOf.set(c.name, rulesSrc.slice(c.start, chunks[i + 1]?.start ?? rulesSrc.length))
  })

  const runtimeExports = Object.keys(rules)
  const live = new Set(runtimeExports.filter(n => new RegExp(`\\b${n}\\b`).test(outside)))

  // Fixpoint: anything a live export mentions is itself live.
  for (let grew = true; grew;) {
    grew = false
    for (const liveName of [...live]) {
      const body = bodyOf.get(liveName) ?? ''
      for (const candidate of runtimeExports) {
        if (!live.has(candidate) && new RegExp(`\\b${candidate}\\b`).test(body)) {
          live.add(candidate)
          grew = true
        }
      }
    }
  }

  const orphans = runtimeExports.filter(n => !live.has(n))
  check(
    `all ${runtimeExports.length} runtime exports are reachable from production code`,
    orphans.length === 0,
  )
  if (orphans.length) console.log(`      orphaned: ${orphans.join(', ')}`)

  // And the specific requirement that was unwired: §9.2's threshold gate has to
  // be CALLED from the issuance path, not merely exist next to it.
  const serviceSrc = readFileSync(
    new URL('../src/lib/documents/service.ts', import.meta.url).pathname, 'utf8')
  check('the §4.1 threshold gate is called from the invoice issuance path',
    /ewayBillRequirement\s*\(/.test(serviceSrc) && /export async function issueFreightInvoice/.test(serviceSrc))
  // FB-03 refinement: pickup gate consults the same helper (fail closed when null).
  check('the pickup hard-gate consults ewayBillRequirement (not always-require)',
    /export async function assertPickupDocumentsReady/.test(serviceSrc) &&
    /ewayBillRequirement\s*\(/.test(serviceSrc.slice(serviceSrc.indexOf('assertPickupDocumentsReady'))))
}

console.log('\n── e-way bill expiry: STORED, never derived (§4.4)')
{
  const now = new Date('2026-08-06T10:00:00Z')
  const inHours = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString()

  check('a bill 10 days out is simply valid', rules.ewayBillExpiry(inHours(240), now).state === 'valid')
  check('the alert window is 4 days (§9.3)', rules.EWB_EXPIRY_ALERT_WINDOW_DAYS === 4)
  check('3 days out is expiring soon', rules.ewayBillExpiry(inHours(72), now).state === 'expiring_soon')
  check('exactly 4 days out is already inside the window', rules.ewayBillExpiry(inHours(96), now).state === 'expiring_soon')
  check('4 days and an hour out is not', rules.ewayBillExpiry(inHours(97), now).state === 'valid')
  check('the instant validity passes it is expired — no grace at a checkpoint',
    rules.ewayBillExpiry(inHours(0), now).state === 'expired')
  check('an hour past is expired', rules.ewayBillExpiry(inHours(-1), now).state === 'expired')
  check('an expired bill reports 0 hours left, never a negative countdown',
    rules.ewayBillExpiry(inHours(-5), now).hours_remaining === 0)
  check('hours remaining rounds DOWN, so it never over-promises',
    rules.ewayBillExpiry(inHours(3.9), now).hours_remaining === 3)
  check('the deadline is echoed back unchanged',
    rules.ewayBillExpiry(inHours(48), now).valid_upto === inHours(48))
  throws('an unparseable valid_upto is refused rather than treated as expired', () =>
    rules.ewayBillExpiry('not-a-date', now))

  // The structural pin for D-17 / §4.4: this module must not grow a function
  // that DERIVES a validity deadline. The midnight rule (a "day" ends at
  // midnight of the day FOLLOWING generation) makes any local computation wrong
  // by up to a full day in the direction that gets a driver detained.
  const exported = Object.keys(rules)
  check(
    'no exported helper computes a valid_upto',
    !exported.some(k => /valid.?upto|validity|expiry.?date/i.test(k) && /compute|derive|calc/i.test(k)),
  )
  check(
    'nothing in this module is named to suggest deriving validity',
    !exported.some(k => /^(compute|derive|calculate)/i.test(k)),
  )
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
