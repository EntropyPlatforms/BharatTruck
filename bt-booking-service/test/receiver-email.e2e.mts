/**
 * PATCH /bookings/:id/receiver-email — the write path that unblocks a stuck POD.
 *
 * A booking with no receiver_email cannot be completed: the driver's POD request
 * has no address to send the delivery code to, so the trip sticks in `in_transit`
 * and the payout it gates never happens. Until this route existed the column was
 * settable exactly once, at creation.
 *
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase.
 * Run: REDIS_URL=redis://localhost:6379 npx tsx test/receiver-email.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

const B_TRANSIT = '11111111-1111-4111-8111-111111111111'
const B_PAID    = '22222222-2222-4222-8222-222222222222'
const S1        = '33333333-3333-4333-8333-333333333333'
const S2        = '44444444-4444-4444-8444-444444444444'
const U_DRIVER  = '55555555-5555-4555-8555-555555555555'
const D1        = '66666666-6666-4666-8666-666666666666'
const U_ADMIN   = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

function reset() {
  store.bookings = [
    { id: B_TRANSIT, shipper_id: S1, driver_id: D1, status: 'in_transit', receiver_email: null,
      source_address: 'Mumbai', destination_address: 'Raipur', load_type: 'general',
      weight_kg: 100, pickup_date: '2026-08-04', quoted_price: 1000, final_price: null },
    { id: B_PAID, shipper_id: S1, driver_id: D1, status: 'paid', receiver_email: 'old@example.com',
      source_address: 'Mumbai', destination_address: 'Raipur', load_type: 'general',
      weight_kg: 100, pickup_date: '2026-08-04', quoted_price: 1000, final_price: null },
  ]
  store.drivers = [{ id: D1, user_id: U_DRIVER, truck_number: 'MH04 1234' }]
  store.users = [
    { id: S1, email: 'shipper@example.com', full_name: 'Shipper One' },
    { id: S2, email: 'other@example.com', full_name: 'Shipper Two' },
  ]
  store.notification_outbox = []
  store.notification_preferences = []
}

class FakeQuery {
  private filters: Array<['eq' | 'in', string, any]> = []
  private mode: 'select' | 'update' | 'insert' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  lte() { return this }
  order() { return this }
  limit() { return this }
  private match(r: Row) {
    return this.filters.every(([o, c, v]) => (o === 'eq' ? r[c] === v : v.includes(r[c])))
  }
  private run() {
    const rows = store[this.table] ?? (store[this.table] = [])
    if (this.mode === 'insert') {
      const p = this.payload as Row
      if (this.table === 'notification_outbox' && rows.some(r => r.dedupe_key === p.dedupe_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      const row = { id: `r${rows.length + 1}`, status: 'pending', attempts: 0, ...p }
      rows.push(row)
      return { data: [row], error: null }
    }
    const hit = rows.filter(r => this.match(r))
    if (this.mode === 'update') { hit.forEach(r => Object.assign(r, this.payload)); return { data: hit, error: null } }
    return { data: hit, error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data?.length ? data[0] : null, error }) }
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
const bookingRow = (id: string) => store.bookings.find(b => b.id === id)!

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(bookingRoutes, { prefix: '/bookings' }) })
  await app.ready()

  const patch = (id: string, token: string, body: unknown) => app.inject({
    method: 'PATCH', url: `/bookings/${id}/receiver-email`,
    headers: { authorization: `Bearer ${token}` }, payload: body as any,
  })

  // ── Authorization ─────────────────────────────────────────────────────────
  console.log('\n── authorization')
  reset()

  check('no token 401',
    (await app.inject({ method: 'PATCH', url: `/bookings/${B_TRANSIT}/receiver-email`, payload: { receiver_email: 'a@b.co' } })).statusCode === 401)

  let res = await patch(B_TRANSIT, tok(S2, 'shipper'), { receiver_email: 'a@b.co' })
  check('a DIFFERENT shipper cannot set it 403', res.statusCode === 403, String(res.statusCode))
  check('and the booking is untouched', bookingRow(B_TRANSIT).receiver_email === null)

  // The carrier must not be able to redirect where the delivery code goes — that
  // would hand them both halves of the proof-of-delivery check.
  res = await patch(B_TRANSIT, tok(U_DRIVER, 'driver'), { receiver_email: 'driver@evil.co' })
  check('the assigned DRIVER cannot set it 403', res.statusCode === 403, String(res.statusCode))
  check('and the booking is still untouched', bookingRow(B_TRANSIT).receiver_email === null)

  // ── Happy path ────────────────────────────────────────────────────────────
  console.log('\n── owning shipper sets it')
  res = await patch(B_TRANSIT, tok(S1, 'shipper'), { receiver_email: 'consignee@acme.co.in' })
  check('owning shipper 200', res.statusCode === 200, res.body.slice(0, 120))
  check('persisted', bookingRow(B_TRANSIT).receiver_email === 'consignee@acme.co.in')
  check('returns the updated booking',
    JSON.parse(res.body).data?.receiver_email === 'consignee@acme.co.in')

  console.log('\n── ops can set it too (they unstick trips for both parties)')
  reset()
  res = await patch(B_TRANSIT, tok(U_ADMIN, 'admin'), { receiver_email: 'ops-set@acme.co.in' })
  check('admin 200', res.statusCode === 200, String(res.statusCode))
  check('persisted', bookingRow(B_TRANSIT).receiver_email === 'ops-set@acme.co.in')

  // ── Validation ────────────────────────────────────────────────────────────
  console.log('\n── validation')
  reset()
  for (const bad of ['not-an-email', '', 'a@', '@b.co']) {
    res = await patch(B_TRANSIT, tok(S1, 'shipper'), { receiver_email: bad })
    check(`rejects ${JSON.stringify(bad)} with 400`, res.statusCode === 400, String(res.statusCode))
  }
  res = await patch(B_TRANSIT, tok(S1, 'shipper'), {})
  check('rejects a missing field 400', res.statusCode === 400)
  check('nothing persisted through any rejection', bookingRow(B_TRANSIT).receiver_email === null)

  // Typed on a phone at the drop — a pasted address with padding must not be
  // rejected as malformed.
  res = await patch(B_TRANSIT, tok(S1, 'shipper'), { receiver_email: '  spaced@acme.co.in  ' })
  check('trims surrounding whitespace and accepts', res.statusCode === 200, String(res.statusCode))
  check('stored trimmed', bookingRow(B_TRANSIT).receiver_email === 'spaced@acme.co.in',
    String(bookingRow(B_TRANSIT).receiver_email))

  // ── Terminal statuses ─────────────────────────────────────────────────────
  console.log('\n── terminal bookings are frozen')
  reset()
  res = await patch(B_PAID, tok(S1, 'shipper'), { receiver_email: 'rewrite@acme.co.in' })
  check('paid booking 409', res.statusCode === 409, String(res.statusCode))
  check('the proven delivery is not rewritten',
    bookingRow(B_PAID).receiver_email === 'old@example.com')

  // ── Missing booking ───────────────────────────────────────────────────────
  res = await patch('99999999-9999-4999-8999-999999999999', tok(S1, 'shipper'), { receiver_email: 'a@b.co' })
  check('unknown booking 404', res.statusCode === 404, String(res.statusCode))

  res = await patch('not-a-uuid', tok(S1, 'shipper'), { receiver_email: 'a@b.co' })
  check('malformed id 400', res.statusCode === 400, String(res.statusCode))

  // ── The blocked-POD notification ──────────────────────────────────────────
  // The driver asking for a POD code on a booking with no receiver email is the
  // moment the trip would otherwise silently dead-end.
  console.log('\n── driver hits the wall → shipper is told')
  reset()
  const podCtx = () => app.inject({
    method: 'GET', url: `/bookings/${B_TRANSIT}/pod-context`,
    headers: { authorization: `Bearer ${tok(U_DRIVER, 'driver')}` },
  })

  res = await podCtx()
  check('pod-context still 200 for the driver', res.statusCode === 200, String(res.statusCode))
  check('and reports no receiver email', JSON.parse(res.body).data?.receiver_email === null)
  check('a notification was queued for the shipper', store.notification_outbox.length === 1,
    JSON.stringify(store.notification_outbox))
  check('addressed to the shipper',
    store.notification_outbox[0]?.recipient_email === 'shipper@example.com')
  check('with the right event type',
    store.notification_outbox[0]?.event_type === 'receiver_email_missing')

  await podCtx(); await podCtx()
  check('retrying the button does NOT spam the shipper', store.notification_outbox.length === 1,
    `queued ${store.notification_outbox.length}`)

  // Once the shipper fixes it, the wall is gone and nothing further is queued.
  reset()
  await patch(B_TRANSIT, tok(S1, 'shipper'), { receiver_email: 'consignee@acme.co.in' })
  res = await podCtx()
  check('after the fix, pod-context returns the address',
    JSON.parse(res.body).data?.receiver_email === 'consignee@acme.co.in')
  check('and no blocked-POD notification is queued', store.notification_outbox.length === 0)

  console.log(`\nRESULT: ${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
