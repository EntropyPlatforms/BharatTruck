'use client'

import { useEffect, useRef } from 'react'

/**
 * Screen Wake Lock (FROZEN Maps contract D-008). Keeps the driver's screen awake
 * while an ACTIVE trip is on screen so the OS doesn't sleep the display and throttle
 * background GPS mid-trip — the core drive use case.
 *
 * SCOPE MATTERS in the unified app: this is a driver-runtime concern and must NOT be
 * forced on every bt-app user (a shipper opening bt-app must never acquire a wake lock).
 * It is therefore called ONLY from the in-transit branch of /my-trips/[id], with
 * `active` = (status === 'in_transit'); the lock is released the moment that branch
 * unmounts (trip completed, navigated away). Nothing app-wide registers it. Copied from
 * driver/src/lib/use-wake-lock.ts.
 *
 * - Acquires the lock while `active` is true and the page is visible.
 * - Re-acquires on `visibilitychange` (the browser auto-releases a wake lock whenever
 *   the page is hidden, e.g. the driver switches to the Google Maps app).
 * - Releases on trip end / unmount.
 * - Feature-detected: a no-op where the API is unavailable (older browsers) or the
 *   context is insecure (HTTP) — never throws.
 */
export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active) return
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return

    let cancelled = false

    const acquire = async () => {
      if (cancelled || sentinelRef.current) return
      if (document.visibilityState !== 'visible') return
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled) {
          sentinel.release().catch(() => {})
          return
        }
        sentinelRef.current = sentinel
        sentinel.addEventListener('release', () => {
          sentinelRef.current = null
        })
      } catch {
        // request() can reject (page hidden, low battery, policy) — best-effort.
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      sentinelRef.current?.release().catch(() => {})
      sentinelRef.current = null
    }
  }, [active])
}
