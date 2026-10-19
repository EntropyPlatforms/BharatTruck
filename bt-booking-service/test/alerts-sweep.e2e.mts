/**
 * POST /internal/alerts/sweep + the 'alerts.open' source of GET /me/feed, against the REAL
 * routes (app.inject) and an in-memory fake Supabase. Pins:
 *
 *   1. The sweep is internal-secret gated, and refuses with 503 ALERTS_NOT_MIGRATED until
 *      migration 0042 exists (a Scheduler job must go red, not report "nothing wrong").
 *   2. Lifecycle: a problem OPENS once, a re-run REFRESHES (no duplicates), it RESOLVES
 *      when the condition clears, and the SAME row REOPENS if it comes back.
 *   3. Critical alerts queue exactly one 'alert_raised' email per episode.
 *   4. Each cadence touches only its own kinds; a rule that cannot load its facts is
 *      reported and its open alerts are LEFT ALONE ("could not check" is not "all clear").
 *   5. The Home feed shows open alerts in the right persona idiom — and a hired driver's
 *      alerts never carry money — and a pending migration is not a degraded feed.
 *   6. Two sweeps that overlap (a slow run, a Scheduler retry) open or reopen each problem
 *      once and email it once, and neither fails.
 *
 * Run: npx tsx test/alerts-sweep.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()

const U_OWNER = '10000000-0000-4000-8000-000000000001' // fleet owner
const U_DRIVER = '20000000-0000-4000-8000-000000000002' // hired driver (no truck)
const U_SHIP = '30000000-0000-4000-8000-000000000003'  // shipper
const U_SOLO = '40000000-0000-4000-8000-000000000004'  // owner-driver
const FO = 'f0000000-0000-4000-8000-000000000001'
const D_HIRED = 'd0000000-0000-4000-8000-000000000002'
const D_SOLO = 'd0000000-0000-4000-8000-000000000004'
const B_FLEET_TRANSIT = 'b0000000-0000-4000-8000-000000000001'
const B_SOLO_TRANSIT = 'b0000000-0000-4000-8000-000000000002'
const B_LATE = 'b0000000-0000-4000-8000-000000000003'
const B_UNPAID = 'b0000000-0000-4000-8000-000000000004'

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const istDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY + 5.5 * 3_600_000).toISOString().slice(0, 10)

function seed() {
  fake.reset()
  const s = fake.store
  s.users = [
    { id: U_OWNER, full_name: 'Sharma Roadlines', email: 'owner@ex.in', role: 'fleet_owner' },
    { id: U_DRIVER, full_name: 'Ravi Kumar', email: 'ravi@ex.in', role: 'driver' },
    { id: U_SHIP, full_name: 'Anita Exports', email: 'anita@ex.in', role: 'shipper' },
    { id: U_SOLO, full_name: 'Sandeep Yadav', email: 'sandeep@ex.in', role: 'driver' },
  ]
  s.drivers = [
    { id: D_HIRED, user_id: U_DRIVER, user: { full_name: 'Ravi Kumar' } },
    { id: D_SOLO, user_id: U_SOLO, user: { full_name: 'Sandeep Yadav' } },
  ]
  s.fleet_owners = [{ id: FO, user_id: U_OWNER, company_name: 'Sharma Roadlines', is_active: true }]
  s.fleet_drivers = [{ id: 'fd-1', fleet_owner_id: FO, driver_id: D_HIRED, status: 'active', responded_at: ago(30 * DAY), updated_at: ago(30 * DAY) }]
  s.vehicles = [
    { id: 'v-f1', fleet_owner_id: FO, driver_id: null }, { id: 'v-f2', fleet_owner_id: FO, driver_id: null },
    { id: 'v-solo', fleet_owner_id: null, driver_id: D_SOLO },
  ]
  const base = { shipper_id: U_SHIP, source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur',
    quoted_price: 48000, final_price: 52000, receiver_email: 'r@acme.in', created_at: ago(20 * DAY) }
  s.bookings = [
    { ...base, id: B_FLEET_TRANSIT, status: 'in_transit', fleet_owner_id: FO, driver_id: D_HIRED, pickup_date: istDay(-1), updated_at: ago(3 * 3_600_000) },
    { ...base, id: B_SOLO_TRANSIT, status: 'in_transit', fleet_owner_id: null, driver_id: D_SOLO, pickup_date: istDay(-1), updated_at: ago(3 * 3_600_000) },
    { ...base, id: B_LATE, status: 'accepted', fleet_owner_id: FO, driver_id: D_HIRED, pickup_date: istDay(-2), updated_at: ago(3 * DAY) },
    { ...base, id: B_UNPAID, status: 'completed', fleet_owner_id: FO, driver_id: D_HIRED, pickup_date: istDay(-10), updated_at: ago(8 * DAY) },
  ]
  s.location_history = [
    { booking_id: B_FLEET_TRANSIT, recorded_at: ago(40 * 60_000) },
    { booking_id: B_FLEET_TRANSIT, recorded_at: ago(30 * 60_000) }, // newest: 30 min ago
    { booking_id: B_SOLO_TRANSIT, recorded_at: ago(2 * 60_000) },  // fresh
  ]
  s.booking_milestones = [
    { booking_id: B_UNPAID, accepted_at: ago(11 * DAY), started_at: ago(9 * DAY), delivered_at: ago(8 * DAY), paid_at: null, has_backfill: false },
  ]
  s.driver_licenses = [{ driver_id: D_HIRED, dl_number: 'MH01 2020 0001', expiry_date: istDay(10) }]
  s.alerts = []
  s.notification_outbox = []
}

const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const internalAuthPlugin = (await import('../src/plugins/internal-auth.js')).default
  const { internalRoutes } = await import('../src/routes/internal.js')
  const { feedRoutes } = await import('../src/routes/feed.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(feedRoutes, { prefix: '/me' }) })
  await app.register(async (a) => { await a.register(internalAuthPlugin); await a.register(internalRoutes, { prefix: '/internal' }) })
  await app.ready()

  const sweep = (cadence: string, secret = process.env.INTERNAL_SERVICE_SECRET!) =>
    app.inject({ method: 'POST', url: `/internal/alerts/sweep?cadence=${cadence}`, headers: { 'x-internal-secret': secret } })
  const data = (res: any) => JSON.parse(res.body).data
  const feed = async (u: string, role: string) =>
    JSON.parse((await app.inject({ method: 'GET', url: '/me/feed?limit=50', headers: { authorization: `Bearer ${tok(u, role)}` } })).body).data
  const open = () => fake.store.alerts.filter((a) => !a.resolved_at)

  // ── 1. Gate and unmigrated database ───────────────────────────────────────
  console.log('\n── the sweep is internal-only and refuses an unmigrated database')
  seed()
  check('no secret → 401', (await sweep('frequent', 'wrong')).statusCode === 401)
  fake.missing.add('alerts')
  const refused = await sweep('frequent')
  check('alerts table missing → 503 ALERTS_NOT_MIGRATED', refused.statusCode === 503 && JSON.parse(refused.body).code === 'ALERTS_NOT_MIGRATED', refused.body)
  check('a bad cadence → 400', (await sweep('hourly')).statusCode === 400)

  // ── 2. Lifecycle: open → refresh → resolve → reopen ───────────────────────
  console.log('\n── one row per problem: open, refresh, resolve, reopen')
  seed()
  let r = data(await sweep('frequent'))
  check('first frequent sweep opens 2 (owner + hired driver of the silent fleet trip)', r.opened === 2 && open().length === 2, JSON.stringify(r))
  check('the solo trip with a fresh fix raises nothing', !fake.store.alerts.some((a) => a.subject_id === B_SOLO_TRANSIT))
  check('frequent sweeps evaluate GPS only', JSON.stringify(r.evaluated_kinds) === '["gps_silent"]', JSON.stringify(r.evaluated_kinds))
  r = data(await sweep('frequent'))
  check('a re-run refreshes instead of duplicating', r.opened === 0 && r.refreshed === 2 && fake.store.alerts.length === 2, JSON.stringify(r))

  fake.store.location_history.push({ booking_id: B_FLEET_TRANSIT, recorded_at: ago(60_000) })
  r = data(await sweep('frequent'))
  check('a fresh fix resolves both alerts', r.resolved === 2 && open().length === 0, JSON.stringify(r))

  fake.store.location_history = fake.store.location_history.filter((l) => l.booking_id !== B_FLEET_TRANSIT)
  fake.store.location_history.push({ booking_id: B_FLEET_TRANSIT, recorded_at: ago(3 * 3_600_000) })
  r = data(await sweep('frequent'))
  check('silent again reopens the SAME rows (no new rows)', r.opened === 2 && fake.store.alerts.length === 2 && open().length === 2, JSON.stringify(r))
  check('three hours silent is critical', open().every((a) => a.severity === 'critical'))

  // ── 3. Email once per episode ─────────────────────────────────────────────
  console.log('\n── critical alerts queue one email each, once')
  const mails = () => fake.store.notification_outbox.filter((m) => m.event_type === 'alert_raised')
  check('two critical alerts → two alert_raised emails', mails().length === 2 &&
    mails().some((m) => m.recipient_email === 'owner@ex.in') && mails().some((m) => m.recipient_email === 'ravi@ex.in'),
    JSON.stringify(mails().map((m) => m.recipient_email)))
  await sweep('frequent')
  check('a re-run queues nothing new', mails().length === 2, String(mails().length))

  // ── 4. Daily kinds, isolation, and failed facts ───────────────────────────
  console.log('\n── the daily sweep: money, documents, late starts')
  r = data(await sweep('daily'))
  const kinds = (k: string) => open().filter((a) => a.kind === k)
  check('daily sweep evaluates its three kinds', ['trip_not_started', 'unpaid_overdue', 'licence_expiring'].every((k) => r.evaluated_kinds.includes(k)), JSON.stringify(r.evaluated_kinds))
  check('late pickup → owner + shipper', kinds('trip_not_started').length === 2 &&
    kinds('trip_not_started').some((a) => a.audience_user_id === U_SHIP && a.persona === 'shipper'))
  check('unpaid 8 days → owner + shipper, critical', kinds('unpaid_overdue').length === 2 && kinds('unpaid_overdue').every((a) => a.severity === 'critical'))
  check('the hired driver is never told about money', !kinds('unpaid_overdue').some((a) => a.audience_user_id === U_DRIVER))
  check('licence in 10 days → the driver + their fleet owner', kinds('licence_expiring').length === 2 &&
    kinds('licence_expiring').some((a) => a.audience_user_id === U_OWNER && /Ravi Kumar/.test(a.title)), JSON.stringify(kinds('licence_expiring').map((a) => a.title)))
  check('the daily sweep did not resolve the open GPS alerts', kinds('gps_silent').length === 2)

  fake.failing.add('driver_licenses')
  r = data(await sweep('daily'))
  check('a rule whose facts fail is reported', r.failed_kinds.includes('licence_expiring'), JSON.stringify(r))
  check('...and its open alerts are left alone, not resolved', kinds('licence_expiring').length === 2)
  fake.failing.clear()

  // ── 5. The Home feed ──────────────────────────────────────────────────────
  console.log('\n── the Home feed shows alerts in each persona’s idiom')
  const ownerFeed = await feed(U_OWNER, 'fleet_owner')
  const ownerAlerts = ownerFeed.items.filter((i: any) => i.type === 'alert')
  check('the owner sees their alerts, tagged fleet', ownerAlerts.length >= 4 && ownerAlerts.every((i: any) => i.tag === 'fleet'), JSON.stringify(ownerAlerts.map((i: any) => [i.tag, i.title])))
  check('critical alerts are urgent and target the booking', ownerAlerts.some((i: any) => i.priority === 'urgent' && i.target.booking_id === B_UNPAID && i.alert.kind === 'unpaid_overdue'))
  const driverFeed = await feed(U_DRIVER, 'driver')
  const driverAlerts = driverFeed.items.filter((i: any) => i.type === 'alert')
  check('the hired driver sees their own alerts, tagged driver', driverAlerts.length >= 2 && driverAlerts.every((i: any) => i.tag === 'driver'))
  check('no alert in the driver’s feed carries money', driverAlerts.every((i: any) => !/₹/.test(i.title + i.subtitle)), JSON.stringify(driverAlerts.map((i: any) => i.title)))
  const shipFeed = await feed(U_SHIP, 'shipper')
  check('the shipper sees the payment due, tagged shipper', shipFeed.items.some((i: any) => i.type === 'alert' && i.tag === 'shipper' && /Payment due/.test(i.title)))
  check('nobody sees another person’s alerts', !shipFeed.items.some((i: any) => i.type === 'alert' && i.tag !== 'shipper'))
  const aboutUnpaid = shipFeed.items.filter((i: any) => i.target?.booking_id === B_UNPAID && ['alert', 'payment_due'].includes(i.type))
  check('an overdue load asks the shipper once: the alert replaces the payment-due row',
    aboutUnpaid.length === 1 && aboutUnpaid[0].type === 'alert', JSON.stringify(aboutUnpaid.map((i: any) => i.type)))

  fake.missing.add('alerts')
  const pending = await feed(U_OWNER, 'fleet_owner')
  check('before 0042 the feed still answers, with no alerts and no degraded source',
    pending.items.every((i: any) => i.type !== 'alert') && !pending.degraded_sources.includes('alerts.open'), JSON.stringify(pending.degraded_sources))
  const pendingShip = await feed(U_SHIP, 'shipper')
  check('...and with no alert the shipper still gets the payment-due row',
    pendingShip.items.some((i: any) => i.type === 'payment_due' && i.target.booking_id === B_UNPAID), JSON.stringify(pendingShip.items.map((i: any) => i.type)))

  // ── 6. Overlapping sweeps ─────────────────────────────────────────────────
  // A slow run or a Scheduler retry can overlap the next tick. Both runs see no row for a new
  // problem and both insert; the unique dedupe_key refuses the second. That must read as
  // "already open", not fail the whole sweep half-way through.
  console.log('\n── two sweeps at once: one row, one email, no failure')
  seed()
  fake.store.location_history = fake.store.location_history.filter((l) => l.booking_id !== B_FLEET_TRANSIT)
  fake.store.location_history.push({ booking_id: B_FLEET_TRANSIT, recorded_at: ago(3 * 3_600_000) })
  const both = await Promise.all([sweep('frequent'), sweep('frequent')])
  check('both overlapping sweeps answer 200', both.every((res) => res.statusCode === 200), both.map((res) => res.statusCode).join(','))
  const runs = both.filter((res) => res.statusCode === 200).map(data)
  check('the problem is opened once between them', runs.reduce((n, x) => n + x.opened, 0) === 2 && fake.store.alerts.length === 2,
    JSON.stringify(runs.map((x) => x.opened)))
  check('and emailed once', mails().length === 2, String(mails().length))

  // The same race on the way back: a resolved problem returns and two runs both see it closed.
  fake.store.location_history.push({ booking_id: B_FLEET_TRANSIT, recorded_at: ago(60_000) })
  await sweep('frequent')
  fake.store.location_history = fake.store.location_history.filter((l) => l.booking_id !== B_FLEET_TRANSIT)
  fake.store.location_history.push({ booking_id: B_FLEET_TRANSIT, recorded_at: ago(3 * 3_600_000) })
  const again = (await Promise.all([sweep('frequent'), sweep('frequent')])).map(data)
  check('a returning problem is reopened once between them', again.reduce((n, x) => n + x.opened, 0) === 2 && open().length === 2,
    JSON.stringify(again.map((x) => x.opened)))
  check('and emailed once for the new episode', mails().length === 4, String(mails().length))

  await app.close()
  finish()
}
main().catch((err) => { console.error(err); process.exit(1) })
