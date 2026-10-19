/**
 * Fleet re-crew decision (review F25).
 *
 * Before this, assignDriverAndVehicle could not re-crew an already-assigned 'accepted' booking:
 * the one-live-per-booking index refused the new row and the sweep only frees TERMINAL bookings,
 * so a swap dead-ended at 409. reCrewPlan is the pure decision that drives the release-then-insert:
 * release the booking's OWN prior assignment first, and — only when the driver changes — prove the
 * new driver is free before letting go of the old crew, so a release can never strand the booking.
 *
 * Pure, no database. Run: npx tsx test/recrew-plan.unit.mts
 */
import { reCrewPlan } from '../src/lib/assignment.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const D1 = 'driver-1', D2 = 'driver-2', V1 = 'vehicle-1', V2 = 'vehicle-2'

console.log('\n── reCrewPlan')
// A fresh fleet-won booking has no crew — nothing to release, the normal insert path applies.
const fresh = reCrewPlan({ driver_id: null, vehicle_id: null }, { driverId: D1, vehicleId: V1 })
check('fresh booking: no release, no driver check', !fresh.needsRelease && !fresh.driverChanged)

// Full swap (new driver AND new truck): release the old crew, and the new driver's freeness matters.
const swap = reCrewPlan({ driver_id: D1, vehicle_id: V1 }, { driverId: D2, vehicleId: V2 })
check('driver+truck swap: release + driverChanged', swap.needsRelease && swap.driverChanged)

// Truck-only swap keeps the SAME driver — release, but the driver is already held so no driver check.
const truckOnly = reCrewPlan({ driver_id: D1, vehicle_id: V1 }, { driverId: D1, vehicleId: V2 })
check('truck-only swap: release, driver unchanged', truckOnly.needsRelease && !truckOnly.driverChanged)

// Driver-only swap (same truck): release + the new driver's freeness matters.
const driverOnly = reCrewPlan({ driver_id: D1, vehicle_id: V1 }, { driverId: D2, vehicleId: V1 })
check('driver-only swap: release + driverChanged', driverOnly.needsRelease && driverOnly.driverChanged)

// Re-submitting the SAME crew is a no-op re-crew — the existing insert path handles it unchanged.
const same = reCrewPlan({ driver_id: D1, vehicle_id: V1 }, { driverId: D1, vehicleId: V1 })
check('same crew re-submitted: no release', !same.needsRelease && !same.driverChanged)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
