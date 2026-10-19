# Task: `feat/bt-app-shipper-docs`

**Relates to:** `docs/ARCHITECTURE_UNIFIED_IDENTITY.md §6.4`, `INDIA_FREIGHT_COMPLIANCE.md`
(invoice rules), and the memory note `bharattruck-unified-app-live-2026-08-08` ("Phase 4 —
shipper INVOICE issue + shipper load-detail read view"). Follows PR #106
(`feat/bt-app-freight-docs`) — reuses the `FreightDocuments` component it introduced.

## What this branch adds

The shipper side of the freight-documents surface:

- **Load-detail read** — the `FreightDocuments` card (`GET /bookings/:id/documents`) now renders
  on the shipper's load-detail page (`loads/[id]`), so the shipper sees the consignment note the
  carrier raised plus any invoice / e-way bill, with standing + expiry status.
- **Invoice issue** (`POST /bookings/:id/documents/invoice`) — the shipper raises their **tax
  invoice for the goods**, billed to the consignee. A minimal **interstate** form (billed-to +
  taxable value + optional IGST); the server computes the consignment value + grand total and
  numbers it on the shipper's own series. Issuable `pending` → `completed`; relation-gated so it
  shows only for the shipper.

The carrier LR-issue action stays carrier-only, so the **same component** shows the LR button on
the trip screen (carrier) and the invoice button on the load screen (shipper) — driven by
relation-to-object, not role (D-27). No new migration, no backend change (migration 0024 live).

## Files

- `bt-app/src/lib/types.ts` — `IssueInvoiceInput`.
- `bt-app/src/lib/api.ts` — `issueFreightInvoice`.
- `bt-app/src/components/freight-documents.tsx` — extended with the shipper invoice action.
- `bt-app/src/app/(app)/loads/[id]/page.tsx` — renders `FreightDocuments` for non-cancelled loads.

## Out of scope (follow-ups)

- Intra-state invoice (CGST + SGST split) — this slice covers interstate (IGST), BharatTruck's focus.
- E-way bill record + status UI (`POST /documents/eway-bill`, `PATCH …/:ewbNumber`).
- Printable / downloadable document view.

## Verification

- `bt-app npm run build` → clean (tsc + next build).
- Live smoke test through the gateway with a **demo-shipper** token: `GET /documents` reads the
  shipper's own load; `POST /documents/invoice` with an empty body → **400** `billed_to_name:
  Required` (validates before any serial is allocated — route deployed, no serial burned).
- API-contract + build verification, not browser-automation UI checks (founder's rule).
