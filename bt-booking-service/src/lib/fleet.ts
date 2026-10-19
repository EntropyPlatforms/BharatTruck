// ============================================================
// src/lib/fleet.ts
//
// Responsibility: everything bt-booking-service needs to know about the
// fleet-owner persona — who is bidding, whether a driver is fleet-controlled,
// and whether an awarded fleet booking has a truck+driver bound to it yet.
// The fleet's own CRUD (roster, vehicles, assignment) lives in bt-fleet-service;
// this file only answers the questions the booking flow has to ask.
//
// DESIGN RULE for this whole slice: a booking or driver with NO fleet
// involvement must take the code path it took before the persona existed. The
// fleet tables are consulted only to answer "is this actor fleet-controlled?",
// and a database where migrations 0015/0016 have not landed yet answers "no"
// rather than failing the request — the migrations are additive and may deploy
// after this code does.
//
// IDENTITY: fleet_owners.user_id references users.id (the JWT `userId`), while
// fleet_drivers.driver_id references drivers.id — a DIFFERENT row from users.id.
// ============================================================

import { can, resolvePersonas, type PersonaSnapshot } from '@bharattruck/shared/personas'
import { supabase } from './supabase.js'
import type { AuthenticatedUser, DbBooking, DbQuote } from './types.js'
import { BookingError } from './types.js'

// -----------------------------------------------------------
// Missing-relation tolerance. PostgREST reports an unknown table as 42P01
// (Postgres) or PGRST205 (schema-cache miss). Treating that as "the fleet
// feature is not deployed here" is what lets a solo driver's request behave
// identically on a pre-0015 database instead of 500ing on a table lookup.
// Every OTHER DB error still propagates, exactly like the other repositories.
// -----------------------------------------------------------

const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205'])

function isMissingRelation(error: { code?: string } | null): boolean {
  return !!error?.code && MISSING_RELATION_CODES.has(error.code)
}

// -----------------------------------------------------------
// Bidder — who is behind a quote. Mirrors the DB invariant
// `num_nonnulls(quotes.driver_id, quotes.fleet_owner_id) = 1`: a bid is from a
// solo driver OR a fleet, never both, never neither.
// -----------------------------------------------------------

export type Bidder =
  | { kind: 'driver'; driverId: string }
  | { kind: 'fleet';  fleetOwnerId: string }

// -----------------------------------------------------------
// getFleetOwnerByUserId
// Bridge: the JWT gives us users.id; every fleet column stores fleet_owners.id.
// -----------------------------------------------------------

export async function getFleetOwnerByUserId(userId: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('fleet_owners')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`Fleet owner lookup failed: ${error.message}`)
  }
  return data
}

// -----------------------------------------------------------
// bidderIsRelatedParty — the ORG half of the self-bid rule (review C-1).
//
// The self-bid guard refuses the posting ACCOUNT; this refuses the posting
// party's own crew. An owner-driver whose truck is ATTACHED to the fleet that
// posted a load holds 'carry' and is not the booking's shipper, so every other
// guard passes — yet a fleet bidding on itself through its own attached driver
// is the same fictional auction with one hop of indirection: the fleet owner
// dispatches that truck by direct-attach + assignment, never by out-bidding
// outsiders on their own load.
//
// Pure — the caller supplies the bidder's affiliations (already on the
// PersonaSnapshot) and the posting party's fleet id (one indexed lookup via
// getFleetOwnerByUserId) — so the rule is unit-testable without a database.
// -----------------------------------------------------------

export function bidderIsRelatedParty(
  affiliatedFleetOwnerIds: readonly string[],
  posterFleetOwnerId: string | null,
): boolean {
  return posterFleetOwnerId != null && affiliatedFleetOwnerIds.includes(posterFleetOwnerId)
}

// -----------------------------------------------------------
// bidderFromSnapshot
// Which of the caller's own carrier identities BIDS: their fleet if they run
// one, otherwise their own truck. This is authorization on CAPABILITY, not on
// the JWT role string (D-27) — a 'shipper'-role human who owns a truck resolves
// to a driver bidder, and a 'fleet_owner'-role human who owns none resolves to
// null (nothing to bid with). null means "cannot carry", the FORBIDDEN case.
//
// Fleet takes precedence when the human is both. The gate is marketplace access
// (`carry` = owns ≥1 truck) OR fleet-business access (`operate` = 2+ trucks or
// held drivers) — NOT `operate` alone. Bidding is a `carry` act in the locked
// capability model (ARCHITECTURE_UNIFIED_IDENTITY §3 / UNIFIED_APP_PLAN); gating
// on `operate` locked one-truck fleets and distributors out of auctions they can
// already see on the board (Deepak: 1 truck → carry, no operate → FORBIDDEN).
// `operate` without `carry` still qualifies so an attached-vehicle fleet that
// holds drivers but owns no truck can bid and assign.
//
// This is the same rule directAttachCarrier applies to a shipper attaching their
// own load, and the two MUST agree — service.ts's directAttachCarrier delegates
// here so there is one implementation of "which of my carriers acts".
// -----------------------------------------------------------

export function bidderFromSnapshot(snapshot: PersonaSnapshot): Bidder | null {
  if (snapshot.fleet_owner_id && (can(snapshot, 'carry') || can(snapshot, 'operate'))) {
    return { kind: 'fleet', fleetOwnerId: snapshot.fleet_owner_id }
  }
  if (snapshot.driver_id && can(snapshot, 'carry')) {
    return { kind: 'driver', driverId: snapshot.driver_id }
  }
  return null
}

// -----------------------------------------------------------
// resolveBidderOrNull
// The authenticated actor turned into the party that would own a quote row, or
// null when they hold no carrier capability. Resolves the persona snapshot and
// defers to bidderFromSnapshot, so bidding is decided by what the caller OWNS,
// never by the role string. A MISSING carrier answers null (not a throw), which
// is what keeps the blind-auction scoping in listQuotes and the ownership checks
// in getQuoteHistory reading as a plain refusal.
// -----------------------------------------------------------

export async function resolveBidderOrNull(actor: AuthenticatedUser): Promise<Bidder | null> {
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  return bidderFromSnapshot(snapshot)
}

// -----------------------------------------------------------
// bidderOfQuote / quoteBelongsTo / quoteBelongsToViewer
// Ownership checks used to compare quote.driver_id; with fleet bids the column
// to compare depends on which kind of bidder made the quote.
// -----------------------------------------------------------

export function bidderOfQuote(quote: DbQuote): Bidder {
  if (quote.fleet_owner_id) return { kind: 'fleet', fleetOwnerId: quote.fleet_owner_id }
  if (quote.driver_id)      return { kind: 'driver', driverId: quote.driver_id }
  // Unreachable while the quotes_exactly_one_bidder check holds; a bidderless
  // quote is corrupt data, not a client mistake.
  throw new BookingError('Quote has no bidder', 'INTERNAL', 500)
}

export function quoteBelongsTo(quote: DbQuote, bidder: Bidder): boolean {
  return bidder.kind === 'fleet'
    ? quote.fleet_owner_id === bidder.fleetOwnerId
    : quote.driver_id === bidder.driverId
}

// Does an existing quote belong to ANY of this viewer's carrier identities?
// Unlike quoteBelongsTo (which is answered against ONE resolved bidder), this
// asks the question relation-to-object: a human who is both an owner-driver and
// a fleet operator owns their driver quote AND their fleet quote, and the
// precedence bidderFromSnapshot applies for CREATING a bid must not decide who
// may WITHDRAW an already-placed one. It also stays true when the identity that
// bid has since stopped carrying (a truck sold), so the bidder can still settle
// their own live quote.
export function quoteBelongsToViewer(quote: DbQuote, snapshot: PersonaSnapshot): boolean {
  if (quote.fleet_owner_id && quote.fleet_owner_id === snapshot.fleet_owner_id) return true
  if (quote.driver_id && quote.driver_id === snapshot.driver_id) return true
  return false
}

// -----------------------------------------------------------
// isFleetAffiliatedDriver
//
// THE RULE (founder Q16 + Q14): a driver employed by a fleet is not the
// commercial party on the trip — the fleet owner bid, the fleet owner is paid.
// So an affiliated driver never sees the money on a booking (quoted_price,
// final_price, min_acceptable) and never self-selects work from the load board;
// their work arrives as an assignment from their owner.
//
// Deliberately keyed on status='active' ONLY. A 'pending' invite has not been
// accepted, and 'rejected'/'left'/'suspended' are not live employment — in all
// of those the driver is still a solo operator and MUST keep the unmodified
// solo behaviour. This narrow, explicit lookup is the gate that keeps the
// price-hiding rule from ever touching a solo driver.
// -----------------------------------------------------------

export async function isFleetAffiliatedDriver(driverId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('fleet_drivers')
    .select('id')
    .eq('driver_id', driverId)
    .eq('status', 'active')
    .limit(1)

  if (error) {
    if (isMissingRelation(error)) return false
    throw new Error(`Fleet affiliation lookup failed: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

// -----------------------------------------------------------
// driverOwnsAnyVehicle
//
// Does this driver own a truck outright? `vehicles.driver_id` references
// drivers(id), and migration 0022 guarantees a vehicle has exactly one owner,
// so a hit here means unambiguous ownership — not "is driving", not "is
// assigned to", OWNS.
//
// This is the discriminator that separates a commercial partner from an
// employee (see isEmployedDriver below). It fails CLOSED to "owns nothing" on a
// missing relation, which preserves the pre-0022 behaviour exactly: on a
// database without the vehicles table every affiliated driver is an employee,
// which is what shipped before this change.
// -----------------------------------------------------------

export async function driverOwnsAnyVehicle(driverId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('vehicles')
    .select('id')
    .eq('driver_id', driverId)
    .limit(1)

  if (error) {
    if (isMissingRelation(error)) return false
    throw new Error(`Vehicle ownership lookup failed: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

// -----------------------------------------------------------
// isEmployedDriver — THE gate for price-hiding and load-board removal.
//
// Replaces the bare isFleetAffiliatedDriver() check, which was too broad. The
// rule is now (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §1.1):
//
//     Commercial visibility follows ASSET OWNERSHIP, not affiliation.
//
// A driver is an EMPLOYEE — money hidden, no load board — only when they are
// affiliated to a fleet AND own no truck of their own. That is the person the
// original rule was written for: their owner bids, their owner is paid, and
// work arrives as an assignment.
//
// An OWNER-DRIVER attached to a fleet is a different party entirely. They carry
// the truck's EMI, fuel, maintenance and downtime, so they are a stakeholder in
// what the trip earns, and hiding the money from them was simply wrong. They
// also keep the marketplace: affiliation ADDS a source of work, it does not
// replace self-selection. This is the Indian attached-vehicle model, which the
// affiliation-only check could not express.
//
// The affiliation lookup runs FIRST and short-circuits: a solo driver never
// reaches the vehicles query, so the common path costs exactly what it did
// before.
// -----------------------------------------------------------

export async function isEmployedDriver(driverId: string): Promise<boolean> {
  if (!(await isFleetAffiliatedDriver(driverId))) return false
  return !(await driverOwnsAnyVehicle(driverId))
}

// -----------------------------------------------------------
// hasLiveVehicleAssignment
// A live pairing is a vehicle_assignments row that has not been released.
// Only ever consulted for a booking that already carries fleet_owner_id, so a
// pre-migration database (which cannot hold such a booking) never reaches it.
// -----------------------------------------------------------

export async function hasLiveVehicleAssignment(bookingId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('vehicle_assignments')
    .select('id')
    .eq('booking_id', bookingId)
    .is('released_at', null)
    .limit(1)

  if (error) {
    if (isMissingRelation(error)) return false
    throw new Error(`Vehicle assignment lookup failed: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

// -----------------------------------------------------------
// stripCommercialFields
// Removes the three money columns from a booking payload. Applied ONLY after
// isFleetAffiliatedDriver() has returned true, so a solo driver's payload is
// byte-identical to what it was before this slice.
// -----------------------------------------------------------

export type CommercialField = 'quoted_price' | 'final_price' | 'min_acceptable'

export type PriceMasked<T> = Omit<T, CommercialField>

export function stripCommercialFields<T extends Pick<DbBooking, CommercialField>>(
  booking: T,
): PriceMasked<T> {
  const { quoted_price: _q, final_price: _f, min_acceptable: _m, ...rest } = booking
  return rest
}
