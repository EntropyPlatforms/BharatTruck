/**
 * D-10 direct-attach, and the award_path column that used to lie about every trip.
 *
 * TWO THINGS ARE PINNED HERE.
 *
 * (1) `bookings.award_path` (migration 0022) was a DEAD column — a grep across every
 *     service returned zero references — so it sat at its `'auction'` default forever
 *     and a load a driver took straight off the board was recorded as though it had
 *     been through an auction that never ran. The stamps below are the audit trail;
 *     a test that only checked direct-attach would have left the lie in place on the
 *     two paths that already existed.
 *
 * (2) Direct-attach itself. Authorization is CAPABILITY + RELATION, never a role
 *     string, so the negative cases are the point: a shipper with no truck cannot
 *     mark their own load accepted with nobody behind it, and a carrier who owns a
 *     truck cannot seize a load they did not post. Both of those pass a role check
 *     and must still be refused.
 *
 * The race guard is asserted against the repository directly as well as through the
 * routes: "an auction and a direct-attach cannot both win one booking" is a claim
 * about the conditional UPDATE, and the honest way to test it is to call both.
 *
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase.
 * Run: npx tsx test/direct-attach.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ---- fixtures -------------------------------------------------------------
// The people. Each one exists to make a DIFFERENT half of the rule fail.
const U_DIST    = '11111111-1111-4111-8111-111111111111' // distributor: posts loads, runs a fleet
const U_OWNDRV  = '22222222-2222-4222-8222-222222222222' // owner-driver: posts loads, IS the truck
const U_BARE    = '33333333-3333-4333-8333-333333333333' // shipper with no truck at all
const U_STRANGE = '44444444-4444-4444-8444-444444444444' // owns a truck, posted nothing
const U_DRIVER2 = '55555555-5555-4555-8555-555555555555' // an unrelated solo driver / bidder

const FO1   = 'aaaaaaaa-1111-4111-8111-111111111111'     // fleet_owners.id of U_DIST
const D_OWN = 'bbbbbbbb-2222-4222-8222-222222222222'     // drivers.id of U_OWNDRV
const D_STR = 'cccccccc-4444-4444-8444-444444444444'     // drivers.id of U_STRANGE
const D2    = 'dddddddd-5555-4555-8555-555555555555'     // drivers.id of U_DRIVER2

const B_DIST     = 'e1111111-1111-4111-8111-111111111111' // U_DIST's load
const B_SOLO     = 'e2222222-2222-4222-8222-222222222222' // U_OWNDRV's load
const B_BARE     = 'e3333333-3333-4333-8333-333333333333' // U_BARE's load
const B_AUCTION  = 'e4444444-4444-4444-8444-444444444444' // U_DIST's load, with a bid to accept
const B_INSTANT  = 'e5555555-5555-4555-8555-555555555555' // U_BARE's load, taken off the board
const B_BIDS     = 'e6666666-6666-4666-8666-666666666666' // U_DIST's load, with live + dead bids

const Q_AUCTION  = 'f1111111-1111-4111-8111-111111111111' // D2's bid on B_AUCTION
const Q_LIVE     = 'f2222222-2222-4222-8222-222222222222' // D2's live bid on B_BIDS
const Q_DEAD     = 'f3333333-3333-4333-8333-333333333333' // an already-withdrawn bid on B_BIDS

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

const booking = (id: string, shipperId: string, extra: Row = {}): Row => ({
  id,
  shipper_id: shipperId,
  driver_id: null,
  fleet_owner_id: null,
  vehicle_id: null,
  awarded_quote_id: null,
  // The default every existing row carries, and the whole reason this suite exists.
  award_path: 'auction',
  status: 'pending',
  booking_type: 'direct',
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
    booking(B_DIST, U_DIST),
    booking(B_SOLO, U_OWNDRV),
    booking(B_BARE, U_BARE),
    booking(B_AUCTION, U_DIST, { booking_type: 'auction' }),
    booking(B_INSTANT, U_BARE),
    booking(B_BIDS, U_DIST, { booking_type: 'auction' }),
  ]
  store.drivers = [
    { id: D_OWN, user_id: U_OWNDRV, truck_number: 'MH04 1111' },
    { id: D_STR, user_id: U_STRANGE, truck_number: 'MH04 2222' },
    { id: D2, user_id: U_DRIVER2, truck_number: 'MH04 3333' },
  ]
  store.fleet_owners = [{ id: FO1, user_id: U_DIST, company_name: 'Bharat Distributors', is_active: true }]
  // Ownership is what grants 'carry'/'operate' — nothing is stored as a flag.
  // TWO trucks under the fleet, so U_DIST resolves to 'operate' as well as 'carry'.
  store.vehicles = [
    { id: 'v1', fleet_owner_id: FO1, driver_id: null },
    { id: 'v2', fleet_owner_id: FO1, driver_id: null },
    { id: 'v3', fleet_owner_id: null, driver_id: D_OWN },   // the owner-driver's own truck
    { id: 'v4', fleet_owner_id: null, driver_id: D_STR },   // the stranger owns one too
  ]
  // U_BARE deliberately owns nothing and holds nobody: 'ship' only.
  store.fleet_drivers = []
  store.quotes = [
    { id: Q_AUCTION, booking_id: B_AUCTION, driver_id: D2, fleet_owner_id: null, amount: 41000, status: 'submitted' },
    { id: Q_LIVE, booking_id: B_BIDS, driver_id: D2, fleet_owner_id: null, amount: 43000, status: 'submitted' },
    { id: Q_DEAD, booking_id: B_BIDS, driver_id: D_STR, fleet_owner_id: null, amount: 47000, status: 'withdrawn' },
  ]
  store.users = [
    { id: U_DIST, email: 'dist@example.com', full_name: 'Bharat Distributors' },
    { id: U_OWNDRV, email: 'ownerdriver@example.com', full_name: 'Owner Driver' },
    { id: U_BARE, email: 'bare@example.com', full_name: 'Bare Shipper' },
    { id: U_STRANGE, email: 'stranger@example.com', full_name: 'Stranger' },
    { id: U_DRIVER2, email: 'driver2@example.com', full_name: 'Driver Two' },
  ]
  store.notification_outbox = []
}

// ---- minimal in-memory Supabase query-builder fake ------------------------
// Beyond the shape the other suites use, this one needs `is` (the
// `awarded_quote_id IS NULL` half of the award guard), `neq`/`not` (quote expiry)
// and head/count selects (resolvePersonas counts owned trucks).
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
  // Only the `.not(col, 'in', '(a,b,c)')` form the quote-expiry queries use.
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
const quote = (id: string) => store.quotes.find(q => q.id === id)!

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')
  const { quoteRoutes } = await import('../src/routes/quotes.js')
  const quoteRepo = await import('../src/lib/quote-repository.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(bookingRoutes, { prefix: '/bookings' })
    await a.register(quoteRoutes, { prefix: '/bookings' })
  })
  await app.ready()

  const attach = (id: string, token: string) => app.inject({
    method: 'PATCH', url: `/bookings/${id}/direct-attach`,
    headers: { authorization: `Bearer ${token}` },
  })

  // ── The happy paths: one per carrier identity ─────────────────────────────
  console.log('\n── a distributor attaches their own load to their own fleet')
  reset()
  let res = await attach(B_DIST, tok(U_DIST, 'shipper'))
  check('owning shipper with a fleet 200', res.statusCode === 200, res.body.slice(0, 160))
  check('award_path stamped direct_attach', row(B_DIST).award_path === 'direct_attach', row(B_DIST).award_path)
  check('status is accepted', row(B_DIST).status === 'accepted', row(B_DIST).status)
  check('carrier is the fleet', row(B_DIST).fleet_owner_id === FO1, String(row(B_DIST).fleet_owner_id))
  // A fleet has not chosen WHICH truck yet — exactly as when a fleet wins an auction.
  // bt-fleet-service binds driver+vehicle later and the start gate enforces it.
  check('driver_id left NULL for the fleet to assign', row(B_DIST).driver_id === null, String(row(B_DIST).driver_id))
  check('no awarded_quote_id (no auction ran)', row(B_DIST).awarded_quote_id === null)
  // D-15: a direct-attached trip invoices real freight, so it carries a real price.
  check('final_price locked to the quoted price', row(B_DIST).final_price === 45000, String(row(B_DIST).final_price))

  console.log('\n── a solo owner-driver attaches their own load to themselves')
  res = await attach(B_SOLO, tok(U_OWNDRV, 'shipper'))
  check('owner-driver shipper 200', res.statusCode === 200, res.body.slice(0, 160))
  check('award_path stamped direct_attach', row(B_SOLO).award_path === 'direct_attach', row(B_SOLO).award_path)
  check('carrier is the driver, not a fleet', row(B_SOLO).driver_id === D_OWN && row(B_SOLO).fleet_owner_id === null,
    JSON.stringify([row(B_SOLO).driver_id, row(B_SOLO).fleet_owner_id]))

  // The persona is resolved from OWNED ASSETS, not from the JWT role string. The
  // same human presenting a fleet_owner-role token must get the same answer.
  res = await attach(B_AUCTION, tok(U_DIST, 'fleet_owner'))
  check('the role string on the token does not decide (fleet_owner token works)',
    res.statusCode === 200, res.body.slice(0, 160))
  check('and it is still recorded as direct_attach', row(B_AUCTION).award_path === 'direct_attach')

  // ── Refusals: each fails a DIFFERENT half of capability + relation ─────────
  console.log('\n── a shipper with no truck cannot attach (no carry, no operate)')
  reset()
  res = await attach(B_BARE, tok(U_BARE, 'shipper'))
  check('shipper who owns nothing 403', res.statusCode === 403, String(res.statusCode))
  check('error names the missing capability, not a role', res.json().code === 'FORBIDDEN', res.json().code)
  check('booking untouched — still pending', row(B_BARE).status === 'pending', row(B_BARE).status)
  check('booking untouched — award_path not stamped', row(B_BARE).award_path === 'auction', row(B_BARE).award_path)
  check('booking untouched — no carrier bound',
    row(B_BARE).driver_id === null && row(B_BARE).fleet_owner_id === null)

  console.log('\n── a stranger WITH a truck cannot attach someone else\'s load')
  // The sharp case: U_STRANGE passes the capability half (they own a truck) and
  // fails only the relation half. A role check alone would let this through.
  res = await attach(B_DIST, tok(U_STRANGE, 'shipper'))
  check('stranger who owns a truck is refused', res.statusCode === 404, String(res.statusCode))
  check('answered 404, not 403 — ids are not confirmed to non-parties', res.json().code === 'NOT_FOUND', res.json().code)
  check('booking untouched — still pending', row(B_DIST).status === 'pending', row(B_DIST).status)
  check('booking untouched — no carrier seized it', row(B_DIST).fleet_owner_id === null)

  res = await attach(B_DIST, tok(U_DRIVER2, 'driver'))
  check('an unrelated driver is refused too', res.statusCode === 404, String(res.statusCode))
  check('and no token at all is 401',
    (await app.inject({ method: 'PATCH', url: `/bookings/${B_DIST}/direct-attach` })).statusCode === 401)

  // ── Idempotency: a double tap must not double-award ───────────────────────
  console.log('\n── direct-attaching twice is safe')
  reset()
  const first = await attach(B_DIST, tok(U_DIST, 'shipper'))
  const second = await attach(B_DIST, tok(U_DIST, 'shipper'))
  check('first attach 200', first.statusCode === 200, String(first.statusCode))
  check('replay also 200 — the request already had its effect', second.statusCode === 200, second.body.slice(0, 160))
  check('replay returns the same booking', second.json().data?.id === B_DIST)
  check('still direct_attach, still accepted',
    row(B_DIST).award_path === 'direct_attach' && row(B_DIST).status === 'accepted')
  check('carrier unchanged by the replay', row(B_DIST).fleet_owner_id === FO1)
  check('price not re-applied differently', row(B_DIST).final_price === 45000)

  // ── The race, in both directions, against the repository guard ────────────
  console.log('\n── an auction and a direct-attach cannot both win one booking')
  reset()
  // Direct-attach first, then let the auction try to award the same booking.
  await attach(B_BIDS, tok(U_DIST, 'shipper'))
  check('booking is direct_attached', row(B_BIDS).award_path === 'direct_attach')
  const lateAward = await quoteRepo.awardBooking(B_BIDS, Q_LIVE, { kind: 'driver', driverId: D2 }, 43000)
  check('a concurrent auction award loses the row (null)', lateAward === null, JSON.stringify(lateAward))
  check('the direct-attach carrier survived', row(B_BIDS).fleet_owner_id === FO1 && row(B_BIDS).driver_id === null)
  check('award_path was NOT rewritten to auction', row(B_BIDS).award_path === 'direct_attach', row(B_BIDS).award_path)

  // And the other way round: auction first, direct-attach after.
  reset()
  res = await app.inject({
    method: 'PATCH', url: `/bookings/${B_AUCTION}/quotes/${Q_AUCTION}/accept`,
    headers: { authorization: `Bearer ${tok(U_DIST, 'shipper')}` },
  })
  check('accepting a quote 200', res.statusCode === 200, res.body.slice(0, 160))
  check('auction award stamps award_path=auction', row(B_AUCTION).award_path === 'auction', row(B_AUCTION).award_path)
  check('auction bound the winning driver', row(B_AUCTION).driver_id === D2, String(row(B_AUCTION).driver_id))

  res = await attach(B_AUCTION, tok(U_DIST, 'shipper'))
  check('direct-attaching an already-awarded booking is 409', res.statusCode === 409, String(res.statusCode))
  check('and reports ALREADY_AWARDED', res.json().code === 'ALREADY_AWARDED', res.json().code)
  check('the auction winner was NOT displaced', row(B_AUCTION).driver_id === D2 && row(B_AUCTION).fleet_owner_id === null)
  check('award_path still says auction', row(B_AUCTION).award_path === 'auction', row(B_AUCTION).award_path)

  const lateAttach = await quoteRepo.directAttachBooking(B_AUCTION, { kind: 'fleet', fleetOwnerId: FO1 }, 45000)
  check('the repository guard refuses it too (null)', lateAttach === null, JSON.stringify(lateAttach))

  // ── The instant path, which was also mislabelled ──────────────────────────
  console.log('\n── a driver taking a load off the board stamps award_path=instant')
  reset()
  res = await app.inject({
    method: 'PATCH', url: `/bookings/${B_INSTANT}/accept`,
    headers: { authorization: `Bearer ${tok(U_DRIVER2, 'driver')}` },
  })
  check('driver self-accept 200', res.statusCode === 200, res.body.slice(0, 160))
  check('award_path stamped instant (was silently "auction")',
    row(B_INSTANT).award_path === 'instant', row(B_INSTANT).award_path)
  check('driver bound and status accepted',
    row(B_INSTANT).driver_id === D2 && row(B_INSTANT).status === 'accepted')

  // ── Existing bids are CLOSED, not silently discarded ──────────────────────
  console.log('\n── attaching a load that already has bids settles them')
  reset()
  res = await attach(B_BIDS, tok(U_DIST, 'shipper'))
  check('a load with live bids can still be attached', res.statusCode === 200, res.body.slice(0, 160))
  check('the live bid is expired, not left dangling', quote(Q_LIVE).status === 'expired', quote(Q_LIVE).status)
  // A bid that already has its own outcome keeps it — expiry must not overwrite history.
  check('an already-withdrawn bid keeps its own status', quote(Q_DEAD).status === 'withdrawn', quote(Q_DEAD).status)
  const lost = store.notification_outbox.filter(n => n.event_type === 'quote_lost')
  check('the live bidder is told they did not get it', lost.length === 1, JSON.stringify(store.notification_outbox))
  check('...at their own address', lost[0]?.recipient_email === 'driver2@example.com', String(lost[0]?.recipient_email))
  check('the withdrawn bidder is NOT mailed again',
    !lost.some(n => n.recipient_email === 'stranger@example.com'), JSON.stringify(lost))

  // ── Self-bidding: the flip side of direct-attach ──────────────────────────
  // Direct-attach exists BECAUSE a distributor must never bid on their own load, so
  // the refusal belongs next to the feature that replaces it. U_DIST is the exact
  // shape that made this reachable: they posted B_BIDS *and* run fleet FO1, so every
  // other guard in submitQuote passes for them. This is the production incident
  // (booking 337e203a) reduced to a fixture.
  console.log('\n── a distributor cannot bid on the load they posted')
  reset()
  const bid = (id: string, token: string, amount: number) => app.inject({
    method: 'POST', url: `/bookings/${id}/quotes`,
    headers: { authorization: `Bearer ${token}` },
    payload: { amount },
  })

  res = await bid(B_BIDS, tok(U_DIST, 'shipper'), 39000)
  check('self-bid on own load is 403', res.statusCode === 403, res.body.slice(0, 200))
  check('refused as SELF_BID_FORBIDDEN, not a generic 403',
    res.json().code === 'SELF_BID_FORBIDDEN', res.json().code)
  check('the error points at direct-attach', /direct-attach/i.test(res.json().error ?? ''), res.body.slice(0, 200))
  check('no quote row was created', !store.quotes.some(q => q.fleet_owner_id === FO1), JSON.stringify(store.quotes))

  // The role string must not be a way around it, exactly as it is not a way INTO
  // direct-attach above. Same human, carrier-shaped token, same refusal.
  res = await bid(B_BIDS, tok(U_DIST, 'fleet_owner'), 39000)
  check('a fleet_owner-role token does not evade the rule', res.statusCode === 403, String(res.statusCode))

  // Ordering matters: a self-bid is permanently wrong, so it must not be reported as
  // a state problem the caller could "fix" by waiting or retrying.
  reset()
  store.bookings.find(b => b.id === B_BIDS)!.auction_deadline = '2020-01-01T00:00:00Z'
  res = await bid(B_BIDS, tok(U_DIST, 'shipper'), 39000)
  check('a self-bid on an EXPIRED auction still reports the self-bid, not AUCTION_CLOSED',
    res.json().code === 'SELF_BID_FORBIDDEN', res.json().code)

  // ── ...and the marketplace still works for everybody else ─────────────────
  // The guard is scoped to the poster. If this breaks, the fix has taken bidding
  // down with it — which would be a far worse bug than the one it repairs.
  //
  // U_STRANGE is the correct control and U_DRIVER2 is not: D2 owns no vehicle in
  // these fixtures, so they are refused by the CAPABILITY gate that predates this
  // change, and a green check on them would prove nothing about the new one.
  // U_STRANGE owns truck v4 and posted nothing — they fail neither half.
  console.log('\n── an unrelated carrier can still bid on that same shipper\'s load')
  reset()
  res = await bid(B_AUCTION, tok(U_STRANGE, 'driver'), 39000)
  check('a stranger who owns a truck bids normally (201)', res.statusCode === 201, res.body.slice(0, 200))
  check('their quote row exists', store.quotes.some(q => q.driver_id === D_STR && q.amount === 39000),
    JSON.stringify(store.quotes.map(q => [q.driver_id, q.amount])))

  // And the poster's legitimate route to their own load is untouched.
  res = await attach(B_BIDS, tok(U_DIST, 'shipper'))
  check('the poster can still direct-attach the load they may not bid on', res.statusCode === 200,
    res.body.slice(0, 160))
  check('recorded as direct_attach, never auction', row(B_BIDS).award_path === 'direct_attach',
    row(B_BIDS).award_path)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
