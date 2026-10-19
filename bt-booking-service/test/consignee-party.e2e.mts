/**
 * The consignee as a first-class freight party (migration 0026 / D-22).
 *
 * What this pins, and why each one is here rather than in a doc:
 *
 *   - 🔴 THE SECURITY RULE. A consignee is identified by a phone number supplied
 *     by whoever is POSTING the load, so a caller can always name a phone that
 *     already belongs to a real account. Linking to that row must NEVER write to
 *     it. Without this test, an ON CONFLICT DO UPDATE looks like a tidy
 *     refactor and turns booking creation into an unauthenticated write to any
 *     profile on the platform.
 *   - An unclaimed party record has NO credential. Not a weak password — none.
 *     `claimed_at` is NULL and nothing else about it is loggable (§9.2's
 *     anti-goal).
 *   - One human, one party. Three spellings of one mobile number ('+91 98765
 *     43210', '098765…', '98765…') must resolve to ONE users row, because the
 *     unique index that dedups them can only dedup values spelled the same way.
 *   - D-29: a load must name a REACHABLE consignee. Name and phone are both
 *     required, and nothing is written on a rejection.
 *   - BACK-COMPAT, in both directions: a legacy `receiver_email`-only create
 *     still works and still populates the column bt-cargo-ledger's POD flow
 *     reads, and a create that names a consignee still populates it too.
 *   - The read gate. `consignee` is attached only for a viewer with a RELATION to
 *     the booking (@bharattruck/shared/personas). A solo driver's list includes
 *     the open load board — every load anyone has posted — so an ungated
 *     attachment would hand every driver a customer list.
 *   - A pre-0026 database: reads simply have no consignee block, and a create
 *     that NAMES a consignee 503s with the migration in the message rather than
 *     silently discarding the party the goods are for.
 *
 * Exercises the REAL routes via app.inject() with an in-memory fake Supabase and
 * a stubbed pricing service, same shape as receiver-email.e2e.mts.
 *
 * Run: npx tsx test/consignee-party.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.PRICING_SERVICE_URL = 'http://pricing.fake.local'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'

const B_CONSIGNED = '11111111-1111-4111-8111-111111111111'
const B_LEGACY    = '22222222-2222-4222-8222-222222222222'

const U_SHIPPER   = '33333333-3333-4333-8333-333333333333'
const U_CONSIGNEE = '44444444-4444-4444-8444-444444444444'
const U_DRIVER    = '55555555-5555-4555-8555-555555555555'
const U_STRANGER  = '66666666-6666-4666-8666-666666666666'
const U_ADMIN     = '77777777-7777-4777-8777-777777777777'

const D_ASSIGNED  = '88888888-8888-4888-8888-888888888888'
const D_STRANGER  = '99999999-9999-4999-8999-999999999999'

const QUOTE_ID    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// The party who already has an account. Every field below is a field a booking
// create must NOT be able to touch.
const EXISTING_PHONE = '9000000001'
const EXISTING_NAME  = 'Sharma Distributors Pvt Ltd'
const EXISTING_EMAIL = 'accounts@sharma-dist.co.in'
const EXISTING_GSTIN = '27AAAAA0000A1Z5'
const EXISTING_CITY  = 'Nagpur'
const CLAIMED_AT     = '2026-01-04T09:00:00.000Z'

type Row = Record<string, any>

let store: Record<string, Row[]> = {}
// Columns migration 0026 adds. Populated in the pre-0026 section to make the
// fake behave like a database the migration has not been applied to.
let missingColumns: Record<string, Set<string>> = {}

function reset() {
  missingColumns = {}
  store = {
    users: [
      { id: U_SHIPPER, full_name: 'Destinio Clothing Co.', phone_number: '9111111111',
        email: 'ops@destinio.in', city: 'Mumbai', role: 'shipper', claimed_at: CLAIMED_AT,
        // FB-04: post-load requires shipper (or fleet) GSTIN.
        gstin: '27AAAAA0000A1Z5',
        password_hash: 'bcrypt$existing', created_at: CLAIMED_AT },
      { id: U_CONSIGNEE, full_name: EXISTING_NAME, phone_number: EXISTING_PHONE,
        email: EXISTING_EMAIL, gstin: EXISTING_GSTIN, city: EXISTING_CITY, address: '14 MIDC Road',
        role: 'shipper', claimed_at: CLAIMED_AT, password_hash: 'bcrypt$existing',
        created_at: CLAIMED_AT },
      { id: U_DRIVER,   full_name: 'Ramesh Kumar', phone_number: '9222222222', role: 'driver',
        claimed_at: CLAIMED_AT, created_at: CLAIMED_AT },
      { id: U_STRANGER, full_name: 'Someone Else',  phone_number: '9333333333', role: 'driver',
        claimed_at: CLAIMED_AT, created_at: CLAIMED_AT },
      { id: U_ADMIN,    full_name: 'Ops',           phone_number: '9444444444', role: 'admin',
        claimed_at: CLAIMED_AT, created_at: CLAIMED_AT },
    ],
    bookings: [
      // Consigned to the party who already has an account, and carried by D_ASSIGNED.
      { id: B_CONSIGNED, shipper_id: U_SHIPPER, driver_id: D_ASSIGNED, fleet_owner_id: null,
        vehicle_id: null, status: 'in_transit', receiver_email: EXISTING_EMAIL,
        consignee_user_id: U_CONSIGNEE, quoted_price: 42000, final_price: null,
        min_acceptable: null, source_address: 'Mumbai', destination_address: 'Nagpur' },
      // One of the 672 rows that predate the model: no consignee at all.
      { id: B_LEGACY, shipper_id: U_SHIPPER, driver_id: null, fleet_owner_id: null,
        vehicle_id: null, status: 'pending', receiver_email: null, consignee_user_id: null,
        quoted_price: 18000, final_price: null, min_acceptable: null,
        source_address: 'Mumbai', destination_address: 'Pune' },
    ],
    drivers: [
      { id: D_ASSIGNED, user_id: U_DRIVER },
      { id: D_STRANGER, user_id: U_STRANGER },
    ],
    // Both drivers are solo: no fleet, no affiliation, no truck of record. That
    // keeps isEmployedDriver() false and leaves the relation set as the ONLY
    // thing deciding what each of them sees.
    fleet_owners: [],
    fleet_drivers: [],
    vehicles: [],
    notification_outbox: [],
    notification_preferences: [],
  }
}

// -----------------------------------------------------------
// Fake Supabase — the T-BE-1 injection seam.
// -----------------------------------------------------------

class FakeQuery {
  private filters: Array<['eq' | 'in' | 'or', string, any]> = []
  private mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | null = null
  private conflictColumn: string | null = null
  private ignoreDuplicates = false
  private headOnly = false
  private limitN: number | null = null
  constructor(private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.headOnly = true
    return this
  }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  upsert(p: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = 'upsert'
    this.payload = p
    this.conflictColumn = opts?.onConflict ?? null
    this.ignoreDuplicates = !!opts?.ignoreDuplicates
    return this
  }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  // PostgREST's `or` grammar, only the two shapes listBookings actually emits.
  or(expr: string) { this.filters.push(['or', expr, null]); return this }
  lte() { return this }
  order() { return this }
  limit(n: number) { this.limitN = n; return this }

  private match(r: Row): boolean {
    return this.filters.every(([op, col, val]) => {
      if (op === 'eq') return r[col] === val
      if (op === 'in') return (val as any[]).includes(r[col])
      return col.split(',').some((clause) => {
        const [c, , v] = clause.split('.')
        return String(r[c]) === v
      })
    })
  }

  private run(): { data: any; error: any; count?: number } {
    const missing = missingColumns[this.table]
    if (missing && this.payload) {
      const offending = Object.keys(this.payload).find((k) => missing.has(k))
      if (offending) {
        // PostgREST's schema-cache miss for an unknown column — a database
        // without migration 0026.
        return {
          data: null,
          error: { code: 'PGRST204', message: `Could not find the '${offending}' column of '${this.table}' in the schema cache` },
        }
      }
    }

    const rows = store[this.table] ?? (store[this.table] = [])

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const p = this.payload as Row
      if (this.mode === 'upsert' && this.ignoreDuplicates && this.conflictColumn) {
        // ON CONFLICT DO NOTHING: no error, and no row comes back.
        if (rows.some((r) => r[this.conflictColumn!] === p[this.conflictColumn!])) {
          return { data: [], error: null }
        }
      }
      const row = { id: randomUUID(), ...p }
      rows.push(row)
      return { data: [row], error: null }
    }

    const hit = rows.filter((r) => this.match(r))
    if (this.mode === 'update') {
      hit.forEach((r) => Object.assign(r, this.payload))
      return { data: hit, error: null }
    }
    if (this.headOnly) return { data: null, error: null, count: hit.length }
    return { data: this.limitN === null ? hit : hit.slice(0, this.limitN), error: null }
  }

  maybeSingle() {
    const { data, error } = this.run()
    return Promise.resolve({ data: data?.length ? data[0] : null, error })
  }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}

const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// -----------------------------------------------------------
// Stubbed bt-pricing-service. The quote-lock saga is not what this file tests,
// so the lock always matches the body below and always consumes cleanly.
// -----------------------------------------------------------

const LOCKED_QUOTE = {
  id: QUOTE_ID,
  shipper_id: U_SHIPPER,
  quoted_price: 42000,
  currency: 'INR',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  consumed_at: null,
  consumed_by_booking_id: null,
  source_lat: 19.076, source_lng: 72.8777,
  dest_lat: 21.1458, dest_lng: 79.0882,
  distance_km: 840,
  vehicle_type: 'hcv', vehicle_class: 'HCV',
  load_type: 'general', weight_kg: 9000,
  breakdown_json: {},
}

globalThis.fetch = (async (url: string | URL) => {
  const href = String(url)
  const body = href.endsWith('/consume')
    ? { success: true, data: { ...LOCKED_QUOTE, consumed_at: new Date().toISOString() } }
    : { success: true, data: LOCKED_QUOTE }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

// -----------------------------------------------------------

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

const CREATE_BASE = {
  quote_id:            QUOTE_ID,
  source_address:      'Bhiwandi, Maharashtra',
  source_lat:          19.076,
  source_lng:          72.8777,
  destination_address: 'Nagpur, Maharashtra',
  dest_lat:            21.1458,
  dest_lng:            79.0882,
  load_type:           'general',
  weight_kg:           9000,
  vehicle_type:        'hcv',
  pickup_date:         '',
}

const userRow = (id: string) => store.users.find((u) => u.id === id)!
const userByPhone = (p: string) => store.users.filter((u) => u.phone_number === p)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { bookingRoutes } = await import('../src/routes/bookings.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(bookingRoutes, { prefix: '/bookings' })
  })
  await app.ready()

  const create = (token: string, extra: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/bookings',
    headers: { authorization: `Bearer ${token}` },
    payload: { ...CREATE_BASE, pickup_date: tomorrow(), ...extra } as any,
  })
  const get = (id: string, token: string) => app.inject({
    method: 'GET', url: `/bookings/${id}`, headers: { authorization: `Bearer ${token}` },
  })
  const list = (token: string) => app.inject({
    method: 'GET', url: '/bookings', headers: { authorization: `Bearer ${token}` },
  })

  // ── A new consignee is a RECORD, never an account ──────────────────────────
  console.log('\n── a new consignee becomes a credential-less party record')
  reset()

  let res = await create(tok(U_SHIPPER, 'shipper'), {
    consignee: {
      name: 'Kirana Traders',
      phone: '+91 98765 43210',
      email: 'kirana@example.co.in',
      gstin: '27bbbbb1111b1z5',
      city: 'Nagpur',
      pincode: '440001',
    },
  })
  check('create with a consignee 201', res.statusCode === 201, res.body.slice(0, 200))

  const created = userByPhone('9876543210')
  check('exactly one party row was created', created.length === 1, `got ${created.length}`)
  check('phone stored in the canonical 10-digit shape', created[0]?.phone_number === '9876543210')
  check('🔴 claimed_at is NULL — a record, not an account', created[0]?.claimed_at === null,
    String(created[0]?.claimed_at))
  check('🔴 no password_hash was minted', created[0]?.password_hash === undefined)
  check('🔴 no google_sub was minted', created[0]?.google_sub === undefined)
  check('shipper-KIND, so claiming it can post loads immediately', created[0]?.role === 'shipper')
  check('the GSTIN is stored uppercased', created[0]?.gstin === '27BBBBB1111B1Z5',
    String(created[0]?.gstin))

  const newBooking = JSON.parse(res.body).data
  check('the booking points at the party', newBooking?.consignee_user_id === created[0]?.id)
  check('receiver_email is still populated from the consignee — POD is unaffected',
    newBooking?.receiver_email === 'kirana@example.co.in', String(newBooking?.receiver_email))

  // ── Linking, and the rule that makes it safe ───────────────────────────────
  console.log('\n── an existing phone LINKS, and the linked row is never written to')
  reset()
  const usersBefore = store.users.length

  res = await create(tok(U_SHIPPER, 'shipper'), {
    consignee: {
      // The same human, spelled with the domestic trunk prefix.
      phone: '09000000001',
      // 🔴 Everything below is an attempt to rewrite a stranger's profile by
      // naming their mobile number on a booking anyone is allowed to post.
      name:  'ATTACKER RENAMED',
      email: 'attacker@evil.co',
      gstin: '29CCCCC2222C1Z5',
      address: 'Attacker Street',
      city:  'Nowhere',
    },
  })
  check('create linking an existing party 201', res.statusCode === 201, res.body.slice(0, 200))
  check('no duplicate party was created', store.users.length === usersBefore,
    `${store.users.length} vs ${usersBefore}`)
  check('a different spelling of the number still matched the same row',
    JSON.parse(res.body).data?.consignee_user_id === U_CONSIGNEE)

  const victim = userRow(U_CONSIGNEE)
  check('🔴 full_name untouched',  victim.full_name === EXISTING_NAME,  String(victim.full_name))
  check('🔴 email untouched',      victim.email === EXISTING_EMAIL,     String(victim.email))
  check('🔴 gstin untouched',      victim.gstin === EXISTING_GSTIN,     String(victim.gstin))
  check('🔴 address untouched',    victim.address === '14 MIDC Road',   String(victim.address))
  check('🔴 city untouched',       victim.city === EXISTING_CITY,       String(victim.city))
  check('🔴 claimed_at untouched — a claimed account cannot be un-claimed',
    victim.claimed_at === CLAIMED_AT, String(victim.claimed_at))

  // The booking's own receiver_email comes from what the CALLER typed, never
  // from the row we matched. Reading it off the linked profile would turn
  // "post a load naming this phone number" into an address-lookup oracle.
  check('the linked party\'s stored email is NOT echoed back onto the booking',
    JSON.parse(res.body).data?.receiver_email === 'attacker@evil.co',
    String(JSON.parse(res.body).data?.receiver_email))

  // ── Two loads for the same new customer, at the same instant ──────────────
  // The DO-NOTHING half of the upsert. Both requests look up the phone, both
  // miss, both insert; the loser gets an empty result rather than a 23505 and
  // re-reads the winner's row. One party, two bookings, no 500.
  console.log('\n── two simultaneous bookings naming the same NEW consignee')
  reset()

  const both = await Promise.all([
    create(tok(U_SHIPPER, 'shipper'), { consignee: { name: 'Kirana Traders', phone: '9876543210' } }),
    create(tok(U_SHIPPER, 'shipper'), { consignee: { name: 'Kirana Traders', phone: '9876543210' } }),
  ])
  check('both creates 201', both.every((r) => r.statusCode === 201),
    both.map((r) => r.statusCode).join('/'))
  check('exactly ONE party row exists for that phone', userByPhone('9876543210').length === 1,
    `${userByPhone('9876543210').length}`)
  const [idA, idB] = both.map((r) => JSON.parse(r.body).data?.consignee_user_id)
  check('and both bookings point at the same party', !!idA && idA === idB, `${idA} vs ${idB}`)

  // ── D-29: a load must name a reachable consignee ───────────────────────────
  console.log('\n── name and phone are both required (D-29)')
  reset()

  const rejections: Array<[string, Record<string, unknown>]> = [
    ['a consignee with no phone at all',   { consignee: { name: 'Kirana Traders' } }],
    ['an empty phone',                     { consignee: { name: 'Kirana Traders', phone: '' } }],
    ['a 9-digit number',                   { consignee: { name: 'Kirana Traders', phone: '912345678' } }],
    ['a landline-shaped number',           { consignee: { name: 'Kirana Traders', phone: '0224567890' } }],
    ['a number starting below 6',          { consignee: { name: 'Kirana Traders', phone: '5876543210' } }],
    ['a consignee with no name',           { consignee: { phone: '9876543210' } }],
    ['an empty name',                      { consignee: { name: '   ', phone: '9876543210' } }],
    ['a malformed GSTIN',                  { consignee: { name: 'K', phone: '9876543210', gstin: 'NOTAGSTIN' } }],
    ['neither a consignee nor a receiver_email', {}],
  ]
  for (const [label, body] of rejections) {
    res = await create(tok(U_SHIPPER, 'shipper'), body)
    check(`rejects ${label} with 400`, res.statusCode === 400, String(res.statusCode))
  }
  check('nothing was persisted through any rejection', store.users.length === 5 && store.bookings.length === 2,
    `${store.users.length} users / ${store.bookings.length} bookings`)

  // ── Back-compat: the legacy receiver_email-only create ─────────────────────
  console.log('\n── a legacy receiver_email-only create is unchanged')
  reset()

  res = await create(tok(U_SHIPPER, 'shipper'), { receiver_email: '  legacy@acme.co.in  ' })
  check('legacy create 201', res.statusCode === 201, res.body.slice(0, 200))
  const legacy = JSON.parse(res.body).data
  check('receiver_email is trimmed and stored', legacy?.receiver_email === 'legacy@acme.co.in',
    String(legacy?.receiver_email))
  check('no party record was invented for it', store.users.length === 5, `${store.users.length}`)
  // The column is not written at all on this path, which is exactly what keeps
  // it working on a database without migration 0026.
  check('consignee_user_id is not written', legacy?.consignee_user_id === undefined,
    String(legacy?.consignee_user_id))

  // ── A pre-0026 database ────────────────────────────────────────────────────
  console.log('\n── a database where migration 0026 has NOT been applied')
  reset()
  missingColumns = {
    users:    new Set(['gstin', 'claimed_at']),
    bookings: new Set(['consignee_user_id']),
  }

  res = await create(tok(U_SHIPPER, 'shipper'), { receiver_email: 'legacy@acme.co.in' })
  check('the legacy path still works, untouched', res.statusCode === 201, res.body.slice(0, 200))

  res = await create(tok(U_SHIPPER, 'shipper'), {
    consignee: { name: 'Kirana Traders', phone: '9876543210' },
  })
  check('naming a NEW consignee fails loudly with 503', res.statusCode === 503, String(res.statusCode))
  check('and the message names migration 0026', /migration 0026/.test(JSON.parse(res.body).error ?? ''),
    JSON.parse(res.body).error)
  check('no half-made party record was left behind', userByPhone('9876543210').length === 0)

  // The linking path writes no users column, so it gets all the way to the
  // booking insert before the missing column stops it — the second of the two
  // guards, and the one that matters for a consignee who already has an account.
  res = await create(tok(U_SHIPPER, 'shipper'), {
    consignee: { name: 'whatever', phone: EXISTING_PHONE },
  })
  check('naming an EXISTING consignee also fails loudly with 503', res.statusCode === 503,
    String(res.statusCode))
  check('and that message names migration 0026 too',
    /migration 0026/.test(JSON.parse(res.body).error ?? ''), JSON.parse(res.body).error)

  // Reads degrade rather than fail: the column simply is not there.
  reset()
  store.bookings.forEach((b) => { delete b.consignee_user_id })
  res = await get(B_CONSIGNED, tok(U_SHIPPER, 'shipper'))
  check('a booking read on a pre-0026 database still 200s', res.statusCode === 200, String(res.statusCode))
  check('with no consignee block at all', JSON.parse(res.body).data?.consignee === undefined)

  // ── The read gate ─────────────────────────────────────────────────────────
  console.log('\n── who may see the consignee')
  reset()

  res = await get(B_CONSIGNED, tok(U_SHIPPER, 'shipper'))
  const forShipper = JSON.parse(res.body).data?.consignee
  check('the shipper who posted it sees the consignee', !!forShipper, JSON.stringify(forShipper))
  check('name is projected',  forShipper?.name === EXISTING_NAME)
  check('phone is projected', forShipper?.phone === EXISTING_PHONE)
  check('city is projected',  forShipper?.city === EXISTING_CITY)
  check('🔴 email is NOT projected',   !('email' in (forShipper ?? {})))
  check('🔴 gstin is NOT projected',   !('gstin' in (forShipper ?? {})))
  check('🔴 address is NOT projected', !('address' in (forShipper ?? {})))

  res = await get(B_CONSIGNED, tok(U_DRIVER, 'driver'))
  check('the assigned driver sees them — they hand the goods over',
    JSON.parse(res.body).data?.consignee?.phone === EXISTING_PHONE, res.body.slice(0, 200))

  res = await get(B_CONSIGNED, tok(U_CONSIGNEE, 'shipper'))
  check('the claimed consignee sees their own inbound shipment',
    JSON.parse(res.body).data?.consignee?.name === EXISTING_NAME, res.body.slice(0, 200))
  // 🔴 …but a consignee is a party to the SHIPMENT, never to the carriage economics
  // (personas.seesCommercialsOnBooking → false). The read must be commercially masked (review F18).
  {
    const cData = JSON.parse(res.body).data
    check('🔴 consignee read masks the money — viewer.sees_commercials is false (F18)',
      cData?.viewer?.sees_commercials === false, JSON.stringify(cData?.viewer))
    check('🔴 consignee read has the price stripped (F18)',
      cData?.quoted_price === undefined, `quoted_price=${cData?.quoted_price}`)
  }

  // …and the guard that read widened is otherwise unchanged: a shipper who is
  // NEITHER the poster nor the consignee is still refused the booking outright.
  res = await get(B_CONSIGNED, tok(U_ADMIN, 'shipper'))
  check('an unrelated shipper is still 403', res.statusCode === 403, String(res.statusCode))

  res = await get(B_LEGACY, tok(U_CONSIGNEE, 'shipper'))
  check('and a consignee on one booking gets nothing on another', res.statusCode === 403,
    String(res.statusCode))

  res = await get(B_CONSIGNED, tok(U_ADMIN, 'admin'))
  check('ops sees it — they unstick trips for both parties',
    JSON.parse(res.body).data?.consignee?.phone === EXISTING_PHONE, res.body.slice(0, 200))

  // 🔴 The disclosure this gate exists to prevent.
  res = await get(B_CONSIGNED, tok(U_STRANGER, 'driver'))
  check('an UNRELATED driver still reads the booking', res.statusCode === 200, String(res.statusCode))
  check('🔴 but gets no consignee block', JSON.parse(res.body).data?.consignee === undefined,
    JSON.stringify(JSON.parse(res.body).data?.consignee))

  // Same rule down the list path, where a solo driver's payload is a UNION of
  // their own trips and the open load board.
  store.bookings.push({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', shipper_id: U_SHIPPER, driver_id: null,
    fleet_owner_id: null, vehicle_id: null, status: 'pending', receiver_email: null,
    consignee_user_id: U_CONSIGNEE, quoted_price: 21000, final_price: null, min_acceptable: null,
    source_address: 'Mumbai', destination_address: 'Nagpur',
  })

  res = await list(tok(U_STRANGER, 'driver'))
  const strangerRows = JSON.parse(res.body).data as any[]
  check('the open load board is still visible to them', strangerRows.length > 0, String(strangerRows.length))
  check('🔴 and not one row on it carries a consignee',
    strangerRows.every((b) => b.consignee === undefined),
    JSON.stringify(strangerRows.map((b) => b.consignee)))

  res = await list(tok(U_DRIVER, 'driver'))
  const assignedRows = JSON.parse(res.body).data as any[]
  check('the assigned driver sees the consignee on THEIR trip',
    assignedRows.find((b) => b.id === B_CONSIGNED)?.consignee?.phone === EXISTING_PHONE)
  check('and still none on the loads they are merely browsing',
    assignedRows.find((b) => b.id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')?.consignee === undefined)

  res = await list(tok(U_SHIPPER, 'shipper'))
  const shipperRows = JSON.parse(res.body).data as any[]
  check('the shipper sees it on their own list',
    shipperRows.find((b) => b.id === B_CONSIGNED)?.consignee?.name === EXISTING_NAME)
  check('a legacy booking with no consignee simply has no block',
    shipperRows.find((b) => b.id === B_LEGACY)?.consignee === undefined)

  console.log(`\nRESULT: ${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
