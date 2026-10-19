// -----------------------------------------------------------
// identity-docs — the fields on an Aadhaar card (front: name, date of birth, gender; back:
// address) read off OCR text, to fill the driver's details for them to confirm.
//
// THE AADHAAR NUMBER IS NOT RETURNED. Only its last four digits, so the driver can see the
// right card was read. The platform has no use for the full number (nothing here verifies it,
// and keeping it would put us under the Aadhaar Act's storage rules for no benefit) — the
// details the form needs are the name and where the driver is based.
//
// Pure, like the other parsers; a field that cannot be read with confidence is null.
// -----------------------------------------------------------

export type AadhaarFields = {
  name: string | null
  /** ISO yyyy-mm-dd; a card that prints only "Year of Birth" gives yyyy-01-01 with year_only true. */
  date_of_birth: string | null
  year_only: boolean
  gender: 'male' | 'female' | 'other' | null
  /** The whole address as printed on the back, one line. */
  address: string | null
  /** The town/city picked out of the address — the "home base" the driver profile asks for. */
  city: string | null
  pincode: string | null
  state: string | null
  /** Last four digits only — enough to recognise the card, never the number itself. */
  aadhaar_last4: string | null
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Chandigarh', 'Puducherry', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu', 'Lakshadweep',
]

// Words that are address structure, not a place name.
const NOT_A_TOWN = /^(?:s\/o|d\/o|w\/o|c\/o|house|h\.?no|flat|plot|near|opp|opposite|behind|road|rd|street|lane|nagar|colony|village|vtc|po|post|dist|district|tehsil|taluk|taluka|sub[- ]?district|india|address)\b/i

function isoDate(d: number, m: number, y: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function cleanName(raw: string): string | null {
  const s = raw.replace(/[^A-Za-z .']/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.' ]+|[.' ]+$/g, '')
  if (s.length < 3 || s.length > 60 || !/[A-Za-z]{2,}/.test(s)) return null
  // A line that is really a label or the issuer, not a person.
  if (/government|india|unique|identification|authority|aadhaar|male|female|year|birth|address|\bdob\b/i.test(s)) return null
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export function parseAadhaar(text: string): AadhaarFields {
  const ls = lines(text)

  // Date of birth: beside "DOB" / "Date of Birth", or "Year of Birth : 1988".
  let date_of_birth: string | null = null
  let year_only = false
  let dobLine = -1
  for (let i = 0; i < ls.length; i++) {
    const dob = /(?:DOB|D\.O\.B|Date of Birth)\s*[:.\-–]?\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/i.exec(ls[i])
    if (dob) { date_of_birth = isoDate(Number(dob[1]), Number(dob[2]), Number(dob[3])); dobLine = i; break }
    const yob = /Year of Birth\s*[:.\-–]?\s*((?:19|20)\d{2})/i.exec(ls[i])
    if (yob) { date_of_birth = `${yob[1]}-01-01`; year_only = true; dobLine = i; break }
  }

  // Gender, on its own line or after the date of birth.
  let gender: AadhaarFields['gender'] = null
  for (const l of ls) {
    if (/\bfemale\b|\bमहिला\b/i.test(l)) { gender = 'female'; break }
    if (/\bmale\b|\bपुरुष\b/i.test(l)) { gender = 'male'; break }
    if (/\btransgender\b/i.test(l)) { gender = 'other'; break }
  }

  // Name: the English line just above the date-of-birth line (the Hindi name sits above that),
  // else the first line that reads as a person's name.
  let name: string | null = null
  if (dobLine > 0) {
    for (let i = dobLine - 1; i >= Math.max(0, dobLine - 3) && !name; i--) name = cleanName(ls[i])
  }
  if (!name) {
    const afterName = ls.find((l) => /^name\s*[:.\-–]/i.test(l))
    if (afterName) name = cleanName(afterName.replace(/^name\s*[:.\-–]\s*/i, ''))
  }

  // Aadhaar number: 12 digits in groups of four. Only the last four are kept.
  const num = /\b(\d{4})\s?(\d{4})\s?(\d{4})\b/.exec(text)
  const aadhaar_last4 = num ? num[3] : null

  // Address (back of the card): from "Address:" to the PIN code.
  let address: string | null = null
  let pincode: string | null = null
  let state: string | null = null
  let city: string | null = null
  const start = ls.findIndex((l) => /\baddress\b/i.test(l))
  if (start >= 0) {
    const parts: string[] = []
    const first = ls[start].replace(/.*\baddress\s*[:.\-–]?\s*/i, '').trim()
    if (first) parts.push(first)
    for (let j = start + 1; j < ls.length && j <= start + 8; j++) {
      parts.push(ls[j])
      if (/\b\d{6}\b/.test(ls[j])) break
    }
    address = parts.join(', ').replace(/\s*,\s*,+/g, ',').replace(/\s+/g, ' ').trim() || null
  }
  if (address) {
    pincode = /\b([1-9]\d{5})\b/.exec(address)?.[1] ?? null
    state = STATES.find((s) => new RegExp(`\\b${s.replace(/ /g, '\\s+')}\\b`, 'i').test(address!)) ?? null

    // The town: Aadhaar prints "VTC: <town>" / "District: <district>" on newer cards; older
    // cards list segments and the town is the segment before the district/state.
    const vtc = /\b(?:VTC|Town|City|Village)\s*[:.\-–]?\s*([A-Za-z .]+?)(?:,|$)/i.exec(address)?.[1]
    const district = /\b(?:Dist(?:rict)?|DT)\s*[:.\-–]?\s*([A-Za-z .]+?)(?:,|$)/i.exec(address)?.[1]
    const pick = (vtc ?? district)?.trim()
    if (pick && pick.length >= 3) city = pick.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    if (!city) {
      const segs = address.split(',').map((s) => s.replace(/\b\d{6}\b/, '').trim()).filter(Boolean)
      // Walk back from the end past the PIN/state/"India" to the first segment that is a place.
      for (let i = segs.length - 1; i >= 0 && !city; i--) {
        const seg = segs[i]
        if (!seg || /\d/.test(seg) || NOT_A_TOWN.test(seg)) continue
        if (state && new RegExp(state.replace(/ /g, '\\s+'), 'i').test(seg)) continue
        if (/^[A-Za-z .]{3,30}$/.test(seg)) city = seg.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
      }
    }
  }

  return { name, date_of_birth, year_only, gender, address, city, pincode, state, aadhaar_last4 }
}
