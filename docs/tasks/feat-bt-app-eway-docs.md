# Task: `feat/bt-app-eway-docs`

**Relates to:** `INDIA_FREIGHT_COMPLIANCE.md §4` (e-way bill), D-17 (record + upload, don't
generate), and the memory note `bharattruck-unified-app-live-2026-08-08` ("Phase 4 — e-way-bill
record/status UI"). Follows PR #106/#107; extends the `FreightDocuments` component. Completes the
in-app documents trio: **LR (carrier) → invoice (shipper) → e-way bill (either party)**.

## What this branch adds

- **Record an e-way bill** (`POST /bookings/:id/documents/eway-bill`) — either party enters the
  bill generated on the NIC portal: number (12 digits), generated-at, valid-upto, portal (NIC1/2).
  We **record** it, never generate one (D-17). `valid_upto` is sent verbatim — it cannot be derived
  locally (§4.4: a day's validity expires at midnight of the day *following* generation). Offered
  when no bill currently stands.
- **File the portal's status** (`PATCH /bookings/:id/documents/eway-bill/:ewbNumber`) — mark an
  active bill **cancelled** or **rejected**, so `standing_eway_bill_number` stops pointing at a dead
  number (§4.5). We record the portal's act; we do not enforce the 24h/72h window.

`datetime-local` inputs are converted to RFC3339-`Z` before sending (the Zod `.datetime()`
contract — same detail as the POD `captured_at_device` fix). No new migration, no backend change.

## Files

- `bt-app/src/lib/types.ts` — `RecordEwayBillInput`, `SetEwayBillStatusInput`.
- `bt-app/src/lib/api.ts` — `recordEwayBill`, `setEwayBillStatus`.
- `bt-app/src/components/freight-documents.tsx` — the record form + per-bill cancel/reject controls.
  (No page changes: the card already renders on the trip and load screens.)

## Verification

- `bt-app npm run build` → clean (tsc + next build).
- Live smoke test through the gateway with a demo token: `POST /documents/eway-bill` empty body →
  **400** `ewb_number: Required`; `PATCH …/eway-bill/abc` → **400** `e-way bill number is 12 digits`.
  Routes deployed, guards fire. (Recording an e-way bill allocates NO gapless statutory serial, so
  it is safe to exercise — probes stayed non-mutating regardless.)
- API-contract + build verification, not browser-automation UI checks (founder's rule).

## Out of scope (follow-ups)

- Intra-state invoice (CGST + SGST split); printable / downloadable document view.
- Part-B-entered capture + the carrier-swap block it enables (§9.4).
