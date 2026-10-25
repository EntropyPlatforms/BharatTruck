// ============================================================
// src/lib/alerts/rules-wave1.ts
//
// Wave 1 of the ranked new alerts (18 Oct "32 new alerts, ranked"): the ones that run on data
// already stored, inside the alerts table's limits (subject = booking | vehicle | driver).
// PURE like rules.ts — facts and `now` in, drafts out — so every threshold is unit-tested
// (test/alert-rules-wave1.unit.mts).
//
//   ewb_expiring          #2  e-way bill valid-until within 8 h while the truck is moving
//   delivered_away        #3  delivery 2+ km from the drop address
//   documents_not_ready   #4  pickup tomorrow; invoice / e-way bill / LR missing
//   pickup_no_truck       #5  fleet won the load; nothing assigned the day before pickup
//   at_drop_not_delivered #7  inside the drop fence 2+ h with no delivery code
//   damage_reported       #8  damage logged at delivery
//   delivery_unconfirmed  #12 driver marked delivered; unconfirmed after 24 h
//   no_bids               #14 load posted 6+ h ago with zero bids
//   truck_idle            #22 active truck with no trip in 5+ days
//
// Same identity rules as rules.ts: a fleet-won trip answers to the fleet owner; a solo trip to
// the driver; a 'driver' alert never carries a freight amount.
// ============================================================

import { daysBetweenDates, istDate } from '../ist.js'
import { laneLabel } from '../place.js'
import type { Audience, BookingFact } from './rules.js'
import type { AlertDraft, AlertPersona, AlertSeverity } from './types.js'

export const EWB_WARN_HOURS = 8
export const EWB_CRITICAL_HOURS = 2
export const DELIVERED_AWAY_M = 2000
export const AT_DROP_HOURS = 2
export const UNCONFIRMED_WARN_HOURS = 24
export const UNCONFIRMED_CRITICAL_HOURS = 72
export const NO_BIDS_HOURS = 6
export const IDLE_DAYS = 5

type Recipient = { userId: string; persona: AlertPersona }
const HOUR_MS = 3600_000
const hoursBetween = (fromIso: string, now: Date) => (now.getTime() - Date.parse(fromIso)) / HOUR_MS
const fmtHours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`)
const km = (m: number) => `${(m / 1000).toFixed(1)} km`

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
function uniqueByUser(rs: Array<Recipient | null>): Recipient[] {
  const seen = new Map<string, Recipient>()
  for (const r of rs) if (r && !seen.has(r.userId)) seen.set(r.userId, r)
  return [...seen.values()]
}
function draft(kind: AlertDraft['kind'], p: Recipient, severity: AlertSeverity, subjectType: AlertDraft['subject_type'], subjectId: string, title: string, detail: AlertDraft['detail']): AlertDraft {
  return { audience_user_id: p.userId, persona: p.persona, kind, severity, subject_type: subjectType, subject_id: subjectId, title, detail, dedupe_key: `${kind}:${subjectId}:${p.userId}` }
}

// ── #2 E-way bill expiring in transit (frequent) ─────────────────────────────

export type EwbFact = { booking: BookingFact; ewbNumber: string | null; validUpto: string }

export function ewbExpiringAlerts(items: EwbFact[], audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, ewbNumber, validUpto } of items) {
    if (b.status !== 'in_transit') continue
    const left = -hoursBetween(validUpto, now) // hours until expiry; negative = expired
    if (!Number.isFinite(left) || left > EWB_WARN_HOURS) continue
    const expired = left <= 0
    const severity: AlertSeverity = left <= EWB_CRITICAL_HOURS ? 'critical' : 'warning'
    const lane = laneLabel(b.source_address, b.destination_address)
    const when = expired ? 'has expired' : `expires in ${fmtHours(left)}`
    // The shipper alone can extend it on the portal; the carrier must know before a checkpoint.
    for (const p of uniqueByUser([{ userId: b.shipper_id, persona: 'shipper' }, carrierOf(b, audience, 'driving')])) {
      const toShipper = p.persona === 'shipper'
      out.push(draft('ewb_expiring', p, severity, 'booking', b.id,
        `E-way bill ${when} — ${lane}`,
        {
          subtitle: toShipper
            ? `The truck is still on the road. Extend the bill${ewbNumber ? ` ${ewbNumber}` : ''} on the portal before it lapses.`
            : 'The truck is still moving. A lapsed bill means a fine or a held truck — ask the shipper to extend it.',
          booking_id: b.id, ewb_number: ewbNumber, valid_upto: validUpto, hours_left: Math.round(left * 10) / 10,
        }))
    }
  }
  return out
}

// ── #3 Delivered away from the drop (frequent) ───────────────────────────────

export type DeliveredAwayFact = { booking: BookingFact; distanceM: number; source: 'code_issue' | 'delivery_photo' }

export function deliveredAwayAlerts(items: DeliveredAwayFact[], audience: Audience, _now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, distanceM, source } of items) {
    if (!['delivery_asserted', 'completed'].includes(b.status)) continue
    if (!(distanceM >= DELIVERED_AWAY_M)) continue
    const lane = laneLabel(b.source_address, b.destination_address)
    const where = source === 'code_issue' ? 'when the delivery code was requested' : 'in the delivery photo'
    for (const p of uniqueByUser([{ userId: b.shipper_id, persona: 'shipper' }, carrierOf(b, audience, 'money')])) {
      out.push(draft('delivered_away', p, 'warning', 'booking', b.id,
        `Delivered ${km(distanceM)} from the drop address — ${lane}`,
        { subtitle: `The truck was ${km(distanceM)} from the drop ${where}. Check with the receiver before paying.`, booking_id: b.id, distance_m: Math.round(distanceM), source }))
    }
  }
  return out
}

// ── #4 Documents not ready for tomorrow's pickup (daily) ─────────────────────

export type DocsFact = { booking: BookingFact; missingInvoice: boolean; missingEwb: boolean; missingLr: boolean }

export function documentsNotReadyAlerts(items: DocsFact[], audience: Audience, now: Date): AlertDraft[] {
  const today = istDate(now)
  const out: AlertDraft[] = []
  for (const { booking: b, missingInvoice, missingEwb, missingLr } of items) {
    if (b.status !== 'accepted') continue
    const until = daysBetweenDates(today, b.pickup_date)
    if (until !== 0 && until !== 1) continue // today or tomorrow
    const lane = laneLabel(b.source_address, b.destination_address)
    const when = until === 0 ? 'today' : 'tomorrow'
    const shipperMissing = [missingInvoice ? 'the tax invoice' : null, missingEwb ? 'the e-way bill' : null].filter(Boolean) as string[]
    if (shipperMissing.length) {
      // Start trip refuses without these — warn the day before, critical on the day.
      out.push(draft('documents_not_ready', { userId: b.shipper_id, persona: 'shipper' }, until === 0 ? 'critical' : 'warning', 'booking', b.id,
        `Pickup ${when}: ${shipperMissing.join(' and ')} missing — ${lane}`,
        { subtitle: `The truck cannot start without ${shipperMissing.join(' and ')}. Add ${shipperMissing.length > 1 ? 'them' : 'it'} on the load's Documents tab.`, booking_id: b.id, missing: shipperMissing }))
    }
    const carrier = carrierOf(b, audience, 'money')
    if (missingLr && carrier && carrier.userId !== b.shipper_id) {
      out.push(draft('documents_not_ready', carrier, 'info', 'booking', b.id,
        `Pickup ${when}: issue the lorry receipt — ${lane}`,
        { subtitle: 'Issue the LR from the trip\'s Documents tab before loading.', booking_id: b.id, missing: ['the lorry receipt'] }))
    }
  }
  return out
}

// ── #5 Pickup tomorrow, no truck (daily) ─────────────────────────────────────

export type PickupFact = { booking: BookingFact; assigned: boolean }

export function pickupNoTruckAlerts(items: PickupFact[], audience: Audience, now: Date): AlertDraft[] {
  const today = istDate(now)
  const out: AlertDraft[] = []
  for (const { booking: b, assigned } of items) {
    if (b.status !== 'accepted' || !b.fleet_owner_id || assigned) continue
    const until = daysBetweenDates(today, b.pickup_date)
    if (until !== 0 && until !== 1) continue
    const owner = carrierOf(b, audience, 'money')
    if (!owner) continue
    const lane = laneLabel(b.source_address, b.destination_address)
    out.push(draft('pickup_no_truck', owner, until === 0 ? 'critical' : 'warning', 'booking', b.id,
      `Pickup ${until === 0 ? 'today' : 'tomorrow'} and no truck assigned — ${lane}`,
      { subtitle: 'Assign a truck and driver in Trips → Needs assignment, or the shipper loses the pickup.', booking_id: b.id }))
  }
  return out
}

// ── #7 At the drop, not delivered (frequent) ─────────────────────────────────

export type AtDropFact = { booking: BookingFact; enteredAt: string | null; exited: boolean }

export function atDropNotDeliveredAlerts(items: AtDropFact[], audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, enteredAt, exited } of items) {
    if (b.status !== 'in_transit' || !enteredAt || exited) continue
    const hours = hoursBetween(enteredAt, now)
    if (!(hours >= AT_DROP_HOURS)) continue
    const lane = laneLabel(b.source_address, b.destination_address)
    const driverUser = b.driver_id ? audience.driverUser.get(b.driver_id) : undefined
    for (const p of uniqueByUser([
      { userId: b.shipper_id, persona: 'shipper' },
      carrierOf(b, audience, 'driving'),
      driverUser ? { userId: driverUser, persona: 'driver' } : null,
    ])) {
      const sub = p.persona === 'shipper'
        ? 'The truck is at the drop. Ask the receiver for the delivery code so the trip can close.'
        : p.persona === 'driver'
          ? 'Ask the receiver for the delivery code, or mark it delivered with a photo.'
          : 'The truck has waited at the drop. The trip can\'t close until the delivery code is entered.'
      out.push(draft('at_drop_not_delivered', p, hours >= 2 * AT_DROP_HOURS ? 'critical' : 'warning', 'booking', b.id,
        `At the drop for ${fmtHours(hours)}, not delivered — ${lane}`,
        { subtitle: sub, booking_id: b.id, hours_at_drop: Math.round(hours * 10) / 10 }))
    }
  }
  return out
}

// ── #8 Damage reported (frequent) ────────────────────────────────────────────

export type DamageFact = { booking: BookingFact; reportedAt: string; delta: number | null; unit: string | null }

export function damageReportedAlerts(items: DamageFact[], audience: Audience, _now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, delta, unit } of items) {
    // Open while money is still to settle; closes when the trip is paid or cancelled.
    if (['paid', 'cancelled'].includes(b.status)) continue
    const lane = laneLabel(b.source_address, b.destination_address)
    const qty = delta !== null && Number.isFinite(delta) && delta !== 0 ? ` (${Math.abs(delta)} ${unit ?? 'units'})` : ''
    for (const p of uniqueByUser([{ userId: b.shipper_id, persona: 'shipper' }, carrierOf(b, audience, 'money')])) {
      out.push(draft('damage_reported', p, 'warning', 'booking', b.id,
        `Damage reported at delivery${qty} — ${lane}`,
        { subtitle: p.persona === 'shipper' ? 'See the photo and agree the claim before paying.' : 'A damage claim is open on this trip — check the photo and settle it with the shipper.', booking_id: b.id }))
    }
  }
  return out
}

// ── #12 Delivery not confirmed (daily) ───────────────────────────────────────

export type UnconfirmedFact = { booking: BookingFact; assertedAt: string | null }

export function deliveryUnconfirmedAlerts(items: UnconfirmedFact[], audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, assertedAt } of items) {
    if (b.status !== 'delivery_asserted') continue
    const hours = hoursBetween(assertedAt ?? b.updated_at, now)
    if (!(hours >= UNCONFIRMED_WARN_HOURS)) continue
    const severity: AlertSeverity = hours >= UNCONFIRMED_CRITICAL_HOURS ? 'critical' : 'warning'
    const lane = laneLabel(b.source_address, b.destination_address)
    const ago = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.round(hours)} h`
    for (const p of uniqueByUser([{ userId: b.shipper_id, persona: 'shipper' }, carrierOf(b, audience, 'money')])) {
      out.push(draft('delivery_unconfirmed', p, severity, 'booking', b.id,
        `Delivery not confirmed for ${ago} — ${lane}`,
        { subtitle: p.persona === 'shipper' ? 'The driver marked it delivered. Confirm it (or report a problem) so the trip can be paid.' : 'Marked delivered but not confirmed yet — ask the shipper or receiver to confirm.', booking_id: b.id, hours_unconfirmed: Math.round(hours) }))
    }
  }
  return out
}

// ── #14 No bids yet (frequent) ───────────────────────────────────────────────

export type OpenLoadFact = { booking: BookingFact; createdAt: string; openToBids: boolean; bidCount: number }

export function noBidsAlerts(items: OpenLoadFact[], _audience: Audience, now: Date): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { booking: b, createdAt, openToBids, bidCount } of items) {
    if (!['pending', 'negotiating'].includes(b.status) || !openToBids || bidCount > 0) continue
    const hours = hoursBetween(createdAt, now)
    if (!(hours >= NO_BIDS_HOURS)) continue
    const lane = laneLabel(b.source_address, b.destination_address)
    out.push(draft('no_bids', { userId: b.shipper_id, persona: 'shipper' }, hours >= 24 ? 'warning' : 'info', 'booking', b.id,
      `No bids yet after ${fmtHours(hours)} — ${lane}`,
      { subtitle: 'Carriers have not bid on this load. Raising the price or moving the pickup date usually helps.', booking_id: b.id, hours_open: Math.round(hours) }))
  }
  return out
}

// ── #22 Truck idle (daily) ───────────────────────────────────────────────────

export type IdleTruckFact = {
  vehicle_id: string
  rc_number: string | null
  /** fleet_owners.id, or null for a solo truck. */
  fleet_owner_id: string | null
  /** drivers.id of the solo driver (solo trucks). */
  driver_id: string | null
  /** The last time the truck worked (latest trip activity), or when it was added if never. */
  lastActiveAt: string
  /** On a trip right now (live assignment or an open booking). */
  busy: boolean
}

export function truckIdleAlerts(items: IdleTruckFact[], audience: Audience, now: Date): AlertDraft[] {
  const today = istDate(now)
  const out: AlertDraft[] = []
  for (const t of items) {
    if (t.busy) continue
    const idle = daysBetweenDates(istDate(new Date(t.lastActiveAt)), today)
    if (!(idle >= IDLE_DAYS)) continue
    const owner = t.fleet_owner_id ? audience.fleetOwnerUser.get(t.fleet_owner_id) : t.driver_id ? audience.driverUser.get(t.driver_id) : undefined
    if (!owner) continue
    const persona: AlertPersona = t.fleet_owner_id ? 'fleet' : 'carrier'
    out.push(draft('truck_idle', { userId: owner, persona }, 'info', 'vehicle', t.vehicle_id,
      `${t.rc_number ?? 'A truck'} has had no trip for ${idle} days`,
      { subtitle: 'Loads are posted every day — find one on the load board for this truck.', vehicle_id: t.vehicle_id, idle_days: idle }))
  }
  return out
}
