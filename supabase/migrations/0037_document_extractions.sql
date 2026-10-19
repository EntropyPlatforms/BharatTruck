-- migration 0037: document_extractions — QR-scan / OCR results, in a SEPARATE table.
--
-- WHY THIS EXISTS
-- A driver re-typing a 12-digit e-way bill number at the gate is error-prone, and the e-way bill
-- and GST e-invoice already carry a NIC-signed QR that holds those fields exactly. Scanning it
-- prefills the freight-documents form; OCR (later, vendor-backed) does the same for handwritten
-- paper bills. Two hard rules from INDIA_FREIGHT_COMPLIANCE.md shape this table:
--
--   1. Extraction results live in their OWN table, never written onto a document/POD record — a
--      scan/OCR is a PREFILL, and a human confirms it by saving the actual LR/invoice/e-way row.
--      This table is the audit of what was scanned; the issued document is the source of truth.
--   2. OCR must run on a DERIVATIVE, never the byte-preserved POD original (§5.4). QR scanning
--      does not touch the POD photo at all — it reads the shipper's own document QR.
--
-- Forward-only, idempotent; baseline regenerated from prod after apply.

create table if not exists public.document_extractions (
  id           uuid        default gen_random_uuid() not null primary key,
  booking_id   uuid        not null references public.bookings(id) on delete cascade,
  -- What was read. 'unknown' records a scan we could not classify, so a failed scan is still
  -- auditable rather than silently dropped.
  kind         text        not null check (kind in ('eway_qr', 'einvoice_qr', 'ocr', 'unknown')),
  source       text        not null check (source in ('qr', 'ocr')),
  -- The raw scanned QR string (null for OCR, whose input is an image held elsewhere). Kept so a
  -- mis-parse can be re-examined against the exact bytes the device read.
  raw_payload  text,
  -- The structured fields the parser produced — exactly what prefilled the form.
  parsed_json  jsonb       not null default '{}'::jsonb,
  created_by   uuid        references public.users(id),
  created_at   timestamptz not null default now()
);

comment on table public.document_extractions is
  'QR-scan / OCR extractions that PREFILL the freight-documents form (never the source of truth — the issued LR/invoice/e-way row is). Separate table per INDIA_FREIGHT_COMPLIANCE.md; OCR runs on a derivative, never the POD original (§5.4).';

create index if not exists document_extractions_booking_idx
  on public.document_extractions (booking_id, created_at desc);

-- Service-only, deny-all for anon/authenticated; service_role bypasses. The rule 0033 enforces.
alter table public.document_extractions enable row level security;
