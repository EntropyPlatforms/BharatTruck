'use client'

/**
 * Freight documents — the in-app document surface (Phase 4 of docs/UNIFIED_APP_PLAN.md;
 * migration 0024). Shows the paperwork a real trip generates and lets the carrier raise
 * the consignment note.
 *
 * - READ (GET /bookings/:id/documents): the LR, the shipper's tax invoice, and the
 *   recorded e-way bill(s) with their standing + expiry status. Relation-gated server-side.
 * - ISSUE LR (POST /bookings/:id/documents/lr): the carrier raises the consignment note,
 *   PREFILLED from the booking. The issuer identity is derived server-side (never sent);
 *   the write is idempotent per booking and allowed only while accepted / in_transit.
 *
 * Never blanks: loading / error / empty / content, and a clear message on every failure.
 *
 * Layout (2026-10 redesign) is a container query, because the same component sits on the
 * wide load-detail page AND the 720px driver trip column: documents as tiles, the issue
 * actions as big square thumb tiles at phone width (descriptive tiles when there is room),
 * and an open form in a panel beside them on a wide container (below them otherwise).
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { FileCheck2, FileText, QrCode, ReceiptText, X } from 'lucide-react'

import { Card, CardHead, ErrorNote, IconTile, Loading } from '@/components/stat'
import { ApiError, getBookingDocuments, issueFreightInvoice, issueLorryReceipt, ocrDocument, recordEwayBill, scanDocumentQr, setEwayBillStatus } from '@/lib/api'
import { EwayPortalActions, GenerateEwayBillPanel } from '@/components/eway-nic'
import { inr, dateTime } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, MONO, SELECT, cx, pill, type Tint } from '@/lib/ui'
import type { Booking, BookingDocuments, EwayBillRecord, FreightTerm, IssueInvoiceInput, IssueLorryReceiptInput } from '@/lib/types'

const FREIGHT_TERMS: { value: FreightTerm; label: string }[] = [
  { value: 'TO_PAY', label: 'To pay — receiver pays freight' },
  { value: 'PAID', label: 'Paid — consignor prepaid' },
  { value: 'TO_BE_BILLED', label: 'To be billed later' },
]

function freightTermLabel(t: FreightTerm): string {
  return FREIGHT_TERMS.find((x) => x.value === t)?.label ?? t
}

// datetime-local inputs give 'YYYY-MM-DDTHH:mm' in LOCAL time; the API wants RFC3339 with a
// zone. new Date(local) reads it as local and toISOString() emits the correct UTC 'Z' form.
function toIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function ewayBadges(ewb: EwayBillRecord): { statusCls: string; statusLabel: string; expiryCls: string; expiryLabel: string } {
  const statusMap: Record<EwayBillRecord['status'], { cls: string; label: string }> = {
    active: { cls: pill('green'), label: 'Active' },
    cancelled: { cls: pill('slate'), label: 'Cancelled' },
    rejected: { cls: pill('red'), label: 'Rejected' },
  }
  const exp = ewb.expiry
  const expiry =
    exp.state === 'valid' ? { cls: pill('green'), label: `Valid · ${Math.round(exp.hours_remaining)}h left` }
      : exp.state === 'expiring_soon' ? { cls: pill('amber'), label: `Expiring · ${Math.round(exp.hours_remaining)}h left` }
        : { cls: pill('red'), label: 'Expired' }
  const s = statusMap[ewb.status]
  return { statusCls: s.cls, statusLabel: s.label, expiryCls: expiry.cls, expiryLabel: expiry.label }
}

/** File -> base64 (no data: prefix), for sending an invoice photo to the OCR endpoint. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result)
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

// Decode a QR from a captured image using the browser's native BarcodeDetector (Chrome/Android —
// the driver's device). Returns the raw string, or null when unsupported (iOS Safari) or nothing
// was found, so the caller can fall back to manual entry. No library dependency.
async function decodeQrFromFile(file: File): Promise<string | null> {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o?: { formats?: string[] }) => { detect(src: ImageBitmapSource): Promise<{ rawValue?: string }[]> } }).BarcodeDetector
  if (!BD || typeof createImageBitmap !== 'function') return null
  try {
    const detector = new BD({ formats: ['qr_code'] })
    const bitmap = await createImageBitmap(file)
    const codes = await detector.detect(bitmap)
    return codes?.[0]?.rawValue ?? null
  } catch {
    return null
  }
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

/** One document on file: a tinted icon tile, its kind and number, then the detail lines. */
function DocTile({
  kind, number, tint, icon, children,
}: { kind: string; number: string; tint: Tint; icon: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 min-w-0">
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tint={tint} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{kind}</p>
          <p className={cx(MONO, 'text-[0.9375rem] font-semibold text-blue-600 break-all')}>{number}</p>
        </div>
      </div>
      {children && <div className="mt-3 space-y-0.5 text-[0.8125rem] text-gray-600">{children}</div>}
    </div>
  )
}

/** The panel an issue / record form opens in: title, one-line sub, close, body. */
function FormPanel({
  title, sub, onClose, disabled, children,
}: { title: string; sub: string; onClose: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
        <div>
          <p className="text-base font-bold text-gray-900">{title}</p>
          <p className="text-sm text-gray-500 mt-0.5">{sub}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={disabled}
          aria-label={`Close ${title.toLowerCase()}`}
          className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

/** "341022998812" → "3410 2299 8812": the e-way bill number as it is printed. */
function groupEwb(n: string): string {
  return /^\d{12}$/.test(n) ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : n
}

const SPINNER = 'w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin'
const LINK_BTN =
  'text-[0.8125rem] font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2 disabled:opacity-50 rounded ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600'

export default function FreightDocuments({ booking, onChanged }: { booking: Booking; onChanged?: () => void }) {
  const [docs, setDocs] = useState<BookingDocuments | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  // LR form, prefilled from the booking — the carrier confirms rather than re-types.
  const [consigneeName, setConsigneeName] = useState(booking.consignee?.name ?? '')
  const [saidToContain, setSaidToContain] = useState(booking.load_type ?? '')
  const [weightKg, setWeightKg] = useState(String(booking.weight_kg ?? ''))
  const [freightCharge, setFreightCharge] = useState(String(booking.final_price ?? booking.quoted_price ?? ''))
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [freightTerm, setFreightTerm] = useState<FreightTerm>('TO_PAY')

  // Invoice form (shipper side), prefilled where the booking knows the answer.
  const [showInvoiceForm, setShowInvoiceForm] = useState(false)
  const [invoicing, setInvoicing] = useState(false)
  const [invoiceErr, setInvoiceErr] = useState<string | null>(null)
  const [billedTo, setBilledTo] = useState(booking.consignee?.name ?? '')
  const [taxableValue, setTaxableValue] = useState('')
  const [igst, setIgst] = useState('')

  // E-way bill: record (either party) + file the portal's cancel/reject.
  const [showEwayForm, setShowEwayForm] = useState(false)
  // Generate on NIC's portal (shipper only; the bill is raised under their GSTIN).
  const [showGenerate, setShowGenerate] = useState(false)
  const [recordingEway, setRecordingEway] = useState(false)
  const [ewayErr, setEwayErr] = useState<string | null>(null)
  const [ewbNumber, setEwbNumber] = useState('')
  const [ewbGeneratedAt, setEwbGeneratedAt] = useState('')
  const [ewbValidUpto, setEwbValidUpto] = useState('')
  const [ewbPortal, setEwbPortal] = useState<'NIC1' | 'NIC2'>('NIC1')
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const scanInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    getBookingDocuments(booking.id)
      .then((d) => setDocs(d))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load documents.'))
      .finally(() => setLoading(false))
  }, [booking.id])

  useEffect(() => { load() }, [load])

  // Carrier (or assigned driver) may raise the LR; the server is the real gate, so stay
  // permissive when the relation block is absent. Only while accepted/in_transit, and only
  // if none exists yet (the write is idempotent, but there is no reason to offer a re-issue).
  const rel = booking.viewer?.relations
  const isCarrier = rel === undefined || rel.includes('carrier') || rel.includes('driver')
  const canIssueLr = isCarrier && ['accepted', 'in_transit'].includes(booking.status) && !!docs && !docs.lorry_receipt

  // The invoice is the SHIPPER's document; issuable pending → completed (wider than the LR
  // at both ends — the invoice number can precede a carrier and a TO_BE_BILLED load is
  // invoiced after delivery). Server-authorized; stay permissive when the relation is absent.
  const isShipper = rel === undefined || rel.includes('shipper')
  const canIssueInvoice =
    isShipper &&
    ['pending', 'negotiating', 'accepted', 'in_transit', 'completed'].includes(booking.status) &&
    !!docs && !docs.invoice

  // Either party records the externally-generated e-way bill (D-17). Offered when none
  // currently stands (a cancelled/rejected one leaves the slot open for its replacement).
  const canRecordEway = (isShipper || isCarrier) && !!docs && !docs.standing_eway_bill_number

  async function handleIssue(e: FormEvent) {
    e.preventDefault()
    const weight = Number(weightKg)
    const charge = Number(freightCharge)
    if (!consigneeName.trim()) { setFormErr('Enter the consignee name.'); return }
    if (!saidToContain.trim()) { setFormErr('Enter what the consignment contains.'); return }
    if (!Number.isFinite(weight) || weight <= 0) { setFormErr('Enter the actual weight in kg.'); return }
    if (!Number.isFinite(charge) || charge < 0) { setFormErr('Enter the freight charge.'); return }
    setIssuing(true)
    setFormErr(null)
    try {
      const body: IssueLorryReceiptInput = {
        consignor_name: booking.shipper_name,
        consignee_name: consigneeName.trim(),
        origin_place: booking.source_address,
        destination_place: booking.destination_address,
        actual_weight_kg: weight,
        said_to_contain: saidToContain.trim(),
        freight_charge_inr: charge,
        freight_term: freightTerm,
        ...(vehicleNumber.trim() ? { vehicle_number: vehicleNumber.trim() } : {}),
      }
      await issueLorryReceipt(booking.id, body)
      toast.success('Consignment note issued')
      setShowForm(false)
      load()
      onChanged?.()
    } catch (err) {
      setFormErr(err instanceof ApiError ? err.message : 'Could not issue the consignment note')
    } finally {
      setIssuing(false)
    }
  }

  async function handleIssueInvoice(e: FormEvent) {
    e.preventDefault()
    const taxable = Number(taxableValue)
    const igstNum = igst.trim() ? Number(igst) : undefined
    if (!billedTo.trim()) { setInvoiceErr('Enter who the invoice is billed to.'); return }
    if (!Number.isFinite(taxable) || taxable <= 0) { setInvoiceErr('Enter the taxable value of the goods.'); return }
    if (igstNum !== undefined && (!Number.isFinite(igstNum) || igstNum < 0)) { setInvoiceErr('Enter a valid IGST amount.'); return }
    setInvoicing(true)
    setInvoiceErr(null)
    try {
      const body: IssueInvoiceInput = {
        billed_to_name: billedTo.trim(),
        taxable_value_inr: taxable,
        ...(igstNum !== undefined ? { igst_inr: igstNum } : {}),
      }
      await issueFreightInvoice(booking.id, body)
      toast.success('Tax invoice issued')
      setShowInvoiceForm(false)
      load()
      onChanged?.()
    } catch (err) {
      setInvoiceErr(err instanceof ApiError ? err.message : 'Could not issue the invoice')
    } finally {
      setInvoicing(false)
    }
  }

  async function handleRecordEway(e: FormEvent) {
    e.preventDefault()
    if (!/^\d{12}$/.test(ewbNumber.trim())) { setEwayErr('The e-way bill number is 12 digits.'); return }
    const genIso = toIso(ewbGeneratedAt)
    const validIso = toIso(ewbValidUpto)
    if (!genIso) { setEwayErr('Enter when the bill was generated.'); return }
    if (!validIso) { setEwayErr('Enter the valid-upto date and time.'); return }
    if (new Date(validIso).getTime() <= new Date(genIso).getTime()) { setEwayErr('Valid-upto must be after the generated time.'); return }
    setRecordingEway(true)
    setEwayErr(null)
    try {
      await recordEwayBill(booking.id, {
        ewb_number: ewbNumber.trim(),
        generated_at: genIso,
        valid_upto: validIso,
        issuing_portal: ewbPortal,
      })
      toast.success('E-way bill recorded')
      setShowEwayForm(false)
      setEwbNumber(''); setEwbGeneratedAt(''); setEwbValidUpto('')
      load()
      onChanged?.()
    } catch (err) {
      setEwayErr(err instanceof ApiError ? err.message : 'Could not record the e-way bill')
    } finally {
      setRecordingEway(false)
    }
  }

  // Scan the NIC QR off the physical e-way bill / e-invoice and prefill the form, so the driver
  // stops re-typing the 12-digit number at the gate (§6). The client decodes; the server parses.
  // A human still confirms by saving. Falls back to manual entry when the device can't scan.
  async function onScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same image
    if (!file) return
    setScanning(true)
    setEwayErr(null)
    try {
      const raw = await decodeQrFromFile(file)
      if (!raw) {
        // No QR on the document — fall back to OCR of the invoice photo (handwritten / printed
        // bills with no scannable code). A human still confirms the prefilled values before
        // issuing; OCR only fills the form. Inert deployments answer 501 (caught below).
        const res = await ocrDocument(booking.id, await fileToBase64(file), file.type || undefined)
        const f = res.fields
        const readAnything = !!(f.doc_no || f.seller_gstin || f.buyer_gstin || f.eway_bill_no || f.freight_inr != null || f.taxable_value != null || f.total_value != null)
        if (!readAnything) {
          toast.error('Could not read invoice details from that photo — enter them by hand.')
          return
        }
        // An e-way bill number on the paper (a transporter's LR prints the shipper's) goes
        // straight into the e-way bill form; the dates still come from the NIC bill.
        if (f.eway_bill_no && canRecordEway) {
          setEwbNumber(f.eway_bill_no)
          if (!showEwayForm) setShowEwayForm(true)
        }
        if (f.buyer_name) setBilledTo(f.buyer_name)
        if (f.doc_type === 'consignment_note') {
          // A consignment note is the TRANSPORTER's paper: its freight line is what a freight
          // invoice bills, not the invoice value of the goods inside.
          if (f.freight_inr != null) setTaxableValue(String(Math.round(f.freight_inr)))
        } else if (f.taxable_value != null) {
          setTaxableValue(String(Math.round(f.taxable_value)))
        }
        const igstRead = f.igst ?? (f.cgst == null && f.sgst == null ? f.total_tax : undefined)
        if (igstRead != null) setIgst(String(Math.round(igstRead)))
        if (!showInvoiceForm) setShowInvoiceForm(true)
        const what = f.doc_type === 'consignment_note' ? 'Consignment note read' : f.doc_type === 'receipt' ? 'Bill read' : 'Invoice read'
        const extras = [f.doc_no ? `invoice ${f.doc_no}` : null, f.eway_bill_no ? `e-way bill ${f.eway_bill_no}` : null].filter(Boolean).join(', ')
        toast.success(`${what}${extras ? ` (${extras})` : ''} — check the values, then issue the invoice.`)
        return
      }
      const res = await scanDocumentQr(booking.id, raw)
      if (res.kind === 'eway_qr' && res.fields.ewb_number) {
        setEwbNumber(res.fields.ewb_number)
        if (!showEwayForm) setShowEwayForm(true)
        toast.success('E-way bill number scanned — check the dates, then Record.')
      } else if (res.kind === 'einvoice_qr') {
        toast.success(`Invoice QR read${res.fields.doc_no ? ` (${res.fields.doc_no})` : ''} — this is a tax invoice, not an e-way bill.`)
      } else {
        toast.error('That QR was not an e-way bill or e-invoice — enter the number by hand.')
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Scan failed — enter the number by hand.')
    } finally {
      setScanning(false)
    }
  }

  async function handleSetEwayStatus(ewb: string, status: 'cancelled' | 'rejected') {
    setStatusBusy(ewb)
    try {
      await setEwayBillStatus(booking.id, ewb, { status })
      toast.success(`E-way bill marked ${status}`)
      load()
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the e-way bill')
    } finally {
      setStatusBusy(null)
    }
  }

  const isEmpty = docs && !docs.lorry_receipt && !docs.invoice && docs.eway_bills.length === 0

  // What can be added, as one list: square thumb tiles at phone width, descriptive tiles
  // with their own button when there is room. Each opens the same form as before.
  type AddAction = { key: string; label: string; desc: string; icon: ReactNode; tint: Tint; cta: string; onClick: () => void }
  const addActions: AddAction[] = []
  if (canIssueLr && !showForm) addActions.push({
    key: 'lr', label: 'Issue consignment note (LR)', desc: 'Create an LR with load and consignee details.',
    icon: <FileText />, tint: 'red', cta: 'Issue consignment note', onClick: () => setShowForm(true),
  })
  if (canIssueInvoice && !showInvoiceForm) addActions.push({
    key: 'invoice', label: 'Issue tax invoice', desc: 'Generate a GST invoice for this load.',
    icon: <ReceiptText />, tint: 'blue', cta: 'Issue tax invoice', onClick: () => setShowInvoiceForm(true),
  })
  if (isShipper && canRecordEway && !showGenerate) addActions.push({
    key: 'generate', label: 'Generate e-way bill on the portal', desc: 'Part A and Part B from this load, generated on NIC in your name.',
    icon: <FileCheck2 />, tint: 'green', cta: 'Generate e-way bill', onClick: () => setShowGenerate(true),
  })
  if (canRecordEway && !showEwayForm) addActions.push({
    key: 'eway', label: 'Record an e-way bill', desc: 'Record a bill already generated on the NIC portal.',
    icon: <FileCheck2 />, tint: 'green', cta: 'Record e-way bill', onClick: () => setShowEwayForm(true),
  })
  const thumbs: AddAction[] = [...addActions]
  if (canRecordEway && !showEwayForm) thumbs.push({
    key: 'scan', label: scanning ? 'Scanning…' : 'Scan e-way bill QR', desc: '', icon: <QrCode />, tint: 'violet', cta: '',
    onClick: () => {}, // wired in JSX below (it opens the camera input)
  })

  const lrOpen = canIssueLr && showForm
  const invoiceOpen = canIssueInvoice && showInvoiceForm
  const ewayOpen = canRecordEway && showEwayForm
  const generateOpen = isShipper && canRecordEway && showGenerate
  const anyOpen = lrOpen || invoiceOpen || ewayOpen || generateOpen

  return (
    <div className="@container">
      {canRecordEway && <input ref={scanInputRef} type="file" accept="image/*" capture="environment" onChange={onScanFile} className="hidden" />}
      <div className={cx('grid gap-5 items-start', anyOpen && '@5xl:grid-cols-[minmax(0,1fr)_380px]')}>
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHead title="Freight documents" sub="Consignment note, invoice & e-way bill on file." />
            <div className="p-4 @md:p-5">
              {loading && !docs && <Loading label="Loading documents" />}
              {error && !docs && <ErrorNote message={error} />}

              {docs && (
                <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                  {docs.lorry_receipt && (
                    <DocTile kind="Consignment note" number={docs.lorry_receipt.lr_number} tint="red" icon={<FileText />}>
                      <p>To {docs.lorry_receipt.consignee_name}</p>
                      <p className="pt-1 text-base font-bold text-gray-900 tabular-nums">{inr(docs.lorry_receipt.total_charge_inr)}</p>
                      <p>{freightTermLabel(docs.lorry_receipt.freight_term)}</p>
                      <p className="text-gray-500">Issued {dateTime(docs.lorry_receipt.issued_at)}</p>
                    </DocTile>
                  )}

                  {docs.invoice && (
                    <DocTile kind="Tax invoice" number={docs.invoice.invoice_number} tint="blue" icon={<ReceiptText />}>
                      <p>Billed to {docs.invoice.billed_to_name}</p>
                      <p className="pt-1 text-base font-bold text-gray-900 tabular-nums">{inr(docs.invoice.grand_total_inr)} total</p>
                      <p className="text-gray-500">Issued {dateTime(docs.invoice.issued_at)}</p>
                    </DocTile>
                  )}

                  {docs.eway_bills.map((ewb) => {
                    const b = ewayBadges(ewb)
                    const standing = ewb.ewb_number === docs.standing_eway_bill_number
                    return (
                      <DocTile key={ewb.id} kind="E-way bill" number={groupEwb(ewb.ewb_number)} tint="green" icon={<FileCheck2 />}>
                        <div className="flex flex-wrap gap-1.5 pb-1.5">
                          <span className={b.statusCls}>{b.statusLabel}</span>
                          <span className={b.expiryCls}>{b.expiryLabel}</span>
                        </div>
                        <p className="text-gray-500">
                          {ewb.issuing_portal} · generated {dateTime(ewb.generated_at)}{standing ? ' · currently standing' : ''}
                        </p>
                        {/* A cancel/reject is a filed act with a timestamp (and, since 0032, an
                            actor on the record) — show when it happened and the stated reason,
                            so a dead number on a printed LR can be explained from this card. */}
                        {ewb.status !== 'active' && ewb.status_changed_at && (
                          <p className="text-gray-500">
                            {ewb.status === 'cancelled' ? 'Cancelled' : 'Rejected'} {dateTime(ewb.status_changed_at)}
                            {ewb.status_reason ? ` — ${ewb.status_reason}` : ''}
                          </p>
                        )}
                        {ewb.status === 'active' && isShipper && ewb.issuing_portal === 'NIC1' && (
                          <EwayPortalActions bookingId={booking.id} ewb={ewb} onChanged={load} />
                        )}
                        {ewb.status === 'active' && (isShipper || isCarrier) && (
                          <div className="flex gap-4 pt-2">
                            <button
                              onClick={() => handleSetEwayStatus(ewb.ewb_number, 'cancelled')}
                              disabled={statusBusy === ewb.ewb_number}
                              className={LINK_BTN}
                            >
                              Mark cancelled
                            </button>
                            <button
                              onClick={() => handleSetEwayStatus(ewb.ewb_number, 'rejected')}
                              disabled={statusBusy === ewb.ewb_number}
                              className={LINK_BTN}
                            >
                              Mark rejected
                            </button>
                          </div>
                        )}
                      </DocTile>
                    )
                  })}

                  {isEmpty && (
                    <div className="@xl:col-span-2 @4xl:col-span-3 rounded-xl border border-dashed border-gray-300 p-6 text-center">
                      <p className="text-sm font-semibold text-gray-700">No documents on file yet</p>
                      <p className="text-xs text-gray-500 mt-1">They appear here once issued.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {addActions.length + thumbs.length > 0 && (
            <Card>
              <CardHead title="Add missing documents" sub="Generate the required documents to complete this trip." />
              <div className="p-4 @md:p-5">
                {/* Phone width: big square thumb tiles. */}
                <div className={cx('grid gap-2.5 @xl:hidden', thumbs.length % 3 === 0 ? 'grid-cols-3' : 'grid-cols-2')}>
                  {thumbs.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      onClick={a.key === 'scan' ? () => scanInputRef.current?.click() : a.onClick}
                      disabled={a.key === 'scan' && scanning}
                      className="min-h-[108px] rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-2 py-3 flex flex-col items-center justify-center gap-2 text-center text-[0.8125rem] font-semibold text-gray-800 leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
                    >
                      <IconTile icon={a.icon} tint={a.tint} />
                      {a.label}
                    </button>
                  ))}
                </div>

                {/* Wider: descriptive tiles with their own button. */}
                <div className="hidden @xl:grid gap-3 grid-cols-3">
                  {addActions.map((a) => (
                    <div key={a.key} className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4 flex flex-col min-w-0">
                      <div className="flex items-start gap-3 flex-1">
                        <IconTile icon={a.icon} tint={a.tint} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900">{a.label}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{a.desc}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={a.onClick} className={cx(BTN_PRIMARY, 'flex-1 text-[0.8125rem] px-3 whitespace-nowrap')}>
                          {a.cta}
                        </button>
                        {a.key === 'eway' && (
                          <button type="button" onClick={() => scanInputRef.current?.click()} disabled={scanning} className={cx(BTN_SECONDARY, 'text-[0.8125rem] px-3 whitespace-nowrap')}>
                            <QrCode className="w-4 h-4" /> {scanning ? 'Scanning…' : 'Scan QR'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>

        {anyOpen && (
          <div className="min-w-0 space-y-5 @5xl:sticky @5xl:top-6">
            {lrOpen && (
              <FormPanel title="Issue consignment note" sub="Raises a numbered LR — cannot be undone." onClose={() => { setShowForm(false); setFormErr(null) }} disabled={issuing}>
                <form onSubmit={handleIssue} className="space-y-4">
                  <Field label="Consignee">
                    <input value={consigneeName} onChange={(e) => { setConsigneeName(e.target.value); setFormErr(null) }} className={cx(INPUT, 'h-11')} />
                  </Field>
                  <Field label="Said to contain">
                    <input value={saidToContain} onChange={(e) => { setSaidToContain(e.target.value); setFormErr(null) }} className={cx(INPUT, 'h-11')} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Actual weight (kg)">
                      <input inputMode="decimal" value={weightKg} onChange={(e) => { setWeightKg(e.target.value.replace(/[^\d.]/g, '')); setFormErr(null) }} className={cx(INPUT, 'h-11 tabular-nums')} />
                    </Field>
                    <Field label="Freight charge (₹)">
                      <input inputMode="decimal" value={freightCharge} onChange={(e) => { setFreightCharge(e.target.value.replace(/[^\d.]/g, '')); setFormErr(null) }} className={cx(INPUT, 'h-11 tabular-nums')} />
                    </Field>
                  </div>
                  <Field label="Vehicle no. (optional)">
                    <input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())} placeholder="MH12AB1234" className={cx(INPUT, MONO, 'h-11')} />
                  </Field>
                  <Field label="Freight term">
                    <select value={freightTerm} onChange={(e) => setFreightTerm(e.target.value as FreightTerm)} className={cx(SELECT, 'h-11')}>
                      {FREIGHT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </Field>
                  {formErr && <p className="text-sm font-medium text-red-600">{formErr}</p>}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <button type="button" onClick={() => { setShowForm(false); setFormErr(null) }} disabled={issuing} className={cx(BTN_SECONDARY, 'h-12')}>Cancel</button>
                    <button type="submit" disabled={issuing} className={cx(BTN_PRIMARY, 'h-12')}>
                      {issuing && <span className={SPINNER} />}
                      {issuing ? 'Issuing…' : 'Issue LR'}
                    </button>
                  </div>
                </form>
              </FormPanel>
            )}

            {invoiceOpen && (
              <FormPanel title="Issue tax invoice" sub="Raises a numbered invoice — cannot be undone." onClose={() => { setShowInvoiceForm(false); setInvoiceErr(null) }} disabled={invoicing}>
                <form onSubmit={handleIssueInvoice} className="space-y-4">
                  <Field label="Billed to">
                    <input value={billedTo} onChange={(e) => { setBilledTo(e.target.value); setInvoiceErr(null) }} className={cx(INPUT, 'h-11')} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Taxable value (₹)">
                      <input inputMode="decimal" value={taxableValue} onChange={(e) => { setTaxableValue(e.target.value.replace(/[^\d.]/g, '')); setInvoiceErr(null) }} className={cx(INPUT, 'h-11 tabular-nums')} />
                    </Field>
                    <Field label="IGST (₹, optional)">
                      <input inputMode="decimal" value={igst} onChange={(e) => { setIgst(e.target.value.replace(/[^\d.]/g, '')); setInvoiceErr(null) }} className={cx(INPUT, 'h-11 tabular-nums')} />
                    </Field>
                  </div>
                  {invoiceErr && <p className="text-sm font-medium text-red-600">{invoiceErr}</p>}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <button type="button" onClick={() => { setShowInvoiceForm(false); setInvoiceErr(null) }} disabled={invoicing} className={cx(BTN_SECONDARY, 'h-12')}>Cancel</button>
                    <button type="submit" disabled={invoicing} className={cx(BTN_PRIMARY, 'h-12')}>
                      {invoicing && <span className={SPINNER} />}
                      {invoicing ? 'Issuing…' : 'Issue invoice'}
                    </button>
                  </div>
                </form>
              </FormPanel>
            )}

            {generateOpen && (
              <FormPanel title="Generate e-way bill" sub="Generated on NIC's portal under your GSTIN and recorded here." onClose={() => setShowGenerate(false)} disabled={false}>
                <GenerateEwayBillPanel bookingId={booking.id} onDone={() => { setShowGenerate(false); load() }} onClose={() => setShowGenerate(false)} />
              </FormPanel>
            )}

            {ewayOpen && (
              <FormPanel title="Record e-way bill" sub="Records a bill already generated on the NIC portal." onClose={() => { setShowEwayForm(false); setEwayErr(null) }} disabled={recordingEway}>
                <form onSubmit={handleRecordEway} className="space-y-4">
                  <button type="button" onClick={() => scanInputRef.current?.click()} disabled={scanning} className={cx(BTN_SECONDARY, 'w-full h-11')}>
                    <QrCode className="w-4 h-4" /> {scanning ? 'Scanning…' : 'Scan QR'}
                  </button>
                  <Field label="E-way bill number (12 digits)">
                    <input inputMode="numeric" value={ewbNumber} onChange={(e) => { setEwbNumber(e.target.value.replace(/\D/g, '').slice(0, 12)); setEwayErr(null) }} placeholder="123456789012" className={cx(INPUT, MONO, 'h-11')} />
                  </Field>
                  <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
                    <Field label="Generated at">
                      <input type="datetime-local" value={ewbGeneratedAt} onChange={(e) => { setEwbGeneratedAt(e.target.value); setEwayErr(null) }} className={cx(INPUT, 'h-11')} />
                    </Field>
                    <Field label="Valid upto">
                      <input type="datetime-local" value={ewbValidUpto} onChange={(e) => { setEwbValidUpto(e.target.value); setEwayErr(null) }} className={cx(INPUT, 'h-11')} />
                    </Field>
                  </div>
                  <Field label="Portal">
                    <select value={ewbPortal} onChange={(e) => setEwbPortal(e.target.value as 'NIC1' | 'NIC2')} className={cx(SELECT, 'h-11')}>
                      <option value="NIC1">NIC1</option>
                      <option value="NIC2">NIC2</option>
                    </select>
                  </Field>
                  {ewayErr && <p className="text-sm font-medium text-red-600">{ewayErr}</p>}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <button type="button" onClick={() => { setShowEwayForm(false); setEwayErr(null) }} disabled={recordingEway} className={cx(BTN_SECONDARY, 'h-12')}>Cancel</button>
                    <button type="submit" disabled={recordingEway} className={cx(BTN_PRIMARY, 'h-12')}>
                      {recordingEway && <span className={SPINNER} />}
                      {recordingEway ? 'Recording…' : 'Record'}
                    </button>
                  </div>
                </form>
              </FormPanel>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
