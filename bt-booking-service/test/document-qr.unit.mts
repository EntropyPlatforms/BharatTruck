/**
 * bt-booking-service — parsing the NIC-signed QR on a GST e-invoice / e-way bill into the
 * fields that prefill the freight-documents form. Pure, so the extraction logic is tested
 * without a database or a camera.
 *
 * Run: npx tsx test/document-qr.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

async function main() {
  const { parseDocumentQr } = await import('../src/lib/documents/qr.js')

  console.log('\n── GST e-invoice QR (JWS with nested `data`) ──')
  const invoice = {
    SellerGstin: '27ABCDE1234F1Z5', BuyerGstin: '29PQRSX6789K2Z1',
    DocNo: 'INV/2026/42', DocTyp: 'INV', DocDt: '15/09/2026',
    TotInvVal: 152400.5, ItemCnt: 7, MainHsnCode: '8708',
    Irn: 'a'.repeat(64), IrnDt: '2026-09-15 10:30:00',
  }
  const jws = [b64u('{"alg":"RS256"}'), b64u(JSON.stringify({ data: JSON.stringify(invoice) })), 'signature'].join('.')
  const r1 = parseDocumentQr(jws)
  check('detected as einvoice_qr', r1.kind === 'einvoice_qr')
  if (r1.kind === 'einvoice_qr') {
    check('irn parsed', r1.fields.irn === 'a'.repeat(64))
    check('seller gstin parsed', r1.fields.seller_gstin === '27ABCDE1234F1Z5')
    check('buyer gstin parsed', r1.fields.buyer_gstin === '29PQRSX6789K2Z1')
    check('doc no parsed', r1.fields.doc_no === 'INV/2026/42')
    check('total value parsed as number', r1.fields.total_value === 152400.5)
    check('item count parsed (feeds POD expected qty)', r1.fields.item_count === 7)
    check('main hsn parsed', r1.fields.main_hsn === '8708')
  }

  console.log('\n── e-invoice JWS with a FLAT payload (no nested data) ──')
  const jwsFlat = [b64u('{}'), b64u(JSON.stringify(invoice)), 'sig'].join('.')
  const r2 = parseDocumentQr(jwsFlat)
  check('flat payload still detected + parsed', r2.kind === 'einvoice_qr' && r2.kind === 'einvoice_qr' && r2.fields.irn === 'a'.repeat(64))

  console.log('\n── e-way bill QR as JSON ──')
  const ewayJson = JSON.stringify({ EwbNo: '123456789012', EwbDt: '15/09/2026 10:00:00', GenGstin: '27ABCDE1234F1Z5' })
  const r3 = parseDocumentQr(ewayJson)
  check('detected as eway_qr', r3.kind === 'eway_qr')
  if (r3.kind === 'eway_qr') {
    check('12-digit ewb number parsed', r3.fields.ewb_number === '123456789012')
    check('generated_at parsed', r3.fields.generated_at === '15/09/2026 10:00:00')
    check('generator gstin parsed', r3.fields.generated_by_gstin === '27ABCDE1234F1Z5')
  }

  console.log('\n── e-way bill QR as a delimited string (defensive extraction) ──')
  const ewayDelim = '123456789012/15-09-2026/27ABCDE1234F1Z5'
  const r4 = parseDocumentQr(ewayDelim)
  check('detected as eway_qr from a delimited string', r4.kind === 'eway_qr')
  check('the 12-digit number is pulled out (the headline win)',
    r4.kind === 'eway_qr' && r4.fields.ewb_number === '123456789012')
  check('the gstin is pulled out too',
    r4.kind === 'eway_qr' && r4.fields.generated_by_gstin === '27ABCDE1234F1Z5')

  console.log('\n── non-documents / junk ──')
  check('empty string -> unknown', parseDocumentQr('').kind === 'unknown')
  check('random text -> unknown', parseDocumentQr('just some text, no ids here').kind === 'unknown')
  check('a URL with no ids -> unknown', parseDocumentQr('https://example.com/x').kind === 'unknown')
  // A 12-digit number embedded anywhere is treated as an e-way number — acceptable, since a human
  // confirms before the form saves.
  check('a bare 12-digit number -> eway_qr', parseDocumentQr('EWB 123456789012 dispatched').kind === 'eway_qr')

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
