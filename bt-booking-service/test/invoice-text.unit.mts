/**
 * bt-booking-service — the text-based freight-paperwork reader (src/lib/documents/invoice-text.ts).
 *
 * Three documents transcribed the way OCR returns them (labels and values on their own lines, the
 * page's order not the layout's): a transporter's consignment note, a GST tax invoice with
 * HSN lines, and a plain bill/receipt. Every name, number and GSTIN is invented; the GSTINs that
 * must be kept carry a correctly computed check character.
 *
 * Run: npx tsx test/invoice-text.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function withCheck(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) { const p = ALPHABET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36) }
  return first14 + ALPHABET[(36 - (sum % 36)) % 36]
}
const TRANSPORTER = withCheck('29AABCV0001C1Z')
const CONSIGNOR = withCheck('24BNCPD0002E1Z')
const CONSIGNEE = withCheck('29CNIPM0003K2Z')
const SELLER = withCheck('24AABCP0004L2Z')

async function main() {
  const { parseInvoiceText, countInvoiceFields, isValidGstin, normaliseGstin } = await import('../src/lib/documents/invoice-text.js')

  console.log('\n── GSTIN check ──')
  check('the canonical published example validates', isValidGstin('27AAPFU0939F1ZV'), '')
  check('a computed check character validates', isValidGstin(CONSIGNOR), CONSIGNOR)
  check('shape-only impostor refused', !isValidGstin('99ZZZZZ9999Z9Z9'), '')
  check('OCR slips corrected by position (O→0 in the digits, 0→O in the letters)', normaliseGstin(CONSIGNOR.replace('0002', 'OOO2').replace('BNC', '8NC')) === CONSIGNOR, String(normaliseGstin(CONSIGNOR.replace('0002', 'OOO2'))))

  console.log('\n── transporter consignment note (LR), photographed sideways ──')
  {
    // The letterhead GSTIN is printed with a space in the middle, as OCR often returns it.
    const f = parseInvoiceText(`
      SAMPLE LOGISTICS LTD
      REGISTERED OFFICE : NH4, HUBBALLI
      TOLL FREE NO. : 1800 000 0000
      TRANSPORTER ID : ${TRANSPORTER.slice(0, 12)} ${TRANSPORTER.slice(12)}
      CONSIGNEE'S COPY
      1105854020
      FROM : AHMEDABAD LATHI BAZAR
      Booking Date : 10-06-2026
      Articles : 5
      TO : SIRA
      KA-SRA-Phone : 9500000000
      Consignor
      SAMPLE CLOTHING CO
      ADILTB-Phone : 8700000000
      GSTIN : ${CONSIGNOR} ***
      Consignee
      SAMPLE FASHIONS
      GSTIN : ${CONSIGNEE} ***
      Invoice No : 2026-27/12
      Invoice Value Rs : 127552
      EwayNo : 652126029067
      A.Weight : 240.00
      C.Weight : 480
      Rate : 8.00
      PartyCode : 0
      PAN No : BNCPD0002E
      Description (said to contain)
      PB READY MADE GOODS (BOX PACKING)
      TOPAY
      GODOWN
      Service Category : Transport of Goods By Road
      SAC NO : 996511
      Freight 3840
      Stationary charges 40
      Hamali/Handling charges 96
      Total 3976
      1105854020
      Bank Details For NEFT/RTGS
      IFSC Code : ICIC0000157
    `)
    check('recognised as a consignment note', f.doc_type === 'consignment_note', f.doc_type)
    check('consignor GSTIN → seller', f.seller_gstin === CONSIGNOR, String(f.seller_gstin))
    check('consignee GSTIN → buyer', f.buyer_gstin === CONSIGNEE, String(f.buyer_gstin))
    check('transporter GSTIN read across the OCR space', f.transporter_gstin === TRANSPORTER, String(f.transporter_gstin))
    check('consignor / consignee names', f.supplier_name === 'Sample Clothing CO' && f.buyer_name === 'Sample Fashions', JSON.stringify([f.supplier_name, f.buyer_name]))
    check("the SHIPPER's invoice number, not the LR number", f.doc_no === '2026-27/12', String(f.doc_no))
    check('invoice value', f.total_value === 127552, String(f.total_value))
    check('booking date', f.doc_date === '2026-06-10', String(f.doc_date))
    check('e-way bill number', f.eway_bill_no === '652126029067', String(f.eway_bill_no))
    check('LR number = the bare number printed twice', f.lr_no === '1105854020', String(f.lr_no))
    check('chargeable weight = the higher of actual and charged', f.weight_kg === 480, String(f.weight_kg))
    check('freight total and TO PAY', f.freight_inr === 3976 && f.freight_term === 'TO_PAY', JSON.stringify([f.freight_inr, f.freight_term]))
    check('SAC', f.sac_code === '996511', String(f.sac_code))
    check('from / to', f.from_place === 'Ahmedabad Lathi Bazar' && f.to_place === 'Sira', JSON.stringify([f.from_place, f.to_place]))
    check('articles', f.item_count === 5, String(f.item_count))
    check('the bank IFSC is not mistaken for anything', !JSON.stringify(f).includes('ICIC0000157'), '')
  }

  console.log('\n── GST tax invoice with HSN lines (pharmacy style) ──')
  {
    const f = parseInvoiceText(`
      SAMPLE PHARMACY (A DIVISION OF SAMPLE ENTERPRISE LTD.)
      FIRST FLOOR, BLOCK-A, MOTERA, AHMEDABAD - 380005
      D.L. NO. : GJ-AD-2-20-170354  GSTIN : ${SELLER}
      GST INVOICE
      CREDIT
      Invoice No. : A009390
      Date : 26-02-2026
      Due Date : 26-02-2026
      TO
      NAJU DEVI
      PHONE NO :
      SN. PRODUCT NAME MFR HSN CODE BATCH NO. EXP. QTY FREE MRP RATE DISC. SGST CGST AMOUNT
      1. T BACT ONIT 5GM CIPLA 30049099 KN5A 9/26 1 0 108.36 115.00 10.00 2.50 2.50 103.50
      2. SURGICAL GLOVES 7.5 NULIF 40151100 SMC4H25 7/30 1 0 67.00 60.00 52.00 2.50 2.50 28.80
      3. BANDAGE 8*10 POLYM 30012030 CH71A2 4/29 1 0 20.00 20.00 10.00 2.50 2.50 18.00
      CLASS TOTAL SCH. DISC. SGST CGST TOTAL GST
      GST 5 % 195.00 0.00 44.70 3.58 3.58 7.16
      SUB TOTAL 143.14
      SGST PAYABLE 3.58
      CGST PAYABLE 3.58
      CR/DR NOTE 0.00
      GRAND TOTAL 150.00
      Rs. One Hundred and Fifty only
    `)
    check('recognised as a tax invoice', f.doc_type === 'tax_invoice', f.doc_type)
    check('seller GSTIN from the letterhead', f.seller_gstin === SELLER, String(f.seller_gstin))
    check('no buyer GSTIN invented for a walk-in customer', f.buyer_gstin === undefined, String(f.buyer_gstin))
    check('invoice number', f.doc_no === 'A009390', String(f.doc_no))
    check('invoice date', f.doc_date === '2026-02-26', String(f.doc_date))
    check('grand total', f.total_value === 150, String(f.total_value))
    check('sub total → taxable value', f.taxable_value === 143.14, String(f.taxable_value))
    check('CGST + SGST', f.cgst === 3.58 && f.sgst === 3.58 && f.igst === undefined, JSON.stringify([f.cgst, f.sgst, f.igst]))
    check('total tax', f.total_tax === 7.16, String(f.total_tax))
    check('HSN read as the code', f.sac_code === '30049099', String(f.sac_code))
    check('billed-to name', f.buyer_name === 'Naju Devi', String(f.buyer_name))
  }

  console.log('\n── bill / cash receipt (hospital style) ──')
  {
    const f = parseInvoiceText(`
      Sample Hospital
      Eastern Express Highway, Thane (W)
      Bill-Cum-Cash Receipt
      PATHOLOGY
      Bill No. : 03B-2025-061234
      Date / Time : 22/02/2026 / 08:50 AM
      Patient Category : PAY PATIENT
      Mobile No : 9000000000
      Qty. Rate Amount
      1 490.00 490.00
      1 2630.00 2,630.00
      4130.00 4130.00
      Net Amount : 4130.00
      Pat. Paid Amount : 4130.00
      Total Paid Amount : 4,130.00
      Pay Mode Amount Cheque/ Card No. Bank
      Credit Card 4130 XXXXXXXXXXXX9931 hdfc
      Net Amount in Words : Four Thousand One Hundred and Thirty Rupees Only
    `)
    check('recognised as a receipt (no GST lines)', f.doc_type === 'receipt', f.doc_type)
    check('bill number', f.doc_no === '03B-2025-061234', String(f.doc_no))
    check('date', f.doc_date === '2026-02-22', String(f.doc_date))
    check('total', f.total_value === 4130, String(f.total_value))
    check('no GSTIN invented', f.seller_gstin === undefined && f.buyer_gstin === undefined, '')
    check('the masked card number is not a document number', !JSON.stringify(f).includes('9931'), JSON.stringify(f))
  }

  console.log('\n── nothing readable ──')
  {
    const f = parseInvoiceText('blurred\nphoto\n12 34')
    check('unknown type, zero fields', f.doc_type === 'unknown' && countInvoiceFields(f) === 0, JSON.stringify(f))
  }

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
