/**
 * Tracking authorization tests — the relation-based decision that replaced the role switch.
 *
 * These pin two things the refactor must not get wrong:
 *   1. REGRESSION: every allow/deny a single-persona user got under the old `role` switch is
 *      unchanged. A shipper sees their own booking and not a stranger's; an assigned driver sees
 *      their trip; an unrelated viewer is refused. Those users each hold one relation, so the old
 *      role check and the new relation check must agree for them.
 *   2. NEW: a claimed consignee may track their inbound load — but only while the trip is ACTIVE
 *      (D-25), and never before dispatch or after close.
 *
 * `relationsToBooking` (shared, already tested) + `relationGrantsTracking` (here) are the exact
 * relation decision assertCanAccess makes before it falls through to the async fleet-reach test;
 * the fleet reach itself is canFleetAccessBooking's contract and is tested with the shared helper.
 * Both functions are pure, so no database or env is needed.
 *
 * Run: npx tsx test/access.test.mts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relationsToBooking, type PersonaSnapshot, type ViewerBooking } from '@bharattruck/shared/personas'
import { relationGrantsTracking, CONSIGNEE_TRACKABLE_STATUSES } from '../src/lib/access.js'

// A snapshot with everything at its "owns nothing" default; each test overrides only the one or
// two facts it is about, so a scenario reads as exactly its distinguishing feature.
function snapshot(over: Partial<PersonaSnapshot> = {}): PersonaSnapshot {
  return {
    user_id: 'user-self',
    primary_persona: 'shipper',
    capabilities: ['ship'],
    driver_id: null,
    fleet_owner_id: null,
    owned_vehicle_count: 0,
    held_driver_count: 0,
    affiliated_fleet_owner_ids: [],
    sees_commercials: false,
    ...over,
  }
}

// assertCanAccess builds this ViewerBooking WITHOUT fleet_owner_id on purpose: the fleet columns
// stay off the shipper/driver hot path, and fleet reach is handled by the async helper. Mirror
// that here so the test decides on the same inputs the route does.
function viewer(over: Partial<ViewerBooking> = {}): ViewerBooking {
  return { shipper_id: 'someone-else', driver_id: null, consignee_user_id: null, ...over }
}

const grants = (b: ViewerBooking, s: PersonaSnapshot, status: string) =>
  relationGrantsTracking(relationsToBooking(b, s), status)

// ── regression: shipper ──────────────────────────────────────────────────────

test('shipper reads their OWN booking, at any status', () => {
  const s = snapshot({ user_id: 'ship-A' })
  const b = viewer({ shipper_id: 'ship-A' })
  assert.equal(grants(b, s, 'pending'), true)
  assert.equal(grants(b, s, 'in_transit'), true)
  assert.equal(grants(b, s, 'paid'), true)
})

test("shipper is refused a stranger's booking by relation (falls through to fleet reach)", () => {
  const s = snapshot({ user_id: 'ship-A' })
  const b = viewer({ shipper_id: 'ship-B' })
  // No relation grants → the route then tries fleet reach, and a shipper has no fleet, so this
  // is the old 403. The relation decision itself must be false.
  assert.equal(relationsToBooking(b, s).length, 0)
  assert.equal(grants(b, s, 'in_transit'), false)
})

// ── regression: driver ───────────────────────────────────────────────────────

test('assigned solo driver reads their trip', () => {
  const s = snapshot({ primary_persona: 'driver', capabilities: ['ship'], driver_id: 'drv-1' })
  const b = viewer({ driver_id: 'drv-1' })
  assert.equal(grants(b, s, 'in_transit'), true)
})

test('a driver assigned to nothing on this booking is refused', () => {
  const s = snapshot({ primary_persona: 'driver', driver_id: 'drv-1' })
  const b = viewer({ driver_id: 'drv-2' })
  assert.equal(grants(b, s, 'in_transit'), false)
})

test('a caller with no driver profile never matches the driver slot', () => {
  // driver_id null on both sides must not collide into a match — the ViewerBooking driver_id is
  // also null on an unassigned booking, and null === null would be a cross-tenant leak.
  const s = snapshot({ user_id: 'ship-A', driver_id: null })
  const b = viewer({ shipper_id: 'ship-B', driver_id: null })
  assert.equal(grants(b, s, 'in_transit'), false)
})

// ── new: consignee, scoped to an active trip (D-25) ──────────────────────────

test('a claimed consignee reads their inbound trip while it is ACTIVE', () => {
  const s = snapshot({ user_id: 'rcv-1' })
  const b = viewer({ shipper_id: 'ship-A', consignee_user_id: 'rcv-1' })
  for (const status of CONSIGNEE_TRACKABLE_STATUSES) {
    assert.equal(grants(b, s, status), true, `consignee should see an ${status} trip`)
  }
})

test('a consignee is refused a trip that has not dispatched or is already closed', () => {
  const s = snapshot({ user_id: 'rcv-1' })
  const b = viewer({ shipper_id: 'ship-A', consignee_user_id: 'rcv-1' })
  // Relation IS present — the refusal is purely the status scope, not a missing relation.
  assert.ok(relationsToBooking(b, s).includes('consignee'))
  for (const status of ['pending', 'accepted_pending', 'completed', 'paid', 'cancelled']) {
    assert.equal(grants(b, s, status), false, `consignee must not see a '${status}' trip`)
  }
})

test('an unclaimed consignee (null user id) has no relation and no access', () => {
  const s = snapshot({ user_id: 'rcv-1' })
  const b = viewer({ shipper_id: 'ship-A', consignee_user_id: null })
  assert.equal(grants(b, s, 'in_transit'), false)
})

// ── new: a shipper who is also the consignee keeps unconditional shipper access ──

test('the stronger relation wins: shipper+consignee reads even a closed trip', () => {
  // Under direct-attach a party can hold two relations; the shipper claim is unconditional and
  // must not be narrowed to the consignee's active-only scope.
  const s = snapshot({ user_id: 'ship-A' })
  const b = viewer({ shipper_id: 'ship-A', consignee_user_id: 'ship-A' })
  assert.deepEqual(relationsToBooking(b, s), ['shipper', 'consignee'])
  assert.equal(grants(b, s, 'paid'), true)
})

// ── an unrelated observer is always refused ──────────────────────────────────

test('an unrelated viewer is refused', () => {
  const s = snapshot({ user_id: 'nobody' })
  const b = viewer({ shipper_id: 'ship-A', driver_id: 'drv-9', consignee_user_id: 'rcv-9' })
  assert.equal(relationsToBooking(b, s).length, 0)
  assert.equal(grants(b, s, 'in_transit'), false)
})

// ── the pure predicate, on synthetic relation sets ───────────────────────────

test('relationGrantsTracking: carrier and driver grant unconditionally, consignee is scoped', () => {
  assert.equal(relationGrantsTracking(['carrier'], 'paid'), true)
  assert.equal(relationGrantsTracking(['driver'], 'pending'), true)
  assert.equal(relationGrantsTracking(['consignee'], 'in_transit'), true)
  assert.equal(relationGrantsTracking(['consignee'], 'pending'), false)
  assert.equal(relationGrantsTracking([], 'in_transit'), false)
})

test('the consignee-trackable set matches bt-booking-service ACTIVE_TRIP_STATUSES', () => {
  // If the ingester's active set moves, this must move with it — a consignee shown a tracking
  // screen for a status that never has GPS is a screen that can only be empty.
  assert.deepEqual(CONSIGNEE_TRACKABLE_STATUSES, ['accepted', 'in_transit', 'delivery_asserted'])
})
