// ============================================================
// src/lib/summary/service.ts
//
// GET /me/summary — one dashboard per person, assembled from what they own and do
// (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §3.2–3.3). No persona switch: the panels a
// person sees are the ones their capabilities unlock, ordered by their front door.
//
//   fleet      operate, or a declared fleet profile (the nav's bootstrap rule)
//   truck      carry without a fleet, on a driver who owns the truck (owner-driver)
//   driving    drive
//   shipments  has posted at least one load
//
// Every section is guarded like a feed source: one that throws is dropped and named in
// degraded_sections, and the others still render. All "this month" figures run from the
// start of the IST month; delivery and payment times come from the status history
// (migration 0041) and fall back to updated_at before it is applied.
// ============================================================

import { can, resolvePersonas, type PersonaSnapshot } from '@bharattruck/shared/personas'
import type { AuthenticatedUser, BookingStatus } from '../types.js'
import { supabase } from '../supabase.js'
import { getActiveBookingsForDriver } from '../repository.js'
import { listActivePostedLoads, listLiveQuotesForBookings } from '../feed/repository.js'
import { listOpenAlertsForUser } from '../alerts/repository.js'
import { getMilestones, type Milestones } from '../milestones.js'
import { daysBetweenDates, daysSince, istDate, istMonthStart } from '../ist.js'
import { cityLabel, laneLabel } from '../place.js'
import type {
  DrivingPanel, MeSummary, ShipmentsPanel, SummaryPanel, TripCard, TruckPanel,
} from './types.js'

type Logger = { warn(obj: unknown, msg: string): void }

type Row = {
  id: string
  status: BookingStatus
  source_address: string
  destination_address: string
  pickup_date: string
  load_type: string
  weight_kg: number | string
  quoted_price: number | string
  final_price: number | string | null
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, status, source_address, destination_address, pickup_date, load_type, weight_kg, ' +
  'quoted_price, final_price, created_at, updated_at'
const DAY_MS = 24 * 60 * 60 * 1000
const LANE_WINDOW_DAYS = 90
const ACTIVE: BookingStatus[] = ['accepted', 'in_transit', 'delivery_asserted']

const amountOf = (r: Row) => Number(r.final_price ?? r.quoted_price) || 0
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** Hours from start to delivery, averaged over trips that have BOTH real times. */
function avgTransitHours(rows: Row[], ms: Map<string, Milestones>): number | null {
  const hours = rows
    .map((r) => ms.get(r.id))
    .filter((m): m is Milestones => !!m?.started_at && !!m.delivered_at)
    .map((m) => (Date.parse(m.delivered_at!) - Date.parse(m.started_at!)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
  return hours.length ? Math.round((sum(hours) / hours.length) * 10) / 10 : null
}

/** When a booking reached a milestone — from the history, else its last update. */
function when(r: Row, ms: Map<string, Milestones>, key: 'delivered_at' | 'paid_at'): string {
  return ms.get(r.id)?.[key] ?? r.updated_at
}

async function select(build: (q: any) => any, what: string): Promise<Row[]> {
  const { data, error } = await build(supabase.from('bookings').select(COLUMNS))
  if (error) throw new Error(`${what} failed: ${error.message}`)
  return (data ?? []) as Row[]
}

function card(r: Row, ms: Map<string, Milestones>): TripCard {
  return {
    booking_id: r.id,
    status: r.status,
    from: cityLabel(r.source_address),
    to: cityLabel(r.destination_address),
    pickup_date: r.pickup_date,
    load_type: r.load_type,
    weight_kg: Number(r.weight_kg) || 0,
    started_at: ms.get(r.id)?.started_at ?? null,
  }
}

// ── driving: the trip ahead and how the month went — no prices anywhere ──────

async function drivingPanel(driverId: string, now: Date, monthStart: Date, alerts: number): Promise<DrivingPanel> {
  const [active, deliveredRecently, licences] = await Promise.all([
    getActiveBookingsForDriver(driverId) as unknown as Promise<Row[]>,
    select((q) => q.eq('driver_id', driverId).in('status', ['delivery_asserted', 'completed', 'paid'])
      .gte('updated_at', monthStart.toISOString()), 'driver month select'),
    supabase.from('driver_licenses').select('expiry_date').eq('driver_id', driverId),
  ])
  if (licences.error) throw new Error(`driver_licenses select failed: ${licences.error.message}`)
  const ms = await getMilestones([...active, ...deliveredRecently].map((r) => r.id))

  const moving = active.filter((r) => r.status !== 'accepted').sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  const waiting = active.filter((r) => r.status === 'accepted').sort((a, b) => (a.pickup_date < b.pickup_date ? -1 : 1))
  const current = moving[0] ?? waiting[0] ?? null
  const upcoming = waiting.filter((r) => r.id !== current?.id).slice(0, 3)

  const deliveredThisMonth = deliveredRecently.filter((r) => Date.parse(when(r, ms, 'delivered_at')) >= monthStart.getTime())
  const expiries = ((licences.data ?? []) as Array<{ expiry_date: string | null }>)
    .map((l) => l.expiry_date).filter((d): d is string => !!d).sort()
  const latest = expiries[expiries.length - 1] ?? null

  return {
    current_trip: current ? card(current, ms) : null,
    upcoming: upcoming.map((r) => card(r, ms)),
    month: { delivered: deliveredThisMonth.length, avg_transit_hours: avgTransitHours(deliveredThisMonth, ms) },
    licence: (licences.data ?? []).length
      ? { expiry_date: latest, days_left: latest ? daysBetweenDates(istDate(now), latest) : null }
      : null,
    open_alerts: alerts,
  }
}

// ── truck: an owner-driver's own business — only trips on their own truck ─────

async function truckPanel(driverId: string, now: Date, monthStart: Date, alerts: number): Promise<TruckPanel> {
  // Own trips only: a trip a fleet assigned them belongs to that fleet's money (§1.1).
  const own = (q: any) => q.eq('driver_id', driverId).is('fleet_owner_id', null)
  const [vehicleRes, live, paidRecently, quotesRes] = await Promise.all([
    supabase.from('vehicles').select('id, rc_number').eq('driver_id', driverId).is('fleet_owner_id', null).limit(1).maybeSingle(),
    select((q) => own(q).in('status', [...ACTIVE, 'completed']), 'own trips select'),
    select((q) => own(q).eq('status', 'paid').gte('updated_at', monthStart.toISOString()), 'own paid select'),
    supabase.from('quotes').select('status').eq('driver_id', driverId).in('status', ['submitted', 'countered']),
  ])
  if (vehicleRes.error) throw new Error(`vehicles select failed: ${vehicleRes.error.message}`)
  if (quotesRes.error) throw new Error(`quotes select failed: ${quotesRes.error.message}`)
  const vehicle = vehicleRes.data as { id: string; rc_number: string } | null

  let emi: number | null = null
  if (vehicle) {
    const fin = await supabase.from('vehicle_finance').select('emi_amount_inr').eq('vehicle_id', vehicle.id).maybeSingle()
    if (fin.error) throw new Error(`vehicle_finance select failed: ${fin.error.message}`)
    const v = (fin.data as { emi_amount_inr?: number | string } | null)?.emi_amount_inr
    emi = v == null ? null : Number(v)
  }

  const owedRows = live.filter((r) => r.status === 'completed')
  const ms = await getMilestones([...owedRows, ...paidRecently].map((r) => r.id))
  const paidThisMonth = paidRecently.filter((r) => Date.parse(when(r, ms, 'paid_at')) >= monthStart.getTime())
  const ages = owedRows.map((r) => daysSince(when(r, ms, 'delivered_at'), now)).filter(Number.isFinite)
  const quotes = (quotesRes.data ?? []) as Array<{ status: string }>

  return {
    vehicle,
    month: { earned_inr: sum(paidThisMonth.map(amountOf)), trips_paid: paidThisMonth.length, emi_inr: emi },
    owed: { amount_inr: sum(owedRows.map(amountOf)), trips: owedRows.length, oldest_days: ages.length ? Math.max(...ages) : null },
    in_progress: live.filter((r) => ACTIVE.includes(r.status)).length,
    bids: {
      live: quotes.filter((q) => q.status === 'submitted').length,
      countered: quotes.filter((q) => q.status === 'countered').length,
    },
    open_alerts: alerts,
  }
}

// ── shipments: the shipper's own loads and spend ─────────────────────────────

async function shipmentsPanel(userId: string, now: Date, monthStart: Date, alerts: number): Promise<ShipmentsPanel | null> {
  const posted = await supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('shipper_id', userId)
  if (posted.error) throw new Error(`shipper count failed: ${posted.error.message}`)
  if (!posted.count) return null // never posted a load: no shipments panel (ship is universal)

  const since = new Date(now.getTime() - LANE_WINDOW_DAYS * DAY_MS).toISOString()
  const [liveRows, recentRows, openLoads] = await Promise.all([
    select((q) => q.eq('shipper_id', userId).in('status', ['in_transit', 'delivery_asserted', 'completed']), 'shipper live select'),
    select((q) => q.eq('shipper_id', userId).gte('updated_at', since), 'shipper recent select'),
    listActivePostedLoads(userId),
  ])
  const byId = new Map<string, Row>([...recentRows, ...liveRows].map((r) => [r.id, r]))
  const rows = [...byId.values()]
  const ms = await getMilestones(rows.map((r) => r.id))
  const quotes = openLoads.length ? await listLiveQuotesForBookings(openLoads.map((b) => b.id)) : []

  const inMonth = (iso: string) => Date.parse(iso) >= monthStart.getTime()
  const delivered = rows.filter((r) => ['delivery_asserted', 'completed', 'paid'].includes(r.status) && inMonth(when(r, ms, 'delivered_at')))
  const paid = rows.filter((r) => r.status === 'paid' && inMonth(when(r, ms, 'paid_at')))
  const due = rows.filter((r) => r.status === 'completed')
  const dueAges = due.map((r) => daysSince(when(r, ms, 'delivered_at'), now)).filter(Number.isFinite)

  const lanes = new Map<string, { spend: number; loads: number }>()
  for (const r of rows.filter((x) => x.status === 'paid' || x.status === 'completed')) {
    const key = laneLabel(r.source_address, r.destination_address)
    const l = lanes.get(key) ?? { spend: 0, loads: 0 }
    l.spend += amountOf(r)
    l.loads += 1
    lanes.set(key, l)
  }

  return {
    month: {
      posted: rows.filter((r) => inMonth(r.created_at)).length,
      delivered: delivered.length,
      paid_inr: sum(paid.map(amountOf)),
      avg_transit_hours: avgTransitHours(delivered, ms),
    },
    due: { amount_inr: sum(due.map(amountOf)), trips: due.length, oldest_days: dueAges.length ? Math.max(...dueAges) : null },
    bids_waiting: { bids: quotes.length, loads: new Set(quotes.map((q) => q.booking_id)).size },
    on_the_road: rows
      .filter((r) => r.status === 'in_transit')
      .map((r) => ({ booking_id: r.id, from: cityLabel(r.source_address), to: cityLabel(r.destination_address), started_at: ms.get(r.id)?.started_at ?? null }))
      .sort((a, b) => ((a.started_at ?? '') < (b.started_at ?? '') ? 1 : -1))
      .slice(0, 5),
    lanes: [...lanes.entries()]
      .map(([lane, l]) => ({ lane, spend_inr: l.spend, loads: l.loads }))
      .sort((a, b) => b.spend_inr - a.spend_inr)
      .slice(0, 5),
    open_alerts: alerts,
  }
}

// ── assembly ─────────────────────────────────────────────────────────────────

/** Front door first (D-32): the persona someone signed up as leads their dashboard. */
function panelOrder(snapshot: PersonaSnapshot): SummaryPanel[] {
  switch (snapshot.primary_persona) {
    case 'fleet_owner':
    case 'admin':
      return ['fleet', 'truck', 'driving', 'shipments']
    case 'driver':
      return ['truck', 'driving', 'fleet', 'shipments']
    default:
      return ['shipments', 'fleet', 'truck', 'driving']
  }
}

export async function getMySummary(actor: AuthenticatedUser, now: Date = new Date(), log?: Logger): Promise<MeSummary> {
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  const monthStart = istMonthStart(now)

  const hasFleet = can(snapshot, 'operate') || !!snapshot.fleet_owner_id
  const driverId = snapshot.driver_id
  const showDriving = can(snapshot, 'drive') && !!driverId
  const showTruck = can(snapshot, 'carry') && !hasFleet && !!driverId

  const degraded: string[] = []
  const guard = async <T,>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (err) {
      log?.warn({ err, section: name }, 'summary section failed — returning the others')
      degraded.push(name)
      return null
    }
  }

  // One alerts read, split by the persona each alert was written for.
  const alerts = (await guard('alerts', () => listOpenAlertsForUser(snapshot.user_id))) ?? []
  const count = (persona: string) => alerts.filter((a) => a.persona === persona).length

  const [driving, truck, shipments] = await Promise.all([
    showDriving ? guard('driving', () => drivingPanel(driverId!, now, monthStart, count('driver'))) : Promise.resolve(null),
    showTruck ? guard('truck', () => truckPanel(driverId!, now, monthStart, count('carrier'))) : Promise.resolve(null),
    guard('shipments', () => shipmentsPanel(snapshot.user_id, now, monthStart, count('shipper'))),
  ])

  const present: Record<SummaryPanel, boolean> = {
    fleet: hasFleet,
    truck: !!truck,
    driving: !!driving,
    shipments: !!shipments,
  }

  return {
    generated_at: now.toISOString(),
    month_start: monthStart.toISOString(),
    panels: panelOrder(snapshot).filter((p) => present[p]),
    driving,
    truck,
    shipments,
    degraded_sections: degraded,
  }
}
