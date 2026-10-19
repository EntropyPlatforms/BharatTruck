'use client'

/**
 * TripInsights — the driver's in-trip panel: route alerts, fuel cost, nearest petrol
 * pumps. Ported from driver/src/components/trip-insights.tsx into bt-app's light house
 * style (white cards, gray text, blue accents), and shown only on an in_transit trip.
 *
 * COST SHAPE, deliberate and unchanged from the driver app:
 *   alerts — polled at 60s. A plain Postgres read with no Google behind it, and the
 *            driver wants to know they drifted off route without tapping anything.
 *   fuel   — on mount + on edit. Pure arithmetic server-side, no Google call.
 *   pumps  — ON DEMAND. Every call is a billed Places (New) request, so it fires when
 *            the driver taps, never on a timer; re-anchored on their current position.
 *
 * NO BLANK SCREENS: every card renders its own loading / empty / error state, and every
 * failure here is non-fatal by construction — a failed insight shows a note and the rest
 * of the trip page (map, Navigate, Mark-as-Delivered) is untouched. Nothing throws into
 * the parent tree; the caller also wraps this in a boundary as belt-and-braces.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Fuel, Gauge, Info, Loader2, Navigation, RefreshCw } from 'lucide-react'
import { IconTile } from '@/components/stat'
import { BTN_BLUE, BTN_PRIMARY, cx } from '@/lib/ui'
import {
  getPumps,
  getFuel,
  getTripAlertsQuiet,
} from '@/lib/api'
import type { PetrolPump, FuelData, TripAlert } from '@/lib/types'
import { buildNavDeepLink } from '@/lib/maps'
import { inr } from '@/lib/format'

const ALERT_POLL_MS = 60_000

export default function TripInsights({
  bookingId,
  onPumpsLoaded,
}: {
  bookingId: string
  /** Lets the parent overlay the pumps on the map once they exist. */
  onPumpsLoaded?: (pumps: PetrolPump[]) => void
}) {
  return (
    <div className="space-y-3">
      <AlertsCard bookingId={bookingId} />
      <TripFuelAndPumps bookingId={bookingId} onPumpsLoaded={onPumpsLoaded} />
    </div>
  )
}

/**
 * The route alerts alone, so the trip screen can show them right above Mark as
 * delivered (the reference layout). Same 60s poll as inside TripInsights; render
 * EITHER this + TripFuelAndPumps OR the default export, never both.
 */
export function TripAlerts({ bookingId }: { bookingId: string }) {
  return <AlertsCard bookingId={bookingId} />
}

/** Fuel estimate + on-demand pumps, side by side from sm up, stacked on a phone. */
export function TripFuelAndPumps({
  bookingId,
  onPumpsLoaded,
}: {
  bookingId: string
  onPumpsLoaded?: (pumps: PetrolPump[]) => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
      <FuelCard bookingId={bookingId} />
      <PumpsCard bookingId={bookingId} onPumpsLoaded={onPumpsLoaded} />
    </div>
  )
}

// ── Alerts ────────────────────────────────────────────────────

function AlertsCard({ bookingId }: { bookingId: string }) {
  const [alerts, setAlerts] = useState<TripAlert[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const data = await getTripAlertsQuiet(bookingId)
        if (cancelled) return
        // Only unresolved alerts matter to a driver mid-trip. Array guard: this payload
        // is not validated field-by-field, and `.filter` on a missing field would throw.
        setAlerts(Array.isArray(data?.alerts) ? data.alerts.filter((a) => !a.resolved_at) : [])
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    load()
    const id = setInterval(load, ALERT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [bookingId])

  // A silent no-op is right here: an empty alert list and an unreachable alerts endpoint
  // both mean "nothing to tell the driver", and a red error box for the latter would be
  // pure noise on the screen they use to get paid. The rest of the panel still renders.
  if (failed || alerts.length === 0) return null

  return (
    <div className="space-y-2">
      {alerts.map((a) => {
        const critical = a.severity === 'critical'
        const warning = a.severity === 'warning'
        const Icon = critical ? Gauge : warning ? AlertTriangle : Info
        return (
          <div
            key={a.id}
            role="status"
            aria-live="polite"
            className={cx(
              'flex items-center gap-3 rounded-xl px-3.5 py-3 border',
              critical ? 'bg-red-50 border-red-200' : warning ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200',
            )}
          >
            <span
              className={cx(
                'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                critical ? 'bg-red-600 text-[#fff]' : warning ? 'bg-amber-400 text-gray-900' : 'bg-gray-100 text-gray-600',
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <p
              className={cx(
                'text-[0.9375rem] font-semibold leading-snug',
                critical ? 'text-red-800' : warning ? 'text-amber-900' : 'text-gray-800',
              )}
            >
              {a.message ?? a.type}
            </p>
          </div>
        )
      })}
    </div>
  )
}

// ── Fuel ──────────────────────────────────────────────────────

function FuelCard({ bookingId }: { bookingId: string }) {
  const [fuel, setFuel] = useState<FuelData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [price, setPrice] = useState<string>('')
  const [editing, setEditing] = useState(false)

  const load = useCallback(
    async (dieselPrice?: number) => {
      setLoading(true)
      setError(null)
      try {
        const data = await getFuel(bookingId, dieselPrice ? { diesel_price: dieselPrice } : undefined)
        setFuel(data)
        setPrice(String(data.diesel_price_inr))
      } catch {
        setError('Could not load the fuel estimate just now.')
      } finally {
        setLoading(false)
      }
    },
    [bookingId],
  )

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <IconTile icon={<Fuel />} tint="amber" size="sm" />
          <h4 className="text-[0.9375rem] font-bold text-gray-900">Fuel for this trip</h4>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>

      {/* Error state — a note, never a blank card. */}
      {error && <p className="text-xs text-gray-500">{error}</p>}

      {/* Empty-ish state: no route computed yet, so every figure would be zero.
          Rendering "₹0" would read as "this trip costs nothing" — worse than
          admitting we cannot say yet. */}
      {fuel && !error && fuel.distance_basis === 'unknown' && (
        <p className="text-xs text-gray-500">{fuel.distance_note}</p>
      )}

      {/* Loading-with-no-data-yet: the spinner above is the whole signal. */}
      {!fuel && !error && loading && (
        <p className="text-xs text-gray-400">Estimating fuel…</p>
      )}

      {fuel && !error && fuel.distance_basis !== 'unknown' && (
        <>
          <p className="text-[1.625rem] leading-tight font-bold text-gray-900 tabular-nums tracking-tight">
            {inr(fuel.estimated_fuel_cost_inr)}
          </p>
          <p className="text-sm text-gray-600 mt-1 tabular-nums">
            {fuel.litres_required} L over {fuel.distance_km} km · {fuel.mileage_kmpl} kmpl
          </p>
          {fuel.def_cost_inr > 0 && (
            <p className="text-sm text-gray-600 mt-0.5 tabular-nums">
              Diesel {inr(fuel.diesel_cost_inr)} + DEF {inr(fuel.def_cost_inr)}
            </p>
          )}

          {/* Provenance, always shown — an estimate on a class average must never be
              presented with the confidence of one built on the truck's own model. */}
          <p className="text-[0.6875rem] text-gray-400 mt-2 leading-snug">
            {fuel.distance_note} {fuel.basis_note}
          </p>

          {editing ? (
            <div className="flex items-center gap-2 mt-3">
              <div className="flex-1 min-w-0 flex items-center gap-1 bg-white border border-gray-200 rounded-[10px] px-3 h-11 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100">
                <span className="text-sm text-gray-500">₹</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  aria-label="Diesel price per litre"
                  className="w-full bg-transparent text-sm text-gray-900 outline-none"
                />
                <span className="text-xs text-gray-400 whitespace-nowrap">/ L</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const n = Number(price)
                  if (Number.isFinite(n) && n > 0) void load(n)
                  setEditing(false)
                }}
                className={cx(BTN_PRIMARY, 'h-11!')}
              >
                Apply
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-2 h-11 -mx-1 px-1 flex items-center text-sm text-blue-600 hover:text-blue-700 font-semibold rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              Diesel at ₹{fuel.diesel_price_inr}/L — change
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Petrol pumps ──────────────────────────────────────────────

function PumpsCard({
  bookingId,
  onPumpsLoaded,
}: {
  bookingId: string
  onPumpsLoaded?: (pumps: PetrolPump[]) => void
}) {
  const [pumps, setPumps] = useState<PetrolPump[] | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getPumps(bookingId)
      const list = Array.isArray(data?.pumps) ? data.pumps : []
      setPumps(list)
      setSource(data?.origin_source ?? null)
      onPumpsLoaded?.(list)
    } catch {
      // Deliberately NOT err.message: an UPSTREAM_ERROR from tracking-service carries up
      // to 200 chars of raw Google response body, which is noise to a driver.
      setError('Could not find nearby pumps just now — tap to try again.')
    } finally {
      setLoading(false)
    }
  }, [bookingId, onPumpsLoaded])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <IconTile icon={<Fuel />} tint="blue" size="sm" />
          <h4 className="text-[0.9375rem] font-bold text-gray-900">Petrol pumps nearby</h4>
        </div>
        {pumps && (
          <button
            type="button"
            onClick={() => void load()}
            // Disabled in flight: every call is a BILLED Places (New) request, and a
            // small icon on a moving truck gets double-tapped constantly.
            disabled={loading}
            aria-label="Search again from my current position"
            aria-busy={loading}
            className="-m-2 h-11 w-11 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Error state — a note, never a blank card. */}
      {error && <p className="text-xs text-gray-500 mb-2">{error}</p>}

      {pumps === null ? (
        // Initial state: a clear call to action (pumps are on-demand to control cost).
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Find nearest pumps"
          aria-busy={loading}
          className={cx(BTN_BLUE, 'w-full h-12! text-[0.9375rem]!')}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Find nearest pumps'}
        </button>
      ) : pumps.length === 0 ? (
        // Empty state: say so, and say what to do.
        <p className="text-xs text-gray-500">
          No pumps found within 5 km. Try again further along the highway.
        </p>
      ) : (
        <>
          {source && source !== 'live_position' && (
            <p className="text-[0.6875rem] text-amber-700 mb-2">
              {source === 'last_breadcrumb'
                ? 'Searched from your last known position — GPS is not reporting right now.'
                : 'Searched from the pickup point — no location recorded for this trip yet.'}
            </p>
          )}
          <ul className="divide-y divide-gray-100">
            {pumps.map((p) => (
              <li key={p.place_id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                  <p className="text-xs text-gray-500 tabular-nums">
                    {(p.distance_m / 1000).toFixed(1)} km
                    {p.address ? ` · ${p.address}` : ''}
                  </p>
                </div>
                {/* Deep-link handoff (D-004) — the phone's Google Maps does the navigating. */}
                <a
                  href={buildNavDeepLink({ destination: { lat: p.lat, lng: p.lng } })}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Navigate to ${p.name}`}
                  className="flex-shrink-0 h-11 w-11 rounded-full border border-blue-200 bg-blue-50 hover:bg-blue-100 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  <Navigation className="h-4 w-4 text-blue-600" />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
