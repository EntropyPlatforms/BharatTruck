/**
 * GET /bookings scope for a DRIVER, solo vs fleet-employed.
 *
 * THE BUG THIS PINS (BIBLE §5.4 item 3 — "direct bookings are invisible to the
 * assigned SOLO driver"): repository.listBookings() filtered a solo driver to
 * `status='pending'` and nothing else. The instant a booking became theirs —
 * accepted, or won and moved to in_transit — it left the only list they could
 * see. The trip existed, the detail screen rendered it correctly (assigned_to_me
 * is computed server-side), but no screen linked to it, so the driver simply
 * lost the trip.
 *
 * The assertions are therefore about the UNION: an assigned trip must appear
 * WITHOUT the open load board disappearing. A test that only checked "the
 * assigned trip is listed" would pass against a filter that had swapped one
 * slice for the other and taken the driver's ability to find work away.
 *
 * bookings.driver_id references drivers.id, NOT the JWT's users.id — the store
 * below keeps those deliberately distinct so a fix that filtered on the wrong
 * identity would fail here rather than in production.
 *
 * Exercises the REAL route via app.inject() with the in-memory fake Supabase
 * seam. Run: npx tsx test/driver-list-scope.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

const OPEN_A         = '11111111-1111-4111-8111-111111111111' // pending, open to anyone
const OPEN_B         = '22222222-2222-4222-8222-222222222222' // pending, open to anyone
const TARGETED       = '33333333-3333-4333-8333-333333333333' // pending, aimed at the solo driver
const MINE_ACCEPTED  = '44444444-4444-4444-8444-444444444444' // accepted BY the solo driver
const MINE_INTRANSIT = '55555555-5555-4555-8555-555555555555' // solo driver's live trip
const THEIRS         = '66666666-6666-4666-8666-666666666666' // another solo driver's live trip
const FLEET_ASSIGNED = '77777777-7777-4777-8777-777777777777' // assigned to the fleet driver

// drivers.id — what bookings.driver_id points at
const D_SOLO  = 'a1111111-1111-4111-8111-111111111111'
const D_OTHER = 'a2222222-2222-4222-8222-222222222222'
const D_FLEET = 'a3333333-3333-4333-8333-333333333333'

// users.id — what the JWT carries. Deliberately NOT equal to any drivers.id.
const U_SOLO  = 'b1111111-1111-4111-8111-111111111111'
const U_OTHER = 'b2222222-2222-4222-8222-222222222222'
const U_FLEET = 'b3333333-3333-4333-8333-333333333333'
const U_GHOST = 'b4444444-4444-4444-8444-444444444444' // driver role, no drivers row

const SHIPPER = 'c1111111-1111-4111-8111-111111111111'
const PRICE   = 47500

type Row = Record<string, any>
const store: Record<string, Row[]> = {
  bookings: [
    { id: OPEN_A,         shipper_id: SHIPPER, driver_id: null,    target_driver_id: null,   status: 'pending',    quoted_price: PRICE, final_price: null,  min_acceptable: 30000, created_at: '2026-07-31T00:00:00Z' },
    { id: OPEN_B,         shipper_id: SHIPPER, driver_id: null,    target_driver_id: null,   status: 'pending',    quoted_price: PRICE, final_price: null,  min_acceptable: 30000, created_at: '2026-07-30T00:00:00Z' },
    { id: TARGETED,       shipper_id: SHIPPER, driver_id: null,    target_driver_id: D_SOLO, status: 'pending',    quoted_price: PRICE, final_price: null,  min_acceptable: 30000, created_at: '2026-07-29T00:00:00Z' },
    { id: MINE_ACCEPTED,  shipper_id: SHIPPER, driver_id: D_SOLO,  target_driver_id: D_SOLO, status: 'accepted',   quoted_price: PRICE, final_price: PRICE, min_acceptable: 30000, created_at: '2026-07-28T00:00:00Z' },
    { id: MINE_INTRANSIT, shipper_id: SHIPPER, driver_id: D_SOLO,  target_driver_id: null,   status: 'in_transit', quoted_price: PRICE, final_price: PRICE, min_acceptable: 30000, created_at: '2026-07-27T00:00:00Z' },
    { id: THEIRS,         shipper_id: SHIPPER, driver_id: D_OTHER, target_driver_id: null,   status: 'in_transit', quoted_price: PRICE, final_price: PRICE, min_acceptable: 30000, created_at: '2026-07-26T00:00:00Z' },
    { id: FLEET_ASSIGNED, shipper_id: SHIPPER, driver_id: D_FLEET, target_driver_id: null,   status: 'accepted',   quoted_price: PRICE, final_price: PRICE, min_acceptable: 30000, created_at: '2026-07-25T00:00:00Z' },
  ],
  drivers: [
    { id: D_SOLO,  user_id: U_SOLO },
    { id: D_OTHER, user_id: U_OTHER },
    { id: D_FLEET, user_id: U_FLEET },
  ],
  // Only D_FLEET is employed. The solo drivers have no row here, which is what
  // keeps their behaviour that of the pre-fleet product.
  fleet_drivers: [
    { id: 'f1', driver_id: D_FLEET, fleet_owner_id: 'own-1', status: 'active' },
  ],
}

class FakeQuery {
  private filters: Array<['eq' | 'in' | 'or', string, any]> = []
  constructor(private table: string) {}
  select() { return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  // PostgREST `.or('status.eq.pending,driver_id.eq.<uuid>')`: comma-separated
  // terms OR'd together, then AND'd with every other filter on the query.
  or(expr: string) { this.filters.push(['or', expr, null]); return this }
  order() { return this }
  limit() { return this }
  private orMatch(r: Row, expr: string) {
    return expr.split(',').some((term) => {
      const first  = term.indexOf('.')
      const second = term.indexOf('.', first + 1)
      if (first < 0 || second < 0) throw new Error(`fake .or(): cannot parse "${term}"`)
      const op = term.slice(first + 1, second)
      // Fail loudly rather than silently not matching: a quietly-unsupported
      // operator would turn a real assertion into a meaningless one.
      if (op !== 'eq') throw new Error(`fake .or(): unsupported operator "${op}"`)
      return String(r[term.slice(0, first)] ?? '') === term.slice(second + 1)
    })
  }
  private match(r: Row) {
    return this.filters.every(([o, c, v]) =>
      o === 'eq' ? r[c] === v : o === 'or' ? this.orMatch(r, c) : v.includes(r[c]))
  }
  private run() { return { data: (store[this.table] ?? []).filter(r => this.match(r)), error: null } }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')
  __setSupabaseClientForTests(fakeSupabase as any)

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(bookingRoutes, { prefix: '/bookings' })
  })
  await app.ready()

  const listAs = async (user: string, role: string) => {
    const r = await app.inject({
      method: 'GET', url: '/bookings',
      headers: { authorization: `Bearer ${tok(user, role)}` },
    })
    const rows = (r.json().data ?? []) as Row[]
    return { code: r.statusCode, rows, ids: rows.map(b => b.id) }
  }

  console.log('\n── solo driver: their own trips, WITHOUT losing the load board ──')
  const solo = await listAs(U_SOLO, 'driver')
  check('solo driver 200', solo.code === 200, `(got ${solo.code})`)
  // The regression. Before the fix both of these were absent — the driver had
  // no link anywhere to a trip that was already theirs.
  check('sees the trip they accepted', solo.ids.includes(MINE_ACCEPTED), JSON.stringify(solo.ids))
  check('sees their in_transit trip', solo.ids.includes(MINE_INTRANSIT), JSON.stringify(solo.ids))
  // The other half of the union: fixing the above must not cost them the board.
  check('still sees open load OPEN_A', solo.ids.includes(OPEN_A), JSON.stringify(solo.ids))
  check('still sees open load OPEN_B', solo.ids.includes(OPEN_B), JSON.stringify(solo.ids))
  check('still sees the pending load targeted at them', solo.ids.includes(TARGETED), JSON.stringify(solo.ids))
  check("does NOT see another driver's in_transit trip", !solo.ids.includes(THEIRS), JSON.stringify(solo.ids))
  check("does NOT see the fleet driver's assignment", !solo.ids.includes(FLEET_ASSIGNED), JSON.stringify(solo.ids))
  check('sees exactly those 5', solo.ids.length === 5, `(got ${solo.ids.length}) ${JSON.stringify(solo.ids)}`)
  // A solo driver IS the commercial party on their own trip (Q16), so the fleet
  // price mask must not have followed them through the new lookup.
  check('money stays visible to a solo driver', solo.rows.every(b => b.quoted_price === PRICE),
    JSON.stringify(solo.rows.map(b => b.quoted_price)))

  console.log('\n── fleet driver: assignments only, unchanged ──')
  const fleet = await listAs(U_FLEET, 'driver')
  check('fleet driver 200', fleet.code === 200, `(got ${fleet.code})`)
  check('sees only their assignment', fleet.ids.length === 1 && fleet.ids[0] === FLEET_ASSIGNED, JSON.stringify(fleet.ids))
  check('gets NO open load board (founder Q14)',
    !fleet.ids.includes(OPEN_A) && !fleet.ids.includes(OPEN_B) && !fleet.ids.includes(TARGETED),
    JSON.stringify(fleet.ids))
  check('money masked', !('quoted_price' in (fleet.rows[0] ?? {})), JSON.stringify(Object.keys(fleet.rows[0] ?? {})))

  console.log('\n── other drivers are scoped to themselves too ──')
  const other = await listAs(U_OTHER, 'driver')
  check('second solo driver sees their own trip', other.ids.includes(THEIRS), JSON.stringify(other.ids))
  check("second solo driver does NOT see the first's trips",
    !other.ids.includes(MINE_ACCEPTED) && !other.ids.includes(MINE_INTRANSIT), JSON.stringify(other.ids))

  // FB-11 / D-27: JWT role='driver' alone is not authorization. Without a drivers
  // row (no 'drive') and no truck assets (no 'carry'/'operate'), the marketplace
  // board stays closed — empty list, not a 500.
  console.log('\n── driver account with no drivers row: no marketplace, no 500 ──')
  const ghost = await listAs(U_GHOST, 'driver')
  check('ghost driver 200', ghost.code === 200, `(got ${ghost.code})`)
  check('ghost without drivers row / carrier assets sees an empty list',
    ghost.ids.length === 0,
    JSON.stringify(ghost.ids))

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
