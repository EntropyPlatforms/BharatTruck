/**
 * bt-fleet-service — the sub-contract seam (D-24): may this truck and this driver
 * execute work won by this carrier?
 *
 * WHAT THIS PINS, AND WHY IT IS WORTH A FILE.
 * D-24 says the commercial counterparty (the carrier that won the work) and the
 * executing assets (truck + driver) are separate facts that no code may assume
 * coincide. Today they must: a fleet dispatches its OWN truck, crewed by a driver
 * holding a live affiliation with it. That policy used to live as two guards a few
 * lines apart inside assignDriverAndVehicle; it now lives in mayExecuteFor, and
 * moving it was a refactor with NO behaviour change. These checks are what makes
 * that claim auditable — every authorization case the inline guards produced,
 * including which one wins when both facts fail, asserted on the named predicate.
 *
 * The refusals are deliberately DIFFERENT and both are pinned: another fleet's truck
 * is a 404 (never "that truck belongs to someone else", which would confirm its
 * existence to a fleet with no business knowing), while an unaffiliated driver is a
 * 403 (the driver is nameable; the refusal is about the relationship).
 *
 * What is NOT here: whether the truck is FREE. That is vehicle_assignments' partial
 * unique index, with D-19's read in front of it — see vehicle-schedule.test.mts. A
 * check below asserts this predicate never goes looking for it.
 *
 * Exercised WITHOUT a database: mayExecuteFor takes its two ownership reads as an
 * injected parameter, and getSupabase() throws unless SUPABASE_URL is set, so
 * anything that reached the network here would fail loudly rather than silently pass.
 *
 * Run: npm test   (or: npx tsx test/assignment-seam.test.mts)
 */
import type { ExecutionLookups } from '../src/lib/assignment.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const CARRIER = '11111111-1111-1111-1111-111111111111' // the fleet whose bid won the booking
const RIVAL = '22222222-2222-2222-2222-222222222222' // some other fleet
const TRUCK = '33333333-3333-3333-3333-333333333333'
const DRIVER = '44444444-4444-4444-4444-444444444444' // drivers.id, NOT users.id

type World = {
  vehicles: { id: string; fleet_owner_id: string }[]
  affiliations: { driver_id: string; fleet_owner_id: string; status: string }[]
}

// The fakes filter on exactly what the live queries filter on — getFleetVehicle
// scopes (id, fleet_owner_id) and getActiveAffiliation scopes (fleet_owner_id,
// driver_id, status='active'). Anything looser would let a test pass a case
// production refuses.
function spy(world: World) {
  const calls: { lookup: 'vehicle' | 'affiliation'; fleetOwnerId: string; assetId: string }[] = []
  const lookups: ExecutionLookups = {
    async vehicle(fleetOwnerId, vehicleId) {
      calls.push({ lookup: 'vehicle', fleetOwnerId, assetId: vehicleId })
      return world.vehicles.find(v => v.id === vehicleId && v.fleet_owner_id === fleetOwnerId) ?? null
    },
    async affiliation(fleetOwnerId, driverId) {
      calls.push({ lookup: 'affiliation', fleetOwnerId, assetId: driverId })
      const row = world.affiliations.find(
        a => a.driver_id === driverId && a.fleet_owner_id === fleetOwnerId && a.status === 'active',
      )
      return row ? { id: 'affiliation-1' } : null
    },
  }
  return { calls, lookups }
}

const ownCrew: World = {
  vehicles: [{ id: TRUCK, fleet_owner_id: CARRIER }],
  affiliations: [{ driver_id: DRIVER, fleet_owner_id: CARRIER, status: 'active' }],
}

const assets = { vehicleId: TRUCK, driverId: DRIVER }

async function main() {
  const { mayExecuteFor } = await import('../src/lib/assignment.js')

  console.log('\n── today: the carrier crews its own work ──')
  {
    const { calls, lookups } = spy(ownCrew)
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, lookups)
    check('own truck + active affiliation is allowed', refusal === null, JSON.stringify(refusal?.message))
    // Both reads are scoped by the CARRIER, never by whoever happens to own the
    // asset — that scoping IS the coupling D-24 keeps in one place.
    check('both reads are scoped by the carrier that won the work',
      calls.length === 2 && calls.every(c => c.fleetOwnerId === CARRIER), JSON.stringify(calls))
    // Freedom is the vehicle_assignments insert's question, not this one. Two reads
    // means it did not go looking for a live assignment on the way past.
    check('the seam asks whose assets these are and nothing else (exactly two reads)',
      calls.length === 2 && calls[0].lookup === 'vehicle' && calls[1].lookup === 'affiliation',
      JSON.stringify(calls.map(c => c.lookup)))
  }

  console.log('\n── a truck the carrier does not own ──')
  {
    const world: World = { ...ownCrew, vehicles: [{ id: TRUCK, fleet_owner_id: RIVAL }] }
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, spy(world).lookups)
    check('another fleet\'s truck is refused', refusal !== null)
    check('and refused as 404 NOT_FOUND, not as "someone else\'s truck"',
      refusal?.httpStatus === 404 && refusal?.code === 'NOT_FOUND', `(got ${refusal?.httpStatus}/${refusal?.code})`)
    check('with the message the inline guard produced',
      refusal?.message === 'Vehicle not found in this fleet', `(got ${refusal?.message})`)
  }
  {
    // A truck with no fleet_owner_id at all is a SOLO DRIVER's, and vehicles_single_owner
    // (0022) makes that mutually exclusive with fleet ownership. Same 404.
    const world: World = { ...ownCrew, vehicles: [] }
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, spy(world).lookups)
    check('a truck that is nobody\'s fleet asset is refused the same way',
      refusal?.httpStatus === 404 && refusal?.message === 'Vehicle not found in this fleet', `(got ${refusal?.message})`)
  }

  console.log('\n── a driver the carrier has no live affiliation with ──')
  {
    const world: World = { ...ownCrew, affiliations: [] }
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, spy(world).lookups)
    check('an unaffiliated driver is refused 403 FORBIDDEN',
      refusal?.httpStatus === 403 && refusal?.code === 'FORBIDDEN', `(got ${refusal?.httpStatus}/${refusal?.code})`)
    check('with the message the inline guard produced',
      refusal?.message === 'Driver is not an active member of this fleet', `(got ${refusal?.message})`)
  }
  for (const status of ['pending', 'suspended', 'left']) {
    const world: World = { ...ownCrew, affiliations: [{ driver_id: DRIVER, fleet_owner_id: CARRIER, status }] }
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, spy(world).lookups)
    check(`a '${status}' affiliation cannot be dispatched`, refusal?.httpStatus === 403, `(got ${refusal?.httpStatus})`)
  }
  {
    // THE sub-contracted case, spelled out: the driver is somebody's employee, just
    // not this carrier's. Refused today — and this is the single line that changes
    // when D-24's post-MVP flow lands, which is the whole reason the seam is named.
    const world: World = {
      ...ownCrew,
      affiliations: [{ driver_id: DRIVER, fleet_owner_id: RIVAL, status: 'active' }],
    }
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, spy(world).lookups)
    check('a driver active with a DIFFERENT fleet is still refused today',
      refusal?.httpStatus === 403, `(got ${refusal?.httpStatus})`)
  }

  console.log('\n── which refusal wins when both facts fail ──')
  {
    // Order is behaviour: the inline guards read the truck first, so a dispatcher who
    // gets both wrong has always been told about the truck. Reversing it would change
    // the status code of a live error response from 404 to 403.
    const { calls, lookups } = spy({ vehicles: [], affiliations: [] })
    const refusal = await mayExecuteFor({ fleetOwnerId: CARRIER }, assets, lookups)
    check('the truck is judged first, exactly as the inline guards did',
      refusal?.httpStatus === 404, `(got ${refusal?.httpStatus})`)
    check('and the affiliation is never read once the truck has been refused',
      calls.length === 1 && calls[0].lookup === 'vehicle', JSON.stringify(calls.map(c => c.lookup)))
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
