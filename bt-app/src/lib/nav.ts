import type { LucideIcon } from 'lucide-react'
import {
  Home, Package, PackagePlus, Navigation,
  LayoutDashboard, Map, Truck, Users, Gavel, Route, TrendingUp, Fuel, Settings, ClipboardCheck, IdCard,
} from 'lucide-react'
import type { Capability } from './types'

/**
 * A surface is shown when the viewer HAS its capability — never when they hold some
 * role string (D-27/D-36). 'always' is for the surfaces every human gets: the Home
 * feed and Settings (one identity, D-4).
 */
export type NavGate = Capability | 'always'

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** The capability that reveals this item. */
  gate: NavGate
  /**
   * True while the destination is a "coming soon" placeholder rather than a built
   * surface. As of Phase 3 every navigable surface is real — the operate+carry
   * surfaces (forked from the fleet console), the ship surfaces (Post a Load, My
   * Loads, load detail — Phase 2) and the drive surfaces (My Trips, Navigate, POD —
   * Phase 3) — so nothing sets this today. Kept on the type so a future
   * not-yet-grafted surface can still be shown honestly (capability real, feature
   * not here) without half-building it.
   */
  placeholder?: boolean
  /** Section break above this item in the rail. */
  startsGroup?: boolean
  /** Small caption for the section this item starts (shown instead of a bare divider). */
  group?: string
}

/**
 * The unified rail. Order is capability-first: Home, then the surfaces each
 * capability unlocks, then Settings. The operate + carry block below Home is the
 * forked fleet console, kept in its original order and groupings — a fleet owner
 * (ship · carry · operate, no drive) sees exactly those surfaces working, which is
 * the Phase-1 acceptance bar.
 *
 * The `ship` items (Phase 2) and the `drive` item (/my-trips — Phase 3) are all live.
 * They appear only for a human who actually holds the capability, so a pure fleet owner
 * never sees the drive surface at all, and a pure shipper sees the working ship surfaces
 * plus Home and Settings.
 */
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home, gate: 'always' },
  // Everyone's "how am I doing?". The page itself shows only the panels the person's
  // capabilities unlock (GET /me/summary) — fleet, truck, driving, shipments — so the entry
  // is ungated and the CONTENT is what follows capabilities, exactly like Home.
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, gate: 'always' },

  { href: '/loads', label: 'My Loads',    icon: Package,     gate: 'ship', startsGroup: true, group: 'Shipping' },
  { href: '/post',  label: 'Post a Load', icon: PackagePlus, gate: 'ship' },

  { href: '/my-trips', label: 'My Trips', icon: Navigation, gate: 'drive', startsGroup: true, group: 'Driving' },
  // A driver's OWN record — details, DL, bank — completed with no truck (2026-09-30).
  { href: '/driver-profile', label: 'Driver profile', icon: IdCard, gate: 'drive' },

  { href: '/map',       label: 'Live Fleet', icon: Map,             gate: 'operate', startsGroup: true, group: 'Fleet' },

  { href: '/vehicles',  label: 'Trucks',  icon: Truck, gate: 'operate', startsGroup: true, group: 'Assets' },
  { href: '/drivers',   label: 'Drivers', icon: Users, gate: 'operate' },

  { href: '/auctions',   label: 'Find Work',  icon: Gavel,          gate: 'carry',   startsGroup: true, group: 'Work' },
  { href: '/trips',      label: 'Trips',      icon: Route,          gate: 'operate' },
  { href: '/deliveries', label: 'Deliveries', icon: ClipboardCheck, gate: 'operate' },

  { href: '/analytics', label: 'Utilisation', icon: TrendingUp, gate: 'operate', startsGroup: true, group: 'Analytics' },
  { href: '/fuel',      label: 'Fuel',        icon: Fuel,       gate: 'operate' },

  { href: '/settings',  label: 'Settings', icon: Settings, gate: 'always', startsGroup: true },
]

/**
 * The rail for a given capability set. `null` capabilities means "not resolved yet"
 * — show only the always-on items so the shell renders something honest rather than
 * flashing surfaces the human may not have.
 *
 * `hasFleetProfile` is the ONE bootstrap exception (D-32 front door): a fleet owner who
 * has created their fleet profile sees the fleet console — Trucks, Drivers, the boards —
 * even before they own a single truck, because that console is the ONLY place they can
 * add their first truck. Without this a declared fleet owner is stranded: `carry`/`operate`
 * need assets, but the surface that adds those assets was itself asset-gated. The
 * fleet-service reads are profile-authorized (de-roled, #109/#117), so these pages return
 * an empty console, never a 403. Once the first truck lands, the real capabilities take
 * over and this exception is a no-op.
 */
export function visibleNav(
  capabilities: Capability[] | null,
  opts?: { hasFleetProfile?: boolean },
): NavItem[] {
  const bootstrapFleet = opts?.hasFleetProfile ?? false
  return NAV.filter(item => {
    if (item.gate === 'always') return true
    if (bootstrapFleet && (item.gate === 'carry' || item.gate === 'operate')) return true
    return capabilities?.includes(item.gate) ?? false
  })
}

/** Longest-prefix match, so /vehicles/<id> keeps "Trucks" lit. */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The capability that gates a path — the longest matching nav href wins so /vehicles/<id> inherits
 * /vehicles' gate. Any path not in the rail (e.g. /loads/<id>, which is 'ship' via /loads) resolves
 * through its prefix; a path matching nothing falls back to 'always' (guarded by its own page).
 */
export function gateForPath(pathname: string): NavGate {
  const match = NAV
    .filter(item => isActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]
  return match?.gate ?? 'always'
}

/**
 * May a viewer with these capabilities reach this path? Mirrors visibleNav's rule EXACTLY (incl. the
 * hasFleetProfile bootstrap) so what the rail SHOWS and what the route guard ALLOWS never diverge
 * (review F3). Callers must wait until capabilities have RESOLVED (non-null) before redirecting on a
 * `false`, or a mid-load null would bounce a legitimate deep link.
 */
export function canAccessPath(
  pathname: string,
  capabilities: Capability[] | null,
  opts?: { hasFleetProfile?: boolean },
): boolean {
  const gate = gateForPath(pathname)
  if (gate === 'always') return true
  if ((opts?.hasFleetProfile ?? false) && (gate === 'carry' || gate === 'operate')) return true
  return capabilities?.includes(gate) ?? false
}
