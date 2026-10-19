# feat/fb-non-payment-fixes

Branch: `feat/fb-non-payment-fixes`
Started: 2026-08-12

## In scope

| ID | Item | Status |
|---|---|---|
| FB-01 | Truck release on completed / delivery_asserted (not only paid) | done |
| FB-03 | Invoice + e-way hard-gate before pickup (require e-way only when `ewayBillRequirement.required !== false`; fail closed on unknown/intra) | done |
| FB-04 | GST hard rule before post load + architecture note + shipper Settings GSTIN UI (bt-app + shipper) + post-load CTA | done |
| FB-09 | Documents stakeholder timing (invoice before e-way; upload required; GSTIN prefill) | done |
| FB-10 | Session storage partition via `?profile=` | done |
| FB-11 | Identity engine de-role sweep (list/cancel/location/quotes/POD qty + fleet login capabilities + quote seeAllQuotes flag) | done |

## Skipped

FB-02, FB-05, FB-06, FB-07, FB-08 (payments/pricing).

## Notes

- Ops/admin JWT carve-outs remain intentional (no `admin` capability).
- Deprecated `repository.listBookings` still maps coarse role → scope for old e2e; live path is `service.listBookings` → `listBookingsForScope`.
