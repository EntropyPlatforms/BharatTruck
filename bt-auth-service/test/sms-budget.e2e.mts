/**
 * Global daily SMS budget on /auth/send-otp (review F10).
 *
 * The per-phone otp_rate counter (5/hr) is bypassed by an attacker who spreads sends across many
 * DISTINCT valid Indian mobiles — each gets a fresh per-phone counter — draining the provider
 * balance so no real user receives a code. A service-wide sms_budget:<day> key is the ceiling that
 * actually binds, exactly as SMTP_DAILY_BUDGET does for email. This pins that it binds across
 * distinct numbers.
 *
 * Registers the REAL authRoutes on a bare Fastify with an in-memory Redis. Run: npx tsx test/sms-budget.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-refresh-hs256'
process.env.SMS_DAILY_BUDGET = '2' // tiny, so a 3rd distinct phone exhausts it
delete process.env.SMS_PROVIDER    // console provider — no real SMS, no credentials
delete process.env.OTP_DEV_MODE
delete process.env.NODE_ENV

import Fastify from 'fastify'

// Only what /auth/send-otp touches, plus ttl (consume() reads it once the budget is spent).
class FakeRedis {
  private store = new Map<string, string>()
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n }
  async expire() { return 1 }
  async ttl() { return 3600 }
  async get(k: string) { return this.store.get(k) ?? null }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK' }
  async del(k: string) { return this.store.delete(k) ? 1 : 0 }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { authRoutes } = await import('../src/routes/auth.js')
  const app = Fastify({ logger: false })
  app.decorate('redis', new FakeRedis() as any)
  app.decorate('supabase', {} as any) // /send-otp never touches it
  await app.register(authRoutes, { prefix: '/auth' })
  const send = (phone: string) => app.inject({ method: 'POST', url: '/auth/send-otp', payload: { phone } })

  console.log('\n── the per-phone throttle is bypassed by distinct numbers; the GLOBAL budget binds')
  // SMS_DAILY_BUDGET=2. Three DISTINCT valid mobiles each clear their own per-phone counter, but
  // they share one sms_budget:<day> key, so the third send is refused (F10).
  const r1 = await send('9811111111')
  const r2 = await send('9822222222')
  const r3 = await send('9833333333')
  check('1st distinct phone → 200 (within budget)', r1.statusCode === 200, `(got ${r1.statusCode})`)
  check('2nd distinct phone → 200 (within budget)', r2.statusCode === 200, `(got ${r2.statusCode})`)
  check('🔴 3rd distinct phone → 429: the shared SMS budget is exhausted (F10)', r3.statusCode === 429, `(got ${r3.statusCode}: ${r3.body})`)

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
