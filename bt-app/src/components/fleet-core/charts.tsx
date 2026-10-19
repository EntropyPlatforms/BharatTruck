'use client'

/**
 * The dashboard's two charts.
 *
 * **Why these are hand-drawn SVG and not a chart library.** Two forms are needed here, both
 * simple, and the alternative costs more than it returns: Recharts is the natural pick (it is
 * what the shadcn chart registry wraps, and this app is already on shadcn), but it would add a
 * charting runtime to a PWA whose payload is already a tracked problem, and React 19 support
 * across that ecosystem is still uneven. Everything visual in this app is already drawn this
 * way — the cost ring is a conic gradient, the meters are divs — so SVG is also the idiom a
 * reader of this codebase expects. If the dashboard ever wants six chart types, revisit it:
 * the `--chart-*` tokens these components read are exactly the ones shadcn's charts consume,
 * so the swap is a re-render, not a redesign.
 *
 * Both charts follow the same rules as the rest of the page: colour encodes health rather than
 * category wherever a health reading exists, numbers are `tabular-nums`, nothing is drawn from
 * data that is not really there, and every chart carries a text equivalent — an `aria-label`
 * summary and, on the trend, a "Show numbers" table — so the chart is never the only way to
 * read the figure.
 */

import { useId, useState } from 'react'

import { inr, inrCompact } from '@/lib/format'
import { cx } from '@/lib/ui'
import type { DriverAnalytics, FleetBooking, VehicleAnalytics } from '@/lib/types'

/**
 * Only PAID trips count as revenue here, to match the tiles above the chart.
 *
 * The Revenue and Net profit tiles read bt-fleet-service's trip_economics row, which is written
 * when a booking reaches 'paid' and at no other point (economics.ts). An earlier version of this
 * chart also counted 'completed' and 'delivery_asserted', so a delivered-but-unpaid trip drew a
 * point here while the Revenue tile directly above still read ₹0 — two numbers on one screen
 * disagreeing about the same money. Unpaid delivered work is not lost: the "delivered but not
 * paid" alert carries it, which is the right place for money that is owed rather than earned.
 */
const EARNED: ReadonlySet<string> = new Set(['paid'])

export type TrendPoint = { label: string; value: number; trips: number }

/**
 * Buckets earned bookings into a short series — weekly for a 30-day window, monthly beyond it,
 * so the x axis never carries more labels than it can render honestly.
 *
 * This is a REAL series: every point is the sum of the trips whose pickup date falls in that
 * bucket. It is derived on the client only because no endpoint returns a per-day series; the
 * numbers are the same bookings the table below the chart lists.
 */
export function revenueSeries(bookings: FleetBooking[], days: number): TrendPoint[] {
  const monthly = days > 30
  const spanDays = monthly ? 30 : 7
  const spanMs = spanDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  const bucketCount = Math.max(1, Math.round(days / spanDays))

  // Each bucket owns an explicit [start, end) range and a trip is placed by comparing
  // against those ranges. An earlier version derived the LABEL from calendar months
  // (setMonth) but the INDEX from fixed 30-day windows — on any window longer than
  // 30 days those two disagree, because calendar months are 28-31 days, so a trip
  // could be labelled under one month and counted under its neighbour. One source of
  // truth for both now, at the cost of "30 days ending 7 Oct" rather than "October".
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const end = now - (bucketCount - 1 - i) * spanMs
    return {
      start: end - spanMs,
      end,
      label: new Date(end).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      value: 0,
      trips: 0,
    }
  })

  for (const b of bookings) {
    if (!EARNED.has(b.status)) continue
    const when = Date.parse(b.pickup_date ?? b.created_at ?? '')
    if (!Number.isFinite(when)) continue
    const bucket = buckets.find(k => when > k.start && when <= k.end)
    if (!bucket) continue
    // A booking with no price at all contributes a trip but no money, rather than NaN.
    const amount = b.final_price ?? b.quoted_price ?? 0
    bucket.value += Number.isFinite(amount) ? amount : 0
    bucket.trips += 1
  }

  return buckets.map(({ label, value, trips }) => ({ label, value, trips }))
}

const W = 720
const H = 200
const PAD = { top: 16, right: 12, bottom: 26, left: 48 }

/**
 * Revenue over time — one series, so no legend: the card's own title names it. A crosshair and
 * tooltip follow the pointer, the peak is direct-labelled, and the grid is recessive.
 */
export function RevenueTrend({ points }: { points: TrendPoint[] }) {
  const [active, setActive] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const gradientId = useId()

  const total = points.reduce((sum, p) => sum + p.value, 0)
  if (points.length < 2 || total <= 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-gray-500">
        Not enough completed trips yet to draw a trend.
      </p>
    )
  }

  const max = Math.max(...points.map(p => p.value))
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  // A flat series would divide by zero; it draws along the top of the plot instead.
  const y = (v: number) => PAD.top + (max <= 0 ? plotH : plotH - (v / max) * plotH)

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${PAD.top + plotH} L${x(0).toFixed(1)},${PAD.top + plotH} Z`

  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0)
  const ticks = [0, 0.5, 1]

  const summary = `Revenue by period: ${points.map(p => `${p.label} ${inr(p.value)}`).join(', ')}`

  return (
    <div className="px-5 pb-4">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto overflow-visible"
          role="img"
          aria-label={summary}
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid and y labels, deliberately recessive — they orient, they do not compete. */}
          {ticks.map(t => {
            const gy = PAD.top + plotH - t * plotH
            return (
              <g key={t}>
                <line
                  x1={PAD.left} y1={gy} x2={W - PAD.right} y2={gy}
                  stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke"
                />
                <text
                  x={PAD.left - 8} y={gy + 4} textAnchor="end"
                  className="fill-gray-400 text-[11px] tabular-nums"
                >
                  {inrCompact(max * t)}
                </text>
              </g>
            )
          })}

          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          />

          {points.map((p, i) => (
            <g key={p.label}>
              <text
                x={x(i)} y={H - 8} textAnchor="middle"
                className={cx('text-[11px]', active === i ? 'fill-gray-900 font-semibold' : 'fill-gray-500')}
              >
                {p.label}
              </text>
              {/* A 2px ring in the surface colour keeps the marker legible over the line. */}
              <circle
                cx={x(i)} cy={y(p.value)} r={active === i ? 6 : 4}
                fill="var(--chart-1)" stroke="var(--card)" strokeWidth="2"
              />
              {/* Hit target spans the whole column, not just the 8px marker. */}
              <rect
                x={x(i) - plotW / (points.length * 2)} y={PAD.top}
                width={plotW / points.length} height={plotH}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              />
            </g>
          ))}

          {active !== null && (
            <line
              x1={x(active)} y1={PAD.top} x2={x(active)} y2={PAD.top + plotH}
              stroke="var(--chart-1)" strokeWidth="1" strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke" pointerEvents="none"
            />
          )}

          {/* The peak is the one point worth naming without a hover. */}
          {active === null && points[peak].value > 0 && (
            <text
              x={x(peak)} y={y(points[peak].value) - 12} textAnchor="middle"
              className="fill-gray-900 text-[11px] font-bold tabular-nums"
            >
              {inrCompact(points[peak].value)}
            </text>
          )}
        </svg>

        {active !== null && (
          <div
            // `ink` never flips (it is the app's fixed tooltip/dark-text token), which leaves it
            // within a few points of the dark card surface — hence the hairline, so the tooltip
            // still has an edge in dark mode without forking the token.
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border border-white/15 bg-ink px-2.5 py-1.5 text-center shadow-lg"
            style={{ left: `${(x(active) / W) * 100}%`, top: `${(y(points[active].value) / H) * 100 - 4}%` }}
          >
            <div className="text-[11px] font-medium text-[#fff]/70">{points[active].label}</div>
            <div className="text-sm font-bold tabular-nums text-[#fff]">{inr(points[active].value)}</div>
            <div className="text-[11px] text-[#fff]/70 tabular-nums">
              {points[active].trips} {points[active].trips === 1 ? 'trip' : 'trips'}
            </div>
          </div>
        )}
      </div>

      {/* The text equivalent: the same numbers, for a screen reader, a print-out, or anyone who
          would simply rather read them. */}
      <button
        type="button"
        onClick={() => setShowTable(v => !v)}
        className="mt-1 text-xs font-semibold text-blue-700 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        aria-expanded={showTable}
      >
        {showTable ? 'Hide numbers' : 'Show numbers'}
      </button>
      {showTable && (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th scope="col" className="py-1 font-medium">Period</th>
              <th scope="col" className="py-1 text-right font-medium">Trips</th>
              <th scope="col" className="py-1 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {points.map(p => (
              <tr key={p.label} className="border-t border-gray-100">
                <td className="py-1.5 text-gray-700">{p.label}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-600">{p.trips}</td>
                <td className="py-1.5 text-right tabular-nums font-medium text-gray-900">{inr(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

type BarRow = {
  key: string
  /** The entity's own name — an RC number or a driver's name. */
  label: string
  value: number
  trips: number
  /** Health, in this row's own words: "Clears EMI" / "Short of EMI", "Profitable" / "Losing". */
  verdict: string
  healthy: boolean
  mono?: boolean
}

/**
 * Bars diverging from a zero line, worst last.
 *
 * Divergence rather than length-from-left because an asset can LOSE money, and a loss has to
 * read as a loss rather than as a short bar. Colour is the health verdict the rest of the page
 * uses (emerald good, red bad), never one hue per row: across ten rows a categorical palette
 * would say nothing, while this says which rows are the problem at a glance.
 */
function DivergingBars({ rows, total, empty }: { rows: BarRow[]; total: number; empty: string }) {
  const [active, setActive] = useState<string | null>(null)

  if (rows.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-gray-500">{empty}</p>
  }

  // One scale either side of zero, so a ₹1L profit and a ₹1L loss draw the same length.
  const extent = Math.max(...rows.map(r => Math.abs(r.value)), 1)
  const widthPct = (value: number) => (Math.abs(value) / extent) * 50

  return (
    <div className="px-5 pb-4">
      <ul className="space-y-2.5">
        {rows.map(r => {
          const positive = r.value >= 0
          const w = widthPct(r.value)
          return (
            <li key={r.key} onMouseEnter={() => setActive(r.key)} onMouseLeave={() => setActive(null)}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className={cx('font-semibold text-gray-900 truncate', r.mono && 'font-mono')}>{r.label}</span>
                <span className={cx('tabular-nums font-semibold', positive ? 'text-emerald-600' : 'text-red-600')}>
                  {positive ? '+' : '−'}{inrCompact(Math.abs(r.value))}
                </span>
              </div>
              <div
                className="relative mt-1 h-5 rounded bg-gray-50"
                role="img"
                aria-label={`${r.label}: ${positive ? 'profit' : 'loss'} ${inr(Math.abs(r.value))} over ${r.trips} ${r.trips === 1 ? 'trip' : 'trips'}, ${r.verdict}`}
              >
                {/* The zero line is the chart's spine — every bar is read against it. */}
                <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
                <div
                  className={cx(
                    'absolute inset-y-0 transition-[width,opacity] duration-300',
                    positive ? 'left-1/2 rounded-r' : 'right-1/2 rounded-l',
                    r.healthy ? 'bg-emerald-500' : 'bg-red-500',
                    active && active !== r.key ? 'opacity-40' : 'opacity-100',
                  )}
                  style={{ width: `${w}%` }}
                />
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[0.6875rem] text-gray-500">
                <span className="tabular-nums">{r.trips} {r.trips === 1 ? 'trip' : 'trips'}</span>
                <span className={r.healthy ? 'text-emerald-700' : 'text-red-600 font-semibold'}>{r.verdict}</span>
              </div>
            </li>
          )
        })}
      </ul>
      {total > rows.length && (
        <p className="mt-3 text-xs text-gray-500">Showing the top {rows.length} of {total} by profit.</p>
      )}
    </div>
  )
}

/** Net profit per truck — the 20-second answer to "which truck is causing it". */
export function ProfitByTruck({ vehicles }: { vehicles: VehicleAnalytics[] }) {
  const ran = vehicles.filter(v => v.trips > 0)
  const rows: BarRow[] = [...ran]
    .sort((a, b) => b.score.surplus_inr - a.score.surplus_inr)
    .slice(0, 8)
    .map(v => ({
      key: v.vehicle_id,
      label: v.rc_number,
      value: v.score.surplus_inr,
      trips: v.trips,
      verdict: v.score.covered ? 'Clears EMI' : 'Short of EMI',
      healthy: v.score.covered,
      mono: true,
    }))
  return <DivergingBars rows={rows} total={ran.length} empty="No truck has completed a trip in this period yet." />
}

/**
 * Net profit per driver — the same question asked of the other half of the fleet.
 *
 * `/fleet/analytics/drivers` has been deployed and typed all along and nothing rendered it, so
 * an owner could see which TRUCK lost money but never which DRIVER. There is no EMI to clear
 * here, so health is simply whether the driver's trips made money after their allocated wage.
 */
export function ProfitByDriver({ drivers }: { drivers: DriverAnalytics[] }) {
  const ran = drivers.filter(d => d.trips > 0)
  const rows: BarRow[] = [...ran]
    .sort((a, b) => b.net_profit_inr - a.net_profit_inr)
    .slice(0, 8)
    .map(d => ({
      key: d.driver_id,
      label: d.full_name ?? 'Unnamed driver',
      value: d.net_profit_inr,
      trips: d.trips,
      verdict: d.low_sample ? 'Few trips — rough' : d.net_profit_inr >= 0 ? 'Profitable' : 'Losing money',
      healthy: d.net_profit_inr >= 0,
    }))
  return <DivergingBars rows={rows} total={ran.length} empty="No driver has completed a trip in this period yet." />
}
