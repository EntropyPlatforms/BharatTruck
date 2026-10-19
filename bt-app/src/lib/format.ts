// Indian-format helpers. A fleet console is dense with money and distance, so
// these live in one place rather than being re-implemented per page.

/** ₹12,34,567 — Indian digit grouping, no decimals. */
export function inr(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

/** Compact money for stat tiles: ₹12.3L / ₹1.2Cr. Lakhs and crores, not K/M. */
export function inrCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`
  return `${sign}₹${Math.round(abs)}`
}

/** Signed money, for surplus/shortfall where the sign carries the meaning. */
export function inrSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n >= 0 ? '+' : '−'}${inr(Math.abs(n))}`
}

export function km(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${Math.round(n).toLocaleString('en-IN')} km`
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export function tons(kg: number | null | undefined): string {
  if (kg === null || kg === undefined || Number.isNaN(kg)) return '—'
  return `${(kg / 1000).toFixed(1)} t`
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** "3 min ago" — used on live GPS, where staleness is the point. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.floor(hrs / 24)} d ago`
}

/** Truck age in years, the key into the non-linear service-cost curve. */
export function vehicleAge(manufactureYear: number | null | undefined): number | null {
  if (!manufactureYear) return null
  return Math.max(0, new Date().getFullYear() - manufactureYear)
}

/** Default reporting window: the trailing 30 days. */
export function defaultPeriod(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

export function periodDays(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

/**
 * Today's calendar date in India, as YYYY-MM-DD.
 *
 * Deliberately NOT the browser's local date. A pickup date is validated against IST by
 * bt-booking-service (it is an Indian shipper keying an Indian calendar date), so a
 * client computing "today" from its own timezone would disagree with the server for
 * anyone testing from outside India — offering a date the form accepts and the POST
 * then rejects.
 *
 * IST is UTC+05:30 with no DST, so shifting the epoch and reading the UTC date back is
 * exact: no Intl formatting, no locale surprises, and directly comparable to the
 * YYYY-MM-DD strings the date input produces.
 */
export function todayInIndia(): string {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)
}
