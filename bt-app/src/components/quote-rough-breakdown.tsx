'use client'

/**
 * (i) beside the quoted price — the rough working behind the number, only on request.
 *
 * Three round lines that add up to the quote exactly: fuel, driver, and "running, tolls &
 * handling". The platform's share is part of the third line, never a line of its own, and there
 * is no cost floor, market rate or margin here — one price, and roughly where it goes. The
 * engine's fuel and driver figures are used where they are sane; otherwise the lines fall back
 * to typical shares so the panel never shows a negative or an absurd split.
 */

import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

import { inr } from '@/lib/format'
import type { PriceQuote } from '@/lib/types'

export type RoughLine = { label: string; hint: string; amount: number }

const round50 = (n: number) => Math.round(n / 50) * 50

/** Pure: the three lines, summing to Math.round(quoted_price). */
export function roughQuoteLines(q: PriceQuote): RoughLine[] {
  const total = Math.round(q.quoted_price)
  if (!Number.isFinite(total) || total <= 0) return []
  const b = q.breakdown
  const km = b?.distance_km != null && Number.isFinite(b.distance_km) ? Math.round(b.distance_km) : null
  const fuelIn = Number(b?.fuel_cost)
  const driverIn = Number(b?.driver_wage)
  // Typical shares when the engine's figures are missing or do not fit inside the quote.
  let fuel = Number.isFinite(fuelIn) && fuelIn > 0 ? fuelIn : total * 0.45
  let driver = Number.isFinite(driverIn) && driverIn > 0 ? driverIn : total * 0.15
  // Keep at least 15% for everything else, so the third line is never tiny or negative.
  const cap = total * 0.85
  if (fuel + driver > cap) {
    const s = cap / (fuel + driver)
    fuel *= s
    driver *= s
  }
  fuel = round50(fuel)
  driver = round50(driver)
  const rest = total - fuel - driver
  return [
    { label: 'Fuel', hint: km ? `${km.toLocaleString('en-IN')} km, both ways considered` : 'for the trip', amount: fuel },
    { label: 'Driver', hint: 'wages and allowances for the trip', amount: driver },
    { label: 'Running, tolls & handling', hint: 'maintenance, tolls, loading, paperwork, service', amount: rest },
  ]
}

export default function QuoteRoughBreakdown({ quote }: { quote: PriceQuote }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const lines = roughQuoteLines(quote)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  if (lines.length === 0) return null
  const total = lines.reduce((s, l) => s + l.amount, 0)

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label="How this price is worked out"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <Info className="w-4 h-4" />
      </button>
      {open && (
        <div role="dialog" aria-label="Rough working of the price" className="absolute left-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-gray-200 bg-white p-3.5 shadow-lg">
          <p className="text-xs font-semibold text-gray-900">Roughly where the price goes</p>
          <dl className="mt-2 space-y-1.5">
            {lines.map((l) => (
              <div key={l.label} className="flex items-start justify-between gap-3">
                <dt className="text-xs text-gray-700">
                  {l.label}
                  <span className="block text-[11px] text-gray-400">{l.hint}</span>
                </dt>
                <dd className="text-xs font-medium text-gray-900 tabular-nums whitespace-nowrap">{inr(l.amount)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
            <span className="text-xs font-semibold text-gray-900">Your price</span>
            <span className="text-sm font-bold text-gray-900 tabular-nums">{inr(total)}</span>
          </div>
          <p className="mt-2 text-[11px] text-gray-400">Rounded, indicative split. The price you pay is the figure above.</p>
        </div>
      )}
    </div>
  )
}
