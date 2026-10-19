// ============================================================
// src/lib/feed/types.ts
//
// The wire contract for GET /me/feed (D-38, docs/ARCHITECTURE_UNIFIED_IDENTITY.md
// §3.2 / §10.2): ONE ranked, time-ordered list of TYPED items, each carrying the
// PERSONA TAG it belongs to.
//
// The tag is the whole point. The unified app renders one home screen; the object
// supplies the context, not a mode switch — so a row tagged 'shipper' renders in
// the shipper idiom and a row tagged 'driver' in the driver idiom, interleaved, on
// the same surface. For a single-capability human the list contains one kind of
// thing and is indistinguishable from today's single-purpose home (§3.2, the
// property that makes it safe to ship).
// ============================================================

/**
 * The relation/persona a feed row belongs to — what lets the frontend pick the
 * idiom to render it in. NOT the caller's global persona: one human's feed can
 * carry 'shipper' and 'carrier' and 'fleet' rows at once (the distributor case).
 *
 * Mirrors BookingRelation from @bharattruck/shared/personas, plus 'fleet' for the
 * operate-side events that are not about one booking's carriage relation (a driver
 * accepting an invite, a truck needing assignment). 'observer' has no place here —
 * the feed only ever contains rows the caller is a party to.
 */
export type FeedPersonaTag = 'shipper' | 'carrier' | 'driver' | 'fleet' | 'consignee'

/**
 * The kind of action a row represents. Kept coarse and stable: the frontend keys
 * its rendering off (tag, type), and new sources add a member here rather than
 * overloading an existing one.
 */
export type FeedItemType =
  | 'bids_received'        // shipper: N live bids on a load you posted
  | 'delivery_action'     // shipper: an in-transit load that cannot close (no receiver inbox)
  | 'payment_due'         // shipper: a load you posted was delivered and is waiting to be paid
  | 'open_work'           // carrier: a load on the marketplace board you could bid on
  | 'bid_countered'       // carrier: the shipper countered your bid — respond
  | 'trip_starting'       // driver: a trip assigned to you, awaiting start
  | 'trip_delivery'       // driver: a trip in transit, awaiting the receiver-OTP POD
  | 'fleet_driver_joined' // fleet:  a driver accepted your invite
  | 'truck_assignment'    // fleet:  a fleet-won load with no truck paired to it yet
  | 'alert'               // any:    an open alert the scheduled sweep raised (src/lib/alerts)

/**
 * Coarse priority band. Deliberately NOT a numeric score: the ranking is a
 * stable bucket order (see PRIORITY_RANK), and a coarse band is all the frontend
 * needs to group "needs you now" above "when you get to it".
 */
export type FeedPriority = 'urgent' | 'high' | 'normal' | 'low'

/** Bucket order for sorting — lower sorts first. */
export const PRIORITY_RANK: Record<FeedPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

/**
 * Where tapping the row goes. A booking id and/or a quote id — the two things the
 * app already routes on. fleet_driver_id is the one non-booking target (the
 * roster row for a driver who joined).
 */
export type FeedTarget = {
  booking_id?: string
  quote_id?: string
  fleet_driver_id?: string
}

export type FeedItem = {
  /** Stable, unique — `${type}:${targetId}`. Also the final tiebreak in the sort, so pagination is stable. */
  id: string
  type: FeedItemType
  tag: FeedPersonaTag
  title: string
  subtitle: string
  /** ISO-8601. The recency the row is ranked by within its priority band. */
  timestamp: string
  target: FeedTarget
  priority: FeedPriority
  /** Present on type 'alert' only: which rule raised it and how bad it is. */
  alert?: { kind: string; severity: 'critical' | 'warning' | 'info' }
}

/**
 * One page of the merged feed. `total` is the size of the whole merged list (so the
 * client can show a count / decide to paginate); `next_offset` is null on the last
 * page. `degraded_sources` names any source that ERRORED and was skipped — the feed
 * returned the others rather than 500ing, and this is how the client knows it is
 * looking at a partial view (§ graceful degradation: the home page must always render).
 */
export type FeedPage = {
  items: FeedItem[]
  total: number
  limit: number
  offset: number
  next_offset: number | null
  degraded_sources: string[]
}
