'use client'

/**
 * My Trips (drive surface — Phase 3 of docs/UNIFIED_APP_PLAN.md).
 *
 * The trips assigned to this human to DRIVE. GET /bookings returns the caller's own
 * bookings, and each row carries a `viewer` block naming the caller's relations to it —
 * so this keeps only the ones where they are the driver or the carrier (the party who
 * moves the load), and only while the trip is live enough to act on
 * (accepted → in_transit → completed → delivery_asserted). Loads they merely POSTED
 * (relation 'shipper') stay on My Loads; the open board they could bid on never matches.
 *
 * Layout (2026-10 light redesign): greeting, any fleet invitation, a highlighted
 * "Today" card for the active trip, then Upcoming and Completed — all split client-side
 * from the one trips list.
 *
 * Three states, all rendered — never a blank screen:
 *  - LOADING → a spinner with a label.
 *  - ERROR   → an ErrorNote with a retry.
 *  - EMPTY   → "No trips assigned yet" with a short explanation of where trips come from.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, ChevronRight, Clock, KeyRound, PlayCircle, Truck } from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import FleetInvites from '@/components/fleet-invites'
import { Card, Empty, ErrorNote, Loading } from '@/components/stat'
import { CopyId, RouteRail, cityOf, loadTypeLabel, tonnes } from '@/components/driver/trip-bits'
import { ApiError, getTrack, listBookings } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { inr, shortDate } from '@/lib/format'
import { bookingStatusConfig } from '@/lib/status'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'
import type { Booking, BookingStatus, TrackData } from '@/lib/types'
import RouteMap from '@/components/maps/RouteMap'
import { isLatLng } from '@/lib/maps'

// A trip is "mine to drive" while it is live enough to act on. `paid` and `cancelled`
// are terminal for the driver, so they drop off the working list.
const DRIVABLE_STATUSES: BookingStatus[] = ['accepted', 'in_transit', 'completed', 'delivery_asserted']

// I'm the party moving this load if the server says my relation is 'driver' (I'm the
// assigned driver) or 'carrier' (I won it as the carrier). Either is enough; the
// relation block is the intended signal and correctly excludes loads I only posted.
function isMineToDrive(b: Booking): boolean {
  const rel = b.viewer?.relations ?? []
  return (rel.includes('driver') || rel.includes('carrier')) && DRIVABLE_STATUSES.includes(b.status)
}

const PAGE = 'p-4 lg:p-8 max-w-3xl mx-auto'

export default function MyTripsPage() {
  const { user } = useAuth()
  const [trips, setTrips] = useState<Booking[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const retry = useCallback(() => {
    setLoading(true)
    setError(null)
    setTrips(null)
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false

    listBookings()
      .then((all) => {
        if (cancelled) return
        setTrips(all.filter(isMineToDrive))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your trips.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [nonce])

  const firstName = user?.full_name?.trim().split(/\s+/)[0]

  const header = (
    <>
      <PageHeader title="My Trips" />
      <div className="-mt-3 mb-5">
        <p className="text-xl font-bold text-gray-900">{firstName ? `Namaste, ${firstName}` : 'Namaste'}</p>
        <p className="text-[0.9375rem] text-gray-500 mt-0.5">Trips assigned to you to drive.</p>
      </div>
    </>
  )

  if (loading && !trips) {
    return (
      <div className={PAGE}>
        {header}
        <Loading label="Loading your trips" />
      </div>
    )
  }

  if (error && !trips) {
    return (
      <div className={PAGE}>
        {header}
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={retry} className={BTN_SECONDARY}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const items = trips ?? []

  // Split the one list client-side. The active trip is the one on the road; failing
  // that, the next accepted trip whose pickup is today.
  const byPickup = (a: Booking, b: Booking) => a.pickup_date.localeCompare(b.pickup_date)
  const inTransit = items.filter((b) => b.status === 'in_transit').sort(byPickup)
  const accepted = items.filter((b) => b.status === 'accepted').sort(byPickup)
  const todayIso = new Date().toISOString().slice(0, 10)
  const active: Booking | null =
    inTransit[0] ?? accepted.find((b) => b.pickup_date.slice(0, 10) === todayIso) ?? null
  const upcoming = [...inTransit, ...accepted].filter((b) => b.id !== active?.id)
  const completed = items
    .filter((b) => b.status === 'completed' || b.status === 'delivery_asserted')
    .sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at))

  return (
    <div className={PAGE}>
      {header}

      <div className="mb-2 empty:hidden"><FleetInvites /></div>

      {items.length === 0 ? (
        <Card>
          <Empty
            icon={<Truck />}
            art title="No trips assigned yet"
            hint="Won or assigned trips appear here. Check Find Work to bid."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {active && (
            <section aria-labelledby="today-h">
              <SectionHead id="today-h" title="Today" right={todayLabel()} />
              <TodayCard booking={active} />
            </section>
          )}

          {upcoming.length > 0 && (
            <section aria-labelledby="upcoming-h">
              <SectionHead id="upcoming-h" title="Upcoming" right={countLabel(upcoming.length)} />
              <div className="space-y-2.5">
                {upcoming.map((b) => <UpcomingRow key={b.id} booking={b} />)}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section aria-labelledby="completed-h">
              <SectionHead id="completed-h" title="Completed" right={countLabel(completed.length)} />
              <Card className="divide-y divide-gray-100 overflow-hidden">
                {completed.map((b) => <CompletedRow key={b.id} booking={b} />)}
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
}

function countLabel(n: number): string {
  return `${n} ${n === 1 ? 'trip' : 'trips'}`
}

function SectionHead({ id, title, right }: { id: string; title: string; right?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <h2 id={id} className="text-lg font-bold text-gray-900">{title}</h2>
      {right && <span className="text-sm text-gray-500">{right}</span>}
    </div>
  )
}

function StatusPill({ status }: { status: BookingStatus }) {
  const cfg = bookingStatusConfig[status] ?? bookingStatusConfig.pending
  return <span className={cfg.color}>{cfg.label}</span>
}

/** The hint chips under a trip: what the driver does next. */
function HintChip({ status }: { status: BookingStatus }) {
  if (status === 'accepted') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-[0.8125rem] font-semibold text-blue-700">
        <PlayCircle className="w-4 h-4" /> Ready to start
      </span>
    )
  }
  if (status === 'in_transit') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[0.8125rem] font-semibold text-amber-800">
        <KeyRound className="w-4 h-4" /> Needs delivery code to close
      </span>
    )
  }
  return null
}

// ── Today ─────────────────────────────────────────────────────

function TodayCard({ booking }: { booking: Booking }) {
  // Live ETA for the trip on the road — one best-effort read, never polled here. A
  // failure or a null ETA simply leaves the line out.
  // The same read also gives the road route and the truck's last fix for the card's map.
  const [eta, setEta] = useState<string | null>(null)
  const [track, setTrack] = useState<TrackData | null>(null)
  useEffect(() => {
    if (booking.status !== 'in_transit') return
    let cancelled = false
    getTrack(booking.id)
      .then((t) => {
        if (cancelled) return
        setTrack(t)
        if (t?.eta && !t.eta.stale) setEta(t.eta.eta_text)
      })
      .catch(() => { /* silent — the card reads fine without an ETA */ })
    return () => { cancelled = true }
  }, [booking.id, booking.status])

  const origin = { lat: booking.source_lat, lng: booking.source_lng }
  const dest = { lat: booking.dest_lat, lng: booking.dest_lng }
  const fix = track?.location ? { lat: track.location.lat, lng: track.location.lng } : null

  return (
    <Card className="p-4 sm:p-5 border-brand-300 ring-1 ring-brand-200 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      {isLatLng(origin) && isLatLng(dest) && (
        <RouteMap
          origin={origin}
          dest={dest}
          originLabel={cityOf(booking.source_address)}
          destLabel={cityOf(booking.destination_address)}
          encodedPolyline={track?.route.polyline}
          trucks={isLatLng(fix) ? [{ id: 'me', position: fix, tone: 'moving', title: 'Your truck' }] : []}
          padding={40}
          className="-mx-4 -mt-4 mb-4 sm:-mx-5 sm:-mt-5 h-40 sm:h-48 rounded-t-xl border-b border-brand-200"
        />
      )}
      <div className="flex gap-3.5">
        <RouteRail className="py-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-lg font-bold text-gray-900 leading-snug min-w-0">
              {cityOf(booking.source_address)}
              <ArrowRight className="inline w-4 h-4 mx-1.5 -mt-0.5 text-gray-400" aria-label="to" />
              {cityOf(booking.destination_address)}
            </p>
            <StatusPill status={booking.status} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3">
            <CopyId id={booking.id} />
            {eta && (
              <span className="inline-flex items-center gap-1 text-sm text-gray-600">
                <Clock className="w-4 h-4 text-gray-400" /> ETA {eta}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-gray-600">
            {booking.consignee?.name
              ? <>Delivering to <span className="font-semibold text-gray-900">{booking.consignee.name}</span></>
              : <>Delivering to <span className="font-semibold text-gray-900">{booking.destination_address}</span></>}
          </p>
          <p className="mt-1.5 flex items-center gap-2 text-sm text-gray-600">
            <Truck className="w-4 h-4 text-gray-400 shrink-0" />
            <span>{tonnes(booking.weight_kg)}</span>
            <span className="text-gray-300">·</span>
            <span>{loadTypeLabel(booking.load_type)}</span>
            <span className="text-gray-300">·</span>
            <span>Pickup {shortDate(booking.pickup_date)}</span>
          </p>
        </div>
      </div>
      <Link href={`/my-trips/${booking.id}`} className={cx(BTN_PRIMARY, 'mt-4 h-14! w-full text-base!')}>
        Open trip
      </Link>
    </Card>
  )
}

// ── Upcoming ──────────────────────────────────────────────────

function UpcomingRow({ booking }: { booking: Booking }) {
  return (
    <div className="relative bg-white rounded-xl border border-gray-200 p-4 hover:border-gray-300 transition-colors">
      {/* Stretched link: the whole row opens the trip; the copy button sits above it. */}
      <Link
        href={`/my-trips/${booking.id}`}
        aria-label={`Open trip ${cityOf(booking.source_address)} to ${cityOf(booking.destination_address)}`}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      />
      <div className="flex gap-3">
        <span className="w-11 h-11 rounded-xl bg-gray-100 text-gray-500 flex items-center justify-center shrink-0">
          <Truck className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-base font-bold text-gray-900 leading-snug min-w-0">
              {cityOf(booking.source_address)}
              <ArrowRight className="inline w-4 h-4 mx-1 -mt-0.5 text-gray-400" aria-label="to" />
              {cityOf(booking.destination_address)}
            </p>
            <span className="flex items-center gap-1 shrink-0">
              <StatusPill status={booking.status} />
              <ChevronRight className="w-5 h-5 text-gray-400" />
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <CopyId id={booking.id} size="sm" />
            <span className="text-sm text-gray-500 pr-6">
              {tonnes(booking.weight_kg)} · {loadTypeLabel(booking.load_type)}
            </span>
          </div>
          <p className="text-sm text-gray-500">
            Pickup {shortDate(booking.pickup_date)}
            {booking.pickup_time_slot ? ` · ${booking.pickup_time_slot}` : ''}
          </p>
          <div className="mt-2"><HintChip status={booking.status} /></div>
        </div>
      </div>
    </div>
  )
}

// ── Completed ─────────────────────────────────────────────────

function CompletedRow({ booking }: { booking: Booking }) {
  const asserted = booking.status === 'delivery_asserted'
  return (
    <Link
      href={`/my-trips/${booking.id}`}
      className="flex items-center gap-3 px-4 py-3.5 min-h-[64px] hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:bg-gray-50"
    >
      {asserted ? (
        <span className="w-10 h-10 rounded-full bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
          <Clock className="w-5 h-5" />
        </span>
      ) : (
        <span className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-5 h-5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="text-[0.9375rem] font-bold text-gray-900 leading-snug min-w-0 break-words">
            {cityOf(booking.source_address)}
            <ArrowRight className="inline w-4 h-4 mx-1 -mt-0.5 text-gray-400" aria-label="to" />
            {cityOf(booking.destination_address)}
          </span>
          {/* The API strips the money for an employed driver, so guard the read. */}
          {booking.final_price != null && (
            <span className="shrink-0 text-[0.9375rem] font-bold text-gray-900 tabular-nums">{inr(booking.final_price)}</span>
          )}
        </span>
        <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm text-gray-500">
          <span>
            <span className="font-mono tracking-wide">{booking.id}</span>
            <span className="text-gray-300"> · </span>
            {shortDate(booking.completed_at ?? booking.updated_at)}
          </span>
          <span className={cx('text-xs font-semibold', asserted ? 'text-orange-700' : 'text-amber-700')}>
            {asserted ? bookingStatusConfig.delivery_asserted.label : 'Awaiting payment'}
          </span>
        </span>
      </span>
      <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
    </Link>
  )
}
