/**
 * GET /me/feed — the unified, capability-aware action feed (D-38, §10.2).
 *
 * This suite pins the properties that make the feed safe to ship, against the REAL
 * route via app.inject() with an in-memory fake Supabase (same harness shape as
 * derole-capabilities.e2e.mts):
 *
 *   1. A single-capability human's feed contains ONE kind of item and is
 *      indistinguishable from today's single-purpose home — a pure shipper sees
 *      only their posted-load rows, tagged 'shipper', with no fleet/driver/carrier
 *      rows anywhere.
 *   2. A multi-capability human's feed INTERLEAVES kinds, each row carrying the
 *      correct per-item persona tag: an owner-driver (carry+drive) sees work-to-bid
 *      AND trips-to-drive; a distributor (ship+carry+operate) sees shipper, carrier
 *      and fleet rows at once.
 *   3. NO cross-user leakage: the feed only ever contains the caller's own items.
 *   4. A failing source DEGRADES to a partial feed (never a 500), and names the
 *      source it dropped.
 *   5. limit/offset pagination returns a STABLE ordering.
 *
 * Run: npx tsx test/me-feed.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ── People. Each exercises a distinct capability set. ────────────────────────
const U_SHIP   = '10000000-0000-4000-8000-000000000001' // pure shipper: owns nothing
const U_OWNDRV = '20000000-0000-4000-8000-000000000002' // owner-driver: carry + drive
const U_DIST   = '30000000-0000-4000-8000-000000000003' // distributor: ship + carry + operate
const U_OTHER  = '40000000-0000-4000-8000-000000000004' // a second shipper (the leakage foil)

const D_OWN  = 'a0000000-0000-4000-8000-000000000002'   // drivers.id of U_OWNDRV
const D_HELD = 'a0000000-0000-4000-8000-00000000000a'   // a driver held by U_DIST's fleet
const FO_DIST = 'b0000000-0000-4000-8000-000000000003'  // fleet_owners.id of U_DIST

// Bookings — the ids are also the deep-link targets asserted below.
const B_SHIP_BIDS   = 'c0000000-0000-4000-8000-000000000001' // U_SHIP posted; has 2 live bids
const B_SHIP_STUCK  = 'c0000000-0000-4000-8000-000000000002' // U_SHIP posted; in_transit, no receiver
const B_SHIP_DONE   = 'c0000000-0000-4000-8000-0000000000a1' // U_SHIP posted; delivered, not paid
const B_SHIP_PAID   = 'c0000000-0000-4000-8000-0000000000a2' // U_SHIP posted; delivered AND paid
const B_OTHER_BIDS  = 'c0000000-0000-4000-8000-000000000003' // U_OTHER posted; has a bid (must NOT leak to U_SHIP)
const B_OTHER_OPEN  = 'c0000000-0000-4000-8000-000000000004' // U_OTHER posted; pending (open board)
const B_DRV_ACCEPT  = 'c0000000-0000-4000-8000-000000000005' // assigned to D_OWN, accepted
const B_DRV_TRANSIT = 'c0000000-0000-4000-8000-000000000006' // assigned to D_OWN, in_transit
const B_OWNDRV_BID  = 'c0000000-0000-4000-8000-000000000007' // U_OTHER's load; D_OWN's bid on it is countered
const B_DIST_POSTED = 'c0000000-0000-4000-8000-000000000008' // U_DIST posted; has a bid
const B_DIST_FLEET  = 'c0000000-0000-4000-8000-000000000009' // U_DIST's fleet won it; awaiting a truck

const Q_BID1 = 'd0000000-0000-4000-8000-000000000001' // a live bid on B_SHIP_BIDS
const Q_BID2 = 'd0000000-0000-4000-8000-000000000002' // another live bid on B_SHIP_BIDS
const Q_OTHER = 'd0000000-0000-4000-8000-000000000003' // a live bid on B_OTHER_BIDS
const Q_OWNDRV_COUNTERED = 'd0000000-0000-4000-8000-000000000004' // D_OWN's countered bid
const Q_DIST_POSTED = 'd0000000-0000-4000-8000-000000000005' // a bid on B_DIST_POSTED

const FD_HELD = 'e0000000-0000-4000-8000-00000000000a' // fleet_drivers row: D_HELD joined U_DIST

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

function booking(id: string, over: Row): Row {
  return {
    id, driver_id: null, fleet_owner_id: null, vehicle_id: null, status: 'pending',
    booking_type: 'direct', target_driver_id: null, quoted_price: 40000, final_price: null,
    min_acceptable: 30000, source_address: 'Mumbai', destination_address: 'Nagpur',
    receiver_email: 'r@acme.in', pickup_date: '2026-09-01',
    created_at: iso(60_000), updated_at: iso(60_000), ...over,
  }
}
function quote(id: string, over: Row): Row {
  return { id, status: 'submitted', driver_id: null, fleet_owner_id: null, amount: 39000,
    submitted_at: iso(30_000), updated_at: iso(30_000), ...over }
}

function reset() {
  store.users = [
    { id: U_SHIP, full_name: 'Pure Shipper', phone_number: '9111111111', email: 's@ex.in' },
    { id: U_OWNDRV, full_name: 'Owner Driver', phone_number: '9222222222', email: 'o@ex.in' },
    { id: U_DIST, full_name: 'Bharat Distributors', phone_number: '9333333333', email: 'd@ex.in' },
    { id: U_OTHER, full_name: 'Other Shipper', phone_number: '9444444444', email: 'x@ex.in' },
  ]
  store.bookings = [
    booking(B_SHIP_BIDS,   { shipper_id: U_SHIP,  status: 'pending', source_address: 'Mumbai', destination_address: 'Nagpur' }),
    booking(B_SHIP_STUCK,  { shipper_id: U_SHIP,  status: 'in_transit', receiver_email: null, source_address: 'Mumbai', destination_address: 'Pune' }),
    booking(B_SHIP_DONE,   { shipper_id: U_SHIP,  status: 'completed', quoted_price: 9000, final_price: 8800, source_address: 'Mumbai', destination_address: 'Surat' }),
    booking(B_SHIP_PAID,   { shipper_id: U_SHIP,  status: 'paid', quoted_price: 7000, final_price: 7000, source_address: 'Mumbai', destination_address: 'Nashik' }),
    booking(B_OTHER_BIDS,  { shipper_id: U_OTHER, status: 'pending', source_address: 'Delhi', destination_address: 'Jaipur' }),
    booking(B_OTHER_OPEN,  { shipper_id: U_OTHER, status: 'pending', source_address: 'Surat', destination_address: 'Indore' }),
    booking(B_DRV_ACCEPT,  { shipper_id: U_OTHER, driver_id: D_OWN, status: 'accepted', source_address: 'Mumbai', destination_address: 'Pune', updated_at: iso(20_000) }),
    booking(B_DRV_TRANSIT, { shipper_id: U_OTHER, driver_id: D_OWN, status: 'in_transit', source_address: 'Pune', destination_address: 'Hyderabad', updated_at: iso(10_000) }),
    booking(B_OWNDRV_BID,  { shipper_id: U_OTHER, status: 'negotiating', source_address: 'Nashik', destination_address: 'Goa' }),
    booking(B_DIST_POSTED, { shipper_id: U_DIST,  status: 'pending', source_address: 'Kolkata', destination_address: 'Patna' }),
    booking(B_DIST_FLEET,  { shipper_id: U_OTHER, fleet_owner_id: FO_DIST, status: 'accepted', source_address: 'Chennai', destination_address: 'Kochi', updated_at: iso(15_000) }),
  ]
  store.quotes = [
    quote(Q_BID1, { booking_id: B_SHIP_BIDS, driver_id: D_OWN, status: 'submitted', updated_at: iso(25_000) }),
    quote(Q_BID2, { booking_id: B_SHIP_BIDS, fleet_owner_id: FO_DIST, status: 'submitted', updated_at: iso(5_000) }),
    quote(Q_OTHER, { booking_id: B_OTHER_BIDS, driver_id: D_OWN, status: 'submitted' }),
    quote(Q_OWNDRV_COUNTERED, { booking_id: B_OWNDRV_BID, driver_id: D_OWN, status: 'countered', updated_at: iso(8_000) }),
    quote(Q_DIST_POSTED, { booking_id: B_DIST_POSTED, driver_id: D_OWN, status: 'submitted' }),
  ]
  store.drivers = [
    { id: D_OWN, user_id: U_OWNDRV },
    { id: D_HELD, user_id: U_OTHER },
  ]
  store.fleet_owners = [{ id: FO_DIST, user_id: U_DIST, company_name: 'Bharat Distributors', is_active: true }]
  // Ownership grants carry/operate: the owner-driver owns 1 truck (carry); the
  // distributor's fleet owns 2 (carry+operate) and holds one driver (operate).
  store.vehicles = [
    { id: 'v-own', driver_id: D_OWN, fleet_owner_id: null },
    { id: 'v-d1', driver_id: null, fleet_owner_id: FO_DIST },
    { id: 'v-d2', driver_id: null, fleet_owner_id: FO_DIST },
  ]
  store.fleet_drivers = [
    { id: FD_HELD, fleet_owner_id: FO_DIST, driver_id: D_HELD, status: 'active', responded_at: iso(3600_000), updated_at: iso(3600_000) },
  ]
  store.vehicle_assignments = [] // B_DIST_FLEET has no truck paired → truck_assignment fires
}

// ── Fake Supabase. Adds a fault-injection hook (failTable) so a single source can
// be made to error, exercising graceful degradation. ────────────────────────
let failTable: string | null = null
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
    if (failTable && this.table === failTable) {
      return { data: null, count: 0, error: { message: `injected failure on ${this.table}`, code: 'XX000' } }
    }
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

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { feedRoutes } = await import('../src/routes/feed.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(feedRoutes, { prefix: '/me' })
  })
  await app.ready()

  const feed = (token: string, qs = '') => app.inject({
    method: 'GET', url: `/me/feed${qs}`, headers: { authorization: `Bearer ${token}` },
  })
  const body = (res: any) => JSON.parse(res.body).data
  const types = (items: any[]) => items.map((i) => i.type)
  const tags = (items: any[]) => new Set(items.map((i) => i.tag))
  const targets = (items: any[]) => items.map((i) => i.target?.booking_id).filter(Boolean)

  // ── 1. A pure shipper: only their posted-load rows, all tagged 'shipper'. ────
  console.log('\n── a pure shipper sees only shipper items')
  reset()
  let res = await feed(tok(U_SHIP, 'shipper'))
  check('pure shipper feed 200', res.statusCode === 200, String(res.statusCode))
  {
    const items = body(res).items
    check('every row is tagged shipper', items.length > 0 && [...tags(items)].every((t) => t === 'shipper'),
      JSON.stringify([...tags(items)]))
    check('bids_received present for their posted load', items.some((i: any) => i.type === 'bids_received' && i.target.booking_id === B_SHIP_BIDS),
      JSON.stringify(types(items)))
    check('the bids_received row counts BOTH live bids', items.some((i: any) => i.type === 'bids_received' && /^2 bids/.test(i.title)),
      JSON.stringify(items.map((i: any) => i.title)))
    check('delivery_action present for the stuck in-transit load', items.some((i: any) => i.type === 'delivery_action' && i.target.booking_id === B_SHIP_STUCK),
      JSON.stringify(types(items)))
    {
      const due = items.find((i: any) => i.type === 'payment_due' && i.target.booking_id === B_SHIP_DONE)
      check('payment_due present for the delivered, unpaid load', !!due && due.tag === 'shipper' && due.priority === 'high', JSON.stringify(due))
      check('payment_due names the AGREED price (final over quoted)', due?.subtitle?.includes('8,800') && !due?.subtitle?.includes('9,000'), JSON.stringify(due?.subtitle))
      check('a load already paid raises no payment_due', !items.some((i: any) => i.type === 'payment_due' && i.target.booking_id === B_SHIP_PAID), '')
    }
    check('no open_work / carrier / driver / fleet rows', !items.some((i: any) => ['open_work', 'bid_countered', 'trip_starting', 'trip_delivery', 'fleet_driver_joined', 'truck_assignment'].includes(i.type)),
      JSON.stringify(types(items)))
  }

  // ── 2. An owner-driver (carry+drive): work-to-bid AND trips-to-drive. ────────
  console.log('\n── an owner-driver sees carrier work AND driver trips, each tagged')
  reset()
  res = await feed(tok(U_OWNDRV, 'driver'))
  check('owner-driver feed 200', res.statusCode === 200, String(res.statusCode))
  {
    const items = body(res).items
    check('has open_work rows, tagged carrier', items.some((i: any) => i.type === 'open_work' && i.tag === 'carrier'),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('has a bid_countered row, tagged carrier', items.some((i: any) => i.type === 'bid_countered' && i.tag === 'carrier' && i.target.quote_id === Q_OWNDRV_COUNTERED),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('has a trip_starting row, tagged driver', items.some((i: any) => i.type === 'trip_starting' && i.tag === 'driver' && i.target.booking_id === B_DRV_ACCEPT),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('has a trip_delivery row, tagged driver', items.some((i: any) => i.type === 'trip_delivery' && i.tag === 'driver' && i.target.booking_id === B_DRV_TRANSIT),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    // They posted nothing, so the (always-on) shipper sources contribute nothing.
    check('no shipper or fleet rows (posted nothing, runs no fleet)', !items.some((i: any) => i.tag === 'shipper' || i.tag === 'fleet'),
      JSON.stringify(items.map((i: any) => i.tag)))
  }

  // ── 3. A distributor (ship+carry+operate): interleaved, correct per-item tags. ─
  console.log('\n── a distributor sees shipper, carrier AND fleet rows interleaved')
  reset()
  res = await feed(tok(U_DIST, 'fleet_owner'))
  check('distributor feed 200', res.statusCode === 200, String(res.statusCode))
  {
    const items = body(res).items
    check('shipper row: bids on their own posted load', items.some((i: any) => i.tag === 'shipper' && i.type === 'bids_received' && i.target.booking_id === B_DIST_POSTED),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('carrier row: the open board', items.some((i: any) => i.tag === 'carrier' && i.type === 'open_work'),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('fleet row: a driver joined', items.some((i: any) => i.tag === 'fleet' && i.type === 'fleet_driver_joined' && i.target.fleet_driver_id === FD_HELD),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('fleet row: a fleet-won load needs a truck', items.some((i: any) => i.tag === 'fleet' && i.type === 'truck_assignment' && i.target.booking_id === B_DIST_FLEET),
      JSON.stringify(items.map((i: any) => [i.type, i.tag])))
    check('all three persona kinds are present at once', ['shipper', 'carrier', 'fleet'].every((t) => tags(items).has(t as any)),
      JSON.stringify([...tags(items)]))
    // A distributor has no drivers row → no driver rows, no matter how many trips exist.
    check('no driver rows (holds no driver identity)', !items.some((i: any) => i.tag === 'driver'),
      JSON.stringify(items.map((i: any) => i.tag)))
  }

  // ── 4. No cross-user leakage. ────────────────────────────────────────────────
  console.log('\n── no cross-user leakage')
  reset()
  res = await feed(tok(U_SHIP, 'shipper'))
  {
    const items = body(res).items
    // U_SHIP has no carry → no open board. Their feed references ONLY their own bookings.
    const foreign = targets(items).filter((id) => id !== B_SHIP_BIDS && id !== B_SHIP_STUCK && id !== B_SHIP_DONE)
    check("U_SHIP's feed references no other user's bookings", foreign.length === 0, JSON.stringify(foreign))
    check("U_OTHER's bid load (B_OTHER_BIDS) does not appear", !targets(items).includes(B_OTHER_BIDS), JSON.stringify(targets(items)))
  }
  // The other direction: the owner-driver's assigned trips never surface for the distributor.
  res = await feed(tok(U_DIST, 'fleet_owner'))
  {
    const items = body(res).items
    check("owner-driver's trips do not surface in the distributor's feed",
      !targets(items).includes(B_DRV_ACCEPT) && !targets(items).includes(B_DRV_TRANSIT),
      JSON.stringify(targets(items)))
  }

  // ── 5. A failing source degrades to a partial feed (never a 500). ────────────
  console.log('\n── a failing source degrades to a partial feed')
  reset()
  failTable = 'quotes' // breaks bids_received + bid_countered; everything else still runs
  res = await feed(tok(U_DIST, 'fleet_owner'))
  failTable = null
  check('feed still returns 200 with a broken source', res.statusCode === 200, String(res.statusCode))
  {
    const data = body(res)
    check('degraded_sources names the two quote-backed sources',
      data.degraded_sources.includes('shipper.bids_received') && data.degraded_sources.includes('carrier.bid_countered'),
      JSON.stringify(data.degraded_sources))
    check('the surviving fleet/board rows are still present', data.items.some((i: any) => i.type === 'truck_assignment') && data.items.some((i: any) => i.type === 'open_work'),
      JSON.stringify(types(data.items)))
    check('the broken source contributes nothing', !data.items.some((i: any) => i.type === 'bids_received'), JSON.stringify(types(data.items)))
  }

  // ── 6. Pagination returns a stable ordering. ─────────────────────────────────
  console.log('\n── pagination returns a stable ordering')
  reset()
  const full = body(await feed(tok(U_DIST, 'fleet_owner'), '?limit=50'))
  check('distributor has enough rows to paginate', full.total >= 4, String(full.total))
  const p1 = body(await feed(tok(U_DIST, 'fleet_owner'), '?limit=2&offset=0'))
  const p2 = body(await feed(tok(U_DIST, 'fleet_owner'), '?limit=2&offset=2'))
  const stitched = [...p1.items, ...p2.items].map((i: any) => i.id)
  check('paged ids match the head of the full sorted list', JSON.stringify(stitched) === JSON.stringify(full.items.slice(0, 4).map((i: any) => i.id)),
    `${JSON.stringify(stitched)} vs ${JSON.stringify(full.items.slice(0, 4).map((i: any) => i.id))}`)
  check('pages do not overlap', new Set(stitched).size === stitched.length, JSON.stringify(stitched))
  check('next_offset advances then null at the end', p1.next_offset === 2 && full.next_offset === null,
    `${p1.next_offset} / ${full.next_offset}`)
  // Re-fetching the same page yields the identical order (deterministic tiebreak).
  const p1again = body(await feed(tok(U_DIST, 'fleet_owner'), '?limit=2&offset=0'))
  check('re-fetching a page is byte-stable', JSON.stringify(p1.items.map((i: any) => i.id)) === JSON.stringify(p1again.items.map((i: any) => i.id)),
    JSON.stringify(p1again.items.map((i: any) => i.id)))

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((err) => { console.error(err); process.exit(1) })
