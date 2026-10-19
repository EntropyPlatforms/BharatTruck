import { z } from 'zod'
import { AppError, type ErrorCode } from '@bharattruck/shared/errors'
import { isGstin, normalizeIndianMobile, type ConsigneeParty } from './consignee/rules.js'

// -----------------------------------------------------------
// BookingStatus — mirrors the DB enum booking_status exactly
//
// 'delivery_asserted' (migration 0025) is the branch for a delivery the receiver
// could not confirm: the driver captured evidence, the trip is delivered-but-
// unconfirmed, and ops — not the driver — closes it to 'completed'. It is a real
// enum value, so a database where 0025 has NOT been applied can never hold a
// booking in this state, and the state machine below simply never routes into it
// there. See docs/ARCHITECTURE_UNIFIED_IDENTITY.md §6.3.
// -----------------------------------------------------------

export type BookingStatus = 'pending' | 'accepted' | 'in_transit' | 'delivery_asserted' | 'completed' | 'paid' | 'cancelled' | 'negotiating'

// -----------------------------------------------------------
// BookingType — direct (1:1) or auction (1:many quotes)
// -----------------------------------------------------------

export type BookingType = 'direct' | 'auction'

// -----------------------------------------------------------
// BookingAwardPath — HOW the carrier on this trip was chosen. Mirrors the DB
// enum booking_award_path (migration 0022) exactly.
//
// Orthogonal to BookingType, which says how the load was OFFERED. A 'direct'
// booking taken off the load board is award_path 'instant'; the same booking
// moved by the shipper's own fleet is 'direct_attach' (D-10). The column is
// RECORDED rather than inferred: "the shipper and the carrier are the same
// human" is true at award time and can stop being true later (a fleet is sold, a
// driver leaves), and an audit trail that changes its mind about how a trip was
// won is not an audit trail.
// -----------------------------------------------------------

export type BookingAwardPath = 'auction' | 'instant' | 'direct_attach'

// -----------------------------------------------------------
// QuoteStatus — lifecycle of a driver's quote on a booking
// -----------------------------------------------------------

export type QuoteStatus = 'submitted' | 'countered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired'

// -----------------------------------------------------------
// DbBooking — raw row shape from the `bookings` table
// -----------------------------------------------------------

export type DbBooking = {
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
  // Geocoding (migration 0035). Optional/nullable and possibly ABSENT on pre-0035 rows, so
  // every read is guarded rather than trusted. The address pins (source_lat/lng, dest_lat/lng)
  // drive distance; the *_gate_* pins are the dragged exact points the POD geofence prefers.
  // Numerics can come back from PostgREST as strings, hence number | string on the coords.
  source_place_id?: string | null
  source_pincode?: string | null
  source_state_code?: string | null
  dest_place_id?: string | null
  dest_pincode?: string | null
  dest_state_code?: string | null
  source_gate_lat?: number | string | null
  source_gate_lng?: number | string | null
  dest_gate_lat?: number | string | null
  dest_gate_lng?: number | string | null
  load_type: string
  weight_kg: number
  quoted_price: number
  final_price: number | null
  pickup_date: string
  pickup_time_slot: string | null
  status: BookingStatus
  special_instructions: string | null
  receiver_email: string | null   // consignee inbox for receiver-OTP POD (migration 010)
  // The receiving party as a FIRST-CLASS entity (migration 0026, D-22) — a
  // users.id that may be UNCLAIMED (a record with a name and a phone and no
  // credential). NULL on the 672 legacy bookings that predate the model, and
  // absent entirely on a database where 0026 has not landed, which is why every
  // read of it is truthiness-checked rather than trusted to be there.
  consignee_user_id: string | null
  booking_type: BookingType
  target_driver_id: string | null
  auction_deadline: string | null
  min_acceptable: number | null
  // NULL on a direct-attached trip as well as on an unawarded one: direct-attach
  // skips the auction, so there is no winning quote to point at. `award_path` —
  // not this column — is what says whether a booking has a carrier.
  awarded_quote_id: string | null
  award_path: BookingAwardPath
  dimensions_json: Record<string, unknown> | null
  // Fleet persona (migration 016). Both NULL on every solo-driver booking, which
  // is what keeps the solo flow on its original code paths: fleet_owner_id is set
  // only when a FLEET quote wins the auction, and vehicle_id only when the owner
  // pairs a truck to the trip in bt-fleet-service.
  fleet_owner_id: string | null
  vehicle_id: string | null
  // POD discrepancy reconciliation (migration 0025). The SERVER-HELD expected
  // delivery quantity + its unit, set by the shipper/ops and NEVER the driver
  // (§5.7). Both NULL on every pre-0025 booking, and read back as "no server-held
  // count" by the discrepancy flow — so a database without 0025 selecting `*` off
  // bookings simply never sees these columns, and nothing that reads them breaks.
  pod_expected_quantity: number | null
  pod_quantity_unit: string | null
  created_at: string
  updated_at: string
}

// -----------------------------------------------------------
// DbQuote — raw row shape from the `quotes` table
// -----------------------------------------------------------

// A bid comes from EITHER a solo driver OR a fleet owner — migration 016 made
// driver_id nullable and added fleet_owner_id under a
// `num_nonnulls(driver_id, fleet_owner_id) = 1` check. Exactly one is ever set.

export type DbQuote = {
  id: string
  booking_id: string
  driver_id: string | null
  fleet_owner_id: string | null
  amount: number
  message: string | null
  status: QuoteStatus
  submitted_at: string
  expires_at: string | null
  updated_at: string
}

// -----------------------------------------------------------
// QuoteCarrier — the party behind a bid, resolved for display
// -----------------------------------------------------------

// A quote row identifies its bidder only by id, and WHICH id depends on the
// party kind (driver_id XOR fleet_owner_id). Neither is resolvable by the
// shipper app: drivers.id/fleet_owners.id are server-side identities it never
// holds. So the shipper had nothing to render but a raw uuid — and once fleet
// owners could bid, `driver_id` came back NULL and the column it was reading
// did not exist at all. Resolving the party here is what makes a bid
// attributable to a carrier the shipper can actually choose between.

export type QuoteCarrier = {
  kind: 'driver' | 'fleet'
  id: string
  /**
   * Display name — `users.full_name` for a solo driver, `company_name` for a
   * fleet. Nullable: a driver row whose user has no name on file is a live case
   * (the seeded demo drivers are exactly that), so the client must still have a
   * fallback rather than treat this as guaranteed.
   */
  name: string | null
  /** Driver-only. A fleet bid names no truck — that is chosen at assignment. */
  truck_number: string | null
  average_rating: number | null
  total_trips: number | null
}

export type QuoteWithCarrier = DbQuote & {
  /** Null only if the referenced party row has since been deleted. */
  carrier: QuoteCarrier | null
}

// -----------------------------------------------------------
// DbNegotiation — append-only log of price offers/counters
// -----------------------------------------------------------

export type DbNegotiation = {
  id: string
  quote_id: string
  booking_id: string
  actor_id: string
  // 'fleet_owner' is written when the carrier side of a negotiation is a fleet.
  // The live negotiations.actor_role CHECK still only allows shipper|driver, so
  // that write is best-effort until the constraint is widened (see quote-service).
  actor_role: 'shipper' | 'driver' | 'fleet_owner'
  amount: number
  message: string | null
  created_at: string
}

// -----------------------------------------------------------
// DriverProfile — joined from drivers + users
// -----------------------------------------------------------

export type DriverProfile = {
  id: string
  truck_number: string
  truck_type: string
  truck_capacity_kg: number | null
  average_rating: number
  total_trips: number
  user: {
    id: string
    full_name: string | null
    phone_number: string
  }
}

// -----------------------------------------------------------
// BookingWithProfiles — booking row with optional driver join
// -----------------------------------------------------------

export type BookingWithProfiles = DbBooking & {
  driver?: DriverProfile | null

  /**
   * The receiving party, projected down to what a booking read may disclose
   * (see ConsigneeParty). ABSENT — not null — for a viewer with no relation to
   * this booking, and absent on a pre-0026 database or a legacy booking that
   * names no consignee. Attached by consignee/service.ts, never selected here.
   */
  consignee?: ConsigneeParty | null

  /**
   * Driver-facing only: is the CALLER the driver assigned to this trip?
   *
   * Server-computed because the client cannot work it out — `driver_id` is a
   * `drivers.id`, and the app only ever holds the `users.id` from its JWT. The
   * driver app needs the answer to decide whether to show the trip lifecycle
   * (start / navigate / POD) or the marketplace bid form, and its previous
   * stand-in for it — "do I own a quote on this booking?" — was wrong for BOTH
   * personas: a fleet driver never owns a quote (their owner bids), and a solo
   * driver who took a load with PATCH /accept has no quote row either. Both
   * were shown a bid form for a trip they were already driving.
   *
   * Absent for shipper/admin callers, who are not drivers.
   */
  assigned_to_me?: boolean
}

// -----------------------------------------------------------
// Auth types — canonical in @bharattruck/shared/auth (the users.id vs
// drivers.id identity contract lives there); re-exported for existing importers.
// -----------------------------------------------------------

export type { AuthenticatedUser, UserRole } from '@bharattruck/shared/auth'

// -----------------------------------------------------------
// CreateBookingBodySchema — request body for POST /bookings
// Shipper info (shipper_id, shipper_name, shipper_contact)
// is filled server-side from the JWT — not accepted from client.
// -----------------------------------------------------------

const latitude  = z.number().min(-90).max(90)
const longitude = z.number().min(-180).max(180)

// -----------------------------------------------------------
// ConsigneeInputSchema — the receiving party, named at posting time (D-22).
//
// NAME AND PHONE ARE BOTH REQUIRED, and the phone is the load-bearing one
// (D-29): a load must have a REACHABLE consignee. That single rule is what
// actually retires the receiver-email trap — a booking whose receiver has no
// contact on file can never be closed by the receiver-OTP POD, so it dead-ends
// short of 'completed' and short of the payout that gates. A nullable column
// plus a nudge email was the old answer and it left 672 of 677 live bookings
// with no receiver at all.
//
// Everything else is optional because a shipper posting at 6am knows their
// customer's name and number and often nothing else. The missing fields are
// exactly the ones the LR and e-way bill want (§2), so the party record is
// completable later — by the consignee themselves, once they claim it.
//
// The phone is NORMALISED here rather than validated in place. See
// consignee/rules.ts: the unique index on users(phone_number) is the dedup
// mechanism, and an index can only dedup values spelled the same way.
// -----------------------------------------------------------

/**
 * Today's calendar date in India, as YYYY-MM-DD.
 *
 * IST is UTC+05:30 with no DST, so shifting the epoch and reading the UTC date back is
 * exact — and gives a string directly comparable to the YYYY-MM-DD a client sends.
 * Exported so the rule can be asserted on without waiting for 00:30 IST.
 */
export function istToday(): string {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

export const ConsigneeInputSchema = z.object({
  name:  z.string().trim().min(1, 'consignee.name is required'),
  phone: z.string()
           .transform(normalizeIndianMobile)
           .refine((p): p is string => p !== null,
                   'consignee.phone must be a 10-digit Indian mobile number'),
  email: z.string().trim().email('consignee.email must be a valid email address').optional(),
  // Uppercased before checking: a GSTIN is canonically uppercase and is stored
  // that way, and the state code read off its first two digits decides intra-
  // vs inter-state supply on an invoice.
  gstin: z.string().trim().toUpperCase()
           .refine(isGstin, 'consignee.gstin must be a valid 15-character GSTIN')
           .optional(),
  address: z.string().trim().min(1).optional(),
  city:    z.string().trim().min(1).optional(),
  state:   z.string().trim().min(1).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, 'consignee.pincode must be 6 digits').optional(),
})

export type ConsigneeInput = z.infer<typeof ConsigneeInputSchema>

export const CreateBookingBodySchema = z.object({
  // The shipper sends the price-lock handle, NOT a raw price. quoted_price is
  // resolved server-side from the locked price_quotes row (PRD 5.4: price SHOWN
  // == price CHARGED) — the client can no longer type its own number.
  quote_id:             z.string().uuid(),
  source_address:       z.string().min(1),
  source_lat:           latitude,
  source_lng:           longitude,
  destination_address:  z.string().min(1),
  dest_lat:             latitude,
  dest_lng:             longitude,
  load_type:            z.string().min(1),
  weight_kg:            z.number().positive(),
  // The requested truck class, bound to the locked quote at create time (the
  // price scales ~2.9x across classes — mini_truck rate 12 → trailer rate 35 —
  // so it MUST match what was priced). Enum mirrors bt-pricing-service's
  // accepted vehicle_type set (single source of truth is pricing's QuoteBody).
  vehicle_type:         z.enum(['mini_truck', 'lcv', 'hcv', 'trailer']),
  pickup_date:          z.string()
                          .regex(/^\d{4}-\d{2}-\d{2}$/, 'pickup_date must be YYYY-MM-DD')
                          // Compared against today IN INDIA, not in UTC. pickup_date is a
                          // plain calendar date keyed in by an Indian shipper, so anchoring
                          // it at UTC midnight accepted YESTERDAY's Indian date every night
                          // between 00:00 and 05:30 IST — the window in which UTC is still
                          // on the previous day. Same reasoning (and same +05:30) as
                          // bt-fleet-service's IST_START_OF_DAY in vehicle-schedule.ts.
                          //
                          // Both sides are YYYY-MM-DD, so a string compare IS the date
                          // compare — no Date parsing, no timezone re-entering by the back
                          // door. Kept in step with bt-app's todayInIndia().
                          .refine(d => d >= istToday(), 'pickup_date cannot be in the past'),
  pickup_time_slot:     z.string().optional(),
  special_instructions: z.string().optional(),
  // The receiving party (D-22). Optional ONLY for back-compat with clients that
  // still send receiver_email — see the refinement below, which requires one of
  // the two. New clients send this.
  consignee:            ConsigneeInputSchema.optional(),
  // Consignee inbox the receiver-OTP POD code is emailed to. SUPERSEDED by
  // `consignee` and now optional at the schema level, which does NOT relax the
  // rule: a create supplying neither is refused exactly as it was before. Still
  // persisted to bookings.receiver_email (read back by getPodContext and by
  // bt-cargo-ledger's POD flow), so nothing downstream notices the change. Now
  // .trim()ed, matching PATCH /bookings/:id/receiver-email — a pasted address
  // with padding is typed on a phone and was the one shape create rejected and
  // the edit route accepted.
  receiver_email:       z.string().trim().email().optional(),
  booking_type:         z.enum(['direct', 'auction']).default('direct'),
  target_driver_id:     z.string().uuid().optional(),
  auction_deadline:     z.string().datetime().optional(),
  dimensions_json:      z.record(z.unknown()).optional(),
  // Geocoding (D-020 / migration 0035). Optional and additive: a legacy client that still
  // sends hand-typed source_lat/lng and no place_id posts exactly as before. New clients pick
  // an address (place_id + pincode + state_code from the details endpoint) and may drag an
  // exact-gate pin (*_gate_lat/lng) distinct from the address pin — geofence uses the gate,
  // distance uses the address pin.
  source_place_id:      z.string().max(512).optional(),
  source_pincode:       z.string().regex(/^\d{6}$/, 'source_pincode must be 6 digits').optional(),
  source_state_code:    z.string().regex(/^\d{2}$/, 'source_state_code must be a 2-digit GST code').optional(),
  dest_place_id:        z.string().max(512).optional(),
  dest_pincode:         z.string().regex(/^\d{6}$/, 'dest_pincode must be 6 digits').optional(),
  dest_state_code:      z.string().regex(/^\d{2}$/, 'dest_state_code must be a 2-digit GST code').optional(),
  source_gate_lat:      latitude.optional(),
  source_gate_lng:      longitude.optional(),
  dest_gate_lat:        latitude.optional(),
  dest_gate_lng:        longitude.optional(),
})
  // D-29, expressed at the edge: a load must name a reachable receiver. The
  // check is "at least one", not "consignee only", because bt-booking-service
  // deploys on merge while its clients ship on their own cadence — making
  // `consignee` mandatory today would 400 every booking the live shipper app
  // posts. A receiver_email-only create is accepted, recorded exactly as it is
  // now, and named as the legacy path so it can be removed on evidence rather
  // than on faith.
  .refine(
    (b) => b.consignee !== undefined || b.receiver_email !== undefined,
    {
      message: 'A booking must name its consignee (consignee.name + consignee.phone), ' +
               'or supply receiver_email for the legacy receiver-OTP flow',
      path: ['consignee'],
    },
  )

export type CreateBookingBody = z.infer<typeof CreateBookingBodySchema>

// -----------------------------------------------------------
// SubmitQuoteBodySchema — request body for POST /quotes
// -----------------------------------------------------------

export const SubmitQuoteBodySchema = z.object({
  amount:  z.number().positive(),
  message: z.string().optional(),
})

export type SubmitQuoteBody = z.infer<typeof SubmitQuoteBodySchema>

// -----------------------------------------------------------
// CounterQuoteBodySchema — request body for PATCH /quotes/:id/counter
// -----------------------------------------------------------

export const CounterQuoteBodySchema = z.object({
  amount:  z.number().positive(),
  message: z.string().optional(),
})

export type CounterQuoteBody = z.infer<typeof CounterQuoteBodySchema>

// -----------------------------------------------------------
// BookingError — domain error, now a thin subclass of the shared AppError
// (canonical error envelope in @bharattruck/shared/errors). Keeps the exact
// (message, code, httpStatus=400) signature + a `.httpStatus` getter so every
// existing call site and route handler is unchanged. Booking's domain codes
// (AUCTION_CLOSED, DUPLICATE_QUOTE, QUOTE_NOT_FOUND, ALREADY_AWARDED) were added
// to the shared ErrorCode union.
// -----------------------------------------------------------

export type BookingErrorCode = ErrorCode

export class BookingError extends AppError {
  constructor(message: string, code: ErrorCode, httpStatus = 400) {
    super(message, code, httpStatus)
    this.name = 'BookingError'
  }

  get httpStatus(): number {
    return this.statusCode
  }
}
