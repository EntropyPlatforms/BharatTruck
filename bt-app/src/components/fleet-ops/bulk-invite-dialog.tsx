'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, Download, FileUp, Trash2 } from 'lucide-react'
import { ErrorNote } from '@/components/stat'
import { Modal, fmtPhone } from '@/components/fleet-ops/bits'
import {
  ApiError, BULK_INVITE_LIMIT, inviteDriversBulk,
  type BulkInviteResponse, type BulkInviteStatus,
} from '@/lib/api'
import {
  readDriverCsv, templateCsv, toInviteRow, validateRows, type DraftRow,
} from '@/lib/driver-csv'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, INPUT_ERROR, LINK, cx, pill, type PillTone } from '@/lib/ui'

/**
 * Invite many drivers from one CSV — the "Invite driver" dialog, for a list.
 *
 * Three steps in one dialog: pick a file -> check and fix the rows here in the browser -> one
 * call to POST /fleet/drivers/invite/bulk and a per-row result. Same consent model as one
 * invite: every driver must already have a BharatTruck account and must accept from their own
 * app; this never creates an account for anyone.
 */

/** A drivers list is a few KB; anything this big is the wrong file, so refuse it before reading. */
const MAX_FILE_BYTES = 1_000_000

const STATUS: Record<BulkInviteStatus, { label: string; tone: PillTone }> = {
  invited:          { label: 'Invited',          tone: 'green' },
  already_in_fleet: { label: 'Already in fleet', tone: 'blue' },
  already_invited:  { label: 'Already invited',  tone: 'amber' },
  unavailable:      { label: 'In another fleet', tone: 'slate' },
  no_account:       { label: 'No account',       tone: 'orange' },
  duplicate:        { label: 'Duplicate',        tone: 'slate' },
  invalid:          { label: 'Invalid',          tone: 'red' },
  failed:           { label: 'Failed',           tone: 'red' },
}
const STATUS_ORDER: BulkInviteStatus[] = [
  'invited', 'already_in_fleet', 'already_invited', 'no_account', 'unavailable', 'duplicate', 'invalid', 'failed',
]

export function BulkInviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [result, setResult] = useState<BulkInviteResponse | null>(null)
  // The rows exactly as sent: the service numbers results by position in the request, and this
  // maps that back to the line in the owner's file that the preview showed.
  const [sent, setSent] = useState<DraftRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const problems = useMemo(() => validateRows(rows ?? []), [rows])
  const badCount = problems.size
  // "Show only these" turns itself off once nothing is left to fix, so the list never goes blank.
  const shown = (rows ?? []).filter(r => !onlyProblems || badCount === 0 || problems.has(r.key))

  // After a submit the roster has changed, so closing — by any route — refreshes it.
  const close = result ? onDone : onClose

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'bharattruck-drivers-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function pickFile(file: File | undefined) {
    setErr(null)
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setErr(`${file.name} is too large for a drivers list. Use the CSV template — one driver per line.`)
      return
    }
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      setErr(`${file.name} is not a CSV file. In Excel or Google Sheets use "Save as / Download → CSV".`)
      return
    }
    const read = readDriverCsv(await file.text())
    if ('error' in read) { setErr(read.error); return }
    if (read.rows.length > BULK_INVITE_LIMIT) {
      setErr(`The file has ${read.rows.length} drivers. Upload at most ${BULK_INVITE_LIMIT} at a time — split it into smaller files.`)
      return
    }
    setFileName(file.name)
    setRows(read.rows)
    setOnlyProblems(false)
  }

  function edit(key: number, field: 'name' | 'mobile' | 'email', value: string) {
    setRows(prev => prev?.map(r => (r.key === key ? { ...r, [field]: value } : r)) ?? prev)
  }

  function remove(key: number) {
    setRows(prev => {
      const next = prev?.filter(r => r.key !== key) ?? null
      return next && next.length > 0 ? next : null
    })
  }

  async function submit() {
    if (!rows || rows.length === 0 || badCount > 0) return
    setBusy(true)
    setErr(null)
    try {
      setSent(rows)
      setResult(await inviteDriversBulk(rows.map(toInviteRow)))
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof Error ? e.message : 'Could not send the invitations')
    } finally {
      setBusy(false)
    }
  }

  // ── Step 3: results ───────────────────────────────────────
  if (result) {
    const invited = result.counts.invited
    const lineOf = (row: number) => sent[row - 1]?.line ?? row
    return (
      <Modal
        title={invited > 0 ? 'Invitations sent' : 'No new invitations'}
        sub={`${invited} of ${result.total} ${result.total === 1 ? 'driver' : 'drivers'} invited. Each one has to accept from their own app.`}
        onClose={close}
        width="sm:max-w-3xl"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2" aria-label="Summary">
            {STATUS_ORDER.filter(s => result.counts[s] > 0).map(s => (
              <span key={s} className={cx(pill(STATUS[s].tone), 'py-1')}>
                {STATUS[s].label}: {result.counts[s]}
              </span>
            ))}
          </div>
          {result.counts.no_account > 0 && (
            <p className="text-xs text-gray-600 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
              &ldquo;No account&rdquo; means that driver has not signed up on BharatTruck yet. Ask them to
              sign up as a driver, then invite them again.
            </p>
          )}
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {result.results.map(r => (
              <li key={r.row} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 px-3.5 py-2.5">
                <span className="text-xs text-gray-400 tabular-nums w-14 shrink-0">Row {lineOf(r.row)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 truncate">{r.name ?? 'Unnamed row'}</span>
                  {r.driver && (
                    <span className="block text-xs text-gray-500 truncate">
                      Account: {r.driver.full_name ?? 'Unnamed driver'}
                      {r.driver.phone_number ? ` · ${fmtPhone(r.driver.phone_number)}` : ''}
                    </span>
                  )}
                  {r.reason && (
                    <span className="block text-xs text-gray-500">
                      {r.reason.replace(/\brow (\d+)/g, (_, n: string) => `row ${lineOf(Number(n))}`)}
                    </span>
                  )}
                </span>
                <span className={cx(pill(STATUS[r.status].tone), 'self-start sm:self-center')}>{STATUS[r.status].label}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onDone} className={cx(BTN_PRIMARY, 'w-full')}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  // ── Step 2: check and fix ─────────────────────────────────
  if (rows) {
    return (
      <Modal
        title="Check the drivers"
        sub={`${fileName} · ${rows.length} ${rows.length === 1 ? 'driver' : 'drivers'}${badCount > 0 ? ` · ${badCount} to fix` : ' · all good'}`}
        onClose={close}
        width="sm:max-w-3xl"
      >
        <div className="space-y-4">
          {badCount > 0 ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
              <span>Fix or remove the {badCount} {badCount === 1 ? 'row' : 'rows'} marked in red, then send.</span>
              <span className="flex gap-3 shrink-0">
                <button type="button" onClick={() => setOnlyProblems(v => !v)} className={cx(LINK, 'text-sm')}>
                  {onlyProblems ? 'Show all rows' : 'Show only these'}
                </button>
                <button
                  type="button"
                  onClick={() => { setRows(prev => { const n = prev?.filter(r => !problems.has(r.key)) ?? null; return n && n.length ? n : null }); setOnlyProblems(false) }}
                  className="text-sm font-semibold text-red-600 hover:text-red-700"
                >
                  Remove them
                </button>
              </span>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4" /> Every row is ready. Mobile is used when a row has both mobile and email.
            </p>
          )}

          <ul className="space-y-2">
            {shown.map(r => {
              const p = problems.get(r.key)
              return (
                <li key={r.key} className={cx('rounded-xl border px-3 py-2.5', p ? 'border-red-200 bg-red-50/40' : 'border-gray-200')}>
                  {/* Phones: a compact card (row number + remove on top, name full width, mobile and
                      email side by side). sm and up: one line per row, like a table. */}
                  <div className="flex items-center justify-between gap-2 -mt-1 -mr-1.5 sm:hidden">
                    <span className="text-xs text-gray-400 tabular-nums">Row {r.line}</span>
                    <RemoveRow onClick={() => remove(r.key)} line={r.line} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-[3rem_1fr_1fr_1fr_auto] gap-2 sm:items-start">
                    <span className="hidden sm:block text-xs text-gray-400 tabular-nums pt-6">{r.line}</span>
                    <Field label="Name" value={r.name} error={p?.name} onChange={v => edit(r.key, 'name', v)} line={r.line} className="col-span-2 sm:col-span-1" />
                    <Field label="Mobile" value={r.mobile} error={p?.mobile} onChange={v => edit(r.key, 'mobile', v)} line={r.line} inputMode="tel" />
                    <Field label="Email" value={r.email} error={p?.email} onChange={v => edit(r.key, 'email', v)} line={r.line} inputMode="email" placeholder="optional" />
                    <span className="hidden sm:block pt-4">
                      <RemoveRow onClick={() => remove(r.key)} line={r.line} />
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="text-xs text-gray-500">
            Each driver gets an invitation to accept in their own app — nobody joins your fleet until they accept.
            Drivers who have not signed up on BharatTruck yet cannot be invited.
          </p>
          {err && <ErrorNote message={err} />}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button type="button" onClick={() => { setRows(null); setFileName(null); setErr(null) }} className={BTN_SECONDARY}>
              Choose another file
            </button>
            <button type="button" onClick={() => void submit()} disabled={busy || badCount > 0} className={BTN_PRIMARY}>
              {busy ? 'Sending…' : `Invite ${rows.length} ${rows.length === 1 ? 'driver' : 'drivers'}`}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  // ── Step 1: pick a file ───────────────────────────────────
  return (
    <Modal title="Upload drivers" sub="Invite many drivers at once from a CSV file." onClose={close}>
      <div className="space-y-4">
        <ol className="space-y-1.5 text-sm text-gray-700 list-decimal pl-5">
          <li>Download the template and open it in Excel or Google Sheets.</li>
          <li>One driver per line: <span className="font-semibold">name</span> and <span className="font-semibold">mobile</span> (or <span className="font-semibold">email</span>, if you invite them by email).</li>
          <li>Save as CSV and upload it here — up to {BULK_INVITE_LIMIT} drivers per file.</li>
        </ol>
        <button type="button" onClick={downloadTemplate} className={cx(BTN_SECONDARY, 'w-full')}>
          <Download className="w-4 h-4" />
          Download CSV template
        </button>

        <div>
          <label htmlFor="drivers_csv" className="sr-only">Drivers CSV file</label>
          {/* The real file input covers the dashed zone (transparent), so clicking opens the picker
              and dropping a file on it works natively — same as the trucks bulk upload. */}
          <div className="relative rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/60 hover:border-blue-400 hover:bg-blue-50/40 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100 transition-colors px-4 py-7 text-center">
            <input
              id="drivers_csv"
              type="file"
              accept=".csv,text/csv"
              onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = '' }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <span className="mx-auto mb-2 w-11 h-11 rounded-xl bg-white border border-gray-200 text-gray-600 inline-flex items-center justify-center" aria-hidden>
              <FileUp className="w-5 h-5" />
            </span>
            <p className="text-sm font-semibold text-gray-900">
              Drop the CSV here, or <span className="text-blue-600">browse</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">Columns: name, mobile, email (optional)</p>
          </div>
        </div>

        {err && <ErrorNote message={err} />}
        <button type="button" onClick={close} className={cx(BTN_SECONDARY, 'w-full')}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function Field({
  label, value, error, onChange, line, inputMode, placeholder, className,
}: {
  label: string
  value: string
  error?: string
  onChange: (v: string) => void
  line: number
  inputMode?: 'tel' | 'email'
  placeholder?: string
  className?: string
}) {
  return (
    <label className={cx('block min-w-0', className)}>
      <span className="block text-[0.6875rem] font-medium text-gray-500 mb-0.5">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        inputMode={inputMode}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={`${label}, row ${line}`}
        aria-invalid={error ? true : undefined}
        className={cx(error ? INPUT_ERROR : INPUT, 'h-9', inputMode === 'tel' && 'tabular-nums')}
      />
      {error && <span className="block mt-0.5 text-xs text-red-600">{error}</span>}
    </label>
  )
}

function RemoveRow({ onClick, line }: { onClick: () => void; line: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove row ${line}`}
      title="Remove this row"
      className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  )
}
