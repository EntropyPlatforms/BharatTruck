/**
 * Related-party bidding rule (review C-1, org half).
 *
 * The self-bid guard refuses the posting ACCOUNT; bidderIsRelatedParty refuses the
 * posting party's own crew — an owner-driver whose truck is ATTACHED to the fleet
 * that posted the load. They are not the shipper, so relationsToBooking passes them,
 * but a fleet out-bidding outsiders on its own load through its own attached driver
 * is the same fictional auction one hop removed. Enforced in submitQuote AND
 * acceptBooking (or the bid guard would be walked around by accepting instead).
 *
 * Pure, no database. Run: npx tsx test/related-party.unit.mts
 */
import { bidderIsRelatedParty } from '../src/lib/fleet.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const FLEET_A = 'fleet-a', FLEET_B = 'fleet-b'

console.log('\n── bidderIsRelatedParty')

// The reviewed hole: the bidder's truck is attached to the fleet that posted the load.
check('driver attached to the posting fleet IS related',
  bidderIsRelatedParty([FLEET_A], FLEET_A) === true)

// Multi-fleet drivers are allowed — only the POSTING fleet's affiliation disqualifies.
check('driver attached to a different fleet is NOT related',
  bidderIsRelatedParty([FLEET_B], FLEET_A) === false)
check('multi-fleet driver: related only when the posting fleet is among them',
  bidderIsRelatedParty([FLEET_B, FLEET_A], FLEET_A) === true)

// A poster with no fleet cannot make anyone a related party.
check('poster without a fleet: nobody is related',
  bidderIsRelatedParty([FLEET_A, FLEET_B], null) === false)

// An unaffiliated bidder is never related.
check('bidder with no affiliations is never related',
  bidderIsRelatedParty([], FLEET_A) === false)

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
