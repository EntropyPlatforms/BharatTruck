/**
 * bt-booking-service — unit test for the Document AI Invoice-Parser -> fields mapping
 * (src/lib/documents/invoice-ocr.ts). Pure: no network, no processor, no credentials. Proves the
 * risky part of invoice OCR — mapping typed entities to the prefill fields, dropping mis-read
 * GSTINs, and reading money from both a structured moneyValue and a currency-formatted string.
 *
 * Run: npx tsx test/invoice-ocr.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { parseInvoiceEntities, mergeInvoiceFields } = await import('../src/lib/documents/invoice-ocr.js')

  console.log('\n── parseInvoiceEntities: Document AI invoice entities -> prefill fields ──')

  const full = parseInvoiceEntities({
    text: 'invoice',
    entities: [
      { type: 'supplier_tax_id', mentionText: '27AAPFU0939F1ZV' },
      { type: 'receiver_tax_id', mentionText: '29AABCA1234A1Z5' },
      { type: 'supplier_name', mentionText: 'Acme Traders Pvt Ltd' },
      { type: 'receiver_name', mentionText: 'Anita\nTraders' },
      { type: 'invoice_id', mentionText: 'INV-2026-001' },
      { type: 'invoice_date', normalizedValue: { text: '2026-09-19' } },
      { type: 'total_amount', normalizedValue: { moneyValue: { units: '52500', nanos: 0 } } },
      { type: 'net_amount', normalizedValue: { moneyValue: { units: '50000' } } },
      { type: 'total_tax_amount', mentionText: '₹2,500.00' },
      { type: 'line_item', properties: [{ type: 'line_item/description', mentionText: 'Steel rods' }] },
      { type: 'line_item', properties: [{ type: 'line_item/description', mentionText: 'Cement' }] },
    ],
  })

  check('seller GSTIN read', full.seller_gstin === '27AAPFU0939F1ZV', full.seller_gstin)
  check('buyer GSTIN read', full.buyer_gstin === '29AABCA1234A1Z5', full.buyer_gstin)
  check('supplier name', full.supplier_name === 'Acme Traders Pvt Ltd', full.supplier_name)
  check('buyer name newline collapsed', full.buyer_name === 'Anita Traders', full.buyer_name)
  check('invoice number', full.doc_no === 'INV-2026-001', full.doc_no)
  check('invoice date', full.doc_date === '2026-09-19', full.doc_date)
  check('total from moneyValue units', full.total_value === 52500, String(full.total_value))
  check('taxable from moneyValue units', full.taxable_value === 50000, String(full.taxable_value))
  check('tax parsed from "₹2,500.00" text', full.total_tax === 2500, String(full.total_tax))
  check('item_count = number of line_item entities', full.item_count === 2, String(full.item_count))

  console.log('\n── robustness ──')

  // A mis-read tax id that is not a valid GSTIN is dropped, never prefilled onto a statutory doc.
  const garbled = parseInvoiceEntities({ entities: [{ type: 'supplier_tax_id', mentionText: '27AAP-garbled' }] })
  check('invalid GSTIN dropped', garbled.seller_gstin === undefined, garbled.seller_gstin)

  // moneyValue units + nanos combine to a decimal.
  const withNanos = parseInvoiceEntities({ entities: [{ type: 'total_amount', normalizedValue: { moneyValue: { units: '100', nanos: 500000000 } } }] })
  check('units + nanos -> 100.5', withNanos.total_value === 100.5, String(withNanos.total_value))

  // A sparse document prefills only what it has; everything else is undefined (not 0/empty).
  const sparse = parseInvoiceEntities({ entities: [{ type: 'invoice_id', mentionText: 'A/42' }] })
  check('sparse: doc_no set', sparse.doc_no === 'A/42')
  check('sparse: total undefined (not 0)', sparse.total_value === undefined)
  check('sparse: item_count undefined when no line items', sparse.item_count === undefined)

  // Empty document -> all undefined, never a throw.
  const empty = parseInvoiceEntities({})
  check('empty doc -> no fields, no throw', Object.values(empty).every((v) => v === undefined))

  console.log('\n── mergeInvoiceFields: Invoice-Parser entities + text reader ──')
  {
    // A transporter's LR: the parser reads the CARRIER as the supplier and the freight as the
    // total. The text reader knows better and must win outright.
    const lr = mergeInvoiceFields(
      { supplier_name: 'Sample Logistics Ltd', seller_gstin: '27AAPFU0939F1ZV', total_value: 3976, doc_no: '1105854020' },
      { doc_type: 'consignment_note', supplier_name: 'Sample Clothing CO', seller_gstin: undefined, total_value: 127552, doc_no: '2026-27/12', eway_bill_no: '652126029067', freight_inr: 3976 },
    )
    check('LR: text reader wins on the parties and the goods invoice', lr.supplier_name === 'Sample Clothing CO' && lr.doc_no === '2026-27/12' && lr.total_value === 127552, JSON.stringify(lr))
    check('LR: a field the text reader left blank keeps the parser value', lr.seller_gstin === '27AAPFU0939F1ZV', String(lr.seller_gstin))
    check('LR: extra fields carried', lr.eway_bill_no === '652126029067' && lr.freight_inr === 3976 && lr.doc_type === 'consignment_note', JSON.stringify(lr))

    const inv = mergeInvoiceFields(
      { doc_no: 'INV-1', total_value: 150, taxable_value: 143.14 },
      { doc_type: 'tax_invoice', doc_no: 'A009390', total_value: 150, cgst: 3.58, sgst: 3.58, total_tax: 7.16 },
    )
    check('invoice: parser wins where it has a value', inv.doc_no === 'INV-1' && inv.taxable_value === 143.14, JSON.stringify(inv))
    check('invoice: text fills the gaps and names the type', inv.cgst === 3.58 && inv.total_tax === 7.16 && inv.doc_type === 'tax_invoice', JSON.stringify(inv))

    const textOnly = mergeInvoiceFields({}, { doc_type: 'receipt', doc_no: '03B-2025-061234', total_value: 4130 })
    check('no entities (plain OCR processor): text alone', textOnly.doc_no === '03B-2025-061234' && textOnly.total_value === 4130 && textOnly.doc_type === 'receipt', JSON.stringify(textOnly))
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.error('  x ' + f); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
