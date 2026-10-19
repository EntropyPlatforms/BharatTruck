/**
 * pickup_date is compared against today IN INDIA, not in UTC (review S-1).
 *
 * THE BUG THIS PINS is invisible for 18.5 hours a day, which is why it survived: the
 * old check anchored "today" at UTC midnight, so between 00:00 and 05:30 IST — while
 * UTC is still on the previous calendar day — a pickup date of YESTERDAY (in India,
 * where every shipper using this actually is) passed validation. Any test written at a
 * normal working hour agrees with both the old code and the new one, so the clock has
 * to be stubbed to see the difference at all.
 *
 * Run: npx tsx test/pickup-date.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

const { CreateBookingBodySchema, istToday } = await import('../src/lib/types.js')

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

/** Run `fn` with Date.now() frozen at an instant. */
function at<T>(iso: string, fn: () => T): T {
  const real = Date.now
  Date.now = () => new Date(iso).getTime()
  try { return fn() } finally { Date.now = real }
}

/** Validate just the pickup_date rule, with every other required field satisfied. */
function accepts(pickup_date: string): boolean {
  return CreateBookingBodySchema.safeParse({
    source_address: 'Mumbai',
    destination_address: 'Raipur',
    source_lat: 19.076, source_lng: 72.877,
    dest_lat: 21.251, dest_lng: 81.629,
    load_type: 'general',
    weight_kg: 12000,
    vehicle_type: 'lcv',
    pickup_date,
    booking_type: 'auction',
    // The server-locked price quote this booking is posted against — required, and
    // unrelated to the rule under test, but the schema is parsed as a whole.
    quote_id: '11111111-1111-4111-8111-111111111111',
    consignee: { name: 'Receiver', phone: '9876543210' },
  }).success
}

// 00:30 IST on 15 Aug 2026 is 19:00 UTC on 14 Aug 2026 — the window where the two
// calendars disagree, and the whole reason this file exists.
const IST_EARLY_MORNING = '2026-08-14T19:00:00Z'

console.log('\n── the IST/UTC window: 00:30 IST on the 15th, still the 14th in UTC')
at(IST_EARLY_MORNING, () => {
  check('istToday() reports the INDIAN date, not the UTC one', istToday() === '2026-08-15', istToday())
  check('yesterday in India is REFUSED (the old UTC anchor accepted it)', accepts('2026-08-14') === false)
  check('today in India is accepted', accepts('2026-08-15') === true)
  check('tomorrow is accepted', accepts('2026-08-16') === true)
  check('a date well in the past is still refused', accepts('2025-01-01') === false)
})

// Midday, when UTC and IST agree on the date. The rule must be unchanged here — this
// is the case the old code got right and a regression would be easy to miss.
console.log('\n── midday, when both calendars agree: behaviour is unchanged')
at('2026-08-15T09:00:00Z', () => {
  check('istToday() is the same date', istToday() === '2026-08-15', istToday())
  check('yesterday refused', accepts('2026-08-14') === false)
  check('today accepted', accepts('2026-08-15') === true)
})

// 23:45 IST — the other edge, where IST has rolled over ahead of UTC.
console.log('\n── late evening IST, the far edge of the same window')
at('2026-08-15T18:15:00Z', () => {
  check('istToday() has already rolled to the 15th', istToday() === '2026-08-15', istToday())
  check('today still accepted at the end of the day', accepts('2026-08-15') === true)
})

console.log('\n── the format rule is untouched')
check('a non-ISO date is still rejected', accepts('15-08-2026') === false)
check('an empty date is still rejected', accepts('') === false)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
