/**
 * bidderFromSnapshot — which of a human's carrier identities places a bid.
 *
 * The regression this pins: a one-truck fleet / distributor has `carry` but not
 * `operate` (operate needs 2+ trucks OR a held driver). Gating fleet bids on
 * `operate` alone 403'd Deepak on the live auction board even though his fleet
 * owned a truck and `/fleet/auctions` listed open loads for him.
 *
 * Pure function over a PersonaSnapshot — no Postgres.
 *
 * Run: npx tsx test/bidder-from-snapshot.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import type { PersonaSnapshot } from '@bharattruck/shared/personas'
import { bidderFromSnapshot } from '../src/lib/fleet.js'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

const snap = (over: Partial<PersonaSnapshot>): PersonaSnapshot => ({
  user_id: 'u1',
  primary_persona: 'fleet_owner',
  capabilities: ['ship'],
  driver_id: null,
  fleet_owner_id: null,
  owned_vehicle_count: 0,
  held_driver_count: 0,
  affiliated_fleet_owner_ids: [],
  sees_commercials: false,
  ...over,
})

console.log('\n── one-truck fleet / distributor (the live Deepak case)')
{
  const bidder = bidderFromSnapshot(snap({
    fleet_owner_id: 'f-deepak',
    owned_vehicle_count: 1,
    capabilities: ['ship', 'carry'],
    sees_commercials: true,
  }))
  check('bids as the fleet', bidder?.kind === 'fleet')
  check('fleetOwnerId is their fleet_owners.id', bidder?.kind === 'fleet' && bidder.fleetOwnerId === 'f-deepak')
}

console.log('\n── multi-truck fleet with operate')
{
  const bidder = bidderFromSnapshot(snap({
    fleet_owner_id: 'f-rajesh',
    owned_vehicle_count: 3,
    held_driver_count: 2,
    capabilities: ['ship', 'carry', 'operate'],
    sees_commercials: true,
  }))
  check('bids as the fleet', bidder?.kind === 'fleet' && bidder.fleetOwnerId === 'f-rajesh')
}

console.log('\n── attached-vehicle fleet (operate, no own truck)')
{
  const bidder = bidderFromSnapshot(snap({
    fleet_owner_id: 'f-attach',
    owned_vehicle_count: 0,
    held_driver_count: 2,
    capabilities: ['ship', 'operate'],
    sees_commercials: true,
  }))
  check('still bids as the fleet', bidder?.kind === 'fleet' && bidder.fleetOwnerId === 'f-attach')
}

console.log('\n── empty fleet registration (no truck, no drivers)')
{
  const bidder = bidderFromSnapshot(snap({
    fleet_owner_id: 'f-empty',
    capabilities: ['ship'],
  }))
  check('cannot bid — nothing to carry with', bidder === null)
}

console.log('\n── solo owner-driver (no fleet)')
{
  const bidder = bidderFromSnapshot(snap({
    primary_persona: 'driver',
    driver_id: 'd-solo',
    owned_vehicle_count: 1,
    capabilities: ['ship', 'drive', 'carry'],
    sees_commercials: true,
  }))
  check('bids as the driver', bidder?.kind === 'driver' && bidder.driverId === 'd-solo')
}

console.log('\n── human who is both: fleet takes precedence')
{
  const bidder = bidderFromSnapshot(snap({
    driver_id: 'd-both',
    fleet_owner_id: 'f-both',
    owned_vehicle_count: 2,
    capabilities: ['ship', 'drive', 'carry', 'operate'],
    sees_commercials: true,
  }))
  check('fleet wins over the driver identity', bidder?.kind === 'fleet' && bidder.fleetOwnerId === 'f-both')
}

console.log('\n── bare shipper')
{
  const bidder = bidderFromSnapshot(snap({
    primary_persona: 'shipper',
    capabilities: ['ship'],
  }))
  check('cannot bid', bidder === null)
}

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
