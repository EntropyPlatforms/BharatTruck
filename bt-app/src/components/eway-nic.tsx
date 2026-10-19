'use client'

/**
 * E-way bills on NIC's portal, from the app — three pieces:
 *
 *   <EwayPortalCredentialsCard>  Settings: the shipper's e-way bill portal API user. Saved only
 *                                after a real login to the portal; the password is never shown back.
 *   <GenerateEwayBillPanel>      Load → Documents: Part A + Part B from the booking, the LR / invoice
 *                                and a short form; the bill is generated and recorded in one step.
 *   <EwayPortalActions>          On a generated bill: update vehicle (Part B), extend validity,
 *                                cancel on the portal, refresh from the portal, download the PDF.
 *
 * Everything here is the SHIPPER's: bills are raised under their GSTIN with their login.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, RefreshCw, Truck } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote } from '@/components/stat'
import {
  ApiError, cancelEwayBillOnPortal, deleteEwayPortalCredentials, extendEwayBill, generateEwayBill, getEwayBillPdf,
  getEwayGenerateDefaults, getEwayPortalCredentials, getGstinProfile, saveEwayPortalCredentials, syncEwayBill, updateEwayBillVehicle,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { gstinProblem } from '@/lib/gst'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, MONO, SELECT, cx } from '@/lib/ui'
import type { EwayBillRecord, EwayGenerateDefaults, EwayPortalCredentialsView } from '@/lib/types'

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

// ── Settings card ─────────────────────────────────────────────

export function EwayPortalCredentialsCard() {
  const { user } = useAuth()
  const [view, setView] = useState<EwayPortalCredentialsView | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  // The account's GSTIN is the obvious default; the shipper can still type another.
  const [form, setForm] = useState(() => ({ gstin: (user?.gstin ?? '').toUpperCase(), username: '', password: '' }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let cancelled = false
    getEwayPortalCredentials()
      .then((v) => { if (!cancelled) { setView(v); setEditing(!v.configured) } })
      .catch((e) => { if (!cancelled) setUnavailable(errText(e, 'E-way bill portal access is not available on this deployment.')) })
    return () => { cancelled = true }
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const g = form.gstin.trim().toUpperCase()
    const problem = gstinProblem(g)
    if (problem) { setErr(problem); return }
    if (form.username.trim().length < 3 || form.password.length < 4) { setErr('Enter the API username and password you created on the e-way bill portal.'); return }
    setBusy(true)
    setErr(null)
    try {
      const v = await saveEwayPortalCredentials({ gstin: g, username: form.username.trim(), password: form.password })
      setView(v)
      setEditing(false)
      setForm((f) => ({ ...f, password: '' }))
      toast.success('E-way bill portal linked — the login worked')
    } catch (e2) {
      setErr(errText(e2, 'Could not link the portal'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteEwayPortalCredentials()
      setView({ configured: false, gstin: null, username: null, updated_at: null })
      setEditing(true)
      toast.success('Portal login removed')
    } catch (e2) {
      toast.error(errText(e2, 'Could not remove the portal login'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead icon={<KeyRound />} tint="amber" title="E-way bill portal" sub="Generate e-way bills from a load, in your name, instead of copying them from the NIC portal." />
      <div className="p-5 space-y-4">
        {unavailable ? (
          <p className="text-sm text-gray-600">{unavailable}</p>
        ) : view?.configured && !editing ? (
          <div className="space-y-3">
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
              Linked: GSTIN <span className={MONO}>{view.gstin}</span> · API user <span className={MONO}>{view.username}</span>
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(true)} className={BTN_SECONDARY}>Change login</button>
              <button type="button" onClick={remove} disabled={busy} className={BTN_SECONDARY}>Remove</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-gray-600">
              On <span className="font-semibold">ewaybillgst.gov.in</span> → Registration → For GSP → Add/New GSP, choose <span className="font-semibold">Quicko Infosoft Pvt. Ltd.</span> (the company behind Sandbox) and set an API username and password (separate from your portal login). Enter them here.
            </p>
            <p className="text-xs text-gray-500">
              Why not an OTP? The NIC e-way bill system only admits applications through an API user you create once there; it has no one-time-password route. Your GSTIN itself is verified by OTP under Settings → Your GSTIN.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field id="ewb_gstin" label="GSTIN">
                <input id="ewb_gstin" value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15) }))} className={`${INPUT} ${MONO} uppercase`} autoComplete="off" />
              </Field>
              <Field id="ewb_user" label="API username">
                <input id="ewb_user" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} className={INPUT} autoComplete="off" />
              </Field>
              <Field id="ewb_pass" label="API password">
                <input id="ewb_pass" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className={INPUT} autoComplete="new-password" />
              </Field>
            </div>
            {err && <ErrorNote message={err} />}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Checking with the portal…' : 'Link portal'}</button>
              {view?.configured && <button type="button" onClick={() => { setEditing(false); setErr(null) }} className={BTN_SECONDARY}>Cancel</button>}
            </div>
          </form>
        )}
      </div>
    </Card>
  )
}

// ── Generate panel ─────────────────────────────────────────────

const GST_RATES = [0, 5, 12, 18, 28] as const

export function GenerateEwayBillPanel({ bookingId, onDone, onClose }: { bookingId: string; onDone: () => void; onClose: () => void }) {
  const [defaults, setDefaults] = useState<EwayGenerateDefaults | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [f, setF] = useState({
    document_number: '', document_date: new Date().toISOString().slice(0, 10), consignee_name: '', consignee_gstin: '',
    hsn_code: '', product_name: '', taxable_value_inr: '', gst_rate: '5', total_invoice_value_inr: '', distance_km: '',
    vehicle_number: '', transporter_id: '', from_place: '', to_place: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }))

  // The receiver's registered name, from the GST portal, the moment their GSTIN is complete —
  // so the name on the bill is the one on their registration (2026-10-17). Filled once per
  // GSTIN; the shipper can still type over it. Silent when the GST lookup is not switched on.
  const [nameFrom, setNameFrom] = useState<string | null>(null)
  useEffect(() => {
    const cg = f.consignee_gstin.trim().toUpperCase()
    if (cg.length !== 15 || gstinProblem(cg) || nameFrom === cg) return
    let cancelled = false
    getGstinProfile(cg)
      .then((p) => {
        if (cancelled) return
        setNameFrom(cg)
        const registered = p.trade_name ?? p.legal_name
        if (registered) setF((prev) => ({ ...prev, consignee_name: registered.slice(0, 100) }))
      })
      .catch(() => { if (!cancelled) setNameFrom(cg) })
    return () => { cancelled = true }
  }, [f.consignee_gstin, nameFrom])

  useEffect(() => {
    let cancelled = false
    getEwayGenerateDefaults(bookingId)
      .then((d) => {
        if (cancelled) return
        setDefaults(d)
        setF((p) => ({
          ...p,
          document_number: d.document_number ?? p.document_number,
          document_date: d.document_date ?? p.document_date,
          consignee_name: d.consignee_name ?? p.consignee_name,
          consignee_gstin: d.consignee_gstin ?? p.consignee_gstin,
          product_name: d.product_name ?? p.product_name,
          taxable_value_inr: d.taxable_value_inr != null ? String(d.taxable_value_inr) : p.taxable_value_inr,
          total_invoice_value_inr: d.total_invoice_value_inr != null ? String(d.total_invoice_value_inr) : p.total_invoice_value_inr,
          vehicle_number: d.vehicle_number ?? p.vehicle_number,
          transporter_id: d.transporter_id ?? p.transporter_id,
          from_place: d.from_place ?? p.from_place,
          to_place: d.to_place ?? p.to_place,
        }))
      })
      .catch((e) => { if (!cancelled) setLoadErr(errText(e, 'Could not prepare the e-way bill.')) })
    return () => { cancelled = true }
  }, [bookingId])

  // Taxable value and rate decide the tax; the total is taxable + tax until the shipper
  // types their own (other charges, rounding).
  const [totalTouched, setTotalTouched] = useState(false)
  const taxable = Number(f.taxable_value_inr) || 0
  const rate = Number(f.gst_rate) || 0
  const tax = Math.round(taxable * rate) / 100
  const computedTotal = taxable > 0 ? String(Math.round((taxable + tax) * 100) / 100) : ''
  const totalShown = totalTouched ? f.total_invoice_value_inr : (computedTotal || f.total_invoice_value_inr)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cg = f.consignee_gstin.trim().toUpperCase()
    if (cg && gstinProblem(cg)) { setErr(`Consignee GSTIN: ${gstinProblem(cg)}`); return }
    if (!f.vehicle_number.trim() && !f.transporter_id.trim()) { setErr('Give the vehicle number, or the transporter id if the transporter will enter the vehicle.'); return }
    setBusy(true)
    setErr(null)
    try {
      const res = await generateEwayBill(bookingId, {
        document_number: f.document_number.trim(),
        document_date: f.document_date,
        consignee_name: f.consignee_name.trim(),
        consignee_gstin: cg || null,
        hsn_code: f.hsn_code.trim(),
        product_name: f.product_name.trim(),
        taxable_value_inr: taxable,
        gst_rate: rate as 0 | 5 | 12 | 18 | 28,
        total_invoice_value_inr: Number(totalShown),
        distance_km: Number(f.distance_km),
        vehicle_number: f.vehicle_number.trim() || null,
        transporter_id: f.transporter_id.trim().toUpperCase() || null,
        from_place: f.from_place.trim(),
        to_place: f.to_place.trim(),
      })
      toast.success(`E-way bill ${res.record.ewb_number} generated on the portal`)
      if (res.alert) toast.message(res.alert)
      onDone()
    } catch (e2) {
      setErr(errText(e2, 'The portal did not generate the bill'))
    } finally {
      setBusy(false)
    }
  }

  if (loadErr) return <ErrorNote message={loadErr} />
  if (defaults && !defaults.portal_linked) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-700">Link your e-way bill portal API login in Settings first, then come back here to generate.</p>
        <a href="/settings#eway" className={BTN_PRIMARY}>Open Settings</a>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {defaults?.inter_state != null && (
        <p className="text-xs text-gray-500">{defaults.inter_state ? 'Inter-state movement — IGST applies.' : 'Within one state — CGST + SGST apply.'}{defaults.shipper_gstin ? ` Generated under ${defaults.shipper_gstin}.` : ''}</p>
      )}
      <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
        <Field id="g_doc" label="Your invoice number"><input id="g_doc" value={f.document_number} onChange={(e) => set('document_number', e.target.value)} maxLength={16} className={cx(INPUT, MONO, 'h-11')} /></Field>
        <Field id="g_date" label="Invoice date"><input id="g_date" type="date" value={f.document_date} onChange={(e) => set('document_date', e.target.value)} className={cx(INPUT, 'h-11')} /></Field>
      </div>
      <Field id="g_cname" label="Consignee (receiver) name" hint={nameFrom && nameFrom === f.consignee_gstin.trim().toUpperCase() ? 'Filled from the GST registration — edit if the bill should read differently.' : undefined}><input id="g_cname" value={f.consignee_name} onChange={(e) => set('consignee_name', e.target.value)} className={cx(INPUT, 'h-11')} /></Field>
      <Field id="g_cgst" label="Consignee GSTIN" hint="Leave blank for an unregistered receiver."><input id="g_cgst" value={f.consignee_gstin} onChange={(e) => set('consignee_gstin', e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} className={cx(INPUT, MONO, 'h-11 uppercase')} /></Field>
      <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
        <Field id="g_prod" label="Goods"><input id="g_prod" value={f.product_name} onChange={(e) => set('product_name', e.target.value)} className={cx(INPUT, 'h-11')} /></Field>
        <Field id="g_hsn" label="HSN code"><input id="g_hsn" inputMode="numeric" value={f.hsn_code} onChange={(e) => set('hsn_code', e.target.value.replace(/\D/g, '').slice(0, 8))} className={cx(INPUT, MONO, 'h-11')} /></Field>
      </div>
      <div className="grid grid-cols-1 @sm:grid-cols-3 gap-3">
        <Field id="g_taxable" label="Taxable value (₹)"><input id="g_taxable" inputMode="decimal" value={f.taxable_value_inr} onChange={(e) => set('taxable_value_inr', e.target.value.replace(/[^\d.]/g, ''))} className={cx(INPUT, 'h-11 tabular-nums')} /></Field>
        <Field id="g_rate" label="GST rate">
          <select id="g_rate" value={f.gst_rate} onChange={(e) => set('gst_rate', e.target.value)} className={cx(SELECT, 'h-11')}>
            {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </Field>
        <Field id="g_total" label="Invoice total (₹)" hint={tax ? `Tax ₹${tax.toLocaleString('en-IN')}` : undefined}><input id="g_total" inputMode="decimal" value={totalShown} onChange={(e) => { setTotalTouched(true); set('total_invoice_value_inr', e.target.value.replace(/[^\d.]/g, '')) }} className={cx(INPUT, 'h-11 tabular-nums')} /></Field>
      </div>
      <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
        <Field id="g_from" label="From place"><input id="g_from" value={f.from_place} onChange={(e) => set('from_place', e.target.value)} maxLength={50} className={cx(INPUT, 'h-11')} /></Field>
        <Field id="g_to" label="To place"><input id="g_to" value={f.to_place} onChange={(e) => set('to_place', e.target.value)} maxLength={50} className={cx(INPUT, 'h-11')} /></Field>
      </div>
      <div className="grid grid-cols-1 @sm:grid-cols-3 gap-3">
        <Field id="g_km" label="Distance (km)"><input id="g_km" inputMode="numeric" value={f.distance_km} onChange={(e) => set('distance_km', e.target.value.replace(/\D/g, '').slice(0, 4))} className={cx(INPUT, 'h-11 tabular-nums')} /></Field>
        <Field id="g_veh" label="Vehicle number" hint="Part B. Needed before the truck moves."><input id="g_veh" value={f.vehicle_number} onChange={(e) => set('vehicle_number', e.target.value.toUpperCase())} className={cx(INPUT, MONO, 'h-11 uppercase')} placeholder="MH12AB1234" /></Field>
        <Field id="g_trn" label="Transporter id" hint="Only if the transporter will fill the vehicle themselves."><input id="g_trn" value={f.transporter_id} onChange={(e) => set('transporter_id', e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} className={cx(INPUT, MONO, 'h-11 uppercase')} /></Field>
      </div>
      {err && <p className="text-sm font-medium text-red-600">{err}</p>}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <button type="button" onClick={onClose} disabled={busy} className={cx(BTN_SECONDARY, 'h-12')}>Cancel</button>
        <button type="submit" disabled={busy || !defaults} className={cx(BTN_PRIMARY, 'h-12')}>{busy ? 'Generating on the portal…' : 'Generate e-way bill'}</button>
      </div>
    </form>
  )
}

// ── Row actions on a generated bill ────────────────────────────

type Dialog = 'vehicle' | 'extend' | 'cancel' | null

export function EwayPortalActions({ bookingId, ewb, onChanged }: { bookingId: string; ewb: EwayBillRecord; onChanged: () => void }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [v, setV] = useState({ vehicle_number: '', reason_code: '4', remarks: 'Vehicle assigned', from_place: '' })
  const [x, setX] = useState({ remaining_distance_km: '', reason_code: '99', remarks: '', from_place: '', from_pincode: '', vehicle_number: '' })
  const [c, setC] = useState({ reason_code: '2', remarks: '' })
  const [err, setErr] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label)
    setErr(null)
    try {
      await fn()
      if (done) toast.success(done)
      setDialog(null)
      onChanged()
    } catch (e) {
      setErr(errText(e, 'The portal refused the change'))
    } finally {
      setBusy(null)
    }
  }

  async function pdf() {
    setBusy('pdf')
    try {
      const { url } = await getEwayBillPdf(bookingId, ewb.ewb_number)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      toast.error(errText(e, 'Could not get the PDF from the portal'))
    } finally {
      setBusy(null)
    }
  }

  if (ewb.status !== 'active') return null
  const LINK = 'text-sm font-semibold text-blue-700 hover:text-blue-800 disabled:opacity-50'

  return (
    <div className="pt-2 space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button onClick={() => setDialog(dialog === 'vehicle' ? null : 'vehicle')} className={LINK}><Truck className="inline w-3.5 h-3.5 mr-1" />Update vehicle</button>
        <button onClick={() => setDialog(dialog === 'extend' ? null : 'extend')} className={LINK}>Extend validity</button>
        <button onClick={() => setDialog(dialog === 'cancel' ? null : 'cancel')} className={LINK}>Cancel on portal</button>
        <button onClick={() => run('sync', () => syncEwayBill(bookingId, ewb.ewb_number), 'Bill refreshed from the portal')} disabled={busy === 'sync'} className={LINK}><RefreshCw className="inline w-3.5 h-3.5 mr-1" />Refresh</button>
        <button onClick={pdf} disabled={busy === 'pdf'} className={LINK}>PDF</button>
      </div>

      {dialog === 'vehicle' && (
        <form onSubmit={(e) => { e.preventDefault(); run('vehicle', () => updateEwayBillVehicle(bookingId, ewb.ewb_number, { ...v, reason_code: v.reason_code as '1' | '2' | '3' | '4' }), 'Vehicle updated on the e-way bill') }} className="rounded-xl border border-gray-200 p-3 space-y-3">
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
            <Field id={`v_no_${ewb.id}`} label="New vehicle number"><input id={`v_no_${ewb.id}`} value={v.vehicle_number} onChange={(e) => setV((p) => ({ ...p, vehicle_number: e.target.value.toUpperCase() }))} className={cx(INPUT, MONO, 'h-11 uppercase')} placeholder="MH12AB1234" /></Field>
            <Field id={`v_from_${ewb.id}`} label="From place"><input id={`v_from_${ewb.id}`} value={v.from_place} onChange={(e) => setV((p) => ({ ...p, from_place: e.target.value }))} className={cx(INPUT, 'h-11')} /></Field>
            <Field id={`v_rsn_${ewb.id}`} label="Reason">
              <select id={`v_rsn_${ewb.id}`} value={v.reason_code} onChange={(e) => setV((p) => ({ ...p, reason_code: e.target.value }))} className={cx(SELECT, 'h-11')}>
                <option value="4">First time</option><option value="1">Breakdown</option><option value="2">Transhipment</option><option value="3">Others</option>
              </select>
            </Field>
            <Field id={`v_rem_${ewb.id}`} label="Remarks"><input id={`v_rem_${ewb.id}`} value={v.remarks} onChange={(e) => setV((p) => ({ ...p, remarks: e.target.value }))} maxLength={50} className={cx(INPUT, 'h-11')} /></Field>
          </div>
          {err && <p className="text-sm font-medium text-red-600">{err}</p>}
          <button type="submit" disabled={busy === 'vehicle'} className={cx(BTN_PRIMARY, 'h-11')}>{busy === 'vehicle' ? 'Updating…' : 'Update on portal'}</button>
        </form>
      )}

      {dialog === 'extend' && (
        <form onSubmit={(e) => { e.preventDefault(); run('extend', () => extendEwayBill(bookingId, ewb.ewb_number, { remaining_distance_km: Number(x.remaining_distance_km), reason_code: Number(x.reason_code) as 1 | 2 | 3 | 4 | 99, remarks: x.remarks, from_place: x.from_place, from_pincode: x.from_pincode, vehicle_number: x.vehicle_number || null, consignment_status: 'M' }), 'Validity extended on the portal') }} className="rounded-xl border border-gray-200 p-3 space-y-3">
          <p className="text-xs text-gray-500">The portal allows an extension only within 8 hours before or after the bill expires.</p>
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
            <Field id={`x_km_${ewb.id}`} label="Remaining distance (km)"><input id={`x_km_${ewb.id}`} inputMode="numeric" value={x.remaining_distance_km} onChange={(e) => setX((p) => ({ ...p, remaining_distance_km: e.target.value.replace(/\D/g, '').slice(0, 4) }))} className={cx(INPUT, 'h-11')} /></Field>
            <Field id={`x_veh_${ewb.id}`} label="Vehicle number"><input id={`x_veh_${ewb.id}`} value={x.vehicle_number} onChange={(e) => setX((p) => ({ ...p, vehicle_number: e.target.value.toUpperCase() }))} className={cx(INPUT, MONO, 'h-11 uppercase')} /></Field>
            <Field id={`x_place_${ewb.id}`} label="Where the truck is now"><input id={`x_place_${ewb.id}`} value={x.from_place} onChange={(e) => setX((p) => ({ ...p, from_place: e.target.value }))} className={cx(INPUT, 'h-11')} /></Field>
            <Field id={`x_pin_${ewb.id}`} label="PIN code there"><input id={`x_pin_${ewb.id}`} inputMode="numeric" value={x.from_pincode} onChange={(e) => setX((p) => ({ ...p, from_pincode: e.target.value.replace(/\D/g, '').slice(0, 6) }))} className={cx(INPUT, MONO, 'h-11')} /></Field>
            <Field id={`x_rsn_${ewb.id}`} label="Reason">
              <select id={`x_rsn_${ewb.id}`} value={x.reason_code} onChange={(e) => setX((p) => ({ ...p, reason_code: e.target.value }))} className={cx(SELECT, 'h-11')}>
                <option value="1">Natural calamity</option><option value="2">Law and order</option><option value="3">Transhipment</option><option value="4">Accident</option><option value="99">Others</option>
              </select>
            </Field>
            <Field id={`x_rem_${ewb.id}`} label="Remarks"><input id={`x_rem_${ewb.id}`} value={x.remarks} onChange={(e) => setX((p) => ({ ...p, remarks: e.target.value }))} maxLength={50} className={cx(INPUT, 'h-11')} /></Field>
          </div>
          {err && <p className="text-sm font-medium text-red-600">{err}</p>}
          <button type="submit" disabled={busy === 'extend'} className={cx(BTN_PRIMARY, 'h-11')}>{busy === 'extend' ? 'Extending…' : 'Extend on portal'}</button>
        </form>
      )}

      {dialog === 'cancel' && (
        <form onSubmit={(e) => { e.preventDefault(); run('cancel', () => cancelEwayBillOnPortal(bookingId, ewb.ewb_number, { reason_code: Number(c.reason_code) as 1 | 2 | 3 | 4, remarks: c.remarks || undefined }), 'E-way bill cancelled on the portal') }} className="rounded-xl border border-red-200 p-3 space-y-3">
          <p className="text-xs text-gray-500">The portal allows cancellation within 24 hours of generation, by the generator only. This cannot be undone.</p>
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
            <Field id={`c_rsn_${ewb.id}`} label="Reason">
              <select id={`c_rsn_${ewb.id}`} value={c.reason_code} onChange={(e) => setC((p) => ({ ...p, reason_code: e.target.value }))} className={cx(SELECT, 'h-11')}>
                <option value="1">Duplicate</option><option value="2">Order cancelled</option><option value="3">Data entry mistake</option><option value="4">Others</option>
              </select>
            </Field>
            <Field id={`c_rem_${ewb.id}`} label="Remarks"><input id={`c_rem_${ewb.id}`} value={c.remarks} onChange={(e) => setC((p) => ({ ...p, remarks: e.target.value }))} maxLength={100} className={cx(INPUT, 'h-11')} /></Field>
          </div>
          {err && <p className="text-sm font-medium text-red-600">{err}</p>}
          <button type="submit" disabled={busy === 'cancel'} className={cx(BTN_PRIMARY, 'h-11')}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel on portal'}</button>
        </form>
      )}
    </div>
  )
}
