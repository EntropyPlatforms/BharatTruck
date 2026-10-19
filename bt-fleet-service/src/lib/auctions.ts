import { getSupabase } from './supabase.js'
import { asRows, type BookingRow } from './types.js'

// -----------------------------------------------------------
// auctions — the READ side of fleet bidding.
//
// WHY THESE LIVE HERE AND NOT IN bt-booking-service: both are fleet-tenant-scoped
// list queries, which is exactly what this service owns (`/fleet/bookings`,
// `/fleet/live`, `/fleet/analytics/*` are all the same shape). The WRITE side —
// placing, countering and withdrawing a bid — deliberately stays in
// bt-booking-service on the existing `/bookings/:id/quotes*` routes, which already
// accept a fleet owner as a bidder, already enforce the auction-deadline and
// duplicate-bid rules, and are already exercised by the driver flow. Re-implementing
// or proxying those writes here would fork the auction rules across two services.
//
// COST/SHAPE: each function is ONE round trip plus a bounded hydrate. The auction
// board is polled by an open console, so a per-row fan-out would be a self-inflicted
// load problem at exactly the moment a dispatcher is watching many auctions at once.
// -----------------------------------------------------------

/**
 * Columns for the open-load board.
 *
 * Wider than assignment.ts's BOOKING_COLUMNS on purpose: bidding needs
 * `auction_deadline` (the countdown the old read-only page explicitly could not
 * draw), `target_driver_id` (to exclude loads aimed at one specific driver), and
 * `special_instructions` (a dispatcher prices off it).
 */
const AUCTION_BOOKING_COLUMNS =
  'id, shipper_id, source_address, destination_address, source_lat, source_lng, ' +
  'dest_lat, dest_lng, load_type, weight_kg, quoted_price, pickup_date, pickup_time_slot, ' +
  'status, booking_type, auction_deadline, target_driver_id, special_instructions, created_at'

const QUOTE_COLUMNS =
  'id, booking_id, driver_id, fleet_owner_id, amount, message, status, submitted_at, expires_at, updated_at'

/** Statuses in which a booking still accepts bids — mirrors submitQuote's own guard. */
const BIDDABLE_STATUSES = ['pending', 'negotiating']

export type QuoteRow = {
  id: string
  booking_id: string
  driver_id: string | null
  fleet_owner_id: string | null
  amount: number
  message: string | null
  status: string
  submitted_at: string
  expires_at: string | null
  updated_at: string
}

export type AuctionBookingRow = BookingRow & {
  auction_deadline: string | null
  target_driver_id: string | null
  special_instructions: string | null
  pickup_time_slot: string | null
}

export type OpenAuction = AuctionBookingRow & {
  shipper_name: string | null
  /** This fleet's live bid on this load, or null if it has not bid yet. */
  my_bid: QuoteRow | null
  /** How many bids the load has in total — the only competitive signal we may leak. */
  bid_count: number
}

/**
 * Who is looking at the board. A bid is owned by a fleet XOR a solo driver
 * (quotes_exactly_one_bidder), and bt-booking-service picks between them with
 * bidderFromSnapshot: the fleet if the human runs one, otherwise their own truck. The
 * board has to scope "my bid" the same way, or a solo owner-driver — who CAN bid —
 * gets a board that does not know about their own bids, or no board at all.
 */
export type BoardBidder =
  | { kind: 'fleet'; fleetOwnerId: string }
  | { kind: 'driver'; driverId: string }

const ownsQuote = (q: QuoteRow, bidder: BoardBidder) =>
  bidder.kind === 'fleet' ? q.fleet_owner_id === bidder.fleetOwnerId : q.driver_id === bidder.driverId

/**
 * The solo-carrier identity of a user: their drivers row, IF they own at least one active
 * truck (the 'carry' capability — @bharattruck/shared personas). null for anyone else: an
 * employed fleet driver with no truck of their own has nothing to bid with.
 */
export async function resolveSoloCarrier(userId: string): Promise<{ driverId: string } | null> {
  const supabase = getSupabase()
  const { data: driver, error } = await supabase.from('drivers').select('id').eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`driver lookup failed: ${error.message}`)
  const driverId = (driver as { id?: string } | null)?.id
  if (!driverId) return null

  const { count, error: vErr } = await supabase
    .from('vehicles').select('id', { count: 'exact', head: true })
    .eq('driver_id', driverId).eq('is_active', true)
  if (vErr) throw new Error(`vehicle lookup failed: ${vErr.message}`)
  return (count ?? 0) >= 1 ? { driverId } : null
}

export type FleetBid = QuoteRow & {
  booking: (AuctionBookingRow & { shipper_name: string | null }) | null
}

/**
 * Open loads this fleet may bid on, each annotated with its own existing bid.
 *
 * Deliberately excludes direct bookings aimed at a specific driver
 * (`target_driver_id`): `submitQuote` rejects those for a fleet with a 403, so
 * showing them would be a board of buttons that cannot work.
 *
 * By the SAME rule it excludes loads the caller POSTED (`excludeShipperUserId`).
 * submitQuote now refuses a self-bid, so leaving them on the board would again be
 * buttons that cannot work — but the exclusion is not merely cosmetic tidying. A
 * distributor's own load appearing under "Open loads" is an invitation to bid on it,
 * and until that refusal existed the invitation was accepted: one such bid was placed,
 * won, and recorded as a genuine auction in production. bt-booking-service's own feed
 * board has always applied this filter (feed/repository.ts listOpenWork); this query
 * was simply never taught it. The two boards now answer the same question the same way.
 *
 * NOTE the id types differ and are not interchangeable: the tenant is a
 * `fleet_owners.id`, while `bookings.shipper_id` is a `users.id`. Both are needed —
 * one scopes `my_bid`, the other the exclusion.
 *
 * `bid_count` is the ONLY thing exposed about rival bids — never their amounts or
 * identities. A dispatcher learning that a load has eight bids is normal auction
 * information; learning what the other eight fleets offered is not, and would turn
 * the marketplace into a race to the bottom.
 */
export async function listOpenAuctions(
  bidder: BoardBidder,
  opts: { limit: number; offset: number; includeExpired: boolean; excludeShipperUserId: string },
): Promise<OpenAuction[]> {
  const supabase = getSupabase()

  let query = supabase
    .from('bookings')
    .select(AUCTION_BOOKING_COLUMNS)
    .in('status', BIDDABLE_STATUSES)
    .neq('shipper_id', opts.excludeShipperUserId)

  // A direct booking aimed at one driver is biddable by THAT driver only (submitQuote's own
  // rule), so a solo driver sees the open board plus loads aimed at them; a fleet sees neither.
  query = bidder.kind === 'driver'
    ? query.or(`target_driver_id.is.null,target_driver_id.eq.${bidder.driverId}`)
    : query.is('target_driver_id', null)

  if (!opts.includeExpired) {
    // A null deadline never expires; a set one must still be in the future. PostgREST
    // `or` keeps this as one indexed query rather than fetching and filtering in app code.
    query = query.or(`auction_deadline.is.null,auction_deadline.gte.${new Date().toISOString()}`)
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1)
  if (error) throw new Error(`open auctions select failed: ${error.message}`)

  const bookings = asRows<AuctionBookingRow>(data)
  if (bookings.length === 0) return []

  const ids = bookings.map((b) => b.id)

  // Two bounded follow-ups, both keyed by the page of ids we already have — never
  // one query per row.
  const [{ data: quoteData }, shipperNames] = await Promise.all([
    supabase.from('quotes').select(QUOTE_COLUMNS).in('booking_id', ids),
    hydrateShipperNames(bookings.map((b) => b.shipper_id)),
  ])

  const quotes = asRows<QuoteRow>(quoteData)
  const myBidByBooking = new Map<string, QuoteRow>()
  const countByBooking = new Map<string, number>()

  for (const q of quotes) {
    // Withdrawn and rejected bids are dead — they should neither block a re-bid nor
    // inflate the competitive count.
    if (q.status === 'withdrawn' || q.status === 'rejected') continue
    countByBooking.set(q.booking_id, (countByBooking.get(q.booking_id) ?? 0) + 1)
    if (ownsQuote(q, bidder)) myBidByBooking.set(q.booking_id, q)
  }

  return bookings.map((b) => ({
    ...b,
    shipper_name: shipperNames.get(b.shipper_id) ?? null,
    my_bid: myBidByBooking.get(b.id) ?? null,
    bid_count: countByBooking.get(b.id) ?? 0,
  }))
}

/**
 * Every bid this fleet has ever placed, newest first, with its load attached.
 *
 * This is the query the console could not previously make. `bookings.fleet_owner_id`
 * is only written when a shipper ACCEPTS a quote, so `/fleet/bookings` can only ever
 * return auctions already won — a fleet's live, pending and lost bids were invisible.
 * `quotes.fleet_owner_id` is written at bid time, so it is the correct anchor for a
 * bid history.
 */
export async function listFleetBids(
  bidder: BoardBidder,
  opts: { status?: string; limit: number; offset: number },
): Promise<FleetBid[]> {
  const supabase = getSupabase()

  let query = supabase
    .from('quotes')
    .select(QUOTE_COLUMNS)
  query = bidder.kind === 'fleet' ? query.eq('fleet_owner_id', bidder.fleetOwnerId) : query.eq('driver_id', bidder.driverId)
  if (opts.status) query = query.eq('status', opts.status)

  const { data, error } = await query
    .order('submitted_at', { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1)
  if (error) throw new Error(`fleet bids select failed: ${error.message}`)

  const bids = asRows<QuoteRow>(data)
  if (bids.length === 0) return []

  const bookingIds = [...new Set(bids.map((b) => b.booking_id))]
  const { data: bookingData, error: bErr } = await supabase
    .from('bookings')
    .select(AUCTION_BOOKING_COLUMNS)
    .in('id', bookingIds)
  if (bErr) throw new Error(`bid bookings select failed: ${bErr.message}`)

  const bookings = asRows<AuctionBookingRow>(bookingData)
  const shipperNames = await hydrateShipperNames(bookings.map((b) => b.shipper_id))
  const byId = new Map(
    bookings.map((b) => [b.id, { ...b, shipper_name: shipperNames.get(b.shipper_id) ?? null }]),
  )

  // A booking the fleet bid on but can no longer read resolves to null rather than
  // dropping the bid row — the fleet's own bid history must stay complete.
  return bids.map((q) => ({ ...q, booking: byId.get(q.booking_id) ?? null }))
}

/** shipper user id -> display name, in one bounded query. */
async function hydrateShipperNames(shipperIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(shipperIds.filter(Boolean))]
  if (ids.length === 0) return out

  const { data, error } = await getSupabase().from('users').select('id, full_name').in('id', ids)
  // A name is decoration; failing to resolve one must not fail the board.
  if (error) return out

  for (const u of asRows<{ id: string; full_name: string | null }>(data)) {
    if (u.full_name) out.set(u.id, u.full_name)
  }
  return out
}
