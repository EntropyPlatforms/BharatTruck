/**
 * Capacity gate (founder: "a 2t truck is taking a 5t load booking").
 *
 * assertVehicleWithinCapacity refuses binding a truck to a load heavier than it can carry.
 * weight_kg is the shipper's declared load; capacity_tons is the fleet's own truck spec
 * (1 t = 1000 kg). It fires ONLY when capacity is KNOWN — a null spec cannot prove an
 * overload, so it stays selectable (the fix for missing specs is prompting fleets to enter
 * them, not failing dispatch closed on a data-entry gap).
 *
 * Pure, no database. Run: npx tsx test/capacity-gate.unit.mts
 */
import { assertVehicleWithinCapacity } from '../src/lib/assignment.js'
import { FleetError } from '../src/lib/types.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

/** Runs fn, returns the thrown FleetError (or null if it did not throw). */
function refusal(fn: () => void): FleetError | null {
  try { fn(); return null } catch (e) { return e instanceof FleetError ? e : null }
}

console.log('\n── assertVehicleWithinCapacity')

// The exact reported bug: a 2t truck under a 5000kg load must be refused.
const overload = refusal(() => assertVehicleWithinCapacity({ weight_kg: 5000 }, { capacity_tons: 2, rc_number: 'KA01AB1234' }))
check('5t load on a 2t truck is refused', overload !== null)
check('refusal carries CAPACITY_EXCEEDED / 409', overload?.code === 'CAPACITY_EXCEEDED' && overload?.httpStatus === 409)
check('refusal names the truck and both weights', Boolean(overload && /KA01AB1234/.test(overload.message) && /2 t/.test(overload.message) && /5\.00 t/.test(overload.message)),
  overload?.message ?? '(no throw)')

// Exactly at capacity is allowed — 2000kg on a 2t truck is a full, legal load, not an overload.
check('load exactly at capacity is allowed', refusal(() => assertVehicleWithinCapacity({ weight_kg: 2000 }, { capacity_tons: 2 })) === null)

// Well under capacity is allowed.
check('load under capacity is allowed', refusal(() => assertVehicleWithinCapacity({ weight_kg: 1500 }, { capacity_tons: 2 })) === null)

// Unknown capacity cannot disqualify a truck — a blank spec is not proof of an overload.
check('null capacity does not refuse', refusal(() => assertVehicleWithinCapacity({ weight_kg: 9999 }, { capacity_tons: null })) === null)

// One kg over the rated capacity is still an overload — the boundary is strict.
check('1kg over capacity is refused', refusal(() => assertVehicleWithinCapacity({ weight_kg: 2001 }, { capacity_tons: 2 })) !== null)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
