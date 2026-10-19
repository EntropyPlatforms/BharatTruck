# feat/pricing-engine — standalone deterministic freight pricing engine

> Active `feat/*` task file (CLAUDE.md §0.4). Delete on merge.

## GOAL

Turn `bt-pricing-service` into a standalone **deterministic** engine that computes a full
freight-price breakdown in ONE call, using the **real CV-Parc cost data** (seeded by migrations
0017/0018 into `vehicle_cost_norms` / `vehicle_service_cost_by_age` / `fleet_cost_settings`) instead
of the flat hardcoded assumptions in `lib/cto-cost.ts`.

## Three layers (only layer 1 is built in P0)

1. **COST FLOOR** — from CV-Parc norms. The real per-trip operating cost × a 1.07 floor markup. (P0)
2. **MARKET RATE** — FR8 live ₹/km, a future `freight_lane_rates` table. (P2)
3. **QUOTE** — chosen between floor and market. (P3)

RL/LinUCB optimiser stays **OUT of MVP**.

## Two modes (future phases)

- **(A) forward "reference quote"** — a shipper posting a load gets a benchmark. (P3)
- **(B) "justify-a-price" allocation** — given a fleet-owner's auction bid ₹X + the load/route ONLY
  (no truck details), produce a breakdown that SUMS to ₹X by filling route/load-derived cost lines
  at TYPICAL class params and putting the residual as margin. Never nudges the bidder. (P4)

Route distance will come from `bt-tracking-service` via an internal point-to-point endpoint (the
Google key stays in tracking), Redis-cached, with haversine × 1.3 fallback. (P1)

## Phases

- **P0** — real cost engine + wire into `computeQuote` + golden test (95 checks). ✅ (#136)
- **P1** — real road distance via `bt-tracking-service` `POST /internal/route/point`, haversine fallback. ✅ (#137)
- **P2** — FR8 market layer: `lib/market-engine.ts` + migration 0029 (4 classes / 27 cities / 63 directional lanes). ✅ (#138, migration applied to prod 2026-08-14 as ledger `0029_freight_market_rates`)
- **P3** — quote↔floor↔market reconciliation (`lib/reconcile.ts`, additive, never mutates the locked headline) + three-layer panel in `bt-app` post/page.tsx (21 checks). ✅ (#141)
- **P4** — Mode B justify-a-price: `lib/justify.ts` + `POST /pricing/justify` + live "Where this bid goes" panel in `bt-app` auctions BidDialog (16 checks). Truck-agnostic, never nudges, sums to the bid to the rupee. ✅ (#142)
- **P5** — calibration/validation harness on the full **4,917-row FR8 dataset**. ⏳ BLOCKED on data: the xlsx (`BharatTruck_Test_Dataset_v3_FR8.xlsx`) is not committed to the repo — it was chat-attached. The COST layer is already calibrated to the workbook (the P0 golden test, fuel/crew to the rupee, total-direct ±3%). The remaining piece — the demand-premium model (dataset Market_Price varies 0.92×–1.45× raw FR8) + season/urgency multipliers — needs that dataset re-supplied to derive honestly rather than guess. P2 deliberately ships honest FR8 live-corridor rates and defers the premium here.

**Status: the standalone engine (both modes) is built end-to-end, wired through services + bt-app, and merged. Full suite 194 checks green.** Delete this file only after P5 (or an explicit decision to close the engine without the premium calibration).

---

## P0 — what was built

`bt-pricing-service/src/lib/cost-engine.ts`:

- Loads + caches the three seed tables via the service-role supabase client (same client
  `price-quote-store` uses). Test-injection seam `__loadCostEngineFixtures()` bypasses the DB so the
  golden test runs offline.
- Pure `computeCostBreakdown(...)` returning every line item + `running` + `total_direct` + `floor`
  + a `basis` note. Mirrors the FORMULAS in `bt-fleet-service/src/lib/economics.ts` (copied, not
  imported — no cross-service dep).
- `resolveModelCategory()` — maps the legacy 4-value `vehicle_type` enum to a CV-Parc
  `model_category`, or takes an explicit `model_category`.
- Async `resolveCostFloor(input)` — the orchestrator: resolves norms/service-cost/prices and calls
  the pure function.

Wiring: `lib/pricing.ts` `computeQuote(input, costFloor?)` gained an **optional** second arg. When
the route passes a resolved `costFloor` (from `resolveCostFloor`), it rides along on the result as
`cost_floor` and into `breakdown_json`. Every existing top-level field, `quote_kind`, `basis`, and
the lock/consume flow are **byte-identical** when the arg is omitted, so the existing e2e stays
green and the commercial rate card (MARGIN_MULTIPLE) is untouched. `routes/pricing.ts` resolves the
floor defensively (a norms outage logs a warning and degrades to `cost_floor: null` — the commercial
split still works).

### The cost formula (per trip)

```
diesel_l   = distance_km / kmpl                    (kmpl_bs6/bs4 by model_category + emission_norm)
fuel       = diesel_l * diesel_price
def        = diesel_l * def_pct * def_price
engine_oil = distance_km / eng_oil_km * eng_oil_l * engine_oil_price
gear_oil   = distance_km / gear_oil_km * gear_oil_l * gear_oil_price
service    = annual_service_cost(super_category, age_clamped_1_10) / kms_per_year * distance_km
tyres      = distance_km * tyre_cost_per_km        (informational — see note below)
crew       = trip_days * (crew_monthly / working_days)   (trip_days = ceil(distance_km / avg_km_per_day))
toll       = distance_km * toll_per_km             (per vehicle_class)
allow      = trip_days * allowance_per_day         (crew vs driver-only)
handling   = weight_tons * handling_per_ton[load_type]
running      = fuel + def + engine_oil + gear_oil + service + crew
total_direct = running + toll + allow + handling
floor        = round(total_direct * 1.07)
```

> **Tyres are NOT in `running`.** The founder pricing workbook's `Running ₹` column is exactly
> `Fuel + DEF + Eng.Oil + Gear Oil + Service + Crew` (verified to the rupee on the anchor:
> 33614+910+120+31+3723+10577 = 48975). It carries **no tyre line**, and `Total Direct` = that
> running + toll + allow + handling. `economics.ts` (a per-asset P&L model) DOES include tyres; this
> is the pricing FLOOR calibrated to the founder's pricing sheet, so it matches the sheet. The tyre
> line is still computed and returned as an informational field for the future market/quote layers.

### Calibrated constants (and why)

Derived from `/Users/.../Downloads/BharatTruck_Test_Dataset.xlsx` sheet "Test Dataset" (4,917 rows,
2-row header). Cost-breakdown columns are the golden targets.

| Constant | Value | Evidence |
|---|---|---|
| `WORKING_DAYS_PER_MONTH` | 26 | `crew = trip_days × crew_mo / 26` reproduces `Crew ₹` for **100%** of rows. |
| `AVG_KM_PER_DAY` | 300 | `trip_days = ceil(dist/300)` reproduces `Trip Days` for **100%** of rows. |
| `CREW_MONTHLY_INR` | crew 55000 / driver-only 35000 | Workbook `Crew ₹/mo`: SCV Cargo / Pickups / LCV(4-7T) are "No (driver only)" 35000; ICV / MCV / all HCV are "Yes" 55000. |
| `TOLL_PER_KM` | HCV 1.80, MCV 1.70, LCV 1.60, SCV 1.20 | Clean-row (`no monsoon/harvest/urgent`) median `Toll ₹/km` per vehicle_class. Route/NH instance variance (the anchor is 2.20/km on NH48) is not modelled in P0 — the shipper flow has no NH; an optional `toll_per_km` override is exposed for P1 (tracking supplies the route). |
| `ALLOWANCE_PER_DAY_INR` | crew 320 / driver-only 440 | Clean-row median `Allow ₹ / Trip Days` (crew ~299, driver ~424); nudged up within the grid that maximises the ±3% Total-Direct hit rate. |
| `HANDLING_PER_TON_INR` | general 30, fragile 300, hazardous 180, perishable 144, heavy_machinery 852 | Workbook `Handling ₹ / Weight MT` is a rock-solid constant per handling type (General 30, Fragile 300, Hazmat 180, Reefer 144, ODC ~852). Anchor: 16.8 t × 30 = 504 exact. |
| `FLOOR_MARKUP` | 1.07 | Workbook `Floor ₹ (×1.07)`. |

Consumable prices (`diesel`, `def` 45, `engine_oil` 420, `gear_oil` 390) come from the seeded
`fleet_cost_settings` global row; `diesel_price_inr` is overridable per request (the workbook varies
diesel per row). The small DEF/oil price gaps vs the workbook (workbook DEF implies ~55/L) are
absorbed by the ±3% Total-Direct tolerance.

### `vehicle_type` → `model_category` map

`mini_truck → SCV Cargo`, `lcv → LCV (4-7 T)`, `hcv → HCV Cargo 25-31T`, `trailer → HCV Cargo 42-48T`.
Optional richer inputs (`model_category`, `emission_norm 'bs6'|'bs4'`, `truck_age`, `diesel_price_inr`)
override the defaults when provided.

### Calibration result

Across all 4,394 freight rows (the 9 mapped categories): **83%** of Total Direct within ±3%, median
abs error **0.5%**. Golden test pins 15 representative rows (all 9 categories, ages 2 & 5, clean):
every Total Direct within ±3% (max 1.48%), and **Fuel + Crew match to the rupee** on all 15. Anchor
(Q3001, Mumbai→Delhi, HCV 25-31T, age 2, diesel 94.27): Fuel 33614, Crew 10577 exact; Total Direct
53507 vs 53887 (0.7%); floor = round(td×1.07) exact, within ±3% of the workbook's 57660.

Golden test: `bt-pricing-service/test/cost-engine.golden.mts` (+ shared fixture
`test/fixtures/cv-parc-norms.mts`, the migration-0018 rows copied verbatim like
`bt-fleet-service/test/economics.test.mts`). Run by `npm test` (globs `test/*.mts`).
