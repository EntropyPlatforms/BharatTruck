# Unified Identity & Emergent Personas — locked architecture

> **Status:** LOCKED 2026-08-03 by founder decision. Supersedes the one-role-per-account model.
> **Extended 2026-08-07** with D-21..D-30 (§9) after a full code audit — the consignee party model,
> the live-location rule, the sub-contracting seam, and the removal of brokers from scope — and again
> with D-31..D-38 (§10, the unified-app session): KYC-as-prompt, primary-persona-as-front-door,
> magic-link removal, the consignee claim link, and the build order to a working `bt-app`.
> Changing anything here needs an explicit dated reversal note in this file, the way `BIBLE.md §2`
> handles scope reversals — do not silently overwrite.
>
> **Companion:** `docs/INDIA_FREIGHT_COMPLIANCE.md` — several decisions below exist because of a
> legal constraint documented there, and are cross-referenced.
>
> ⚠️ **D-1..D-20 below describe the intended model, not uniformly the shipped one.** The 2026-08-07
> audit found the identity model *written but not wired*: `resolvePersonas()` is complete and
> imported by nobody, `/auth/me` still returns only `users.role`, and `bookings.award_path` (D-10)
> is a dead column with no code path. §9.4 is the honest built-vs-designed ledger. Trust the code
> over any claim in §1–§8.
>
> Since that audit, items 1–3, 6 and 8 of §9.5 have landed — including `award_path` and the
> direct-attach endpoint, so the D-10 note above is no longer true.

---

## 1. The one idea

**A persona is not a flag on an account. It is a view over what you own and who you are connected to.**

```
what you OWN         (trucks)              → carrier capability
who you HOLD         (drivers / fleets)    → fleet capability
what you DO          (post a load)         → shipper capability
```

Nobody "becomes" a fleet owner. They buy a second truck, and the fleet surfaces become *relevant*.
Nothing is switched on; something became true. That is what makes the app feel like it is taking the
shape of the user's business rather than asking them to pick a costume.

### 1.1 The single rule that replaces three special cases

> **Commercial visibility follows ASSET OWNERSHIP, not affiliation.**
> Own a truck → you are a stakeholder in its economics → you see the money.
> Assetless driver → you are an employee → you do not.

This one rule resolves what used to be three separate behaviours:

| Case | Old behaviour | New behaviour |
|---|---|---|
| Solo driver | sees money | sees money (owns the truck) |
| Fleet driver, no assets | masked by `stripCommercialFields` | masked — unchanged |
| **Owner-driver affiliated to a fleet** | **masked (wrong)** | **sees money — they are a stakeholder** |

### 1.2 The second rule — affiliation ADDS work, it does not replace it

An affiliated driver who **owns a truck** keeps full marketplace access. Affiliation is an additional
source of work, not a substitute for self-selection.

An affiliated driver who owns **nothing** does not self-select work — their owner bids and assigns.

> This retires the `driver/src/lib/fleet-affiliation.tsx` "two products" split, which keyed the whole
> driver app off `is_fleet_affiliated`. That discriminator is now wrong.

---

## 2. Decisions locked

| # | Decision | Consequence |
|---|---|---|
| **D-1** | Account = **one human**. No organisations, no shared logins. | A distributor with dispatch clerks cannot delegate. Accepted for pilot; §7 leaves the seam. |
| **D-2** | Auth identifies the **user**, not a role. `users.role` demotes to `primary_persona`. | Every service that authorizes on `role` must move to capability checks. Back-compat kept — see §4.3. |
| **D-3** | Personas are **emergent**, computed from assets + relationships + actions. Never stored as an authorization flag. | No "add persona" settings screen. Emergence moments are the growth loop (§5.3). |
| **D-4** | **One KYC identity.** Documents are typed and shared across personas. | PAN/Aadhaar verify the person; GST the business; DL the driver; RC the truck. All hang off `users.id`. |
| **D-5** | **KYC does not gate use at MVP.** | Founder call — cannot onboard and test the full KYC surface before 31 Aug. Verification badges are informational. Revisit post-MVP. |
| **D-6** | Trucks are assets of a **person** (driver or fleet owner) and behave identically either way. | `vehicles` already supports both (`driver_id` / `fleet_owner_id`). Normalised in 0022. |
| **D-7** | **Revenue split** on the fleet↔driver relationship; the fleet owner sets it. | `fleet_drivers.revenue_share_pct`. Default 0 (salaried). |
| **D-8** | A driver may affiliate to **multiple fleets**. | Availability is owned by the **truck**, not the driver (§6.2). |
| **D-9** | Trip history is **jointly owned** and retained in full, for legal reasons. | Never delete on affiliation end. Read access survives `status='left'`. |
| **D-10** | **Same person on both sides → direct-attach**, bypassing the auction. | New lifecycle path. Still gets a real invoice with real freight (D-15). |
| **D-11** | Platform runs a pricing engine at auction start — **reference only for the shipper, never a compulsion.** | Also a legal protection: platform *setting* price is a GTA red line (`INDIA_FREIGHT_COMPLIANCE.md §1.3`). |
| **D-12** | Platform **moves money** via Razorpay Route when wired, using **stakeholder-owned** accounts. **No platform cut.** Falls back to record-only. | No credentials exist today → built inert (§8). Money never rests with the platform — that is what keeps the collection-agent framing. |
| **D-13** | **POD = OTP + photo evidence. The QR is scrapped.** | Founder call. §6.3. |
| **D-14** | **Phone OTP stubbed everywhere**, ready for DLT registration. | Every send site goes through one provider seam so DLT wiring is a config change. |
| **D-15** | Direct-attach bookings still produce an invoice; freight is real, **not zero**. | Internal cost accounting, external correctness. |
| **D-16** | **Multi-truck consignments supported** (SKD/CKD). | One invoice, per-truck delivery challan, original with the last truck. Breaks one-invoice-one-truck. |
| **D-17** | **In-platform e-way bill generation is OUT of MVP.** Record + upload an externally-generated one. | Removes the GSP + ISO 27001 critical path. The full API contract is documented for later. |
| **D-18** | Shippers **≥ ₹5 cr turnover**: invoices handled in-house. | Their e-way bills must go through the IRN path — deferred with D-17. |
| **D-19** | **Truck carries the schedule.** Accepting work locks the truck for the window. | Prevents double-booking across multiple fleets + self-selected loads. |
| **D-20** | Reputation is **per persona**, and deferred. | A bad shipper is not automatically a bad carrier. Keep it simple until there is data. |

---

## 3. What "one app" means

Founder: *"There is no destination in this application. A user logs into BharatTruck, that's all."*

### 3.1 What it is NOT

- ❌ A persona switcher / slider / dropdown
- ❌ Three apps behind one login with a router picking one
- ❌ A settings screen where you tick which personas you want

All three make the user do the platform's filing.

### 3.2 The shape

**One home surface that answers a single question: *what needs me right now?***

A unified action feed where **each item carries its own persona** and renders in its own idiom. The
user never selects a context — the *object* supplies it:

```
┌─────────────────────────────────────────────┐
│  Needs you                                  │
├─────────────────────────────────────────────┤
│  🟠 3 bids on Mumbai → Nagpur     [shipper] │  ← you posted this
│  🟢 Trip to Pune starts tomorrow  [driver]  │  ← you're driving this
│  🔵 Ravi accepted your invite     [fleet]   │  ← you employ him
│  🟠 Delivery code needed           [shipper] │  ← your consignee hasn't confirmed
└─────────────────────────────────────────────┘
```

For a single-persona user this is indistinguishable from today's app — the feed just contains one kind
of thing. **That is the property that makes it safe to ship**: it degrades gracefully to the current
product and gets richer as the user's business does.

### 3.3 Navigation appears as capability becomes true

Nav is derived, never chosen:

| Tab | Appears when |
|---|---|
| **Home** | always |
| **My Loads** | you have ever posted a load, or have `ship` capability |
| **Find Work** | you own a truck (`carry`) |
| **My Fleet** | you own ≥2 trucks, **or** you have ≥1 driver |
| **Trips** | you have `drive` capability |
| **Profile** | always |

A solo driver sees Home / Find Work / Trips / Profile. They add a second truck; **My Fleet appears**.
Nothing was configured.

### 3.4 Context comes from the object

Opening a booking resolves *your* relationship to **that** booking:

```
GET /bookings/:id  →  { ...booking, viewer: { relation: 'shipper' | 'carrier' | 'driver' | 'observer',
                                              sees_commercials: bool,
                                              actions: [...] } }
```

Same URL, same screen component, different truth. This is what makes the distributor case work: they
open a load they posted and see the shipper view; they open a load they won and see the carrier view.
**No mode, no switch.**

### 3.5 Emergence moments — the growth loop

Each is a call-to-action at the moment the fact becomes true, not a settings toggle:

| Trigger | Moment |
|---|---|
| Adds a 2nd truck | *"You now run 2 trucks. Assign a driver to the second?"* → fleet surfaces unlock |
| Invites a driver | *"You're now managing a fleet."* → fleet surfaces unlock |
| Posts a first load | shipper surfaces unlock silently |
| Owner-driver joins a fleet | keeps Find Work; **gains** assigned Trips |
| Distributor with trucks | all three live at once; the feed interleaves |

### 3.6 Interim (pre-31 Aug)

The three deployed apps stay. The **backend becomes persona-aware now** — `/auth/me` returns
capabilities, bookings return a `viewer` block, authorization moves off `role`. Each app renders the
slice it already renders, but reads capability instead of assuming a role.

**This is deliberate sequencing, not a compromise:** the one-app frontend is a rewrite that cannot land
by 31 Aug, and every backend change above is required for it either way. When the single app is built
it consumes an API that is already correct.

---

## 4. The identity model

### 4.1 Capabilities

```ts
type Capability =
  | 'ship'     // may post loads
  | 'drive'    // may be assigned trips  (has a drivers row)
  | 'carry'    // may bid / self-select   (owns ≥1 vehicle)
  | 'operate'  // fleet surfaces          (owns ≥2 vehicles OR has ≥1 driver)
```

`ship` is ungated — posting a load is the act that emerges the persona (D-5: no KYC gate at MVP).

### 4.2 Resolution (single source of truth, `@bharattruck/shared/personas`)

```
drives      := exists drivers where user_id = $user
fleets_led  := fleet_owners where user_id = $user
vehicles    := vehicles where driver_id in (drives) or fleet_owner_id in (fleets_led)
drivers_held:= fleet_drivers where fleet_owner_id in (fleets_led) and status in ('pending','active')

carry   := count(vehicles) >= 1
operate := count(vehicles) >= 2 or count(drivers_held) >= 1
```

### 4.3 Backward compatibility

The JWT keeps `role` **and** gains `personas`. Nothing breaks on deploy; services migrate to
capability checks one at a time. `users.role` becomes the **primary persona** and keeps its existing
job of deciding where emailed links land (`DRIVER_MAGIC_LINK_URL` etc.) — a multi-persona user still
needs one correct destination for a password-reset email.

---

## 5. Money

### 5.1 The split

`fleet_drivers.revenue_share_pct` — the fleet owner's call (D-7). `0` = salaried employee, which is
today's behaviour and the default, so nothing changes for existing rows.

`resolvePayee` becomes `resolvePayees` and returns **1..n** payees:

```
fleet-won, share = 0    → [fleet_owner: 100%]                  (today's behaviour, unchanged)
fleet-won, share = 30   → [fleet_owner: 70%, driver: 30%]
solo                    → [driver: 100%]
```

### 5.2 Razorpay Route — built inert

No credentials exist (`.env.example` declares them; Cloud Run has none). So:

- `RAZORPAY_KEY_ID` unset → `disbursement_mode = 'recorded'`, exactly today's behaviour
- set → `disbursement_mode = 'route'`, transfers to **stakeholder-owned linked accounts**

**No platform cut** (D-12). The platform is a conduit; the money never rests with it. That is
deliberate — taking freight as principal is a GTA red line
(`INDIA_FREIGHT_COMPLIANCE.md §1.3`).

### 5.3 Pricing

The engine stays and runs at auction start, but the quote is **advisory**. The shipper is shown a
reference, and the binding number is the carrier's accepted bid. `price_quotes` stops being a *lock*
for auction bookings and becomes a *reference snapshot*.

---

## 6. Operations

### 6.1 Direct-attach

Shipper and carrier are the same human → skip the auction, assign directly. Still produces: a real
booking, a real LR, a real invoice with **real freight** (D-15), and a real POD. The trip is not
special — only its *award path* is.

### 6.2 Availability

The **truck** carries the schedule (D-19). Accepting any work — a self-selected load, a fleet
assignment from either of two fleets — locks that truck for the window. A driver with no truck cannot
be double-booked because assignment is to a truck, not a person.

### 6.3 POD — OTP + evidence, no QR

Scrapped: QR (D-13). Kept and hardened:

| Control | Why |
|---|---|
| **OTP to the consignee**, gated on **geofence entry** | The secret sits off the driver's device. The geofence gate closes the "driver phones ahead from 40 km away" hole |
| **Camera-only photos, SHA-256 hashed on device, never re-encoded** | `INDIA_FREIGHT_COMPLIANCE.md §5.4`. Re-compressing destroys the evidence |
| **Server-authoritative timestamps** + retained clock skew | Device clocks are trivially reset; large skew is itself a signal |
| **Continuous GPS trail** | Far harder to forge than a point fix — must stay internally consistent for hours |
| **Expected-vs-actual counts** against a **server-held** quantity the driver cannot edit | This is what defeats strategic pilferage; free-text remarks do not |
| **Append-only audit log** | Makes every other control credible in a dispute |
| **Idempotent state machine**, no artificial ordering | Founder: *"no first this then this unless that's how it works"* |

**The receiver path assumes zero app installation** — OTP over SMS/email, works on a feature phone.
That is the mainstream path in Indian logistics, not the fallback.

**When the receiver cannot confirm at all** (my call, delegated): the driver captures evidence, the
trip moves to `delivery_asserted` — not `delivered` — and ops can close it. The record carries
`pod_strength = 'asserted'` so a weaker proof is never silently indistinguishable from a confirmed one.

### 6.4 Documents

| Document | MVP |
|---|---|
| **LR / consignment note** | Generated, **per-fleet-owner series**, Rule 46(b) format. Never a platform-wide counter (`INDIA_FREIGHT_COMPLIANCE.md §3.3`) |
| **E-way bill** | **Record + upload** an externally-generated one (D-17). Number, `valid_upto`, portal, and a file |
| **Invoice** | Generated in-house, incl. ≥₹5 cr shippers (D-18) |
| **Multi-truck (SKD/CKD)** | One invoice, per-truck delivery challan, original with the last truck (D-16) |

---

## 7. Deliberately deferred

| Item | Why | Revisit |
|---|---|---|
| Organisations / staff accounts | D-1. Painful past ~50 shippers | Post-MVP. Seam: nothing assumes `users.id` is the only actor — authorization goes through capability resolution, so an org actor slots in there |
| In-platform e-way bill generation | GSP + ISO 27001 lead time | Post-MVP. API fully documented |
| Reputation | D-20 | Post-MVP |
| Single-app frontend | Cannot land by 31 Aug | Post-MVP; backend is being made ready now (§3.6) |
| KYC gating | D-5 | Post-MVP |

---

## 8. Migration path

**Migrate, do not reset.** `users.role` is preserved as `primary_persona`; persona rows backfill from
it. The 620 seeded fleet assignments and every demo account keep working.

Ordering, each behind its own PR:

1. **0022** — `fleet_drivers.revenue_share_pct`, vehicle-ownership constraint, persona backfill
2. Shared capability resolver + `/auth/me` capabilities *(no behaviour change)*
3. Commercial-visibility rule moves to asset ownership
4. Documents: LR series, e-way bill record, invoice, multi-truck
5. POD rebuild
6. Payouts split + Razorpay Route (inert)
7. Pricing repositioned to advisory

Steps 1–2 are strictly additive: nothing reads the new columns until step 3.

---

# 9. Extension — locked 2026-08-07

> Founder session of 2026-08-07. Ten further decisions, taken after a code audit of all eight
> backend domains. Where one of these corrects an earlier decision it says so explicitly; nothing
> above has been silently edited.

## 9.1 Decisions D-21..D-30

| # | Decision | Consequence |
|---|---|---|
| **D-21** | **Config is a PREFERENCE layer, never an authorization layer.** A settings toggle may *suppress* a surface the user does not want; it may never *grant* a capability their assets do not support. | Resolves the tension between D-3 (emergent, no toggles) and the founder's ask for a config map. A fleet owner who only moves own goods flips "private carrier" and loses Find Work / My Bids from their UI — but still holds `carry`+`operate`, because the trucks are real. Defaults are always correct the moment a fact becomes true, so emergence is untouched. |
| **D-22** | **The consignee is a shipper-KIND party, in one of two states: unclaimed or claimed.** Unclaimed = a record (name, **phone primary**, email, GSTIN, address) with no login. Claimed = a full account. There is ONE entity kind, not two. | Replaces `bookings.receiver_email`. Documents always have complete consignee data; POD OTP authenticates *possession of the party's phone*, not an account; the receiver never installs anything. `ship` becomes **bidirectional** — outbound (posted) and inbound (consigned). Supersedes the receiver-email design in §6.3. |
| **D-23** | **Brokers / commission agents are PERMANENTLY out of product scope.** | Founder: *"brokers exist because we don't exist."* Disintermediation is the thesis; modelling a broker would compete with it. Note the payout layer stays a generic payee list for D-24's sake, so nothing structurally blocks a reversal — but the product does not model a broker. |
| **D-24** | **Sub-contracting: the SEAM stays open even though the flow is post-MVP.** The **commercial counterparty** (the winning carrier) is recorded separately from the **executing truck + driver**, and no code may assume they coincide. | Corrects a live hardcoding: `assignDriverAndVehicle` requires the truck *and* the driver's affiliation to belong to the winning fleet, and `resolvePayees` pays an unaffiliated (sub-contracted) driver **₹0** silently, because the D-7 share lookup returns 0 when no affiliation row exists. Both become one named predicate, not scattered guards. |
| **D-25** | **Live location is a property of an ACTIVE TRIP, never of a person or a truck.** No GPS is stored outside a trip; every read is authorized by the viewer's relation to that trip. | Driver → own active trip only. Fleet → their executing trips (an idle truck shows "idle since X", no pin). Shipper/consignee → the truck carrying *their* in-transit load only. This is server-side authorization, never a frontend filter. Closes two live leaks (§9.4). |
| **D-26** | **Twilio implements the D-14 SMS seam. SMS-first, email fallback.** The seam is **hoisted to `@bharattruck/shared`** so every service can send. | The seam currently lives private to `bt-auth-service` and knows only `console`/`msg91`, so `bt-cargo-ledger` — the service that sends the POD OTP, the one OTP that most needs a phone — cannot reach it. DLT template registration still applies per provider (`BLOCKERS.md` B-2); the email fallback keeps every flow alive until it lands, and no code changes when it does. |
| **D-27** | **No hardcoded persona flows anywhere.** Authorization is `capabilities` + relation-to-object. Booking reads return a viewer block with an **array** of relations. | A direct-attach distributor is `['shipper','carrier']` — not forced to pick. The current single-value `relationToBooking` silently drops the second relation, and ~30 sites across five services still branch on the JWT `role` string. |
| **D-28** | **A trip completed without ever being `in_transit` must be MARKED as such.** | Ops force-complete allows `accepted → completed`, bypassing the state machine. Under D-25 a trip with no movement record has no location history, so a forced completion must never be silently indistinguishable from a proven one. Same principle as `pod_strength` (§6.3). |
| **D-29** | **`ship` is ungated but WRITE-gated by contact completeness:** posting a load requires a consignee with at least one reachable channel (phone required). | This is what actually kills the receiver-email trap (§9.4, issue #3) — not a nullable column plus a nudge email. A trip can no longer become un-closeable for want of a contact. |
| **D-30** | **Truck owner ≠ operator (the non-driving investor) stays DEFERRED.** | `vehicles_single_owner` (migration 0022) enforces one owner per truck, which cannot express investor-owns / fleet-operates / third-party-drives. The owner-**driver** attached case works today via `fleet_drivers` affiliation and covers the pilot. Revisit post-MVP with a `vehicle_operator` relation; do not widen the constraint casually — it is what makes "who gets paid for this truck" answerable. |

## 9.2 The consignee, in full (D-22)

The question this answers: *"the receiver needs to be a shipper for GST and e-way bill purposes, but
must not need an account — how are those the same thing?"*

They are the same thing because **documents need a RECORD; actions need a LOGIN.** Those are
different requirements, and only the second one needs authentication.

| Concern | What it needs | Consequence |
|---|---|---|
| **E-way bill / LR** | consignee name, GSTIN-or-URP, address | A *record* satisfies this completely. The law does not care whether the consignee ever logged in. |
| **POD** | proof the goods reached the right party | OTP to the party's **phone** (D-26), gated on geofence entry. Zero install, works on a feature phone. |
| **Paying a `TO_PAY` freight** | an authenticated actor | **This is the claim trigger** — and the only one. |
| **Seeing your inbound shipments** | an account | Available once claimed; until then, the OTP is the entire access path. |

**Claiming.** Phone OTP → set password → the unclaimed record becomes a full account *with its
shipment history already attached*. Because a consignee record is shipper-kind, the human who
claims it can immediately post their own loads. **Every delivery seeds a shipper who is one OTP
away from their first booking** — the backhaul growth loop, for free.

**Matching.** At posting time, a consignee whose phone matches an existing party links to it rather
than creating a duplicate; the load then appears under that party's **Incoming**. This is what makes
the distributor case ordinary: they post, name the consignee (their customer), direct-attach to
their own fleet (D-10), and the documents read consignor = distributor, consignee = the party.

**Why not a separate `freight_parties` table.** It was considered and rejected: the moment a
consignee also ships outbound, a separate table gives the same human two identities — precisely the
problem the unified model exists to kill — and claiming would need a merge migration. The consignee
is a `users` row that happens to have no password, which the schema already supports (accounts are
created today with phone-only, email-only, and Google-only shapes, and password-reset already
handles `password_hash IS NULL`).

> **Anti-goal:** an unclaimed consignee record is **not** a user account with a weak password. It
> has no credential at all. It cannot be logged into, only claimed. Never mint a password for one.

## 9.3 Live location scoping (D-25)

| Viewer | May read |
|---|---|
| Driver | Their own active trip. Nothing else, ever. |
| Fleet owner (`operate`) | Trips their fleet is executing **now**. Idle trucks report status, not position. |
| Shipper | The truck carrying their load, while `in_transit`. |
| Consignee (claimed) | Same as shipper, for their inbound load. |
| Ops/admin | Explicit, logged bypass. |

**Ingestion follows the same rule:** a location fix must belong to an active trip or be rejected.
A driver's phone must not be a tracking device outside working hours — that is a product promise,
not just an authorization detail.

## 9.4 Built vs. designed — the honest ledger (audit, 2026-08-07)

**Fixed and verified in code** (four of five issues from the founder's 2026-08-02 security note):
settle() now reconciles against `final_price ?? quoted_price` (422 on mismatch, admin override
logged); login lockout 10/15min charged before bcrypt and enumeration-safe, plus a global
`SMTP_DAILY_BUDGET`; the HCV rate card is derived (~₹36.7/km cost × 1.63) instead of the ₹22
constant, and the advisory/binding split (D-11) has landed.

**Found by the audit, not previously known:**

| Severity | Finding |
|---|---|
| 🔴 **Critical** | `callback_url` in the request body **overrides** the magic-link and password-reset link base with no allowlist. An unauthenticated attacker has a victim's single-use sign-in / reset token emailed to the attacker's own origin. Account takeover in one POST. |
| 🔴 **High** | Location reads **fail open**: `/location/driver/:id` and `/location/booking/:id` branch only on `driver`/`shipper`, so any `fleet_owner` JWT reads any driver's live GPS by uuid. |
| 🔴 **High** | `POST /location/update` treats `booking_id` as optional and skips every trip check when it is absent, storing off-duty positions that then surface on the fleet map. Violates D-25. |
| 🟠 Medium | Sub-contracted driver silently paid ₹0 (D-24). |
| ~~🟠 Medium~~ **FIXED** | `bookings.award_path` was a **dead column** — no code read or wrote it, so every direct booking was recorded as `'auction'` and D-10 direct-attach had no execution path. The three award paths now stamp it in the same statement that binds the carrier, and `PATCH /bookings/:id/direct-attach` exists. |

**Written but not wired:** `resolvePersonas()` is complete and tested and imported by nobody;
`/auth/me` returns only `users.role`; `bt-auth-service` is not on `@bharattruck/shared` at all, so
wiring it is a build change (Dockerfile, CI path filter) before it is a code change.

**Written but not merged:** branch `feat/pod-rebuild` carries migration `0025_pod_evidence` and
~2.3k lines implementing camera-only evidence with on-device hashing, geofence-gated OTP,
server-held expected-vs-actual quantities, an append-only audit log, and the
`delivery_asserted` / `pod_strength` weaker-proof tier (§6.3). It is real work sitting unreviewed —
land it rather than rebuilding it.

**Written but not applied:** migration `0024_freight_documents` is in the repo and **not applied to
the live database**; the document endpoints 503 in production until it is.

> **Migration numbering.** `0025` is claimed by `feat/pod-rebuild`. The consignee party model takes
> **`0026`**. Numbers are assigned centrally — ask before taking one.

## 9.5 Sequencing

Each row is one PR, green CI, merged, deployed.

| Order | Change | Why here |
|---|---|---|
| 1 | `callback_url` origin allowlist | Live account-takeover vector. Nothing waits on this. |
| 2 | Location authz + trip-scoped ingestion (D-25) | Live privacy leak; also the first D-25 enforcement. |
| 3 | `relationsToBooking()` + `consignee` relation (D-27) | Pure `packages/shared`, additive, unblocks everything below. |
| 4 | `bt-auth-service` onto shared + `/auth/me` capabilities | The gate for every capability-gated client. Build change first. |
| 5 | Twilio provider + seam hoisted to shared (D-26) | Unblocks phone-primary POD. |
| 6 | Consignee party — migration 0026 + booking wiring (D-22, D-29) | The largest change; needs 3 and 5. |
| 7 | Viewer block on booking reads; de-role-ify authorization (D-27) | Needs 3 and 4. |
| 8 | ✅ `award_path` + direct-attach endpoint (D-10) | Makes the distributor path real. |
| 9 | Sub-contract predicate + payee fix (D-24) | Closes the ₹0 payout hole. |
| 10 | Land `feat/pod-rebuild`; apply 0024 and 0026 | Sequenced last so the DB moves once, deliberately. |

---

# 10. Extension — locked 2026-08-07 (the unified-app session)

> Founder session that decided how the ONE app onboards and shapes itself. These lock the
> product model the `bt-app` frontend renders. Where one refines an earlier decision it says so.

## 10.1 Decisions D-31..D-38

| # | Decision | Consequence |
|---|---|---|
| **D-31** | **KYC prompts, never gates.** A capability unlocks on *either* a verified document *or* a recorded self-declaration. Both are evidence; neither is a wall. | Refines D-5 (which deferred KYC entirely). A transporter over the ₹20 L GST threshold who has not filed GST still sees the fleet-owner surfaces once they sign the **under-threshold / will-provide-later acknowledgement** we pop up. The declaration is an *artifact* (a missing KYC record is only an absence), so it is the stronger legal position. Applies to every persona — driver, shipper, fleet owner. |
| **D-32** | **Primary persona is a FRONT DOOR, not a ladder.** At signup the user picks a primary persona — shipper, driver, **or fleet owner directly** — and it shapes the initial UI and the onboarding checklist. It gates nothing. | Corrects the earlier "shipper→driver→fleet owner promotion" framing: that chain is *one emergent path* (a driver who buys a second truck), not the only entry. A fleet owner who never drives declares "fleet owner", lands in the fleet console in a **setup state**, and is never made to onboard a truck-as-a-driver first. Capabilities still emerge from assets underneath (§4.2) — you cannot *assign* a truck you do not own — but the declared persona sets the initial shape so nobody climbs a ladder they do not belong on. |
| **D-33** | **A persona-completeness ring** shows what a persona still needs (KYC docs, GST, bank, trucks) as a percentage. Incomplete never blocks; it nudges. | The visible form of D-31. Per-persona requirement sets: **driver** = Aadhaar + PAN + driving licence; **fleet owner** = the driver set (if they also drive) + GST + business/bank details; **shipper** = GST, prompted when a load is interstate / needs an e-way bill, or when volume is high. Each unmet item is a prompt with an acknowledgement escape hatch (D-31), never a gate. |
| **D-34** | **Magic-link auth is DELETED.** Password + a production-grade password-reset flow only, one flow for the whole app. | The per-role `DRIVER_/SHIPPER_/FLEET_MAGIC_LINK_URL` routing (and the whole magic-link surface) goes away — nobody used it and under one front door it has no correct destination. Auth becomes conventional email+password as the rest of the industry runs it. Password reset is reviewed and hardened separately (single origin, single-use token, the callback-allowlist from the 2026-08-07 security fix). |
| **D-35** | **The consignee is NOT a persona and NOT a KYC subject.** They join the network through a single emailed **claim link** to a standalone form — no app install, no KYC. | Refines D-22's claim trigger. The shipper already put the consignee's email on the booking, so we email them a signed, single-purpose URL → a standalone form where they confirm/complete only what a consignee needs (delivery confirmation, the details the LR/e-way-bill/invoice name them on). Landing on that form is "in the network" *lightly* — enough to be a named party on the documents and to drive the POD, and nothing more. They never carry a persona, a completeness ring, or a KYC burden. |
| **D-36** | **`bt-app` is a FOURTH app, built alongside the three — not a rewrite of them, and the three are not deleted.** It references the existing apps' capabilities and unifies them under one capability-gated shell. | The driver/shipper/fleet apps stay in the repo and running. `bt-app` is themed on the **fleet console** (`fleet/`) — its sidebar, layout and business-grade UI are the convention to follow, because that is the strongest UI we have and this is a tool for businesses. |
| **D-37** | **One endpoint now; per-persona subdomains are a FUTURE option, not built.** | MVP is a single origin. Later, a persona shift can move the session to a persona subdomain (cleaner isolation, an easier place to harden). Not designed now — noted so nothing precludes it. |
| **D-38** | **The home is a single action feed** ("what needs me right now?") where each item carries its own persona tag and renders in its idiom. | §3.2 already locked the shape. The open build question (§10.2) is only HOW the backend assembles it. |

## 10.2 The home feed — the one backend question still open

The feed interleaves items of different persona kinds — *"3 bids on your load [shipper]"*, *"trip to Pune tomorrow [driver]"*, *"Ravi accepted your invite [fleet]"* — into one time-ordered list. Two ways to build it, and this is a real fork the frontend depends on:

- **Client fan-out:** `bt-app` calls the existing per-surface endpoints (bookings, quotes, trips, fleet) in parallel and merges the results in the browser. Zero new backend. But every home render is N round-trips through the gateway, pagination across sources is awkward, and each app re-implements the merge.
- **A server aggregate — `GET /me/feed`:** one endpoint that resolves the viewer's capabilities, queries only the sources those capabilities touch, and returns one ranked, paginated list of typed items. One round-trip, one place that knows the ranking, and it is reusable. Costs a new read-only endpoint (naturally lands in `bt-booking-service`, which already holds most sources).

**Recommendation: the server aggregate.** The feed IS the product's front page; a fan-out makes it slow and puts persona logic back in the client, which is exactly what the capability model moved to the server. Decision pending founder confirmation.

## 10.3 Distance to a working frontend — the honest gate

The backend now serves capabilities, relations and documents correctly. **What still stands between "start the UI" and "the UI actually works":**

1. **De-role-ify authorization (D-27) — the hard blocker.** ~30 sites still authorize on the JWT `role` string. The unified app shows every user every surface their capabilities allow, then the API 403s the ones the stale `role` forbids (a truck-owning driver cannot `POST /bookings`; a distributor cannot bid). **This must land before or with Phase 1 or the app is a tour of 403s.**
2. **A driver-profile / fleet-profile creation endpoint.** Today the `drivers`/`fleet_owners` row is only ever created from the signup role-branch. "Add your truck → become a carrier" and "accept a fleet invite → become an employed driver" both need real endpoints.
3. **The home feed source (§10.2).**
4. **Consignee claim endpoint (D-35)** + the standalone form.
5. **Magic-link removal + password-reset hardening (D-34).**
6. **`GET /me/feed` or the client-fan-out decision.**

None of these is the frontend itself; all are its preconditions. Sequencing them is §10.4.

## 10.4 Build order to a working `bt-app`

| # | Backend precondition (no UI) | Unblocks |
|---|---|---|
| 1 | De-role-ify authorization → capabilities + `relationsToBooking` everywhere (D-27) | every surface not 403-ing |
| 2 | Driver/fleet profile-creation endpoints + persona-completeness data (D-32/D-33) | the emergence CTAs and the ring |
| 3 | Magic-link removal + production password reset (D-34) | one clean auth flow |
| 4 | Consignee claim endpoint + standalone form (D-35) | POD + documents name a real party |
| 5 | `GET /me/feed` aggregate (D-38, §10.2) | the home page |
| — | **Then** Phase 1 of `UNIFIED_APP_PLAN.md`: fork `fleet/` → `bt-app`, capability-gated shell, deploy | the app itself |

Steps 1–5 are backend and independent of the UI signal. Phase 1 is the first frontend step and waits on the founder's go.

---

## Reversal notes (append-only)

### 2026-08-12 — FB-04: GST hard-gates posting a load (overrides D-5 / D-31 for this action)

**Product override.** D-5 (KYC does not gate use at MVP) and D-31 (KYC prompts, never gates) still
stand for verification badges, persona completeness rings, and capability *visibility*. They no
longer apply to **`POST /bookings`**: a shipper must have a GSTIN present on `users.gstin` **or**
their `fleet_owners.gstin` before a load can be posted. A D-31 `gst_under_threshold`
acknowledgement alone does **not** satisfy the gate.

Rationale: Aditya product call during MVP feedback — interstate freight without a GSTIN on the
posting party is not operable for invoice / e-way bill issuance. Settings path: `PATCH /auth/me/gstin`
(and existing fleet owner settings for `fleet_owners.gstin`).

Do not silently edit D-5/D-31 rows above; this dated note is the reversal.

### 2026-09-18 — FD-01: delegated fleet-staff access via `fleet_members` grants (opens D-1/§7's seam)

**Extension, not reversal.** D-1 ("account = one human, no organisations, no shared logins")
STANDS — there is still no shared login and no organisation entity. What changes is that §7's
explicitly-deferred case — *"a distributor with dispatch clerks cannot delegate"* — is now open.

A human may be granted specific ACTIONS on a fleet they do not own, via a new `fleet_members`
row (migration 0036): `(fleet_owner_id, user_id, grants[], status)`. This does **not** reintroduce
a `role` column (D-2/D-3): a grant is a FACT about a person's relationship to a fleet — the same
shape as `fleet_drivers`, resolved per request — never a stored authorization label.
`fleet_owners.user_id` stays UNIQUE; delegation lives in the new table, never by relaxing ownership.

Grants are actions, not job titles: `dispatch`, `bid`, `settle`, `documents`, `manage_drivers`,
`manage_assets`, `view_analytics`, `admin`. Authorization moves from *"is this user the fleet
owner?"* to *"does this user hold this grant on this fleet?"* — `requireFleetAccess`
(`bt-fleet-service/src/lib/fleet-access.ts`) supersedes `requireFleetOwner` on every operational
route (owner ⇒ all grants; a delegate ⇒ only their granted actions; `admin` ⇒ all).

Four invariants:
- **Money visibility follows the grant, per fleet.** Analytics (P&L / fuel / surplus) is gated by
  `view_analytics`, and the resolver only ever returns fleets the caller owns or holds a live grant
  on — so a clerk at Fleet A can never reach Fleet B.
- **Bank details and KYC stay with the owner.** They live on the owner's own user/profile with no
  fleet-scoped read path; `settle` lets a clerk RECORD a payment, never see an account. Fleet
  registration and the owner's GSTIN/profile routes remain `requireFleetOwner` (owner-only).
- **Grants are looked up PER REQUEST, never baked into the JWT**, so revoking a member takes effect
  on their next call.
- **The audit records the acted-for fleet** (`ops_overrides.acted_for_fleet_owner_id`, 0036); truck
  assignment was already traceable via `vehicle_assignments.assigned_by` + `fleet_owner_id`.

Pilot scope: the table + the permission check ship; there is **no management UI** — ops set grants
directly in `fleet_members` (~20 users). Deferred: a management UI; and extending the grant check to
the cross-service surfaces that still resolve a lone owner (bt-booking-service LR/document issuance,
bt-tracking-service fleet map) — those stay owner-only until a follow-up.

Do not silently edit D-1 or §7 above; this dated note is the extension.
