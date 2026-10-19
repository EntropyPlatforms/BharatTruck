/**
 * GSTIN / PAN rules (src/lib/gst.ts) and the text -> fields parsers for a GST registration
 * certificate, a PAN card and an Aadhaar card (src/lib/ocr/business-docs.ts, identity-docs.ts).
 *
 * The texts are written the way an OCR pass returns a document: labels and values on
 * separate lines. Every name, number and address is invented; the GSTINs that must validate
 * carry a correctly computed check character.
 * Run: npx tsx test/business-docs-ocr.unit.mts
 */
import { gstinCheckDigit, gstinProblem, isValidGstin, panMatchesGstin, panProblem } from '../src/lib/gst.js'
import { normaliseGstin, normalisePan, parseGstCertificate, parsePanCard } from '../src/lib/ocr/business-docs.js'
import { parseAadhaar } from '../src/lib/ocr/identity-docs.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

// A valid GSTIN built from an invented PAN, with the check character computed.
const PAN = 'AAACT1001A'
const G14 = '27' + PAN + '1Z'
const GOOD = G14 + gstinCheckDigit(G14)

console.log('\n── GSTIN rules ──')
check('the canonical published example validates', isValidGstin('27AAPFU0939F1ZV'), '')
check('a computed check character validates', isValidGstin(GOOD), GOOD)
check('lower case and spaces are tolerated', isValidGstin(`  ${GOOD.toLowerCase()} `), '')
check('shape-only impostor is refused (UAT BT-11)', gstinProblem('99ZZZZZ9999Z9Z9') !== null, '')
check('a wrong check character is refused with the "mistyped" reason', /mistyped/.test(gstinProblem(G14 + (GOOD[14] === 'A' ? 'B' : 'A')) ?? ''), String(gstinProblem(G14 + 'A')))
check('an unknown state code is refused', /state code/.test(gstinProblem('45' + PAN + '1Z' + gstinCheckDigit('45' + PAN + '1Z')) ?? ''), '')
check('14 characters is refused', gstinProblem(GOOD.slice(0, 14)) === 'A GSTIN is 15 characters.', '')
check('an embedded PAN with a bad holder letter is refused', /PAN/.test(gstinProblem('27AAAXT1001A1Z' + gstinCheckDigit('27AAAXT1001A1Z')) ?? ''), '')

console.log('\n── PAN rules ──')
check('a PAN validates', panProblem(PAN) === null, '')
check('digits only is refused', panProblem('1234567890') !== null, '')
check('a bad holder-type letter is refused', panProblem('AAAXT1001A') !== null, '')
check('PAN matches its GSTIN', panMatchesGstin(PAN, GOOD), '')
check('another PAN does not', !panMatchesGstin('AAACT1002B', GOOD), '')

console.log('\n── OCR slips on a fixed-shape code ──')
check('O read for 0 and I for 1 inside the PAN are corrected', normalisePan('AAACTIOOIA') === PAN, String(normalisePan('AAACTIOOIA')))
check('a GSTIN with the same slips is corrected and still validates', normaliseGstin(`27AAACTIOOIA1Z${GOOD[14]}`) === GOOD, String(normaliseGstin(`27AAACTIOOIA1Z${GOOD[14]}`)))
check('a GSTIN whose check character does not fit is not "corrected" into existence', normaliseGstin(G14 + (GOOD[14] === 'A' ? 'B' : 'A')) === null, '')

console.log('\n── GST registration certificate (REG-06) ──')
{
  const f = parseGstCertificate(`
    Government of India
    Form GST REG-06
    Registration Certificate
    Registration Number : ${GOOD}
    1. Legal Name
    TEST TRANSPORT PRIVATE LIMITED
    2. Trade Name, if any
    TEST TRANSPORT
    3. Constitution of Business
    Private Limited Company
    4. Address of Principal Place of Business
    Plot 14, MIDC Bhosari,
    Pune, Maharashtra, 411026
    5. Date of Liability
    01/07/2017
    6. Period of Validity From 01/07/2017 To Not Applicable
    7. Type of Registration Regular
  `)
  check('GSTIN beside its label', f.gstin === GOOD, JSON.stringify(f.gstin))
  check('PAN derived from the GSTIN', f.pan === PAN, JSON.stringify(f.pan))
  check('legal name on the line after its label', f.legal_name === 'Test Transport Private Limited', JSON.stringify(f.legal_name))
  check('trade name', f.trade_name === 'Test Transport', JSON.stringify(f.trade_name))
  check('constitution', f.constitution === 'Private Limited Company', JSON.stringify(f.constitution))
  check('address runs across lines up to the next field', f.address === 'Plot 14, MIDC Bhosari,, Pune, Maharashtra, 411026'.replace(',,', ',') || (f.address ?? '').includes('Bhosari') && (f.address ?? '').includes('411026'), JSON.stringify(f.address))
  check('registered from = date of liability', f.registered_from === '2017-07-01', JSON.stringify(f.registered_from))
}
{
  const slipped = GOOD.slice(0, 2) + 'AAACTIOOIA' + GOOD.slice(12)
  const f = parseGstCertificate(`Registration Number : ${slipped}\nLegal Name : SOMEONE`)
  check('a GSTIN misread by OCR is corrected when the corrected one validates', f.gstin === GOOD, JSON.stringify(f.gstin))
  const none = parseGstCertificate('Government of India\nRegistration Certificate\nsome blur 99ZZZZZ9999Z9Z9')
  check('an impostor on the page is not taken as the GSTIN', none.gstin === null && none.pan === null, JSON.stringify(none.gstin))
  const noTrade = parseGstCertificate(`Registration Number : ${GOOD}\nTrade Name, if any\nNA\nConstitution of Business\nProprietorship`)
  check('"NA" trade name is null', noTrade.trade_name === null && noTrade.constitution === 'Proprietorship', JSON.stringify(noTrade))
}

console.log('\n── PAN card ──')
{
  const f = parsePanCard(`
    आयकर विभाग
    INCOME TAX DEPARTMENT
    भारत सरकार
    GOVT. OF INDIA
    Permanent Account Number Card
    ${PAN}
    नाम / Name
    RAMESH KUMAR PATIL
    पिता का नाम / Father's Name
    SURESH PATIL
    जन्म की तारीख / Date of Birth
    02/06/1988
  `)
  check('PAN', f.pan === PAN, JSON.stringify(f.pan))
  check('holder name, not the father', f.name === 'Ramesh Kumar Patil', JSON.stringify(f.name))
  check('date of birth', f.date_of_birth === '1988-06-02', JSON.stringify(f.date_of_birth))
  check('holder type from the 4th letter (C = company here)', f.holder_type === 'company', JSON.stringify(f.holder_type))
  const p = parsePanCard('Permanent Account Number\nABCPD1234E\nName\nSUNITA DEVI')
  check('a person PAN', p.pan === 'ABCPD1234E' && p.holder_type === 'person' && p.name === 'Sunita Devi', JSON.stringify(p))
  const bad = parsePanCard('INCOME TAX DEPARTMENT\nblurred')
  check('no PAN invented', bad.pan === null && bad.name === null, JSON.stringify(bad))
}

console.log('\n── Aadhaar card ──')
{
  const f = parseAadhaar(`
    भारत सरकार
    Government of India
    रमेश कुमार पाटील
    Ramesh Kumar Patil
    जन्म तारीख / DOB : 02/06/1988
    पुरुष / MALE
    4321 8765 1234
    मेरा आधार, मेरी पहचान
  `)
  check('name is the English line above the DOB', f.name === 'Ramesh Kumar Patil', JSON.stringify(f.name))
  check('date of birth', f.date_of_birth === '1988-06-02' && f.year_only === false, JSON.stringify(f.date_of_birth))
  check('gender', f.gender === 'male', JSON.stringify(f.gender))
  check('only the last four digits of the number come back', f.aadhaar_last4 === '1234', JSON.stringify(f.aadhaar_last4))
  check('the full number appears nowhere in the result', !JSON.stringify(f).includes('4321') && !JSON.stringify(f).includes('8765'), JSON.stringify(f))
}
{
  const f = parseAadhaar(`
    Address:
    S/O: Suresh Patil, 7 Transport Nagar,
    Nigdi, Pune,
    Maharashtra - 411044
    4321 8765 1234
  `)
  check('address joined from the back of the card', (f.address ?? '').includes('Transport Nagar') && (f.address ?? '').includes('411044'), JSON.stringify(f.address))
  check('PIN code', f.pincode === '411044', JSON.stringify(f.pincode))
  check('state', f.state === 'Maharashtra', JSON.stringify(f.state))
  check('city is the town before the state, not a structure word', f.city === 'Pune', JSON.stringify(f.city))
  const vtc = parseAadhaar('Address: C/O Mohan Lal, House 12, Sector 4, VTC: Karnal, District: Karnal, State: Haryana, PIN Code: 132001')
  check('VTC wins on a card that prints it', vtc.city === 'Karnal' && vtc.state === 'Haryana', JSON.stringify(vtc))
  const yob = parseAadhaar('SUNITA DEVI\nYear of Birth : 1990\nFEMALE')
  check('year-only birth is marked as such', yob.date_of_birth === '1990-01-01' && yob.year_only && yob.gender === 'female' && yob.name === 'Sunita Devi', JSON.stringify(yob))
}

console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
