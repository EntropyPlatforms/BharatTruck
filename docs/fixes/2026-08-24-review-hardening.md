# Fix report — Review hardening: C-1/C-2 remainders, S-7 compliance, S-6/S-2 UX

**Date:** 2026-08-24 · **Base:** `origin/main@2fa1d7a` · **Branch:** `fix/review-hardening-t123`
**Scope:** the open remainders of the 2026-08-14 platform review, statuses re-verified against the **live prod DB** on 2026-08-23/24 (not repo docs). Live reconciliation upgraded two findings before any code was written: migrations 0030 and 0031 **are applied in prod** (the repo ledger was stale), and zero actionable self-bid rows remain (the one row is the review's own repro, since paid).

---

## Fix 1 — C-1 remainder: self-accept and related-party paths around the self-bid guard

**Issue.** PR #139 blocked the poster's *bid*, but two walk-arounds stayed open: (a) a poster owning a truck could **instant-accept their own posted load** (`acceptBooking` had no shipper-relation refusal — same account on both sides, `award_path='instant'`); (b) the guard was user-account-level only — an **owner-driver attached to the fleet that posted the load** isn't the shipper, so they could bid on (or accept) their own fleet's load: the same fictional auction one hop removed.

**Where it went wrong.** `bt-booking-service/src/lib/service.ts` `acceptBooking` checked capability/employment/targeting but never the caller's relation to the booking. `quote-service.ts` `submitQuote` checked `relationsToBooking(...).includes('shipper')` only; `PersonaSnapshot.affiliated_fleet_owner_ids` existed but was never consulted.

**Solution.**
- `fleet.ts`: new **pure** `bidderIsRelatedParty(affiliatedIds, posterFleetOwnerId)`.
- `submitQuote`: after the self-bid refusal, resolves the poster's fleet (`getFleetOwnerByUserId(booking.shipper_id)`, one indexed lookup, only when the bidder has affiliations) and refuses related parties with `SELF_BID_FORBIDDEN` (403).
- `acceptBooking`: the same two refusals, first-after-read — self-accept and related-party accept both route the caller to direct-attach (D-10), the one named action for internal allocation.

**Validation.** `related-party.unit.mts` (new, 5/5): attached-to-posting-fleet related; other-fleet not; multi-fleet correct; fleetless poster never matches; unaffiliated bidder never matches. `tsc --noEmit` clean. Not built: a DB-level constraint on quotes (app-layer + tests deemed proportionate for now).

## Fix 2 — C-2 remainder: readable refusals on the last two assignment paths

**Issue.** Live-DB check proved the 0030 index protects every path — but two paths surfaced it as a raw 500: fleet-crewing a driver who is on a live **solo** trip (no `vehicle_assignments` row, so the 0016 ledger indexes never see it), and the ops reassign override. The review demanded "a clear conflict error," not an internal failure.

**Solution.**
- `bt-fleet-service/assignment.ts`: new step (3.2) `assertDriverFreeAcrossBookings` — reads `bookings` by `driver_id` (excluding the booking being crewed, excluding `TRIP_END_FREE_STATUSES`) and refuses 409 **naming the blocking trip**, exactly as (3) does for the truck. The insert + 0030 index stay the race-proof authority.
- Same file, bind step: a `23505` on the `bookings` update now maps to a named 409 `CONFLICT` instead of `throw new Error(...)`.
- `bt-booking-service/repository.ts` `reassignDriver` (ops): `23505` → 409 `CONFLICT` ("release the blocking trip"), other errors unchanged.

**Validation.** `tsc` clean both services; existing suites green (recrew 5/5, capacity 7/7, driver-lookup, assignment seam/sweep untouched). The trips-page AssignDialog already renders `CONFLICT` with its stale-refresh flow — no new UI needed; the new named message flows through it.

## Fix 3 — S-7 remainder: actor on e-way status changes, party-GSTIN formats, PAN input gap

- **Migration `0032_eway_status_actor.sql`** — `eway_bill_records.status_changed_by uuid REFERENCES users(id)`, additive/nullable. **Applied to prod 2026-08-24 and verified** (`information_schema.columns`). Ledger addendum added to `supabase/migrations/README.md`, which also corrects the stale 08-07 audit: everything through 0032 is live (incl. the previously-open 0027 ACL fix).
- `setEwayBillStatus` (repo + service) now stamps `changedBy: actor.userId`. UI counterpart: the freight-documents card shows "Cancelled/Rejected {date} — {reason}" on dead bills (`status_changed_at`/`status_reason` added to the app's `EwayBillRecord` type).
- **Party GSTIN/PAN formats** (`documents/service.ts`): `consignor_gstin`, `consignee_gstin`, `supplier_gstin`, `billed_to_gstin`, `shipped_to_gstin` → GSTIN regex; `consignor_pan`, `issuer_pan` → PAN regex (trim+uppercase first). These feed `stateCodeOfGstin` and print on statutory paper. No app form carries these fields (bodies are server-derived), so server-side validation is the complete story.
- **PAN input gap** (`bt-auth-service/identity.ts`): `pan` was `z.string().max(10)` while the sibling fleet route enforced format — now the same trim+uppercase+regex. (The live `fleet_owners_pan_format` constraint already backstopped new writes; this returns a proper 400 instead of a DB 500.)

**Validation.** `tsc` clean (`bt-booking-service`, `bt-auth-service`, `bt-app`); document-numbering 86/86 and consignee-rules 44/44 regression-green.

## Fix 4 — S-6/S-2 UX finishers

- **S-6:** fleet Trips table Actions column pinned (`sticky right-0` th + opaque `group-hover`-mirrored td — the exact #145 recipe; that PR's audit fixed My bids but missed this table). Secondary-column collapsing remains not built (larger redesign, low value at pilot scale).
- **S-2 nit:** the stale-quote notice now **names the change** — `invalidateQuote('the weight')` etc. at all 8 price-bearing call sites; notice reads "You changed the weight, so the previous quote no longer applies…".

**Validation.** `bt-app` `tsc --noEmit` clean.

---

## Still open after this PR (by decision, not omission)
- **S-3 / S-4 / S-5** — product decisions (context indicator vs the shipped per-object design; brokers vs the locked "no brokers" architecture; glossary choice). Presented separately.
- Document **versioning/audit table** (S-7) and a **quotes-level DB constraint** (C-1) — deliberate deferrals; issue-once idempotency and app-layer guards carry the load at pilot scale.
- Systematic **idempotency audit** (review Phase 1) — proposed as its own verification pass.
