// ============================================================
// src/lib/documents/rules.ts
//
// Responsibility: the compliance ARITHMETIC and FORMAT rules behind the freight
// documents — nothing here touches Postgres, Fastify or an actor. Every rule in
// this file is a restatement of a specific provision, and each one exists
// because getting it wrong is a detention, a rejected document or a tax event
// rather than a bug report. Citations are to docs/INDIA_FREIGHT_COMPLIANCE.md.
//
// WHAT IS DELIBERATELY NOT HERE:
//   - Number ALLOCATION *or FORMATTING*. The gapless per-owner counter lives in
//     migration 0024 (allocate_document_number) because it has to share a
//     transaction with the INSERT of the document, and supabase-js has no
//     transactions at all. A read-then-write in Node would hand two concurrent
//     bookings the same LR number. Since the DB is the only thing that ever
//     assembles a number, a TypeScript formatter would be a second implementation
//     of a frozen format with no caller — so there isn't one. What this file owns
//     is the BUDGET (how many numbers a series shape can hold) and the CHECK.
//   - Any recomputation of an e-way bill's validity. See ewayBillExpiry.
//   - The intra-state threshold table (§4.2). It is effective-dated, per-state
//     and partly contested; a constant would be a wrong answer with a confident
//     face. Only the inter-state figure — which no state may vary — is here, and
//     ewayBillRequirement refuses to answer where that table would be needed.
//
// EVERY EXPORT BELOW HAS A PRODUCTION CALLER. That is a rule, not an observation:
// a helper whose only caller is its own test inflates the check count while
// exercising nothing that ships.
// ============================================================

// -----------------------------------------------------------
// Enums shared with the DB (migration 0024). Kept as string unions rather than
// TS enums so the wire value IS the value — these are printed on a document.
// -----------------------------------------------------------

/**
 * §5.8. "To Pay" is not a note on an invoice, it is the informal sector's
 * built-in escrow: the consignee pays before the goods are released and the
 * carrier's Contract Act s.170 lien is the leverage. A POD flow that marks
 * delivered-and-released without recording payment removes the only leverage a
 * small operator has, which is why this is an enum on the document.
 */
export type FreightTerm = 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'

/** GODOWN = consignee collects from the destination branch; DOOR = we deliver. */
export type DeliveryMode = 'GODOWN' | 'DOOR'

/** §4.8. Portal affinity: a bill raised on NIC1 cannot be cancelled on NIC2. */
export type EwbPortal = 'NIC1' | 'NIC2'

/**
 * Whether a recorded e-way bill still stands. Mirrors public.ewb_status.
 *
 * §4.5: a bill may be cancelled within 24 hours of generation, and rejected (or
 * deemed accepted) within 72. Several rows per booking is the design — a
 * cancelled-and-regenerated bill and a D-16 multi-truck movement both produce
 * them — but without this column a dead bill and a live one are the same row
 * shape, and "which e-way bill was live when the vehicle was stopped" (the
 * question the table exists to answer) has no answer at all.
 *
 * 🔴 'expired' is deliberately NOT a value here. Expiry is a FUNCTION of the
 * stored valid_upto and the current time (see ewayBillExpiry) — writing it into
 * a column means a row that was correct when written and lies from the next
 * midnight onwards. Status is what a PERSON did to the bill; expiry is what the
 * clock did to it.
 */
export type EwbStatus = 'active' | 'cancelled' | 'rejected'

/** A bill that still covers the movement. Expiry is a separate, derived question. */
export function isStandingEwayBill(status: EwbStatus): boolean {
  return status === 'active'
}

/** Who owns a document series. Mirrors public.document_issuer_kind. */
export type DocumentIssuerKind = 'fleet_owner' | 'driver' | 'shipper'

// -----------------------------------------------------------
// Document numbers — CGST Rule 46(b).
//
// ≤16 characters, alphanumerics + hyphen + slash ONLY, consecutive, unique per
// owner per financial year. §3.3 calls out putting a uuid or a 20-char slug in
// this field as a common bug in logistics SaaS; the specimens in §11.1 show what
// real operators actually print ('2026-27/11', 'MA/4135/2526').
//
// The same regex is a CHECK constraint on every number column in 0024. Two
// copies on purpose: this one gives the user a 400 with a sentence they can act
// on, the DB one guarantees no other code path can ever get past it.
// -----------------------------------------------------------

export const MAX_GST_DOCUMENT_NUMBER_LENGTH = 16

export const GST_DOCUMENT_NUMBER_PATTERN = /^[A-Za-z0-9/-]{1,16}$/

export function isGstDocumentNumber(value: string): boolean {
  return GST_DOCUMENT_NUMBER_PATTERN.test(value)
}

// -----------------------------------------------------------
// THE SERIAL BUDGET — 🔴 the thing a prefix silently spends.
//
// The DB assembles `[PREFIX/]<FY>/<serial>`, and the FY label is 7 characters
// ('2026-27'). Rule 46(b) caps the whole string at 16, so every character of
// prefix costs a DIGIT OF SERIAL:
//
//     prefix len 4  ->  'ABCD/2026-27/999'        16 chars  ->      999 / year
//     prefix len 3  ->  'ABC/2026-27/9999'        16 chars  ->    9,999 / year
//     prefix len 2  ->  'AB/2026-27/99999'        16 chars  ->   99,999 / year
//     no prefix     ->  '2026-27/99999999'        16 chars  -> 99,999,999 / year
//
// WHY THIS IS A HARD CAP AND NOT A WARNING. Running out is UNRECOVERABLE inside
// the financial year. The series cannot be renumbered (Rule 46(b): never
// renumbered after issue), the prefix cannot be edited because the format of a
// series in flight is frozen at its first document, and there is no product path
// to either. The allocator's overflow check would then abort every issue for the
// rest of the year — the counter can neither advance past the bad number nor go
// back, so the owner is simply locked out until 1 April.
//
// A 4-character prefix buys 999 documents. A fleet issuing 1,000 consignment
// notes in a year is an ordinary fleet, not an exotic one, so a 4-character
// prefix is a wedge with a date on it. The budget — not the prefix length — is
// therefore the rule: a series must be able to hold a year of real operation,
// and MAX_SERIES_PREFIX_LENGTH falls out of that rather than being chosen.
//
// 99,999 is 274 documents a day, every day, for one owner. Beyond that the
// honest answer is a second series (Rule 46(b) permits "one or multiple"), which
// is a product decision, not something to discover as a 500 in March.
// -----------------------------------------------------------

/** Length of the FY label printed inside every number, e.g. '2026-27'. */
export const FINANCIAL_YEAR_LABEL_LENGTH = 7

/** The floor a series must clear for one owner for one financial year. */
export const MIN_SERIALS_PER_FINANCIAL_YEAR = 99_999

/**
 * How many documents a series with this prefix can issue in one financial year,
 * i.e. the largest serial that still assembles to a legal Rule 46(b) number.
 * `null` prefix is the unprefixed series.
 */
export function serialBudgetForPrefix(prefix?: string | null): number {
  // '<FY>/' always; '<PREFIX>/' as well when there is one.
  const fixed = FINANCIAL_YEAR_LABEL_LENGTH + 1 + (prefix ? prefix.length + 1 : 0)
  const digits = MAX_GST_DOCUMENT_NUMBER_LENGTH - fixed
  if (digits < 1) return 0
  return 10 ** digits - 1
}

/**
 * The longest prefix whose budget still clears MIN_SERIALS_PER_FINANCIAL_YEAR.
 * Derived, so changing the floor or the FY label moves the cap with it instead
 * of leaving a stale literal that no longer means what it says.
 */
export const MAX_SERIES_PREFIX_LENGTH: number = (() => {
  for (let len = MAX_GST_DOCUMENT_NUMBER_LENGTH; len >= 1; len--) {
    if (serialBudgetForPrefix('x'.repeat(len)) >= MIN_SERIALS_PER_FINANCIAL_YEAR) return len
  }
  return 0
})()

/**
 * Series prefix rules: the Rule 46(b) charset MINUS the slash (the DB supplies
 * the separator), and no longer than the budget above allows.
 *
 * Built from MAX_SERIES_PREFIX_LENGTH rather than written as a literal, so the
 * validation a caller hits and the arithmetic that justifies it cannot disagree.
 */
export const SERIES_PREFIX_PATTERN = new RegExp(`^[A-Za-z0-9-]{1,${MAX_SERIES_PREFIX_LENGTH}}$`)

// -----------------------------------------------------------
// Weight — §11.2, the thing a statute-only reading misses.
//
// Freight bills on the CHARGED weight, which is max(actual, volumetric). Light
// bulky cargo is the normal case, not the exception, so a schema (or a
// calculation) carrying one weight cannot reproduce a real freight bill. The
// actual weight is separately load-bearing: Carriage by Road Act s.9 makes the
// weight on the goods receipt PRIMA FACIE EVIDENCE in a shortage claim.
// -----------------------------------------------------------

export function chargedWeightKg(actualKg: number, volumetricKg?: number | null): number {
  if (!(actualKg > 0)) throw new Error('actual weight must be positive')
  if (volumetricKg == null) return actualKg
  if (!(volumetricKg > 0)) throw new Error('volumetric weight must be positive when supplied')
  return Math.max(actualKg, volumetricKg)
}

// -----------------------------------------------------------
// Charges — §11.2. Freight + stationary + hamali/handling summing to a total,
// never one lump figure. The consignee disputes hamali far more often than
// freight, and a single number makes that dispute unanswerable.
//
// The DB stores total_charge_inr as a GENERATED column over the same four
// fields, so this function and the stored total cannot drift; it exists so the
// caller can show the total before the row is written.
// -----------------------------------------------------------

export type LrCharges = {
  freightInr: number
  stationaryInr?: number
  handlingInr?: number
  otherInr?: number
}

export function lrChargeTotalInr(charges: LrCharges): number {
  const parts = [
    charges.freightInr,
    charges.stationaryInr ?? 0,
    charges.handlingInr ?? 0,
    charges.otherInr ?? 0,
  ]
  for (const p of parts) {
    if (!Number.isFinite(p) || p < 0) throw new Error('charge lines must be finite and non-negative')
  }
  return roundInr(parts.reduce((a, b) => a + b, 0))
}

// -----------------------------------------------------------
// Consignment value — Rule 138 Explanation 2, §4.1.
//
//     consignment_value = section 15 value
//                       + CGST + SGST + UTGST + IGST + cess   <- INCLUDED
//                       - exempt component                    <- mixed invoice only
//
// 🔴 THE VALUE INCLUDES GST. ₹48,000 + 5% = ₹50,400, which is over the ₹50,000
// line and needs an e-way bill; thresholding on the ₹48,000 taxable value says
// it does not, and the truck moves without one. That is a s.129 detention, which
// is 100%/200% of tax territory, not a ₹1,000 penalty.
//
// The exempt component is subtracted ONLY where one invoice covers exempt and
// taxable goods together — hence a defaulted, explicitly named input rather than
// a general "deductions" bag someone would reach for.
// -----------------------------------------------------------

export type ConsignmentValueInput = {
  taxableValueInr: number
  cgstInr?: number
  sgstInr?: number
  utgstInr?: number
  igstInr?: number
  cessInr?: number
  /** Only on a mixed exempt+taxable invoice. Zero everywhere else. */
  exemptValueInr?: number
}

export function consignmentValueInr(input: ConsignmentValueInput): number {
  const {
    taxableValueInr,
    cgstInr = 0, sgstInr = 0, utgstInr = 0, igstInr = 0, cessInr = 0,
    exemptValueInr = 0,
  } = input

  for (const [name, v] of Object.entries({
    taxableValueInr, cgstInr, sgstInr, utgstInr, igstInr, cessInr, exemptValueInr,
  })) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be finite and non-negative`)
  }

  return roundInr(
    taxableValueInr + cgstInr + sgstInr + utgstInr + igstInr + cessInr - exemptValueInr,
  )
}

/**
 * Rule 138(1): required where consignment value EXCEEDS ₹50,000 — strictly
 * greater than, so an exactly-₹50,000 consignment does not need one.
 *
 * INTER-STATE ONLY, and that is the whole reason this constant is allowed to
 * exist: §4.2 confirms the inter-state figure is ₹50,000 everywhere and no state
 * may vary it. Intra-state is a different question with a per-state,
 * effective-dated, partly contested answer (Rajasthan ₹2,00,000 intra-city, MP
 * none intra-district, Goa only for 22 goods…). That table is NOT in this slice
 * and must not be faked with this constant.
 */
export const INTER_STATE_EWB_THRESHOLD_INR = 50_000

export function interStateEwayBillRequired(consignmentValue: number): boolean {
  return consignmentValue > INTER_STATE_EWB_THRESHOLD_INR
}

/**
 * The first two digits of a GSTIN are the GST state code — the same code space
 * as place_of_supply_code. Lets a movement be classified from identifiers the
 * invoice already carries instead of asking the user for the state twice.
 */
export function stateCodeOfGstin(gstin?: string | null): string | null {
  if (!gstin) return null
  const head = gstin.trim().slice(0, 2)
  return /^\d{2}$/.test(head) ? head : null
}

/**
 * §9.2's first validation gate — "threshold check on GST-INCLUSIVE consignment
 * value" — as a single answer the caller can put in front of a user.
 *
 * 🔴 IT REFUSES TO GUESS. Rule 138(1)'s ₹50,000 is the INTER-state figure, and
 * that is the only one §4.2 lets us hardcode. Where the movement is intra-state,
 * or where the two ends cannot be identified at all, the answer is `null` with a
 * reason — never `false`. `false` here would read as "no e-way bill needed" on a
 * Rajasthan intra-city move whose real threshold is ₹2,00,000 *or* on a Goa move
 * where 22 specified goods need one at ₹50,000 and nothing else ever does. Both
 * of those are answers this codebase does not have, and a confident wrong "no"
 * is what puts a truck on the road without a bill it needed: s.129 detention at
 * 100%/200% of tax, not a ₹1,000 penalty.
 */
export type EwayBillMovement = 'inter_state' | 'intra_state' | 'unknown'

export type EwayBillRequirement = {
  /** GST-INCLUSIVE, per Rule 138 Explanation 2. Never the pre-tax figure. */
  consignment_value_inr: number
  movement: EwayBillMovement
  threshold_inr: number | null
  /** null = we decline to answer; see `reason`. */
  required: boolean | null
  reason: string
}

export function ewayBillRequirement(input: {
  consignmentValueInr: number
  fromStateCode?: string | null
  toStateCode?: string | null
}): EwayBillRequirement {
  const { consignmentValueInr, fromStateCode, toStateCode } = input

  if (!fromStateCode || !toStateCode) {
    return {
      consignment_value_inr: consignmentValueInr,
      movement: 'unknown',
      threshold_inr: null,
      required: null,
      reason:
        'Both ends of the movement must be identified before the e-way bill threshold can be applied — ' +
        'supply the supplier and delivery state codes (or GSTINs).',
    }
  }

  if (fromStateCode === toStateCode) {
    return {
      consignment_value_inr: consignmentValueInr,
      movement: 'intra_state',
      threshold_inr: null,
      required: null,
      reason:
        `Intra-state movement within state ${fromStateCode}: the threshold is set by that state and is ` +
        'not a single national figure, so this platform does not assert one. Check the state rule.',
    }
  }

  const required = interStateEwayBillRequired(consignmentValueInr)
  return {
    consignment_value_inr: consignmentValueInr,
    movement: 'inter_state',
    threshold_inr: INTER_STATE_EWB_THRESHOLD_INR,
    required,
    reason: required
      ? `Inter-state movement ${fromStateCode} to ${toStateCode} and the GST-inclusive consignment value ` +
        `exceeds ₹${INTER_STATE_EWB_THRESHOLD_INR.toLocaleString('en-IN')} — an e-way bill is required.`
      : `Inter-state movement ${fromStateCode} to ${toStateCode} but the GST-inclusive consignment value ` +
        `does not exceed ₹${INTER_STATE_EWB_THRESHOLD_INR.toLocaleString('en-IN')}.`,
  }
}

// -----------------------------------------------------------
// E-way bill expiry — §4.4.
//
// 🔴 THE VALIDITY IS GIVEN TO US, NEVER DERIVED. Explanation 1 to Rule 138(10):
// each day of validity expires at midnight of the day IMMEDIATELY FOLLOWING
// generation. So a bill raised at 23:55 has about 24 hours of life and one
// raised at 00:05 has about 48 — from the same "1 day" allowance. Any local
// `generated_at + n days` gets the second case wrong by a full day in the
// dangerous direction: we would tell a driver they are covered while the bill is
// already dead. There is deliberately no function in this module that computes a
// valid_upto, and no default or trigger on the column that stores it.
//
// What we DO own is the alert. §9.3: replicate the portal's 4-day window, because
// mid-transit expiry is the most common cause of detention.
// -----------------------------------------------------------

export const EWB_EXPIRY_ALERT_WINDOW_DAYS = 4

const MS_PER_HOUR = 60 * 60 * 1000

export type EwayBillExpiry = {
  /** 'expired' the instant validity passes — there is no grace period at a checkpoint. */
  state: 'valid' | 'expiring_soon' | 'expired'
  hours_remaining: number
  valid_upto: string
}

export function ewayBillExpiry(
  validUpto: Date | string,
  now: Date = new Date(),
  windowDays: number = EWB_EXPIRY_ALERT_WINDOW_DAYS,
): EwayBillExpiry {
  const upto = validUpto instanceof Date ? validUpto : new Date(validUpto)
  if (Number.isNaN(upto.getTime())) throw new Error(`Invalid valid_upto '${String(validUpto)}'`)

  const msRemaining = upto.getTime() - now.getTime()
  const hours = msRemaining / MS_PER_HOUR

  const state: EwayBillExpiry['state'] =
    msRemaining <= 0 ? 'expired'
      : hours <= windowDays * 24 ? 'expiring_soon'
      : 'valid'

  return {
    state,
    // Rounded to whole hours for display; never rounded UP past the boundary,
    // because "1 hour left" on an expired bill is the worst possible message.
    hours_remaining: msRemaining <= 0 ? 0 : Math.floor(hours),
    valid_upto: upto.toISOString(),
  }
}

// -----------------------------------------------------------
// Money. Every amount on these documents is stored as numeric(_,2); rounding to
// paise here keeps a JS float sum (0.1 + 0.2) from arriving at the DB as a value
// that prints one paisa off the figure the user was shown.
// -----------------------------------------------------------

export function roundInr(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100
}
