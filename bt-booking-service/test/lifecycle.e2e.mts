/**
 * T-BE-1 verification harness — lifecycle closure + durable breadcrumb write.
 *
 * Exercises the REAL Fastify route → service → repository stack via
 * app.inject(), backed by an in-memory fake of the Supabase query builder and
 * the REAL local Redis (redis://localhost:6379) so the SET-NX-EX throttle gate
 * is proven for real, not mocked.
 *
 * Not part of the tsc `src` build (lives under test/), so it never ships.
 * Run:  REDIS_URL=redis://localhost:6379 npx tsx test/lifecycle.e2e.mts
 */

// Env must be set before importing modules that read it at import time (redis.ts).
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

// Only env-agnostic modules are static-imported; the modules that read env at
// import time (redis.ts) are dynamically imported inside main() AFTER the env
// assignments above have run (static imports are hoisted ahead of them).
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ---- fixtures -------------------------------------------------------------
const B1 = '11111111-1111-4111-8111-111111111111'
const D1 = '22222222-2222-4222-8222-222222222222'
const D2 = '33333333-3333-4333-8333-333333333333'
const U1 = '44444444-4444-4444-8444-444444444444' // driver 1 (assigned) user
const U2 = '55555555-5555-4555-8555-555555555555' // driver 2 (not assigned) user
const S1 = '66666666-6666-4666-8666-666666666666' // shipper user
const B_ASSERTED = '77777777-7777-4777-8777-777777777777' // a driver-asserted delivery ops must be able to void

type Row = Record<string, any>
const store: Record<string, Row[]> = {
  bookings: [
    { id: B1, driver_id: D1, shipper_id: S1, status: 'accepted' },
    { id: B_ASSERTED, driver_id: D1, shipper_id: S1, status: 'delivery_asserted' },
  ],
  drivers: [{ id: D1, user_id: U1 }, { id: D2, user_id: U2 }],
  location_history: [],
  // FB-03 pickup gate: tax invoice required. Inter-state under ₹50k → e-way not required.
  freight_invoices: [{
    id: 'inv-1', booking_id: B1, invoice_number: 'INV/26-27/1',
    supplier_gstin: '27AAAAA0000A1Z5', shipped_to_gstin: '29BBBBB0000B1Z5',
    shipped_to_state_code: '29', consignment_value_inr: 10000,
  }],
  eway_bill_records: [],
}

// ---- minimal in-memory Supabase query-builder fake ------------------------
class FakeQuery {
  private filters: Array<['eq' | 'in', string, any]> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | Row[] | null = null
  constructor(private table: string) {}
  select() { return this }
  order() { return this }
  limit() { return this }
  insert(payload: Row | Row[]) { this.mode = 'insert'; this.payload = payload; return this }
  update(payload: Row) { this.mode = 'update'; this.payload = payload; return this }
  eq(col: string, val: any) { this.filters.push(['eq', col, val]); return this }
  in(col: string, arr: any[]) { this.filters.push(['in', col, arr]); return this }
  private match(r: Row) {
    return this.filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : v.includes(r[c])))
  }
  private run() {
    const rows = store[this.table] ?? (store[this.table] = [])
    if (this.mode === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      items.forEach(r => rows.push({ ...r }))
      return { data: items, error: null }
    }
    if (this.mode === 'update') {
      const hit = rows.filter(r => this.match(r))
      hit.forEach(r => Object.assign(r, this.payload))
      return { data: hit, error: null }
    }
    return { data: rows.filter(r => this.match(r)), error: null }
  }
  maybeSingle() {
    const { data, error } = this.run()
    return Promise.resolve({ data: data && data.length ? data[0] : null, error })
  }
  single() { return this.maybeSingle() }
  then(onF: (v: { data: any; error: any }) => any, onR?: (e: any) => any) {
    return Promise.resolve(this.run()).then(onF, onR)
  }
}
const fakeSupabase = { from: (table: string) => new FakeQuery(table) }

// ---- assertions -----------------------------------------------------------
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (userId: string, role: string) => jwt.sign({ userId, role }, process.env.JWT_SECRET!)
const bookingStatus = () => store.bookings.find(b => b.id === B1)!.status

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')
  const { locationRoutes } = await import('../src/routes/location.js')
  const { redis, breadcrumbGateKey, driverLocationKey } = await import('../src/lib/redis.js')

  __setSupabaseClientForTests(fakeSupabase as any)
  await redis.del(breadcrumbGateKey(B1), driverLocationKey(D1))

  const app = Fastify({ logger: false })
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(bookingRoutes, { prefix: '/bookings' })
    await authed.register(locationRoutes, { prefix: '/location' })
  })
  await app.ready()

  const patch = (path: string, token: string) =>
    app.inject({ method: 'PATCH', url: path, headers: { authorization: `Bearer ${token}` } })

  console.log('\n── Lifecycle: accepted → in_transit → completed ──')
  let r = await patch(`/bookings/${B1}/start`, tok(U1, 'driver'))
  check('C1 start: accepted→in_transit returns 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('C1 start: booking status is in_transit', r.json().data?.status === 'in_transit', `(got ${r.json().data?.status})`)
  check('C1 start: store persisted in_transit', bookingStatus() === 'in_transit')

  // C2 — a driver must NOT be able to self-complete a trip.
  //
  // This assertion used to expect 200 from `PATCH /bookings/:id/complete`. That route was
  // deliberately removed (see the comment at bt-booking-service/src/routes/bookings.ts:110):
  // in_transit → completed is now closed ONLY by the receiver-OTP POD path
  // (internal /bookings/:id/complete-pod) or an ops force-complete. Letting a driver mark
  // their own delivery complete would defeat proof-of-delivery entirely — the driver is the
  // party POD exists to check.
  //
  // So the route being absent IS the contract, and this now pins it that way. The happy path
  // (POD closes the trip) is covered by pod.e2e.mts; ops force-complete by ops.e2e.mts.
  r = await patch(`/bookings/${B1}/complete`, tok(U1, 'driver'))
  check('C2 driver self-complete route does not exist', r.statusCode === 404, `(got ${r.statusCode})`)
  check('C2 booking is still in_transit after the attempt', bookingStatus() === 'in_transit', `(got ${bookingStatus()})`)

  // Drive it to completed the way production does — through the store — so the state-machine
  // checks below still exercise transitions out of `completed`.
  store.bookings.find(b => b.id === B1)!.status = 'completed'

  console.log('\n── State machine rejects illegal moves with 4xx (not 500) ──')
  r = await patch(`/bookings/${B1}/start`, tok(U1, 'driver')) // completed → in_transit is illegal
  check('C3 illegal start from completed returns 409', r.statusCode === 409, `(got ${r.statusCode})`)
  check('C3 illegal start is a 4xx not 5xx', r.statusCode >= 400 && r.statusCode < 500)
  check('C3 illegal start error envelope code', r.json().code === 'INVALID_TRANSITION', `(got ${r.json().code})`)

  // C3b — the driver-complete route is absent in EVERY state, not just in_transit. Asserting
  // it from `accepted` too stops a future change from quietly reintroducing self-completion
  // for some subset of statuses.
  store.bookings.find(b => b.id === B1)!.status = 'accepted'
  r = await patch(`/bookings/${B1}/complete`, tok(U1, 'driver'))
  check('C3b driver self-complete absent from accepted too', r.statusCode === 404, `(got ${r.statusCode})`)

  console.log('\n── Only the assigned driver may transition (others 403) ──')
  r = await patch(`/bookings/${B1}/start`, tok(U2, 'driver')) // driver 2, not assigned
  check('C4 non-assigned driver gets 403', r.statusCode === 403, `(got ${r.statusCode})`)
  r = await patch(`/bookings/${B1}/start`, tok(S1, 'shipper')) // shipper
  check('C4 shipper gets 403', r.statusCode === 403, `(got ${r.statusCode})`)
  check('C4 booking still accepted after rejected attempts', bookingStatus() === 'accepted')

  console.log('\n── Durable throttled breadcrumb write (real Redis gate) ──')
  store.location_history.length = 0
  await redis.del(breadcrumbGateKey(B1), driverLocationKey(D1))
  const post = () => app.inject({
    method: 'POST', url: '/location/update',
    headers: { authorization: `Bearer ${tok(U1, 'driver')}` },
    payload: { lat: 19.076, lng: 72.8777, heading: 90, speed_kmh: 40, booking_id: B1 },
  })
  const p1 = await post()
  check('C5 location update returns 200', p1.statusCode === 200, `(got ${p1.statusCode})`)
  check('C5 live position written to Redis', (await redis.get(driverLocationKey(D1))) !== null)
  check('C5 first update inserts a breadcrumb row', store.location_history.length === 1, `(got ${store.location_history.length})`)
  const bc = store.location_history[0]
  check('C5 breadcrumb matches PLAN §4.1 shape',
    bc?.booking_id === B1 && bc?.driver_id === D1 && bc?.lat === 19.076 && bc?.lng === 72.8777 &&
    bc?.heading === 90 && bc?.speed_kmh === 40 && bc?.accuracy_m === null && typeof bc?.recorded_at === 'string',
    JSON.stringify(bc))
  const p2 = await post() // within the 12s window
  check('C5 second update within window still 200', p2.statusCode === 200, `(got ${p2.statusCode})`)
  check('C5 throttle gate blocks second insert (still 1 row)', store.location_history.length === 1, `(got ${store.location_history.length})`)

  console.log('\n── ops can void a bad delivery_asserted assertion; a terminal trip stays frozen (F14) ──')
  const asserted = (id: string) => store.bookings.find(b => b.id === id)!.status
  r = await patch(`/bookings/${B_ASSERTED}/cancel`, tok('ops-user', 'admin'))
  check('🔴 ops cancels a delivery_asserted booking 200 (F14)', r.statusCode === 200, `(got ${r.statusCode}) ${r.body.slice(0, 120)}`)
  check('the delivery_asserted booking is now cancelled', asserted(B_ASSERTED) === 'cancelled', `(got ${asserted(B_ASSERTED)})`)
  // B_ASSERTED is now 'cancelled' (terminal) — re-cancelling is refused for everyone, ops included.
  r = await patch(`/bookings/${B_ASSERTED}/cancel`, tok('ops-user', 'admin'))
  check('ops cannot cancel an already-terminal (cancelled) booking 409', r.statusCode === 409, `(got ${r.statusCode})`)

  await app.close()
  await redis.del(breadcrumbGateKey(B1), driverLocationKey(D1))
  await redis.quit()

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
