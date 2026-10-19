/**
 * Persona completeness (D-33: the ring).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  THIS IS DISPLAY-ONLY METADATA. IT NEVER GATES ANYTHING. NOT ONE CAPABILITY, NOT ONE ROUTE,
 *  NOT ONE ACTION KEYS OFF A COMPLETENESS RESULT (D-31). A caller that treats a low percentage as
 *  permission-to-deny has misread this file. Capabilities are computed from OWNED ASSETS
 *  (@bharattruck/shared/personas); completeness is a nudge to fill a profile, and a nudge only.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * For each persona surface the human actually HAS — shipper (everyone), driver (has a `drivers` row),
 * fleet owner (has a `fleet_owners` row) — we report the D-33 requirement set and, per item, whether
 * the evidence is:
 *
 *   'verified' — a checked document/record exists (KYC approved, licence verified, bank verified).
 *   'declared' — the user has either typed the datum (e.g. a GSTIN) or signed the D-31 acknowledgement.
 *                Both are affirmative evidence; neither is a wall.
 *   'missing'  — no evidence yet. This is a PROMPT, not a block.
 *
 * KYC is stubbed today (the /kyc routes are 501), so in practice almost nothing resolves to 'verified'
 * yet — most items land on 'declared' (via an acknowledgement) or 'missing'. The 'verified' branch is
 * wired now so the ring simply lights up the day real KYC lands, with no change here.
 */

import type { PersonaSnapshot } from '@bharattruck/shared'

export type ItemStatus = 'verified' | 'declared' | 'missing'

export interface CompletenessItem {
  /** Stable machine key the frontend maps to a prompt + the acknowledgement kind that satisfies it. */
  key: string
  label: string
  status: ItemStatus
  /** The acknowledgement kind that flips this item to 'declared', when one applies. */
  acknowledgement_kind: string | null
  /** One line on why this is asked for — informational, never a gate. */
  note: string
}

export interface PersonaCompleteness {
  persona: 'shipper' | 'driver' | 'fleet_owner'
  /** Share of items that are not 'missing' (verified OR declared both count as satisfied). */
  percentage: number
  items: CompletenessItem[]
}

export interface CompletenessReport {
  /**
   * Redundant with the doc comment, but a machine-readable restatement so a client cannot accidentally
   * infer that completeness is a gate: it is not, and this field says so in the payload itself.
   */
  gates_nothing: true
  overall_percentage: number
  personas: PersonaCompleteness[]
}

/** The raw evidence rows the report is computed from. Gathered by the route, passed in for testability. */
export interface CompletenessFacts {
  /** users.gstin — a self-typed GSTIN counts as a declaration (format-checked, not portal-verified). */
  user_gstin: string | null
  /** fleet_owners.gstin, when the human owns a fleet. */
  fleet_gstin: string | null
  /** doc_types with an APPROVED kyc_documents row for this user. */
  verified_kyc_doc_types: Set<string>
  /** driver_licenses.status for this driver, or null when no licence has been submitted. */
  driver_licence_status: string | null
  /** Whether this user has at least one bank account row, and whether any is verified. */
  has_bank_account: boolean
  has_verified_bank_account: boolean
  /** The acknowledgement kinds this user has on file (from persona_acknowledgements). */
  acknowledged_kinds: Set<string>
}

function statusOf(verified: boolean, declared: boolean): ItemStatus {
  if (verified) return 'verified'
  if (declared) return 'declared'
  return 'missing'
}

function pct(items: CompletenessItem[]): number {
  if (items.length === 0) return 100
  const satisfied = items.filter((i) => i.status !== 'missing').length
  return Math.round((satisfied / items.length) * 100)
}

/**
 * Pure computation, no I/O — so the whole D-33 rule set is testable without a database and the "never
 * gates" property is verifiable by inspection.
 */
export function computeCompleteness(snapshot: PersonaSnapshot, facts: CompletenessFacts): CompletenessReport {
  const gstDeclared = Boolean(facts.user_gstin) || Boolean(facts.fleet_gstin) || facts.acknowledged_kinds.has('gst_under_threshold')
  const personas: PersonaCompleteness[] = []

  // ── shipper: everyone ships. GST is informational — needed for interstate / e-way-bill loads. ──
  {
    const items: CompletenessItem[] = [
      {
        key: 'gst',
        label: 'GST registration',
        // GST can never be 'verified' today (no 'gst' kyc_documents type + portal check is stubbed);
        // a typed GSTIN or the under-threshold acknowledgement makes it 'declared'.
        status: statusOf(false, gstDeclared),
        acknowledgement_kind: 'gst_under_threshold',
        note: 'Required on the e-way bill and invoice for interstate or high-value shipments.',
      },
    ]
    personas.push({ persona: 'shipper', percentage: pct(items), items })
  }

  // ── driver: only when the human has a drivers row (the 'drive' capability). Aadhaar + PAN + DL. ──
  if (snapshot.driver_id) {
    const licenceVerified = facts.driver_licence_status === 'verified' || facts.verified_kyc_doc_types.has('license')
    const licenceDeclared = facts.driver_licence_status !== null || facts.acknowledged_kinds.has('driving_licence_will_provide')
    const items: CompletenessItem[] = [
      {
        key: 'aadhaar',
        label: 'Aadhaar',
        status: statusOf(facts.verified_kyc_doc_types.has('aadhaar'), facts.acknowledged_kinds.has('aadhaar_will_provide')),
        acknowledgement_kind: 'aadhaar_will_provide',
        note: 'Identity proof for driver verification.',
      },
      {
        key: 'pan',
        label: 'PAN',
        status: statusOf(facts.verified_kyc_doc_types.has('pan'), facts.acknowledged_kinds.has('pan_will_provide')),
        acknowledgement_kind: 'pan_will_provide',
        note: 'Tax identity for driver payouts.',
      },
      {
        key: 'driving_licence',
        label: 'Driving licence',
        status: statusOf(licenceVerified, licenceDeclared),
        acknowledgement_kind: 'driving_licence_will_provide',
        note: 'Proof you may legally drive the vehicle class.',
      },
    ]
    personas.push({ persona: 'driver', percentage: pct(items), items })
  }

  // ── fleet owner: only when the human has a fleet_owners row. GST + business/bank. ──
  // Keyed on the ROW, not on the 'operate' capability: a fleet owner who declared at signup (D-32)
  // and has not added a truck yet still has a fleet_owners row and belongs in the fleet console in a
  // setup state — their ring must show even before 'operate' emerges from owning assets.
  if (snapshot.fleet_owner_id) {
    const bankDeclared = facts.has_bank_account || facts.acknowledged_kinds.has('bank_details_will_provide')
    const items: CompletenessItem[] = [
      {
        key: 'gst',
        label: 'GST registration',
        status: statusOf(false, gstDeclared),
        acknowledgement_kind: 'gst_under_threshold',
        note: 'Required to bill freight and issue compliant documents.',
      },
      {
        key: 'business_bank',
        label: 'Bank account for payouts',
        status: statusOf(facts.has_verified_bank_account, bankDeclared),
        acknowledgement_kind: 'bank_details_will_provide',
        note: 'Where trip payouts are settled.',
      },
    ]
    personas.push({ persona: 'fleet_owner', percentage: pct(items), items })
  }

  const allItems = personas.flatMap((p) => p.items)
  return {
    gates_nothing: true,
    overall_percentage: pct(allItems),
    personas,
  }
}
