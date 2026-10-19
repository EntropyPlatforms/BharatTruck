/**
 * Live-location privacy: who may READ a position, and when one may be WRITTEN at all.
 *
 * THE TWO BUGS THIS EXISTS FOR:
 *
 *  1. FAIL-OPEN READS. GET /location/driver/:driver_id and GET /location/booking/:booking_id
 *     branched on 'driver' and 'shipper' and then simply continued. fleet_owner (a role since
 *     migration 0014) matched neither, so any fleet account could read ANY driver's current
 *     coordinates by uuid, and any booking's live position — a cross-tenant leak. No test
 *     covered a third role, which is why it survived.
 *
 *  2. UNTRACKED GPS. POST /location/update took booking_id as OPTIONAL and put every trip and
 *     status check inside `if (booking_id)`. A payload that omitted it skipped all of them and
 *     still wrote loc:driver:{id}, so an OFF-DUTY driver's position was cached — and
 *     bt-fleet-service's GET /fleet/live MGETs that key for every driver on the roster
 *     regardless of assignment.
 *
 * The checks are deliberately about what must NOT be visible and what must NOT be stored: a
 * test that only asserted "the owning fleet can see its own truck" passed against both bugs.
 *
 * Exercises the REAL routes via app.inject(), with the in-memory fake Supabase seam and the
 * REAL local Redis so the writes being asserted about are the actual ones.
 * Run: REDIS_URL=redis://localhost:6379 npx tsx test/location-scope.e2e.mts
 */

// Env must be set before importing modules that read it at import time (redis.ts).
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ---- fixtures -------------------------------------------------------------
// Fleet A runs BA with its employed driver DA. Fleet B and driver DX are unrelated
// to it in every direction — they are the tenants the leak crossed.
const FLEET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'   // fleet_owners.id
const FLEET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FA_USER = 'a1111111-1111-4111-8111-111111111111'   // users.id behind FLEET_A
const FB_USER = 'b1111111-1111-4111-8111-111111111111'

const DA = 'd0000000-0000-4000-8000-00000000000a'        // drivers.id, fleet A's driver
const DX = 'd0000000-0000-4000-8000-00000000000b'        // drivers.id, unrelated solo driver
const DI = 'd0000000-0000-4000-8000-00000000000c'        // drivers.id, off duty
const UA = 'c1111111-1111-4111-8111-11111111111a'        // users.id behind DA
const UX = 'c1111111-1111-4111-8111-11111111111b'
const UI = 'c1111111-1111-4111-8111-11111111111c'

const BA = 'e0000000-0000-4000-8000-00000000000a'        // fleet A's live trip
const BX = 'e0000000-0000-4000-8000-00000000000b'        // solo driver's live trip
const BX2 = 'e0000000-0000-4000-8000-00000000000d'       // DX's second live trip (added late)
const BI = 'e0000000-0000-4000-8000-00000000000c'        // finished trip, off-duty driver

const SHIPPER_A = 'f1111111-1111-4111-8111-11111111111a'
const SHIPPER_X = 'f1111111-1111-4111-8111-11111111111b'
const ADMIN = 'f1111111-1111-4111-8111-11111111111f'

type Row = Record<string, any>
const store: Record<string, Row[]> = {
  bookings: [
    { id: BA, shipper_id: SHIPPER_A, driver_id: DA, status: 'in_transit', fleet_owner_id: FLEET_A, vehicle_id: null, updated_at: '2026-08-07T10:00:00Z' },
    { id: BX, shipper_id: SHIPPER_X, driver_id: DX, status: 'accepted',   fleet_owner_id: null,    vehicle_id: null, updated_at: '2026-08-07T09:00:00Z' },
    { id: BI, shipper_id: SHIPPER_X, driver_id: DI, status: 'completed',  fleet_owner_id: null,    vehicle_id: null, updated_at: '2026-08-06T09:00:00Z' },
  ],
  drivers: [{ id: DA, user_id: UA }, { id: DX, user_id: UX }, { id: DI, user_id: UI }],
  fleet_owners: [
    { id: FLEET_A, user_id: FA_USER, company_name: 'Fleet A Logistics', is_active: true },
    { id: FLEET_B, user_id: FB_USER, company_name: 'Fleet B Carriers',  is_active: true },
  ],
  // DA is employed by fleet A; DX is nobody's employee.
  fleet_drivers: [{ id: 'fd-a', fleet_owner_id: FLEET_A, driver_id: DA, status: 'active' }],
  vehicles: [],
  vehicle_assignments: [],
  location_history: [],
}

// ---- minimal in-memory Supabase query-builder fake ------------------------
class FakeQuery {
  private filters: Array<['eq' | 'in', string, any]> = []
  private mode: 'select' | 'insert' = 'select'
  private payload: Row | Row[] | null = null
  constructor(private table: string) {}
  select() { return this }
  order() { return this }
  limit() { return this }
  insert(payload: Row | Row[]) { this.mode = 'insert'; this.payload = payload; return this }
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

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { locationRoutes } = await import('../src/routes/location.js')
  const { redis, driverLocationKey, driverBookingKey, bookingDriverKey, breadcrumbGateKey } =
    await import('../src/lib/redis.js')

  __setSupabaseClientForTests(fakeSupabase as any)

  const allKeys = [
    driverLocationKey(DA), driverLocationKey(DX), driverLocationKey(DI),
    driverBookingKey(DA), driverBookingKey(DX), driverBookingKey(DI),
    bookingDriverKey(BA), bookingDriverKey(BX), bookingDriverKey(BX2), bookingDriverKey(BI),
    breadcrumbGateKey(BA), breadcrumbGateKey(BX), breadcrumbGateKey(BX2), breadcrumbGateKey(BI),
  ]
  await redis.del(...allKeys)

  const app = Fastify({ logger: false })
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(locationRoutes, { prefix: '/location' })
  })
  await app.ready()

  const get = (path: string, user: string, role: string) =>
    app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${tok(user, role)}` } })
  const post = (user: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST', url: '/location/update',
      headers: { authorization: `Bearer ${tok(user, 'driver')}` },
      payload,
    })

  // Seed both live positions, so a read that should be refused would otherwise hand
  // back real coordinates — the leak has something to leak.
  const fix = (driverId: string, bookingId: string) => JSON.stringify({
    driver_id: driverId, lat: 19.076, lng: 72.8777, heading: null, speed_kmh: null,
    accuracy_m: null, booking_id: bookingId, updated_at: new Date().toISOString(),
  })
  await redis.set(driverLocationKey(DA), fix(DA, BA), 'EX', 60)
  await redis.set(driverLocationKey(DX), fix(DX, BX), 'EX', 60)

  console.log('\n── HOLE 1: GET /location/driver/:driver_id is closed by default ──')
  let r = await get(`/location/driver/${DX}`, FA_USER, 'fleet_owner')
  check('fleet A cannot read an unrelated driver by uuid', r.statusCode === 403, `(got ${r.statusCode})`)
  check('and no coordinates come back with it', r.json().data == null, JSON.stringify(r.json().data))

  r = await get(`/location/driver/${DA}`, FB_USER, 'fleet_owner')
  check("fleet B cannot read fleet A's driver", r.statusCode === 403, `(got ${r.statusCode})`)

  // FB-11: JWT role is not an authz axis. SHIPPER_A owns the live trip with DA —
  // a non-canonical role claim must not strip that relation (strangers stay 403 above/below).
  r = await get(`/location/driver/${DA}`, SHIPPER_A, 'receiver')
  check('shipper relation still reads with a non-canonical JWT role', r.statusCode === 200, `(got ${r.statusCode})`)

  r = await get(`/location/driver/${DA}`, UX, 'driver')
  check("a driver cannot read another driver's position", r.statusCode === 403, `(got ${r.statusCode})`)

  r = await get(`/location/driver/${DX}`, SHIPPER_A, 'shipper')
  check('a shipper with no live trip with that driver gets 403', r.statusCode === 403, `(got ${r.statusCode})`)

  console.log('\n── HOLE 1: the legitimate relations still work ──')
  r = await get(`/location/driver/${DA}`, FA_USER, 'fleet_owner')
  check('fleet A reads its own driver running its own trip', r.statusCode === 200, `(got ${r.statusCode})`)
  check('and gets the position', r.json().data?.lat === 19.076, JSON.stringify(r.json().data))

  r = await get(`/location/driver/${DA}`, UA, 'driver')
  check('the driver reads their own position', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/driver/${DX}`, SHIPPER_X, 'shipper')
  check('the shipper on the live trip reads their driver', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/driver/${DX}`, ADMIN, 'admin')
  check('admin bypass is explicit and preserved', r.statusCode === 200, `(got ${r.statusCode})`)

  console.log('\n── HOLE 1: a fleet reaches a TRIP, never a PERSON ──')
  // Same fleet, same driver, same seeded position — only the trip has ended. If the grant
  // were employment-based rather than trip-based this would still be 200.
  store.bookings.find(b => b.id === BA)!.status = 'completed'
  r = await get(`/location/driver/${DA}`, FA_USER, 'fleet_owner')
  check("fleet A loses its own driver's position once the trip ends", r.statusCode === 403, `(got ${r.statusCode})`)
  store.bookings.find(b => b.id === BA)!.status = 'in_transit'

  console.log('\n── HOLE 1: GET /location/booking/:booking_id is closed by default ──')
  r = await get(`/location/booking/${BX}`, FA_USER, 'fleet_owner')
  check("fleet A cannot read a booking it has no reach over", r.statusCode === 403, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, FB_USER, 'fleet_owner')
  check("fleet B cannot read fleet A's booking", r.statusCode === 403, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, SHIPPER_A, 'receiver')
  check('shipper relation still reads booking with a non-canonical JWT role', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, SHIPPER_X, 'shipper')
  check("a shipper cannot read another shipper's trip", r.statusCode === 403, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, UX, 'driver')
  check('an unassigned driver cannot read the trip', r.statusCode === 403, `(got ${r.statusCode})`)

  r = await get(`/location/booking/${BA}`, FA_USER, 'fleet_owner')
  check('the owning fleet still reads its own trip', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, SHIPPER_A, 'shipper')
  check('the owning shipper still reads their trip', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, UA, 'driver')
  check('the assigned driver still reads the trip', r.statusCode === 200, `(got ${r.statusCode})`)
  r = await get(`/location/booking/${BA}`, ADMIN, 'admin')
  check('admin still reads the trip', r.statusCode === 200, `(got ${r.statusCode})`)

  console.log('\n── HOLE 2: a fix with no active trip is refused, and nothing is stored ──')
  let p = await post(UI, { lat: 19.1, lng: 72.9 })
  check('off-duty driver, no booking_id → 409', p.statusCode === 409, `(got ${p.statusCode})`)
  check('error is INVALID_TRANSITION', p.json().code === 'INVALID_TRANSITION', `(got ${p.json().code})`)
  check('NOTHING was written to loc:driver:{id}', (await redis.get(driverLocationKey(DI))) === null)

  p = await post(UI, { lat: 19.1, lng: 72.9, booking_id: BI })
  check('naming a finished booking is still 409', p.statusCode === 409, `(got ${p.statusCode})`)
  check('still nothing stored for the off-duty driver', (await redis.get(driverLocationKey(DI))) === null)

  p = await post(UA, { lat: 19.1, lng: 72.9, booking_id: BX })
  check("a driver cannot post against someone else's trip", p.statusCode === 403, `(got ${p.statusCode})`)

  console.log('\n── HOLE 2: an active trip still ingests exactly as before ──')
  await redis.del(driverLocationKey(DA), driverBookingKey(DA), bookingDriverKey(BA), breadcrumbGateKey(BA))
  store.location_history.length = 0
  p = await post(UA, { lat: 19.076, lng: 72.8777, heading: 90, speed_kmh: 40, booking_id: BA })
  check('the app payload (booking_id present) is unchanged → 200', p.statusCode === 200, `(got ${p.statusCode})`)
  check('live position written', (await redis.get(driverLocationKey(DA))) !== null)
  check('driver→booking key written', (await redis.get(driverBookingKey(DA))) === BA)
  check('booking→driver key written', (await redis.get(bookingDriverKey(BA))) === DA)
  check('breadcrumb inserted', store.location_history.length === 1, `(got ${store.location_history.length})`)
  const p2 = await post(UA, { lat: 19.077, lng: 72.8778, booking_id: BA })
  check('a second fix inside the 12s window still 200', p2.statusCode === 200, `(got ${p2.statusCode})`)
  check('and the throttle gate still blocks its insert', store.location_history.length === 1, `(got ${store.location_history.length})`)

  console.log('\n── HOLE 2: an omitted booking_id resolves to the trip, it does not skip it ──')
  await redis.del(driverLocationKey(DX), driverBookingKey(DX), bookingDriverKey(BX), breadcrumbGateKey(BX))
  p = await post(UX, { lat: 18.5, lng: 73.8 })
  check('driver on a live trip, no booking_id → 200', p.statusCode === 200, `(got ${p.statusCode})`)
  check('the response names the resolved trip', p.json().data?.booking_id === BX, JSON.stringify(p.json().data))
  check('and the trip keys were written, not skipped', (await redis.get(bookingDriverKey(BX))) === DX)

  // Two live trips is legitimate (one accepted while another is in_transit) and the fix
  // belongs to exactly one — guessing would file breadcrumbs against the wrong trip.
  store.bookings.push({ id: BX2, shipper_id: SHIPPER_X, driver_id: DX, status: 'in_transit', fleet_owner_id: null, vehicle_id: null, updated_at: '2026-08-07T11:00:00Z' })
  p = await post(UX, { lat: 18.6, lng: 73.9 })
  check('two live trips + no booking_id → 400, not a guess', p.statusCode === 400, `(got ${p.statusCode})`)
  p = await post(UX, { lat: 18.6, lng: 73.9, booking_id: BX2 })
  check('naming one of them resolves the ambiguity → 200', p.statusCode === 200, `(got ${p.statusCode})`)

  await app.close()
  await redis.del(...allKeys)
  await redis.quit()

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
