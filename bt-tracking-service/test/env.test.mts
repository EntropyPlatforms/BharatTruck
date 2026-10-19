/**
 * positiveIntEnv — numeric env tunables must not collapse to 0 on an EMPTY value (review F27).
 *
 * The old `Number(process.env.X ?? default)` only substituted the default for null/undefined, so a
 * Cloud Run var set-but-EMPTY became `Number('') === 0`: a zero route-cache TTL 500s /route and
 * /track (Redis rejects `EX 0`), a zero diesel price prints ₹0 fuel, and a zero speed limit flags
 * every moving truck. Pure, no database. Run: npx tsx test/env.test.mts
 */
import { positiveIntEnv } from '../src/lib/env.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const KEY = 'TEST_POSITIVE_INT_ENV'
const set = (v: string | undefined) => { if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v }

console.log('\n── positiveIntEnv')
set(undefined); check('unset -> fallback', positiveIntEnv(KEY, 90) === 90)
set('');        check('🔴 empty string -> fallback, NOT 0 (F27)', positiveIntEnv(KEY, 90) === 90, `(got ${positiveIntEnv(KEY, 90)})`)
set('0');       check('zero -> fallback', positiveIntEnv(KEY, 90) === 90)
set('-5');      check('negative -> fallback', positiveIntEnv(KEY, 90) === 90)
set('abc');     check('non-numeric -> fallback', positiveIntEnv(KEY, 90) === 90)
set('120');     check('a valid positive value is parsed', positiveIntEnv(KEY, 90) === 120)
set('  75  ');  check('surrounding whitespace is tolerated', positiveIntEnv(KEY, 90) === 75, `(got ${positiveIntEnv(KEY, 90)})`)
set(undefined)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
