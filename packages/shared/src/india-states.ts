// -----------------------------------------------------------
// India state -> GST 2-digit state code. The ONE home for this mapping.
//
// The system keys on the GST 2-digit code everywhere (freight_invoices.*_state_code,
// documents/rules.ts stateCodeOfGstin, diesel_prices keyed by GST state code). Two callers
// derive that code from softer inputs and used to keep their own copies, which had already
// drifted (different Delhi aliases, one missing the two-letter path):
//   - bt-fleet-service economics roll-up: fleet_owners.state is FREE TEXT an owner typed, so
//     it must map common spellings AND 2-letter codes onto the canonical GST code.
//   - bt-tracking-service place-details: Places (New) returns a state as its full NAME in an
//     administrative_area_level_1 component (e.g. "Maharashtra"), mapped to the code alongside
//     pincode.
//
// This module serves both. gstStateCode accepts an already-canonical 2-digit code (passed
// through), a two-letter code, or a full-name spelling, and returns null when it cannot
// resolve — a mis-typed state never fabricates a diesel price, and the tracking caller keeps
// the name with a null code rather than guessing. PURE + data-only, so it is unit-testable.
// -----------------------------------------------------------

// Two-letter code -> GST code, for the free-text / short-code path.
const GST_BY_TWO_LETTER: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UA: '05', HR: '06', DL: '07',
  RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14', MZ: '15',
  TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CG: '22', CT: '22',
  MP: '23', GJ: '24', DD: '26', DN: '26', MH: '27', KA: '29', GA: '30', LD: '31',
  KL: '32', TN: '33', PY: '34', AN: '35', TG: '36', TS: '36', LA: '38',
}

// Full-name spellings -> GST code. Lower-cased keys; lookups lower-case the input. Aliases are
// the union of what the fleet free-text path and the tracking Places path each need to accept.
const GST_BY_NAME: Record<string, string> = {
  'jammu and kashmir': '01', 'jammu & kashmir': '01', 'j&k': '01',
  'himachal pradesh': '02', 'himachal': '02',
  'punjab': '03',
  'chandigarh': '04',
  'uttarakhand': '05', 'uttaranchal': '05',
  'haryana': '06',
  'delhi': '07', 'new delhi': '07', 'nct of delhi': '07', 'national capital territory of delhi': '07',
  'rajasthan': '08',
  'uttar pradesh': '09',
  'bihar': '10',
  'sikkim': '11',
  'arunachal pradesh': '12',
  'nagaland': '13',
  'manipur': '14',
  'mizoram': '15',
  'tripura': '16',
  'meghalaya': '17',
  'assam': '18',
  'west bengal': '19',
  'jharkhand': '20',
  'odisha': '21', 'orissa': '21',
  'chhattisgarh': '22', 'chattisgarh': '22',
  'madhya pradesh': '23',
  'gujarat': '24',
  'dadra and nagar haveli and daman and diu': '26', 'daman and diu': '26', 'dadra and nagar haveli': '26',
  'maharashtra': '27',
  'karnataka': '29',
  'goa': '30',
  'lakshadweep': '31',
  'kerala': '32',
  'tamil nadu': '33', 'tamilnadu': '33',
  'puducherry': '34', 'pondicherry': '34',
  'andaman and nicobar islands': '35', 'andaman and nicobar': '35',
  'telangana': '36',
  'andhra pradesh': '37', // post-2014 AP; pre-split records also appear as 28
  'ladakh': '38',
}

/**
 * gstStateCode — best-effort GST 2-digit state code from a free-text state, a two-letter
 * code, or an already-canonical 2-digit code. Returns null when it cannot be resolved (the
 * caller falls back to the national default diesel price, or keeps a null state_code).
 */
export function gstStateCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Already a 2-digit GST code.
  if (/^[0-9]{2}$/.test(trimmed)) return trimmed

  const upper = trimmed.toUpperCase()
  if (GST_BY_TWO_LETTER[upper]) return GST_BY_TWO_LETTER[upper]

  const lower = trimmed.toLowerCase()
  if (GST_BY_NAME[lower]) return GST_BY_NAME[lower]

  return null
}
