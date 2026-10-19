// API client for bt-app — the unified BharatTruck front door (D-36). Forked from the
// former fleet console's client; that console and the driver/shipper apps were retired
// and deleted from the repo on 2026-09-26, so this is now the ONLY front-end client.
//
// Every call goes through the gateway origin, paths are written WITHOUT the /api prefix,
// and a 401 triggers exactly one refresh attempt before bouncing to /login.
//
// Token keys stay namespaced (this app owns bt_app_*): the retired apps used bt_driver_token /
// bt_token / bt_fleet_*, and keeping our own prefix means a browser that still holds one of
// those stale sessions never has it mistaken for ours.

import { storageKey } from './session-keys'
import type {
  AuthUser, MeResponse, FeedPage, MeSummary, FleetOwner, Vehicle, VehicleFinance, VehiclePermit, VehicleLane,
  FleetDriver, FleetInvite, DriverAffiliation, FleetSummary, VehicleAnalytics, DriverAnalytics, FuelComparison,
  LivePosition, FleetBooking, ModelCategory, Period,
  FleetOverview, Geofence,
  OpenAuction, FleetBid, Quote, NegotiationEntry, QuoteStatus,
  Booking, BookingType, ConsigneeInput,
  PriceQuote, PriceQuoteInput, PriceQuoteVehicleType, JustifyBreakdown,
  TrackData, DriverLocation,
  LocationUpdate, PodContext, RequestOtpResult, VerifyOtpResult, RouteData, PumpsData, FuelData, AlertsData,
  EvidenceCaptureInput, CaptureResult, AssertReason, AssertResult, DiscrepancyInput, DiscrepancyResult, PodRecord,
  VerifyDeliveryResult, FleetPendingResult,
  DriverOnboarding, OnboardingStatus, DriverProfile, DriverLicense, BankAccount,
  BookingDocuments, LorryReceipt, IssueLorryReceiptInput, FreightInvoice, IssueInvoiceInput,
  EwayBillRecord, RecordEwayBillInput, SetEwayBillStatusInput,
  CompletenessReport,
  PaymentMode, PaymentStatus, SettleResult, PaymentConfig, OnlineOrder, CheckoutSuccess, OnlineSync,
  DocumentScan, ScanKind,
  TripExpense,
} from './types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
// FB-10: pass ?profile=<slug> to partition tokens for multi-account QA.
const TOKEN_KEY_BASE = 'bt_app_token'
const REFRESH_KEY_BASE = 'bt_app_refresh_token'
const TOKEN_KEY = () => storageKey(TOKEN_KEY_BASE)
const REFRESH_KEY = () => storageKey(REFRESH_KEY_BASE)

// ── Token storage ─────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(TOKEN_KEY())
  // Tokens are sometimes pasted by hand during QA; strip stray newlines the way
  // the shipper client does, otherwise the Authorization header is malformed.
  return raw ? raw.trim().replace(/[\r\n]+/g, '') : null
}

export function setToken(token: string) { localStorage.setItem(TOKEN_KEY(), token) }
export function clearToken() { localStorage.removeItem(TOKEN_KEY()) }

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REFRESH_KEY())
}
export function setRefreshToken(token: string) { localStorage.setItem(REFRESH_KEY(), token) }
export function clearRefreshToken() { localStorage.removeItem(REFRESH_KEY()) }

// ── Errors ────────────────────────────────────────────────────

export class ApiError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'That asset belongs to another fleet',
  NOT_FOUND: 'Not found',
  CONFLICT: 'That truck or driver is already on a live trip',
  INVALID_TRANSITION: 'That step is not allowed from the current status',
  NOT_IMPLEMENTED: 'Not available yet',
  MISCONFIGURED: 'Service is misconfigured — check with the team',
  UNAUTHORIZED: 'Session expired',
}

// ── Refresh (single-flight) ───────────────────────────────────

let refreshPromise: Promise<string> | null = null

async function tryRefresh(): Promise<string> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const rt = getRefreshToken()
    if (!rt) throw new ApiError('Session expired', 'UNAUTHORIZED')
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.success) throw new ApiError('Session expired', 'UNAUTHORIZED')
    setToken(json.data.access_token)
    return json.data.access_token as string
  })()
  try { return await refreshPromise } finally { refreshPromise = null }
}

function bounceToLogin(): never {
  clearToken()
  clearRefreshToken()
  if (typeof window !== 'undefined') window.location.href = '/login'
  throw new ApiError('Session expired', 'UNAUTHORIZED')
}

async function parse<T>(res: Response): Promise<T> {
  let json
  try { json = await res.json() } catch {
    throw new ApiError('Server error — please try again', 'NETWORK_ERROR')
  }

  if (!json.success) {
    // The gateway answers an UNROUTED path with its own nginx-shaped body,
    // {"error":"not_found","message":"No route matched this path"} — no `success`,
    // no `code`. Falling through to json.error there puts the literal string
    // "not_found" on screen, which tells the owner nothing. That is the exact state
    // when bt-fleet-service is not deployed or FLEET_SERVICE_URL is unset on the
    // gateway, so it is worth naming precisely rather than papering over.
    if (json.code === undefined && json.error === 'not_found') {
      throw new ApiError(
        'The fleet service is not reachable. It may not be deployed yet, or the gateway is not routing /api/fleet.',
        'SERVICE_UNAVAILABLE',
      )
    }
    if (res.status >= 500 && json.code === undefined) {
      throw new ApiError('The service is temporarily unavailable — please retry.', 'SERVICE_UNAVAILABLE')
    }

    const code = json.code || 'UNKNOWN'
    // INVALID_TRANSITION is one code for many different refusals, and the server's own sentence
    // is the only thing that says WHICH ("missing … tax invoice. The shipper must issue the
    // invoice first", "that driver is already on …"). The generic line hid the one fact the
    // user needed to act, so for this code the server's reason wins when it gave one.
    const specific = code === 'INVALID_TRANSITION' && typeof json.error === 'string' && json.error.trim() ? json.error : null
    throw new ApiError(specific || ERROR_MESSAGES[code] || json.error || json.message || 'Something went wrong', code)
  }

  return json.data
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  }

  let res = await fetch(`${API_BASE}/api${path}`, { ...options, headers })

  if (res.status === 401) {
    try {
      headers['Authorization'] = `Bearer ${await tryRefresh()}`
    } catch { bounceToLogin() }
    res = await fetch(`${API_BASE}/api${path}`, { ...options, headers })
    // The refresh above SUCCEEDED, so the session itself is valid. If one service still
    // answers 401 with a fresh token, that service is refusing a good session — signing the
    // user out would throw them off every page over one service's fault (this is exactly
    // how Live Fleet used to "crash to the sign-in page"). Report it on the page instead.
    if (res.status === 401) {
      throw new ApiError(
        'This part of BharatTruck could not verify your sign-in. The rest of the app still works — please try again shortly.',
        'SERVICE_AUTH_REJECTED',
      )
    }
  }

  return parse<T>(res)
}

/** Auth calls: no auto-redirect, so a bad password shows an error instead of a bounce. */
async function authRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  return parse<T>(await fetch(`${API_BASE}/api${path}`, { ...options, headers }))
}

// ── Auth ──────────────────────────────────────────────────────

/**
 * NOTE the path: bt-auth-service mounts email auth at `/auth/email/login`, not
 * `/auth/login` — verified against the live gateway, which 404s the shorter form.
 * The response also carries `is_new_user`, which this console ignores.
 */
export function loginWithEmail(email: string, password: string) {
  return authRequest<{ access_token: string; refresh_token: string; user: AuthUser }>(
    '/auth/email/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

/**
 * The whole point of /auth/me for this app: it returns `personas.capabilities`,
 * which the shell gates every surface on. `personas` is null when the server could
 * not resolve them — the caller (lib/auth.tsx) falls back rather than blanking the UI.
 */
export function getMe() {
  return authRequest<MeResponse>('/auth/me')
}

/** FB-04: save shipper GSTIN on users.gstin (format matches users_gstin_format CHECK). */
export function updateMyGstin(gstin: string | null) {
  return authRequest<{ user: AuthUser }>('/auth/me/gstin', {
    method: 'PATCH',
    body: JSON.stringify({ gstin }),
  })
}

export function refreshAccessToken(refresh_token: string) {
  return authRequest<{ access_token: string }>(
    '/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token }) })
}

// ── Registration + account recovery (bt-auth-service /auth/*) ──────────────────
//
// The full auth surface D-32/D-34 asks for, all on this ONE origin. Registration takes
// a PRIMARY PERSONA (shipper/driver/fleet_owner) — the front door that shapes onboarding
// — and gates nothing; capabilities still emerge from assets. Email is verified with a
// 6-digit OTP; password reset is a single-origin, single-use, expiring-link flow.

export type PrimaryPersona = 'shipper' | 'driver' | 'fleet_owner'

/** Create an account. Sends a 6-digit verification code to the email; login is gated on
 *  verifying it. `role` is the declared primary persona (D-32). */
export function registerWithEmail(email: string, password: string, full_name: string, role: PrimaryPersona) {
  return authRequest<{ email?: string; message?: string }>(
    '/auth/email/register', { method: 'POST', body: JSON.stringify({ email, password, full_name, role }) })
}

/** Verify the email OTP. May return tokens; the caller logs in with the password regardless. */
export function verifyEmailOtp(email: string, otp: string) {
  return authRequest<{ access_token?: string; refresh_token?: string; user?: AuthUser }>(
    '/auth/email/verify', { method: 'POST', body: JSON.stringify({ email, otp }) })
}

export function resendEmailOtp(email: string) {
  return authRequest<{ message: string }>('/auth/email/resend-otp', { method: 'POST', body: JSON.stringify({ email }) })
}

/** Enumeration-safe: always resolves with the same generic message whether or not the
 *  account exists. Emails a single-use reset link (30-min TTL) that lands on /auth/reset. */
export function forgotPassword(email: string) {
  // Send our OWN origin as the reset destination so the emailed link follows whatever
  // domain this app is served from — localhost in dev, the run.app URL today, a custom
  // domain later — with no hardcoded URL. The server allowlists it (its default + any
  // PASSWORD_RESET_URL), and falls back to its own default if we can't supply one (SSR).
  const callback_url = typeof window !== 'undefined' ? `${window.location.origin}/auth/reset` : undefined
  return authRequest<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify(callback_url ? { email, callback_url } : { email }),
  })
}

/** Set a new password from a reset-link token (the `token` query param on /auth/reset). */
export function resetPassword(token: string, password: string) {
  return authRequest<{ message?: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) })
}

/** Sign in with a Google ID token (from Google Identity Services). Needs GOOGLE_CLIENT_ID
 *  set on bt-auth-service AND NEXT_PUBLIC_GOOGLE_CLIENT_ID here — otherwise the button is hidden. */
export function googleSignIn(id_token: string, role: PrimaryPersona) {
  return authRequest<{ access_token: string; refresh_token: string; user: AuthUser }>(
    '/auth/google', { method: 'POST', body: JSON.stringify({ id_token, role }) })
}

// ── Home action feed (D-38) ───────────────────────────────────
//
// GET /api/me/feed → bt-booking-service. ONE ranked, capability-aware list of typed
// items — the server already resolves the caller's capabilities and queries only the
// sources they touch, so the client renders whatever comes back without re-deriving
// persona logic (exactly what the capability model moved off the client). Authorized
// purely by the caller's JWT; the feed only ever contains the caller's own items.
export function getMyFeed(opts?: { limit?: number; offset?: number }) {
  const qs = new URLSearchParams()
  if (opts?.limit != null) qs.set('limit', String(opts.limit))
  if (opts?.offset != null) qs.set('offset', String(opts.offset))
  const suffix = qs.toString() ? `?${qs}` : ''
  return request<FeedPage>(`/me/feed${suffix}`)
}

/**
 * GET /me/summary — the feed's companion, "how am I doing?": only the dashboard panels this
 * person's capabilities unlock, in their front-door order, with money decided on the server.
 * bt-booking-service, reached through the gateway's /api/me/summary block.
 */
export function getMySummary() {
  return request<MeSummary>('/me/summary')
}

// ── Owner profile ─────────────────────────────────────────────

export function getMyFleet() { return request<FleetOwner>('/fleet/owners/me') }

export function updateMyFleet(body: Partial<FleetOwner>) {
  return request<FleetOwner>('/fleet/owners/me', { method: 'PATCH', body: JSON.stringify(body) })
}

export function registerFleet(body: { company_name: string; gstin?: string; pan?: string; city?: string; state?: string }) {
  return request<FleetOwner>('/fleet/owners', { method: 'POST', body: JSON.stringify(body) })
}

// ── Identity / emergence (D-32 — bt-auth-service, gateway /api/fleet-owners|drivers/me) ──
//
// Become a fleet owner / a driver in-app, from ANY persona. Both are idempotent
// (create-if-absent; a repeat returns the existing row), act only on the CALLER'S own
// identity (userId from the token, never the body), and are the transitions the emergence
// CTAs perform. Creating the fleet profile is what makes the de-roled fleet surfaces open
// to an owner-driver — the JWT role no longer gates them (feat/derole-fleet-service).

/** Create the caller's fleet-owner profile if absent (idempotent). The "set up fleet
 *  management" emergence transition. Refresh /auth/me after so fleet_owner_id appears. */
export function becomeFleetOwner() {
  return request<{ fleet_owner: FleetOwner; created: boolean }>(
    '/fleet-owners/me', { method: 'POST', body: JSON.stringify({}) })
}

/** Create the caller's driver profile if absent (idempotent). "Register as a driver" — a
 *  shipper who adds their first truck, or an invited employee, becomes a driver. */
export function becomeDriver() {
  return request<{ driver: { id: string }; created: boolean }>(
    '/drivers/me', { method: 'POST', body: JSON.stringify({}) })
}

/** The D-33 persona-completeness report — per-persona requirement sets + status. DISPLAY
 *  ONLY; it gates nothing (D-31), which the payload's `gates_nothing:true` also states. */
export function getMyCompleteness() {
  return request<{ completeness: CompletenessReport }>('/me/completeness')
}

/**
 * Sign a D-31 self-declaration ("I'll provide this later" / "under threshold"). The server
 * stores the EXACT text it served, keyed by kind — an artifact, not a boolean. Flips the
 * matching completeness item from 'missing' to 'declared'. Never gates anything.
 */
export function acknowledgePersona(kind: string) {
  return request<{ acknowledgement: { id: string; kind: string; version: string } }>(
    '/me/acknowledgements', { method: 'POST', body: JSON.stringify({ kind }) })
}

// ── Drivers ───────────────────────────────────────────────────

export function listFleetDrivers() { return request<FleetDriver[]>('/fleet/drivers') }

/**
 * Invites an EXISTING driver account by the channel the owner chose — phone OR email.
 * We never create driver identities; the driver must already have signed up.
 */
export function inviteDriver(channel: { driver_phone: string } | { driver_email: string }) {
  return request<FleetDriver>('/fleet/drivers/invite', {
    method: 'POST', body: JSON.stringify(channel),
  })
}

export function updateFleetDriver(id: string, body: { monthly_salary_inr?: number; status?: 'suspended' | 'active' }) {
  return request<FleetDriver>(`/fleet/drivers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function removeFleetDriver(id: string) {
  return request<{ id: string }>(`/fleet/drivers/${id}`, { method: 'DELETE' })
}

// ── Driver-side fleet invitations (the consent seam — driver-only routes) ──────
//
// An owner invites by phone; ONLY the driver may accept, from their own app. These
// are the routes the owner's console deliberately cannot call.

/** The driver's pending-invitation inbox. */
export function getMyInvites() { return request<FleetInvite[]>('/fleet/drivers/invites/mine') }

/** Accept or decline a fleet invitation — the driver's decision alone. */
export function respondToInvite(id: string, action: 'accept' | 'reject') {
  return request<FleetDriver>(`/fleet/drivers/invites/${id}/respond`, {
    method: 'POST', body: JSON.stringify({ action }),
  })
}

/** The driver's commercial standing — `is_employed` decides which product they see. */
export function getMyAffiliation() { return request<DriverAffiliation>('/fleet/drivers/me/affiliation') }

// ── Vehicles ──────────────────────────────────────────────────

export function listVehicles() { return request<Vehicle[]>('/fleet/vehicles') }

export function getVehicle(id: string) {
  return request<{
    vehicle: Vehicle
    finance: VehicleFinance | null
    permits: VehiclePermit[]
    lanes: VehicleLane[]
  }>(`/fleet/vehicles/${id}`)
}

export function createVehicle(body: Partial<Vehicle>) {
  return request<Vehicle>('/fleet/vehicles', { method: 'POST', body: JSON.stringify(body) })
}

export function updateVehicle(id: string, body: Partial<Vehicle>) {
  return request<Vehicle>(`/fleet/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export type BulkImportFormat = 'csv' | 'xlsx' | 'pdf' | 'image'

export type BulkImportError = { row: number; rc_number: string | null; message: string }

/** Field names copied verbatim from bt-fleet-service/src/lib/bulk-import.ts:28-32. */
export type BulkImportResult = {
  imported: number
  skipped: number
  errors: BulkImportError[]
}

/**
 * Bulk truck onboarding. `csv` is parsed directly; `pdf`/`image` are read with OCR (Document AI)
 * when it is enabled on the deployment — otherwise they come back as a clean 501. `xlsx` is not
 * supported (export to CSV). For pdf/image, `content` is base64 of the file and `mimeType` is its
 * exact type (e.g. application/pdf, image/jpeg).
 *
 * Partial success is normal: rows that fail validation are counted in `skipped` with a per-row
 * reason, and the request still returns 200.
 */
export function bulkImportVehicles(format: BulkImportFormat, content: string, mimeType?: string) {
  return request<BulkImportResult>('/fleet/vehicles/bulk', {
    method: 'POST',
    body: JSON.stringify({ format, content, ...(mimeType ? { mime_type: mimeType } : {}) }),
  })
}

export function setVehicleFinance(id: string, body: Partial<VehicleFinance>) {
  return request<VehicleFinance>(`/fleet/vehicles/${id}/finance`, { method: 'PUT', body: JSON.stringify(body) })
}

export function setVehiclePermits(id: string, permits: Partial<VehiclePermit>[]) {
  return request<VehiclePermit[]>(`/fleet/vehicles/${id}/permits`, { method: 'PUT', body: JSON.stringify({ permits }) })
}

export function setVehicleLanes(id: string, lanes: Partial<VehicleLane>[]) {
  return request<VehicleLane[]>(`/fleet/vehicles/${id}/lanes`, { method: 'PUT', body: JSON.stringify({ lanes }) })
}

export function listModelCategories() {
  return request<ModelCategory[]>('/fleet/vehicles/model-categories')
}

// ── Bookings + the assign step ────────────────────────────────

export function listFleetBookings(status?: string) {
  return request<FleetBooking[]>(`/fleet/bookings${status ? `?status=${encodeURIComponent(status)}` : ''}`)
}

/** The pairing step. Until this exists, accepted -> in_transit is blocked. */
export function assignToBooking(bookingId: string, driver_id: string, vehicle_id: string) {
  // Route returns { assignment, booking } (bt-fleet-service assignment.ts), NOT a bare assignment
  // row — the old return type read undefined on assignment.* fields (review F5).
  return request<{
    assignment: { id: string; booking_id: string; driver_id: string; vehicle_id: string }
    booking: Booking
  }>(`/fleet/bookings/${bookingId}/assign`, { method: 'POST', body: JSON.stringify({ driver_id, vehicle_id }) })
}

/**
 * Direct-attach (D-10): the shipper moves their OWN load with their OWN fleet, skipping the
 * auction. No body — the carrier is the caller's own resolved fleet. Moves pending -> accepted;
 * a fleet booking then still needs a truck+driver paired via assignToBooking before it can start.
 */
export function directAttachBooking(bookingId: string) {
  return request<Booking>(`/bookings/${bookingId}/direct-attach`, { method: 'PATCH' })
}

// ── Live map ──────────────────────────────────────────────────

/**
 * All vehicle positions in ONE call. The service serves this from a single Redis
 * SMEMBERS + MGET — never poll per-vehicle endpoints from here, that is 100 req/s
 * at 1000 trucks on a 10s interval.
 */
export function getLivePositions() {
  // GET /fleet/live returns an ENVELOPE, not a bare array (bt-fleet-service assignment.ts) — the
  // old LivePosition[] return type crashed any caller that iterated it directly (review F4).
  return request<{
    fleet_owner_id: string
    driver_count: number
    online_count: number
    on_trip_count: number
    positions: LivePosition[]
  }>('/fleet/live')
}

// ── Analytics ─────────────────────────────────────────────────

function periodQS(p?: Partial<Period>) {
  if (!p?.from && !p?.to) return ''
  const qs = new URLSearchParams()
  if (p.from) qs.set('from', p.from)
  if (p.to) qs.set('to', p.to)
  return `?${qs}`
}

export function getFleetSummary(p?: Partial<Period>) {
  return request<FleetSummary>(`/fleet/analytics/summary${periodQS(p)}`)
}

export function getVehicleAnalytics(p?: Partial<Period>) {
  return request<{ period: Period; vehicles: VehicleAnalytics[] }>(
    `/fleet/analytics/vehicles${periodQS(p)}`)
}

export function getOneVehicleAnalytics(id: string, p?: Partial<Period>) {
  return request<{ period: Period } & VehicleAnalytics>(
    `/fleet/analytics/vehicles/${id}${periodQS(p)}`)
}

export function getDriverAnalytics(p?: Partial<Period>) {
  return request<{ period: Period; drivers: DriverAnalytics[] }>(
    `/fleet/analytics/drivers${periodQS(p)}`)
}

export function getFuelComparison(p?: Partial<Period>) {
  return request<FuelComparison>(`/fleet/analytics/fuel${periodQS(p)}`)
}

// ── Live fleet tracking (bt-tracking-service, via the gateway) ────────────────

/**
 * Every truck in the fleet with position, trip, telemetry, fuel and open alerts —
 * in ONE call.
 *
 * Note the service: this is bt-tracking-service (`/api/tracking/...`), not
 * bt-fleet-service's `/fleet/live`. The two are deliberately different shapes —
 * `/fleet/live` iterates DRIVERS and so omits any truck without one, which is
 * exactly the blind spot an owner's board must not have. Use this for the board;
 * `/fleet/live` remains the cheap position-only feed.
 *
 * Cost: the service answers from one Redis MGET plus bounded Postgres reads and
 * makes NO Google call, so a 10s poll is safe. Route and ETA stay lazy — fetch
 * them for one selected truck, never for the whole list.
 */
export function getFleetOverview() {
  return request<FleetOverview>('/tracking/fleet/overview')
}

export function listGeofences() {
  return request<Geofence[]>('/tracking/fleet/geofences')
}

export function createGeofence(body: {
  name: string
  kind: Geofence['kind']
  lat: number
  lng: number
  radius_m: number
}) {
  return request<Geofence>('/tracking/fleet/geofences', {
    method: 'POST', body: JSON.stringify(body),
  })
}

export function deleteGeofence(id: string) {
  return request<{ id: string; deleted: boolean }>(`/tracking/fleet/geofences/${id}`, {
    method: 'DELETE',
  })
}

/** One trip's full analytics record — planned vs driven, dwell, geofence events. */
export function getTripSummary(bookingId: string) {
  return request<Record<string, unknown>>(`/tracking/summary/${bookingId}`)
}

/** Traveled breadcrumb trail for the replay/trail layer. */
export function getTripHistory(bookingId: string) {
  return request<{
    booking_id: string
    point_count: number
    points: { lat: number; lng: number; speed_kmh: number | null; heading: number | null; recorded_at: string }[]
  }>(`/tracking/history/${bookingId}`)
}

// ── Auction bidding ───────────────────────────────────────────
//
// READS come from bt-fleet-service, WRITES from bt-booking-service, and the split is
// deliberate. `/fleet/auctions` and `/fleet/bids` are tenant-scoped list queries, which
// is what the fleet service owns. Bid writes reuse `/bookings/:id/quotes*`, which
// already accept a fleet owner as a bidder and already enforce the auction-deadline,
// duplicate-bid and fleet-affiliated-driver rules. Re-implementing those writes here —
// or proxying them through the fleet service — would fork the auction rules across two
// services and let them drift.
//
// Note what /fleet/bookings could NOT do: `bookings.fleet_owner_id` is written only when
// a shipper ACCEPTS a quote, so it can only ever return auctions already won. Live,
// countered and lost bids live on `quotes.fleet_owner_id`, which is what /fleet/bids reads.

/** Open loads this fleet may bid on, each annotated with its own bid if it has one. */
export function listOpenAuctions(opts?: { include_expired?: boolean }) {
  const qs = opts?.include_expired ? '?include_expired=true' : ''
  return request<{ fleet_owner_id: string | null; count: number; auctions: OpenAuction[] }>(
    `/fleet/auctions${qs}`,
  )
}

/** Every bid this fleet has placed, newest first, with its load attached. */
// GET /fleet/bids validates a 5-status enum that OMITS 'expired' (bt-fleet-service auctions.ts), so
// the filter type must exclude it — otherwise the client offers a value the server 400s (review F6).
export function listMyBids(status?: Exclude<QuoteStatus, 'expired'>) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return request<{ fleet_owner_id: string | null; count: number; bids: FleetBid[] }>(`/fleet/bids${qs}`)
}

/**
 * Place a bid. 409 CONFLICT means this fleet already has a live quote on the load
 * (the DB enforces one per bidder), and 409 AUCTION_CLOSED means the deadline passed
 * or the booking left pending/negotiating.
 */
export function placeBid(bookingId: string, amount: number, message?: string) {
  return request<Quote>(`/bookings/${bookingId}/quotes`, {
    method: 'POST',
    body: JSON.stringify({ amount, ...(message ? { message } : {}) }),
  })
}

/** Counter the shipper's counter-offer. Only legal while the quote is `countered`. */
export function counterBid(bookingId: string, quoteId: string, amount: number, message?: string) {
  return request<Quote>(`/bookings/${bookingId}/quotes/${quoteId}/counter`, {
    method: 'PATCH',
    body: JSON.stringify({ amount, ...(message ? { message } : {}) }),
  })
}

/** Pull a live bid. Frees the fleet to re-bid, since the unique index only covers live rows. */
export function withdrawBid(bookingId: string, quoteId: string) {
  return request<Quote>(`/bookings/${bookingId}/quotes/${quoteId}/withdraw`, { method: 'PATCH' })
}

/** The full price thread for one bid — every offer and counter, oldest first. */
export function getBidHistory(bookingId: string, quoteId: string) {
  return request<NegotiationEntry[]>(`/bookings/${bookingId}/quotes/${quoteId}/history`)
}

// ── Trip expenses (driver logs what a trip cost — feeds the fleet fuel/pilferage signal) ──

export type LogExpenseInput = {
  category_code: string
  amount: number
  description?: string
  litres?: number
  rate_per_litre?: number
  odometer_km?: number
  expense_date?: string
}

/** The assigned driver records one trip expense. category_code comes from EXPENSE_CATEGORIES. */
export function logTripExpense(bookingId: string, body: LogExpenseInput) {
  return request<TripExpense>(`/bookings/${bookingId}/expenses`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Expenses logged on a booking (assigned driver / its fleet / ops), newest first. */
export function getTripExpenses(bookingId: string) {
  return request<TripExpense[]>(`/bookings/${bookingId}/expenses`)
}

// ── Geocoding + saved addresses (D-020) ───────────────────────────────────────
//
// bt-tracking-service holds the Google key and proxies Places (New): autocomplete on a typed
// address, then details resolving the picked place to lat/lng + pincode + GST state code. The
// session_token groups a search's keystrokes with its one details call so Google bills the pair
// once — the caller mints a token per search and drops it after the details call.

export type PlaceSuggestion = {
  place_id: string
  description: string
  main_text: string
  secondary_text: string
}

export type PlaceDetailsResult = {
  place_id: string
  lat: number
  lng: number
  formatted_address: string
  pincode: string | null
  state: string | null
  state_code: string | null
}

export function placesAutocomplete(q: string, sessionToken?: string) {
  const qs = new URLSearchParams({ q })
  if (sessionToken) qs.set('session_token', sessionToken)
  return request<{ query: string; suggestions: PlaceSuggestion[]; cached: boolean }>(
    `/tracking/places/autocomplete?${qs.toString()}`,
  )
}

export function placeDetails(placeId: string, sessionToken?: string) {
  const qs = new URLSearchParams({ place_id: placeId })
  if (sessionToken) qs.set('session_token', sessionToken)
  return request<PlaceDetailsResult & { cached: boolean }>(`/tracking/places/details?${qs.toString()}`)
}

// Reverse geocode a dropped map pin -> pincode + GST state (D-021). `resolved` is false when the
// Geocoding API is not enabled yet or the point has no postal area — callers keep the pin's
// coordinates and simply leave pincode/state blank in that case.
export type ReverseGeocodeResult = {
  lat: number
  lng: number
  formatted_address: string | null
  pincode: string | null
  state: string | null
  state_code: string | null
  resolved: boolean
}

export function reverseGeocode(lat: number, lng: number) {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng) })
  return request<ReverseGeocodeResult & { cached: boolean }>(`/tracking/places/reverse?${qs.toString()}`)
}

export type SavedAddress = {
  id: string
  label: string | null
  place_id: string | null
  formatted_address: string
  lat: number
  lng: number
  gate_lat: number | null
  gate_lng: number | null
  pincode: string | null
  state_code: string | null
  use_count: number
  last_used_at: string | null
  created_at: string
}

export type SaveAddressInput = {
  label?: string
  place_id?: string
  formatted_address: string
  lat: number
  lng: number
  gate_lat?: number
  gate_lng?: number
  pincode?: string
  state_code?: string
}

export function listSavedAddresses() {
  return request<SavedAddress[]>('/me/addresses')
}

export function saveAddress(body: SaveAddressInput) {
  return request<SavedAddress>('/me/addresses', { method: 'POST', body: JSON.stringify(body) })
}

export function deleteSavedAddress(id: string) {
  return request<{ deleted: string }>(`/me/addresses/${id}`, { method: 'DELETE' })
}

// ── Ship surfaces (Post a Load / My Loads / load detail — Phase 2) ─────────────
//
// The shipper flow, ported from shipper/src/lib/api.ts into this client's style:
// every call goes through `request` (gateway origin, `/api` prefix added here,
// snake_case JSON, {success,data} envelope, one refresh on 401). bt-app talks to
// bt-booking-service (`/bookings`, `/quotes`), bt-pricing-service (`/pricing`) and
// bt-tracking-service (`/tracking`, `/location`) — all through the gateway.

/** The caller's bookings. A shipper gets the loads THEY posted; each row carries a
 *  `viewer` block naming the caller's relations so My Loads can keep only its own. */
export function listBookings() {
  return request<Booking[]>('/bookings/')
}

export function getBooking(id: string) {
  return request<Booking>(`/bookings/${id}`)
}

/**
 * The booking-create payload. The shipper sends the price-lock HANDLE (`quote_id`),
 * never a raw price — the server resolves quoted_price from the locked price_quotes
 * row (price SHOWN == price CHARGED). D-29: a load must name a reachable consignee,
 * so `consignee` (name + phone) is required here; `receiver_email` is the optional
 * legacy POD inbox. The same coords + vehicle_type that were priced must be sent so
 * the booking binds to the locked quote (the server rejects a mismatch).
 */
export type CreateBookingPayload = {
  quote_id: string
  source_address: string
  source_lat: number
  source_lng: number
  destination_address: string
  dest_lat: number
  dest_lng: number
  load_type: string
  weight_kg: number
  vehicle_type: PriceQuoteVehicleType
  pickup_date: string
  pickup_time_slot?: string
  special_instructions?: string
  consignee: ConsigneeInput
  receiver_email?: string
  booking_type: BookingType
  target_driver_id?: string
  auction_deadline?: string
  // Geocoding (D-020 / migration 0035): the resolved place + the dragged exact-gate pin.
  // All optional and stripped when empty, so a legacy hand-typed post is unchanged.
  source_place_id?: string
  source_pincode?: string
  source_state_code?: string
  dest_place_id?: string
  dest_pincode?: string
  dest_state_code?: string
  source_gate_lat?: number
  source_gate_lng?: number
  dest_gate_lat?: number
  dest_gate_lng?: number
}

export function createBooking(payload: CreateBookingPayload) {
  // Strip empties so an optional field never reaches the server as '' — the
  // consignee's own optional fields (email/gstin/…) are pruned the same way,
  // because an empty string there fails validation rather than being ignored.
  const consignee = Object.fromEntries(
    Object.entries(payload.consignee).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  )
  const clean = Object.fromEntries(
    Object.entries({ ...payload, consignee }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  )
  return request<Booking>('/bookings/', { method: 'POST', body: JSON.stringify(clean) })
}

export function cancelBooking(id: string) {
  return request<Booking>(`/bookings/${id}/cancel`, { method: 'PATCH' })
}

/**
 * Set (or correct) the consignee inbox the delivery code is emailed to. The only
 * field on a live booking a shipper may change mid-trip; the server rejects it once
 * the booking is completed/paid/cancelled.
 */
export function setReceiverEmail(id: string, receiverEmail: string) {
  return request<Booking>(`/bookings/${id}/receiver-email`, {
    method: 'PATCH', body: JSON.stringify({ receiver_email: receiverEmail }),
  })
}

// ── Quotes on a load (shipper side of the auction) ────────────────────────────

export function getQuotes(bookingId: string) {
  return request<Quote[]>(`/bookings/${bookingId}/quotes`)
}

/** Award the load to this bid. */
export function acceptQuote(bookingId: string, quoteId: string) {
  return request<Quote>(`/bookings/${bookingId}/quotes/${quoteId}/accept`, { method: 'PATCH' })
}

/** Counter the carrier's bid. Legal while the quote is submitted/countered. */
export function counterQuote(bookingId: string, quoteId: string, body: { amount: number; message?: string }) {
  return request<Quote>(`/bookings/${bookingId}/quotes/${quoteId}/counter`, {
    method: 'PATCH', body: JSON.stringify(body),
  })
}

export function rejectQuote(bookingId: string, quoteId: string) {
  return request<Quote>(`/bookings/${bookingId}/quotes/${quoteId}/reject`, { method: 'PATCH' })
}

// ── Advisory pricing (bt-pricing-service, D-11) ────────────────────────────────
//
// The number is a REFERENCE, not a charge, on an auction. The server classifies it
// (`quote_kind`) and authors the disclosure sentence (`basis`); these helpers show
// the server's record and fall back to the requested booking type only against a
// pricing service that predates D-11 (where an auction must never read as binding).

export function getPriceQuote(payload: PriceQuoteInput) {
  return request<PriceQuote>('/pricing/quote', { method: 'POST', body: JSON.stringify(payload) })
}

/**
 * Mode B — justify a self-named bid. Sends the load + route ONLY (no truck details); the engine
 * returns a breakdown that sums to `amount`. Coords let the service derive the routed distance and
 * reuse the tracking cache; pass a booking's source/dest.
 */
export function justifyBid(payload: {
  amount: number
  load_type: string
  weight_kg: number
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
}) {
  return request<JustifyBreakdown>('/pricing/justify', { method: 'POST', body: JSON.stringify(payload) })
}

export function quoteKindOf(quote: PriceQuote, requestedFor?: BookingType): 'advisory' | 'binding' {
  if (quote.quote_kind) return quote.quote_kind
  return requestedFor === 'auction' ? 'advisory' : 'binding'
}

export function priceQuoteHeading(quote: PriceQuote, requestedFor?: BookingType): string {
  return quoteKindOf(quote, requestedFor) === 'advisory' ? 'Estimated price' : 'Locked price'
}

export function priceQuoteBasis(quote: PriceQuote, requestedFor?: BookingType): string {
  if (quote.basis) return quote.basis
  return quoteKindOf(quote, requestedFor) === 'advisory'
    ? "Reference estimate — you pay the winning carrier's bid, not this number."
    : 'This is the price charged for this booking.'
}

// ── Live tracking (bt-tracking-service, via the gateway) ──────────────────────

/**
 * One read-through call (LOCKED D-8) for the shipper live map: current location +
 * base route + live ETA + status + alerts. Poll every 10s while in transit (D-10).
 */
export function getTrack(bookingId: string) {
  return request<TrackData>(`/tracking/track/${bookingId}`)
}

/** The latest raw driver fix for a booking; null until the driver shares location. */
export function getBookingLocation(bookingId: string) {
  return request<DriverLocation | null>(`/location/booking/${bookingId}`)
}

// ── Drive surfaces (My Trips / Navigate / POD capture — Phase 3) ───────────────
//
// The driver flow, ported from driver/src/lib/api.ts into this client's style.
// bt-app talks to bt-booking-service (`/bookings`, `/location`), bt-tracking-service
// (`/tracking`) and bt-cargo-ledger (`/cargo`) — all through the gateway. The listing
// (listBookings), booking read (getBooking) and shipper live-track (getTrack) added in
// Phase 2 are REUSED; only the driver-owned actions are added here.

/** Move an assigned trip accepted → in_transit. The server authorises the caller as
 *  the trip's driver, so this is safe to surface on the drive surface. */
export function startTrip(bookingId: string) {
  return request<Booking>(`/bookings/${bookingId}/start`, { method: 'PATCH' })
}

/**
 * POD context for the driver: the receiver inbox the delivery code will be emailed to.
 * Driver-only, requires the trip to be in_transit. `receiver_email` is null when the
 * shipper never set one — the caller must say so, never send a code into a dead end.
 */
export function getPodContext(bookingId: string) {
  return request<PodContext>(`/bookings/${bookingId}/pod-context`)
}

/**
 * Ask bt-cargo-ledger to email the one-time delivery code to the receiver. The driver
 * NEVER completes the trip directly — the receiver verifying this code out-of-band is
 * what drives booking-service in_transit → completed (D-25 receiver-OTP POD).
 */
export function requestPodOtp(bookingId: string) {
  return request<RequestOtpResult>('/cargo/pod/request-otp', {
    method: 'POST', body: JSON.stringify({ booking_id: bookingId }),
  })
}

/**
 * Submit the delivery code to close the trip (POST /cargo/pod/verify-otp).
 *
 * The code was sent to the RECEIVER (their phone/email) — the driver asks the receiver
 * for it at the drop and enters it here. The endpoint is unauthenticated by design (§6.3:
 * the secret sits off the driver's device; it can only be produced by the receiver who is
 * present), TTL- and attempt-bounded. On success the backend has already moved the trip to
 * 'completed'. A wrong/expired code throws an ApiError the caller shows inline.
 */
export function verifyPodOtp(bookingId: string, otp: string) {
  return request<VerifyOtpResult>('/cargo/pod/verify-otp', {
    method: 'POST', body: JSON.stringify({ booking_id: bookingId, otp }),
  })
}

// ── POD evidence capture (Phase 3b — bt-booking-service, migration 0025) ────────
//
// The hardened POD layer on top of the receiver-OTP flow above (§6.3). Evidence is
// camera-only and hashed ON THE DEVICE — the app computes the SHA-256 over the photo's
// own bytes and posts METADATA only; the bytes go to WORM storage separately (inert
// until the bucket is wired), so this call never uploads a re-encoded image. Every one
// is driver-only + assigned-driver gated server-side, exactly like getPodContext.

/**
 * Record a camera capture at the drop. `sha256_original` is the on-device hash of the
 * photo's own bytes, stored verbatim and never recomputed server-side. Idempotent on
 * (booking, hash): a retry returns the existing row with `created:false`. Capturable
 * only while the trip is in_transit or delivery_asserted.
 */
export function capturePodEvidence(bookingId: string, body: EvidenceCaptureInput) {
  return request<CaptureResult>(`/bookings/${bookingId}/pod-evidence`, {
    method: 'POST', body: JSON.stringify(body),
  })
}

/**
 * Assert delivery when the receiver cannot confirm the code (no smartphone, night drop,
 * warehouse hand-off). Moves the trip in_transit → delivery_asserted with
 * pod_strength='asserted'; ops closes it later. REQUIRES ≥1 captured photo — the server
 * 400s an assertion with no evidence, so the caller MUST gate the action on evidence.
 */
export function assertDelivery(bookingId: string, assert_reason: AssertReason) {
  return request<AssertResult>(`/bookings/${bookingId}/assert-delivery`, {
    method: 'POST', body: JSON.stringify({ assert_reason }),
  })
}

/**
 * Log a structured shortage/damage note. The driver reports ONLY the actual quantity;
 * the expected side is server-held (§5.7). A captured `evidence_id` is required when the
 * counts differ or for damage — capture a photo first.
 */
export function submitDiscrepancy(bookingId: string, body: DiscrepancyInput) {
  return request<DiscrepancyResult>(`/bookings/${bookingId}/discrepancy`, {
    method: 'POST', body: JSON.stringify(body),
  })
}

/**
 * The POD ledger for a trip: proof strength, the evidence list and the discrepancy.
 * Relation-gated server-side (shipper / carrier / assigned driver / consignee / ops);
 * degrades to "nothing recorded" on a pre-0025 database rather than failing.
 */
export function getPodRecord(bookingId: string) {
  return request<PodRecord>(`/bookings/${bookingId}/pod`)
}

// ── Fleet-owner delivery verification (migration 0039) ──────────────────────────
//
// The carrier reviews its driver's two typed geotagged photos and approves or rejects the
// delivery. Gated server-side by canFleetAccessBooking (the owner or a delegate) — never the
// driver, who cannot mark their own proof good.

/**
 * Approve or reject a delivery's evidence (POST /bookings/:id/pod/verify). Idempotent on the
 * same decision; a different decision after one was made is refused (409).
 */
export function verifyDelivery(bookingId: string, decision: 'approve' | 'reject', note?: string) {
  return request<VerifyDeliveryResult>(`/bookings/${bookingId}/pod/verify`, {
    method: 'POST', body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
  })
}

/**
 * The fleet owner's review queue: their deliveries whose evidence is awaiting a decision
 * (GET /bookings/pod/fleet-pending). Owner-scoped; a caller who owns no fleet gets an empty list.
 */
export function listFleetPodPending() {
  return request<FleetPendingResult>('/bookings/pod/fleet-pending')
}

/**
 * Push one GPS fix (trip-scoped — always send booking_id, D-25). Fired ~every 10s
 * from the in-transit trip screen; the caller swallows failures so a dropped push
 * never interrupts the drive. Ingestion lives in bt-booking-service (never rebuilt
 * in tracking) — this is the same `/location/update` the driver app writes to.
 */
export function pushLocation(body: LocationUpdate) {
  return request<{ driver_id: string; lat: number; lng: number; updated_at: string }>(
    '/location/update', { method: 'POST', body: JSON.stringify(body) })
}

/** Cached base polyline for the lane. One call per trip — never per GPS tick (the
 *  service caches it 6h, D-006, so polling would redraw an identical line). */
export function getRoute(bookingId: string) {
  return request<RouteData>(`/tracking/route/${bookingId}`)
}

/** Top-8 nearest pumps (D-011). ON DEMAND ONLY — this is a billed Places (New) call. */
export function getPumps(bookingId: string) {
  return request<PumpsData>(`/tracking/pumps/${bookingId}`)
}

/** Fuel + DEF estimate. Pure arithmetic server-side, no Google call (D-009/D-015).
 *  Accepts diesel-price / mileage overrides. */
export function getFuel(bookingId: string, opts?: { diesel_price?: number; mileage_kmpl?: number }) {
  const qs = new URLSearchParams()
  if (opts?.diesel_price !== undefined) qs.set('diesel_price', String(opts.diesel_price))
  if (opts?.mileage_kmpl !== undefined) qs.set('mileage_kmpl', String(opts.mileage_kmpl))
  const suffix = qs.toString() ? `?${qs}` : ''
  return request<FuelData>(`/tracking/fuel/${bookingId}${suffix}`)
}

/** Route alerts (D-012 thresholds). DB read only — safe to poll. */
export function getTripAlerts(bookingId: string) {
  return request<AlertsData>(`/tracking/alerts/${bookingId}`)
}

/**
 * Alerts for a BACKGROUND poll — deliberately routed through `authRequest`, not
 * `request`. `request()` treats a failed token refresh as session death (clears both
 * tokens and hard-navigates to /login), which is correct for an action the driver just
 * took and dangerous for a 60s timer running the whole trip: one refresh landing inside
 * a tunnel would log the driver out mid-delivery. `authRequest` neither refreshes nor
 * redirects, so a 401 here simply rejects and the alerts card hides until the next tick.
 * Failing quiet is the right trade for a decoration; never for the POD flow.
 */
export function getTripAlertsQuiet(bookingId: string) {
  return authRequest<AlertsData>(`/tracking/alerts/${bookingId}`)
}

// ── Freight documents (Phase 4 — bt-booking-service, migration 0024) ────────────
//
// The trip's paperwork. Registered under the EXISTING /bookings prefix, so these ride
// the gateway route bt-app already uses (no edge change — the routes cannot be half-
// deployed). Reads are relation-gated server-side (shipper / carrier / assigned driver
// / ops); the LR issue is carrier-only and its issuer identity is derived server-side.

/**
 * Everything on file for a booking: the LR, the tax invoice, and the e-way bill(s) with
 * their standing + expiry status. Degrades to nulls / an empty list on a pre-0024
 * database, so an empty result means "none issued yet", never an error.
 */
export function getBookingDocuments(bookingId: string) {
  return request<BookingDocuments>(`/bookings/${bookingId}/documents`)
}

/**
 * The CARRIER issues the consignment note (LR). Idempotent per booking — a repeat returns
 * the LR already issued rather than burning a second serial out of the gapless statutory
 * series. Issuable only while the booking is accepted or in_transit; the server derives
 * the issuer from the booking + actor and rejects any attempt to name it from the body.
 */
export function issueLorryReceipt(bookingId: string, body: IssueLorryReceiptInput) {
  return request<LorryReceipt>(`/bookings/${bookingId}/documents/lr`, {
    method: 'POST', body: JSON.stringify(body),
  })
}

/**
 * The SHIPPER issues their tax invoice (for the goods they sold, billed to the consignee).
 * The server computes the consignment value + grand total from the parts and numbers it on
 * the shipper's own series. Issuable pending → completed. The response also carries the
 * server's e-way-bill requirement verdict (ignored here; the ledger reload reflects it).
 */
export function issueFreightInvoice(bookingId: string, body: IssueInvoiceInput) {
  return request<FreightInvoice>(`/bookings/${bookingId}/documents/invoice`, {
    method: 'POST', body: JSON.stringify(body),
  })
}

/**
 * Record an externally generated e-way bill (D-17 — we record, never generate). Either
 * party may file it. Per-booking unique on the 12-digit number, so re-recording the same
 * paper against the same trip is refused.
 */
export function recordEwayBill(bookingId: string, body: RecordEwayBillInput) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill`, {
    method: 'POST', body: JSON.stringify(body),
  })
}

// Parse a scanned NIC document QR (e-way bill / GST e-invoice) into fields that prefill the
// forms (§6). The client decodes the QR from the camera and posts the raw string; a human still
// confirms by saving. Returns the parsed fields — never a saved document.
export type ScanResult = {
  extraction_id: string | null
  kind: 'eway_qr' | 'einvoice_qr' | 'unknown'
  fields: {
    ewb_number?: string
    generated_at?: string
    generated_by_gstin?: string
    irn?: string
    seller_gstin?: string
    buyer_gstin?: string
    doc_no?: string
    doc_date?: string
    total_value?: number
    item_count?: number
    main_hsn?: string
    irn_date?: string
  }
}

export function scanDocumentQr(bookingId: string, raw: string) {
  return request<ScanResult>(`/bookings/${bookingId}/documents/scan`, {
    method: 'POST', body: JSON.stringify({ raw }),
  })
}

/**
 * OCR a photographed / handwritten INVOICE (one without a scannable QR) into fields that prefill
 * the invoice form. `content` is base64 of the image/PDF; `mimeType` its exact type. Returns a
 * clean 501 (ApiError) when invoice OCR is not enabled on the deployment — callers fall back to
 * manual entry. A human still confirms by saving the invoice.
 */
export type OcrInvoiceResult = {
  extraction_id: string | null
  kind: 'ocr'
  fields: {
    /** consignment_note = a transporter's LR / freight bill; tax_invoice = a GST invoice; receipt = a plain bill. */
    doc_type?: 'consignment_note' | 'tax_invoice' | 'receipt' | 'unknown'
    seller_gstin?: string
    buyer_gstin?: string
    supplier_name?: string
    buyer_name?: string
    doc_no?: string
    doc_date?: string
    total_value?: number
    taxable_value?: number
    total_tax?: number
    cgst?: number
    sgst?: number
    igst?: number
    item_count?: number
    eway_bill_no?: string
    lr_no?: string
    transporter_gstin?: string
    transporter_name?: string
    from_place?: string
    to_place?: string
    weight_kg?: number
    freight_inr?: number
    freight_term?: 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'
    sac_code?: string
  }
}

export function ocrDocument(bookingId: string, content: string, mimeType?: string) {
  return request<OcrInvoiceResult>(`/bookings/${bookingId}/documents/ocr`, {
    method: 'POST',
    body: JSON.stringify({ content, ...(mimeType ? { mime_type: mimeType } : {}) }),
  })
}

/**
 * File what the portal did to a recorded bill (§4.5): mark it cancelled or rejected so
 * `standing_eway_bill_number` stops pointing at a dead number. Records the portal's act;
 * does not enforce the 24h/72h window.
 */
export function setEwayBillStatus(bookingId: string, ewbNumber: string, body: SetEwayBillStatusInput) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}`, {
    method: 'PATCH', body: JSON.stringify(body),
  })
}

// ── Payment settlement (bt-payment-service — cash-recorded, D-7) ────────────────
//
// The closing step: record a cash/UPI/direct settlement against a COMPLETED trip and
// flip the booking to paid. Authorized on relation-to-booking (the paying shipper, a
// to-pay consignee, or ops), never the role string. Escrow is a later upgrade.

/** GET /payments/status/:id — the recorded payment + payout(s), or nulls if unsettled. */
export function getPaymentStatus(bookingId: string) {
  return request<PaymentStatus>(`/payments/status/${bookingId}`)
}

/**
 * POST /payments/settle — record the settlement; booking runs completed → paid. A
 * shipper may only settle the AGREED price (the server refuses a self-discount), so the
 * caller passes `final_price ?? quoted_price`, never a hand-typed figure. Idempotent.
 */
export function recordPayment(booking_id: string, amount: number, mode: PaymentMode, reference?: string) {
  return request<SettleResult>('/payments/settle', {
    method: 'POST',
    body: JSON.stringify({ booking_id, amount, mode, ...(reference ? { reference } : {}) }),
  })
}

// Online payment (Razorpay checkout). Off unless the server has Razorpay keys — ask
// getPaymentConfig() first. The server confirms every payment with Razorpay itself; the
// page never reports an amount.

export function getPaymentConfig() {
  return request<PaymentConfig>('/payments/config')
}

export function createOnlineOrder(booking_id: string) {
  return request<OnlineOrder>('/payments/razorpay/order', { method: 'POST', body: JSON.stringify({ booking_id }) })
}

export function verifyOnlinePayment(booking_id: string, result: CheckoutSuccess) {
  return request<SettleResult>('/payments/razorpay/verify', { method: 'POST', body: JSON.stringify({ booking_id, ...result }) })
}

/** Applies an online payment whose confirmation never reached us (tab closed mid-payment). */
export function syncOnlinePayment(booking_id: string) {
  return request<OnlineSync>('/payments/razorpay/sync', { method: 'POST', body: JSON.stringify({ booking_id }) })
}

import type { KycConfig, GstinProfile, GstFilingSummary, KycVerifyResult, KycStatusView, DigiLockerSession, DigiLockerStatus, DigiLockerImport, GstOtpVerified } from './types'

// ── Government-record verification (bt-auth-service /kyc/*, gateway /api/kyc/) ────
// Ask getKycConfig() first: with no provider wired, a verification is recorded for ops
// review (status manual_review) rather than answered, and the GST / DigiLocker calls 503.

export function getKycConfig() {
  return request<KycConfig>('/kyc/config')
}

/** One verification against the provider; the server flips the matching record on success. */
export function verifyKyc(type: 'pan' | 'gst' | 'dl' | 'rc' | 'bank' | 'aadhaar', userId: string, role: 'CUSTOMER' | 'DRIVER' | 'FLEET_OPERATOR', metadata: Record<string, unknown>) {
  return request<KycVerifyResult>(`/kyc/verify/${type}`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role, metadata }),
  })
}

/** Level + per-document status for the signed-in user (or anyone, for ops). */
export function getKycStatus(userId: string) {
  return request<KycStatusView>(`/kyc/status/${encodeURIComponent(userId)}`)
}

export function getGstinProfile(gstin: string) {
  return request<GstinProfile>(`/kyc/gst/${encodeURIComponent(gstin)}/profile`)
}

/** GST identity by OTP: the GST portal texts the mobile registered against the GSTIN. */
export function sendGstOtp(gstin: string, username: string) {
  return request<{ sent: true }>('/kyc/gst/otp', { method: 'POST', body: JSON.stringify({ gstin, username }) })
}

/** The OTP back to the portal; on success the server saves the GSTIN on the account and records the verification. */
export function verifyGstOtp(gstin: string, username: string, otp: string) {
  return request<GstOtpVerified>('/kyc/gst/otp/verify', { method: 'POST', body: JSON.stringify({ gstin, username, otp }) })
}

export function getGstFilingSummary(gstin: string, financialYear?: string) {
  const qs = financialYear ? `?financial_year=${encodeURIComponent(financialYear)}` : ''
  return request<GstFilingSummary>(`/kyc/gst/${encodeURIComponent(gstin)}/returns${qs}`)
}

/** DigiLocker: start → send the person to authorization_url → they come back → status → import. */
export function startDigiLocker(doc_types: Array<'driving_license' | 'aadhaar' | 'pan'>, redirect_url: string) {
  return request<DigiLockerSession>('/kyc/digilocker/session', { method: 'POST', body: JSON.stringify({ doc_types, redirect_url }) })
}

export function getDigiLockerStatus(sessionId: string) {
  return request<DigiLockerStatus>(`/kyc/digilocker/session/${encodeURIComponent(sessionId)}`)
}

export function importDigiLocker(sessionId: string) {
  return request<DigiLockerImport>(`/kyc/digilocker/session/${encodeURIComponent(sessionId)}/import`, { method: 'POST' })
}

import type {
  EwayPortalCredentialsView, EwayGenerateDefaults, GenerateEwayBillInput, UpdateEwayVehicleInput, ExtendEwayBillInput, CancelEwayOnPortalInput,
} from './types'

// ── E-way bills on NIC's portal (bt-booking-service, through the GSP) ────
// The shipper's portal API login is saved once in Settings; bills are then generated,
// updated, extended and cancelled on the portal from the load's Documents tab.

export function getEwayPortalCredentials() {
  return request<EwayPortalCredentialsView>('/bookings/eway-portal/credentials')
}
export function saveEwayPortalCredentials(body: { gstin: string; username: string; password: string }) {
  return request<EwayPortalCredentialsView>('/bookings/eway-portal/credentials', { method: 'PUT', body: JSON.stringify(body) })
}
export function deleteEwayPortalCredentials() {
  return request<{ configured: false }>('/bookings/eway-portal/credentials', { method: 'DELETE' })
}
export function getEwayGenerateDefaults(bookingId: string) {
  return request<EwayGenerateDefaults>(`/bookings/${bookingId}/documents/eway-bill/defaults`)
}
export function generateEwayBill(bookingId: string, body: GenerateEwayBillInput) {
  return request<{ record: EwayBillRecord; alert: string | null }>(`/bookings/${bookingId}/documents/eway-bill/generate`, { method: 'POST', body: JSON.stringify(body) })
}
export function updateEwayBillVehicle(bookingId: string, ewbNumber: string, body: UpdateEwayVehicleInput) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}/vehicle`, { method: 'PUT', body: JSON.stringify(body) })
}
export function extendEwayBill(bookingId: string, ewbNumber: string, body: ExtendEwayBillInput) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}/extend`, { method: 'POST', body: JSON.stringify(body) })
}
export function cancelEwayBillOnPortal(bookingId: string, ewbNumber: string, body: CancelEwayOnPortalInput) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}/cancel-on-portal`, { method: 'POST', body: JSON.stringify(body) })
}
export function syncEwayBill(bookingId: string, ewbNumber: string) {
  return request<EwayBillRecord>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}/sync`, { method: 'POST' })
}
export function getEwayBillPdf(bookingId: string, ewbNumber: string) {
  return request<{ url: string }>(`/bookings/${bookingId}/documents/eway-bill/${ewbNumber}/pdf`)
}

// ── Driver-document scan (bt-auth-service /onboarding/ocr) ────
// Off unless the server has an OCR processor configured — ask getDocumentScanConfig() first.
// The photo is read and dropped; nothing is saved until the driver submits the form.

export function getDocumentScanConfig() {
  return request<{ enabled: boolean }>('/onboarding/ocr/config')
}

export function scanDocument<K extends ScanKind>(kind: K, mime_type: string, content_base64: string) {
  return request<DocumentScan<K>>('/onboarding/ocr', {
    method: 'POST',
    body: JSON.stringify({ kind, mime_type, content_base64 }),
  })
}

// ── Driver self-onboarding (bt-auth-service /onboarding/*) ────
//
// Every route here needs the 'drive' capability (a drivers row) and NOTHING else — a
// driver's own record is completed without a truck. Adding a truck is a separate,
// GST-gated act: POST /fleet/vehicles and POST /onboarding/vehicle both answer 403 with
// code GSTIN_REQUIRED until a GSTIN is on file (Settings).

/** The 403 code both vehicle-create routes send when no GSTIN is on file. */
export const GSTIN_REQUIRED = 'GSTIN_REQUIRED'

export function getDriverOnboarding() {
  return request<DriverOnboarding>('/onboarding/profile')
}

export function getOnboardingStatus() {
  return request<OnboardingStatus>('/onboarding/status')
}

export type DriverProfileInput = {
  full_name?: string
  photo_url?: string
  languages?: string[]
  home_base_city?: string
}

export function updateDriverProfile(body: DriverProfileInput) {
  return request<{ driver: DriverProfile }>('/onboarding/profile', { method: 'PUT', body: JSON.stringify(body) })
}

export type DriverLicenseInput = {
  dl_number: string
  vehicle_classes?: string[]
  expiry_date?: string
}

/** First submission — 409 if one already exists (use updateDriverLicense then). */
export function submitDriverLicense(body: DriverLicenseInput) {
  return request<{ license: DriverLicense }>('/onboarding/license', { method: 'POST', body: JSON.stringify(body) })
}

/** Corrects an existing licence; the server resets its status to 'pending'. */
export function updateDriverLicense(body: Partial<DriverLicenseInput>) {
  return request<{ license: DriverLicense }>('/onboarding/license', { method: 'PUT', body: JSON.stringify(body) })
}

export type BankAccountInput = {
  account_number: string
  ifsc: string
  account_holder_name: string
  bank_name?: string
  is_primary?: boolean
}

/** The account number is encrypted server-side; only its last 4 digits ever come back. */
export function linkBankAccount(body: BankAccountInput) {
  return request<{ bank_account: BankAccount }>('/onboarding/bank-account', { method: 'POST', body: JSON.stringify(body) })
}
