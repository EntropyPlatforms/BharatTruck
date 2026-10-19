/**
 * Identity-lifecycle endpoints (D-32/D-33/D-31): profile creation, the completeness ring, and
 * versioned acknowledgements. Registers the REAL identityRoutes and the SHIPPED persona resolver
 * against an in-memory Supabase, so the assertions run over the actual route + rule logic.
 * Run: npx tsx test/identity-lifecycle.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { ACKNOWLEDGEMENTS } from '../src/lib/acknowledgements.js'

type Row = Record<string, any>
let db: Record<string, Row[]> = {}

// ── Fake Supabase covering the shapes resolvePersonas + identityRoutes build:
//    eq / in / select(cols,{count,head}) / insert / update / maybeSingle / single / await.
class FakeQuery {
  private eqs: Array<[string, any]> = []
  private ins: Array<[string, any[]]> = []
  private counting = false
  private mode: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  constructor(private table: string) {}
  select(_cols = '*', opts?: { count?: string; head?: boolean }) { this.counting = !!opts?.count; return this }
  insert(p: Row) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  in(c: string, vs: any[]) { this.ins.push([c, vs]); return this }
  order() { return this }
  private match(r: Row) {
    return this.eqs.every(([c, v]) => r[c] === v) && this.ins.every(([c, vs]) => vs.includes(r[c]))
  }
  private run() {
    const rows = db[this.table] ?? (db[this.table] = [])
    if (this.mode === 'insert') {
      // A real UNIQUE(user_id) would reject a second insert for the same user; model that so the
      // idempotency path (23505 -> re-read) is actually exercised for drivers/fleet_owners.
      if ((this.table === 'drivers' || this.table === 'fleet_owners') &&
          rows.some(r => r.user_id === (this.payload as Row).user_id)) {
        return { data: null, count: 0, error: { code: '23505', message: 'duplicate key' } }
      }
      const row = { id: `${this.table}-${rows.length + 1}`, ...this.payload }
      rows.push(row)
      return { data: [row], count: 1, error: null }
    }
    if (this.mode === 'update') {
      const hit = rows.filter(r => this.match(r))
      hit.forEach(r => Object.assign(r, this.payload))
      return { data: hit, count: hit.length, error: null }
    }
    const found = rows.filter(r => this.match(r))
    return this.counting ? { data: null, count: found.length, error: null } : { data: found, count: found.length, error: null }
  }
  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data && data.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

// resolvePersonas needs these tables present even when empty, or the lookups throw.
function baseDb(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return { users: [], drivers: [], fleet_owners: [], vehicles: [], fleet_drivers: [], driver_licenses: [], kyc_documents: [], bank_accounts: [], persona_acknowledgements: [], ...extra }
}

async function main() {
  const { identityRoutes } = await import('../src/routes/identity.js')
  const app = Fastify({ logger: false })
  app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
  await app.register(identityRoutes)

  const tokenFor = (userId: string) => jwt.sign({ userId, role: 'shipper' }, process.env.JWT_SECRET!, { expiresIn: 900 })
  const auth = (u: string) => ({ authorization: `Bearer ${tokenFor(u)}` })

  // ── PART 1: POST /drivers/me creates then is idempotent ──
  console.log('\n── POST /drivers/me: create then idempotent ──')
  db = baseDb({ users: [{ id: 'u1', role: 'shipper' }] })
  let r = await app.inject({ method: 'POST', url: '/drivers/me', headers: auth('u1') })
  check('first call creates the drivers row (201)', r.statusCode === 201 && r.json().data.created === true, `(got ${r.statusCode})`)
  check('drivers row belongs to the caller', db.drivers[0]?.user_id === 'u1', JSON.stringify(db.drivers))
  r = await app.inject({ method: 'POST', url: '/drivers/me', headers: auth('u1') })
  check('second call is a no-op (200, created:false)', r.statusCode === 200 && r.json().data.created === false, `(got ${r.statusCode})`)
  check('still exactly one drivers row', db.drivers.length === 1, `(got ${db.drivers.length})`)

  // ── PART 1: POST /fleet-owners/me creates then is idempotent ──
  console.log('\n── POST /fleet-owners/me: create then idempotent ──')
  db = baseDb({ users: [{ id: 'u2', role: 'shipper', full_name: 'Rao Traders' }] })
  r = await app.inject({ method: 'POST', url: '/fleet-owners/me', headers: auth('u2'), payload: { company_name: 'Rao Logistics' } })
  check('first call creates the fleet_owners row (201)', r.statusCode === 201 && r.json().data.created === true, `(got ${r.statusCode})`)
  check('company_name seeded from body', db.fleet_owners[0]?.company_name === 'Rao Logistics', JSON.stringify(db.fleet_owners))
  r = await app.inject({ method: 'POST', url: '/fleet-owners/me', headers: auth('u2'), payload: {} })
  check('second call is a no-op (200, created:false)', r.statusCode === 200 && r.json().data.created === false, `(got ${r.statusCode})`)
  check('idempotent call did NOT overwrite the company name', db.fleet_owners[0]?.company_name === 'Rao Logistics', db.fleet_owners[0]?.company_name)
  check('still exactly one fleet_owners row', db.fleet_owners.length === 1, `(got ${db.fleet_owners.length})`)

  // no company_name supplied → non-empty placeholder from identity, never blank (D-31: not gated)
  db = baseDb({ users: [{ id: 'u3', role: 'shipper', email: 'solo@x.com' }] })
  r = await app.inject({ method: 'POST', url: '/fleet-owners/me', headers: auth('u3'), payload: {} })
  check('fleet profile creatable with NO fields supplied (not gated)', r.statusCode === 201, `(got ${r.statusCode})`)
  check('placeholder company_name is non-empty', !!db.fleet_owners[0]?.company_name, JSON.stringify(db.fleet_owners))

  // ── PART 1: a user cannot create another user's profile ──
  console.log('\n── a user cannot create another user\'s profile ──')
  db = baseDb({ users: [{ id: 'attacker', role: 'shipper' }, { id: 'victim', role: 'shipper' }] })
  // The body tries to smuggle a foreign user_id; the route ignores the body and uses the JWT.
  r = await app.inject({ method: 'POST', url: '/drivers/me', headers: auth('attacker'), payload: { user_id: 'victim' } })
  check('drivers row is created for the TOKEN holder, not the body', db.drivers[0]?.user_id === 'attacker', JSON.stringify(db.drivers))
  check('no drivers row was created for the victim', !db.drivers.some(d => d.user_id === 'victim'), JSON.stringify(db.drivers))
  // fleet-owners body is .strict(), so a foreign user_id is a hard 400, not a silent write.
  r = await app.inject({ method: 'POST', url: '/fleet-owners/me', headers: auth('attacker'), payload: { user_id: 'victim' } })
  check('fleet-owners rejects an unknown body field (strict)', r.statusCode === 400, `(got ${r.statusCode})`)

  // ── PART 2: completeness reports verified/declared/missing and NEVER gates ──
  console.log('\n── GET /me/completeness: verified/declared/missing, never a gate ──')
  // A driver (drivers row) with nothing on file → every driver item + shipper gst is 'missing'.
  db = baseDb({ users: [{ id: 'd1', role: 'driver' }], drivers: [{ id: 'drv1', user_id: 'd1' }] })
  r = await app.inject({ method: 'GET', url: '/me/completeness', headers: auth('d1') })
  check('completeness returns 200 even when everything is missing (no gate)', r.statusCode === 200, `(got ${r.statusCode})`)
  let report = r.json().data.completeness
  check('payload carries the display-only gates_nothing flag', report.gates_nothing === true, JSON.stringify(report))
  let driver = report.personas.find((p: any) => p.persona === 'driver')
  check('a driver surface is reported', !!driver, JSON.stringify(report.personas.map((p: any) => p.persona)))
  check('aadhaar is missing with nothing on file', driver.items.find((i: any) => i.key === 'aadhaar').status === 'missing', JSON.stringify(driver.items))
  check('overall percentage is 0 with nothing satisfied', report.overall_percentage === 0, `(got ${report.overall_percentage})`)

  // Verified: an approved Aadhaar kyc_documents row. Declared: an acknowledgement + a submitted DL.
  db = baseDb({
    users: [{ id: 'd2', role: 'driver' }],
    drivers: [{ id: 'drv2', user_id: 'd2' }],
    kyc_documents: [{ user_id: 'd2', doc_type: 'aadhaar', status: 'approved' }],
    driver_licenses: [{ driver_id: 'drv2', status: 'pending' }],
    persona_acknowledgements: [{ user_id: 'd2', kind: 'pan_will_provide' }, { user_id: 'd2', kind: 'gst_under_threshold' }],
  })
  r = await app.inject({ method: 'GET', url: '/me/completeness', headers: auth('d2') })
  report = r.json().data.completeness
  driver = report.personas.find((p: any) => p.persona === 'driver')
  check('approved KYC doc → aadhaar VERIFIED', driver.items.find((i: any) => i.key === 'aadhaar').status === 'verified', JSON.stringify(driver.items))
  check('acknowledgement → pan DECLARED', driver.items.find((i: any) => i.key === 'pan').status === 'declared', JSON.stringify(driver.items))
  check('submitted (pending) licence → driving_licence DECLARED', driver.items.find((i: any) => i.key === 'driving_licence').status === 'declared', JSON.stringify(driver.items))
  const shipper = report.personas.find((p: any) => p.persona === 'shipper')
  check('gst_under_threshold ack → shipper gst DECLARED', shipper.items.find((i: any) => i.key === 'gst').status === 'declared', JSON.stringify(shipper.items))
  check('still 200 — no status flips into a 4xx anywhere', r.statusCode === 200, `(got ${r.statusCode})`)

  // Fleet owner surface shows when a fleet_owners row exists (even before assets → no 'operate').
  db = baseDb({ users: [{ id: 'f1', role: 'fleet_owner', gstin: '33AABCV3609C1ZJ' }], fleet_owners: [{ id: 'fo1', user_id: 'f1', gstin: '33AABCV3609C1ZJ' }] })
  r = await app.inject({ method: 'GET', url: '/me/completeness', headers: auth('f1') })
  report = r.json().data.completeness
  const fleet = report.personas.find((p: any) => p.persona === 'fleet_owner')
  check('fleet surface reported for a fleet_owners row', !!fleet, JSON.stringify(report.personas.map((p: any) => p.persona)))
  check('typed GSTIN → fleet gst DECLARED', fleet.items.find((i: any) => i.key === 'gst').status === 'declared', JSON.stringify(fleet.items))
  check('no bank → business_bank MISSING (a prompt, not a block)', fleet.items.find((i: any) => i.key === 'business_bank').status === 'missing', JSON.stringify(fleet.items))

  // ── PART 2: an acknowledgement stores the versioned TEXT, not a boolean ──
  console.log('\n── POST /me/acknowledgements stores versioned text ──')
  db = baseDb({ users: [{ id: 'a1', role: 'shipper' }] })
  r = await app.inject({ method: 'POST', url: '/me/acknowledgements', headers: auth('a1'), payload: { kind: 'gst_under_threshold' } })
  check('acknowledgement recorded (201)', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)
  const stored = db.persona_acknowledgements[0]
  check('stored row carries the server-owned version', stored?.version === ACKNOWLEDGEMENTS.gst_under_threshold.version, JSON.stringify(stored))
  check('stored row carries the VERBATIM statement, not a boolean', stored?.statement === ACKNOWLEDGEMENTS.gst_under_threshold.statement, JSON.stringify(stored))
  check('the statement is non-empty text', typeof stored?.statement === 'string' && stored.statement.length > 20, '')
  r = await app.inject({ method: 'POST', url: '/me/acknowledgements', headers: auth('a1'), payload: { kind: 'not_a_real_kind' } })
  check('an unknown kind is refused (400) — no bare flags', r.statusCode === 400, `(got ${r.statusCode})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
