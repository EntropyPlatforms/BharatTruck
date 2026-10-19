'use client'

/**
 * Trip detail / Navigate (drive surface — Phase 3 of docs/UNIFIED_APP_PLAN.md).
 *
 * The driver's active-trip surface, ported from driver/src/app/(app)/bookings/[id]/page.tsx
 * into bt-app's light house style. It closes the trip end to end — start, drive, deliver —
 * and NO sub-view can render blank:
 *
 *  - Booking (primary): Loading → NotFound(Empty) → Error(retry) → the record.
 *  - Not-yours guard: a booking that isn't the caller's to drive shows a clear note, not
 *    the drive controls.
 *  - Accepted: Start trip (with a submitting state) + a Navigate deep-link to pickup.
 *  - In transit: live GPS push (~10s, guarded for permission-denied / unsupported), the
 *    route map (degrades to the guard's note, never blank), a Navigate deep-link to the
 *    drop, the receiver-OTP POD flow (handles "no receiver contact"), and trip insights
 *    (pumps / fuel / alerts — each with its own loading/empty/error).
 *  - Delivered / awaiting-confirmation / paid / cancelled: each a plain status card.
 *
 * The wake lock and the GPS watch are scoped to the in_transit branch ONLY — they mount
 * with the active trip and release on unmount. Nothing driver-runtime is registered
 * app-wide (a shipper opening bt-app never gets a wake lock or a GPS watch).
 *
 * Layout (2026-10 light redesign): a mobile-first stack of cards in a centred ~720px
 * column — header, route, details, 4-step stepper, the state's action card with 56px
 * thumb buttons, then evidence, documents and expenses.
 */

import { use, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertCircle, ArrowLeft, Ban, Check, CheckCircle2, Clock, Flag, Mail, Navigation, Phone,
  PlayCircle, ShieldAlert, Timer, Truck, UserPlus, Wallet,
} from 'lucide-react'

import { Card, Empty, ErrorNote, IconTile, Loading } from '@/components/stat'
import { MapBoundary } from '@/components/map-guard'
import LiveTrackMap from '@/components/maps/LiveTrackMap'
import RouteMap from '@/components/maps/RouteMap'
import { TripAlerts, TripFuelAndPumps } from '@/components/trip-insights'
import DeliveryEvidence from '@/components/delivery-evidence'
import FreightDocuments from '@/components/freight-documents'
import TripExpenses from '@/components/trip-expenses'
import { CopyId, RouteRail, cityOf, loadTypeLabel, tonnes } from '@/components/driver/trip-bits'
import {
  ApiError,
  getBooking,
  getPodContext,
  getRoute,
  pushLocation,
  requestPodOtp,
  verifyPodOtp,
  startTrip,
} from '@/lib/api'
import { buildNavDeepLink, isLatLng } from '@/lib/maps'
import { bookingStatusConfig } from '@/lib/status'
import { inr, shortDate } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'
import { useScreenWakeLock } from '@/lib/use-wake-lock'
import type { Booking, BookingStatus, PodContext, RouteData } from '@/lib/types'

const COLUMN = 'p-4 lg:p-8 max-w-[720px] mx-auto'
/** 56px thumb buttons — the driver is often standing at a truck, gloves on. */
const THUMB = 'h-14! w-full text-base! rounded-xl'
const SPIN_DARK = 'w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin'

export default function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Road distance/duration, reported up by the in-transit section's existing route read
  // (no extra call) so the route card can show "712 km · about 13 h".
  const [route, setRoute] = useState<RouteData | null>(null)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    getBooking(id)
      .then((b) => { if (!cancelled) setBooking(b) })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.code === 'NOT_FOUND') setNotFound(true)
        else setError(err instanceof ApiError ? err.message : 'Could not load this trip.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, nonce])

  const backLink = (
    <Link
      href="/my-trips"
      className="inline-flex items-center gap-1.5 -ml-1 px-1 h-10 text-[0.9375rem] font-semibold text-blue-600 hover:text-blue-700 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      <ArrowLeft className="w-5 h-5" /> My Trips
    </Link>
  )

  if (loading && !booking) {
    return (
      <div className={COLUMN}>
        {backLink}
        <Loading label="Loading this trip" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className={COLUMN}>
        {backLink}
        <Card className="mt-3">
          <Empty title="Trip not found" hint="It may have been reassigned, or you may not have access to it. Head back to My Trips." />
        </Card>
      </div>
    )
  }

  if (error && !booking) {
    return (
      <div className={COLUMN}>
        {backLink}
        <div className="space-y-3 mt-3">
          <ErrorNote message={error} />
          <button onClick={reload} className={BTN_SECONDARY}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!booking) {
    return (
      <div className={COLUMN}>
        {backLink}
        <Card className="mt-3"><Empty title="Nothing to show" hint="The service returned no trip." /></Card>
      </div>
    )
  }

  const status = bookingStatusConfig[booking.status] ?? bookingStatusConfig.pending

  // Whether this human may DRIVE this trip. The relation block is the intended signal;
  // when it's absent (older backend) we stay permissive and let the server be the real
  // gate — startTrip / POD are all server-authorised, so a stale tab can't act anyway.
  const rel = booking.viewer?.relations
  const canDrive = rel === undefined || rel.includes('driver') || rel.includes('carrier')

  return (
    <div className={COLUMN}>
      {backLink}

      <div className="mt-1 mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-extrabold tracking-tight text-gray-900">Trip</h1>
          <CopyId id={booking.id} className="mt-0.5" />
        </div>
        <span className={cx(status.color, 'mt-1.5 text-sm! px-2.5! py-1!')}>{status.label}</span>
      </div>

      <div className="space-y-3">
        <RouteCard booking={booking} route={route} />
        <TripSummaryCard booking={booking} />
        {booking.status !== 'cancelled' && <TripStatusStepper status={booking.status} />}
        <TripActionSection booking={booking} canDrive={canDrive} onRefresh={reload} onRoute={setRoute} />
        {/* Freight documents (Phase 4): the trip's paperwork — LR / invoice / e-way bill.
            Page-level (not in the in_transit-only section) so it shows from 'accepted'
            through 'completed'; the carrier can raise the LR while accepted/in_transit. */}
        {booking.status !== 'cancelled' && <FreightDocuments booking={booking} onChanged={reload} />}
        {/* Trip expenses (A2): the assigned driver logs fuel/toll/repair with a controlled
            category, feeding the fleet fuel/pilferage signal. Driver-gated inside. */}
        {booking.status !== 'cancelled' && <TripExpenses booking={booking} canDrive={canDrive} onChanged={reload} />}
      </div>
    </div>
  )
}

// ── Route + summary ───────────────────────────────────────────

function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 3600) return `about ${Math.max(1, Math.round(seconds / 60))} min`
  return `about ${Math.round(seconds / 3600)} h`
}

function RouteCard({ booking, route }: { booking: Booking; route: RouteData | null }) {
  const origin = { lat: booking.source_lat, lng: booking.source_lng }
  const dest = { lat: booking.dest_lat, lng: booking.dest_lng }
  // In transit, the live map further down already shows the route; a cancelled trip has
  // none. Every other state gets a still preview of pickup → drop.
  const showMap = booking.status !== 'in_transit' && booking.status !== 'cancelled' && isLatLng(origin) && isLatLng(dest)
  return (
    <Card className="p-4">
      {showMap && (
        <RouteMap
          origin={origin}
          dest={dest}
          originLabel={cityOf(booking.source_address)}
          destLabel={cityOf(booking.destination_address)}
          padding={44}
          className="-mx-4 -mt-4 mb-4 h-44 sm:h-52 rounded-t-xl border-b border-gray-200"
        />
      )}
      <div className="flex gap-3">
        <RouteRail />
        <div className="min-w-0 flex-1 flex flex-col justify-between gap-2">
          <p className="text-[0.9375rem] font-semibold text-gray-900 leading-snug">{booking.source_address}</p>
          <p className="text-[0.9375rem] font-semibold text-gray-900 leading-snug">{booking.destination_address}</p>
        </div>
      </div>
      {route && route.distance_m > 0 && (
        <p className="mt-2 pl-8 text-sm text-gray-500 tabular-nums">
          {Math.round(route.distance_m / 1000).toLocaleString('en-IN')} km
          {durationText(route.static_duration_s) && <> · {durationText(route.static_duration_s)}</>}
        </p>
      )}
    </Card>
  )
}

function TripSummaryCard({ booking }: { booking: Booking }) {
  const pickup = booking.pickup_time_slot
    ? `${shortDate(booking.pickup_date)} · ${booking.pickup_time_slot}`
    : shortDate(booking.pickup_date)

  return (
    <>
      <Card className="px-4 py-1">
        <dl className="divide-y divide-gray-100 text-[0.9375rem]">
          <Detail label="Load type" value={loadTypeLabel(booking.load_type)} />
          <Detail label="Weight" value={`${tonnes(booking.weight_kg)} (${booking.weight_kg.toLocaleString('en-IN')} kg)`} />
          <Detail label="Pickup" value={pickup} />
          {/* The API strips the money for an employed driver, so guard the read. */}
          {booking.final_price != null
            ? <Detail label="Payout" value={inr(booking.final_price)} money />
            : booking.quoted_price != null && <Detail label="Freight" value={inr(booking.quoted_price)} money />}
        </dl>
      </Card>

      {booking.consignee && (booking.consignee.name || booking.consignee.phone) && (
        <Card className="p-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-500">Consignee</p>
            <p className="text-[0.9375rem] font-bold text-gray-900">{booking.consignee.name ?? 'Unnamed consignee'}</p>
            {booking.consignee.city && <p className="text-sm text-gray-500">{booking.consignee.city}</p>}
            {booking.consignee.phone && (
              <p className="text-sm text-gray-500 tabular-nums">{booking.consignee.phone}</p>
            )}
          </div>
          {booking.consignee.phone && (
            <a
              href={`tel:${booking.consignee.phone}`}
              aria-label={`Call ${booking.consignee.name ?? 'the consignee'} on ${booking.consignee.phone}`}
              className="w-12 h-12 shrink-0 rounded-full border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <Phone className="w-5 h-5" />
            </a>
          )}
        </Card>
      )}

      {booking.special_instructions && (
        <Card className="p-4">
          <p className="text-sm text-gray-500">Special instructions</p>
          <p className="text-[0.9375rem] text-gray-900 mt-0.5">{booking.special_instructions}</p>
        </Card>
      )}
    </>
  )
}

function Detail({ label, value, money }: { label: string; value: string; money?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-2.5">
      <dt className="text-gray-500">{label}</dt>
      <dd className={money ? 'font-bold text-emerald-600 tabular-nums' : 'font-medium text-gray-900'}>{value}</dd>
    </div>
  )
}

// ── Status stepper ────────────────────────────────────────────

function stepIndexFor(status: BookingStatus): number {
  switch (status) {
    case 'accepted': return 0
    case 'in_transit': return 1
    case 'delivery_asserted': return 1 // reported, not yet confirmed
    case 'completed': return 2
    case 'paid': return 3
    default: return -1
  }
}

function TripStatusStepper({ status }: { status: BookingStatus }) {
  const steps = ['Assigned', 'In transit', 'Delivered', 'Paid']
  const current = stepIndexFor(status)
  // 'paid' is the last step and terminal, so it reads as done rather than "in progress".
  const allDone = status === 'paid'
  return (
    <section aria-label="Trip status" className="px-1 py-2">
      <ol className="grid grid-cols-4">
        {steps.map((label, i) => {
          const done = i < current || (allDone && i === current)
          const now = i === current && !allDone
          return (
            <li key={label} className="relative flex flex-col items-center gap-1.5" aria-current={now ? 'step' : undefined}>
              {i > 0 && (
                <span
                  aria-hidden
                  className={cx(
                    'absolute top-[12.5px] h-[3px] rounded-full right-[calc(50%+18px)] w-[calc(100%-36px)]',
                    i <= current ? 'bg-blue-600' : 'bg-gray-200',
                  )}
                />
              )}
              <span
                className={cx(
                  'relative z-10 w-7 h-7 rounded-full flex items-center justify-center',
                  done ? 'bg-blue-600 text-[#fff]'
                    : now ? 'bg-white border-[3px] border-blue-600 ring-4 ring-blue-100'
                      : 'bg-white border-2 border-gray-300',
                )}
              >
                {done ? <Check className="w-4 h-4" strokeWidth={3} />
                  : now ? <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
                    : <span className="w-2 h-2 rounded-full bg-gray-300" />}
              </span>
              <span className={cx('text-[0.8125rem] text-center', now ? 'font-bold text-gray-900' : done ? 'font-medium text-gray-700' : 'text-gray-400')}>
                {label}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ── Shared callouts ───────────────────────────────────────────

/** A status card: tinted icon, a bold title, one line under it. */
function StateCard({
  icon, tone, title, children,
}: { icon: ReactNode; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; title: string; children?: ReactNode }) {
  const box = {
    green: 'bg-emerald-50 border-emerald-200',
    amber: 'bg-amber-50 border-amber-200',
    red: 'bg-red-50 border-red-200',
    slate: 'bg-white border-gray-200',
    blue: 'bg-blue-50 border-blue-200',
  }[tone]
  const dot = {
    green: 'bg-emerald-600 text-[#fff]',
    amber: 'bg-amber-400 text-gray-900',
    red: 'bg-red-600 text-[#fff]',
    slate: 'bg-gray-100 text-gray-600',
    blue: 'bg-blue-600 text-[#fff]',
  }[tone]
  const ink = {
    green: 'text-emerald-800', amber: 'text-amber-900', red: 'text-red-800', slate: 'text-gray-900', blue: 'text-blue-900',
  }[tone]
  return (
    <div className={cx('rounded-xl border p-4 flex items-start gap-3', box)}>
      <span className={cx('w-10 h-10 rounded-full flex items-center justify-center shrink-0 [&_svg]:w-5 [&_svg]:h-5', dot)}>{icon}</span>
      <div className="min-w-0 pt-0.5">
        <p className={cx('text-base font-bold', ink)}>{title}</p>
        {children && <div className="text-sm text-gray-600 mt-0.5">{children}</div>}
      </div>
    </div>
  )
}

// ── Action section — chosen by status ─────────────────────────

function TripActionSection({
  booking, canDrive, onRefresh, onRoute,
}: { booking: Booking; canDrive: boolean; onRefresh: () => void; onRoute: (r: RouteData) => void }) {
  if (booking.status === 'cancelled') {
    return (
      <StateCard icon={<Ban />} tone="slate" title="Trip cancelled">
        This trip is no longer active.
      </StateCard>
    )
  }

  if (!canDrive) {
    return (
      <StateCard icon={<ShieldAlert />} tone="slate" title="This trip isn't yours to drive">
        Only the assigned driver can start it or capture delivery.
      </StateCard>
    )
  }

  if (booking.status === 'accepted') {
    // A fleet-won booking is 'accepted' with the CARRIER locked in but driver_id still NULL — the
    // owner pairs a truck+driver in Trips before anyone can start it. Offering "Start Trip" here
    // dead-ends at a server 403 with a misleading toast; send the owner to pair crew instead (F1).
    if (isAwaitingFleetDriver(booking)) {
      return <AwaitingCrewSection booking={booking} />
    }
    return <AcceptedTripSection booking={booking} onRefresh={onRefresh} />
  }

  if (booking.status === 'in_transit') {
    return <ActiveTripSection booking={booking} onRefresh={onRefresh} onRoute={onRoute} />
  }

  if (booking.status === 'delivery_asserted') {
    return <AssertedTripSection booking={booking} onRefresh={onRefresh} />
  }

  if (booking.status === 'completed') {
    return (
      <StateCard icon={<CheckCircle2 />} tone="green" title="Delivered ✓">
        {booking.final_price != null
          ? `Delivered successfully — ${inr(booking.final_price)} awaiting payment.`
          : 'Delivered successfully. Awaiting payment.'}
      </StateCard>
    )
  }

  if (booking.status === 'paid') {
    return (
      <StateCard icon={<Wallet />} tone="green" title="Payment received ✓">
        {booking.final_price != null ? `${inr(booking.final_price)} settled.` : 'This trip is settled.'}
      </StateCard>
    )
  }

  // pending / negotiating shouldn't reach My Trips, but never blank if one does.
  return (
    <StateCard icon={<Clock />} tone="slate" title="Not ready to drive yet">
      This trip isn&apos;t assigned for driving at the moment.
    </StateCard>
  )
}

// ── Navigate deep-link ────────────────────────────────────────
//
// FROZEN Maps contract: navigation is a deep-link handoff to the phone's Google Maps
// app — NO in-app turn-by-turn. Destination-only, so Google Maps uses the device's live
// location as the start. The target follows the leg: PICKUP while 'accepted', DROP once
// 'in_transit'. It is a plain <a href> — a link is never blank.

function NavigateButton({ booking }: { booking: Booking }) {
  const toPickup = booking.status === 'accepted'
  const destination = toPickup
    ? { lat: booking.source_lat, lng: booking.source_lng }
    : { lat: booking.dest_lat, lng: booking.dest_lng }
  const label = toPickup ? 'Navigate to pickup' : 'Navigate to delivery'

  return (
    <a
      href={buildNavDeepLink({ destination })}
      target="_blank"
      rel="noopener noreferrer"
      className={cx(BTN_SECONDARY, THUMB)}
    >
      <Navigation className="w-5 h-5 text-blue-600" />
      {label}
    </a>
  )
}

// ── Accepted (fleet-won, not yet crewed): pair a truck + driver ────────────────

/**
 * A fleet wins the auction as a COMPANY; the truck+driver are paired to the trip afterwards in the
 * fleet console. Until then driver_id is NULL, so an 'accepted' fleet booking means "carrier locked
 * in", NOT "driver assigned" — starting it is refused server-side. Mirrors isAwaitingFleetDriver in
 * the shipper load-detail view.
 */
function isAwaitingFleetDriver(booking: Booking): boolean {
  return !!booking.fleet_owner_id && !booking.driver_id
}

function AwaitingCrewSection({ booking }: { booking: Booking }) {
  return (
    <Card className="p-5 text-center">
      <span className="mx-auto mb-3 w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
        <UserPlus className="w-7 h-7" />
      </span>
      <p className="text-lg font-bold text-gray-900">Assign a truck &amp; driver</p>
      <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
        Your fleet won this load. Pair a truck and driver in Trips before it can start.
      </p>
      <div className="mt-4 rounded-xl bg-gray-50 border border-gray-100 p-3 space-y-2 text-sm text-left">
        <div className="flex justify-between gap-3">
          <span className="text-gray-500">From</span>
          <span className="font-medium text-gray-900 text-right truncate max-w-[70%]">{booking.source_address}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-gray-500">To</span>
          <span className="font-medium text-gray-900 text-right truncate max-w-[70%]">{booking.destination_address}</span>
        </div>
      </div>
      <Link href="/trips" className={cx(BTN_PRIMARY, THUMB, 'mt-4')}>
        Assign in Trips
      </Link>
    </Card>
  )
}

// ── Accepted: Start Trip ──────────────────────────────────────

function AcceptedTripSection({ booking, onRefresh }: { booking: Booking; onRefresh: () => void }) {
  const [starting, setStarting] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  async function handleStart() {
    setStarting(true)
    try {
      await startTrip(booking.id)
      toast.success('Trip started — GPS tracking is now active')
      onRefresh()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start the trip')
      setStarting(false)
      setShowConfirm(false)
    }
  }

  return (
    <div className="space-y-3">
      <StateCard icon={<Check strokeWidth={3} />} tone="green" title="You're assigned this trip">
        Load up at the pickup, then start the trip to begin sharing your location.
      </StateCard>

      {!showConfirm ? (
        <button onClick={() => setShowConfirm(true)} className={cx(BTN_PRIMARY, THUMB)}>
          <PlayCircle className="w-5 h-5" />
          Start trip
        </button>
      ) : (
        <Card className="p-5 text-center border-brand-300 ring-1 ring-brand-200">
          <span className="mx-auto mb-3 w-14 h-14 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center">
            <Truck className="w-7 h-7" />
          </span>
          <p className="text-lg font-bold text-gray-900 leading-snug">
            Confirm you&apos;ve loaded the cargo and are ready to depart?
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <button
              onClick={() => setShowConfirm(false)}
              disabled={starting}
              className={cx(BTN_SECONDARY, THUMB)}
            >
              Not yet
            </button>
            <button
              onClick={handleStart}
              disabled={starting}
              className={cx(BTN_PRIMARY, THUMB)}
            >
              {starting && <span className={SPIN_DARK} />}
              {starting ? 'Starting…' : 'Yes, start trip'}
            </button>
          </div>
        </Card>
      )}

      <NavigateButton booking={booking} />
    </div>
  )
}

// ── In transit: active trip (GPS, map, POD) ───────────────────

type DeliverPhase = 'idle' | 'confirm' | 'sent'

// Persist the 'awaiting receiver confirmation' state across reloads/remounts. Ephemeral
// useState would reset to idle on a reload and tempt a re-tap that silently issues a NEW
// code, invalidating the one the receiver is already typing. We stamp a per-booking
// localStorage record when the code is sent; a remount restores 'sent' from it, and
// re-issuing a code requires the explicit "Resend delivery code" action.
type AwaitingRecord = { receiver_email: string | null; sent_at: number }

function awaitingKey(bookingId: string): string { return `bt-app-pod-awaiting:${bookingId}` }

function readAwaiting(bookingId: string): AwaitingRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(awaitingKey(bookingId))
    return raw ? (JSON.parse(raw) as AwaitingRecord) : null
  } catch { return null }
}

function writeAwaiting(bookingId: string, rec: AwaitingRecord): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(awaitingKey(bookingId), JSON.stringify(rec)) } catch { /* storage may be unavailable */ }
}

function clearAwaiting(bookingId: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(awaitingKey(bookingId)) } catch { /* non-fatal */ }
}

function ActiveTripSection({
  booking, onRefresh, onRoute,
}: { booking: Booking; onRefresh: () => void; onRoute?: (r: RouteData) => void }) {
  const [deliverPhase, setDeliverPhase] = useState<DeliverPhase>('idle')
  const [podContext, setPodContext] = useState<PodContext | null>(null)
  const [loadingContext, setLoadingContext] = useState(false)
  const [sending, setSending] = useState(false)
  // The code the driver types in — the receiver reads it out at the drop. Verifying it is
  // what actually closes the trip (the old flow only polled and had NOWHERE to enter it).
  const [otpInput, setOtpInput] = useState('')
  const [otpFocused, setOtpFocused] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [gpsActive, setGpsActive] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState('')

  // The driver's OWN position, held locally for the map — no round trip, and it keeps
  // updating through the network dead zones where a driver most needs the map.
  const [selfPos, setSelfPos] = useState<{ lat: number; lng: number } | null>(null)
  const [route, setRoute] = useState<RouteData | null>(null)
  // Held in a ref so the route read below stays one call per trip (not re-run if the
  // parent's callback identity ever changes).
  const onRouteRef = useRef(onRoute)
  useEffect(() => { onRouteRef.current = onRoute }, [onRoute])

  // Keep the screen awake for the whole in-transit trip so the OS doesn't throttle
  // background GPS (frozen D-008). SCOPED here: this section renders only while
  // in_transit, so the lock releases the moment the trip closes or we navigate away —
  // nothing app-wide. A shipper never reaches this branch.
  useScreenWakeLock(booking.status === 'in_transit')

  // Live GPS push (~10s). Best-effort, never blocks the trip flow; guarded so a denied
  // or unsupported permission shows a clear message instead of a blank or a crash. When
  // the trip flips to completed this section unmounts and the watch is cleared here.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('Location sharing is unavailable on this device — it activates on a phone with GPS.')
      return
    }

    let gotFix = false
    const timeoutId = setTimeout(() => {
      if (!gotFix) {
        setGpsError('Location unavailable on this device — tracking will activate on a mobile with GPS.')
        setGpsActive(false)
      }
    }, 10_000)

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        gotFix = true
        clearTimeout(timeoutId)
        setGpsActive(true)
        setGpsError(null)
        // Draw locally first — the map must not wait on the network round trip below.
        setSelfPos({ lat: position.coords.latitude, lng: position.coords.longitude })
        pushLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          heading: position.coords.heading ?? undefined,
          speed_kmh: position.coords.speed ? position.coords.speed * 3.6 : undefined,
          accuracy_m: position.coords.accuracy ?? undefined,
          booking_id: booking.id,
        }).catch(() => {
          // silent — a dropped push must never interrupt the drive
        })
      },
      (err) => {
        if (err.code === 1) {
          clearTimeout(timeoutId)
          setGpsError('Location access denied — enable location for this site to share your position.')
          setGpsActive(false)
        }
        // code 2 (POSITION_UNAVAILABLE) and 3 (TIMEOUT): let the 10s timer handle it
      },
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 },
    )

    return () => {
      clearTimeout(timeoutId)
      navigator.geolocation.clearWatch(watchId)
    }
  }, [booking.id, booking.status])

  // Road geometry for the map — one call per trip, best-effort. A failure leaves `route`
  // null and the map draws pickup, drop and the truck without the road line: a degraded
  // map, not a broken trip, so it's deliberately not surfaced as an error.
  useEffect(() => {
    let cancelled = false
    getRoute(booking.id)
      .then((r) => {
        if (cancelled) return
        setRoute(r)
        onRouteRef.current?.(r) // display only: lets the route card show distance / duration
      })
      .catch(() => { /* silent — the map degrades to markers-only */ })
    return () => { cancelled = true }
  }, [booking.id])

  // Elapsed time since the trip went in transit.
  useEffect(() => {
    const start = new Date(booking.in_transit_at ?? booking.updated_at ?? Date.now()).getTime()
    function update() {
      const diff = Date.now() - start
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      setElapsed(h > 0 ? `${h}h ${m}m` : `${m}m`)
    }
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [booking.in_transit_at, booking.updated_at])

  // Restore the awaiting state on mount so a reload doesn't reset to idle. Done in an
  // effect (not useState init) to stay SSR/hydration-safe.
  useEffect(() => {
    const rec = readAwaiting(booking.id)
    if (rec) {
      setPodContext({ booking_id: booking.id, status: 'in_transit', receiver_email: rec.receiver_email })
      setDeliverPhase('sent')
    }
  }, [booking.id])

  // POD completion is out-of-band: once the code is sent, the receiver's verify drives
  // booking-service in_transit → completed. Poll the booking until it flips, clear the
  // persisted awaiting record, then refresh (this section unmounts, the completed card renders).
  useEffect(() => {
    if (deliverPhase !== 'sent') return
    const interval = setInterval(async () => {
      try {
        const b = await getBooking(booking.id)
        if (b.status !== 'in_transit') {
          clearInterval(interval)
          clearAwaiting(booking.id)
          toast.success('Delivery confirmed by receiver')
          onRefresh()
        }
      } catch {
        // silent — keep polling
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [deliverPhase, booking.id, onRefresh])

  async function handleFetchContext() {
    setLoadingContext(true)
    try {
      const ctx = await getPodContext(booking.id)
      setPodContext(ctx)
      setDeliverPhase('confirm')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start delivery capture')
    } finally {
      setLoadingContext(false)
    }
  }

  async function handleSendOtp() {
    setSending(true)
    try {
      await requestPodOtp(booking.id)
      writeAwaiting(booking.id, { receiver_email: podContext?.receiver_email ?? null, sent_at: Date.now() })
      setDeliverPhase('sent')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the delivery code')
    } finally {
      setSending(false)
    }
  }

  async function handleResend() {
    setSending(true)
    setVerifyError(null)
    try {
      await requestPodOtp(booking.id)
      writeAwaiting(booking.id, { receiver_email: podContext?.receiver_email ?? null, sent_at: Date.now() })
      toast.success('Delivery code re-sent')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not resend the delivery code')
    } finally {
      setSending(false)
    }
  }

  // The driver enters the code the receiver gives them; verifying it closes the trip.
  // This is the completion path the grafted flow was missing — it only polled, so the
  // code the receiver read out had nowhere to go.
  async function handleVerify(e: FormEvent) {
    e.preventDefault()
    const code = otpInput.trim()
    if (!/^\d{6}$/.test(code)) {
      setVerifyError('Enter the 6-digit code the receiver gives you.')
      return
    }
    setVerifying(true)
    setVerifyError(null)
    try {
      await verifyPodOtp(booking.id, code)
      clearAwaiting(booking.id)
      toast.success('Delivery confirmed')
      onRefresh() // trip is now completed — this section unmounts, the completed card renders
    } catch (err) {
      // Wrong / expired / too-many-attempts all surface here. Keep the box so the driver
      // can re-read the code (or resend); never blank, never a silent failure.
      setVerifyError(err instanceof ApiError ? err.message : 'That code did not work. Ask the receiver to read it again, or resend.')
    } finally {
      setVerifying(false)
    }
  }

  function handleCancelAwaiting() {
    clearAwaiting(booking.id)
    setDeliverPhase('idle')
    setOtpInput('')
    setVerifyError(null)
  }

  const receiverEmail = podContext?.receiver_email ?? null

  const origin = useMemo(
    () => ({ lat: booking.source_lat, lng: booking.source_lng }),
    [booking.source_lat, booking.source_lng],
  )
  const dest = useMemo(
    () => ({ lat: booking.dest_lat, lng: booking.dest_lng }),
    [booking.dest_lat, booking.dest_lng],
  )

  // Runtime coord guard: a null slipping through the type would render a map at (0,0) —
  // the Gulf of Guinea — which looks like a working map showing the wrong thing.
  const hasCoords =
    Number.isFinite(booking.source_lat) && Number.isFinite(booking.source_lng) &&
    Number.isFinite(booking.dest_lat) && Number.isFinite(booking.dest_lng)

  const insightsFallback = (
    <p className="text-xs text-gray-500 px-1">
      Trip insights are unavailable right now. Your delivery controls above are unaffected.
    </p>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1 pt-1">
        <h2 className="text-lg font-bold text-gray-900">Trip in progress</h2>
        {elapsed && (
          <span className="inline-flex items-center gap-1.5 text-[0.9375rem] font-semibold text-gray-700 tabular-nums">
            <Timer className="w-4 h-4 text-gray-500" /> {elapsed}
          </span>
        )}
      </div>

      {/* GPS status — always says something, never blank. */}
      <div
        role="status"
        className={cx(
          'flex items-center gap-2.5 rounded-xl px-3.5 py-3 border',
          gpsActive ? 'bg-emerald-50 border-emerald-200'
            : gpsError ? 'bg-gray-50 border-gray-200'
              : 'bg-amber-50 border-amber-200',
        )}
      >
        <span className={cx(
          'w-2.5 h-2.5 rounded-full shrink-0 ring-4',
          gpsActive ? 'bg-emerald-500 ring-emerald-100 animate-pulse'
            : gpsError ? 'bg-gray-400 ring-gray-100'
              : 'bg-amber-500 ring-amber-100 animate-pulse',
        )} />
        <span className={cx(
          'text-sm font-medium',
          gpsActive ? 'text-emerald-800' : gpsError ? 'text-gray-600' : 'text-amber-800',
        )}>
          {gpsActive ? 'Location active — sharing with the shipper' : gpsError ?? 'Acquiring location…'}
        </span>
      </div>

      {/* The map always draws pickup + drop from the booking's own coords, so it is never
          blank even with no live fix or route; it degrades to the guard's note on a key
          problem. A booking without coordinates simply renders no map. */}
      {hasCoords && (
        <LiveTrackMap
          origin={origin}
          dest={dest}
          encodedPolyline={route?.polyline}
          bounds={route?.bounds}
          driver={selfPos}
          className="h-60 sm:h-72 w-full rounded-xl overflow-hidden border border-gray-200"
        />
      )}

      <NavigateButton booking={booking} />

      <Card className="p-4 flex items-center gap-3">
        <IconTile icon={<Flag />} tint="red" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-500">Delivering to</p>
          <p className="text-[0.9375rem] font-bold text-gray-900 leading-snug">{booking.destination_address}</p>
          {booking.consignee?.name && <p className="text-sm text-gray-500">{booking.consignee.name}</p>}
        </div>
        {booking.consignee?.phone && (
          <a
            href={`tel:${booking.consignee.phone}`}
            aria-label={`Call ${booking.consignee.name ?? 'the consignee'}`}
            className="w-12 h-12 shrink-0 rounded-full border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <Phone className="w-5 h-5" />
          </a>
        )}
      </Card>

      {/* Route alerts sit right above the delivery controls. Boundaried as belt-and-braces
          so an unexpected server shape throwing during render can't unmount Mark-as-Delivered. */}
      <MapBoundary fallback={insightsFallback}>
        <TripAlerts bookingId={booking.id} />
      </MapBoundary>

      {/* Proof-of-delivery, three steps: (idle) Mark as delivered → send a code to the
          receiver → (sent) the driver enters the code the receiver reads out and CONFIRMS,
          which verifies it and closes the trip. A background poll also closes it if the
          receiver instead enters the code on their own device. The trip is never closed
          without a verified code. */}
      {deliverPhase === 'idle' && (
        <button
          onClick={handleFetchContext}
          disabled={loadingContext}
          className={cx(BTN_PRIMARY, THUMB)}
        >
          {loadingContext ? <span className={SPIN_DARK} /> : <Flag className="w-5 h-5" />}
          {loadingContext ? 'Preparing…' : 'Mark as delivered'}
        </button>
      )}

      {deliverPhase === 'confirm' && (
        <Card className="p-5 border-brand-300 ring-1 ring-brand-200">
          {receiverEmail ? (
            <div className="text-center">
              <span className="mx-auto mb-3 w-12 h-12 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center">
                <Mail className="w-6 h-6" />
              </span>
              <p className="text-lg font-bold text-gray-900">Send delivery code?</p>
              <p className="text-sm text-gray-500 mt-1">Delivery code will be sent to</p>
              <p className="text-base font-semibold text-blue-600 break-all">{receiverEmail}</p>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-full bg-red-600 text-[#fff] flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5" />
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-sm text-gray-500">Delivery code will be sent to</p>
                <p className="font-semibold text-red-600">
                  No receiver contact set — the shipper must add one to confirm delivery.
                </p>
              </div>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <button
              onClick={() => setDeliverPhase('idle')}
              disabled={sending}
              className={cx(BTN_SECONDARY, THUMB)}
            >
              Cancel
            </button>
            <button
              onClick={handleSendOtp}
              disabled={sending || !receiverEmail}
              className={cx(BTN_PRIMARY, THUMB)}
            >
              {sending && <span className={SPIN_DARK} />}
              {sending ? 'Sending…' : 'Send delivery code'}
            </button>
          </div>
        </Card>
      )}

      {deliverPhase === 'sent' && (
        <Card className="p-5 border-brand-300 ring-1 ring-brand-200">
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="text-center">
              <p className="text-lg font-bold text-gray-900">Enter the delivery code</p>
              <p className="text-sm text-gray-600 mt-1">
                A code was sent to{' '}
                <span className="font-semibold text-blue-600 break-all">{receiverEmail ?? 'the receiver'}</span>.
                Ask them to read it out and enter it below.
              </p>
            </div>

            {/* Six digit boxes drawn over ONE real input — typing, paste and the OS
                one-time-code autofill all go through the same field as before. */}
            <div className="relative">
              <div aria-hidden className="grid grid-cols-6 gap-2">
                {Array.from({ length: 6 }).map((_, i) => {
                  const ch = otpInput[i] ?? ''
                  const active = otpFocused && (i === otpInput.length || (i === 5 && otpInput.length === 6))
                  return (
                    <span
                      key={i}
                      className={cx(
                        'h-14 rounded-xl border-2 bg-white flex items-center justify-center font-mono text-2xl font-bold text-gray-900',
                        verifyError ? 'border-red-300' : active ? 'border-blue-600 ring-4 ring-blue-100' : ch ? 'border-gray-300' : 'border-gray-200',
                      )}
                    >
                      {ch}
                    </span>
                  )
                })}
              </div>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpInput}
                onChange={(e) => { setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6)); setVerifyError(null) }}
                onFocus={() => setOtpFocused(true)}
                onBlur={() => setOtpFocused(false)}
                placeholder="6-digit code"
                aria-label="Delivery code"
                className="absolute inset-0 w-full h-full opacity-0 cursor-text"
              />
            </div>

            {verifyError && (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-px" />
                <p className="text-sm font-medium text-red-700">{verifyError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={verifying || otpInput.length !== 6}
              className={cx(BTN_PRIMARY, THUMB)}
            >
              {verifying && <span className={SPIN_DARK} />}
              {verifying ? 'Confirming…' : 'Confirm delivery'}
            </button>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleCancelAwaiting}
                disabled={sending || verifying}
                className={cx(BTN_SECONDARY, 'h-12! w-full')}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleResend}
                disabled={sending || verifying}
                className="inline-flex items-center justify-center gap-2 h-12 w-full rounded-xl border border-blue-200 bg-white text-blue-600 hover:bg-blue-50 text-sm font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                {sending && <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />}
                {sending ? 'Sending…' : 'Resend code'}
              </button>
            </div>
            <p className="text-xs text-gray-500 text-center border-t border-gray-100 pt-3">
              Or the receiver enters it on their phone to close it.
            </p>
          </form>
        </Card>
      )}

      {/* Fuel estimate + on-demand pumps. Each card owns its loading/empty/error; nothing
          here can blank the trip controls above. */}
      <MapBoundary fallback={insightsFallback}>
        <TripFuelAndPumps bookingId={booking.id} />
      </MapBoundary>

      {/* Delivery evidence + assert/discrepancy (Phase 3b). Complements the OTP flow above:
          the OTP is the confirmed tier; this captures the photo evidence and owns the
          no-confirmation (asserted) branch. Its own card — it never blanks the controls above. */}
      <DeliveryEvidence booking={booking} currentPos={selfPos} onChanged={onRefresh} />
    </div>
  )
}

// ── Delivery asserted: awaiting ops confirmation ──────────────
//
// The driver reported the delivery without a receiver-confirmed code (migration 0025).
// The evidence card carries the awaiting-confirmation banner, shows the captured photos,
// and still lets the driver add a photo or log a discrepancy if ops asks — the backend
// keeps evidence capturable in this state. No GPS watch runs here, so the evidence card
// takes its own one-shot fix at capture (currentPos is null).

function AssertedTripSection({ booking, onRefresh }: { booking: Booking; onRefresh: () => void }) {
  return <DeliveryEvidence booking={booking} currentPos={null} onChanged={onRefresh} />
}
