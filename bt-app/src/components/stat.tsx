'use client'

import type { ReactNode } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Info, Inbox } from 'lucide-react'

import { SURFACE, TINT, WASH, pill, type Tint } from '@/lib/ui'

/**
 * Shared primitives for the 2026-10 light redesign: white cards with a hairline border,
 * 16px radius and a soft lift, tinted icon tiles (KPI cards carry a wash of the same
 * tint), soft bordered pills, Marigold spinners.
 */

/**
 * InfoDot — a small ⓘ beside a term that, on hover, reveals a SINGLE PHRASE. No page
 * carries paragraph help; anything a user might not grasp at a glance gets one of these.
 */
export function InfoDot({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`group relative inline-flex items-center align-middle ${className}`}>
      <Info className="w-4 h-4 text-blue-500/70 hover:text-blue-600 cursor-help transition-colors" aria-hidden />
      <span className="sr-only">{text}</span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full z-30 mb-2 w-max max-w-[240px] -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium normal-case leading-snug tracking-normal text-center text-[#fff] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}

/** A rounded square holding an icon, tinted by meaning. Used by Stat, CardHead and lists. */
export function IconTile({ icon, tint = 'blue', size = 'md' }: { icon: ReactNode; tint?: Tint; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-12 h-12 rounded-2xl ring-1 ring-white shadow-[0_2px_6px_rgba(20,24,31,0.06)] [&_svg]:!w-6 [&_svg]:!h-6' : size === 'sm' ? 'w-8 h-8 rounded-lg' : 'w-10 h-10 rounded-xl'
  return (
    <span className={`${box} ${TINT[tint]} inline-flex items-center justify-center shrink-0 [&_svg]:w-5 [&_svg]:h-5`}>
      {icon}
    </span>
  )
}

const TONE_TINT: Record<'neutral' | 'good' | 'bad' | 'warn', Tint> = {
  neutral: 'blue', good: 'green', bad: 'red', warn: 'amber',
}

/**
 * The KPI tile: tinted icon tile on the left, label, a big number, one sub line.
 * `tone` colours the value (and, by default, the icon tile and sub line);
 * pass `tint` to colour the icon tile independently of the value.
 */
export function Stat({
  label, value, sub, tone = 'neutral', icon, info, tint,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'neutral' | 'good' | 'bad' | 'warn'
  icon?: ReactNode
  /** One-phrase hover hint for a term that isn't self-explanatory. */
  info?: string
  tint?: Tint
}) {
  const valueTone =
    tone === 'good' ? 'text-emerald-600'
    : tone === 'bad' ? 'text-red-600'
    : tone === 'warn' ? 'text-amber-600'
    : 'text-gray-900'
  const subTone =
    tone === 'warn' ? 'text-amber-700'
    : tone === 'bad' ? 'text-red-600'
    : 'text-gray-500'

  return (
    <div className={`${SURFACE} bg-gradient-to-br ${WASH[tint ?? TONE_TINT[tone]]} via-white to-white p-4 flex items-start gap-3.5 min-w-0`}>
      {icon && <IconTile icon={icon} tint={tint ?? TONE_TINT[tone]} size="lg" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-600 inline-flex items-center gap-1.5">
          {label}
          {info && <InfoDot text={info} />}
        </div>
        <div className={`mt-1 text-[1.625rem] leading-tight font-bold tabular-nums tracking-tight ${valueTone}`}>{value}</div>
        {sub && <div className={`mt-1 text-xs ${subTone}`}>{sub}</div>}
      </div>
    </div>
  )
}

/** Signed delta chip — green up, red down. */
export function Delta({ value, suffix = '' }: { value: number | null; suffix?: string }) {
  if (value === null || Number.isNaN(value)) return <span className="text-gray-400">—</span>
  const good = value >= 0
  const Icon = good ? ArrowUpRight : ArrowDownRight
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold ${good ? 'text-emerald-600' : 'text-red-600'}`}>
      <Icon className="w-3.5 h-3.5" />
      {Math.abs(value).toFixed(1)}{suffix}
    </span>
  )
}

/**
 * Horizontal meter for the three utilisation views. Colour encodes health, not
 * category: under 50% is a problem worth seeing at a glance.
 */
export function Meter({ pct, label }: { pct: number | null; label?: string }) {
  if (pct === null || Number.isNaN(pct)) {
    return <div className="text-sm text-gray-400">Not enough data</div>
  }
  const clamped = Math.max(0, Math.min(100, pct))
  const bar =
    clamped >= 75 ? 'bg-emerald-500'
    : clamped >= 50 ? 'bg-blue-600'
    : clamped >= 30 ? 'bg-amber-500'
    : 'bg-red-500'

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        {label && <span className="text-xs text-gray-500">{label}</span>}
        <span className="text-sm font-bold text-gray-900 tabular-nums">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${bar} transition-[width] duration-500`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

/** "Clears EMI" / "Short" — the headline verdict for one asset. */
export function CoverPill({ covered }: { covered: boolean }) {
  return <span className={pill(covered ? 'green' : 'red')}>{covered ? 'Clears EMI' : 'Short'}</span>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`${SURFACE} ${className}`}>{children}</div>
  )
}

/**
 * Card header: optional tinted icon tile, a title, a grey sub line, an ⓘ hint and
 * right-aligned actions. Matches the "Fleet register" / "Utilisation" headers.
 */
export function CardHead({
  title, sub, actions, info, icon, tint = 'blue',
}: { title: ReactNode; sub?: string; actions?: ReactNode; info?: string; icon?: ReactNode; tint?: Tint }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
      <div className="min-w-0 flex items-start gap-3">
        {icon && <IconTile icon={icon} tint={tint} />}
        <div className="min-w-0">
          <h2 className="text-[1.0625rem] font-extrabold tracking-tight text-gray-900 inline-flex items-center gap-1.5">
            {title}
            {info && <InfoDot text={info} />}
          </h2>
          {sub && <p className="text-sm text-gray-500 mt-0.5">{sub}</p>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Empty state: a quiet line icon, a bold title, a hint and an optional action. `art` swaps
 * the icon for the road illustration — for a page's MAIN empty state, not small in-card ones.
 */
export function Empty({ title, hint, icon, action, art }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode; art?: boolean }) {
  return (
    <div className={`text-center px-4 flex flex-col items-center ${art ? 'py-8' : 'py-12'}`}>
      {art ? (
        // One drawing per theme; the hidden one is not downloaded (display: none + lazy).
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative, fixed-size, lazy */}
          <img src="/images/empty-road.webp" alt="" loading="lazy" width={420} height={209} className="mb-2 w-full max-w-[26rem] select-none dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative, fixed-size, lazy */}
          <img src="/images/empty-road-dark.webp" alt="" loading="lazy" width={420} height={209} className="mb-2 hidden w-full max-w-[26rem] select-none dark:block" />
        </>
      ) : (
        <span className="w-12 h-12 rounded-2xl bg-gray-100 text-gray-400 inline-flex items-center justify-center mb-3 [&_svg]:w-6 [&_svg]:h-6">
          {icon ?? <Inbox />}
        </span>
      )}
      <p className="text-base font-bold text-gray-900">{title}</p>
      {hint && <p className="text-sm text-gray-500 mt-1 max-w-md">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-gray-500">
      <span className="w-5 h-5 border-[2.5px] border-brand-500 border-t-transparent rounded-full animate-spin" />
      {label}
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2.5">
      <AlertCircle className="w-4.5 h-4.5 mt-0.5 shrink-0 text-red-600" />
      <span>{message}</span>
    </div>
  )
}

/** Amber notice strip: GST-needed, low-sample, partial-data and similar warnings. */
export function WarnBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-3">
      <span className="w-6 h-6 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold text-sm">!</span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
