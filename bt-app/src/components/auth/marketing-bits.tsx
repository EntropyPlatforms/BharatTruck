/**
 * Pieces shared by the two public pages — the landing page and the sign-in screens:
 * the top navigation, the "at a glance" strip and the small feature tiles.
 *
 * The strip sits where a marketing page would usually print user counts. BharatTruck does
 * not publish numbers it cannot back, so every figure here is a fact about the product
 * itself (roles, steps, records), not about usage.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { FileText, KeyRound, Route, Users } from 'lucide-react'
import { Logo } from '@/components/brand'
import { TINT, cx, type Tint } from '@/lib/ui'

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2'

const NAV_LINKS = [
  { href: '/#shippers', label: 'For shippers' },
  { href: '/#drivers', label: 'For drivers' },
  { href: '/#fleet-owners', label: 'For fleet owners' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#industries', label: 'Industries' },
]

/** Top bar: logo, section links (tablet and up) and whatever actions the page passes. */
export function SiteNav({ actions, className }: { actions?: ReactNode; className?: string }) {
  return (
    <header className={cx('sticky top-0 z-30 border-b border-gray-200/70 bg-white/95', className)}>
      <div className="mx-auto flex h-16 max-w-[100rem] items-center gap-4 px-4 lg:px-8">
        <Link href="/" aria-label="BharatTruck home" className={cx('rounded-lg', FOCUS)}>
          <span className="sm:hidden"><Logo size="sm" /></span>
          <span className="hidden sm:inline"><Logo size="md" /></span>
        </Link>
        <nav aria-label="Sections" className="ml-8 hidden items-center gap-7 text-sm font-semibold text-gray-700 lg:flex">
          {NAV_LINKS.map(l => (
            <Link key={l.href} href={l.href} className={cx('rounded hover:text-[#0b0e13]', FOCUS)}>{l.label}</Link>
          ))}
        </nav>
        {actions && <div className="ml-auto flex items-center gap-2 sm:gap-3">{actions}</div>}
      </div>
    </header>
  )
}

const FACTS: { icon: ReactNode; tint: Tint; value: string; label: string }[] = [
  { icon: <KeyRound />, tint: 'brand', value: '1 login', label: 'For every role' },
  { icon: <Users />, tint: 'blue', value: '3 roles', label: 'Shipper, driver, fleet' },
  { icon: <Route />, tint: 'violet', value: '5 steps', label: 'Post to payment' },
  { icon: <FileText />, tint: 'green', value: 'Paperless', label: 'LR, invoice, e-way bill' },
]

/** Four product facts in a frosted card (see the file comment: facts, not usage numbers). */
export function FactStrip({ className }: { className?: string }) {
  return (
    <ul className={cx(
      'grid grid-cols-2 gap-x-4 gap-y-4 rounded-2xl border border-white/80 bg-white/95 p-4 shadow-[0_8px_30px_rgba(20,24,31,0.08)] sm:grid-cols-4 sm:gap-x-0 sm:p-5',
      className,
    )}>
      {FACTS.map((f, i) => (
        <li key={f.value} className={cx('flex items-center gap-2.5 sm:px-3', i > 0 && 'sm:border-l sm:border-gray-200', i === 0 && 'sm:pl-1')}>
          <span className={cx('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full [&_svg]:h-5 [&_svg]:w-5', TINT[f.tint])} aria-hidden>
            {f.icon}
          </span>
          <span className="min-w-0">
            <span className="block whitespace-nowrap text-lg font-extrabold xl:text-xl leading-tight tracking-tight text-gray-900">{f.value}</span>
            <span className="block text-xs leading-snug text-gray-600">{f.label}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A tinted icon square with a two-line caption under it — the hero's feature row. */
export function FeatureTile({ icon, tint, label }: { icon: ReactNode; tint: Tint; label: string }) {
  return (
    <li className="w-[92px]">
      <span className={cx('inline-flex h-12 w-12 items-center justify-center rounded-xl border border-white/80 shadow-[0_2px_8px_rgba(20,24,31,0.06)] [&_svg]:h-6 [&_svg]:w-6', TINT[tint])} aria-hidden>
        {icon}
      </span>
      <span className="mt-2 block text-[0.8125rem] font-bold leading-snug text-gray-900 text-halo">{label}</span>
    </li>
  )
}
