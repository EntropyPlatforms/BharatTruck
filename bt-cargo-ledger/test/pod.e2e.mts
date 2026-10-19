/**
 * T-BE-2 (cross-service) — receiver-OTP POD closes the trip.
 * Boots the REAL bt-booking-service app in-process on an ephemeral port
 * (fake Supabase via its injection seam) and drives the full POD flow through
 * the REAL HttpBookingClient (real HTTP), REAL Redis, mocked email + POD store.
 * Proves: OTP issued → wrong rejected → correct completes the trip across
 * services, plus rate-limiting, replay protection, and cross-service authz.
 * Run: REDIS_URL=redis://localhost:6379 npx tsx test/pod.e2e.mts
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.JWT_SECRET = 'shared-test-jwt-secret-hs256-both-services'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-shared'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import { createHmac } from 'node:crypto'

// Minimal HS256 JWT signer (avoids a test-only jsonwebtoken dependency in
// cargo-ledger). Produces a standard token that booking-service verifies.
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`
  const sig = createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}

const B1 = '11111111-1111-4111-8111-111111111111'
const D1 = '22222222-2222-4222-8222-222222222222'
const D2 = '33333333-3333-4333-8333-333333333333'
const U1 = '44444444-4444-4444-8444-444444444444'
const U2 = '55555555-5555-4555-8555-555555555555'
const RECEIVER = 'consignee@example.com'

type Row = Record<string, any>
// A faithful PRE-0025 database backing the REAL booking-service booted in-process.
// The IDENTITY tables (drivers/fleet_owners/vehicles/fleet_drivers) DO exist — they
// predate 0025 (migrations 0014/0016/0022) — because the booking de-role made
// getPodContext resolve the caller's PersonaSnapshot via resolvePersonas(), which reads
// all four. Seeded EMPTY except drivers: this booking has no fleet, so the snapshot
// carries only the drive capability, exactly as the solo-driver POD flow expects. Absent
// them, resolvePersonas' 42P01 checks would throw and every POD request would 500.
// The POD-hardening tables (pod_evidence, …) are ABSENT and answer PostgREST's 42P01, so
// podFeatureAvailable()'s probe returns false and the trip closes with today's exact
// pre-0025 behaviour — no geofence gate — which is what this cross-service flow asserts.
const bstore: Record<string, Row[]> = {
  bookings: [{ id: B1, driver_id: D1, shipper_id: 'ship', status: 'in_transit', receiver_email: RECEIVER }],
  drivers: [{ id: D1, user_id: U1 }, { id: D2, user_id: U2 }],
  fleet_owners: [],
  vehicles: [],
  fleet_drivers: [],
}
const MISSING_RELATION = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
class FakeQuery {
  private f: Array<['eq' | 'in' | 'is', string, any]> = []
  private mode: 'select' | 'update' | 'insert' | 'upsert' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  upsert(p: Row) { this.mode = 'upsert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.f.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.f.push(['in', c, v]); return this }
  is(c: string, v: any) { this.f.push(['is', c, v]); return this }
  limit() { return this }
  order() { return this }
  private m(r: Row) {
    return this.f.every(([o, c, v]) =>
      o === 'eq' ? r[c] === v : o === 'in' ? v.includes(r[c]) : (r[c] ?? null) === v)
  }
  private run() {
    // The pre-0025 truth: a table that is not seeded is not there — answer 42P01, exactly
    // as PostgREST would, so podFeatureAvailable's feature probe reads "0025 not applied"
    // and completeBookingViaPod's best-effort POD writes (pod_state upsert, audit inserts)
    // swallow the missing relation instead of 500ing after the status flip.
    if (!(this.table in bstore)) return MISSING_RELATION
    const rows = bstore[this.table]
    if (this.mode === 'insert' || this.mode === 'upsert') { const row = { ...this.payload }; rows.push(row); return { data: [row], error: null } }
    if (this.mode === 'update') { const h = rows.filter(r => this.m(r)); h.forEach(r => Object.assign(r, this.payload)); return { data: h, error: null } }
    return { data: rows.filter(r => this.m(r)), error: null }
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
const tok = (u: string) => signJwt({ userId: u, role: 'driver' }, process.env.JWT_SECRET!)
const bStatus = () => bstore.bookings[0].status

async function main() {
  const SECRET = process.env.INTERNAL_SERVICE_SECRET!

  // 1) Boot the REAL booking-service (fake Supabase) on an ephemeral port.
  const { __setSupabaseClientForTests } = await import('../../bt-booking-service/src/lib/supabase.js')
  const bookingAuth = (await import('../../bt-booking-service/src/plugins/auth.js')).default
  const bookingInternalAuth = (await import('../../bt-booking-service/src/plugins/internal-auth.js')).default
  const { bookingRoutes } = await import('../../bt-booking-service/src/routes/bookings.js')
  const { internalRoutes } = await import('../../bt-booking-service/src/routes/internal.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const bookingApp = Fastify({ logger: false })
  await bookingApp.register(async (a) => { await a.register(bookingAuth); await a.register(bookingRoutes, { prefix: '/bookings' }) })
  await bookingApp.register(async (a) => { await a.register(bookingInternalAuth); await a.register(internalRoutes, { prefix: '/internal' }) })
  await bookingApp.listen({ port: 0, host: '127.0.0.1' })
  const addr = bookingApp.server.address() as { port: number }
  const bookingBase = `http://127.0.0.1:${addr.port}`

  // 2) Boot the cargo POD app with a REAL HttpBookingClient → bookingBase.
  const { podRoutes } = await import('../src/routes/pod.js')
  const { HttpBookingClient } = await import('../src/lib/booking-client.js')
  const { redis, podOtpKey, podAttemptsKey } = await import('../src/lib/redis.js')
  await redis.del(podOtpKey(B1), podAttemptsKey(B1))
  const mockEmail = { last: null as any, async send(m: any) { this.last = m } }
  const fakeStore = { receipts: [] as any[], async record(r: any) { this.receipts.push(r) } }
  const deps = { booking: new HttpBookingClient(bookingBase, SECRET), email: mockEmail, store: fakeStore }
  const cargoApp = Fastify({ logger: false })
  await cargoApp.register(podRoutes, { prefix: '/pod', deps })
  await cargoApp.ready()

  const reqOtp = (bearer?: string) => cargoApp.inject({
    method: 'POST', url: '/pod/request-otp',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { booking_id: B1 },
  })
  const verify = (otp: string) => cargoApp.inject({
    method: 'POST', url: '/pod/verify-otp', payload: { booking_id: B1, otp },
  })
  const extractOtp = () => String(mockEmail.last.text.match(/(\d{6})/)[1])

  console.log('\n── request-otp authorization (delegated to booking-service over real HTTP) ──')
  let r = await reqOtp() // no bearer
  check('request-otp without Bearer 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await reqOtp(tok(U2)) // non-assigned driver → booking pod-context 403 → propagated
  check('request-otp non-assigned driver 403 (cross-service authz)', r.statusCode === 403, `(got ${r.statusCode})`)

  console.log('\n── issue → wrong → correct completes the trip ──')
  r = await reqOtp(tok(U1))
  check('request-otp assigned driver 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('OTP emailed to receiver', mockEmail.last?.to === RECEIVER, JSON.stringify(mockEmail.last?.to))
  check('sent_to is masked (not full email)', r.json().data?.sent_to !== RECEIVER && String(r.json().data?.sent_to).includes('@'), JSON.stringify(r.json().data?.sent_to))
  const otp = extractOtp()
  const wrong = otp === '000000' ? '111111' : '000000'
  r = await verify(wrong)
  check('verify wrong OTP 400 OTP_INVALID', r.statusCode === 400 && r.json().code === 'OTP_INVALID', `(got ${r.statusCode}/${r.json().code})`)
  check('booking still in_transit after wrong OTP', bStatus() === 'in_transit', `(got ${bStatus()})`)
  r = await verify(otp)
  check('verify correct OTP 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('trip completed across services (in_transit→completed)', r.json().data?.status === 'completed' && bStatus() === 'completed', `(got ${bStatus()})`)
  check('durable POD receipt recorded (best-effort)', fakeStore.receipts.length === 1 && fakeStore.receipts[0].booking_id === B1, JSON.stringify(fakeStore.receipts))
  check('OTP key cleared from Redis (one-time)', (await redis.get(podOtpKey(B1))) === null)
  r = await verify(otp) // replay
  check('replay of used OTP 410 OTP_EXPIRED', r.statusCode === 410 && r.json().code === 'OTP_EXPIRED', `(got ${r.statusCode}/${r.json().code})`)

  console.log('\n── rate-limiting (5 wrong then burn) ──')
  bstore.bookings[0].status = 'in_transit' // reset for a fresh POD cycle
  await redis.del(podOtpKey(B1), podAttemptsKey(B1))
  r = await reqOtp(tok(U1))
  const otp2 = extractOtp()
  const wrong2 = otp2 === '000000' ? '111111' : '000000'
  let last = 0
  for (let i = 1; i <= 5; i++) { r = await verify(wrong2); last = r.statusCode }
  check('first 5 wrong attempts all 400', last === 400, `(last ${last})`)
  r = await verify(wrong2) // 6th
  check('6th attempt 429 RATE_LIMITED', r.statusCode === 429 && r.json().code === 'RATE_LIMITED', `(got ${r.statusCode}/${r.json().code})`)
  r = await verify(otp2) // correct but code burned
  check('correct OTP after burn 410 (code destroyed)', r.statusCode === 410, `(got ${r.statusCode})`)
  check('booking NOT completed via rate-limited path', bStatus() === 'in_transit', `(got ${bStatus()})`)

  await cargoApp.close()
  await bookingApp.close()
  await redis.del(podOtpKey(B1), podAttemptsKey(B1))
  await redis.quit()

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
