/**
 * The acknowledgement REGISTRY — the canonical, versioned text a user signs when they choose the
 * "I'll provide this later / it does not apply to me" escape hatch instead of uploading a document
 * (D-31: KYC prompts, never gates).
 *
 * WHY THE TEXT LIVES ON THE SERVER, KEYED BY kind+version, AND IS NOT ACCEPTED FROM THE CLIENT:
 * an acknowledgement is a legal artifact — the whole point of D-31 is that a recorded self-declaration
 * is a STRONGER position than a missing KYC record, because it is affirmative evidence of what the
 * user asserted. Evidence is only worth something if we can prove WHAT they agreed to, which means the
 * exact wording has to be ours and pinned to a version. A boolean ("gst_ack = true") proves nothing a
 * year later; a client-supplied string proves nothing either, because the client could have shown the
 * user anything. So the server owns the statement, stamps the version it served, and stores the full
 * text verbatim next to the user (migration 0028). When the wording materially changes we bump the
 * version and keep the old rows exactly as they were signed.
 *
 * Re-prompting when the underlying facts materially change (e.g. a shipper who declared "under the GST
 * threshold" starts posting high-value interstate loads) is a deliberate FUTURE refinement — it needs
 * a change-detection trigger we are not building here. Today an acknowledgement, once signed, stands
 * until the user revisits it.
 */

export interface AcknowledgementDef {
  /**
   * Bumped whenever the STATEMENT text changes in a way that alters what the user is agreeing to.
   * Date-stamped rather than a running integer so the version is self-describing in an audit and two
   * branches editing different kinds never collide on "v2".
   */
  version: string
  /** The exact words shown to the user and stored verbatim on the signed row. */
  statement: string
}

/**
 * Every acknowledgement kind the service will record. A `kind` absent from this map is rejected by
 * POST /me/acknowledgements — an acknowledgement whose text we cannot produce is not an artifact, it
 * is a bare flag, and this map exists precisely to stop those being written.
 *
 * The kinds mirror the completeness items in lib/completeness.ts: signing one flips the matching item
 * from 'missing' to 'declared'. That is the ONLY thing it does — it never unlocks a capability, because
 * completeness never gates (D-31).
 */
export const ACKNOWLEDGEMENTS: Record<string, AcknowledgementDef> = {
  // The GST escape hatch called out in D-31/D-33: a transporter or shipper below the ₹20 lakh
  // registration threshold, or one who has not filed yet, signs this instead of supplying a GSTIN.
  gst_under_threshold: {
    version: '2026-08-07',
    statement:
      'I confirm that my annual turnover is below the ₹20,00,000 GST registration threshold, or ' +
      'that I will provide my GSTIN before it becomes legally required for the movement I book. I ' +
      'understand BharatTruck relies on this declaration for the lorry receipts, invoices and ' +
      'e-way bills it prepares on my behalf, and that I am responsible for its accuracy.',
  },
  // Driver document escape hatches. A driver may operate while their Aadhaar / PAN / licence upload
  // is pending; the signed declaration is what makes that a recorded choice rather than a silent gap.
  aadhaar_will_provide: {
    version: '2026-08-07',
    statement:
      'I confirm that I hold a valid Aadhaar and will upload it for verification when asked. I ' +
      'understand my driver profile is shown as incomplete until it is verified.',
  },
  pan_will_provide: {
    version: '2026-08-07',
    statement:
      'I confirm that I hold a valid PAN and will provide it when asked. I understand my driver ' +
      'profile is shown as incomplete until it is verified.',
  },
  driving_licence_will_provide: {
    version: '2026-08-07',
    statement:
      'I confirm that I hold a valid driving licence for the vehicle class I drive and will submit ' +
      'it for verification when asked. I understand my driver profile is shown as incomplete until ' +
      'it is verified.',
  },
  // Fleet-owner bank/business escape hatch: payouts need a bank account, but declaring the intent
  // must not block a fleet owner from setting up their console (D-32 front-door, D-31 no gate).
  bank_details_will_provide: {
    version: '2026-08-07',
    statement:
      'I confirm that I will add the bank and business details required to receive payouts before I ' +
      'accept payment for a trip. I understand my fleet profile is shown as incomplete until they ' +
      'are on file.',
  },
}

/** kinds are a closed set; the union is derived from the registry so the two can never drift. */
export type AcknowledgementKind = keyof typeof ACKNOWLEDGEMENTS
