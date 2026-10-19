/**
 * Driver-invite lookup normalization (review F23/F24).
 *
 * F23: bt-auth-service stores a mobile as bare 10 digits (verify-otp inserts phone_number from
 *      /^[6-9]\d{9}$/), but the invite form sends E.164 (+91…) and owners paste numbers in every
 *      shape. An exact `.eq` on the raw input 404'd real accounts. toCanonicalPhone must fold every
 *      spelling of one number onto the stored bare-10 form.
 * F24: findDriverByEmail used `.ilike(raw)`, so an underscore in a real email is a LIKE wildcard —
 *      escapeLikePattern must make %/_ literal for a case-insensitive EXACT match.
 *
 * Pure functions, no database. Run: npx tsx test/driver-lookup.unit.mts
 */
import { toCanonicalPhone, escapeLikePattern } from '../src/lib/fleet-repo.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

console.log('\n── F23: every spelling of one mobile folds onto the stored bare-10 form')
check('bare 10-digit passes through', toCanonicalPhone('9876543210') === '9876543210')
check('E.164 +91 prefix stripped', toCanonicalPhone('+919876543210') === '9876543210')
check('91 country code stripped', toCanonicalPhone('919876543210') === '9876543210')
check('domestic 0 trunk prefix stripped', toCanonicalPhone('09876543210') === '9876543210')
check('spaces and dashes ignored', toCanonicalPhone('+91 98765-43210') === '9876543210',
  `(got ${toCanonicalPhone('+91 98765-43210')})`)
check('a short/landline number is rejected', toCanonicalPhone('0224567890') === null)
check('a number starting below 6 is rejected', toCanonicalPhone('5876543210') === null)
check('a 9-digit number is rejected', toCanonicalPhone('987654321') === null)
check('an 11-digit number without a 0 trunk is rejected', toCanonicalPhone('99876543210') === null,
  `(got ${toCanonicalPhone('99876543210')})`)

console.log('\n── F24: ILIKE metacharacters are escaped so the match is exact, not a pattern')
check('underscore is escaped to a literal', escapeLikePattern('ravi_kumar@gmail.com') === 'ravi\\_kumar@gmail.com',
  `(got ${escapeLikePattern('ravi_kumar@gmail.com')})`)
check('percent is escaped', escapeLikePattern('a%b@x.com') === 'a\\%b@x.com')
check('a backslash is escaped first (not doubled by later rules)', escapeLikePattern('a\\b@x.com') === 'a\\\\b@x.com',
  `(got ${escapeLikePattern('a\\b@x.com')})`)
check('a plain email is unchanged', escapeLikePattern('ravikumar@gmail.com') === 'ravikumar@gmail.com')

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
