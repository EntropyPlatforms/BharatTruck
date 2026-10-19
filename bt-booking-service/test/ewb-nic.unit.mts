/**
 * bt-booking-service — the PURE half of NIC e-way bill generation (src/lib/ewb/nic.ts):
 * the Generate payload built from a booking + the shipper's form, GST split, NIC timestamps,
 * NIC business rejections turned into readable errors. No network, no account.
 *
 * Run: npx tsx test/ewb-nic.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { buildGeneratePayload, splitGst, nicDateTimeToIso, toNicDate, nicData, normaliseVehicleNo, EwbError } = await import('../src/lib/ewb/nic.js')

  const facts = {
    shipper_gstin: '27AAPFU0939F1ZV',
    shipper_name: 'Sample Clothing Co',
    source_address: 'Plot 14, MIDC Bhosari, Pune, Maharashtra',
    source_pincode: '411026',
    source_state_code: '27',
    destination_address: '22 Peenya Industrial Area, Bengaluru, Karnataka',
    dest_pincode: '560058',
    dest_state_code: '29',
    weight_kg: 3500,
  }
  const input = {
    document_number: 'INV-2026/12',
    document_date: '2026-10-09',
    consignee_name: 'Sample Fashions',
    consignee_gstin: '29AAPFU0939F1ZV',
    hsn_code: '6109',
    product_name: 'Ready made garments',
    taxable_value_inr: 100000,
    gst_rate: 5 as const,
    total_invoice_value_inr: 105000,
    distance_km: 840,
    vehicle_number: 'mh 12 ab 1234',
    from_place: 'Pune',
    to_place: 'Bengaluru',
  }

  console.log('\n── Generate payload: inter-state ──')
  {
    const p = buildGeneratePayload(facts, input) as any
    check('parties and codes', p.fromGstin === '27AAPFU0939F1ZV' && p.toGstin === '29AAPFU0939F1ZV' && p.fromStateCode === 27 && p.toStateCode === 29 && p.fromPincode === 411026 && p.toPincode === 560058, JSON.stringify(p))
    check('document', p.docType === 'INV' && p.docNo === 'INV-2026/12' && p.docDate === '09/10/2026' && p.supplyType === 'O' && p.subSupplyType === '1' && p.transactionType === 1, JSON.stringify([p.docNo, p.docDate]))
    check('inter-state → IGST only, 5% of 1,00,000', p.igstValue === 5000 && p.cgstValue === 0 && p.sgstValue === 0 && p.totInvValue === 105000 && p.totalValue === 100000, JSON.stringify([p.igstValue, p.cgstValue, p.sgstValue]))
    check('item line: HSN as a number, weight in KGS, IGST rate', p.itemList[0].hsnCode === 6109 && p.itemList[0].quantity === 3500 && p.itemList[0].qtyUnit === 'KGS' && p.itemList[0].igstRate === 5 && p.itemList[0].cgstRate === 0 && p.itemList[0].taxableAmount === 100000, JSON.stringify(p.itemList[0]))
    check('vehicle normalised, Part B present, road, distance as a string', p.vehicleNo === 'MH12AB1234' && p.vehicleType === 'R' && p.transMode === '1' && p.transDistance === '840', JSON.stringify([p.vehicleNo, p.transDistance]))
    check('no transporter id unless given', p.transporterId === undefined, String(p.transporterId))
    check('other charges = total − taxable − tax', p.otherValue === 0, String(p.otherValue))
  }

  console.log('\n── Generate payload: intra-state, unregistered receiver, transporter instead of vehicle ──')
  {
    const p = buildGeneratePayload({ ...facts, dest_state_code: '27', dest_pincode: '400037' }, { ...input, consignee_gstin: null, vehicle_number: null, transporter_id: '27AABCV3609C1ZJ', gst_rate: 18, total_invoice_value_inr: 118500 }) as any
    check('intra-state → CGST + SGST, 9% each', p.cgstValue === 9000 && p.sgstValue === 9000 && p.igstValue === 0 && p.itemList[0].cgstRate === 9 && p.itemList[0].sgstRate === 9, JSON.stringify([p.cgstValue, p.sgstValue]))
    check('unregistered receiver → URP', p.toGstin === 'URP', p.toGstin)
    check('transporter id, no vehicle fields', p.transporterId === '27AABCV3609C1ZJ' && p.vehicleNo === undefined && p.vehicleType === undefined, JSON.stringify([p.transporterId, p.vehicleNo]))
    check('other charges carried', p.otherValue === 500, String(p.otherValue))
  }

  console.log('\n── Generate payload: refusals in the shipper\'s words ──')
  const refuse = (f: any, i: any) => { try { buildGeneratePayload(f, i); return null } catch (e) { return e instanceof EwbError ? e.message : 'not an EwbError' } }
  check('missing state code', /state code/.test(refuse({ ...facts, dest_state_code: '' }, input) ?? ''), String(refuse({ ...facts, dest_state_code: '' }, input)))
  check('missing PIN', /PIN code/.test(refuse({ ...facts, source_pincode: '' }, input) ?? ''), '')
  check('neither vehicle nor transporter', /vehicle number .* or the transporter/.test(refuse(facts, { ...input, vehicle_number: null }) ?? ''), String(refuse(facts, { ...input, vehicle_number: null })))
  check('bad HSN', /HSN/.test(refuse(facts, { ...input, hsn_code: '12' }) ?? ''), '')
  check('bad consignee GSTIN', /Consignee GSTIN/.test(refuse(facts, { ...input, consignee_gstin: 'ABCDE1234' }) ?? ''), '')
  check('total below taxable', /Total invoice value/.test(refuse(facts, { ...input, total_invoice_value_inr: 90000 }) ?? ''), '')
  check('invoice number over Rule 46(b)', /Rule 46/.test(refuse(facts, { ...input, document_number: 'INV 2026 12 extra long' }) ?? ''), '')

  console.log('\n── GST split, dates, vehicle ──')
  check('paise-exact split with the odd paisa on SGST', JSON.stringify(splitGst(1000.05, 18, false)) === JSON.stringify({ cgst: 90, sgst: 90.01, igst: 0 }), JSON.stringify(splitGst(1000.05, 18, false)))
  check('zero rate', JSON.stringify(splitGst(5000, 0, true)) === JSON.stringify({ cgst: 0, sgst: 0, igst: 0 }), '')
  check('NIC PM timestamp → ISO IST', nicDateTimeToIso('01/05/2024 07:56:00 PM') === '2024-05-01T19:56:00+05:30', String(nicDateTimeToIso('01/05/2024 07:56:00 PM')))
  check('NIC "23:59:00 PM" quirk', nicDateTimeToIso('21/05/2024 23:59:00 PM') === '2024-05-21T23:59:00+05:30', String(nicDateTimeToIso('21/05/2024 23:59:00 PM')))
  check('12 AM is midnight', nicDateTimeToIso('21/05/2024 12:05:00 AM') === '2024-05-21T00:05:00+05:30', String(nicDateTimeToIso('21/05/2024 12:05:00 AM')))
  check('unreadable timestamp → null, never a guess', nicDateTimeToIso('soon') === null && nicDateTimeToIso(undefined) === null, '')
  check('ISO → NIC date', toNicDate('2026-10-09') === '09/10/2026', '')
  check('vehicle number stripped', normaliseVehicleNo('ka-05 mm 1234') === 'KA05MM1234', '')

  console.log('\n── NIC answers ──')
  {
    const ok = nicData<{ ewayBillNo: number }>({ data: { status: '1', data: { ewayBillNo: 291010077005 } } }, 'Generating')
    check('status 1 → data', ok.ewayBillNo === 291010077005, '')
    const fail = (res: any) => { try { nicData(res, 'Generating the e-way bill'); return null } catch (e) { return e instanceof EwbError ? { m: e.message, s: e.httpStatus, c: e.code } : null } }
    const r1 = fail({ data: { status: '0', error: { errorCodes: '382' } } })
    check('status 0 with a known code → readable 422', r1?.s === 422 && r1.c === 'NIC_REJECTED' && /8 hours/.test(r1.m), JSON.stringify(r1))
    const r2 = fail({ data: { status: '0', error: { errorCodes: '312,' } } })
    check('trailing comma in codes tolerated', /cannot be cancelled/.test(r2?.m ?? ''), JSON.stringify(r2))
    const r3 = fail({ data: { status: '0', error: { errorCodes: 9999 } } })
    check('unknown code named', /NIC error 9999/.test(r3?.m ?? ''), JSON.stringify(r3))
    const r4 = fail({ data: {} })
    check('no status at all → no result', /no result/.test(r4?.m ?? ''), JSON.stringify(r4))
  }

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
