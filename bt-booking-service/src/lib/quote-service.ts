// ============================================================
// src/lib/quote-service.ts
//
// Responsibility: all business logic for the auction &
// negotiation layer. Orchestrates quote-repository.ts and
// the existing repository.ts (for booking lookups / driver
// resolution). Every public function enforces role checks,
// ownership, and state-machine guards before touching the DB.
//
// A bid comes from a solo DRIVER or a FLEET OWNER (fleet.ts bidderFromSnapshot).
// Everything downstream of that resolution is shared: the state machine, the
// deadline rules and the shipper-side accept/reject path are identical for
// both kinds of bidder.
// ============================================================

import type {
  AuthenticatedUser,
  CounterQuoteBody,
  DbBooking,
  DbNegotiation,
  DbQuote,
  QuoteWithCarrier,
  SubmitQuoteBody,
} from './types.js'
import { BookingError } from './types.js'
import { assertPanVerified } from './kyc-gate.js'
import { assertValidQuoteTransition } from './state.js'
import { assertDriverAvailable } from './driver-schedule.js'
import * as repo from './repository.js'
import * as quoteRepo from './quote-repository.js'
import * as notify from './notifications/emit.js'
import { supabase } from './supabase.js'
import { relationsToBooking, resolvePersonas } from '@bharattruck/shared/personas'
import {
  bidderFromSnapshot,
  bidderIsRelatedParty,
  bidderOfQuote,
  getFleetOwnerByUserId,
  quoteBelongsTo,
  quoteBelongsToViewer,
  resolveBidderOrNull,
  type Bidder,
} from './fleet.js'

// Minimal structural logger (same shape service.ts uses) so the negotiation-log
// fallback below can report without this module depending on Fastify.
type Logger = { warn(obj: unknown, msg: string): void }

// -----------------------------------------------------------
// recordNegotiation
// The negotiation log is a display/audit history; the quotes row is the
// source of truth for a bid. The live negotiations.actor_role CHECK predates
// the fleet persona and only allows shipper|driver, so a fleet-side entry can
// be rejected until that constraint is widened. Failing the whole bid on a
// rejected audit row would be worse than losing the row, so the FLEET side is
// best-effort + logged (the same pattern as the ops-override audit and the GPS
// breadcrumb). The driver/shipper sides still throw exactly as before.
// -----------------------------------------------------------

async function recordNegotiation(
  entry: Omit<DbNegotiation, 'id' | 'created_at'>,
  log?: Logger,
): Promise<void> {
  if (entry.actor_role !== 'fleet_owner') {
    await quoteRepo.createNegotiationEntry(entry)
    return
  }
  try {
    await quoteRepo.createNegotiationEntry(entry)
  } catch (err) {
    log?.warn(
      { err, quote_id: entry.quote_id, booking_id: entry.booking_id },
      'negotiation log entry rejected for a fleet bid (bid applied) — widen the negotiations.actor_role check',
    )
  }
}

// -----------------------------------------------------------
// NEGOTIATION_ROUND_CAP — the committed MVP scope caps bilateral negotiation at
// five counter-offers per quote (docs/BIBLE.md §2.2). Without a cap a pair can
// counter each other indefinitely, which is not a negotiation: it holds the
// load off the market while the auction deadline runs down, and every round
// writes a negotiation row and fires a notification.
//
// The cap is on the QUOTE, not the booking. Each bidder gets their own five
// rounds with the shipper — one bidder exhausting theirs must not silently
// close the conversation with everyone else on the same load.
// -----------------------------------------------------------

export const NEGOTIATION_ROUND_CAP = 5

// Pure so it can be unit-tested without a DB. `negotiationRows` is the count
// BEFORE the incoming counter is written: the opening bid plus one row per
// prior counter. So counters-so-far is rows - 1, and the cap is reached when
// that already equals the cap — the next counter would be the sixth.
export function negotiationCapReached(negotiationRows: number): boolean {
  return negotiationRows - 1 >= NEGOTIATION_ROUND_CAP
}

// -----------------------------------------------------------
// submitQuote
// A solo driver or a fleet owner submits a price quote on a pending/open
// booking. For auction bookings the deadline is enforced server-side.
// For direct bookings the target_driver_id (if set) must match.
//
// Bidding is a CARRIER act, gated on what the caller OWNS, never the role string
// (D-27): a truck owner bids as themselves ('carry'), a fleet bids as their fleet
// ('operate'). That single gate SUBSUMES the old fleet-employed-driver block — an
// employed driver owns no truck, so they hold neither capability and are refused,
// while an owner-driver attached to a fleet keeps the marketplace their truck
// earns them (founder Q14, the attached-vehicle model).
//
// Holding a carrier capability is NOT sufficient on its own: the caller must also not
// be this booking's shipper. See the self-bid refusal below — the one guard here that
// asks about the caller's RELATION to the load rather than about what they own.
// -----------------------------------------------------------

export async function submitQuote(
  bookingId: string,
  body: SubmitQuoteBody,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<DbQuote> {
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  const bidder = bidderFromSnapshot(snapshot)
  if (!bidder) {
    throw new BookingError('Only a carrier — a truck owner or a fleet — can submit a quote', 'FORBIDDEN', 403)
  }
  // PAN is mandatory (2026-10-15): the bidding human must have a verified PAN.
  await assertPanVerified(actor.userId, 'bid on a load')

  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // NOBODY BIDS ON THEIR OWN LOAD. A distributor holds both halves — they posted it
  // ('shipper' relation) and they can carry it ('carry'/'operate') — so every other
  // guard in this function passes for them, and without this one the platform lets a
  // human run an auction against themselves and then award it to themselves. That is
  // not a hypothetical: it reached production (booking 337e203a), where the resulting
  // trip was recorded as award_path='auction' and silently entered the price history
  // every future quote is anchored on.
  //
  // Refused on the RELATION to this booking, never a role string (D-27) — the same
  // relation acceptQuote awards on, so the two cannot disagree about who the shipper
  // is. It is deliberately the FIRST refusal after the booking is read: a self-bid is
  // permanently wrong, so reporting it as 'auction closed' or 'deadline passed'
  // depending on when it was tried would send the caller to fix the wrong thing.
  //
  // This does NOT close the distributor's route to their own load — it names it.
  // Direct-attach (D-10, PATCH /bookings/:id/direct-attach) exists for exactly this
  // and reaches the same 'accepted' state, minus the fictional auction.
  if (relationsToBooking(booking, snapshot).includes('shipper')) {
    throw new BookingError(
      'You posted this load — use direct-attach to move it with your own truck instead of bidding on it',
      'SELF_BID_FORBIDDEN',
      403,
    )
  }

  // RELATED PARTIES DO NOT BID EITHER (review C-1, org half). The refusal above
  // catches the posting account; this catches the posting party's own crew — an
  // owner-driver whose truck is ATTACHED to the fleet that posted this load. They
  // are not the shipper, so the relation check passes, but a fleet bidding on
  // itself through its own attached driver is the same fictional auction one hop
  // removed. The fleet owner dispatches internal trucks by direct-attach +
  // assignment; the attached driver's OUTSIDE work is untouched (their
  // affiliations rarely include a random poster's fleet). Ordered directly after
  // the self-bid refusal for the same reason it is: permanently wrong beats
  // 'auction closed'. Costs one indexed lookup, and only for affiliated drivers.
  if (snapshot.affiliated_fleet_owner_ids.length > 0) {
    const posterFleet = await getFleetOwnerByUserId(booking.shipper_id)
    if (bidderIsRelatedParty(snapshot.affiliated_fleet_owner_ids, posterFleet?.id ?? null)) {
      throw new BookingError(
        'Your truck is attached to the fleet that posted this load — its owner moves internal loads by direct-attach, not through the auction',
        'SELF_BID_FORBIDDEN',
        403,
      )
    }
  }

  if (booking.status !== 'pending' && booking.status !== 'negotiating') {
    throw new BookingError('Booking is not accepting quotes', 'AUCTION_CLOSED', 409)
  }

  if (booking.booking_type === 'auction' && booking.auction_deadline) {
    if (new Date(booking.auction_deadline) < new Date()) {
      throw new BookingError('Auction deadline has passed', 'AUCTION_CLOSED', 409)
    }
  }

  // A direct booking aimed at one specific driver is not open to anyone else,
  // fleets included.
  if (booking.booking_type === 'direct' && booking.target_driver_id) {
    if (bidder.kind !== 'driver' || booking.target_driver_id !== bidder.driverId) {
      throw new BookingError('This booking is assigned to a different driver', 'FORBIDDEN', 403)
    }
  }

  const quote = await quoteRepo.createQuote(
    bookingId,
    bidder,
    body.amount,
    body.message ?? null,
  )

  await recordNegotiation({
    quote_id:   quote.id,
    booking_id: bookingId,
    actor_id:   actor.userId,
    actor_role: bidder.kind === 'fleet' ? 'fleet_owner' : 'driver',
    amount:     body.amount,
    message:    body.message ?? null,
  }, log)

  // Tell the shipper a bid landed. Queued, never sent inline — see notifications/emit.ts
  // for why this cannot fail the bid.
  await notify.emitQuoteReceived(booking, quote, log)

  return quote
}

// -----------------------------------------------------------
// counterQuote
// Either party (shipper, or the bidder — solo driver or fleet owner)
// proposes a new price on an existing quote. Creates a negotiation
// entry and notifies the other party.
// -----------------------------------------------------------

export async function counterQuote(
  bookingId: string,
  quoteId: string,
  body: CounterQuoteBody,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<DbQuote> {
  const quote = await quoteRepo.getQuoteById(quoteId)
  if (!quote || quote.booking_id !== bookingId) {
    throw new BookingError(`Quote ${quoteId} not found`, 'QUOTE_NOT_FOUND', 404)
  }

  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // Either party to the negotiation may counter, decided by RELATION-to-object,
  // never the role string (D-27): the SHIPPER who posted the load (the 'shipper'
  // relation, i.e. booking.shipper_id === them), or the BIDDER who owns the quote
  // (any of the caller's carrier identities — see quoteBelongsToViewer, which
  // compares both the driver and fleet columns). isShipper takes precedence for
  // the audit role below, matching the old role-string ordering.
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  const isShipper = relationsToBooking(booking, snapshot).includes('shipper')
  const ownsQuote = quoteBelongsToViewer(quote, snapshot)
  if (!isShipper && !ownsQuote) {
    throw new BookingError('Forbidden', 'FORBIDDEN', 403)
  }

  // An expired auction must not keep accepting counters. submitQuote already
  // refuses new bids past the deadline; countering was never checked, so a live
  // quote on a closed auction could still be moved on price indefinitely.
  if (
    booking.booking_type === 'auction' &&
    booking.auction_deadline &&
    new Date(booking.auction_deadline).getTime() < Date.now()
  ) {
    throw new BookingError('Auction deadline has passed', 'AUCTION_CLOSED', 409)
  }

  // Cap bilateral negotiation (docs/BIBLE.md §2.2). Checked BEFORE the status
  // transition and the write, so a rejected counter leaves the quote exactly as
  // it was — the pair keep their existing position rather than losing it to a
  // round they were not allowed to play.
  const negotiationRows = await quoteRepo.countNegotiationsForQuote(quoteId)
  if (negotiationCapReached(negotiationRows)) {
    throw new BookingError(
      `Negotiation cap reached — at most ${NEGOTIATION_ROUND_CAP} counter-offers per quote`,
      'NEGOTIATION_CAP_REACHED',
      409,
    )
  }

  assertValidQuoteTransition(quote.status, 'countered')

  const updated = await quoteRepo.updateQuoteStatus(quoteId, 'countered', body.amount)
  if (!updated) {
    throw new BookingError('Quote could not be updated — it may have changed', 'INVALID_TRANSITION', 409)
  }

  // The audit role is the SIDE the caller acted from: the shipper if they hold
  // that relation, otherwise the carrier kind that owns the quote (fleet vs solo
  // driver, read off the quote's populated column — the same discriminator
  // bidderOfQuote uses).
  await recordNegotiation({
    quote_id:   quoteId,
    booking_id: bookingId,
    actor_id:   actor.userId,
    actor_role: isShipper ? 'shipper' : (quote.fleet_owner_id ? 'fleet_owner' : 'driver'),
    amount:     body.amount,
    message:    body.message ?? null,
  }, log)

  // Notify the other party. `updated` (not `quote`) carries the new amount and the
  // bumped updated_at the dedupe key is built from, so each round of a negotiation
  // is a distinct notification rather than a duplicate of the first.
  await notify.emitQuoteCountered(
    booking,
    updated,
    isShipper ? 'shipper' : 'carrier',
    log,
  )

  return updated
}

// -----------------------------------------------------------
// acceptQuote
// Shipper awards a booking to a specific quote. Uses the atomic
// awardBooking guard to prevent double-awards. The shipper-side logic is
// identical for both kinds of bidder — only the column the winner is
// written into differs (see awardBooking).
// -----------------------------------------------------------

export async function acceptQuote(
  bookingId: string,
  quoteId: string,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<DbBooking> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // Awarding is the SHIPPER's act, gated on the 'shipper' relation to THIS
  // booking (booking.shipper_id === them), never the JWT role string (D-27) — so
  // a distributor holding a fleet_owner-role token who posted the load can award
  // it, while the ownership guarantee is unchanged. The old two-step (role check
  // then shipper_id check) collapses into this one relation check; both were 403.
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (!relationsToBooking(booking, snapshot).includes('shipper')) {
    throw new BookingError('Only the shipper on this booking can accept quotes', 'FORBIDDEN', 403)
  }

  const quote = await quoteRepo.getQuoteById(quoteId)
  if (!quote || quote.booking_id !== bookingId) {
    throw new BookingError(`Quote ${quoteId} not found`, 'QUOTE_NOT_FOUND', 404)
  }

  if (quote.status !== 'submitted' && quote.status !== 'countered') {
    throw new BookingError(
      `Cannot accept a quote with status '${quote.status}'`,
      'INVALID_TRANSITION',
      409,
    )
  }

  if (booking.awarded_quote_id) {
    throw new BookingError('Booking already has an awarded quote', 'ALREADY_AWARDED', 409)
  }

  // Snapshot who is still in play BEFORE awarding. awardBooking expires every
  // other open quote as part of the award, and listLosingQuotes only returns live
  // ones — read it afterwards and the set is always empty, so nobody is ever told
  // they lost. Same ordering the direct-attach path uses.
  //
  // Unlike the emit itself, this read is allowed to fail the accept: nothing has
  // been committed yet, so a throw here leaves the booking exactly as it was and
  // the shipper can retry. Swallowing it would silently reinstate the bug.
  const losingQuotes = await quoteRepo.listLosingQuotes(bookingId, quoteId)

  // A winning SOLO driver is bound straight onto bookings.driver_id with no
  // vehicle_assignments row, so nothing else in the system would stop this shipper
  // awarding a driver who is already out on someone else's load (driver-schedule.ts).
  // A FLEET winner is skipped deliberately: awardBooking leaves driver_id NULL and
  // bt-fleet-service's assign step runs the stronger index-backed guard when the owner
  // picks the crew.
  //
  // Placed with the other pre-award refusals, BEFORE awardBooking's conditional UPDATE,
  // so a refused award leaves the booking and every live quote exactly as they were —
  // the shipper keeps their whole field of bidders and can accept a different one.
  const winner = bidderOfQuote(quote)
  if (winner.kind === 'driver') {
    await assertDriverAvailable(winner.driverId, { exceptBookingId: bookingId })
  }

  const awarded = await quoteRepo.awardBooking(bookingId, quoteId, winner, quote.amount)
  if (!awarded) {
    throw new BookingError('Booking was already awarded — race condition', 'ALREADY_AWARDED', 409)
  }

  // Tell the winner they won, and every other live bidder that they did not. The
  // losing side matters: a carrier who never hears back holds capacity for a load
  // they are not getting. Only reached once the award actually landed.
  //
  // (The blockchain anchor that used to be called here went with jobs.ts — the
  // hash-anchor ledger is a committed MVP cut, see CLAUDE.md, and the stub had
  // never done anything.)
  await notify.emitQuoteAwarded(awarded, quote, losingQuotes, log)

  return awarded
}

// -----------------------------------------------------------
// rejectQuote
// Shipper rejects a driver's quote. The quote becomes terminal.
// -----------------------------------------------------------

export async function rejectQuote(
  bookingId: string,
  quoteId: string,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<DbQuote> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // Rejecting a bid is the shipper's act — the 'shipper' relation to this booking,
  // not the role string (D-27). Same collapse of role+ownership into one relation
  // check as acceptQuote.
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (!relationsToBooking(booking, snapshot).includes('shipper')) {
    throw new BookingError('Only the shipper on this booking can reject quotes', 'FORBIDDEN', 403)
  }

  const quote = await quoteRepo.getQuoteById(quoteId)
  if (!quote || quote.booking_id !== bookingId) {
    throw new BookingError(`Quote ${quoteId} not found`, 'QUOTE_NOT_FOUND', 404)
  }

  assertValidQuoteTransition(quote.status, 'rejected')

  const updated = await quoteRepo.updateQuoteStatus(quoteId, 'rejected')
  if (!updated) {
    throw new BookingError('Quote could not be updated — it may have changed', 'INVALID_TRANSITION', 409)
  }

  await notify.emitQuoteRejected(booking, updated, log)

  return updated
}

// -----------------------------------------------------------
// withdrawQuote
// The bidder withdraws their own quote — a solo driver their driver quote,
// a fleet owner their fleet quote. Only the quote owner can do this.
// -----------------------------------------------------------

export async function withdrawQuote(
  bookingId: string,
  quoteId: string,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<DbQuote> {
  const quote = await quoteRepo.getQuoteById(quoteId)
  if (!quote || quote.booking_id !== bookingId) {
    throw new BookingError(`Quote ${quoteId} not found`, 'QUOTE_NOT_FOUND', 404)
  }

  // Only the quote's OWNER withdraws it — decided by relation-to-object, not the
  // role string (D-27): quoteBelongsToViewer matches the quote against any of the
  // caller's carrier identities, so a solo driver settles their driver quote and a
  // fleet its fleet quote, and a human who is both settles either.
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (!quoteBelongsToViewer(quote, snapshot)) {
    throw new BookingError('Forbidden', 'FORBIDDEN', 403)
  }

  assertValidQuoteTransition(quote.status, 'withdrawn')

  const updated = await quoteRepo.updateQuoteStatus(quoteId, 'withdrawn')
  if (!updated) {
    throw new BookingError('Quote could not be updated — it may have changed', 'INVALID_TRANSITION', 409)
  }

  // The shipper was counting on this bid; a silent withdrawal leaves them waiting on
  // an option that no longer exists. Booking lookup is inside the emit's own guard,
  // so a missing booking here cannot fail the withdrawal.
  const booking = await repo.getBookingById(bookingId)
  if (booking) await notify.emitQuoteWithdrawn(booking, updated, log)

  return updated
}

// -----------------------------------------------------------
// listQuotes
// Returns quotes for a booking, scoped by shipper relation / ops — never JWT role.
// A bidder — solo driver or fleet owner — only sees its own quote
// (blind auction enforcement).
// -----------------------------------------------------------

export async function listQuotes(
  bookingId: string,
  actor: AuthenticatedUser,
): Promise<QuoteWithCarrier[]> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // De-roled (FB-11): shipper relation (or ops) sees all bids; others see only their own.
  // No role-spoof: seeAllQuotes is an explicit flag, not actor.role === 'shipper'.
  if (actor.role === 'admin') {
    return quoteRepo.listQuotesForBooking(bookingId, { seeAllQuotes: true })
  }
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  const isShipper = relationsToBooking(booking, snapshot).includes('shipper')
  if (isShipper) {
    return quoteRepo.listQuotesForBooking(bookingId, { seeAllQuotes: true })
  }
  const bidder = (await resolveBidderOrNull(actor)) ?? undefined
  return quoteRepo.listQuotesForBooking(bookingId, { seeAllQuotes: false, bidder })
}

// -----------------------------------------------------------
// getQuoteHistory
// Returns the full negotiation log for a specific quote.
// Access is verified against the booking and quote ownership.
// -----------------------------------------------------------

export async function getQuoteHistory(
  bookingId: string,
  quoteId: string,
  actor: AuthenticatedUser,
): Promise<DbNegotiation[]> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  const quote = await quoteRepo.getQuoteById(quoteId)
  if (!quote || quote.booking_id !== bookingId) {
    throw new BookingError(`Quote ${quoteId} not found`, 'QUOTE_NOT_FOUND', 404)
  }

  if (actor.role !== 'admin') {
    const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
    const isShipper = relationsToBooking(booking, snapshot).includes('shipper')
    if (!isShipper) {
      const bidder = await resolveBidderOrNull(actor)
      if (!bidder || !quoteBelongsTo(quote, bidder)) {
        throw new BookingError('Forbidden', 'FORBIDDEN', 403)
      }
    }
  }

  return quoteRepo.listNegotiationsForQuote(quoteId)
}
