/**
 * Authorization is CAPABILITY + RELATION, never the JWT role string (D-27).
 *
 * This suite pins the two halves of the de-role at once, against the REAL routes:
 *
 *   1. THE UNBLOCK — the cases the role string wrongly refused. A driver who owns
 *      a truck is a shipper the moment they post ('ship' is ungated) AND a carrier
 *      when they bid ('carry' == owns a truck). A distributor who posts a load and
 *      wins it with their own fleet holds BOTH relations to it, and the viewer
 *      block says so.
 *
 *   2. THE REGRESSION GUARD — every allow/deny a single-persona seeded user had is
 *      unchanged, because for them the old role check and the new capability check
 *      agree. A shipper who owns nothing still cannot bid; a booking can still only
 *      be created against your OWN price-lock; a stranger is still refused a
 *      booking they hold no relation to.
 *
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase and a
 * stubbed bt-pricing-service, same shape as consignee-party.e2e.mts.
 *
 * Run: npx tsx test/derole-capabilities.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.PRICING_SERVICE_URL = 'http://pricing.fake.local'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ── People. The point of each is which HALF of the rule it exercises. ────────
const U_OWNDRV = '11111111-1111-4111-8111-111111111111' // driver AND owns a truck
const U_DIST   = '22222222-2222-4222-8222-222222222222' // distributor: posts loads, runs a fleet
const U_BARE   = '33333333-3333-4333-8333-333333333333' // shipper, owns nothing
const U_POSTER = '44444444-4444-4444-8444-444444444444' // some other shipper, posts the open load

const D_OWN = 'aaaaaaaa-1111-4111-8111-111111111111'     // drivers.id of U_OWNDRV
const FO1   = 'bbbbbbbb-2222-4222-8222-222222222222'     // fleet_owners.id of U_DIST

const B_OPEN  = 'e1111111-1111-4111-8111-111111111111'   // U_POSTER's pending load, open to bids
const B_DIST  = 'e2222222-2222-4222-8222-222222222222'   // U_DIST's load, won by U_DIST's fleet
const B_OTHER = 'e3333333-3333-4333-8333-333333333333'   // U_POSTER's load, nobody else's business

const QUOTE_ID = 'f1111111-1111-4111-8111-111111111111'  // the price-lock the driver posts against

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

function reset() {
  store.users = [
    { id: U_OWNDRV, full_name: 'Owner Driver', phone_number: '9111111111', email: 'own@drv.in', gstin: '27AABCU9603R1ZM' },
    { id: U_DIST,   full_name: 'Bharat Distributors', phone_number: '9222222222', email: 'dist@ex.in', gstin: '27AABCU9603R1ZN' },
    { id: U_BARE,   full_name: 'Bare Shipper', phone_number: '9333333333', email: 'bare@ex.in', gstin: '27AABCU9603R1ZO' },
    { id: U_POSTER, full_name: 'Poster Shipper', phone_number: '9444444444', email: 'post@ex.in', gstin: '27AABCU9603R1ZP' },
  ]
  store.bookings = [
    { id: B_OPEN, shipper_id: U_POSTER, driver_id: null, fleet_owner_id: null, vehicle_id: null,
      status: 'pending', booking_type: 'direct', target_driver_id: null, quoted_price: 45000,
      final_price: null, min_acceptable: 30000, source_address: 'Mumbai', destination_address: 'Nagpur' },
    // U_DIST posted this AND their fleet won it (direct-attach or auction — the
    // column state is the same): both fleet_owner_id and shipper_id point at them.
    { id: B_DIST, shipper_id: U_DIST, driver_id: null, fleet_owner_id: FO1, vehicle_id: null,
      status: 'accepted', booking_type: 'direct', target_driver_id: null, quoted_price: 60000,
      final_price: 60000, min_acceptable: 40000, source_address: 'Mumbai', destination_address: 'Surat' },
    { id: B_OTHER, shipper_id: U_POSTER, driver_id: null, fleet_owner_id: null, vehicle_id: null,
      status: 'pending', booking_type: 'direct', target_driver_id: null, quoted_price: 20000,
      final_price: null, min_acceptable: 15000, source_address: 'Pune', destination_address: 'Goa' },
  ]
  store.drivers = [{ id: D_OWN, user_id: U_OWNDRV }]
  store.fleet_owners = [{ id: FO1, user_id: U_DIST, company_name: 'Bharat Distributors', is_active: true }]
  // Ownership is what grants 'carry'/'operate' — nothing is stored as a flag. The
  // driver owns one truck (carry); the distributor's fleet owns two (carry+operate).
  store.vehicles = [
    { id: 'v1', driver_id: D_OWN, fleet_owner_id: null },
    { id: 'v2', driver_id: null, fleet_owner_id: FO1 },
    { id: 'v3', driver_id: null, fleet_owner_id: FO1 },
  ]
  store.fleet_drivers = []
  store.quotes = []
  store.notification_outbox = []
  store.notification_preferences = []
}

// ── Fake Supabase — the operator surface these routes emit, incl. head/count
// selects (resolvePersonas counts owned trucks) and the quotes insert. ───────
class FakeQuery {
  private filters: Array<[string, string, any]> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  private head = false
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.head = true; return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  neq(c: string, v: any) { this.filters.push(['neq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  is(c: string, v: any) { this.filters.push(['is', c, v]); return this }
  not(c: string, _op: string, list: string) { this.filters.push(['notin', c, list.replace(/[()]/g, '').split(',')]); return this }
  or(expr: string) { this.filters.push(['or', expr, null]); return this }
  order() { return this }
  limit() { return this }
  private match(r: Row) {
    return this.filters.every(([o, c, v]) => {
      if (o === 'eq') return r[c] === v
      if (o === 'neq') return r[c] !== v
      if (o === 'in') return (v as any[]).includes(r[c])
      if (o === 'is') return (r[c] ?? null) === v
      if (o === 'or') return String(c).split(',').some((t) => { const [col, , val] = t.split('.'); return String(r[col] ?? '') === val })
      return !(v as any[]).includes(r[c])
    })
  }
  private run() {
    const rows = store[this.table] ?? (store[this.table] = [])
    if (this.mode === 'insert') { const row = { id: `r${rows.length + 1}`, ...this.payload }; rows.push(row); return { data: [row], count: 1, error: null } }
    const hit = rows.filter((r) => this.match(r))
    if (this.mode === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return { data: hit, count: hit.length, error: null } }
    return { data: this.head ? null : hit, count: hit.length, error: null }
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.length ? r.data[0] : null, error: r.error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// ── Stubbed bt-pricing-service. The lock is owned by U_OWNDRV and matches the
// create body below; /consume always succeeds. ──────────────────────────────
const LOCKED_QUOTE = {
  id: QUOTE_ID, shipper_id: U_OWNDRV, quoted_price: 47000, currency: 'INR',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), consumed_at: null, consumed_by_booking_id: null,
  source_lat: 19.076, source_lng: 72.8777, dest_lat: 21.1458, dest_lng: 79.0882, distance_km: 840,
  vehicle_type: 'hcv', load_type: 'general', weight_kg: 9000, breakdown_json: {},
}
globalThis.fetch = (async (url: string | URL) => {
  const href = String(url)
  const body = href.endsWith('/consume')
    ? { success: true, data: { ...LOCKED_QUOTE, consumed_at: new Date().toISOString() } }
    : { success: true, data: LOCKED_QUOTE }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

const CREATE_BODY = {
  quote_id: QUOTE_ID, source_address: 'Bhiwandi', source_lat: 19.076, source_lng: 72.8777,
  destination_address: 'Nagpur', dest_lat: 21.1458, dest_lng: 79.0882, load_type: 'general',
  weight_kg: 9000, vehicle_type: 'hcv', receiver_email: 'consignee@acme.co.in',
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')
  const { quoteRoutes } = await import('../src/routes/quotes.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(bookingRoutes, { prefix: '/bookings' })
    await a.register(quoteRoutes, { prefix: '/bookings' })
  })
  await app.ready()

  const create = (token: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/bookings', headers: { authorization: `Bearer ${token}` },
    payload: { ...CREATE_BODY, pickup_date: tomorrow(), ...extra } as any,
  })
  const bid = (id: string, token: string, amount = 40000) => app.inject({
    method: 'POST', url: `/bookings/${id}/quotes`, headers: { authorization: `Bearer ${token}` }, payload: { amount } as any,
  })
  const get = (id: string, token: string) => app.inject({
    method: 'GET', url: `/bookings/${id}`, headers: { authorization: `Bearer ${token}` },
  })
  const accept = (id: string, token: string) => app.inject({
    method: 'PATCH', url: `/bookings/${id}/accept`, headers: { authorization: `Bearer ${token}` },
  })

  // ── THE UNBLOCK ─────────────────────────────────────────────────────────────
  console.log('\n── a truck-owning driver posts a load ("ship" is ungated)')
  reset()
  // A 'driver'-role token whose human owns a truck. The old `role !== 'shipper'`
  // gate 403'd this; posting is now open to everyone with a valid account.
  let res = await create(tok(U_OWNDRV, 'driver'))
  check('driver-role token creates a booking 201', res.statusCode === 201, res.body.slice(0, 200))
  check('the booking is theirs', JSON.parse(res.body).data?.shipper_id === U_OWNDRV, res.body.slice(0, 120))

  console.log('\n── a truck-owning driver bids ("carry" == owns a truck)')
  reset()
  res = await bid(B_OPEN, tok(U_OWNDRV, 'driver'))
  check('truck-owning driver submits a quote 201', res.statusCode === 201, res.body.slice(0, 200))
  check('a quote row was written for their driver id',
    store.quotes.length === 1 && store.quotes[0].driver_id === D_OWN, JSON.stringify(store.quotes))

  console.log('\n── a distributor holds BOTH relations to their own won load')
  reset()
  res = await get(B_DIST, tok(U_DIST, 'shipper'))
  check('distributor reads their own load 200', res.statusCode === 200, String(res.statusCode))
  {
    const viewer = JSON.parse(res.body).data?.viewer
    check('viewer.relations includes shipper (they posted it)', viewer?.relations?.includes('shipper') === true, JSON.stringify(viewer))
    check('viewer.relations includes carrier (their fleet won it)', viewer?.relations?.includes('carrier') === true, JSON.stringify(viewer))
    check('viewer.sees_commercials true for the owning party', viewer?.sees_commercials === true, JSON.stringify(viewer))
  }
  // The role string does not decide: the SAME human on a fleet_owner-role token
  // gets the SAME two relations, because they are computed from what they own.
  res = await get(B_DIST, tok(U_DIST, 'fleet_owner'))
  check('same answer on a fleet_owner-role token', JSON.parse(res.body).data?.viewer?.relations?.includes('shipper') === true
    && JSON.parse(res.body).data?.viewer?.relations?.includes('carrier') === true, res.body.slice(0, 160))

  // ── THE REGRESSION GUARD ────────────────────────────────────────────────────
  console.log('\n── single-persona decisions are unchanged')
  reset()
  // A shipper who owns nothing still cannot bid — 'carry'/'operate' both absent.
  res = await bid(B_OPEN, tok(U_BARE, 'shipper'))
  check('a shipper who owns nothing still cannot bid 403', res.statusCode === 403, String(res.statusCode))
  check('and no quote row was written', store.quotes.length === 0, JSON.stringify(store.quotes))

  // A booking can still only be created against your OWN price-lock (the lock is
  // U_OWNDRV's; U_BARE naming it is refused exactly as before).
  res = await create(tok(U_BARE, 'shipper'))
  check("someone else's price-lock is still 403", res.statusCode === 403, res.body.slice(0, 160))

  // A ship-only poster with no relation to a stranger's booking is still refused,
  // and still 403 (not 404) — the role-era shipper gate, de-roled but unchanged.
  res = await get(B_OTHER, tok(U_BARE, 'shipper'))
  check('a stranger is still refused a booking they hold no relation to 403', res.statusCode === 403, String(res.statusCode))

  // ── review F15/F16: the instant-accept award path ──────────────────────────
  console.log('\n── a solo driver instant-accepting an open load closes the market (F16)')
  reset()
  const B_TARGET_ME    = 'e4444444-4444-4444-8444-444444444444'
  const B_TARGET_OTHER = 'e5555555-5555-4555-8555-555555555555'
  const D_STRANGER     = 'a9999999-9999-4999-8999-999999999999'
  // A live competing bid from the distributor's fleet on U_POSTER's open load.
  store.quotes.push({ id: 'q-lose', booking_id: B_OPEN, driver_id: null, fleet_owner_id: FO1, amount: 44000, status: 'submitted' })
  // Two direct bookings earmarked at specific drivers (one at U_OWNDRV, one at a stranger).
  const targetRow = (id: string, target: string) => ({
    id, shipper_id: U_POSTER, driver_id: null, fleet_owner_id: null, vehicle_id: null,
    status: 'pending', booking_type: 'direct', target_driver_id: target, quoted_price: 30000,
    final_price: null, min_acceptable: 20000, source_address: 'Pune', destination_address: 'Goa',
  })
  store.bookings.push(targetRow(B_TARGET_ME, D_OWN), targetRow(B_TARGET_OTHER, D_STRANGER))

  res = await accept(B_OPEN, tok(U_OWNDRV, 'driver'))
  check('solo owner-driver instant-accepts the open load 200', res.statusCode === 200, res.body.slice(0, 200))
  check('the booking is bound to them', store.bookings.find((b) => b.id === B_OPEN)?.driver_id === D_OWN)
  check('🔴 the competing live bid is EXPIRED, not orphaned (F16)',
    store.quotes.find((q) => q.id === 'q-lose')?.status === 'expired',
    String(store.quotes.find((q) => q.id === 'q-lose')?.status))
  check('🔴 the losing bidder is told they lost (F16)',
    store.notification_outbox.some((r) => r.event_type === 'quote_lost'),
    JSON.stringify(store.notification_outbox.map((r) => r.event_type)))

  console.log('\n── a targeted direct load is not open to another driver (F15)')
  res = await accept(B_TARGET_OTHER, tok(U_OWNDRV, 'driver'))
  check('🔴 a non-target driver cannot accept a targeted load 403 (F15)', res.statusCode === 403, String(res.statusCode))
  // U_OWNDRV is still bound to B_OPEN from the instant-accept above, and a driver may
  // only hold ONE live trip (driver-schedule.ts). That is a different rule from the one
  // under test here, so finish the first trip rather than assert the targeting rule
  // through a driver who is not free — otherwise this check would pass or fail for a
  // reason that has nothing to do with F15.
  store.bookings.find((b) => b.id === B_OPEN)!.status = 'completed'

  res = await accept(B_TARGET_ME, tok(U_OWNDRV, 'driver'))
  check('the targeted driver CAN accept their earmarked load 200', res.statusCode === 200, res.body.slice(0, 200))

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((err) => { console.error(err); process.exit(1) })
