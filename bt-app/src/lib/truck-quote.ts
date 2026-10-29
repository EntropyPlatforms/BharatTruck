/**
 * The pricing inputs a truck contributes to an estimate: its CV-Parc model category, emission norm
 * and age. Shared by the shipper's quote (Post a Load) and the fleet's bid estimate (Find Work), so
 * both price the same truck the same way.
 */
export function truckQuoteFields(t: { model_category: string | null; emission_norm: string | null; manufacture_year: number | null } | null | undefined) {
  if (!t) return {}
  const out: { model_category?: string; emission_norm?: 'bs6' | 'bs4'; truck_age?: number } = {}
  if (t.model_category) out.model_category = t.model_category
  const norm = (t.emission_norm ?? '').toLowerCase()
  if (norm === 'bs6' || norm === 'bs4') out.emission_norm = norm
  if (t.manufacture_year && t.manufacture_year > 1980) out.truck_age = Math.max(1, new Date().getFullYear() - t.manufacture_year)
  return out
}
