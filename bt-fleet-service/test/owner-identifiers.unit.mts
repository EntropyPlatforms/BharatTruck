/**
 * fleet_owners.gstin / .pan are validated by FORMAT, not just length (review S-7).
 *
 * The review said GSTIN and PAN lack format validation. On the SHIPPER side that is
 * wrong twice over — bt-auth-service applies a regex and the users_gstin_format CHECK
 * enforces it in Postgres. On the FLEET side it was right: these fields were
 * `.length(15)` and `.length(10)`, which accepts fifteen letters as a GSTIN. (Since the
 * GSTIN check character and the PAN holder-type letter are enforced, the valid samples
 * below carry a real check character and a P-type PAN.)
 *
 * It was not theoretical. Live data carries pan 'ABCDE123FG' on one fleet — exactly ten
 * characters, and not a PAN, because the 6th-9th characters must be digits. That exact
 * string is pinned below as the case the old rule waved through.
 *
 * Run: npx tsx test/owner-identifiers.unit.mts
 */
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'

const { OwnerProfileBody } = await import('../src/routes/owners.js')

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const parse = (patch: Record<string, unknown>) =>
  OwnerProfileBody.safeParse({ company_name: 'Bharat Distributors', ...patch })

const ok = (patch: Record<string, unknown>) => parse(patch).success
const valueOf = (patch: Record<string, unknown>, key: 'gstin' | 'pan') => {
  const r = parse(patch)
  return r.success ? (r.data as Record<string, unknown>)[key] : undefined
}

console.log('\n── the real GSTIN format, matching users_gstin_format')
check('a valid GSTIN is accepted', ok({ gstin: '27ABCPE1234F1ZB' }))
check('15 letters are NOT a GSTIN (the old length-only rule accepted this)',
  ok({ gstin: 'ABCDEFGHIJKLMNO' }) === false)
check('15 digits are not either', ok({ gstin: '123456789012345' }) === false)
check('14 characters is refused', ok({ gstin: '27ABCDE1234F1Z' }) === false)
check('16 characters is refused', ok({ gstin: '27ABCPE1234F1ZB5' }) === false)
check('the state-code prefix must be digits', ok({ gstin: 'AAABCDE1234F1Z5' }) === false)

console.log('\n── the real PAN format')
check('a valid PAN is accepted', ok({ pan: 'ABCPE1234F' }))
// The exact value sitting in production today on 'Joshi Freight Lines'.
check("'ABCDE123FG' is refused — 10 chars, but not a PAN", ok({ pan: 'ABCDE123FG' }) === false)
check('10 digits are not a PAN', ok({ pan: '1234567890' }) === false)
check('9 characters is refused', ok({ pan: 'ABCDE1234' }) === false)
check('11 characters is refused', ok({ pan: 'ABCDE1234FG' }) === false)

console.log('\n── lower case is normalised, not rejected')
// An owner typing their own number in lower case has not made a mistake about the
// number, and an error saying otherwise would send them looking for the wrong problem.
check('a lower-case GSTIN is accepted', ok({ gstin: '27abcpe1234f1zb' }))
check('...and stored upper-case', valueOf({ gstin: '27abcpe1234f1zb' }, 'gstin') === '27ABCPE1234F1ZB',
  String(valueOf({ gstin: '27abcpe1234f1zb' }, 'gstin')))
check('a lower-case PAN is accepted', ok({ pan: 'abcpe1234f' }))
check('...and stored upper-case', valueOf({ pan: 'abcpe1234f' }, 'pan') === 'ABCPE1234F',
  String(valueOf({ pan: 'abcpe1234f' }, 'pan')))
check('surrounding whitespace is still trimmed', valueOf({ gstin: '  27ABCPE1234F1ZB  ' }, 'gstin') === '27ABCPE1234F1ZB')

console.log('\n── both stay OPTIONAL — this is not a new requirement')
// Most fleets in the live data have neither on file. Making these mandatory here would
// lock existing owners out of editing their own profile, which is a different decision
// from validating what they do provide.
check('a profile with neither is valid', ok({}))
check('a profile with only a GSTIN is valid', ok({ gstin: '27ABCPE1234F1ZB' }))
check('a profile with only a PAN is valid', ok({ pan: 'ABCPE1234F' }))

console.log('\n── unrelated fields are untouched')
check('company_name still required', parse({}).success && OwnerProfileBody.safeParse({}).success === false)
check('company_name minimum still applies', OwnerProfileBody.safeParse({ company_name: 'X' }).success === false)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
