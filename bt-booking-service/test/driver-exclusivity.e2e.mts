/**
 * One driver, one live trip — across the THREE paths that bind bookings.driver_id
 * without a vehicle_assignments row behind them (review C-2).
 *
 * WHY THIS SUITE EXISTS. bt-fleet-service enforces this properly for its own dispatch:
 * three partial-unique indexes on vehicle_assignments (0016) plus assertVehicleAvailable
 * in front of them. A platform review concluded from that path's stale UI selector that
 * assignment was unlocked; it is not — that path is the best-defended code in the repo.
 * The real hole was next door. A SOLO driver never gets a vehicle_assignments row, so
 * those indexes cannot see them, and `bookings` carries only plain non-unique indexes on
 * driver_id. One owner-driver could win five auctions at once.
 *
 * THE CONTROLS MATTER AS MUCH AS THE REFUSALS, and they are the reason this file is
 * longer than the fix. A guard on "is this driver busy" can very easily also stop a
 * driver who has DELIVERED from taking the next load (the wrong terminal-status list),
 * stop a FLEET winning an auction (no driver is bound on that path at all), or turn a
 * retried request into a 409. Each of those would be a worse bug than the one being
 * fixed, so each is pinned below.
 *
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase.
 * Run: npx tsx test/driver-exclusivity.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ---- fixtures -------------------------------------------------------------
const U_SHIPPER = '11111111-1111-4111-8111-111111111111' // posts loads, owns nothing
const U_SHIP2   = '12121212-1212-4121-8121-121212121212' // a second, unrelated shipper
const U_OWNDRV  = '22222222-2222-4222-8222-222222222222' // owner-driver: one truck, one person
const U_DIST    = '33333333-3333-4333-8333-333333333333' // distributor: posts loads, runs a fleet

const D_OWN = 'bbbbbbbb-2222-4222-8222-222222222222'     // drivers.id of U_OWNDRV
const FO1   = 'aaaaaaaa-3333-4333-8333-333333333333'     // fleet_owners.id of U_DIST

const B_LIVE    = 'e1111111-1111-4111-8111-111111111111' // the trip already holding D_OWN
const B_SECOND  = 'e2222222-2222-4222-8222-222222222222' // the load they must not also take
const B_INSTANT = 'e3333333-3333-4333-8333-333333333333' // an open load, for /accept
const B_FLEET   = 'e4444444-4444-4444-8444-444444444444' // an auction a FLEET wins
const B_OWN     = 'e5555555-5555-4555-8555-555555555555' // U_OWNDRV's OWN load, for direct-attach

const Q_SECOND = 'f2222222-2222-4222-8222-222222222222'  // D_OWN's bid on B_SECOND
const Q_FLEET  = 'f4444444-4444-4444-8444-444444444444'  // FO1's bid on B_FLEET

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

const booking = (id: string, shipperId: string, extra: Row = {}): Row => ({
  id,
  shipper_id: shipperId,
  driver_id: null,
  fleet_owner_id: null,
  vehicle_id: null,
  awarded_quote_id: null,
  award_path: 'auction',
  status: 'pending',
  booking_type: 'auction',
  quoted_price: 45000,
  final_price: null,
  source_address: 'Mumbai',
  destination_address: 'Raipur',
  load_type: 'general',
  weight_kg: 12000,
  pickup_date: '2026-08-20',
  ...extra,
})

function reset() {
  store.bookings = [
    // D_OWN is ALREADY OUT on this one. Every refusal below is against this trip.
    booking(B_LIVE, U_SHIPPER, { status: 'in_transit', driver_id: D_OWN, award_path: 'instant' }),
    booking(B_SECOND, U_SHIP2),
    booking(B_INSTANT, U_SHIP2, { booking_type: 'direct' }),
    booking(B_FLEET, U_SHIPPER),
    booking(B_OWN, U_OWNDRV, { booking_type: 'direct' }),
  ]
  store.drivers = [{ id: D_OWN, user_id: U_OWNDRV, truck_number: 'MH04 1111' }]
  store.fleet_owners = [{ id: FO1, user_id: U_DIST, company_name: 'Bharat Distributors', is_active: true }]
  // Ownership is what grants 'carry'/'operate' — nothing is stored as a flag.
  store.vehicles = [
    { id: 'v1', fleet_owner_id: null, driver_id: D_OWN },
    { id: 'v2', fleet_owner_id: FO1, driver_id: null },
    { id: 'v3', fleet_owner_id: FO1, driver_id: null },
  ]
  store.fleet_drivers = []
  store.quotes = [
    { id: Q_SECOND, booking_id: B_SECOND, driver_id: D_OWN, fleet_owner_id: null, amount: 41000, status: 'submitted' },
    { id: Q_FLEET, booking_id: B_FLEET, driver_id: null, fleet_owner_id: FO1, amount: 43000, status: 'submitted' },
  ]
  store.users = [
    { id: U_SHIPPER, email: 'shipper@example.com', full_name: 'Shipper One' },
    { id: U_SHIP2, email: 'shipper2@example.com', full_name: 'Shipper Two' },
    { id: U_OWNDRV, email: 'ownerdriver@example.com', full_name: 'Owner Driver' },
    { id: U_DIST, email: 'dist@example.com', full_name: 'Bharat Distributors' },
  ]
  store.notification_outbox = []
}

// ---- minimal in-memory Supabase query-builder fake ------------------------
class FakeQuery {
  private filters: Array<[string, string, any]> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  private head = false
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.head = true
    return this
  }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  neq(c: string, v: any) { this.filters.push(['neq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  is(c: string, v: any) { this.filters.push(['is', c, v]); return this }
  not(c: string, _op: string, list: string) {
    this.filters.push(['notin', c, list.replace(/[()]/g, '').split(',')])
    return this
  }
  order() { return this }
  limit() { return this }
  private match(r: Row) {
    return this.filters.every(([o, c, v]) => {
      if (o === 'eq') return r[c] === v
      if (o === 'neq') return r[c] !== v
      if (o === 'in') return v.includes(r[c])
      if (o === 'is') return (r[c] ?? null) === v
      return !v.includes(r[c])
    })
  }
  private run() {
    const rows = store[this.table] ?? (store[this.table] = [])
    if (this.mode === 'insert') {
      const p = this.payload as Row
      if (this.table === 'notification_outbox' && rows.some(r => r.dedupe_key === p.dedupe_key)) {
        return { data: null, count: null, error: { code: '23505', message: 'duplicate' } }
      }
      const row = { id: `r${rows.length + 1}`, ...p }
      rows.push(row)
      return { data: [row], count: 1, error: null }
    }
    const hit = rows.filter(r => this.match(r))
    if (this.mode === 'update') hit.forEach(r => Object.assign(r, this.payload))
    return { data: this.head ? null : hit, count: hit.length, error: null }
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.length ? r.data[0] : null, error: r.error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// ---- assertions -----------------------------------------------------------
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)
const row = (id: string) => store.bookings.find(b => b.id === id)!

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const { buildDriverCommitments, tripFreesDriver } = await import('../src/lib/driver-schedule.js')
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

  const acceptQuote = (b: string, q: string, token: string) => app.inject({
    method: 'PATCH', url: `/bookings/${b}/quotes/${q}/accept`,
    headers: { authorization: `Bearer ${token}` },
  })
  const instantAccept = (b: string, token: string) => app.inject({
    method: 'PATCH', url: `/bookings/${b}/accept`,
    headers: { authorization: `Bearer ${token}` },
  })
  const attach = (b: string, token: string) => app.inject({
    method: 'PATCH', url: `/bookings/${b}/direct-attach`,
    headers: { authorization: `Bearer ${token}` },
  })

  // ── The rule itself, without a database ───────────────────────────────────
  console.log('\n── the freeness rule is pure and testable on its own')
  const lanes = { source_address: 'Pune', destination_address: 'Goa', pickup_date: '2026-08-20' }
  check('a live trip is a commitment',
    buildDriverCommitments([{ id: 'b1', status: 'in_transit', ...lanes }]).length === 1)
  check('an accepted-but-not-started trip still holds the driver',
    buildDriverCommitments([{ id: 'b1', status: 'accepted', ...lanes }]).length === 1)
  check('the excepted booking never blocks itself',
    buildDriverCommitments([{ id: 'b1', status: 'accepted', ...lanes }], { exceptBookingId: 'b1' }).length === 0)
  check('a commitment names its lane so the refusal can be acted on',
    buildDriverCommitments([{ id: 'b1', status: 'in_transit', ...lanes }])[0].description === 'Pune → Goa')

  // THE TRAP: 'completed' means DELIVERED, money still pending. state.ts's
  // TERMINAL_BOOKING_STATUSES (used for document issuance) excludes it, and reusing
  // that list here would strand every driver between delivery and settlement.
  console.log('\n── delivery frees the driver; payment is a separate clock')
  for (const status of ['completed', 'delivery_asserted', 'paid', 'cancelled']) {
    check(`'${status}' frees the driver`, tripFreesDriver(status) === true)
    check(`...and drops out of the commitment list`,
      buildDriverCommitments([{ id: 'b1', status, ...lanes }]).length === 0)
  }
  for (const status of ['pending', 'accepted', 'in_transit']) {
    check(`'${status}' does NOT free the driver`, tripFreesDriver(status) === false)
  }

  // ── The bug, on all three binding paths ───────────────────────────────────
  console.log('\n── a driver already out on a trip cannot be bound to a second')
  reset()
  let res = await acceptQuote(B_SECOND, Q_SECOND, tok(U_SHIP2, 'shipper'))
  check('awarding an auction to a busy driver is 409', res.statusCode === 409, res.body.slice(0, 220))
  check('the refusal NAMES the blocking trip', /Mumbai → Raipur/.test(res.json().error ?? ''), res.body.slice(0, 220))
  check('...and its booking id', res.json().error?.includes(B_LIVE), res.body.slice(0, 220))
  check('the second booking is untouched — still pending', row(B_SECOND).status === 'pending', row(B_SECOND).status)
  check('no carrier was bound to it', row(B_SECOND).driver_id === null, String(row(B_SECOND).driver_id))
  // The refusal must leave the shipper their whole field of bidders, not burn it.
  check('the bid was NOT consumed — it is still live',
    store.quotes.find(q => q.id === Q_SECOND)?.status === 'submitted',
    String(store.quotes.find(q => q.id === Q_SECOND)?.status))
  check('the first trip was not disturbed', row(B_LIVE).status === 'in_transit' && row(B_LIVE).driver_id === D_OWN)

  reset()
  res = await instantAccept(B_INSTANT, tok(U_OWNDRV, 'driver'))
  check('instant-accepting a second load is 409', res.statusCode === 409, res.body.slice(0, 220))
  check('that load is untouched', row(B_INSTANT).driver_id === null && row(B_INSTANT).status === 'pending')

  reset()
  res = await attach(B_OWN, tok(U_OWNDRV, 'shipper'))
  check('direct-attaching their own load while busy is 409', res.statusCode === 409, res.body.slice(0, 220))
  check('their own load is untouched', row(B_OWN).driver_id === null && row(B_OWN).status === 'pending')
  check('award_path not stamped on a refused attach', row(B_OWN).award_path === 'auction', row(B_OWN).award_path)

  // ── Controls: what must STILL work ────────────────────────────────────────
  console.log('\n── a driver who has delivered takes the next load immediately')
  reset()
  row(B_LIVE).status = 'completed'   // delivered; payment outstanding
  res = await acceptQuote(B_SECOND, Q_SECOND, tok(U_SHIP2, 'shipper'))
  check('award succeeds once the trip is completed', res.statusCode === 200, res.body.slice(0, 220))
  check('the driver is bound to the new load', row(B_SECOND).driver_id === D_OWN, String(row(B_SECOND).driver_id))

  reset()
  row(B_LIVE).status = 'completed'
  res = await instantAccept(B_INSTANT, tok(U_OWNDRV, 'driver'))
  check('instant-accept works again too', res.statusCode === 200, res.body.slice(0, 220))

  console.log('\n── a FLEET winner is not driver-checked (no driver is bound yet)')
  reset()
  // FO1 has no driver at all in these fixtures. If the guard reached fleet awards it
  // would have to invent a driver to check, and every fleet auction would break.
  res = await acceptQuote(B_FLEET, Q_FLEET, tok(U_SHIPPER, 'shipper'))
  check('a fleet wins the auction normally', res.statusCode === 200, res.body.slice(0, 220))
  check('the fleet is the carrier', row(B_FLEET).fleet_owner_id === FO1, String(row(B_FLEET).fleet_owner_id))
  check('driver_id is left NULL for bt-fleet-service to pair', row(B_FLEET).driver_id === null,
    String(row(B_FLEET).driver_id))

  console.log('\n── bidding is untouched — only BINDING is exclusive')
  reset()
  // A busy driver may keep bidding: they are pricing future work, not taking it. The
  // guard sits on the award, never on the bid.
  res = await app.inject({
    method: 'POST', url: `/bookings/${B_INSTANT}/quotes`,
    headers: { authorization: `Bearer ${tok(U_OWNDRV, 'driver')}` },
    payload: { amount: 38000 },
  })
  check('a driver on a live trip can still submit a bid (201)', res.statusCode === 201, res.body.slice(0, 220))

  console.log('\n── a replay is not blocked by its own first run')
  reset()
  row(B_LIVE).status = 'completed'
  const first = await attach(B_OWN, tok(U_OWNDRV, 'shipper'))
  const second = await attach(B_OWN, tok(U_OWNDRV, 'shipper'))
  check('first attach 200', first.statusCode === 200, first.body.slice(0, 220))
  // Without exceptBookingId the driver would now be "busy" on the very booking being
  // retried, and an idempotent request would start 409-ing.
  check('replay still 200, not a self-inflicted 409', second.statusCode === 200, second.body.slice(0, 220))
  check('still bound to them exactly once', row(B_OWN).driver_id === D_OWN, String(row(B_OWN).driver_id))

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
