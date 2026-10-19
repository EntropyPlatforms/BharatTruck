# Task: `feat/pod-evidence`

**Relates to:** `INDIA_FREIGHT_COMPLIANCE.md` **§5.2 / §5.4 / §5.5 / §5.7** (the POD evidence
controls and why a single one loses a contested dispute), `docs/ARCHITECTURE_UNIFIED_IDENTITY.md`
**§6.3** (confirmed vs asserted proof) and **D-27** (relation-to-object authorization). Carries the
work of `feat/pod-rebuild` (commits `4d50d89`, `59970df`), which was never PR'd, plus the changes an
independent assessment made a condition of landing it.

## What this branch adds

Turns POD from "a code reached the consignee's inbox" into a combination of controls: an on-device
hash nobody can recompute, a server clock the driver cannot reset, a GPS trail that has to stay
internally consistent for hours, and a server-held quantity the driver cannot edit.

### Migration `0025_pod_evidence.sql` — **not applied to production**

Strictly additive and idempotent. It keeps its number: 0026 and 0027 are taken, and 0025 was never
applied, so it lands **after** a higher number. That is safe in both directions — nothing here reads
or alters anything 0026 added, and it references only tables that predate the whole 002x series.

- `booking_status` gains **`delivery_asserted`**. Added but never used in the same transaction
  (Postgres forbids it), the pattern migration 0011 established.
- `pod_evidence` — one row per photo. Camera-only at the **DB CHECK**, not just the API; on-device
  `sha256_original` stored **verbatim**, never recomputed server-side; `captured_at_server`
  authoritative with the device time kept as a claim and the gap stored as a signed
  `clock_skew_seconds`; geofence distance + verdict; a WORM storage handle; unique
  `(booking_id, sha256_original)` as the idempotency anchor.
- `pod_state` — the proof-strength ledger. `pod_strength` is `confirmed` (receiver OTP) or
  `asserted` (evidence only). An asserted trip closed by ops **stays asserted**, permanently.
- `pod_discrepancies` — server-held `expected_quantity` vs driver-reported `actual_quantity`, a typed
  reason, a mandatory geofenced photo when they differ, dual acknowledgement, and snapshotted
  180-day (booking) / 7-day (delivery) claim clocks.
- `pod_audit_log` — append-only, INSERT-only by construction.
- `bookings.pod_expected_quantity` / `pod_quantity_unit` — writable by shipper/ops, **never** the
  driver, which is the whole anti-pilferage control.

### The changes made on top of `feat/pod-rebuild`

🔴 **Stale-fix guard** (`pod/geo.ts`, `MAX_FIX_AGE_MS = 10 min`). `trip_telemetry.last_fix_at` never
expires. The gate's block branch reasons "the truck is demonstrably somewhere else" — true only of a
fix taken moments ago. A driver whose phone died 40 km short leaves a fix that is hours old and
permanently far from the drop, and the branch as written would refuse them the delivery code while
they stood at the dock, with no way to clear it. A fix that cannot be shown to be recent is now
treated as **absent**: it falls through to the geofence-event and degrade branches. An *undated* fix
is treated the same way, because unknown age is not provable freshness.

🔴 **Kill switch** (`POD_GEOFENCE_GATE`, **default OFF**). Applying 0025 is what makes
`podFeatureAvailable()` answer true, and that alone would arm a hard 409 across the only path a trip
has to reach `completed` — on thresholds nobody has measured on a real corridor. Coupling "the tables
exist" to "the gate refuses deliveries" makes the *migration* the risky act. **Off does not mean
blind**: the gate still runs, still resolves a full decision, and still writes its
`otp_gate_pass` / `otp_gate_block` / `otp_gate_degraded` line tagged `enforced: false` — so "how often
would this have blocked a real driver, and how far out were they" is answerable from production
before anyone flips it.

**Read path** — `GET /bookings/:id/pod` returns `pod_state` (including `pod_strength`), the evidence
list, the discrepancy and the claim clocks. It is the only way ops can tell a confirmed delivery from
an asserted one before they close it. Authorized by `relationsToBooking()` (D-27), **not** role
strings: shipper / carrier / assigned driver / claimed consignee, plus the explicit ops carve-out. An
observer gets **404, not 403**, so booking-id existence does not leak. Every authorized read writes an
`evidence_access` line; a rejected one writes nothing.

**Forensic tier is narrower than the read tier.** The WORM storage URI, raw EXIF, device fingerprint,
precise fix and the fraud signals go to **ops and the shipper** only — the parties who prosecute or
defend a claim. The carrier, the assigned driver and the consignee get the durable proof facts (hash,
server time, geofence verdict, `storage_status`) and no URI. Two reasons, both deliberate: the fraud
signals are *detection output aimed at the capturing side*, and handing a driver the list of which
photos tripped mock-location teaches them what to change; and the consignee is downstream of the
carriage, the same line `seesCommercialsOnBooking` draws for money. This is the tight end of the
range on purpose — widening it should be a decision, not a field that quietly appears.

**Location states.** `delivery_asserted` **is** tracked. The state means the driver claims a delivery
nobody confirmed and ops has not closed it; the truck is still at the drop. Going dark at the
assertion would be exactly backwards — it is the weakest proof the platform accepts, so the window
right after it is when the positional record matters most, and it is the only thing that can
contradict an assertion filed from 40 km out while the gate is off. `ACTIVE_TRIP_STATUSES` is the one
list (write path, read path, fleet reach, and `EVIDENCE_CAPTURABLE` all agree); the mirror in
`bt-tracking-service`'s fleet health readout was updated with it, or a normally-reporting truck would
have read as "assigned, not started".

**Named dual acknowledgement.** `pod_discrepancies.consignee_user_id` is populated from
`bookings.consignee_user_id` (0026) when the OTP lands. A joint damage certificate is signed by two
named parties; a timestamp alone names one. NULL stays the honest answer for an unclaimed consignee.

**Frontend** — `delivery_asserted` added to the `BookingStatus` unions in `bt-ops-web`, `driver`,
`shipper` and `fleet`, with the label/colour entries their exhaustive `Record<BookingStatus, …>` maps
require to compile. `FORCE_COMPLETABLE` in the ops trips console gained it too: an asserted delivery
is closed by ops and nobody else, so a console without the button parks the trip forever one step
short of paid. No new UI.

## Acceptance criteria

- [x] A stale (45 min) fix 40 km out does **not** block; a fresh one at the same distance does.
- [x] `POD_GEOFENCE_GATE` off does not refuse, and still records the block it would have made.
- [x] Only an explicit `on`/`true`/`1` arms the gate — a typo stays off.
- [x] `GET /bookings/:id/pod` is relation-gated; observer → 404; every read audited.
- [x] Driver and consignee get no storage URI, no EXIF, no fraud signals.
- [x] `delivery_asserted` representable in all four apps; all four build.
- [x] Location ingestion and read accept `delivery_asserted`; tracking's health readout agrees.
- [x] A claimed consignee's ack names them; an unclaimed one records NULL.
- [x] The service still tolerates 0025 being unapplied (503 on primary writes, degrade on reads).

## Verification

```
packages/shared      npm run build   → tsc clean
bt-booking-service   npm run build   → tsc clean
bt-booking-service   npm test        → 13 files, all pass (pod-evidence: 106 checks)
bt-tracking-service  npm run build   → tsc clean;  npm test → 13/13
driver / shipper / fleet / bt-ops-web   npm run build → all clean
```

## Apply instructions

1. Merge. The service is inert against a database without 0025 — reads answer "no evidence", the
   gate stays off, and the existing email-OTP POD behaves exactly as it does today.
2. Hand-apply `supabase/migrations/0025_pod_evidence.sql`. Every guard is `if not exists`, so a
   partial apply can be re-run rather than untangled.
3. **Leave `POD_GEOFENCE_GATE` unset** until after the first real corridor drive. Read the
   `otp_gate_*` lines in `pod_audit_log` first: if the gate would have blocked a driver who did
   deliver, the thresholds move before the switch does.

## Out of scope

- The WORM bucket itself (`POD_EVIDENCE_GCS_BUCKET` unset → storage inert, metadata still real).
  BLOCKERS.md B-8.
- `sha256_received` verification — needs the bucket.
- Any UI for `delivery_asserted` beyond the label/colour a compile requires.
- Re-pointing POD OTP at the consignee's phone (D-26, Twilio).

## Risk

Medium, and deliberately staged. The migration is additive and the code is inert without it; the one
behaviour that could refuse a real delivery is behind a switch that ships off. The residual risk is
the widened location window — a `delivery_asserted` trip now keeps a live position, which is more
disclosure than before, bounded by the same relation checks every other location read already uses.
