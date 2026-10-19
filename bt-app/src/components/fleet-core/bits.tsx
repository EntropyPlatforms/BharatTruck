'use client'

import type { ReactNode } from 'react'
import { Truck } from 'lucide-react'

import { cx } from '@/lib/ui'

/** A small tinted truck tile — stands in for the truck photos the references draw (none exist). */
export function TruckTile({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const box =
    size === 'lg' ? 'w-16 h-16 rounded-2xl [&_svg]:w-8 [&_svg]:h-8'
    : size === 'sm' ? 'w-8 h-8 rounded-lg [&_svg]:w-4 [&_svg]:h-4'
    : 'w-10 h-10 rounded-xl [&_svg]:w-5 [&_svg]:h-5'
  return (
    <span className={cx(box, 'bg-blue-50 text-blue-600 ring-1 ring-inset ring-blue-100 inline-flex items-center justify-center shrink-0')} aria-hidden>
      <Truck />
    </span>
  )
}

/** Bar colour by health, the same thresholds as the shared Meter. */
export function meterColour(pct: number): string {
  return pct >= 75 ? 'bg-emerald-500' : pct >= 50 ? 'bg-blue-600' : pct >= 30 ? 'bg-amber-500' : 'bg-red-500'
}

/**
 * Inline meter for table cells: the bar with its percentage beside it, and a caption
 * ("7,800 / 10,000 km") under it. `pct` null reads as a dash, never as zero.
 */
export function InlineMeter({ pct, caption, className = '' }: { pct: number | null; caption?: ReactNode; className?: string }) {
  if (pct === null || Number.isNaN(pct)) {
    return <span className="text-sm text-gray-400">—</span>
  }
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className={className}>
      <div className="flex items-center gap-2.5">
        <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden min-w-[3rem]">
          <div className={cx('h-2 rounded-full', meterColour(clamped))} style={{ width: `${clamped}%` }} />
        </div>
        <span className="text-xs font-bold text-gray-900 tabular-nums w-9 text-right">{clamped.toFixed(0)}%</span>
      </div>
      {caption && <div className="mt-1 text-xs text-gray-500 tabular-nums">{caption}</div>}
    </div>
  )
}

/** A choice-chip group that sets the same value a <select> would. */
export function ChipGroup<T extends string>({
  id, label, value, options, onChange, invalid = false, className = '',
}: {
  id: string
  label: string
  value: string
  options: { value: T | ''; label: string }[]
  onChange: (value: string) => void
  invalid?: boolean
  className?: string
}) {
  return (
    <fieldset className={className}>
      <legend id={`${id}-label`} className="block text-sm font-medium text-gray-700 mb-1.5">{label}</legend>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        className={cx('flex flex-wrap gap-1.5 rounded-[10px]', invalid && 'ring-2 ring-red-200 p-1')}
      >
        {options.map(option => {
          const on = option.value === value
          return (
            <button
              key={option.value || 'none'}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(option.value)}
              className={cx(
                'h-9 px-3 rounded-lg border text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1',
                on
                  ? 'border-blue-600 bg-blue-50 text-blue-700 font-semibold'
                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
