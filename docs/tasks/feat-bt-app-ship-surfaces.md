# feat/bt-app-ship-surfaces — the unified app, Phase 2 (ship surfaces)

**Branch:** `feat/bt-app-ship-surfaces` · **Deleted on merge** (CLAUDE.md §0.4).

Phase 2 of `docs/UNIFIED_APP_PLAN.md`: graft the real **ship** surfaces into `bt-app`, replacing the
`/loads` and `/post` placeholders. Touches **no backend** and not `bt-gateway` — this is purely
`bt-app` frontend, talking to the existing services through the gateway.

## What this grafts (replaces the placeholders)
- **Post a Load** (`src/app/(app)/post/page.tsx`) — ported from `shipper/bookings/new`. Pickup/drop
  address + lat/lng, cargo/vehicle/weight, an **advisory** price quote (`getPriceQuote`, D-11 —
  labelled "reference, not binding"), the **consignee** (name + phone **required**, D-29) and an
  optional receiver email, schedule, and auction/direct routing. Submit → `createBooking` → the new
  load's detail page. Full validation, a submitting state, and an error banner on failure.
- **My Loads** (`src/app/(app)/loads/page.tsx`) — the loads the caller **posted** (`listBookings`,
  kept to `viewer.relations` including `shipper`; falls back to `shipper_id`). Row = route, status
  badge, bid count (auction, best-effort), price, timestamp → `/loads/[id]`.
- **Load detail** (`src/app/(app)/loads/[id]/page.tsx`) — ported from `shipper/bookings/[id]`. Booking
  summary + consignee + the receiver-email/POD editor, the **LiveTrackMap** (drawn for
  accepted/in_transit/delivery_asserted/completed/paid; a clear note otherwise — never a blank map),
  and the bids panel with accept / counter / reject + negotiation history (auction only).

## Supporting changes
- **`src/components/maps/LiveTrackMap.tsx`** — COPIED per Maps decision D-008 (apps do not share the
  map). Reuses this app's `map-guard`, so a missing **or** invalid/over-quota key degrades to a note
  rather than a crash (closes the shipper-side half of BIBLE §5.4 item 10 for this app).
- **`src/components/{receiver-email-section,negotiation-history,counter-modal}.tsx`** — ported helpers,
  restyled to bt-app's light house style.
- **`src/lib/types.ts`** — `Booking` (+ `viewer`/`consignee`), `BookingType`, `ConsigneeParty`/
  `ConsigneeInput`, `QuoteCarrier` (+ `Quote.carrier`), `PriceQuote*`, `TrackData`/`DriverLocation`.
- **`src/lib/api.ts`** — `listBookings`, `getBooking`, `createBooking`, `cancelBooking`,
  `setReceiverEmail`, `getQuotes`, `acceptQuote`, `counterQuote`, `rejectQuote`, `getPriceQuote`
  (+ `quoteKindOf`/`priceQuoteHeading`/`priceQuoteBasis`), `getTrack`, `getBookingLocation` — all in
  the existing `request`/`authRequest` style.
- **`src/lib/nav.ts`** — removed `placeholder: true` from `/loads` and `/post` (now real surfaces).

## No blank screens (the acceptance bar)
Every fetch renders **Loading**, **Empty** (message + CTA), and **Error** (retry). The tracking map
always draws pickup + drop from the booking's own coordinates, so it is never blank even with no live
fix or a failed track call. Bids, tracking, and the booking read each own their three states
independently — a failure in one never blanks the others.

## Deferred
- Phase 3: the drive surfaces (`/my-trips` — still a placeholder).
- Payment settlement panel (not ported here — out of this slice's scope).
