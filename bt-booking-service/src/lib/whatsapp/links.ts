// Links into bt-app. One app serves every persona (D-36), so either configured base works;
// SHIPPER_APP_BASE_URL is read first. Paths are the routes bt-app actually has — not the
// old `/bookings/:id` shape the email templates still use.

type Env = Record<string, string | undefined>

export function appBaseUrl(env: Env = process.env): string | null {
  const b = env.SHIPPER_APP_BASE_URL ?? env.DRIVER_APP_BASE_URL ?? null
  return b && b.trim() ? b.trim().replace(/\/+$/, '') : null
}

export const appLink = (base: string | null, path: string): string | null => (base ? `${base}${path}` : null)

/**
 * Where an alert should send someone — the same mapping as the Home feed's alertHref
 * (bt-app app/(app)/home/page.tsx), so a WhatsApp alert and its Home row open the same page.
 */
export function alertPath(a: { persona: string; kind: string; subject_type: string; subject_id: string }): string {
  const booking = a.subject_type === 'booking' ? a.subject_id : null
  const licence = a.kind === 'licence_expiring'
  switch (a.persona) {
    case 'shipper':
      if (booking && a.kind === 'unpaid_overdue') return `/loads/${booking}?tab=payment`
      return booking ? `/loads/${booking}` : '/loads'
    case 'driver':
      if (licence) return '/driver-profile'
      return booking ? `/my-trips/${booking}` : '/my-trips'
    case 'carrier':
      return booking ? `/my-trips/${booking}` : '/my-trips'
    case 'fleet':
      return licence ? '/drivers' : '/trips'
    default:
      return '/home'
  }
}
