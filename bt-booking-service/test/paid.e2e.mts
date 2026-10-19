/**
 * T-BE-4 (booking-service side) — completed → paid transition + internal
 * mark-paid endpoint. Real routes via app.inject() + fake Supabase seam.
 * Run: npx tsx test/paid.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'

const B1 = '11111111-1111-4111-8111-111111111111' // completed
const B2 = '22222222-2222-4222-8222-222222222222' // in_transit
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type Row = Record<string, any>
const store: Record<string, Row[]> = {
  bookings: [
    { id: B1, driver_id: D1, shipper_id: 'ship', status: 'completed' },
    { id: B2, driver_id: D1, shipper_id: 'ship', status: 'in_transit' },
  ],
  drivers: [{ id: D1, user_id: 'u1' }],
}
class FakeQuery {
  private f: Array<['eq', string, any]> = []
  private mode: 'select' | 'update' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.f.push(['eq', c, v]); return this }
  private m(r: Row) { return this.f.every(([, c, v]) => r[c] === v) }
  private run() {
    const rows = store[this.table] ?? []
    if (this.mode === 'update') { const h = rows.filter(r => this.m(r)); h.forEach(r => Object.assign(r, this.payload)); return { data: h, error: null } }
    return { data: rows.filter(r => this.m(r)), error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data.length ? data[0] : null, error }) }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const status = (id: string) => store.bookings.find(b => b.id === id)!.status

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const internalAuth = (await import('../src/plugins/internal-auth.js')).default
  const { internalRoutes } = await import('../src/routes/internal.js')
  const { assertValidTransition } = await import('../src/lib/state.js')
  __setSupabaseClientForTests(fakeSupabase as any)

  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(internalAuth); await a.register(internalRoutes, { prefix: '/internal' }) })
  await app.ready()
  const SECRET = process.env.INTERNAL_SERVICE_SECRET!
  const markPaid = (id: string, secret?: string) => app.inject({
    method: 'POST', url: `/internal/bookings/${id}/mark-paid`,
    headers: secret ? { 'x-internal-secret': secret } : {},
  })

  console.log('\n── state machine ──')
  let threw = false
  try { assertValidTransition('completed' as any, 'paid' as any) } catch { threw = true }
  check('completed→paid is a legal transition', !threw)
  threw = false
  try { assertValidTransition('in_transit' as any, 'paid' as any) } catch (e: any) { threw = e?.httpStatus === 409 }
  check('in_transit→paid rejected 409', threw)

  console.log('\n── internal mark-paid ──')
  let r = await markPaid(B1, 'wrong')
  check('mark-paid wrong secret 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await markPaid(B1)
  check('mark-paid missing secret 401', r.statusCode === 401, `(got ${r.statusCode})`)
  check('booking still completed after rejected calls', status(B1) === 'completed')
  r = await markPaid(B2, SECRET)
  check('mark-paid on in_transit booking 409 (not 500)', r.statusCode === 409, `(got ${r.statusCode})`)
  r = await markPaid(B1, SECRET)
  check('mark-paid completed→paid 200', r.statusCode === 200 && r.json().data?.status === 'paid', `(got ${r.statusCode}/${r.json().data?.status})`)
  check('booking persisted as paid', status(B1) === 'paid')
  r = await markPaid(B1, SECRET)
  check('mark-paid replay on paid booking 409 (idempotent guard)', r.statusCode === 409, `(got ${r.statusCode})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
