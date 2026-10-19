/**
 * T-BE-6 — ops override endpoints (force-complete + reassign) + audit trail.
 * Real routes via app.inject() with fake Supabase seam + fake AuditStore.
 * Run: npx tsx test/ops.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
delete process.env.PAYMENT_SERVICE_URL // emit skips silently (covered by T-BE-4)

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

const B1 = '11111111-1111-4111-8111-111111111111' // in_transit — force-complete
const B2 = '22222222-2222-4222-8222-222222222222' // accepted — force-complete (ops override)
const B3 = '33333333-3333-4333-8333-333333333333' // pending — illegal source
const B4 = '44444444-4444-4444-8444-444444444444' // in_transit — reassign
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MISSING_DRIVER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Row = Record<string, any>
const store: Record<string, Row[]> = {
  bookings: [
    { id: B1, driver_id: D1, shipper_id: 's', status: 'in_transit', quoted_price: 1000, final_price: null },
    { id: B2, driver_id: D1, shipper_id: 's', status: 'accepted', quoted_price: 1000, final_price: null },
    { id: B3, driver_id: null, shipper_id: 's', status: 'pending', quoted_price: 1000, final_price: null },
    { id: B4, driver_id: D1, shipper_id: 's', status: 'in_transit', quoted_price: 1000, final_price: null },
  ],
  drivers: [{ id: D1, user_id: 'u1' }, { id: D2, user_id: 'u2' }],
}
class FakeQuery {
  private f: Array<['eq' | 'in', string, any]> = []
  private mode: 'select' | 'update' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.f.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.f.push(['in', c, v]); return this }
  private m(r: Row) { return this.f.every(([o, c, v]) => (o === 'eq' ? r[c] === v : v.includes(r[c]))) }
  private run() {
    const rows = store[this.table] ?? []
    if (this.mode === 'update') { const h = rows.filter(r => this.m(r)); h.forEach(r => Object.assign(r, this.payload)); return { data: h, error: null } }
    return { data: rows.filter(r => this.m(r)), error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data.length ? data[0] : null, error }) }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }
const auditRecords: any[] = []
const fakeAudit = { async record(e: any) { auditRecords.push(e) } }

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = (role: string) => jwt.sign({ userId: `user-${role}`, role }, process.env.JWT_SECRET!)
const b = (id: string) => store.bookings.find(x => x.id === id)!

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { opsRoutes } = await import('../src/routes/ops.js')
  __setSupabaseClientForTests(fakeSupabase as any)

  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(opsRoutes, { prefix: '/bookings', auditStore: fakeAudit }) })
  await app.ready()
  const post = (url: string, token?: string, body?: any) => app.inject({ method: 'POST', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body })

  console.log('\n── force-complete: ops/admin only ──')
  let r = await post(`/bookings/${B1}/force-complete`)
  check('no token 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await post(`/bookings/${B1}/force-complete`, tok('driver'))
  check('driver 403', r.statusCode === 403, `(got ${r.statusCode})`)
  r = await post(`/bookings/${B1}/force-complete`, tok('shipper'))
  check('shipper 403', r.statusCode === 403, `(got ${r.statusCode})`)
  check('booking still in_transit after rejected attempts', b(B1).status === 'in_transit')

  console.log('\n── force-complete: admin drives in_transit/accepted → completed ──')
  r = await post(`/bookings/${B1}/force-complete`, tok('admin'))
  check('admin force-complete in_transit 200', r.statusCode === 200 && r.json().data?.status === 'completed', `(got ${r.statusCode}/${r.json().data?.status})`)
  check('booking B1 now completed', b(B1).status === 'completed')
  check('audit row written (force_complete, in_transit→completed)', auditRecords.some(a => a.action === 'force_complete' && a.booking_id === B1 && a.from_status === 'in_transit' && a.to_status === 'completed'))
  r = await post(`/bookings/${B2}/force-complete`, tok('admin'))
  check('admin force-complete accepted→completed 200 (ops override)', r.statusCode === 200 && b(B2).status === 'completed', `(got ${r.statusCode}/${b(B2).status})`)
  r = await post(`/bookings/${B3}/force-complete`, tok('admin'))
  check('force-complete pending booking 409 (illegal source)', r.statusCode === 409, `(got ${r.statusCode})`)

  console.log('\n── reassign: ops/admin only, validates driver ──')
  r = await post(`/bookings/${B4}/reassign`, tok('shipper'), { driver_id: D2 })
  check('reassign as shipper 403', r.statusCode === 403, `(got ${r.statusCode})`)
  r = await post(`/bookings/${B4}/reassign`, tok('admin'), { driver_id: MISSING_DRIVER })
  check('reassign to non-existent driver 404', r.statusCode === 404, `(got ${r.statusCode})`)
  check('driver unchanged after failed reassign', b(B4).driver_id === D1)
  r = await post(`/bookings/${B4}/reassign`, tok('admin'), { driver_id: D2 })
  check('reassign to valid driver 200', r.statusCode === 200, `(got ${r.statusCode})`)
  check('booking B4 driver_id changed to D2', b(B4).driver_id === D2, `(got ${b(B4).driver_id})`)
  check('booking B4 status unchanged (in_transit)', b(B4).status === 'in_transit')
  check('audit row written (reassign, D1→D2)', auditRecords.some(a => a.action === 'reassign' && a.booking_id === B4 && a.from_driver_id === D1 && a.to_driver_id === D2))

  console.log('\n── reassign is refused outside an in-flight trip (review F17) ──')
  // B2 was force-completed above: its carrier of record is settled and must be immutable.
  r = await post(`/bookings/${B2}/reassign`, tok('admin'), { driver_id: D2 })
  check('🔴 reassign a completed booking 409 (F17)', r.statusCode === 409, `(got ${r.statusCode})`)
  check('the completed booking keeps its original driver', b(B2).driver_id === D1, `(got ${b(B2).driver_id})`)
  // B3 is pending — it has no driver yet; a crew is bound via accept/award, not an ops override.
  r = await post(`/bookings/${B3}/reassign`, tok('admin'), { driver_id: D2 })
  check('🔴 reassign a pending booking 409 (F17)', r.statusCode === 409, `(got ${r.statusCode})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
