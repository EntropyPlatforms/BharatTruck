import { z } from 'zod'
import { createVehicle, type CreateVehicleInput } from './vehicles-repo.js'
import { listModelCategories } from './economics.js'
import { getOcrProvider } from './ocr/provider.js'
import { FleetError } from './types.js'

// -----------------------------------------------------------
// bulk-import — onboarding a whole fleet in one paste.
//
// CSV is fully implemented: RFC-4180 parsing (quoted fields, embedded commas and
// newlines, doubled quotes, CRLF), header mapping onto the vehicles columns, and
// PER-ROW validation so one bad line does not reject the file. Rows are inserted
// individually for the same reason — a batch insert fails wholesale on a single
// duplicate RC number, and a fleet's spreadsheet always has one.
//
// PDF / image ingestion now runs through the OCR seam (src/lib/ocr/provider.ts): Document AI
// extracts the register table, and the SAME importVehiclesCsv path below validates and inserts
// it — so OCR is an input format, never a second, unvalidated write path. OCR is inert until a
// provider is configured (a scan is then read; until then pdf/image get an honest 501). xlsx
// stays unsupported: no workbook parser exists and Document AI does not read spreadsheets, so
// export-to-CSV remains the documented workaround.
// -----------------------------------------------------------

export const BULK_ROW_LIMIT = 500

export type BulkImportFormat = 'csv' | 'xlsx' | 'pdf' | 'image'

export type BulkImportError = { row: number; rc_number: string | null; message: string }

export type BulkImportResult = {
  imported: number
  skipped: number
  errors: BulkImportError[]
  vehicles: { id: string; rc_number: string }[]
}

// parseCsv — RFC-4180. Returns raw cells; header mapping happens above it.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise corrupt the first
  // header name and make every column look unknown.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r') { continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  // Trailing field/row (a file that does not end in a newline).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }

  return rows.filter(r => r.some(cell => cell.trim() !== ''))
}

// Header aliases: owners' spreadsheets say "Registration No" or "Truck Number",
// not `rc_number`. Anything unrecognised is ignored rather than fatal.
const HEADER_ALIASES: Record<string, keyof CsvVehicleRow> = {
  rc_number: 'rc_number',
  rc_no: 'rc_number',
  registration_no: 'rc_number',
  registration_number: 'rc_number',
  truck_number: 'rc_number',
  vehicle_number: 'rc_number',
  model_category: 'model_category',
  category: 'model_category',
  emission_norm: 'emission_norm',
  bs_norm: 'emission_norm',
  manufacture_year: 'manufacture_year',
  year: 'manufacture_year',
  model_year: 'manufacture_year',
  capacity_tons: 'capacity_tons',
  capacity: 'capacity_tons',
  payload_tons: 'capacity_tons',
  volume_cuft: 'volume_cuft',
  volume: 'volume_cuft',
  current_odometer_km: 'current_odometer_km',
  odometer_km: 'current_odometer_km',
  odometer: 'current_odometer_km',
  body_type: 'body_type',
  axle_config: 'axle_config',
  maker_model: 'maker_model',
  make_model: 'maker_model',
  fuel_type: 'fuel_type',
  rc_expiry: 'rc_expiry',
}

type CsvVehicleRow = {
  rc_number: string
  model_category: string
  emission_norm?: string
  manufacture_year: string
  capacity_tons?: string
  volume_cuft?: string
  current_odometer_km?: string
  body_type?: string
  axle_config?: string
  maker_model?: string
  fuel_type?: string
  rc_expiry?: string
}

function normaliseHeader(raw: string): keyof CsvVehicleRow | null {
  const key = raw.trim().toLowerCase().replace(/[\s.-]+/g, '_').replace(/[^a-z0-9_]/g, '')
  return HEADER_ALIASES[key] ?? null
}

const optionalNumber = (label: string, min: number, max: number) =>
  z.string().trim().optional()
    .transform(v => (v === undefined || v === '' ? null : Number(v)))
    .refine(v => v === null || (Number.isFinite(v) && v >= min && v <= max), `${label} is not a valid number`)

const RowSchema = z.object({
  rc_number: z.string().trim().min(4, 'rc_number is required').max(20, 'rc_number is too long'),
  model_category: z.string().trim().min(1, 'model_category is required'),
  emission_norm: z.string().trim().optional()
    .transform(v => (v ? v.toUpperCase().replace(/[\s-]+/g, '_') : null))
    .refine(v => v === null || v === 'BS4' || v === 'BS6' || v === 'BS6_PH2',
      'emission_norm must be BS4, BS6 or BS6_PH2'),
  manufacture_year: z.string().trim().min(4, 'manufacture_year is required')
    .transform(v => Number(v))
    .refine(v => Number.isInteger(v) && v >= 1990 && v <= 2100, 'manufacture_year must be between 1990 and 2100'),
  capacity_tons: optionalNumber('capacity_tons', 0.1, 100),
  volume_cuft: optionalNumber('volume_cuft', 1, 100000),
  current_odometer_km: optionalNumber('current_odometer_km', 0, 5_000_000),
  body_type: z.string().trim().optional(),
  axle_config: z.string().trim().optional(),
  maker_model: z.string().trim().optional(),
  fuel_type: z.string().trim().optional(),
  rc_expiry: z.string().trim().optional(),
})

// importVehiclesCsv — parse, validate per row, insert one at a time, and report
// exactly which spreadsheet line failed and why.
export async function importVehiclesCsv(fleetOwnerId: string, csv: string): Promise<BulkImportResult> {
  const rows = parseCsv(csv)
  if (rows.length < 2) {
    throw new FleetError('CSV must have a header row and at least one vehicle row', 'VALIDATION_ERROR', 400)
  }

  const headers = rows[0].map(normaliseHeader)
  if (!headers.includes('rc_number')) {
    throw new FleetError('CSV header must include an rc_number (or registration_no) column', 'VALIDATION_ERROR', 400)
  }
  if (!headers.includes('model_category')) {
    throw new FleetError('CSV header must include a model_category column', 'VALIDATION_ERROR', 400)
  }

  const dataRows = rows.slice(1)
  if (dataRows.length > BULK_ROW_LIMIT) {
    throw new FleetError(`CSV has ${dataRows.length} rows; the limit is ${BULK_ROW_LIMIT} per upload`, 'VALIDATION_ERROR', 400)
  }

  const validCategories = new Set(await listModelCategories())
  const result: BulkImportResult = { imported: 0, skipped: 0, errors: [], vehicles: [] }
  const seenRcNumbers = new Set<string>()

  for (let i = 0; i < dataRows.length; i++) {
    // +2: one for the header, one because spreadsheets are 1-indexed — this number
    // must point at the line the owner is looking at.
    const lineNo = i + 2
    const cells = dataRows[i]
    const raw: Record<string, string> = {}
    headers.forEach((header, idx) => {
      if (header) raw[header] = (cells[idx] ?? '').trim()
    })

    const parsed = RowSchema.safeParse(raw)
    if (!parsed.success) {
      result.skipped++
      result.errors.push({ row: lineNo, rc_number: raw.rc_number || null, message: parsed.error.errors[0].message })
      continue
    }
    const row = parsed.data

    if (!validCategories.has(row.model_category)) {
      result.skipped++
      result.errors.push({
        row: lineNo,
        rc_number: row.rc_number,
        message: `Unknown model_category '${row.model_category}'`,
      })
      continue
    }
    // Catch duplicates inside the file itself, which the DB would report as a
    // confusing "already registered" on the second occurrence.
    if (seenRcNumbers.has(row.rc_number)) {
      result.skipped++
      result.errors.push({ row: lineNo, rc_number: row.rc_number, message: 'Duplicate rc_number within this file' })
      continue
    }
    seenRcNumbers.add(row.rc_number)

    const input: CreateVehicleInput = {
      rc_number: row.rc_number,
      model_category: row.model_category,
      manufacture_year: row.manufacture_year,
      emission_norm: row.emission_norm,
      capacity_tons: row.capacity_tons,
      volume_cuft: row.volume_cuft,
      current_odometer_km: row.current_odometer_km,
      body_type: row.body_type || null,
      axle_config: row.axle_config || null,
      maker_model: row.maker_model || null,
      fuel_type: row.fuel_type || null,
      rc_expiry: row.rc_expiry || null,
    }

    try {
      const vehicle = await createVehicle(fleetOwnerId, input)
      result.imported++
      result.vehicles.push({ id: vehicle.id, rc_number: vehicle.rc_number })
    } catch (err) {
      result.skipped++
      result.errors.push({
        row: lineNo,
        rc_number: row.rc_number,
        message: err instanceof FleetError ? err.message : 'Could not save this vehicle',
      })
    }
  }

  return result
}

// assertParserAvailable — the honest boundary. csv is parsed here; pdf/image go through the OCR
// seam (which itself returns a clean 501 when no provider is configured). Only xlsx has no path
// at all — no workbook parser, and Document AI does not read spreadsheets.
export function assertParserAvailable(format: BulkImportFormat): void {
  if (format === 'csv' || format === 'pdf' || format === 'image') return
  throw new FleetError(
    `Bulk import from ${format} is not supported. Export the sheet to CSV, ` +
    'or upload a PDF/image scan to read it with OCR.',
    'NOT_IMPLEMENTED',
    501,
  )
}

// importVehiclesFromDocument — OCR a PDF/image register into CSV via the configured provider,
// then run it through the EXACT same validate-and-insert path as a hand-uploaded CSV. The
// provider throws a 501 when OCR is not enabled, so the caller degrades to "upload a CSV".
export async function importVehiclesFromDocument(
  fleetOwnerId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<BulkImportResult> {
  const csv = await getOcrProvider().extractCsv(bytes, mimeType)
  return importVehiclesCsv(fleetOwnerId, csv)
}
