// ============================================================
// src/lib/alerts/rules.ts
//
// PURE: facts in, alert drafts out. No I/O and no clock of their own (`now` is an
// argument), so every threshold is unit-tested (test/alert-rules.unit.mts).
//
// Who hears about what follows the identity model:
//   - A fleet-won trip answers to the FLEET OWNER (founder Q15) — persona 'fleet'.
//   - A solo trip answers to the driver who owns the truck — 'carrier' for money,
//     'driver' for driving.
//   - Money follows ownership (§1.1): a 'driver' alert NEVER carries a freight amount.
// ============================================================

import type { BookingStatus } from '../types.js'
import { daysBetweenDates, daysSince, istDate } from '../ist.js'
import { laneLabel } from '../place.js'
import type { AlertDraft, AlertPersona, AlertSeverity } from './types.js'

export const GPS_SILENT_WARN_MINUTES = 15
export const GPS_SILENT_CRITICAL_MINUTES = 120
export const NOT_STARTED_CRITICAL_DAYS = 3
export const UNPAID_WARN_DAYS = 3
export const UNPAID_CRITICAL_DAYS = 7
export const LICENCE_WARN_DAYS = 30

/** The booking columns the rules read. Numerics may arrive from PostgREST as strings. */
export type BookingFact = {
  id: string
  status: BookingStatus
  shipper_id: string
  driver_id: string | null
  fleet_owner_id: string | null
  source_address: string
  destination_address: string
  pickup_date: string
  updated_at: string
  quoted_price: number | string
  final_price: number | string | null
}

/** users.id behind the drivers.id / fleet_owners.id a booking names (the two-hop identities). */
export type Audience = {
  driverUser: Map<string, string>
  fleetOwnerUser: Map<string, string>
}

type Recipient = { userId: string; persona: AlertPersona }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const amountOf = (b: BookingFact) => Number(b.final_price ?? b.quoted_price) || 0
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const prettyDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** The commercial party of a trip. */
function carrierOf(b: BookingFact, a: Audience, role: 'money' | 'driving'): Recipient | null {
  if (b.fleet_owner_id) {
    const userId = a.fleetOwnerUser.get(b.fleet_owner_id)
    return userId ? { userId, persona: 'fleet' } : null
  }
  if (b.driver_id) {
    const userId = a.driverUser.get(b.driver_id)
    return userId ? { userId, persona: role === 'money' ? 'carrier' : 'driver' } : null
  }
  return null
}

/** One alert per person: the first role listed wins when two roles are the same human. */
function uniqueByUser(recipients: Array<Recipient | null>): Recipient[] {
  const seen = new Map<string, Recipient>()
  for (const r of recipients) if (r && !seen.has(r.userId)) seen.set(r.userId, r)
  return [...seen.values()]
}

// ── GPS silent during a trip (every 5 minutes) ───────────────────────────────

export type TripFix = { booking: BookingFact; lastFixAt: string | null; startedAt: string | null }

export function gpsSilentAlerts(trips: TripFix[], audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, lastFixAt, startedAt } of trips) {
    if (b.status !== 'in_transit') continue
    const since = lastFixAt ?? startedAt ?? b.updated_at
    const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000)
    if (!Number.isFinite(minutes) || minutes < GPS_SILENT_WARN_MINUTES) continue

    const severity: AlertSeverity = minutes >= GPS_SILENT_CRITICAL_MINUTES ? 'critical' : 'warning'
    const lane = laneLabel(b.source_address, b.destination_address)
    const silentFor = minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`
    const driverUser = b.driver_id ? audience.driverUser.get(b.driver_id) : undefined

    const people = uniqueByUser([
      carrierOf(b, audience, 'driving'),
      driverUser ? { userId: driverUser, persona: 'driver' } : null,
    ])
    for (const p of people) {
      const toDriver = p.persona === 'driver'
      out.push({
        audience_user_id: p.userId,
        persona: p.persona,
        kind: 'gps_silent',
        severity,
        subject_type: 'booking',
        subject_id: b.id,
        title: toDriver ? `Your location isn’t reaching us — ${lane}` : `No GPS for ${silentFor} — ${lane}`,
        detail: {
          subtitle: toDriver
            ? 'Open the trip screen so your owner and the shipper can see the truck.'
            : lastFixAt
              ? `Last location ${silentFor} ago. Call the driver or open the live map.`
              : `No location since the trip started, ${silentFor} ago.`,
          booking_id: b.id,
          minutes_silent: minutes,
        },
        dedupe_key: `gps_silent:${b.id}:${p.userId}`,
      })
    }
  }
  return out
}

// ── Trip not started by its pickup date (daily) ──────────────────────────────

export function tripNotStartedAlerts(bookings: BookingFact[], audience: Audience, now: Date): AlertDraft[] {
  const today = istDate(now)
  const out: AlertDraft[] = []
  for (const b of bookings) {
    if (b.status !== 'accepted') continue
    // pickup_date is a DATE with no time, so "late" is measured in whole IST days.
    const late = daysBetweenDates(b.pickup_date, today)
    if (late < 1) continue

    const severity: AlertSeverity = late >= NOT_STARTED_CRITICAL_DAYS ? 'critical' : 'warning'
    const lane = laneLabel(b.source_address, b.destination_address)
    const when = late === 1 ? 'yesterday' : `${plural(late, 'day')} ago`
    const carrier = carrierOf(b, audience, 'driving')
    const people = uniqueByUser([carrier, { userId: b.shipper_id, persona: 'shipper' }])

    for (const p of people) {
      const toShipper = p.persona === 'shipper'
      out.push({
        audience_user_id: p.userId,
        persona: p.persona,
        kind: 'trip_not_started',
        severity,
        subject_type: 'booking',
        subject_id: b.id,
        title: toShipper ? `Not picked up yet — ${lane}` : `Trip not started — pickup was ${when}`,
        detail: {
          subtitle: toShipper
            ? `Pickup was due ${prettyDate(b.pickup_date)}; the carrier hasn’t started the trip.`
            : `${lane}. Start the trip, or tell the shipper about the delay.`,
          booking_id: b.id,
          days_late: late,
        },
        dedupe_key: `trip_not_started:${b.id}:${p.userId}`,
      })
    }
  }
  return out
}

// ── Delivered but not paid (daily) ───────────────────────────────────────────

export type DeliveredFact = { booking: BookingFact; deliveredAt: string | null }

export function unpaidOverdueAlerts(items: DeliveredFact[], audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, deliveredAt } of items) {
    // 'completed' is the only payable state; a delivery still being confirmed is not owed yet.
    if (b.status !== 'completed') continue
    // The age is counted from DELIVERY (the trigger's history), not from pickup. Before 0041
    // there is no delivery time, so the last update stands in for it.
    const days = daysSince(deliveredAt ?? b.updated_at, now)
    if (!Number.isFinite(days) || days < UNPAID_WARN_DAYS) continue

    const severity: AlertSeverity = days >= UNPAID_CRITICAL_DAYS ? 'critical' : 'warning'
    const amount = amountOf(b)
    const lane = laneLabel(b.source_address, b.destination_address)
    // Money alerts go to the stakeholders only — never to a hired driver (§1.1).
    const people = uniqueByUser([carrierOf(b, audience, 'money'), { userId: b.shipper_id, persona: 'shipper' }])

    for (const p of people) {
      const toShipper = p.persona === 'shipper'
      out.push({
        audience_user_id: p.userId,
        persona: p.persona,
        kind: 'unpaid_overdue',
        severity,
        subject_type: 'booking',
        subject_id: b.id,
        title: toShipper ? `Payment due: ${inr(amount)} for ${lane}` : `${inr(amount)} not paid for ${plural(days, 'day')}`,
        detail: {
          subtitle: toShipper
            ? `Delivered ${plural(days, 'day')} ago — record the payment to close the trip.`
            : `${lane} · delivered ${plural(days, 'day')} ago.`,
          booking_id: b.id,
          amount_inr: amount,
          days_unpaid: days,
        },
        dedupe_key: `unpaid_overdue:${b.id}:${p.userId}`,
      })
    }
  }
  return out
}

// ── Driving licence expiring (daily) ─────────────────────────────────────────

export type LicenceFact = {
  driver_id: string
  expiry_date: string
  driver_name: string | null
  /** fleet_owners.id of every fleet this driver holds an ACTIVE seat with. */
  fleet_owner_ids: string[]
}

export function licenceExpiringAlerts(licences: LicenceFact[], audience: Audience, now: Date): AlertDraft[] {
  const today = istDate(now)
  const out: AlertDraft[] = []
  for (const l of licences) {
    const left = daysBetweenDates(today, l.expiry_date)
    if (left > LICENCE_WARN_DAYS) continue

    const severity: AlertSeverity = left < 0 ? 'critical' : 'warning'
    const when = left < 0 ? `expired ${plural(-left, 'day')} ago` : left === 0 ? 'expires today' : `expires in ${plural(left, 'day')}`
    const driverUser = audience.driverUser.get(l.driver_id)
    const owners = l.fleet_owner_ids.map((fo) => audience.fleetOwnerUser.get(fo))
    const people = uniqueByUser([
      driverUser ? { userId: driverUser, persona: 'driver' } : null,
      ...owners.map((u) => (u ? { userId: u, persona: 'fleet' as const } : null)),
    ])

    for (const p of people) {
      const toDriver = p.persona === 'driver'
      out.push({
        audience_user_id: p.userId,
        persona: p.persona,
        kind: 'licence_expiring',
        severity,
        subject_type: 'driver',
        subject_id: l.driver_id,
        title: toDriver ? `Your driving licence ${when}` : `${l.driver_name ?? 'A driver'}’s licence ${when}`,
        detail: {
          subtitle: toDriver
            ? 'Renew it at the RTO, then update it on your Driver profile.'
            : 'They will need a valid licence before their next trip.',
          expiry_date: l.expiry_date,
          days_left: left,
        },
        dedupe_key: `licence_expiring:${l.driver_id}:${p.userId}`,
      })
    }
  }
  return out
}
