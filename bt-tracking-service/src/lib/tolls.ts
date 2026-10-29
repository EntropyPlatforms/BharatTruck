// Route tolls from the Google Routes API (extraComputations: TOLLS). Pure parsing, kept apart from
// google.ts so it is testable without a Maps key.
//
// Google's rule for routes.travelAdvisory.tollInfo:
//   absent                          → no tolls expected on the route
//   present, estimatedPrice missing → the route has tolls but the price is unknown
//   present, estimatedPrice         → one Money per currency charged
// Google prices tolls for a CAR. bt-pricing-service scales the figure to the truck's axle class;
// this module only reports what Google said.

export type RouteToll =
  | { status: 'priced'; car_toll_inr: number }
  | { status: 'none' }
  | { status: 'unknown' }

type Money = { currencyCode?: string; units?: string | number; nanos?: number }

export function parseRouteToll(route: { travelAdvisory?: { tollInfo?: { estimatedPrice?: Money[] } } } | undefined): RouteToll {
  const info = route?.travelAdvisory?.tollInfo
  if (!info) return { status: 'none' }
  const inr = (info.estimatedPrice ?? []).filter((m) => (m.currencyCode ?? '').toUpperCase() === 'INR')
  if (inr.length === 0) return { status: 'unknown' }
  const total = inr.reduce((s, m) => s + Number(m.units ?? 0) + Number(m.nanos ?? 0) / 1e9, 0)
  if (!Number.isFinite(total) || total < 0) return { status: 'unknown' }
  return { status: 'priced', car_toll_inr: Math.round(total) }
}
