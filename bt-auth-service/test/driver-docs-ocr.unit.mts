/**
 * Driver-document OCR — the pure text -> fields rules (src/lib/ocr/driver-docs.ts), and the
 * /onboarding/ocr routes with the OCR call injected.
 *
 * The texts below are written the way an OCR pass returns a card: labels and values on separate
 * lines, in an order that does not follow the layout. Every name and number is invented.
 * Run: npx tsx test/driver-docs-ocr.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { parseDrivingLicence, parseBankDocument, countFound } from '../src/lib/ocr/driver-docs.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

console.log('\n── driving licence: smart card ──')
{
  const f = parseDrivingLicence(`
    INDIAN UNION DRIVING LICENCE
    MAHARASHTRA STATE MOTOR DRIVING LICENCE
    DL No  MH12 20110012345
    DOI : 14-03-2011
    Valid Till : 13-03-2031 (NT)
    Valid Till : 20-08-2027 (TR)
    AED 14-03-2011
    Name : RAMESH KUMAR PATIL
    S/D/W of : SURESH PATIL
    DOB : 02-06-1988   BG : O+
    Add : 12 MG ROAD PUNE 411001
    COV   DOI
    LMV   14-03-2011
    TRANS 21-08-2015
    MCWG  14-03-2011
  `)
  check('DL number, separators removed', f.dl_number === 'MH1220110012345', JSON.stringify(f.dl_number))
  check('name is the holder, not the father', f.name === 'Ramesh Kumar Patil', JSON.stringify(f.name))
  check('date of birth', f.date_of_birth === '1988-06-02', JSON.stringify(f.date_of_birth))
  check('expiry is the TRANSPORT validity, not the later non-transport one', f.expiry_date === '2027-08-20', JSON.stringify(f.expiry_date))
  check('classes', JSON.stringify(f.vehicle_classes) === JSON.stringify(['LMV', 'MCWG', 'TRANS']), JSON.stringify(f.vehicle_classes))
}

console.log('\n── driving licence: labels and values on separate lines ──')
{
  const f = parseDrivingLicence(`
    Driving Licence
    Licence No.
    DL-0420110149646
    Name
    SUNITA DEVI
    Father's Name
    MOHAN LAL
    Date of Birth
    15/01/1990
    Date of Issue 03/02/2011
    Validity
    02/02/2031
    LMV-NT HGMV
  `)
  check('DL number with a dash', f.dl_number === 'DL0420110149646', JSON.stringify(f.dl_number))
  check('name on the line after its label', f.name === 'Sunita Devi', JSON.stringify(f.name))
  check('date of birth on the line after its label', f.date_of_birth === '1990-01-15', JSON.stringify(f.date_of_birth))
  check('validity on the line after its label', f.expiry_date === '2031-02-02', JSON.stringify(f.expiry_date))
  check('LMV-NT reads as LMV; HGMV kept', JSON.stringify(f.vehicle_classes) === JSON.stringify(['LMV', 'HGMV']), JSON.stringify(f.vehicle_classes))
}

console.log('\n── driving licence: no guessing ──')
{
  const f = parseDrivingLicence('GOVERNMENT OF INDIA\nsome blurred text 12345\nFather Name : MOHAN LAL\n07-07-2020')
  check('unreadable DL number is null', f.dl_number === null, JSON.stringify(f.dl_number))
  check("a relative's name is never taken as the holder", f.name === null, JSON.stringify(f.name))
  check('a single unlabelled date is not called the expiry', f.expiry_date === null, JSON.stringify(f.expiry_date))
  check('no classes invented', f.vehicle_classes.length === 0, JSON.stringify(f.vehicle_classes))
  check('nothing found counts as zero', countFound(f) === 0, String(countFound(f)))
  const bad = parseDrivingLicence('DL No KA05 20150001234\nDOB 31-02-1990\nValid Till 10-10-1985')
  check('an impossible date is dropped', bad.date_of_birth === null, JSON.stringify(bad.date_of_birth))
  const swapped = parseDrivingLicence('DOB 10-10-1990\nValid Till 01-01-1985')
  check('an expiry before the date of birth is dropped', swapped.expiry_date === null, JSON.stringify(swapped.expiry_date))
}

console.log('\n── bank: passbook ──')
{
  const f = parseBankDocument(`
    STATE BANK OF INDIA
    Branch : SHIVAJINAGAR PUNE
    Customer Name : Mr. RAMESH KUMAR PATIL
    Account No. : 3214 5678 9012
    CIF No : 88001234567
    IFSC Code : SBIN0001234
    MICR : 411002005
  `)
  check('account number beside its label, spaces removed', f.account_number === '321456789012', JSON.stringify(f.account_number))
  check('IFSC', f.ifsc === 'SBIN0001234', JSON.stringify(f.ifsc))
  check('bank named from the IFSC', f.bank_name === 'State Bank of India', JSON.stringify(f.bank_name))
  check('holder name, title removed', f.account_holder_name === 'Ramesh Kumar Patil', JSON.stringify(f.account_holder_name))
}

console.log('\n── bank: cancelled cheque ──')
{
  const f = parseBankDocument(`
    HDFC BANK
    KOREGAON PARK PUNE 411001
    RTGS / NEFT IFSC : HDFCO000123
    Pay ______________________ or bearer
    Rupees
    50100123456789
    RAMESH KUMAR PATIL
    "000123" 411240002: 123456" 31
  `)
  check('IFSC with the zero read as letter O is corrected', f.ifsc === 'HDFC0000123', JSON.stringify(f.ifsc))
  check('the one long digit run is the account number', f.account_number === '50100123456789', JSON.stringify(f.account_number))
  check('MICR / cheque numbers are not taken', f.account_number !== '411240002' && f.account_number !== '000123', '')
  check('bank named from the IFSC', f.bank_name === 'HDFC Bank', JSON.stringify(f.bank_name))
  check('an unlabelled printed name is left for the driver', f.account_holder_name === null, JSON.stringify(f.account_holder_name))
}

console.log('\n── bank: no guessing ──')
{
  const two = parseBankDocument('ICIC0001234\n123456789012\n987654321098')
  check('two candidate numbers and no label: account left blank', two.account_number === null, JSON.stringify(two.account_number))
  const word = parseBankDocument('PAYMENT0RDERX ABCD0123456')
  check('an 11-character word with an unknown bank prefix is not an IFSC', word.ifsc === null, JSON.stringify(word.ifsc))
  const unknown = parseBankDocument('IFSC : ZZZZ0123456')
  check('a labelled IFSC of an unlisted bank is kept, bank name blank', unknown.ifsc === 'ZZZZ0123456' && unknown.bank_name === null, JSON.stringify(unknown))
}

// ── routes ─────────────────────────────────────────────────────
type Row = Record<string, any>
const db: Record<string, Row[]> = {
  users: [{ id: 'u-driver' }, { id: 'u-shipper' }],
  drivers: [{ id: 'd-1', user_id: 'u-driver' }],
  fleet_owners: [], vehicles: [], fleet_drivers: [], fleet_members: [],
}
class FakeQuery {
  private eqs: Array<[string, any]> = []
  private ins: Array<[string, any[]]> = []
  constructor(private table: string) {}
  select() { return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  in(c: string, vs: any[]) { this.ins.push([c, vs]); return this }
  order() { return this }
  limit() { return this }
  private run() {
    const data = (db[this.table] ?? []).filter(r => this.eqs.every(([c, v]) => r[c] === v) && this.ins.every(([c, vs]) => vs.includes(r[c])))
    return { data, count: data.length, error: null }
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}

async function routes() {
  const { onboardingOcrRoutes } = await import('../src/routes/onboarding-ocr.js')
  const tok = (userId: string, role: string) => jwt.sign({ userId, role }, process.env.JWT_SECRET!)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')

  const build = async (reader: null | ((b: Buffer, m: string) => Promise<string>)) => {
    const app = Fastify({ logger: false })
    app.decorate('supabase', { from: (t: string) => new FakeQuery(t) } as any)
    await app.register(onboardingOcrRoutes, { prefix: '/onboarding', reader })
    return app
  }

  console.log('\n── /onboarding/ocr: switched off ──')
  let app = await build(null)
  let r = await app.inject({ method: 'GET', url: '/onboarding/ocr/config', headers: { authorization: `Bearer ${tok('u-driver', 'driver')}` } })
  check('config says scanning is off', r.statusCode === 200 && r.json().data?.enabled === false, r.body)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: { authorization: `Bearer ${tok('u-driver', 'driver')}` }, payload: { kind: 'licence', mime_type: 'image/png', content_base64: png } })
  check('scan while off 501 OCR_NOT_CONFIGURED', r.statusCode === 501 && r.json().code === 'OCR_NOT_CONFIGURED', `(got ${r.statusCode})`)
  await app.close()

  console.log('\n── /onboarding/ocr: switched on ──')
  const seen: Array<{ bytes: number; mime: string }> = []
  app = await build(async (b, m) => { seen.push({ bytes: b.length, mime: m }); return 'DL No MH12 20110012345\nName : RAMESH PATIL\nValid Till : 13-03-2031' })
  const H = { authorization: `Bearer ${tok('u-driver', 'driver')}` }
  r = await app.inject({ method: 'GET', url: '/onboarding/ocr/config', headers: H })
  check('config says scanning is on', r.json().data?.enabled === true, r.body)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', payload: { kind: 'licence', mime_type: 'image/png', content_base64: png } })
  check('no token 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: { authorization: `Bearer ${tok('u-shipper', 'shipper')}` }, payload: { kind: 'licence', mime_type: 'image/png', content_base64: png } })
  check('a non-driver cannot scan a licence 403', r.statusCode === 403 && seen.length === 0, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: H, payload: { kind: 'passport', mime_type: 'image/png', content_base64: png } })
  check('unknown document kind 400', r.statusCode === 400, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: H, payload: { kind: 'licence', mime_type: 'application/zip', content_base64: png } })
  check('unsupported file type 400', r.statusCode === 400 && seen.length === 0, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: H, payload: { kind: 'licence', mime_type: 'image/png', content_base64: '' } })
  check('empty file 400', r.statusCode === 400 && seen.length === 0, `(got ${r.statusCode})`)
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: H, payload: { kind: 'licence', mime_type: 'image/png', content_base64: png } })
  check('licence scan 200 with fields', r.statusCode === 200 && r.json().data?.fields?.dl_number === 'MH1220110012345' && r.json().data?.fields?.expiry_date === '2031-03-13' && r.json().data?.found === 3, r.body)
  check('the reader got the decoded bytes and type', seen.length === 1 && seen[0].bytes === 8 && seen[0].mime === 'image/png', JSON.stringify(seen))
  check('the response does not echo the raw text', !r.body.includes('Valid Till'), r.body)
  check('nothing was written', Object.keys(db).every(t => !['driver_licenses', 'bank_accounts'].includes(t)), Object.keys(db).join(','))
  await app.close()

  app = await build(async () => 'Account No : 321456789012\nIFSC : SBIN0001234')
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: { authorization: `Bearer ${tok('u-shipper', 'shipper')}` }, payload: { kind: 'bank', mime_type: 'image/jpeg', content_base64: png } })
  check('bank scan is open to any signed-in user, like linking a bank account', r.statusCode === 200 && r.json().data?.fields?.ifsc === 'SBIN0001234' && r.json().data?.fields?.account_number === '321456789012', r.body)
  await app.close()

  app = await build(async () => '   ')
  r = await app.inject({ method: 'POST', url: '/onboarding/ocr', headers: H, payload: { kind: 'licence', mime_type: 'image/png', content_base64: png } })
  check('an unreadable photo is a 200 with found = 0, not an error', r.statusCode === 200 && r.json().data?.found === 0, r.body)
  await app.close()
}

routes().then(() => {
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}).catch(err => { console.error(err); process.exit(1) })
