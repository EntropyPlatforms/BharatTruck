/**
 * T-BE-2 (booking-service side) — POD context + internal completion.
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase
 * (T-BE-1 injection seam). Not shipped (under test/, excluded from tsc src).
 * Run: REDIS_URL=redis://localhost:6379 npx tsx test/pod.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

const B1 = '11111111-1111-4111-8111-111111111111'
const D1 = '22222222-2222-4222-8222-222222222222'
const D2 = '33333333-3333-4333-8333-333333333333'
const U1 = '44444444-4444-4444-8444-444444444444'
const U2 = '55555555-5555-4555-8555-555555555555'
const S1 = '66666666-6666-4666-8666-666666666666'
const RECEIVER = 'consignee@example.com'

type Row = Record<string, any>
// A faithful PRE-0025 database. Every 0025 table (pod_evidence, pod_state,
// pod_discrepancies, pod_audit_log) — and anything else the hardening might read
// (geofence_events, trip_telemetry) — is ABSENT and answers PostgREST's 42P01.
// This is the whole point of the file: it pins that on a database without 0025
// the receiver-OTP POD behaves EXACTLY as it always did — no geofence gate, no
// strength ledger, no extra field — because the feature probe comes back "not here".
//
// The IDENTITY tables (drivers/fleet_owners/vehicles/fleet_drivers) DO exist —
// they predate 0025 (migrations 0014/0016/0022) and are present on any real
// pre-0025 database — so getPodContext's assigned-driver check, which now
// resolves the caller's persona snapshot, has the tables it reads. They are
// seeded EMPTY except drivers: this booking has no fleet, so the snapshot carries
// only the drive capability, exactly as the solo-driver POD flow expects.
const store: Record<string, Row[]> = {
  bookings: [{ id: B1, driver_id: D1, shipper_id: S1, status: 'in_transit', receiver_email: RECEIVER }],
  drivers: [{ id: D1, user_id: U1 }, { id: D2, user_id: U2 }],
  fleet_owners: [],
  vehicles: [],
  fleet_drivers: [],
}
const MISSING_RELATION = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
class FakeQuery {
  private filters: Array<['eq' | 'in' | 'is', string, any]> = []
  private mode: 'select' | 'update' | 'insert' | 'upsert' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  upsert(p: Row) { this.mode = 'upsert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  is(c: string, v: any) { this.filters.push(['is', c, v]); return this }
  limit() { return this }
  order() { return this }
  private match(r: Row) {
    return this.filters.every(([o, c, v]) =>
      o === 'eq' ? r[c] === v : o === 'in' ? v.includes(r[c]) : (r[c] ?? null) === v)
  }
  private run() {
    // The pre-0025 truth: the table is not there.
    if (!(this.table in store)) return MISSING_RELATION
    const rows = store[this.table]
    if (this.mode === 'insert' || this.mode === 'upsert') { const row = { ...this.payload }; rows.push(row); return { data: [row], error: null } }
    if (this.mode === 'update') { const hit = rows.filter(r => this.match(r)); hit.forEach(r => Object.assign(r, this.payload)); return { data: hit, error: null } }
    return { data: rows.filter(r => this.match(r)), error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data?.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)
const status = () => store.bookings[0].status

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const internalAuthPlugin = (await import('../src/plugins/internal-auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')
  const { internalRoutes } = await import('../src/routes/internal.js')
  __setSupabaseClientForTests(fakeSupabase as any)

  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(bookingRoutes, { prefix: '/bookings' }) })
  await app.register(async (a) => { await a.register(internalAuthPlugin); await a.register(internalRoutes, { prefix: '/internal' }) })
  await app.ready()

  const SECRET = process.env.INTERNAL_SERVICE_SECRET!

  console.log('\n── POD context (assigned-driver-only, in_transit-only) ──')
  let r = await app.inject({ method: 'GET', url: `/bookings/${B1}/pod-context`, headers: { authorization: `Bearer ${tok(U1, 'driver')}` } })
  check('pod-context assigned driver 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('pod-context returns receiver_email', r.json().data?.receiver_email === RECEIVER, JSON.stringify(r.json().data))
  // PRE-0025 CONTRACT: no geofence gate ran, and the payload is exactly today's three
  // fields — the feature probe (pod_evidence) came back 42P01, so getPodContext returned
  // the base context untouched. A geofence key appearing here would mean the gate ran on
  // a database that never got migration 0025.
  check('pod-context carries NO geofence field pre-0025', r.json().data?.geofence === undefined, JSON.stringify(r.json().data))
  r = await app.inject({ method: 'GET', url: `/bookings/${B1}/pod-context`, headers: { authorization: `Bearer ${tok(U2, 'driver')}` } })
  check('pod-context non-assigned driver 403', r.statusCode === 403, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'GET', url: `/bookings/${B1}/pod-context`, headers: { authorization: `Bearer ${tok(S1, 'shipper')}` } })
  check('pod-context shipper 403', r.statusCode === 403, `(got ${r.statusCode})`)

  console.log('\n── Internal complete-pod (shared-secret gated, state machine) ──')
  r = await app.inject({ method: 'POST', url: `/internal/bookings/${B1}/complete-pod`, headers: { 'x-internal-secret': 'wrong' } })
  check('complete-pod wrong secret 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: `/internal/bookings/${B1}/complete-pod` })
  check('complete-pod missing secret 401', r.statusCode === 401, `(got ${r.statusCode})`)
  check('booking still in_transit after rejected internal calls', status() === 'in_transit', `(got ${status()})`)
  r = await app.inject({ method: 'POST', url: `/internal/bookings/${B1}/complete-pod`, headers: { 'x-internal-secret': SECRET } })
  check('complete-pod correct secret 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('booking moved in_transit→completed', r.json().data?.status === 'completed' && status() === 'completed', `(got ${status()})`)
  r = await app.inject({ method: 'POST', url: `/internal/bookings/${B1}/complete-pod`, headers: { 'x-internal-secret': SECRET } })
  check('complete-pod on completed booking 409 (not 500)', r.statusCode === 409, `(got ${r.statusCode})`)

  console.log('\n── pod-context rejects non-in_transit ──')
  store.bookings[0].status = 'accepted'
  r = await app.inject({ method: 'GET', url: `/bookings/${B1}/pod-context`, headers: { authorization: `Bearer ${tok(U1, 'driver')}` } })
  check('pod-context on accepted booking 409', r.statusCode === 409, `(got ${r.statusCode})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
