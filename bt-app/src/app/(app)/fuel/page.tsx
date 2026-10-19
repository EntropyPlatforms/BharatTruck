'use client'

// Fuel — modelled diesel spend vs what the driver actually filled.
//
// The single number this page exists to produce is the variance, and the single
// way to get it wrong is to show it confidently when nobody has entered a fuel
// bill. So the sign convention and the coverage caveat are both load-bearing:
//
//   bt-fleet-service/src/lib/analytics.ts → fuelComparison()
//     withActuals = rows.filter(r => r.fuel_cost_actual_inr != null)
//     estimated   = Σ fuel_cost_est_inr    OVER withActuals ONLY
//     actual      = Σ fuel_cost_actual_inr OVER withActuals ONLY
//     variance    = actual - estimated          ← POSITIVE means OVERSPEND (bad)
//     variance_pct = variance / estimated × 100 ← null when estimated is 0
//
// Two consequences the UI must respect:
//
//  1. Both columns cover the SAME trips. `estimated_inr` is not the fleet's whole
//     modelled diesel bill — it is the modelled cost of exactly those trips that
//     have an actual, so a fleet with one fuel entry is not shown as spending 3%
//     of what it should.
//  2. With trips_with_actuals === 0 every figure collapses to a clean ₹0 and the
//     variance is meaningless, not zero. That is the likely live state today
//     (actuals come from driver-side trip_expenses rows), so this page refuses to
//     render ₹0 variance and says why instead.
//
// by_vehicle is keyed off `withActuals` too, so a truck with no fuel entry in the
// window is ABSENT from the table rather than present with a flattering ₹0 gap.
// The zero-actuals branch below is defensive only.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  CalendarDays, ChartColumn, FileText, Fuel, Percent, Truck, TrendingDown, TrendingUp,
} from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, IconTile, Loading, Stat } from '@/components/stat'
import { TD, TH, THEAD_ROW } from '@/components/fleet-ops/bits'
import { ApiError, getFuelComparison } from '@/lib/api'
import { inr, inrCompact, inrSigned, pct, periodDays, shortDate } from '@/lib/format'
import type { FuelComparison } from '@/lib/types'
import { MONO, SEG_OFF, SEG_ON, SEG_WRAP, cx } from '@/lib/ui'

const PERIOD_OPTIONS = [30, 90, 180] as const
type PeriodChoice = (typeof PERIOD_OPTIONS)[number]

type VehicleRow = FuelComparison['by_vehicle'][number]

/** Positive variance = actual above model = money leaking. */
function varianceTone(variance: number): 'good' | 'bad' | 'neutral' {
  if (variance > 0) return 'bad'
  if (variance < 0) return 'good'
  return 'neutral'
}

function varianceText(variance: number): string {
  if (variance > 0) return 'text-red-600'
  if (variance < 0) return 'text-emerald-700'
  return 'text-gray-900'
}

/** "+₹14.2K" — the compact signed label at the end of a gap bar. */
function compactSigned(n: number): string {
  if (n === 0) return inrCompact(0)
  return `${n > 0 ? '+' : '−'}${inrCompact(Math.abs(n))}`
}

export default function FuelPage() {
  const [days, setDays] = useState<PeriodChoice>(30)
  const [data, setData] = useState<FuelComparison | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Kick off only; every setState lands in a callback so the period buttons own
  // the loading/error transition (same pattern as the dashboard).
  useEffect(() => {
    let cancelled = false

    getFuelComparison(periodDays(days))
      .then(result => { if (!cancelled) setData(result) })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load the fuel report')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [days])

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
      {data && (
        <span className="inline-flex items-center gap-2 h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700">
          <CalendarDays className="w-4 h-4 text-gray-500" />
          {shortDate(data.period.from)} – {shortDate(data.period.to)}
        </span>
      )}
    </div>
  )

  const header = (
    <PageHeader
      title="Fuel"
      subtitle={`Modelled vs actual diesel — last ${days} days`}
      actions={switcher}
    />
  )

  if (loading && !data) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Loading label="Comparing modelled diesel against fuel entries" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <ErrorNote message={error} />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Card>
          <Empty
            title="No fuel report for this window"
            hint="Complete a trip to start modelling its diesel cost."
            icon={<Fuel />}
          />
        </Card>
      </div>
    )
  }

  const covered = data.trips_with_actuals > 0
  const coveragePct = data.trips > 0 ? (data.trips_with_actuals / data.trips) * 100 : null

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      {header}

      {/* A failed refetch keeps the previous period on screen. */}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {/* 1 — the four numbers. Every money tile goes blank without coverage,
            because ₹0 here would read as "the model was exactly right". */}
        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-4 gap-3 lg:gap-4">
          <Stat
            label="Estimated"
            value={covered ? inrCompact(data.estimated_inr) : '—'}
            sub={covered
              ? `Modelled diesel on the ${data.trips_with_actuals} compared ${data.trips_with_actuals === 1 ? 'trip' : 'trips'}`
              : 'Needs at least one fuel entry to compare'}
            icon={<Fuel />}
            tint="brand"
          />
          <Stat
            label="Actual"
            value={covered ? inrCompact(data.actual_inr) : '—'}
            sub={covered ? 'Summed from driver fuel entries' : 'No fuel entries recorded'}
            icon={<FileText />}
            tint="blue"
          />
          <Stat
            label="Variance"
            info="Actual − modelled diesel spend"
            value={covered ? inrSigned(data.variance_inr) : '—'}
            tone={covered ? varianceTone(data.variance_inr) : 'neutral'}
            sub={covered
              ? `${pct(data.variance_pct, 1)} ${data.variance_inr > 0 ? 'over model' : data.variance_inr < 0 ? 'under model' : 'against model'}`
              : 'Not measurable yet'}
            icon={data.variance_inr > 0
              ? <TrendingUp />
              : <TrendingDown />}
            tint={!covered ? 'slate' : data.variance_inr > 0 ? 'red' : data.variance_inr < 0 ? 'green' : 'slate'}
          />
          <Stat
            label="Coverage"
            value={`${data.trips_with_actuals} / ${data.trips}`}
            tone={covered ? 'neutral' : 'warn'}
            sub={data.trips === 0
              ? 'No completed trips in this window'
              : `${pct(coveragePct)} of trips have a fuel entry`}
            icon={<Percent />}
            tint={covered ? 'green' : 'amber'}
          />
        </div>

        {/* 2 — the caveat, or the comparison itself. */}
        <div className="mt-5">
          {covered
            ? <Comparison data={data} coveragePct={coveragePct} />
            : <NoActuals days={days} />}
        </div>

        {/* 3 — per truck, worst gap first. */}
        <div className="mt-5">
          <ByVehicle rows={data.by_vehicle} covered={covered} />
        </div>
      </div>
    </div>
  )
}

// ── No actuals: the likely live state ─────────────────────────

function NoActuals({ days }: { days: PeriodChoice }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 flex items-start gap-4">
      <span className="w-9 h-9 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold text-lg">!</span>
      <div className="min-w-0 pt-0.5">
        <h2 className="text-base font-bold text-amber-900">No fuel entries in the last {days} days</h2>
        <p className="mt-0.5 text-sm text-amber-900/80">Nothing to compare until a driver files a fuel entry against a completed trip.</p>
      </div>
    </div>
  )
}

// ── Estimated vs actual, side by side ─────────────────────────

function Comparison({ data, coveragePct }: { data: FuelComparison; coveragePct: number | null }) {
  const max = Math.max(data.estimated_inr, data.actual_inr, 1)
  const over = data.variance_inr > 0
  const without = Math.max(0, data.trips - data.trips_with_actuals)

  return (
    <Card className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex items-start gap-3 px-5 pt-5">
          <IconTile icon={<ChartColumn />} tint="blue" />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">Modelled vs actual</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Both bars cover the same {data.trips_with_actuals} {data.trips_with_actuals === 1 ? 'trip' : 'trips'} — the ones with a fuel entry
            </p>
          </div>
        </div>
        <div className="px-5 pb-5 pt-5">
          <div className="space-y-3.5">
            <BarRow
              label="Estimated"
              value={data.estimated_inr}
              share={(data.estimated_inr / max) * 100}
              color="bg-gray-400"
            />
            <BarRow
              label="Actual"
              value={data.actual_inr}
              share={(data.actual_inr / max) * 100}
              color={over ? 'bg-red-500' : 'bg-emerald-500'}
            />
          </div>

          <p className={`mt-5 text-sm font-medium ${over ? 'text-red-700' : 'text-emerald-800'}`}>
            Drivers filled{' '}
            <span className="font-bold tabular-nums">{inr(Math.abs(data.variance_inr))}</span>{' '}
            {over ? 'more' : 'less'} diesel than the model expected
            {data.variance_pct === null
              ? ''
              : <> — <span className="font-bold tabular-nums">{pct(Math.abs(data.variance_pct), 1)}</span>{' '}
                  {over ? 'above' : 'below'} estimate</>}
            .
          </p>
        </div>
      </div>

      {coveragePct !== null && (
        <div className="min-w-0 border-t lg:border-t-0 lg:border-l border-gray-100 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-gray-900">Trip coverage</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Trips with a driver fuel entry · {data.trips_with_actuals} of {data.trips} trips
              </p>
            </div>
            <span className="text-2xl font-bold text-gray-900 tabular-nums">{pct(coveragePct)}</span>
          </div>
          <div className="mt-3 h-2.5 rounded-full bg-gray-100 overflow-hidden" role="img" aria-label={`Trips with a driver fuel entry: ${pct(coveragePct)}`}>
            <div className="h-2.5 rounded-full bg-blue-600 transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, coveragePct))}%` }} />
          </div>
          <dl className="mt-3 divide-y divide-gray-100 text-sm">
            <div className="flex justify-between py-2"><dt className="text-gray-600">Trips with fuel entry</dt><dd className="font-semibold text-gray-900 tabular-nums">{data.trips_with_actuals}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-gray-600">Trips without fuel entry</dt><dd className="font-semibold text-gray-900 tabular-nums">{without}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-gray-600">Total trips</dt><dd className="font-semibold text-gray-900 tabular-nums">{data.trips}</dd></div>
          </dl>
        </div>
      )}
    </Card>
  )
}

function BarRow({
  label, value, share, color,
}: { label: string; value: number; share: number; color: string }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] sm:grid-cols-[88px_minmax(0,1fr)_96px] items-center gap-x-3 gap-y-1">
      <span className="text-sm text-gray-600">{label}</span>
      <div className="h-6 rounded-md bg-gray-100 overflow-hidden">
        <div
          className={`h-6 rounded-md ${color} transition-[width] duration-500`}
          style={{ width: `${Math.max(0, Math.min(100, share))}%` }}
        />
      </div>
      <span className="col-start-2 sm:col-start-auto text-sm font-bold text-gray-900 tabular-nums sm:text-right">{inr(value)}</span>
    </div>
  )
}

// ── Per truck ─────────────────────────────────────────────────

function ByVehicle({ rows, covered }: { rows: VehicleRow[]; covered: boolean }) {
  // Biggest gap first regardless of direction — an under-report of ₹40k is as
  // worth opening as an overspend of ₹40k. Trucks without an actual (which the
  // service does not currently emit) can never be ranked, so they sink.
  const sorted = [...rows].sort((a, b) => {
    const aHas = a.trips_with_actuals > 0
    const bHas = b.trips_with_actuals > 0
    if (aHas !== bHas) return aHas ? -1 : 1
    return Math.abs(b.variance_inr) - Math.abs(a.variance_inr)
  })

  const comparable = sorted.filter(v => v.trips_with_actuals > 0)
  const maxAbs = comparable.reduce((m, v) => Math.max(m, Math.abs(v.variance_inr)), 0)
  const overspending = comparable.filter(v => v.variance_inr > 0).length

  return (
    <Card>
      <CardHead
        title="Gap by truck"
        icon={<Truck />}
        sub={comparable.length === 0
          ? 'Only trucks with a fuel entry appear here'
          : `${comparable.length} ${comparable.length === 1 ? 'truck' : 'trucks'} comparable — ${overspending} over model. Biggest gap first.`}
        actions={
          <div className="hidden sm:flex items-center gap-4 text-sm text-gray-600">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500" /> Over model</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-emerald-500" /> Under model</span>
          </div>
        }
      />

      {sorted.length === 0 ? (
        <Empty title={covered ? 'No truck-level gaps to show' : 'No truck has a fuel entry in this window'} icon={<Truck />} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className={THEAD_ROW}>
                <th className={TH}>Truck (RC number)</th>
                <th className={cx(TH, 'text-right')}>Estimated</th>
                <th className={cx(TH, 'text-right')}>Actual</th>
                <th className={cx(TH, 'text-right')}>Variance</th>
                <th className={cx(TH, 'text-right')}>Var %</th>
                <th className={cx(TH, 'text-center w-[260px]')}>Gap</th>
                <th className={cx(TH, 'text-right')}>Trips w/ entry</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(v => {
                const has = v.trips_with_actuals > 0
                return (
                  <tr
                    key={v.vehicle_id}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/70 transition-colors"
                  >
                    <td className={TD}>
                      <Link
                        href={`/vehicles/${v.vehicle_id}`}
                        className={cx(MONO, 'font-semibold', has ? 'text-blue-600 hover:text-blue-700' : 'text-gray-400 hover:text-gray-600')}
                      >
                        {v.rc_number || 'Unknown truck'}
                      </Link>
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums', has ? 'text-gray-600' : 'text-gray-400')}>
                      {has ? inr(v.estimated_inr) : '—'}
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums', has ? 'text-gray-900' : 'text-gray-400')}>
                      {has ? inr(v.actual_inr) : '—'}
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums font-semibold', has ? varianceText(v.variance_inr) : 'text-gray-400')}>
                      {has ? inrSigned(v.variance_inr) : '—'}
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums', has ? varianceText(v.variance_inr) : 'text-gray-400')}>
                      {has ? `${v.variance_pct !== null && v.variance_pct > 0 ? '+' : ''}${pct(v.variance_pct, 1)}` : '—'}
                    </td>
                    <td className={cx(TD, 'py-2')}>
                      {has
                        ? <GapBar value={v.variance_inr} max={maxAbs} />
                        : <NoEntry />}
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums', has ? 'text-gray-600' : 'text-gray-400')}>
                      {v.trips_with_actuals}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="sm:hidden px-4 py-3 border-t border-gray-100 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Over model</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Under model</span>
      </div>
    </Card>
  )
}

function NoEntry() {
  return (
    <div className="relative h-6 w-full min-w-[160px]">
      <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      <span className="absolute left-1/2 ml-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">No entry</span>
    </div>
  )
}

/** Diverging bar around a centre line: right/red is overspend, left/green is under. */
function GapBar({ value, max }: { value: number; max: number }) {
  // The bar may use up to 70% of each half so its value label fits beside it.
  const share = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0
  const half = (share / 100) * 35
  const over = value > 0
  return (
    <div className="relative h-6 w-full min-w-[160px]" role="img" aria-label={`Gap ${inrSigned(value)}`}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      <span
        className={cx('absolute top-1 bottom-1', over ? 'bg-red-500 rounded-r-[3px]' : 'bg-emerald-500 rounded-l-[3px]')}
        style={over
          ? { left: '50%', width: `${half}%` }
          : { right: '50%', width: `${half}%` }}
      />
      <span
        className={cx('absolute top-1/2 -translate-y-1/2 text-xs font-semibold tabular-nums whitespace-nowrap', over ? 'text-red-600' : 'text-emerald-700')}
        style={over
          ? { left: `calc(50% + ${half}% + 6px)` }
          : { right: `calc(50% + ${half}% + 6px)` }}
      >
        {compactSigned(value)}
      </span>
    </div>
  )
}
