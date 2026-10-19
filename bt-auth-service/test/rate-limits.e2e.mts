/**
 * Auth throttles — brute-force lockout, OTP guess caps, and SMTP-drain guards.
 * Registers the REAL authRoutes on a bare Fastify instance with an in-memory
 * Redis and Supabase, so the assertions run against the shipped route logic.
 * Run: npx tsx test/rate-limits.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'
process.env.EMAIL_DEV_MODE = 'true' // never touch a real SMTP host
process.env.LOGIN_FAIL_LIMIT = '10'
process.env.OTP_VERIFY_LIMIT = '5'
process.env.EMAIL_SEND_LIMIT = '5'
process.env.SMTP_DAILY_BUDGET = '12'

import Fastify from 'fastify'
import bcrypt from 'bcrypt'

const PASSWORD = 'correct-horse-battery'

type Row = Record<string, any>
let users: Row[] = []

// ── Fake Redis: only the commands the throttles use. Values are strings, as in
// the real client, so a bug that assumes numbers surfaces here rather than in prod.
class FakeRedis {
  private store = new Map<string, string>()
  private expiries = new Map<string, number>()
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n }
  async expire(k: string, s: number) { this.expiries.set(k, s); return 1 }
  async ttl(k: string) { return this.expiries.get(k) ?? -1 }
  async get(k: string) { return this.store.get(k) ?? null }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK' }
  async del(k: string) { this.expiries.delete(k); return this.store.delete(k) ? 1 : 0 }
  /** Test-only reach-in, so a case can assert an OTP was burned. */
  peek(k: string) { return this.store.get(k) ?? null }
}

class FakeQuery {
  private f: Array<[string, any]> = []
  private mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  upsert(p: Row) { this.mode = 'upsert'; this.payload = p; return this }
  eq(c: string, v: any) { this.f.push([c, v]); return this }
  private m(r: Row) { return this.f.every(([c, v]) => r[c] === v) }
  private run() {
    if (this.table !== 'users') return { data: [], error: null }
    if (this.mode === 'insert') {
      const row = { id: `u${users.length + 1}`, role: 'shipper', email_verified: false, ...this.payload }
      users.push(row)
      return { data: [row], error: null }
    }
    if (this.mode === 'update') {
      const hit = users.filter(r => this.m(r))
      hit.forEach(r => Object.assign(r, this.payload))
      return { data: hit, error: null }
    }
    if (this.mode === 'upsert') return { data: [], error: null }
    return { data: users.filter(r => this.m(r)), error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { authRoutes } = await import('../src/routes/auth.js')

  const redis = new FakeRedis()
  const app = Fastify({ logger: false })
  app.decorate('redis', redis as any)
  app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
  await app.register(authRoutes, { prefix: '/auth' })

  const post = (url: string, payload: any) => app.inject({ method: 'POST', url, payload })
  const login = (email: string, password: string) => post('/auth/email/login', { email, password })

  users = [
    { id: 'u1', email: 'driver@example.com', password_hash: await bcrypt.hash(PASSWORD, 4), role: 'driver', email_verified: true },
    { id: 'u2', email: 'other@example.com', password_hash: await bcrypt.hash(PASSWORD, 4), role: 'shipper', email_verified: true },
  ]

  console.log('\n── login brute-force lockout ──')
  let r = await login('driver@example.com', 'wrong')
  check('wrong password still 401 (not thrown)', r.statusCode === 401, `(got ${r.statusCode})`)
  for (let i = 0; i < 9; i++) await login('driver@example.com', 'wrong')
  r = await login('driver@example.com', 'wrong')
  check('11th attempt 429 TOO_MANY_ATTEMPTS', r.statusCode === 429 && r.json().code === 'TOO_MANY_ATTEMPTS', `(got ${r.statusCode}/${r.json().code})`)
  r = await login('driver@example.com', PASSWORD)
  check('correct password ALSO refused once locked', r.statusCode === 429, `(got ${r.statusCode})`)
  r = await login('other@example.com', PASSWORD)
  check('lockout is per-account, not global', r.statusCode === 200, `(got ${r.statusCode})`)

  console.log('\n── a success clears the tally ──')
  await redis.del('login_fail:other@example.com')
  for (let i = 0; i < 9; i++) await login('other@example.com', 'wrong')
  r = await login('other@example.com', PASSWORD)
  check('9 failures then success 200', r.statusCode === 200, `(got ${r.statusCode})`)
  for (let i = 0; i < 9; i++) await login('other@example.com', 'wrong')
  r = await login('other@example.com', 'wrong')
  check('counter reset by the success (10th failure still 401)', r.statusCode === 401, `(got ${r.statusCode})`)

  console.log('\n── unknown addresses are charged too (no enumeration oracle) ──')
  for (let i = 0; i < 10; i++) await login('ghost@example.com', 'wrong')
  r = await login('ghost@example.com', 'wrong')
  check('unknown email locks out like a real one', r.statusCode === 429, `(got ${r.statusCode})`)

  console.log('\n── OTP guess cap + burn ──')
  users.push({ id: 'u3', email: 'otp@example.com', role: 'shipper', email_verified: false })
  await redis.set('email_otp:otp@example.com', '123456')
  for (let i = 0; i < 4; i++) await post('/auth/email/verify', { email: 'otp@example.com', otp: '000000' })
  check('OTP survives the first 4 wrong guesses', redis.peek('email_otp:otp@example.com') === '123456', '')
  r = await post('/auth/email/verify', { email: 'otp@example.com', otp: '000000' })
  check('5th wrong guess still 401', r.statusCode === 401, `(got ${r.statusCode})`)
  check('OTP burned at the cap', redis.peek('email_otp:otp@example.com') === null, `(got ${redis.peek('email_otp:otp@example.com')})`)
  r = await post('/auth/email/verify', { email: 'otp@example.com', otp: '123456' })
  check('the real code no longer works after the burn', r.statusCode === 429, `(got ${r.statusCode})`)

  console.log('\n── per-address send throttle ──')
  const reg = (email: string) => post('/auth/email/register', { email, password: 'password123', full_name: 'Test User', role: 'shipper' })
  for (let i = 0; i < 5; i++) await reg('flood@example.com')
  const before = users.length
  r = await reg('flood@example.com')
  check('6th send to one address 429', r.statusCode === 429, `(got ${r.statusCode})`)
  check('throttled register wrote no users row', users.length === before, `(${before} → ${users.length})`)

  console.log('\n── global daily SMTP budget ──')
  // Budget is 12 and the flood above spent 5. Spend the rest across DISTINCT
  // addresses — the exact shape the per-address counter cannot see. Registration
  // accepts any address and sends an OTP, so it is the route an attacker would use.
  for (let i = 0; i < 7; i++) await reg(`spread${i}@example.com`)
  r = await reg('fresh@example.com')
  check('budget exhausted across distinct addresses 429', r.statusCode === 429, `(got ${r.statusCode})`)

  console.log('\n── forgot-password still absorbs silently ──')
  // A DIFFERENT mail route draws down the SAME budget: forgot-password is now over
  // budget too, but it must stay enumeration-safe and return generic success, never 429.
  r = await post('/auth/forgot-password', { email: 'driver@example.com' })
  check('over-budget reset returns generic success, not 429', r.statusCode === 200, `(got ${r.statusCode})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
