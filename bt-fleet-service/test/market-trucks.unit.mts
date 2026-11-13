/**
 * Market trucks (2026-11-13): a fleet hiring an OUTSIDER — an independent driver on their own
 * truck — for one load. Pins:
 *   • the seam (mayExecuteFor) opens the outsider branch ONLY for the exact crew of an accepted
 *     offer, and only when the truck is that driver's own; everything else is the own-fleet rule;
 *   • who may be offered a load at all (checkMarketCrew);
 *   • offer expiry / ownership (offerIsFor, buildOffer);
 *   • the Own / Outsider badge (crewOf).
 * No database, no Redis: lookups are injected, and the pure helpers take plain values.
 *
 * Run: npx tsx test/market-trucks.unit.mts
 */
import { mayExecuteFor, type ExecutionLookups } from '../src/lib/assignment.js'
import { buildOffer, checkMarketCrew, offerIsFor, MARKET_OFFER_TTL_SECONDS } from '../src/lib/market-offer.js'
import { crewOf } from '../src/routes/assignment.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const FLEET = '11111111-1111-1111-1111-111111111111'
const FLEET_TRUCK = '22222222-2222-2222-2222-222222222222'
const OUT_TRUCK = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const OUTSIDER = '55555555-5555-5555-5555-555555555555'
const STRANGER = '66666666-6666-6666-6666-666666666666'

const vehicles = [
  { id: FLEET_TRUCK, fleet_owner_id: FLEET as string | null, driver_id: null as string | null },
  { id: OUT_TRUCK, fleet_owner_id: null, driver_id: OUTSIDER },
]
const lookups: ExecutionLookups = {
  async vehicle(f, v) { return vehicles.find(x => x.id === v && x.fleet_owner_id === f) ?? null },
  async affiliation(f, d) { return f === FLEET && d === MEMBER ? { id: 'aff' } : null },
  async driverVehicle(d, v) { return vehicles.find(x => x.id === v && x.driver_id === d && x.fleet_owner_id === null) ?? null },
}

async function main() {
  console.log('\n── seam: mayExecuteFor')
  check('own crew still passes (no offer)', (await mayExecuteFor({ fleetOwnerId: FLEET }, { vehicleId: FLEET_TRUCK, driverId: MEMBER }, lookups)) === null)
  const noOffer = await mayExecuteFor({ fleetOwnerId: FLEET }, { vehicleId: OUT_TRUCK, driverId: OUTSIDER }, lookups)
  check('outsider WITHOUT an offer is refused (truck not in fleet → 404)', noOffer?.httpStatus === 404)
  const hire = { driverId: OUTSIDER, vehicleId: OUT_TRUCK }
  check('outsider WITH the matching offer passes', (await mayExecuteFor({ fleetOwnerId: FLEET, marketHire: hire }, { vehicleId: OUT_TRUCK, driverId: OUTSIDER }, lookups)) === null)
  const swapTruck = await mayExecuteFor({ fleetOwnerId: FLEET, marketHire: hire }, { vehicleId: FLEET_TRUCK, driverId: OUTSIDER }, lookups)
  check('offer for one crew cannot carry another truck (falls to own-fleet rule → not a member, 403)', swapTruck?.httpStatus === 403)
  const strangerOnOffer = await mayExecuteFor({ fleetOwnerId: FLEET, marketHire: { driverId: STRANGER, vehicleId: OUT_TRUCK } }, { vehicleId: OUT_TRUCK, driverId: STRANGER }, lookups)
  check("someone else's truck under an offer naming it → 404", strangerOnOffer?.httpStatus === 404)
  const noLookup = await mayExecuteFor({ fleetOwnerId: FLEET, marketHire: hire }, { vehicleId: OUT_TRUCK, driverId: OUTSIDER }, { vehicle: lookups.vehicle, affiliation: lookups.affiliation })
  check('fails closed when the driver-truck lookup is missing', noLookup?.httpStatus === 404)

  console.log('\n── who can be offered a load: checkMarketCrew')
  const base = { driverId: OUTSIDER, driverUserId: 'u-out', ownerUserId: 'u-owner', isMember: false }
  check('driver with their own truck → ok', checkMarketCrew({ ...base, vehicle: vehicles[1] }) === null)
  check('no truck of their own → refused', checkMarketCrew({ ...base, vehicle: null })?.code === 'NOT_FOUND')
  check('a fleet truck can never be a market truck', checkMarketCrew({ ...base, vehicle: { id: FLEET_TRUCK, driver_id: OUTSIDER, fleet_owner_id: FLEET } })?.code === 'NOT_FOUND')
  check("another driver's truck → refused", checkMarketCrew({ ...base, vehicle: { id: OUT_TRUCK, driver_id: STRANGER, fleet_owner_id: null } })?.code === 'NOT_FOUND')
  check('already in your fleet → assign directly', checkMarketCrew({ ...base, vehicle: vehicles[1], isMember: true })?.code === 'IN_YOUR_FLEET')
  check('the owner cannot hire themselves', checkMarketCrew({ ...base, vehicle: vehicles[1], driverUserId: 'u-owner' })?.code === 'OWN_FLEET')

  console.log('\n── offers')
  const now = new Date('2026-11-13T10:00:00Z')
  const offer = buildOffer({ booking_id: 'b1', fleet_owner_id: FLEET, driver_id: OUTSIDER, vehicle_id: OUT_TRUCK, by: 'u-owner' }, now)
  check('offer lasts 24 h', new Date(offer.expires_at).getTime() - now.getTime() === MARKET_OFFER_TTL_SECONDS * 1000)
  check('offer is open for its driver', offerIsFor(offer, OUTSIDER, now))
  check('not for anyone else', !offerIsFor(offer, STRANGER, now))
  check('lapses after 24 h', !offerIsFor(offer, OUTSIDER, new Date(now.getTime() + 25 * 3600 * 1000)))
  check('no offer → not open', !offerIsFor(null, OUTSIDER, now))

  console.log('\n── badge: crewOf')
  const fleetTrucks = new Set([FLEET_TRUCK])
  check('fleet truck → own', crewOf(FLEET_TRUCK, fleetTrucks) === 'own')
  check('market truck → outsider', crewOf(OUT_TRUCK, fleetTrucks) === 'outsider')
  check('no truck yet → null', crewOf(null, fleetTrucks) === null)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
