/**
 * Driver invite LINKS — an owner shares one link; a driver who opens it and accepts joins as ACTIVE.
 *
 * Pins: the token is HMAC-signed (tamper / wrong key / garbage refused, constant-time compare),
 * expiry is enforced server-side, "Make a new link" and "turn off" revoke every older link via the
 * per-fleet Redis record (stubbed in memory here), a Redis outage fails CLOSED, the public preview
 * leaks no owner contact details, and accept keeps the one-live-fleet rule: happy path (born
 * active, owner notified-shaped, idempotent re-open), already active elsewhere, pending invite
 * elsewhere, suspended here, pending here (accepted in place), non-driver, own fleet, and only
 * owners / manage_drivers delegates may make links.
 *
 * Runs the REAL routes and auth plugin against a stand-in PostgREST server, like bulk-invite.test.
 * Run: npx tsx test/invite-link.test.mts
 */
import http from 'node:http'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>
const F1 = '11111111-1111-4111-8111-111111111111'
const F2 = '22222222-2222-4222-8222-222222222222'
const F3 = '33333333-3333-4333-8333-333333333333' // deactivated fleet
const U_OWNER = 'u-owner', U_OWNER2 = 'u-owner2', U_OWNER3 = 'u-owner3', U_CLERK = 'u-clerk', U_HR = 'u-hr'
const U_SHIPPER = 'u-shipper'

let db: Record<string, Row[]>
function reset() {
  db = {
    fleet_owners: [
      { id: F1, user_id: U_OWNER, company_name: 'Fleet One', city: 'Pune', state: 'MH', contact_phone: '9999999991', gstin: '27AAAAA0000A1Z5', is_active: true },
      { id: F2, user_id: U_OWNER2, company_name: 'Fleet Two', city: 'Nagpur', state: 'MH', contact_phone: '9999999992', is_active: true },
      { id: F3, user_id: U_OWNER3, company_name: 'Closed Fleet', city: null, state: null, is_active: false },
    ],
    fleet_members: [
      { fleet_owner_id: F1, user_id: U_CLERK, grants: ['dispatch'], status: 'active' },
      { fleet_owner_id: F1, user_id: U_HR, grants: ['manage_drivers'], status: 'active' },
    ],
    // d-1 free · d-2 active in F2 · d-3 pending from F2 · d-4 suspended in F1 · d-5 pending from F1
    // d-6 suspended in F2 (not live — may join F1) · d-own is fleet one's owner, also a driver
    drivers: ['1', '2', '3', '4', '5', '6'].map(n => ({ id: `d-${n}`, user_id: `u-d${n}` }))
      .concat([{ id: 'd-own', user_id: U_OWNER }]),
    fleet_drivers: [
      { id: 'fd-2', fleet_owner_id: F2, driver_id: 'd-2', status: 'active', invited_at: '2026-10-01T00:00:00Z' },
      { id: 'fd-3', fleet_owner_id: F2, driver_id: 'd-3', status: 'pending', invited_at: '2026-10-02T00:00:00Z' },
      { id: 'fd-4', fleet_owner_id: F1, driver_id: 'd-4', status: 'suspended', invited_at: '2026-10-03T00:00:00Z' },
      { id: 'fd-5', fleet_owner_id: F1, driver_id: 'd-5', status: 'pending', invited_at: '2026-10-04T00:00:00Z' },
      { id: 'fd-6', fleet_owner_id: F2, driver_id: 'd-6', status: 'suspended', invited_at: '2026-10-05T00:00:00Z' },
    ],
  }
}
reset()

const inserts: Row[] = []
const patches: Row[] = []
function match(row: Row, key: string, expr: string): boolean {
  if (expr.startsWith('eq.')) return String(row[key]) === expr.slice(3)
  if (expr.startsWith('in.(')) return expr.slice(4, -1).split(',').map(s => s.replace(/"/g, '')).includes(String(row[key]))
  return true
}
const live = (s: string) => s === 'pending' || s === 'active'
let idSeq = 0
const pg = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  const table = url.pathname.replace('/rest/v1/', '')
  const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
  res.setHeader('content-type', 'application/json')
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'limit', 'offset'].includes(k))
    const uniqueClash = (row: Row) => live(row.status) && db.fleet_drivers.some(r => r.id !== row.id && r.driver_id === row.driver_id && live(r.status))
    if (req.method === 'POST' && table === 'fleet_drivers') {
      const input = JSON.parse(body)
      const row = { id: `fd-new-${++idSeq}`, monthly_salary_inr: null, invited_at: new Date().toISOString(), responded_at: null, left_at: null, ...(Array.isArray(input) ? input[0] : input) }
      if (uniqueClash(row)) { res.statusCode = 409; return res.end(JSON.stringify({ code: '23505', message: 'fleet_drivers_one_live_per_driver' })) }
      db.fleet_drivers.push(row); inserts.push(row)
      res.statusCode = 201
      return res.end(JSON.stringify(single ? row : [row]))
    }
    if (req.method === 'PATCH' && table === 'fleet_drivers') {
      const patch = JSON.parse(body)
      const target = db.fleet_drivers.find(r => filters.every(([k, v]) => match(r, k, v)))
      if (!target) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })) }
      if (uniqueClash({ ...target, ...patch })) { res.statusCode = 409; return res.end(JSON.stringify({ code: '23505', message: 'fleet_drivers_one_live_per_driver' })) }
      Object.assign(target, patch); patches.push({ id: target.id, ...patch })
      return res.end(JSON.stringify(single ? target : [target]))
    }
    let rows = [...(db[table] ?? [])]
    for (const [k, v] of filters) rows = rows.filter(r => match(r, k, v))
    if (single && rows.length === 0) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '0 rows' })) }
    res.end(JSON.stringify(single ? rows[0] : rows))
  })
})

// The per-fleet "current link" record, in memory instead of Redis. `down` simulates an outage.
const mem = new Map<string, { rec: any; until: number }>()
let down = false
const memStore = {
  async get(id: string) { if (down) throw new Error('ECONNREFUSED'); const v = mem.get(id); return v && v.until > Date.now() ? v.rec : null },
  async set(id: string, rec: any, ttl: number) { if (down) throw new Error('ECONNREFUSED'); mem.set(id, { rec, until: Date.now() + ttl }) },
  async del(id: string) { if (down) throw new Error('ECONNREFUSED'); mem.delete(id) },
}

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
  delete process.env.BOOKING_SERVICE_URL
  delete process.env.REDIS_URL // fleet-set sync is best-effort and must not fail a join

  const { driverRoutes } = await import('../src/routes/drivers.js')
  const { joinRoutes } = await import('../src/routes/join.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { FleetError } = await import('../src/lib/types.js')
  const L = await import('../src/lib/invite-link.js')
  L.setInviteLinkStoreForTests(memStore)

  console.log('\n── sign / verify (pure) ──')
  const now = Date.now()
  const payload = { v: 1 as const, f: F1, n: 'abcdefghijklmnopqrstuv', e: Math.floor(now / 1000) + 3600 }
  const tok = L.signInviteLink(payload)
  const ok = L.verifyInviteLink(tok, now)
  check('a freshly signed token verifies and round-trips its payload', ok.ok && JSON.stringify((ok as any).payload) === JSON.stringify(payload), JSON.stringify(ok))
  check('signing is deterministic (the owner can be shown the same link again)', L.signInviteLink(payload) === tok)
  check('token is URL-safe (base64url.base64url)', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok) && tok.length < 300, tok)
  const [b, s] = tok.split('.')
  const forged = Buffer.from(JSON.stringify({ ...payload, f: F2 })).toString('base64url')
  check('tamper: another fleet id with the old signature -> bad_signature', (L.verifyInviteLink(`${forged}.${s}`, now) as any).reason === 'bad_signature')
  const longer = Buffer.from(JSON.stringify({ ...payload, e: payload.e + 86400 * 365 })).toString('base64url')
  check('tamper: a pushed-out expiry -> bad_signature', (L.verifyInviteLink(`${longer}.${s}`, now) as any).reason === 'bad_signature')
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1)
  check('tamper: one changed signature character -> bad_signature', (L.verifyInviteLink(`${b}.${flipped}`, now) as any).reason === 'bad_signature')
  check('a truncated signature -> bad_signature (length checked before the constant-time compare)', (L.verifyInviteLink(`${b}.${s.slice(0, 10)}`, now) as any).reason === 'bad_signature')
  process.env.JWT_SECRET = 'a-different-secret'
  check('a token signed under another key is refused', (L.verifyInviteLink(tok, now) as any).reason === 'bad_signature')
  process.env.JWT_SECRET = 'test-secret-not-real'
  const asJwt = jwt.sign({ userId: U_OWNER, role: 'fleet_owner' }, process.env.JWT_SECRET!)
  check('a login JWT (3 parts, signed with JWT_SECRET itself) is not an invite token', !L.verifyInviteLink(asJwt, now).ok)
  check('garbage / empty / non-string / oversized -> malformed', ['', 'nope', 'a.b.c', 42, null, 'x'.repeat(600) + '.y'].every(t => (L.verifyInviteLink(t, now) as any).reason === 'malformed'))
  const badShape = L.signInviteLink({ ...payload, f: 'not-a-uuid' } as any)
  check('a validly signed but wrong-shaped payload -> malformed', (L.verifyInviteLink(badShape, now) as any).reason === 'malformed')
  check('expiry: one second after e -> expired', (L.verifyInviteLink(tok, payload.e * 1000 + 1000) as any).reason === 'expired')
  check('expiry: exactly at e -> expired', (L.verifyInviteLink(tok, payload.e * 1000) as any).reason === 'expired')

  console.log('\n── store: create / rotate / revoke ──')
  mem.clear()
  const first = await L.createInviteLink(F1, U_OWNER, now)
  const days = (Date.parse(first.expires_at) - now) / 86400000
  check('a new link lasts 7 days', days > 6.99 && days <= 7, String(days))
  check('the current link is shown again unchanged', (await L.getCurrentInviteLink(F1, now))?.token === first.token)
  check('it resolves to fleet one', (await L.resolveInviteLink(first.token, now)).fleetOwnerId === F1)
  const second = await L.createInviteLink(F1, U_OWNER, now)
  check('"Make a new link" gives a different token', second.token !== first.token)
  let code = await L.resolveInviteLink(first.token, now).then(() => 'resolved', (e: any) => e.code)
  check('…and the old link is now LINK_REPLACED (410)', code === 'LINK_REPLACED', code)
  check('…while the new one works', (await L.resolveInviteLink(second.token, now)).fleetOwnerId === F1)
  await L.revokeInviteLink(F1)
  code = await L.resolveInviteLink(second.token, now).then(() => 'resolved', (e: any) => e.code)
  check('turning links off revokes the current one too', code === 'LINK_REPLACED', code)
  check('…and there is no current link', (await L.getCurrentInviteLink(F1, now)) === null)
  const unsaved = L.signInviteLink({ v: 1, f: F2, n: 'zzzzzzzzzzzzzzzzzzzzzz', e: Math.floor(now / 1000) + 3600 })
  code = await L.resolveInviteLink(unsaved, now).then(() => 'resolved', (e: any) => e.code)
  check('a validly signed token the store never issued (e.g. Redis was flushed) is refused', code === 'LINK_REPLACED', code)
  const live1 = await L.createInviteLink(F1, U_OWNER, now)
  code = await L.resolveInviteLink(live1.token, now + 8 * 86400000).then(() => 'resolved', (e: any) => e.code)
  check('the current link is LINK_EXPIRED (410) after 7 days, even if Redis still held it', code === 'LINK_EXPIRED', code)
  down = true
  code = await L.resolveInviteLink(live1.token, now).then(() => 'resolved', (e: any) => e.code)
  check('Redis down -> fails CLOSED with SERVICE_UNAVAILABLE', code === 'SERVICE_UNAVAILABLE', code)
  down = false

  // ── HTTP ──
  const app = Fastify({ logger: false })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof FleetError) return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
    return reply.status(500).send({ success: false, error: String(err) })
  })
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(driverRoutes, { prefix: '/fleet/drivers' })
  })
  await app.register(joinRoutes, { prefix: '/fleet/join' })
  const bearer = (userId: string) => ({ authorization: `Bearer ${jwt.sign({ userId, role: 'driver' }, process.env.JWT_SECRET!)}` })
  const linkCall = (method: 'GET' | 'POST' | 'DELETE', userId: string | null) =>
    app.inject({ method, url: '/fleet/drivers/invite-link', headers: userId ? bearer(userId) : {} })
  const preview = (token: unknown) => app.inject({ method: 'POST', url: '/fleet/join/preview', payload: { token } })
  const accept = (userId: string | null, token: unknown) =>
    app.inject({ method: 'POST', url: '/fleet/join/accept', headers: userId ? bearer(userId) : {}, payload: { token } })

  console.log('\n── owner: who may make a link ──')
  reset(); mem.clear()
  let r = await linkCall('GET', U_OWNER)
  check('GET with no link yet -> link null, ttl 7', r.statusCode === 200 && r.json().data.link === null && r.json().data.ttl_days === 7, r.body)
  r = await linkCall('POST', U_OWNER)
  check('owner POST -> 201 with token + expiry', r.statusCode === 201 && typeof r.json().data.link.token === 'string' && r.json().data.link.expires_at, r.body)
  const ownerToken: string = r.json().data.link.token
  check('…and does not expose who made it', !('created_by' in r.json().data.link), r.body)
  r = await linkCall('GET', U_OWNER)
  check('GET shows the same link', r.json().data.link?.token === ownerToken)
  r = await linkCall('POST', null)
  check('no sign-in -> 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await linkCall('POST', U_CLERK)
  check('a delegate without manage_drivers -> 403', r.statusCode === 403, `(got ${r.statusCode})`)
  r = await linkCall('POST', 'u-d1')
  check('a driver with no fleet -> 404', r.statusCode === 404, `(got ${r.statusCode})`)
  r = await linkCall('POST', U_HR)
  check('a manage_drivers delegate may (it rotates the fleet\'s link)', r.statusCode === 201 && r.json().data.link.token !== ownerToken, r.body)
  const hrToken: string = r.json().data.link.token
  r = await preview(ownerToken)
  check('the owner\'s earlier link is now replaced', r.statusCode === 410 && r.json().code === 'LINK_REPLACED', r.body)

  console.log('\n── public preview ──')
  r = await preview(hrToken)
  const data = r.json().data
  check('preview needs no sign-in and names the fleet', r.statusCode === 200 && data.fleet.company_name === 'Fleet One' && data.fleet.city === 'Pune', r.body)
  check('preview carries only name, city, state + expiry', JSON.stringify(Object.keys(data.fleet).sort()) === JSON.stringify(['city', 'company_name', 'state']) && !!data.expires_at, r.body)
  check('preview leaks no phone, GSTIN, fleet id or owner id', !/9999999991|27AAAAA|u-owner|1111-4111/.test(r.body), r.body)
  r = await preview('garbage')
  check('garbage token -> 400 LINK_INVALID', r.statusCode === 400 && r.json().code === 'LINK_INVALID', r.body)
  r = await app.inject({ method: 'POST', url: '/fleet/join/preview', payload: {} })
  check('no token -> 400', r.statusCode === 400, r.body)
  r = await preview('x'.repeat(2000))
  check('an oversized token -> 400', r.statusCode === 400, r.body)
  const expired = L.signInviteLink({ v: 1, f: F1, n: 'expiredexpiredexpired1', e: Math.floor(Date.now() / 1000) - 10 })
  r = await preview(expired)
  check('an expired token -> 410 LINK_EXPIRED', r.statusCode === 410 && r.json().code === 'LINK_EXPIRED', r.body)
  const closed = (await L.createInviteLink(F3, U_OWNER3)).token
  r = await preview(closed)
  check('a deactivated fleet\'s link -> LINK_INVALID, no name', r.statusCode === 400 && r.json().code === 'LINK_INVALID' && !/Closed Fleet/.test(r.body), r.body)

  console.log('\n── accept ──')
  reset(); mem.clear(); inserts.length = 0; patches.length = 0
  const t1: string = (await linkCall('POST', U_HR)).json().data.link.token
  r = await accept(null, t1)
  check('accept without sign-in -> 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await accept('u-d1', t1)
  check('happy path: 201 joined, fleet named', r.statusCode === 201 && r.json().data.joined === true && r.json().data.fleet.company_name === 'Fleet One', r.body)
  check('…one row inserted for THIS fleet, born ACTIVE, responded_at set, invited_by = link maker', inserts.length === 1 && inserts[0].fleet_owner_id === F1 && inserts[0].driver_id === 'd-1' && inserts[0].status === 'active' && !!inserts[0].responded_at && inserts[0].invited_by === U_HR, JSON.stringify(inserts))
  r = await accept('u-d1', t1)
  check('opening the link again is harmless: 200 already_member, nothing new inserted', r.statusCode === 200 && r.json().data.already_member === true && inserts.length === 1, r.body)
  r = await accept('u-d2', t1)
  check('driver already ACTIVE in another fleet -> 409 ALREADY_IN_ANOTHER_FLEET', r.statusCode === 409 && r.json().code === 'ALREADY_IN_ANOTHER_FLEET', r.body)
  check('…without naming that other fleet', !/Fleet Two/.test(r.body), r.body)
  r = await accept('u-d3', t1)
  check('driver with a PENDING invite from another fleet -> 409 PENDING_INVITE_ELSEWHERE (never auto-declined)', r.statusCode === 409 && r.json().code === 'PENDING_INVITE_ELSEWHERE' && db.fleet_drivers.find(x => x.id === 'fd-3')?.status === 'pending', r.body)
  r = await accept('u-d4', t1)
  check('driver SUSPENDED by this fleet cannot reinstate themself -> 409 SUSPENDED_IN_FLEET', r.statusCode === 409 && r.json().code === 'SUSPENDED_IN_FLEET' && db.fleet_drivers.find(x => x.id === 'fd-4')?.status === 'suspended', r.body)
  r = await accept('u-d5', t1)
  check('driver already INVITED by this fleet: that invitation is accepted in place (no second row)', r.statusCode === 201 && r.json().data.affiliation.id === 'fd-5' && db.fleet_drivers.find(x => x.id === 'fd-5')?.status === 'active' && inserts.length === 1, r.body)
  r = await accept('u-d6', t1)
  check('suspended in ANOTHER fleet is not live there -> may join', r.statusCode === 201 && r.json().data.joined === true, r.body)
  r = await accept(U_SHIPPER, t1)
  check('a signed-in non-driver -> 403 DRIVER_PROFILE_REQUIRED', r.statusCode === 403 && r.json().code === 'DRIVER_PROFILE_REQUIRED', r.body)
  r = await accept(U_OWNER, t1)
  check('the fleet\'s own owner (who also drives) -> 409 OWN_FLEET', r.statusCode === 409 && r.json().code === 'OWN_FLEET', r.body)
  r = await accept(U_OWNER2, t1)
  check('another fleet\'s owner with no driver profile -> DRIVER_PROFILE_REQUIRED', r.json().code === 'DRIVER_PROFILE_REQUIRED', r.body)

  console.log('\n── accept: revoked / expired / tampered ──')
  const before = inserts.length
  r = await linkCall('POST', U_OWNER) // owner makes a new link: t1 must stop working
  const t2: string = r.json().data.link.token
  db.drivers.push({ id: 'd-7', user_id: 'u-d7' })
  r = await accept('u-d7', t1)
  check('after "Make a new link", the old link cannot be used to join -> 410 LINK_REPLACED', r.statusCode === 410 && r.json().code === 'LINK_REPLACED' && inserts.length === before, r.body)
  await linkCall('DELETE', U_OWNER)
  r = await accept('u-d7', t2)
  check('after turning the link off -> 410 LINK_REPLACED', r.statusCode === 410 && r.json().code === 'LINK_REPLACED', r.body)
  r = await accept('u-d7', expired)
  check('an expired link cannot be accepted -> 410 LINK_EXPIRED', r.statusCode === 410 && r.json().code === 'LINK_EXPIRED', r.body)
  const t3: string = (await linkCall('POST', U_OWNER)).json().data.link.token
  const [tb] = t3.split('.')
  const forgedF2 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(tb, 'base64url').toString()), f: F2 })).toString('base64url')
  r = await accept('u-d7', `${forgedF2}.${t3.split('.')[1]}`)
  check('a link edited to point at another fleet -> 400 LINK_INVALID', r.statusCode === 400 && r.json().code === 'LINK_INVALID' && inserts.length === before, r.body)
  down = true
  r = await accept('u-d7', t3)
  check('Redis down at accept -> 503, nothing inserted', r.statusCode === 503 && r.json().code === 'SERVICE_UNAVAILABLE' && inserts.length === before, r.body)
  r = await linkCall('POST', U_OWNER)
  check('Redis down when making a link -> 503', r.statusCode === 503, r.body)
  down = false
  r = await accept('u-d7', t3)
  check('…and once it is back the current link works', r.statusCode === 201 && r.json().data.joined === true, r.body)

  console.log('\n── tokens never reach a URL ──')
  r = await app.inject({ method: 'GET', url: `/fleet/join/${t3}` })
  check('there is no GET-by-token route (token only ever in a body)', r.statusCode === 404, `(got ${r.statusCode})`)

  await app.close()
  pg.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
