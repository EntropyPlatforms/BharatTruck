'use client'

/**
 * Persona-completeness rings (D-33). For each persona the user HAS, a ring showing how much
 * of that persona's profile is filled and the items still open. It NEVER gates anything
 * (D-31): every unmet item is a prompt with an "I'll provide later" escape hatch — a signed
 * acknowledgement, which is a stronger legal position than a blank. The server's
 * `gates_nothing: true` is honoured; nothing here blocks a surface or an action.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Circle, Package, IdCard, Truck } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote, IconTile, Loading } from '@/components/stat'
import { useAuth } from '@/lib/auth'
import { ApiError, acknowledgePersona, getMyCompleteness } from '@/lib/api'
import type { CompletenessItem, CompletenessReport, PersonaCompleteness } from '@/lib/types'
import { cx, pill, type PillTone, type Tint } from '@/lib/ui'

const PERSONA_LABEL: Record<PersonaCompleteness['persona'], string> = {
  shipper: 'Shipper', driver: 'Driver', fleet_owner: 'Fleet owner',
}

const PERSONA_ICON: Record<PersonaCompleteness['persona'], { icon: ReactNode; tint: Tint }> = {
  shipper: { icon: <Package />, tint: 'brand' },
  driver: { icon: <IdCard />, tint: 'blue' },
  fleet_owner: { icon: <Truck />, tint: 'green' },
}

const STATUS_STYLE: Record<CompletenessItem['status'], { label: string; tone: PillTone }> = {
  verified: { label: 'Verified', tone: 'green' },
  declared: { label: 'Declared', tone: 'blue' },
  missing: { label: 'Needed', tone: 'slate' },
}

function Ring({ pct }: { pct: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  const dash = (clamped / 100) * c
  const tone = clamped >= 100 ? 'text-emerald-500' : clamped >= 50 ? 'text-blue-600' : 'text-amber-500'
  return (
    <div className="relative w-16 h-16 shrink-0">
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-gray-100" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`} className={tone}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-gray-900 tabular-nums">
        {clamped}%
      </span>
    </div>
  )
}

function AckButton({ kind, busy, onAck }: { kind: string; busy: boolean; onAck: (k: string) => void }) {
  return (
    <button
      onClick={() => onAck(kind)}
      disabled={busy}
      className="shrink-0 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      {busy ? 'Saving…' : "I'll provide later"}
    </button>
  )
}

export default function CompletenessSection() {
  const { personas } = useAuth()
  const [report, setReport] = useState<CompletenessReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ackBusy, setAckBusy] = useState<string | null>(null)

  // Lead with the user's PRIMARY persona (D-32 front door): their main role's ring
  // sits first and wears a badge; the rest follow in the server's order. primary_persona
  // can be 'admin' (matches no completeness persona) — the sort then no-ops and the
  // list stays as the server sent it. A stable sort keeps the non-primary order intact.
  const primary = personas?.primary_persona
  const ordered = useMemo(() => {
    const list = report?.personas ?? []
    return [...list].sort((a, b) => Number(b.persona === primary) - Number(a.persona === primary))
  }, [report, primary])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    getMyCompleteness()
      .then((r) => setReport(r.completeness))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load your profile completeness.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function acknowledge(kind: string) {
    setAckBusy(kind)
    try {
      await acknowledgePersona(kind)
      toast.success('Noted — you can provide the document later')
      load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not record that')
    } finally {
      setAckBusy(null)
    }
  }

  return (
    <Card>
      <CardHead title="Profile completeness" sub="What each of your roles still needs" />
      <div className="p-4 sm:p-5">
        {loading && !report && <Loading label="Loading completeness" />}
        {error && !report && <ErrorNote message={error} />}
        {report && report.personas.length === 0 && (
          <p className="text-sm text-gray-500">Nothing to complete yet.</p>
        )}
        {report && ordered.length > 0 && (
          <div className="space-y-3">
            {ordered.map((p) => {
              const look = PERSONA_ICON[p.persona]
              const done = p.items.filter((i) => i.status !== 'missing').length
              return (
                <div
                  key={p.persona}
                  className="rounded-xl border border-gray-200 p-4 grid grid-cols-[auto_1fr_auto] md:grid-cols-[minmax(0,13rem)_auto_minmax(0,1fr)] gap-x-4 gap-y-3 items-center"
                >
                  <div className="flex items-center gap-3 min-w-0 col-span-2 md:col-span-1">
                    <IconTile icon={look.icon} tint={look.tint} size="lg" />
                    <div className="min-w-0">
                      <p className="text-base font-bold text-gray-900">{PERSONA_LABEL[p.persona]}</p>
                      {p.persona === primary
                        ? <span className={cx(pill('brand'), 'mt-1')}>Primary</span>
                        : <p className="text-xs text-gray-500">{done} of {p.items.length} done</p>}
                    </div>
                  </div>
                  <div className="row-start-1 col-start-3 md:row-auto md:col-auto flex items-center gap-2">
                    <Ring pct={p.percentage} />
                    {p.persona === primary && (
                      <span className="hidden sm:inline text-xs text-gray-500 whitespace-nowrap">{done} of {p.items.length} done</span>
                    )}
                  </div>
                  <ul className="col-span-3 md:col-span-1 space-y-1.5 min-w-0">
                    {p.items.map((item) => {
                      const s = STATUS_STYLE[item.status]
                      const ackKind = item.acknowledgement_kind
                      const met = item.status !== 'missing'
                      return (
                        <li key={`${p.persona}-${item.key}`} className="flex items-center gap-2.5 min-h-[30px]">
                          {met
                            ? <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" aria-hidden />
                            : <Circle className="w-4 h-4 shrink-0 text-gray-300" aria-hidden />}
                          <span className="text-sm text-gray-900 min-w-0 flex-1 sm:truncate">{item.label}</span>
                          <span className={cx(pill(s.tone), 'sm:w-[4.75rem] justify-center')}>{s.label}</span>
                          <span className="sm:w-[6.5rem] text-right shrink-0">
                            {item.status === 'missing' && ackKind && (
                              <AckButton kind={ackKind} busy={ackBusy === ackKind} onAck={acknowledge} />
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}
