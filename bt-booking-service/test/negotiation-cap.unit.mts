/**
 * Bilateral negotiation round cap.
 *
 * The committed MVP scope caps negotiation at five counter-offers per quote
 * (docs/BIBLE.md §2.2). Nothing enforced it: counterQuote checked the actor,
 * the quote and the transition, then wrote — so a shipper and one bidder could
 * counter each other without limit, holding the load off the market while the
 * auction deadline ran down and firing a notification every round.
 *
 * The arithmetic is the part worth pinning. The negotiations log holds the
 * bidder's OPENING BID plus one row per counter, so the number of counters
 * already played is rows - 1, not rows. An off-by-one here either steals a
 * round from every negotiation or grants a sixth.
 *
 * Pure function, no Postgres.
 *
 * Run: npx tsx test/negotiation-cap.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { NEGOTIATION_ROUND_CAP, negotiationCapReached } from '../src/lib/quote-service.js'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('── negotiation round cap')

check('cap is 5, as committed in BIBLE §2.2', NEGOTIATION_ROUND_CAP === 5)

// rows = opening bid only. No counters yet, so the first counter must be allowed.
check('opening bid alone does not reach the cap', negotiationCapReached(1) === false)

// rows = bid + n counters. Allowed while counters-so-far < cap.
check('after 1 counter (2 rows) not reached', negotiationCapReached(2) === false)
check('after 4 counters (5 rows) not reached', negotiationCapReached(5) === false)

// The boundary: 6 rows = bid + 5 counters. Five have been played, so the
// incoming one would be the sixth and must be refused.
check('after 5 counters (6 rows) the cap IS reached', negotiationCapReached(6) === true)
check('after 6 counters (7 rows) still reached', negotiationCapReached(7) === true)

// Exactly NEGOTIATION_ROUND_CAP counters must be reachable — the cap is a
// maximum that can be hit, not one the pair can only approach.
let allowed = 0
for (let rows = 1; !negotiationCapReached(rows); rows++) allowed++
check(`exactly ${NEGOTIATION_ROUND_CAP} counters are permitted`, allowed === NEGOTIATION_ROUND_CAP)

// Degenerate inputs. A quote with no negotiation rows at all should not be
// treated as having exhausted its rounds — fail OPEN on a missing log, because
// refusing a legitimate counter is the worse failure for a live load.
check('zero rows does not reach the cap', negotiationCapReached(0) === false)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('FAILED:', failures.join(', '))
  process.exit(1)
}
