'use client'

/**
 * "Verify with DigiLocker" — the driver's licence straight from the transport department's
 * record (Sarathi), with the driver's consent, instead of a typed number waiting for ops.
 *
 * Start: POST /kyc/digilocker/session → DigiLocker's consent page (same tab; the session id is
 * kept in sessionStorage). Return: DigiLocker sends the driver back to this page with
 * ?digilocker=1; <DigiLockerReturn> polls the session, imports the licence and reports.
 * Nothing about the driver is read until they consent in DigiLocker's own pages.
 */

import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { ApiError, getDigiLockerStatus, importDigiLocker, startDigiLocker } from '@/lib/api'
import { BTN_PRIMARY, cx } from '@/lib/ui'
import type { DigiLockerImport } from '@/lib/types'

const SESSION_KEY = 'bt_digilocker_session'
const RETURN_FLAG = 'digilocker'

export function DigiLockerButton({ enabled, className, label = 'Verify with DigiLocker' }: { enabled: boolean; className?: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  if (!enabled) return null

  async function start() {
    setBusy(true)
    try {
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set(RETURN_FLAG, '1')
      const session = await startDigiLocker(['driving_license', 'aadhaar'], url.toString())
      try { sessionStorage.setItem(SESSION_KEY, session.session_id) } catch { /* the return handler then asks to start again */ }
      window.location.href = session.authorization_url
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start DigiLocker.')
      setBusy(false)
    }
  }

  return (
    <button type="button" onClick={start} disabled={busy} className={cx(BTN_PRIMARY, 'gap-2', className)}>
      <ShieldCheck className="w-4 h-4" aria-hidden />
      {busy ? 'Opening DigiLocker…' : label}
    </button>
  )
}

/**
 * Mount once on the page DigiLocker returns to. When the URL carries ?digilocker=1 and a
 * session id is stored, waits for consent to register, imports, and calls onImported.
 */
export function DigiLockerReturn({ onImported }: { onImported: (result: DigiLockerImport) => void | Promise<void> }) {
  const ran = useRef(false)
  const [state, setState] = useState<'idle' | 'waiting' | 'importing'>('idle')

  useEffect(() => {
    if (ran.current) return
    const params = new URLSearchParams(window.location.search)
    if (params.get(RETURN_FLAG) !== '1') return
    ran.current = true
    let sessionId: string | null = null
    try { sessionId = sessionStorage.getItem(SESSION_KEY) } catch { sessionId = null }

    // Clean the URL whatever happens, so a refresh does not replay the import.
    params.delete(RETURN_FLAG)
    window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`)

    if (!sessionId) {
      toast.error('DigiLocker returned, but the session was lost — press Verify with DigiLocker again.')
      return
    }
    const id = sessionId
    let cancelled = false

    ;(async () => {
      setState('waiting')
      // Consent usually registers within a second or two of the redirect.
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        const s = await getDigiLockerStatus(id).catch(() => null)
        if (s?.status === 'succeeded') break
        if (s?.status === 'expired' || s?.status === 'failed') {
          toast.error('DigiLocker consent was not completed. Press Verify with DigiLocker to try again.')
          setState('idle')
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (cancelled) return
      setState('importing')
      try {
        const result = await importDigiLocker(id)
        try { sessionStorage.removeItem(SESSION_KEY) } catch { /* nothing to clear */ }
        if (result.applied.licence_saved && result.licence?.dl_number) {
          toast.success(`Licence ${result.licence.dl_number} verified from the transport department's record.`)
        } else if (result.warnings.length) {
          toast.error(result.warnings[0])
        } else {
          toast.message('DigiLocker returned no licence. Add the licence to DigiLocker first, then try again.')
        }
        await onImported(result)
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not read the DigiLocker documents.')
      } finally {
        setState('idle')
      }
    })()

    return () => { cancelled = true }
  }, [onImported])

  if (state === 'idle') return null
  return (
    <p className="rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3 text-sm text-gray-700" role="status">
      {state === 'waiting' ? 'Waiting for DigiLocker to confirm your consent…' : 'Reading your licence from DigiLocker…'}
    </p>
  )
}
