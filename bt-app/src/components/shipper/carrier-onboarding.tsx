'use client'

/**
 * Bringing carriers onto a shipper's Preferred list (My carriers page):
 *   • CarrierInviteDialog — one shareable link (30 days). A fleet owner, or a driver with their
 *     own truck, who opens it and accepts is added to the shipper's Preferred carriers.
 *   • BulkCarriersDialog — a CSV of name + mobile. Everyone already carrying loads on
 *     BharatTruck is added at once; for the rest the dialog offers the invite link to send.
 * Nothing here creates an account or messages anyone: the shipper shares the link themselves.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Download, FileUp, Link2, MessageCircle, RefreshCw } from 'lucide-react'
import { Modal } from '@/components/fleet-ops/bits'
import { ErrorNote, Loading } from '@/components/stat'
import {
  ApiError, BULK_CARRIER_LIMIT, addCarriersBulk, carrierInviteUrl, createCarrierInviteLink,
  getCarrierInviteLink, revokeCarrierInviteLink,
  type BulkCarrierRow, type BulkCarrierStatus, type CarrierInviteLink,
} from '@/lib/api'
import { parseCsv } from '@/lib/driver-csv'
import { dateTime } from '@/lib/format'
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, LABEL, cx, pill, type PillTone } from '@/lib/ui'

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback)

function shareText(expiresAt: string) {
  return `Join my preferred carriers on BharatTruck to get my loads. Open this link and tap Join (works until ${dateTime(expiresAt)}):`
}

/** The link block: copy + WhatsApp. Shared by both dialogs. */
function LinkBlock({ link }: { link: CarrierInviteLink }) {
  const [copied, setCopied] = useState(false)
  const url = carrierInviteUrl(link.token)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      (document.getElementById('carrier-invite-url') as HTMLInputElement | null)?.select()
    }
  }
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="carrier-invite-url" className={LABEL}>Your invite link</label>
        <div className="flex gap-2">
          <input id="carrier-invite-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={cx(INPUT, 'font-mono text-xs')} />
          <button type="button" onClick={() => void copy()} className={cx(BTN_SECONDARY, 'h-[42px] shrink-0')}>
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className={HINT}>Works until {dateTime(link.expires_at)}.</p>
      </div>
      <a
        href={`https://wa.me/?text=${encodeURIComponent(`${shareText(link.expires_at)}\n${url}`)}`}
        target="_blank"
        rel="noopener noreferrer"
        className={cx(BTN_PRIMARY, 'h-11 w-full')}
      >
        <MessageCircle className="h-4 w-4" />
        Share on WhatsApp
      </a>
    </div>
  )
}

/** Loads the current link, or makes one. */
function useCarrierLink() {
  const [link, setLink] = useState<CarrierInviteLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    getCarrierInviteLink()
      .then(setLink)
      .catch((e) => setErr(errText(e, 'Could not load your invite link')))
      .finally(() => setLoading(false))
  }, [])
  const make = useCallback(async () => {
    setErr(null)
    try { setLink(await createCarrierInviteLink()) } catch (e) { setErr(errText(e, 'Could not make a link')) }
  }, [])
  return { link, setLink, loading, err, setErr, make }
}

export function CarrierInviteDialog({ onClose }: { onClose: () => void }) {
  const { link, setLink, loading, err, setErr, make } = useCarrierLink()
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null)
  const [confirmRotate, setConfirmRotate] = useState(false)

  async function run(kind: 'create' | 'revoke') {
    setBusy(kind); setConfirmRotate(false)
    if (kind === 'create') await make()
    else {
      try { await revokeCarrierInviteLink(); setLink(null) } catch (e) { setErr(errText(e, 'Could not turn the link off')) }
    }
    setBusy(null)
  }

  return (
    <Modal title="Invite carriers" sub="Send one link to the fleet owners and truck drivers you like to work with." onClose={onClose}>
      {loading ? <Loading label="Loading your link" /> : (
        <div className="space-y-4">
          <p className="rounded-xl bg-gray-50 px-3.5 py-3 text-sm text-gray-700">
            A fleet owner, or a driver with their own truck, who opens this link and taps <strong>Join</strong> is added
            to your <strong>Preferred carriers</strong>. Their bids on your loads show a Preferred badge, and your loads show
            one to them. A driver without a truck of their own is asked to add one first.
          </p>
          {link ? (
            <>
              <LinkBlock link={link} />
              <div className="border-t border-gray-100 pt-4">
                {confirmRotate ? (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-700">Make a new link? The link you already shared will <strong>stop working</strong>.</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setConfirmRotate(false)} className={BTN_SECONDARY}>Keep this link</button>
                      <button type="button" onClick={() => void run('create')} disabled={busy !== null} className={BTN_PRIMARY}>
                        {busy === 'create' ? 'Making…' : 'Make a new link'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setConfirmRotate(true)} disabled={busy !== null} className={BTN_SECONDARY}>
                      <RefreshCw className="h-4 w-4" />Make a new link
                    </button>
                    <button type="button" onClick={() => void run('revoke')} disabled={busy !== null} className={BTN_DANGER}>
                      {busy === 'revoke' ? 'Turning off…' : 'Turn off link'}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button type="button" onClick={() => void run('create')} disabled={busy !== null} className={cx(BTN_PRIMARY, 'w-full h-11')}>
              <Link2 className="h-4 w-4" />
              {busy === 'create' ? 'Making your link…' : 'Make an invite link'}
            </button>
          )}
          {err && <ErrorNote message={err} />}
        </div>
      )}
    </Modal>
  )
}

// ── Bulk ──────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 1_000_000

const STATUS: Record<BulkCarrierStatus, { label: string; tone: PillTone }> = {
  added:              { label: 'Added',               tone: 'green' },
  already_added:      { label: 'Already preferred',   tone: 'blue' },
  not_on_bharattruck: { label: 'Not on BharatTruck',  tone: 'orange' },
  needs_truck:        { label: 'No truck of their own', tone: 'amber' },
  invalid_mobile:     { label: 'Invalid mobile',      tone: 'red' },
  duplicate:          { label: 'Duplicate',           tone: 'slate' },
  self:               { label: 'Your own number',     tone: 'slate' },
}

/** name, mobile from a CSV. Header names are forgiving; the server validates every number. */
export function readCarrierCsv(text: string): { rows: Array<{ name: string; mobile: string }> } | { error: string } {
  const table = parseCsv(text)
  if (table.length === 0) return { error: 'The file is empty.' }
  const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.]/g, '')
  const header = table[0].map(norm)
  const nameCol = header.findIndex((h) => ['name', 'fullname', 'carrier', 'company', 'companyname', 'drivername'].includes(h))
  const mobileCol = header.findIndex((h) => ['mobile', 'phone', 'mobilenumber', 'phonenumber', 'contact', 'contactnumber'].includes(h))
  if (mobileCol < 0) return { error: 'No "mobile" column found. Use the template: name, mobile.' }
  const rows = table.slice(1)
    .map((r) => ({ name: (nameCol >= 0 ? r[nameCol] : '')?.trim() ?? '', mobile: (r[mobileCol] ?? '').trim() }))
    .filter((r) => r.name || r.mobile)
  if (rows.length === 0) return { error: 'The file has a header but no rows.' }
  if (rows.length > BULK_CARRIER_LIMIT) return { error: `${rows.length} rows: up to ${BULK_CARRIER_LIMIT} at a time. Split the file.` }
  return { rows }
}

export function BulkCarriersDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Array<{ name: string; mobile: string }> | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<BulkCarrierRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inviteNeeded = (result ?? []).filter((r) => r.status === 'not_on_bharattruck' || r.status === 'needs_truck')
  const { link, make } = useCarrierLink()

  function template() {
    const url = URL.createObjectURL(new Blob(['name,mobile\r\n'], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'bharattruck-carriers-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function pick(file: File | undefined) {
    setErr(null)
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { setErr(`${file.name} is too large for a carriers list.`); return }
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') { setErr(`${file.name} is not a CSV file. In Excel or Google Sheets use "Save as / Download → CSV".`); return }
    const parsed = readCarrierCsv(await file.text())
    if ('error' in parsed) { setErr(parsed.error); setRows(null); return }
    setRows(parsed.rows); setFileName(file.name)
  }

  async function submit() {
    if (!rows) return
    setBusy(true); setErr(null)
    try {
      setResult((await addCarriersBulk(rows.map((r) => ({ name: r.name || undefined, mobile: r.mobile })))).rows)
    } catch (e) {
      setErr(errText(e, 'Could not add these carriers'))
    } finally {
      setBusy(false)
    }
  }

  const counts = (result ?? []).reduce<Partial<Record<BulkCarrierStatus, number>>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})

  return (
    <Modal title="Add carriers from a list" sub="A CSV with each carrier's name and mobile number." onClose={result ? onDone : onClose} width="sm:max-w-2xl">
      <div className="space-y-4">
        {!result && (
          <>
            <p className="text-sm text-gray-600">
              Fleet owners and drivers with their own truck who are already on BharatTruck are added to your Preferred
              carriers straight away. For everyone else you get your invite link to send them.
            </p>
            <div className="flex flex-wrap gap-2">
              <label className={cx(BTN_PRIMARY, 'cursor-pointer')}>
                <FileUp className="h-4 w-4" />
                {fileName ? 'Choose another file' : 'Choose CSV file'}
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
              </label>
              <button type="button" onClick={template} className={BTN_SECONDARY}><Download className="h-4 w-4" />Download template</button>
            </div>
            {rows && (
              <div className="space-y-3">
                <p className="text-sm text-gray-700"><strong>{rows.length}</strong> {rows.length === 1 ? 'carrier' : 'carriers'} in {fileName}.</p>
                <ul className="max-h-60 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-100 text-sm">
                  {rows.map((r, i) => (
                    <li key={i} className="flex justify-between gap-3 px-3 py-2">
                      <span className="text-gray-900 truncate">{r.name || '—'}</span>
                      <span className="font-mono text-gray-600">{r.mobile || '—'}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => void submit()} disabled={busy} className={cx(BTN_PRIMARY, 'w-full h-11')}>
                  {busy ? 'Adding…' : `Add ${rows.length} to Preferred carriers`}
                </button>
              </div>
            )}
          </>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(STATUS) as BulkCarrierStatus[]).filter((k) => counts[k]).map((k) => (
                <span key={k} className={pill(STATUS[k].tone)}>{STATUS[k].label}: {counts[k]}</span>
              ))}
            </div>
            <ul className="max-h-72 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-100 text-sm">
              {result.map((r) => (
                <li key={r.row} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-gray-900 truncate">{r.carrier?.name || r.name || '—'}</span>
                    <span className="block font-mono text-xs text-gray-500">Row {r.row} · {r.mobile}</span>
                  </span>
                  <span className={cx(pill(STATUS[r.status].tone), 'shrink-0')}>{STATUS[r.status].label}</span>
                </li>
              ))}
            </ul>
            {inviteNeeded.length > 0 && (
              <div className="rounded-xl border border-orange-100 bg-orange-50/60 p-3.5 space-y-3">
                <p className="text-sm text-gray-700">
                  Send your invite link to the {inviteNeeded.length} {inviteNeeded.length === 1 ? 'carrier' : 'carriers'} not added yet.
                  They join your Preferred carriers once they sign up (drivers need their own truck on BharatTruck).
                </p>
                {link ? <LinkBlock link={link} /> : (
                  <button type="button" onClick={() => void make()} className={cx(BTN_PRIMARY, 'w-full h-11')}>
                    <Link2 className="h-4 w-4" />Make an invite link
                  </button>
                )}
              </div>
            )}
            <button type="button" onClick={onDone} className={cx(BTN_SECONDARY, 'w-full')}>Done</button>
          </div>
        )}
        {err && <ErrorNote message={err} />}
      </div>
    </Modal>
  )
}
