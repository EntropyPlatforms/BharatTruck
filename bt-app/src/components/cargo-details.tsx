'use client'

/**
 * Optional cargo details on Post a Load (18 Oct audit: "cargo size never asked", "expected
 * quantity can't be set"). Both feed things that already exist but stayed empty:
 *   - size → bookings.dimensions_json, which the fleet P&L reads for volume utilisation
 *     (a stated volume in cubic feet, else length × width × height in feet);
 *   - expected quantity → the server-held count the delivery check reconciles a shortage
 *     against (PATCH /bookings/:id/expected-quantity, shipper-only).
 * Everything here is optional; blank fields are simply not sent.
 */

import { INPUT, LABEL, cx } from '@/lib/ui'

export type CargoDetailsValue = {
  length_ft: string
  width_ft: string
  height_ft: string
  volume_cuft: string
  expected_quantity: string
  unit: string
}

export const EMPTY_CARGO_DETAILS: CargoDetailsValue = { length_ft: '', width_ft: '', height_ft: '', volume_cuft: '', expected_quantity: '', unit: 'boxes' }

const pos = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? n : null }

/** bookings.dimensions_json from the form, or undefined when nothing usable was entered. */
export function dimensionsJson(v: CargoDetailsValue): Record<string, number> | undefined {
  const volume = pos(v.volume_cuft)
  const l = pos(v.length_ft), w = pos(v.width_ft), h = pos(v.height_ft)
  const out: Record<string, number> = {}
  if (l && w && h) Object.assign(out, { length_ft: l, width_ft: w, height_ft: h })
  if (volume) out.volume_cuft = volume
  else if (l && w && h) out.volume_cuft = Math.round(l * w * h * 100) / 100
  return Object.keys(out).length ? out : undefined
}

/** The expected count, or null when not entered. Zero is allowed (nothing expected) but blank is not. */
export function expectedQuantity(v: CargoDetailsValue): { qty: number; unit: string } | null {
  if (v.expected_quantity.trim() === '') return null
  const n = Number(v.expected_quantity)
  if (!Number.isFinite(n) || n < 0) return null
  return { qty: n, unit: v.unit.trim() || 'units' }
}

const UNITS = ['boxes', 'bags', 'cartons', 'pallets', 'drums', 'pieces', 'units']

export default function CargoDetails({ value, onChange }: { value: CargoDetailsValue; onChange: (v: CargoDetailsValue) => void }) {
  const set = (k: keyof CargoDetailsValue, s: string) => onChange({ ...value, [k]: s })
  const num = (k: keyof CargoDetailsValue) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value.replace(/[^\d.]/g, '').slice(0, 8))
  const dims = dimensionsJson(value)

  return (
    <details className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 group">
      <summary className="cursor-pointer text-sm font-semibold text-gray-800 select-none">
        Cargo size and count <span className="font-normal text-gray-500">(optional)</span>
      </summary>
      <div className="mt-3 space-y-4">
        <div>
          <p className={LABEL}>Size of the load</p>
          <div className="grid grid-cols-3 gap-2">
            {(['length_ft', 'width_ft', 'height_ft'] as const).map((k, i) => (
              <div key={k} className="relative">
                <input aria-label={['Length', 'Width', 'Height'][i] + ' in feet'} inputMode="decimal" value={value[k]} onChange={num(k)} placeholder={['L', 'W', 'H'][i]} className={cx(INPUT, 'pr-8 tabular-nums')} />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">ft</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm text-gray-500">
            <span>or total volume</span>
            <div className="relative w-36">
              <input aria-label="Total volume in cubic feet" inputMode="decimal" value={value.volume_cuft} onChange={num('volume_cuft')} className={cx(INPUT, 'pr-10 tabular-nums')} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">cft</span>
            </div>
            {dims?.volume_cuft && !value.volume_cuft && <span className="text-xs">= {dims.volume_cuft.toLocaleString('en-IN')} cft</span>}
          </div>
        </div>
        <div>
          <p className={LABEL}>How many pieces should arrive</p>
          <div className="flex gap-2">
            <input aria-label="Expected quantity" inputMode="numeric" value={value.expected_quantity} onChange={num('expected_quantity')} placeholder="e.g. 120" className={cx(INPUT, 'w-36 tabular-nums')} />
            <select aria-label="Unit" value={value.unit} onChange={(e) => set('unit', e.target.value)} className={cx(INPUT, 'w-36')}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <p className="mt-1 text-xs text-gray-500">The receiver&apos;s count at delivery is checked against this, so a shortage is caught on the spot.</p>
        </div>
      </div>
    </details>
  )
}
