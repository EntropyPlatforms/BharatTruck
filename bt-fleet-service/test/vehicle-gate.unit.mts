/**
 * bt-fleet-service — the PURE rule behind "a truck can only be added once GST is on file"
 * (src/lib/vehicle-gate.ts). The DB-touching half (requireBusinessIdentity) only loads the
 * owner's account GSTIN and calls this; the decision itself is pinned here.
 *
 * Run: npx tsx test/vehicle-gate.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { canAddVehicle, GST_REQUIRED_CODE, GST_REQUIRED_MESSAGE } = await import('../src/lib/vehicle-gate.js')

  console.log('\n── canAddVehicle ──')
  check('no GSTIN anywhere → refused',
    !canAddVehicle({ fleet_gstin: null, owner_user_gstin: null }))
  check('blank strings count as absent',
    !canAddVehicle({ fleet_gstin: '   ', owner_user_gstin: '' }))
  check('fleet profile GSTIN alone is enough',
    canAddVehicle({ fleet_gstin: '27ABCDE1234F1Z5', owner_user_gstin: null }))
  check('owner account GSTIN alone is enough (FB-04 shipper path)',
    canAddVehicle({ fleet_gstin: null, owner_user_gstin: '29ABCDE1234F1Z5' }))
  check('both present is fine',
    canAddVehicle({ fleet_gstin: '27ABCDE1234F1Z5', owner_user_gstin: '29ABCDE1234F1Z5' }))

  console.log('\n── wire contract ──')
  check('error code is the one bt-app keys its Settings link off', GST_REQUIRED_CODE === 'GSTIN_REQUIRED')
  check('message tells the owner WHERE to fix it', /Settings/.test(GST_REQUIRED_MESSAGE))

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.error('  ✗ ' + f); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
