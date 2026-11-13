/**
 * A shipper bringing carriers onto their Preferred list: the invite link and the bulk CSV,
 * against the REAL routes (app.inject), the in-memory fake Supabase and an in-memory link store.
 *
 * What is pinned:
 *   * the link: make / show / replace / turn off; preview is public and shows only the shipper's name;
 *   * accept: a fleet owner and a truck-owning driver are starred for THAT shipper; a driver
 *     without a truck and a plain account are refused with what to do; your own link is refused;
 *     accepting twice is harmless; a replaced, expired or tampered link is refused;
 *   * bulk: per-row outcomes (added, already added, needs truck, not on BharatTruck, invalid,
 *     duplicate, self), fleet found by its business number, nothing for a row we cannot match;
 *   * before migration 0044 accept answers 503 naming the migration, never a 500.
 * Run: npx tsx test/preferred-onboarding.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'
import {
  setCarrierInviteStoreForTests, signCarrierInvite, verifyCarrierInvite, type CarrierInviteRecord,
} from '../src/lib/preferred/invite-link.ts'
import { planBulkRows } from '../src/lib/preferred/onboarding.ts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()

const U_SHIP  = '10000000-0000-4000-8000-000000000001'
const U_SHIP2 = '10000000-0000-4000-8000-000000000002'
const U_FLEET = '30000000-0000-4000-8000-000000000003'
const U_OWNER = '20000000-0000-4000-8000-000000000004' // driver with own truck
const U_HIRED = '20000000-0000-4000-8000-000000000005' // driver, no truck
const U_PLAIN = '40000000-0000-4000-8000-000000000006' // shipper-only account
const FO      = 'f0000000-0000-4000-8000-000000000003'
const D_OWNER = 'd0000000-0000-4000-8000-000000000004'
const D_HIRED = 'd0000000-0000-4000-8000-000000000005'

function seed() {
  fake.reset()
  const s = fake.store
  s.users = [
    { id: U_SHIP, full_name: 'Anita Traders', phone_number: '9000000001' },
    { id: U_SHIP2, full_name: 'Other Shipper', phone_number: '9000000002' },
    { id: U_FLEET, full_name: 'Mohan Sharma', phone_number: '9876500003' },
    { id: U_OWNER, full_name: 'Suresh Patil', phone_number: '9876500004' },
    { id: U_HIRED, full_name: 'Ravi Shinde', phone_number: '9876500005' },
    { id: U_PLAIN, full_name: 'Plain Account', phone_number: '9876500006' },
  ]
  s.fleet_owners = [{ id: FO, user_id: U_FLEET, company_name: 'Sharma Roadlines', contact_phone: '9822012345', city: 'Mumbai', is_active: true }]
  s.drivers = [
    { id: D_OWNER, user_id: U_OWNER, truck_number: 'MH12 CD 2222' },
    { id: D_HIRED, user_id: U_HIRED, truck_number: null },
  ]
  s.vehicles = [{ id: 'v1', driver_id: D_OWNER, fleet_owner_id: null, is_active: true }]
  s.fleet_drivers = []
  s.bookings = []
  s.shipper_preferred_carriers = []
}

const mem = new Map<string, CarrierInviteRecord>()
setCarrierInviteStoreForTests({
  async get(id) { return mem.get(id) ?? null },
  async set(id, r) { mem.set(id, r) },
  async del(id) { mem.delete(id) },
})

const tok = (u: string) => jwt.sign({ userId: u, role: 'shipper' }, process.env.JWT_SECRET!)
const stars = (shipper = U_SHIP) => (fake.store.shipper_preferred_carriers as any[]).filter((r) => r.shipper_id === shipper)

async function main() {
  // ---- pure parts ------------------------------------------------------------
  {
    const t = signCarrierInvite({ v: 1, s: U_SHIP, n: 'x'.repeat(22), e: Math.floor(Date.now() / 1000) + 60 })
    check('a signed link verifies', verifyCarrierInvite(t).ok === true)
    const [body, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ v: 1, s: U_SHIP2, n: 'x'.repeat(22), e: 9999999999 })).toString('base64url')
    check('changing the shipper breaks the signature', verifyCarrierInvite(`${forged}.${sig}`).ok === false)
    check('an expired link is refused as expired', (verifyCarrierInvite(t, Date.now() + 120_000) as any).reason === 'expired')
    check('garbage is malformed', (verifyCarrierInvite('nope') as any).reason === 'malformed' && body.length > 0)
    const plan = planBulkRows([{ mobile: '+91 98765 00004' }, { mobile: '098765-00004' }, { mobile: '12345' }, { name: '  A  ', mobile: '9876500003' }])
    check('bulk plan: +91/0 prefixes normalise to the same number → second is a duplicate',
      plan[0].status === 'lookup' && plan[0].mobile === '9876500004' && plan[1].status === 'duplicate')
    check('bulk plan: a short number is invalid', plan[2].status === 'invalid_mobile')
    check('bulk plan: names are trimmed, rows numbered from 1', plan[3].name === 'A' && plan[3].row === 4)
  }

  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { preferredCarrierRoutes, preferredCarrierPublicRoutes } = await import('../src/routes/preferred-carriers.js')
  const app = Fastify({ logger: false })
  await app.register(preferredCarrierPublicRoutes, { prefix: '/me' })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(preferredCarrierRoutes, { prefix: '/me' }) })
  await app.ready()

  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, u: string | null = U_SHIP, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as any, headers: u ? { authorization: `Bearer ${tok(u)}` } : {} })
    return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body }
  }

  // ---- the link --------------------------------------------------------------
  seed()
  mem.clear()
  let token = ''
  {
    const none = await call('GET', '/me/carriers/invite-link')
    check('no link yet → null', none.status === 200 && none.body.data === null, none.raw)
    const made = await call('POST', '/me/carriers/invite-link')
    token = made.body.data?.token ?? ''
    check('make a link → 201 with token and expiry', made.status === 201 && token.length > 20 && !!made.body.data?.expires_at, made.raw)
    const again = await call('GET', '/me/carriers/invite-link')
    check('showing it again returns the same token', again.body.data?.token === token)

    const pre = await call('POST', '/me/carriers/join/preview', null, { token })
    check('preview is public and names the shipper', pre.status === 200 && pre.body.data?.shipper_name === 'Anita Traders', pre.raw)
    check('preview reveals no phone or id', !/9000000001|10000000-0000/.test(pre.raw), pre.raw)
    const bad = await call('POST', '/me/carriers/join/preview', null, { token: token.slice(0, -3) + 'AAA' })
    check('a tampered link is refused (400)', bad.status === 400, bad.raw)
    const noAuth = await call('POST', '/me/carriers/join/accept', null, { token })
    check('accepting needs sign-in (401)', noAuth.status === 401, noAuth.raw)
  }

  // ---- accept ----------------------------------------------------------------
  {
    const fleet = await call('POST', '/me/carriers/join/accept', U_FLEET, { token })
    check('a fleet owner accepts → starred as the FLEET', fleet.status === 200 && fleet.body.data?.kind === 'fleet_owner' && fleet.body.data?.added === true, fleet.raw)
    check('…the star row is on THIS shipper', stars().some((r) => r.carrier_kind === 'fleet_owner' && r.carrier_id === FO) && stars(U_SHIP2).length === 0)
    const twice = await call('POST', '/me/carriers/join/accept', U_FLEET, { token })
    check('accepting twice is harmless (added: false, one row)', twice.status === 200 && twice.body.data?.added === false && stars().length === 1, twice.raw)

    const drv = await call('POST', '/me/carriers/join/accept', U_OWNER, { token })
    check('a driver with their own truck → starred as a driver', drv.status === 200 && drv.body.data?.kind === 'driver' && stars().some((r) => r.carrier_id === D_OWNER), drv.raw)

    const hired = await call('POST', '/me/carriers/join/accept', U_HIRED, { token })
    check('a driver without a truck is refused (403) and told to add one', hired.status === 403 && /truck/i.test(hired.body.error) && !stars().some((r) => r.carrier_id === D_HIRED), hired.raw)
    const plain = await call('POST', '/me/carriers/join/accept', U_PLAIN, { token })
    check('a plain account is refused (403) and told to set up a fleet or driver profile', plain.status === 403 && /fleet|driver/i.test(plain.body.error), plain.raw)
    const self = await call('POST', '/me/carriers/join/accept', U_SHIP, { token })
    check('your own link is refused (409)', self.status === 409, self.raw)

    const remade = await call('POST', '/me/carriers/invite-link')
    const old = await call('POST', '/me/carriers/join/accept', U_OWNER, { token })
    check('making a new link turns the old one off (410)', old.status === 410 && remade.body.data?.token !== token, old.raw)
    token = remade.body.data.token
    await call('DELETE', '/me/carriers/invite-link')
    const off = await call('POST', '/me/carriers/join/preview', null, { token })
    check('a link that was turned off is refused (410)', off.status === 410, off.raw)
  }

  // ---- before 0044 ------------------------------------------------------------
  seed()
  mem.clear()
  {
    const made = await call('POST', '/me/carriers/invite-link')
    fake.missing.add('shipper_preferred_carriers')
    const r = await call('POST', '/me/carriers/join/accept', U_FLEET, { token: made.body.data.token })
    check('before migration 0044, accept → 503 naming the migration (never a 500)', r.status === 503 && /0044/.test(r.body.error), r.raw)
    fake.missing.clear()
  }

  // ---- bulk --------------------------------------------------------------------
  seed()
  {
    ;(fake.store.shipper_preferred_carriers as any[]).push({ id: 'pre', shipper_id: U_SHIP, carrier_kind: 'driver', carrier_id: D_OWNER, created_at: '2026-11-01T00:00:00Z' })
    const r = await call('POST', '/me/carriers/bulk', U_SHIP, {
      rows: [
        { name: 'Sharma', mobile: '9822012345' },     // fleet business number
        { name: 'Suresh', mobile: '+91 98765 00004' }, // already starred
        { name: 'Ravi', mobile: '9876500005' },        // no truck
        { name: 'New guy', mobile: '9123456789' },     // not on BharatTruck
        { name: 'Typo', mobile: '98765' },
        { name: 'Again', mobile: '09822012345' },      // duplicate of row 1
        { name: 'Me', mobile: '9000000001' },          // the shipper
        { name: 'Plain', mobile: '9876500006' },       // an account, but not a carrier
      ],
    })
    const st = (r.body.data?.rows ?? []).map((x: any) => x.status)
    check('bulk → 200', r.status === 200, r.raw)
    check('per-row outcomes in order', JSON.stringify(st) === JSON.stringify([
      'added', 'already_added', 'needs_truck', 'not_on_bharattruck', 'invalid_mobile', 'duplicate', 'self', 'not_on_bharattruck',
    ]), JSON.stringify(st))
    check('the fleet row names the fleet', r.body.data.rows[0].carrier?.kind === 'fleet_owner' && r.body.data.rows[0].carrier?.name === 'Sharma Roadlines')
    check('unmatched rows carry no carrier', r.body.data.rows[3].carrier === null && r.body.data.rows[2].carrier === null)
    check('only the fleet was newly starred', stars().length === 2 && stars().some((x) => x.carrier_id === FO))
    const tooMany = await call('POST', '/me/carriers/bulk', U_SHIP, { rows: Array.from({ length: 201 }, () => ({ mobile: '9123456789' })) })
    check('more than 200 rows → 400', tooMany.status === 400, tooMany.raw)
    const empty = await call('POST', '/me/carriers/bulk', U_SHIP, { rows: [] })
    check('no rows → 400', empty.status === 400, empty.raw)
  }

  await app.close()
  finish()
}

main().catch((e) => { console.error(e); process.exit(1) })
