// Emergent-persona tests.
//
// These pin the rules that decide what a human may DO and what money they may SEE. Getting them
// wrong is either a lockout (a real operator cannot bid) or a leak (an employee sees the fleet's
// margins), so the cases the founder decisions turn on are pinned explicitly rather than left
// implied by a happy path.
//
// The cases that matter most, and why they exist:
//   - owner-driver attached to a fleet KEEPS the marketplace          (D-6 / §1.2)
//   - assetless fleet driver does NOT get a load board                (§1.2)
//   - owner-driver on a fleet booking SEES the money                  (§1.1 — this is the change)
//   - a shipper who also owns trucks reads as 'shipper' on their own load  (D-10 direct-attach)
//   - ...and still HOLDS the carrier relation in the full set             (D-10, relationsToBooking)
//   - a claimed consignee sees their inbound shipment but no economics    (§1.1)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capabilitiesFrom,
  relationToBooking,
  relationsToBooking,
  seesCommercialsOnBooking,
  resolvePersonas,
  type PersonaFacts,
  type PersonaSnapshot,
} from '../src/personas.ts'

const NOBODY: PersonaFacts = {
  driver_id: null,
  fleet_owner_id: null,
  owned_vehicle_count: 0,
  held_driver_count: 0,
  affiliated_fleet_owner_ids: [],
}

const facts = (over: Partial<PersonaFacts>): PersonaFacts => ({ ...NOBODY, ...over })

// ── capability emergence ──────────────────────────────────────────────────────

test('everyone may ship — posting a load is what emerges the persona (D-5)', () => {
  assert.deepEqual(capabilitiesFrom(NOBODY), ['ship'])
})

test('a drivers row grants drive, but not carry without a truck', () => {
  const caps = capabilitiesFrom(facts({ driver_id: 'd1' }))
  assert.ok(caps.includes('drive'))
  assert.ok(!caps.includes('carry'), 'a driver with no truck must not get a load board')
})

test('one owned truck grants carry', () => {
  const caps = capabilitiesFrom(facts({ driver_id: 'd1', owned_vehicle_count: 1 }))
  assert.ok(caps.includes('carry'))
  assert.ok(!caps.includes('operate'), 'one truck alone is not a fleet')
})

test('a SECOND truck emerges the fleet — nothing was configured', () => {
  const one = capabilitiesFrom(facts({ driver_id: 'd1', owned_vehicle_count: 1 }))
  const two = capabilitiesFrom(facts({ driver_id: 'd1', owned_vehicle_count: 2 }))
  assert.ok(!one.includes('operate'))
  assert.ok(two.includes('operate'), 'buying a truck is the only action required')
})

test('holding a driver emerges the fleet even on one truck (attached-vehicle model)', () => {
  const caps = capabilitiesFrom(facts({ fleet_owner_id: 'f1', owned_vehicle_count: 1, held_driver_count: 1 }))
  assert.ok(caps.includes('operate'), 'managing people is running a fleet even if the truck is theirs')
})

test('a fleet owner who holds drivers but owns no truck still operates', () => {
  const caps = capabilitiesFrom(facts({ fleet_owner_id: 'f1', held_driver_count: 3 }))
  assert.ok(caps.includes('operate'))
  assert.ok(!caps.includes('carry'), 'owning no asset means no self-selected work')
})

// ── the rule that changes behaviour ───────────────────────────────────────────

test('OWNER-DRIVER attached to a fleet keeps the marketplace (D-6)', () => {
  // Affiliation ADDS a source of work; it does not replace self-selection. This is the case the
  // old is_fleet_affiliated split got wrong — it hid the load board from anyone with a fleet tie.
  const caps = capabilitiesFrom(
    facts({ driver_id: 'd1', owned_vehicle_count: 1, affiliated_fleet_owner_ids: ['f1'] }),
  )
  assert.ok(caps.includes('carry'), 'owning a truck grants carry regardless of affiliation')
  assert.ok(caps.includes('drive'))
})

test('ASSETLESS fleet driver gets no marketplace — their owner bids for them', () => {
  const caps = capabilitiesFrom(facts({ driver_id: 'd2', affiliated_fleet_owner_ids: ['f1'] }))
  assert.ok(!caps.includes('carry'))
  assert.ok(caps.includes('drive'))
})

test('multi-fleet affiliation is allowed and does not change capability (D-8)', () => {
  const caps = capabilitiesFrom(facts({ driver_id: 'd3', affiliated_fleet_owner_ids: ['f1', 'f2'] }))
  assert.deepEqual(caps.sort(), ['drive', 'ship'])
})

// ── relation to a booking: the "one app, no mode switch" primitive ────────────

const snapshot = (over: Partial<PersonaSnapshot>): PersonaSnapshot => ({
  user_id: 'u1',
  primary_persona: 'driver',
  capabilities: ['ship'],
  driver_id: null,
  fleet_owner_id: null,
  owned_vehicle_count: 0,
  held_driver_count: 0,
  affiliated_fleet_owner_ids: [],
  sees_commercials: false,
  ...over,
})

test('the person who posted the load reads as shipper', () => {
  const rel = relationToBooking({ shipper_id: 'u1' }, snapshot({ user_id: 'u1' }))
  assert.equal(rel, 'shipper')
})

test('direct-attach: shipper wins over carrier on your OWN load (D-10)', () => {
  // The distributor case. They posted it AND their fleet is running it. Whoever is paying sees
  // the paying side — that is the relation with the stronger claim on the screen.
  const rel = relationToBooking(
    { shipper_id: 'u1', fleet_owner_id: 'f1' },
    snapshot({ user_id: 'u1', fleet_owner_id: 'f1' }),
  )
  assert.equal(rel, 'shipper')
})

test('a SOLO driver on their own won booking is the carrier, not staff', () => {
  const rel = relationToBooking(
    { shipper_id: 'someone-else', driver_id: 'd1', fleet_owner_id: null },
    snapshot({ user_id: 'u2', driver_id: 'd1' }),
  )
  assert.equal(rel, 'carrier', 'they bid, they won, they carry the economics')
})

test('a driver on a FLEET-owned booking is staff', () => {
  const rel = relationToBooking(
    { shipper_id: 'someone-else', driver_id: 'd1', fleet_owner_id: 'f9' },
    snapshot({ user_id: 'u2', driver_id: 'd1' }),
  )
  assert.equal(rel, 'driver')
})

test('an unrelated human is an observer', () => {
  const rel = relationToBooking({ shipper_id: 'x', driver_id: 'y' }, snapshot({ user_id: 'z' }))
  assert.equal(rel, 'observer')
})

// ── the FULL relation set: one human, two relations ──────────────────────────
//
// relationToBooking() answers "which view renders". relationsToBooking() answers "what may this
// human do here", and those diverge exactly where the single value has to drop a relation on the
// floor — direct-attach (D-10) being the case the unified app is built around.

test('direct-attach: the distributor is shipper AND carrier, both (D-10)', () => {
  const rels = relationsToBooking(
    { shipper_id: 'u1', fleet_owner_id: 'f1' },
    snapshot({ user_id: 'u1', fleet_owner_id: 'f1' }),
  )
  assert.deepEqual(rels, ['shipper', 'carrier'], 'the carrier relation must survive, not be shadowed')
})

test('a SOLO driver holds carrier, not driver — the assignment IS the win', () => {
  const rels = relationsToBooking(
    { shipper_id: 'someone-else', driver_id: 'd1', fleet_owner_id: null },
    snapshot({ user_id: 'u2', driver_id: 'd1' }),
  )
  assert.deepEqual(rels, ['carrier'], 'nobody stands between them and the load; there is no staff relation')
})

test('a FLEET-EMPLOYED driver holds driver only', () => {
  const rels = relationsToBooking(
    { shipper_id: 'someone-else', driver_id: 'd1', fleet_owner_id: 'f9' },
    snapshot({ user_id: 'u2', driver_id: 'd1' }),
  )
  assert.deepEqual(rels, ['driver'])
})

test('a fleet owner driving their own truck is carrier AND driver', () => {
  const rels = relationsToBooking(
    { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f1' },
    snapshot({ user_id: 'u2', driver_id: 'd1', fleet_owner_id: 'f1' }),
  )
  assert.deepEqual(rels, ['carrier', 'driver'])
})

test('a CLAIMED consignee sees their inbound shipment', () => {
  const rels = relationsToBooking({ shipper_id: 's', consignee_user_id: 'u4' }, snapshot({ user_id: 'u4' }))
  assert.deepEqual(rels, ['consignee'])
})

test('an UNCLAIMED consignee has no relation — they have no session to resolve', () => {
  // The common case: a name and a phone, no login. Their access path is the POD OTP (D-13), so the
  // absence of a users.id must read as "no relation", never as an unmatched-everything wildcard.
  const rels = relationsToBooking(
    { shipper_id: 's', consignee_user_id: null },
    snapshot({ user_id: 'u4', driver_id: null, fleet_owner_id: null }),
  )
  assert.deepEqual(rels, [])
})

test('an unrelated human holds NO relations — the empty set is observer', () => {
  const rels = relationsToBooking({ shipper_id: 'x', driver_id: 'y' }, snapshot({ user_id: 'z' }))
  assert.deepEqual(rels, [], "'observer' is the absence of a relation, not a member of the set")
})

test('the shipper who is also the consignee holds both', () => {
  // Stock transfer: same business posts the load and receives it at its own warehouse.
  const rels = relationsToBooking(
    { shipper_id: 'u1', consignee_user_id: 'u1' },
    snapshot({ user_id: 'u1' }),
  )
  assert.deepEqual(rels, ['shipper', 'consignee'])
})

// ── regression: the single-value picker is unchanged ─────────────────────────

test('relationToBooking still returns exactly what it returned before the set existed', () => {
  // relationToBooking() is now relationsToBooking()[0]. Every caller in every service depends on
  // this truth table, so it is pinned as a table rather than as prose.
  const cases: Array<[string, Parameters<typeof relationToBooking>[0], PersonaSnapshot, string]> = [
    ['poster', { shipper_id: 'u1' }, snapshot({ user_id: 'u1' }), 'shipper'],
    [
      'direct-attach',
      { shipper_id: 'u1', fleet_owner_id: 'f1' },
      snapshot({ user_id: 'u1', fleet_owner_id: 'f1' }),
      'shipper',
    ],
    [
      'fleet that won it',
      { shipper_id: 's', fleet_owner_id: 'f1' },
      snapshot({ user_id: 'u2', fleet_owner_id: 'f1' }),
      'carrier',
    ],
    [
      'solo driver',
      { shipper_id: 's', driver_id: 'd1', fleet_owner_id: null },
      snapshot({ user_id: 'u2', driver_id: 'd1' }),
      'carrier',
    ],
    [
      'fleet-employed driver',
      { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f9' },
      snapshot({ user_id: 'u2', driver_id: 'd1' }),
      'driver',
    ],
    [
      'fleet owner driving their own truck',
      { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f1' },
      snapshot({ user_id: 'u2', driver_id: 'd1', fleet_owner_id: 'f1' }),
      'carrier',
    ],
    ['stranger', { shipper_id: 'x', driver_id: 'y' }, snapshot({ user_id: 'z' }), 'observer'],
    [
      'claimed consignee',
      { shipper_id: 's', consignee_user_id: 'u4' },
      snapshot({ user_id: 'u4' }),
      'consignee',
    ],
  ]

  for (const [label, booking, snap, expected] of cases) {
    assert.equal(relationToBooking(booking, snap), expected, label)
  }
})

// ── commercial visibility follows OWNERSHIP, not affiliation (§1.1) ───────────

test('shipper sees their own freight', () => {
  assert.ok(seesCommercialsOnBooking({ shipper_id: 'u1' }, snapshot({ user_id: 'u1' }), false))
})

test('assetless fleet driver is MASKED on a fleet booking (unchanged)', () => {
  const sees = seesCommercialsOnBooking(
    { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f9' },
    snapshot({ user_id: 'u2', driver_id: 'd1' }),
    false, // does not own the truck
  )
  assert.equal(sees, false, 'an employee does not see the fleet margin')
})

test('OWNER-DRIVER on a fleet booking SEES the money — this is the behaviour change (§1.1)', () => {
  const sees = seesCommercialsOnBooking(
    { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f9', vehicle_id: 'v1' },
    snapshot({ user_id: 'u2', driver_id: 'd1', owned_vehicle_count: 1 }),
    true, // it is THEIR truck under the fleet's booking
  )
  assert.equal(sees, true, 'they carry the cost and the risk, so they are a stakeholder')
})

test('owning SOME truck does not unmask a booking run on someone else\'s', () => {
  const sees = seesCommercialsOnBooking(
    { shipper_id: 's', driver_id: 'd1', fleet_owner_id: 'f9', vehicle_id: 'v-other' },
    snapshot({ user_id: 'u2', driver_id: 'd1', owned_vehicle_count: 4 }),
    false, // this particular trip is on the fleet's truck
  )
  assert.equal(sees, false, 'visibility is per-asset, not a global flag')
})

test('a consignee does NOT see carrier economics', () => {
  // They may owe the freight on a To Pay consignment, but what they are owed-and-shown is a
  // per-document disclosure on the LR/invoice — not the carrier's margin on the booking.
  const sees = seesCommercialsOnBooking(
    { shipper_id: 's', consignee_user_id: 'u4', fleet_owner_id: 'f9' },
    snapshot({ user_id: 'u4' }),
    true, // even claiming to own a truck must not unmask them here
  )
  assert.equal(sees, false)
})

test('a shipper who is also the consignee still sees their own freight', () => {
  // The granting relation must not be shadowed by the weaker one it shares the booking with.
  const sees = seesCommercialsOnBooking(
    { shipper_id: 'u1', consignee_user_id: 'u1' },
    snapshot({ user_id: 'u1' }),
    false,
  )
  assert.equal(sees, true)
})

test('an observer never sees freight', () => {
  assert.equal(seesCommercialsOnBooking({ shipper_id: 'x' }, snapshot({ user_id: 'z' }), true), false)
})

// ── resolvePersonas against a PostgREST double ───────────────────────────────

/**
 * Minimal PostgREST double. Only the chain shapes resolvePersonas actually builds are modelled;
 * an unexpected table throws loudly rather than quietly returning undefined and passing a test
 * for the wrong reason.
 */
function makeSupabase(rows: {
  drivers?: { id: string; user_id: string }[]
  fleet_owners?: { id: string; user_id: string }[]
  vehicles?: { id: string; driver_id?: string | null; fleet_owner_id?: string | null }[]
  fleet_drivers?: { id: string; driver_id: string; fleet_owner_id: string; status: string }[]
}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    drivers: rows.drivers ?? [],
    fleet_owners: rows.fleet_owners ?? [],
    vehicles: rows.vehicles ?? [],
    fleet_drivers: rows.fleet_drivers ?? [],
  }

  function from(table: string) {
    if (!(table in tables)) throw new Error(`unexpected table in query: ${table}`)
    let rowset = tables[table]
    let headMode = false
    const builder: any = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) headMode = true
        return builder
      },
      eq: (col: string, val: unknown) => {
        rowset = rowset.filter(r => r[col] === val)
        return builder
      },
      in: (col: string, vals: unknown[]) => {
        rowset = rowset.filter(r => vals.includes(r[col] as string))
        return builder
      },
      maybeSingle: () => Promise.resolve({ data: rowset[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          headMode
            ? { data: null, count: rowset.length, error: null }
            : { data: rowset, count: rowset.length, error: null },
        ).then(resolve),
    }
    return builder
  }
  return { from } as never
}

test('resolvePersonas: solo owner-driver', async () => {
  const db = makeSupabase({
    drivers: [{ id: 'd1', user_id: 'u1' }],
    vehicles: [{ id: 'v1', driver_id: 'd1' }],
  })
  const snap = await resolvePersonas(db, 'u1', 'driver')
  assert.equal(snap.driver_id, 'd1')
  assert.equal(snap.owned_vehicle_count, 1)
  assert.ok(snap.capabilities.includes('carry'))
  assert.equal(snap.sees_commercials, true)
})

test('resolvePersonas: the distributor — ships AND runs a fleet', async () => {
  const db = makeSupabase({
    fleet_owners: [{ id: 'f1', user_id: 'u9' }],
    vehicles: [
      { id: 'v1', fleet_owner_id: 'f1' },
      { id: 'v2', fleet_owner_id: 'f1' },
    ],
    fleet_drivers: [{ id: 'fd1', driver_id: 'd7', fleet_owner_id: 'f1', status: 'active' }],
  })
  const snap = await resolvePersonas(db, 'u9', 'shipper')
  assert.equal(snap.fleet_owner_id, 'f1')
  assert.equal(snap.owned_vehicle_count, 2)
  assert.equal(snap.held_driver_count, 1)
  assert.deepEqual(snap.capabilities.sort(), ['carry', 'operate', 'ship'])
  assert.equal(snap.primary_persona, 'shipper', 'primary decides where emailed links land, nothing else')
})

test('resolvePersonas: assetless fleet driver, affiliated to two fleets', async () => {
  const db = makeSupabase({
    drivers: [{ id: 'd5', user_id: 'u5' }],
    fleet_drivers: [
      { id: 'fd1', driver_id: 'd5', fleet_owner_id: 'f1', status: 'active' },
      { id: 'fd2', driver_id: 'd5', fleet_owner_id: 'f2', status: 'pending' },
      { id: 'fd3', driver_id: 'd5', fleet_owner_id: 'f3', status: 'left' },
    ],
  })
  const snap = await resolvePersonas(db, 'u5', 'driver')
  assert.deepEqual(snap.affiliated_fleet_owner_ids.sort(), ['f1', 'f2'], 'left affiliations are not live')
  assert.ok(!snap.capabilities.includes('carry'))
  assert.equal(snap.sees_commercials, false)
})

test('resolvePersonas: a brand-new user can still ship', async () => {
  const snap = await resolvePersonas(makeSupabase({}), 'u-new', 'shipper')
  assert.deepEqual(snap.capabilities, ['ship'])
  assert.equal(snap.driver_id, null)
  assert.equal(snap.fleet_owner_id, null)
})
