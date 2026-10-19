'use client'

/**
 * Delivery evidence & assertion — the POD evidence-capture slice (Phase 3b of
 * docs/UNIFIED_APP_PLAN.md; migration 0025, ARCHITECTURE_UNIFIED_IDENTITY.md §6.3).
 *
 * This is the hardened POD layer that sits ALONGSIDE the receiver-OTP flow on the trip
 * screen. The OTP is the CONFIRMED tier — the receiver reads out a code and the driver
 * enters it. This card is:
 *
 *  - CAMERA EVIDENCE the driver captures at the drop regardless of the OTP: a photo taken
 *    with the device camera, hashed ON THE DEVICE (SHA-256 over the file's own bytes),
 *    geo-stamped with the fix at capture, and POSTed as metadata only. The bytes are never
 *    re-encoded (§5.4) — hashing the raw File is deliberate; a canvas round-trip would
 *    destroy the integrity anchor. Idempotent, so a retry on a flaky connection is a no-op.
 *
 *  - ASSERT DELIVERY: the no-confirmation branch. When the receiver cannot confirm (no
 *    smartphone, night drop, warehouse hand-off), the driver picks a typed reason and
 *    reports the delivery; the trip moves in_transit → delivery_asserted and ops closes
 *    it. The server REQUIRES at least one photo first, so the action is GATED on evidence
 *    existing — the driver is never handed a 400 for an empty assertion.
 *
 *  - DISCREPANCY: a compact shortage/damage note. The driver reports only the actual
 *    quantity (expected is server-held, §5.7); a captured photo backs it.
 *
 * Nothing here can blank the trip screen: a non-secure context, a denied camera, a denied
 * or unavailable GPS fix, and every failed POST each resolve to a clear message, never a
 * crash or an empty card.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle, AlertTriangle, Camera, Check, ChevronRight, CircleHelp as HelpCircle, Image as ImageIcon, Lock, MapPin,
} from 'lucide-react'

import { Card, CardHead } from '@/components/stat'
import {
  ApiError, assertDelivery, capturePodEvidence, getPodRecord, submitDiscrepancy,
} from '@/lib/api'
import { dateTime } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, SELECT, cx, pill } from '@/lib/ui'
import type {
  AssertReason, Booking, CaptureResult, DiscrepancyReason, EvidenceCaptureInput,
  EvidenceKind, GeofenceResult, PodEvidenceView,
} from '@/lib/types'

// The two required delivery shots, in capture order. `goods` is an optional extra.
const REQUIRED_KINDS: { kind: EvidenceKind; label: string; hint: string }[] = [
  { kind: 'signed_invoice', label: 'Signed invoice copy', hint: 'The customer-signed invoice / LR copy' },
  { kind: 'vehicle', label: 'Vehicle photo', hint: 'The truck at the delivery point' },
]

function kindLabel(kind: EvidenceKind | null): string {
  if (kind === 'signed_invoice') return 'Signed invoice copy'
  if (kind === 'vehicle') return 'Vehicle photo'
  return 'Photo'
}

// base64 of the photo's own bytes, chunked so a multi-MB image does not overflow the call
// stack. The SAME ArrayBuffer that produced the SHA-256, so the hash and the uploaded bytes
// can never disagree.
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

// The six typed assert reasons (pod_state.assert_reason), most-common first.
const ASSERT_REASONS: { value: AssertReason; label: string }[] = [
  { value: 'no_receiver_present', label: 'No receiver present at the drop' },
  { value: 'no_smartphone', label: 'Receiver has no smartphone' },
  { value: 'receiver_refused_confirm', label: 'Receiver refused to confirm' },
  { value: 'warehouse_handoff', label: 'Warehouse hand-off (loader, no code)' },
  { value: 'night_delivery', label: 'Night delivery' },
  { value: 'other', label: 'Other reason' },
]

// The five typed discrepancy reasons (pod_discrepancies.reason, §5.7).
const DISCREPANCY_REASONS: { value: DiscrepancyReason; label: string }[] = [
  { value: 'shortage', label: 'Shortage (fewer than expected)' },
  { value: 'damage', label: 'Damage' },
  { value: 'wrong_goods', label: 'Wrong goods' },
  { value: 'partial_acceptance', label: 'Partial acceptance' },
  { value: 'refusal', label: 'Receiver refused the goods' },
]

// On-device SHA-256 over the photo's OWN bytes — the integrity anchor the server stores
// verbatim and never recomputes (§5.4). Requires a secure context (guarded by the caller).
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// One-shot fix at capture time (fresher than a watch fix for geofencing the photo).
// Resolves null rather than throwing so a denied/unavailable GPS never blocks a capture.
function getFix(): Promise<{ lat: number; lng: number; accuracy?: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? undefined }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 },
    )
  })
}

function formatDistance(m: number | null): string | null {
  if (m == null || !Number.isFinite(m)) return null
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

function geofenceBadge(result: GeofenceResult, distanceM: number | null): { label: string; cls: string } {
  const dist = formatDistance(distanceM)
  if (result === 'inside') return { label: dist ? `At the drop · ${dist}` : 'At the drop', cls: pill('green') }
  if (result === 'outside') return { label: dist ? `${dist} from drop` : 'Away from drop', cls: pill('amber') }
  return { label: 'Location not captured', cls: pill('slate') }
}

// One display row, mapped from either a fresh capture (has a local thumbnail) or a
// ledger read (no bytes to preview — storage is WORM/inert, so only metadata comes back).
type EvidenceItem = {
  evidence_id: string
  kind: EvidenceKind | null
  captured_at_server: string
  geofence_result: GeofenceResult
  geofence_distance_m: number | null
  previewUrl?: string
  imageUrl?: string | null
}

function fromCapture(r: CaptureResult, previewUrl?: string): EvidenceItem {
  return {
    evidence_id: r.evidence_id,
    kind: r.kind,
    captured_at_server: r.captured_at_server,
    geofence_result: r.geofence_result,
    geofence_distance_m: r.geofence_distance_m,
    previewUrl,
  }
}

function fromView(v: PodEvidenceView): EvidenceItem {
  return {
    evidence_id: v.evidence_id,
    kind: v.kind,
    captured_at_server: v.captured_at_server,
    geofence_result: v.geofence_result,
    geofence_distance_m: v.geofence_distance_m,
    imageUrl: v.image_url,
  }
}

export default function DeliveryEvidence({
  booking, currentPos, onChanged,
}: {
  booking: Booking
  currentPos: { lat: number; lng: number } | null
  onChanged: () => void
}) {
  const asserted = booking.status === 'delivery_asserted'

  const fileRef = useRef<HTMLInputElement | null>(null)
  const previewsRef = useRef<string[]>([])
  // Which shot the next file-pick is for — set before opening the camera so onFileSelected
  // tags the capture correctly (one hidden input serves every kind).
  const pendingKind = useRef<EvidenceKind>('signed_invoice')

  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [capturingKind, setCapturingKind] = useState<EvidenceKind | null>(null)

  const [showAssert, setShowAssert] = useState(false)
  const [assertReason, setAssertReason] = useState<AssertReason>('no_receiver_present')
  const [asserting, setAsserting] = useState(false)

  const [showDiscrepancy, setShowDiscrepancy] = useState(false)
  const [discReason, setDiscReason] = useState<DiscrepancyReason>('shortage')
  const [actualQty, setActualQty] = useState('')
  const [discUnit, setDiscUnit] = useState('')
  const [discErr, setDiscErr] = useState<string | null>(null)
  const [submittingDisc, setSubmittingDisc] = useState(false)
  const [discrepancyDone, setDiscrepancyDone] = useState(false)

  // Merge server rows in, preserving any session thumbnail we already hold. Newest first.
  const mergeEvidence = useCallback((serverRows: PodEvidenceView[]) => {
    setEvidence((prev) => {
      const byId = new Map(prev.map((e) => [e.evidence_id, e]))
      for (const row of serverRows) {
        const existing = byId.get(row.evidence_id)
        byId.set(row.evidence_id, { ...fromView(row), previewUrl: existing?.previewUrl })
      }
      return [...byId.values()].sort((a, b) => b.captured_at_server.localeCompare(a.captured_at_server))
    })
  }, [])

  // Load any already-captured evidence so a reload shows prior photos and an existing
  // discrepancy. Best-effort — capture still works if the ledger read fails.
  useEffect(() => {
    let cancelled = false
    getPodRecord(booking.id)
      .then((rec) => {
        if (cancelled) return
        mergeEvidence(rec.evidence)
        if (rec.discrepancy) setDiscrepancyDone(true)
      })
      .catch(() => { /* silent — the ledger read is a convenience, not the capture path */ })
    return () => { cancelled = true }
  }, [booking.id, mergeEvidence])

  // Release object URLs when the section unmounts (trip closes or we navigate away).
  useEffect(() => () => { previewsRef.current.forEach((u) => URL.revokeObjectURL(u)) }, [])

  // Open the camera for a specific shot; onFileSelected reads pendingKind to tag it.
  function capture(kind: EvidenceKind) {
    pendingKind.current = kind
    fileRef.current?.click()
  }

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the driver re-take the same file if they need to
    if (!file) return
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      toast.error('Photo capture needs a secure (HTTPS) connection.')
      return
    }
    const kind = pendingKind.current
    setCapturingKind(kind)
    try {
      const buf = await file.arrayBuffer()
      const sha = await sha256Hex(buf)
      // The uploaded bytes ARE the hashed bytes — no re-encode, so the device hash and the
      // server's re-hash (sha256_received) agree (§5.4 rule 3).
      const image_base64 = bufToBase64(buf)

      // Prefer a fresh one-shot fix; fall back to the trip's live position if GPS is slow
      // or denied here. Neither available → capture without coords (geofence = 'unknown').
      let pos: { lat: number; lng: number; accuracy?: number } | null = await getFix()
      if (!pos && currentPos) pos = { lat: currentPos.lat, lng: currentPos.lng }

      const body: EvidenceCaptureInput = {
        sha256_original: sha,
        capture_method: 'camera',
        kind,
        image_base64,
        captured_at_device: new Date().toISOString(),
        gps_source: 'browser',
        content_type: file.type || undefined,
      }
      if (pos) {
        body.lat = pos.lat
        body.lng = pos.lng
        if (pos.accuracy != null) body.gps_accuracy_m = pos.accuracy
      }

      const res = await capturePodEvidence(booking.id, body)
      const previewUrl = URL.createObjectURL(file)
      previewsRef.current.push(previewUrl)
      setEvidence((prev) => [fromCapture(res, previewUrl), ...prev.filter((x) => x.evidence_id !== res.evidence_id)])
      toast.success(res.created ? `${kindLabel(kind)} captured` : `${kindLabel(kind)} was already captured`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not capture the photo. Please try again.')
    } finally {
      setCapturingKind(null)
    }
  }

  async function handleAssert() {
    setAsserting(true)
    try {
      await assertDelivery(booking.id, assertReason)
      toast.success('Delivery reported — our team confirms and closes the trip')
      onChanged() // status flips to delivery_asserted; the parent re-renders this in asserted mode
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not report the delivery')
      setAsserting(false)
    }
  }

  async function handleDiscrepancy(e: FormEvent) {
    e.preventDefault()
    const qty = Number(actualQty)
    if (actualQty.trim() === '' || !Number.isFinite(qty) || qty < 0) {
      setDiscErr('Enter the actual quantity received (0 or more).')
      return
    }
    if (evidence.length === 0) {
      setDiscErr('Capture a delivery photo first — a discrepancy needs one on record.')
      return
    }
    setSubmittingDisc(true)
    setDiscErr(null)
    try {
      await submitDiscrepancy(booking.id, {
        actual_quantity: qty,
        reason: discReason,
        quantity_unit: discUnit.trim() || undefined,
        evidence_id: evidence[0].evidence_id, // the most recent capture backs the note
      })
      toast.success('Discrepancy recorded')
      setShowDiscrepancy(false)
      setDiscrepancyDone(true)
      setActualQty('')
    } catch (err) {
      setDiscErr(err instanceof ApiError ? err.message : 'Could not record the discrepancy')
    } finally {
      setSubmittingDisc(false)
    }
  }

  const hasEvidence = evidence.length > 0
  const capturedKinds = new Set(evidence.map((e) => e.kind).filter((k): k is EvidenceKind => k != null))
  const bothCaptured = REQUIRED_KINDS.every((r) => capturedKinds.has(r.kind))
  // The newest capture of each required kind, for the tile thumbnail.
  const latestOf = (kind: EvidenceKind) => evidence.find((e) => e.kind === kind)

  return (
    <Card>
      <CardHead
        title="Delivery evidence"
        sub="Camera photos, hashed and geo-stamped at the drop"
        icon={<Camera />}
        tint="blue"
      />
      <div className="p-4 sm:p-5 space-y-4">
        {asserted && (
          <div role="status" className="rounded-xl bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
            <span className="w-9 h-9 rounded-full bg-amber-400 text-gray-900 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[0.9375rem] font-bold text-amber-900">Delivery reported — awaiting confirmation</p>
              <p className="text-sm text-amber-800 mt-0.5">
                Our team reviews the evidence and closes the trip.
              </p>
            </div>
          </div>
        )}

        {/* Capture — the two required geo-stamped shots */}
        <div className="space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFileSelected}
            className="hidden"
            aria-hidden="true"
          />
          <div className="grid grid-cols-2 gap-3">
            {REQUIRED_KINDS.map(({ kind, label, hint }) => {
              const done = capturedKinds.has(kind)
              const busy = capturingKind === kind
              const shot = latestOf(kind)
              const thumb = shot?.previewUrl || shot?.imageUrl || null
              return (
                <button
                  key={kind}
                  onClick={() => capture(kind)}
                  disabled={capturingKind !== null}
                  className={cx(
                    'relative flex flex-col justify-start rounded-xl border-2 text-left overflow-hidden transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2',
                    done ? 'border-emerald-400 bg-emerald-50/40' : 'border-dashed border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/40',
                  )}
                >
                  <span className={cx('relative flex items-center justify-center h-28', done ? 'bg-emerald-50' : 'bg-gray-50')}>
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a local blob preview or a short-lived signed URL; next/image cannot optimize either
                      <img src={thumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    ) : busy ? (
                      <span className="w-7 h-7 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
                    ) : done ? (
                      <ImageIcon className="w-8 h-8 text-emerald-600/70" />
                    ) : (
                      <span className="w-12 h-12 rounded-full bg-blue-600 text-[#fff] flex items-center justify-center">
                        <Camera className="w-6 h-6" />
                      </span>
                    )}
                    {done && (
                      <span className="absolute top-2 right-2 w-7 h-7 rounded-full bg-emerald-600 text-[#fff] flex items-center justify-center shadow">
                        <Check className="w-4 h-4" strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className={cx('block px-3 py-1.5 text-xs font-semibold border-b', done ? 'text-emerald-700 border-emerald-100' : 'text-blue-700 border-gray-100')}>
                    {busy ? 'Capturing…' : done ? 'Captured · Tap to retake' : 'Tap to capture'}
                  </span>
                  <span className="block px-3 py-2.5">
                    <span className="block text-sm font-bold text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-500 mt-0.5 leading-snug">{hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-3.5 py-3 flex items-center gap-3">
            <Lock className="w-5 h-5 text-blue-600 shrink-0" />
            <p className="text-sm text-gray-600">
              Both photos are hashed on your phone and geo-stamped at the drop.
            </p>
          </div>
        </div>

        {/* Evidence list */}
        {hasEvidence && (
          <div className="space-y-2">
            <p className="text-base font-bold text-gray-900">Captured ({evidence.length})</p>
            <ul className="space-y-2">
              {evidence.map((ev) => {
                const badge = geofenceBadge(ev.geofence_result, ev.geofence_distance_m)
                return (
                  <li key={ev.evidence_id} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-2.5">
                    <div className="w-16 h-16 rounded-lg bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center">
                      {(ev.previewUrl || ev.imageUrl) ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a local blob preview or a short-lived signed URL; next/image cannot optimize either
                        <img src={ev.previewUrl || ev.imageUrl || ''} alt={kindLabel(ev.kind)} className="w-full h-full object-cover" />
                      ) : (
                        <Camera className="w-6 h-6 text-gray-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      {ev.kind && <p className="text-[0.9375rem] font-bold text-gray-900">{kindLabel(ev.kind)}</p>}
                      <span className={cx(badge.cls, 'mt-1')}>
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        {badge.label}
                      </span>
                      <p className="text-xs text-gray-500 mt-1">{dateTime(ev.captured_at_server)}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {discrepancyDone && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
            A shortage/damage note is on record for this delivery.
          </div>
        )}

        {/* Secondary actions */}
        {(!asserted || !discrepancyDone) && (
          <div className="pt-1 space-y-2.5">
            {/* Assert — only while the trip is still in transit. */}
            {!asserted && (
              !showAssert ? (
                <ActionRow
                  onClick={() => setShowAssert(true)}
                  icon={<HelpCircle className="w-5 h-5" />}
                  iconCls="bg-blue-50 text-blue-600"
                  title="Receiver can't confirm the code?"
                  sub="Report delivery without a code"
                />
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                  <div>
                    <p className="text-base font-bold text-gray-900">Report delivery without a code</p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      Use only when the receiver can&apos;t confirm; capture a photo first.
                    </p>
                  </div>
                  {!bothCaptured && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 flex items-start gap-2.5">
                      <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-px" />
                      <p className="text-sm text-red-700">Capture both the signed invoice copy and a vehicle photo above before reporting.</p>
                    </div>
                  )}
                  <div>
                    <label htmlFor={`assert-reason-${booking.id}`} className={LABEL}>Reason</label>
                    <select
                      id={`assert-reason-${booking.id}`}
                      value={assertReason}
                      onChange={(e) => setAssertReason(e.target.value as AssertReason)}
                      className={cx(SELECT, 'h-12! text-[0.9375rem]!')}
                    >
                      {ASSERT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      onClick={() => setShowAssert(false)}
                      disabled={asserting}
                      className={cx(BTN_SECONDARY, 'h-12! w-full')}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAssert}
                      disabled={asserting || !bothCaptured}
                      className={cx(BTN_PRIMARY, 'h-12! w-full')}
                    >
                      {asserting && <span className="w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />}
                      {asserting ? 'Reporting…' : 'Report delivery'}
                    </button>
                  </div>
                </div>
              )
            )}

            {/* Discrepancy — available in transit and after an assertion. */}
            {!discrepancyDone && (
              !showDiscrepancy ? (
                <ActionRow
                  onClick={() => setShowDiscrepancy(true)}
                  icon={<AlertCircle className="w-5 h-5" />}
                  iconCls="bg-red-50 text-red-600"
                  title="Report shortage or damage"
                  sub="Tell us what happened"
                />
              ) : (
                <form onSubmit={handleDiscrepancy} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                  <div>
                    <p className="text-base font-bold text-gray-900">Report a problem with this delivery</p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      Enter what you actually received.
                    </p>
                  </div>
                  <div>
                    <label htmlFor={`disc-reason-${booking.id}`} className={LABEL}>Problem</label>
                    <select
                      id={`disc-reason-${booking.id}`}
                      value={discReason}
                      onChange={(e) => setDiscReason(e.target.value as DiscrepancyReason)}
                      className={cx(SELECT, 'h-12! text-[0.9375rem]!')}
                    >
                      {DISCREPANCY_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-2.5">
                    <div className="flex-1 min-w-0">
                      <label htmlFor={`disc-qty-${booking.id}`} className={LABEL}>Actual quantity received</label>
                      <input
                        id={`disc-qty-${booking.id}`}
                        inputMode="decimal"
                        value={actualQty}
                        onChange={(e) => { setActualQty(e.target.value.replace(/[^\d.]/g, '')); setDiscErr(null) }}
                        placeholder="0"
                        className={cx(INPUT, 'h-12! text-[0.9375rem]! tabular-nums')}
                      />
                    </div>
                    <div className="w-28">
                      <label htmlFor={`disc-unit-${booking.id}`} className={LABEL}>Unit</label>
                      <input
                        id={`disc-unit-${booking.id}`}
                        value={discUnit}
                        onChange={(e) => setDiscUnit(e.target.value)}
                        placeholder="boxes"
                        className={cx(INPUT, 'h-12! text-[0.9375rem]!')}
                      />
                    </div>
                  </div>
                  {!hasEvidence && <p className="text-sm text-amber-700">Capture a delivery photo above before reporting a problem.</p>}
                  {discErr && <p role="alert" className="text-sm text-red-600">{discErr}</p>}
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => { setShowDiscrepancy(false); setDiscErr(null) }}
                      disabled={submittingDisc}
                      className={cx(BTN_SECONDARY, 'h-12! w-full')}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submittingDisc || !hasEvidence}
                      className={cx(BTN_PRIMARY, 'h-12! w-full')}
                    >
                      {submittingDisc && <span className="w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />}
                      {submittingDisc ? 'Recording…' : 'Record'}
                    </button>
                  </div>
                </form>
              )
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

/** A full-width tappable row: tinted round icon, a bold line, a grey line, a chevron. */
function ActionRow({
  onClick, icon, iconCls, title, sub,
}: { onClick: () => void; icon: ReactNode; iconCls: string; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full min-h-[60px] rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3.5 py-3 flex items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      <span className={cx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', iconCls)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] font-semibold text-gray-900">{title}</span>
        <span className="block text-sm text-gray-500">{sub}</span>
      </span>
      <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
    </button>
  )
}
