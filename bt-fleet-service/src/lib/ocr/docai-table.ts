// -----------------------------------------------------------
// docai-table — turn a Google Document AI `process` response into CSV text.
//
// WHY THIS IS ITS OWN (pure) MODULE: this is the only risky part of OCR — reconstructing a
// table from Document AI's text-anchor offsets. Keeping it pure (Document AI JSON in, CSV out,
// no network, no auth) makes it unit-testable against a captured response, so the parsing is
// proven without a live processor or credentials.
//
// The output is CSV on purpose: it feeds straight into the EXISTING, battle-tested
// importVehiclesCsv pipeline (header aliasing, per-row zod validation, model_category check,
// dedupe, per-row insert + error report). OCR adds an input format; it does not add a second,
// unvalidated write path.
// -----------------------------------------------------------

import { FleetError } from '../types.js'

// Minimal shape of the Document AI v1 `Document` we read. Everything is optional because a real
// response omits empty collections, and int64 offsets arrive as STRINGS in JSON.
export interface DocAiTextSegment {
  startIndex?: string
  endIndex?: string
}
export interface DocAiLayout {
  textAnchor?: { textSegments?: DocAiTextSegment[] }
}
export interface DocAiTableCell {
  layout?: DocAiLayout
}
export interface DocAiTableRow {
  cells?: DocAiTableCell[]
}
export interface DocAiTable {
  headerRows?: DocAiTableRow[]
  bodyRows?: DocAiTableRow[]
}
export interface DocAiPage {
  tables?: DocAiTable[]
}
export interface DocAiDocument {
  text?: string
  pages?: DocAiPage[]
}

/** Slice a cell's text out of the document's flat `text` using its text-anchor segments. */
function cellText(fullText: string, cell: DocAiTableCell): string {
  const segments = cell.layout?.textAnchor?.textSegments ?? []
  let out = ''
  for (const seg of segments) {
    // A first segment often omits startIndex (meaning 0). endIndex is exclusive.
    const start = seg.startIndex ? Number(seg.startIndex) : 0
    const end = seg.endIndex ? Number(seg.endIndex) : 0
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      out += fullText.slice(start, end)
    }
  }
  // Cells hold newlines and stray whitespace from layout; collapse to a single clean line so a
  // header like "RC\nNumber" maps, and a value never smuggles a newline into the CSV.
  return out.replace(/\s+/g, ' ').trim()
}

const rowCells = (fullText: string, row: DocAiTableRow): string[] =>
  (row.cells ?? []).map((c) => cellText(fullText, c))

/** A field is quoted only when it must be (RFC-4180), so the output stays human-readable. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

const toCsvLine = (fields: string[]): string => fields.map(csvField).join(',')

/**
 * Pick the table that is actually the vehicle register: the one with the most body rows across
 * all pages. A scanned register sometimes yields small spurious tables (a title block, a stamp);
 * the real data table is the largest.
 */
function largestTable(doc: DocAiDocument): DocAiTable | null {
  let best: DocAiTable | null = null
  let bestRows = 0
  for (const page of doc.pages ?? []) {
    for (const table of page.tables ?? []) {
      const n = table.bodyRows?.length ?? 0
      if (n > bestRows) { best = table; bestRows = n }
    }
  }
  return best
}

/**
 * extractTableCsv — Document AI `Document` -> CSV text (header line + one line per body row).
 *
 * Throws a 422 FleetError when the document has no usable table, so a blank or non-tabular
 * scan gives the owner a clear "couldn't read a table" message instead of a silent empty import.
 */
export function extractTableCsv(doc: DocAiDocument): string {
  const fullText = doc.text ?? ''
  const table = largestTable(doc)
  if (!table) {
    throw new FleetError(
      'No table found in the document. Make sure the page shows your truck list as a table, or upload a CSV.',
      'VALIDATION_ERROR',
      422,
    )
  }

  // Header: the table's declared header row, else the first body row (some scans put the header
  // in the body). Either way importVehiclesCsv maps the names via its alias table.
  const headerRow = table.headerRows?.[0] ?? table.bodyRows?.[0]
  const header = headerRow ? rowCells(fullText, headerRow) : []
  if (header.length === 0 || header.every((h) => h === '')) {
    throw new FleetError(
      'Could not read a header row (e.g. RC number, model category) from the document.',
      'VALIDATION_ERROR',
      422,
    )
  }

  // Body rows: all bodyRows, minus the first if it was borrowed as the header above.
  const body = table.headerRows?.length ? (table.bodyRows ?? []) : (table.bodyRows ?? []).slice(1)

  const lines = [toCsvLine(header)]
  for (const row of body) {
    const cells = rowCells(fullText, row)
    // Skip a fully-empty row — OCR often emits a trailing blank row for a table border.
    if (cells.some((c) => c !== '')) lines.push(toCsvLine(cells))
  }

  if (lines.length < 2) {
    throw new FleetError(
      'The document had a header but no data rows the reader could extract.',
      'VALIDATION_ERROR',
      422,
    )
  }

  return lines.join('\n')
}
