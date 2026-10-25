/**
 * Wave 1 alerts end to end: the REAL POST /internal/alerts/sweep against an in-memory Supabase,
 * seeded so each new rule has one trip that should fire and one that should not. Pins that the
 * fact loaders read the right tables, that alerts open, refresh, resolve when the problem is
 * fixed, and that "documents not ready" agrees with the Start-trip gate.
 *
 * Run: npx tsx test/alerts-wave1-sweep.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'

import Fastify from 'fastify'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()

const U_OWNER = '10000000-0000-4000-8000-000000000001'
const U_SHIP = '30000000-0000-4000-8000-000000000003'
const U_SOLO = '40000000-0000-4000-8000-000000000004'
const FO = 'f0000000-0000-4000-8000-000000000001'
const D_SOLO = 'd0000000-0000-4000-8000-000000000004'
const B = (n: number) => `b0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`

const HOUR = 3_600_000, DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString()
const istDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY + 5.5 * HOUR).toISOString().slice(0, 10)

function seed() {
  fake.reset()
  const s = fake.store
  s.users = [
    { id: U_OWNER, full_name: 'Sharma Roadlines', email: 'owner@ex.in', role: 'fleet_owner' },
    { id: U_SHIP, full_name: 'Anita Exports', email: 'anita@ex.in', role: 'shipper' },
    { id: U_SOLO, full_name: 'Sandeep Yadav', email: 'sandeep@ex.in', role: 'driver' },
  ]
  s.drivers = [{ id: D_SOLO, user_id: U_SOLO }]
  s.fleet_owners = [{ id: FO, user_id: U_OWNER, company_name: 'Sharma Roadlines', is_active: true }]
  const base = { shipper_id: U_SHIP, source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur',
    quoted_price: 48000, final_price: 52000, created_at: ago(20 * DAY), booking_type: 'auction', target_driver_id: null }
  s.bookings = [
    // #2 in transit, bill lapses in 3 h → fires; B(2) bill good for 2 days → quiet
    { ...base, id: B(1), status: 'in_transit', fleet_owner_id: FO, driver_id: null, pickup_date: istDay(-1), updated_at: ago(HOUR) },
    { ...base, id: B(2), status: 'in_transit', fleet_owner_id: FO, driver_id: null, pickup_date: istDay(-1), updated_at: ago(HOUR) },
    // #4/#5 accepted fleet load picking up tomorrow, no invoice and no truck → both fire
    { ...base, id: B(3), status: 'accepted', fleet_owner_id: FO, driver_id: null, pickup_date: istDay(1), updated_at: ago(DAY) },
    // #12 asserted 30 h ago → fires
    { ...base, id: B(4), status: 'delivery_asserted', fleet_owner_id: null, driver_id: D_SOLO, pickup_date: istDay(-3), updated_at: ago(30 * HOUR) },
    // #14 auction posted 8 h ago, no bids → fires; B(6) has a bid → quiet
    { ...base, id: B(5), status: 'pending', fleet_owner_id: null, driver_id: null, pickup_date: istDay(3), updated_at: ago(8 * HOUR), created_at: ago(8 * HOUR) },
    { ...base, id: B(6), status: 'pending', fleet_owner_id: null, driver_id: null, pickup_date: istDay(3), updated_at: ago(8 * HOUR), created_at: ago(8 * HOUR) },
    // #8 damage on a completed, unpaid trip; #3 delivered 3.2 km away
    { ...base, id: B(7), status: 'completed', fleet_owner_id: FO, driver_id: null, pickup_date: istDay(-4), updated_at: ago(DAY) },
  ]
  s.eway_bill_records = [
    { booking_id: B(1), ewb_number: '331001112223', valid_upto: ahead(3 * HOUR), status: 'active', recorded_at: ago(DAY) },
    { booking_id: B(2), ewb_number: '331001112224', valid_upto: ahead(2 * DAY), status: 'active', recorded_at: ago(DAY) },
  ]
  s.geofence_events = [
    { booking_id: B(2), kind: 'drop', event: 'enter', occurred_at: ago(3 * HOUR) }, // #7 at the drop 3 h
  ]
  s.pod_state = [{ booking_id: B(4), asserted_at: ago(30 * HOUR) }]
  s.quotes = [{ booking_id: B(6), status: 'submitted' }]
  s.pod_discrepancies = [{ booking_id: B(7), reason: 'damage', delta: -3, quantity_unit: 'boxes', created_at: ago(2 * HOUR) }]
  s.pod_audit_log = [{ booking_id: B(7), action: 'otp_gate_block', detail: { distance_m: 3200 } }]
  s.pod_evidence = []
  s.vehicle_assignments = []
  s.freight_invoices = []
  s.lorry_receipts = []
  // #22 a fleet truck idle 9 days, and one that worked yesterday
  s.vehicles = [
    { id: 'v-idle', rc_number: 'MH12AB1234', fleet_owner_id: FO, driver_id: null, is_active: true, created_at: ago(60 * DAY) },
    { id: 'v-busy', rc_number: 'MH12CD5678', fleet_owner_id: FO, driver_id: null, is_active: true, created_at: ago(60 * DAY) },
    { id: 'v-off', rc_number: 'MH12EF9012', fleet_owner_id: FO, driver_id: null, is_active: false, created_at: ago(60 * DAY) },
  ]
  s.bookings.push({ ...base, id: B(8), status: 'paid', fleet_owner_id: FO, driver_id: null, vehicle_id: 'v-busy', pickup_date: istDay(-2), updated_at: ago(DAY) })
  s.bookings.push({ ...base, id: B(9), status: 'paid', fleet_owner_id: FO, driver_id: null, vehicle_id: 'v-idle', pickup_date: istDay(-12), updated_at: ago(9 * DAY) })
  s.location_history = []
  s.booking_milestones = []
  s.driver_licenses = []
  s.fleet_drivers = []
  s.alerts = []
  s.notification_outbox = []
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const internalAuthPlugin = (await import('../src/plugins/internal-auth.js')).default
  const { internalRoutes } = await import('../src/routes/internal.js')
  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(internalAuthPlugin); await a.register(internalRoutes, { prefix: '/internal' }) })
  await app.ready()
  const sweep = async (cadence: string) => JSON.parse((await app.inject({ method: 'POST', url: `/internal/alerts/sweep?cadence=${cadence}`, headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET! } })).body).data
  const open = (kind?: string) => fake.store.alerts.filter((a: any) => !a.resolved_at && (!kind || a.kind === kind))
  const subjects = (kind: string) => [...new Set(open(kind).map((a: any) => a.subject_id))]

  console.log('\n── frequent sweep')
  seed()
  let r = await sweep('frequent')
  check('no frequent kind failed to load its facts', r.failed_kinds.length === 0, JSON.stringify(r.failed_kinds))
  check('#2 e-way bill lapsing in 3 h → only that trip, shipper + fleet owner', JSON.stringify(subjects('ewb_expiring')) === JSON.stringify([B(1)]) && open('ewb_expiring').length === 2)
  check('#7 at the drop 3 h → that trip', JSON.stringify(subjects('at_drop_not_delivered')) === JSON.stringify([B(2)]))
  check('#14 no bids → only the load without a bid, to the shipper', JSON.stringify(subjects('no_bids')) === JSON.stringify([B(5)]) && open('no_bids')[0].audience_user_id === U_SHIP)
  check('#8 damage → shipper + fleet owner', JSON.stringify(subjects('damage_reported')) === JSON.stringify([B(7)]) && open('damage_reported').length === 2)
  check('#3 delivered 3.2 km away → that trip', JSON.stringify(subjects('delivered_away')) === JSON.stringify([B(7)]))
  check('daily kinds are not touched by a frequent sweep', open('truck_idle').length === 0 && open('documents_not_ready').length === 0)

  r = await sweep('frequent')
  check('a re-run refreshes, never duplicates', r.opened === 0 && fake.store.alerts.length === open().length, JSON.stringify(r))

  fake.store.eway_bill_records[0].valid_upto = ahead(2 * DAY) // the shipper extended the bill
  fake.store.quotes.push({ booking_id: B(5), status: 'submitted' }) // a carrier bid
  fake.store.bookings.find((b: any) => b.id === B(7)).status = 'paid' // the trip settled
  r = await sweep('frequent')
  check('fixing each problem resolves its alerts (bill extended, bid in, trip paid)', open('ewb_expiring').length === 0 && open('no_bids').length === 0 && open('damage_reported').length === 0 && open('delivered_away').length === 0, JSON.stringify(r))

  console.log('\n── daily sweep')
  seed()
  r = await sweep('daily')
  check('no daily kind failed to load its facts', r.failed_kinds.length === 0, JSON.stringify(r.failed_kinds))
  const docs = open('documents_not_ready')
  check('#4 pickup tomorrow, no invoice → the shipper is warned (same rule as Start trip)', docs.some((a: any) => a.subject_id === B(3) && a.audience_user_id === U_SHIP && /tax invoice/.test(a.title)), JSON.stringify(docs.map((a: any) => a.title)))
  check('#4 …and the LR is advisory, to the fleet owner as info', docs.some((a: any) => a.subject_id === B(3) && a.audience_user_id === U_OWNER && a.severity === 'info'))
  check('#5 pickup tomorrow, no truck assigned → fleet owner', JSON.stringify(subjects('pickup_no_truck')) === JSON.stringify([B(3)]))
  check('#12 asserted 30 h ago → shipper + the solo driver as carrier', JSON.stringify(subjects('delivery_unconfirmed')) === JSON.stringify([B(4)]) && open('delivery_unconfirmed').some((a: any) => a.audience_user_id === U_SOLO && a.persona === 'carrier'))
  check('#22 only the truck idle 9 days (not the one that worked yesterday, not the deactivated one)', JSON.stringify(subjects('truck_idle')) === JSON.stringify(['v-idle']))

  // The shipper issues the invoice (inter-state, under the e-way threshold) and the owner assigns a truck.
  fake.store.freight_invoices.push({ booking_id: B(3), consignment_value_inr: 40000, supplier_gstin: '27AAPFU0939F1ZV', billed_to_gstin: '29AAPFU0939F1ZV', billed_to_state_code: '29' })
  fake.store.vehicle_assignments.push({ booking_id: B(3), vehicle_id: 'v-idle', released_at: null })
  r = await sweep('daily')
  check('invoice issued (no e-way needed under ₹50k inter-state) → the shipper\'s document alert resolves', !open('documents_not_ready').some((a: any) => a.audience_user_id === U_SHIP), JSON.stringify(open('documents_not_ready').map((a: any) => a.title)))
  check('truck assigned → pickup alert resolves', open('pickup_no_truck').length === 0)

  await app.close()
  finish()
}
main().catch((e) => { console.error(e); process.exit(1) })
