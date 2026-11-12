'use client'

/**
 * "Share invite link" — the owner's side of a fleet invite link (Drivers page).
 *
 * One link per fleet, valid 7 days. Unlike an invitation by phone, the LINK IS THE OWNER'S
 * APPROVAL: any driver who opens it and presses Join is added to the fleet as active straight
 * away, so the dialog says so plainly and offers "Make a new link" (every older link stops
 * working) and "Turn off link" for when it has gone further than intended.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Link2, MessageCircle, RefreshCw, Share2, ShieldAlert } from 'lucide-react'
import { Modal } from '@/components/fleet-ops/bits'
import { ErrorNote, Loading } from '@/components/stat'
import {
  ApiError, createInviteLink, getInviteLink, inviteLinkUrl, revokeInviteLink, type InviteLink,
} from '@/lib/api'
import { dateTime } from '@/lib/format'
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, LABEL, cx } from '@/lib/ui'

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError || e instanceof Error ? e.message : fallback
}

function shareMessage(expiresAt: string): string {
  return `Join my fleet on BharatTruck as a driver. Open this link and tap Join (works until ${dateTime(expiresAt)}):`
}

export function InviteLinkDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<InviteLink | null>(null)
  const [ttlDays, setTtlDays] = useState(7)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // "Make a new link" kills the one already shared, so it asks once before doing it.
  const [confirmRotate, setConfirmRotate] = useState(false)
  // The phone's own share sheet, where the browser has one. The dialog only ever renders on the
  // client (opened by a click), so reading navigator here is safe.
  const [canShare] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function')

  useEffect(() => {
    getInviteLink()
      .then(s => { setLink(s.link); setTtlDays(s.ttl_days) })
      .catch(e => setErr(errText(e, 'Could not load your invite link')))
      .finally(() => setLoading(false))
  }, [])

  const make = useCallback(async () => {
    setBusy('create'); setErr(null); setCopied(false); setConfirmRotate(false)
    try {
      const s = await createInviteLink()
      setLink(s.link); setTtlDays(s.ttl_days)
    } catch (e) {
      setErr(errText(e, 'Could not make a link'))
    } finally {
      setBusy(null)
    }
  }, [])

  async function turnOff() {
    setBusy('revoke'); setErr(null); setCopied(false); setConfirmRotate(false)
    try {
      await revokeInviteLink()
      setLink(null)
    } catch (e) {
      setErr(errText(e, 'Could not turn the link off'))
    } finally {
      setBusy(null)
    }
  }

  const url = link ? inviteLinkUrl(link.token) : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard blocked (http, old browser): select the field so a long-press / Ctrl+C works.
      const el = document.getElementById('invite-link-url') as HTMLInputElement | null
      el?.select()
    }
  }

  async function nativeShare() {
    if (!link) return
    try {
      await navigator.share({ title: 'Join my fleet on BharatTruck', text: shareMessage(link.expires_at), url })
    } catch {
      // The user closed the share sheet — nothing to do.
    }
  }

  return (
    <Modal
      title="Share an invite link"
      sub="Send one link to your drivers on WhatsApp or SMS."
      onClose={onClose}
    >
      {loading ? (
        <Loading label="Loading your link" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              Anyone who opens this link and taps <strong>Join</strong> is added to your fleet as an active
              driver right away. Share it only with your drivers. It works for {ttlDays} days.
            </p>
          </div>

          {link ? (
            <>
              <div>
                <label htmlFor="invite-link-url" className={LABEL}>Your invite link</label>
                <div className="flex gap-2">
                  <input
                    id="invite-link-url"
                    readOnly
                    value={url}
                    onFocus={e => e.currentTarget.select()}
                    className={cx(INPUT, 'font-mono text-xs')}
                  />
                  <button type="button" onClick={() => void copy()} className={cx(BTN_SECONDARY, 'h-[42px] shrink-0')}>
                    {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className={HINT}>Works until {dateTime(link.expires_at)}.</p>
              </div>

              <div className={cx('grid gap-2', canShare ? 'grid-cols-1 min-[420px]:grid-cols-2' : 'grid-cols-1')}>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(`${shareMessage(link.expires_at)}\n${url}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cx(BTN_PRIMARY, 'h-11')}
                >
                  <MessageCircle className="h-4 w-4" />
                  Share on WhatsApp
                </a>
                {canShare && (
                  <button type="button" onClick={() => void nativeShare()} className={cx(BTN_SECONDARY, 'h-11')}>
                    <Share2 className="h-4 w-4" />
                    More ways to share
                  </button>
                )}
              </div>

              <div className="border-t border-gray-100 pt-4">
                {confirmRotate ? (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-700">
                      Make a new link? The link you already shared will <strong>stop working</strong> immediately.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setConfirmRotate(false)} className={BTN_SECONDARY}>Keep this link</button>
                      <button type="button" onClick={() => void make()} disabled={busy !== null} className={BTN_PRIMARY}>
                        {busy === 'create' ? 'Making…' : 'Make a new link'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setConfirmRotate(true)} disabled={busy !== null} className={BTN_SECONDARY}>
                      <RefreshCw className="h-4 w-4" />
                      Make a new link
                    </button>
                    <button type="button" onClick={() => void turnOff()} disabled={busy !== null} className={BTN_DANGER}>
                      {busy === 'revoke' ? 'Turning off…' : 'Turn off link'}
                    </button>
                  </div>
                )}
                <p className={HINT}>Use these if the link reached someone it should not have.</p>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                You have no active invite link. Make one, then send it to your drivers — they open it, sign in
                (or create a driver account) and tap Join.
              </p>
              <button type="button" onClick={() => void make()} disabled={busy !== null} className={cx(BTN_PRIMARY, 'w-full h-11')}>
                <Link2 className="h-4 w-4" />
                {busy === 'create' ? 'Making your link…' : 'Make an invite link'}
              </button>
            </div>
          )}

          {err && <ErrorNote message={err} />}
        </div>
      )}
    </Modal>
  )
}
