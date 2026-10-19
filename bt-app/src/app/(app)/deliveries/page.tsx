'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, CircleCheck, CircleX, Clock, FileText, MapPin, Package, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, ErrorNote, IconTile, Loading, Stat } from '@/components/stat'
import { Modal, RouteLine } from '@/components/fleet-ops/bits'
import { ApiError, getPodRecord, listFleetPodPending, verifyDelivery } from '@/lib/api'
import { dateTime, timeAgo } from '@/lib/format'
import type { EvidenceKind, FleetPendingItem, GeofenceResult, PodEvidenceView, PodRecord } from '@/lib/types'
import { BTN_BLUE, BTN_BLUE_SOLID, BTN_SECONDARY, LABEL, TEXTAREA, cx, pill, type PillTone } from '@/lib/ui'

/**
 * Deliveries — the fleet owner's verification queue (migration 0039).
 *
 * A driver captures two typed, geo-stamped shots at the drop — the signed customer invoice
 * copy and a photo of the vehicle — and each delivery lands here awaiting the owner's
 * decision. The owner reviews the photos, the geofence verdict and the capture time, then
 * APPROVES or REJECTS. This is a new verification actor, distinct from the receiver OTP
 * (which confirms the delivery) and the ops close: the carrier attesting the proof its own
 * driver produced. The list is owner-scoped server-side (canFleetAccessBooking) — a
 * delivery on someone else's fleet can never appear here.
 */

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

function kindLabel(kind: EvidenceKind | null): string {
  if (kind === 'signed_invoice') return 'Signed invoice copy'
  if (kind === 'vehicle') return 'Vehicle photo'
  if (kind === 'goods') return 'Goods photo'
  return 'Photo'
}

function fmtDistance(m: number | null): string | null {
  if (m == null || !Number.isFinite(m)) return null
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

function geofenceBadge(result: GeofenceResult, distanceM: number | null): { label: string; tone: PillTone } {
  const d = fmtDistance(distanceM)
  if (result === 'inside') return { label: d ? `At the drop · ${d}` : 'At the drop', tone: 'green' }
  if (result === 'outside') return { label: d ? `${d} from drop` : 'Away from drop', tone: 'amber' }
  return { label: 'Location not captured', tone: 'slate' }
}

// Signed invoice first, then vehicle, then anything else — the order the owner reviews in.
const KIND_ORDER: Record<string, number> = { signed_invoice: 0, vehicle: 1, goods: 2, other: 3 }
function orderEvidence(evidence: PodEvidenceView[]): PodEvidenceView[] {
  return [...evidence].sort((a, b) => (KIND_ORDER[a.kind ?? 'other'] ?? 9) - (KIND_ORDER[b.kind ?? 'other'] ?? 9))
}

export default function DeliveriesPage() {
  const [pending, setPending] = useState<FleetPendingItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<FleetPendingItem | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await listFleetPodPending()
      setPending(res.pending)
      setError(null)
    } catch (e) {
      setError(errText(e, 'Could not load deliveries'))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const count = pending?.length ?? 0

  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto">
      <PageHeader
        title="Deliveries"
        info="Review the signed invoice copy and the vehicle photo your driver captured at the drop, then approve or reject the delivery."
        subtitle={pending ? (count === 0 ? 'All caught up' : `${count} awaiting your review`) : undefined}
        actions={
          <button
            onClick={() => { setLoading(true); void load() }}
            disabled={loading}
            className={cx(BTN_BLUE, 'h-10 px-4')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {loading ? (
        <Loading label="Loading deliveries" />
      ) : error ? (
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={() => { setLoading(true); void load() }} className={BTN_SECONDARY}>
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="max-w-md">
            <Stat
              label="Awaiting review"
              value={count}
              tone={count > 0 ? 'warn' : 'good'}
              sub={count > 0 ? 'Deliveries need your decision' : 'Nothing waiting on you'}
              icon={<Clock />}
            />
          </div>

          {count === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 flex flex-col items-center text-center">
              <span className="w-12 h-12 rounded-full bg-emerald-500 text-[#fff] inline-flex items-center justify-center mb-3">
                <CheckCircle2 className="w-7 h-7" />
              </span>
              <p className="text-base font-bold text-gray-900">Nothing to review</p>
              <p className="text-sm text-gray-500 mt-1 max-w-md">A delivery appears here once a driver captures the two photos at the drop.</p>
            </div>
          ) : (
            <Card>
              <CardHead
                title="Awaiting verification"
                sub="Each shows the signed invoice and vehicle photos captured at the drop."
                icon={<FileText />}
              />
              <ul className="p-3 sm:p-4 space-y-2.5">
                {pending!.map((d) => {
                  const when = d.asserted_at ?? d.confirmed_at
                  const confirmed = d.pod_strength === 'confirmed'
                  return (
                    <li
                      key={d.booking_id}
                      className="rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors px-4 py-3.5 grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,0.9fr)_auto] items-center gap-x-4 gap-y-3"
                    >
                      <IconTile icon={<Package />} tint="slate" />
                      <div className="min-w-0">
                        <RouteLine from={d.source_address} to={d.destination_address} max="max-w-[180px]" className="text-base font-bold text-gray-900" />
                        {d.shipper_name?.trim() && <div className="mt-0.5 text-sm text-gray-500 truncate">{d.shipper_name}</div>}
                      </div>
                      <div className="col-start-2 sm:col-start-auto min-w-0">
                        <span className={pill(confirmed ? 'green' : 'amber')}>
                          {confirmed ? 'Receiver confirmed' : 'Driver asserted'}
                        </span>
                        {when && (
                          <div className="mt-1 text-sm text-gray-600">
                            Delivered {timeAgo(when)}
                            <span className="block text-xs text-gray-400">{dateTime(when)}</span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => setReviewing(d)}
                        className={cx(BTN_BLUE_SOLID, 'col-span-2 sm:col-span-1 h-10 px-5 w-full sm:w-auto')}
                      >
                        Review
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </div>
      )}

      {reviewing && (
        <ReviewModal
          item={reviewing}
          onClose={() => setReviewing(null)}
          onDone={(decision) => {
            const done = reviewing
            setReviewing(null)
            setPending((prev) => prev?.filter((x) => x.booking_id !== done.booking_id) ?? null)
            toast.success(decision === 'approve' ? 'Delivery approved' : 'Delivery rejected')
          }}
        />
      )}
    </div>
  )
}


// ── Review modal ──────────────────────────────────────────────

function ReviewModal({
  item, onClose, onDone,
}: {
  item: FleetPendingItem
  onClose: () => void
  onDone: (decision: 'approve' | 'reject') => void
}) {
  const [rec, setRec] = useState<PodRecord | null>(null)
  const [loadingRec, setLoadingRec] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let cancelled = false
    getPodRecord(item.booking_id)
      .then((r) => { if (!cancelled) { setRec(r); setLoadingRec(false) } })
      .catch((e) => { if (!cancelled) { setErr(errText(e, 'Could not load the evidence')); setLoadingRec(false) } })
    return () => { cancelled = true }
  }, [item.booking_id])

  async function decide(decision: 'approve' | 'reject') {
    // A rejection should carry a reason; nudge but do not hard-block.
    setBusy(decision)
    setErr(null)
    try {
      await verifyDelivery(item.booking_id, decision, note.trim() || undefined)
      onDone(decision)
    } catch (e) {
      setErr(errText(e, 'Could not record your decision'))
      setBusy(null)
    }
  }

  const evidence = rec ? orderEvidence(rec.evidence) : []
  const when = item.asserted_at ?? item.confirmed_at
  const confirmed = item.pod_strength === 'confirmed'

  return (
    <Modal
      title="Verify delivery"
      sub="Check the invoice and vehicle photos, then approve or reject."
      onClose={onClose}
      width="sm:max-w-3xl"
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3.5 flex items-start gap-3.5">
          <IconTile icon={<Package />} tint="brand" />
          <div className="min-w-0 text-sm">
            <RouteLine from={item.source_address} to={item.destination_address} max="max-w-[220px]" className="text-base font-bold text-gray-900" />
            {item.shipper_name?.trim() && <div className="text-gray-600 mt-0.5">{item.shipper_name}</div>}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-gray-600">
              <span className={pill(confirmed ? 'green' : 'amber')}>{confirmed ? 'Receiver confirmed' : 'Driver asserted'}</span>
              {when && <span>Delivered {dateTime(when)}</span>}
            </div>
          </div>
        </div>

        {loadingRec ? (
          <Loading label="Loading evidence" />
        ) : (
          <>
            {evidence.length === 0 ? (
              <p className="text-sm text-amber-800 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">No photos are attached to this delivery.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {evidence.map((ev) => {
                  const badge = geofenceBadge(ev.geofence_result, ev.geofence_distance_m)
                  return (
                    <figure key={ev.evidence_id} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
                      <div className="aspect-[16/9] bg-gray-100 flex items-center justify-center">
                        {ev.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image cannot optimize it
                          <img src={ev.image_url} alt={kindLabel(ev.kind)} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-xs text-gray-400 px-3 text-center">Photo not retained on this environment</span>
                        )}
                      </div>
                      <figcaption className="px-3 py-2.5">
                        <p className="text-sm font-semibold text-gray-900">{kindLabel(ev.kind)}</p>
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                          <span className={cx(pill(badge.tone), 'py-1')}>
                            {ev.geofence_result === 'inside'
                              ? <CircleCheck className="w-3.5 h-3.5" />
                              : <MapPin className="w-3.5 h-3.5" />}
                            {badge.label}
                          </span>
                          <span className="text-xs text-gray-500">{dateTime(ev.captured_at_server)}</span>
                        </div>
                      </figcaption>
                    </figure>
                  )
                })}
              </div>
            )}

            {rec?.discrepancy && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold text-sm">!</span>
                <span className="pt-0.5">
                  Driver reported a {rec.discrepancy.reason.replace(/_/g, ' ')}
                  {rec.discrepancy.delta != null
                    ? <> (<span className="font-bold tabular-nums">{rec.discrepancy.delta}{rec.discrepancy.quantity_unit ? ` ${rec.discrepancy.quantity_unit}` : ''}</span> vs expected)</>
                    : null}.
                </span>
              </div>
            )}

            <div>
              <label htmlFor="pod-note" className={LABEL}>Note (optional — recommended when rejecting)</label>
              <textarea
                id="pod-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="e.g. invoice not clearly signed, retake needed"
                className={TEXTAREA}
              />
            </div>

            {err && <ErrorNote message={err} />}

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                onClick={() => decide('reject')}
                disabled={busy !== null}
                className="h-12 rounded-xl border-2 border-red-300 bg-white text-red-600 hover:bg-red-50 font-bold text-base disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                {busy === 'reject' ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <CircleX className="w-5 h-5" />}
                Reject
              </button>
              <button
                onClick={() => decide('approve')}
                disabled={busy !== null}
                className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-[#fff] font-bold text-base disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                {busy === 'approve' ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                Approve
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
