/**
 * Wave 1 of the ranked new alerts (src/lib/alerts/rules-wave1.ts) — pure, so every threshold,
 * audience and close condition is pinned with an injected clock:
 *
 *   #2  e-way bill: within 8 h → warning, within 2 h or expired → critical; only while in transit;
 *       shipper (can extend) + carrier.
 *   #3  delivered 2 km+ from the drop → shipper + money carrier; closes once paid.
 *   #4  documents: pickup today/tomorrow only; invoice/e-way to the shipper (critical on the day),
 *       LR to the carrier as info.
 *   #5  fleet pickup with no live assignment, today (critical) / tomorrow (warning); solo trips never.
 *   #7  in the drop fence 2 h+ without leaving → warning, 4 h+ critical; a driver gets no amount.
 *   #8  damage → shipper + money carrier until paid/cancelled.
 *   #12 delivery_asserted 24 h+ → warning, 72 h+ critical.
 *   #14 open-to-bids load, 6 h+, zero bids → shipper; direct-to-one-driver loads never.
 *   #22 active, not busy, 5+ IST days since it last worked → owner (fleet) or solo driver.
 *   Everywhere: one alert per person; no 'driver' alert carries ₹.
 *
 * Run: npx tsx test/alert-rules-wave1.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { createChecker } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const w = await import('../src/lib/alerts/rules-wave1.js')
const { KINDS_BY_CADENCE } = await import('../src/lib/alerts/types.js')

const NOW = new Date('2026-10-16T06:30:00Z') // 12:00 IST, 16 Oct
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const hAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString()
const U_OWNER = 'u-owner', U_DRIVER = 'u-driver', U_SOLO = 'u-solo', U_SHIP = 'u-ship'
const audience = { driverUser: new Map([['d-hired', U_DRIVER], ['d-solo', U_SOLO]]), fleetOwnerUser: new Map([['fo-1', U_OWNER]]) }
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b-1', status: 'in_transit', shipper_id: U_SHIP, driver_id: 'd-hired', fleet_owner_id: 'fo-1',
  source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur',
  pickup_date: '2026-10-17', updated_at: hAgo(30), quoted_price: 48000, final_price: 52000, ...over,
}) as any
const solo = (over: Record<string, unknown> = {}) => booking({ fleet_owner_id: null, driver_id: 'd-solo', ...over })
const to = (as: any[], u: string) => as.filter((a) => a.audience_user_id === u)
const noMoneyToDrivers = (as: any[]) => as.filter((a) => a.persona === 'driver').every((a) => !/₹/.test(a.title + a.detail.subtitle))
const keysUnique = (as: any[]) => new Set(as.map((a) => a.dedupe_key)).size === as.length

console.log('\n── cadences')
check('frequent: e-way, at-drop, delivered-away, damage, no-bids', ['ewb_expiring', 'at_drop_not_delivered', 'delivered_away', 'damage_reported', 'no_bids'].every((k) => (KINDS_BY_CADENCE.frequent as string[]).includes(k)))
check('daily: documents, pickup-no-truck, unconfirmed, idle', ['documents_not_ready', 'pickup_no_truck', 'delivery_unconfirmed', 'truck_idle'].every((k) => (KINDS_BY_CADENCE.daily as string[]).includes(k)))
check('every kind is on exactly one cadence', new Set([...KINDS_BY_CADENCE.frequent, ...KINDS_BY_CADENCE.daily]).size === KINDS_BY_CADENCE.frequent.length + KINDS_BY_CADENCE.daily.length)

console.log('\n── #2 e-way bill expiring in transit')
{
  const at = (validUpto: string, b = booking()) => w.ewbExpiringAlerts([{ booking: b, ewbNumber: '331009876543', validUpto }], audience, NOW)
  check('9 h left → nothing', at(hAhead(9)).length === 0)
  const eight = at(hAhead(7.5))
  check('7.5 h left → warning to the shipper and the fleet owner', eight.length === 2 && eight.every((a) => a.severity === 'warning') && to(eight, U_SHIP).length === 1 && to(eight, U_OWNER).length === 1)
  check('the shipper is told to extend, with the bill number', /Extend the bill 331009876543/.test(to(eight, U_SHIP)[0].detail.subtitle))
  check('1.5 h left → critical', at(hAhead(1.5)).every((a) => a.severity === 'critical'))
  const gone = at(hAgo(1))
  check('already expired → critical, "has expired"', gone.every((a) => a.severity === 'critical') && /has expired/.test(gone[0].title))
  check('a delivered truck raises nothing (only while moving)', at(hAhead(1), booking({ status: 'delivery_asserted' })).length === 0)
  const s = at(hAhead(3), solo())
  check('solo trip → the driver (driving persona), no money', to(s, U_SOLO)[0]?.persona === 'driver' && noMoneyToDrivers(s))
}

console.log('\n── #3 delivered away from the drop')
{
  const at = (m: number, b = booking({ status: 'completed' })) => w.deliveredAwayAlerts([{ booking: b, distanceM: m, source: 'code_issue' }], audience, NOW)
  check('1.9 km → nothing', at(1900).length === 0)
  const far = at(3400)
  check('3.4 km → warning to shipper + fleet owner, distance in the title', far.length === 2 && far.every((a) => a.severity === 'warning') && /3\.4 km/.test(far[0].title))
  check('closes once paid (a paid trip raises nothing)', at(3400, booking({ status: 'paid' })).length === 0)
  const s = at(5000, solo({ status: 'delivery_asserted' }))
  check('solo trip → the driver as CARRIER (money persona)', to(s, U_SOLO)[0]?.persona === 'carrier')
}

console.log('\n── #4 documents not ready')
{
  const docs = (over: Record<string, unknown>, gaps: Partial<{ missingInvoice: boolean; missingEwb: boolean; missingLr: boolean }>) =>
    w.documentsNotReadyAlerts([{ booking: booking({ status: 'accepted', ...over }), missingInvoice: false, missingEwb: false, missingLr: false, ...gaps }], audience, NOW)
  check('pickup in 2 days → nothing yet', docs({ pickup_date: '2026-10-18' }, { missingInvoice: true }).length === 0)
  const tmr = docs({ pickup_date: '2026-10-17' }, { missingInvoice: true, missingEwb: true })
  check('tomorrow, invoice + e-way missing → one WARNING to the shipper naming both', tmr.length === 1 && tmr[0].audience_user_id === U_SHIP && tmr[0].severity === 'warning' && /tax invoice and the e-way bill/.test(tmr[0].title))
  check('today → critical', docs({ pickup_date: '2026-10-16' }, { missingInvoice: true })[0].severity === 'critical')
  const lr = docs({}, { missingLr: true })
  check('LR missing → info to the carrier only', lr.length === 1 && lr[0].audience_user_id === U_OWNER && lr[0].severity === 'info')
  check('everything in place → nothing', docs({}, {}).length === 0)
  check('a trip already started is not this rule\'s', docs({ status: 'in_transit' }, { missingInvoice: true }).length === 0)
}

console.log('\n── #5 pickup tomorrow, no truck')
{
  const p = (over: Record<string, unknown>, assigned: boolean) => w.pickupNoTruckAlerts([{ booking: booking({ status: 'accepted', driver_id: null, ...over }), assigned }], audience, NOW)
  const tmr = p({ pickup_date: '2026-10-17' }, false)
  check('fleet load, tomorrow, unassigned → warning to the fleet owner', tmr.length === 1 && tmr[0].audience_user_id === U_OWNER && tmr[0].severity === 'warning')
  check('today → critical', p({ pickup_date: '2026-10-16' }, false)[0].severity === 'critical')
  check('assigned → nothing', p({}, true).length === 0)
  check('a solo trip never (the solo driver IS the truck)', p({ fleet_owner_id: null, driver_id: 'd-solo' }, false).length === 0)
  check('pickup in 3 days → nothing yet', p({ pickup_date: '2026-10-19' }, false).length === 0)
}

console.log('\n── #7 at the drop, not delivered')
{
  const a = (entered: string | null, exited = false) => w.atDropNotDeliveredAlerts([{ booking: booking(), enteredAt: entered, exited }], audience, NOW)
  check('1.5 h at the drop → nothing', a(hAgo(1.5)).length === 0)
  const two = a(hAgo(2.5))
  check('2.5 h → warning to shipper, fleet owner AND the driver at the wheel', two.length === 3 && two.every((x) => x.severity === 'warning'))
  check('the driver is told to get the code, no ₹ anywhere for them', /delivery code/.test(to(two, U_DRIVER)[0].detail.subtitle) && noMoneyToDrivers(two))
  check('4 h+ → critical', a(hAgo(4.5)).every((x) => x.severity === 'critical'))
  check('left the fence → nothing', a(hAgo(5), true).length === 0)
  check('never entered → nothing', a(null).length === 0)
  check('one alert per person, unique keys', keysUnique(two))
}

console.log('\n── #8 damage reported')
{
  const d = (status: string) => w.damageReportedAlerts([{ booking: booking({ status }), reportedAt: hAgo(1), delta: -4, unit: 'boxes' }], audience, NOW)
  const open = d('delivery_asserted')
  check('damage → warning to shipper + fleet owner, with the count', open.length === 2 && /4 boxes/.test(open[0].title))
  check('closes once paid or cancelled', d('paid').length === 0 && d('cancelled').length === 0)
}

console.log('\n── #12 delivery not confirmed')
{
  const u = (assertedHoursAgo: number | null, status = 'delivery_asserted') => w.deliveryUnconfirmedAlerts([{ booking: booking({ status }), assertedAt: assertedHoursAgo === null ? null : hAgo(assertedHoursAgo) }], audience, NOW)
  check('20 h → nothing', u(20).length === 0)
  check('30 h → warning to shipper + fleet owner', (() => { const x = u(30); return x.length === 2 && x.every((a) => a.severity === 'warning') })())
  check('80 h → critical, said in days', (() => { const x = u(80); return x.every((a) => a.severity === 'critical') && /3 days/.test(x[0].title) })())
  check('no assert time (pre-0039) → falls back to the last update (30 h ago)', u(null).length === 2)
  check('confirmed (completed) → nothing', u(100, 'completed').length === 0)
}

console.log('\n── #14 no bids yet')
{
  const n = (hoursOpen: number, over: Partial<{ openToBids: boolean; bidCount: number; status: string }> = {}) =>
    w.noBidsAlerts([{ booking: booking({ status: over.status ?? 'pending' }), createdAt: hAgo(hoursOpen), openToBids: over.openToBids ?? true, bidCount: over.bidCount ?? 0 }], audience, NOW)
  check('5 h → nothing', n(5).length === 0)
  const six = n(7)
  check('7 h, zero bids → INFO to the shipper only', six.length === 1 && six[0].audience_user_id === U_SHIP && six[0].severity === 'info')
  check('a day without bids → warning', n(26)[0].severity === 'warning')
  check('one bid → nothing', n(26, { bidCount: 1 }).length === 0)
  check('a direct load sent to one driver → never', n(26, { openToBids: false }).length === 0)
  check('accepted loads are not this rule\'s', n(26, { status: 'accepted' }).length === 0)
}

console.log('\n── #22 truck idle')
{
  const t = (daysIdle: number, over: Record<string, unknown> = {}) => w.truckIdleAlerts([{
    vehicle_id: 'v-1', rc_number: 'MH12AB1234', fleet_owner_id: 'fo-1', driver_id: null,
    lastActiveAt: new Date(NOW.getTime() - daysIdle * 86_400_000).toISOString(), busy: false, ...over,
  } as any], audience, NOW)
  check('4 days → nothing', t(4).length === 0)
  const idle = t(6)
  check('6 days → INFO to the fleet owner, about the TRUCK (subject vehicle)', idle.length === 1 && idle[0].audience_user_id === U_OWNER && idle[0].subject_type === 'vehicle' && idle[0].severity === 'info' && /MH12AB1234/.test(idle[0].title))
  check('on a trip right now → nothing', t(20, { busy: true }).length === 0)
  const s = t(9, { fleet_owner_id: null, driver_id: 'd-solo' })
  check('a solo truck → its driver as carrier', s.length === 1 && s[0].audience_user_id === U_SOLO && s[0].persona === 'carrier')
}

finish()
