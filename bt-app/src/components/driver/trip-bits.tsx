'use client'

/**
 * Small presentational pieces shared by the driver screens (My Trips, trip detail):
 * the copyable mono booking ID, the green→red route rail, and the city shortener.
 * Pure display — no API calls, no state beyond the "Copied" flash.
 */

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cx } from '@/lib/ui'

/** "MIDC Hingna, Nagpur" → "Nagpur". Falls back to the whole address. */
export function cityOf(address: string | null | undefined): string {
  if (!address) return '—'
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : address
}

/** Mono booking ID with a copy-to-clipboard button (44px hit area on touch). */
export function CopyId({ id, className = '', size = 'md' }: { id: string; className?: string; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable (insecure context) — the ID is still on screen */
    }
  }

  return (
    <span className={cx('inline-flex items-center gap-0.5 min-w-0', className)}>
      <span className={cx('font-mono tracking-wide text-gray-500 truncate', size === 'sm' ? 'text-[0.8125rem]' : 'text-[0.9375rem]')}>{id}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Booking ID copied' : `Copy booking ID ${id}`}
        className="relative z-10 -my-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
      </button>
    </span>
  )
}

/** Vertical pickup→drop rail: green dot, dashed line, red dot. Stretches to its parent. */
export function RouteRail({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden className={cx('flex flex-col items-center shrink-0 w-5', className)}>
      <span className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
      </span>
      <span className="flex-1 min-h-4 border-l-2 border-dashed border-gray-300 my-1" />
      <span className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
      </span>
    </span>
  )
}

/** "12.0 t" without the trailing ".0". */
export function tonnes(kg: number | null | undefined): string {
  if (kg == null || !Number.isFinite(kg)) return '—'
  const t = kg / 1000
  return `${Number.isInteger(t) ? t : t.toFixed(1)} t`
}

/** "fmcg" → "FMCG", "general" → "General". */
export function loadTypeLabel(s: string | null | undefined): string {
  if (!s) return '—'
  if (s.length <= 4) return s.toUpperCase()
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
}
