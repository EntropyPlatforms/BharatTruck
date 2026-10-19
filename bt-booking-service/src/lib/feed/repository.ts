// ============================================================
// src/lib/feed/repository.ts
//
// The reads GET /me/feed aggregates. Every query is SCOPED BY THE CALLER'S OWN
// IDENTITY — a users.id, a drivers.id, or a fleet_owners.id resolved from the
// caller's PersonaSnapshot — never by an id taken from the request. That is the
// no-cross-user-leak guarantee at the data layer: a source physically cannot
// return another human's private rows because the only id it filters on is the
// caller's own.
//
// These are NEW queries because the feed asks questions no existing repository
// method answers: "live bids across ALL of my loads", "my countered bids", "my
// fleet loads with no truck yet". Where an existing query already fits — a
// driver's active trips (repository.getActiveBookingsForDriver), whether a
// booking has a live vehicle pairing (fleet.hasLiveVehicleAssignment) — the
// service reuses it rather than re-implementing it here.
//
// Errors THROW; they are NOT softened to empty. Graceful degradation is the
// SERVICE's job (it wraps each source), so a broken source degrades the feed to a
// partial one — but a source that silently swallowed its own error would hide a
// real outage behind an innocent-looking empty section. The one exception is the
// marketplace board's public visibility, which is intrinsic to the query, not an
// error path.
// ============================================================

import { supabase } from '../supabase.js'
import type { DbBooking, DbQuote } from '../types.js'

// The open marketplace board is large; cap what one home render pulls. Pagination
// over the MERGED feed happens in the service — this only bounds the single
// noisiest source so it cannot dominate the round-trip at pilot scale.
const OPEN_WORK_LIMIT = 25

// -----------------------------------------------------------
// listActivePostedLoads — the caller's OWN loads still collecting bids
// (pending | negotiating). The anchor for the shipper's "N bids on X" rows:
// bids are read against THESE booking ids, so a bid on someone else's load can
// never be counted here.
// -----------------------------------------------------------

export async function listActivePostedLoads(shipperUserId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('shipper_id', shipperUserId)
    .in('status', ['pending', 'negotiating'])
    .order('created_at', { ascending: false })

  if (error) throw new Error(`DB feed posted-loads lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listLiveQuotesForBookings — live bids (submitted | countered) on a set of the
// caller's OWN bookings. The feed needs only the count and recency per load, not
// the amounts, so this is deliberately blind to price. Empty ids short-circuits
// so a shipper with no open loads makes no quotes query at all.
// -----------------------------------------------------------

export async function listLiveQuotesForBookings(bookingIds: string[]): Promise<DbQuote[]> {
  if (bookingIds.length === 0) return []
  const { data, error } = await supabase
    .from('quotes')
    .select('*')
    .in('booking_id', bookingIds)
    .in('status', ['submitted', 'countered'])

  if (error) throw new Error(`DB feed live-quotes lookup failed: ${error.message}`)
  return (data ?? []) as DbQuote[]
}

// -----------------------------------------------------------
// listShipperLoadsNeedingReceiver — the caller's in-transit loads that name no
// receiver inbox. Without one the driver's POD request has nowhere to send the
// code, so the trip dead-ends short of 'completed' and the payout it gates never
// happens (see service.setReceiverEmail). This is the shipper's most urgent
// action, and the ONLY party who can fix it.
// -----------------------------------------------------------

export async function listShipperLoadsNeedingReceiver(shipperUserId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('shipper_id', shipperUserId)
    .eq('status', 'in_transit')
    .is('receiver_email', null)

  if (error) throw new Error(`DB feed receiver-needed lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listShipperLoadsAwaitingPayment — the caller's posted loads that have been DELIVERED
// ('completed') and not yet paid. 'completed' is exactly the state the payment routes
// accept, so every row here is one the shipper can settle right now; a paid trip moves
// to 'paid' and drops out on its own. Capped: a shipper far behind on payments gets the
// most recent deliveries, not an unbounded list.
// -----------------------------------------------------------

export async function listShipperLoadsAwaitingPayment(shipperUserId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('shipper_id', shipperUserId)
    .eq('status', 'completed')
    .order('updated_at', { ascending: false })
    .limit(OPEN_WORK_LIMIT)

  if (error) throw new Error(`DB feed payment-due lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listOpenWork — the open marketplace board, MINUS the caller's own loads.
//
// This is the ONE source whose rows are not the caller's private property: the
// pending board is public to every carrier by design (it is the same set
// repository.listBookings already returns to a driver/fleet caller), and a
// carrier browsing it is exactly what bidding is. It is NOT a leak — it carries no
// other human's private state, only loads posted TO the market. Own loads are
// excluded because you attach your own load with your own truck (D-10), you do not
// bid on it.
// -----------------------------------------------------------

export async function listOpenWork(excludeShipperUserId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'pending')
    .neq('shipper_id', excludeShipperUserId)
    .order('created_at', { ascending: false })
    .limit(OPEN_WORK_LIMIT)

  if (error) throw new Error(`DB feed open-work lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listCounteredBidsForBidder — the caller's OWN bids the shipper has countered.
//
// A quote is owned by a driver_id XOR a fleet_owner_id (the
// quotes_exactly_one_bidder invariant). A human can hold BOTH identities (an
// owner-driver who also runs a fleet), so this matches either, and dedups by
// quote id in case a future schema ever lets a row carry both. Only 'countered'
// bids surface: an ACCEPTED bid is already represented elsewhere (a solo win
// becomes the driver's own trip row, a fleet win becomes a truck-assignment row),
// so re-surfacing it here would double the same load in the feed.
// -----------------------------------------------------------

export async function listCounteredBidsForBidder(
  driverId: string | null,
  fleetOwnerId: string | null,
): Promise<DbQuote[]> {
  const out: DbQuote[] = []
  const seen = new Set<string>()

  for (const [column, value] of [
    ['driver_id', driverId],
    ['fleet_owner_id', fleetOwnerId],
  ] as const) {
    if (!value) continue
    const { data, error } = await supabase
      .from('quotes')
      .select('*')
      .eq('status', 'countered')
      .eq(column, value)

    if (error) throw new Error(`DB feed countered-bids lookup failed: ${error.message}`)
    for (const q of (data ?? []) as DbQuote[]) {
      if (!seen.has(q.id)) { seen.add(q.id); out.push(q) }
    }
  }
  return out
}

// -----------------------------------------------------------
// getBookingsByIds — hydrate the route (source/destination) for rows anchored on
// a quote, which carries no address of its own. Ids come only from the caller's
// own quotes above, so this discloses nothing they could not already read.
// -----------------------------------------------------------

export async function getBookingsByIds(ids: string[]): Promise<DbBooking[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .in('id', ids)

  if (error) throw new Error(`DB feed bookings-by-id lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listFleetBookingsAwaitingTruck — the caller's fleet-won loads that are
// 'accepted' but not yet paired to a truck. The service filters these against
// hasLiveVehicleAssignment; this only narrows to the fleet's own accepted loads so
// that per-booking check runs over a handful of rows, not the whole table.
// -----------------------------------------------------------

export async function listFleetBookingsAwaitingTruck(fleetOwnerId: string): Promise<DbBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('status', 'accepted')

  if (error) throw new Error(`DB feed fleet-awaiting-truck lookup failed: ${error.message}`)
  return (data ?? []) as DbBooking[]
}

// -----------------------------------------------------------
// listActiveFleetDrivers — drivers holding a LIVE ('active') seat under the
// caller's fleet. The service keeps only recently-responded ones (a months-old
// accept is not "needs you now") using responded_at, which fleet_drivers stamps
// when the invite is answered.
// -----------------------------------------------------------

export type FleetDriverSeat = {
  id: string
  driver_id: string
  responded_at: string | null
  updated_at: string
  status: string
}

export async function listActiveFleetDrivers(fleetOwnerId: string): Promise<FleetDriverSeat[]> {
  const { data, error } = await supabase
    .from('fleet_drivers')
    .select('id, driver_id, responded_at, updated_at, status')
    .eq('fleet_owner_id', fleetOwnerId)
    .eq('status', 'active')

  if (error) throw new Error(`DB feed fleet-drivers lookup failed: ${error.message}`)
  return (data ?? []) as FleetDriverSeat[]
}

// -----------------------------------------------------------
// driverNamesByIds — resolve drivers.id -> user full_name for the "X joined your
// fleet" rows. One embedded read, not a query per driver. A name that cannot be
// resolved (a driver whose user has none on file) comes back as null and the
// service falls back to a generic label rather than dropping the row.
// -----------------------------------------------------------

export async function driverNamesByIds(driverIds: string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  if (driverIds.length === 0) return names

  const { data, error } = await supabase
    .from('drivers')
    .select('id, user:users!drivers_user_id_fkey ( full_name )')
    .in('id', driverIds)

  if (error) throw new Error(`DB feed driver-names lookup failed: ${error.message}`)
  // PostgREST types an embedded to-one as an array; the FK is single-valued, so
  // normalise either shape (object or 1-element array) to the one name. Cast via
  // unknown, the same widening quote-repository uses for its carrier embed.
  for (const row of (data ?? []) as unknown as Array<{ id: string; user?: { full_name: string | null } | Array<{ full_name: string | null }> | null }>) {
    const u = Array.isArray(row.user) ? row.user[0] : row.user
    names.set(row.id, u?.full_name ?? null)
  }
  return names
}
