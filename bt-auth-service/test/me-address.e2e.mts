/**
 * PATCH /auth/me/address — a shipper's billing address (18 Oct audit: users.address/city/state/
 * pincode existed but nothing filled them). Pins: the caller updates ONLY their own row; the PIN
 * code is validated; blanks clear a field; the profile returned carries the address; unknown
 * fields and empty bodies are refused; no token → 401.
 * Run: npx tsx test/me-address.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.EMAIL_DEV_MODE = 'true'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>
const db: Record<string, Row[]> = {
  users: [
    { id: 'u-ship', email: 's@x.example', full_name: 'S', role: 'shipper', address: null, city: null, state: null, pincode: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'u-other', email: 'o@x.example', full_name: 'O', role: 'shipper', address: 'Keep me', city: 'Nagpur', state: 'MH', pincode: '440001', created_at: '2026-01-01T00:00:00Z' },
  ],
}
class Q {
  private f: Array<[string, any]> = []
  private patch: Row | null = null
  constructor(private t: string) {}
  select() { return this }
  eq(c: string, v: any) { this.f.push([c, v]); return this }
  update(p: Row) { this.patch = p; return this }
  private rows() { return (db[this.t] ?? []).filter((r) => this.f.every(([c, v]) => r[c] === v)) }
  single() {
    const rs = this.rows()
    if (this.patch) rs.forEach((r) => Object.assign(r, this.patch))
    return Promise.resolve({ data: rs[0] ?? null, error: rs[0] ? null : { message: 'none' } })
  }
  maybeSingle() { return this.single() }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { authRoutes } = await import('../src/routes/auth.js')
  const app = Fastify({ logger: false })
  app.decorate('redis', { get: async () => null, set: async () => 'OK', del: async () => 1, incr: async () => 1, expire: async () => 1, ttl: async () => -1 } as any)
  app.decorate('supabase', { from: (t: string) => new Q(t) } as any)
  await app.register(authRoutes, { prefix: '/auth' })
  const token = jwt.sign({ userId: 'u-ship', role: 'shipper' }, process.env.JWT_SECRET!, { expiresIn: 900 })
  const patch = (body: unknown, auth = true) => app.inject({ method: 'PATCH', url: '/auth/me/address', headers: auth ? { authorization: `Bearer ${token}` } : {}, payload: body as any })

  let r = await patch({ address: '12 MG Road, Shivajinagar', city: 'Pune', state: 'Maharashtra', pincode: '411005' })
  check('saves the address (200) and returns it on the profile', r.statusCode === 200 && r.json().data.user.city === 'Pune' && r.json().data.user.pincode === '411005', r.body)
  check('only the caller\'s row changed', db.users[1].address === 'Keep me' && db.users[0].address === '12 MG Road, Shivajinagar')
  r = await patch({ pincode: '12345' })
  check('a 5-digit PIN is refused (400)', r.statusCode === 400 && /PIN/.test(r.json().error), r.body)
  r = await patch({ pincode: '011005' })
  check('a PIN starting with 0 is refused', r.statusCode === 400)
  r = await patch({ address: '   ' })
  check('a blank field clears it (null), others untouched', r.statusCode === 200 && db.users[0].address === null && db.users[0].city === 'Pune', JSON.stringify(db.users[0]))
  r = await patch({})
  check('an empty body is refused', r.statusCode === 400)
  r = await patch({ role: 'admin' })
  check('unknown fields (e.g. role) are refused — no privilege edits through this route', r.statusCode === 400 && db.users[0].role === 'shipper')
  r = await patch({ city: 'Mumbai' }, false)
  check('no token → 401', r.statusCode === 401)
  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
