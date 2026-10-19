// -----------------------------------------------------------
// digilocker-dl — read a DigiLocker-issued DRIVING LICENCE document into the fields the
// driver record keeps.
//
// This is the Sarathi route for a private company: no API to MoRTH, no scraping. The driver
// signs in to DigiLocker and consents; DigiLocker hands over the licence as the ISSUER's XML
// (the State transport department's record), not a photo. Sandbox's DigiLocker endpoints
// (modules/kyc/digilocker.ts) run the session; this file only parses the XML.
//
// DigiLocker's issued-document XML follows one envelope across issuers:
//   <Certificate number="…" type="DRVLC" issueDate="…" expiryDate="…" status="…">
//     <IssuedBy><Organization name="…"/></IssuedBy>
//     <IssuedTo><Person name="…" dob="…" gender="…" swd="…"/></IssuedTo>
//     <CertificateData><DrivingLicense …><Categories><Category abbreviation="LMV" …/>…
//   </Certificate>
// Attribute names vary a little between states, so every read is tolerant: a field that is
// not there is null, never a guess. Pure, so it is unit-tested on sample XML.
// -----------------------------------------------------------

export type DigiLockerDl = {
  dl_number: string | null
  name: string | null
  /** ISO yyyy-mm-dd */
  date_of_birth: string | null
  issue_date: string | null
  expiry_date: string | null
  /** The transport (TR) validity when the record prints one separately. */
  transport_expiry_date: string | null
  vehicle_classes: string[]
  issuing_authority: string | null
  /** The issuer's own status word ("A"/"ACTIVE", "S"uspended …), as printed. */
  status: string | null
}

/** Attribute value by name, case-insensitive, from the first matching element. */
function attr(xml: string, element: RegExp | string, name: string): string | null {
  const el = typeof element === 'string' ? new RegExp(`<${element}\\b[^>]*>`, 'i') : element
  const tag = el.exec(xml)?.[0]
  if (!tag) return null
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  const v = m?.[1]?.trim()
  return v ? decodeEntities(v) : null
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
}

/** "02-06-1988", "02/06/1988", "1988-06-02", "02 Jun 1988" -> ISO; null when unreadable. */
export function toIsoDate(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  let d: number, m: number, y: number
  let x: RegExpExecArray | null
  if ((x = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3] }
  else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3] }
  else if ((x = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})/.exec(s))) {
    d = +x[1]; y = +x[3]
    m = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(x[2].slice(0, 3).toLowerCase()) + 1
  } else return null
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const DL_RE = /\b([A-Z]{2})[\s-]?(\d{2})[\s-]?((?:19|20)\d{2})[\s-]?(\d{7})\b/

function cleanName(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.replace(/[^A-Za-z .']/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length < 2) return null
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export function parseDigiLockerDl(xml: string): DigiLockerDl {
  const certNumber = attr(xml, 'Certificate', 'number') ?? attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'number') ?? attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'dlNumber')
  let dl_number: string | null = null
  const fromNumber = certNumber ? DL_RE.exec(certNumber.toUpperCase().replace(/\s|-/g, '')) : null
  if (fromNumber) dl_number = `${fromNumber[1]}${fromNumber[2]}${fromNumber[3]}${fromNumber[4]}`
  else if (certNumber && /^[A-Z0-9-]{8,20}$/i.test(certNumber)) dl_number = certNumber.toUpperCase().replace(/[\s-]/g, '')

  const person = /<Person\b[^>]*>/i
  const name = cleanName(attr(xml, person, 'name'))
  const date_of_birth = toIsoDate(attr(xml, person, 'dob'))

  const issue_date = toIsoDate(attr(xml, 'Certificate', 'issueDate') ?? attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'issueDate'))
  const expiry_date = toIsoDate(
    attr(xml, 'Certificate', 'expiryDate') ?? attr(xml, 'Certificate', 'validTo') ??
    attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'validTo') ?? attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'ntValidTo') ?? attr(xml, /<Validity\b[^>]*>/i, 'nonTransportTo'),
  )
  const transport_expiry_date = toIsoDate(
    attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'trValidTo') ?? attr(xml, /<Validity\b[^>]*>/i, 'transportTo') ?? attr(xml, /<Transport\b[^>]*>/i, 'validTo'),
  )

  // Categories: <Category abbreviation="LMV"/>, <Category cov="HMV"/>, <COV code="TRANS"/>.
  const classes = new Set<string>()
  for (const m of xml.matchAll(/<(?:Category|COV|VehicleClass)\b[^>]*>/gi)) {
    const tag = m[0]
    const v = /\b(?:abbreviation|cov|code|class|name)\s*=\s*"([^"]+)"/i.exec(tag)?.[1]?.trim().toUpperCase()
    if (v && /^[A-Z][A-Z0-9-]{1,12}$/.test(v)) classes.add(v.replace(/-?(NT|TR)$/, '') || v)
  }

  const issuing_authority = decodeEntities(attr(xml, /<IssuedBy>\s*<Organization\b[^>]*>/i, 'name') ?? attr(xml, 'Organization', 'name') ?? '') || null
  const status = attr(xml, 'Certificate', 'status') ?? attr(xml, /<DrivingLicen[cs]e\b[^>]*>/i, 'status')

  return { dl_number, name, date_of_birth, issue_date, expiry_date, transport_expiry_date, vehicle_classes: [...classes], issuing_authority, status }
}
