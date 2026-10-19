/**
 * Scenario engine — plays ONE load from posting to payment through the REAL
 * bt-booking-service and bt-cargo-ledger code and returns every step.
 *
 *   post a load → carriers bid → shipper awards the lowest → pickup (document gate) →
 *   in transit → delivery code to the receiver → delivered → paid
 *
 * with the access rules checked at every stage.
 *
 * WHAT IS REAL AND WHAT IS NOT. The routes, validation, auth, state machine and
 * delivery-code logic are the real service code, talking to each other over real HTTP.
 * Everything OUTSIDE that code is simulated for the run: the database is an in-memory
 * stand-in, Redis is an in-memory map, the pricing service answers with the scenario's own
 * quote, and the email is captured instead of sent. No secret, no live data, no network
 * beyond localhost — which is what makes it safe to expose as a public "try a scenario"
 * endpoint (scenario/server.mts).
 *
 * Used by test/scenario-flow.e2e.mts (the saved scenarios, on every pipeline run) and by
 * scenario/server.mts (a scenario typed into the test portal's form).
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.JWT_SECRET = 'scenario-jwt-secret-hs256-shared-by-both-services'
process.env.INTERNAL_SERVICE_SECRET = 'scenario-internal-secret'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.PRICING_SERVICE_URL = 'http://pricing.fake.local'
delete process.env.PAYMENT_SERVICE_URL

import Fastify from 'fastify'
import { createHmac, randomUUID } from 'node:crypto'

type Row = Record<string, any>

export interface Scenario {
  id: string
  name: string
  /** state_code = the GST state code (first two digits of a GSTIN), e.g. 27 Maharashtra. */
  from: { label: string; lat: number; lng: number; state_code: string }
  to: { label: string; lat: number; lng: number; state_code: string }
  weight_kg: number
  vehicle_type: string
  load_type: string
  quoted_price: number
  consignment_value_inr: number
  receiver: { name: string; phone: string; email: string }
  bids: { carrier: string; amount: number }[]
}


// Minimal HS256 signer (cargo-ledger has no jsonwebtoken dependency); booking-service verifies it.
function signJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: Math.floor(Date.now() / 1000) })}`
  return `${data}.${createHmac('sha256', process.env.JWT_SECRET!).update(data).digest('base64url')}`
}
const tok = (userId: string, role: string) => signJwt({ userId, role })

// ── In-memory database (the same injection seam the service suites use) ────────────────
let store: Record<string, Row[]> = {}
const MISSING = { data: null, error: { code: '42P01', message: 'relation does not exist' } }

class FakeQuery {
  private f: Array<(r: Row) => boolean> = []
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private payload: Row | Row[] | null = null
  private head = false
  private n: number | null = null
  constructor(private table: string) {}
  select(_c?: string, o?: { head?: boolean }) { if (o?.head) this.head = true; return this }
  insert(p: Row | Row[]) { this.mode = 'insert'; this.payload = p; return this }
  upsert(p: Row | Row[]) { this.mode = 'upsert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  delete() { this.mode = 'delete'; return this }
  eq(c: string, v: any) { this.f.push(r => (r[c] ?? null) === v); return this }
  neq(c: string, v: any) { this.f.push(r => (r[c] ?? null) !== v); return this }
  in(c: string, v: any[]) { this.f.push(r => v.includes(r[c])); return this }
  is(c: string, v: any) { this.f.push(r => (r[c] ?? null) === v); return this }
  match(o: Row) { for (const [c, v] of Object.entries(o)) this.eq(c, v); return this }
  // Only the shapes the services emit: not(col,'is',null) · not(col,'in','(a,b)') · filter(col,op,val)
  not(c: string, op: string, v: any) {
    if (op === 'is') this.f.push(r => (r[c] ?? null) !== v)
    else if (op === 'in') { const set = String(v).replace(/[()"]/g, '').split(','); this.f.push(r => !set.includes(String(r[c]))) }
    else if (op === 'eq') this.f.push(r => r[c] !== v)
    return this
  }
  filter(c: string, op: string, v: any) {
    if (op === 'eq') return this.eq(c, v)
    if (op === 'in') { const set = String(v).replace(/[()"]/g, '').split(','); this.f.push(r => set.includes(String(r[c]))) }
    return this
  }
  // PostgREST `or`: "a.eq.x,b.eq.y" (the only grammar used).
  or(expr: string) {
    const clauses = expr.split(',').map(s => s.split('.'))
    this.f.push(r => clauses.some(([c, op, ...rest]) => {
      const v = rest.join('.')
      return op === 'is' ? (r[c] ?? null) === (v === 'null' ? null : v) : String(r[c]) === v
    }))
    return this
  }
  lte() { return this } gte() { return this } lt() { return this } gt() { return this }
  order() { return this }
  limit(n: number) { this.n = n; return this }
  private run(): { data: any; error: any; count?: number } {
    if (!(this.table in store)) return MISSING
    const rows = store[this.table]
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map(p => ({
        id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...p,
      }))
      rows.push(...items)
      return { data: items, error: null }
    }
    const hit = rows.filter(r => this.f.every(fn => fn(r)))
    if (this.mode === 'update') { hit.forEach(r => Object.assign(r, this.payload)); return { data: hit, error: null } }
    if (this.mode === 'delete') { store[this.table] = rows.filter(r => !hit.includes(r)); return { data: hit, error: null } }
    if (this.head) return { data: null, error: null, count: hit.length }
    return { data: this.n === null ? hit : hit.slice(0, this.n), error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data?.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// ── In-memory Redis (only the calls the two services make) ─────────────────────────────
function patchRedis(redis: any) {
  const mem = new Map<string, string>()
  redis.on?.('error', () => {})
  redis.disconnect?.()
  redis.get = async (k: string) => mem.get(k) ?? null
  redis.set = async (k: string, v: string, ...args: any[]) => {
    if (args.includes('NX') && mem.has(k)) return null
    mem.set(k, String(v)); return 'OK'
  }
  redis.del = async (...ks: string[]) => { let n = 0; for (const k of ks.flat()) if (mem.delete(k)) n++; return n }
  redis.incr = async (k: string) => { const v = Number(mem.get(k) ?? 0) + 1; mem.set(k, String(v)); return v }
  redis.expire = async () => 1
  redis.pipeline = () => {
    const ops: Array<() => Promise<any>> = []
    const p: any = {
      set: (...a: any[]) => { ops.push(() => redis.set(...a)); return p },
      del: (...a: any[]) => { ops.push(() => redis.del(...a)); return p },
      incr: (k: string) => { ops.push(() => redis.incr(k)); return p },
      expire: () => { ops.push(async () => 1); return p },
      exec: async () => { const out = []; for (const op of ops) out.push([null, await op()]); return out },
    }
    return p
  }
  redis.quit = async () => 'OK'
}


/** Whose journey a step belongs to — the portal has one page per user type. */
export type View = 'shipper' | 'driver'
export interface Step { stage: string; title: string; actor: string; expected: string; got: string; ok: boolean; views: View[] }
export interface ScenarioResult { id: string; name: string; status: 'pass' | 'fail'; summary: string; final_status: string; steps: Step[] }

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN')}`
const errOf = (r: any) => { try { const j = r.json(); return j.code ?? j.error ?? '' } catch { return '' } }
/** The service's own refusal message, first sentence only (for the trace). */
const whyOf = (r: any) => { try { const m = String(r.json().error ?? '').split(/(?<=[.!?])\s/)[0].replace(/\.$/, ''); return m.length > 150 ? m.slice(0, 147) + '…' : m } catch { return '' } }

// ── Boot (once per process) ────────────────────────────────────────────────────────────
let rt: null | { bookingApp: any; cargoApp: any; mail: any; receipts: any; realFetch: typeof fetch } = null
let lockedQuote: Row = {}

export async function init(): Promise<void> {
  if (rt) return
  const { __setSupabaseClientForTests } = await import('../../bt-booking-service/src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const bookingAuth = (await import('../../bt-booking-service/src/plugins/auth.js')).default
  const bookingInternalAuth = (await import('../../bt-booking-service/src/plugins/internal-auth.js')).default
  const { bookingRoutes } = await import('../../bt-booking-service/src/routes/bookings.js')
  const { quoteRoutes } = await import('../../bt-booking-service/src/routes/quotes.js')
  const { internalRoutes } = await import('../../bt-booking-service/src/routes/internal.js')
  patchRedis((await import('../../bt-booking-service/src/lib/redis.js')).redis)

  const bookingApp = Fastify({ logger: false })
  await bookingApp.register(async (a) => {
    await a.register(bookingAuth)
    await a.register(bookingRoutes, { prefix: '/bookings' })
    await a.register(quoteRoutes, { prefix: '/bookings' })
  })
  await bookingApp.register(async (a) => { await a.register(bookingInternalAuth); await a.register(internalRoutes, { prefix: '/internal' }) })
  await bookingApp.listen({ port: 0, host: '127.0.0.1' })
  const bookingBase = `http://127.0.0.1:${(bookingApp.server.address() as { port: number }).port}`

  const { podRoutes } = await import('../src/routes/pod.js')
  const { HttpBookingClient } = await import('../src/lib/booking-client.js')
  patchRedis((await import('../src/lib/redis.js')).redis)
  const mail = { last: null as any, async send(m: any) { this.last = m } }
  const receipts = { list: [] as any[], async record(r: any) { this.list.push(r) } }
  const cargoApp = Fastify({ logger: false })
  await cargoApp.register(podRoutes, {
    prefix: '/pod',
    deps: { booking: new HttpBookingClient(bookingBase, process.env.INTERNAL_SERVICE_SECRET!), email: mail, store: receipts },
  })
  await cargoApp.ready()

  // The stubbed pricing service answers with the CURRENT scenario's locked quote. Every
  // other request (cargo → booking over real HTTP) passes through untouched.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const href = String(url)
    if (!href.startsWith(process.env.PRICING_SERVICE_URL!)) return realFetch(url, init)
    const data = href.endsWith('/consume') ? { ...lockedQuote, consumed_at: new Date().toISOString() } : lockedQuote
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  rt = { bookingApp, cargoApp, mail, receipts, realFetch }
}

export async function shutdown(): Promise<void> {
  if (!rt) return
  await rt.cargoApp.close()
  await rt.bookingApp.close()
  globalThis.fetch = rt.realFetch
  rt = null
}

// The in-memory database and the pricing stub are process-wide, so scenarios run one at a
// time: each call waits for the previous one.
let queue: Promise<unknown> = Promise.resolve()
export function runScenario(sc: Scenario, onStep?: (s: Step) => void): Promise<ScenarioResult> {
  const next = queue.then(() => play(sc, onStep))
  queue = next.catch(() => {})
  return next
}

async function play(sc: Scenario, onStep?: (s: Step) => void): Promise<ScenarioResult> {
  await init()
  const { bookingApp, cargoApp, mail, receipts } = rt!
  receipts.list.length = 0 // a long-running server must not accumulate past runs
  const steps: Step[] = []
  // A step belongs to the SHIPPER's journey, the DRIVER's (carrier's), or both. Decided by
  // who acts: a carrier's own actions are the driver's story, a shipper's are the shipper's;
  // the receiver, the payment service and the delivery receipt matter to both.
  const carrierNames = new Set(sc.bids.map(b => b.carrier))
  const viewsOf = (stage: string, actor: string): View[] => {
    if (carrierNames.has(actor)) return ['driver']
    if (actor === 'Shipper' || actor === 'Another shipper') return ['shipper']
    if (actor === 'Anonymous') return stage === 'Post the load' ? ['shipper'] : stage === 'Delivery' ? ['driver'] : ['shipper', 'driver']
    if (actor === 'System' && stage === 'Award') return ['driver']
    return ['shipper', 'driver']
  }
  const step = (stage: string, title: string, actor: string, expected: string, ok: boolean, got: string) => {
    const s = { stage, title, actor, expected, got, ok, views: viewsOf(stage, actor) }
    steps.push(s); onStep?.(s)
  }
  const finish = (): ScenarioResult => ({
    id: sc.id, name: sc.name, status: steps.every(s => s.ok) ? 'pass' : 'fail',
    summary: `${sc.from.label} → ${sc.to.label} · ${(sc.weight_kg / 1000).toLocaleString('en-IN')} t · ${sc.vehicle_type.toUpperCase()} · quoted ${inr(sc.quoted_price)} · ${sc.bids.length} bid${sc.bids.length === 1 ? '' : 's'}`,
    final_status: store.bookings?.[0]?.status ?? 'not created',
    steps,
  })

  const U_SHIPPER = randomUUID(), U_OTHER_SHIPPER = randomUUID()
  const carriers = sc.bids.map(b => ({ ...b, userId: randomUUID(), driverId: randomUUID(), email: `${b.carrier.toLowerCase().replace(/[^a-z]+/g, '.')}@carrier.test` }))
  const now = new Date().toISOString()
  store = {
    users: [
      { id: U_SHIPPER, full_name: 'Scenario Shipper', email: 'shipper@scenario.test', phone_number: '9111111111', role: 'shipper', gstin: '27AAAAA0000A1Z5', claimed_at: now, created_at: now },
      { id: U_OTHER_SHIPPER, full_name: 'Another Shipper', email: 'other@scenario.test', phone_number: '9111111112', role: 'shipper', gstin: '27BBBBB0000B1Z5', claimed_at: now, created_at: now },
      ...carriers.map((c, i) => ({ id: c.userId, full_name: c.carrier, email: c.email, phone_number: `92222222${String(i).padStart(2, '0')}`, role: 'driver', claimed_at: now, created_at: now })),
    ],
    bookings: [],
    drivers: carriers.map(c => ({ id: c.driverId, user_id: c.userId })),
    // Each carrier is an owner-driver with one truck of record — what makes them a bidder.
    vehicles: carriers.map(c => ({ id: randomUUID(), owner_user_id: c.userId, driver_id: c.driverId, is_active: true, rc_number: 'MH00XX0000' })),
    fleet_owners: [],
    fleet_drivers: [],
    quotes: [],
    negotiations: [],
    notification_outbox: [],
    notification_preferences: [],
    freight_invoices: [],
    eway_bill_records: [],
  }
  lockedQuote = {
    id: randomUUID(), shipper_id: U_SHIPPER, quoted_price: sc.quoted_price, currency: 'INR',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), consumed_at: null, consumed_by_booking_id: null,
    source_lat: sc.from.lat, source_lng: sc.from.lng, dest_lat: sc.to.lat, dest_lng: sc.to.lng,
    distance_km: 0, vehicle_type: sc.vehicle_type, vehicle_class: sc.vehicle_type.toUpperCase(),
    load_type: sc.load_type, weight_kg: sc.weight_kg, breakdown_json: {},
  }
  const createBody = {
    quote_id: lockedQuote.id, booking_type: 'auction',
    source_address: sc.from.label, source_lat: sc.from.lat, source_lng: sc.from.lng,
    destination_address: sc.to.label, dest_lat: sc.to.lat, dest_lng: sc.to.lng,
    load_type: sc.load_type, weight_kg: sc.weight_kg, vehicle_type: sc.vehicle_type,
    pickup_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    consignee: { name: sc.receiver.name, phone: sc.receiver.phone, email: sc.receiver.email },
  }
  const b = (method: string, url: string, token?: string, payload?: unknown, headers: Row = {}) =>
    bookingApp.inject({ method: method as any, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(payload ? { payload: payload as any } : {}) })
  const status = () => store.bookings[0]?.status ?? 'none'

  // ── 1. Post the load ──
  let r = await b('POST', '/bookings', undefined, createBody)
  step('Post the load', 'A visitor who is not signed in tries to post a load', 'Anonymous', 'refused (401)', r.statusCode === 401, `${r.statusCode} refused`)

  r = await b('POST', '/bookings', tok(U_SHIPPER, 'shipper'), createBody)
  const booking = r.statusCode === 201 ? r.json().data : null
  step('Post the load', `Shipper posts ${sc.from.label} → ${sc.to.label}, ${(sc.weight_kg / 1000).toLocaleString('en-IN')} t, at the locked price ${inr(sc.quoted_price)}`, 'Shipper', 'load created, open for bids',
    !!booking && ['pending', 'negotiating'].includes(booking.status) && Number(booking.quoted_price) === sc.quoted_price,
    booking ? `created · status ${booking.status} · price ${inr(booking.quoted_price)}` : `${r.statusCode} ${errOf(r)}`)
  if (!booking) return finish()
  const id = booking.id

  // ── 2. Bids ──
  for (const c of carriers) {
    r = await b('POST', `/bookings/${id}/quotes`, tok(c.userId, 'driver'), { amount: c.amount })
    step('Carriers bid', `${c.carrier} bids ${inr(c.amount)}`, c.carrier, 'bid accepted', r.statusCode === 201, r.statusCode === 201 ? 'bid recorded' : `${r.statusCode} ${errOf(r)}`)
  }
  r = await b('POST', `/bookings/${id}/quotes`, tok(U_SHIPPER, 'shipper'), { amount: sc.quoted_price })
  step('Carriers bid', 'The shipper tries to bid on their own load', 'Shipper', 'refused (403)', r.statusCode === 403, `${r.statusCode} ${errOf(r)}`)
  r = await b('GET', `/bookings/${id}/quotes`, tok(U_SHIPPER, 'shipper'))
  const seen = r.statusCode === 200 ? (r.json().data ?? []).length : -1
  step('Carriers bid', 'The shipper opens the load and sees the bids', 'Shipper', `${carriers.length} bid${carriers.length === 1 ? '' : 's'} listed`, seen === carriers.length, r.statusCode === 200 ? `${seen} bid${seen === 1 ? '' : 's'} listed` : `${r.statusCode} ${errOf(r)}`)

  // ── 3. Award ──
  const quoteOf = (driverId: string) => store.quotes.find(q => q.booking_id === id && q.driver_id === driverId)
  const winner = [...carriers].sort((x, y) => x.amount - y.amount)[0]
  const loser = carriers.find(c => c !== winner) ?? null
  const winQuote = quoteOf(winner.driverId)
  r = await b('PATCH', `/bookings/${id}/quotes/${winQuote?.id}/accept`, tok(U_OTHER_SHIPPER, 'shipper'))
  step('Award', 'A different shipper tries to award this load', 'Another shipper', 'refused (403)', r.statusCode === 403 || r.statusCode === 404, `${r.statusCode} ${errOf(r)}`)

  r = await b('PATCH', `/bookings/${id}/quotes/${winQuote?.id}/accept`, tok(U_SHIPPER, 'shipper'))
  const bk = () => store.bookings[0]
  step('Award', `Shipper accepts the lowest bid: ${winner.carrier} at ${inr(winner.amount)}`, 'Shipper', 'load awarded to that carrier',
    r.statusCode === 200 && bk().status === 'accepted' && bk().driver_id === winner.driverId,
    r.statusCode === 200 ? `awarded · status ${bk().status} · agreed fare ${inr(bk().final_price ?? winner.amount)}` : `${r.statusCode} ${errOf(r)}`)
  if (loser) {
    const lq = quoteOf(loser.driverId)
    step('Award', `${loser.carrier}'s bid is closed`, 'System', 'losing bids expire', lq?.status === 'expired', `bid status ${lq?.status}`)
    const told = store.notification_outbox.some(n => n.event_type === 'quote_lost' && n.recipient_email === loser.email)
    step('Award', `${loser.carrier} is told they did not win`, 'System', 'notice queued', told, told ? 'notice queued' : 'no notice')
  }
  {
    r = await b('GET', `/bookings/${id}`, tok(winner.userId, 'driver'))
    const d = r.statusCode === 200 ? r.json().data : null
    step('Award', `${winner.carrier} opens the trip they won`, winner.carrier, 'trip visible, status accepted', d?.status === 'accepted', d ? `trip visible · status ${d.status}` : `${r.statusCode} ${errOf(r)}`)
  }

  // ── 4. Pickup ──
  if (loser) {
    r = await b('PATCH', `/bookings/${id}/start`, tok(loser.userId, 'driver'))
    step('Pickup', `${loser.carrier} (did not win) tries to start the trip`, loser.carrier, 'refused (403)', r.statusCode === 403, `${r.statusCode} ${errOf(r)}`)
  }
  r = await b('PATCH', `/bookings/${id}/start`, tok(winner.userId, 'driver'))
  step('Pickup', 'The driver tries to start before the tax invoice is on file', winner.carrier, 'refused: tax invoice missing',
    r.statusCode === 409 && /tax invoice/i.test(whyOf(r)) && status() === 'accepted', `refused — ${whyOf(r)}`)

  // The freight documents are recorded straight into the stand-in database: issuing them
  // goes through database functions (issue_freight_invoice, …) that only exist in Postgres.
  // The GATE that reads them — the thing under test here — is the real code.
  store.freight_invoices.push({
    id: randomUUID(), booking_id: id, invoice_number: 'INV/26-27/1',
    supplier_gstin: `${sc.from.state_code}AAAAA0000A1Z5`, shipped_to_gstin: `${sc.to.state_code}BBBBB0000B1Z5`,
    shipped_to_state_code: sc.to.state_code, consignment_value_inr: sc.consignment_value_inr,
  })
  r = await b('PATCH', `/bookings/${id}/start`, tok(winner.userId, 'driver'))
  if (r.statusCode === 409 && /e-way bill/i.test(whyOf(r))) {
    step('Pickup', 'Tax invoice is on file; the driver tries to start without an e-way bill', winner.carrier, 'refused: e-way bill missing',
      status() === 'accepted', `refused — ${whyOf(r)}`)
    store.eway_bill_records.push({
      id: randomUUID(), booking_id: id, ewb_number: '271000000001', status: 'active', document_uri: 'supabase://docs/ewb.pdf',
      generated_at: new Date().toISOString(), valid_upto: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    })
    r = await b('PATCH', `/bookings/${id}/start`, tok(winner.userId, 'driver'))
    step('Pickup', 'With the invoice and a valid e-way bill on file, the driver starts the trip', winner.carrier, 'trip in transit',
      r.statusCode === 200 && status() === 'in_transit', r.statusCode === 200 ? `started · status ${status()}` : `${r.statusCode} ${whyOf(r) || errOf(r)}`)
  } else {
    step('Pickup', 'With the tax invoice on file (no e-way bill needed for this consignment), the driver starts the trip', winner.carrier, 'trip in transit',
      r.statusCode === 200 && status() === 'in_transit', r.statusCode === 200 ? `started · status ${status()}` : `${r.statusCode} ${whyOf(r) || errOf(r)}`)
  }

  r = await b('PATCH', `/bookings/${id}/complete`, tok(winner.userId, 'driver'))
  step('In transit', 'The driver tries to mark their own trip delivered', winner.carrier, 'not possible (no such action)', r.statusCode === 404 && status() === 'in_transit', `${r.statusCode} · still ${status()}`)
  r = await b('GET', `/bookings/${id}`, tok(U_SHIPPER, 'shipper'))
  step('In transit', 'The shipper checks the load', 'Shipper', 'shown as in transit', r.statusCode === 200 && r.json().data?.status === 'in_transit', r.statusCode === 200 ? `status ${r.json().data?.status}` : `${r.statusCode} ${errOf(r)}`)
  r = await b('GET', `/bookings/${id}`, tok(U_OTHER_SHIPPER, 'shipper'))
  step('In transit', 'A different shipper tries to open this load', 'Another shipper', 'refused', r.statusCode === 403 || r.statusCode === 404, `${r.statusCode} ${errOf(r)}`)

  // ── 5. Delivery code ──
  const reqOtp = (token?: string) => cargoApp.inject({ method: 'POST', url: '/pod/request-otp', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: { booking_id: id } })
  const verify = (otp: string) => cargoApp.inject({ method: 'POST', url: '/pod/verify-otp', payload: { booking_id: id, otp } })
  r = await reqOtp()
  step('Delivery', 'Someone who is not signed in asks for the delivery code', 'Anonymous', 'refused (401)', r.statusCode === 401, `${r.statusCode} refused`)
  if (loser) {
    r = await reqOtp(tok(loser.userId, 'driver'))
    step('Delivery', `${loser.carrier} (not the driver of this trip) asks for the delivery code`, loser.carrier, 'refused (403)', r.statusCode === 403, `${r.statusCode} ${errOf(r)}`)
  }
  mail.last = null
  r = await reqOtp(tok(winner.userId, 'driver'))
  const sentTo = r.statusCode === 200 ? String(r.json().data?.sent_to ?? '') : ''
  step('Delivery', 'The driver reaches the drop and requests the delivery code', winner.carrier, `6-digit code emailed to the receiver`,
    r.statusCode === 200 && mail.last?.to === sc.receiver.email && sentTo !== sc.receiver.email,
    r.statusCode === 200 ? `code emailed to ${sentTo} (address masked for the driver)` : `${r.statusCode} ${errOf(r)}`)
  const otp = String(mail.last?.text?.match(/(\d{6})/)?.[1] ?? '')
  const wrong = otp === '000000' ? '111111' : '000000'
  r = await verify(wrong)
  step('Delivery', 'A wrong code is entered', 'Receiver', 'rejected, trip stays in transit', r.statusCode === 400 && status() === 'in_transit', `${r.statusCode} ${errOf(r)} · still ${status()}`)
  r = await verify(otp)
  step('Delivery', 'The receiver gives the correct code', 'Receiver', 'trip marked delivered', r.statusCode === 200 && status() === 'completed', r.statusCode === 200 ? `delivered · status ${status()}` : `${r.statusCode} ${errOf(r)}`)
  step('Delivery', 'A delivery receipt is recorded', 'System', 'one receipt for this load', receipts.list.filter(x => x.booking_id === id).length === 1, `${receipts.list.filter(x => x.booking_id === id).length} receipt`)
  r = await verify(otp)
  step('Delivery', 'The same code is used a second time', 'Receiver', 'refused (code already used)', r.statusCode === 410, `${r.statusCode} ${errOf(r)}`)
  r = await b('GET', `/bookings/${id}`, tok(U_SHIPPER, 'shipper'))
  step('Delivery', 'The shipper checks the load', 'Shipper', 'shown as delivered', r.statusCode === 200 && r.json().data?.status === 'completed', r.statusCode === 200 ? `status ${r.json().data?.status}` : `${r.statusCode} ${errOf(r)}`)

  // ── 6. Payment ──
  r = await b('POST', `/internal/bookings/${id}/mark-paid`, undefined, { amount: winner.amount, method: 'bank_transfer' })
  step('Payment', 'A call without the service secret tries to mark the load paid', 'Anonymous', 'refused', (r.statusCode === 401 || r.statusCode === 403) && status() === 'completed', `${r.statusCode} · still ${status()}`)
  r = await b('POST', `/internal/bookings/${id}/mark-paid`, undefined, { amount: winner.amount, method: 'bank_transfer' }, { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET! })
  step('Payment', `The payment service settles ${inr(winner.amount)} and marks the load paid`, 'Payment service', 'load paid', r.statusCode === 200 && status() === 'paid', r.statusCode === 200 ? `paid · status ${status()}` : `${r.statusCode} ${errOf(r)}`)
  r = await b('GET', `/bookings/${id}`, tok(winner.userId, 'driver'))
  step('Payment', `${winner.carrier} checks the trip`, winner.carrier, 'shown as paid', r.statusCode === 200 && r.json().data?.status === 'paid', r.statusCode === 200 ? `status ${r.json().data?.status}` : `${r.statusCode} ${errOf(r)}`)
  r = await b('GET', `/bookings/${id}`, tok(U_SHIPPER, 'shipper'))
  step('Payment', 'The shipper checks the load', 'Shipper', 'shown as paid', r.statusCode === 200 && r.json().data?.status === 'paid', r.statusCode === 200 ? `status ${r.json().data?.status}` : `${r.statusCode} ${errOf(r)}`)


  return finish()
}
