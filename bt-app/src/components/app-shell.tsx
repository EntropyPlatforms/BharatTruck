'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Menu, X, Bell, Info } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import PaymentDuePrompt from '@/components/payment-due-prompt'
import { BrandMark, Wordmark } from '@/components/brand'
import { visibleNav, isActive, canAccessPath } from '@/lib/nav'
import { getMyFleet } from '@/lib/api'
import { PhotoHero } from '@/components/photo-hero'
import type { FleetOwner } from '@/lib/types'

/**
 * Desktop-first shell: a persistent white left rail plus a content column
 * (2026-10 light redesign: BharatTruck mark and wordmark at the top, the fleet's
 * company name under it, a Marigold-tinted active item, the user and Sign out at
 * the foot). On desktop the rail rests as a strip of icons with no edge of its own — it
 * sits on the page's background — and opens over the page while the pointer (or keyboard
 * focus) is on it; there is no collapse button. Below lg it becomes a drawer behind a top bar.
 *
 * The route guard lives here, so every page under (app)/ is protected by
 * construction and nothing outside it is.
 *
 * The rail is CAPABILITY-GATED (D-27/D-36): it renders only the surfaces the
 * viewer's capabilities unlock, read from GET /auth/me — never from a role string.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { token, isReady, logout, user, capabilities, personas } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  // Desktop rail: open while hovered or focused, icons-only otherwise.
  const [railOpen, setRailOpen] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [fleet, setFleet] = useState<FleetOwner | null>(null)

  useEffect(() => {
    if (!isReady) return
    if (!token) { router.replace('/login'); return }
    // Capability route guard (D-27/D-36): a deep link to a surface the viewer's capabilities do
    // not unlock goes to Home. Wait until capabilities RESOLVE (null = still loading) so a
    // legitimate deep link is never bounced mid-load, and mirror the rail's hasFleetProfile
    // bootstrap so a declared fleet owner with no trucks keeps the console that adds one.
    if (capabilities !== null && !canAccessPath(pathname, capabilities, { hasFleetProfile: !!personas?.fleet_owner_id })) {
      router.replace('/home')
    }
  }, [isReady, token, capabilities, personas, pathname, router])

  useEffect(() => {
    if (!token) return
    getMyFleet().then(setFleet).catch(() => setFleet(null))
  }, [token])

  // Close the mobile drawer (and the hover rail) on navigation, otherwise it covers the
  // page you just asked for.
  useEffect(() => {
    setMobileOpen(false)
    // Keep the rail open if the pointer is still on it (the user clicked a link in it and
    // may click another); closing it here left it shut under the cursor until they moved
    // out and back in.
    if (!railRef.current?.matches(':hover')) setRailOpen(false)
  }, [pathname])

  // While the rail is open, close it as soon as the pointer is anywhere else. mouseleave
  // alone can be missed — the rail sits on the window's left edge, and a fast exit past
  // that edge, a dialog opening over it, or switching windows never delivers it — which
  // left the menu stuck open.
  useEffect(() => {
    if (!railOpen) return
    const close = () => setRailOpen(false)
    const onMove = (e: PointerEvent) => {
      const rail = railRef.current
      if (rail && !rail.contains(e.target as Node) && !rail.contains(document.activeElement)) close()
    }
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) close() }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('blur', close)
    }
  }, [railOpen])

  if (!isReady) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-[3px] border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (!token) return null

  // A fleet owner who has created their profile sees the fleet console so they can add
  // their first truck (D-32 bootstrap) — see visibleNav.
  const navItems = visibleNav(capabilities, { hasFleetProfile: !!personas?.fleet_owner_id })
  const initials = (user?.full_name || user?.email || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')

  // ONE layout for the rail, open or closed: icons sit in the first 4.5rem, labels to their
  // right. Closed, the desktop rail is simply clipped to that strip and the labels fade out —
  // nothing re-renders or reflows when it opens, which is what keeps the motion smooth.
  // `FADE` reads the open state from the nearest `group/rail` ancestor's data-open.
  const FADE = 'transition-opacity duration-200 group-data-[open=false]/rail:opacity-0'
  const renderRail = (surface: string) => (
    <nav className={`flex flex-col h-full ${surface}`}>
      {/* Brand: the BharatTruck mark and wordmark, then who is signed in. */}
      <div className="pt-5 pb-4 px-4">
        <Link href="/home" aria-label="BharatTruck home" className="flex items-center gap-2.5 px-1">
          <BrandMark className="w-8 h-8 shrink-0" />
          <Wordmark className={`text-xl ${FADE}`} />
        </Link>
        {/* Name, and the fleet's company name when there is one. */}
        <Link
          href="/settings"
          className="mt-4 flex items-center gap-3 rounded-xl border border-gray-200/80 bg-gradient-to-br from-brand-50/70 to-white px-3 py-2.5 shadow-[0_1px_4px_rgba(20,24,31,0.04)] hover:border-brand-200 transition-colors group-data-[open=false]/rail:border-transparent group-data-[open=false]/rail:bg-none group-data-[open=false]/rail:px-0 group-data-[open=false]/rail:shadow-none"
        >
          <span className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 text-sm font-bold inline-flex items-center justify-center shrink-0">{initials}</span>
          <span className={`min-w-0 ${FADE}`}>
            <span className="block text-sm font-bold text-gray-900 truncate">{user?.full_name ?? 'My account'}</span>
            <span className="block text-xs text-gray-500 truncate">{fleet?.company_name ?? user?.email ?? ''}</span>
          </span>
        </Link>
      </div>

      {/* Links — capability-gated. Only surfaces the viewer's capabilities unlock. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-3 px-3">
        {navItems.map((item, i) => {
          const active = isActive(pathname, item.href)
          const Icon = item.icon
          // Only draw a section break BETWEEN visible items, never above the first.
          return (
            <div key={item.href}>
              {item.startsGroup && i > 0 && (
                item.group
                  ? <div className={`mt-4 mb-1 px-3 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-gray-400 whitespace-nowrap ${FADE}`}>{item.group}</div>
                  : <div className="my-2.5 mx-2 border-t border-gray-200/70" />
              )}
              <Link
                href={item.href}
                title={item.label}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-3 rounded-xl px-3 py-2 text-[0.9375rem] transition-colors group-data-[open=false]/rail:w-12 ${
                  active
                    ? 'bg-gradient-to-r from-brand-100 to-brand-50 text-ink font-bold shadow-[inset_0_0_0_1px_rgba(242,165,22,0.18)]'
                    : 'text-gray-600 font-medium hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-brand-600' : 'text-gray-500'}`} strokeWidth={active ? 2.2 : 1.8} />
                <span className={`truncate ${FADE}`}>{item.label}</span>
              </Link>
            </div>
          )
        })}
      </div>

      {/* Footer: sign out */}
      <div className="p-3">
        <button
          onClick={logout}
          title="Sign out"
          className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-[0.9375rem] font-medium text-gray-600 hover:text-red-600 hover:bg-red-50 transition-colors group-data-[open=false]/rail:w-12"
        >
          <LogOut className="w-5 h-5 shrink-0" strokeWidth={1.8} />
          <span className={`whitespace-nowrap ${FADE}`}>Sign out</span>
        </button>
      </div>
    </nav>
  )

  return (
    <div className="h-full flex bg-gray-50 page-wash">
      {/* Desktop rail: a 4.5rem slot in the layout. The rail is always 16rem wide and floats
          over the page; closed, it is clipped to the icon strip. Opening animates only the
          clip (and a colour), so nothing reflows and no backdrop blur is recomputed. */}
      <aside className="hidden lg:block shrink-0 w-[4.5rem] relative z-40">
        <div
          ref={railRef}
          data-open={railOpen}
          onMouseEnter={() => setRailOpen(true)}
          onMouseMove={() => { if (!railOpen) setRailOpen(true) }}
          onMouseLeave={() => { railRef.current?.querySelector<HTMLElement>(':focus')?.blur(); setRailOpen(false) }}
          // Keyboard focus opens it; a mouse click's focus must not hold it open.
          onFocus={e => { if (e.target.matches(':focus-visible')) setRailOpen(true) }}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover')) setRailOpen(false) }}
          className={`group/rail absolute inset-y-0 left-0 w-64 rounded-r-3xl shadow-[12px_0_40px_rgba(20,24,31,0.12)] transition-[clip-path,background-color] duration-200 ease-out ${
            railOpen ? 'bg-white [clip-path:inset(0_-4rem_0_0)]' : 'bg-white/0 [clip-path:inset(0_calc(100%-4.5rem)_0_0)]'
          }`}
        >
          {renderRail('')}
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div data-open="true" className="group/rail w-72 h-full shadow-xl">{renderRail('bg-white')}</div>
          <button
            aria-label="Close menu"
            className="flex-1 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar — the rail is hidden below lg */}
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-gray-200 px-4 h-14 flex items-center justify-between">
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="p-1.5 -ml-1.5 text-gray-700">
            {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
          <Link href="/home" className="inline-flex items-center gap-2">
            <BrandMark className="w-7 h-7" />
            <Wordmark className="text-lg" />
          </Link>
          <Link href="/home" aria-label="What needs you" className="p-1.5 -mr-1.5 text-gray-700">
            <Bell className="w-6 h-6" strokeWidth={1.8} />
          </Link>
        </header>

        <main className="relative isolate flex-1 overflow-y-auto">{children}</main>
        {/* Tells a shipper which of their loads were delivered and are waiting for payment. */}
        <PaymentDuePrompt />
      </div>
    </div>
  )
}

/** Standard page header. Every screen uses this so titles line up across routes: the
 *  photo banner (PhotoHero, medium size) with the title, an optional one-phrase `info`
 *  caption beside it, a subtitle, and the page's actions in a row under them. */
export function PageHeader({
  title, subtitle, actions, info,
}: { title: string; subtitle?: string; actions?: ReactNode; info?: string }) {
  return (
    <PhotoHero
      size="md"
      title={title}
      subtitle={subtitle}
      // The explanation is shown as a visible caption at every width, with a plain info
      // icon — no hover tooltip, which only repeated the caption sitting right beside it.
      caption={info && (
        <span className="inline-flex items-start gap-1.5 text-sm text-gray-700 min-w-0 max-w-[560px]">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-600/80" aria-hidden />
          <span>{info}</span>
        </span>
      )}
    >
      {/* Actions sit under the title on the left, as in the references. */}
      {actions}
    </PhotoHero>
  )
}
