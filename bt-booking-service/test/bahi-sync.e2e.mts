/**
 * Bahi Khata sync through Bahi's EXISTING API (lib/bahi/*) — no Bahi change, no migration.
 * A fake Bahi mirrors the live contract: login → access + refresh (rotating), parties, items,
 * draft transactions, submit, approval (required for sales invoices), idempotent payments.
 * A fake Redis stands in for the booking service's Redis.
 *
 * Pins: the password is never stored, only the sealed refresh token, rotated on each use;
 * staff logins are refused; shipper → paid purchase invoice at once; carrier → sales invoice
 * sent for the shipper's approval, then submitted + paid once approved; a replay never creates
 * a second invoice; Bahi down never throws into the payment path and is retried.
 *
 * Run: npx tsx test/bahi-sync.e2e.mts
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.BAHI_CREDENTIALS_KEY = 'ab'.repeat(32)
process.env.BAHI_API_URL = 'https://bahi.test'

type Row = Record<string, any>
const SHIPPER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER_USER = 'aaaaaaaa-0000-4000-8000-000000000002'
const FLEET = 'bbbbbbbb-0000-4000-8000-000000000001'
const BOOKING = 'cccccccc-0000-4000-8000-000000000001'

// ── fake Supabase ──
const db: Record<string, Row[]> = {
  users: [
    { id: SHIPPER, full_name: 'Anita Sharma', email: 'anita@traders.example', phone_number: '9876500001', gstin: '27AAPFU0939F1ZV' },
    { id: OWNER_USER, full_name: 'Ravi Patil', email: 'ravi@roadways.example', phone_number: '9876500002', gstin: null },
  ],
  fleet_owners: [{ id: FLEET, user_id: OWNER_USER, company_name: 'Patil Roadways', gstin: '27ABCPE1234F1ZB' }],
  drivers: [],
  payments: [],
}
class Q {
  private eqs: Array<[string, any]> = []
  constructor(private table: string) {}
  select() { return this } order() { return this } limit() { return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  maybeSingle() { return Promise.resolve({ data: (db[this.table] ?? []).find((r) => this.eqs.every(([c, v]) => r[c] === v)) ?? null, error: null }) }
}

// ── fake Redis ──
const kv = new Map<string, string>()
const zs = new Map<string, Map<string, number>>()
const fakeRedis = {
  async get(k: string) { return kv.get(k) ?? null },
  async set(k: string, v: string, ...args: any[]) { if (args.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK' },
  async del(k: string) { kv.delete(k); return 1 },
  async zadd(k: string, s: number, m: string) { (zs.get(k) ?? zs.set(k, new Map()).get(k)!).set(m, s); return 1 },
  async zrevrange(k: string, a: number, b: number) { return [...(zs.get(k) ?? new Map()).entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0]).slice(a, b + 1) },
  async zremrangebyrank() { return 0 },
}

// ── fake Bahi (two tenants: the carrier's and the shipper's books) ──
type Tenant = { company: string; gstin: string; role: string; parties: Row[]; items: Row[]; txns: Row[]; payments: Map<string, Row>; approvals: Map<string, Row>; seq: number }
const tenants: Record<string, Tenant> = {
  'ravi@roadways.example': { company: 'Patil Roadways', gstin: '27ABCPE1234F1ZB', role: 'ADMIN', parties: [], items: [], txns: [], payments: new Map(), approvals: new Map(), seq: 0 },
  'anita@traders.example': { company: 'Anita Traders', gstin: '27AAPFU0939F1ZV', role: 'ADMIN', parties: [], items: [], txns: [], payments: new Map(), approvals: new Map(), seq: 0 },
  'staff@roadways.example': { company: 'Patil Roadways', gstin: '27ABCPE1234F1ZB', role: 'STAFF', parties: [], items: [], txns: [], payments: new Map(), approvals: new Map(), seq: 0 },
}
const refreshTokens = new Map<string, string>() // refresh → email
const accessTokens = new Map<string, string>()  // access → email
let n = 0
const issue = (email: string) => { const a = `acc-${++n}`, r = `ref-${n}`; accessTokens.set(a, email); refreshTokens.set(r, email); return { access_token: a, refresh_token: r } }
let bahiDown = false
const calls: string[] = []
const passwordsSeen: string[] = []

globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  if (bahiDown) throw new Error('ECONNREFUSED')
  const u = new URL(String(url)); const path = u.pathname.replace('/api/v1', ''); const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : {}
  calls.push(`${method} ${path}`)
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s })
  if (path === '/auth/login') {
    passwordsSeen.push(body.password)
    const t = tenants[body.email]; if (!t || body.password !== 'right-pass') return json({ detail: 'Invalid credentials' }, 401)
    return json({ ...issue(body.email), token_type: 'bearer', user: { name: 'x', email: body.email, role: t.role, tenant_id: 'T' } })
  }
  if (path === '/auth/refresh') {
    const email = refreshTokens.get(body.refresh_token); if (!email) return json({ detail: 'Invalid or expired refresh token' }, 401)
    refreshTokens.delete(body.refresh_token) // rotation: the old token dies
    return json(issue(email))
  }
  const email = accessTokens.get(String(new Headers(init.headers).get('Authorization')).replace('Bearer ', ''))
  if (!email) return json({ detail: 'Not authenticated' }, 401)
  const t = tenants[email]
  if (path === '/settings') return json({ name: t.company, gstin: t.gstin })
  if (path === '/parties' && method === 'GET') return json({ items: t.parties })
  if (path === '/parties') { const id = `P-${++t.seq}`; t.parties.push({ id, ...body }); return json({ id, status: 'created' }) }
  if (path === '/items' && method === 'GET') return json({ items: t.items })
  if (path === '/items') { const id = `I-${++t.seq}`; t.items.push({ id, ...body, is_stock_item: body.is_stock_item === false ? 0 : 1 }); return json({ id }) }
  if (path === '/transactions' && method === 'POST') {
    const l = body.items[0]; const tax = Math.round(l.rate * l.gst_rate) / 100; const id = `TXN-${++t.seq}`
    t.txns.push({ id, ...body, docstatus: 0, status: 'DRAFT', grand_total: l.rate + tax, naming_series: `${body.txn_type}-000${t.txns.length + 1}` })
    return json({ id, grand_total: l.rate + tax, status: 'DRAFT' })
  }
  const m = path.match(/^\/(transactions|documents)\/([^/]+)(?:\/(.*))?$/)
  if (m) {
    const txn = t.txns.find((x) => x.id === m[2]); if (!txn) return json({ detail: 'Transaction not found' }, 404)
    if (m[1] === 'transactions' && !m[3]) return json(txn)
    if (m[3] === 'submit') {
      if (txn.docstatus === 1) return json({ detail: 'Transaction not found or already submitted' }, 400)
      if (txn.txn_type === 'SINV' && t.approvals.get(txn.id)?.status !== 'APPROVED') return json({ detail: 'External approval is required before submitting this invoice' }, 400)
      txn.docstatus = 1; txn.status = 'UNPAID'; return json({ id: txn.id, status: 'UNPAID' })
    }
    if (m[3] === 'approval/send') { t.approvals.set(txn.id, { status: 'PENDING', recipient_email: body.email }); return json({ approval: t.approvals.get(txn.id) }) }
    if (m[3] === 'approval') return json({ approval: t.approvals.get(txn.id) ?? null })
  }
  if (path === '/payments') {
    if (t.payments.has(body.request_id)) return json({ id: body.request_id, status: 'already recorded' })
    const txn = t.txns.find((x) => x.id === body.invoice_id)
    if (!txn || txn.docstatus !== 1) return json({ detail: 'Invoice is not open for payment' }, 400)
    t.payments.set(body.request_id, body); txn.status = 'PAID'; return json({ id: body.request_id })
  }
  return json({ detail: `fake: no route ${method} ${path}` }, 404)
}) as any

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests({ from: (t: string) => new Q(t) } as any)
  const store = await import('../src/lib/bahi/store.js')
  store.__setBahiRedisForTests(fakeRedis as any)
  const posting = await import('../src/lib/bahi/posting.js')
  const bahi = await import('../src/lib/bahi/service.js')
  const { BookingError } = await import('../src/lib/types.js')

  console.log('\n── pure ──')
  const s5 = posting.splitInclusive(18900, 5)
  check('5% inclusive → 18000 + 900', s5.taxable === 18000 && s5.total === 18900, JSON.stringify(s5))
  const s12 = posting.splitInclusive(10000, 12)
  check('12% inclusive never exceeds what was paid', s12.total <= 10000 && 10000 - s12.total < 0.02, JSON.stringify(s12))

  console.log('\n── linking ──')
  const wrong = await bahi.connect(OWNER_USER, { email: 'ravi@roadways.example', password: 'nope' }).then(() => null, (e) => e)
  check('a wrong password is refused in plain words', wrong instanceof BookingError && /did not accept/.test(wrong.message), String(wrong?.message))
  const staff = await bahi.connect(OWNER_USER, { email: 'staff@roadways.example', password: 'right-pass' }).then(() => null, (e) => e)
  check('a staff login is refused (cannot record payments)', staff instanceof BookingError && /owner or manager/.test(staff.message))
  const view = await bahi.connect(OWNER_USER, { email: 'ravi@roadways.example', password: 'right-pass', gst_rate: 5 })
  check('linked to the Bahi company', view.linked && view.company_name === 'Patil Roadways' && view.gst_rate === 5, JSON.stringify(view))
  const stored = [...kv.values()].join('|')
  check('the password is never stored', !stored.includes('right-pass'))
  const conn = JSON.parse(kv.get(`bahi:conn:${OWNER_USER}`)!)
  check('only the refresh token is kept, sealed', !stored.includes('ref-') && /^ref-\d+$/.test(store.unseal(conn.refresh_sealed)))

  console.log('\n── a paid load (only the carrier linked) ──')
  const booking = { id: BOOKING, shipper_id: SHIPPER, driver_id: null, fleet_owner_id: FLEET, source_address: 'Pune, MH', destination_address: 'Mumbai, MH', weight_kg: 9000, quoted_price: 18900, final_price: null, status: 'paid' }
  await bahi.onBookingPaid(booking, { amount: 18900, method: 'razorpay', paymentId: 'pay_ABC' })
  const ct = tenants['ravi@roadways.example']
  check('sales invoice drafted to the shipper (found/created by GSTIN)', ct.txns.length === 1 && ct.txns[0].txn_type === 'SINV' && ct.parties[0]?.gstin === '27AAPFU0939F1ZV' && ct.parties[0]?.role_type === 'CUSTOMER')
  check('5%: 18000 taxable, 18900 total, freight item SAC 996511 non-stock', ct.txns[0].items[0].rate === 18000 && ct.txns[0].grand_total === 18900 && ct.items[0]?.hsn_sac === '996511' && ct.items[0]?.is_stock_item === 0)
  check('approval emailed to the shipper', ct.approvals.get(ct.txns[0].id)?.recipient_email === 'anita@traders.example')
  let rec = JSON.parse(kv.get(`bahi:post:${BOOKING}:income`)!)
  check('recorded as awaiting approval, not paid yet', rec.status === 'awaiting_approval' && ct.payments.size === 0, rec.status)
  const refreshesBefore = calls.filter((c) => c === 'POST /auth/refresh').length
  check('the refresh token rotated and was re-stored', store.unseal(JSON.parse(kv.get(`bahi:conn:${OWNER_USER}`)!).refresh_sealed) !== store.unseal(conn.refresh_sealed) && refreshesBefore >= 1)

  await bahi.onBookingPaid(booking, { amount: 18900, method: 'razorpay', paymentId: 'pay_ABC' })
  check('a replay never drafts a second invoice', ct.txns.length === 1)

  ct.approvals.get(ct.txns[0].id)!.status = 'APPROVED'
  const after = await bahi.syncPending(OWNER_USER)
  check('once approved: submitted and paid with the same reference', ct.txns[0].docstatus === 1 && [...ct.payments.values()][0]?.reference === 'pay_ABC' && [...ct.payments.values()][0]?.payment_type === 'RECEIVE')
  check('…and shown as posted with its Bahi number', after[0]?.status === 'posted' && after[0]?.bahi_number === 'SINV-0001', JSON.stringify(after[0]))

  console.log('\n── the shipper links too ──')
  await bahi.connect(SHIPPER, { email: 'anita@traders.example', password: 'right-pass' })
  await bahi.onBookingPaid(booking, { amount: 18900, method: 'upi', paymentId: 'pay_ABC' })
  const st = tenants['anita@traders.example']
  check('purchase invoice from the carrier company, submitted and paid at once', st.txns[0]?.txn_type === 'PI' && st.txns[0]?.docstatus === 1 && st.parties[0]?.legal_name === 'Patil Roadways' && st.parties[0]?.role_type === 'SUPPLIER' && [...st.payments.values()][0]?.payment_type === 'PAY')
  check('the carrier side is not posted twice', ct.txns.length === 1 && ct.payments.size === 1)

  console.log('\n── Bahi down ──')
  const booking2 = { ...booking, id: 'cccccccc-0000-4000-8000-000000000002' }
  bahiDown = true
  let threw = false
  try { await bahi.onBookingPaid(booking2, { amount: 5000 }) } catch { threw = true }
  bahiDown = false
  check('Bahi unreachable never throws into the payment path', !threw)
  rec = JSON.parse(kv.get(`bahi:post:${booking2.id}:expense`)!)
  check('…recorded as failed with the reason', rec.status === 'failed' && /could not be reached/.test(rec.error), JSON.stringify(rec))
  const retried = await bahi.retryForUser(booking2, SHIPPER)
  check('retry posts it', retried[0]?.status === 'posted' && st.txns.length === 2, JSON.stringify(retried))

  console.log('\n── unlink ──')
  await bahi.disconnect(OWNER_USER)
  check('unlinked', !(await bahi.connectionView(OWNER_USER)).linked)

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
