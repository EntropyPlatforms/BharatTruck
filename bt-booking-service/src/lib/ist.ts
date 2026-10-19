// ============================================================
// src/lib/ist.ts
//
// India-time calendar helpers that take the clock as an ARGUMENT, so rules built on
// them (the alert sweep, the /me/summary month) are testable at any instant. IST is
// UTC+05:30 with no DST, so shifting the epoch and reading the UTC fields back is
// exact. (types.ts istToday() is the same idea bound to Date.now().)
// ============================================================

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** The IST calendar date of an instant, as YYYY-MM-DD (comparable to a DATE column). */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The instant the current IST calendar month began (00:00 IST on the 1st). */
export function istMonthStart(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS)
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS)
}

/** Whole calendar days from one YYYY-MM-DD to another (positive when `to` is later). */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** Whole days elapsed since an instant (floored; 0 within the first 24 hours). */
export function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)
}
