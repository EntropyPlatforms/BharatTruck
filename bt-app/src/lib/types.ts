// Shapes returned by bt-fleet-service (and, for auth, bt-auth-service).
//
// These mirror bt-fleet-service/src/lib/types.ts and src/lib/analytics.ts. The
// service speaks snake_case over the wire and these types keep that verbatim —
// no camelCase mapping layer — so a field rename in the service is a compile
// error here rather than a silent `undefined` in a stat tile.

export type EmissionNorm = 'BS4' | 'BS6' | 'BS6_PH2'
export type FleetDriverStatus = 'pending' | 'active' | 'rejected' | 'suspended' | 'left'

// Both enums are the LIVE database values, confirmed by introspection rather than
// read off a migration file — booking_status in particular has no 'expired' member,
// because migration 0004 was never applied.
// 'delivery_asserted' (migration 0025) is the no-confirmation POD branch: the driver
// captured evidence but the receiver could not confirm, so the trip parks here until
// ops closes it to 'completed'. Listed so the state is REPRESENTABLE — the API can
// return it, and a union that cannot hold it turns a real status into a type lie.
export type BookingStatus =
  | 'pending' | 'negotiating' | 'accepted' | 'in_transit' | 'delivery_asserted' | 'completed' | 'cancelled' | 'paid'
export type QuoteStatus =
  | 'submitted' | 'countered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired'

export type AuthUser = {
  id: string
  phone: string | null
  email: string | null
  full_name: string | null
  avatar_url: string | null
  role: 'shipper' | 'driver' | 'admin' | 'fleet_owner'
  /** users.gstin — required before posting a load (FB-04). */
  gstin: string | null
  /** Billing address (shippers' invoices). */
  address?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  email_verified: boolean
  created_at: string
}

// ── Capabilities & personas (the unified-app shell reads these) ────────────────
//
// Mirrors @bharattruck/shared/personas as served by GET /auth/me. This app is a
// standalone Next project with no @bharattruck/shared dependency (same as fleet/),
// so the wire shape is restated here — a field rename in the resolver becomes a
// compile error here rather than a silent `undefined` gate.
//
// A "persona" is NOT a role string. It is a VIEW over what a human owns and who
// they are connected to, computed server-side. The shell gates every surface on a
// CAPABILITY (never on `role`) — D-27/D-36. `ship` is unconditional (everyone may
// post a load, D-5); the other three emerge from assets: `drive` = has a driver
// profile, `carry` = owns >=1 truck, `operate` = owns >=2 trucks or holds >=1 driver.
export type Capability = 'ship' | 'drive' | 'carry' | 'operate'

export type PersonaSnapshot = {
  user_id: string
  primary_persona: AuthUser['role']
  capabilities: Capability[]
  driver_id: string | null
  fleet_owner_id: string | null
  owned_vehicle_count: number
  held_driver_count: number
  affiliated_fleet_owner_ids: string[]
  sees_commercials: boolean
}

// The full GET /auth/me payload. `personas` is null when the server could not
// resolve capabilities (e.g. the 0022 columns are not applied yet on the database
// this build talks to); `personas_error` then names the reason. The client must
// treat null as "no answer yet", never as "this human may do nothing" — see the
// fallback in lib/auth.tsx.
export type MeResponse = {
  user: AuthUser
  personas: PersonaSnapshot | null
  personas_error: 'PERSONA_RESOLUTION_FAILED' | null
}

// ── Home action feed (GET /me/feed, D-38) ─────────────────────────────────────
//
// One ranked, time-ordered list of TYPED items, each carrying the PERSONA TAG it
// belongs to — mirrors bt-booking-service/src/lib/feed/types.ts. The tag is the
// whole point: a row tagged 'shipper' renders in the shipper idiom and a 'driver'
// row in the driver idiom, interleaved on one surface. For a single-capability
// human the list holds one kind of thing and reads like today's single-purpose home.
export type FeedPersonaTag = 'shipper' | 'carrier' | 'driver' | 'fleet' | 'consignee'

export type FeedItemType =
  | 'bids_received' | 'delivery_action' | 'payment_due' | 'open_work' | 'bid_countered'
  | 'trip_starting' | 'trip_delivery' | 'fleet_driver_joined' | 'truck_assignment'
  // An open alert the scheduled sweep raised (bt-booking-service src/lib/alerts).
  | 'alert'

export type FeedPriority = 'urgent' | 'high' | 'normal' | 'low'

/** Where tapping a row goes. The app already routes on booking/quote ids. */
export type FeedTarget = {
  booking_id?: string
  quote_id?: string
  fleet_driver_id?: string
}

export type FeedItem = {
  id: string
  type: FeedItemType
  tag: FeedPersonaTag
  title: string
  subtitle: string
  timestamp: string
  target: FeedTarget
  priority: FeedPriority
  /** Present on type 'alert' only: which rule raised it and how bad it is. */
  alert?: { kind: AlertKind; severity: 'critical' | 'warning' | 'info' }
}

export type AlertKind =
  | 'gps_silent' | 'trip_not_started' | 'unpaid_overdue' | 'licence_expiring'
  | 'ewb_expiring' | 'delivered_away' | 'documents_not_ready' | 'pickup_no_truck' | 'at_drop_not_delivered'
  | 'damage_reported' | 'delivery_unconfirmed' | 'no_bids' | 'truck_idle'

// ── GET /me/summary — "how am I doing?" (mirrors bt-booking-service src/lib/summary/types.ts) ──
// Only the panels this person's capabilities unlock, in their front-door order. Money is decided
// on the server: the driving panel carries no amounts at all, the truck panel counts only trips
// on the person's own truck, and the shipments panel is the shipper's own spend.
export type SummaryPanel = 'fleet' | 'truck' | 'driving' | 'shipments'

export type SummaryTripCard = {
  booking_id: string
  status: BookingStatus
  from: string
  to: string
  pickup_date: string
  load_type: string
  weight_kg: number
  started_at: string | null
}

export type DrivingPanelData = {
  current_trip: SummaryTripCard | null
  upcoming: SummaryTripCard[]
  month: { delivered: number; avg_transit_hours: number | null }
  licence: { expiry_date: string | null; days_left: number | null } | null
  open_alerts: number
}

export type TruckPanelData = {
  vehicle: { id: string; rc_number: string } | null
  month: { earned_inr: number; trips_paid: number; emi_inr: number | null }
  owed: { amount_inr: number; trips: number; oldest_days: number | null }
  in_progress: number
  bids: { live: number; countered: number }
  open_alerts: number
}

export type ShipmentsPanelData = {
  month: { posted: number; delivered: number; paid_inr: number; avg_transit_hours: number | null }
  due: { amount_inr: number; trips: number; oldest_days: number | null }
  bids_waiting: { bids: number; loads: number }
  on_the_road: Array<{ booking_id: string; from: string; to: string; started_at: string | null }>
  lanes: Array<{ lane: string; spend_inr: number; loads: number }>
  open_alerts: number
}

export type MeSummary = {
  generated_at: string
  month_start: string
  panels: SummaryPanel[]
  driving: DrivingPanelData | null
  truck: TruckPanelData | null
  shipments: ShipmentsPanelData | null
  degraded_sections: string[]
}

/**
 * One page of the merged feed. `degraded_sources` names any source that ERRORED
 * and was skipped — the feed returns the rest rather than 500ing, so the home page
 * always renders. The client surfaces that partial state rather than hiding it.
 */
export type FeedPage = {
  items: FeedItem[]
  total: number
  limit: number
  offset: number
  next_offset: number | null
  degraded_sources: string[]
}

export type FleetOwner = {
  id: string
  user_id: string
  company_name: string
  gstin: string | null
  pan: string | null
  contact_phone: string | null
  billing_address: string | null
  city: string | null
  state: string | null
  monthly_overhead_inr: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Vehicle = {
  id: string
  driver_id: string | null
  fleet_owner_id: string | null
  rc_number: string
  capacity_tons: number | null
  body_type: string | null
  axle_config: string | null
  maker_model: string | null
  fuel_type: string | null
  rc_expiry: string | null
  model_category: string | null
  emission_norm: EmissionNorm | null
  manufacture_year: number | null
  volume_cuft: number | null
  current_odometer_km: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type VehicleFinance = {
  vehicle_id: string
  lender: string | null
  loan_account_no: string | null
  principal_inr: number | null
  emi_amount_inr: number
  emi_day_of_month: number | null
  tenure_months: number | null
  interest_rate_pct: number | null
  start_date: string | null
  end_date: string | null
  outstanding_inr: number | null
  insurance_annual_inr: number
  permit_annual_inr: number
  fitness_annual_inr: number
}

export type VehiclePermit = {
  id: string
  vehicle_id: string
  permit_type: 'national' | 'state' | 'contract_carriage' | 'goods'
  allowed_states: string[]
  permit_number: string | null
  issued_on: string | null
  expiry_date: string | null
  is_active: boolean
}

export type VehicleLane = {
  id: string
  vehicle_id: string
  origin_city: string
  destination_city: string
  origin_lat: number | null
  origin_lng: number | null
  dest_lat: number | null
  dest_lng: number | null
  typical_distance_km: number | null
  is_primary: boolean
  trips_observed: number
}

export type FleetDriver = {
  id: string
  fleet_owner_id: string
  driver_id: string
  status: FleetDriverStatus
  monthly_salary_inr: number | null
  invited_at: string
  responded_at: string | null
  left_at: string | null
  full_name?: string | null
  phone_number?: string | null
  home_base_city?: string | null
  average_rating?: number | null
  total_trips?: number | null
  verification_badge?: string | null
}

// ── Driver-side fleet affiliation (bt-fleet-service /fleet/drivers/{invites/mine,me/affiliation}) ──
//
// The driver's OWN view of fleet membership — the consent seam. An owner invites by phone
// (fleet_drivers row → 'pending'); ONLY the driver may accept, from here. `is_employed` is
// the signal the app branches on: affiliated AND owning no truck — a salaried fleet driver
// who sees the job, not the money. An owner-driver whose own truck rides with a fleet is
// affiliated but NOT employed (they still hold the load board + their payout).

/** One pending invitation, as the driver's inbox returns it (GET /invites/mine). */
export type FleetInvite = {
  id: string
  fleet_owner_id: string
  company_name: string | null
  fleet_city: string | null
  monthly_salary_inr: number | null
  invited_at: string
}

/** The driver's commercial standing (GET /me/affiliation) — what product to show them. */
export type DriverAffiliation = {
  is_fleet_affiliated: boolean
  /** Affiliated AND owns no truck → salaried employee: no prices, no load board. */
  is_employed: boolean
  owns_vehicles: boolean
  owned_vehicle_count: number
  fleet_owner_id: string | null
  company_name: string | null
  fleet_city: string | null
  since: string | null
}

// ── Analytics (bt-fleet-service/src/lib/analytics.ts) ─────────

export type Period = { from: string; to: string }

export type Utilization = {
  tonnage_pct: number | null
  volume_pct: number | null
  distance_pct: number | null
  laden_weight_kg: number
  capacity_kg: number
  volume_used_cuft: number
  capacity_cuft: number
  distance_km: number
  expected_distance_km: number | null
  /** How the summed distance splits by basis — powers the measured-vs-estimated label. */
  distance_basis_km: { measured: number; routed: number; estimated: number }
  /** Share of distance that is real (measured or routed), 0..100. null when no distance. */
  measured_distance_pct: number | null
  /** Trips with a declared weight AND a known capacity — the sample tonnage_pct rests on. */
  tonnage_trips: number
  /** Trips with a declared volume AND a known capacity — the sample volume_pct rests on.
   *  An undeclared volume is unknown, not zero: a null volume_pct means nobody declared one. */
  volume_trips: number
}

/** The headline: did this asset cover its own running cost + tolls/other + EMI + fixed share? */
export type RunningCostScore = {
  revenue_inr: number
  /** Modelled cost of moving the asset (fuel, DEF, oils, service, tyres, wage). */
  running_cost_inr: number
  /** revenue − running_cost, before actuals and fixed charges. */
  gross_margin_inr: number
  /** Tolls + "other" the driver actually logged — real cash, netted in surplus. */
  toll_other_inr: number
  fixed_cost_inr: number
  emi_inr: number
  /** revenue − running_cost − toll_other − fixed: the true all-in net. */
  surplus_inr: number
  covered: boolean
}

export type CostBreakdown = {
  fuel_inr: number
  def_inr: number
  engine_oil_inr: number
  gear_oil_inr: number
  service_inr: number
  tyre_inr: number
  driver_wage_inr: number
  toll_inr: number
  other_inr: number
}

export type VehicleAnalytics = {
  vehicle_id: string
  rc_number: string
  model_category: string | null
  emission_norm: string | null
  trips: number
  /** trips in (0, LOW_SAMPLE_TRIPS): means are noisy, the UI says so. */
  low_sample: boolean
  utilization: Utilization
  score: RunningCostScore
  cost_breakdown_inr: CostBreakdown
  net_profit_inr: number
  cost_per_km_inr: number | null
  revenue_per_km_inr: number | null
}

export type FleetSummary = {
  period: Period
  trips: number
  /** trips in (0, LOW_SAMPLE_TRIPS): fleet-wide means are noisy, the UI says so. */
  low_sample: boolean
  active_vehicles: number
  utilization: Utilization
  score: RunningCostScore
  cost_breakdown_inr: CostBreakdown
  net_profit_inr: number
  monthly_overhead_inr: number
  vehicles_covering_emi: number
}

// One trip-expense the driver logged (bt-booking-service /bookings/:id/expenses).
export type TripExpense = {
  id: string
  booking_id: string | null
  driver_id: string
  vehicle_id: string | null
  category: string
  category_code: string | null
  amount: number
  description: string | null
  litres: number | null
  rate_per_litre: number | null
  odometer_km: number | null
  expense_date: string
  created_at: string
}

export type DriverAnalytics = {
  driver_id: string
  full_name: string | null
  phone_number: string | null
  trips: number
  /** trips in (0, LOW_SAMPLE_TRIPS): this driver's averages are noisy. */
  low_sample: boolean
  distance_km: number
  revenue_inr: number
  running_cost_inr: number
  net_profit_inr: number
  wage_allocated_inr: number
  net_profit_per_km_inr: number | null
}

export type FuelComparison = {
  period: Period
  estimated_inr: number
  actual_inr: number
  variance_inr: number
  variance_pct: number | null
  trips_with_actuals: number
  trips: number
  by_vehicle: {
    vehicle_id: string
    rc_number: string
    estimated_inr: number
    actual_inr: number
    variance_inr: number
    variance_pct: number | null
    trips_with_actuals: number
  }[]
}

// ── Live map ─────────────────────────────────────────────────

export type LivePosition = {
  driver_id: string
  driver_name: string | null
  vehicle_id: string | null
  rc_number: string | null
  booking_id: string | null
  // GET /fleet/live sends is_online (a live fix exists) + updated_at; lat/lng go null once the 30s
  // Redis TTL lapses (offline, not lost). Matches bt-fleet-service/src/routes/assignment.ts — the
  // old recorded_at/stale/non-null lat-lng shape never matched the wire (review F4).
  is_online: boolean
  lat: number | null
  lng: number | null
  heading: number | null
  speed_kmh: number | null
  updated_at: string | null
}

// ── Bookings / assignment ────────────────────────────────────

export type FleetBooking = {
  id: string
  status: BookingStatus
  shipper_name: string
  source_address: string
  destination_address: string
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  load_type: string
  weight_kg: number
  quoted_price: number
  final_price: number | null
  pickup_date: string
  booking_type: string
  vehicle_id: string | null
  driver_id: string | null
  created_at: string
  vehicle?: { rc_number: string } | null
  driver?: { full_name: string | null } | null
}

export type ModelCategory = {
  model_category: string
  super_category: string
  vehicle_class: 'SCV' | 'LCV' | 'MCV' | 'HCV'
  kms_per_year: number
  payload_tons_typical: number | null
  volume_cuft_typical: number | null
}

// ── Live fleet tracking (bt-tracking-service /tracking/fleet/overview) ────────
//
// VEHICLE-centric, unlike LivePosition above, which is driver-centric and comes from
// bt-fleet-service's /fleet/live. That distinction is the whole point: /fleet/live starts
// from the driver set, so a truck with no driver assigned never appears. This board starts
// from the vehicle list, so every asset the owner has is always a row — and when a truck has
// no position, the row explains WHY rather than vanishing.

/** Why a truck looks the way it does. Drives both the pin colour and the row's copy. */
export type VehicleStatus =
  | 'moving'                // reporting and rolling
  | 'idle'                  // reporting, stopped
  | 'no_signal'             // should be reporting, is not
  | 'assigned_not_started'  // has a trip, trip not live yet
  | 'parked'                // no trip
  | 'inactive'              // deactivated in the fleet

export type DataHealth = {
  level: 'ok' | 'degraded' | 'missing'
  /** Plain-language cause, written for the owner. Always safe to render directly. */
  reason: string
}

export type TrackedAlert = {
  id: string
  type: string
  message: string | null
  severity: 'info' | 'warning' | 'critical'
  lat: number | null
  lng: number | null
  acknowledged: boolean
  resolved_at: string | null
  created_at: string
  meta: Record<string, unknown>
}

export type TrackedVehicle = {
  vehicle_id: string
  rc_number: string | null
  maker_model: string | null
  model_category: string | null
  emission_norm: string | null
  body_type: string | null
  capacity_tons: number | null
  is_active: boolean
  current_odometer_km: number | null
  rc_expiry: string | null

  status: VehicleStatus
  status_label: string
  data_health: DataHealth

  driver: { driver_id: string; name: string | null; phone: string | null } | null

  booking: {
    booking_id: string
    status: string
    source_address: string | null
    dest_address: string | null
    pickup_date: string | null
    destination: { lat: number; lng: number }
  } | null

  position: {
    lat: number
    lng: number
    heading: number | null
    speed_kmh: number | null
    updated_at: string
    age_seconds: number | null
  } | null

  trip: {
    driven_km: number
    moving_hours: number
    idle_hours: number
    night_hours: number
    avg_moving_speed_kmh: number | null
    max_speed_kmh: number
    stop_count: number
    speeding_fixes: number
    max_deviation_m: number
    point_count: number
    last_fix_at: string | null
  } | null

  fuel: {
    /** The truck's rated economy — present even when parked. */
    mileage_kmpl: number
    basis: 'vehicle_norms' | 'vehicle_class' | 'default'
    basis_note: string
    /** Null until the truck has actually driven some of this trip. */
    trip: {
      distance_km: number
      litres: number
      diesel_cost_inr: number
      def_cost_inr: number
      total_cost_inr: number
    } | null
  }

  alerts: TrackedAlert[]
}

export type FleetOverview = {
  fleet_owner_id: string
  company_name: string
  generated_at: string
  summary: {
    vehicle_count: number
    moving: number
    idle: number
    no_signal: number
    assigned_not_started: number
    parked: number
    inactive: number
    on_trip: number
    alert_count: number
    trip_fuel_cost_inr: number
    driven_km: number
  }
  vehicles: TrackedVehicle[]
}

export type Geofence = {
  id: string
  fleet_owner_id: string | null
  name: string
  kind: 'depot' | 'warehouse' | 'checkpoint' | 'custom'
  lat: number
  lng: number
  radius_m: number
  active: boolean
  created_at: string
  updated_at: string
}
// ── Auction bidding ───────────────────────────────────────────
//
// Reads come from bt-fleet-service (`/fleet/auctions`, `/fleet/bids`) because they are
// tenant-scoped list queries. Writes go straight to bt-booking-service's existing
// `/bookings/:id/quotes*` routes, which already accept a fleet owner as a bidder and
// already own the auction-deadline and duplicate-bid rules.

export type Quote = {
  id: string
  booking_id: string
  driver_id: string | null
  /** Set instead of driver_id when the bidder is a fleet (migration 0016). */
  fleet_owner_id: string | null
  amount: number
  message: string | null
  status: QuoteStatus
  submitted_at: string
  expires_at: string | null
  updated_at: string
  /**
   * The party behind the bid, resolved server-side for display (D-27). Present on
   * a booking's quote list (GET /bookings/:id/quotes, bt-booking-service) so the
   * shipper can tell a solo driver from a fleet; ABSENT on the tenant-scoped fleet
   * bid reads (/fleet/auctions, /fleet/bids), which never carry it. Optional for
   * exactly that reason — read `carrier` when it is there, fall back to the id
   * columns when it is not (see the load-detail page's carrierKind()).
   */
  carrier?: QuoteCarrier | null
}

/**
 * Who is behind a bid, resolved server-side (mirrors bt-booking-service's
 * QuoteCarrier). A quote row names its bidder only by id, and which id — a
 * `drivers.id` XOR a `fleet_owners.id` — is not resolvable by this app, so the
 * server projects the party down to what a shipper may see and render.
 */
export type QuoteCarrier = {
  kind: 'driver' | 'fleet'
  id: string
  /** Null when the party has no name on file — render a fallback, never assume. */
  name: string | null
  /** Driver-only; a fleet names its truck at assignment, not at bid time. */
  truck_number: string | null
  average_rating: number | null
  total_trips: number | null
}

/** The load behind a bid or an open auction. */
export type AuctionBooking = {
  id: string
  shipper_id: string
  shipper_name: string | null
  source_address: string
  destination_address: string
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  load_type: string
  weight_kg: number
  /** What the shipper posted as their ask. */
  quoted_price: number
  pickup_date: string
  pickup_time_slot: string | null
  status: BookingStatus
  booking_type: string
  auction_deadline: string | null
  target_driver_id: string | null
  special_instructions: string | null
  created_at: string
}

export type OpenAuction = AuctionBooking & {
  /** This fleet's live bid on this load, or null if it has not bid yet. */
  my_bid: Quote | null
  /**
   * Total live bids on the load. Deliberately the ONLY competitive signal the
   * service exposes — rival amounts and identities are never sent.
   */
  bid_count: number
}

export type FleetBid = Quote & {
  /** Null only if the load became unreadable; the bid row still shows. */
  booking: AuctionBooking | null
}

/**
 * One entry in a bid's price thread.
 *
 * `actor_role` includes `fleet_owner` — bt-booking-service writes that value
 * (quote-service.ts recordNegotiation), and the driver app's copy of this type
 * omits it, which would mis-render a fleet's own counter.
 */
export type NegotiationEntry = {
  id: string
  quote_id: string
  booking_id: string
  actor_id: string
  actor_role: 'shipper' | 'driver' | 'fleet_owner'
  amount: number
  message: string | null
  created_at: string
}

// ── Ship surfaces (Post a Load / My Loads / load detail — Phase 2) ─────────────
//
// The shapes bt-booking-service, bt-pricing-service and bt-tracking-service speak
// for the shipper flow. Ported from shipper/src/lib (types.ts + api.ts) and kept
// snake_case verbatim — a field rename in a service is a compile error here rather
// than a silent `undefined`. bt-app is a standalone Next project with no
// @bharattruck/shared dep (same as fleet/ and shipper/), so the wire shapes are
// restated rather than imported.

/** A load is taken to the marketplace (`auction`) or handed to one driver (`direct`). */
export type BookingType = 'direct' | 'auction'

/**
 * The caller's relations to a booking, resolved server-side (D-27). Every booking
 * read carries a `viewer` block naming these — it is how "loads I posted" is told
 * from "loads I could bid on" in one list, without the client re-deriving persona
 * logic. Mirrors @bharattruck/shared BookingRelation.
 */
export type BookingRelation = 'shipper' | 'carrier' | 'driver' | 'consignee' | 'observer'

export type BookingViewer = {
  relations: BookingRelation[]
  sees_commercials: boolean
}

/**
 * The receiving party, projected down to what a booking read may disclose (D-22).
 * Name/phone/city only — email, GSTIN and street address are deliberately withheld
 * from a general booking read (they appear on the LR/invoice instead). Attached by
 * the server; ABSENT (not null) for a viewer with no relation, or on a pre-0026
 * database, which is why every read of it is guarded.
 */
export type ConsigneeParty = {
  name: string | null
  phone: string | null
  city: string | null
}

/** The receiving party named at posting time (D-22/D-29). Name + phone required. */
export type ConsigneeInput = {
  name: string
  /** A 10-digit Indian mobile; the server normalises and dedups on it. */
  phone: string
  email?: string
  gstin?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
}

export type Booking = {
  id: string
  shipper_id: string
  driver_id: string | null
  shipper_name: string
  shipper_contact: string
  source_address: string
  source_lat: number
  source_lng: number
  destination_address: string
  dest_lat: number
  dest_lng: number
  load_type: string
  weight_kg: number
  quoted_price: number
  final_price: number | null
  pickup_date: string
  pickup_time_slot: string | null
  status: BookingStatus
  special_instructions: string | null
  /** Consignee inbox the one-time delivery code is emailed to. Nullable. */
  receiver_email: string | null
  /** The consignee as a first-class (possibly unclaimed) party (D-22). */
  consignee_user_id: string | null
  booking_type: BookingType
  /**
   * Set when a FLEET won the auction rather than a solo driver. `driver_id` then
   * stays NULL until the owner pairs a truck+driver in bt-fleet-service — so an
   * `accepted` fleet booking means "carrier locked in", NOT "driver assigned".
   */
  fleet_owner_id: string | null
  vehicle_id: string | null
  target_driver_id: string | null
  auction_deadline: string | null
  awarded_quote_id: string | null
  in_transit_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  /** The receiving party (server-attached; absent for a viewer with no relation). */
  consignee?: ConsigneeParty | null
  /** The caller's relations to this booking + whether they may see money. */
  viewer?: BookingViewer
}

// ── Advisory pricing (bt-pricing-service, D-11) ────────────────────────────────

export type PriceQuoteVehicleType = 'mini_truck' | 'lcv' | 'hcv' | 'trailer'
export type PriceQuoteLoadType =
  | 'general' | 'fragile' | 'perishable' | 'hazardous' | 'heavy_machinery'

export type PriceQuoteInput = {
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  vehicle_type: PriceQuoteVehicleType
  load_type: PriceQuoteLoadType
  weight_kg: number
  /**
   * What the quote is for. On an auction the platform sets no price, so the quote
   * is `advisory`; sending this is what makes the server persist it that way. The
   * omitted wire default is `binding` — the wrong answer for an auction — so the
   * form always sends it.
   */
  booking_type?: BookingType
  /** The chosen truck, when there is one — refines the cost floor (otherwise a new BS6 truck is assumed). */
  model_category?: string
  emission_norm?: 'bs6' | 'bs4'
  truck_age?: number
}

export type PriceQuoteBreakdown = {
  vehicle_class: string
  distance_km: number
  mileage_kmpl: number
  diesel_price_inr: number
  fuel_cost: number
  driver_wage: number
  per_km_operating_cost: number
  handling: number
  operating_cost_total: number
}

/** FR8-calibrated market reference for the lane (bt-pricing-service P2). */
export type PriceQuoteMarket = {
  market_price: number
  inr_per_km: number
  /** `lane_fr8` = a live per-corridor rate (directional); `national` = the ₹/km-by-class fallback. */
  market_basis: 'lane_fr8' | 'national'
  source_city: string | null
  dest_city: string | null
  /** Demand/supply ratio for the corridor (>1 head-haul, <1 back-haul); null off a seeded lane. */
  ds_ratio: number | null
}

/** Where the headline quote sits between the operating-cost floor and the market (P3). */
export type PriceQuoteReconciliation = {
  cost_floor: number | null
  market_ref: number | null
  quoted: number
  position: 'below_floor' | 'floor_to_market' | 'above_market' | 'market_below_floor' | 'unknown'
  margin_over_floor_pct: number | null
  vs_market_pct: number | null
  /** One shipper-facing sentence, ready to render verbatim. */
  note: string
}

export type PriceQuote = {
  quote_id: string
  quoted_price: number
  currency: string
  expires_at: string
  breakdown: PriceQuoteBreakdown
  base_price: number
  weight_surcharge: number
  handling_fee: number
  rate_per_km: number
  total_price: number
  platform_fee: number
  shipper_pays: number
  driver_receives: number
  version: string
  /** Whether `quoted_price` is the charge (`binding`) or a benchmark (`advisory`). */
  quote_kind?: 'advisory' | 'binding'
  /** Server-authored sentence explaining where the number came from. */
  basis?: string
  /** Whether distance_km came from the routing service (`routed`) or the haversine estimate. */
  distance_basis?: 'routed' | 'estimated'
  /** FR8 market reference for the lane; null when no lane/class rate resolved (P2). */
  market?: PriceQuoteMarket | null
  /** Floor ↔ quote ↔ market placement + a UI-ready note (P3). */
  reconciliation?: PriceQuoteReconciliation | null
  /** Every line of the price (bt-pricing-service trip-estimate.ts). Absent on quotes made before it. */
  trip_estimate?: TripEstimate
}

/**
 * The one cost structure behind the fleet's bid estimate and the shipper's rate:
 *   trip cost = truck operating + driver & helper + allowance + handling + route tolls
 *   carrier_estimate   = trip cost + carrier_return_pct (18%)
 *   shipper_indicative = carrier_estimate × market_correction (1.05)
 */
export type TripEstimate = {
  model_category: string
  vehicle_class: 'SCV' | 'LCV' | 'MCV' | 'HCV'
  emission_norm: 'bs6' | 'bs4' | null
  truck_age: number | null
  distance_km: number
  trip_days: number
  diesel_price_inr: number
  operating_basis: 'cv_parc_norms' | 'class_typicals'
  operating: { fuel: number; def: number; lubricants: number; maintenance: number; tyres: number; total: number }
  crew: {
    driver_salary: number
    helper_salary: number
    allowance: number
    total: number
    has_helper: boolean
    driver_monthly_inr: number
    helper_monthly_inr: number
  }
  handling: number
  tolls: { amount: number; basis: 'route' | 'class_rate'; axle_class: string; car_toll_inr: number | null }
  trip_cost: number
  carrier_return_pct: number
  carrier_return: number
  carrier_estimate: number
  market_correction: number
  market_correction_amount: number
  shipper_indicative: number
}

/**
 * What a fleet sees when bidding (POST /pricing/justify): the trip estimate for its truck and,
 * once a bid is typed, where it lands against the trip cost. The bid is never adjusted.
 */
export type BidEstimate = {
  estimate: TripEstimate
  amount: number | null
  margin: number | null
  return_pct: number | null
  position: 'at_or_above_estimate' | 'covers_cost' | 'below_cost' | null
  note: string
  distance_km: number
  distance_basis: 'routed' | 'estimated' | 'given'
}

// ── Live tracking (bt-tracking-service read-through aggregate, LOCKED D-8) ──────

export type RouteBounds = {
  ne_lat: number
  ne_lng: number
  sw_lat: number
  sw_lng: number
}

export type TrackLocation = {
  lat: number
  lng: number
  heading: number | null
  speed_kmh: number | null
  updated_at: string
}

export type TrackEta = {
  eta_s: number
  eta_text: string
  remaining_m: number
  traffic: string
  computed_at: string
  stale: boolean
}

export type TrackAlert = {
  id: string
  type: string
  message: string | null
  lat: number | null
  lng: number | null
  acknowledged: boolean
  created_at: string
}

export type TrackData = {
  booking_id: string
  status: string
  /** Latest live fix; null until the driver starts sharing location. */
  location: TrackLocation | null
  route: {
    polyline: string
    distance_m: number
    bounds: RouteBounds
  }
  /** Live traffic ETA; null when there's no location and nothing cached. */
  eta: TrackEta | null
  destination: { lat: number; lng: number }
  alerts: TrackAlert[]
}

/** A single driver fix (GET /location/booking/:id). Trip-scoped (D-25). */
export type DriverLocation = {
  driver_id: string
  lat: number
  lng: number
  heading: number | null
  speed_kmh: number | null
  accuracy_m: number | null
  booking_id: string | null
  updated_at: string
}

// ── Drive surfaces (My Trips / Navigate / POD capture — Phase 3) ────────────────
//
// The driver-side wire shapes bt-booking-service, bt-tracking-service and
// bt-cargo-ledger speak for a trip being DRIVEN. Ported from driver/src/lib (api.ts
// interfaces) and kept snake_case verbatim — a field rename in a service is a compile
// error here rather than a silent `undefined`. bt-app is a standalone Next project
// with no @bharattruck/shared dep (same as fleet/ and driver/), so the wire shapes are
// restated rather than imported.

/** A single GPS fix the driver pushes while in transit (POST /location/update). */
export type LocationUpdate = {
  lat: number
  lng: number
  heading?: number
  speed_kmh?: number
  accuracy_m?: number
  booking_id?: string
}

/**
 * What the driver needs to trigger the delivery code (GET /bookings/:id/pod-context).
 * `receiver_email` is the inbox the one-time code is sent to — null when the shipper
 * never set one, which the UI must surface rather than let the driver tap into a
 * dead end.
 */
export type PodContext = {
  booking_id: string
  status: string
  receiver_email: string | null
}

/** Result of asking for the delivery OTP (POST /cargo/pod/request-otp). */
export type RequestOtpResult = {
  booking_id: string
  /** MASKED receiver email (e.g. j****@x.com) — show the full address from
   *  PodContext instead. */
  sent_to: string
  expires_in_seconds: number
}

/** Result of submitting the delivery code (POST /cargo/pod/verify-otp). On success the
 *  backend has already moved the trip to 'completed' — status reflects that. */
export type VerifyOtpResult = {
  booking_id: string
  status: string
}

// ── POD evidence capture (Phase 3b — bt-booking-service, migration 0025) ────────
//
// The hardened POD layer that sits ON TOP of the receiver-OTP flow above (§6.3,
// ARCHITECTURE_UNIFIED_IDENTITY.md). The OTP is the CONFIRMED tier; this is the
// evidence the driver captures at the drop regardless — camera-only, hashed on the
// device, geofenced against the delivery address — plus the ASSERTED tier for when
// the receiver cannot confirm at all. Wire shapes mirror
// bt-booking-service/src/lib/pod/service.ts verbatim (snake_case) — a field rename in
// the service is a compile error here, not a silent `undefined` on the drop screen.

/** Why a delivery was ASSERTED without a receiver-confirmed code (pod_state.assert_reason). */
export type AssertReason =
  | 'no_smartphone' | 'night_delivery' | 'warehouse_handoff'
  | 'receiver_refused_confirm' | 'no_receiver_present' | 'other'

/** A typed delivery discrepancy (pod_discrepancies.reason, §5.7). */
export type DiscrepancyReason =
  | 'shortage' | 'damage' | 'wrong_goods' | 'refusal' | 'partial_acceptance'

/** A coarse verdict on where the photo was taken relative to the drop address. */
export type GeofenceResult = 'inside' | 'outside' | 'unknown'

/**
 * A camera capture the driver records at the drop (POST /bookings/:id/pod-evidence).
 * `sha256_original` is hashed ON THE DEVICE from the photo's own bytes and sent
 * verbatim — the server stores it as the integrity anchor and never recomputes it
 * (§5.4). `capture_method` is the literal 'camera'; the bytes are never re-encoded.
 * lat/lng/gps_accuracy_m are the fix AT capture, used to geofence the photo against
 * the Rule 46(o) delivery address; all optional, because a photo with no fix still
 * captures — its geofence verdict is then 'unknown'.
 */
// Which delivery shot a capture is (migration 0039). The verified-delivery flow requires
// the signed customer invoice copy and a photo of the vehicle; both are geo-stamped.
export type EvidenceKind = 'signed_invoice' | 'vehicle' | 'goods' | 'other'

export type EvidenceCaptureInput = {
  sha256_original: string
  capture_method: 'camera'
  kind?: EvidenceKind
  // The photo bytes as base64 (no data: prefix). When present the service stores them in the
  // private bucket and re-hashes on arrival; omit for a metadata-only capture.
  image_base64?: string
  captured_at_device?: string
  lat?: number
  lng?: number
  gps_accuracy_m?: number
  gps_source?: string
  content_type?: string
  lr_number?: string
}

/**
 * Result of a capture. `created` is false when the same (booking, hash) was already
 * recorded — the write is idempotent, so a retry on a flaky rural connection returns
 * the existing row rather than a duplicate.
 */
export type CaptureResult = {
  evidence_id: string
  booking_id: string
  kind: EvidenceKind | null
  sha256_original: string
  sha256_received: string | null
  captured_at_server: string
  clock_skew_seconds: number | null
  geofence_result: GeofenceResult
  geofence_distance_m: number | null
  mock_location_detected: boolean
  storage_status: string
  created: boolean
}

/**
 * Result of asserting delivery (POST /bookings/:id/assert-delivery). The trip is now
 * `delivery_asserted` (NOT completed) with `pod_strength='asserted'`; ops closes it.
 * The server REQUIRES ≥1 captured photo to already exist and 400s otherwise, so the
 * caller must gate the action on evidence rather than let the driver hit the 400.
 */
export type AssertResult = {
  booking_id: string
  status: BookingStatus
  pod_strength: 'asserted'
  assert_reason: AssertReason
  asserted_at: string | null
  created: boolean
}

/**
 * Log a shortage/damage note (POST /bookings/:id/discrepancy). The driver reports ONLY
 * the actual quantity — the expected side is server-held (§5.7) and never sent from
 * here. A captured `evidence_id` is required when the counts differ or for damage.
 */
export type DiscrepancyInput = {
  actual_quantity: number
  reason: DiscrepancyReason
  quantity_unit?: string
  evidence_id?: string
}

/**
 * The two claim clocks surfaced on a discrepancy (§5.7): the 180-day pre-suit notice
 * runs from BOOKING, the 7-day insurance intimation from DELIVERY.
 */
export type ClaimClocks = {
  booking_date: string | null
  delivery_date: string | null
  claim_notice_deadline: string | null
  insurance_intimation_deadline: string | null
  claim_notice_days: number
  insurance_intimation_days: number
}

export type DiscrepancyResult = {
  discrepancy_id: string
  booking_id: string
  expected_quantity: number | null
  actual_quantity: number
  delta: number | null
  reason: DiscrepancyReason
  evidence_id: string | null
  driver_ack_at: string
  consignee_ack_at: string | null
  claim_clocks: ClaimClocks
  created: boolean
}

/**
 * One evidence row as the POD ledger returns it (GET /bookings/:id/pod). The forensic
 * fields (lat/lng, device fingerprint, fraud signals, storage URI) are attached by the
 * server ONLY for the shipper/ops viewer, so they are optional here — a driver reading
 * their own trip never receives them.
 */
export type PodEvidenceView = {
  evidence_id: string
  kind: EvidenceKind | null
  captured_at_server: string
  capture_method: string
  sha256_original: string
  geofence_result: GeofenceResult
  geofence_distance_m: number | null
  storage_status: string
  lr_number: string | null
  // Short-lived signed URL of the retained photo, or null when nothing was stored.
  image_url: string | null
  lat?: number | null
  lng?: number | null
  mock_location_detected?: boolean
  clock_skew_seconds?: number | null
}

export type PodDiscrepancyView = {
  discrepancy_id: string
  expected_quantity: number | null
  actual_quantity: number
  delta: number | null
  quantity_unit: string | null
  reason: DiscrepancyReason
  evidence_id: string | null
  driver_ack_at: string
  consignee_ack_at: string | null
  consignee_ack_via: string | null
  consignee_user_id: string | null
  claim_clocks: ClaimClocks
}

/**
 * The POD ledger for a trip (GET /bookings/:id/pod) — proof strength, the evidence
 * list and the discrepancy. `pod_hardening_available` is false on a database without
 * migration 0025 (the read degrades to "nothing recorded" rather than failing), so a
 * caller must treat an empty evidence list as "none captured yet", never as an error.
 */
export type PodRecord = {
  booking_id: string
  status: BookingStatus
  viewer_relations: BookingRelation[]
  pod_hardening_available: boolean
  pod_strength: 'confirmed' | 'asserted' | null
  confirmed_at: string | null
  confirmed_via: string | null
  asserted_at: string | null
  assert_reason: AssertReason | null
  closed_by_ops_at: string | null
  // The fleet owner's review of the delivery evidence (migration 0039).
  fleet_review_status?: 'pending' | 'approved' | 'rejected' | null
  fleet_reviewed_at?: string | null
  fleet_review_note?: string | null
  evidence: PodEvidenceView[]
  discrepancy: PodDiscrepancyView | null
}

// The fleet owner's approve/reject of a delivery's evidence (POST /bookings/:id/pod/verify).
export type VerifyDeliveryResult = {
  booking_id: string
  fleet_review_status: 'approved' | 'rejected'
  fleet_reviewed_at: string
  note: string | null
  created: boolean
}

// One row in the fleet owner's review queue (GET /bookings/pod/fleet-pending).
export type FleetPendingItem = {
  booking_id: string
  pod_strength: 'confirmed' | 'asserted'
  asserted_at: string | null
  confirmed_at: string | null
  status: BookingStatus
  source_address: string
  destination_address: string
  shipper_name: string
  driver_id: string | null
}

export type FleetPendingResult = { pending: FleetPendingItem[] }

/** Cached base polyline for the lane (GET /tracking/route/:id). One call per trip. */
export type RouteData = {
  polyline: string
  distance_m: number
  static_duration_s: number
  bounds: { ne_lat: number; ne_lng: number; sw_lat: number; sw_lng: number }
  cached: boolean
}

export type PetrolPump = {
  place_id: string
  name: string
  lat: number
  lng: number
  distance_m: number
  address: string | null
  brand: string | null
}

export type PumpsData = {
  booking_id: string
  origin: { lat: number; lng: number }
  /** Which position the search was anchored at, so the UI can say so honestly. */
  origin_source: 'live_position' | 'last_breadcrumb' | 'pickup_point'
  limit: number
  radius_m: number
  pump_count: number
  pumps: PetrolPump[]
  cached: boolean
}

export type FuelData = {
  booking_id: string
  vehicle_id: string | null
  distance_basis: 'override' | 'driven' | 'planned' | 'unknown'
  distance_note: string
  distance_km: number
  mileage_kmpl: number
  diesel_price_inr: number
  litres_required: number
  diesel_cost_inr: number
  def_cost_inr: number
  estimated_fuel_cost_inr: number
  vehicle_class: string | null
  basis: 'vehicle_norms' | 'vehicle_class' | 'default'
  /** Plain-language provenance — render it, never present an estimate as measured. */
  basis_note: string
  inputs_overridden: string[]
}

export type TripAlert = {
  id: string
  type: string
  message: string | null
  severity: 'info' | 'warning' | 'critical'
  acknowledged: boolean
  resolved_at: string | null
  created_at: string
}

export type AlertsData = {
  booking_id: string
  evaluated_at: string
  thresholds: { off_route_m: number; idle_seconds: number; near_drop_m: number; speeding_kmh: number }
  current_location: { deviation_m: number | null; off_route: boolean | null; distance_to_drop_m: number } | null
  open_count: number
  alerts: TripAlert[]
}

// ── Freight documents (Phase 4 — bt-booking-service, migration 0024) ────────────
//
// The paperwork a real freight trip generates: the carrier's consignment note (LR),
// the shipper's tax invoice, and the recorded e-way bill(s). Wire shapes mirror
// bt-booking-service/src/lib/documents/{service,repository,rules}.ts verbatim
// (snake_case). The platform is never a named party — the LR issuer is derived
// server-side from the booking + actor, never sent (red line 1, §1.3).

export type FreightTerm = 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'

/** Consignment note / lorry receipt (lorry_receipts). Issued by the CARRIER. */
export type LorryReceipt = {
  id: string
  booking_id: string
  lr_number: string
  financial_year: string
  issuer_legal_name: string
  consignor_name: string
  consignee_name: string
  origin_place: string
  destination_place: string
  vehicle_number: string | null
  actual_weight_kg: number
  charged_weight_kg: number
  said_to_contain: string
  freight_charge_inr: number
  total_charge_inr: number
  freight_term: FreightTerm
  invoice_number: string | null
  eway_bill_number: string | null
  issued_at: string
  /** Convenience total the server echoes on issue (the charge lines summed). */
  charges_total_inr?: number
}

/** The shipper's tax invoice (freight_invoices). */
export type FreightInvoice = {
  id: string
  booking_id: string
  invoice_number: string
  financial_year: string
  supplier_legal_name: string
  billed_to_name: string
  taxable_value_inr: number
  consignment_value_inr: number
  grand_total_inr: number
  lr_number: string | null
  eway_bill_number: string | null
  issued_at: string
}

/** Expiry verdict computed from the STORED valid_upto (never a stored 'expired'). */
export type EwayBillExpiry = {
  state: 'valid' | 'expiring_soon' | 'expired'
  hours_remaining: number
  valid_upto: string
}

/** A recorded (externally generated) e-way bill (eway_bill_records, D-17). */
export type EwayBillRecord = {
  id: string
  booking_id: string
  ewb_number: string
  generated_at: string
  valid_upto: string
  issuing_portal: 'NIC1' | 'NIC2'
  status: 'active' | 'cancelled' | 'rejected'
  /** When and why a cancel/reject was filed (null while the bill stands). */
  status_changed_at: string | null
  status_reason: string | null
  document_number: string | null
  consignment_value_inr: number | null
  expiry: EwayBillExpiry
}

/**
 * Everything on file for a booking (GET /bookings/:id/documents). Degrades to all-null
 * / empty on a pre-0024 database rather than failing, so an empty result means "none
 * issued yet", never an error. `standing_eway_bill_number` is the bill that currently
 * STANDS (skipping any the portal cancelled/rejected) — the list alone cannot say which.
 */
export type BookingDocuments = {
  booking_id: string
  lorry_receipt: LorryReceipt | null
  invoice: FreightInvoice | null
  eway_bills: EwayBillRecord[]
  standing_eway_bill_number: string | null
}

/**
 * Issue a consignment note (POST /bookings/:id/documents/lr). Most fields prefill from
 * the booking; the caller confirms the weight, description, freight charge and term. The
 * ISSUER is derived server-side from the booking + actor and can never be set from here.
 */
export type IssueLorryReceiptInput = {
  consignor_name: string
  consignee_name: string
  consignee_gstin?: string
  consignee_address?: string
  origin_place: string
  destination_place: string
  vehicle_number?: string
  actual_weight_kg: number
  said_to_contain: string
  freight_charge_inr: number
  freight_term: FreightTerm
}

/**
 * Issue the shipper's tax invoice (POST /bookings/:id/documents/invoice). This is the
 * SHIPPER's document for the GOODS they sold — billed to the consignee — NOT a freight
 * bill. Only `billed_to_name` and `taxable_value_inr` are required; the server computes
 * the consignment value and grand total, and returns the e-way-bill requirement. `igst_inr`
 * covers interstate movement (BharatTruck's focus); intra-state CGST+SGST is a follow-up.
 */
export type IssueInvoiceInput = {
  billed_to_name: string
  billed_to_gstin?: string
  taxable_value_inr: number
  igst_inr?: number
  place_of_supply_state?: string
}

/**
 * Record an externally generated e-way bill (POST /bookings/:id/documents/eway-bill,
 * D-17 — we record theirs, we generate nothing). `valid_upto` is REQUIRED and stored
 * verbatim: a day of validity expires at midnight of the day FOLLOWING generation, so
 * it cannot be derived locally (§4.4). Either party may file it (whoever holds the paper).
 */
export type RecordEwayBillInput = {
  ewb_number: string
  generated_at: string
  valid_upto: string
  issuing_portal: 'NIC1' | 'NIC2'
  document_number?: string
}

/**
 * File what the portal did to a bill (PATCH /bookings/:id/documents/eway-bill/:ewbNumber,
 * §4.5): cancelled within 24h, rejected within 72h. We record the portal's act; we do not
 * adjudicate its window. This is what makes `standing_eway_bill_number` answerable.
 */
export type SetEwayBillStatusInput = {
  status: 'cancelled' | 'rejected'
  reason?: string
}

// ── Persona completeness (D-33 ring — bt-auth-service GET /api/me/completeness) ──
//
// DISPLAY-ONLY, NEVER GATES (D-31). The payload even carries `gates_nothing: true` so a
// client cannot misread a low percentage as a permission decision. Per persona the human
// HAS (shipper=everyone, driver=has a drivers row, fleet_owner=has a fleet_owners row) it
// lists the D-33 requirement set; each item is 'verified' (a checked doc), 'declared' (a
// typed datum OR a signed D-31 acknowledgement — both count), or 'missing' (a prompt).

export type CompletenessItemStatus = 'verified' | 'declared' | 'missing'

export type CompletenessItem = {
  key: string
  label: string
  status: CompletenessItemStatus
  /** The acknowledgement kind that flips a 'missing' item to 'declared' (D-31), or null. */
  acknowledgement_kind: string | null
  note: string
}

export type PersonaCompleteness = {
  persona: 'shipper' | 'driver' | 'fleet_owner'
  /** Share of items that are not 'missing' (verified OR declared both count). */
  percentage: number
  items: CompletenessItem[]
}

export type CompletenessReport = {
  /** Machine-readable "this never gates" — a client must not treat a low % as a block. */
  gates_nothing: true
  overall_percentage: number
  personas: PersonaCompleteness[]
}

// ── Payment settlement (bt-payment-service — cash-recorded, NO escrow) ──────────
//
// The CLOSING step of the trip lifecycle: a `completed` trip is settled and the
// booking flips completed → paid. Escrow/Razorpay are OUT of MVP (§2) — this records
// a real-world cash/UPI/direct settlement. Wire shapes mirror
// bt-payment-service/src/lib/payment-store.ts (PaymentRecord/PayoutRecord) + the
// settle() return, snake_case verbatim — a field rename in the service is a compile
// error here, not a silent `undefined` on the receipt.

export type PaymentMode = 'cash' | 'upi' | 'direct'

/**
 * The payment (payments row). One per booking. A settlement RECORDED by the shipper is
 * cash/upi/direct + 'settled'; one PAID ONLINE is 'razorpay' + 'captured', with the
 * gateway's payment id as the reference.
 */
export type PaymentRecord = {
  booking_id: string
  amount: number
  mode: PaymentMode | 'razorpay' | 'razorpay_test'
  reference: string | null
  recorded_by: string
  status: 'settled' | 'captured'
}

/**
 * One payee's cut of a settled trip (D-7 split). A solo trip pays the driver 100%;
 * a fleet trip may split between the owner and the driver per the affiliation. Both
 * id columns are present with one null — the pairing is server-enforced.
 */
export type PayoutRecord = {
  booking_id: string
  payee_type: 'driver' | 'fleet_owner'
  driver_id: string | null
  fleet_owner_id: string | null
  amount: number
  mode: PaymentMode | null
  status: 'pending' | 'recorded'
  recorded_by: string | null
}

/**
 * GET /payments/status/:id — the recorded payment + payout(s) for a booking. `payout`
 * is the BIDDER's row (the party the shipper contracted with); `payouts` is every
 * payee. Both null / empty until a settlement is recorded.
 */
export type PaymentStatus = {
  booking_id: string
  payment: PaymentRecord | null
  payout: PayoutRecord | null
  payouts: PayoutRecord[]
}

/**
 * POST /payments/settle — records the settlement and asks booking-service to run
 * completed → paid. Idempotent: a retry returns the existing settlement with
 * `already_settled: true` rather than double-recording.
 */
export type SettleResult = PaymentStatus & {
  status: 'paid'
  already_settled: boolean
}

/** GET /payments/config — is online payment switched on (Razorpay keys set on the server)? */
export type PaymentConfig = {
  razorpay: { enabled: boolean; key_id: string | null; test_mode: boolean }
}

/**
 * POST /payments/razorpay/order — the order the checkout opens with (`amount` in paise).
 * If an earlier order for this booking was already paid, the trip is closed on it and the
 * settlement comes back instead.
 */
export type OnlineOrder =
  | { already_paid: false; order_id: string; amount: number; currency: string; key_id: string; test_mode: boolean }
  | { already_paid: true; settlement: SettleResult }

/** What Razorpay's checkout hands the page on success; sent to the server to verify. */
export type CheckoutSuccess = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

/** POST /payments/razorpay/sync — `synced` when an earlier online payment was found and applied. */
export type OnlineSync = PaymentStatus & { synced: boolean; status: string }

// ── Government-record verification (bt-auth-service /kyc/*) ──

/** What the deployment can verify: which provider answers, and whether GST lookups / DigiLocker are on. */
export type KycConfig = { provider: 'console' | 'surepass' | 'sandbox'; gst_lookup: boolean; digilocker: boolean; gst_otp?: boolean }

/** POST /kyc/gst/otp/verify — the GSTIN is the caller's own (OTP to its registered mobile), plus the registered names. */
export type GstOtpVerified = {
  verified: true
  gstin: string
  legal_name: string | null
  trade_name: string | null
  kyc_level: 'L0' | 'L1' | 'L2' | 'L3'
  /** false when the verification was recorded but users.gstin could not be written. */
  gstin_saved: boolean
}

/** The GST portal's public record for a GSTIN. */
export type GstinProfile = {
  gstin: string
  valid: boolean
  legal_name: string | null
  status: string | null
  active: boolean
  pan: string | null
  state_code: string | null
  state_name: string | null
  business_nature: string | null
  registered_since: string | null
  /** The firm's name as traded — a proprietorship's legal name is the proprietor's own name. */
  trade_name: string | null
  /** When nothing could be read: the portal's own message. */
  reason: string | null
}

/** Does this business file its GST returns? A trust signal, never a gate. */
export type GstFilingSummary = {
  gstin: string
  financial_year: string
  gstr3b_filed: number
  gstr1_filed: number
  last_period: string | null
  last_filed_on: string | null
  months_elapsed: number
  gstr3b_missing: number
  verdict: 'regular' | 'behind' | 'none'
}

export type KycVerifyResult = {
  type: string
  result: { status: 'success' | 'failed' | 'pending' | 'manual_review'; error?: string }
  kyc_level: 'L0' | 'L1' | 'L2' | 'L3'
}

/** GET /kyc/status/:userId — level plus per-document status; never a number. */
export type KycStatusView = {
  user_id: string
  kyc_level: 'L0' | 'L1' | 'L2' | 'L3'
  verifications: Record<string, { status: 'success' | 'failed' | 'pending' | 'manual_review'; verified_at: string | null }>
}

export type DigiLockerSession = { session_id: string; authorization_url: string }
export type DigiLockerStatus = { status: 'created' | 'succeeded' | 'expired' | 'failed'; documents_consented: string[] }
export type DigiLockerImport = {
  profile: { name: string | null; date_of_birth: string | null; gender: string | null } | null
  licence: {
    dl_number: string | null
    name: string | null
    expiry_date: string | null
    transport_expiry_date: string | null
    vehicle_classes: string[]
    issuing_authority: string | null
  } | null
  applied: { licence_saved: boolean; aadhaar_recorded: boolean }
  warnings: string[]
}

// ── E-way bills on NIC's portal (bt-booking-service /bookings/:id/documents/eway-bill/*) ──

export type EwayPortalCredentialsView = { configured: boolean; gstin: string | null; username: string | null; updated_at: string | null }

export type EwayGenerateDefaults = {
  portal_linked: boolean
  shipper_gstin: string | null
  document_number: string | null
  document_date: string | null
  consignee_name: string | null
  consignee_gstin: string | null
  product_name: string | null
  total_invoice_value_inr: number | null
  taxable_value_inr: number | null
  vehicle_number: string | null
  transporter_id: string | null
  from_place: string | null
  to_place: string | null
  inter_state: boolean | null
  weight_kg: number | null
  distance_km?: number | null
  gst_rate?: 0 | 5 | 12 | 18 | 28 | null
}

export type GenerateEwayBillInput = {
  document_number: string
  document_date: string
  consignee_name: string
  consignee_gstin?: string | null
  hsn_code: string
  product_name: string
  taxable_value_inr: number
  gst_rate: 0 | 5 | 12 | 18 | 28
  total_invoice_value_inr: number
  distance_km: number
  vehicle_number?: string | null
  transporter_id?: string | null
  from_place: string
  to_place: string
}

export type UpdateEwayVehicleInput = { vehicle_number: string; reason_code: '1' | '2' | '3' | '4'; remarks: string; from_place: string }
export type ExtendEwayBillInput = {
  remaining_distance_km: number; reason_code: 1 | 2 | 3 | 4 | 99; remarks: string; from_place: string; from_pincode: string
  vehicle_number?: string | null; consignment_status?: 'M' | 'T'; transit_type?: 'R' | 'W' | 'O'; address_line1?: string
}
export type CancelEwayOnPortalInput = { reason_code: 1 | 2 | 3 | 4; remarks?: string }

// ── Driver-document scan (POST /onboarding/ocr) ──
// Suggestions read off a photo. A field that could not be read is null; the driver confirms
// the form before anything is saved.

export type LicenceScan = {
  dl_number: string | null
  name: string | null
  date_of_birth: string | null
  expiry_date: string | null
  vehicle_classes: string[]
}

export type BankScan = {
  account_number: string | null
  ifsc: string | null
  bank_name: string | null
  account_holder_name: string | null
}

export type GstCertificateScan = {
  gstin: string | null
  /** The PAN embedded in the GSTIN (characters 3–12). */
  pan: string | null
  legal_name: string | null
  trade_name: string | null
  constitution: string | null
  address: string | null
  registered_from: string | null
}

export type PanCardScan = {
  pan: string | null
  name: string | null
  date_of_birth: string | null
  holder_type: 'person' | 'company' | 'firm' | 'huf' | 'trust' | 'other' | null
}

/** An Aadhaar scan: the details, never the number (only its last four digits, to recognise the card). */
export type AadhaarScan = {
  name: string | null
  date_of_birth: string | null
  year_only: boolean
  gender: 'male' | 'female' | 'other' | null
  address: string | null
  city: string | null
  pincode: string | null
  state: string | null
  aadhaar_last4: string | null
}

export type ScanKind = 'licence' | 'bank' | 'gst' | 'pan' | 'aadhaar'

export type ScanFields = {
  licence: LicenceScan
  bank: BankScan
  gst: GstCertificateScan
  pan: PanCardScan
  aadhaar: AadhaarScan
}

export type DocumentScan<K extends ScanKind> = {
  kind: K
  fields: ScanFields[K]
  /** How many fields were read. 0 = the photo could not be read. */
  found: number
}

// ── Driver self-onboarding (bt-auth-service /onboarding/*, gateway /api/onboarding/) ──
//
// A driver completes THEIR OWN record — details, driving licence, bank — with no truck
// (2026-09-30). Trucks are a separate, GST-gated step (see GSTIN_REQUIRED in api.ts).

export type VerificationBadge = 'pending' | 'verified' | 'premium'

export type DriverProfile = {
  id: string
  user_id: string
  photo_url: string | null
  languages: string[] | null
  home_base_city: string | null
  home_base_lat: number | null
  home_base_lng: number | null
  verification_badge: VerificationBadge
  is_available: boolean | null
}

export type DriverLicense = {
  id: string
  driver_id: string
  dl_number: string
  vehicle_classes: string[] | null
  expiry_date: string | null
  /** 'pending' until an ops check marks it 'verified'. */
  status: string
}

export type BankAccount = {
  id: string
  account_number_last4: string
  ifsc: string
  bank_name: string | null
  account_holder_name: string
  is_primary: boolean
  verification_status: string | null
}

/** GET /onboarding/profile */
export type DriverOnboarding = {
  user: {
    id: string
    full_name: string | null
    phone_number: string | null
    email: string | null
    kyc_status: string | null
  }
  driver: DriverProfile
  license: DriverLicense | null
  vehicles: unknown[]
  bank_accounts: BankAccount[]
}

export type OnboardingChecklist = {
  profile_complete: boolean
  license_submitted: boolean
  license_verified: boolean
  vehicle_registered: boolean
  vehicle_verified: boolean
  insurance_uploaded: boolean
  bank_linked: boolean
}

/** GET /onboarding/status */
export type OnboardingStatus = {
  verification_badge: VerificationBadge
  checklist: OnboardingChecklist
}

/** GET /bookings/bahi/connection — the account's Bahi Khata link (the token itself is never returned). */
export type BahiConnectionView = {
  linked: boolean
  /** The Bahi login it was linked with. */
  email: string | null
  company_name: string | null
  gstin: string | null
  gst_rate: number
  linked_at: string | null
  available: boolean
}

/** One paid load posted (or not) into the account's Bahi books. */
export type BahiPostingView = {
  booking_id: string
  kind: 'income' | 'expense'
  status: 'posted' | 'awaiting_approval' | 'draft' | 'failed'
  bahi_number: string | null
  amount_inr: number | null
  note: string | null
  error: string | null
  updated_at: string
}
