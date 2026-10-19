/**
 * Frame for the auth screens (2026-10 light redesign): the site navigation on top, the
 * pitch on the left over the brand's sunset-highway photograph (headline whose accent line is
 * Marigold, role tiles, product facts) and the form card on the right. Phones get the
 * navigation and the form only.
 */

import Image from 'next/image'
import type { ReactNode } from 'react'
import { BadgeCheck, IdCard, IndianRupee, Lock, MapPin, Package, ShieldCheck, Truck, Users } from 'lucide-react'
import { TINT, cx, type Tint } from '@/lib/ui'
import { SteeringWheel } from './auth-ui'
import { FactStrip, SiteNav } from './marketing-bits'

export type PanelRow = { icon: ReactNode; tint: Tint; title: string; text: string }
export type PanelCopy = {
  /** Headline lines; `accent` lines are Marigold. */
  lines: { text: string; accent?: boolean }[]
  sub?: string
  rows: PanelRow[]
}

const ROLE_ROWS: PanelRow[] = [
  { icon: <Package />, tint: 'brand', title: 'Shippers post and track loads', text: 'Get bids, track live, digital LR and e-way bill records in one place.' },
  { icon: <SteeringWheel />, tint: 'blue', title: 'Drivers run trips and get paid', text: 'Run your trips, share delivery proof and get payouts to your bank account.' },
  { icon: <Truck />, tint: 'green', title: 'Fleet owners see which truck pays its EMI', text: 'Manage trucks and drivers, track utilisation, fuel costs and payments.' },
]

const SHORT_ROWS: PanelRow[] = [
  { icon: <Package />, tint: 'brand', title: 'Post loads and get the best bids', text: 'Compare carriers and track every load live.' },
  { icon: <SteeringWheel />, tint: 'blue', title: 'Run trips with live tracking', text: 'Delivery code and photo proof at the drop.' },
  { icon: <Truck />, tint: 'green', title: 'Manage your fleet, lower costs', text: 'Know which truck pays its EMI.' },
]

export const PANEL_SIGNIN: PanelCopy = {
  lines: [{ text: 'One login for' }, { text: 'every load', accent: true }, { text: 'and every truck.' }],
  rows: ROLE_ROWS,
}

/** Create-account panel: the headline of reference 32, rows follow the persona picked. */
export function panelRegister(persona: 'shipper' | 'driver' | 'fleet_owner'): PanelCopy {
  const sub = 'One login for every load and every truck.'
  if (persona === 'driver') {
    return {
      lines: [{ text: 'More trips.' }, { text: 'Steady income.', accent: true }, { text: 'A stronger tomorrow.' }],
      sub,
      rows: [
        { icon: <IdCard />, tint: 'blue', title: 'Register with your driving licence', text: 'No truck needed to start.' },
        { icon: <MapPin />, tint: 'green', title: 'See assigned trips and navigate', text: 'Live routes and proof of delivery.' },
        { icon: <IndianRupee />, tint: 'brand', title: 'Get paid to your bank account', text: 'Account number stored encrypted.' },
      ],
    }
  }
  if (persona === 'fleet_owner') {
    return {
      lines: [{ text: 'More trips.' }, { text: 'Steady income.', accent: true }, { text: 'A stronger tomorrow.' }],
      sub,
      rows: [
        { icon: <Truck />, tint: 'green', title: 'Add your trucks and drivers', text: 'Assign them to trips and track them live.' },
        { icon: <IndianRupee />, tint: 'brand', title: 'See which truck pays its EMI', text: 'Per-truck profit after fuel, tolls and fixed costs.' },
        { icon: <Users />, tint: 'blue', title: 'Bring your staff in with roles', text: 'Everyone sees only what their role allows.' },
      ],
    }
  }
  return {
    lines: [{ text: 'Every load' }, { text: 'moves India' }, { text: 'forward.', accent: true }],
    sub,
    rows: [
      { icon: <Package />, tint: 'brand', title: 'Post a load and get bids', text: 'Compare rates and truck types on one screen.' },
      { icon: <MapPin />, tint: 'blue', title: 'Track it live to the drop', text: 'Geotagged proof of delivery.' },
      { icon: <BadgeCheck />, tint: 'green', title: 'Keep your paperwork together', text: 'LR, invoice and e-way bill records per load.' },
    ],
  }
}

export const PANEL_VERIFY: PanelCopy = {
  lines: [{ text: 'Every load' }, { text: 'moves India' }, { text: 'forward.', accent: true }],
  sub: 'One login for shippers, drivers and fleet owners.',
  rows: SHORT_ROWS,
}

export const PANEL_FORGOT: PanelCopy = {
  lines: [{ text: 'Same roads.' }, { text: 'New opportunities.' }, { text: 'Always together.', accent: true }],
  sub: 'One login for shippers, drivers and fleet owners.',
  rows: SHORT_ROWS,
}

export const PANEL_RESET: PanelCopy = {
  lines: [{ text: 'New password.' }, { text: 'More miles ahead.', accent: true }],
  sub: 'One login for shippers, drivers and fleet owners.',
  rows: SHORT_ROWS,
}

export function AuthShell({ panel, children, footer = true }: { panel: PanelCopy; children: ReactNode; footer?: boolean }) {
  return (
    <div className="relative isolate flex min-h-full flex-col overflow-hidden bg-gray-50 page-wash">
      <Backdrop />
      {/* No ribbon here: the bar is clear and scrolls with the page, so it does not cut across
          the India map in the photo behind it. */}
      <SiteNav className="static border-transparent bg-white/85 lg:bg-transparent" />
      <div className="mx-auto grid w-full max-w-[100rem] flex-1 items-start gap-10 px-4 py-6 sm:py-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:px-8 lg:py-12">
        <BrandPanel copy={panel} />
        <div className="mx-auto w-full max-w-[30rem] lg:mx-0 lg:justify-self-end">
          {children}
          {footer && (
            <div className="mt-4 rounded-2xl border border-white/70 bg-white/92 px-4 pb-4 shadow-[0_8px_30px_rgba(20,24,31,0.08)]">
              <p className="mt-1 flex items-center justify-center gap-2.5 pt-3 text-xs text-gray-600">
                <Users className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
                <span>Shippers, drivers and fleet owners — one BharatTruck account.</span>
              </p>
              <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs font-medium text-gray-600">
                {TRUST.map(t => (
                  <li key={t.label} className="inline-flex items-center gap-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600 [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden>{t.icon}</span>
                    <span className="max-w-[92px] leading-snug">{t.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Things the product really does, shown under the form (no support-hours or user claims). */
const TRUST: { icon: ReactNode; label: string }[] = [
  { icon: <ShieldCheck />, label: 'Email-verified accounts' },
  { icon: <Lock />, label: 'Encrypted bank details' },
  { icon: <MapPin />, label: 'Geotagged proof of delivery' },
]

/** The white form card on the right. */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_18px_50px_rgba(20,24,31,0.10)] sm:p-9', className)}>
      {children}
    </div>
  )
}

/**
 * Backdrop (every screen size): the brand's sunset-highway photograph filling the page — trucks along
 * the bottom, the glowing India route map on the right behind the form. Fixed to the
 * viewport so a tall form (register) scrolls over it instead of stretching it. A wash over
 * the top-left keeps the headline readable. Decorative.
 */
function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden>
      {/* Phones and tablets: the portrait artwork (map above, trucks below). */}
      <div className="absolute inset-0 lg:hidden">
        <Image src="/images/highway-portrait.webp" alt="" fill priority sizes="100vw" className="object-cover object-bottom dark:hidden" />
        <Image src="/images/highway-portrait-night.webp" alt="" fill loading="lazy" sizes="100vw" className="hidden object-cover object-bottom dark:block" />
      </div>
      {/* Desktop: the wide photo, anchored right so the whole India map is in view. */}
      <div className="absolute inset-0 hidden lg:block">
        <Image src="/images/highway-india-map.webp" alt="" fill priority sizes="100vw" className="object-cover object-[100%_40%] dark:hidden" />
        <Image src="/images/highway-india-map-night.webp" alt="" fill loading="lazy" sizes="100vw" className="hidden object-cover object-[100%_40%] dark:block" />
      </div>
      <div className="absolute inset-0 hidden lg:block hero-wash-radial" />
      <div className="absolute inset-0 bg-[var(--warm)]/15 lg:hidden" />
    </div>
  )
}

/** Left side on desktop: the pitch — headline, role tiles and the facts strip — over the photo. */
function BrandPanel({ copy }: { copy: PanelCopy }) {
  return (
    <aside className="hidden lg:block">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/90 px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-[0_1px_4px_rgba(20,24,31,0.06)]">
        <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden />
        India&apos;s freight marketplace and fleet management platform
      </span>
      <h1 className="mt-6 text-[3.25rem] font-extrabold leading-[1.04] tracking-[-0.03em] text-gray-900 xl:text-[3.875rem]">
        {copy.lines.map((l, i) => (
          <span key={i} className={cx('block', l.accent && 'text-brand-500')}>{l.text}</span>
        ))}
      </h1>
      <p className="mt-5 max-w-xl text-lg font-medium leading-relaxed text-gray-700">
        {copy.sub ?? 'Post loads, run trips with live tracking and proof of delivery, and manage your fleet — all in one place.'}
      </p>
      <ul className="mt-7 flex gap-5">
        {copy.rows.map(r => (
          <li key={r.title} className="w-[150px]">
            <span className={cx('inline-flex h-12 w-12 items-center justify-center rounded-xl border border-white/80 shadow-[0_2px_8px_rgba(20,24,31,0.06)] [&_svg]:h-6 [&_svg]:w-6', TINT[r.tint])} aria-hidden>
              {r.icon}
            </span>
            <span className="mt-2 block text-[0.8125rem] font-bold leading-snug text-gray-900 text-halo">{r.title}</span>
          </li>
        ))}
      </ul>
      <FactStrip className="mt-8" />
    </aside>
  )
}

/** A highway running to the horizon with a Marigold truck on it, a skyline and lamps. */
export function RoadArt({ className }: { className?: string }) {
  const lamps = [
    { x: 352, y: 168, h: 34 }, { x: 410, y: 186, h: 46 }, { x: 500, y: 214, h: 62 },
  ]
  return (
    <svg viewBox="0 0 600 260" preserveAspectRatio="xMidYMax slice" className={cx('block h-full w-full', className)} aria-hidden>
      {/* skyline */}
      <g fill="#dce6ff" opacity="0.75">
        <rect x="372" y="118" width="16" height="44" rx="1.5" />
        <rect x="392" y="102" width="20" height="60" rx="1.5" />
        <rect x="416" y="126" width="14" height="36" rx="1.5" />
        <rect x="434" y="94" width="18" height="68" rx="1.5" />
        <rect x="456" y="120" width="22" height="42" rx="1.5" />
        <rect x="482" y="108" width="14" height="54" rx="1.5" />
        <rect x="500" y="130" width="26" height="32" rx="1.5" />
        <rect x="70" y="132" width="20" height="30" rx="1.5" />
        <rect x="94" y="120" width="14" height="42" rx="1.5" />
      </g>
      {/* low hills */}
      <path d="M0 150 C 80 128, 150 140, 220 150 S 340 142, 380 156 L 380 162 L 0 162 Z" fill="#cfe0d6" opacity="0.55" />
      <path d="M0 162 C 120 150, 200 154, 280 160 L 600 160 L 600 162 Z" fill="#c4d6cb" opacity="0.5" />
      {/* ground */}
      <rect x="0" y="160" width="600" height="100" fill="#e6ebf2" />
      {/* road */}
      <path d="M282 160 L 318 160 L 560 260 L 40 260 Z" fill="#cdd4de" />
      <path d="M282 160 L 40 260" stroke="#ffffff" strokeWidth="3" />
      <path d="M318 160 L 560 260" stroke="#ffffff" strokeWidth="3" />
      {/* centre dashes, growing toward the viewer */}
      <g fill="#ffffff">
        <rect x="299" y="166" width="2" height="5" />
        <rect x="298.5" y="178" width="3" height="8" />
        <rect x="298" y="196" width="4" height="12" />
        <rect x="297" y="222" width="6" height="18" />
        <rect x="296" y="252" width="8" height="8" />
      </g>
      {/* guard rail on the right */}
      <path d="M322 158 L 600 248" stroke="#a9b4c3" strokeWidth="3" />
      <path d="M322 164 L 600 256" stroke="#bcc5d1" strokeWidth="2" />
      {/* lamps */}
      {lamps.map(l => (
        <g key={l.x} stroke="#9aa6b6" strokeWidth="2" fill="none">
          <path d={`M${l.x} ${l.y} L ${l.x} ${l.y - l.h} q 0 -6 -8 -6`} />
          <circle cx={l.x - 9} cy={l.y - l.h - 6} r="2" fill="#f9c955" stroke="none" />
        </g>
      ))}
      {/* the truck (rear view) */}
      <g transform="translate(240 186) scale(0.78)">
        <rect x="0" y="0" width="44" height="40" rx="3" fill="#f2a516" />
        <rect x="0" y="0" width="44" height="6" rx="3" fill="#d98c07" />
        <rect x="21" y="8" width="2" height="28" fill="#d98c07" />
        <rect x="-2" y="38" width="48" height="6" rx="2" fill="#343d4b" />
        <rect x="2" y="44" width="10" height="8" rx="2" fill="#14181f" />
        <rect x="32" y="44" width="10" height="8" rx="2" fill="#14181f" />
        <rect x="2" y="39.5" width="5" height="3" rx="1" fill="#ef4444" />
        <rect x="37" y="39.5" width="5" height="3" rx="1" fill="#ef4444" />
      </g>
    </svg>
  )
}
