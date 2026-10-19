'use client'

import { useEffect, useId, type ReactNode } from 'react'
import { ArrowRight, X } from 'lucide-react'

import { cx } from '@/lib/ui'

/**
 * Small presentational pieces shared by the fleet-ops screens (Drivers, Find Work,
 * Trips, Deliveries, Utilisation, Fuel) in the 2026-10 light redesign. Pure markup —
 * no data fetching, no state beyond the dialog's Escape key.
 */

/** Table header / cell / row classes, so the six screens' tables read as one system. */
export const TH = 'py-2.5 px-4 text-left text-xs font-semibold text-gray-500 whitespace-nowrap'
export const TD = 'py-3 px-4 text-sm align-middle'
export const TR = 'border-b border-gray-100 last:border-b-0 hover:bg-gray-50/70 transition-colors'
export const THEAD_ROW = 'border-b border-gray-200 bg-gray-50/70'

/** "+919876543210" → "+91 98765 43210"; anything else is returned untouched. */
export function fmtPhone(p: string | null | undefined): string | null {
  if (!p) return null
  const m = p.replace(/\s+/g, '').match(/^\+91(\d{5})(\d{5})$/)
  return m ? `+91 ${m[1]} ${m[2]}` : p
}

const AVATAR_TONES = [
  'bg-blue-50 text-blue-700 ring-blue-100',
  'bg-emerald-50 text-emerald-700 ring-emerald-100',
  'bg-amber-50 text-amber-700 ring-amber-100',
  'bg-violet-50 text-violet-700 ring-violet-100',
  'bg-teal-50 text-teal-700 ring-teal-100',
  'bg-orange-50 text-orange-700 ring-orange-100',
]

/** Initials in a soft circle — never a stock photo. Tone is stable per name. */
export function Avatar({ name, size = 'md', muted = false }: { name: string | null; size?: 'sm' | 'md' | 'lg'; muted?: boolean }) {
  const clean = (name ?? '').trim()
  const parts = clean.split(/\s+/).filter(Boolean)
  const initials = parts.length === 0 ? '?' : (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
  let h = 0
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const tone = muted ? 'bg-gray-100 text-gray-500 ring-gray-200' : AVATAR_TONES[h % AVATAR_TONES.length]
  const box = size === 'lg' ? 'w-11 h-11 text-sm' : size === 'sm' ? 'w-7 h-7 text-[0.6875rem]' : 'w-9 h-9 text-xs'
  return (
    <span aria-hidden className={cx('inline-flex items-center justify-center rounded-full font-bold ring-1 shrink-0', box, tone)}>
      {initials}
    </span>
  )
}

/** "Source → Destination" on one line, each end truncating on its own. */
export function RouteLine({
  from, to, className = '', max = 'max-w-[180px]',
}: { from: string; to: string; className?: string; max?: string }) {
  return (
    <span className={cx('flex items-center gap-1.5 min-w-0', className)}>
      <span className={cx('truncate', max)} title={from}>{from}</span>
      <ArrowRight className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
      <span className={cx('truncate', max)} title={to}>{to}</span>
    </span>
  )
}

/**
 * The fleet-ops dialog: a white panel with a bold title, an optional grey sub line and a
 * close button. Slides up as a sheet on phones, centred on larger screens.
 */
export function Modal({
  title, sub, onClose, children, width = 'sm:max-w-md',
}: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; width?: string }) {
  const titleId = useId()
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px] cursor-default" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'relative w-full bg-white rounded-t-2xl sm:rounded-2xl border border-gray-200 shadow-2xl max-h-[92vh] overflow-y-auto',
          width,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 sticky top-0 bg-white z-10">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-gray-900 leading-snug">{title}</h2>
            {sub && <p className="text-sm text-gray-500 mt-0.5">{sub}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 sm:px-6 pb-5 sm:pb-6">{children}</div>
      </div>
    </div>
  )
}

/** A thin vertical rule used between grouped table columns. */
export const COL_RULE = 'border-l border-gray-100'
