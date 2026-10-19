'use client'

/**
 * Live Fleet — every truck the owner has, on one canvas and in one list.
 *
 * WHY THIS IS VEHICLE-CENTRIC (and the previous version was not): the earlier board read
 * bt-fleet-service's GET /fleet/live, which iterates the fleet's DRIVER set. A truck with
 * nobody assigned to it therefore never appeared at all — so a yard full of idle trucks
 * rendered as an empty, calm-looking map. For an owner that is exactly backwards: the assets
 * earning nothing are the ones costing money.
 *
 * This reads bt-tracking-service's GET /api/tracking/fleet/overview instead, which starts
 * from `vehicles`. Every truck is always a row. A truck with no driver, no trip, or no GPS
 * fix still appears, carrying an explicit status and a plain-language REASON — because on a
 * logistics dashboard "no data" is worse than useless: the owner cannot tell whether the
 * driver forgot to open the app, the truck is legitimately parked, or the platform is broken.
 *
 * COST RULE (unchanged, and it still binds): ONE request per tick for the whole fleet. The
 * service answers from a single Redis MGET plus bounded Postgres reads and makes NO Google
 * call. Never fan out to a per-vehicle /tracking/route or /tracking/eta from this screen —
 * at 1000 trucks on a 10s poll that is 100 req/s straight into the Maps bill. Route and ETA
 * stay lazy, one selected truck at a time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APIProvider, Map as GoogleMap, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'
import {
  AlertTriangle, ArrowRight, Fuel, MapPin, Moon, Pause, Phone, Play, Radio, Search,
  Truck, X,
} from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, IconTile, Loading, Stat } from '@/components/stat'
import { ApiError, getFleetOverview } from '@/lib/api'
import { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAPS_MAP_ID } from '@/lib/maps'
import { MapBoundary, useMapsAuthFailed, useMapRenderWatchdog } from '@/components/map-guard'
import { useIsDark } from '@/components/theme-sync'
import { timeAgo } from '@/lib/format'
import { bookingStatusConfig } from '@/lib/status'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, MONO, cx, pill, type PillTone } from '@/lib/ui'
import type { BookingStatus, FleetOverview, TrackedVehicle, VehicleStatus } from '@/lib/types'

/** Fallback centre when nothing is reporting — roughly the centre of the network. */
const NAGPUR = { lat: 21.1458, lng: 79.0882 }
const POLL_MS = 10_000
const FOCUS_ZOOM = 12

// ── Status presentation ───────────────────────────────────────
//
// One table, so the pin colour, the chip and the filter can never disagree about what a
// status means. `pin` is null for statuses that by definition have no position to draw.

const STATUS: Record<
  VehicleStatus,
  { label: string; pin: string | null; tone: PillTone; dot: string; order: number }
> = {
  moving:               { label: 'Moving',   pin: '#2563eb', tone: 'blue',   dot: 'bg-emerald-500', order: 0 },
  idle:                 { label: 'Stopped',  pin: '#6b7280', tone: 'slate',  dot: 'bg-amber-500',   order: 1 },
  no_signal:            { label: 'No signal',pin: null,      tone: 'amber',  dot: 'bg-amber-500',   order: 2 },
  assigned_not_started: { label: 'Assigned', pin: null,      tone: 'violet', dot: 'bg-violet-500',  order: 3 },
  parked:               { label: 'Parked',   pin: null,      tone: 'slate',  dot: 'bg-gray-400',    order: 4 },
  inactive:             { label: 'Inactive', pin: null,      tone: 'slate',  dot: 'bg-gray-300',    order: 5 },
}

const FILTERS: { key: 'all' | VehicleStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'moving', label: 'Moving' },
  { key: 'idle', label: 'Stopped' },
  { key: 'no_signal', label: 'No signal' },
  { key: 'parked', label: 'Parked' },
]

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const truckName = (v: TrackedVehicle) => v.rc_number ?? v.maker_model ?? 'Unregistered truck'

/** Share of the fleet, for the KPI sub lines. */
const share = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}% of fleet` : '—')

// ── Page ──────────────────────────────────────────────────────

export default function LiveFleetPage() {
  const [data, setData] = useState<FleetOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | VehicleStatus>('all')
  const [query, setQuery] = useState('')
  const mapRef = useRef<google.maps.Map | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const payload = await getFleetOverview()
        if (cancelled) return
        setData(payload)
        setFetchedAt(new Date().toISOString())
        setErr(null)
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof ApiError ? e.message : 'Could not reach the live feed')
      }
    }

    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const vehicles = useMemo(() => {
    const list = data?.vehicles ?? []
    // Sort by how much the owner needs to look at it: alerts first, then trucks that
    // should be reporting and are not, then the normal on-road statuses, parked last.
    return [...list].sort((a, b) => {
      if (a.alerts.length !== b.alerts.length) return b.alerts.length - a.alerts.length
      const byStatus = STATUS[a.status].order - STATUS[b.status].order
      if (byStatus !== 0) return byStatus
      return truckName(a).localeCompare(truckName(b))
    })
  }, [data])

  const shown = useMemo(() => {
    const byStatus = filter === 'all' ? vehicles : vehicles.filter((v) => v.status === filter)
    // Client-side search over what the board already holds: RC, model, driver, route.
    const q = query.trim().toLowerCase()
    if (!q) return byStatus
    return byStatus.filter((v) =>
      [v.rc_number, v.maker_model, v.driver?.name, v.booking?.source_address, v.booking?.dest_address]
        .some((field) => (field ?? '').toLowerCase().includes(q)),
    )
  }, [vehicles, filter, query])

  const plotted = useMemo(() => vehicles.filter((v) => v.position !== null), [vehicles])

  // Computed once from the first payload that has pins. Recomputing every poll would drag
  // the camera out from under the owner mid-look.
  const centerRef = useRef<{ lat: number; lng: number } | null>(null)
  if (centerRef.current === null && plotted.length > 0) {
    const sum = plotted.reduce(
      (acc, v) => ({ lat: acc.lat + v.position!.lat, lng: acc.lng + v.position!.lng }),
      { lat: 0, lng: 0 },
    )
    centerRef.current = { lat: sum.lat / plotted.length, lng: sum.lng / plotted.length }
  }

  const selected = useMemo(
    () => vehicles.find((v) => v.vehicle_id === selectedId) ?? null,
    [vehicles, selectedId],
  )

  const holdMap = useCallback((map: google.maps.Map | null) => {
    mapRef.current = map
  }, [])

  const focusOn = useCallback((v: TrackedVehicle) => {
    setSelectedId(v.vehicle_id)
    const map = mapRef.current
    if (!map || !v.position) return
    map.panTo({ lat: v.position.lat, lng: v.position.lng })
    if ((map.getZoom() ?? 0) < FOCUS_ZOOM) map.setZoom(FOCUS_ZOOM)
  }, [])

  const s = data?.summary
  const loading = data === null && err === null
  /** An error with nothing to fall back on — the very first poll failed. */
  const coldError = data === null ? err : null

  const subtitle = data
    ? `${s!.vehicle_count} ${s!.vehicle_count === 1 ? 'truck' : 'trucks'} · ${plotted.length} reporting · updated ${timeAgo(fetchedAt)}`
    : 'Loading your fleet…'

  return (
    <div className="lg:h-screen flex flex-col p-4 lg:p-8 lg:pb-6 max-w-[112rem] mx-auto">
      <div className="shrink-0">
        <PageHeader title="Live Fleet" subtitle={subtitle} />
      </div>

      {/* A failed poll AFTER a good one keeps the last known board on screen — a blank
          dashboard during a transient network blip is worse than slightly stale numbers. */}
      {err && data && (
        <div className="shrink-0 mb-4">
          <ErrorNote message={`${err} — showing the last successful update (${timeAgo(fetchedAt)}).`} />
        </div>
      )}

      {coldError && <ErrorNote message={coldError} />}

      {loading && <Loading label="Locating your trucks" />}

      {data && (
        <>
          {/* The fleet at a glance, before any pin is read. */}
          <div className="shrink-0 mb-5 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Trucks" value={s!.vehicle_count} sub={`${s!.on_trip} on a trip`} icon={<Truck />} tint="blue" />
            <Stat
              label="Moving"
              value={s!.moving}
              tone={s!.moving > 0 ? 'good' : 'neutral'}
              sub={share(s!.moving, s!.vehicle_count)}
              icon={<Play />}
              tint="green"
            />
            <Stat label="Stopped" value={s!.idle} sub={share(s!.idle, s!.vehicle_count)} icon={<Pause />} tint="slate" />
            <Stat
              label="No signal"
              value={s!.no_signal}
              tone={s!.no_signal > 0 ? 'warn' : 'neutral'}
              sub={s!.no_signal > 0 ? 'Should be reporting' : 'All reporting'}
              icon={<Radio />}
              tint="amber"
            />
            <Stat
              label="Open alerts"
              value={s!.alert_count}
              tone={s!.alert_count > 0 ? 'bad' : 'good'}
              sub={s!.alert_count > 0 ? 'Needs attention' : 'None open'}
              icon={<AlertTriangle />}
              tint={s!.alert_count > 0 ? 'red' : 'green'}
            />
            <Stat
              label="Fuel on road"
              value={<span className="text-[1.375rem] sm:text-[1.625rem] xl:text-[1.4375rem]">{inr(s!.trip_fuel_cost_inr)}</span>}
              sub={`${s!.driven_km.toLocaleString('en-IN')} km driven`}
              icon={<Fuel />}
              tint="brand"
            />
          </div>

          {s!.vehicle_count === 0 ? (
            <Card>
              <Empty
                icon={<Truck />}
                art title="No trucks in your fleet yet"
                hint="Add a truck under Trucks to see it here."
              />
            </Card>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
              {/* ── The list. Every truck, always. ── */}
              <Card className="lg:w-[56%] shrink-0 flex flex-col min-h-0 overflow-hidden">
                <CardHead
                  icon={<Truck />}
                  tint="blue"
                  title="Fleet list"
                  sub={`Showing ${shown.length} of ${vehicles.length} ${vehicles.length === 1 ? 'truck' : 'trucks'}`}
                  actions={
                    <div className="relative hidden w-64 sm:block xl:w-80">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search truck, driver or route…"
                        aria-label="Search trucks"
                        className={cx(INPUT, 'pl-9')}
                      />
                    </div>
                  }
                />
                <div className="shrink-0 px-5 py-3 space-y-3 border-b border-gray-100">
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
                    {FILTERS.map((f) => {
                      const n = f.key === 'all' ? vehicles.length : vehicles.filter((v) => v.status === f.key).length
                      const active = filter === f.key
                      return (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setFilter(f.key)}
                          aria-pressed={active}
                          className={cx(
                            'h-9 inline-flex items-center gap-1.5 rounded-lg border px-3 text-[0.8125rem] transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1',
                            active
                              ? 'bg-brand-50 border-brand-400 text-gray-900 font-bold'
                              : 'bg-white border-gray-200 text-gray-700 font-medium hover:bg-gray-50',
                          )}
                        >
                          {f.label}
                          <span className={cx(
                            'tabular-nums text-xs font-semibold rounded px-1.5 py-px',
                            active ? 'bg-brand-200 text-gray-900' : 'bg-gray-100 text-gray-600',
                          )}>
                            {n}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {/* Phones: the search sits under the chips (the header has no room for it). */}
                  <div className="relative sm:hidden">
                    <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search truck, driver or route…"
                      aria-label="Search trucks"
                      className={cx(INPUT, 'pl-9')}
                    />
                  </div>
                </div>

                <ListHead />
                <div className="flex-1 min-h-0 overflow-y-auto max-h-[34rem] lg:max-h-none">
                  {shown.length === 0 ? (
                    <Empty title="No trucks match this filter" hint="Clear the filter to see the whole fleet." />
                  ) : (
                    shown.map((v) => (
                      <VehicleRow
                        key={v.vehicle_id}
                        vehicle={v}
                        selected={v.vehicle_id === selectedId}
                        onSelect={() => focusOn(v)}
                      />
                    ))
                  )}
                </div>
              </Card>

              {/* ── The map. ── */}
              <div className="flex-1 min-h-[26rem] lg:min-h-0 relative">
                <FleetMap vehicles={plotted} selectedId={selectedId} onHoldMap={holdMap} onSelect={focusOn} />

                <span className="absolute top-3 left-3 inline-flex items-center gap-2 rounded-lg bg-white/95 border border-gray-200 shadow-sm px-3 py-1.5 text-sm font-semibold text-gray-900">
                  <span className="relative flex h-2.5 w-2.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_3px_rgba(16,185,129,0.55)]" />
                  </span>
                  Live
                </span>

                {/* What the pin colours mean (the same table the pins are drawn from). */}
                {plotted.length === vehicles.length && (
                  <div className="absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-5 rounded-xl border border-gray-200 bg-white/95 px-4 py-2 text-xs font-medium text-gray-700 shadow-sm sm:inline-flex">
                    {(['moving', 'idle'] as const).map(k => (
                      <span key={k} className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[k].pin ?? undefined }} aria-hidden />
                        {STATUS[k].label}
                      </span>
                    ))}
                  </div>
                )}

                {selected && (
                  <div className="absolute inset-x-3 top-3 bottom-3 sm:inset-x-auto sm:right-3 sm:w-[24rem] z-10 flex flex-col pointer-events-none">
                    <VehicleDetail vehicle={selected} onClose={() => setSelectedId(null)} />
                  </div>
                )}

                {/* Trucks that cannot be drawn are still accounted for, right on the map,
                    so the pin count never silently under-reports the fleet. */}
                {plotted.length < vehicles.length && (
                  <div className="absolute bottom-3 left-3 right-3 sm:right-auto sm:max-w-md rounded-xl bg-amber-50 border border-amber-200 shadow-sm px-3.5 py-2.5 text-sm text-amber-900 flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 text-xs font-bold">!</span>
                    <span>
                      {vehicles.length - plotted.length} of {vehicles.length} trucks have no live
                      position — see the list for why.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── List row ──────────────────────────────────────────────────

/** Column template shared by the header and every row, so they always line up. */
const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_5.5rem] md:gap-x-4 md:items-center'

function ListHead() {
  return (
    <div className={cx('hidden px-5 py-2.5 border-b border-gray-100 bg-gray-50/60 text-[0.8125rem] font-medium text-gray-500', ROW_GRID)}>
      <span>Truck</span>
      <span>Driver</span>
      <span>Status</span>
      <span>Trip</span>
      <span className="text-right">Last update</span>
    </div>
  )
}

function VehicleRow({
  vehicle, selected, onSelect,
}: {
  vehicle: TrackedVehicle
  selected: boolean
  onSelect: () => void
}) {
  const st = STATUS[vehicle.status]
  const worst = vehicle.alerts.find((a) => a.severity === 'critical') ?? vehicle.alerts[0] ?? null

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'w-full text-left px-5 py-3.5 border-b border-gray-100 last:border-b-0 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600',
        selected ? 'bg-brand-50 shadow-[inset_3px_0_0_var(--color-brand-500)]' : 'hover:bg-gray-50',
      )}
    >
      <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-1.5', ROW_GRID)}>
        {/* Truck */}
        <span className="flex min-w-0 items-center gap-3">
          <span className="relative shrink-0">
            <IconTile icon={<Truck />} tint="slate" />
            <span className={cx('absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white', worst?.severity === 'critical' ? 'bg-red-500' : st.dot)} aria-hidden />
          </span>
          <span className="min-w-0">
            <span className={cx(MONO, 'block truncate text-[0.9375rem] font-semibold text-blue-600')}>{truckName(vehicle)}</span>
            <span className="block truncate text-xs text-gray-500">{vehicle.maker_model ?? 'Model not recorded'}</span>
          </span>
        </span>

        {/* Driver */}
        <span className="hidden min-w-0 md:block">
          <span className="block truncate text-sm font-medium text-gray-900">{vehicle.driver?.name ?? '—'}</span>
          {vehicle.driver?.phone && <span className="block truncate text-xs text-gray-500 tabular-nums">{vehicle.driver.phone}</span>}
        </span>

        {/* Status */}
        <span className="ml-auto min-w-0 md:ml-0">
          <span className={pill(st.tone)}>{vehicle.status_label}</span>
          {vehicle.position && (
            <span className="mt-0.5 block text-xs text-gray-500 tabular-nums">{Math.round(vehicle.position.speed_kmh ?? 0)} km/h</span>
          )}
        </span>

        {/* Trip */}
        <span className="min-w-0 basis-full md:basis-auto">
          {vehicle.booking ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-gray-900">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-blue-600" aria-hidden />
              <span className="truncate">{vehicle.booking.source_address ?? 'Pickup'}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-label="to" />
              <span className="truncate">{vehicle.booking.dest_address ?? 'Drop'}</span>
            </span>
          ) : (
            <span className="text-sm text-gray-500">No active trip</span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500 tabular-nums">
            {vehicle.trip && <span>{vehicle.trip.driven_km} km driven</span>}
            {vehicle.trip && vehicle.fuel.trip && <span aria-hidden>·</span>}
            {vehicle.fuel.trip && <span>{inr(vehicle.fuel.trip.total_cost_inr)} fuel</span>}
            {!vehicle.trip && !vehicle.position && <span>{vehicle.fuel.mileage_kmpl} kmpl rated</span>}
          </span>
        </span>

        {/* Last update */}
        <span className="hidden text-right text-xs text-gray-500 md:block">
          {vehicle.position ? timeAgo(vehicle.position.updated_at) : '—'}
        </span>
      </div>

      {/* The reason line. This is the row's real payload for anything not simply "moving":
          it turns a blank cell into something the owner can act on. */}
      {(vehicle.data_health.level !== 'ok' || worst) && (
        <div className="mt-2 flex flex-wrap gap-2 md:pl-[3.25rem]">
          {vehicle.data_health.level !== 'ok' && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              {vehicle.data_health.reason}
            </p>
          )}
          {worst && (
            <p className={cx(
              'inline-flex items-start gap-1.5 text-xs font-medium px-2 py-1 rounded-md border',
              worst.severity === 'critical'
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-orange-50 border-orange-200 text-orange-700',
            )}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {worst.message ?? worst.type}
                {vehicle.alerts.length > 1 && ` (+${vehicle.alerts.length - 1} more)`}
              </span>
            </p>
          )}
        </div>
      )}
    </button>
  )
}

// ── Detail panel ──────────────────────────────────────────────

function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
}

function VehicleDetail({ vehicle, onClose }: { vehicle: TrackedVehicle; onClose: () => void }) {
  const t = vehicle.trip
  const f = vehicle.fuel
  const bookingStatus = vehicle.booking
    ? bookingStatusConfig[vehicle.booking.status as BookingStatus] ?? null
    : null

  return (
    <Card className="shadow-xl max-h-full flex flex-col pointer-events-auto">
      <div className="shrink-0 flex items-start justify-between gap-2 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className={cx(MONO, 'text-xl font-bold text-gray-900 truncate')}>{truckName(vehicle)}</h2>
          <p className="text-sm text-gray-500 truncate">
            {vehicle.maker_model ?? 'Model not recorded'}
            {vehicle.emission_norm ? ` · ${vehicle.emission_norm}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close truck details"
          className="shrink-0 w-9 h-9 -mr-1.5 -mt-1 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 px-4 pb-4 space-y-3 overflow-y-auto">
        {vehicle.driver && (
          <div className="rounded-xl border border-gray-200 p-3 flex items-center gap-3">
            <span className="w-10 h-10 rounded-full bg-gray-100 text-gray-700 text-sm font-bold inline-flex items-center justify-center shrink-0" aria-hidden>
              {initials(vehicle.driver.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-900 truncate">{vehicle.driver.name ?? 'Name not on file'}</p>
              {vehicle.driver.phone && (
                <p className="text-xs text-gray-500 tabular-nums inline-flex items-center gap-1">
                  <Phone className="w-3 h-3" />{vehicle.driver.phone}
                </p>
              )}
            </div>
            {vehicle.driver.phone && (
              <a
                href={`tel:${vehicle.driver.phone}`}
                aria-label={`Call ${vehicle.driver.name ?? 'driver'}`}
                className="w-10 h-10 rounded-full border border-blue-200 text-blue-600 hover:bg-blue-50 inline-flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <Phone className="w-4 h-4" />
              </a>
            )}
          </div>
        )}

        {vehicle.booking && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" aria-hidden />
            <span className="text-sm font-semibold text-gray-900 truncate">
              {vehicle.booking.source_address ?? 'Pickup'} → {vehicle.booking.dest_address ?? 'Drop'}
            </span>
            {bookingStatus && <span className={cx(bookingStatus.color, 'ml-auto shrink-0')}>{bookingStatus.label}</span>}
          </div>
        )}

        <p className="text-xs text-gray-600">{vehicle.data_health.reason}</p>

        {t ? (
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Driven" value={`${t.driven_km} km`} />
            <Metric label="Moving" value={`${t.moving_hours} h`} />
            <Metric label="Idle" value={`${t.idle_hours} h`} />
            <Metric
              label="Avg speed"
              value={t.avg_moving_speed_kmh === null ? '—' : `${t.avg_moving_speed_kmh} km/h`}
            />
            <Metric label="Top speed" value={`${t.max_speed_kmh} km/h`} />
            <Metric label="Stops" value={String(t.stop_count)} />
            {t.night_hours > 0 && (
              <Metric label="Night driving" value={`${t.night_hours} h`} icon={<Moon className="w-3 h-3" />} />
            )}
            {t.max_deviation_m > 0 && (
              <Metric label="Max off-route" value={`${t.max_deviation_m.toLocaleString('en-IN')} m`} />
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No trip telemetry yet.</p>
        )}

        {/* Fuel is shown for EVERY truck — the rated figure is a property of the asset, not
            of the trip — with the basis stated so a class average never masquerades as
            measured data. */}
        <div className="rounded-xl border border-gray-200 p-3 flex items-start gap-3">
          <IconTile icon={<Fuel />} tint="brand" size="sm" />
          <div className="min-w-0">
            {f.trip ? (
              <p className="text-base font-bold text-gray-900 tabular-nums">
                {inr(f.trip.total_cost_inr)}
                <span className="block text-xs font-normal text-gray-500">
                  {f.trip.litres} L over {f.trip.distance_km} km
                </span>
              </p>
            ) : (
              <p className="text-sm font-medium text-gray-700">Not on a running trip.</p>
            )}
            <p className="mt-0.5 text-[0.6875rem] text-gray-500">
              {f.mileage_kmpl} kmpl · {f.basis_note}
            </p>
          </div>
        </div>

        {vehicle.alerts.length > 0 && (
          <div>
            <p className="text-sm font-bold text-gray-900 mb-1.5">Alerts ({vehicle.alerts.length})</p>
            <div className="space-y-1.5">
              {vehicle.alerts.map((a) => (
                <div
                  key={a.id}
                  className={cx(
                    'text-xs px-2.5 py-2 rounded-lg border flex items-start gap-2',
                    a.severity === 'critical'
                      ? 'bg-red-50 border-red-200 text-red-800'
                      : a.severity === 'warning'
                        ? 'bg-orange-50 border-orange-200 text-orange-800'
                        : 'bg-blue-50 border-blue-200 text-blue-800',
                  )}
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span className="flex-1 font-medium">{a.message ?? a.type}</span>
                  <span className="opacity-70 shrink-0">{timeAgo(a.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {vehicle.driver?.phone && (
        <div className="shrink-0 grid grid-cols-2 gap-2 px-4 py-3 border-t border-gray-100">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>Close</button>
          <a href={`tel:${vehicle.driver.phone}`} className={BTN_PRIMARY}>
            <Phone className="w-4 h-4" />
            Call driver
          </a>
        </div>
      )}
    </Card>
  )
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 px-2.5 py-2 min-w-0">
      <span className="text-[0.6875rem] text-gray-500 flex items-center gap-1">{icon}{label}</span>
      <p className="text-sm font-bold text-gray-900 tabular-nums truncate">{value}</p>
    </div>
  )
}

// ── Map ───────────────────────────────────────────────────────

function MapUnavailable({ detail }: { detail: string }) {
  return (
    <div
      className="h-full min-h-[26rem] w-full rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center px-4 pt-14 pb-24 sm:p-6 text-center"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgb(0 0 0 / 0.035) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 0 0 / 0.035) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }}
    >
      <div className="max-w-xs rounded-2xl bg-white/90 border border-gray-200 px-6 py-5 shadow-sm">
        <span className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 inline-flex items-center justify-center">
          <MapPin className="w-6 h-6" />
        </span>
        <p className="text-base font-bold text-gray-900">Map unavailable</p>
        <p className="text-sm text-gray-500 mt-1 break-words [overflow-wrap:anywhere]">{detail}</p>
        <p className="text-xs text-gray-400 mt-2">
          Truck status, telemetry and alerts on the left are unaffected.
        </p>
      </div>
    </div>
  )
}

function FleetMap({
  vehicles, selectedId, onHoldMap, onSelect,
}: {
  vehicles: TrackedVehicle[]
  selectedId: string | null
  onHoldMap: (map: google.maps.Map | null) => void
  onSelect: (v: TrackedVehicle) => void
}) {
  // Three independent detectors, because a Maps failure surfaces differently depending on
  // the cause: gm_authFailure (no throw), a thrown render error (the boundary), and — the
  // only one that catches everything — whether tiles ever actually painted.
  const dark = useIsDark()
  const authFailed = useMapsAuthFailed()
  const { timedOut, onReady } = useMapRenderWatchdog()

  // A missing browser key must degrade to a usable page, not a crash — the list beside
  // this map is fully functional without any map at all.
  if (!GOOGLE_MAPS_BROWSER_KEY) {
    return <MapUnavailable detail="NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is not configured for this deployment." />
  }

  if (authFailed || timedOut) {
    return (
      <MapUnavailable detail="Google rejected the map key for this site. It is usually the key's allowed-referrer list, an unactivated API, or an exhausted quota." />
    )
  }

  const center = vehicles[0]?.position
    ? { lat: vehicles[0].position.lat, lng: vehicles[0].position.lng }
    : NAGPUR

  return (
    <div className="h-full min-h-[26rem] w-full rounded-xl overflow-hidden border border-gray-200">
      <MapBoundary fallback={<MapUnavailable detail="The live map could not be drawn. This is a display problem only." />}>
        <APIProvider apiKey={GOOGLE_MAPS_BROWSER_KEY}>
          <GoogleMap
            // The colour scheme is fixed when a map is created: remount on a theme change.
            key={dark ? 'dark' : 'light'}
            colorScheme={dark ? 'DARK' : 'LIGHT'}
            defaultCenter={center}
            defaultZoom={vehicles.length ? 6 : 5}
            mapId={GOOGLE_MAPS_MAP_ID || undefined}
            gestureHandling="greedy"
            disableDefaultUI
            style={{ width: '100%', height: '100%' }}
          >
            <MapHandle onHoldMap={onHoldMap} onReady={onReady} />
            {vehicles.map((v) => (
              <AdvancedMarker
                key={v.vehicle_id}
                position={{ lat: v.position!.lat, lng: v.position!.lng }}
                title={`${truckName(v)} — ${v.status_label}`}
                onClick={() => onSelect(v)}
              >
                <TruckPin vehicle={v} selected={v.vehicle_id === selectedId} />
              </AdvancedMarker>
            ))}
          </GoogleMap>
        </APIProvider>
      </MapBoundary>
    </div>
  )
}

/**
 * Hands the imperative map instance up so the list can pan to a truck, and reports the
 * first real paint so the watchdog can stand down.
 *
 * `tilesloaded` rather than the map instance merely existing: `useMap()` returns an object
 * even when Google has refused the key and will never draw a thing.
 */
function MapHandle({
  onHoldMap, onReady,
}: {
  onHoldMap: (m: google.maps.Map | null) => void
  onReady: () => void
}) {
  const map = useMap()

  useEffect(() => {
    onHoldMap(map)
    return () => onHoldMap(null)
  }, [map, onHoldMap])

  useEffect(() => {
    if (!map) return
    const listener = map.addListener('tilesloaded', onReady)
    return () => listener.remove()
  }, [map, onReady])

  return null
}

function TruckPin({ vehicle, selected }: { vehicle: TrackedVehicle; selected: boolean }) {
  const colour = STATUS[vehicle.status].pin ?? '#f59e0b'
  const hasAlert = vehicle.alerts.length > 0
  // Rotate to heading when the device reported one. Cheap Android GPS often omits heading
  // while stationary, so an upright pin is the honest default rather than a stale angle.
  const heading = vehicle.position?.heading ?? null

  return (
    <div className="relative" style={{ width: 28, height: 28 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: colour,
          border: selected ? '3px solid #111827' : '2px solid white',
          boxShadow: '0 1px 5px rgba(0,0,0,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: heading === null ? undefined : `rotate(${heading}deg)`,
        }}
      >
        <Truck className="w-3.5 h-3.5 text-[#fff]" />
      </div>
      {hasAlert && (
        <span
          style={{
            position: 'absolute', top: -2, right: -2,
            width: 10, height: 10, borderRadius: '50%',
            background: '#dc2626', border: '2px solid white',
          }}
        />
      )}
    </div>
  )
}
