/**
 * GET /me/summary — one dashboard per person, against the REAL route (app.inject) and an
 * in-memory fake Supabase. Pins:
 *
 *   1. Panels follow capabilities, never a role flag: a pure shipper gets 'shipments'; an
 *      owner-driver 'truck' + 'driving'; a hired driver only 'driving'; a fleet owner
 *      'fleet'; a brand-new account nothing — and the front door orders them (D-32).
 *   2. Money follows ownership (§1.1): the driving panel carries no amounts at all, and the
 *      truck panel counts only trips on the person's own truck — a fleet-assigned trip's
 *      money is the fleet's.
 *   3. The figures: this month's paid spend / earnings, what is due and how old, live bids,
 *      loads on the road, lanes, average transit time from the status history.
 *   4. No cross-user leakage, and the panel still answers before migration 0041 exists.
 *
 * Run: npx tsx test/me-summary.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()
const { istMonthStart } = await import('../src/lib/ist.js')

const U_SHIP = '10000000-0000-4000-8000-000000000001'
const U_OTHER = '10000000-0000-4000-8000-000000000009'
const U_OWNDRV = '20000000-0000-4000-8000-000000000002'
const U_HIRED = '30000000-0000-4000-8000-000000000003'
const U_FLEET = '40000000-0000-4000-8000-000000000004'
const U_NEW = '50000000-0000-4000-8000-000000000005'
const D_OWN = 'd0000000-0000-4000-8000-000000000002'
const D_HIRED = 'd0000000-0000-4000-8000-000000000003'
const FO = 'f0000000-0000-4000-8000-000000000004'
const FO_X = 'f0000000-0000-4000-8000-0000000000aa'

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()
const monthStart = istMonthStart(new Date(now)).getTime()
const lastMonth = new Date(monthStart - DAY).toISOString() // always before this IST month
const istDay = (offsetDays: number) => new Date(now + offsetDays * DAY + 5.5 * HOUR).toISOString().slice(0, 10)

let n = 0
function booking(over: Record<string, unknown>) {
  return {
    id: `b0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, shipper_id: U_OTHER, driver_id: null, fleet_owner_id: null,
    status: 'pending', source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur',
    pickup_date: istDay(1), load_type: 'Steel coils', weight_kg: 12000, quoted_price: 48000, final_price: null,
    created_at: ago(1 * MIN), updated_at: ago(1 * MIN), ...over,
  }
}

const ids: Record<string, string> = {}
function seed() {
  fake.reset()
  n = 0
  const s = fake.store
  s.users = [U_SHIP, U_OTHER, U_OWNDRV, U_HIRED, U_FLEET, U_NEW].map((id) => ({ id, email: `${id.slice(0, 2)}@ex.in` }))
  s.drivers = [{ id: D_OWN, user_id: U_OWNDRV }, { id: D_HIRED, user_id: U_HIRED }]
  s.fleet_owners = [{ id: FO, user_id: U_FLEET, company_name: 'Sharma Roadlines' }, { id: FO_X, user_id: U_OTHER, company_name: 'Other Fleet' }]
  s.fleet_drivers = [{ id: 'fd-1', fleet_owner_id: FO, driver_id: D_HIRED, status: 'active' }]
  s.vehicles = [
    { id: 'v-own', rc_number: 'MH40 BG 2211', driver_id: D_OWN, fleet_owner_id: null },
    { id: 'v-f1', rc_number: 'MH12 AB 1234', driver_id: null, fleet_owner_id: FO },
    { id: 'v-f2', rc_number: 'MH12 AB 5678', driver_id: null, fleet_owner_id: FO },
  ]
  s.vehicle_finance = [{ vehicle_id: 'v-own', emi_amount_inr: '52000.00' }]
  s.driver_licenses = [{ driver_id: D_OWN, dl_number: 'MH40 2019 0002', expiry_date: istDay(20) }]

  // The shipper's loads (and one from another shipper that must never leak in).
  const sPaid = booking({ shipper_id: U_SHIP, status: 'paid', final_price: 50000 })
  const sDue = booking({ shipper_id: U_SHIP, status: 'completed', final_price: 30000, created_at: lastMonth, updated_at: lastMonth })
  const sTransit = booking({ shipper_id: U_SHIP, status: 'in_transit', destination_address: 'Hyderabad' })
  const sOpen = booking({ shipper_id: U_SHIP, status: 'pending' })
  const other = booking({ shipper_id: U_OTHER, status: 'paid', final_price: 99999 })
  // The owner-driver's trips: own truck vs a fleet's assignment.
  const oPaid = booking({ driver_id: D_OWN, status: 'paid', final_price: 40000 })
  const oFleetPaid = booking({ driver_id: D_OWN, fleet_owner_id: FO_X, status: 'paid', final_price: 99999 })
  const oDue = booking({ driver_id: D_OWN, status: 'completed', final_price: 30000, updated_at: ago(4 * DAY) })
  const oTransit = booking({ driver_id: D_OWN, status: 'in_transit', updated_at: ago(2 * HOUR) })
  const oNext = booking({ driver_id: D_OWN, status: 'accepted', pickup_date: istDay(1) })
  // The hired driver's fleet trip — its price must not appear anywhere in their summary.
  const hAccepted = booking({ driver_id: D_HIRED, fleet_owner_id: FO, status: 'accepted', final_price: 77777, quoted_price: 77777 })
  s.bookings = [sPaid, sDue, sTransit, sOpen, other, oPaid, oFleetPaid, oDue, oTransit, oNext, hAccepted]
  Object.assign(ids, { sPaid: sPaid.id, sDue: sDue.id, sTransit: sTransit.id, sOpen: sOpen.id, oTransit: oTransit.id, oNext: oNext.id, hAccepted: hAccepted.id })

  s.booking_milestones = [
    { booking_id: sPaid.id, started_at: ago(2 * HOUR), delivered_at: ago(1 * HOUR), paid_at: ago(1 * MIN), has_backfill: false },
    { booking_id: sDue.id, started_at: new Date(monthStart - 2 * DAY).toISOString(), delivered_at: lastMonth, paid_at: null, has_backfill: false },
    { booking_id: sTransit.id, started_at: ago(3 * HOUR), delivered_at: null, paid_at: null, has_backfill: false },
    { booking_id: oPaid.id, started_at: ago(5 * HOUR), delivered_at: ago(2 * HOUR), paid_at: ago(1 * MIN), has_backfill: false },
    { booking_id: oDue.id, started_at: ago(5 * DAY), delivered_at: ago(4 * DAY), paid_at: null, has_backfill: false },
    { booking_id: oTransit.id, started_at: ago(2 * HOUR), delivered_at: null, paid_at: null, has_backfill: false },
  ]
  s.quotes = [
    { id: 'q1', booking_id: sOpen.id, status: 'submitted', driver_id: D_OWN, submitted_at: ago(MIN), updated_at: ago(MIN) },
    { id: 'q2', booking_id: sOpen.id, status: 'countered', fleet_owner_id: FO, submitted_at: ago(MIN), updated_at: ago(MIN) },
    { id: 'q3', booking_id: other.id, status: 'countered', driver_id: D_OWN, submitted_at: ago(MIN), updated_at: ago(MIN) },
  ]
  s.alerts = [{ id: 'a1', audience_user_id: U_SHIP, persona: 'shipper', kind: 'unpaid_overdue', severity: 'warning', resolved_at: null, opened_at: ago(HOUR) }]
}

const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { summaryRoutes } = await import('../src/routes/summary.js')
  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(summaryRoutes, { prefix: '/me' }) })
  await app.ready()

  const summary = async (u: string, role: string) => {
    const res = await app.inject({ method: 'GET', url: '/me/summary', headers: { authorization: `Bearer ${tok(u, role)}` } })
    return { status: res.statusCode, data: JSON.parse(res.body).data }
  }
  const hasMoney = (o: unknown) => /price|_inr|amount/i.test(JSON.stringify(Object.keys(flatten(o)))) || /77777|99999/.test(JSON.stringify(o))
  const flatten = (o: any, acc: Record<string, unknown> = {}): Record<string, unknown> => {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc[k] = v; flatten(v, acc) }
    return acc
  }

  // ── 1. A pure shipper ─────────────────────────────────────────────────────
  console.log('\n── a shipper sees their shipments, and only theirs')
  seed()
  let { status, data } = await summary(U_SHIP, 'shipper')
  check('200', status === 200, String(status))
  check('panels: shipments only', JSON.stringify(data.panels) === '["shipments"]', JSON.stringify(data.panels))
  const sh = data.shipments
  check('paid this month is the one load paid this month', sh.month.paid_inr === 50000, JSON.stringify(sh.month))
  check('loads posted this month excludes last month’s', sh.month.posted === 3, JSON.stringify(sh.month))
  check('delivered this month counts by DELIVERY time, not last update', sh.month.delivered === 1, JSON.stringify(sh.month))
  check('average transit comes from the status history (1 h)', sh.month.avg_transit_hours === 1, JSON.stringify(sh.month))
  const expectAge = Math.floor((now - Date.parse(lastMonth)) / DAY)
  check('due: the unpaid delivery, aged from delivery', sh.due.amount_inr === 30000 && sh.due.trips === 1 && sh.due.oldest_days === expectAge, JSON.stringify(sh.due))
  check('bids waiting: 2 live bids on 1 open load', sh.bids_waiting.bids === 2 && sh.bids_waiting.loads === 1, JSON.stringify(sh.bids_waiting))
  check('on the road: the in-transit load, as cities', sh.on_the_road.length === 1 && sh.on_the_road[0].from === 'Mumbai' && sh.on_the_road[0].to === 'Hyderabad', JSON.stringify(sh.on_the_road))
  check('lanes: Mumbai → Nagpur with its spend', sh.lanes.some((l: any) => l.lane === 'Mumbai → Nagpur' && l.spend_inr === 80000 && l.loads === 2), JSON.stringify(sh.lanes))
  check('their open alert is counted', sh.open_alerts === 1)
  check('another shipper’s load never leaks in', !JSON.stringify(data).includes('99999'))

  // ── 2. An owner-driver ────────────────────────────────────────────────────
  console.log('\n── an owner-driver sees their truck and their driving')
  ;({ status, data } = await summary(U_OWNDRV, 'driver'))
  check('panels: truck then driving (driver front door)', JSON.stringify(data.panels) === '["truck","driving"]', JSON.stringify(data.panels))
  const tr = data.truck
  check('their own truck', tr.vehicle?.rc_number === 'MH40 BG 2211', JSON.stringify(tr.vehicle))
  check('earned this month counts ONLY their own truck’s trips', tr.month.earned_inr === 40000 && tr.month.trips_paid === 1, JSON.stringify(tr.month))
  check('the EMI comes from the truck’s finance row', tr.month.emi_inr === 52000, JSON.stringify(tr.month))
  check('owed: the delivered-unpaid own trip, 4 days old', tr.owed.amount_inr === 30000 && tr.owed.trips === 1 && tr.owed.oldest_days === 4, JSON.stringify(tr.owed))
  check('in progress: the moving trip and the next one', tr.in_progress === 2, String(tr.in_progress))
  // q1 (live) and q3 (countered) are theirs; q2 is a FLEET's counter and must not count.
  check('bids: their own — 1 live, 1 countered', tr.bids.live === 1 && tr.bids.countered === 1, JSON.stringify(tr.bids))
  const dr = data.driving
  check('driving: the moving trip is the current one', dr.current_trip?.booking_id === ids.oTransit && dr.current_trip.started_at, JSON.stringify(dr.current_trip))
  check('driving: the accepted trip is coming up', dr.upcoming.some((t: any) => t.booking_id === ids.oNext))
  check('driving: licence days left', dr.licence?.days_left === 20, JSON.stringify(dr.licence))
  check('the driving panel carries no money at all', !hasMoney(dr), JSON.stringify(dr))

  // ── 3. A hired driver ─────────────────────────────────────────────────────
  console.log('\n── a hired driver sees driving only, and no money')
  ;({ status, data } = await summary(U_HIRED, 'driver'))
  check('panels: driving only', JSON.stringify(data.panels) === '["driving"]', JSON.stringify(data.panels))
  check('no truck panel for someone who owns no truck', data.truck === null)
  check('their fleet trip is the current one', data.driving.current_trip?.booking_id === ids.hAccepted)
  check('the fleet trip’s price appears nowhere in the response', !hasMoney(data.driving) && !JSON.stringify(data).includes('77777'), JSON.stringify(data.driving))

  // ── 4. A fleet owner and a new account ────────────────────────────────────
  console.log('\n── a fleet owner gets the fleet panel; a new account gets nothing')
  ;({ data } = await summary(U_FLEET, 'fleet_owner'))
  check('fleet owner: panels = fleet', JSON.stringify(data.panels) === '["fleet"]', JSON.stringify(data.panels))
  ;({ status, data } = await summary(U_NEW, 'shipper'))
  check('new account: 200 with no panels', status === 200 && data.panels.length === 0 && !data.driving && !data.truck && !data.shipments, JSON.stringify(data))

  // ── 5. Before migration 0041 ──────────────────────────────────────────────
  console.log('\n── before the status history exists, the summary still answers')
  fake.missing.add('booking_milestones')
  ;({ status, data } = await summary(U_SHIP, 'shipper'))
  check('200 with no degraded section', status === 200 && data.degraded_sections.length === 0, JSON.stringify(data.degraded_sections))
  check('paid this month falls back to the last update', data.shipments.month.paid_inr === 50000, JSON.stringify(data.shipments.month))
  check('no history means no average transit time (not a made-up one)', data.shipments.month.avg_transit_hours === null)

  await app.close()
  finish()
}
main().catch((err) => { console.error(err); process.exit(1) })
