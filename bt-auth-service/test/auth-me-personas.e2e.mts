/**
 * GET /auth/me — computed capabilities.
 *
 * Registers the REAL authRoutes on a bare Fastify instance with an in-memory Redis and Supabase,
 * so the assertions run against the shipped route logic and the shipped resolver
 * (@bharattruck/shared/personas), not a re-implementation of either.
 *
 * What these pin, and why each one is here:
 *   - capabilities are COMPUTED from owned assets, so a driver with a truck gets a load board and
 *     a plain shipper does not — the whole point of the endpoint;
 *   - every field the response carried BEFORE this change is still there, because four deployed
 *     apps read `data.user` today and a dropped field is an outage;
 *   - a token with no `role` claim still authenticates, so dropping the claim later cannot 401
 *     every live session;
 *   - a resolver failure still returns the user with `personas: null` — never an empty capability
 *     list, which a client cannot distinguish from a real answer and would render as a lockout.
 *
 * Run: npx tsx test/auth-me-personas.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'
process.env.EMAIL_DEV_MODE = 'true' // never touch a real SMTP host

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>

// The four tables resolvePersonas reads, plus users. Seeded per case.
let db: Record<string, Row[]> = { users: [], drivers: [], fleet_owners: [], vehicles: [], fleet_drivers: [] }

// Tables told to answer like a database the migration has not reached yet. PostgREST reports an
// unknown relation as 42P01, which is exactly the pre-0022 window this service has to survive.
const brokenTables = new Set<string>()

// ── Fake Supabase: only the query shapes /auth/me and resolvePersonas build —
// eq / in / maybeSingle, and the head+count form used for the ownership tallies.
class FakeQuery {
  private eqs: Array<[string, any]> = []
  private ins: Array<[string, any[]]> = []
  private counting = false
  constructor(private table: string) {}
  select(_cols = '*', opts?: { count?: string; head?: boolean }) { this.counting = !!opts?.count; return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  in(c: string, vs: any[]) { this.ins.push([c, vs]); return this }
  private run() {
    if (brokenTables.has(this.table)) {
      return { data: null, count: null, error: { code: '42P01', message: `relation "public.${this.table}" does not exist` } }
    }
    const rows = (db[this.table] ?? []).filter(r =>
      this.eqs.every(([c, v]) => r[c] === v) && this.ins.every(([c, vs]) => vs.includes(r[c])),
    )
    return this.counting
      ? { data: null, count: rows.length, error: null }
      : { data: rows, count: rows.length, error: null }
  }
  maybeSingle() {
    const { data, error } = this.run()
    return Promise.resolve({ data: data && data.length ? data[0] : null, error })
  }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}

class FakeRedis {
  private store = new Map<string, string>()
  async get(k: string) { return this.store.get(k) ?? null }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK' }
  async del(k: string) { return this.store.delete(k) ? 1 : 0 }
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n }
  async expire(_k: string, _s: number) { return 1 }
  async ttl(_k: string) { return -1 }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { authRoutes } = await import('../src/routes/auth.js')

  const app = Fastify({ logger: false })
  app.decorate('redis', new FakeRedis() as any)
  app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
  await app.register(authRoutes, { prefix: '/auth' })

  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })

  // Tokens are minted exactly as issueTokens does, so these are the real thing.
  const tokenFor = (userId: string, role?: string) =>
    jwt.sign(role ? { userId, role } : { userId }, process.env.JWT_SECRET!, { expiresIn: 900 })

  // The identity gotcha this whole model turns on: drivers.id / fleet_owners.id are SEPARATE rows
  // from users.id, and the snapshot must report the profile ids, never the user id.
  const SHIPPER = { id: 'u-ship', phone_number: '9812345678', email: 'ship@example.com', full_name: 'Shipper Singh', avatar_url: null, role: 'shipper', email_verified: true, google_sub: null, created_at: '2026-01-01T00:00:00Z' }
  const DRIVER  = { id: 'u-drive', phone_number: '9898989898', email: 'drive@example.com', full_name: 'Driver Das', avatar_url: null, role: 'driver', email_verified: true, google_sub: null, created_at: '2026-02-02T00:00:00Z' }

  function seed() {
    db = {
      users: [{ ...SHIPPER }, { ...DRIVER }],
      drivers: [{ id: 'd-1', user_id: 'u-drive' }],
      fleet_owners: [],
      vehicles: [{ id: 'v-1', driver_id: 'd-1', fleet_owner_id: null }],
      fleet_drivers: [],
    }
    brokenTables.clear()
  }

  console.log('\n── a driver who owns a truck ──')
  seed()
  let r = await me(tokenFor('u-drive', 'driver'))
  let p = r.json().data?.personas
  check('200 with a personas snapshot', r.statusCode === 200 && !!p, `(got ${r.statusCode})`)
  check('capabilities are ship+drive+carry', JSON.stringify(p?.capabilities) === JSON.stringify(['ship', 'drive', 'carry']), `(got ${JSON.stringify(p?.capabilities)})`)
  check('one truck alone is not a fleet', !p?.capabilities.includes('operate'), '')
  check('driver_id is drivers.id, NOT users.id', p?.driver_id === 'd-1', `(got ${p?.driver_id})`)
  check('user_id is users.id', p?.user_id === 'u-drive', `(got ${p?.user_id})`)
  check('owning a truck means seeing the money', p?.sees_commercials === true, '')
  check('primary_persona falls back to role pre-0022', p?.primary_persona === 'driver', `(got ${p?.primary_persona})`)
  check('no error flag on a clean resolve', r.json().data.personas_error === null, `(got ${r.json().data.personas_error})`)

  console.log('\n── a second truck emerges the fleet, with nothing configured ──')
  seed()
  db.vehicles.push({ id: 'v-2', driver_id: 'd-1', fleet_owner_id: null })
  r = await me(tokenFor('u-drive', 'driver'))
  check('two trucks grant operate', r.json().data.personas.capabilities.includes('operate'), `(got ${JSON.stringify(r.json().data.personas.capabilities)})`)

  console.log('\n── a plain shipper ──')
  seed()
  r = await me(tokenFor('u-ship', 'shipper'))
  p = r.json().data.personas
  check('capabilities are ship only', JSON.stringify(p.capabilities) === JSON.stringify(['ship']), `(got ${JSON.stringify(p.capabilities)})`)
  check('no drivers row → driver_id null', p.driver_id === null, `(got ${p.driver_id})`)
  check('no fleet → fleet_owner_id null', p.fleet_owner_id === null, `(got ${p.fleet_owner_id})`)
  check('owns nothing → no commercial baseline', p.sees_commercials === false, '')

  console.log('\n── the response is strictly additive ──')
  // Field-by-field against the shape userProfile() has always returned. The four deployed apps
  // read `data.user`; anything missing or renamed here is a live outage, not a test failure.
  const u = r.json().data.user
  const expected: Record<string, unknown> = {
    id: 'u-ship', phone: '9812345678', email: 'ship@example.com', full_name: 'Shipper Singh',
    avatar_url: null, role: 'shipper', gstin: null, primary_persona: 'shipper',
    email_verified: true, google_sub: null, created_at: '2026-01-01T00:00:00Z',
  }
  for (const [k, v] of Object.entries(expected)) {
    check(`user.${k} unchanged`, k in u && u[k] === v, `(got ${JSON.stringify(u[k])})`)
  }
  check('user gained no unexpected fields', Object.keys(u).length === Object.keys(expected).length, `(got ${JSON.stringify(Object.keys(u))})`)

  console.log('\n── a token with no role claim ──')
  seed()
  r = await me(tokenFor('u-drive'))
  check('authenticates on userId alone', r.statusCode === 200, `(got ${r.statusCode})`)
  check('capabilities still computed from assets, not from the token', r.json().data.personas.capabilities.includes('carry'), '')
  check('primary_persona still read from the DB row', r.json().data.personas.primary_persona === 'driver', `(got ${r.json().data.personas.primary_persona})`)

  console.log('\n── a token with no userId is still refused ──')
  const noSubject = jwt.sign({ role: 'driver' }, process.env.JWT_SECRET!, { expiresIn: 900 })
  r = await me(noSubject)
  check('missing userId is 401', r.statusCode === 401, `(got ${r.statusCode})`)

  console.log('\n── resolution failure (pre-migration database) ──')
  seed()
  brokenTables.add('vehicles')
  r = await me(tokenFor('u-drive', 'driver'))
  check('profile still returned, not a 500', r.statusCode === 200, `(got ${r.statusCode})`)
  check('the user is intact', r.json().data.user.id === 'u-drive', '')
  check('personas is null, never an empty capability list', r.json().data.personas === null, `(got ${JSON.stringify(r.json().data.personas)})`)
  check('the failure is named explicitly', r.json().data.personas_error === 'PERSONA_RESOLUTION_FAILED', `(got ${r.json().data.personas_error})`)

  console.log('\n── a missing drivers table degrades the same way ──')
  seed()
  brokenTables.add('drivers')
  r = await me(tokenFor('u-drive', 'driver'))
  check('still 200 with the user', r.statusCode === 200 && r.json().data.user.id === 'u-drive', `(got ${r.statusCode})`)
  check('signalled, not silently empty', r.json().data.personas === null && r.json().data.personas_error === 'PERSONA_RESOLUTION_FAILED', '')

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
