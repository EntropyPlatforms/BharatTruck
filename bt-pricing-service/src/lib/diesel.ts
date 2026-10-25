// -----------------------------------------------------------
// diesel — the ONE diesel price every pricing path reads.
//
// Order: the per-state row in public.diesel_prices (when the caller knows the GST state code)
// → the national row in public.fleet_cost_settings (fleet_owner_id IS NULL, the same row the
// cost floor uses) → DIESEL_PRICE_INR env → ₹90. Loaded from the database at start-up and
// refreshed every 6 hours in the background, so the synchronous getter used by the quote maths
// never waits on a network call; until the first load completes it falls back to the env.
// Editing the price is now one row in the database, not a redeploy.
// -----------------------------------------------------------

import { getSupabase } from './supabase.js'

const REFRESH_MS = 6 * 3600_000

let national: number | null = null
let byState = new Map<string, number>()
let loadedAt = 0
let inFlight: Promise<void> | null = null

function envPrice(): number {
  const v = Number(process.env.DIESEL_PRICE_INR)
  return Number.isFinite(v) && v > 0 ? v : 90
}

/** Load (or reload) both reference tables. Never throws: a failed load keeps the last values. */
export async function refreshDieselPrices(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const sb = getSupabase()
      const { data: g, error: ge } = await sb.from('fleet_cost_settings').select('diesel_price_inr').is('fleet_owner_id', null).maybeSingle()
      if (!ge && g && Number((g as { diesel_price_inr: unknown }).diesel_price_inr) > 0) national = Number((g as { diesel_price_inr: unknown }).diesel_price_inr)
      const { data: rows, error: se } = await sb.from('diesel_prices').select('state_code, price_inr, effective_from').order('effective_from', { ascending: true })
      if (!se && Array.isArray(rows)) {
        const next = new Map<string, number>()
        // Ascending by date, so the newest row for each state is the one left in the map.
        for (const r of rows as Array<{ state_code: string; price_inr: unknown; effective_from: string }>) {
          if (r.effective_from <= new Date().toISOString().slice(0, 10) && Number(r.price_inr) > 0) next.set(r.state_code, Number(r.price_inr))
        }
        byState = next
      }
      loadedAt = Date.now()
    } catch {
      // Keep whatever was loaded before; the getter falls back to the env.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** ₹/litre for a GST state code (or nationally). Synchronous; triggers a background refresh when stale. */
export function dieselPriceInr(stateCode?: string | null): number {
  if (Date.now() - loadedAt > REFRESH_MS && !inFlight && process.env.NODE_ENV !== 'test') void refreshDieselPrices()
  if (stateCode && byState.has(stateCode)) return byState.get(stateCode)!
  return national ?? envPrice()
}

/** Tests only: set the reference values directly. */
export function __setDieselPricesForTests(v: { national?: number | null; byState?: Record<string, number> }): void {
  national = v.national ?? null
  byState = new Map(Object.entries(v.byState ?? {}))
  loadedAt = Date.now()
}
