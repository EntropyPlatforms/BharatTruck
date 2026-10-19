/**
 * The load board and bid list for a SOLO owner-driver (no fleet, one truck of their own).
 *
 * The bug: "Load available" showed in a solo driver's activity, but Find work answered
 * "Not found" — GET /fleet/auctions and /fleet/bids were gated on having a fleet, although
 * bt-booking-service lets that same driver place a bid. These pin that the board is now scoped
 * to whichever bidder the caller is, and that a caller with nothing to bid with is still refused.
 *
 * Runs the REAL routes against a stand-in PostgREST server (the service's Supabase client is not
 * injectable), so the filters asserted are the ones actually sent on the wire.
 * Run: npx tsx test/solo-carrier-board.test.mts
 */
import http from 'node:http'
import Fastify from 'fastify'

type Row = Record<string, any>
const U_SOLO = 'u-solo', U_FLEET = 'u-fleet', U_NOTRUCK = 'u-notruck', U_PLAIN = 'u-plain'
const D_SOLO = 'd-solo', D_NOTRUCK = 'd-notruck', F1 = 'f-1'

const db: Record<string, Row[]> = {
  fleet_owners: [{ id: F1, user_id: U_FLEET, company_name: 'Fleet One', is_active: true }],
  fleet_members: [],
  drivers: [{ id: D_SOLO, user_id: U_SOLO }, { id: D_NOTRUCK, user_id: U_NOTRUCK }],
  vehicles: [{ id: 'v-1', driver_id: D_SOLO, is_active: true }, { id: 'v-2', driver_id: D_NOTRUCK, is_active: false }],
  bookings: [
    { id: 'b-open', shipper_id: 'u-shipper', status: 'pending', target_driver_id: null, created_at: '2026-10-01T00:00:00Z' },
    { id: 'b-direct', shipper_id: 'u-shipper', status: 'pending', target_driver_id: D_SOLO, created_at: '2026-10-02T00:00:00Z' },
  ],
  quotes: [
    { id: 'q-solo', booking_id: 'b-open', driver_id: D_SOLO, fleet_owner_id: null, amount: 9000, status: 'submitted', submitted_at: '2026-10-02T00:00:00Z' },
    { id: 'q-fleet', booking_id: 'b-open', driver_id: null, fleet_owner_id: F1, amount: 8800, status: 'submitted', submitted_at: '2026-10-02T01:00:00Z' },
  ],
  users: [{ id: 'u-shipper', full_name: 'Test Shipper' }],
}

// Just enough PostgREST: eq / is.null / in / the one `or` the board sends. Everything asked is recorded.
const asked: Array<{ table: string; params: URLSearchParams }> = []
function match(row: Row, key: string, expr: string): boolean {
  if (expr.startsWith('eq.')) return String(row[key]) === expr.slice(3)
  if (expr.startsWith('neq.')) return String(row[key]) !== expr.slice(4)
  if (expr === 'is.null') return row[key] == null
  if (expr.startsWith('in.(')) return expr.slice(4, -1).split(',').map(s => s.replace(/"/g, '')).includes(String(row[key]))
  return true
}
const pg = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  const table = url.pathname.replace('/rest/v1/', '')
  asked.push({ table, params: url.searchParams })
  let rows = [...(db[table] ?? [])]
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue
    if (k === 'or') {
      const alts = v.slice(1, -1).split(',').map(a => { const i = a.indexOf('.'); return [a.slice(0, i), a.slice(i + 1)] as const })
      // auction_deadline is absent from these rows, so its `or` (null or future) passes everything.
      rows = rows.filter(r => alts.some(([c, e]) => match(r, c, e)))
    } else rows = rows.filter(r => match(r, k, v))
  }
  const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
  const head = req.method === 'HEAD'
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-range', `0-${Math.max(rows.length - 1, 0)}/${rows.length}`)
  if (single && rows.length === 0) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '0 rows' })) }
  res.end(head ? undefined : JSON.stringify(single ? rows[0] : rows))
})

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  await new Promise<void>(r => pg.listen(0, '127.0.0.1', r))
  process.env.SUPABASE_URL = `http://127.0.0.1:${(pg.address() as any).port}`
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake'

  const { auctionRoutes } = await import('../src/routes/auctions.js')
  const { FleetError } = await import('../src/lib/types.js')
  const app = Fastify({ logger: false })
  app.decorateRequest('user', null as any)
  app.addHook('onRequest', async (req) => { (req as any).user = { userId: req.headers['x-user'] as string, role: 'driver' } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof FleetError) return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
    return reply.status(500).send({ success: false, error: String(err) })
  })
  await app.register(auctionRoutes, { prefix: '/fleet' })
  const get = (url: string, user: string) => app.inject({ method: 'GET', url, headers: { 'x-user': user } })

  console.log('\n── solo owner-driver ──')
  asked.length = 0
  let r = await get('/fleet/auctions', U_SOLO)
  const board = r.json().data
  check('board 200 (was 404 "not found")', r.statusCode === 200, `(got ${r.statusCode} ${r.body})`)
  check('no fleet id in the reply', board?.fleet_owner_id === null, JSON.stringify(board?.fleet_owner_id))
  check('sees the open load AND the load aimed at them', JSON.stringify(board?.auctions?.map((a: Row) => a.id).sort()) === JSON.stringify(['b-direct', 'b-open']), JSON.stringify(board?.auctions?.map((a: Row) => a.id)))
  const open = board?.auctions?.find((a: Row) => a.id === 'b-open')
  check('"my bid" is the driver\'s own quote, not the fleet\'s', open?.my_bid?.id === 'q-solo', JSON.stringify(open?.my_bid))
  check('bid count covers every live bid', open?.bid_count === 2, String(open?.bid_count))
  check('own posted loads excluded by the caller\'s user id', asked.some(a => a.table === 'bookings' && a.params.get('shipper_id') === `neq.${U_SOLO}`), '')

  r = await get('/fleet/bids', U_SOLO)
  check('bid list 200 with only their own bid', r.statusCode === 200 && r.json().data?.bids?.length === 1 && r.json().data.bids[0].id === 'q-solo', r.body)
  check('bid carries its load', r.json().data?.bids?.[0]?.booking?.id === 'b-open', r.body)

  console.log('\n── fleet (unchanged) ──')
  r = await get('/fleet/auctions', U_FLEET)
  const fb = r.json().data
  check('fleet board 200 with its fleet id', r.statusCode === 200 && fb?.fleet_owner_id === F1, r.body)
  check('fleet does not see a load aimed at one driver', JSON.stringify(fb?.auctions?.map((a: Row) => a.id)) === JSON.stringify(['b-open']), JSON.stringify(fb?.auctions?.map((a: Row) => a.id)))
  check('fleet "my bid" is the fleet\'s quote', fb?.auctions?.[0]?.my_bid?.id === 'q-fleet', JSON.stringify(fb?.auctions?.[0]?.my_bid))
  r = await get('/fleet/bids', U_FLEET)
  check('fleet bid list is the fleet\'s bid only', r.json().data?.bids?.length === 1 && r.json().data.bids[0].id === 'q-fleet', r.body)

  console.log('\n── nothing to bid with ──')
  r = await get('/fleet/auctions', U_NOTRUCK)
  check('a driver whose only truck is retired is refused 404', r.statusCode === 404 && r.json().code === 'NOT_FOUND', `(got ${r.statusCode})`)
  r = await get('/fleet/auctions', U_PLAIN)
  check('a user with no driver record and no fleet is refused 404', r.statusCode === 404, `(got ${r.statusCode})`)
  r = await get('/fleet/bids', U_PLAIN)
  check('…and has no bid list either', r.statusCode === 404, `(got ${r.statusCode})`)

  await app.close()
  pg.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
