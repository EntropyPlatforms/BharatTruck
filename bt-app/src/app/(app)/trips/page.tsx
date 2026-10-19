'use client'

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, Clock, FileText, Info, Layers, Play, RefreshCw,
  Truck, UserRound, Users, X,
} from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, IconTile, Loading, Stat } from '@/components/stat'
import { Avatar, Modal, RouteLine, TD, TH, THEAD_ROW, TR, fmtPhone } from '@/components/fleet-ops/bits'
import {
  ApiError, assignToBooking, listFleetBookings, listFleetDrivers, listVehicles,
} from '@/lib/api'
import { inr, inrCompact, shortDate, timeAgo, tons } from '@/lib/format'
import { bookingStatusConfig } from '@/lib/status'
import { consolidationSuggestions, type ConsolidationSuggestion } from '@/lib/consolidation'
import type { BookingStatus, FleetBooking, FleetDriver, Vehicle } from '@/lib/types'
import {
  BTN_BLUE, BTN_BLUE_SOLID, BTN_PRIMARY, BTN_SECONDARY, LABEL, MONO, cx, pill,
} from '@/lib/ui'

/**
 * Trips — where a booking the fleet has won becomes a trip that can actually roll.
 *
 * THE GATE IS REAL. bt-booking-service/src/lib/state.ts::assertFleetAssignmentReady
 * refuses accepted -> in_transit for any booking carrying a fleet_owner_id until a
 * live vehicle_assignments row exists. A fleet may bid with no free truck, so the
 * award binds nothing physical; until the owner pairs a driver AND a truck here the
 * trip has no truck of record and its distance, fuel and per-asset P&L would be
 * unattributable. So this page is not a convenience — it is the only way a won load
 * ever departs.
 *
 * MUTUAL EXCLUSION IS ALSO REAL. bt-fleet-service/src/lib/assignment.ts INSERTs and
 * catches 23505 on three partial-unique indexes (one live assignment per booking,
 * per vehicle, per driver) rather than pre-checking, because check-then-insert has
 * a race in which two dispatchers hand the same truck to two loads. The dialog
 * therefore treats a rejection as normal traffic: it stays open, re-reads who is
 * live, and says which of the two is already out.
 *
 * The fleet owner never starts a trip from here — only the driver does, from their
 * own app. Crewed rows therefore carry no start control.
 */

// GET /fleet/bookings returns the booking columns listed in
// bt-fleet-service/src/lib/assignment.ts (BOOKING_COLUMNS) — there is no join to
// the shipper, the truck or the driver. RC number and driver name below are
// therefore resolved locally from the fleet's own roster and vehicle list, which
// this page already loads for the assign dialog.

// GET /fleet/vehicles decorates each row (routes/vehicles.ts) with age_years,
// status and current_assignment; lib/types.ts Vehicle stops at the DB columns.
// Optional so a service that stops sending them degrades instead of crashing.
type LiveAssignment = {
  assignment_id: string
  booking_id: string
  driver_id: string
  driver_name: string | null
  assigned_at: string
}
type FleetVehicleRow = Vehicle & {
  status?: 'on_trip' | 'idle'
  current_assignment?: LiveAssignment | null
}

// GET /fleet/drivers nests the identity under `driver` (routes/drivers.ts), while
// FleetDriver declares those fields flat. Read both, prefer the nested one.
type DriverIdentity = { driver_id: string; full_name: string | null; phone_number: string | null }
type RosterRow = FleetDriver & { driver?: DriverIdentity | null }

const nameOf = (r: RosterRow) => r.driver?.full_name ?? r.full_name ?? null
const phoneOf = (r: RosterRow) => r.driver?.phone_number ?? r.phone_number ?? null

/** bt-fleet-service caps each booking list at 50 (BookingListQuery default). */
const PAGE_LIMIT = 50

/**
 * bookings.status is a plain string on the wire (BookingRow), so an unmapped value
 * degrades to a neutral pill instead of rendering `undefined.color` into a class.
 */
function pillFor(status: BookingStatus): { label: string; color: string } {
  return bookingStatusConfig[status] ?? {
    label: String(status).replace(/_/g, ' '),
    color: pill('slate'),
  }
}

type TabKey = 'needs' | 'in_transit' | 'completed' | 'paid' | 'all'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'needs',      label: 'Needs assignment' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'completed',  label: 'Completed' },
  { key: 'paid',       label: 'Paid' },
  { key: 'all',        label: 'All' },
]

type Lists = {
  accepted: FleetBooking[]
  in_transit: FleetBooking[]
  completed: FleetBooking[]
  paid: FleetBooking[]
  all: FleetBooking[]
}

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

/** A trip departs only when BOTH halves are bound — that is the server's rule. */
function needsCrew(b: FleetBooking): boolean {
  return !b.vehicle_id || !b.driver_id
}

function priceOf(b: FleetBooking): number {
  return b.final_price ?? b.quoted_price
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

/** Whole days from today to a pickup date; null if the date is unparseable. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  then.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((then.getTime() - today.getTime()) / 86_400_000)
}

function routeLabel(b: FleetBooking): string {
  return `${b.source_address} → ${b.destination_address}`
}

function loadName(b: { load_type: string }): string {
  return (b.load_type || 'Load').replace(/_/g, ' ')
}

export default function TripsPage() {
  const [lists, setLists] = useState<Lists | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicleRow[]>([])
  const [drivers, setDrivers] = useState<RosterRow[]>([])
  const [tab, setTab] = useState<TabKey>('needs')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [crewError, setCrewError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [assignTarget, setAssignTarget] = useState<FleetBooking | null>(null)

  // No state is written before the first await, so the mount effect below does not
  // set state synchronously; the Refresh button raises the spinner itself.
  const load = useCallback(async () => {
    // One list per tab: the service filters on an exact status and paginates each
    // query independently, so a fleet with 200 paid trips cannot push today's
    // unassigned queue past the 50-row window.
    const [booked, crew] = await Promise.allSettled([
      Promise.all([
        listFleetBookings('accepted'),
        listFleetBookings('in_transit'),
        listFleetBookings('completed'),
        listFleetBookings('paid'),
        listFleetBookings(),
      ]),
      Promise.all([listVehicles(), listFleetDrivers()]),
    ])

    if (booked.status === 'fulfilled') {
      const [accepted, in_transit, completed, paid, all] = booked.value
      setLists({ accepted, in_transit, completed, paid, all })
      setError(null)
    } else {
      setError(errText(booked.reason, 'Could not load trips'))
    }

    if (crew.status === 'fulfilled') {
      setVehicles(crew.value[0] as FleetVehicleRow[])
      setDrivers(crew.value[1] as RosterRow[])
      setCrewError(null)
    } else {
      // The table still renders without this; only the pairing step needs it.
      setCrewError(errText(crew.reason, 'Could not load your trucks and drivers'))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  /** Re-read who is live. Used after a rejected assignment, where staleness IS the error. */
  const refreshCrew = useCallback(async () => {
    try {
      const [v, d] = await Promise.all([listVehicles(), listFleetDrivers()])
      setVehicles(v as FleetVehicleRow[])
      setDrivers(d as RosterRow[])
      return { vehicles: v as FleetVehicleRow[], drivers: d as RosterRow[] }
    } catch {
      return null
    }
  }, [])

  const vehicleById = new Map(vehicles.map(v => [v.id, v]))
  const driverById = new Map(drivers.map(d => [d.driver_id, d]))
  const bookingById = new Map((lists?.accepted ?? []).map(b => [b.id, b]))

  const accepted = lists?.accepted ?? []
  const needs = accepted.filter(needsCrew)
  const crewed = accepted.filter(b => !needsCrew(b))
  const inTransit = lists?.in_transit ?? []

  // Read-only consolidation hint (v1): which not-yet-crewed loads share a lane and would
  // fit ONE free truck. Purely a planning insight computed from data this page already has —
  // it changes nothing about dispatch (loads still run as separate trips until consolidated
  // trips ship). See lib/consolidation.ts.
  const consolidation = consolidationSuggestions(
    needs.map(b => ({
      id: b.id,
      source_lat: b.source_lat, source_lng: b.source_lng,
      dest_lat: b.dest_lat, dest_lng: b.dest_lng,
      destination_address: b.destination_address,
      weight_kg: b.weight_kg,
    })),
    vehicles.map(v => ({ id: v.id, rc_number: v.rc_number, capacity_tons: v.capacity_tons, free: !v.current_assignment })),
  )

  const counts: Record<TabKey, number> = {
    needs: needs.length,
    in_transit: inTransit.length,
    completed: lists?.completed.length ?? 0,
    paid: lists?.paid.length ?? 0,
    all: lists?.all.length ?? 0,
  }

  const onTripVehicles = vehicles.filter(v => v.current_assignment != null || v.status === 'on_trip')
  const idleVehicles = vehicles.length - onTripVehicles.length
  const busyDriverIds = new Set(
    vehicles.map(v => v.current_assignment?.driver_id).filter((id): id is string => Boolean(id)),
  )
  const activeDrivers = drivers.filter(d => d.status === 'active')
  const freeDrivers = activeDrivers.filter(d => !busyDriverIds.has(d.driver_id)).length
  const waitingValue = sum(needs.map(priceOf))

  const rows: FleetBooking[] =
    tab === 'needs' ? needs
    : tab === 'in_transit' ? inTransit
    : tab === 'completed' ? (lists?.completed ?? [])
    : tab === 'paid' ? (lists?.paid ?? [])
    : (lists?.all ?? [])

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <PageHeader
        title="Trips"
        info="A won load can't depart until you assign both a truck and a driver."
        subtitle={lists ? `${needs.length} waiting on a crew · ${inTransit.length} on the road` : undefined}
        actions={
          <button
            onClick={() => { setNotice(null); setLoading(true); void load() }}
            disabled={loading}
            className={cx(BTN_BLUE, 'h-10 px-4')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {loading ? (
        <Loading label="Loading trips" />
      ) : error ? (
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={() => { setLoading(true); void load() }} className={BTN_SECONDARY}>
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 lg:gap-4">
            <Stat
              label="Waiting on a crew"
              value={needs.length}
              tone={needs.length > 0 ? 'warn' : 'good'}
              sub={needs.length > 0 ? `${inrCompact(waitingValue)} of work not moving` : 'Every won load is crewed'}
              icon={<Users />}
            />
            <Stat
              label="On the road"
              value={inTransit.length}
              sub={crewed.length > 0 ? `${crewed.length} crewed, yet to depart` : 'No trip is waiting to start'}
              icon={<Truck />}
              tint="violet"
            />
            <Stat
              label="Idle trucks"
              value={crewError ? '—' : idleVehicles}
              sub={crewError ? 'Fleet list unavailable' : `${onTripVehicles.length} of ${vehicles.length} on a live trip`}
              icon={<Truck />}
              tint="slate"
            />
            <Stat
              label="Free drivers"
              value={crewError ? '—' : freeDrivers}
              sub={crewError ? 'Roster unavailable' : `${activeDrivers.length} active on the roster`}
              icon={<UserRound />}
              tint="green"
            />
          </div>

          {crewError && (
            <ErrorNote message={`Assigning is unavailable — ${crewError}`} />
          )}

          {notice && (
            <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <span className="min-w-0 flex-1 pt-px">{notice}</span>
              <button
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                className="-m-1 p-1 rounded-md text-emerald-700 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Tabs — the owner's queue first, because that is the only one with work in it. */}
          <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Trips by state">
            {TABS.map(t => {
              const active = tab === t.key
              const n = counts[t.key]
              const showCount = t.key !== 'all' || n > 0
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setTab(t.key); setNotice(null) }}
                  className={cx(
                    'inline-flex items-center gap-2 rounded-xl border px-4 h-10 text-sm font-semibold whitespace-nowrap transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                    active
                      ? 'border-brand-400 bg-brand-50 text-gray-900'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {t.label}
                  {showCount && (
                    <span className={cx(
                      'text-xs tabular-nums rounded-full min-w-[22px] px-1.5 py-0.5 text-center',
                      active ? 'bg-brand-500 text-ink'
                      : t.key === 'needs' && n > 0 ? 'bg-orange-100 text-orange-700'
                      : 'bg-blue-50 text-blue-700',
                    )}>
                      {n >= PAGE_LIMIT ? `${PAGE_LIMIT}+` : n}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {tab === 'needs' ? (
            <>
              {consolidation.length > 0 && <ConsolidationHints suggestions={consolidation} bookingById={bookingById} />}

              <Card>
                <CardHead
                  title="Awaiting crew"
                  sub="Assign a truck and a driver to let the trip depart."
                  icon={<Users />}
                  tint="amber"
                />
                {needs.length === 0 ? (
                  <Empty
                    art title="Nothing waiting on you"
                    hint="Every accepted booking already has a truck and driver."
                    icon={<CheckCircle2 />}
                  />
                ) : (
                  <BookingTable
                    rows={needs}
                    vehicleById={vehicleById}
                    driverById={driverById}
                    onAssign={crewError ? undefined : setAssignTarget}
                  />
                )}
              </Card>

              {crewed.length > 0 && (
                <Card>
                  <CardHead
                    title="Crewed — clear to depart"
                    sub="Waiting on the driver to start"
                    icon={<Play />}
                    tint="green"
                  />
                  <BookingTable rows={crewed} vehicleById={vehicleById} driverById={driverById} />
                </Card>
              )}

              {inTransit.length > 0 && (
                <Card>
                  <CardHead title="In transit" sub="Live trips on the road." icon={<Truck />} tint="violet" />
                  <BookingTable rows={inTransit} vehicleById={vehicleById} driverById={driverById} />
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardHead
                title={TABS.find(t => t.key === tab)?.label ?? 'Trips'}
                icon={tab === 'in_transit' ? <Truck /> : <FileText />}
                tint={tab === 'in_transit' ? 'violet' : tab === 'completed' ? 'teal' : tab === 'paid' ? 'green' : 'blue'}
                sub={rows.length >= PAGE_LIMIT
                  ? `Showing the ${PAGE_LIMIT} most recent`
                  : `${rows.length} ${rows.length === 1 ? 'trip' : 'trips'}`}
              />
              {rows.length === 0 ? (
                <Empty
                  title="No trips here"
                  hint={tab === 'in_transit'
                    ? 'A crewed trip appears here once the driver starts it.'
                    : 'Nothing in this state yet.'}
                  icon={<Truck />}
                />
              ) : (
                <BookingTable
                  rows={rows}
                  vehicleById={vehicleById}
                  driverById={driverById}
                  onAssign={crewError ? undefined : setAssignTarget}
                />
              )}
            </Card>
          )}

        </div>
      )}

      {assignTarget && (
        <AssignDialog
          booking={assignTarget}
          vehicles={vehicles}
          drivers={drivers}
          refreshCrew={refreshCrew}
          onClose={() => setAssignTarget(null)}
          onAssigned={(rc, driverName) => {
            setAssignTarget(null)
            setNotice(`${rc} and ${driverName} are on ${routeLabel(assignTarget)}. The driver can start the trip now.`)
            // Silent refetch: the confirmation stays on screen while the queue,
            // the busy-truck map and the roster catch up underneath it.
            void load()
          }}
        />
      )}
    </div>
  )
}

// ── Consolidation hints ───────────────────────────────────────

/**
 * Read-only consolidation slice (v1). Surfaces which not-yet-crewed loads share a lane and
 * would fit one free truck — a planning insight, NOT an action. Consolidated dispatch (one
 * truck carrying several loads) is not built yet: the one-live-booking-per-truck rule still
 * holds, so these loads dispatch as separate trips for now. The copy says so plainly.
 */
function ConsolidationHints({
  suggestions, bookingById,
}: {
  suggestions: ConsolidationSuggestion[]
  bookingById: Map<string, FleetBooking>
}) {
  return (
    <Card>
      <CardHead
        title="Loads that could share a truck"
        icon={<Layers />}
        sub="Same-lane loads awaiting a truck. Consolidated trips are coming — for now, assign each as its own trip."
      />
      <ul className="p-4 sm:p-5 space-y-2">
        {suggestions.map(s => (
          <li key={s.lane} className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-x-4 gap-y-1.5">
            <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
              <span className="font-semibold text-gray-900">
                {s.loadIds.length} loads → <span className="truncate">{s.destination_address}</span>
              </span>
              <span className="text-gray-300" aria-hidden>·</span>
              <span className="text-gray-600">
                {s.loadIds
                  .map(id => bookingById.get(id))
                  .filter((b): b is FleetBooking => Boolean(b))
                  .map(b => `${loadName(b)} ${tons(b.weight_kg)}`)
                  .join(', ')}
              </span>
              <span className="text-gray-300" aria-hidden>·</span>
              <span className="font-semibold text-gray-900 tabular-nums">{tons(s.totalWeightKg)} total</span>
            </div>
            {s.fittingTruck ? (
              <span className="shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                <span className="w-4 h-4 rounded bg-emerald-600 text-[#fff] inline-flex items-center justify-center"><Check className="w-3 h-3" /></span>
                fits <span className={MONO}>{s.fittingTruck.rc_number}</span> ({s.fittingTruck.capacity_tons}t)
              </span>
            ) : (
              <span className="shrink-0 text-sm text-gray-400">no single free truck fits</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ── Table ─────────────────────────────────────────────────────

function BookingTable({
  rows, vehicleById, driverById, onAssign,
}: {
  rows: FleetBooking[]
  vehicleById: Map<string, FleetVehicleRow>
  driverById: Map<string, RosterRow>
  onAssign?: (b: FleetBooking) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px]">
        <thead>
          <tr className={THEAD_ROW}>
            <th className={TH}>Route / Shipper</th>
            <th className={TH}>Load</th>
            <th className={TH}>Pickup</th>
            <th className={cx(TH, 'text-right')}>Price</th>
            <th className={TH}>Status</th>
            <th className={TH}>Truck &amp; driver</th>
            {/* Pinned so the primary Assign action survives horizontal scroll on narrow
                screens (review S-6 — the corrected-scope audit fixed My bids but missed
                this table). Same recipe as auctions/page.tsx: sticky th + opaque sticky
                td mirroring the row tint via `group` on the tr. */}
            <th className={cx(TH, 'text-right sticky right-0 bg-gray-50')}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(b => {
            const status = pillFor(b.status)
            const vehicle = b.vehicle_id ? vehicleById.get(b.vehicle_id) ?? null : null
            const driver = b.driver_id ? driverById.get(b.driver_id) ?? null : null
            const shipper = (b.shipper_name ?? '').trim()
            const assignable = b.status === 'accepted' && needsCrew(b)
            const driverName = b.driver_id ? (driver ? nameOf(driver) ?? 'Unnamed driver' : 'Driver off this roster') : 'No driver'

            return (
              <tr key={b.id} className={cx(TR, 'group')}>
                <td className={TD}>
                  <RouteLine from={b.source_address} to={b.destination_address} className="font-semibold text-gray-900" />
                  <div className="text-xs text-gray-500 mt-0.5">
                    {/* The booking list carries no shipper join today, so this line
                        appears only when the service does send a name. */}
                    {shipper !== '' ? shipper : `Booked ${shortDate(b.created_at)}`}
                    {b.booking_type ? ` · ${b.booking_type.replace(/_/g, ' ')}` : ''}
                  </div>
                </td>

                <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                  <span>{loadName(b)}</span>
                  <span className="text-gray-400"> · </span>
                  <span className="tabular-nums">{tons(b.weight_kg)}</span>
                </td>

                <td className={cx(TD, 'whitespace-nowrap')}>
                  <div className="text-gray-900">{shortDate(b.pickup_date)}</div>
                  {assignable && <PickupUrgency iso={b.pickup_date} />}
                </td>

                <td className={cx(TD, 'text-right')}>
                  <div className="text-gray-900 font-semibold tabular-nums">{inr(priceOf(b))}</div>
                  <div className="text-xs text-gray-400">{b.final_price === null ? 'quoted' : 'final'}</div>
                </td>

                <td className={TD}>
                  <span className={status.color}>{status.label}</span>
                </td>

                <td className={TD}>
                  {b.vehicle_id || b.driver_id ? (
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={b.driver_id ? driverName : null} size="sm" muted={!driver} />
                      <span className="min-w-0">
                        <span className={cx(MONO, 'block text-sm font-semibold', b.vehicle_id ? 'text-blue-700' : 'text-gray-400')}>
                          {b.vehicle_id ? vehicle?.rc_number ?? 'Truck outside this fleet' : 'No truck'}
                        </span>
                        <span className="block text-xs text-gray-500 truncate max-w-[160px]">{driverName}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-500">
                      <Truck className="w-3.5 h-3.5" />
                      Not assigned
                    </span>
                  )}
                </td>

                <td className={cx(TD, 'text-right whitespace-nowrap sticky right-0 bg-white group-hover:bg-gray-50 transition-colors')}>
                  {assignable && onAssign ? (
                    <button onClick={() => onAssign(b)} className={cx(BTN_BLUE_SOLID, 'min-w-[88px]')}>
                      Assign
                    </button>
                  ) : b.status === 'in_transit' ? (
                    <Link href="/map" className={cx(BTN_BLUE, 'min-w-[88px]')}>
                      Track
                    </Link>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** How late the queue is running — a pickup date that has passed is the loudest signal here. */
function PickupUrgency({ iso }: { iso: string }) {
  const d = daysUntil(iso)
  if (d === null) return null
  if (d < 0) {
    return (
      <div className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-red-600">
        <AlertTriangle className="w-3.5 h-3.5" />
        Pickup passed {Math.abs(d)}d ago
      </div>
    )
  }
  if (d === 0) return <div className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-orange-600"><Clock className="w-3.5 h-3.5" />Pickup today</div>
  if (d === 1) return <div className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-orange-600"><Clock className="w-3.5 h-3.5" />Pickup tomorrow</div>
  return <div className="text-xs text-gray-400">in {d} days</div>
}

// ── Assign ────────────────────────────────────────────────────

type PickOption = {
  value: string
  label: ReactNode
  /** Short state shown at the right of the option: Free, On a trip, Too small. */
  tag: string
  tone: 'free' | 'busy' | 'off'
  disabled: boolean
  leading: ReactNode
}

/**
 * A select that shows WHY an option is unavailable (free / on a trip / too small) as a
 * pill, instead of a native <option> that can only grey out. Same value + onChange
 * contract as the <select> it replaces.
 */
function Picker({
  id, labelId, placeholder, value, options, onChange,
}: {
  id: string
  labelId: string
  placeholder: string
  value: string
  options: PickOption[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const selected = options.find(o => o.value === value) ?? null

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const tagCls = (tone: PickOption['tone']) =>
    tone === 'free' ? pill('green') : tone === 'busy' ? pill('red') : pill('slate')

  return (
    <div ref={wrap}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${id}`}
        onClick={() => setOpen(o => !o)}
        className={cx(
          'w-full min-h-[44px] rounded-[10px] border bg-white px-3 py-2 flex items-center gap-2.5 text-left text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-100 focus-visible:border-blue-600',
          open ? 'border-blue-600 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300',
        )}
      >
        {selected ? (
          <>
            {selected.leading}
            <span className="min-w-0 flex-1 truncate text-gray-900 font-medium">{selected.label}</span>
            <span className={tagCls(selected.tone)}>{selected.tag}</span>
          </>
        ) : (
          <span className="flex-1 text-gray-400">{placeholder}</span>
        )}
        <ChevronDown className={cx('w-4 h-4 text-gray-500 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-labelledby={labelId}
          className="mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-lg"
        >
          {options.length === 0 && <div className="px-3 py-2.5 text-sm text-gray-500">Nothing to choose from.</div>}
          {options.map(o => {
            const isSel = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled}
                disabled={o.disabled}
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={cx(
                  'w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                  o.disabled ? 'opacity-55 cursor-not-allowed' : 'hover:bg-gray-50',
                  isSel && 'bg-blue-50 hover:bg-blue-50',
                )}
              >
                {o.leading}
                <span className={cx('min-w-0 flex-1 truncate', o.disabled ? 'text-gray-500' : 'text-gray-900')}>{o.label}</span>
                <span className={tagCls(o.tone)}>{o.tag}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AssignDialog({
  booking, vehicles, drivers, refreshCrew, onClose, onAssigned,
}: {
  booking: FleetBooking
  vehicles: FleetVehicleRow[]
  drivers: RosterRow[]
  refreshCrew: () => Promise<{ vehicles: FleetVehicleRow[]; drivers: RosterRow[] } | null>
  onClose: () => void
  onAssigned: (rc: string, driverName: string) => void
}) {
  const [driverId, setDriverId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const driverLabelId = useId()
  const truckLabelId = useId()

  // Only ACTIVE affiliations can be dispatched — bt-fleet-service checks
  // getActiveAffiliation and 403s a pending, suspended or departed driver.
  const roster = drivers.filter(d => d.status === 'active')

  // Who is already out, straight from the live vehicle_assignments the vehicle
  // list is decorated with. This is a hint, not the guard — the insert is.
  const busyDriver = new Map<string, string>()
  for (const v of vehicles) {
    const a = v.current_assignment
    if (a) busyDriver.set(a.driver_id, v.rc_number)
  }
  // Free trucks first — a dispatcher should not have to scroll past the fleet's
  // busiest assets to find the one standing in the yard.
  const trucks = [...vehicles].sort((a, b) => {
    const aBusy = a.current_assignment ? 1 : 0
    const bBusy = b.current_assignment ? 1 : 0
    if (aBusy !== bBusy) return aBusy - bBusy
    return a.rc_number.localeCompare(b.rc_number)
  })

  const freeTrucks = trucks.filter(v => !v.current_assignment).length
  const freeDrivers = roster.filter(d => !busyDriver.has(d.driver_id)).length

  function describeConflict(vs: FleetVehicleRow[], ds: RosterRow[]): string {
    const truck = vs.find(v => v.id === vehicleId) ?? null
    const truckBusy = truck?.current_assignment ?? null
    const driverOn = vs.find(v => v.current_assignment?.driver_id === driverId) ?? null
    const chosen = ds.find(d => d.driver_id === driverId)
    const driverName = (chosen ? nameOf(chosen) : null) ?? 'That driver'

    const parts: string[] = []
    if (truckBusy && truck) {
      parts.push(
        `${truck.rc_number} is already on a live trip${truckBusy.driver_name ? ` with ${truckBusy.driver_name}` : ''}` +
        ` (assigned ${timeAgo(truckBusy.assigned_at)}).`,
      )
    }
    if (driverOn && driverOn.id !== vehicleId) {
      parts.push(`${driverName} is already out on ${driverOn.rc_number}.`)
    }
    if (parts.length === 0) {
      return 'That truck, that driver or this booking already has a live assignment — it may have just been crewed by someone else. Pick another pairing, or refresh the queue.'
    }
    return `${parts.join(' ')} Pick another and try again — the trip that is running has to finish or be released first.`
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!driverId || !vehicleId) {
      setErr('Pick both a driver and a truck — the trip cannot start with only one.')
      return
    }
    setBusy(true)
    setErr(null)
    setConflict(null)
    try {
      await assignToBooking(booking.id, driverId, vehicleId)
      const rc = vehicles.find(v => v.id === vehicleId)?.rc_number ?? 'The truck'
      const picked = roster.find(d => d.driver_id === driverId)
      onAssigned(rc, (picked ? nameOf(picked) : null) ?? 'the driver')
    } catch (e2) {
      if (e2 instanceof ApiError && (e2.code === 'CONFLICT' || e2.code === 'INVALID_TRANSITION')) {
        // The three partial-unique indexes just refused this pairing. Re-read who is
        // live — our view was stale, which is the whole reason the insert is the guard —
        // and keep the dialog open so another truck or driver can be picked.
        const fresh = await refreshCrew()
        setConflict(describeConflict(fresh?.vehicles ?? vehicles, fresh?.drivers ?? drivers))
      } else if (e2 instanceof ApiError && e2.code === 'FORBIDDEN') {
        setErr('That driver is no longer an active member of this fleet.')
      } else if (e2 instanceof ApiError && e2.code === 'NOT_FOUND') {
        setErr('That booking or truck is no longer available to this fleet — refresh the queue.')
      } else if (e2 instanceof ApiError && e2.code === 'CAPACITY_EXCEEDED') {
        // The truck cannot carry this load. The picker already disables under-capacity
        // trucks, but a truck whose capacity was blank client-side can still be refused
        // here — show the server's message, which names the load and the truck's rating.
        setErr(e2.message)
      } else {
        setErr(errText(e2, 'Could not assign this trip'))
      }
    } finally {
      setBusy(false)
    }
  }

  const driverOptions: PickOption[] = roster.map(d => {
    const on = busyDriver.get(d.driver_id)
    const label = nameOf(d) ?? 'Unnamed driver'
    const phone = fmtPhone(phoneOf(d))?.replace(/^\+91\s*/, '')
    return {
      value: d.driver_id,
      label: <>{label}{phone ? <span className="text-gray-500 font-normal"> · {phone}</span> : null}</>,
      tag: on ? `On a trip · ${on}` : 'Free',
      tone: on ? 'busy' : 'free',
      disabled: Boolean(on),
      leading: <Avatar name={label} size="sm" muted={Boolean(on)} />,
    }
  })

  const truckOptions: PickOption[] = trucks.map(v => {
    const on = v.current_assignment
    // A truck rated below the load's weight cannot carry it — disable it so the
    // dispatcher never picks it, mirroring the server's CAPACITY_EXCEEDED refusal.
    // Only a KNOWN capacity can disqualify a truck; a blank spec stays selectable.
    const tooSmall = v.capacity_tons != null && booking.weight_kg > v.capacity_tons * 1000
    const cap = v.capacity_tons !== null ? `${v.capacity_tons} t` : null
    return {
      value: v.id,
      label: (
        <>
          <span className={cx(MONO, 'font-semibold')}>{v.rc_number}</span>
          {v.maker_model ? <span className="text-gray-500 font-normal"> · {v.maker_model}</span> : null}
          {v.is_active ? null : <span className="text-gray-400 font-normal"> · inactive</span>}
        </>
      ),
      tag: on
        ? `On a trip${on.driver_name ? ` · ${on.driver_name}` : ''}`
        : tooSmall ? `Too small${cap ? ` · ${cap}` : ''}`
        : `Free${cap ? ` · ${cap}` : ''}`,
      tone: on ? 'busy' : tooSmall ? 'off' : 'free',
      disabled: Boolean(on) || tooSmall,
      leading: <span className="w-7 h-7 rounded-lg bg-gray-100 text-gray-500 inline-flex items-center justify-center shrink-0"><Truck className="w-4 h-4" /></span>,
    }
  })

  return (
    <Modal title="Assign a driver and a truck" sub="Choose from available drivers and trucks." onClose={onClose} width="sm:max-w-xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3.5 flex items-start gap-3.5">
          <IconTile icon={<FileText />} tint="slate" />
          <div className="min-w-0 text-sm">
            <RouteLine from={booking.source_address} to={booking.destination_address} max="max-w-[200px]" className="text-base font-bold text-gray-900" />
            <div className="text-gray-600 mt-1 tabular-nums">
              <span>{loadName(booking)}</span> · {tons(booking.weight_kg)} · pickup{' '}
              {shortDate(booking.pickup_date)} · {inr(priceOf(booking))}
            </div>
            {(booking.shipper_name ?? '').trim() !== '' && (
              <div className="text-gray-600">Shipper: {booking.shipper_name}</div>
            )}
          </div>
        </div>

        <div>
          <span id={driverLabelId} className={LABEL}>
            Driver <span className="text-red-600" aria-hidden>*</span>
          </span>
          <Picker
            id="assign-driver"
            labelId={driverLabelId}
            placeholder="Choose a driver…"
            value={driverId}
            options={driverOptions}
            onChange={v => { setDriverId(v); setConflict(null) }}
          />
          <p className="mt-1.5 text-xs text-gray-500 flex items-center gap-1.5">
            <UserRound className="w-3.5 h-3.5 text-gray-400" />
            {roster.length === 0
              ? 'Nobody has accepted a fleet invitation yet — invite a driver from the Drivers page.'
              : `${freeDrivers} of ${roster.length} active drivers are free.`}
          </p>
        </div>

        <div>
          <span id={truckLabelId} className={LABEL}>
            Truck <span className="text-red-600" aria-hidden>*</span>
          </span>
          <Picker
            id="assign-truck"
            labelId={truckLabelId}
            placeholder="Choose a truck…"
            value={vehicleId}
            options={truckOptions}
            onChange={v => { setVehicleId(v); setConflict(null) }}
          />
          <p className="mt-1.5 text-xs text-gray-500 flex items-center gap-1.5">
            <Truck className="w-3.5 h-3.5 text-gray-400" />
            {trucks.length === 0
              ? 'No trucks on this fleet yet — add one from the Trucks page.'
              : `${freeTrucks} of ${trucks.length} trucks are free.`}
          </p>
        </div>

        {conflict && (
          <div role="alert" className="rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 flex gap-3">
            <span className="w-6 h-6 rounded-full bg-orange-500 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold text-sm">!</span>
            <p className="text-sm text-orange-900 pt-0.5">{conflict}</p>
          </div>
        )}
        {err && <ErrorNote message={err} />}

        <p className="text-xs text-gray-500 flex items-start gap-1.5">
          <Info className="w-4 h-4 text-blue-600 shrink-0" />
          Binds this truck and driver until the trip finishes; no mid-trip reassignment.
        </p>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !driverId || !vehicleId} className={BTN_PRIMARY}>
            {busy ? 'Assigning…' : 'Assign trip'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
