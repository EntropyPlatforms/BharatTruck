# Fix report — Platform fee removal + Truck-capacity gate + Load-consolidation slice

**Date:** 2026-08-21
**Verified against:** `origin/main@6a1a725` (changes made in the working tree, not yet committed)
**Scope:** two confirmed defects from the founder's 2026-08-20 review (platform fee, capacity gate), fixed end-to-end (backend service + bt-app UI) with regression tests; plus a **read-only v1 slice** of load consolidation, which the founder approved as the "ship read-only slice first" option. All three are validated below (`tsc` clean on every touched project; unit tests green).

---

## Fix 1 — Platform fee shown in quotes (and inconsistent with settlement)

### The issue
Every quote billed a **10% platform fee** and displayed it as a line item to the customer, while the payment layer charged nothing. Two problems in one:
1. **Business-rule violation.** Founder rule: no platform fee until ≥5 transporters are onboarded, and a fee must *never* appear inside a customer quotation (kills first-trip conversion). The eventual model is a flat ₹151/load charged **only** on auction-booked loads — never a percentage, never on direct/instant bookings.
2. **Internal inconsistency.** The quote told the shipper they pay `total` and the carrier receives `total − 10%`, but `bt-payment-service` settles the **whole** amount to the payees. The quote under-reported the carrier's take and implied a cut that is never taken.

### Where it went wrong (code / architecture)
- `bt-pricing-service/src/lib/pricing.ts:67` — `export const PLATFORM_RATE = 0.10`.
- `bt-pricing-service/src/lib/pricing.ts:240` — `const platform_fee = Math.ceil(total * PLATFORM_RATE)`, returned as `platform_fee` and `driver_receives: total - platform_fee`.
- `bt-app/src/app/(app)/post/page.tsx` — quote breakdown rendered `<Line label="Platform fee" value={inr(quote.platform_fee)} />`.
- Contrast: `bt-payment-service/src/lib/payment-service.ts:381` — *"pilot: no platform fee — the payees split the whole settled amount."* The pricing layer and the settlement layer disagreed; nothing reconciled them.

### The solution
- **`bt-pricing-service/src/lib/pricing.ts`** — replaced the percentage constant with an explicit, documented, disabled-by-default flat-fee model:
  ```ts
  export const PLATFORM_FEE_ENABLED = false
  export const PLATFORM_FEE_PER_LOAD_INR = 151
  ...
  const platform_fee = PLATFORM_FEE_ENABLED ? PLATFORM_FEE_PER_LOAD_INR : 0
  ```
  The `platform_fee` field stays on the wire (pinned to 0) for type/response stability. With the fee at 0, `driver_receives === total_price === shipper_pays`, so the quote now matches what settlement actually does. Turning the fee on later is a one-line flag flip, and the constant already encodes the founder's flat-₹151 intent (scoping it to the auction path only is a follow-up when it is enabled).
- **`bt-app/src/app/(app)/post/page.tsx`** — removed the `Platform fee` line from the quote breakdown. The customer no longer sees any platform fee.

### Validation
- `bt-pricing-service/test/platform-fee.unit.mts` (new): asserts `PLATFORM_FEE_ENABLED === false` and, across three vehicle/lane cases, `platform_fee === 0` and `driver_receives === shipper_pays === total_price`. **10/10 pass.**
- `bt-pricing-service` `tsc --noEmit` — clean (exit 0).
- Pre-existing `pricing.e2e.mts` assertion `driver_receives > cost` still holds (driver take only increased).

---

## Fix 2 — A truck could be dispatched under a load heavier than it carries

### The issue
Founder: *"2 ton ka truck 5 ton ka load booking le raha hai."* No code path compared a booking's declared weight to the assigned truck's rated capacity. A fleet operator could assign a 2-tonne truck to a 5-tonne load; the assignment succeeded.

### Where it went wrong (code / architecture)
- `bt-fleet-service/src/lib/assignment.ts` — `assignDriverAndVehicle` is the one path that binds `bookings.vehicle_id`. It validated ownership (`mayExecuteFor`) and availability (`assertVehicleAvailable` — truck not already on another trip), but **never** capacity.
- The data existed but was unused for gating: `vehicles.capacity_tons` (`bt-fleet-service`) and `bookings.weight_kg`. Capacity met weight only in **post-trip analytics** (`bt-fleet-service/src/lib/analytics.ts:86`, a utilization %), never as a pre-dispatch gate.
- Solo owner-driver paths (instant-accept / direct-attach) bind `driver_id` but no `vehicle_id`, and `drivers.truck_capacity_kg` is legacy/unused — so the truck is not modeled at solo-accept time (see "Known limitation" below).

### The solution
Authoritative server gate at the single truck-binding point, plus the UI counterpart on both truck-picking surfaces.

- **`bt-fleet-service/src/lib/types.ts`** — added `'CAPACITY_EXCEEDED'` to the service's `ErrorCode` union (its own union, distinct from `@bharattruck/shared`). Its own code (not `CONFLICT`) so the app can tell the dispatcher to pick a bigger truck / split the load rather than showing a generic clash they would retry unchanged.
- **`bt-fleet-service/src/lib/assignment.ts`** — new pure, unit-testable helper `assertVehicleWithinCapacity(booking, vehicle)`:
  - refuses with `CAPACITY_EXCEEDED` (409) when `capacity_tons != null && weight_kg > capacity_tons * 1000`;
  - **fires only when capacity is known** — a null spec cannot prove an overload, so it stays selectable (the fix for blank specs is prompting fleets to record capacity, not failing dispatch closed on a data-entry gap).
  - Wired into `assignDriverAndVehicle` as step (2.5), after ownership is proven and before the crew is committed. This one gate covers **both** the auction-award→assign and the direct-attach→assign flows, because both funnel through `assignDriverAndVehicle`.
- **UI — `bt-app/src/app/(app)/trips/page.tsx` (`AssignDialog`)**: the truck `<select>` now disables any truck whose known capacity is below the load, labelling it *"— too small for this Xt load"*; the submit handler surfaces a `CAPACITY_EXCEEDED` server message (defense-in-depth for a truck whose capacity was blank client-side).
- **UI — `bt-app/src/components/fleet-pair-picker.tsx`** (post-page direct-attach): accepts a `loadWeightKg` prop, shows each truck's capacity, and disables + flags over-capacity trucks. `bt-app/src/app/(app)/post/page.tsx` passes the load's weight in.

### Validation
- `bt-fleet-service/test/capacity-gate.unit.mts` (new): the reported case (5000 kg on a 2 t truck) is refused with `CAPACITY_EXCEEDED`/409 and a message naming the truck and both weights; exactly-at-capacity and under-capacity are allowed; null capacity does not refuse; 1 kg over is refused. **7/7 pass.** Wired into `bt-fleet-service` `npm test`.
- `bt-fleet-service` `tsc --noEmit` — clean (exit 0). Existing unit suite unaffected (recrew 5/5, driver-lookup 13/13, owner-identifiers 21/21).
- `bt-app` `tsc --noEmit` — clean (exit 0).

### Known limitation (follow-up, not a regression)
Solo owner-drivers accept a load without binding a specific `vehicle_id`, and `drivers.truck_capacity_kg` is legacy/unused, so their truck's capacity is not checked at accept time. The fleet-dispatch path — where an operator picks a concrete truck, i.e. the exact reported scenario — is fully gated. Extending the gate to solo owner-drivers needs the solo truck to be modeled (or `drivers.truck_capacity_kg` revived); scoped as a small follow-up.

---

## Fix 3 — Load consolidation, read-only slice v1 (BUILT; founder approved "ship read-only slice first")

Requested: a fleet operator aggregates multiple lane-compatible loads into one truck, respecting payload capacity. The **full** feature reverses the one-load-one-truck invariant, so per the founder's decision we shipped only the **non-breaking read-only slice**: surface which of the fleet's own not-yet-crewed loads share a lane and would fit one free truck. It changes **nothing** about dispatch — loads still run as separate trips.

### Why the full feature is deferred (the invariant it would reverse)
- A booking is strictly one-load-one-truck. `bookings.vehicle_id` is a single FK, and one-live-booking-per-truck is *actively enforced* (`assertVehicleAvailable` + the `0016` partial-unique indexes on `vehicle_assignments` in `baseline.sql`). The only "consolidated" concept that exists is a document-level D-16 consolidated e-way bill.
- Naively allowing N loads on one truck breaks everything assuming booking↔vehicle is 1:1 — the `0016` indexes, `assertVehicleAvailable`, trip-scoped GPS/tracking (per booking), receiver-OTP POD (per booking), freight documents, and utilization analytics. Real consolidated dispatch needs a manifest entity + Σ-weight accounting + price/payout/POD/e-way split rules — scoped as v2.

### The solution (v1)
- **`bt-app/src/lib/consolidation.ts`** (new, self-contained pure module): `consolidationSuggestions(loads, trucks)` groups not-yet-crewed loads by a coarse lane bucket (source & dest rounded to ~0.1° ≈ 11 km), and for each lane with ≥2 loads reports the combined weight and the **tightest free truck** that could carry all of them (or `null` if none fits). Ordered biggest-opportunity-first.
- **`bt-app/src/app/(app)/trips/page.tsx`**: computes suggestions client-side from data the page already loads (no new endpoint, no schema change), and renders a read-only `ConsolidationHints` card at the top of the "Needs assignment" tab. Copy is explicit that consolidated trips are not yet available and the loads dispatch separately for now — an honest planning insight, not a false "consolidate now" button.

### Validation
- `bt-app/src/lib/consolidation.ts` covered by a pure test (7/7 pass): same-lane loads group and report combined weight; the tightest **free** truck is chosen (busy and too-small trucks excluded); a lone-lane load is never suggested; an over-capacity lane still surfaces with `fittingTruck: null`; different lanes bucket apart. (bt-app has no test runner wired, so this ran via the fleet-service `tsx`; logic is self-contained.)
- `bt-app` `tsc --noEmit` — clean (exit 0).

### Heuristic to tune later
Lane compatibility is a coarse ~11 km source+dest bucket and ignores pickup-date proximity — deliberately simple for a hint the operator confirms by eye. Tighten it (add a date window, tighten the radius) when v2 lands.
