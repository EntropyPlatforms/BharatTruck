/**
 * Consignee claim (D-35): completing a claim, and the four ways a claim must be refused. Registers the
 * REAL consigneeClaimRoutes + consigneeInternalRoutes against an in-memory Redis + Supabase, so the
 * single-use-token and unclaimed-only invariants run over the shipped logic.
 * Run: npx tsx test/consignee-claim.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'
process.env.EMAIL_DEV_MODE = 'true' // never touch a real SMTP host
process.env.INTERNAL_SERVICE_SECRET = 'internal-shhh'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>
let db: Record<string, Row[]> = {}

class FakeRedis {
  private store = new Map<string, string>()
  private expiries = new Map<string, number>()
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n }
  async expire(k: string, s: number) { this.expiries.set(k, s); return 1 }
  async ttl(k: string) { return this.expiries.get(k) ?? -1 }
  async get(k: string) { return this.store.get(k) ?? null }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK' }
  async del(k: string) { this.expiries.delete(k); return this.store.delete(k) ? 1 : 0 }
  peek(k: string) { return this.store.get(k) ?? null }
}

class FakeQuery {
  private eqs: Array<[string, any]> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  private match(r: Row) { return this.eqs.every(([c, v]) => r[c] === v) }
  private run() {
    const rows = db[this.table] ?? (db[this.table] = [])
    if (this.mode === 'insert') { const row = { id: `${this.table}-${rows.length + 1}`, ...this.payload }; rows.push(row); return { data: [row], error: null } }
    if (this.mode === 'update') { const hit = rows.filter(r => this.match(r)); hit.forEach(r => Object.assign(r, this.payload)); return { data: hit, error: null } }
    return { data: rows.filter(r => this.match(r)), error: null }
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

const claimToken = (userId: string) => jwt.sign({ userId, type: 'consignee_claim' }, process.env.JWT_SECRET!, { expiresIn: 3600 })
const claimKey = (userId: string) => `consignee_claim:${userId}`

async function main() {
  const { consigneeClaimRoutes, consigneeInternalRoutes } = await import('../src/routes/consignee.js')
  const redis = new FakeRedis()
  const app = Fastify({ logger: false })
  app.decorate('redis', redis as any)
  app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
  await app.register(consigneeClaimRoutes, { prefix: '/auth' })
  await app.register(consigneeInternalRoutes, { prefix: '/internal' })

  const complete = (token: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/consignee/claim/complete', payload: { token, password } })

  // ── Happy path: an UNCLAIMED record is claimed — password set + claimed_at stamped ──
  console.log('\n── claim completes: password + claimed_at ──')
  db = { users: [{ id: 'c1', role: 'shipper', email: 'rcv@x.com', full_name: 'Receiver', claimed_at: null, password_hash: null, google_sub: null, created_at: '2026-08-01T00:00:00Z' }] }
  const t1 = claimToken('c1')
  await redis.set(claimKey('c1'), t1)
  let r = await complete(t1, 'newpassword12')
  check('claim completes (200)', r.statusCode === 200, `(got ${r.statusCode}: ${r.body})`)
  check('claimed_at was stamped', db.users[0].claimed_at != null, JSON.stringify(db.users[0]))
  check('password_hash was set', typeof db.users[0].password_hash === 'string' && db.users[0].password_hash.length > 0, '')
  check('the row now reads as claimed (email_verified true)', db.users[0].email_verified === true, '')
  check('claim returns a session (access_token)', typeof r.json().data.access_token === 'string', '')
  check('single-use: the claim token was burned from redis', redis.peek(claimKey('c1')) === null, `(got ${redis.peek(claimKey('c1'))})`)

  // ── A burned token is refused ──
  console.log('\n── a burned token is refused ──')
  r = await complete(t1, 'anotherpass12')
  check('replaying the burned token → 400', r.statusCode === 400 && r.json().code === 'INVALID_CLAIM_TOKEN', `(got ${r.statusCode}/${r.json().code})`)

  // ── An already-claimed row is refused (fresh token, but claimed_at is set) ──
  console.log('\n── an already-claimed row is refused ──')
  db = { users: [{ id: 'c2', role: 'shipper', email: 'x@x.com', claimed_at: '2026-08-05T00:00:00Z', password_hash: 'existing-hash', google_sub: null }] }
  const t2 = claimToken('c2')
  await redis.set(claimKey('c2'), t2)
  r = await complete(t2, 'newpassword12')
  check('claim on an already-claimed row → 409 ALREADY_CLAIMED', r.statusCode === 409 && r.json().code === 'ALREADY_CLAIMED', `(got ${r.statusCode}/${r.json().code})`)
  check('the useless token is burned so a leaked link cannot be retried', redis.peek(claimKey('c2')) === null, '')

  // ── A claim on a credentialed (real) account is refused, even if claimed_at is somehow null ──
  console.log('\n── a claim on a credentialed real account is refused ──')
  db = { users: [{ id: 'c3', role: 'shipper', email: 'real@x.com', claimed_at: null, password_hash: 'real-account-hash', google_sub: null }] }
  const t3 = claimToken('c3')
  await redis.set(claimKey('c3'), t3)
  r = await complete(t3, 'newpassword12')
  check('a password_hash present → refused 409 (no takeover)', r.statusCode === 409, `(got ${r.statusCode})`)
  check('the real account password was NOT overwritten', db.users[0].password_hash === 'real-account-hash', db.users[0].password_hash)

  // ── Internal claim-invite: secret-gated, unclaimed-only, idempotent ──
  // consignee_user_id is validated as a UUID, so the ids here are real UUIDs.
  console.log('\n── POST /internal/consignee/claim-invite ──')
  const INV1 = '11111111-1111-4111-8111-111111111111'
  const INV2 = '22222222-2222-4222-8222-222222222222'
  const INV3 = '33333333-3333-4333-8333-333333333333'
  const invite = (headers: Row, body: Row) => app.inject({ method: 'POST', url: '/internal/consignee/claim-invite', headers, payload: body })
  db = { users: [{ id: INV1, role: 'shipper', email: 'inv@x.com', claimed_at: null, password_hash: null, google_sub: null }] }
  r = await invite({}, { consignee_user_id: INV1 })
  check('no internal secret → 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await invite({ 'x-internal-secret': 'wrong' }, { consignee_user_id: INV1 })
  check('wrong internal secret → 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await invite({ 'x-internal-secret': 'internal-shhh' }, { consignee_user_id: INV1 })
  check('valid secret + unclaimed + email → 202 emailed', r.statusCode === 202 && r.json().data.emailed === true, `(got ${r.statusCode}: ${r.body})`)
  check('a single-use claim token was stored for the consignee', typeof redis.peek(claimKey(INV1)) === 'string', '')

  // already-claimed consignee → idempotent no-op, not an error (booking-service retry stays green)
  db = { users: [{ id: INV2, role: 'shipper', email: 'inv2@x.com', claimed_at: '2026-08-01T00:00:00Z', password_hash: 'h', google_sub: null }] }
  r = await invite({ 'x-internal-secret': 'internal-shhh' }, { consignee_user_id: INV2 })
  check('already-claimed consignee → 200 emailed:false (idempotent)', r.statusCode === 200 && r.json().data.emailed === false, `(got ${r.statusCode}: ${r.body})`)

  // consignee with no email on record → reported plainly, not a failure
  db = { users: [{ id: INV3, role: 'shipper', email: null, claimed_at: null, password_hash: null, google_sub: null }] }
  r = await invite({ 'x-internal-secret': 'internal-shhh' }, { consignee_user_id: INV3 })
  check('no-email consignee → 200 emailed:false reason no_email', r.statusCode === 200 && r.json().data.reason === 'no_email', `(got ${r.statusCode}: ${r.body})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
