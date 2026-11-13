/**
 * Market hire price mask (2026-11-13): a driver running a FLEET's load on their own truck,
 * without being a member of that fleet, sees the job but not the fleet's price.
 * Pure predicate only — fleet.isMarketHireFor.
 *
 * Run: npx tsx test/market-hire-mask.unit.mts
 */
import { isMarketHireFor } from '../src/lib/fleet.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(name); console.log(`  FAIL  ${name}`) }
}

const FLEET = 'f1', OTHER = 'f2', ME = 'd1', SOMEONE = 'd2'
const none = new Set<string>()

check('outsider on a fleet load → hire (masked)', isMarketHireFor({ fleet_owner_id: FLEET, driver_id: ME }, ME, null, none))
check('member of that fleet → not a hire (existing rules apply)', !isMarketHireFor({ fleet_owner_id: FLEET, driver_id: ME }, ME, null, new Set([FLEET])))
check('member of ANOTHER fleet is still an outsider here', isMarketHireFor({ fleet_owner_id: FLEET, driver_id: ME }, ME, null, new Set([OTHER])))
check('the fleet owner driving their own load → not a hire', !isMarketHireFor({ fleet_owner_id: FLEET, driver_id: ME }, ME, FLEET, none))
check('solo booking (no fleet) → never a hire', !isMarketHireFor({ fleet_owner_id: null, driver_id: ME }, ME, null, none))
check('someone else driving → not my hire', !isMarketHireFor({ fleet_owner_id: FLEET, driver_id: SOMEONE }, ME, null, none))
check('no driver yet → not a hire', !isMarketHireFor({ fleet_owner_id: FLEET, driver_id: null }, ME, null, none))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
