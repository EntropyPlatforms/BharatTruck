// -----------------------------------------------------------
// bahi/posting — pure: a paid booking → what to post into each side's Bahi books.
//
// The carrier (fleet owner, or the solo driver) books freight INCOME: a sales invoice to the
// shipper. The shipper books a freight EXPENSE: a purchase invoice from the carrier. Both carry
// the settlement that paid it. The paid amount is treated as GST-INCLUSIVE at the account's
// own rate (0% by default — whether freight carries 5% or 12% GST, or none under reverse
// charge, is each business's own registration question), so the books never show more
// than the shipper actually paid.
// -----------------------------------------------------------

export type BahiParty = { userId: string; name: string; gstin: string | null; email: string | null; phone: string | null }

export type BahiFreightBody = {
  external_id: string
  kind: 'income' | 'expense'
  date: string
  counterparty: { name: string; gstin: string | null; email: string | null; phone: string | null }
  description: string
  amount: number
  gst_rate: number
  payment: { amount: number; date: string; reference: string | null; mode: 'BANK_TRANSFER' | 'UPI' | 'CASH' | 'CHEQUE' | 'CARD' }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Taxable value and the grand total Bahi will compute (it rounds tax per line to the paisa). */
export function splitInclusive(paid: number, gstRate: number): { taxable: number; total: number } {
  if (gstRate <= 0) return { taxable: round2(paid), total: round2(paid) }
  const taxable = round2(paid / (1 + gstRate / 100))
  const total = round2(taxable + round2((taxable * gstRate) / 100))
  return { taxable, total }
}

/** Settlement method → a Bahi payment mode. */
export function paymentMode(method: string | null | undefined): BahiFreightBody['payment']['mode'] {
  const m = (method ?? '').toLowerCase()
  if (m.includes('cash')) return 'CASH'
  if (m.includes('upi')) return 'UPI'
  if (m.includes('cheque') || m.includes('check')) return 'CHEQUE'
  if (m.includes('card')) return 'CARD'
  return 'BANK_TRANSFER'
}

/** "Pune, Maharashtra 411001, India" → "Pune". */
export function placeShort(address: string | null | undefined): string {
  const first = String(address ?? '').split(',')[0]?.trim() ?? ''
  return first.slice(0, 40) || '—'
}

/** IST calendar date, YYYY-MM-DD. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

export function buildFreightBody(args: {
  kind: 'income' | 'expense'
  bookingId: string
  source: string | null
  destination: string | null
  weightKg: number | null
  counterparty: BahiParty
  paid: number
  gstRate: number
  method: string | null
  paymentId: string | null
  at?: Date
}): BahiFreightBody {
  const { taxable, total } = splitInclusive(args.paid, args.gstRate)
  const date = istDate(args.at)
  const weight = args.weightKg ? `, ${Math.round(args.weightKg).toLocaleString('en-IN')} kg` : ''
  return {
    external_id: args.bookingId,
    kind: args.kind,
    date,
    counterparty: {
      name: args.counterparty.name,
      gstin: args.counterparty.gstin,
      email: args.counterparty.email,
      phone: args.counterparty.phone,
    },
    description: `Freight ${placeShort(args.source)} → ${placeShort(args.destination)}${weight} · BharatTruck load ${args.bookingId.slice(0, 8)}`,
    amount: taxable,
    gst_rate: args.gstRate,
    payment: { amount: total, date, reference: args.paymentId, mode: paymentMode(args.method) },
  }
}
