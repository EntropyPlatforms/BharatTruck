/**
 * /me/carriers — a shipper's Preferred carriers, against the REAL routes (app.inject) and
 * the in-memory fake Supabase.
 *
 * What is pinned:
 *   * automatic preference comes from THIS shipper's finished trips only (completed/paid —
 *     not delivery_asserted, not another shipper's trips), credited to the fleet on a fleet trip;
 *   * a star adds a carrier, both reasons merge into ONE card, un-starring keeps trip history;
 *   * no full phone number leaves the service; the caller never sees themselves;
 *   * a fleet-EMPLOYED driver is never offered as a direct target (they could not accept it);
 *   * search: by name and by whole mobile, preferred hits keep their label;
 *   * BEFORE migration 0044: the list still answers 200 (automatic only, stars_enabled
 *     false) and star/unstar answer 503 naming the migration — never a 500.
 * Run: npx tsx test/preferred-carriers.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()

const U_SHIP   = '10000000-0000-4000-8000-000000000001' // the shipper under test
const U_OTHER  = '10000000-0000-4000-8000-000000000002' // another shipper
const U_SOLO   = '20000000-0000-4000-8000-000000000003' // solo driver, 2 trips with U_SHIP
const U_OWNDRV = '20000000-0000-4000-8000-000000000004' // owner-driver attached to a fleet, starred
const U_HIRED  = '20000000-0000-4000-8000-000000000005' // fleet-EMPLOYED driver
const U_FLEET  = '30000000-0000-4000-8000-000000000006' // fleet owner, 1 trip with U_SHIP
const U_STRAY  = '20000000-0000-4000-8000-000000000007' // driver who only worked for U_OTHER
const U_ASSERT = '20000000-0000-4000-8000-000000000008' // driver whose only trip is delivery_asserted

const D_SOLO   = 'd0000000-0000-4000-8000-000000000003'
const D_OWN    = 'd0000000-0000-4000-8000-000000000004'
const D_HIRED  = 'd0000000-0000-4000-8000-000000000005'
const D_STRAY  = 'd0000000-0000-4000-8000-000000000007'
const D_ASSERT = 'd0000000-0000-4000-8000-000000000008'
const D_SELF   = 'd0000000-0000-4000-8000-000000000001' // U_SHIP also drives
const FO       = 'f0000000-0000-4000-8000-000000000006'

let n = 0
const booking = (over: Record<string, unknown>) => ({
  id: `b0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  shipper_id: U_SHIP, driver_id: null, fleet_owner_id: null, status: 'pending', updated_at: '2026-10-01T00:00:00Z', ...over,
})

function seed() {
  fake.reset()
  n = 0
  const s = fake.store
  s.users = [
    { id: U_SHIP, full_name: 'Anita Traders', phone_number: '9000000001', city: 'Pune' },
    { id: U_OTHER, full_name: 'Other Shipper', phone_number: '9000000002' },
    { id: U_SOLO, full_name: 'Ravi Kumar', phone_number: '9876543210', city: 'Nashik' },
    { id: U_OWNDRV, full_name: 'Suresh Patil', phone_number: '9876500004' },
    { id: U_HIRED, full_name: 'Ravi Shinde', phone_number: '9876500005' },
    { id: U_FLEET, full_name: 'Mohan Sharma', phone_number: '9876500006' },
    { id: U_STRAY, full_name: 'Stray Driver', phone_number: '9876500007' },
    { id: U_ASSERT, full_name: 'Asserted Driver', phone_number: '9876500008' },
  ]
  s.drivers = [
    { id: D_SOLO, user_id: U_SOLO, truck_number: 'MH15 AB 1111', home_base_city: 'Nashik' },
    { id: D_OWN, user_id: U_OWNDRV, truck_number: 'MH12 CD 2222', home_base_city: null },
    { id: D_HIRED, user_id: U_HIRED, truck_number: null, home_base_city: null },
    { id: D_STRAY, user_id: U_STRAY, truck_number: null, home_base_city: null },
    { id: D_ASSERT, user_id: U_ASSERT, truck_number: null, home_base_city: null },
    { id: D_SELF, user_id: U_SHIP, truck_number: 'MH14 ZZ 0001', home_base_city: 'Pune' },
  ]
  s.fleet_owners = [{ id: FO, user_id: U_FLEET, company_name: 'Sharma Roadlines', contact_phone: '9822012345', city: 'Mumbai', is_active: true }]
  s.fleet_drivers = [
    { driver_id: D_HIRED, fleet_owner_id: FO, status: 'active' },
    { driver_id: D_OWN, fleet_owner_id: FO, status: 'active' },
  ]
  s.vehicles = [{ id: 'v-own', driver_id: D_OWN, fleet_owner_id: null }]
  s.bookings = [
    booking({ driver_id: D_SOLO, status: 'completed', updated_at: '2026-10-02T00:00:00Z' }),
    booking({ driver_id: D_SOLO, status: 'paid', updated_at: '2026-10-08T00:00:00Z' }),
    booking({ driver_id: D_SOLO, status: 'in_transit' }),                                  // not finished
    booking({ driver_id: D_HIRED, fleet_owner_id: FO, status: 'paid', updated_at: '2026-10-09T00:00:00Z' }),
    booking({ driver_id: D_ASSERT, status: 'delivery_asserted' }),                         // POD unconfirmed
    booking({ shipper_id: U_OTHER, driver_id: D_STRAY, status: 'paid' }),                  // someone else's
    booking({ driver_id: D_SELF, status: 'completed' }),                                   // never list yourself
  ]
  s.shipper_preferred_carriers = [
    { id: 's1', shipper_id: U_SHIP, carrier_kind: 'driver', carrier_id: D_OWN, created_at: '2026-10-10T00:00:00Z' },
    { id: 's2', shipper_id: U_OTHER, carrier_kind: 'driver', carrier_id: D_STRAY, created_at: '2026-10-10T00:00:00Z' },
  ]
}

const tok = (u: string) => jwt.sign({ userId: u, role: 'shipper' }, process.env.JWT_SECRET!)

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { preferredCarrierRoutes } = await import('../src/routes/preferred-carriers.js')
  const app = Fastify({ logger: false })
  await app.register(async (a) => { await a.register(authPlugin); await a.register(preferredCarrierRoutes, { prefix: '/me' }) })
  await app.ready()

  const call = async (method: 'GET' | 'PUT' | 'DELETE', url: string, u = U_SHIP) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tok(u)}` } })
    return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body }
  }

  // ---- the list --------------------------------------------------------------
  seed()
  {
    const r = await call('GET', '/me/carriers')
    const list = r.body.data?.carriers ?? []
    const ids = list.map((c: any) => c.id)
    check('GET /me/carriers → 200', r.status === 200, r.raw)
    check('stars are enabled once 0044 exists', r.body.data?.stars_enabled === true)
    check('ranked: 2-trip solo driver, then the fleet (1 trip), then the star-only owner-driver',
      JSON.stringify(ids) === JSON.stringify([D_SOLO, FO, D_OWN]), JSON.stringify(ids))
    const solo = list.find((c: any) => c.id === D_SOLO)
    check('solo driver: 2 trips with you (in_transit not counted)', solo?.trips_with_you === 2, JSON.stringify(solo))
    check('solo driver: reasons = trips', JSON.stringify(solo?.reasons) === '["trips"]')
    check('solo driver can be the target of a direct load', solo?.direct_targetable === true)
    const fleet = list.find((c: any) => c.id === FO)
    check('a fleet trip lists the FLEET as preferred, by company name', fleet?.kind === 'fleet_owner' && fleet?.name === 'Sharma Roadlines')
    check('a fleet is not a direct target (no target column; see the route header)', fleet?.direct_targetable === false)
    check('the employee who drove the fleet trip is not listed', !ids.includes(D_HIRED))
    const own = list.find((c: any) => c.id === D_OWN)
    check('a starred carrier with no trips is preferred with reason "starred"',
      own?.preferred === true && JSON.stringify(own?.reasons) === '["starred"]' && own?.starred === true)
    check('an attached OWNER-driver (owns a truck) is still a direct target', own?.direct_targetable === true)
    check('delivery_asserted is not a finished trip', !ids.includes(D_ASSERT))
    check('another shipper\'s trips and stars never leak in', !ids.includes(D_STRAY))
    check('the caller never appears in their own list', !ids.includes(D_SELF))
    check('no full phone number in the payload', !/9876543210|9822012345|9876500004/.test(r.raw), r.raw)
    check('phones arrive masked to the last four', solo?.phone_masked === '••••••3210')
  }

  // ---- star / unstar ---------------------------------------------------------
  seed()
  {
    let r = await call('PUT', `/me/carriers/fleet_owner/${FO}/star`)
    check('PUT star → 200', r.status === 200 && r.body.data?.starred === true, r.raw)
    r = await call('PUT', `/me/carriers/fleet_owner/${FO}/star`)
    check('starring twice is idempotent (200, one row)', r.status === 200 &&
      fake.store.shipper_preferred_carriers.filter((x) => x.shipper_id === U_SHIP && x.carrier_id === FO).length === 1, r.raw)
    const list = (await call('GET', '/me/carriers')).body.data.carriers
    const fleet = list.find((c: any) => c.id === FO)
    check('trips + star merge into ONE card with both reasons',
      list.filter((c: any) => c.id === FO).length === 1 && JSON.stringify(fleet?.reasons) === '["trips","starred"]', JSON.stringify(fleet))

    r = await call('DELETE', `/me/carriers/fleet_owner/${FO}/star`)
    check('DELETE star → 200', r.status === 200 && r.body.data?.starred === false, r.raw)
    const after = (await call('GET', '/me/carriers')).body.data.carriers.find((c: any) => c.id === FO)
    check('un-starring keeps the carrier Preferred by trips', after?.preferred === true && JSON.stringify(after?.reasons) === '["trips"]')

    r = await call('DELETE', `/me/carriers/driver/${D_OWN}/star`)
    const gone = (await call('GET', '/me/carriers')).body.data.carriers.some((c: any) => c.id === D_OWN)
    check('un-starring a star-only carrier removes them from the list', r.status === 200 && !gone)
    check('U_OTHER\'s star on the same table is untouched', fake.store.shipper_preferred_carriers.some((x) => x.shipper_id === U_OTHER))

    r = await call('PUT', `/me/carriers/driver/${D_SELF}/star`)
    check('starring yourself → 400', r.status === 400, r.raw)
    r = await call('PUT', '/me/carriers/driver/d0000000-0000-4000-8000-0000000000ff/star')
    check('starring a carrier that does not exist → 404', r.status === 404, r.raw)
    r = await call('PUT', `/me/carriers/shipper/${D_SOLO}/star`)
    check('an unknown kind → 400', r.status === 400, r.raw)
    r = await call('PUT', '/me/carriers/driver/not-a-uuid/star')
    check('a malformed id → 400', r.status === 400, r.raw)
  }

  // ---- search ----------------------------------------------------------------
  seed()
  {
    let r = await call('GET', '/me/carriers/search?q=ravi')
    const ids = (r.body.data ?? []).map((c: any) => c.id)
    check('search by name → 200 with both Ravis', r.status === 200 && ids.includes(D_SOLO) && ids.includes(D_HIRED), r.raw)
    check('the preferred Ravi comes first and keeps his label', ids[0] === D_SOLO && r.body.data[0].preferred === true)
    const hired = r.body.data.find((c: any) => c.id === D_HIRED)
    check('a non-preferred hit is labelled not preferred', hired?.preferred === false && hired?.reasons.length === 0)
    check('a fleet-employed driver is found but NOT offered as a direct target', hired?.direct_targetable === false)
    check('search results never carry a full phone', !/9876543210|9876500005/.test(r.raw))

    r = await call('GET', '/me/carriers/search?q=sharma')
    check('search finds a fleet by company name', r.body.data?.some((c: any) => c.id === FO && c.kind === 'fleet_owner'), r.raw)

    r = await call('GET', '/me/carriers/search?q=%2B91%2098765%2043210')
    check('search by whole mobile finds that driver', r.status === 200 && r.body.data?.length === 1 && r.body.data[0].id === D_SOLO, r.raw)
    r = await call('GET', '/me/carriers/search?q=9822012345')
    check('search by a fleet\'s contact phone finds the fleet', r.body.data?.some((c: any) => c.id === FO), r.raw)

    r = await call('GET', '/me/carriers/search?q=98765')
    check('a partial number → 400 (no walking the directory)', r.status === 400, r.raw)
    r = await call('GET', '/me/carriers/search?q=%25')
    check('a lone "%" → 400', r.status === 400, r.raw)
    r = await call('GET', '/me/carriers/search?q=%25%25')
    check('"%%" is matched literally — it lists nobody', r.status === 200 && r.body.data.length === 0, r.raw)
    r = await call('GET', '/me/carriers/search?q=anita')
    check('the caller never finds themselves', r.status === 200 && !r.body.data.some((c: any) => c.id === D_SELF), r.raw)
  }

  // ---- before migration 0044 -------------------------------------------------
  seed()
  fake.missing.add('shipper_preferred_carriers')
  {
    const r = await call('GET', '/me/carriers')
    const ids = (r.body.data?.carriers ?? []).map((c: any) => c.id)
    check('unapplied 0044: the list still answers 200', r.status === 200, r.raw)
    check('unapplied 0044: stars_enabled is false', r.body.data?.stars_enabled === false)
    check('unapplied 0044: automatic preferred still listed', ids.includes(D_SOLO) && ids.includes(FO) && !ids.includes(D_OWN))
    const s = await call('GET', '/me/carriers/search?q=ravi')
    check('unapplied 0044: search still answers 200', s.status === 200, s.raw)
    const put = await call('PUT', `/me/carriers/driver/${D_SOLO}/star`)
    check('unapplied 0044: star → 503 naming the migration', put.status === 503 && /0044/.test(put.body.error), put.raw)
    const del = await call('DELETE', `/me/carriers/driver/${D_SOLO}/star`)
    check('unapplied 0044: unstar → 503, not 500', del.status === 503, del.raw)
  }

  // ---- auth --------------------------------------------------------------------
  {
    const res = await app.inject({ method: 'GET', url: '/me/carriers' })
    check('no token → 401', res.statusCode === 401, res.body)
  }

  await app.close()
  finish()
}

main().catch((e) => { console.error(e); process.exit(1) })
