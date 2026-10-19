/**
 * bt-fleet-service — trip-end assignment sweep (FB-01).
 *
 * Run: npm test   (or: npx tsx test/assignment-sweep.test.mts)
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

function assignment(bookingId: string) {
  return { id: `assignment-${bookingId}`, booking_id: bookingId, released_at: null }
}

async function main() {
  const { bookingFreesTruck, TRIP_END_FREE_STATUSES } = await import('../src/lib/booking-status.js')
  const { liveAssignmentsAfterTripEndSweep } = await import('../src/lib/assignment.js')

  console.log('\n── statuses that free a truck ──')
  check('completed frees the truck', bookingFreesTruck('completed'))
  check('delivery_asserted frees the truck', bookingFreesTruck('delivery_asserted'))
  check('paid frees the truck', bookingFreesTruck('paid'))
  check('cancelled frees the truck', bookingFreesTruck('cancelled'))
  check('in_transit does NOT free the truck', !bookingFreesTruck('in_transit'))
  check('accepted does NOT free the truck', !bookingFreesTruck('accepted'))
  check('delivery_asserted is in the shared constant',
    TRIP_END_FREE_STATUSES.includes('delivery_asserted'))

  console.log('\n── proactive sweep filter ──')
  const live = [assignment('booking-a'), assignment('booking-b'), assignment('booking-c')]
  const bookings = [
    { id: 'booking-a', status: 'completed' },
    { id: 'booking-b', status: 'delivery_asserted' },
    { id: 'booking-c', status: 'in_transit' },
  ]
  const swept = liveAssignmentsAfterTripEndSweep(live, bookings)
  check('completed and delivery_asserted assignments are swept out',
    swept.length === 1 && swept[0].booking_id === 'booking-c', `(got ${swept.map(a => a.booking_id).join(',')})`)
  check('paid assignments are swept out too',
    liveAssignmentsAfterTripEndSweep([assignment('booking-a')], [{ id: 'booking-a', status: 'paid' }]).length === 0)
  check('an empty live list stays empty',
    liveAssignmentsAfterTripEndSweep([], bookings).length === 0)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
