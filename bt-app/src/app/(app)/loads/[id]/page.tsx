'use client'

/**
 * Load detail (ship surface — Phase 2 of docs/UNIFIED_APP_PLAN.md).
 *
 * Ported from shipper/src/app/bookings/[id]/page.tsx into bt-app's light house
 * style. The booking summary + consignee + receiver-email editor, the live-tracking
 * map, and the bids panel each fetch and render independently, so a failure in one
 * never blanks the others and NO sub-view can render blank:
 *
 *  - Booking (primary): Loading → NotFound(Empty) → Error(retry) → the record.
 *  - Tracking: the map ALWAYS draws pickup + drop from the booking's own coords, so
 *    it is never blank; the caption reflects loading / live / stale / delivered /
 *    error. Before a carrier is booked it shows a "tracking starts in transit" note
 *    instead of the map.
 *  - Bids (auction only): Loading → Empty("no bids yet") → Error → the list, with
 *    accept / counter / reject when the load is still open.
 *
 * Layout (2026-10 redesign): a header plus four tabs — Overview, Bids, Documents,
 * Payment. Every panel stays MOUNTED and inactive ones are only hidden, so each keeps
 * its own fetches and polls exactly as when they were stacked on one page. Tabs that
 * do not apply are not offered (Bids only on an auction, Documents not on a cancelled
 * load, Payment only to the payer once delivered). `?tab=bids` etc. opens a tab.
 */

import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft, Building2, Check, ChevronRight, Copy, MessagesSquare, Phone, Timer, UserRound, X,
} from 'lucide-react'

import { Card, CardHead, Empty, ErrorNote, Loading } from '@/components/stat'
import { cityOf } from '@/components/shipper/route-text'
import {
  ApiError,
  acceptQuote,
  cancelBooking,
  counterQuote,
  getBooking,
  getQuotes,
  getTrack,
  rejectQuote,
} from '@/lib/api'
import { bookingStatusConfig, quoteStatusConfig } from '@/lib/status'
import { dateTime, inr, shortDate } from '@/lib/format'
import { BTN_DANGER, BTN_SECONDARY, MONO, TAB_OFF, TAB_ON, cx } from '@/lib/ui'
import type { Booking, Quote, TrackData, TrackEta, TrackLocation } from '@/lib/types'
import LiveTrackMap from '@/components/maps/LiveTrackMap'
import RouteMap from '@/components/maps/RouteMap'
import { isLatLng } from '@/lib/maps'
import { ReceiverEmailSection } from '@/components/receiver-email-section'
import FreightDocuments from '@/components/freight-documents'
import PaymentSection from '@/components/payment-section'
import { NegotiationHistory } from '@/components/negotiation-history'
import { CounterModal } from '@/components/counter-modal'

const TRACKED_STATUSES = ['accepted', 'in_transit', 'delivery_asserted', 'completed', 'paid']

type TabKey = 'overview' | 'bids' | 'documents' | 'payment'
const TAB_KEYS: TabKey[] = ['overview', 'bids', 'documents', 'payment']

/** The tab named by `?tab=` on first load — a deep-link convenience; defaults to Overview. */
function initialTab(): TabKey {
  if (typeof window === 'undefined') return 'overview'
  const t = new URLSearchParams(window.location.search).get('tab') as TabKey | null
  return t && TAB_KEYS.includes(t) ? t : 'overview'
}

export default function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [cancelling, setCancelling] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const [tab, setTab] = useState<TabKey>(initialTab)
  const [bidCount, setBidCount] = useState<number | null>(null)

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
        else setError(err instanceof ApiError ? err.message : 'Could not load this load.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, nonce])

  const backLink = (
    <Link href="/loads" className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 mb-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
      <ArrowLeft className="w-4 h-4" /> My Loads
    </Link>
  )

  if (loading && !booking) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {backLink}
        <Loading label="Loading this load" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {backLink}
        <Card>
          <Empty title="Load not found" hint="It may have been removed, or you may not have access to it. Head back to My Loads." />
        </Card>
      </div>
    )
  }

  if (error && !booking) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {backLink}
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={reload} className={BTN_SECONDARY}>Try again</button>
        </div>
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {backLink}
        <Card><Empty title="Nothing to show" hint="The service returned no load." /></Card>
      </div>
    )
  }

  const status = bookingStatusConfig[booking.status] ?? bookingStatusConfig.pending
  // 'delivery_asserted' is a delivered-but-unconfirmed trip: only ops closure remains, so a shipper
  // Cancel here is not a valid action (the server refuses it) — hide it like the other post-pickup
  // states (review F2). Its predecessor in_transit is already excluded; this closes the gap.
  const canCancel = !['cancelled', 'completed', 'in_transit', 'delivery_asserted', 'paid'].includes(booking.status)
  const isTracked = TRACKED_STATUSES.includes(booking.status)
  const routeEnds = {
    origin: { lat: booking.source_lat, lng: booking.source_lng },
    dest: { lat: booking.dest_lat, lng: booking.dest_lng },
  }

  // Which tabs apply — the same rules that decided whether each section rendered before.
  const isShipper = booking.viewer?.relations?.includes('shipper') ?? false
  const tabs: { key: TabKey; label: string; count?: number | null }[] = [
    { key: 'overview', label: 'Overview' },
    ...(booking.booking_type === 'auction' ? [{ key: 'bids' as const, label: 'Bids', count: bidCount }] : []),
    ...(booking.status !== 'cancelled' ? [{ key: 'documents' as const, label: 'Documents' }] : []),
    ...(isShipper && (booking.status === 'completed' || booking.status === 'paid') ? [{ key: 'payment' as const, label: 'Payment' }] : []),
  ]
  const active: TabKey = tabs.some((t) => t.key === tab) ? tab : 'overview'

  async function copyId() {
    try {
      await navigator.clipboard.writeText(booking!.id)
      toast.success('Booking ID copied')
    } catch {
      toast.error('Could not copy — select the ID instead')
    }
  }

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      {backLink}

      {/* Header: route, booking id, status, cancel */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[1.625rem] lg:text-[1.875rem] leading-tight font-extrabold tracking-tight text-gray-900">
              {cityOf(booking.source_address)} <span className="text-gray-400 font-semibold">→</span> {cityOf(booking.destination_address)}
            </h1>
            <span className={cx(status.color, 'text-[0.8125rem] px-2.5 py-1')}>{status.label}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-gray-500 min-w-0">
            <span className={cx(MONO, 'break-all')}>{booking.id}</span>
            <button
              type="button"
              onClick={copyId}
              aria-label="Copy booking ID"
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
        </div>
        {canCancel && (
          <button onClick={() => setShowCancelConfirm(true)} className={cx(BTN_DANGER, 'shrink-0')}>
            Cancel load
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="-mx-4 px-4 lg:mx-0 lg:px-0 overflow-x-auto border-b border-gray-200 mb-5">
        <div role="tablist" aria-label="Load sections" className="flex gap-7 min-w-max">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={active === t.key}
              aria-controls={`panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className={cx(active === t.key ? TAB_ON : TAB_OFF, 'inline-flex items-center gap-2 whitespace-nowrap rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600')}
            >
              {t.label}
              {t.count != null && (
                <span className={cx(
                  'min-w-[22px] h-[22px] px-1.5 rounded-md text-xs font-semibold tabular-nums inline-flex items-center justify-center',
                  active === t.key ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600',
                )}>{t.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Overview */}
      <section id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" hidden={active !== 'overview'} className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-3 items-start">
          <Card className="lg:col-span-2">
            <CardHead title="Load summary" />
            <div className="p-5">
              <div className="grid sm:grid-cols-2 gap-6">
                <ol>
                  <RouteStop connector color="bg-emerald-500" label="Pickup" address={booking.source_address}
                    sub={`${shortDate(booking.pickup_date)}${booking.pickup_time_slot ? ` · ${booking.pickup_time_slot}` : ''}`} />
                  <RouteStop color="bg-red-500" label="Drop" address={booking.destination_address} />
                </ol>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5 text-sm">
                  <Detail label="Load type" value={booking.load_type.replace(/_/g, ' ')} capitalize />
                  <Detail label="Weight" value={`${booking.weight_kg.toLocaleString('en-IN')} kg`} />
                  <Detail label="Quoted price" value={inr(booking.quoted_price)} />
                  <Detail label="Booking type" value={booking.booking_type} capitalize />
                  <Detail label="Pickup date" value={shortDate(booking.pickup_date)} />
                  {booking.pickup_time_slot && <Detail label="Time slot" value={booking.pickup_time_slot} />}
                  {booking.final_price != null && <Detail label="Final price" value={inr(booking.final_price)} strong />}
                </dl>
              </div>

              {booking.special_instructions && (
                <div className="mt-5 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3">
                  <p className="text-xs font-semibold text-gray-500 mb-0.5">Special instructions</p>
                  <p className="text-sm text-gray-800">{booking.special_instructions}</p>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHead title="Consignee" sub="Receives the goods and the delivery code." />
            <div className="p-5">
              {booking.consignee && (booking.consignee.name || booking.consignee.phone) ? (
                <div className="flex items-start gap-3">
                  <span className="w-10 h-10 rounded-full bg-gray-100 text-gray-600 inline-flex items-center justify-center shrink-0">
                    <Building2 className="w-5 h-5" />
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-gray-900">{booking.consignee.name ?? 'Unnamed consignee'}</p>
                    {booking.consignee.city && <p className="text-gray-500">{booking.consignee.city}</p>}
                    {booking.consignee.phone && (
                      <a href={`tel:${booking.consignee.phone}`} className="mt-1 inline-flex items-center gap-1.5 font-semibold text-blue-600 hover:underline tabular-nums">
                        <Phone className="w-3.5 h-3.5" /> {booking.consignee.phone}
                      </a>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500">No consignee details on this load.</p>
              )}
              <ReceiverEmailSection booking={booking} onSaved={reload} />
            </div>
          </Card>
        </div>

        {/* Tracking */}
        {isTracked ? (
          <TripTrackingSection booking={booking} />
        ) : (
          <Card>
            <CardHead title={booking.status === 'cancelled' ? 'Tracking' : 'Route'} />
            <div className="p-5 space-y-3">
              {/* Before a carrier is booked there is no road route yet: the map shows pickup and
                  drop with a dashed straight line, so the load still reads at a glance. */}
              {booking.status !== 'cancelled' && isLatLng(routeEnds.origin) && isLatLng(routeEnds.dest) && (
                <RouteMap
                  origin={routeEnds.origin}
                  dest={routeEnds.dest}
                  originLabel={cityOf(booking.source_address)}
                  destLabel={cityOf(booking.destination_address)}
                  interactive
                  padding={56}
                  className="h-64 lg:h-80 w-full rounded-xl border border-gray-200"
                />
              )}
              <p className="text-sm text-gray-500">
                {booking.status === 'cancelled'
                  ? 'This load was cancelled — there is no trip to track.'
                  : 'Live tracking starts once the trip is in transit.'}
              </p>
            </div>
          </Card>
        )}
      </section>

      {/* Bids — auction only */}
      {booking.booking_type === 'auction' && (
        <section id="panel-bids" role="tabpanel" aria-labelledby="tab-bids" hidden={active !== 'bids'}>
          <QuotesPanel booking={booking} onBookingChanged={reload} onCount={setBidCount} />
        </section>
      )}

      {/* Freight documents (Phase 4): the shipper sees the LR the carrier raised and
          issues their own tax invoice, billed to the consignee. */}
      {booking.status !== 'cancelled' && (
        <section id="panel-documents" role="tabpanel" aria-labelledby="tab-documents" hidden={active !== 'documents'}>
          <FreightDocuments booking={booking} onChanged={reload} />
        </section>
      )}

      {/* Payment: the closing step — record the cash/UPI/direct settlement on a
          completed trip (shipper only). Renders nothing until then, then the receipt. */}
      <section id="panel-payment" role="tabpanel" aria-labelledby="tab-payment" hidden={active !== 'payment'}>
        <PaymentSection booking={booking} onChanged={reload} />
      </section>

      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setShowCancelConfirm(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="cancel-title" className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
            <h3 id="cancel-title" className="text-lg font-bold text-gray-900 mb-1.5">Cancel this load?</h3>
            <p className="text-sm text-gray-500 mb-6">This cannot be undone. Any pending bids are invalidated.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowCancelConfirm(false)} className={cx(BTN_SECONDARY, 'flex-1')}>
                Keep load
              </button>
              <button
                onClick={async () => {
                  setCancelling(true)
                  try {
                    await cancelBooking(booking.id)
                    toast.success('Load cancelled')
                    router.push('/loads')
                  } catch (err: unknown) {
                    toast.error(err instanceof ApiError ? err.message : 'Could not cancel the load')
                    setCancelling(false)
                    setShowCancelConfirm(false)
                  }
                }}
                disabled={cancelling}
                className="flex-1 inline-flex items-center justify-center h-10 px-4 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 text-[#fff] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                {cancelling ? 'Cancelling…' : 'Yes, cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RouteStop({ color, label, address, sub, connector }: { color: string; label: string; address: string; sub?: string; connector?: boolean }) {
  return (
    <li className={cx('relative flex items-start gap-3', connector && 'pb-5')}>
      {connector && <span className="absolute left-[7px] top-6 bottom-0 border-l-2 border-dashed border-gray-200" aria-hidden />}
      <span className={cx('relative z-10 mt-1 w-4 h-4 rounded-full ring-4 ring-white shrink-0', color)} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-500">{label}</p>
        <p className="text-sm font-medium text-gray-900">{address}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </li>
  )
}

// ── Trip tracking ─────────────────────────────────────────────

/**
 * A fleet wins the auction as a COMPANY; the truck and driver are paired to the trip
 * afterwards in bt-fleet-service. Until then driver_id is NULL, so an `accepted`
 * fleet booking means "carrier locked in", NOT "driver assigned".
 */
function isAwaitingFleetDriver(booking: Booking): boolean {
  return !!booking.fleet_owner_id && !booking.driver_id
}

const STALE_AFTER_MS = 30_000

function ageText(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

function TripTrackingSection({ booking }: { booking: Booking }) {
  const [track, setTrack] = useState<TrackData | null>(null)
  const [pollError, setPollError] = useState(false)

  // One read-through call (LOCKED D-8) gives location + route + ETA + status. Fetch
  // once for any tracked status (so the route/pins show even before the trip starts),
  // then keep the 10s live poll (D-10) only while moving.
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const t = await getTrack(booking.id)
        if (!cancelled) { setTrack(t); setPollError(false) }
      } catch {
        if (!cancelled) setPollError(true)
      }
    }
    poll()
    if (booking.status !== 'in_transit') return () => { cancelled = true }
    const interval = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [booking.id, booking.status])

  const origin = useMemo(() => ({ lat: booking.source_lat, lng: booking.source_lng }), [booking.source_lat, booking.source_lng])
  const dest = useMemo(() => ({ lat: booking.dest_lat, lng: booking.dest_lng }), [booking.dest_lat, booking.dest_lng])

  const location = track?.location ?? null
  const delivered = booking.status === 'completed' || booking.status === 'paid'
  const ageMs = location ? Date.now() - new Date(location.updated_at).getTime() : Infinity
  const fresh = ageMs <= STALE_AFTER_MS
  const driverPt = !delivered && location ? { lat: location.lat, lng: location.lng } : null

  const steps = [
    { key: 'accepted', label: isAwaitingFleetDriver(booking) ? 'Carrier booked' : 'Driver assigned' },
    { key: 'in_transit', label: 'In transit' },
    { key: 'completed', label: 'Delivered' },
    { key: 'paid', label: 'Paid' },
  ]
  const currentIndex = steps.findIndex((s) => s.key === booking.status)

  return (
    <Card>
      <CardHead title="Trip status" />
      <div className="p-5 space-y-5">
        {/* Progress steps */}
        <ol className="flex items-start">
          {steps.map((step, i) => {
            const done = i <= currentIndex
            const current = i === currentIndex
            return (
              <li key={step.key} className="flex-1 flex flex-col items-center text-center relative">
                {i > 0 && (
                  <span className={cx('absolute right-1/2 top-[13px] w-full h-0.5', i <= currentIndex ? 'bg-emerald-500' : 'bg-gray-200')} aria-hidden />
                )}
                <span className={cx(
                  'relative z-10 w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-bold',
                  done ? 'bg-emerald-500 text-[#fff]' : 'bg-white border-2 border-gray-200 text-gray-400',
                  current && 'ring-4 ring-emerald-100',
                )}>
                  {done ? <Check className="w-4 h-4" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cx('mt-2 text-xs sm:text-sm', done ? 'text-gray-900 font-semibold' : 'text-gray-400')}>{step.label}</span>
              </li>
            )
          })}
        </ol>

        {/* The map always draws pickup + drop from the booking's own coords, so it is
            never blank even when there is no live fix or the track call failed. */}
        <LiveTrackMap
          origin={origin}
          dest={dest}
          encodedPolyline={track?.route.polyline}
          bounds={track?.route.bounds}
          driver={driverPt}
          className="h-72 lg:h-[380px] w-full rounded-xl overflow-hidden border border-gray-200"
        />

        <TrackCaption
          status={booking.status}
          delivered={delivered}
          awaitingFleetDriver={isAwaitingFleetDriver(booking)}
          completedAt={booking.completed_at}
          location={location}
          eta={track?.eta ?? null}
          fresh={fresh}
          ageMs={ageMs}
          pollError={pollError}
        />
      </div>
    </Card>
  )
}

function etaSuffix(eta: TrackEta | null): string {
  if (!eta) return ''
  return ` · ETA ${eta.eta_text}${eta.stale ? ' (est.)' : ''}`
}

function TrackCaption({
  status, delivered, awaitingFleetDriver, completedAt, location, eta, fresh, ageMs, pollError,
}: {
  status: Booking['status']
  delivered: boolean
  awaitingFleetDriver: boolean
  completedAt: string | null
  location: TrackLocation | null
  eta: TrackEta | null
  fresh: boolean
  ageMs: number
  pollError: boolean
}) {
  if (delivered) {
    return (
      <p className="text-sm font-semibold text-emerald-700 inline-flex items-center gap-1.5">
        <Check className="w-4 h-4" /> Delivered{completedAt ? ` · ${dateTime(completedAt)}` : ''}
      </p>
    )
  }

  if (!location) {
    return (
      <p className="text-sm text-gray-500">
        {pollError
          ? 'Could not fetch live tracking — retrying…'
          : awaitingFleetDriver
            ? 'Carrier booked — waiting for the fleet to assign a truck and driver.'
            : status === 'accepted'
              ? 'Driver assigned — waiting for the trip to start.'
              : 'Waiting for the driver to start sharing location…'}
      </p>
    )
  }

  if (fresh) {
    return (
      <p className="text-sm text-gray-700 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" />
        {`Live · updated ${ageText(ageMs)}${location.speed_kmh !== null ? ` · ${Math.round(location.speed_kmh)} km/h` : ''}${etaSuffix(eta)}`}
      </p>
    )
  }

  return (
    <p className="text-sm text-amber-700 flex items-center gap-2">
      <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
      {`Driver offline — last seen ${ageText(ageMs)}${etaSuffix(eta)}`}
    </p>
  )
}

// ── Bids panel ────────────────────────────────────────────────

/** "5h 20m" until the auction deadline; null when there is none or it has passed. */
function closesIn(deadline: string | null, now: number): string | null {
  if (!deadline) return null
  const ms = new Date(deadline).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

function QuotesPanel({
  booking, onBookingChanged, onCount,
}: { booking: Booking; onBookingChanged: () => void; onCount?: (n: number | null) => void }) {
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [counterQuoteId, setCounterQuoteId] = useState<string | null>(null)
  const [expandedQuote, setExpandedQuote] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const historyRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setError(null); setQuotes(null) }
    try {
      const q = await getQuotes(booking.id)
      setQuotes(q)
      setError(null)
    } catch (err: unknown) {
      if (!opts?.silent) setError(err instanceof ApiError ? err.message : 'Could not load bids.')
    }
  }, [booking.id])

  useEffect(() => { load() }, [load])

  // The tab label shows the count once known.
  useEffect(() => { onCount?.(quotes ? quotes.length : null) }, [quotes, onCount])

  // Auto-refresh while the load is still open, so new bids appear without a reload.
  const pollable = booking.status === 'pending'
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!pollable) return
    const interval = setInterval(() => loadRef.current({ silent: true }), 15_000)
    return () => clearInterval(interval)
  }, [pollable])

  // The "closes in" countdown ticks once a minute.
  useEffect(() => {
    if (!booking.auction_deadline) return
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [booking.auction_deadline])

  async function act(fn: () => Promise<unknown>, okMsg: string) {
    setActionError(null)
    try {
      await fn()
      toast.success(okMsg)
      onBookingChanged()
      load({ silent: true })
    } catch (err: unknown) {
      setActionError(err instanceof ApiError ? err.message : 'That action could not be completed.')
    }
  }

  function toggleHistory(id: string) {
    setExpandedQuote((cur) => (cur === id ? null : id))
    // On a phone the history panel sits below the list — bring it into view.
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setTimeout(() => historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    }
  }

  const openForBids = booking.status === 'pending' || booking.status === 'negotiating'
  const estimate = booking.quoted_price
  const sorted = useMemo(() => (quotes ? [...quotes].sort((a, b) => a.amount - b.amount) : null), [quotes])
  const live = sorted?.filter((q) => q.status === 'submitted' || q.status === 'countered') ?? []
  const lowest = live.length ? live[0].amount : null
  const closes = closesIn(booking.auction_deadline, now)
  const expanded = sorted?.find((q) => q.id === expandedQuote) ?? null

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <div className="min-w-0 space-y-4">
        {/* Estimate · lowest bid · closes in */}
        <Card className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1.6fr] divide-x divide-gray-100">
          <div className="p-4 sm:px-5">
            <p className="text-sm text-gray-500">Your estimate</p>
            <p className="mt-1 text-[1.375rem] sm:text-2xl font-bold text-gray-900 tabular-nums">{inr(estimate)}</p>
          </div>
          <div className="p-4 sm:px-5">
            <p className="text-sm text-gray-500">Lowest bid</p>
            <p className={cx('mt-1 text-[1.375rem] sm:text-2xl font-bold tabular-nums', lowest != null ? 'text-emerald-600' : 'text-gray-400')}>
              {lowest != null ? inr(lowest) : '—'}
            </p>
          </div>
          <div className="col-span-2 sm:col-span-1 p-4 sm:px-5 border-t sm:border-t-0 border-gray-100 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm text-gray-500 inline-flex items-center gap-1.5"><Timer className="w-4 h-4" /> Bids close in</p>
              <p className="mt-1 text-[1.375rem] sm:text-2xl font-bold text-gray-900 tabular-nums">
                {closes ?? (booking.auction_deadline ? 'Closed' : 'No deadline')}
              </p>
            </div>
            {pollable && (
              <p className="text-xs text-gray-500 inline-flex items-center gap-1.5 pb-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-emerald-700">Live</span> Auto-refreshing every 15s
              </p>
            )}
          </div>
        </Card>

        {sorted && sorted.length > 0 && <BidSpread quotes={sorted} estimate={estimate} />}

        {actionError && <ErrorNote message={actionError} />}

        {error && !quotes ? (
          <Card className="p-4 space-y-3">
            <ErrorNote message={error} />
            <button onClick={() => load()} className={BTN_SECONDARY}>Try again</button>
          </Card>
        ) : !sorted ? (
          <Card><Loading label="Loading bids" /></Card>
        ) : sorted.length === 0 ? (
          <Card>
            <Empty
              title="No bids yet"
              hint={openForBids ? 'Carriers will appear here as they bid on your load.' : 'This load received no bids.'}
            />
          </Card>
        ) : (
          <div>
            <p className="mb-2.5 text-sm">
              <span className="text-base font-bold text-gray-900">{sorted.length} {sorted.length === 1 ? 'bid' : 'bids'}</span>
              <span className="ml-2 text-gray-500">Sorted by lowest amount</span>
            </p>
            <div className="space-y-2.5">
              {sorted.map((quote, i) => (
                <QuoteRow
                  key={quote.id}
                  rank={i + 1}
                  quote={quote}
                  estimate={estimate}
                  actionable={openForBids && (quote.status === 'submitted' || quote.status === 'countered')}
                  expanded={expandedQuote === quote.id}
                  onToggle={() => toggleHistory(quote.id)}
                  onAccept={() => act(() => acceptQuote(booking.id, quote.id), 'Bid accepted')}
                  onReject={() => act(() => rejectQuote(booking.id, quote.id), 'Bid rejected')}
                  onCounter={() => setCounterQuoteId(quote.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Negotiation history for the selected bid */}
      <div ref={historyRef} className="lg:sticky lg:top-6 scroll-mt-20">
        <Card>
          <CardHead
            title="Negotiation history"
            sub={expanded ? (expanded.carrier?.name ?? carrierFallbackName(expanded)) : undefined}
            actions={expanded ? (
              <button
                onClick={() => setExpandedQuote(null)}
                aria-label="Close negotiation history"
                className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <X className="w-4 h-4" />
              </button>
            ) : undefined}
          />
          <div className="p-4">
            {expanded ? (
              <NegotiationHistory bookingId={booking.id} quoteId={expanded.id} />
            ) : (
              <div className="text-center py-6 px-2">
                <span className="w-10 h-10 rounded-xl bg-gray-100 text-gray-400 inline-flex items-center justify-center mb-2">
                  <MessagesSquare className="w-5 h-5" />
                </span>
                <p className="text-sm text-gray-500">Open a bid to see every offer and counter on it.</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {counterQuoteId && (
        <CounterModal
          onClose={() => setCounterQuoteId(null)}
          onSubmit={async (amount, message) => {
            await counterQuote(booking.id, counterQuoteId, { amount, message })
            toast.success('Counter offer sent')
            onBookingChanged()
            load({ silent: true })
          }}
        />
      )}
    </div>
  )
}

/** Compact rupees for chart labels: ₹46.2K. */
function kInr(n: number): string {
  return n >= 1000 ? `₹${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K` : `₹${n}`
}

/**
 * Where every bid lands against your estimate, on one axis. Drawn only from the bids
 * already loaded; withdrawn / expired / rejected bids are greyed.
 */
function BidSpread({ quotes, estimate }: { quotes: Quote[]; estimate: number }) {
  const amounts = quotes.map((q) => q.amount)
  const lo = Math.min(estimate, ...amounts)
  const hi = Math.max(estimate, ...amounts)
  const pad = Math.max((hi - lo) * 0.15, 1000)
  // A round tick step (₹500 / 1K / 2K / 2.5K / 5K …) so the axis reads cleanly.
  const step = [500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000].find((s) => s >= (hi - lo + 2 * pad) / 6) ?? 100000
  const min = Math.floor((lo - pad) / step) * step
  const max = Math.ceil((hi + pad) / step) * step
  const x = (v: number) => ((v - min) / (max - min || 1)) * 100
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step)
  const liveIds = new Set(quotes.filter((q) => q.status === 'submitted' || q.status === 'countered').map((q) => q.id))
  const lowestLive = quotes.find((q) => liveIds.has(q.id)) ?? null

  return (
    <Card className="px-5 pt-4 pb-3">
      <p className="sr-only">
        Bid spread: your estimate {inr(estimate)}; bids {quotes.map((q) => inr(q.amount)).join(', ')}.
      </p>
      <div className="relative h-[124px] mx-3" aria-hidden>
        {/* estimate marker */}
        <div className="absolute top-0 h-[74px] flex flex-col items-center -translate-x-1/2" style={{ left: `${x(estimate)}%` }}>
          <span className="text-xs font-bold text-blue-600 tabular-nums">{inr(estimate)}</span>
          <span className="flex-1 border-l-2 border-dashed border-blue-500 mt-1" />
        </div>
        {/* axis */}
        <div className="absolute left-0 right-0 top-[66px] h-px bg-gray-200" />
        {quotes.map((q, i) => {
          const isLive = liveIds.has(q.id)
          const isLowest = lowestLive?.id === q.id
          return (
            <div key={q.id} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${x(q.amount)}%`, top: i % 2 === 0 ? 30 : 18 }}>
              <span className={cx('text-[0.6875rem] font-semibold tabular-nums whitespace-nowrap', isLowest ? 'text-emerald-600' : isLive ? 'text-gray-700' : 'text-gray-400')}>
                {inr(q.amount)}
              </span>
              <span className="w-px bg-gray-200" style={{ height: i % 2 === 0 ? 4 : 16 }} />
              <span className={cx(
                'w-3.5 h-3.5 rounded-full ring-[3px] ring-white',
                isLowest ? 'bg-emerald-500' : isLive ? 'bg-blue-600' : 'bg-gray-300',
              )} />
            </div>
          )
        })}
        {/* captions */}
        {lowestLive && (
          <span className="absolute top-[78px] -translate-x-1/2 text-[0.6875rem] font-semibold text-emerald-600 whitespace-nowrap" style={{ left: `${x(lowestLive.amount)}%` }}>
            Lowest bid
          </span>
        )}
        <span className="absolute top-[78px] -translate-x-1/2 text-[0.6875rem] font-semibold text-blue-600 whitespace-nowrap" style={{ left: `${x(estimate)}%` }}>
          Your estimate
        </span>
        {/* ticks */}
        {ticks.map((t) => (
          <span key={t} className="absolute bottom-0 -translate-x-1/2 text-[0.6875rem] text-gray-400 tabular-nums" style={{ left: `${x(t)}%` }}>
            {kInr(t)}
          </span>
        ))}
      </div>
    </Card>
  )
}

/** Compact in-row button (the shared BTN_* are 40px; bid rows use 36px like the reference). */
const BTN_SM =
  'inline-flex items-center justify-center h-9 px-4 rounded-lg text-sm font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1'

function QuoteRow({
  rank, quote, estimate, actionable, expanded, onToggle, onAccept, onReject, onCounter,
}: {
  rank: number
  quote: Quote
  estimate: number
  actionable: boolean
  expanded: boolean
  onToggle: () => void
  onAccept: () => void
  onReject: () => void
  onCounter: () => void
}) {
  const qs = quoteStatusConfig[quote.status] ?? quoteStatusConfig.submitted
  const kind = carrierKind(quote)
  const delta = quote.amount - estimate
  const live = quote.status === 'submitted' || quote.status === 'countered'

  const amount = (
    <div>
      <p className="text-lg font-bold text-gray-900 tabular-nums leading-tight">{inr(quote.amount)}</p>
      <p className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
        <span className={cx('font-semibold', delta < 0 ? 'text-emerald-600' : delta > 0 ? 'text-red-600' : 'text-gray-600')}>
          {delta === 0 ? 'Same' : `${delta < 0 ? '−' : '+'}${inr(Math.abs(delta))}`}
        </span>{' '}
        vs your estimate
      </p>
    </div>
  )
  const statusBlock = (
    <div>
      <span className={qs.color}>{quote.status === 'accepted' ? 'Awarded ✓' : qs.label}</span>
      <p className="mt-1 text-xs text-gray-500 whitespace-nowrap">{dateTime(quote.submitted_at)}</p>
    </div>
  )
  const actions = (cls: string) => actionable && (
    <div className={cls}>
      <button onClick={onAccept} className={cx(BTN_SM, 'bg-brand-500 hover:bg-brand-400 text-ink')}>Accept</button>
      <button onClick={onCounter} className={cx(BTN_SM, 'bg-white border border-blue-200 text-blue-700 hover:bg-blue-50')}>Counter</button>
      <button onClick={onReject} className={cx(BTN_SM, 'bg-white border border-red-200 text-red-600 hover:bg-red-50')}>Reject</button>
    </div>
  )

  return (
    <div className={cx('bg-white rounded-xl border transition-colors p-4', expanded ? 'border-blue-300 ring-1 ring-blue-100' : 'border-gray-200')}>
      <div className="flex items-center gap-3">
        <span className={cx(
          'w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-bold shrink-0',
          rank === 1 && live ? 'bg-brand-500 text-ink' : 'bg-gray-100 text-gray-500',
        )}>{rank}</span>
        <span className="hidden sm:inline-flex w-9 h-9 rounded-lg bg-gray-50 border border-gray-100 text-gray-500 items-center justify-center shrink-0">
          {kind === 'driver' ? <UserRound className="w-4.5 h-4.5" /> : <Building2 className="w-4.5 h-4.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <CarrierName quote={quote} />
            <span className="inline-flex items-center whitespace-nowrap rounded-md bg-gray-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-600">
              {carrierKindLabel(quote)}
            </span>
          </div>
          <CarrierDetail quote={quote} />
        </div>
        <div className="hidden sm:block w-36 shrink-0">{amount}</div>
        <div className="hidden sm:block w-28 shrink-0">{statusBlock}</div>
        {actions('hidden 2xl:flex gap-2 shrink-0')}
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'View'} negotiation history`}
          title="Negotiation history"
          className={cx(
            'p-2 -mr-1 rounded-lg hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 shrink-0',
            expanded ? 'text-blue-600' : 'text-gray-400 hover:text-gray-700',
          )}
        >
          <ChevronRight className={cx('w-5 h-5 transition-transform max-lg:rotate-90', expanded && 'max-lg:-rotate-90')} />
        </button>
      </div>

      <div className="sm:hidden mt-3 pl-10 flex items-end justify-between gap-3">
        {amount}
        <div className="text-right">{statusBlock}</div>
      </div>
      {actions('2xl:hidden mt-3 grid grid-cols-3 gap-2 sm:flex sm:justify-end')}
    </div>
  )
}

// A bid comes from EITHER a solo driver OR a fleet owner, and the quote row names
// only the one it came from. Prefer the server-resolved `carrier`; fall back to the
// id columns when it is absent — guessing "Driver" for a fleet bid is wrong.
function carrierKind(quote: Quote): 'driver' | 'fleet' | null {
  if (quote.carrier) return quote.carrier.kind
  if (quote.fleet_owner_id) return 'fleet'
  if (quote.driver_id) return 'driver'
  return null
}

function carrierKindLabel(quote: Quote): string {
  const kind = carrierKind(quote)
  return kind === 'fleet' ? 'Fleet operator' : kind === 'driver' ? 'Independent driver' : 'Carrier'
}

function carrierFallbackName(quote: Quote): string {
  const kind = carrierKind(quote)
  return kind === 'fleet' ? 'Fleet operator' : kind === 'driver' ? 'Independent driver' : 'Unknown carrier'
}

function CarrierName({ quote }: { quote: Quote }) {
  const carrier = quote.carrier
  return (
    <span className={cx('text-[0.9375rem] text-gray-900', carrier?.name ? 'font-bold' : 'italic')}>
      {carrier?.name ?? carrierFallbackName(quote)}
    </span>
  )
}

function CarrierDetail({ quote }: { quote: Quote }): ReactNode {
  const carrier = quote.carrier
  if (carrier?.kind !== 'driver') return null
  const parts = [
    carrier.truck_number ? <span key="t" className={MONO}>{carrier.truck_number}</span> : null,
    carrier.total_trips ? `${carrier.total_trips} trips` : null,
    carrier.average_rating ? `${carrier.average_rating.toFixed(1)}★` : null,
  ].filter(Boolean)
  if (parts.length === 0) return null
  return (
    <p className="mt-0.5 text-xs text-gray-500 flex flex-wrap items-center gap-x-1.5">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300" aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </p>
  )
}

function Detail({ label, value, capitalize, strong }: { label: string; value: string; capitalize?: boolean; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={cx('mt-0.5 text-gray-900', strong ? 'font-bold' : 'font-medium', capitalize && 'capitalize')}>{value}</dd>
    </div>
  )
}
