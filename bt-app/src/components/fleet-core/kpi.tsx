'use client'

import type { ReactNode } from 'react'

import { Delta, IconTile, InfoDot } from '@/components/stat'
import { SURFACE, WASH, cx, type Tint } from '@/lib/ui'

/**
 * The dashboard's two tile sizes, which together carry its 5-second layer.
 *
 * The page used to run one six-up row of equal-weight `KpiTile`s, which gave the owner six
 * things to rank themselves. Since 2026-10-07 it runs a hierarchy instead: three
 * `HeadlineTile`s (net profit, revenue, fleet earning) over a quieter strip of `MiniStat`s
 * for the numbers that were demoted. Nothing else in the app consumes these, so the old
 * six-up tile was removed with the row it served rather than left behind unused.
 */

type Tone = 'neutral' | 'good' | 'bad' | 'warn'

/**
 * Beyond this, a percentage stops informing and starts looking like a bug. A fleet whose
 * first trips fall inside the comparison window really can post "+5,018%", and that is a
 * true number no owner can use — worse, it makes the tile beside it look untrustworthy too.
 */
const DELTA_CAP = 999

/**
 * A delta chip that admits when the change is off the scale instead of printing it.
 * Direction and the fact that it is enormous are both preserved; the spurious precision is
 * not. Capping lives here rather than in the shared `Delta` because this is the only caller
 * that knows the value is a percentage.
 */
function CappedDelta({ value }: { value: number }) {
  if (Math.abs(value) <= DELTA_CAP) return <Delta value={value} suffix="%" />
  const up = value > 0
  return (
    <span
      className={cx('inline-flex items-center gap-0.5 font-semibold', up ? 'text-emerald-600' : 'text-red-600')}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(value).toFixed(0)}% — the comparison period has too little activity to be meaningful`}
    >
      {up ? '↑' : '↓'}&gt;{DELTA_CAP}%
    </span>
  )
}

function valueTone(tone: Tone): string {
  return tone === 'good' ? 'text-emerald-600'
    : tone === 'bad' ? 'text-red-600'
    : tone === 'warn' ? 'text-amber-600'
    : 'text-gray-900'
}

/**
 * A headline number: label and tinted icon tile on top, the figure large underneath with
 * its period-over-period delta beside it, one sub line.
 *
 * `delta` is a percentage change against the preceding window of equal length, or null —
 * and null renders NOTHING rather than a `0%` or an em-dash, because an absent baseline
 * is not a flat quarter. The caller decides; this tile never invents one.
 */
export function HeadlineTile({
  label, value, sub, tone = 'neutral', icon, tint = 'blue', info, delta,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: Tone
  icon?: ReactNode
  tint?: Tint
  info?: string
  delta?: number | null
}) {
  return (
    <div className={cx(SURFACE, 'bg-gradient-to-br via-white to-white p-5 min-w-0 flex flex-col', WASH[tint])}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-gray-600 inline-flex items-center gap-1.5 min-w-0 pt-1">
          <span className="truncate">{label}</span>
          {info && <InfoDot text={info} />}
        </span>
        {icon && <IconTile icon={icon} tint={tint} size="lg" />}
      </div>
      <div className="mt-2 flex items-baseline gap-2.5 flex-wrap">
        <span className={cx('text-[2.125rem] leading-none font-extrabold tabular-nums tracking-tight', valueTone(tone))}>
          {value}
        </span>
        {delta !== null && delta !== undefined && (
          <span className="text-sm"><CappedDelta value={delta} /></span>
        )}
      </div>
      {sub && <div className="mt-2 text-xs leading-snug text-gray-500">{sub}</div>}
    </div>
  )
}

/**
 * A supporting number, one tier quieter than `HeadlineTile`: no icon tile, no wash, a
 * smaller figure. Used for the numbers that lost their place in the headline row but are
 * still worth a glance.
 */
export function MiniStat({
  label, value, sub, tone = 'neutral', icon,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: Tone
  icon?: ReactNode
}) {
  return (
    <div className={cx(SURFACE, 'px-4 py-3 min-w-0')}>
      <div className="text-xs font-medium text-gray-500 inline-flex items-center gap-1.5 min-w-0">
        {icon && <span className="text-gray-400 [&_svg]:w-3.5 [&_svg]:h-3.5 shrink-0">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className={cx('mt-0.5 text-lg leading-tight font-bold tabular-nums tracking-tight', valueTone(tone))}>
        {value}
      </div>
      {sub && <div className="text-[0.6875rem] leading-snug text-gray-500 truncate">{sub}</div>}
    </div>
  )
}
