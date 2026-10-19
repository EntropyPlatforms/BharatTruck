/**
 * bt-fleet-service — unit test for the Document AI table -> CSV parser (src/lib/ocr/docai-table.ts).
 * Pure: no network, no credentials, no processor. Proves the one risky part of OCR — turning
 * Document AI's text-anchor offsets back into a CSV the existing importer can validate.
 *
 * Run: npx tsx test/ocr-table.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { extractTableCsv } = await import('../src/lib/ocr/docai-table.js')
  type Doc = Parameters<typeof extractTableCsv>[0]

  // Build a Document AI-shaped doc from a grid, computing real text-anchor offsets into `text`.
  // The first row is the header. A newline separates cells in `text` but sits OUTSIDE each
  // segment, mirroring how Document AI lays a table out in the flat document text.
  function docFromGrid(header: string[], body: string[][]): Doc {
    let text = ''
    const cellRow = (cells: string[]) => ({
      cells: cells.map((c) => {
        const startIndex = String(text.length)
        text += c
        const endIndex = String(text.length)
        text += '\n'
        return { layout: { textAnchor: { textSegments: [{ startIndex, endIndex }] } } }
      }),
    })
    const headerRows = [cellRow(header)]
    const bodyRows = body.map(cellRow)
    return { text, pages: [{ tables: [{ headerRows, bodyRows }] }] }
  }

  console.log('\n── extractTableCsv: Document AI table -> CSV ──')

  // 1. A normal register table.
  const csv = extractTableCsv(
    docFromGrid(
      ['RC Number', 'Model Category', 'Year'],
      [['MH12AB1234', 'MCV', '2019'], ['MH14CD5678', 'LCV', '2021']],
    ),
  )
  const lines = csv.split('\n')
  check('header + 2 rows -> 3 CSV lines', lines.length === 3, JSON.stringify(csv))
  check('header row preserved verbatim', lines[0] === 'RC Number,Model Category,Year', lines[0])
  check('first data row', lines[1] === 'MH12AB1234,MCV,2019', lines[1])
  check('second data row', lines[2] === 'MH14CD5678,LCV,2021', lines[2])

  // 2. A value containing a comma is RFC-4180 quoted, so a "Tata, LPT" model never splits a row.
  const csv2 = extractTableCsv(docFromGrid(['rc_number', 'maker_model'], [['MH12AB1234', 'Tata, LPT 1613']]))
  check('comma in a value is quoted', csv2.split('\n')[1] === 'MH12AB1234,"Tata, LPT 1613"', csv2)

  // 3. A cell's internal newline/whitespace is collapsed (a wrapped "RC\nNumber" header maps).
  const wrapped: Doc = {
    text: 'RC\nNumber',
    pages: [{ tables: [{
      headerRows: [{ cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '0', endIndex: '9' }] } } }] }],
      bodyRows: [{ cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '0', endIndex: '9' }] } } }] }],
    }] }],
  }
  check('internal whitespace collapses to one space', extractTableCsv(wrapped).split('\n')[0] === 'RC Number')

  // 4. A fully-empty body row (a table border artefact) is dropped, not emitted as a blank line.
  const withBlank = docFromGrid(['rc_number', 'model_category'], [['MH12AB1234', 'MCV'], ['', '']])
  check('empty row is skipped', extractTableCsv(withBlank).split('\n').length === 2, extractTableCsv(withBlank))

  // 5. No table at all -> a clear throw, never a silent empty import.
  let threw = false
  try { extractTableCsv({ text: 'just some prose', pages: [{ tables: [] }] }) } catch { threw = true }
  check('no table -> throws', threw)

  // 6. The largest table wins (a title/stamp block must not shadow the real register).
  const twoTables: Doc = {
    text: 'StampAAABBBCCCDDD',
    pages: [{ tables: [
      // a 1-row noise table
      { headerRows: [{ cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '0', endIndex: '5' }] } } }] }], bodyRows: [] },
      // the real 2-row table (header AAA, rows BBB/CCC)
      {
        headerRows: [{ cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '5', endIndex: '8' }] } } }] }],
        bodyRows: [
          { cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '8', endIndex: '11' }] } } }] },
          { cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: '11', endIndex: '14' }] } } }] },
        ],
      },
    ] }],
  }
  check('largest table is chosen', extractTableCsv(twoTables).split('\n')[0] === 'AAA', extractTableCsv(twoTables))

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.error('  x ' + f); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
