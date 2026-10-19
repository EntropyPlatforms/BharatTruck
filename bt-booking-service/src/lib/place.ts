// ============================================================
// src/lib/place.ts
//
// A short, human label for a stored address — "Mumbai" rather than "Andheri East,
// Mumbai, Maharashtra 400069, India". Used where a whole address is too long: alert
// titles and the shipper's spend-by-lane. Booking addresses come both from the geocoded
// picker (long, comma-separated) and from older hand-typed rows (often just a city), so
// this strips the trailing country, the pincode-bearing part and a bare state name, and
// keeps the last part that is left — the city in both shapes.
// ============================================================

import { gstStateCode } from '@bharattruck/shared/india-states'

const PINCODE = /\b\d{6}\b/
// Union territories that are also the city: "Sector 17, Chandigarh, 160017, India" must
// keep "Chandigarh", where "Panaji, Goa, India" should drop the state and keep "Panaji".
const CITY_STATE_CODES = new Set(['04', '07', '34']) // Chandigarh, Delhi, Puducherry

export function cityLabel(address: string | null | undefined): string {
  if (!address) return '—'
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean)
  const kept = parts.filter((p, i) => {
    if (i === 0) return true // never strip the only/first part
    if (/^india$/i.test(p)) return false
    if (PINCODE.test(p)) return false // "Maharashtra 400069", or a bare pincode
    const code = /^[0-9]{2}$/.test(p) ? null : gstStateCode(p)
    if (code && !CITY_STATE_CODES.has(code)) return false // a bare state name
    return true
  })
  return kept[kept.length - 1] ?? address
}

/** "Mumbai → Nagpur" for a booking's two addresses. */
export function laneLabel(from: string | null | undefined, to: string | null | undefined): string {
  return `${cityLabel(from)} → ${cityLabel(to)}`
}
