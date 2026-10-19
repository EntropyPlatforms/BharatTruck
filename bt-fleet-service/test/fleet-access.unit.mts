/**
 * bt-fleet-service — the PURE authorization logic behind delegated fleet-staff access
 * (migration 0036): does a grant set satisfy a need, which fleets can a caller act on, and
 * which one is chosen. The DB-touching parts (requireFleetAccess) are integration-tested
 * elsewhere; these are the decisions that decide who gets in, so they are unit-tested.
 *
 * Run: npx tsx test/fleet-access.unit.mts
 */
import type { FleetGrant } from '../src/lib/fleet-access.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { grantSatisfies, resolveFleetCandidates, pickFleet, ALL_GRANTS } = await import('../src/lib/fleet-access.js')

  console.log('\n── grantSatisfies: owner/admin/any/exact ──')
  check('an OWNER satisfies any need', grantSatisfies('view_analytics', [], true))
  check('the admin grant satisfies any need', grantSatisfies('dispatch', ['admin'], false))
  check('the exact grant is accepted', grantSatisfies('dispatch', ['dispatch'], false))
  check('a different grant is refused', !grantSatisfies('bid', ['dispatch'], false))
  check("'any' is satisfied by holding SOME grant", grantSatisfies('any', ['view_analytics'], false))
  check("'any' is refused with NO grants", !grantSatisfies('any', [], false))
  check('a non-owner with no grants is refused', !grantSatisfies('view_analytics', [], false))
  check('view_analytics gates money: a dispatch-only clerk cannot see analytics',
    !grantSatisfies('view_analytics', ['dispatch'], false))

  console.log('\n── resolveFleetCandidates: owned (all grants) + granted ──')
  const ownedOnly = resolveFleetCandidates('F1', new Map())
  check('owned-only -> one candidate, isOwner, all grants',
    ownedOnly.length === 1 && ownedOnly[0].fleetId === 'F1' && ownedOnly[0].isOwner &&
    ownedOnly[0].grants.length === ALL_GRANTS.length)

  const ownedPlusGrant = resolveFleetCandidates('F1', new Map<string, FleetGrant[]>([['F2', ['bid']]]))
  check('owned + a grant on another fleet -> two candidates',
    ownedPlusGrant.length === 2 &&
    ownedPlusGrant.some(c => c.fleetId === 'F1' && c.isOwner) &&
    ownedPlusGrant.some(c => c.fleetId === 'F2' && !c.isOwner && c.grants.join() === 'bid'))

  const ownerWinsDup = resolveFleetCandidates('F1', new Map<string, FleetGrant[]>([['F1', ['bid']]]))
  check('a grant on your OWN fleet does not duplicate it — ownership wins',
    ownerWinsDup.length === 1 && ownerWinsDup[0].isOwner)

  const delegateOnly = resolveFleetCandidates(null, new Map<string, FleetGrant[]>([['F2', ['dispatch', 'view_analytics']]]))
  check('a pure delegate -> one non-owner candidate with just their grants',
    delegateOnly.length === 1 && delegateOnly[0].fleetId === 'F2' && !delegateOnly[0].isOwner &&
    delegateOnly[0].grants.join() === 'dispatch,view_analytics')

  check('no fleet at all -> no candidates', resolveFleetCandidates(null, new Map()).length === 0)

  console.log('\n── pickFleet: single / explicit / owned-preferred / ambiguous ──')
  const c1 = resolveFleetCandidates('F1', new Map())
  const c2 = resolveFleetCandidates('F1', new Map<string, FleetGrant[]>([['F2', ['bid']]]))
  const cDelegateTwo = resolveFleetCandidates(null, new Map<string, FleetGrant[]>([['F2', ['bid']], ['F3', ['dispatch']]]))

  check('no candidates -> NOT_FOUND', pickFleet([], undefined).ok === false)
  const single = pickFleet(c1, undefined)
  check('a single candidate is chosen', single.ok === true && single.ok && single.chosen.fleetId === 'F1')
  const explicit = pickFleet(c2, 'F2')
  check('an explicit fleetId picks that authorized fleet', explicit.ok === true && explicit.ok && explicit.chosen.fleetId === 'F2')
  const explicitBad = pickFleet(c2, 'F9')
  check('an explicit fleetId the caller lacks -> FORBIDDEN', explicitBad.ok === false && !explicitBad.ok && explicitBad.code === 'FORBIDDEN')
  const multiOwned = pickFleet(c2, undefined)
  check('multiple candidates with no disambiguator -> the OWNED fleet',
    multiOwned.ok === true && multiOwned.ok && multiOwned.chosen.fleetId === 'F1' && multiOwned.chosen.isOwner)
  const ambiguous = pickFleet(cDelegateTwo, undefined)
  check('a delegate on TWO fleets with no fleetId -> AMBIGUOUS (must specify)',
    ambiguous.ok === false && !ambiguous.ok && ambiguous.code === 'AMBIGUOUS')
  const ambiguousResolved = pickFleet(cDelegateTwo, 'F3')
  check('...and passing the fleetId resolves it', ambiguousResolved.ok === true && ambiguousResolved.ok && ambiguousResolved.chosen.fleetId === 'F3')

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
