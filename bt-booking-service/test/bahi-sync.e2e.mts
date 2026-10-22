/**
 * Bahi Khata sync (lib/bahi/*): the GST-inclusive split, the posting body, and a paid load
 * flowing to whichever side linked Bahi — against a fake Supabase and a fake Bahi.
 * Pins: carrier → income to the shipper, shipper → expense from the carrier; an account
 * without a link is skipped; Bahi being down records 'failed' and NEVER throws into the
 * payment path; the token is stored sealed and sent as a Bearer header.
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

const db: Record<string, Row[]> = {
  users: [
    { id: SHIPPER, full_name: 'Anita Sharma', email: 'anita@traders.example', phone_number: '9876500001', gstin: '27AAPFU0939F1ZV' },
    { id: OWNER_USER, full_name: 'Ravi Patil', email: 'ravi@roadways.example', phone_number: '9876500002', gstin: null },
  ],
  fleet_owners: [{ id: FLEET, user_id: OWNER_USER, company_name: 'Patil Roadways', gstin: '27ABCPE1234F1ZB' }],
  drivers: [],
  bahi_connections: [],
  bahi_postings: [],
  payments: [],
}

class Q {
  private eqs: Array<[string, any]> = []
  private op: 'select' | 'upsert' | 'update' | 'delete' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select() { return this }
  order() { return this }
  limit() { return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  private rows() { return (db[this.table] ??= []).filter((r) => this.eqs.every(([c, v]) => r[c] === v)) }
  upsert(p: Row, opts: { onConflict: string }) {
    const keys = opts.onConflict.split(',')
    const t = (db[this.table] ??= [])
    const i = t.findIndex((r) => keys.every((k) => r[k] === p[k]))
    if (i >= 0) t[i] = { ...t[i], ...p }; else t.push({ created_at: new Date().toISOString(), ...p })
    return Promise.resolve({ data: null, error: null })
  }
  update(p: Row) { this.op = 'update'; this.payload = p; return this }
  delete() { this.op = 'delete'; return this }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }) }
  then(res: (v: any) => void) {
    if (this.op === 'update') { const rs = this.rows(); rs.forEach((r) => Object.assign(r, this.payload)); return Promise.resolve({ data: rs, error: null }).then(res) }
    if (this.op === 'delete') { db[this.table] = (db[this.table] ?? []).filter((r) => !this.eqs.every(([c, v]) => r[c] === v)); return Promise.resolve({ data: null, error: null }).then(res) }
    return Promise.resolve({ data: this.rows(), error: null }).then(res)
  }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const sent: Array<{ url: string; auth: string | null; body: any }> = []
let bahiDown = false
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (bahiDown) throw new Error('ECONNREFUSED')
  const body = init.body ? JSON.parse(String(init.body)) : null
  sent.push({ url: String(url), auth: new Headers(init.headers).get('Authorization'), body })
  if (String(url).endsWith('/connect/ping')) return new Response(JSON.stringify({ company_name: 'Patil Roadways', gstin: '27ABCPE1234F1ZB', integration: 'BharatTruck' }), { status: 200 })
  return new Response(JSON.stringify({ txn_id: 'TXN-1', number: body.kind === 'income' ? 'SINV-0001' : 'PI-0001', txn_type: body.kind === 'income' ? 'SINV' : 'PI', status: 'PAID', grand_total: body.payment.amount, deduped: false }), { status: 201 })
}) as any

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests({ from: (t: string) => new Q(t) } as any)
  const posting = await import('../src/lib/bahi/posting.js')
  const bahi = await import('../src/lib/bahi/service.js')

  console.log('\n── pure ──')
  check('0% → the paid amount is the taxable value', JSON.stringify(posting.splitInclusive(18000, 0)) === JSON.stringify({ taxable: 18000, total: 18000 }))
  const s5 = posting.splitInclusive(18900, 5)
  check('5% inclusive → 18000 + 900', s5.taxable === 18000 && s5.total === 18900, JSON.stringify(s5))
  const s12 = posting.splitInclusive(10000, 12)
  check('12% inclusive never exceeds what was paid', s12.total <= 10000 && 10000 - s12.total < 0.02, JSON.stringify(s12))
  check('payment modes', posting.paymentMode('razorpay') === 'BANK_TRANSFER' && posting.paymentMode('cash') === 'CASH' && posting.paymentMode('UPI') === 'UPI')
  check('place = first address part', posting.placeShort('Pune, Maharashtra 411001, India') === 'Pune')

  console.log('\n── linking ──')
  const view0 = await bahi.connectionView(OWNER_USER)
  check('not linked, storage available', !view0.linked && view0.available)
  const token = 'bahi_it_' + 'x'.repeat(43)
  const view = await bahi.connect(OWNER_USER, { token, gst_rate: 5 })
  check('link pings Bahi with the token as Bearer', sent[0]?.url === 'https://bahi.test/api/v1/integrations/connect/ping' && sent[0]?.auth === `Bearer ${token}`)
  check('the company name comes from Bahi', view.linked && view.company_name === 'Patil Roadways' && view.gst_rate === 5, JSON.stringify(view))
  check('the token is stored sealed, never in clear', !JSON.stringify(db.bahi_connections).includes(token) && bahi.openToken(db.bahi_connections[0].token_enc) === token)

  console.log('\n── a paid load ──')
  sent.length = 0
  const booking = { id: BOOKING, shipper_id: SHIPPER, driver_id: null, fleet_owner_id: FLEET, source_address: 'Pune, MH', destination_address: 'Mumbai, MH', weight_kg: 9000, quoted_price: 18900, final_price: null, status: 'paid' }
  await bahi.onBookingPaid(booking, { amount: 18900, method: 'razorpay', paymentId: 'pay_ABC' })
  const post = sent.find((x) => x.url.endsWith('/connect/freight'))
  check('only the linked side posts (the shipper has not linked)', sent.length === 1 && post?.body.kind === 'income', JSON.stringify(sent.map((x) => x.body?.kind)))
  check('income is billed to the shipper with their GSTIN', post?.body.counterparty.name === 'Anita Sharma' && post?.body.counterparty.gstin === '27AAPFU0939F1ZV')
  check('5% inclusive: 18000 taxable, 18900 paid, ref carried', post?.body.amount === 18000 && post?.body.payment.amount === 18900 && post?.body.payment.reference === 'pay_ABC')
  check('external id is the booking id', post?.body.external_id === BOOKING)
  const rec = db.bahi_postings.find((r) => r.user_id === OWNER_USER)
  check('recorded as posted with the Bahi number', rec?.status === 'posted' && rec?.bahi_number === 'SINV-0001', JSON.stringify(rec))

  console.log('\n── both sides, and Bahi down ──')
  await bahi.connect(SHIPPER, { token: 'bahi_it_' + 'y'.repeat(43) })
  sent.length = 0
  await bahi.onBookingPaid(booking, { amount: 18900, method: 'upi', paymentId: 'pay_ABC' })
  const exp = sent.find((x) => x.body?.kind === 'expense')
  check('the shipper gets an expense from the carrier company', exp?.body.counterparty.name === 'Patil Roadways' && exp?.body.counterparty.gstin === '27ABCPE1234F1ZB' && exp?.body.amount === 18900)
  bahiDown = true
  let threw = false
  try { await bahi.onBookingPaid(booking, { amount: 18900 }) } catch { threw = true }
  check('Bahi unreachable never throws into the payment path', !threw)
  check('…and is recorded as failed, with the attempt counted', db.bahi_postings.every((r) => r.status === 'failed' && r.attempts >= 2), JSON.stringify(db.bahi_postings.map((r) => [r.kind, r.status, r.attempts])))
  bahiDown = false

  console.log('\n── unlinking ──')
  await bahi.disconnect(OWNER_USER)
  check('unlinked', !(await bahi.connectionView(OWNER_USER)).linked)

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
