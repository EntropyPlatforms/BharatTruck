/**
 * Government-record verification — the PURE parts:
 *   • the DigiLocker driving-licence XML reader (modules/kyc/digilocker-dl.ts)
 *   • the GST public-record mappers: profile + filing verdict (modules/kyc/gst-public.ts)
 *   • the Sandbox PAN / GSTIN response mapping (modules/kyc/provider.ts) against a fake client
 *
 * Every number and name is invented. Run: npx tsx test/gov-verification.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { parseDigiLockerDl, toIsoDate } = await import('../src/modules/kyc/digilocker-dl.js')
  const { toGstinProfile, toFilingSummary, financialYearOf } = await import('../src/modules/kyc/gst-public.js')
  const { SandboxKycProvider } = await import('../src/modules/kyc/provider.js')

  console.log('\n── DigiLocker driving-licence XML ──')
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Certificate language="99" name="Driving License" type="DRVLC" number="MH12 20110012345" issuedAt="Pune" issueDate="14-03-2011" expiryDate="13-03-2031" status="A">
  <IssuedBy><Organization name="Transport Department, Maharashtra" type="SG"/></IssuedBy>
  <IssuedTo><Person uid="" name="RAMESH KUMAR PATIL" dob="02-06-1988" gender="M" swd="SURESH PATIL"/></IssuedTo>
  <CertificateData>
    <DrivingLicense trValidTo="20-08-2027" ntValidTo="13-03-2031">
      <Categories>
        <Category abbreviation="LMV" issueDate="14-03-2011"/>
        <Category abbreviation="TRANS" issueDate="21-08-2015"/>
        <Category abbreviation="MCWG" issueDate="14-03-2011"/>
      </Categories>
    </DrivingLicense>
  </CertificateData>
</Certificate>`
    const f = parseDigiLockerDl(xml)
    check('licence number, normalised', f.dl_number === 'MH1220110012345', String(f.dl_number))
    check('holder name, not the father', f.name === 'Ramesh Kumar Patil', String(f.name))
    check('date of birth', f.date_of_birth === '1988-06-02', String(f.date_of_birth))
    check('issue + expiry', f.issue_date === '2011-03-14' && f.expiry_date === '2031-03-13', JSON.stringify([f.issue_date, f.expiry_date]))
    check('transport validity read separately', f.transport_expiry_date === '2027-08-20', String(f.transport_expiry_date))
    check('classes', JSON.stringify(f.vehicle_classes) === JSON.stringify(['LMV', 'TRANS', 'MCWG']), JSON.stringify(f.vehicle_classes))
    check('issuing authority', f.issuing_authority === 'Transport Department, Maharashtra', String(f.issuing_authority))
    check('status as printed', f.status === 'A', String(f.status))
  }
  {
    const f = parseDigiLockerDl('<Certificate type="DRVLC"><IssuedTo><Person name="SUNITA DEVI" dob="15/01/1990"/></IssuedTo><CertificateData><DrivingLicence number="DL-0420110149646" validTo="2031-02-02"><COV code="LMV-NT"/><COV code="HGMV"/></DrivingLicence></CertificateData></Certificate>')
    check('number on the inner element, slash dates, COV codes, NT suffix dropped', f.dl_number === 'DL0420110149646' && f.date_of_birth === '1990-01-15' && f.expiry_date === '2031-02-02' && JSON.stringify(f.vehicle_classes) === JSON.stringify(['LMV', 'HGMV']), JSON.stringify(f))
    const empty = parseDigiLockerDl('<Certificate></Certificate>')
    check('nothing invented from an empty document', empty.dl_number === null && empty.name === null && empty.vehicle_classes.length === 0, JSON.stringify(empty))
    check('date formats', toIsoDate('02 Jun 1988') === '1988-06-02' && toIsoDate('31-02-1990') === null && toIsoDate(null) === null, '')
  }

  console.log('\n── GST public record: profile ──')
  {
    const p = toGstinProfile('27AAPFU0939F1ZV', { code: 200, data: { status_cd: '1', data: { legalName: 'Sample Transport Pvt Ltd', status: 'Active', validGstin: true, pan: 'AAPFU0939F', stateCode: 27, stateName: 'Maharashtra', regStartDate: '01/07/2017', bussNature: ['Service Provision'] } } })
    check('active registration with its facts', p.valid && p.active && p.legal_name === 'Sample Transport Pvt Ltd' && p.pan === 'AAPFU0939F' && p.state_code === '27' && p.registered_since === '2017-07-01' && p.business_nature === 'Service Provision', JSON.stringify(p))
    const c = toGstinProfile('27AAPFU0939F1ZV', { code: 200, data: { status_cd: '1', data: { legalName: 'X', status: 'Cancelled', validGstin: true } } })
    check('a cancelled registration is valid but not active', c.valid && !c.active && c.status === 'Cancelled', JSON.stringify(c))
    const n = toGstinProfile('27AAPFU0939F1ZV', { code: 200, data: { status_cd: '0' } })
    check('no record → not valid', !n.valid && !n.active && n.legal_name === null, JSON.stringify(n))
  }

  console.log('\n── GST public record: filing verdict ──')
  {
    const today = new Date(Date.UTC(2026, 9, 9)) // 9 Oct 2026 → Apr..Sep elapsed = 6 months
    check('financial year of a date', financialYearOf(today) === 'FY 2026-27' && financialYearOf(new Date(Date.UTC(2027, 1, 1))) === 'FY 2026-27' && financialYearOf(new Date(Date.UTC(2027, 3, 1))) === 'FY 2027-28', financialYearOf(today))
    const rows = ['042026', '052026', '062026', '072026', '082026', '092026'].flatMap((prd) => [
      { rtntype: 'GSTR3B', ret_prd: prd, dof: `20/${String(Number(prd.slice(0, 2)) + 1).padStart(2, '0')}/2026`, status: 'Filed', valid: 'Y' },
      { rtntype: 'GSTR1', ret_prd: prd, dof: `11/${String(Number(prd.slice(0, 2)) + 1).padStart(2, '0')}/2026`, status: 'Filed', valid: 'Y' },
    ])
    const r = toFilingSummary('27AAPFU0939F1ZV', 'FY 2026-27', rows, today)
    check('every elapsed month filed → regular', r.verdict === 'regular' && r.months_elapsed === 6 && r.gstr3b_filed === 6 && r.gstr1_filed === 6 && r.gstr3b_missing === 0, JSON.stringify(r))
    check('last period and date', r.last_period === '092026' && r.last_filed_on === '2026-10-20', JSON.stringify([r.last_period, r.last_filed_on]))
    const behind = toFilingSummary('27AAPFU0939F1ZV', 'FY 2026-27', rows.filter((x) => !['072026', '082026', '092026'].includes(x.ret_prd)), today)
    check('three months unfiled → behind, 3 missing', behind.verdict === 'behind' && behind.gstr3b_missing === 3, JSON.stringify(behind))
    const none = toFilingSummary('27AAPFU0939F1ZV', 'FY 2026-27', [], today)
    check('nothing filed → none', none.verdict === 'none' && none.gstr3b_filed === 0 && none.last_period === null, JSON.stringify(none))
    const invalid = toFilingSummary('27AAPFU0939F1ZV', 'FY 2026-27', rows.map((x) => ({ ...x, valid: 'N' })), today)
    check('invalid filings do not count', invalid.verdict === 'none', JSON.stringify(invalid))
  }

  console.log('\n── Sandbox provider: documented PAN / GSTIN responses ──')
  {
    const calls: Array<{ endpoint: string; payload: any }> = []
    const fake = {
      configured: true,
      async post(endpoint: string, payload: any) {
        calls.push({ endpoint, payload })
        if (endpoint === '/kyc/pan/verify') return { code: 200, transaction_id: 't1', data: { status: 'valid', category: 'individual', name_as_per_pan_match: payload.name_as_per_pan === 'RAMESH PATIL', date_of_birth_match: true, aadhaar_seeding_status: 'y' } }
        if (endpoint === '/gst/compliance/public/gstin/verify') return { code: 200, transaction_id: 't2', data: { status_cd: '1', data: { legalName: 'Sample Transport', status: payload.gstin.startsWith('29') ? 'Cancelled' : 'Active', validGstin: true, pan: 'AAPFU0939F' } } }
        throw new Error('unexpected ' + endpoint)
      },
      async get() { throw new Error('unexpected get') },
    }
    const provider = new SandboxKycProvider(fake as any)
    const ok = await provider.verifyPan({ pan: 'AAPFU0939F', name: 'RAMESH PATIL', dob: '02/06/1988' })
    check('PAN: documented endpoint, name + dob sent', calls[0].endpoint === '/kyc/pan/verify' && calls[0].payload.name_as_per_pan === 'RAMESH PATIL' && calls[0].payload.date_of_birth === '02/06/1988' && calls[0].payload.consent === 'Y', JSON.stringify(calls[0]))
    check('PAN: valid + matches → verified', ok.verified && ok.details.aadhaar_seeding_status === 'y', JSON.stringify(ok))
    const wrong = await provider.verifyPan({ pan: 'AAPFU0939F', name: 'SOMEONE ELSE', dob: '02/06/1988' })
    check('PAN: name mismatch → not verified, with the reason', !wrong.verified && /name/i.test(wrong.reason ?? ''), JSON.stringify(wrong.reason))
    const noDob = await provider.verifyPan({ pan: 'AAPFU0939F' })
    check('PAN: without name/dob the call is not made (unavailable, not failed)', noDob.unavailable && calls.length === 2, JSON.stringify(noDob.reason))
    const g = await provider.verifyGstin({ gstin: '27AAPFU0939F1ZV' })
    check('GSTIN: public verify endpoint, active → verified with legal name', calls[2].endpoint === '/gst/compliance/public/gstin/verify' && g.verified && g.name === 'Sample Transport', JSON.stringify(g))
    const cancelled = await provider.verifyGstin({ gstin: '29AAPFU0939F1ZV' })
    check('GSTIN: cancelled → not verified, reason says so', !cancelled.verified && /cancelled/i.test(cancelled.reason ?? ''), JSON.stringify(cancelled.reason))
  }

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
