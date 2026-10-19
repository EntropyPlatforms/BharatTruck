'use client'

// Utilisation — "is the truck full, and is it moving?"
//
// The three utilisation numbers on this page answer DIFFERENT questions and are
// deliberately never averaged together (bt-fleet-service/src/lib/analytics.ts,
// computeUtilization):
//
//   tonnage_pct  = Σ laden_weight_kg   ÷ Σ capacity_kg     — full by weight
//   volume_pct   = Σ volume_used_cuft  ÷ Σ capacity_cuft   — full by space
//   distance_pct = Σ distance_km       ÷ expected km       — moving at all
//
// The first two sum only over trips that actually ran, so their denominators
// shrink with idle time; distance_pct is the only one measured against the
// calendar. A truck that did one perfectly loaded trip in 30 days reads 100%
// tonnage and ~3% distance, and the owner has to see both.
//
// Below them is the headline the running-cost score answers: revenue minus
// running cost, minus the tolls and other actuals the driver logged, minus this
// asset's pro-rated share of fixed cost (EMI, annuals, office overhead) — did the
// asset pay for itself.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowDown, ArrowUp, ArrowUpDown, Box, CalendarDays, ChartColumn, Gauge, IndianRupee, Route, Truck,
  UserRound, Weight, X,
} from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import {
  Card, CardHead, CoverPill, Empty, ErrorNote, IconTile, InfoDot, Loading, Stat,
} from '@/components/stat'
import { Avatar, TD, TH, THEAD_ROW, fmtPhone } from '@/components/fleet-ops/bits'
import {
  ApiError, getDriverAnalytics, getFleetSummary, getVehicleAnalytics,
} from '@/lib/api'
import { inr, inrCompact, inrSigned, km, pct, periodDays, shortDate, tons } from '@/lib/format'
import type { DriverAnalytics, FleetSummary, Utilization, VehicleAnalytics } from '@/lib/types'
import { MONO, SEG_OFF, SEG_ON, SEG_WRAP, SELECT, cx, pill } from '@/lib/ui'

const PERIOD_OPTIONS = [30, 90, 180] as const
type PeriodChoice = (typeof PERIOD_OPTIONS)[number]

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

/** Cubic feet, Indian grouping. There is no format.ts helper for volume. */
function cuft(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${Math.round(n).toLocaleString('en-IN')} cu ft`
}

/**
 * Same thresholds as <Meter> so a number in the table and a bar above it never
 * disagree about whether 48% is bad.
 */
function utilTone(value: number | null): string {
  if (value === null || Number.isNaN(value)) return 'text-gray-400'
  if (value >= 75) return 'text-emerald-700'
  if (value >= 50) return 'text-gray-900'
  if (value >= 30) return 'text-orange-600'
  return 'text-red-600'
}

/** The bar colour for the same thresholds — health, not category. */
function utilBar(value: number): string {
  return value >= 75 ? 'bg-emerald-500' : value >= 50 ? 'bg-blue-600' : value >= 30 ? 'bg-amber-500' : 'bg-red-500'
}

/** "+₹1.8L" — a compact signed figure for the surplus tile. */
function inrCompactSigned(n: number): string {
  return n > 0 ? `+${inrCompact(n)}` : inrCompact(n)
}

// ── Page ──────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [days, setDays] = useState<PeriodChoice>(30)
  const [summary, setSummary] = useState<FleetSummary | null>(null)
  const [vehicles, setVehicles] = useState<VehicleAnalytics[]>([])
  const [drivers, setDrivers] = useState<DriverAnalytics[]>([])
  const [driverError, setDriverError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hideLowSample, setHideLowSample] = useState(false)

  // The effect only kicks the requests off; every setState happens in a
  // callback, matching the dashboard. Flipping loading/error synchronously in
  // the effect body trips react-hooks/set-state-in-effect, so the period
  // buttons own that transition.
  useEffect(() => {
    let cancelled = false
    const period = periodDays(days)

    Promise.all([
      getFleetSummary(period),
      getVehicleAnalytics(period),
      // The driver roll-up hydrates identities from a second service. Settle it
      // separately: a leaderboard that fails must not blank the utilisation
      // report, which is what this page is actually for.
      getDriverAnalytics(period).then(
        res => ({ ok: true as const, res }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    ])
      .then(([summaryData, vehicleData, driverData]) => {
        if (cancelled) return
        setSummary(summaryData)
        setVehicles(vehicleData?.vehicles ?? [])
        if (driverData.ok) {
          setDrivers(driverData.res?.drivers ?? [])
          setDriverError(null)
        } else {
          setDrivers([])
          setDriverError(messageOf(driverData.err))
        }
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(messageOf(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [days])

  const periodLabel = summary ? `${shortDate(summary.period.from)} – ${shortDate(summary.period.to)}` : null

  const switcher = (
    <div className="flex flex-wrap items-center gap-2">
      <div className={SEG_WRAP} role="group" aria-label="Reporting window">
        {PERIOD_OPTIONS.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => {
              if (option === days) return
              setLoading(true)
              setError(null)
              setDays(option)
            }}
            aria-pressed={days === option}
            className={cx(days === option ? SEG_ON : SEG_OFF, 'min-w-[52px]')}
          >
            {option}d
          </button>
        ))}
      </div>
      {periodLabel && (
        <span className="inline-flex items-center gap-2 h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700">
          <CalendarDays className="w-4 h-4 text-gray-500" />
          {periodLabel}
        </span>
      )}
    </div>
  )

  const header = (
    <PageHeader
      title="Utilisation"
      info="Whether each truck ran full and paid for itself."
      actions={switcher}
    />
  )

  if (loading && !summary) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Loading label="Working out utilisation" />
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <ErrorNote message={error} />
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Card>
          <Empty
            title="No utilisation data yet"
            hint="Add a truck and complete a trip."
            icon={<ChartColumn />}
          />
        </Card>
      </div>
    )
  }

  const period = `${shortDate(summary.period.from)} – ${shortDate(summary.period.to)}`

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      {header}

      {/* A refetch that failed keeps the previous period on screen. */}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 lg:gap-4">
          <Stat
            label="Trips"
            value={summary.trips}
            tone={summary.low_sample ? 'warn' : 'neutral'}
            sub={
              summary.low_sample
                ? 'Few trips — averages below are noisy'
                : `${summary.active_vehicles} ${summary.active_vehicles === 1 ? 'truck' : 'trucks'} on the books`
            }
            icon={<Truck />}
            tint="blue"
          />
          <Stat
            label="Clearing EMI"
            value={`${summary.vehicles_covering_emi} / ${summary.active_vehicles}`}
            tone={
              summary.active_vehicles === 0
                ? 'neutral'
                : summary.vehicles_covering_emi * 2 > summary.active_vehicles ? 'good' : 'warn'
            }
            sub={`EMI ${inrCompact(summary.score.emi_inr)} over ${days} days`}
            icon={<IndianRupee />}
          />
          <Stat
            label="Fleet surplus"
            value={inrCompactSigned(summary.score.surplus_inr)}
            tone={summary.score.surplus_inr >= 0 ? 'good' : 'bad'}
            sub={`After ${inrCompact(summary.score.toll_other_inr)} tolls & other, ${inrCompact(summary.score.fixed_cost_inr)} fixed cost`}
            icon={<ChartColumn />}
          />
        </div>

        {summary.low_sample && !hideLowSample && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold text-sm">!</span>
            <p className="min-w-0 flex-1 pt-0.5">
              <span className="font-semibold">
                Only {summary.trips} {summary.trips === 1 ? 'trip' : 'trips'} in this window.
              </span>{' '}
              Every average below is built on a handful of trips — treat it as a hint, not a trend, until more trips settle.
            </p>
            <button
              onClick={() => setHideLowSample(true)}
              aria-label="Dismiss"
              className="-m-1 p-1 rounded-md text-amber-700 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 items-start">
          <FleetUtilisation
            utilization={summary.utilization}
            sub={`${summary.trips} ${summary.trips === 1 ? 'trip' : 'trips'} across ${summary.active_vehicles} ${
              summary.active_vehicles === 1 ? 'truck' : 'trucks'
            } · ${period}`}
          />
          <RunningCostChart vehicles={vehicles} days={days} />
        </div>

        <div className="mt-5">
          <VehicleTable vehicles={vehicles} periodLabel={period} />
        </div>

        <div className="mt-5">
          <DriverLeaderboard drivers={drivers} errorMessage={driverError} periodLabel={period} />
        </div>
      </div>
    </div>
  )
}

// ── 1-3: the three fleet-level views ──────────────────────────

// TrustBadge — a small pill saying how much to trust a number: "Declared" (the shipper
// stated it, nobody measured it), "Measured" (GPS/routed real km), or "Estimated" (a
// stand-in). The visible half of the analytics-trust work: an owner should never have to
// guess whether a figure is a fact or a claim.
function TrustBadge({ label, tone, title }: { label: string; tone: 'declared' | 'measured' | 'estimated'; title: string }) {
  const cls = pill(tone === 'measured' ? 'green' : tone === 'estimated' ? 'amber' : 'slate')
  return (
    <span title={title} className={cx(cls, 'text-[0.6875rem]')}>
      {label}
    </span>
  )
}

// distanceBadge — turns measured_distance_pct into a "how real is this distance" label.
function distanceBadge(u: Utilization): { label: string; tone: 'measured' | 'estimated'; title: string } {
  const p = u.measured_distance_pct
  if (p === null) return { label: 'No distance', tone: 'estimated', title: 'No measured, routed or quoted distance for these trips.' }
  if (p >= 99) return { label: 'Measured', tone: 'measured', title: 'Every kilometre is GPS-driven or a real routed road distance — no estimates.' }
  if (p >= 50) return { label: `${Math.round(p)}% measured`, tone: 'measured', title: 'Most of this distance is GPS-driven or routed road distance; the remainder is the sold-quote estimate.' }
  if (p > 0) return { label: `${Math.round(p)}% measured`, tone: 'estimated', title: 'Most of this distance is the sold-quote estimate, not measured or routed km.' }
  return { label: 'Estimated', tone: 'estimated', title: 'This distance is the sold-quote figure, not measured or routed km.' }
}

function UtilPanel({
  icon, title, info, meterLabel, value, rows, badge,
}: {
  icon: ReactNode
  title: string
  info: string
  meterLabel: string
  value: number | null
  rows: { label: string; value: string }[]
  badge?: ReactNode
}) {
  const known = value !== null && !Number.isNaN(value)
  const clamped = known ? Math.max(0, Math.min(100, value)) : 0
  return (
    <div className="rounded-xl border border-gray-200 p-4 min-w-0">
      <div className="flex items-center gap-2.5">
        <IconTile icon={icon} tint="blue" size="sm" />
        <h3 className="text-sm font-semibold text-gray-900 inline-flex items-center gap-1.5 min-w-0">
          {title}
          <InfoDot text={info} />
        </h3>
      </div>

      <div className="mt-3">
        {known ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className={cx('text-[1.625rem] leading-tight font-bold tabular-nums', utilTone(value))}>{clamped.toFixed(0)}%</span>
              {badge}
            </div>
            <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden" role="img" aria-label={`${meterLabel}: ${clamped.toFixed(0)}%`}>
              <div className={cx('h-2 rounded-full transition-[width] duration-500', utilBar(clamped))} style={{ width: `${clamped}%` }} />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-sm text-gray-400">Not enough data</span>
            {badge}
          </div>
        )}
        <div className="mt-1.5 text-xs text-gray-500">{meterLabel}</div>
      </div>

      <dl className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
        {rows.map(row => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-xs text-gray-500 min-w-0">{row.label}</dt>
            <dd className="text-sm font-medium text-gray-900 tabular-nums whitespace-nowrap">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function FleetUtilisation({ utilization, sub }: { utilization: Utilization; sub: string }) {
  const u = utilization

  return (
    <Card>
      <CardHead title="Fleet utilisation" sub={sub} icon={<ChartColumn />} />

      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <UtilPanel
          icon={<Weight />}
          title="Tonnage"
          info="Load weight carried vs the trucks' weight capacity, on trips that ran. Weight is the shipper's declared figure — the load is not re-weighed."
          meterLabel="Laden weight vs capacity"
          value={u.tonnage_pct}
          badge={<TrustBadge label="Declared" tone="declared" title="Weight is what the shipper declared at booking — the load was not re-weighed. Read tonnage utilisation as a declared figure, not a measured one." />}
          rows={[
            { label: 'Carried (declared)', value: tons(u.laden_weight_kg) },
            { label: 'Capacity offered', value: tons(u.capacity_kg) },
            { label: 'Declared on', value: `${u.tonnage_trips} ${u.tonnage_trips === 1 ? 'trip' : 'trips'}` },
          ]}
        />
        <UtilPanel
          icon={<Box />}
          title="Volume"
          info="Cargo space used vs capacity — read alongside tonnage, not instead. Used volume is shipper-stated/derived and capacity can fall back to a class average. Trips with no declared volume are left out, not counted as empty."
          meterLabel="Cubic feet used vs capacity"
          value={u.volume_pct}
          badge={<TrustBadge label="Declared" tone="declared" title="Volume is the shipper's stated cubic feet (or derived from stated L×W×H), and truck capacity may fall back to a class average — so this is a declared/estimated ratio, the least measured of the three. A trip with no declared volume is unknown, not empty, and is left out of the ratio." />}
          rows={[
            { label: 'Used (declared)', value: cuft(u.volume_used_cuft) },
            { label: 'Capacity offered', value: cuft(u.capacity_cuft) },
            { label: 'Declared on', value: u.volume_trips === 0 ? 'No trip declared a volume' : `${u.volume_trips} ${u.volume_trips === 1 ? 'trip' : 'trips'}` },
          ]}
        />
        <UtilPanel
          icon={<Gauge />}
          title="Distance"
          info="Actual km vs the category's expected km — exposes idle trucks. Actual km is GPS-driven or the real routed road distance; the old straight-line × 1.3 guess is gone."
          meterLabel="Actual km vs expected km"
          value={u.distance_pct}
          badge={<TrustBadge {...distanceBadge(u)} />}
          rows={[
            { label: 'Actual', value: km(u.distance_km) },
            { label: 'Expected', value: km(u.expected_distance_km) },
          ]}
        />
      </div>
    </Card>
  )
}

// ── Per-vehicle table ─────────────────────────────────────────

type SortKey = 'tonnage' | 'volume' | 'distance' | 'surplus'
type SortDir = 'asc' | 'desc'

function metricOf(v: VehicleAnalytics, key: SortKey): number | null {
  switch (key) {
    case 'tonnage': return v.utilization.tonnage_pct
    case 'volume': return v.utilization.volume_pct
    case 'distance': return v.utilization.distance_pct
    case 'surplus': return v.score.surplus_inr
  }
}

const SORT_LABEL: Record<SortKey, string> = {
  tonnage: 'tonnage use',
  volume: 'volume use',
  distance: 'distance use',
  surplus: 'surplus',
}

function SortableHeader({
  label, sortKey, active, dir, onSort,
}: {
  label: string
  sortKey: SortKey
  active: boolean
  dir: SortDir
  onSort: (key: SortKey) => void
}) {
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={cx(TH, 'text-right')} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${SORT_LABEL[sortKey]}`}
        className={cx(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 -mr-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
          active ? 'text-blue-700 bg-blue-50' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100',
        )}
      >
        {label}
        <Icon className={cx('w-3.5 h-3.5 shrink-0', !active && 'opacity-50')} />
      </button>
    </th>
  )
}

/** A percentage with a small bar beside it, coloured by the same health thresholds. */
function MiniMeter({ value }: { value: number | null }) {
  if (value === null || Number.isNaN(value)) return <span className="text-gray-400">—</span>
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className={cx('tabular-nums', utilTone(value))}>{pct(value)}</span>
      <span className="w-10 h-1.5 rounded-full bg-gray-100 overflow-hidden shrink-0" aria-hidden>
        <span className={cx('block h-1.5 rounded-full', utilBar(clamped))} style={{ width: `${clamped}%` }} />
      </span>
    </span>
  )
}

function VehicleTable({ vehicles, periodLabel }: { vehicles: VehicleAnalytics[]; periodLabel: string }) {
  // Worst surplus first by default — the truck to deal with today is the one at
  // the top of the page, not the one buried alphabetically.
  const [sortKey, setSortKey] = useState<SortKey>('surplus')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    // Percentages are most useful worst-first too, so every column opens ascending.
    setSortDir('asc')
  }

  const sorted = useMemo(() => {
    const rows = [...vehicles]
    rows.sort((a, b) => {
      const av = metricOf(a, sortKey)
      const bv = metricOf(b, sortKey)
      // Nulls are "not enough data", not "zero" — they sink to the bottom in
      // both directions rather than pretending to be the worst performer.
      if (av === null && bv === null) return a.rc_number.localeCompare(b.rc_number)
      if (av === null) return 1
      if (bv === null) return -1
      if (av === bv) return a.rc_number.localeCompare(b.rc_number)
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return rows
  }, [vehicles, sortKey, sortDir])

  const shortCount = vehicles.filter(v => v.score.covered === false).length

  return (
    <Card>
      <CardHead
        title="Per-truck utilisation"
        icon={<Truck />}
        info="Per-truck revenue, cost and surplus — an idle truck still carries its EMI."
        sub={
          vehicles.length === 0
            ? 'No trucks in this fleet yet'
            : `${vehicles.length} ${vehicles.length === 1 ? 'truck' : 'trucks'} · sorted by ${SORT_LABEL[sortKey]} ${
                sortDir === 'asc' ? 'lowest first' : 'highest first'
              } · ${periodLabel}`
        }
        actions={vehicles.length > 0 ? (
          <label className="hidden sm:inline-flex items-center gap-2 text-sm text-gray-600">
            Sort by
            <select
              value={`${sortKey}:${sortDir}`}
              onChange={e => {
                const [k, d] = e.target.value.split(':') as [SortKey, SortDir]
                setSortKey(k)
                setSortDir(d)
              }}
              className={cx(SELECT, 'h-10 w-52')}
            >
              {(Object.keys(SORT_LABEL) as SortKey[]).flatMap(k => [
                <option key={`${k}:asc`} value={`${k}:asc`}>{SORT_LABEL[k][0].toUpperCase() + SORT_LABEL[k].slice(1)} (lowest first)</option>,
                <option key={`${k}:desc`} value={`${k}:desc`}>{SORT_LABEL[k][0].toUpperCase() + SORT_LABEL[k].slice(1)} (highest first)</option>,
              ])}
            </select>
          </label>
        ) : undefined}
      />

      {vehicles.length === 0 ? (
        <Empty
          title="No trucks on the books"
          hint="Add a truck under Trucks to start scoring it."
          icon={<Truck />}
        />
      ) : (
        <>
          {shortCount > 0 && (
            <div className="mx-4 mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700 flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-red-500 text-[#fff] inline-flex items-center justify-center shrink-0 text-xs font-bold">!</span>
              {shortCount} {shortCount === 1 ? 'truck' : 'trucks'} did not cover their cost.
            </div>
          )}

          <div className="overflow-x-auto mt-3">
            <table className="w-full min-w-[1040px]">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>RC number</th>
                  <th className={TH}>Category</th>
                  <th className={cx(TH, 'text-right')}>Trips</th>
                  <SortableHeader label="Tonnage" sortKey="tonnage" active={sortKey === 'tonnage'} dir={sortDir} onSort={onSort} />
                  <SortableHeader label="Volume" sortKey="volume" active={sortKey === 'volume'} dir={sortDir} onSort={onSort} />
                  <SortableHeader label="Distance" sortKey="distance" active={sortKey === 'distance'} dir={sortDir} onSort={onSort} />
                  <th className={cx(TH, 'text-right')}>Revenue / km</th>
                  <th className={cx(TH, 'text-right')}>Cost / km</th>
                  <SortableHeader label="Surplus" sortKey="surplus" active={sortKey === 'surplus'} dir={sortDir} onSort={onSort} />
                  <th className={cx(TH, 'text-right')}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(v => {
                  const short = v.score.covered === false
                  return (
                    <tr
                      key={v.vehicle_id}
                      className={cx(
                        'border-b border-gray-100 last:border-b-0 transition-colors',
                        short ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-gray-50/70',
                      )}
                    >
                      <td className={cx(TD, short ? 'shadow-[inset_3px_0_0_0_var(--color-red-500)]' : '')}>
                        <Link
                          href={`/vehicles/${v.vehicle_id}`}
                          className={cx(MONO, 'font-semibold text-blue-600 hover:text-blue-700 hover:underline')}
                        >
                          {v.rc_number}
                        </Link>
                      </td>
                      <td className={cx(TD, 'text-gray-600 whitespace-nowrap')}>
                        {v.model_category ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className={cx(TD, 'text-right tabular-nums text-gray-900')}>
                        {v.trips}
                        {v.low_sample && (
                          <span title="Few trips — this truck's averages are noisy" className="ml-1 text-amber-600" aria-label="few trips">*</span>
                        )}
                      </td>
                      <td className={cx(TD, 'text-right')}><MiniMeter value={v.utilization.tonnage_pct} /></td>
                      <td className={cx(TD, 'text-right')}><MiniMeter value={v.utilization.volume_pct} /></td>
                      <td className={cx(TD, 'text-right')}><MiniMeter value={v.utilization.distance_pct} /></td>
                      <td className={cx(TD, 'text-right tabular-nums text-gray-900')}>
                        {v.revenue_per_km_inr === null
                          ? <span className="text-gray-400">—</span>
                          : inr(v.revenue_per_km_inr)}
                      </td>
                      <td className={cx(TD, 'text-right tabular-nums text-gray-600')}>
                        {v.cost_per_km_inr === null
                          ? <span className="text-gray-400">—</span>
                          : inr(v.cost_per_km_inr)}
                      </td>
                      <td className={cx(TD, 'text-right tabular-nums font-semibold whitespace-nowrap',
                        v.score.surplus_inr >= 0 ? 'text-emerald-700' : 'text-red-600',
                      )}>
                        {inrSigned(v.score.surplus_inr)}
                      </td>
                      <td className={cx(TD, 'text-right')}>
                        <CoverPill covered={v.score.covered} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

// ── Running-cost score: diverging bars ────────────────────────

function RunningCostChart({ vehicles, days }: { vehicles: VehicleAnalytics[]; days: number }) {
  const ranked = useMemo(
    () => [...vehicles].sort((a, b) => b.score.surplus_inr - a.score.surplus_inr),
    [vehicles],
  )

  // One shared scale so the bars are comparable across the fleet: the widest bar
  // is the biggest number in either direction.
  const maxAbs = ranked.reduce((max, v) => Math.max(max, Math.abs(v.score.surplus_inr)), 0)
  const covered = ranked.filter(v => v.score.covered).length

  return (
    <Card>
      <CardHead
        title="Running-cost score"
        icon={<Route />}
        info="Revenue minus running cost, tolls & other actuals, fixed cost and EMI — right of the line paid for itself."
        sub={
          vehicles.length === 0
            ? 'No trucks to score'
            : `${covered} of ${ranked.length} cleared running cost, tolls, fixed cost and EMI over ${days} days`
        }
      />

      {vehicles.length === 0 ? (
        <Empty
          title="Nothing to rank yet"
          hint="Add a truck to see it ranked."
          icon={<Route />}
        />
      ) : (
        <div className="p-4 sm:p-5">
          <ul className="space-y-1.5">
            {ranked.map(v => {
              const value = v.score.surplus_inr
              const positive = value >= 0
              // Half the track per side; a non-zero amount always gets a sliver
              // so it never renders as an invisible bar.
              const width = maxAbs > 0 ? Math.max(value === 0 ? 0 : 0.6, (Math.abs(value) / maxAbs) * 50) : 0

              return (
                <li key={v.vehicle_id} className="flex items-center gap-2 sm:gap-3">
                  <Link
                    href={`/vehicles/${v.vehicle_id}`}
                    className={cx(MONO, 'w-[80px] sm:w-24 shrink-0 text-right text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline truncate')}
                    title={v.rc_number}
                  >
                    {v.rc_number}
                  </Link>

                  <div
                    className="relative flex-1 min-w-0 h-7"
                    role="img"
                    aria-label={`${v.rc_number}: ${inrSigned(value)}`}
                  >
                    <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
                    <span
                      className={cx(
                        'absolute inset-y-1.5',
                        positive ? 'left-1/2 rounded-r-[3px] bg-emerald-500' : 'right-1/2 rounded-l-[3px] bg-red-500',
                      )}
                      style={{ width: `${width}%` }}
                    />
                  </div>

                  <span className={cx(
                    'w-[72px] sm:w-24 shrink-0 text-right text-xs font-semibold tabular-nums',
                    positive ? 'text-emerald-700' : 'text-red-600',
                  )}>
                    {inrSigned(value)}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="mt-3 flex items-center gap-2 sm:gap-3 text-[0.6875rem] sm:text-xs font-medium">
            <span className="w-[80px] sm:w-24 shrink-0" />
            <span className="flex-1 min-w-0 flex justify-between border-t border-gray-200 pt-2">
              <span className="text-red-600">Short</span>
              <span className="text-gray-500 whitespace-nowrap">Breaks even</span>
              <span className="text-emerald-700">Surplus</span>
            </span>
            <span className="w-[72px] sm:w-24 shrink-0 text-right text-gray-400 pt-2 whitespace-nowrap">₹ surplus</span>
          </div>

          {maxAbs === 0 && (
            <p className="mt-4 text-xs text-gray-500">
              Every truck scored exactly zero this period.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Driver leaderboard ────────────────────────────────────────

function DriverLeaderboard({
  drivers, errorMessage, periodLabel,
}: {
  drivers: DriverAnalytics[]
  errorMessage: string | null
  periodLabel: string
}) {
  const ranked = useMemo(
    () => [...drivers].sort((a, b) => b.net_profit_inr - a.net_profit_inr),
    [drivers],
  )

  return (
    <Card>
      <CardHead
        title="Driver leaderboard"
        icon={<UserRound />}
        info="Net profit per trip, after the driver's wage — excludes tolls & other actuals, EMI and overhead."
        sub={
          errorMessage
            ? 'Could not be loaded'
            : ranked.length === 0
              ? 'No driver-attributed trips in this window'
              : `${ranked.length} ${ranked.length === 1 ? 'driver' : 'drivers'} by net profit contributed · ${periodLabel}`
        }
      />

      {errorMessage ? (
        <div className="p-4">
          <ErrorNote message={errorMessage} />
        </div>
      ) : ranked.length === 0 ? (
        <Empty
          title="No driver figures yet"
          hint="Appears once a crewed trip is completed."
          icon={<UserRound />}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className={THEAD_ROW}>
                <th className={cx(TH, 'w-12')}>#</th>
                <th className={TH}>Driver</th>
                <th className={cx(TH, 'text-right')}>Trips</th>
                <th className={cx(TH, 'text-right')}>Distance</th>
                <th className={cx(TH, 'text-right')}>Net profit</th>
                <th className={cx(TH, 'text-right')}>Wage allocated</th>
                <th className={cx(TH, 'text-right')}>Net profit / km</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((d, index) => (
                <tr key={d.driver_id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/70 transition-colors">
                  <td className={cx(TD, 'tabular-nums text-gray-500 font-semibold')}>{index + 1}</td>
                  <td className={TD}>
                    <span className="flex items-center gap-3 min-w-0">
                      <Avatar name={d.full_name} />
                      <span className="min-w-0">
                        <span className="block font-semibold text-gray-900 truncate">
                          {d.full_name ?? 'Unnamed driver'}
                        </span>
                        {d.phone_number && (
                          <span className="block text-xs text-gray-500 tabular-nums">{fmtPhone(d.phone_number)}</span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums text-gray-900')}>{d.trips}</td>
                  <td className={cx(TD, 'text-right tabular-nums text-gray-600 whitespace-nowrap')}>
                    {km(d.distance_km)}
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums font-semibold whitespace-nowrap',
                    d.net_profit_inr >= 0 ? 'text-emerald-700' : 'text-red-600',
                  )}>
                    {inr(d.net_profit_inr)}
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums text-gray-600')}>
                    {inr(d.wage_allocated_inr)}
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums text-gray-900')}>
                    {d.net_profit_per_km_inr === null
                      ? <span className="text-gray-400">—</span>
                      : inr(d.net_profit_per_km_inr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </Card>
  )
}
