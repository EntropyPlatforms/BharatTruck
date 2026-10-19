/**
 * The alert rules (src/lib/alerts/rules.ts) and the helpers they stand on — pure, so
 * every threshold is pinned here with an injected clock:
 *
 *   - GPS silent: 15 min -> warning, 2 h -> critical; a fresh fix raises nothing.
 *   - Trip not started: measured in whole IST days against a DATE pickup.
 *   - Unpaid: counted from DELIVERY; 3 days -> warning, 7 -> critical; only 'completed'.
 *   - Licence: within 30 days -> warning, expired -> critical.
 *   - Audience: a fleet trip answers to the fleet owner; a solo trip to the driver.
 *   - Money follows ownership (§1.1): no 'driver' alert ever carries an amount, and a
 *     hired driver never receives a money alert.
 *
 * Run: npx tsx test/alert-rules.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { createChecker } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const { istDate, istMonthStart, daysBetweenDates } = await import('../src/lib/ist.js')
const { cityLabel, laneLabel } = await import('../src/lib/place.js')
const rules = await import('../src/lib/alerts/rules.js')

const NOW = new Date('2026-10-16T06:30:00Z') // 12:00 IST on 16 Oct
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

const U_OWNER = 'u-owner', U_DRIVER = 'u-driver', U_SOLO = 'u-solo', U_SHIP = 'u-ship'
const audience = {
  driverUser: new Map([['d-hired', U_DRIVER], ['d-solo', U_SOLO]]),
  fleetOwnerUser: new Map([['fo-1', U_OWNER]]),
}
const booking = (over: Record<string, unknown>) => ({
  id: 'b-1', status: 'in_transit', shipper_id: U_SHIP, driver_id: 'd-hired', fleet_owner_id: 'fo-1',
  source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur',
  pickup_date: '2026-10-15', updated_at: daysAgo(1), quoted_price: 48000, final_price: 52000, ...over,
}) as any
const hasMoney = (a: any) => /₹/.test(a.title + a.detail.subtitle) || 'amount_inr' in a.detail

// ── helpers ──────────────────────────────────────────────────────────────────
console.log('\n── IST calendar helpers and place labels')
check('istDate rolls to the next day after 18:30 UTC', istDate(new Date('2026-10-16T20:00:00Z')) === '2026-10-17')
check('istMonthStart is 00:00 IST on the 1st (18:30 UTC the day before)',
  istMonthStart(new Date('2026-10-31T19:00:00Z')).toISOString() === '2026-10-31T18:30:00.000Z')
check('daysBetweenDates counts whole calendar days', daysBetweenDates('2026-10-10', '2026-10-16') === 6)
check('cityLabel: a geocoded address becomes its city', cityLabel('Andheri East, Mumbai, Maharashtra 400069, India') === 'Mumbai')
check('cityLabel: a bare city stays as it is', cityLabel('Mumbai') === 'Mumbai')
check('cityLabel: drops a bare state name', cityLabel('Bhiwandi, Maharashtra, India') === 'Bhiwandi')
check('cityLabel: keeps a city that is also a state (Chandigarh)', cityLabel('Sector 17, Chandigarh, 160017, India') === 'Chandigarh')
check('cityLabel: New Delhi survives its "Delhi 110001" part', cityLabel('New Delhi, Delhi 110001, India') === 'New Delhi')
check('cityLabel: missing address is a dash', cityLabel(null) === '—')
check('laneLabel joins two cities', laneLabel('Andheri East, Mumbai, Maharashtra 400069, India', 'Nagpur') === 'Mumbai → Nagpur')

// ── GPS silent ───────────────────────────────────────────────────────────────
console.log('\n── GPS silent during a trip')
{
  const fleetTrip = (fix: string | null, started: string | null = null) =>
    rules.gpsSilentAlerts([{ booking: booking({}), lastFixAt: fix, startedAt: started }], audience, NOW)
  check('a fix 5 minutes old raises nothing', fleetTrip(minsAgo(5)).length === 0)
  const twenty = fleetTrip(minsAgo(20))
  check('20 minutes silent on a fleet trip alerts the owner AND the driver', twenty.length === 2 &&
    twenty.some((a) => a.audience_user_id === U_OWNER && a.persona === 'fleet') &&
    twenty.some((a) => a.audience_user_id === U_DRIVER && a.persona === 'driver'), JSON.stringify(twenty.map((a) => [a.audience_user_id, a.persona])))
  check('20 minutes is a warning', twenty.every((a) => a.severity === 'warning'))
  check('3 hours silent is critical', fleetTrip(minsAgo(180)).every((a) => a.severity === 'critical'))
  check('no fix since a start 30 minutes ago still alerts', fleetTrip(null, minsAgo(30)).length === 2)
  check('a trip that just started (10 min, no fix yet) raises nothing', fleetTrip(null, minsAgo(10)).length === 0)
  const solo = rules.gpsSilentAlerts([{ booking: booking({ driver_id: 'd-solo', fleet_owner_id: null }), lastFixAt: minsAgo(30), startedAt: null }], audience, NOW)
  check('a solo trip alerts its driver exactly once', solo.length === 1 && solo[0].audience_user_id === U_SOLO && solo[0].persona === 'driver')
  check('an accepted (not moving) trip is never GPS-silent',
    rules.gpsSilentAlerts([{ booking: booking({ status: 'accepted' }), lastFixAt: minsAgo(300), startedAt: null }], audience, NOW).length === 0)
  check('dedupe keys are per trip AND per person', new Set(twenty.map((a) => a.dedupe_key)).size === 2)
  check('GPS alerts never carry money', twenty.every((a) => !hasMoney(a)))
}

// ── Trip not started ─────────────────────────────────────────────────────────
console.log('\n── trip not started by its pickup date')
{
  const run = (pickup: string, over: Record<string, unknown> = {}) =>
    rules.tripNotStartedAlerts([booking({ status: 'accepted', pickup_date: pickup, ...over })], audience, NOW)
  check('pickup today raises nothing', run('2026-10-16').length === 0)
  const late1 = run('2026-10-15')
  check('pickup yesterday alerts the carrier AND the shipper', late1.length === 2 &&
    late1.some((a) => a.persona === 'fleet') && late1.some((a) => a.persona === 'shipper' && a.audience_user_id === U_SHIP))
  check('one day late is a warning; the title says "yesterday"', late1.every((a) => a.severity === 'warning') &&
    late1.some((a) => /yesterday/.test(a.title)), JSON.stringify(late1.map((a) => a.title)))
  check('four days late is critical', run('2026-10-12').every((a) => a.severity === 'critical'))
  check('an in-transit trip is not "not started"', run('2026-10-10', { status: 'in_transit' }).length === 0)
  const self = run('2026-10-15', { shipper_id: U_OWNER })
  check('when the shipper IS the carrier, one alert, not two', self.length === 1, JSON.stringify(self.map((a) => a.persona)))
}

// ── Unpaid ───────────────────────────────────────────────────────────────────
console.log('\n── delivered but not paid')
{
  const run = (delivered: string | null, over: Record<string, unknown> = {}) =>
    rules.unpaidOverdueAlerts([{ booking: booking({ status: 'completed', ...over }), deliveredAt: delivered }], audience, NOW)
  check('two days after delivery raises nothing', run(daysAgo(2)).length === 0)
  const three = run(daysAgo(3))
  check('three days after delivery: owner and shipper are told', three.length === 2 &&
    three.some((a) => a.persona === 'fleet') && three.some((a) => a.persona === 'shipper'))
  check('three days is a warning, eight is critical', three.every((a) => a.severity === 'warning') &&
    run(daysAgo(8)).every((a) => a.severity === 'critical'))
  check('the amount is the agreed final price', three.every((a) => (a.detail as any).amount_inr === 52000))
  check('the age counts from DELIVERY, not the last update', run(daysAgo(1), { updated_at: daysAgo(20) }).length === 0)
  check('with no delivery time yet, the last update stands in', run(null, { updated_at: daysAgo(9) }).every((a) => a.severity === 'critical'))
  check('a paid trip is never unpaid', run(daysAgo(30), { status: 'paid' }).length === 0)
  check('a delivery still being confirmed is not owed yet', run(daysAgo(30), { status: 'delivery_asserted' }).length === 0)
  const solo = run(daysAgo(5), { driver_id: 'd-solo', fleet_owner_id: null })
  check('a solo trip owes the driver as a CARRIER (money persona), never as a driver',
    solo.some((a) => a.audience_user_id === U_SOLO && a.persona === 'carrier') && !solo.some((a) => a.persona === 'driver'))
  check('a hired driver never receives a money alert', !three.some((a) => a.audience_user_id === U_DRIVER))
}

// ── Licence ──────────────────────────────────────────────────────────────────
console.log('\n── driving licence expiring')
{
  const lic = (expiry: string, fleets = ['fo-1']) =>
    rules.licenceExpiringAlerts([{ driver_id: 'd-hired', expiry_date: expiry, driver_name: 'Ravi', fleet_owner_ids: fleets }], audience, NOW)
  check('40 days away raises nothing', lic('2026-11-25').length === 0)
  const ten = lic('2026-10-26')
  check('10 days away alerts the driver and their fleet owner', ten.length === 2 &&
    ten.some((a) => a.persona === 'driver' && a.audience_user_id === U_DRIVER) &&
    ten.some((a) => a.persona === 'fleet' && a.audience_user_id === U_OWNER && /Ravi/.test(a.title)), JSON.stringify(ten.map((a) => a.title)))
  check('within 30 days is a warning', ten.every((a) => a.severity === 'warning'))
  const expired = lic('2026-10-14')
  check('an expired licence is critical and says so', expired.every((a) => a.severity === 'critical') && expired.some((a) => /expired 2 days ago/.test(a.title)),
    JSON.stringify(expired.map((a) => a.title)))
  check('a driver with no fleet seat alerts only themselves', lic('2026-10-26', []).length === 1)
  check('licence alerts are about the driver, not a booking', ten.every((a) => a.subject_type === 'driver' && a.subject_id === 'd-hired'))
}

finish()
