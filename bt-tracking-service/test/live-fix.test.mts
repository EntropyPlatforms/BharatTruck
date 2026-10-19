/**
 * Live-fix booking scoping (review F26).
 *
 * loc:driver:{id} is one key per DRIVER, but a driver can hold two concurrent active trips. Each
 * fix records its booking, so a booking-scoped read must drop a fix from the driver's OTHER trip —
 * otherwise a shipper tracking booking A sees the truck's position/ETA from trip B, off A's route.
 * A legacy fix with no booking_id is not filtered (single-trip behaviour is unchanged).
 *
 * Pure, no Redis. Run: npx tsx test/live-fix.test.mts
 */
import { fixMatchesBooking, liveFixForBooking } from '../src/lib/live-fix.js'
import type { LiveLocation } from '../src/lib/types.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const A = 'booking-a', B = 'booking-b'
const fix = (booking_id: string | null): LiveLocation => ({
  driver_id: 'd', lat: 19.07, lng: 72.87, heading: null, speed_kmh: null, accuracy_m: null,
  booking_id, updated_at: '2026-08-14T00:00:00.000Z',
})

console.log('\n── fixMatchesBooking')
check("a fix pushed for THIS booking matches", fixMatchesBooking(fix(A), A) === true)
check("🔴 a fix pushed for ANOTHER booking does NOT match (F26)", fixMatchesBooking(fix(B), A) === false)
check("a legacy fix with no booking_id matches (backward-compatible)", fixMatchesBooking(fix(null), A) === true)

console.log('\n── liveFixForBooking (parse + scope)')
check("returns the fix for this booking", liveFixForBooking(A, JSON.stringify(fix(A)))?.booking_id === A)
check("🔴 drops a fix for another booking -> null (F26)", liveFixForBooking(A, JSON.stringify(fix(B))) === null)
check("null raw -> null", liveFixForBooking(A, null) === null)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
