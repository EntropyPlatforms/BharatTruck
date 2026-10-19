/**
 * Driver onboarding authorizes on the 'drive' CAPABILITY, not the JWT `role` string.
 *
 * The refactor (D-27): the gate on every onboarding route used to be `role === 'driver'`.
 * That wrongly refused the multi-persona case the unified-identity model exists for — a
 * distributor whose account role is 'shipper' but who drives their own truck. Such a human
 * HAS a `drivers` row, so they have the 'drive' capability and must be able to finish driver
 * onboarding (insurance/bank). The new gate is capability-based, computed per request from
 * owned assets (resolvePersonas), so it says yes to them while still refusing a pure shipper.
 *
 * What these pin:
 *   - a role='shipper' account WITH a drivers row (the distributor-with-a-truck) can complete
 *     the gated insurance step AND the ungated bank step — the bug this fixes;
 *   - a role='shipper' account with NO drivers row (a pure shipper) is still refused 403, with
 *     the same message as before — the deny half of the decision is unchanged;
 *   - a role='driver' account with a drivers row still succeeds — existing driver onboarding
 *     is untouched.
 *
 * Registers the REAL onboardingRoutes and the SHIPPED resolver (@bharattruck/shared/personas)
 * against an in-memory Supabase, so the gate runs against the real capability computation.
 * Run: npx tsx test/onboarding-capability.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'
// bank-account encrypts the account number — a fixed 32-byte hex key so encrypt() works.
process.env.ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

type Row = Record<string, any>

// The tables resolvePersonas + the onboarding routes read/write. Seeded per case.
let db: Record<string, Row[]> = {}

// ── Fake Supabase: the query shapes resolvePersonas and the insurance/bank routes build —
// eq / in / select(cols,{count,head}) / insert / update / order / maybeSingle / single.
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

async function main() {
  const { onboardingRoutes } = await import('../src/routes/onboarding.js')

  const app = Fastify({ logger: false })
  app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
  await app.register(onboardingRoutes, { prefix: '/onboarding' })

  // The insurance route validates :id as a UUID before touching the row, so the seeded
  // vehicle ids have to be real UUIDs — the gate has already run by then.
  const V_DIST = '11111111-1111-4111-8111-111111111111'
  const V_DRV  = '22222222-2222-4222-8222-222222222222'

  const tokenFor = (userId: string, role?: string) =>
    jwt.sign(role ? { userId, role } : { userId }, process.env.JWT_SECRET!, { expiresIn: 900 })
  const auth = (t: string) => ({ authorization: `Bearer ${t}` })
  const postInsurance = (token: string, vehicleId: string) =>
    app.inject({ method: 'POST', url: `/onboarding/vehicle/${vehicleId}/insurance`, headers: auth(token),
      payload: { policy_number: 'POL-123', provider: 'ICICI Lombard' } })
  const linkBank = (token: string) =>
    app.inject({ method: 'POST', url: '/onboarding/bank-account', headers: auth(token),
      payload: { account_number: '12345678', ifsc: 'HDFC0001234', account_holder_name: 'Distributor Rao' } })

  // ── The distributor who drives their own truck: role 'shipper', but HAS a drivers row and a
  //    truck. This is the case the old `role === 'driver'` gate wrongly refused.
  console.log('\n── a role=shipper account that owns a truck it drives ──')
  db = {
    users: [{ id: 'u-dist', role: 'shipper' }],
    drivers: [{ id: 'd-dist', user_id: 'u-dist' }],
    fleet_owners: [],
    vehicles: [{ id: V_DIST, driver_id: 'd-dist', fleet_owner_id: null, is_active: true }],
    fleet_drivers: [],
    driver_insurance: [],
    bank_accounts: [],
  }
  let r = await postInsurance(tokenFor('u-dist', 'shipper'), V_DIST)
  check('gated insurance step is allowed (not 403) for a shipper who drives', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)
  check('the insurance row was written', (db.driver_insurance?.length ?? 0) === 1, `(got ${db.driver_insurance?.length})`)
  r = await linkBank(tokenFor('u-dist', 'shipper'))
  check('the bank step completes too', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)

  // ── A pure shipper: role 'shipper', NO drivers row. The deny half must be unchanged.
  console.log('\n── a pure shipper with no drivers row is still refused ──')
  db = {
    users: [{ id: 'u-ship', role: 'shipper' }],
    drivers: [],
    fleet_owners: [],
    vehicles: [],
    fleet_drivers: [],
    driver_insurance: [],
    bank_accounts: [],
  }
  r = await postInsurance(tokenFor('u-ship', 'shipper'), 'v-any')
  check('no drivers row → 403', r.statusCode === 403, `(got ${r.statusCode})`)
  check('same refusal message as before', r.json().error === 'Only drivers can access onboarding', `(got ${r.json().error})`)

  // ── An ordinary driver: role 'driver', drivers row + truck. Existing behaviour unchanged.
  console.log('\n── an ordinary driver is unchanged ──')
  db = {
    users: [{ id: 'u-drv', role: 'driver' }],
    drivers: [{ id: 'd-drv', user_id: 'u-drv' }],
    fleet_owners: [],
    vehicles: [{ id: V_DRV, driver_id: 'd-drv', fleet_owner_id: null, is_active: true }],
    fleet_drivers: [],
    driver_insurance: [],
    bank_accounts: [],
  }
  r = await postInsurance(tokenFor('u-drv', 'driver'), V_DRV)
  check('a role=driver account still completes insurance', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)

  // ── 2026-09-30: a driver joins with NO truck. Their own record (licence) completes with
  //    nothing but a drivers row; adding a TRUCK waits for a GSTIN on the account.
  console.log('\n── a driver with no truck: licence works, truck needs GST ──')
  db = {
    users: [{ id: 'u-new', role: 'driver', gstin: null }],
    drivers: [{ id: 'd-new', user_id: 'u-new' }],
    fleet_owners: [],
    vehicles: [],
    fleet_drivers: [],
    driver_licenses: [],
    driver_insurance: [],
    bank_accounts: [],
  }
  const postLicence = (token: string) =>
    app.inject({ method: 'POST', url: '/onboarding/license', headers: auth(token),
      payload: { dl_number: 'MH1220110012345', vehicle_classes: ['HMV'], expiry_date: '2030-01-01' } })
  const postVehicle = (token: string) =>
    app.inject({ method: 'POST', url: '/onboarding/vehicle', headers: auth(token),
      payload: { rc_number: 'MH31CQ4512', capacity_tons: 16 } })
  r = await postLicence(tokenFor('u-new', 'driver'))
  check('DL submits with no truck on file', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)
  r = await postVehicle(tokenFor('u-new', 'driver'))
  check('adding a truck without a GSTIN is refused 403', r.statusCode === 403, `(got ${r.statusCode}: ${r.body})`)
  check('…with the GSTIN_REQUIRED code bt-app keys off', r.json().code === 'GSTIN_REQUIRED', `(got ${r.json().code})`)
  check('…and no vehicle row was written', (db.vehicles?.length ?? 0) === 0, `(got ${db.vehicles?.length})`)
  db.users[0].gstin = '27ABCDE1234F1Z5'
  r = await postVehicle(tokenFor('u-new', 'driver'))
  check('the same request succeeds once a GSTIN is on the account', r.statusCode === 201, `(got ${r.statusCode}: ${r.body})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
