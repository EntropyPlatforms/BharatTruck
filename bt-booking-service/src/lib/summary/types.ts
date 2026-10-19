// ============================================================
// src/lib/summary/types.ts
//
// The wire contract for GET /me/summary — "how am I doing?", the companion of the
// /me/feed "what needs me?" (D-38). ONE call returns only the panels this person's
// capabilities unlock, in the order of their front door (D-32), with money fields
// decided on the SERVER (§1.1): the driving panel carries no freight amounts at all,
// the truck panel counts only trips on the person's own truck, and the shipments panel
// is the shipper's own spend.
//
// The fleet panel's numbers keep coming from bt-fleet-service's analytics endpoints;
// 'fleet' in `panels` only tells the app to render it.
// ============================================================

import type { BookingStatus } from '../types.js'

export type SummaryPanel = 'fleet' | 'truck' | 'driving' | 'shipments'

/** A trip as a driver sees it — route, load and timing; never a price. */
export type TripCard = {
  booking_id: string
  status: BookingStatus
  from: string
  to: string
  pickup_date: string
  load_type: string
  weight_kg: number
  started_at: string | null
}

export type DrivingPanel = {
  current_trip: TripCard | null
  upcoming: TripCard[]
  month: { delivered: number; avg_transit_hours: number | null }
  licence: { expiry_date: string | null; days_left: number | null } | null
  open_alerts: number
}

export type TruckPanel = {
  vehicle: { id: string; rc_number: string } | null
  month: { earned_inr: number; trips_paid: number; emi_inr: number | null }
  owed: { amount_inr: number; trips: number; oldest_days: number | null }
  in_progress: number
  bids: { live: number; countered: number }
  open_alerts: number
}

export type ShipmentsPanel = {
  month: { posted: number; delivered: number; paid_inr: number; avg_transit_hours: number | null }
  due: { amount_inr: number; trips: number; oldest_days: number | null }
  bids_waiting: { bids: number; loads: number }
  on_the_road: Array<{ booking_id: string; from: string; to: string; started_at: string | null }>
  lanes: Array<{ lane: string; spend_inr: number; loads: number }>
  open_alerts: number
}

export type MeSummary = {
  generated_at: string
  /** Start of the current IST month — every "this month" figure counts from here. */
  month_start: string
  panels: SummaryPanel[]
  driving: DrivingPanel | null
  truck: TruckPanel | null
  shipments: ShipmentsPanel | null
  /** Sections that errored and were dropped; the rest still render (same idea as the feed). */
  degraded_sections: string[]
}
