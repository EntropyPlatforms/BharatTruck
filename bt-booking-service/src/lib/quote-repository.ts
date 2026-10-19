// ============================================================
// src/lib/quote-repository.ts
//
// Responsibility: all Supabase queries for the quotes and
// negotiations tables, plus the atomic awardBooking operation.
//
// ── REQUIRED MIGRATIONS ─────────────────────────────────────
//
//   ALTER TABLE bookings
//     ADD COLUMN IF NOT EXISTS booking_type text NOT NULL DEFAULT 'direct',
//     ADD COLUMN IF NOT EXISTS target_driver_id uuid REFERENCES drivers(id),
//     ADD COLUMN IF NOT EXISTS auction_deadline timestamptz,
//     ADD COLUMN IF NOT EXISTS min_acceptable numeric,
//     ADD COLUMN IF NOT EXISTS awarded_quote_id uuid,
//     ADD COLUMN IF NOT EXISTS dimensions_json jsonb;
//
//   CREATE TABLE IF NOT EXISTS quotes (
//     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
//     driver_id uuid NOT NULL REFERENCES drivers(id),
//     amount numeric NOT NULL CHECK (amount > 0),
//     message text,
//     status text NOT NULL DEFAULT 'submitted',
//     submitted_at timestamptz NOT NULL DEFAULT now(),
//     expires_at timestamptz,
//     updated_at timestamptz NOT NULL DEFAULT now(),
//     UNIQUE (booking_id, driver_id)
//   );
//
//   -- migration 016 then made quotes.driver_id NULLABLE and added
//   -- fleet_owner_id + a num_nonnulls(driver_id, fleet_owner_id) = 1 check,
//   -- so a bid can come from a fleet instead of a solo driver.
//
//   CREATE TABLE IF NOT EXISTS negotiations (
//     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
//     booking_id uuid NOT NULL REFERENCES bookings(id),
//     actor_id uuid NOT NULL REFERENCES users(id),
//     actor_role text NOT NULL CHECK (actor_role IN ('shipper','driver')),
//     amount numeric NOT NULL,
//     message text,
//     created_at timestamptz NOT NULL DEFAULT now()
//   );
//
// ============================================================

import { supabase } from './supabase.js'
import type {
  DbBooking,
  DbNegotiation,
  DbQuote,
  QuoteCarrier,
  QuoteStatus,
  QuoteWithCarrier,
} from './types.js'
import { BookingError } from './types.js'
import type { Bidder } from './fleet.js'

// -----------------------------------------------------------
// createQuote
// Inserts a new quote row for whichever party is bidding. If the
// UNIQUE(booking_id, driver_id) / one-live-bid-per-fleet constraint
// fires, we catch it and throw a domain error so callers get a clean
// DUPLICATE_QUOTE response.
//
// The two branches write DISJOINT columns (quotes_exactly_one_bidder
// enforces that) — a driver bid inserts exactly the same payload it
// always did, so nothing about the solo path moved.
// -----------------------------------------------------------

export async function createQuote(
  bookingId: string,
  bidder: Bidder,
  amount: number,
  message: string | null,
): Promise<DbQuote> {
  const bidderColumns = bidder.kind === 'fleet'
    ? { fleet_owner_id: bidder.fleetOwnerId }
    : { driver_id: bidder.driverId }

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      booking_id: bookingId,
      ...bidderColumns,
      amount,
      message,
      status: 'submitted',
    })
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      throw new BookingError(
        bidder.kind === 'fleet'
          ? 'This fleet already has an active quote on this booking'
          : 'Driver already has an active quote',
        'DUPLICATE_QUOTE',
        409,
      )
    }
    throw new Error(`DB insert quote failed: ${error.message}`)
  }
  return data as DbQuote
}

// -----------------------------------------------------------
// getQuoteById
// Returns a single quote by primary key, or null on miss.
// -----------------------------------------------------------

export async function getQuoteById(quoteId: string): Promise<DbQuote | null> {
  const { data, error } = await supabase
    .from('quotes')
    .select('*')
    .eq('id', quoteId)
    .maybeSingle()

  if (error) throw new Error(`DB select quote failed: ${error.message}`)
  return data as DbQuote | null
}

// -----------------------------------------------------------
// listLosingQuotes
// Every OTHER quote still in play on a booking at the moment one wins —
// i.e. the bidders who need telling they lost.
//
// Deliberately NOT role-scoped, unlike listQuotesForBooking: this is a
// server-side notification lookup with no actor, and its result never reaches
// a bidder's eyes (only their own address does). Restricted to the live
// statuses so a bidder who already withdrew or was rejected earlier is not
// told a second time that they lost.
//
// winningQuoteId is NULL on the direct-attach path (D-10): the shipper moved the
// load with their own truck, so nobody's bid won and EVERY live bid is a losing
// one. Excluding nothing is the correct answer there, not a degenerate case.
//
// CALL THIS BEFORE THE QUOTES ARE CLOSED — awardBooking's step 3 on the auction
// path, expireOpenQuotes on the direct-attach one. Both flip the live bids to
// 'expired', and the status filter below then matches nothing: call it afterwards
// and you get an empty list, not the losers.
// -----------------------------------------------------------

export async function listLosingQuotes(
  bookingId: string,
  winningQuoteId: string | null,
): Promise<DbQuote[]> {
  let query = supabase
    .from('quotes')
    .select('*')
    .eq('booking_id', bookingId)
    .in('status', ['submitted', 'countered'])

  if (winningQuoteId) query = query.neq('id', winningQuoteId)

  const { data, error } = await query
  if (error) throw new Error(`DB list losing quotes failed: ${error.message}`)
  return (data ?? []) as DbQuote[]
}

// -----------------------------------------------------------
// listQuotesForBooking
// Blind-auction scoped by `seeAllQuotes` (shipper relation / ops), never by JWT
// role. A bidder only sees its own quote; shippers and admins see all.
// `bidder` is the resolved identity of a carrier caller — absent when seeAllQuotes.
// -----------------------------------------------------------

export async function listQuotesForBooking(
  bookingId: string,
  opts: { seeAllQuotes: boolean; bidder?: Bidder },
): Promise<QuoteWithCarrier[]> {
  let query = supabase
    .from('quotes')
    .select(QUOTE_WITH_CARRIER_SELECT)
    .eq('booking_id', bookingId)
    .order('submitted_at', { ascending: false })

  if (!opts.seeAllQuotes) {
    // Blind auction: a bidder we could not resolve to a party sees nothing.
    if (!opts.bidder) {
      return []
    }
    query = opts.bidder.kind === 'fleet'
      ? query.eq('fleet_owner_id', opts.bidder.fleetOwnerId)
      : query.eq('driver_id', opts.bidder.driverId)
  }

  const { data, error } = await query
  if (error) throw new Error(`DB list quotes failed: ${error.message}`)
  return ((data ?? []) as unknown as QuoteCarrierRow[]).map(toQuoteWithCarrier)
}

// -----------------------------------------------------------
// Carrier resolution for listQuotesForBooking
//
// One embedded read rather than a second round trip per quote. The two embeds
// are disjoint by the quotes_exactly_one_bidder check, so exactly one of them
// is non-null on any given row. Both FK constraints are named explicitly —
// quotes has one FK to each table, but naming them keeps the embed from
// silently re-resolving if another is ever added (same house style as
// repository.ts's booking→driver join).
// -----------------------------------------------------------

const QUOTE_WITH_CARRIER_SELECT = `
  *,
  driver:drivers!quotes_driver_id_fkey (
    id,
    truck_number,
    average_rating,
    total_trips,
    user:users!drivers_user_id_fkey ( full_name )
  ),
  fleet_owner:fleet_owners!quotes_fleet_owner_id_fkey ( id, company_name )
`

type QuoteCarrierRow = DbQuote & {
  driver?: {
    id: string
    truck_number: string | null
    // PostgREST returns numeric columns as strings ("0.00"), so these are
    // widened here and normalised in toNumber rather than trusted as numbers.
    average_rating: number | string | null
    total_trips: number | string | null
    user?: { full_name: string | null } | null
  } | null
  fleet_owner?: { id: string; company_name: string | null } | null
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Strips the join keys off the row and folds them into one `carrier`, so the
 * wire shape stays DbQuote + carrier and the client never has to know which of
 * the two id columns was the populated one.
 *
 * Exported for the unit suite — it is the whole mapping, and it is worth
 * pinning without a live Postgres.
 */
export function toQuoteWithCarrier(row: QuoteCarrierRow): QuoteWithCarrier {
  const { driver, fleet_owner, ...quote } = row

  let carrier: QuoteCarrier | null = null
  if (fleet_owner) {
    carrier = {
      kind: 'fleet',
      id: fleet_owner.id,
      name: fleet_owner.company_name ?? null,
      truck_number: null,
      average_rating: null,
      total_trips: null,
    }
  } else if (driver) {
    carrier = {
      kind: 'driver',
      id: driver.id,
      name: driver.user?.full_name ?? null,
      truck_number: driver.truck_number ?? null,
      average_rating: toNumber(driver.average_rating),
      total_trips: toNumber(driver.total_trips),
    }
  }

  return { ...quote, carrier }
}

// -----------------------------------------------------------
// updateQuoteStatus
// Updates the quote's status (and optionally amount) with an
// optimistic concurrency approach — returns null if no row matched.
// -----------------------------------------------------------

export async function updateQuoteStatus(
  quoteId: string,
  status: QuoteStatus,
  newAmount?: number,
): Promise<DbQuote | null> {
  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (newAmount !== undefined) {
    updates.amount = newAmount
  }

  const { data, error } = await supabase
    .from('quotes')
    .update(updates)
    .eq('id', quoteId)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB update quote failed: ${error.message}`)
  return data as DbQuote | null
}

// -----------------------------------------------------------
// createNegotiationEntry
// Append-only insert into the negotiations table. Each row is
// an immutable record of a price offer or counter-offer.
// -----------------------------------------------------------

export async function createNegotiationEntry(
  entry: Omit<DbNegotiation, 'id' | 'created_at'>,
): Promise<DbNegotiation> {
  const { data, error } = await supabase
    .from('negotiations')
    .insert({
      quote_id:   entry.quote_id,
      booking_id: entry.booking_id,
      actor_id:   entry.actor_id,
      actor_role: entry.actor_role,
      amount:     entry.amount,
      message:    entry.message,
    })
    .select('*')
    .single()

  if (error) throw new Error(`DB insert negotiation failed: ${error.message}`)
  return data as DbNegotiation
}

// -----------------------------------------------------------
// listNegotiationsForQuote
// Returns the full negotiation history for a quote, ordered
// chronologically (oldest first) so the conversation reads
// top-to-bottom.
// -----------------------------------------------------------

export async function listNegotiationsForQuote(quoteId: string): Promise<DbNegotiation[]> {
  const { data, error } = await supabase
    .from('negotiations')
    .select('*')
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`DB list negotiations failed: ${error.message}`)
  return (data ?? []) as DbNegotiation[]
}

// -----------------------------------------------------------
// countNegotiationsForQuote
// How many negotiation rows exist for a quote: the bidder's opening bid plus
// one row per counter. Used by the round cap, so counters-so-far = count - 1.
//
// HEAD count query — the cap needs the number, never the rows, and a long
// negotiation should not transfer its whole history on every counter.
// -----------------------------------------------------------

export async function countNegotiationsForQuote(quoteId: string): Promise<number> {
  const { count, error } = await supabase
    .from('negotiations')
    .select('id', { count: 'exact', head: true })
    .eq('quote_id', quoteId)

  if (error) throw new Error(`DB count negotiations failed: ${error.message}`)
  return count ?? 0
}

// -----------------------------------------------------------
// awardBooking
// Atomically binds the booking to the WINNING BIDDER and marks it
// accepted. The WHERE guard (status IN (...) AND awarded_quote_id IS
// NULL) ensures only one concurrent award call can succeed.
//
// A driver bid sets driver_id, exactly as before. A fleet bid sets
// fleet_owner_id and leaves driver_id NULL: the fleet may have bid with
// no free truck (founder Q10), so the driver and the truck are bound
// later by the owner's assignment step in bt-fleet-service — which is
// what the accepted → in_transit gate then checks for.
//
// Also marks the winning quote as 'accepted' and expires all
// other open quotes on this booking.
//
// award_path='auction' goes in the SAME statement that binds the winner. It is
// the column's default (migration 0022), so this changes no value today — it is
// written explicitly because the default is now load-bearing in the other
// direction: with direct-attach live, "how was this trip won" is a real question
// with three answers, and the one path that genuinely IS an auction should say so
// rather than rely on nobody having overwritten the default.
// -----------------------------------------------------------

export async function awardBooking(
  bookingId: string,
  quoteId: string,
  bidder: Bidder,
  finalPrice: number,
): Promise<DbBooking | null> {
  const winnerColumns = bidder.kind === 'fleet'
    ? { fleet_owner_id: bidder.fleetOwnerId }
    : { driver_id: bidder.driverId }

  // Step 1: atomically update the booking
  const { data, error } = await supabase
    .from('bookings')
    .update({
      ...winnerColumns,
      awarded_quote_id: quoteId,
      final_price:      finalPrice,
      status:           'accepted',
      award_path:       'auction',
      updated_at:       new Date().toISOString(),
    })
    .eq('id', bookingId)
    .in('status', ['pending', 'negotiating'])
    .is('awarded_quote_id', null)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB award booking failed: ${error.message}`)
  if (!data) return null

  // Step 2: mark the winning quote as accepted
  const { error: acceptErr } = await supabase
    .from('quotes')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', quoteId)

  if (acceptErr) throw new Error(`DB accept quote failed: ${acceptErr.message}`)

  // Step 3: expire all other open quotes on this booking
  const { error: expireErr } = await supabase
    .from('quotes')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .neq('id', quoteId)
    .not('status', 'in', '(withdrawn,rejected,accepted)')

  if (expireErr) throw new Error(`DB expire quotes failed: ${expireErr.message}`)

  return data as DbBooking
}

// -----------------------------------------------------------
// directAttachBooking — D-10, the award path with no auction in it.
//
// The shipper and the carrier are the same human, so there is no bid to accept:
// the load is bound straight to the caller's own fleet or truck and the booking
// moves to 'accepted'. Everything after that point is the auction flow's
// 'accepted' booking, indistinguishable from it — which is the whole point of the
// decision, and the reason this sets exactly the same columns awardBooking sets.
//
// ── RACE SAFETY (the sharp edge in this change) ─────────────
//
// There are now TWO writers that can bind a carrier to one booking: this, and
// awardBooking. Both must be mutually exclusive, in both directions, without a
// transaction — PostgREST gives us one statement, not a BEGIN.
//
// The guarantee comes from the WHERE clause being the ENTIRE precondition rather
// than a re-check of something read earlier. Postgres serializes concurrent
// UPDATEs of the same row: the second writer to reach the row blocks, and on
// waking re-evaluates its WHERE against the COMMITTED post-award row. So:
//
//   • direct-attach loses to a concurrent auction award — that award left
//     status='accepted', so `status IN ('pending','negotiating')` no longer
//     matches and this returns null.
//   • an auction award loses to a concurrent direct-attach — same reason, via
//     awardBooking's identical status guard. Note its OTHER guard,
//     `awarded_quote_id IS NULL`, does NOT catch this: direct-attach deliberately
//     leaves awarded_quote_id NULL because no quote won. The status guard is what
//     makes that direction safe, and it is why acceptQuote's pre-read check on
//     awarded_quote_id can never be the real defence.
//
// `awarded_quote_id IS NULL` is carried here anyway so the two writers guard on
// the SAME predicate. Today it is implied by the status guard; keeping it means a
// future widening of either writer's accepted statuses cannot quietly open a
// window on one side only.
//
// A second direct-attach by the same caller also matches nothing (status has
// moved), so this never double-awards. Turning that null into idempotent success
// vs. a conflict needs the booking re-read, which is the SERVICE's job — this
// function reports only "did I win the row".
// -----------------------------------------------------------

export async function directAttachBooking(
  bookingId: string,
  carrier: Bidder,
  finalPrice: number,
): Promise<DbBooking | null> {
  const carrierColumns = carrier.kind === 'fleet'
    ? { fleet_owner_id: carrier.fleetOwnerId }
    : { driver_id: carrier.driverId }

  const { data, error } = await supabase
    .from('bookings')
    .update({
      ...carrierColumns,
      final_price: finalPrice,
      status:      'accepted',
      award_path:  'direct_attach',
      updated_at:  new Date().toISOString(),
    })
    .eq('id', bookingId)
    .in('status', ['pending', 'negotiating'])
    .is('awarded_quote_id', null)
    .select('*')
    .maybeSingle()

  if (error) throw new Error(`DB direct-attach booking failed: ${error.message}`)
  return data as DbBooking | null
}

// -----------------------------------------------------------
// expireOpenQuotes
// Closes the market on a booking: every still-live bid becomes 'expired'.
//
// awardBooking does this inline with `.neq('id', winner)` because it has a winner
// to exempt. Direct-attach has none — the shipper moved the load themselves — so
// the whole set goes. Terminal statuses are left alone for the same reason they
// are in awardBooking: a bid already withdrawn or rejected has its own outcome on
// record and must not be overwritten with a vaguer one.
// -----------------------------------------------------------

export async function expireOpenQuotes(bookingId: string): Promise<void> {
  const { error } = await supabase
    .from('quotes')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .not('status', 'in', '(withdrawn,rejected,accepted,expired)')

  if (error) throw new Error(`DB expire quotes failed: ${error.message}`)
}
