'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import { applyTheme, readTheme } from '@/lib/theme'

function subscribeDark(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => mo.disconnect()
}

/**
 * Whether the dark theme is on right now (the `dark` class on <html>). For the few things
 * CSS tokens cannot restyle — Google maps take their colour scheme as an option.
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribeDark,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  )
}

/**
 * Keeps the theme right after the first paint (lib/theme.ts): re-applies it when the route
 * changes (public pages are always automatic, the app follows the saved choice) and once a
 * minute, so an open tab turns dark at 7 pm IST and light at 6 am without a reload.
 */
export function ThemeSync() {
  const pathname = usePathname()
  useEffect(() => {
    const run = () => applyTheme(readTheme(), pathname)
    run()
    const id = setInterval(run, 60_000)
    return () => clearInterval(id)
  }, [pathname])
  return null
}
