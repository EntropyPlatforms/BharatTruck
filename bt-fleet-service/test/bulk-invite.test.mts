/**
 * POST /fleet/drivers/invite/bulk — a fleet owner invites a whole CSV of drivers in one call.
 *
 * Pins: every row runs the SAME lookup + insert as the single invite (no account is ever created,
 * an unknown number is 'no_account'); one bad row never fails the batch; in-file duplicates are
 * caught by canonical mobile, by email, and by two channels naming one driver; drivers already on
 * THIS fleet are told apart from drivers live elsewhere (which stays undisclosed); the 200-row cap
 * refuses the request; and only the owner or a manage_drivers delegate may call it.
 *
 * Runs the REAL routes and the REAL auth plugin against a stand-in PostgREST server (the service's
 * Supabase client is not injectable), so the inserts asserted are the ones actually sent.
 * Run: npx tsx test/bulk-invite.test.mts
 */
import http from 'node:http'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>
const F1 = 'f-1', F2 = 'f-2'
const U_OWNER = 'u-owner', U_OTHER_OWNER = 'u-owner2', U_CLERK = 'u-clerk', U_HR = 'u-hr', U_NOBODY = 'u-nobody'

// Drivers by phone (bare 10 digits, as bt-auth-service stores them) and one by email.
const users: Row[] = [
  { id: 'u-d1', full_name: 'Ravi Kumar',   phone_number: '9000000001', email: 'ravi@example.com', kyc_status: 'verified' },
  { id: 'u-d2', full_name: 'Suresh Yadav', phone_number: '9000000002', email: null, kyc_status: 'pending' },
  { id: 'u-d3', full_name: 'Amit Singh',   phone_number: '9000000003', email: null, kyc_status: 'pending' },
  { id: 'u-d4', full_name: 'Mohan Lal',    phone_number: '9000000004', email: null, kyc_status: 'pending' },
  { id: 'u-d5', full_name: 'Vijay Patil',  phone_number: '9000000005', email: null, kyc_status: 'pending' },
  { id: 'u-d6', full_name: 'Kiran Rao',    phone_number: '9000000006', email: 'kiran_rao@example.com', kyc_status: 'pending' },
  // Signed up but never finished driver onboarding: no drivers row.
  { id: 'u-shipper', full_name: 'Just A Shipper', phone_number: '9000000009', email: null, kyc_status: 'pending' },
]
const drivers: Row[] = ['1', '2', '3', '4', '5', '6'].map(n => ({ id: `d-${n}`, user_id: `u-d${n}`, average_rating: null, total_trips: 0 }))

let db: Record<string, Row[]>
function reset() {
  db = {
    fleet_owners: [
      { id: F1, user_id: U_OWNER, company_name: 'Fleet One', is_active: true },
      { id: F2, user_id: U_OTHER_OWNER, company_name: 'Fleet Two', is_active: true },
    ],
    fleet_members: [
      { fleet_owner_id: F1, user_id: U_CLERK, grants: ['dispatch'], status: 'active' },
      { fleet_owner_id: F1, user_id: U_HR, grants: ['manage_drivers'], status: 'active' },
    ],
    users: users.map(u => ({ ...u })),
    drivers: drivers.map(d => ({ ...d })),
    bookings: [],
    fleet_drivers: [
      // d-2 already ACTIVE in fleet 1, d-3 already INVITED by fleet 1, d-4 live in fleet 2.
      { id: 'fd-2', fleet_owner_id: F1, driver_id: 'd-2', status: 'active', invited_at: '2026-10-01T00:00:00Z' },
      { id: 'fd-3', fleet_owner_id: F1, driver_id: 'd-3', status: 'pending', invited_at: '2026-10-02T00:00:00Z' },
      { id: 'fd-4', fleet_owner_id: F2, driver_id: 'd-4', status: 'active', invited_at: '2026-10-03T00:00:00Z' },
    ],
  }
}
reset()

// Just enough PostgREST: eq / in / ilike filters, single-object reads, and the fleet_drivers insert
// with the fleet_drivers_one_live_per_driver unique index. Every insert is recorded.
const inserts: Row[] = []
function match(row: Row, key: string, expr: string): boolean {
  if (expr.startsWith('eq.')) return String(row[key]) === expr.slice(3)
  if (expr.startsWith('in.(')) return expr.slice(4, -1).split(',').map(s => s.replace(/"/g, '')).includes(String(row[key]))
  if (expr.startsWith('ilike.')) return String(row[key] ?? '').toLowerCase() === expr.slice(6).replace(/\\(.)/g, '$1').toLowerCase()
  return true
}
let idSeq = 0
const pg = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  const table = url.pathname.replace('/rest/v1/', '')
  const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
  res.setHeader('content-type', 'application/json')
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.method === 'POST' && table === 'fleet_drivers') {
      const input = JSON.parse(body)
      const row = Array.isArray(input) ? input[0] : input
      const clash = db.fleet_drivers.some(r => r.driver_id === row.driver_id && (r.status === 'pending' || r.status === 'active'))
      if (clash) {
        res.statusCode = 409
        return res.end(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "fleet_drivers_one_live_per_driver"' }))
      }
      const created = { id: `fd-new-${++idSeq}`, monthly_salary_inr: null, invited_at: new Date().toISOString(), responded_at: null, left_at: null, ...row }
      db.fleet_drivers.push(created)
      inserts.push(created)
      res.statusCode = 201
      return res.end(JSON.stringify(single ? created : [created]))
    }
    let rows = [...(db[table] ?? [])]
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue
      rows = rows.filter(r => match(r, k, v))
    }
    if (single && rows.length === 0) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '0 rows' })) }
    res.end(JSON.stringify(single ? rows[0] : rows))
  })
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
  process.env.JWT_SECRET = 'test-secret-not-real'
  delete process.env.BOOKING_SERVICE_URL // notifications stay off in tests

  const { driverRoutes } = await import('../src/routes/drivers.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { FleetError } = await import('../src/lib/types.js')
  const { planRows, BULK_INVITE_LIMIT } = await import('../src/lib/bulk-invite.js')

  const app = Fastify({ logger: false })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof FleetError) return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
    return reply.status(500).send({ success: false, error: String(err) })
  })
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(driverRoutes, { prefix: '/fleet/drivers' })
  })
  const token = (userId: string) => jwt.sign({ userId, role: 'fleet_owner' }, process.env.JWT_SECRET!)
  const bulk = (userId: string | null, drivers: unknown) => app.inject({
    method: 'POST',
    url: '/fleet/drivers/invite/bulk',
    headers: userId ? { authorization: `Bearer ${token(userId)}` } : {},
    payload: { drivers },
  })
  const byRow = (r: any) => new Map<number, any>(r.json().data.results.map((x: any) => [x.row, x]))

  console.log('\n── valid batch ──')
  reset(); inserts.length = 0
  let r = await bulk(U_OWNER, [
    { name: 'Ravi', driver_phone: '+91 90000 00001' },
    { name: 'Vijay', driver_phone: '09000000005' },
    { name: 'Kiran', driver_email: 'KIRAN_RAO@example.com' },
  ])
  check('200 with a per-row result for every row', r.statusCode === 200 && r.json().data.total === 3, `(got ${r.statusCode} ${r.body})`)
  check('all three invited', r.json().data.counts.invited === 3, JSON.stringify(r.json().data?.counts))
  check('three pending rows inserted for THIS fleet', inserts.length === 3 && inserts.every(i => i.fleet_owner_id === F1 && i.status === 'pending' && i.invited_by === U_OWNER), JSON.stringify(inserts))
  let rows = byRow(r)
  check('each invited row carries its invite id and the matched account', rows.get(1)?.invite_id && rows.get(1)?.driver?.full_name === 'Ravi Kumar', JSON.stringify(rows.get(1)))
  check('email lookup is case-insensitive and _ is literal', rows.get(3)?.status === 'invited' && rows.get(3)?.driver?.driver_id === 'd-6', JSON.stringify(rows.get(3)))
  check('no users or drivers rows were created', db.users.length === users.length && db.drivers.length === drivers.length)

  console.log('\n── mixed batch: one bad row never fails the rest ──')
  reset(); inserts.length = 0
  r = await bulk(U_OWNER, [
    { name: 'Ravi', driver_phone: '9000000001' },          // 1 invited
    { name: 'Suresh', driver_phone: '9000000002' },        // 2 already active here
    { name: 'Amit', driver_phone: '9000000003' },          // 3 already invited here
    { name: 'Mohan', driver_phone: '9000000004' },         // 4 live in ANOTHER fleet
    { name: 'Nobody', driver_phone: '9111111111' },        // 5 no account
    { name: 'Shipper', driver_phone: '9000000009' },       // 6 account but not a driver
    { name: 'Bad', driver_phone: '12345' },                // 7 bad mobile
    { name: '', driver_phone: '9000000005' },              // 8 missing name
    { name: 'No contact' },                                // 9 neither channel
    { name: 'Bad email', driver_email: 'not-an-email' },   // 10 bad email
    'not even an object',                                  // 11 garbage
    { name: 'Vijay', driver_phone: '9000000005' },         // 12 invited
  ])
  rows = byRow(r)
  check('200 even with bad rows', r.statusCode === 200, `(got ${r.statusCode})`)
  check('row 1 invited', rows.get(1)?.status === 'invited')
  check('row 2 already_in_fleet', rows.get(2)?.status === 'already_in_fleet', JSON.stringify(rows.get(2)))
  check('row 3 already_invited', rows.get(3)?.status === 'already_invited', JSON.stringify(rows.get(3)))
  check('row 4 unavailable, with NO identity of the other fleet\'s driver', rows.get(4)?.status === 'unavailable' && rows.get(4)?.driver === null && !/Fleet Two/.test(r.body), JSON.stringify(rows.get(4)))
  check('row 5 no_account (driver must sign up first)', rows.get(5)?.status === 'no_account' && /sign up/.test(rows.get(5)?.reason), JSON.stringify(rows.get(5)))
  check('row 6 no_account (not onboarded as a driver)', rows.get(6)?.status === 'no_account', JSON.stringify(rows.get(6)))
  check('row 7 invalid mobile', rows.get(7)?.status === 'invalid' && /mobile/i.test(rows.get(7)?.reason), JSON.stringify(rows.get(7)))
  check('row 8 invalid: name missing', rows.get(8)?.status === 'invalid' && /Name/.test(rows.get(8)?.reason), JSON.stringify(rows.get(8)))
  check('row 9 invalid: no channel', rows.get(9)?.status === 'invalid' && /mobile number or an email/.test(rows.get(9)?.reason), JSON.stringify(rows.get(9)))
  check('row 10 invalid email', rows.get(10)?.status === 'invalid' && /email/.test(rows.get(10)?.reason), JSON.stringify(rows.get(10)))
  check('row 11 invalid (not an object)', rows.get(11)?.status === 'invalid', JSON.stringify(rows.get(11)))
  check('row 12 invited despite the bad rows before it', rows.get(12)?.status === 'invited', JSON.stringify(rows.get(12)))
  check('exactly the two good rows were inserted', inserts.length === 2, `(got ${inserts.length})`)
  const counts = r.json().data.counts
  check('counts add up', counts.invited === 2 && counts.already_in_fleet === 1 && counts.already_invited === 1 && counts.unavailable === 1 && counts.no_account === 2 && counts.invalid === 5, JSON.stringify(counts))
  check('results come back in file order', JSON.stringify(r.json().data.results.map((x: any) => x.row)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))

  console.log('\n── duplicate mobiles ──')
  reset(); inserts.length = 0
  r = await bulk(U_OWNER, [
    { name: 'Ravi', driver_phone: '9000000001' },
    { name: 'Ravi again', driver_phone: '+919000000001' },  // same number, different spelling
    { name: 'Ravi by email', driver_email: 'ravi@example.com' }, // same DRIVER via the other channel
    { name: 'Vijay', driver_phone: '9000000005' },
    { name: 'Vijay', driver_phone: '0 90000 00005' },
  ])
  rows = byRow(r)
  check('first occurrence invited', rows.get(1)?.status === 'invited')
  check('same mobile in another spelling is a duplicate of row 1', rows.get(2)?.status === 'duplicate' && /row 1/.test(rows.get(2)?.reason), JSON.stringify(rows.get(2)))
  check('same driver by email is a duplicate, not a misleading "unavailable"', rows.get(3)?.status === 'duplicate' && /row 1/.test(rows.get(3)?.reason), JSON.stringify(rows.get(3)))
  check('row 5 duplicate of row 4', rows.get(5)?.status === 'duplicate' && /row 4/.test(rows.get(5)?.reason), JSON.stringify(rows.get(5)))
  check('one invitation per driver', inserts.length === 2, `(got ${inserts.length})`)

  console.log('\n── over the cap ──')
  reset(); inserts.length = 0
  const many = Array.from({ length: BULK_INVITE_LIMIT + 1 }, (_, i) => ({ name: `D${i}`, driver_phone: `9${String(i).padStart(9, '0')}` }))
  r = await bulk(U_OWNER, many)
  check(`${BULK_INVITE_LIMIT + 1} rows refused 400 VALIDATION_ERROR`, r.statusCode === 400 && r.json().code === 'VALIDATION_ERROR' && /200/.test(r.json().error), `(got ${r.statusCode} ${r.body})`)
  check('nothing inserted when refused', inserts.length === 0)
  r = await bulk(U_OWNER, [])
  check('an empty list is refused 400', r.statusCode === 400, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/fleet/drivers/invite/bulk', headers: { authorization: `Bearer ${token(U_OWNER)}` }, payload: {} })
  check('a body without drivers is refused 400', r.statusCode === 400, `(got ${r.statusCode})`)
  check(`exactly ${BULK_INVITE_LIMIT} rows is allowed (validation only)`, planRows(many.slice(0, BULK_INVITE_LIMIT)).planned.length === BULK_INVITE_LIMIT)

  console.log('\n── who may call it ──')
  reset(); inserts.length = 0
  const one = [{ name: 'Ravi', driver_phone: '9000000001' }]
  r = await bulk(null, one)
  check('no token -> 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await bulk(U_NOBODY, one)
  check('a user with no fleet -> 404', r.statusCode === 404 && r.json().code === 'NOT_FOUND', `(got ${r.statusCode})`)
  r = await bulk(U_CLERK, one)
  check('a delegate without manage_drivers -> 403', r.statusCode === 403 && r.json().code === 'FORBIDDEN', `(got ${r.statusCode})`)
  check('…and nothing was inserted', inserts.length === 0)
  r = await bulk(U_HR, one)
  check('a manage_drivers delegate may, into the fleet they serve', r.statusCode === 200 && inserts.length === 1 && inserts[0].fleet_owner_id === F1 && inserts[0].invited_by === U_HR, `(got ${r.statusCode} ${JSON.stringify(inserts)})`)
  reset(); inserts.length = 0
  r = await bulk(U_OTHER_OWNER, [{ name: 'Suresh', driver_phone: '9000000002' }])
  check('another owner inviting fleet 1\'s driver gets "unavailable", never "already in fleet"', byRow(r).get(1)?.status === 'unavailable' && byRow(r).get(1)?.driver === null, r.body)

  console.log('\n── single invite still works through the shared helpers ──')
  reset(); inserts.length = 0
  r = await app.inject({ method: 'POST', url: '/fleet/drivers/invite', headers: { authorization: `Bearer ${token(U_OWNER)}` }, payload: { driver_phone: '+919000000001' } })
  check('single invite 201 with the driver identity', r.statusCode === 201 && r.json().data?.driver?.driver_id === 'd-1' && inserts.length === 1, `(got ${r.statusCode} ${r.body})`)
  r = await app.inject({ method: 'POST', url: '/fleet/drivers/invite', headers: { authorization: `Bearer ${token(U_OWNER)}` }, payload: { driver_phone: '9111111111' } })
  check('single invite of an unknown number is still a 404', r.statusCode === 404, `(got ${r.statusCode})`)

  await app.close()
  pg.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
