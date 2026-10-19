/**
 * Awarding an auction must tell the LOSERS, not just the winner.
 *
 * The regression this pins: awardBooking expires every other open quote as part
 * of the award, and listLosingQuotes only returns live ones. While the lookup
 * happened inside emitQuoteAwarded — i.e. after the award — it always came back
 * empty, so the winner was mailed and every losing carrier was silently told
 * nothing, holding capacity for a load they did not get. The losing set has to be
 * snapshotted BEFORE the award and passed into the emit.
 *
 * Exercises the REAL accept route via app.inject() with an in-memory fake
 * Supabase, and asserts against store.notification_outbox — the same shape the
 * direct-attach suite uses for its own losing-bidder notice.
 *
 * Run: npx tsx test/award-losing-bidders.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.PAN_GATE = 'off' // the PAN gate is a KYC rule, not what this exercises
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ── Ids ─────────────────────────────────────────────────────────────────────
const B_AUCTION = '11111111-1111-4111-8111-111111111111'
// A booking already moved on by someone else: awarded_quote_id is still null, so
// acceptQuote's own pre-check passes and only awardBooking's WHERE guard catches it.
const B_STALE   = '1a1a1a1a-1111-4111-8111-111111111111'
// The uncontested case: one bid, nobody to tell they lost. The loop must simply not
// run, rather than degenerate into mailing the winner a loss notice.
const B_SOLO    = '1b1b1b1b-1111-4111-8111-111111111111'
const U_SHIPPER = '22222222-2222-4222-8222-222222222222'

const Q_WIN       = '33333333-3333-4333-8333-333333333333'
const Q_LOSE_A    = '44444444-4444-4444-8444-444444444444'
const Q_LOSE_B    = '55555555-5555-4555-8555-555555555555'
const Q_LOSE_FLT  = '66666666-6666-4666-8666-666666666666'
const Q_WITHDRAWN = '77777777-7777-4777-8777-777777777777'
const Q_REJECTED  = '88888888-8888-4888-8888-888888888888'
const Q_STALE     = '99999999-9999-4999-8999-999999999999'
const Q_SOLO      = '9a9a9a9a-9999-4999-8999-999999999999'

const D_WIN  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const D_A    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const D_B    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D_GONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const D_REJ  = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const F_LOSE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const U_WIN   = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const U_A     = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const U_B     = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
const U_GONE  = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const U_REJ   = 'e0e0e0e0-eeee-4eee-8eee-eeeeeeeeeeee'
const U_FLEET = 'f0f0f0f0-ffff-4fff-8fff-ffffffffffff'

type Row = Record<string, any>
const store: Record<string, Row[]> = {}

const bookingBase = {
  source_address: 'Bhiwandi', destination_address: 'Raipur', load_type: 'general',
  weight_kg: 9000, pickup_date: '2026-08-20', quoted_price: 42000, final_price: null,
  booking_type: 'auction', auction_deadline: null, fleet_owner_id: null, driver_id: null,
}

const quoteBase = { driver_id: null, fleet_owner_id: null, message: null, updated_at: '2026-08-06T00:00:00.000Z' }

/**
 * Table whose next access fails, or null. The seam for "the notification layer is
 * down": set it to notification_outbox and every enqueue on the award returns a DB
 * error, exactly as a dead/overloaded Postgres would.
 */
let failTable: string | null = null

function reset() {
  failTable = null
  store.bookings = [
    { ...bookingBase, id: B_AUCTION, shipper_id: U_SHIPPER, status: 'negotiating', awarded_quote_id: null },
    // status 'accepted' — outside awardBooking's `status IN (pending, negotiating)` guard.
    { ...bookingBase, id: B_STALE, shipper_id: U_SHIPPER, status: 'accepted', awarded_quote_id: null },
    { ...bookingBase, id: B_SOLO, shipper_id: U_SHIPPER, status: 'negotiating', awarded_quote_id: null },
  ]
  store.quotes = [
    { ...quoteBase, id: Q_WIN,       booking_id: B_AUCTION, driver_id: D_WIN, amount: 40000, status: 'submitted' },
    { ...quoteBase, id: Q_LOSE_A,    booking_id: B_AUCTION, driver_id: D_A,   amount: 45000, status: 'submitted' },
    // Mid-negotiation when the shipper awarded elsewhere — still very much in play.
    { ...quoteBase, id: Q_LOSE_B,    booking_id: B_AUCTION, driver_id: D_B,   amount: 43000, status: 'countered' },
    { ...quoteBase, id: Q_LOSE_FLT,  booking_id: B_AUCTION, fleet_owner_id: F_LOSE, amount: 44000, status: 'submitted' },
    // Already terminal: both of these were told where they stood at the time.
    { ...quoteBase, id: Q_WITHDRAWN, booking_id: B_AUCTION, driver_id: D_GONE, amount: 39000, status: 'withdrawn' },
    { ...quoteBase, id: Q_REJECTED,  booking_id: B_AUCTION, driver_id: D_REJ,  amount: 50000, status: 'rejected' },
    { ...quoteBase, id: Q_STALE,     booking_id: B_STALE,   driver_id: D_WIN,  amount: 41000, status: 'submitted' },
    // The only bid on its booking — no competing carrier to notify.
    { ...quoteBase, id: Q_SOLO,      booking_id: B_SOLO,    driver_id: D_WIN,  amount: 41500, status: 'submitted' },
  ]
  store.drivers = [
    { id: D_WIN,  user_id: U_WIN,  truck_number: 'MH04 1111' },
    { id: D_A,    user_id: U_A,    truck_number: 'MH04 2222' },
    { id: D_B,    user_id: U_B,    truck_number: 'MH04 3333' },
    { id: D_GONE, user_id: U_GONE, truck_number: 'MH04 4444' },
    { id: D_REJ,  user_id: U_REJ,  truck_number: 'MH04 5555' },
  ]
  store.fleet_owners = [{ id: F_LOSE, user_id: U_FLEET, company_name: 'Sharma Logistics' }]
  store.users = [
    { id: U_SHIPPER, email: 'shipper@example.com', full_name: 'Shipper One' },
    { id: U_WIN,   email: 'win@carrier.test',   full_name: 'Winning Driver' },
    { id: U_A,     email: 'losea@carrier.test', full_name: 'Loser A' },
    { id: U_B,     email: 'loseb@carrier.test', full_name: 'Loser B' },
    { id: U_GONE,  email: 'gone@carrier.test',  full_name: 'Withdrawn Driver' },
    { id: U_REJ,   email: 'rej@carrier.test',   full_name: 'Rejected Driver' },
    { id: U_FLEET, email: 'fleet@carrier.test', full_name: 'Fleet Owner' },
  ]
  store.notification_outbox = []
  store.notification_preferences = []
}

// -----------------------------------------------------------
// Fake Supabase — the T-BE-1 injection seam. Supports exactly the operator
// surface the accept path emits: eq / neq / in / is / not-in, plus the unique
// dedupe_key index on notification_outbox.
// -----------------------------------------------------------

class FakeQuery {
  private filters: Array<['eq' | 'neq' | 'in' | 'is' | 'notin', string, any]> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}

  select() { return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  neq(c: string, v: any) { this.filters.push(['neq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  is(c: string, v: any) { this.filters.push(['is', c, v]); return this }
  /** Only `.not(col, 'in', '(a,b,c)')` — the one negation awardBooking uses. */
  not(c: string, _op: string, list: string) {
    this.filters.push(['notin', c, list.replace(/^\(|\)$/g, '').split(',')])
    return this
  }
  order() { return this }
  limit() { return this }

  private match(r: Row): boolean {
    return this.filters.every(([op, c, v]) => {
      if (op === 'eq') return r[c] === v
      if (op === 'neq') return r[c] !== v
      if (op === 'in') return (v as any[]).includes(r[c])
      if (op === 'is') return (r[c] ?? null) === v
      return !(v as any[]).includes(r[c])
    })
  }

  private run(): { data: any; error: any } {
    // Injected outage. Not a 23505 — that one is the dedupe path and is swallowed by
    // design; this is the genuine "the queue is unreachable" failure.
    if (this.table === failTable) {
      return { data: null, error: { code: '08006', message: 'connection failure' } }
    }

    const rows = store[this.table] ?? (store[this.table] = [])

    if (this.mode === 'insert') {
      const p = this.payload as Row
      // The unique index from migration 021 — one email per event per recipient.
      if (this.table === 'notification_outbox' && rows.some(r => r.dedupe_key === p.dedupe_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      const row = { id: `row-${rows.length + 1}`, status: 'pending', attempts: 0, ...p }
      rows.push(row)
      return { data: [row], error: null }
    }

    const hit = rows.filter(r => this.match(r))
    if (this.mode === 'update') {
      hit.forEach(r => Object.assign(r, this.payload))
      return { data: hit, error: null }
    }
    return { data: hit, error: null }
  }

  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data?.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// ── Harness ─────────────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const tok = (u: string, role: string) => jwt.sign({ userId: u, role }, process.env.JWT_SECRET!)
const outbox = () => store.notification_outbox
const eventsTo = (email: string) => outbox().filter(r => r.recipient_email === email).map(r => r.event_type)
const lostRecipients = () =>
  outbox().filter(r => r.event_type === 'quote_lost').map(r => r.recipient_email).sort()
const quoteRow = (id: string) => store.quotes.find(q => q.id === id)!

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fakeSupabase as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { quoteRoutes } = await import('../src/routes/quotes.js')
  const quoteRepo = await import('../src/lib/quote-repository.js')

  const app = Fastify({ logger: false })
  await app.register(async (a) => {
    await a.register(authPlugin)
    await a.register(quoteRoutes, { prefix: '/bookings' })
  })
  await app.ready()

  const accept = (bookingId: string, quoteId: string, userId = U_SHIPPER) => app.inject({
    method: 'PATCH',
    url: `/bookings/${bookingId}/quotes/${quoteId}/accept`,
    headers: { authorization: `Bearer ${tok(userId, 'shipper')}` },
  })

  // ── The award itself ──────────────────────────────────────────────────────
  console.log('\n── award')
  reset()

  let res = await accept(B_AUCTION, Q_WIN)
  check('shipper awards the auction', res.statusCode === 200, res.body)
  check('booking is bound to the winner',
    store.bookings[0].driver_id === D_WIN && store.bookings[0].awarded_quote_id === Q_WIN)
  check('winning quote is accepted', quoteRow(Q_WIN).status === 'accepted')
  check('the live losers are expired',
    [Q_LOSE_A, Q_LOSE_B, Q_LOSE_FLT].every(id => quoteRow(id).status === 'expired'))
  check('terminal quotes are left alone',
    quoteRow(Q_WITHDRAWN).status === 'withdrawn' && quoteRow(Q_REJECTED).status === 'rejected')

  // ── Who got told ──────────────────────────────────────────────────────────
  console.log('\n── notifications')

  check('the winner is told they won', eventsTo('win@carrier.test').includes('quote_awarded'))

  // THE REGRESSION. Before the fix this list was empty on every single award:
  // awardBooking had already flipped these three to 'expired', and the lookup
  // inside the emit only matches submitted/countered.
  check('every live losing bidder is told they lost',
    JSON.stringify(lostRecipients()) ===
      JSON.stringify(['fleet@carrier.test', 'losea@carrier.test', 'loseb@carrier.test']),
    JSON.stringify(lostRecipients()))

  check('a mid-negotiation bidder is included, not just untouched bids',
    eventsTo('loseb@carrier.test').includes('quote_lost'))
  // A fleet bid answers to the OWNER, not to any driver (founder Q15).
  check('a losing FLEET bid mails the owner', eventsTo('fleet@carrier.test').includes('quote_lost'))

  check('a bidder who withdrew is not told again', eventsTo('gone@carrier.test').length === 0)
  check('a bidder already rejected is not told twice', eventsTo('rej@carrier.test').length === 0)
  check('the winner is never sent a loss notice',
    !eventsTo('win@carrier.test').includes('quote_lost'))

  check('losing notices are keyed per quote',
    outbox().filter(r => r.event_type === 'quote_lost')
      .every(r => [Q_LOSE_A, Q_LOSE_B, Q_LOSE_FLT].some(id => r.dedupe_key === `quote_lost:${id}`)),
    JSON.stringify(outbox().filter(r => r.event_type === 'quote_lost').map(r => r.dedupe_key)))

  // Why the snapshot has to come first, asserted directly rather than implied:
  // by this point the losers are unfindable, so a lookup inside the emit — which
  // runs after the award — can only ever return nothing.
  const afterAward = await quoteRepo.listLosingQuotes(B_AUCTION, Q_WIN)
  check('after the award there are no live losers left to look up', afterAward.length === 0,
    String(afterAward.length))

  // ── Re-award ──────────────────────────────────────────────────────────────
  console.log('\n── re-award')
  const before = outbox().length

  res = await accept(B_AUCTION, Q_LOSE_A)
  check('a second award is refused', res.statusCode === 409, res.body)
  check('and mails nobody a second time', outbox().length === before, String(outbox().length))

  // ── A failed award mails nobody ───────────────────────────────────────────
  // The emit is a consequence of the award, so it must not fire when the award
  // itself lost the race — even though the losing set was read before the attempt.
  console.log('\n── award that loses the race')
  reset()

  res = await accept(B_STALE, Q_STALE)
  check('an already-moved-on booking is refused', res.statusCode === 409, res.body)
  check('nothing is queued when the award did not land', outbox().length === 0,
    JSON.stringify(outbox().map(r => r.event_type)))
  check('and the quote is untouched', quoteRow(Q_STALE).status === 'submitted')

  // ── An uncontested auction ────────────────────────────────────────────────
  // The snapshot is legitimately empty here. The winner must still be told, and the
  // loser loop must simply not run — an empty set is the normal single-bid case, not
  // the symptom the fix exists to catch.
  console.log('\n── sole bidder')
  reset()

  res = await accept(B_SOLO, Q_SOLO)
  check('the sole bid is awarded', res.statusCode === 200, res.body)
  check('the winner is still told they won',
    eventsTo('win@carrier.test').includes('quote_awarded'))
  check('nobody is told they lost', lostRecipients().length === 0,
    JSON.stringify(lostRecipients()))
  check('exactly one notice is queued in total', outbox().length === 1,
    JSON.stringify(outbox().map(r => r.event_type)))

  // ── The queue is down ─────────────────────────────────────────────────────
  // Telling people is a consequence of the award, never a precondition. If the outbox
  // is unreachable the award must still stand and the request must still succeed —
  // the alternative is a shipper who cannot award a load because a mail table is sick.
  console.log('\n── notification failure does not roll back the award')
  reset()
  failTable = 'notification_outbox'

  res = await accept(B_AUCTION, Q_WIN)
  check('the accept still succeeds', res.statusCode === 200, res.body)
  check('the award still landed',
    store.bookings[0].awarded_quote_id === Q_WIN && store.bookings[0].driver_id === D_WIN)
  check('the winning quote is still accepted', quoteRow(Q_WIN).status === 'accepted')
  check('the losers are still expired',
    [Q_LOSE_A, Q_LOSE_B, Q_LOSE_FLT].every(id => quoteRow(id).status === 'expired'))
  check('and nothing was queued', outbox().length === 0,
    JSON.stringify(outbox().map(r => r.event_type)))

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
