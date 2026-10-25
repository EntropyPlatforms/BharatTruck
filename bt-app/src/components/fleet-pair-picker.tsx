'use client'

/**
 * FleetPairPicker — the DISTRIBUTOR's truck + driver chooser for moving their OWN load with
 * their OWN fleet (D-10 direct-attach). Two searchable, scrollable dropdowns over the fleet's
 * own vehicles and drivers.
 *
 *  - A truck dedicated to a driver (vehicles.driver_id) is a FIXED PAIR: picking either side
 *    auto-selects its counterpart.
 *  - Loose trucks and loose drivers are chosen independently — both must be set.
 *  - Trucks show the BRAND (maker/model) beside the number as a visual pairing cue.
 *
 * Fleet-only by construction: it reads /fleet/vehicles and /fleet/drivers (which a non-fleet
 * account cannot), and the post page renders it ONLY for a distributor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, Truck, UserRound } from 'lucide-react'

import { ApiError, listFleetDrivers, listVehicles } from '@/lib/api'
import type { FleetDriver, Vehicle } from '@/lib/types'

type TruckOpt = { id: string; rc: string; brand: string | null; driverId: string | null; capacityTons: number | null ; truck: PairTruck }
type DriverOpt = { driverId: string; name: string; vehicleId: string | null }
type FleetDriverRow = FleetDriver & { driver?: { driver_id: string; full_name: string | null } | null }

/** What the quote's cost floor needs about the chosen truck (null fields = unknown on record). */
export type PairTruck = { model_category: string | null; emission_norm: string | null; manufacture_year: number | null }
export type FleetPair = { vehicleId: string | null; driverId: string | null; truck?: PairTruck | null }

export default function FleetPairPicker({
  value,
  onChange,
  loadWeightKg,
}: {
  value: FleetPair
  onChange: (next: FleetPair) => void
  /** The load's weight (kg). Trucks rated below it are shown but not selectable — the
   *  same rule bt-fleet-service enforces (CAPACITY_EXCEEDED) at assign time. */
  loadWeightKg?: number | null
}) {
  const [trucks, setTrucks] = useState<TruckOpt[]>([])
  const [drivers, setDrivers] = useState<DriverOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listVehicles(), listFleetDrivers()])
      .then(([vs, ds]) => {
        if (cancelled) return
        const truckOpts: TruckOpt[] = (vs as (Vehicle & { is_active?: boolean })[])
          .filter(v => v.is_active !== false)
          .map(v => ({
            id: v.id, rc: v.rc_number, brand: v.maker_model ?? null, driverId: v.driver_id ?? null, capacityTons: v.capacity_tons ?? null,
            truck: { model_category: v.model_category ?? null, emission_norm: v.emission_norm ?? null, manufacture_year: v.manufacture_year ?? null },
          }))

        // driver_id → the truck dedicated to them, so picking a driver can bring their truck.
        const vehicleByDriver = new Map<string, string>()
        truckOpts.forEach(t => { if (t.driverId) vehicleByDriver.set(t.driverId, t.id) })

        const driverOpts: DriverOpt[] = (ds as FleetDriverRow[])
          .filter(d => d.status === 'active')
          .map(d => {
            const driverId = d.driver?.driver_id ?? d.driver_id
            return {
              driverId,
              name: d.driver?.full_name ?? d.full_name ?? 'Driver',
              vehicleId: vehicleByDriver.get(driverId) ?? null,
            }
          })

        setTrucks(truckOpts)
        setDrivers(driverOpts)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : 'Could not load your fleet')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const pickTruck = useCallback((id: string | null) => {
    const t = trucks.find(x => x.id === id)
    // A dedicated truck brings its driver; otherwise keep whatever driver is already chosen.
    onChange({ vehicleId: id, driverId: t?.driverId ?? value.driverId, truck: t?.truck ?? null })
  }, [trucks, value.driverId, onChange])

  const pickDriver = useCallback((id: string | null) => {
    const d = drivers.find(x => x.driverId === id)
    const vehicleId = d?.vehicleId ?? value.vehicleId
    onChange({ driverId: id, vehicleId, truck: trucks.find(x => x.id === vehicleId)?.truck ?? null })
  }, [drivers, trucks, value.vehicleId, onChange])

  const truckItems = useMemo(
    () => trucks.map(t => {
      const cap = t.capacityTons != null ? `${t.capacityTons}t` : null
      const secondary = [t.brand ? t.rc : null, cap].filter(Boolean).join(' · ') || null
      // A truck with a KNOWN capacity below the load is disqualified; a blank spec stays free.
      const tooSmall = loadWeightKg != null && t.capacityTons != null && loadWeightKg > t.capacityTons * 1000
      return { key: t.id, primary: t.brand ?? t.rc, secondary, disabled: tooSmall, note: tooSmall ? 'too small for this load' : null }
    }),
    [trucks, loadWeightKg],
  )
  const driverItems = useMemo(
    () => drivers.map(d => ({ key: d.driverId, primary: d.name, secondary: null })),
    [drivers],
  )

  if (error) {
    return <p className="text-sm text-red-700">{error}</p>
  }

  return (
    <div className="@container">
    <div className="grid @md:grid-cols-2 gap-3">
      <Combobox
        label="Truck"
        icon={<Truck className="w-4 h-4" />}
        placeholder={loading ? 'Loading trucks…' : 'Search by brand or number'}
        empty="No trucks in your fleet yet"
        items={truckItems}
        value={value.vehicleId}
        disabled={loading}
        onSelect={pickTruck}
      />
      <Combobox
        label="Driver"
        icon={<UserRound className="w-4 h-4" />}
        placeholder={loading ? 'Loading drivers…' : 'Search drivers'}
        empty="No active drivers in your fleet yet"
        items={driverItems}
        value={value.driverId}
        disabled={loading}
        onSelect={pickDriver}
      />
    </div>
    </div>
  )
}

type Item = { key: string; primary: string; secondary: string | null; disabled?: boolean; note?: string | null }

function Combobox({
  label, icon, placeholder, empty, items, value, disabled, onSelect,
}: {
  label: string
  icon: React.ReactNode
  placeholder: string
  empty: string
  items: Item[]
  value: string | null
  disabled?: boolean
  onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const selected = items.find(i => i.key === value) ?? null
  const filtered = query.trim()
    ? items.filter(i => (i.primary + ' ' + (i.secondary ?? '')).toLowerCase().includes(query.trim().toLowerCase()))
    : items

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQuery('') }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <p id={`${label.toLowerCase()}-pick-label`} className="block text-sm font-medium text-gray-700 mb-1.5">{label}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${label.toLowerCase()}-pick-label`}
        className="w-full h-[42px] flex items-center gap-2 rounded-[10px] border border-gray-200 bg-white px-3 text-sm text-left outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400"
      >
        <span className="text-gray-400 shrink-0">{icon}</span>
        <span className={`flex-1 min-w-0 truncate ${selected ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>
          {selected ? (
            <>
              {selected.primary}
              {selected.secondary && <span className="text-gray-400"> · {selected.secondary}</span>}
            </>
          ) : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search className="w-4 h-4 text-gray-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search…"
              aria-label={`Search ${label.toLowerCase()}s`}
              className="flex-1 min-w-0 text-sm outline-none bg-transparent"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2.5 text-sm text-gray-400">{items.length === 0 ? empty : 'No match'}</li>
            ) : (
              filtered.map(i => (
                <li key={i.key}>
                  <button
                    type="button"
                    disabled={i.disabled}
                    onClick={() => { if (i.disabled) return; onSelect(i.key); setOpen(false); setQuery('') }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left focus-visible:outline-none focus-visible:bg-blue-50 ${i.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'} ${i.key === value ? 'bg-blue-50/60' : ''}`}
                  >
                    <span className="flex-1 min-w-0 truncate">
                      <span className="font-medium text-gray-900">{i.primary}</span>
                      {i.secondary && <span className="text-gray-400"> · {i.secondary}</span>}
                      {i.note && <span className="text-red-500"> — {i.note}</span>}
                    </span>
                    {i.key === value && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
