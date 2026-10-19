// Tenant-isolation tests for canFleetAccessBooking.
//
// This helper is the single gate protecting one fleet's trips from another's, and
// bt-tracking-service gates /route, /eta and /track on it. A regression here is a
// cross-tenant data leak, not a bug report — so the cross-tenant cases are pinned
// explicitly rather than left implied by the happy path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canFleetAccessBooking } from '../src/fleet.ts'

const FLEET_X = 'fleet-x'
const FLEET_Y = 'fleet-y'
const DRIVER_D = 'driver-d'

/**
 * Minimal PostgREST double. Only the chain shapes canFleetAccessBooking actually
 * builds are modelled; anything else throws loudly rather than quietly returning
 * undefined and passing a test for the wrong reason.
 */
function makeSupabase(rows: {
  vehicles?: { id: string; fleet_owner_id: string }[]
  vehicle_assignments?: { id: string; booking_id: string; fleet_owner_id: string }[]
  fleet_drivers?: { driver_id: string; fleet_owner_id: string; status: string }[]
}) {
  const tables = {
    vehicles: rows.vehicles ?? [],
    vehicle_assignments: rows.vehicle_assignments ?? [],
    fleet_drivers: rows.fleet_drivers ?? [],
  } as Record<string, Record<string, unknown>[]>

  function from(table: string) {
    if (!(table in tables)) throw new Error(`unexpected table in query: ${table}`)
    let rowset = tables[table]
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        rowset = rowset.filter(r => r[col] === val)
        return builder
      },
      in: (col: string, vals: unknown[]) => {
        rowset = rowset.filter(r => vals.includes(r[col] as string))
        return builder
      },
      order: () => builder,
      limit: (n: number) => {
        rowset = rowset.slice(0, n)
        return builder
      },
      maybeSingle: async () => ({ data: rowset[0] ?? null, error: null }),
      single: async () => ({ data: rowset[0] ?? null, error: null }),
      then: undefined,
    }
    return builder
  }

  return { from } as never
}

test('grants when the fleet won the auction', async () => {
  const supabase = makeSupabase({})
  const ok = await canFleetAccessBooking(supabase, FLEET_X, {
    id: 'b1', fleet_owner_id: FLEET_X, vehicle_id: null, driver_id: null,
  })
  assert.equal(ok, true)
})

test('grants when the fleet\'s own truck ran it', async () => {
  const supabase = makeSupabase({ vehicles: [{ id: 'veh-1', fleet_owner_id: FLEET_X }] })
  const ok = await canFleetAccessBooking(supabase, FLEET_X, {
    id: 'b2', fleet_owner_id: null, vehicle_id: 'veh-1', driver_id: null,
  })
  assert.equal(ok, true)
})

test('grants on a released assignment — history stays visible after a driver leaves', async () => {
  const supabase = makeSupabase({
    vehicle_assignments: [{ id: 'a1', booking_id: 'b3', fleet_owner_id: FLEET_X }],
  })
  const ok = await canFleetAccessBooking(supabase, FLEET_X, {
    id: 'b3', fleet_owner_id: null, vehicle_id: null, driver_id: DRIVER_D,
  })
  assert.equal(ok, true)
})

test('grants an UNOWNED booking to the fleet the driver now belongs to', async () => {
  // The case the driver-affiliation clause exists for: a solo driver won this
  // trip themselves (no owning fleet), then joined a fleet.
  const supabase = makeSupabase({
    fleet_drivers: [{ driver_id: DRIVER_D, fleet_owner_id: FLEET_Y, status: 'active' }],
  })
  const ok = await canFleetAccessBooking(supabase, FLEET_Y, {
    id: 'b4', fleet_owner_id: null, vehicle_id: null, driver_id: DRIVER_D,
  })
  assert.equal(ok, true)
})

test('REGRESSION: hiring another fleet\'s driver must NOT expose that fleet\'s trips', async () => {
  // Booking b5 belongs to fleet X and was run by driver D on X's truck.
  // D leaves X and joins fleet Y — reachable through shipped routes, because the
  // one-live-affiliation index is partial over ('pending','active') and leaving is
  // a soft status change.
  //
  // Y must NOT be able to read X's trip. Before the fix the driver-affiliation
  // clause carried no owner filter and returned true here, leaking X's route
  // polyline, distance, status and destination coordinates through
  // GET /api/tracking/track/:id.
  const supabase = makeSupabase({
    fleet_drivers: [{ driver_id: DRIVER_D, fleet_owner_id: FLEET_Y, status: 'active' }],
  })
  const leaked = await canFleetAccessBooking(supabase, FLEET_Y, {
    id: 'b5', fleet_owner_id: FLEET_X, vehicle_id: 'veh-x', driver_id: DRIVER_D,
  })
  assert.equal(leaked, false, 'fleet Y must not access fleet X\'s booking via a hired driver')
})

test('denies a stranger fleet with no vehicle, assignment or affiliation', async () => {
  const supabase = makeSupabase({})
  const ok = await canFleetAccessBooking(supabase, FLEET_Y, {
    id: 'b6', fleet_owner_id: FLEET_X, vehicle_id: 'veh-x', driver_id: DRIVER_D,
  })
  assert.equal(ok, false)
})

test('a PENDING affiliation is not enough — the driver has not accepted yet', async () => {
  const supabase = makeSupabase({
    fleet_drivers: [{ driver_id: DRIVER_D, fleet_owner_id: FLEET_Y, status: 'pending' }],
  })
  const ok = await canFleetAccessBooking(supabase, FLEET_Y, {
    id: 'b7', fleet_owner_id: null, vehicle_id: null, driver_id: DRIVER_D,
  })
  assert.equal(ok, false)
})
