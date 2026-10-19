/**
 * bt-fleet-service — D-19 read side: is this truck busy, and until when.
 *
 * WHAT THIS SLICE IS NOT, AND WHY THERE ARE NO OVERLAP TESTS BELOW.
 * The natural reading of D-19 is a date-window calendar that refuses a second load
 * whose dates overlap and permits one whose dates do not. The schema does not permit
 * the state that would guard against:
 *
 *   - vehicle_assignments_one_live_per_vehicle (0016) refuses ANY second live
 *     assignment on a truck, overlapping or not — strictly stronger than an overlap
 *     rule, which could therefore never turn one of its allows into a refusal;
 *   - vehicles_exactly_one_owner (0015) / vehicles_single_owner (0022) give a truck
 *     exactly one owner, so "fleet A and fleet B commit the same truck" is
 *     unrepresentable, and a fleet-owned truck has driver_id NULL so it has no own
 *     driver to self-select work with either;
 *   - fleet_drivers_one_live_per_driver (0015) still allows one live affiliation per
 *     driver, so D-8's multi-fleet driver is not in the schema yet.
 *
 * So what is pinned here is the smaller, true thing: a truck's busy-ness reported on
 * exactly the rule assignment enforces, plus the return date the index cannot give.
 * Every case is a way that stops being true:
 *   - is_free answered from dates rather than commitments -> availability promises a
 *                                                            slot assignment refuses
 *   - a RELEASED assignment still counting                -> the truck retires after
 *                                                            one trip
 *   - a live assignment on a FINISHED trip still counting -> one missed roll-up hook
 *                                                            retires the truck
 *   - a running booking with no assignment row ignored    -> the one double-booking
 *                                                            no index catches
 *   - a mixed known/unknown return date averaged into a
 *     confident answer                                    -> a planner books against
 *                                                            a date we cannot support
 *
 * The whole module is exercised WITHOUT a database on purpose. getSupabase() throws
 * unless SUPABASE_URL is set, so any test below that reached the network would fail
 * loudly rather than silently pass.
 *
 * Run: npm test   (or: npx tsx test/vehicle-schedule.test.mts)
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const VEHICLE = '11111111-1111-1111-1111-111111111111'

// Mumbai -> Nagpur, ~700 road km: 3 days at the 300 km/day default.
const MUMBAI = { source_lat: 19.076, source_lng: 72.8777 }
const NAGPUR = { dest_lat: 21.1458, dest_lng: 79.0882 }
// Mumbai -> Pune, ~150 road km: inside one day.
const PUNE = { dest_lat: 18.5204, dest_lng: 73.8567 }

function booking(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'booking-a',
    vehicle_id: VEHICLE,
    source_address: 'Bhiwandi, Mumbai',
    destination_address: 'MIDC, Nagpur',
    pickup_date: '2026-08-10',
    status: 'accepted',
    ...MUMBAI,
    ...NAGPUR,
    ...over,
  } as never
}

function assignment(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'assignment-a', booking_id: 'booking-a', released_at: null, ...over } as never
}

// IST, not UTC: the truck's day starts when the shipper's does.
const ist = (date: string) => new Date(`${date}T00:00:00+05:30`).toISOString()

async function main() {
  const {
    buildSchedule, estimatedFreeFrom, istStartOfDay, scheduleFreeFrom,
    summariseAvailability, transitDays,
  } = await import('../src/lib/vehicle-schedule.js')

  console.log('\n── when the truck is expected back ──')
  check('pickup_date anchors at IST start-of-day, not UTC midnight',
    istStartOfDay('2026-08-10') === '2026-08-09T18:30:00.000Z', `(got ${istStartOfDay('2026-08-10')})`)
  check('Mumbai -> Nagpur takes the truck for 3 days at 300 km/day',
    transitDays(booking()) === 3, `(got ${transitDays(booking())})`)
  check('Mumbai -> Pune still takes the truck for a whole day',
    transitDays(booking(PUNE)) === 1, `(got ${transitDays(booking(PUNE))})`)
  // Nothing is refused on this number, so a data defect must cost a wrong date and
  // not a truck reported busy for a fortnight.
  check('a trip with unusable coordinates estimates one day, not forever',
    transitDays(booking({ dest_lat: null, dest_lng: null })) === 1)
  check('the estimate lands 3 days after pickup',
    estimatedFreeFrom(booking()) === ist('2026-08-13'), `(got ${estimatedFreeFrom(booking())})`)
  check('no pickup_date is UNKNOWN, not a guess',
    estimatedFreeFrom(booking({ pickup_date: null })) === null)
  check('a garbage pickup_date is unknown too, not NaN',
    estimatedFreeFrom(booking({ pickup_date: 'not-a-date' })) === null)

  console.log('\n── what actually holds a truck ──')
  const live = buildSchedule(VEHICLE, [assignment()], [booking()])
  check('a live assignment is one commitment', live.length === 1, `(got ${live.length})`)
  check('it is attributed to the assignment row', live[0].source === 'assignment')
  check('it names the trip so the refusal can too',
    live[0].description === 'Bhiwandi, Mumbai → MIDC, Nagpur, pickup 2026-08-10', `(got ${live[0].description})`)
  check('and carries the return estimate', live[0].estimated_free_from === ist('2026-08-13'))

  // The regression this pins: released_at means the truck is back in the pool. If
  // this ever stops being true, a truck is retired for good after its first trip and
  // the only symptom is a dispatcher who cannot assign anything.
  const released = buildSchedule(VEHICLE, [assignment({ released_at: '2026-08-14T00:00:00.000Z' })], [])
  check('a RELEASED assignment is not a commitment', released.length === 0, `(got ${released.length})`)

  // Same judgement releaseFinishedAssignments makes when it sweeps: one roll-up hook
  // that never fired must not take the truck out of service permanently.
  check('a live assignment row on a finished trip does not hold the truck',
    buildSchedule(VEHICLE, [assignment()], [booking({ status: 'paid' })]).length === 0)
  check('an assignment whose booking cannot be read stays blocking — unreadable is not free',
    buildSchedule(VEHICLE, [assignment()], []).length === 1)

  // THE one commitment no 0016 index catches: the trip is on the road but its
  // assignment row is gone, so nothing at the database level stops a second load.
  const orphan = buildSchedule(VEHICLE, [], [booking({ id: 'booking-b', status: 'in_transit' })])
  check('a running booking with no assignment row still holds the truck',
    orphan.length === 1 && orphan[0].source === 'booking')
  check('a booking that names another truck does not hold this one',
    buildSchedule(VEHICLE, [], [booking({ vehicle_id: 'another-truck' })]).length === 0)
  check('the same trip is counted once, not twice',
    buildSchedule(VEHICLE, [assignment()], [booking()]).length === 1)

  console.log('\n── the date reported to a planner ──')
  check('an idle truck has no return date to report', scheduleFreeFrom([]) === null)
  check('one commitment reports its own return', scheduleFreeFrom(live) === ist('2026-08-13'))

  const two = buildSchedule(VEHICLE,
    [assignment(), assignment({ id: 'assignment-b', booking_id: 'booking-b' })],
    [booking(), booking({ id: 'booking-b', pickup_date: '2026-08-12', vehicle_id: 'unused' })])
  check('two commitments report the LATER return, not the first',
    scheduleFreeFrom(two) === ist('2026-08-15'), `(got ${scheduleFreeFrom(two)})`)

  // Reporting the latest KNOWN date while one trip has no return date at all hands a
  // planner a date the truck may blow straight through. Unknown has to win.
  const mixed = buildSchedule(VEHICLE,
    [assignment(), assignment({ id: 'assignment-c', booking_id: 'booking-c' })],
    [booking(), booking({ id: 'booking-c', pickup_date: null, vehicle_id: 'unused' })])
  check('one unknown return makes the whole answer unknown',
    scheduleFreeFrom(mixed) === null, `(got ${scheduleFreeFrom(mixed)})`)

  console.log('\n── availability and assignment cannot disagree ──')
  // is_free must track the COUNT of commitments, never a date comparison, because
  // vehicle_assignments_one_live_per_vehicle refuses a second live assignment on ANY
  // dates. These three pin exactly that: a truck whose only trip finished weeks ago
  // is still not free, and one held by a trip in the distant future is not free now
  // either. Both are cases a date-window answer would get wrong in the direction
  // that promises a slot the assignment call then refuses.
  check('no commitments means free, with no return date to report',
    summariseAvailability(VEHICLE, []).is_free === true &&
    summariseAvailability(VEHICLE, []).estimated_free_from === null)

  const longPast = buildSchedule(VEHICLE, [assignment()], [booking({ pickup_date: '2020-01-01' })])
  check('a truck held by a trip whose estimated return is long past is still NOT free',
    summariseAvailability(VEHICLE, longPast).is_free === false)

  const farFuture = buildSchedule(VEHICLE, [assignment()], [booking({ pickup_date: '2030-01-01' })])
  check('a truck held by a trip that has not started yet is NOT free today',
    summariseAvailability(VEHICLE, farFuture).is_free === false)
  check('and the caller is told when it comes back',
    summariseAvailability(VEHICLE, farFuture).estimated_free_from === ist('2030-01-04'),
    `(got ${summariseAvailability(VEHICLE, farFuture).estimated_free_from})`)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
