'use client'

/**
 * (i) beside the quoted price — the rough working behind the number, only on request.
 *
 * Opens across the full width of the price row (the caller positions it), so it never runs off
 * a narrow card.
 *
 * The indicative rate in three lines that add up to it exactly (founder brief, 29 Oct 2026):
 * operating cost of the trip (truck running, driver & helper, tolls, handling), the fleet
 * operator's margin, and the market correction. Quotes made before the trip estimate existed fall
 * back to the older rough split (fuel / driver / the rest).
 */

import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

import { inr } from '@/lib/format'
import type { PriceQuote } from '@/lib/types'

export type RoughLine = { label: string; hint: string; amount: number }

const round50 = (n: number) => Math.round(n / 50) * 50

/** Pure: the indicative rate's lines, summing to Math.round(quoted_price). */
export function roughQuoteLines(q: PriceQuote): RoughLine[] {
  const total = Math.round(q.quoted_price)
  if (!Number.isFinite(total) || total <= 0) return []
  const e = q.trip_estimate
  if (e && e.shipper_indicative === total) {
    const crew = e.crew.driver_salary + e.crew.helper_salary + e.crew.allowance
    const km = Math.round(e.distance_km).toLocaleString('en-IN')
    return [
      {
        label: 'Operating cost',
        hint: `${km} km in a ${e.model_category}: truck running ${inr(e.operating.total)}, ${e.crew.has_helper ? 'driver & helper' : 'driver'} ${inr(crew)}, tolls ${inr(e.tolls.amount)}, handling ${inr(e.handling)}`,
        amount: e.trip_cost,
      },
      { label: `Fleet operator margin (${e.carrier_return_pct}%)`, hint: 'the carrier\'s return on the trip cost', amount: e.carrier_return },
      { label: `Market correction (×${e.market_correction})`, hint: 'keeps the rate fair to both sides of the market', amount: e.market_correction_amount },
    ]
  }
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
    // Not "relative": the panel anchors to the price row (the caller makes it relative), so it
    // spans the whole price card instead of starting at the (i) and running off the edge.
    <div ref={box}>
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
        <div role="dialog" aria-label="Rough working of the price" className="absolute inset-x-0 top-full z-20 mt-1.5 rounded-xl border border-gray-200 bg-white p-3.5 shadow-lg">
          <p className="text-xs font-semibold text-gray-900">{quote.trip_estimate ? 'How the indicative rate is built' : 'Roughly where the price goes'}</p>
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
            <span className="text-xs font-semibold text-gray-900">{quote.trip_estimate ? 'Indicative rate' : 'Your price'}</span>
            <span className="text-sm font-bold text-gray-900 tabular-nums">{inr(total)}</span>
          </div>
          <p className="mt-2 text-[11px] text-gray-400">{quote.trip_estimate ? 'Estimated from the truck type, the route and its tolls. The price you pay is the figure above.' : 'Rounded, indicative split. The price you pay is the figure above.'}</p>
        </div>
      )}
    </div>
  )
}
