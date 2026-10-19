'use client'

// The owner's morning screen.
//
// Reading order follows the hierarchy the product owner set (2026-10-05) — the page is
// read in four passes, and the layout puts each pass where the eye lands in that order:
//
//   5 sec   how is the fleet doing?        -> three headline tiles with a delta
//   10 sec  is anything going wrong?       -> Needs attention, full width, severity-sorted
//   20 sec  which truck/trip is causing it? -> live map, utilisation, EMI table, recent trips
//   then    what should I do?              -> the action on each exception row
//
// Exceptions therefore outrank every chart on this page. The EMI-shortfall table used to
// be the hero; it is now one of the 20-second answers, reached from the alert that names it.
//
// Six calls, all period-scoped except the live map and the fleet overview. Nothing polls.
// Two of the six are allowed to fail without blanking the page (see loadSoft below): the
// tracking overview and the fuel comparison only ADD alerts, so a 503 on either costs an
// alert row, not the dashboard.
//
// Only real data is drawn. There are no sparklines, because nothing server-side returns a
// per-day series — the deltas are a second summary call for the preceding window.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ArrowRight, BarChart3, Bell, CheckCircle2, ClipboardCheck, Fuel, Gavel, Gauge,
  FileWarning, IndianRupee, Map as MapIcon, MapPin, PackagePlus, Radio, Route, TrendingUp, Truck,
  UserPlus, Users, Wallet,
} from 'lucide-react'

import { Card, CardHead, CoverPill, Empty, ErrorNote, IconTile, InfoDot, Loading, Meter } from '@/components/stat'
import { PhotoHero } from '@/components/photo-hero'
import { useAuth } from '@/lib/auth'
import RouteMap from '@/components/maps/RouteMap'
import { HeadlineTile, MiniStat } from '@/components/fleet-core/kpi'
import { ProfitByDriver, ProfitByTruck, RevenueTrend, revenueSeries } from '@/components/fleet-core/charts'
import { BTN_PRIMARY, BTN_SECONDARY, LINK, MONO, PAGE_WIDE, cx, type Tint } from '@/lib/ui'
import { cityOf } from '@/components/driver/trip-bits'
import { bookingStatusConfig } from '@/lib/status'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  ApiError,
  getFleetOverview,
  getFleetSummary,
  getDriverAnalytics,
  getFuelComparison,
  getLivePositions,
  getVehicleAnalytics,
  getMySummary,
  listFleetBookings,
  listMyBids,
} from '@/lib/api'
import { DrivingPanel, ShipmentsPanel, TruckPanel } from '@/components/persona-panels'
import { inr, inrCompact, inrSigned, km, pct, periodDays, shortDate, tons } from '@/lib/format'
import type {
  CostBreakdown, FleetBooking, FleetOverview, FleetSummary, FuelComparison, LivePosition,
  TrackedAlert, VehicleAnalytics, DriverAnalytics, FleetBid, BookingStatus, MeSummary,
} from '@/lib/types'

const PERIOD_OPTIONS = [30, 90, 180] as const
type PeriodChoice = (typeof PERIOD_OPTIONS)[number]

/**
 * The window of equal length immediately BEFORE the current one, so "last 30 days" is
 * compared against the 30 days before that.
 *
 * The delta is computed in the browser from a second summary call on purpose:
 * `FleetSummary` carries no `previous` block, and adding one to bt-fleet-service would
 * not reach this app — it runs against the LIVE gateway, so a new server field shows
 * nothing until it is deployed. A server-side `previous` is still the better long-term
 * home for this (noted in the task MD); until then one extra call buys real numbers.
 */
function previousPeriodDays(days: number): { from: string; to: string } {
  const to = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

/**
 * Percentage change, or null when the comparison would mislead rather than inform.
 *
 * Null in four cases, all of which a naive `(a-b)/b` would render as something confident and
 * wrong: either side missing or NaN (a service that answered partially), a zero baseline
 * (every change from zero is infinite), and a baseline so small that the percentage explodes —
 * ₹400 to ₹40,000 is a true "+9,900%" and a useless thing to put in a tile. The caller shows
 * no chip at all rather than a number the owner would have to discount.
 */
const MIN_BASELINE_INR = 1000

function changePct(now: number, before: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null
  if (Math.abs(before) < MIN_BASELINE_INR) return null
  const pct = ((now - before) / Math.abs(before)) * 100
  return Number.isFinite(pct) ? pct : null
}

/**
 * Money delivered but not yet collected.
 *
 * The page shows what the fleet EARNED and never what it has actually been PAID, which for an
 * Indian fleet owner is the gap that ends businesses — a profitable quarter with ninety days of
 * receivables is still a fleet that cannot buy diesel. A trip counts as owed once the goods are
 * delivered (`completed` / `delivery_asserted`) and the booking has not reached `paid`.
 */
const DELIVERED_UNPAID: ReadonlySet<BookingStatus> = new Set(['completed', 'delivery_asserted'])

function unpaidSummary(bookings: FleetBooking[]) {
  const owed = bookings.filter(b => DELIVERED_UNPAID.has(b.status))
  const amount = owed.reduce((sum, b) => {
    const value = b.final_price ?? b.quoted_price ?? 0
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)
  const ages = owed
    .map(b => Date.parse(b.pickup_date ?? b.created_at ?? ''))
    .filter(Number.isFinite)
    .map(t => Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)))
  return { count: owed.length, amount, oldestDays: ages.length ? Math.max(...ages) : 0 }
}

/**
 * Registration certificates about to lapse, read off the fleet overview that is already fetched.
 *
 * An expired RC grounds a truck at the first checkpost, which costs far more than the renewal.
 * Permits (`VehiclePermit.expiry_date`) and driving licences (`DriverLicense.expiry_date`) carry
 * the same risk and the same shaped field, but both are per-entity reads today — surfacing them
 * here would mean one call per truck and per driver, so they want a fleet-scoped endpoint first.
 */
const RC_WARN_DAYS = 45

function expiringRcs(overview: FleetOverview | null) {
  const out: { rc: string; days: number }[] = []
  for (const v of overview?.vehicles ?? []) {
    const when = Date.parse(v.rc_expiry ?? '')
    if (!Number.isFinite(when)) continue
    const days = Math.ceil((when - Date.now()) / (24 * 60 * 60 * 1000))
    if (days <= RC_WARN_DAYS) out.push({ rc: v.rc_number ?? 'Unnamed truck', days })
  }
  return out.sort((a, b) => a.days - b.days)
}

/**
 * Revenue share by shipper — concentration is a risk an owner should be able to see.
 *
 * Scoped to the selected window, which is NOT free: `listFleetBookings()` returns every booking
 * this fleet has ever had, with no period filter, so a naive sum here would quietly report
 * all-time shares under a card that sits beneath a 30/90/180-day switch. Every other number on
 * this page moves when that switch moves, and this one has to as well.
 */
function shipperShares(bookings: FleetBooking[], days: number) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const totals = new Map<string, number>()
  for (const b of bookings) {
    if (!EARNED_STATUSES.has(b.status)) continue
    const when = Date.parse(b.pickup_date ?? b.created_at ?? '')
    if (!Number.isFinite(when) || when < since) continue
    const value = b.final_price ?? b.quoted_price ?? 0
    if (!Number.isFinite(value)) continue
    const name = b.shipper_name?.trim() || 'Unknown shipper'
    totals.set(name, (totals.get(name) ?? 0) + value)
  }
  const grand = [...totals.values()].reduce((a, b) => a + b, 0)
  const rows = [...totals.entries()]
    .map(([name, value]) => ({ name, value, pct: grand > 0 ? (value / grand) * 100 : 0 }))
    .sort((a, b) => b.value - a.value)
  return { rows, grand }
}

// Paid only — the same definition the Revenue tile uses (trip_economics is written at 'paid'),
// so a shipper's share is never computed over money the tile does not yet count. See the note
// on EARNED in components/fleet-core/charts.tsx.
const EARNED_STATUSES: ReadonlySet<BookingStatus> = new Set(['paid'])

/**
 * Alert severity, borrowed verbatim from `TrackedAlert.severity` so a locally-derived
 * alert and one the tracking service computed rank on the same scale.
 */
type Severity = TrackedAlert['severity']

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

/** The row's left rail and icon tint for each severity. Never colour alone — the title says it too. */
const SEVERITY_STYLE: Record<Severity, { rail: string; tint: Tint }> = {
  critical: { rail: 'border-l-red-500', tint: 'red' },
  warning: { rail: 'border-l-amber-500', tint: 'amber' },
  info: { rail: 'border-l-blue-400', tint: 'blue' },
}

// ── Estimates notice ──────────────────────────────────────────
//
// Shown every time the dashboard is opened (2026-10-02, product owner's request; it
// was once per browser session before): every figure here is modelled from historic
// trip data and cost norms, not read off a meter, and may differ from actual values.
function EstimatesNotice({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md bg-white border border-gray-200">
        <DialogHeader>
          <DialogTitle>These figures are estimates</DialogTitle>
          <DialogDescription>
            All estimations on this dashboard are based on historic trip data and standard cost norms.
            They are not exact figures and may differ from actual values.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1.5">
          <li>Fuel, tyres, service and other running costs are modelled per km for each truck category, not metered.</li>
          <li>Revenue, tolls and driver wages come from the trips recorded on BharatTruck.</li>
          <li>Numbers get closer to actuals as more trips and your own cost inputs are recorded.</li>
        </ul>
        <DialogFooter>
          <button type="button" onClick={onClose} className="rounded-xl bg-brand-500 hover:bg-brand-400 text-ink text-sm font-semibold px-4 py-2.5">
            I understand
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Wire-shape tolerance ──────────────────────────────────────
//
// Two places where lib/types.ts and bt-fleet-service disagree today. Both are
// read defensively rather than "fixed" here, because the foundation files are
// not this page's to edit and a mismatch must not blank the dashboard.

/**
 * lib/api.ts types GET /fleet/live as LivePosition[], but the route
 * (bt-fleet-service/src/routes/assignment.ts) sends an envelope:
 * { driver_count, online_count, on_trip_count, positions: [...] }. Accept either.
 */
function positionsOf(res: unknown): LivePosition[] {
  if (Array.isArray(res)) return res as LivePosition[]
  if (res && typeof res === 'object' && 'positions' in res) {
    const inner = (res as { positions: unknown }).positions
    if (Array.isArray(inner)) return inner as LivePosition[]
  }
  return []
}

/**
 * A driver counts as "on the road" only with a real fix. GET /fleet/live sends is_online plus
 * lat/lng that go null once the 30s Redis TTL lapses (offline, not lost) — a finite lat/lng is
 * exactly an online fix.
 */
function hasFix(p: LivePosition): boolean {
  return p.is_online && Number.isFinite(p.lat) && Number.isFinite(p.lng)
}

/**
 * lib/types.ts declares CostBreakdown with `_inr`-suffixed keys; the service's
 * costBreakdown() (bt-fleet-service/src/lib/analytics.ts) emits bare keys
 * (`fuel`, `tyres`, `driver_wage`, …). Read both so no slice is ever NaN-wide.
 */
function costAmount(breakdown: CostBreakdown, typedKey: string, wireKey: string): number {
  const record: Record<string, unknown> = breakdown
  const value = record[typedKey] ?? record[wireKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Ordered so the dominant slice leads and the bar reads left-to-right by size
// for a typical fleet. Fuel gets the strongest colour on purpose.
const COST_SLICES: { typedKey: string; wireKey: string; label: string; color: string; css: string }[] = [
  { typedKey: 'fuel_inr',        wireKey: 'fuel',        label: 'Fuel',        color: 'bg-brand-500', css: 'var(--color-brand-500)' },
  { typedKey: 'driver_wage_inr', wireKey: 'driver_wage', label: 'Driver wage', color: 'bg-blue-300', css: 'var(--color-blue-300)' },
  { typedKey: 'toll_inr',        wireKey: 'toll',        label: 'Toll',        color: 'bg-blue-600', css: 'var(--color-blue-600)' },
  { typedKey: 'tyre_inr',        wireKey: 'tyres',       label: 'Tyres',       color: 'bg-teal-500', css: 'var(--color-teal-500)' },
  { typedKey: 'service_inr',     wireKey: 'service',     label: 'Service',     color: 'bg-violet-500', css: 'var(--color-violet-500)' },
  { typedKey: 'def_inr',         wireKey: 'def',         label: 'DEF',         color: 'bg-violet-300', css: 'var(--color-violet-300)' },
  { typedKey: 'engine_oil_inr',  wireKey: 'engine_oil',  label: 'Engine oil',  color: 'bg-pink-400', css: 'var(--color-pink-400)' },
  { typedKey: 'gear_oil_inr',    wireKey: 'gear_oil',    label: 'Gear oil',    color: 'bg-pink-200', css: 'var(--color-pink-200)' },
  { typedKey: 'other_inr',       wireKey: 'other',       label: 'Other',       color: 'bg-gray-400', css: 'var(--color-gray-400)' },
]

const PAGE = PAGE_WIDE

/** `MeSummary.degraded_sections` names, as the person knows them. */
const SECTION_LABEL: Record<string, string> = {
  alerts: 'open alert counts',
  driving: 'My driving',
  truck: 'My truck',
  shipments: 'My shipments',
}

/**
 * One dashboard per person, assembled from what they own and do (GET /me/summary) — never a
 * persona switch (D-3). The fleet panel is the dashboard below, unchanged; the others are the
 * driving / truck / shipments panels. Fleet renders first when present because it carries the
 * page hero and period switch; the rest follow in the server's front-door order (D-32).
 */
export default function DashboardPage() {
  const { capabilities, personas } = useAuth()
  const [summary, setSummary] = useState<MeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMySummary()
      .then((s) => { if (!cancelled) setSummary(s) })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your dashboard')
      })
    return () => { cancelled = true }
  }, [])

  // The fleet panel can start loading before the summary answers: the same rule the nav uses
  // (operate, or a declared fleet profile — the bootstrap exception).
  const fleetCapable = !!capabilities?.includes('operate') || !!personas?.fleet_owner_id
  const showFleet = summary ? summary.panels.includes('fleet') : fleetCapable
  const others = (summary?.panels ?? []).filter((p) => p !== 'fleet')

  // A section the server could not read is named, in the panel's own words, not hidden.
  const unavailable = (summary?.degraded_sections ?? []).map((s) => SECTION_LABEL[s] ?? s)
  const partialNote = unavailable.length > 0 && (
    <p className="text-sm text-gray-500">Could not load just now: {unavailable.join(', ')}.</p>
  )

  const panels = (
    <div className="space-y-10">
      {others.map((p) => {
        if (p === 'driving' && summary?.driving) return <DrivingPanel key={p} data={summary.driving} />
        if (p === 'truck' && summary?.truck) return <TruckPanel key={p} data={summary.truck} />
        if (p === 'shipments' && summary?.shipments) return <ShipmentsPanel key={p} data={summary.shipments} />
        return null
      })}
    </div>
  )

  if (showFleet) {
    return (
      <>
        <FleetDashboard />
        {others.length > 0 && <div className={cx(PAGE, 'pt-0 lg:pt-0')}>{panels}</div>}
        {/* The fleet half is whole on its own; say so only if the rest could not load. */}
        {(error || partialNote) && (
          <div className={cx(PAGE, 'pt-0 lg:pt-0')}>
            {error ? <p className="text-sm text-gray-500">Your trips and shipments could not load just now: {error}</p> : partialNote}
          </div>
        )}
      </>
    )
  }

  return (
    <div className={PAGE}>
      <PhotoHero size="md" subtitle="How your month is going — the parts of BharatTruck you use." />
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
      {!summary && !error && <Loading label="Loading your dashboard" />}
      {summary && others.length === 0 && unavailable.length === 0 && (
        <Card>
          <Empty art title="Your dashboard fills in as you use BharatTruck"
            hint="Post a load, take a trip or add a truck — each one adds its own panel here."
            action={<Link href="/post" className={cx(BTN_PRIMARY, '[&_svg]:w-4 [&_svg]:h-4')}><PackagePlus />Post a load</Link>} />
        </Card>
      )}
      {summary && others.length > 0 && panels}
      {partialNote && <div className="mt-6">{partialNote}</div>}
    </div>
  )
}

function FleetDashboard() {
  const [days, setDays] = useState<PeriodChoice>(30)
  const [summary, setSummary] = useState<FleetSummary | null>(null)
  // The preceding window of equal length — the only source of the headline deltas.
  const [previous, setPrevious] = useState<FleetSummary | null>(null)
  const [vehicles, setVehicles] = useState<VehicleAnalytics[]>([])
  const [live, setLive] = useState<LivePosition[]>([])
  const [bookings, setBookings] = useState<FleetBooking[]>([])
  // Alert sources. Both are optional: they add exception rows and must never blank the page.
  const [overview, setOverview] = useState<FleetOverview | null>(null)
  const [fuel, setFuel] = useState<FuelComparison | null>(null)
  const [drivers, setDrivers] = useState<DriverAnalytics[]>([])
  const [bids, setBids] = useState<FleetBid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noticeOpen, setNoticeOpen] = useState(false)
  // One notice per visit to the dashboard; a period switch re-runs the load but must not re-open it.
  const noticeShownRef = useRef(false)

  // The effect only kicks the requests off; every setState happens in a
  // callback. Flipping `loading`/`error` synchronously here would trip
  // react-hooks/set-state-in-effect, so the period buttons own that transition.
  useEffect(() => {
    let cancelled = false
    const period = periodDays(days)

    // An alert source that 503s costs one alert row, not the dashboard — so these
    // resolve to null instead of rejecting the Promise.all the page depends on.
    const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

    Promise.all([
      getFleetSummary(period),
      getVehicleAnalytics(period),
      getLivePositions(),
      // Every status: the page shows the latest trips and counts the ones waiting on the owner.
      listFleetBookings(),
      // One Redis-backed call, no Google call — the service's own note says a poll is safe,
      // and this page does not even poll. Carries the off-route / idle alerts.
      soft(getFleetOverview()),
      soft(getFuelComparison(period)),
      // Deployed and typed since the fleet console, and never rendered anywhere until now.
      soft(getDriverAnalytics(period)),
      // Tenant-scoped, one call: /fleet/bookings cannot answer this because
      // bookings.fleet_owner_id is written only on ACCEPT, so it can only ever show bids
      // already won — the lost and live ones live on quotes.fleet_owner_id.
      soft(listMyBids()),
    ])
      .then(([summaryData, vehicleData, liveData, bookingData, overviewData, fuelData, driverData, bidData]) => {
        if (cancelled) return
        setSummary(summaryData)
        setVehicles(vehicleData?.vehicles ?? [])
        setLive(positionsOf(liveData))
        setBookings(bookingData ?? [])
        setOverview(overviewData)
        setFuel(fuelData)
        setDrivers(driverData?.drivers ?? [])
        setBids(bidData?.bids ?? [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load the dashboard')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        // Shown every time the dashboard is opened, once the first load settles (success or
        // not) — not on period switches. It used to show once per browser session and only
        // after a fully successful load, so most visits never saw it.
        if (!noticeShownRef.current) {
          noticeShownRef.current = true
          setNoticeOpen(true)
        }
      })

    // The comparison window rides OUTSIDE the Promise.all above on purpose. It feeds only the
    // three delta chips, so making first paint wait on it would hold the whole dashboard for a
    // number that is decoration on an otherwise complete page. The tiles render without a
    // delta and gain one when it lands — which is also exactly how they behave when the call
    // fails, so there is one code path, not two.
    //
    // Clearing the stale baseline belongs to the period buttons, not here, for the same reason
    // `loading` and `error` do (see the note above the effect): a synchronous setState in an
    // effect trips react-hooks/set-state-in-effect.
    getFleetSummary(previousPeriodDays(days))
      .then(prev => { if (!cancelled) setPrevious(prev) })
      .catch(() => { /* no baseline → no delta chip; never an error on screen for this */ })

    return () => { cancelled = true }
  }, [days])

  const switcher = (
    <div className="flex w-full sm:w-auto sm:inline-flex rounded-xl border border-white/70 bg-white/95 p-1 gap-1 shadow-[0_4px_14px_rgba(20,24,31,0.12)]" role="group" aria-label="Reporting period">
      {PERIOD_OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          onClick={() => {
            if (option === days) return
            setLoading(true)
            setError(null)
            // Drop the old window's baseline, or 90d would briefly wear 30d's delta.
            setPrevious(null)
            setDays(option)
          }}
          aria-pressed={days === option}
          className={cx(
            'rounded-lg px-3.5 py-1.5 text-sm',
            days === option ? 'font-bold bg-brand-500 text-ink' : 'font-medium text-gray-700 hover:bg-white',
            'flex-1 sm:flex-none sm:min-w-[64px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
          )}
        >
          {option}d
        </button>
      ))}
    </div>
  )

  const header = (
    <>
      <Hero days={days} switcher={switcher} />
      <EstimatesNotice open={noticeOpen} onClose={() => setNoticeOpen(false)} />
    </>
  )

  // First load: nothing to show behind the spinner yet.
  if (loading && !summary) {
    return (
      <div className={PAGE}>
        {header}
        <Loading label="Pulling the fleet's numbers" />
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div className={PAGE}>
        {header}
        <ErrorNote message={error} />
      </div>
    )
  }

  if (!summary) {
    return (
      <div className={PAGE}>
        {header}
        <Card>
          <Empty
            icon={<Truck />}
            title="No fleet data yet"
            hint="Add a truck to start seeing numbers here."
            action={<Link href="/vehicles" className={BTN_PRIMARY}>Add a truck</Link>}
          />
        </Card>
      </div>
    )
  }

  const { score, utilization } = summary
  const recent = [...bookings]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 6)
  const trucksTotal = summary.active_vehicles
  const clearing = summary.vehicles_covering_emi
  const emiTone = trucksTotal === 0
    ? 'neutral'
    : clearing * 2 > trucksTotal ? 'good' : 'warn'

  // The operational half of the 5-second question: of the trucks on the books, how many
  // actually earned this period. Deliberately NOT EMI coverage — that is an exception and
  // belongs in the attention list, not in a headline tile.
  const earning = vehicles.filter(v => v.trips > 0).length
  const earningTone = trucksTotal === 0
    ? 'neutral'
    : earning === trucksTotal ? 'good'
    : earning * 2 > trucksTotal ? 'neutral'
    : 'warn'

  // Null whenever the preceding window is missing or had nothing to divide by, and the
  // tile then simply shows no delta rather than a fabricated 0%.
  const revenueDelta = previous ? changePct(score.revenue_inr, previous.score.revenue_inr) : null
  const profitDelta = previous ? changePct(score.surplus_inr, previous.score.surplus_inr) : null

  return (
    <div className={PAGE}>
      {header}

      {/* A refetch that failed keeps the previous period on screen rather than
          throwing the owner back to an empty page. */}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {/* ── 5 SECONDS — how is the fleet doing? ──────────────────────────────
            Three tiles, not six. Net profit leads because it is the bottom line; the
            other three numbers that used to sit here are one tier down, in the strip
            immediately below, where they read as supporting detail rather than as
            headlines competing with the profit figure. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 lg:gap-4">
          {/* The TRUE bottom line: revenue − running cost − tolls/other actuals − EMI & fixed.
              summary.net_profit_inr is Σ per-trip (revenue − running) — the same number as
              the gross margin shown under Revenue — and must not be headlined as net profit. */}
          <HeadlineTile
            label="Net profit"
            value={inrCompact(score.surplus_inr)}
            tone={score.surplus_inr >= 0 ? 'good' : 'bad'}
            delta={profitDelta}
            sub={`after ${inrCompact(score.toll_other_inr)} tolls & other, ${inrCompact(score.fixed_cost_inr)} EMI & fixed`}
            icon={<BarChart3 />}
            tint={score.surplus_inr >= 0 ? 'green' : 'red'}
          />
          <HeadlineTile
            label="Revenue"
            value={inrCompact(score.revenue_inr)}
            delta={revenueDelta}
            sub={`Gross margin ${inrCompact(score.gross_margin_inr)}`}
            icon={<IndianRupee />}
            tint="blue"
          />
          {/* No percentage under this one on purpose: on a two-truck fleet "100%" reads as
              a precision the sample does not support, which `low_sample` already concedes
              elsewhere on the page. The ratio itself is the honest form. */}
          <HeadlineTile
            label="Fleet earning"
            value={`${earning} / ${trucksTotal}`}
            tone={earningTone}
            sub={trucksTotal === 0
              ? 'No trucks on the books yet'
              : `${summary.trips} ${summary.trips === 1 ? 'trip' : 'trips'} · overhead ${inrCompact(summary.monthly_overhead_inr)}/mo`}
            icon={<Truck />}
            tint="brand"
            info="Trucks that ran at least one trip this period, out of the trucks active on your books."
          />
        </div>

        {/* The three numbers demoted from the headline row — present, deliberately quieter. */}
        <div className="mt-3 grid grid-cols-3 gap-3 lg:gap-4">
          <MiniStat label="Trips" value={summary.trips} sub={summary.trips > 0 ? `${inrCompact(score.revenue_inr / summary.trips)} avg` : 'None completed'} icon={<Route />} />
          <MiniStat label="Distance" value={km(utilization.distance_km)} sub={`${pct(utilization.distance_pct)} of expected`} icon={<MapPin />} />
          <MiniStat label="Clearing EMI" value={`${clearing} / ${trucksTotal}`} sub={`EMI ${inrCompact(score.emi_inr)}`} icon={<Wallet />} tone={emiTone} />
        </div>

        {/* ── 10 SECONDS — is anything going wrong? ────────────────────────────
            Full width and directly under the headline numbers. This is the single
            change the hierarchy most depended on: the exception list used to sit in a
            1fr sidebar in the third row, below a map and a shortcuts card, so the
            answer to "is anything wrong" arrived after the answer to "what shortcuts
            exist". Severity-sorted, so the worst thing is the first thing. */}
        <div className="mt-5">
          <NeedsAttention
            vehicles={vehicles}
            live={live}
            bookings={bookings}
            overview={overview}
            fuel={fuel}
            lowSample={summary.low_sample}
          />
        </div>

        {/* ── 20 SECONDS — which truck, trip or load is causing it? ────────────
            Everything below here is drill-down for an alert above, ordered truck → load →
            map. The Quick actions card that used to sit beside the map is gone: all six of
            its links are in the nav rail, four of them repeat the hero's buttons 200px
            higher, and it was occupying the slot this tier needs.

            The trend leads because it answers the half of "how is my fleet doing" that a
            single number cannot — direction. An owner who has just read "fuel is 14% over"
            asks next whether revenue is climbing or sliding. */}
        {/* Full width: six monthly points need the x-resolution, and the trend is the one
            thing here that is read left-to-right rather than scanned. */}
        <div className="mt-5">
          <Card className="flex flex-col">
            <CardHead
              icon={<TrendingUp />}
              tint="blue"
              title="Revenue over time"
              sub={`Completed trips, last ${days} days`}
              info="Each point sums the trips whose pickup date falls in that period."
            />
            <RevenueTrend points={revenueSeries(bookings, days)} />
          </Card>
        </div>

        {/* The same question asked of both halves of the fleet, side by side. */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card className="flex flex-col">
            <CardHead
              icon={<Truck />}
              tint="green"
              title="Profit by truck"
              sub="Best first, against each truck's EMI"
              info="Net profit after running costs, tolls, EMI and fixed charges."
            />
            <ProfitByTruck vehicles={vehicles} />
          </Card>
          <Card className="flex flex-col">
            <CardHead
              icon={<Users />}
              tint="violet"
              title="Profit by driver"
              sub="Best first, after each driver's allocated wage"
              info="The same trips, grouped by who drove them instead of what they drove."
            />
            <ProfitByDriver drivers={drivers} />
          </Card>
        </div>

        {/* Directly under the chart it belongs to: "Profit by truck" ranks the whole fleet,
            this names the trucks in the red half and says by how much, with the category,
            distance, gross margin and EMI behind each one. Overview then detail, adjacent —
            they were two rows apart, which made the table read as an unrelated fourth table
            rather than as the answer to the bar the owner had just looked at. */}
        <div className="mt-5">
          <ShortfallTable vehicles={vehicles} />
        </div>

        {/* Recent trips sits above the map rather than last. The map is the most duplicated
            surface on this page — two of the alerts above deep-link straight to /map and carry
            their own button — whereas this table is the only place on the dashboard that
            answers "which LOAD", and it needs the full width for its seven columns. */}
        <div className="mt-5">
          <RecentTrips bookings={recent} live={live} vehicles={vehicles} />
        </div>

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-5">
          <LiveFleet live={live} />
          <UtilisationRing utilization={utilization} />
        </div>

        {/* Where the work comes from — strategic rather than operational, so it reads last
            alongside the cost breakdown. */}
        <div className="mt-5">
          <WorkAndDemand bids={bids} bookings={bookings} days={days} />
        </div>

        {/* Where the money went — context, read last. */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <MoneySplit score={score} />
          <CostMix breakdown={summary.cost_breakdown_inr} />
        </div>
      </div>
    </div>
  )
}

// ── Greeting banner ───────────────────────────────────────────

const HERO_BTN = cx(BTN_SECONDARY, 'h-12 px-5 text-[0.9375rem] border-white bg-white shadow-[0_4px_14px_rgba(20,24,31,0.12)] [&_svg]:w-5 [&_svg]:h-5 [&_svg]:text-blue-600')

/**
 * The photo banner (shared with Home) with this page's quick actions and period switch.
 *
 * `size="md"` rather than Home's `"lg"`: this page's job is a five-second read, and the
 * tall banner pushed the three headline numbers under the fold on a laptop. The action
 * buttons stay — they are the only quick-action surface left now that the Quick actions
 * card is gone, and the nav rail carries the rest.
 */
function Hero({ days, switcher }: { days: number; switcher: ReactNode }) {
  const { capabilities } = useAuth()
  return (
    <PhotoHero size="md" subtitle={<>Your fleet over the last {days} days. Figures are estimates, not exact.</>} aside={switcher}>
      {capabilities?.includes('ship') && (
        <Link href="/post" className={cx(BTN_PRIMARY, 'h-12 px-5 text-[0.9375rem] shadow-[0_8px_20px_rgba(242,165,22,0.4)]')}>
          <PackagePlus className="w-5 h-5" /> Post a load
        </Link>
      )}
      <Link href="/auctions" className={HERO_BTN}><Gavel /> Find work</Link>
      <Link href="/map" className={HERO_BTN}><MapIcon /> Live fleet</Link>
      <Link href="/drivers" className={HERO_BTN}><UserPlus /> Add driver</Link>
    </PhotoHero>
  )
}

// ── Rings ─────────────────────────────────────────────────────

/** A ring chart drawn with a conic gradient; `children` sit in the hole. */
function Ring({ slices, size = 152, label, children }: {
  slices: { value: number; css: string }[]; size?: number; label: string; children?: ReactNode
}) {
  const total = slices.reduce((a, x) => a + x.value, 0)
  let at = 0
  const stops = slices.map(x => {
    const from = total > 0 ? (at / total) * 100 : 0
    at += x.value
    const to = total > 0 ? (at / total) * 100 : 0
    return `${x.css} ${from}% ${to}%`
  })
  return (
    <div
      role="img"
      aria-label={label}
      className="relative shrink-0 rounded-full"
      style={{ width: size, height: size, background: total > 0 ? `conic-gradient(${stops.join(', ')})` : 'var(--color-gray-100)' }}
    >
      <div className="absolute inset-[18%] rounded-full bg-white shadow-[inset_0_1px_4px_rgba(20,24,31,0.08)] flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  )
}

// ── Live fleet location ───────────────────────────────────────

function LiveFleet({ live }: { live: LivePosition[] }) {
  const reporting = live.filter(hasFix)
  const moving = reporting.filter(p => (p.speed_kmh ?? 0) > 3).length
  return (
    <Card className="flex flex-col">
      <CardHead
        icon={<MapPin />}
        tint="green"
        title="Live fleet location"
        // /fleet/live is one row per DRIVER (idle ones included), not per truck — so a fleet of
        // 2 trucks and 3 drivers used to read "0 of 3 tracked trucks". Name what is counted.
        sub={`${reporting.length} of ${live.length} ${live.length === 1 ? 'driver' : 'drivers'} reporting a live fix`}
        actions={
          <Link href="/map" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm py-1')}>
            <span className="hidden sm:inline">View on full map</span>
            <span className="sm:hidden">Map</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        }
      />
      <div className="p-4 flex-1 flex flex-col">
        {reporting.length > 0 ? (
          // Where the reporting trucks are right now — a still glance; Live Fleet has the detail.
          <RouteMap
            trucks={reporting.map(p => ({
              id: p.driver_id,
              position: { lat: p.lat as number, lng: p.lng as number },
              tone: (p.speed_kmh ?? 0) > 3 ? 'moving' : 'stopped',
              title: [p.rc_number, p.driver_name].filter(Boolean).join(' · ') || undefined,
            }))}
            padding={{ top: 56, right: 40, bottom: 36, left: 40 }}
            singleZoom={8}
            className="min-h-[240px] flex-1 rounded-xl border border-gray-200"
            fallback={<GpsCount n={reporting.length} />}
          >
            <div className="absolute left-2.5 top-2.5 inline-flex items-center gap-4 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-[0_1px_3px_rgba(20,24,31,0.15)]">
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden /> Moving <b className="tabular-nums text-gray-900">{moving}</b></span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" aria-hidden /> Stopped <b className="tabular-nums text-gray-900">{reporting.length - moving}</b></span>
            </div>
          </RouteMap>
        ) : (
          <GpsCount n={0} />
        )}
      </div>
    </Card>
  )
}

// ── Fleet utilisation ─────────────────────────────────────────

function UtilisationRing({ utilization }: { utilization: FleetSummary['utilization'] }) {
  const d = utilization.distance_pct
  const shown = d === null || Number.isNaN(d) ? null : Math.max(0, Math.min(100, d))
  const ringCss = shown === null ? 'var(--color-gray-200)'
    : shown >= 75 ? 'var(--color-emerald-500)' : shown >= 50 ? 'var(--color-blue-600)' : shown >= 30 ? 'var(--color-amber-500)' : 'var(--color-red-500)'
  const rows: { label: string; value: number | null; dot: string }[] = [
    { label: 'Distance', value: utilization.distance_pct, dot: 'bg-blue-600' },
    { label: 'Tonnage', value: utilization.tonnage_pct, dot: 'bg-brand-500' },
    { label: 'Volume', value: utilization.volume_pct, dot: 'bg-teal-500' },
  ]
  return (
    <Card className="flex flex-col">
      <CardHead
        icon={<Gauge />}
        tint="blue"
        title="Fleet utilisation"
        actions={<Link href="/analytics" className={cx(LINK, 'text-sm py-1')}>Details</Link>}
      />
      <div className="p-5 flex-1 flex flex-col items-center justify-center gap-5">
        <Ring
          label={shown === null ? 'Utilisation: not enough data' : `Distance utilisation ${pct(shown)}`}
          slices={shown === null ? [] : [{ value: shown, css: ringCss }, { value: 100 - shown, css: 'var(--color-gray-100)' }]}
        >
          <span className="text-[1.625rem] font-extrabold leading-none tabular-nums text-gray-900">{shown === null ? '—' : pct(shown)}</span>
          <span className="mt-1 text-xs text-gray-500">of expected</span>
        </Ring>
        <ul className="w-full space-y-2">
          {rows.map(r => (
            <li key={r.label} className="flex items-center gap-2.5 text-sm">
              <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', r.dot)} />
              <span className="text-gray-700">{r.label}</span>
              {/* An undeclared weight or volume is unknown, not zero. */}
              <span className="ml-auto font-semibold tabular-nums text-gray-900">{r.value === null || Number.isNaN(r.value) ? 'Not enough data' : pct(r.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

// ── Assets that did not cover their EMI ───────────────────────

function ShortfallTable({ vehicles }: { vehicles: VehicleAnalytics[] }) {
  // Worst first: the most negative surplus is the truck to deal with today.
  const short = vehicles
    .filter(v => v.score.covered === false)
    .sort((a, b) => a.score.surplus_inr - b.score.surplus_inr)

  const totalShortfall = short.reduce((sum, v) => sum + v.score.surplus_inr, 0)
  // Trucks that actually earned this period — the only ones an EMI verdict means anything for.
  const ran = vehicles.filter(v => v.trips > 0).length

  return (
    <Card>
      <CardHead
        icon={<AlertCircle />}
        tint={short.length > 0 ? 'red' : 'green'}
        title="Assets that did not cover their EMI"
        sub={
          vehicles.length === 0
            ? 'No trucks in this fleet yet'
            // A truck that ran nothing has a surplus of zero, and zero passes `covered`, so a
            // fleet with no trips at all used to be congratulated for clearing an EMI it never
            // faced. Found the first time this page met a real, idle fleet (2026-10-09): two
            // trucks, no trips, and the card said both had cleared. Silence is the honest
            // answer there, not praise.
            : ran === 0
              ? `No trips yet — nothing to settle against ${vehicles.length === 1 ? 'this truck' : 'these trucks'}`
            : short.length === 0
              ? `${ran === 1 ? 'The truck that ran' : `All ${ran} trucks that ran`} cleared running cost, tolls, fixed cost and EMI`
              : `${short.length} of ${vehicles.length} trucks — ${inr(Math.abs(totalShortfall))} short in total`
        }
        actions={
          <Link href="/vehicles" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm py-1')}>
            <span className="hidden sm:inline">View all trucks</span>
            <span className="sm:hidden">All trucks</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        }
      />

      {vehicles.length === 0 ? (
        <Empty
          icon={<Truck />}
          title="No trucks on the books"
          hint="Add a truck under Trucks to get started."
        />
      ) : ran === 0 ? (
        <Empty
          icon={<Route />}
          title="No truck has run a trip this period"
          hint="EMI cover is worked out from completed trips, so there is nothing to settle yet."
        />
      ) : short.length === 0 ? (
        <Empty title={`Every truck that ran cleared its EMI this period`} />
      ) : (
        <>
          {/* Phone: one compact row per truck. The full table scrolls sideways below 640px. */}
          <ul className="sm:hidden divide-y divide-gray-100">
            {short.map(v => (
              <li key={v.vehicle_id} className="px-4 py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/vehicles/${v.vehicle_id}`} className={cx(MONO, 'text-sm font-semibold text-blue-600 underline underline-offset-2')}>
                    {v.rc_number}
                  </Link>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{v.model_category ?? '—'}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold tabular-nums text-red-600">{inr(Math.abs(v.score.surplus_inr))}</p>
                  <p className="text-xs text-red-600">short</p>
                </div>
                <CoverPill covered={v.score.covered} />
              </li>
            ))}
          </ul>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="text-[0.8125rem] text-gray-500 border-b border-gray-100 bg-gray-50/60">
                  <th className="py-3 px-5 text-left font-medium">Truck</th>
                  <th className="py-3 px-4 text-left font-medium">Category</th>
                  <th className="py-3 px-4 text-right font-medium">Trips</th>
                  <th className="py-3 px-4 text-right font-medium">Distance</th>
                  <th className="py-3 px-4 text-right font-medium">Gross margin</th>
                  <th className="py-3 px-4 text-right font-medium">EMI</th>
                  <th className="py-3 px-4 text-right font-medium">Shortfall</th>
                  <th className="py-3 px-5 text-right font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {short.map(v => (
                  <tr key={v.vehicle_id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                    <td className="py-3.5 px-5 text-sm">
                      <Link
                        href={`/vehicles/${v.vehicle_id}`}
                        className={cx(MONO, 'font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300')}
                      >
                        {v.rc_number}
                      </Link>
                    </td>
                    <td className="py-3.5 px-4 text-sm text-gray-700">{v.model_category ?? '—'}</td>
                    <td className="py-3.5 px-4 text-sm text-right tabular-nums text-gray-900">{v.trips}</td>
                    <td className="py-3.5 px-4 text-sm text-right tabular-nums text-gray-700">
                      {km(v.utilization.distance_km)}
                    </td>
                    <td className={`py-3.5 px-4 text-sm text-right tabular-nums ${
                      v.score.gross_margin_inr < 0 ? 'text-red-600' : 'text-gray-900'
                    }`}>
                      {inr(v.score.gross_margin_inr)}
                    </td>
                    <td className="py-3.5 px-4 text-sm text-right tabular-nums text-gray-700">
                      {inr(v.score.emi_inr)}
                    </td>
                    <td className="py-3.5 px-4 text-sm text-right tabular-nums font-bold text-red-600">
                      {inrSigned(v.score.surplus_inr)}
                    </td>
                    <td className="py-3.5 px-5 text-sm text-right">
                      <CoverPill covered={v.score.covered} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

// ── Recent trips ──────────────────────────────────────────────

function RecentTrips({
  bookings, live, vehicles,
}: {
  bookings: FleetBooking[]
  live: LivePosition[]
  vehicles: VehicleAnalytics[]
}) {
  // The booking list may carry only ids, so the RC number and the driver's name are joined
  // from data already on this page: the analytics roster and the live-position roster.
  const rcByVehicle = new Map(vehicles.map(v => [v.vehicle_id, v.rc_number]))
  const nameByDriver = new Map(live.map(p => [p.driver_id, p.driver_name]))

  return (
    <Card className="flex flex-col">
      <CardHead
        icon={<Route />}
        tint="violet"
        title="Recent trips"
        sub={bookings.length === 0 ? 'No trips yet' : `Latest ${bookings.length} by booking date`}
        actions={
          <Link href="/trips" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm py-1')}>
            <span className="hidden sm:inline">View all trips</span>
            <span className="sm:hidden">Trips</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        }
      />
      {bookings.length === 0 ? (
        <Empty icon={<Route />} title="No trips yet" hint="Win a load under Find Work and it shows up here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="text-[0.8125rem] text-gray-500 border-b border-gray-100 bg-gray-50/60">
                <th className="py-2.5 px-5 text-left font-medium">Truck</th>
                <th className="py-2.5 px-3 text-left font-medium">Route</th>
                <th className="py-2.5 px-3 text-left font-medium">Driver</th>
                <th className="py-2.5 px-3 text-left font-medium">Load</th>
                <th className="py-2.5 px-3 text-right font-medium">Fare</th>
                <th className="py-2.5 px-3 text-left font-medium">Status</th>
                <th className="py-2.5 px-5 text-right font-medium">Pickup</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map(b => {
                const rc = b.vehicle?.rc_number ?? (b.vehicle_id ? rcByVehicle.get(b.vehicle_id) : null)
                const driverName = b.driver?.full_name ?? (b.driver_id ? nameByDriver.get(b.driver_id) : null)
                const status = bookingStatusConfig[b.status] ?? bookingStatusConfig.pending
                return (
                  <tr key={b.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-5 text-sm">
                      <span className="inline-flex items-center gap-2">
                        <Truck className="w-4 h-4 text-brand-500 shrink-0" aria-hidden />
                        <span className={cx(MONO, 'font-semibold text-gray-900')}>{rc ?? '—'}</span>
                      </span>
                    </td>
                    <td className="py-3 px-3 text-sm text-gray-900 whitespace-nowrap">
                      {cityOf(b.source_address)} <ArrowRight className="inline w-3.5 h-3.5 mx-0.5 text-gray-400" aria-label="to" /> {cityOf(b.destination_address)}
                    </td>
                    <td className="py-3 px-3 text-sm text-gray-700">{driverName ?? '—'}</td>
                    <td className="py-3 px-3 text-sm text-gray-600 tabular-nums">{tons(b.weight_kg)}</td>
                    <td className="py-3 px-3 text-sm text-right tabular-nums font-medium text-gray-900">{inr(b.final_price ?? b.quoted_price)}</td>
                    <td className="py-3 px-3 text-sm"><span className={status.color}>{status.label}</span></td>
                    <td className="py-3 px-5 text-sm text-right text-gray-600 whitespace-nowrap">{shortDate(b.pickup_date)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Needs attention ───────────────────────────────────────────

/** One exception. `severity` ranks it; everything else is how it renders. */
type Attention = {
  key: string
  severity: Severity
  icon: ReactNode
  title: string
  sub: string
  href: string
  cta: string
}

/**
 * The 10-second layer: everything wrong with the fleet right now, worst first.
 *
 * Two rules this list is built on.
 *
 * **Severity, not insertion order.** The list used to render in whatever order the code
 * happened to push the rows, so "few trips this period" could sit above a truck that had
 * gone dark. Every row now declares a `severity` and the list sorts on it, which is the
 * whole reason the owner can trust the first row.
 *
 * **The vocabulary is the tracking service's own** (`TrackedAlert.severity`), so an alert
 * the service computed and one derived here rank against each other honestly rather than
 * on two private scales. Severity shows as a coloured left rail AND an icon tint AND the
 * row's own words — never colour alone, which would strand a colour-blind owner, and never
 * an emoji, which renders differently on every phone the pilot runs on.
 */
function NeedsAttention({
  vehicles, live, bookings, overview, fuel, lowSample,
}: {
  vehicles: VehicleAnalytics[]
  live: LivePosition[]
  bookings: FleetBooking[]
  /** Optional: a 503 here costs the two tracking-derived rows, not the list. */
  overview: FleetOverview | null
  /** Optional, same contract — only the fuel-variance row depends on it. */
  fuel: FuelComparison | null
  lowSample: boolean
}) {
  const short = vehicles.filter(v => v.score.covered === false)
  // A driver is expected to report a position ONLY while their trip is in_transit — D-25 makes
  // bt-booking-service refuse GPS outside an active trip. /fleet/live returns every active driver
  // in the fleet, idle ones included (is_online false, booking_id null), and a driver assigned to a
  // trip that has not started yet carries a booking_id but still cannot send GPS. Filtering on
  // "no fix" alone therefore flagged every driver who simply was not driving, which on a real fleet
  // is most of them most of the time. Found by walking one load through its lifecycle (2026-10-11).
  const inTransit = new Set(bookings.filter(b => b.status === 'in_transit').map(b => b.id))
  const silent = live.filter(p => p.booking_id !== null && inTransit.has(p.booking_id) && !hasFix(p))
  const needCrew = bookings.filter(b => b.status === 'accepted' && !b.driver_id)
  const toReview = bookings.filter(b => b.status === 'delivery_asserted')
  const unpaid = unpaidSummary(bookings)
  const expiring = expiringRcs(overview)
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  // Trucks whose live trip is off-route or sitting idle, straight off the tracking
  // service's own evaluator (off_route at 500 m, idle at 15 min — D-012 thresholds).
  // Read, never re-derived here: the thresholds are the frozen CONTRACT's to set.
  const delayed = (overview?.vehicles ?? []).filter(v =>
    v.alerts.some(a => !a.resolved_at && (a.type === 'off_route' || a.type === 'idle')))
  const delayedWorst: Severity = delayed.some(v =>
    v.alerts.some(a => !a.resolved_at && a.severity === 'critical')) ? 'critical' : 'warning'

  // Fuel burnt against what the trip should have cost. `/fleet/analytics/fuel` is the same
  // read the Fuel page lives on, so the two surfaces can never disagree about a variance.
  const fuelOver = fuel && fuel.variance_pct !== null && fuel.variance_pct > 10 && fuel.trips_with_actuals > 0
    ? fuel
    : null
  const fuelWorstTruck = fuelOver
    ? [...fuelOver.by_vehicle]
        .filter(v => v.variance_pct !== null)
        .sort((a, b) => (b.variance_pct ?? 0) - (a.variance_pct ?? 0))[0]
    : null

  const items: Attention[] = []

  if (delayed.length > 0) items.push({
    key: 'delayed', severity: delayedWorst, icon: <Gauge />,
    title: `${plural(delayed.length, 'trip is', 'trips are')} off-route or idle`,
    sub: delayed.slice(0, 3).map(v => v.rc_number ?? 'Unnamed truck').join(', ')
      + (delayed.length > 3 ? ` +${delayed.length - 3}` : ''),
    href: '/map', cta: 'Track',
  })

  // Money already delivered and still not collected. Critical once something has been owed for
  // longer than a month, because that is the point at which it stops being a billing lag.
  if (unpaid.count > 0) items.push({
    key: 'unpaid',
    severity: unpaid.oldestDays >= 30 ? 'critical' : 'warning',
    icon: <IndianRupee />,
    title: `${inrCompact(unpaid.amount)} delivered but not paid`,
    sub: `${plural(unpaid.count, 'trip', 'trips')} · oldest ${unpaid.oldestDays} ${unpaid.oldestDays === 1 ? 'day' : 'days'}`,
    href: '/deliveries', cta: 'Chase',
  })

  if (short.length > 0) items.push({
    key: 'emi', severity: 'critical', icon: <AlertCircle />,
    title: `${plural(short.length, 'truck', 'trucks')} did not cover EMI`,
    sub: short.slice(0, 3).map(v => v.rc_number).join(', ') + (short.length > 3 ? ` +${short.length - 3}` : ''),
    href: '/vehicles', cta: 'View',
  })

  // An RC that has already lapsed grounds the truck today; one lapsing soon is a diary entry.
  if (expiring.length > 0) {
    const lapsed = expiring.filter(e => e.days <= 0)
    items.push({
      key: 'rc',
      severity: lapsed.length > 0 ? 'critical' : 'warning',
      icon: <FileWarning />,
      title: lapsed.length > 0
        ? `${plural(lapsed.length, 'truck has', 'trucks have')} an expired RC`
        : `${plural(expiring.length, 'RC expires', 'RCs expire')} soon`,
      sub: expiring.slice(0, 3)
        .map(e => `${e.rc} ${e.days <= 0 ? 'expired' : `in ${e.days}d`}`)
        .join(', ') + (expiring.length > 3 ? ` +${expiring.length - 3}` : ''),
      href: '/vehicles', cta: 'Renew',
    })
  }

  if (fuelOver) items.push({
    key: 'fuel', severity: 'warning', icon: <Fuel />,
    title: `Fuel is running ${pct(fuelOver.variance_pct)} over estimate`,
    sub: fuelWorstTruck
      ? `Worst: ${fuelWorstTruck.rc_number} at ${pct(fuelWorstTruck.variance_pct)} over`
      : `${inr(fuelOver.variance_inr)} more than estimated this period`,
    href: '/fuel', cta: 'Check',
  })

  if (silent.length > 0) items.push({
    key: 'gps', severity: 'warning', icon: <Radio />,
    title: `${plural(silent.length, 'truck is', 'trucks are')} not sending GPS`,
    sub: silent.slice(0, 3).map(p => p.rc_number ?? p.driver_name ?? 'Unnamed').join(', '),
    href: '/map', cta: 'Open map',
  })

  if (needCrew.length > 0) items.push({
    key: 'crew', severity: 'warning', icon: <UserPlus />,
    title: `${plural(needCrew.length, 'trip needs', 'trips need')} a truck and driver`,
    sub: 'Won loads waiting to be paired', href: '/trips', cta: 'Assign',
  })

  if (toReview.length > 0) items.push({
    key: 'pod', severity: 'info', icon: <ClipboardCheck />,
    title: `${plural(toReview.length, 'delivery', 'deliveries')} awaiting your review`,
    sub: 'Check the proof-of-delivery photos', href: '/deliveries', cta: 'Review',
  })

  if (lowSample) items.push({
    key: 'sample', severity: 'info', icon: <BarChart3 />,
    title: 'Few trips this period',
    sub: 'Averages are rough until more trips complete', href: '/analytics', cta: 'Details',
  })

  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  const critical = items.filter(i => i.severity === 'critical').length
  const headSub = items.length === 0
    ? undefined
    : critical > 0
      ? `${plural(items.length, 'item', 'items')} · ${critical} need${critical === 1 ? 's' : ''} you now`
      : plural(items.length, 'item', 'items')

  return (
    <Card className="flex flex-col">
      <CardHead
        icon={<Bell />}
        tint={critical > 0 ? 'red' : items.length > 0 ? 'amber' : 'green'}
        title="Needs attention"
        sub={headSub}
        info="Everything wrong with the fleet right now, most serious first."
      />
      {items.length === 0 ? (
        <Empty icon={<CheckCircle2 />} title="Nothing needs you right now" hint="Alerts appear here the moment a trip, truck or payment needs a decision." />
      ) : (
        <ul className="p-3 grid grid-cols-1 xl:grid-cols-2 gap-2">
          {items.map(it => {
            const style = SEVERITY_STYLE[it.severity]
            return (
              <li key={it.key}>
                <Link
                  href={it.href}
                  className={cx(
                    'flex h-full items-center gap-3 rounded-xl border-l-4 bg-gray-50/60 px-3 py-2.5',
                    'hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                    style.rail,
                  )}
                >
                  <IconTile icon={it.icon} tint={style.tint} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-gray-900">{it.title}</span>
                    <span className="block text-xs text-gray-500 truncate">{it.sub}</span>
                  </span>
                  <span className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">{it.cta}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// ── Where the work comes from ─────────────────────────────────

/**
 * Two demand questions the dashboard never asked: how often this fleet actually wins the loads
 * it bids on, and how much of its revenue rests on a single shipper.
 *
 * Win rate matters because bidding is the fleet's whole sales function and nothing reported on
 * it — an owner could bid forty times, win six, and never see that number. Concentration
 * matters because a fleet taking most of its revenue from one shipper is one phone call from a
 * very bad quarter, and that is worth knowing before the call comes.
 */
function WorkAndDemand({ bids, bookings, days }: { bids: FleetBid[]; bookings: FleetBooking[]; days: number }) {
  const decided = bids.filter(b => b.status === 'accepted' || b.status === 'rejected')
  const won = bids.filter(b => b.status === 'accepted').length
  const live = bids.filter(b => b.status === 'submitted' || b.status === 'countered').length
  const winPct = decided.length > 0 ? (won / decided.length) * 100 : null

  const { rows, grand } = shipperShares(bookings, days)
  const top = rows.slice(0, 4)
  const topShare = rows[0]?.pct ?? 0

  return (
    <Card>
      <CardHead
        icon={<Gavel />}
        tint="amber"
        title="Where the work comes from"
        sub={`How often bids convert, and who the revenue depends on — last ${days} days`}
        info="Win rate counts only bids the shipper has decided — live bids are excluded."
        actions={
          <Link href="/auctions" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm py-1')}>
            Find work <ArrowRight className="w-4 h-4" />
          </Link>
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 px-5 py-4">
        <div>
          <p className="text-sm font-medium text-gray-600">Bid win rate</p>
          {winPct === null ? (
            <p className="mt-2 text-sm text-gray-500">
              No bid has been decided yet{live > 0 ? ` — ${live} still live` : ''}.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[1.625rem] leading-tight font-extrabold tabular-nums tracking-tight text-gray-900">
                {pct(winPct)}
              </p>
              <p className="mt-1 text-xs text-gray-500 tabular-nums">
                Won {won} of {decided.length} decided{live > 0 ? ` · ${live} still live` : ''}
              </p>
              <Meter pct={winPct} />
            </>
          )}
        </div>

        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-600 inline-flex items-center gap-1.5">
            Revenue by shipper
            {topShare >= 50 && rows.length > 1 && (
              <InfoDot text="Most of this fleet's revenue depends on one shipper." />
            )}
          </p>
          {grand <= 0 ? (
            <p className="mt-2 text-sm text-gray-500">No completed trips in this period.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {top.map(s => (
                <li key={s.name} className="flex items-center gap-2.5 text-sm min-w-0">
                  <span className="text-gray-700 truncate flex-1">{s.name}</span>
                  <span className="text-xs text-gray-500 tabular-nums">{pct(s.pct)}</span>
                  <span className="w-[5.5rem] text-right font-medium text-gray-900 tabular-nums">{inr(s.value)}</span>
                </li>
              ))}
              {rows.length > top.length && (
                <li className="text-xs text-gray-500">+{rows.length - top.length} more</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}

// ── Where the revenue went ────────────────────────────────────

/** Revenue against each thing it paid for, and what was left — one bar per line. */
function MoneySplit({ score }: { score: FleetSummary['score'] }) {
  const base = Math.max(score.revenue_inr, 1)
  const rows: { label: string; value: number; bar: string; strong?: boolean }[] = [
    { label: 'Revenue', value: score.revenue_inr, bar: 'bg-blue-600' },
    { label: 'Running cost', value: score.running_cost_inr, bar: 'bg-brand-500' },
    { label: 'Tolls & other', value: score.toll_other_inr, bar: 'bg-violet-500' },
    { label: 'EMI & fixed', value: score.fixed_cost_inr, bar: 'bg-teal-500' },
    { label: 'Net profit', value: score.surplus_inr, bar: score.surplus_inr >= 0 ? 'bg-emerald-500' : 'bg-red-500', strong: true },
  ]
  return (
    <Card className="flex flex-col">
      <CardHead
        icon={<IndianRupee />}
        tint="blue"
        title="Revenue vs costs"
        sub="What the period's revenue paid for, and what was left"
      />
      {score.revenue_inr <= 0 ? (
        <Empty title="No revenue recorded this period" hint="Bars appear once trips are completed." />
      ) : (
        <ul className="px-5 py-4 space-y-3.5 flex-1">
          {rows.map(r => (
            <li key={r.label}>
              <div className="flex items-baseline justify-between text-sm">
                <span className={r.strong ? 'font-bold text-gray-900' : 'text-gray-700'}>{r.label}</span>
                <span className={cx('tabular-nums font-semibold', r.strong ? (r.value >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-gray-900')}>
                  {r.strong ? inrSigned(r.value) : inr(r.value)}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 rounded-full bg-gray-100 overflow-hidden">
                <div className={cx('h-full rounded-full', r.bar)} style={{ width: `${Math.min(100, (Math.abs(r.value) / base) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** The "N trucks sending GPS" strip — shown when no truck reports, or the map cannot load. */
function GpsCount({ n }: { n: number }) {
  return (
    <div className="rounded-lg bg-emerald-50/70 border border-emerald-100 px-3.5 py-2.5 flex items-center gap-2.5">
      <MapPin className="w-4 h-4 text-emerald-600 shrink-0" />
      <span className="text-sm font-semibold text-gray-900 tabular-nums">{n}</span>
      <span className="text-sm text-gray-700 -ml-1">
        {n === 1 ? 'truck sending GPS' : 'trucks sending GPS'}
      </span>
    </div>
  )
}

// ── Cost mix ──────────────────────────────────────────────────

function CostMix({ breakdown }: { breakdown: CostBreakdown }) {
  const slices = COST_SLICES
    .map(s => ({ label: s.label, color: s.color, css: s.css, value: costAmount(breakdown, s.typedKey, s.wireKey) }))
    .filter(s => s.value > 0)

  const total = slices.reduce((sum, s) => sum + s.value, 0)
  const fuel = slices.find(s => s.label === 'Fuel')
  const fuelShare = total > 0 && fuel ? (fuel.value / total) * 100 : null

  return (
    <Card>
      <CardHead
        icon={<Fuel />}
        tint="amber"
        title="Where the money went"
        sub={total > 0 ? `${inr(total)} of cost across the fleet` : 'No cost recorded'}
        actions={
          <Link href="/analytics" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm py-1')}>
            <span className="hidden sm:inline">View full report</span>
            <span className="sm:hidden">Report</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        }
      />

      {total <= 0 ? (
        <Empty
          title="No costs recorded this period"
          hint="Cost lines appear once trips are completed."
        />
      ) : (
        <div className="px-5 py-4">
          {fuelShare !== null && fuel && (
            <p className="text-base font-bold text-gray-900 mb-3 tabular-nums">
              Fuel is {pct(fuelShare)} of all cost — {inr(fuel.value)}
            </p>
          )}

          <div className="flex flex-col sm:flex-row items-center gap-5 sm:gap-6">
            <Ring
              label={`Cost mix: ${slices.map(s => `${s.label} ${inr(s.value)}`).join(', ')}`}
              slices={slices}
            >
              <span className="text-lg font-extrabold leading-none tabular-nums text-gray-900">{inrCompact(total)}</span>
              <span className="mt-1 text-xs text-gray-500">Total cost</span>
            </Ring>
            <ul className="w-full min-w-0 flex-1 space-y-2">
              {slices.map(s => (
                <li key={s.label} className="flex items-center gap-2.5 text-sm min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.color}`} />
                  <span className="text-gray-700 truncate">{s.label}</span>
                  <span className="ml-auto text-xs text-gray-500 tabular-nums">
                    {pct((s.value / total) * 100)}
                  </span>
                  <span className="w-[5.5rem] text-right font-medium text-gray-900 tabular-nums">{inr(s.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  )
}
