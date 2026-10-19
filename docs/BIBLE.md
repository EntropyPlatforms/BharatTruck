# BharatTruck — THE BIBLE

> **This is the sole source of truth for this repo's documentation.** It replaces the fragmented
> `docs/` folder (22 files that had drifted out of sync with each other and with reality — see §0.3).
> Every file it folded in now carries a short superseded-banner stub pointing back here. If you are
> looking for a doc that used to live at `docs/SOMETHING.md`, it's a section below.
>
> Tracked externally via the founder's PMO tool (`entropy-pmo.netlify.app`, Supabase-backed, project
> `p_bt`) — that tool tracks task **status** (`pmo_items`, ref-tagged like `W1-7`); it does not hold a
> second copy of this content. **This file is the only place the actual content lives.**

---

## Table of contents

- [§0 — How to use this doc](#0--how-to-use-this-doc)
- [§1 — Product spec](#1--product-spec)
- [§2 — Execution plan & committed scope](#2--execution-plan--committed-scope)
- [§3 — Maps & Tracking](#3--maps--tracking)
- [§4 — Team operating model](#4--team-operating-model)
- [§5 — Current live state](#5--current-live-state)
  - **New here, or planning what to build next? Read [§5.0](#50-what-changed-on-2026-07-28-read-this-first-if-youre-new-to-the-repo)
    and [§5.6](#56-honest-progress-assessment-2026-07-28--read-before-planning) first.** §5.0 is what
    changed on 2026-07-28 (CD went from silently dead to green); §5.6 is the evidence-based answer to
    "how far along are we really" — the short version is that the platform is built but no trip has
    ever traversed the real production path.
- [§6 — Browser QA harness](#6--browser-qa-harness)
- [§7 — Runbooks](#7--runbooks)
- [Appendix A — Audit trail & rulings](#appendix-a--audit-trail--rulings)
- [Appendix B — Engineer scorecard](#appendix-b--engineer-scorecard)
- [Appendix C — Monorepo provenance](#appendix-c--monorepo-provenance)
- [Appendix D — Pricing & payments status (for the other coder)](#appendix-d--pricing--payments-status-for-the-other-coder)

---

## §0 — How to use this doc

### 0.1 Trust tiers (read this before trusting any section)

Not everything below carries the same authority. This file organizes by tier instead of flattening
everything to one level, and each tier keeps its *own* governance rule intact:

| Tier | Sections | Rule |
|---|---|---|
| **Frozen** | §3.1 (Maps CONTRACT), §3.2 (Maps DECISIONS log) | Changing a locked item requires a new `D-xxx` decision appended to §3.2 — never edit/reorder/delete an existing entry, never silently contradict the CONTRACT. |
| **Authoritative plan** | §2 (execution/scope) | Wins on *how we build / what we cut* — except the frozen Maps CONTRACT wins on maps/tracking specifics. |
| **Product spec** | §1 | The "what," not the "how/cut." §2 wins over §1 on scope conflicts. |
| **Standing process** | §4, §6, §7 | Valid until explicitly changed here (not a dated snapshot — update in place). |
| **Living current-state** | §5 | **The one section every session should update.** Superseded the old habit of writing a brand-new "handoff" doc every few days that re-described state from scratch (see §0.3) — now there's one table to keep current instead of five going stale in parallel. |
| **Historical record** | Appendices A–D | Append-only logs / point-in-time snapshots. Don't rewrite history — add a new dated entry. |

**Companion file — `docs/INDIA_FREIGHT_COMPLIANCE.md`** (added 2026-08-03). Legal/regulatory reference
for e-way bills, LR/consignment notes and POD: what the platform may and may not do without becoming a
**GTA**, the e-way bill integration model (ASP-on-GSP), document retention, and the evidentiary design
for photo/QR POD. It lives outside this file for the same reason the Maps PLAN did — it is sourced,
citation-heavy research with its own verified/unverified confidence marks, and flattening it into a
tier here would destroy the thing that makes it safe to use. **Read it before touching any
document-generation, POD or pricing-presentation code**; §1.3 in particular sets three commercial red
lines that constrain `bt-pricing-service` and `bt-payment-service`, not just the document layer.

### 0.2 The self-iteration rule

This file goes stale the same way its predecessors did if nobody maintains it — that's the exact
failure mode this consolidation exists to fix. Before ending a session that touched anything this
file documents:

1. Did the *code* change in a way §5 (current live state) describes? Update §5's tables in place.
2. Did you find a new testing gotcha or a new known bug? Add it to §6 (harness) or §5, dated.
3. Did you make or need a maps/tracking decision? **Append** a new `D-xxx` to §3.2 — do not edit §3.1
   or an existing §3.2 entry.
4. Did a scope/cut decision change (a founder call, a new committed cut)? Update §2 in place, and if
   it reverses something §2 already stated, say so explicitly with the date rather than silently
   overwriting — future readers need to know a reversal happened, not just the new state (see §2's
   own escrow/RL note for the pattern to follow).
5. Did you finish or start a `feat/*` branch? See §0.4 — create/delete its task MD, don't grow this
   file's "current branches" table into a fifth handoff-chain document.

A stale Bible costs the next session more tokens re-discovering context than the two minutes it takes
to add a line. This is the same rule the old browser-harness document used to enforce on its own (much
narrower) scope — it's now just enforced here, for everything.

### 0.3 Why this file exists (so nobody re-litigates the consolidation)

Before 2026-07-20, `docs/` held 22 files including a **five-deep handoff chain**, each written to be
"the self-contained brief for anyone picking up this codebase cold," each superseding the last, each
re-describing current state from scratch: `AGENT_HANDOFF.md` (07-04) → `CTO_HANDOFF.md` (07-11) →
`CTO_HANDOFF_LIVE.md` (07-15) → `SESSION_HANDOFF_2026-07-19.md` (07-19). By the end, `AGENT_HANDOFF.md`'s
build-state table said the trip lifecycle was unbuilt — it had actually been code-complete and live
for over a week. Separately, `docs/EXECUTION_ROADMAP.md` still said RL pricing + Razorpay escrow were
cut, while the founder had reversed that on 2026-07-12 (`SESSION_HANDOFF_2026-07-19.md §6` flagged the
gap but nothing ever fixed the source file). Two different docs gave two different answers depending
which one a reader opened. All of that folded into this file so there is exactly one place to keep
current, and exactly one place to check before assuming you know the state of the project.

The originals were kept for a while as "superseded, see here" stubs. **They were deleted on
2026-08-07** — a stub still shows up in a grep, still gets opened, and a week of code audits kept
finding engineers reading files whose only true sentence was the banner. Git history holds them if
anyone needs the original wording. Every filename named in this section is therefore **historical
only**: nothing below asks you to go read one, and if a doc or comment ever points you at one, fix
the pointer rather than restoring the file. `docs/MAPS_TRACKING_PLAN.md` is the one file that stayed a
real, separate file (linked from §3.3) rather than folding in — it's a 1200+ line engineering
narrative meant to be read as deep reference during a build phase, not top-to-bottom, and inlining it
here would bury everything else.

### 0.4 Task MDs — how branch-level work is tracked (new convention, 2026-07-20)

Going forward, an active `feat/*` branch gets its own file at **`docs/tasks/<branch-name>.md`**
(slashes in the branch name become dashes, e.g. `feat/some-slice` → `docs/tasks/feat-some-slice.md`).
This replaces the old habit of tracking active branches in ad-hoc tables buried in a handoff doc (e.g.
the old `CTO_HANDOFF_LIVE.md §4` "Wave-2 branches" table).

- **Create it** when the branch starts. Contents: what the task is, acceptance criteria, a link to the
  relevant section of this file, a PMO `ref` if one exists (see §0.1's PMO note at the top), progress
  notes, and real verification evidence as it lands (build output, curl transcripts — the same
  evidence bar §4.2 has always required in a `report`).
- **Delete it on merge.** Git history plus Appendix B's append-only scorecard log already preserve the
  permanent record — a task MD is a working document for the life of the branch, not a permanent
  archive. (If you'd rather archive them under `docs/tasks/archive/` instead of deleting, that's a
  one-line change to this rule — just make it explicitly, don't let both patterns coexist silently.)
  **This half of the rule was not being followed:** on 2026-08-07 all 8 files in `docs/tasks/` belonged
  to already-merged branches and were swept. Delete yours in the same PR that merges the branch.
- This is a lighter-weight parallel to §4's IPC `task`/`report` messages, not a replacement for them —
  the IPC message is the *notification*; the task MD is the *durable record* a human or another session
  can read without replaying the IPC log.

---

## §1 — Product spec

_Folded in from the former `docs/BHARATTRUCK_MVP_PRD.md` v1.0, created 2026-06-30 (deleted 2026-08-07). Condensed here — the original's Part 3
(build-state) and Part 10 (release timeline) are dropped in favor of §5 (current-state, kept fresh) and
§2 (the authoritative execution plan) respectively, so this file doesn't hold two competing versions of
either. Everything else is close to the source._

| | |
|---|---|
| **Product** | BharatTruck (built on the LogisticOS microservices platform) |
| **Target ship** | **31 August 2026** (hard deadline) |
| **North-Star metric** | **Completed Paid Trips** |
| **Goal of this MVP** | Prove **feasibility** — a fleet owner/driver can run a real interstate freight trip end-to-end through the platform instead of phone+WhatsApp. Not a scale or compliance milestone. |

### 1.1 One-page overview

A two-sided freight marketplace replacing the manual "call a transport guy on WhatsApp" process. A
**Shipper** posts a load; **Drivers/Fleet Owners** compete for it via auction or strike a direct
contract; the truck is matched, the trip is GPS-tracked live, delivery is proved via a receiver OTP,
and money settles through the platform. The promise: **transparency & trust for shippers**, **comfort
& analytics for fleet owners**.

**The MVP delivers:**
1. **Identity & KYC** — sign up, KYC-gated onboarding (Driver: PAN+Aadhaar; Truck: Vahan/RC; Shipper
   KYC above ₹50k), manually approved by ops, "Verified" badge.
2. **Load + Booking** — point-to-point FTL/LTL load; **auction** (many drivers bid) or **direct
   contract** (1:1); capped 5-round time-boxed negotiation; booked price is final.
3. **Pricing** — cost-breakdown engine (fuel/driver/per-km) as the anchor price.
4. **Payments** — cash-recorded/direct first; escrow is a later upgrade (see §2's scope note).
5. **Live Tracking** — driver app streams GPS; shipper sees the truck on a live Google Map; geofenced
   pickup/drop; >1hr halt alerts.
6. **POD + Cargo Ledger** — receiver-email **OTP closes the trip**; checkpoint photos carry EXIF GPS.
   (On-chain hash-anchoring is deferred — see §2.)
7. **Ops Console** — one web console: KYC approval queue, live trips, manual override.

**Reality check (as designed, 2026-06-30):** the platform was ~30% built at PRD-authoring time — see
§5 for what's actually built *now*, which is substantially further along.

**Out of scope for MVP:** multi-pickup/multi-drop, partial delivery, mid-trip price changes, driver
ratings, intracity loads, WhatsApp/voice booking, real-time auto driver-matching, full payment/legal
compliance.

### 1.2 Personas & the truck-derived role model

| Persona | App/Surface | Description |
|---|---|---|
| **Shipper** | Shipper PWA | SME moving city-to-city loads. Wants transparency & trust. |
| **Driver/Fleet Owner** | Driver-Fleet PWA → Capacitor Android | **Primary audience.** One combined persona — role is *derived from trucks on the account*, not fixed. May be non-literate → icon-led, vernacular UX. Very low friction tolerance. |
| **Ops** | Ops Console (web) | Single on-call operator. Approves KYC, watches trips, resolves exceptions, overrides. |
| **Receiver/Consignee** | No account — email only | Enters the delivery OTP. May differ from the shipper. |

**Truck-derived roles (core design decision):** register 1 truck → Driver; add a 2nd → Fleet Owner
(can be both simultaneously). A Fleet Owner assigns any fleet truck to any affiliated driver; the
assignment reflects in that driver's app. A truck need not be in the user's legal name — we verify the
*truck's* authenticity (Vahan/RC), not ownership chain. Roles are fluid and migratable.

### 1.3 MVP scope (In/Out)

**Priority legend:** P0 = the "Completed Paid Trip" loop cannot happen without it. P1 = strongly
wanted, degrade gracefully if not. P2 = post-MVP.

Full capability table (29 items spanning identity/KYC, booking, pricing, tracking, POD/ledger,
payments, ops console, notifications, infra, Capacitor) is unchanged from the original PRD — see
§2 for what's actually committed-in vs. committed-out, which is the version that wins on conflicts.

**Explicitly OUT of MVP (product-level, not the scope-cut list in §2):** multi-pickup/multi-drop,
partial/short delivery, mid-trip price renegotiation, driver ratings, intracity loads,
WhatsApp/voice/vernacular-voice booking, real-time automated dispatch, in-app turn-by-turn nav (deep-link
instead), full RBI/PA escrow legal compliance, GST tax-invoice issuance.

### 1.4 Detailed scope by module (goal + requirements + acceptance criteria)

Current build status per module lives in §5, not here — this table is the durable "what it should do,"
kept stable across the deploy churn §5 tracks.

**5.1 Identity, Roles & KYC** (`bt-auth-service` + Ops Console) — Every paying actor is a verified
human/entity, every working truck is a verified vehicle, roles flow from trucks. Auth: email+pw, magic
link, Google OAuth, phone OTP via MSG91. Truck-derived roles + truck CRUD (Vahan/RC verify via
Surepass). Driver KYC minimum gate: PAN+Aadhaar+DL+bank (penny-drop). Shipper KYC only above ₹50k.
Manual ops approval → "Verified" badge + trip-count. PII: AES-256-GCM + SHA-256 dedupe hash.
*Acceptance:* sign up → add truck → Vahan-verify → PAN+Aadhaar+bank KYC → ops-approved → "Verified" →
can bid. 2nd truck flips to Fleet Owner; assignment appears in the driver's app. >₹50k shipper order
blocked until shipper-KYC clears.

**5.2 Load Posting & Booking** (`bt-booking-service` + Shipper app) — Point-to-point only (no
multi-leg). Load fields: origin/destination (geocoded), weight/quantity, material type, truck type,
pickup schedule, auction end time, FTL/LTL, optional e-way bill. **Auction** (blind, multi-driver bid,
shipper picks) or **Direct Contract** (1:1, single per load at MVP). Booked price final except
detention. Lifecycle: `pending → negotiating → accepted → in_transit → completed → paid` (+
`cancelled`/`expired`). *Acceptance:* full-field FTL post is visible to eligible drivers; auction losers
auto-expire; direct-contract fleet accepts → `accepted`; trip can progress all the way to `paid`.

**5.3 Negotiation** (`bt-booking-service`) — Bilateral counter-offers, **capped at 5**, time-limited by
auction-end/offer-expiry, append-only immutable log. *Acceptance:* thread stops accepting counters
after 5 rounds or deadline, whichever first; full thread visible to both parties.

**5.4 Pricing Engine** (`bt-pricing-service`) — Truck classes: **2-3 big-truck classes in the
MCV/HCV range**. Deterministic cost-breakdown (fuel/driver-wage/per-km/handling) as the P0 anchor,
input `(truck_category, distance, age)`, market constants (mileage by BS-norm, AdBlue %, service cost
by age, diesel price, driver wage, capacity, handling). Dynamic RL layer (LinUCB, 16-feature market
context) is P1/data-dependent — see §2's scope note on its current in/out status. Quote persistence
(`quote_id`) so shown price == charged price. *Acceptance:* posting a load returns a line-item
breakdown; the quoted price is the price charged at booking. See Appendix D for the Python-engine
history behind this module's constants.

**5.5 Payments & Escrow** (`bt-payment-service`) — Multiple modes: **Escrow (Razorpay)**, **Direct**,
**Cash** (recorded off-platform). Escrow: shipper funds on booking → held → released on POD-OTP.
Payout to verified bank (penny-drop). Detention: configurable per-hour charge. Compliance explicitly
NOT required to pass at MVP (feasibility test only) — flag every money endpoint as compliance-pending.
*Acceptance (escrow mode, if in scope — see §2):* shipper funds, money held, POD-OTP releases payout to
driver bank, observable end-to-end (test-mode acceptable). Cash/direct modes recorded correctly
regardless.

**5.6 Live Tracking & Maps** (`bt-tracking-service` + both apps) — See §3 in full; this is the frozen
contract's territory. One-line summary: driver streams GPS (10-15s near pickup/drop, ~60s mid-trip);
shipper sees a Google Map with moving truck + route + ETA; geofence detects pickup/drop arrival;
>1hr halt alerts (P1); navigation is a deep-link handoff, never in-app turn-by-turn.

**5.7 Proof of Delivery, Checkpoints & Cargo Ledger** (`bt-cargo-ledger` + driver app) — **POD =
receiver-email OTP**; entering the correct OTP is the key that completes the trip and triggers payout.
Checkpoint photos carry EXIF GPS, stored in an object sink. Ledger/blockchain hash-anchoring: **core by
original PRD, but committed OUT of the first Completed Paid Trip** — see §2's ruling; checkpoint photos
may still be captured, just not chain-anchored yet. *Acceptance:* delivery completes only when the
receiver enters the emailed OTP; each checkpoint photo is stored with GPS EXIF.

**5.8 Ops Console** (`bt-ops-web`) — Real auth+RBAC (ops staff only). KYC approval queue with real
handlers. Live trip board (position/status/ETA/halts) across all drivers/fleets. Users/Fleets/Trucks
management. Exceptions/disputes: full trip-state view + manual override (reassign, refund, force-payout,
edit a stuck booking). *Acceptance:* ops approves a real KYC, watches a real trip live, manually
intervenes on a stuck trip — all against real platform data.

**5.9 Notifications** (`bt-booking-service` + infra) — Notify on: new load, new quote/counter,
award/loss, status changes, payment events, KYC result. At least one channel. *Acceptance:* a driver is
notified of a new matching load and an award without the app open.

**Channel decided (2026-07-31): EMAIL.** This closes §5 open-decision #6 for MVP — email needed no
vendor onboarding (WhatsApp Business takes weeks) and the SMTP transport already existed for auth OTPs.
SMS/WhatsApp remain post-MVP additions on the same outbox.

Shape: a durable **outbox** (`notification_outbox`, migration 021) in `bt-booking-service`, drained by
a dispatcher with retry/backoff, dead-lettering and a delivery audit trail. Other services post to
`POST /internal/notifications`; that route owns audience resolution (the `drivers.id` → `users.id` hop).
**Login/POD OTPs are deliberately NOT in the outbox** — a human is blocked on those, so they stay
synchronous inline sends. 15 events wired (marketplace, trip lifecycle, payments, fleet invites,
password-changed); per-category opt-out + RFC 8058 one-click unsubscribe; transactional mail cannot be
muted. Not yet wired: digests/reports. The event catalogue itself is
`packages/shared/src/notifications.ts` — read it rather than a doc.

> **Operational gate:** the dispatcher only runs when something invokes it. On Cloud Run that means a
> **Cloud Scheduler job** hitting `/internal/notifications/dispatch` — see §7.1. Without it, mail queues
> silently and nothing errors. `GET /health` reports `email: smtp|console` to make the related
> mis-config visible.

**5.10 Platform/Infrastructure** (cross-cutting) — API gateway routes `/api/*` to every service; DB
migrations in version control; real env config (no secret behind `NEXT_PUBLIC_`); both apps build
green; Driver app wrapped in Capacitor for native background GPS before the real pilot.

### 1.5 The three core user journeys

1. **Shipper:** post load → auction bids or direct contract → negotiate (≤5 rounds) → pick winner →
   fund → watch truck live → checkpoint/halt updates → receiver OTP → trip closes → settlement.
2. **Driver/Fleet Owner:** sign up → add truck (Vahan/RC) → KYC → ops-approve → Verified → (fleet) add
   trucks + affiliate drivers → browse loads → bid/accept → negotiate → win → deep-link navigate →
   stream GPS → checkpoint photos → receiver OTP closes trip → get paid.
3. **Ops:** review KYC queue → approve/reject → monitor all live trips → on exception → open trip
   detail (negotiation + GPS + checkpoints + ledger + payment) → override.

### 1.6 Data requirements (standalone procurement list)

Isolated so data-dependent features can be sourced separately from engineering:

- **Pricing (highest priority):** vehicle parc counts, real demand-supply signal per corridor/time,
  weather/monsoon API, harvest-season calendar, live diesel price by state, validated truck cost
  constants, real road distance/tolls (Google Routes, already the chosen provider).
- **Maps & tracking:** GCP Maps Platform project + 3 APIs + 2 restricted keys + Map ID (Phase-0 gate,
  see §3) + per-API quota caps.
- **KYC:** Surepass account/key (Aadhaar v2, PAN, RC/Vahan, DL, GST, bank penny-drop, face-match);
  MSG91 (SMS/OTP) + a WhatsApp provider.
- **Payments:** Razorpay merchant (+ RazorpayX, + Route/escrow if available) + a registered entity for
  onboarding.
- **Ledger/storage:** object storage bucket for checkpoint photos; a blockchain endpoint + funded
  wallet if/when the chain-anchor work resumes.

### 1.7 Non-functional requirements

Real auth boundary everywhere (no fake login); auth on every money endpoint; webhook signature
verification; PII encryption + hashed lookups; JWTs toward httpOnly cookies (currently localStorage —
XSS-exposed, a known gap, see §5); booking/payment/POD path transactional/idempotent; DB migrations in
version control; GPS breadcrumbs persisted for dispute resolution; tracking ingest sized + cached for N
concurrent trucks; error tracking + structured logs + an ops-override audit trail; Driver app usable by
non-literate users (icon-led, large tap targets, works on cheap Android + intermittent data).
Compliance (RBI PA/escrow, DPDP, goods-liability) is explicitly deferred for the feasibility MVP but
tracked as a launch-blocker for the real post-feasibility launch.

### 1.8 MVP Definition of Done (deliverables checklist)

- [ ] Real Fleet Owner signs up, Vahan-verified truck, PAN+Aadhaar+bank KYC, ops-approved → Verified.
- [ ] Real Shipper posts a point-to-point interstate FTL/LTL load with the full field set.
- [ ] Drivers bid in auction (or shipper sends direct contract); 5-round cap + deadline respected;
      shipper picks the winner.
- [ ] Shipper sees a price with a fuel/driver/per-km breakdown, locked at booking.
- [ ] Shipper funds the trip (mode per §2's current scope).
- [ ] Driver runs the trip; shipper watches it live on a map; geofence + halt signals work.
- [ ] Driver captures checkpoint photos with GPS EXIF, stored in the sink (chain-anchoring per §2).
- [ ] At drop, receiver enters the emailed OTP → trip completes.
- [ ] Driver/fleet receives payout (mode per §2) or settlement is recorded.
- [ ] Ops watches every trip live and can manually override a stuck/exception trip.
- [ ] Driver app runs as a Capacitor Android app with native background GPS.
- [ ] At least one notification channel delivers load/quote/status/payment alerts.
- [ ] All services build + deploy on Cloud Run, reachable through the gateway; DB schema reproducible
      from committed migrations; both PWAs build green; Driver Android APK produced.

### 1.9 Risks (condensed)

Scope vs. 8-week deadline with several trust-critical subsystems starting near zero (mitigated by
ruthless happy-path focus, §2's cut order); payment-intermediary legality (RBI PA/escrow — prefer
Razorpay Route/escrow-as-a-service over self-custody, tiny volumes, counsel before real-money scale);
KYC/PII handling at real scale (DPDP — encrypt+minimize now, launch-blocker later); web background GPS
unreliable (Capacitor Android for the real pilot); pricing accuracy on synthetic/placeholder data
(ship the deterministic breakdown as the anchor, treat RL as directional); blockchain anchoring
cost/complexity (anchor one Merkle root per shipment, not per checkpoint, if/when it resumes); Cloud
Run cold-start latency on OTP/booking (min-instances on hot services); single ops person as the safety
net (make override actions first-class); non-literate driver UX (icon-led flows, early usability test).

### 1.10 Open questions — status (originally PRD Part 13)

| # | Question | Status |
|---|---|---|
| 1-3 | Payments demo mode / Razorpay custody / registered entity | Tangled up in the escrow/RL reversal — see §2's scope note. Founder re-confirmation still needed. |
| 4 | GPS ingest transport: Kafka vs Redis | **Resolved: Redis pub/sub** (D-010, §3.2) — lighter, kept for the pilot. |
| 5 | Auth: finish Supabase Auth migration vs. keep custom JWT | **Resolved: kept custom HS256 JWT** — see §5. |
| 6 | Notification channel: SMS vs WhatsApp vs both | **Resolved 2026-07-31 — EMAIL ships as the MVP channel** (§5.9). Chosen because it needed no vendor onboarding and the SMTP transport already existed for auth OTPs. SMS/WhatsApp are post-MVP additions on the same outbox; WhatsApp Business onboarding still takes weeks, so start it early if it is wanted for the pilot. |
| 7 | Contract semantics: single direct booking vs. standing/recurring | **Resolved: single direct contract per load** at MVP; recurring stayed post-MVP. |
| 8 | Blockchain choice + anchoring wallet | **Resolved OUT of the first Completed Paid Trip** (Appendix A §0 ruling #3) — the "which chain" question is moot until it resumes. |
| 9 | Exact 2-3 supported truck classes | **Resolved: MCV / HCV** (aligned to the frozen tracking fuel-estimate decision, D-009). |
| 10 | Native app: Capacitor feasible solo? | **Resolved: yes**, Capacitor wrapping the existing Next.js Driver app (~95% reuse, native GPS). |

### Appendix A (of §1) — pricing engine spec provenance

The PRD's original pricing spec described a from-scratch **Python** RL system (`cto_data.py` market
constants, `cto_engine.py` deterministic breakdown, `pretrain.py`/`market_sim.py`/`rl_agent.py` for the
LinUCB dynamic layer). **What's actually deployed is a TypeScript deterministic engine** (see §5) — the
Python codebase's real value turned out to be its data-grounded market constants, which are slated to
be harvested into the TS engine rather than the Python runtime being deployed (Appendix A §7 has the
full review). Kept here for that harvesting reference, not as a build target.

### Appendix B (of §1) — tech stack & conventions (as built)

Backend: Node 20 + TypeScript + Fastify + Zod (pricing was originally spec'd as Python+FastAPI; the
deployed reality is TS — see above). DB: Supabase Postgres (service-role; lat/lng decimals, no
PostGIS) + Redis. Frontend: **`bt-app/` (Next.js 16/React 19) is the single front door (D-36)**. The
pre-unification `driver/`, `shipper/`, `fleet/` (Next 16) and `bt-ops-web` (Next 14, auth/data stubbed)
apps were retired and deleted from the repo on 2026-09-26; their Cloud Run services (bt-driver,
bt-shipper, bt-fleet-console, bt-ops-web) are to be deleted. Maps: Google Maps Platform per §3. Payments: Razorpay (+RazorpayX). KYC: Surepass. OTP:
MSG91. Storage: object store for checkpoint photos. Infra: GCP Cloud Run (`asia-south1`); Nginx gateway
(`bt-gateway`) as the single edge; keyless OIDC CI/CD; **this one monorepo**, not polyrepo (see
Appendix C). Conventions: snake_case JSON; `{success, data}` / `{success:false, error, code}` envelope;
client JWT access+refresh (migrating toward httpOnly cookies).

---

## §2 — Execution plan & committed scope

_Folded in from the former `docs/EXECUTION_ROADMAP.md` (deleted 2026-08-07), decisions locked 2026-07-04. **This section wins on how-we-build
and what-we-cut**, except the frozen Maps CONTRACT (§3.1) wins on maps/tracking specifics._

**The bar (definition of done for the whole MVP):** one shipper → one driver → one **tracked, proven,
PAID** interstate trip, completed end-to-end by a real external user who is not on the team.
**Deadline:** 31 Aug 2026 · **North Star:** Completed Paid Trips.

**Decisions locked 2026-07-04** (do not silently reverse; log a dated change here if you must):
1. **Repo model → one fresh monorepo.** Consolidated from the scattered Entropy-LLP standalones;
   those, the stale `Entropy-LLP/LogisticOS` aggregate, and the dead `deltaos1997/*` mirrors are
   retired — never push to them.
2. **Team → small (2-4 engineers).**
3. **First paid trip → cash-recorded/direct settlement.** Razorpay escrow is a *later upgrade*.
4. **Scope → cut-order committed** (see §2.1). RL pricing, escrow, blockchain ledger, fleet reviews,
   detention, halt alerts were OUT of the first Completed Paid Trip.

> ### ⚠️ SCOPE REVERSAL — NOT YET RECONCILED (flagged 2026-07-19, still open 2026-07-20)
> The founder reversed decision #4 above on **2026-07-12**: **escrow and RL pricing are back IN
> scope**, overriding the cut-order below. This reversal was recorded "from memory" in the 2026-07-19
> session handoff (that file is gone; this banner is now the record) but **the cut-order table in §2.1
> below was never actually rewritten to match**
> — it's carried forward here exactly as the source doc had it, with this banner, rather than silently
> editing it, because the reversal itself has not been re-confirmed against a primary founder decision
> record. **Before planning escrow or RL work: get the founder to explicitly re-confirm current scope**,
> then update §2.1 in place and remove this banner (log what changed and when, per §0.2 rule 4).

### 2.1 Operating principles

1. **One source of truth, one working tree.** Until `git clone && git pull` yields the real code and
   `git push` lands it where CI reads, every status is fiction.
2. **Walking skeleton before deep features.** Thinnest end-to-end thread running before thickening.
3. **Vertical slices, not horizontal layers.** DoD = demoable through the UI on the pilot corridor.
4. **Ruthless triage against the North Star.** Non-load-bearing bits are cut or faked-by-Ops.
5. **Trunk-based, PR-reviewed, CI-green, production-ready only.** No stubs/TODOs in `main`.
6. **Progress is visible and honest.** One board tracks the slice, not per-service %.

### 2.2 The committed scope (as locked 2026-07-04 — see the reversal banner above)

**IN — the spine:** sign-up/login (all 3 surfaces) · truck-derived roles + truck CRUD · KYC gate
(manual ops approval acceptable early; real Surepass/Vahan later) · point-to-point load posting ·
auction + direct contract · bilateral negotiation (≤5 rounds, deadline) · CTO cost-breakdown pricing
with quote-lock · full trip lifecycle `accepted → in_transit → completed` · live GPS + shipper live
map + geofence · deep-link nav · **POD = receiver-email OTP that closes the trip** · cash-recorded/
direct payment + payout record · Ops live-trip board + override · ≥1 notification channel · API
gateway + DB migrations in VC · Capacitor Android wrap for the on-road pilot.

**OUT — as originally cut** (subject to the reversal banner above for escrow + RL specifically): RL/
LinUCB dynamic pricing · Razorpay escrow + milestone split · blockchain hash-anchor ledger (checkpoint
photos may still be captured; the on-chain anchor is deferred) · fleet-owner reviews · per-hour
detention · >1hr halt alerts · multi-pickup/multi-drop · mid-trip renegotiation · in-app turn-by-turn.

**Never cut, regardless of any reversal or re-scoping:** lifecycle closure, tracking map, POD-OTP, KYC
gate.

### 2.3 The one vertical slice (drive this to 100% first)

**Booking #1, on the pilot corridor, from post to paid** — see §5 for current status of each step:
1. **Lifecycle closure** — `accepted → in_transit → completed` transitions + throttled
   `location_history` breadcrumb write.
2. **Live tracking rendered end-to-end** — `bt-tracking-service` `/track` aggregate + `<LiveTrackMap/>`
   in `shipper/`.
3. **POD closes the trip** — receiver-email OTP drives `in_transit → completed` + triggers payout.
4. **Payment (cash-recorded)** — mark the trip `paid`; record the driver payout. No escrow (pending
   the reversal reconciliation above).
5. **Ops can see + override** — real login/RBAC, live-trip board, manual force-complete/reassign.

**Slice DoD:** an external shipper posts a real interstate load, a KYC-approved driver wins and runs
it, the shipper watches it live, the receiver's OTP closes it, money is recorded as settled — through
the UI, no manual DB edits.

### 2.4 Weeks 0-8 (re-baselined 2026-07-04)

| Wk | Theme | Exit criteria |
|---|---|---|
| 0 | Stabilize & Connect | Walking skeleton walks; CI green; monorepo live |
| 1 | Lifecycle spine | Booking moves `accepted → in_transit → completed`; breadcrumbs written |
| 2 | Tracking rendered | Shipper live map shows a (simulated) moving truck via `/track` |
| 3 | Close the loop | Receiver-OTP POD closes the trip; cash-recorded payment marks it `paid` — first end-to-end slice green |
| 4 | Ops + hardening | Real ops auth/RBAC, live-trip board on real data; smoke tests on money/booking/POD |
| 5 | Real identity | Un-stub KYC (Surepass PAN/Aadhaar/bank + Vahan/RC), Verified badge, real approval queue |
| 6 | Go native | Capacitor Android wrap; ≥1 notification channel |
| 7 | Pilot dry-run | Real driver, real device, real GPS; bug-bash the money/POD path |
| 8 | The proof | External non-team user completes one tracked, proven, paid trip unaided |

**If the spine finishes early**, pull from the OUT list in order: escrow → halt alerts → detention →
reviews (subject to the reversal banner — escrow may already be back in play; confirm before assuming
this order still applies as written).

### 2.5 Cadence & rituals

Daily: trunk-based, PR per change, CI green before merge. Weekly: demo the vertical slice end-to-end
on the corridor (simulator OK); re-confirm the cut-list still holds. Definition of Done per feature:
merged to `main`, CI green, reachable + demoable through the UI, no stub left behind.

---

## §3 — Maps & Tracking

> **Before touching any tracking/maps code:** read §3.1 in full. §3.1 is **FROZEN** and wins over §3.3
> and everything else on tracking/maps specifics. Never silently fork a decision — to change anything
> locked in §3.1, append a new `D-xxx` to §3.2. Follow §3.3: one phase per working session, phases 0-6,
> strictly sequential. Phase 0 is a hard gate before any map code.

### Frozen facts (quick reference — full detail in §3.1-3.2)
- **Provider:** Google Maps Platform. Only Routes API + Places API (New) + Maps JavaScript API. Legacy
  Directions/Places APIs are BLOCKED for new GCP projects — never reference them.
- **Navigation** is a deep-link handoff to the phone's Google Maps app — no in-app turn-by-turn.
- **Ingestion stays in `bt-booking-service`.** `bt-tracking-service` never rebuilds it, only READS
  `location_history` for history/idle-detection.
- **DB:** Supabase Postgres, no PostGIS. lat/lng are plain decimals.
- **Polling:** 10s GPS polling for the pilot (no WebSocket push).
- **Cost control:** per-API quota caps + restricted keys. Billing budget alerts only, does not cap.
- **Frontend:** `@vis.gl/react-google-maps`. `<LiveTrackMap/>` is **copied** into each app (driver/,
  shipper/ are separate Next projects) — no shared npm package.

### Locked env-key names
`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (HTTP-referrer-restricted, browser, Maps JS only) ·
`GOOGLE_MAPS_SERVER_KEY` (secret, `bt-tracking-service` ONLY, Routes + Places New) ·
`NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (vector Map ID) · `DIESEL_PRICE_INR=90` (default, editable).

### 3.1 — The CONTRACT (FROZEN)

_Folded in from the former `docs/MAPS_TRACKING_CONTRACT.md` (deleted 2026-08-07). **Status: FROZEN.** This is the single source of truth for
the Maps & Tracking build. On ANY conflict between this and §3.3 (or anything else), **this wins.**
Decisions confirmed 2026-06-18. Changing anything here requires a new `D-xxx` decision (§3.2). Anything
not locked on 2026-06-18 is tagged inline **(INFERRED — confirm)** and must not be treated as frozen
until confirmed._

#### CONTRACT §1 — Purpose & Scope

BharatTruck is an India interstate/intrastate freight-booking marketplace built on the LogisticOS
microservices. The MVP bar is a single proven loop: one shipper → one driver → one tracked, proven,
paid interstate trip. Today the `driver/`/`shipper/` PWAs already poll live location every 10s but
render raw `lat`/`lng` as **text** — the map layer is the missing piece this feature delivers.

**What `bt-tracking-service` OWNS (new logic only):** a server-side Google Maps proxy with Redis
caching — cached base route polyline (Essentials/static tier, long TTL); live traffic ETA
(TRAFFIC_AWARE/Pro tier, short TTL); traveled breadcrumb history read from `location_history`;
petrol-pump search (Places API New, top-8); fuel estimate (mileage-by-class × editable diesel price);
route alerts (off-route/idle/near-drop); the shipper read-through aggregate (**endpoint #8, LOCKED**).

**What STAYS in `bt-booking-service` (do NOT rebuild):** raw GPS ingestion (`POST /location/update`,
`GET /location/driver/:driver_id`, `GET /location/booking/:booking_id`, Redis-backed, 30s TTL) —
`bt-tracking-service` consumes this but never re-implements it. The `location_history` breadcrumb
**WRITE** belongs to the ingestion path in `bt-booking-service`; `bt-tracking-service` is read-only.

**Out of scope:** no WebSocket/push (10s HTTP polling, Decision 5/D-010); no in-app turn-by-turn
(deep-link, D-004); no PostGIS (D-007); no shared npm package for the map component (copied per app,
D-013).

#### CONTRACT §2 — Service Facts

| Fact | Value |
|---|---|
| Service name | `bt-tracking-service` |
| Runtime | Node.js 20 (`node:20-alpine`) |
| Framework | Fastify 4 |
| Language | TypeScript 5, ESM (`"type":"module"`, NodeNext, `.js` import specifiers) |
| Port | 3006 |
| Deploy | GCP Cloud Run, `asia-south1`, multi-stage Dockerfile, `USER node` |
| Cache | Redis (`ioredis`), `trk:` namespace |
| DB access | Supabase JS (service-role) — read-only on `location_history` |

Folder layout mirrors `bt-auth-service`/`bt-booking-service`:
```
bt-tracking-service/
├── Dockerfile
├── .env.example
├── package.json               # "type":"module"; dev(tsx watch)/build(tsc)/start
├── tsconfig.json
└── src/
    ├── index.ts               # cors → /health → redis → scoped(auth + tracking routes)
    ├── plugins/{auth,redis}.ts
    ├── lib/{google,cache,supabase,booking,types}.ts
    └── routes/tracking.ts     # /api/tracking/* prefix
```

Bootstrap shape:
```ts
async function bootstrap() {
  await app.register(cors, { origin: true })
  app.get('/health', () => ({ status: 'ok', service: 'bt-tracking-service', ts: new Date().toISOString() }))
  await app.register(redisPlugin)
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(trackingRoutes, { prefix: '/api/tracking' })
  })
  await app.listen({ port: Number(process.env.PORT ?? 3006), host: '0.0.0.0' })
}
```

#### CONTRACT §3 — Environment Variables (LOCKED names)

| Variable | Side | Restriction | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | Browser (both PWAs) | HTTP-referrer restricted; Maps JS only | Loads the vector map |
| `GOOGLE_MAPS_SERVER_KEY` | Server only (`bt-tracking-service`), SECRET | Restricted to Routes + Places (New) | Server calls to Routes/Places |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | Browser | Public style ID | Vector Map ID |
| `DIESEL_PRICE_INR` | Server | — | Fuel estimate default (**90**) |
| `PORT` / `NODE_ENV` / `REDIS_URL` / `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `JWT_SECRET` | Server | secrets as noted | standard service env |
| `BOOKING_SERVICE_URL` | Server | *(INFERRED — confirm; alt. is direct Redis read)* | base URL of `bt-booking-service` for live-position read-through |

**Never** put `GOOGLE_MAPS_SERVER_KEY` behind a `NEXT_PUBLIC_` prefix — two physically different,
separately-restricted keys (D-005).

#### CONTRACT §4 — Endpoints

Conventions for every endpoint: JSON is **snake_case**; path param is **`:bookingId`**; all
`/api/tracking/*` are JWT-gated except `/health`; success = `{success:true,data}`; error shape per §4
below; live position sourced from `bt-booking-service`, never re-ingested.

| # | Method | Path | Google API/tier | Cache key | TTL |
|---|---|---|---|---|---|
| — | GET | `/health` | none | — | — |
| 1 | GET | `/api/tracking/route/:bookingId` | Routes — Essentials/static | `trk:route:{id}` | 24h *(INF)* |
| 2 | GET | `/api/tracking/eta/:bookingId` | Routes — TRAFFIC_AWARE/Pro | `trk:eta:{id}` | 60s *(INF)* |
| 3 | GET | `/api/tracking/history/:bookingId` | none (DB read) | `trk:history:{id}` | 15s *(INF)* |
| 4 | GET | `/api/tracking/pumps/:bookingId` | Places New — searchNearby | `trk:pumps:{id}` | 120s *(INF)* |
| 5 | GET | `/api/tracking/fuel/:bookingId` | none (arithmetic) | `trk:fuel:{id}` | 1h base *(INF)* |
| 6 | GET | `/api/tracking/alerts/:bookingId` | none (geometry) | `trk:alerts:{id}` | 30s *(INF)* |
| 8 | GET | `/api/tracking/track/:bookingId` **[LOCKED]** | Routes (composed, cached) | `trk:track:{id}` | 10s *(INF)* |

*(Only the 500m/15min/2km thresholds, top-8 pump default, Essentials-vs-Pro tier split, the endpoint
set/paths, and snake_case/`:bookingId` conventions are LOCKED. Numeric TTLs/limits tagged (INF) are
starting points to confirm.)*

**`GET /api/tracking/route/:bookingId`** — cached base route polyline. Routes API `computeRoutes`,
Essentials/static tier (`TRAFFIC_UNAWARE`). Response: `booking_id, source{lat,lng,address},
destination{...}, polyline, distance_km, static_duration_seconds, provider:"google_routes",
tier:"essentials", cached_at`.

**`GET /api/tracking/eta/:bookingId`** — live traffic-aware ETA. Routes API, TRAFFIC_AWARE/Pro tier
(Decision 1/D-006), origin = live position, destination = booking drop. Response: `booking_id,
current_location{lat,lng,updated_at}, destination, eta_seconds, eta_iso, remaining_distance_km,
in_traffic, provider, tier:"traffic_aware_pro", computed_at`. No live position → `{success:true,
data:null, message:"No recent driver location — ETA unavailable"}`.

**`GET /api/tracking/history/:bookingId`** — traveled breadcrumb trail from `location_history`
(read-only). Query: `since` (ISO-8601), `limit` (default 500, max 2000, *INFERRED*). Response:
`booking_id, point_count, points[{lat,lng,speed_kmh,heading,recorded_at}]`.

**`GET /api/tracking/pumps/:bookingId`** — top-**8** nearest petrol pumps (D-011). Places API (New)
`searchNearby`, `includedTypes:["gas_station"]`, ranked by distance. Query: `limit` default 8 (LOCKED),
`radius_m` default 5000 *(INFERRED)*. Response: `booking_id, origin, limit, pumps[{place_id, name,
lat, lng, distance_m, address, brand}]`. Legacy Places API is BLOCKED.

**`GET /api/tracking/fuel/:bookingId`** — fuel estimate (D-009). `fuel = distance_km / mileage_kmpl ×
diesel_price`. Query overrides: `vehicle_class` (`MCV`|`HCV`), `mileage_kmpl`, `diesel_price`,
`distance_km`. Prefilled mileage *(INFERRED — confirm)*: `MCV ≈ 6.0 kmpl`, `HCV ≈ 3.5 kmpl`. Response:
`booking_id, vehicle_class, distance_km, mileage_kmpl, diesel_price_inr, litres_required,
estimated_fuel_cost_inr, inputs_overridden`.

**`GET /api/tracking/alerts/:bookingId`** — route alerts (D-012). Geometry only, no Google call.
**Thresholds (LOCKED, tunable after the first real drive):** `off_route` > **500 m** from base
polyline; `idle` no meaningful movement > **15 min**; `near_drop` within **2 km** of destination.
Response: `booking_id, evaluated_at, current_location, alerts[{type, active, ...}]`.

**`GET /api/tracking/track/:bookingId` — [LOCKED #8]** — the shipper read-through aggregate: current
location + route + live ETA + status in ONE call. Identity, path, and role are LOCKED and MUST NOT
change. Composes from §4.1/§4.2's caches — does not multiply Google calls. Response: `booking_id,
status, current_location{lat,lng,heading,speed_kmh,updated_at}, route{polyline,distance_km,source,
destination}, eta{eta_seconds,eta_iso,remaining_distance_km,in_traffic}, served_at`. No live position
yet → `current_location`/`eta` are `null`, `route` still populated, `status` reflects the booking.

**Error shape** (matches `bt-booking-service`/`bt-auth-service`): `{success:false, error:"human
message", code:"MACHINE_CODE"}`. Codes: `VALIDATION_ERROR`(400), `UNAUTHORIZED`(401), `FORBIDDEN`(403),
`NOT_FOUND`(404), `INVALID_TRANSITION`(409), internal `500`. `TrackingError` class mirrors
`BookingError` (message, code, httpStatus). Validate via zod.

#### CONTRACT §5 — Data Contract: `location_history` (migration 009)

Migration 009 ENABLES a new breadcrumb table. **No PostGIS** — lat/lng are plain decimals. Throttled
**~1 point / 10-15s** (D-007/D-002). Proposed columns *(INFERRED — confirm against the real
migration)*: `id` (bigint/uuid PK), `booking_id` (FK→bookings), `driver_id` (FK→driver), `lat`, `lng`
(double precision), `heading` (0-360, null), `speed_kmh` (null), `accuracy_m` (null), `recorded_at`
(timestamptz), `created_at` (default now()). Suggested index: `(booking_id, recorded_at)`.

**Read/Write ownership (CRITICAL):** **WRITE owner = `bt-booking-service`** — the throttled breadcrumb
insert happens on the existing GPS ingestion path (`POST /location/update`), the same path that writes
the 30s-TTL Redis live position. `bt-tracking-service` **NEVER writes** `location_history`. **READ
owner = `bt-tracking-service`** — serves `/api/tracking/history/:bookingId` and feeds `/alerts` idle
detection.

#### CONTRACT §6 — Google Maps Platform: Usage & Cost Rules

**Provider is LOCKED to Google Maps Platform.** Exactly three APIs enabled; anything else is out of
contract.

**Allowed (and ONLY these):** Maps JavaScript API (browser, `<LiveTrackMap/>`); Routes API (server,
`/route` Essentials + `/eta` TRAFFIC_AWARE/Pro); Places API (New) (server, `/pumps` searchNearby,
`gas_station`).

**BLOCKED — never reference:** legacy Directions API; legacy Places API; any Google Maps API not
listed above.

**Keys & restriction:** two physically separate, restricted keys, never interchanged —
`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (HTTP-referrer restricted, Maps JS only, safe to ship client-side)
and `GOOGLE_MAPS_SERVER_KEY` (secret, API-restricted to Routes+Places New, lives ONLY in
`bt-tracking-service`).

**Cost control:** cost cap = per-API quota limits + restricted keys. **A billing budget only
ALERTS — it does NOT cap spend.** Pilot (~20 users) is expected to fit inside Google's free monthly
tiers. Redis caching (§4 TTLs) is the primary lever — `/track` (#8) MUST serve from `route`/`eta`
caches rather than fresh Google calls on every 10s poll.

**Phase-0 gate (BEFORE any map code)** — see §3.3's Phase 0: create the GMP/GCP project; enable exactly
the 3 APIs; create the 2 restricted keys; set per-API quota caps. Testing (later phases): real Android
drive tests on the pilot corridor + a route-replay GPS simulator. **Geolocation requires HTTPS** for
phone testing.

#### CONTRACT §7 — Frontend Contract

**No map library was installed at the time of freeze.** The React map layer MUST use
`@vis.gl/react-google-maps`. **No shared npm package (D-013):** `driver/` and `shipper/` are separate
Next.js 16/React 19 projects, so `<LiveTrackMap/>` is **COPIED** into each app — keep the two copies in
sync manually. Per-app deliverables: **shipper/** → `<LiveTrackMap/>` (live-tracking, fed by `/track`);
**driver/** → `<LiveTrackMap/>` (navigation view) + insights (pumps/fuel/alerts) + the deep-link nav
helper. **PWA basics (D-008):** minimal manifest + service worker; Screen Wake Lock API during a drive.

`<LiveTrackMap/>` props *(INFERRED shape — only "uses `@vis.gl/react-google-maps`, copied per app,
consumes the locked endpoints/env keys" is frozen)*: `bookingId`, `currentLocation`, `routePolyline?`,
`source?`, `destination?`, `historyPath?`, `etaSeconds?`, `mapId`, `apiKey`, `follow?`, `height?`,
`onMarkerClick?`.

**Deep-link navigation (D-004):** hand off to the phone's Google Maps app — **NOT** in-app
turn-by-turn. `buildNavDeepLink({destination, origin?, travelMode:'driving'})` → locked URL bases:
`https://www.google.com/maps/dir/` (universal) and `comgooglemaps://` (iOS, falls back to https if
absent). Same behavior on web now and React Native later.

#### CONTRACT §8 — Conventions & Change Control

**Conventions (FROZEN):** JSON is snake_case everywhere; every tracking route is namespaced under
`/api/tracking/…` with the `:bookingId` path param; **endpoint #8 is LOCKED** as the shipper
read-through aggregate; petrol-pump default limit = 8; every `/api/tracking/*` route is JWT-gated
(`/health` open). Success = `{success:true,data}`. Error = `{success:false,error,code}` via a
`TrackingError` class.

**FROZEN — change control:** any change to a LOCKED item (the endpoint set/paths, endpoint #8's
identity, snake_case/`:bookingId` conventions, env-key names, the provider/API choice, the deep-link
nav model, the 500m/15min/2km thresholds, the top-8 pump default, the Essentials-vs-Pro split, the
write-owner=booking-service rule, or the copy-per-app rule) **requires a new `D-xxx` decision** (§3.2)
recorded before implementation. Items tagged **(INFERRED — confirm)** are not frozen and should be
pinned down during build, updating this section when they are.

**On any conflict with §3.3 (or anything else), this section (§3.1) wins.**

### 3.2 — DECISIONS log (append-only, D-001..D-013)

_Folded in from the former `docs/MAPS_TRACKING_DECISIONS.md` (deleted 2026-08-07). **This log is APPEND-ONLY.** Never edit, reorder, or
delete an existing `D-xxx` entry — a decision that turns out wrong is *superseded* by a NEW
higher-numbered entry that references it, not rewritten in place. A real fork of any locked decision
in §3.1 requires **asking the founder** before it is recorded here. On any conflict between this log
and §3.1, §3.1 wins; this log records *why* each locked item is what it is. Entries D-001..D-013 below
were all confirmed together on **2026-06-18**._

**D-001 — New `bt-tracking-service` instead of extending `bt-booking-service`**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** The feature adds a distinct body of logic — cached route+ETA, pump search, fuel
  estimate, alerts, the shipper aggregate. Folding it into booking-service would bloat a service
  already on the critical booking path and couple Google quota/latency risk to core booking flows.
- **Decision:** Stand up a new microservice `bt-tracking-service` (Fastify/TS/Node 20, port 3006)
  following the existing microservice recipe. It owns only the new derived/read logic. Raw GPS
  ingestion STAYS in `bt-booking-service` and is never re-implemented.
- **Consequences:** Clean separation of Google-cost/latency risk from the booking path; one more
  service to operate; must degrade gracefully when live position is stale (>30s TTL).

**D-002 — Provider is Google Maps Platform (ease-of-build over lowest cost)**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Needs routing, traffic ETA, place search, a rendered map. Engineering time is the
  scarce resource at pilot scale (~20 users), not per-call price.
- **Decision:** Standardize on Google Maps Platform for the whole feature. Pilot volume expected to
  fit Google's free monthly tiers.
- **Consequences:** Vendor concentration on Google; cost must be actively controlled (D-005).
  Revisiting the provider later is a founder-level `D-xxx`, not an incremental change.

**D-003 — Routes API + Places API (New) + Maps JavaScript API; legacy APIs BLOCKED**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Legacy Directions API and legacy Places API are BLOCKED for new GCP projects.
- **Decision:** Enable and use exactly three APIs: Maps JavaScript API (browser), Routes API (server,
  `computeRoutes`), Places API New (server, `searchNearby`). Never reference legacy Directions/Places.
- **Consequences:** Future-proof against Google's legacy deprecations. This three-API set is the only
  allowed Google surface.

**D-004 — Navigation is a deep-link handoff (no in-app turn-by-turn)**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** An in-app navigator (voice guidance, rerouting, lane guidance) is far beyond the MVP
  bar; drivers already trust Google Maps.
- **Decision:** Deep-link handoff via `buildNavDeepLink()` using `https://www.google.com/maps/dir/`
  (universal) and `comgooglemaps://` on iOS (falling back to https if absent). Driving mode. Same on
  web now and React Native later.
- **Consequences:** Near-zero nav maintenance; lose in-app control of the nav experience. Per-app
  deliverable (copied, D-013).

**D-005 — Two physically separate restricted keys + per-API quota caps**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** A public browser key and a powerful server key have different threat models; Google's
  billing budget only ALERTS, does not cap spend.
- **Decision:** `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (HTTP-referrer restricted, Maps JS only) and
  `GOOGLE_MAPS_SERVER_KEY` (secret, Routes+Places New only, `bt-tracking-service` only, never
  `NEXT_PUBLIC_`). Plus per-API quota caps as the *hard* spend ceiling, enforced at the Phase-0 gate.
- **Consequences:** A leaked browser key can't drive billable server calls. Two rotation paths to
  manage. Redis caching (D-006) is the primary lever to stay inside free tiers.

**D-006 — ETA uses Routes TRAFFIC_AWARE ("Pro"); base route uses static Essentials tier**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Base route geometry is stable per booking; live ETA must reflect current traffic. The
  Pro tier costs more than Essentials.
- **Decision:** `/route` → Essentials/static (`TRAFFIC_UNAWARE`), cached long (target 24h, INFERRED).
  `/eta` → TRAFFIC_AWARE/Pro, cached short (target 60s, INFERRED). `/track` (#8) composes these two
  caches rather than issuing fresh Google calls.
- **Consequences:** Pay the Pro price only for ETA, and only ~once per short TTL window. Tier split is
  LOCKED; TTL numbers are INFERRED starting points.

**D-007 — Persist throttled breadcrumbs to `location_history` (migration 009)**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** The live position lives in Redis with a 30s TTL — good for "where is the truck now" but
  it evaporates; no traveled-path/history view, no basis for idle detection over time.
- **Decision:** Enable `location_history` via migration 009, throttled ~1 point/10-15s. **WRITE owner
  = `bt-booking-service`** on the existing ingestion path. `bt-tracking-service` is **read-only**.
- **Consequences:** A durable traveled path becomes available. No PostGIS means geometry math runs in
  app code. Write-owner rule is LOCKED; exact throttle mechanism/column types are INFERRED — confirm
  against the real migration.

**D-008 — PWA manifest + service worker now, with Screen Wake Lock for drives**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** During a drive the driver's screen must not sleep; geolocation testing needs a secure
  context (HTTPS). Investing now smooths the later Capacitor path.
- **Decision:** Add a minimal PWA manifest + service worker now in both apps; use the Screen Wake Lock
  API to keep the driver screen awake during an active drive.
- **Consequences:** Installable, more app-like PWAs. Wake Lock support varies by browser and must
  degrade gracefully (re-acquire on visibility change).

**D-009 — Fuel estimate = mileage prefilled by vehicle class × editable diesel price**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** True per-vehicle mileage and live diesel prices aren't available at MVP, but a
  transparent, editable estimate is valuable and cheap (pure arithmetic, no Google call).
- **Decision:** `fuel = distance_km / mileage_kmpl × diesel_price`. Prefill by vehicle class (MCV/HCV;
  INFERRED starting values ≈ MCV 6.0, HCV 3.5 kmpl), editable diesel price default `DIESEL_PRICE_INR=90`.
  Overridable: `vehicle_class`, `mileage_kmpl`, `diesel_price`, `distance_km`.
- **Consequences:** Instant, override-friendly estimate at no Google cost. Overridden results are not
  cached as canonical.

**D-010 — Keep 10s HTTP polling for the pilot (no WebSocket/push)**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Both apps already poll every 10s over HTTP; a push transport adds infra complexity for
  marginal benefit at ~20 pilot users.
- **Decision:** Keep the existing 10s HTTP polling. Do not introduce WebSocket/push in this feature.
  Cache TTLs (D-006) tuned to sit near the 10s cadence.
- **Consequences:** Up-to-10s staleness, acceptable for interstate freight. A push transport remains a
  clean future upgrade behind the same read endpoints (a later `D-xxx`).

**D-011 — Petrol-pump search returns the top-8 nearest pumps**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Drivers want nearby fuel options without an overwhelming list.
- **Decision:** `/pumps` returns the top-8 nearest via Places API New `searchNearby`,
  `includedTypes:["gas_station"]`, ranked by distance. Default limit = 8 (LOCKED). Cached ~120s
  (INFERRED). Legacy Places not used.
- **Consequences:** A concise, actionable fuel-stop list. The 8-result default is LOCKED; radius/TTL
  are INFERRED and tunable.

**D-012 — Route-alert thresholds: 500m off-route, 15min idle, 2km near-drop**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** Shipper/ops need automatic exception signals without watching continuously. Computed
  with pure geometry (no Google call). Real-world thresholds unknown until the first drive.
- **Decision:** Ship three alerts with starting thresholds (LOCKED, tunable after the first real
  drive): off_route > 500m from base polyline; idle > 15 min no movement; near_drop within 2km of
  destination. Cached ~30s (INFERRED).
- **Consequences:** Immediate, no-cost exception detection. Thresholds deliberately provisional —
  expected to be re-tuned after the first corridor drive.

**D-013 — Copy `<LiveTrackMap/>` per app; lock snake_case + `:bookingId` + endpoint #8 conventions**
- **Date:** 2026-06-18 · **Status:** Accepted
- **Context:** `driver/` and `shipper/` are separate Next.js projects; no shared component package, no
  map library installed yet. A shared npm package adds disproportionate overhead for two copies of one
  component during an MVP.
- **Decision:** (1) Build on `@vis.gl/react-google-maps`, **COPY** `<LiveTrackMap/>` (+ the deep-link
  helper) into each app rather than sharing a package; keep in sync by hand. Shipper gets the
  live-tracking map (fed by `/track`); driver gets navigation + insights (pumps/fuel/alerts). (2) API
  conventions (FROZEN): snake_case JSON; `/api/tracking/…` + `:bookingId`, JWT-gated except `/health`;
  endpoint #8 LOCKED; pump default limit = 8; success/error envelopes via `TrackingError`.
- **Consequences:** Fast, dependency-light frontend with two divergent-by-design consumers; manual-sync
  cost accepted for the MVP. Any change to the locked conventions requires a new `D-xxx` + founder
  sign-off.

**D-014 — Derived tracking state is evaluated ON INGEST, not on read**
- **Date:** 2026-07-31 · **Status:** Accepted
- **Context:** Every tracking surface built through Phase 4 is computed ON READ — `/route`,
  `/eta` and `/track` all answer "where is the truck now" from caches. That model cannot express
  an EVENT. "The truck entered the drop geofence at 14:32 and sat there 90 minutes" exists only
  at the instant it happens; a poll ten minutes later cannot reconstruct it. Geofencing,
  detention and alerting therefore need evaluation on every GPS fix. This is also why
  `route_alerts` had **0 rows in production** despite existing since before the migrations
  directory: nothing had ever been in a position to write one.
- **Decision:** `bt-booking-service` fires a **fire-and-forget** `POST /internal/evaluate` at
  `bt-tracking-service` after each accepted `/location/update`, from **inside the breadcrumb
  throttle gate** so evaluation runs at the same ~1/12s cadence as the breadcrumbs it derives
  from. `bt-tracking-service` owns all geometry and writes only DERIVED state: `trip_telemetry`,
  `geofence_events`, `route_alerts`. Raw GPS ingestion does **not** move — §3.1 §1 and D-007 are
  untouched, and this service still never writes `location_history`.
- **Consequences:** Alerts gain a real lifecycle (open → resolved) deduped by a partial unique
  index on `(booking_id, type) where resolved_at is null`, so a 12-hour off-route condition is
  ONE row, not 3,600. A dropped emit costs only derived data — the next fix recomputes from the
  durable telemetry row. New: migration 0019, `INTERNAL_SERVICE_SECRET` +
  `TRACKING_SERVICE_URL` env, and `SPEEDING_LIMIT_KMH` (default **80**, MoRTH's goods-carriage
  expressway ceiling). The speeding threshold is explicitly **NOT** a D-012 locked value — D-012
  covers only off-route/idle/near-drop — and is expected to be re-tuned after the first drive.

**D-015 — Fuel mileage comes from `vehicle_cost_norms`, superseding D-009's inferred figures**
- **Date:** 2026-07-31 · **Status:** Accepted (supersedes the `(INFERRED — confirm)` mileage
  values in D-009 / §3.1 §4.5; D-009's *formula* stands unchanged)
- **Context:** D-009 tagged its mileage prefills `(INFERRED — confirm)`: MCV ≈ 6.0, HCV ≈ 3.5 kmpl.
  Migration 0018 has since landed `vehicle_cost_norms`, seeded from the founder's own
  `CV_Parc_Tables.xlsx`, which says MCV Cargo 15-19T is **4.98** kmpl and HCV ranges **2.54-4.03**
  by tonnage. The inferred numbers overstate range by 30-40%, which understates fuel by thousands
  of rupees on a single Mumbai-Delhi run — and fuel is the number a fleet owner prices a lane on.
- **Decision:** Resolve mileage from the truck's own `model_category` + `emission_norm` against
  `vehicle_cost_norms`, in three tiers: (1) `vehicle_norms` — exact model; (2) `vehicle_class` —
  class average when the model is unknown; (3) `default` — 3.5 kmpl last resort. Every estimate
  reports which tier produced it (`basis` + `basis_note`) so a class average never renders with
  the same authority as measured data. `BS6_PH2` reads the BS6 columns; a BS4 light truck falls
  back to BS6 because `kmpl_bs4` is legitimately NULL for LCV/ICV/SCV. **DEF is now costed too**
  (`def_pct_*`, ~3-5.5% of the diesel spend), which D-009 omitted entirely.
- **Consequences:** Fuel is honest per truck and degrades without ever blanking. The norms table
  is loaded ONCE per fleet-board request and resolved in memory — a per-vehicle lookup would be
  an N+1 across every poll. `test/fuel.test.mts` pins all three tiers.

**D-016 — The fleet tracking board is VEHICLE-centric, and absent data must state its reason**
- **Date:** 2026-07-31 · **Status:** Accepted · **Founder ask, 2026-07-31**
- **Context:** `bt-fleet-service`'s `GET /fleet/live` iterates the fleet's DRIVER set, so a truck
  with nobody assigned to it never appears at all — a yard of idle trucks rendered as an empty,
  calm-looking map. For an owner that is backwards: the assets earning nothing are the ones
  costing money. Separately, a blank cell on a logistics dashboard is worse than useless — the
  owner cannot tell whether the driver forgot to open the app, the truck is legitimately parked,
  or the platform is broken.
- **Decision:** Add `GET /api/tracking/fleet/overview`, keyed on `vehicles` so **every** asset is
  always a row, each carrying a `status` (`moving` · `idle` · `no_signal` ·
  `assigned_not_started` · `parked` · `inactive`) **and** a `data_health.reason` written in plain
  language for the owner. `/fleet/live` stays as the cheap position-only feed; the two are
  deliberately different shapes. Cost rule is unchanged and still binds: ONE request per tick,
  one Redis MGET plus bounded Postgres reads, **zero** Google calls — route and ETA stay lazy,
  one selected truck at a time.
- **Consequences:** The owner can distinguish "parked and fine" from "should be reporting and
  we've lost it", and a platform-side failure to load a booking says so rather than blaming a
  driver. Also forces the map to be non-load-bearing: `components/map-guard.tsx` keeps a Maps
  rejection from taking the dashboard down with it (see §5.4 item 10).

**D-020 — Geocoding endpoints (address autocomplete + place details) on bt-tracking-service**
- **Date:** 2026-09-17 · **Status:** Accepted · **Product ask (Aditya)**
- **Context:** The post-load form has the shipper type raw decimal `lat`/`lng` BY HAND, with the
  address a separate free-text box (`bt-app/.../post/page.tsx`, `shipper/.../bookings/new`). No
  geocoding exists anywhere in the repo. A mistyped coordinate silently corrupts the POD
  geofence gate (`bt-booking-service/src/lib/pod/geo.ts` measures against `dest_lat/lng`) and the
  fleet P&L distance fallback, and the booking carries no `pincode`/`state_code` — the exact
  fields the e-way bill Part A needs (`fromPincode`/`actFromStateCode`, `INDIA_FREIGHT_COMPLIANCE.md
  §4.3`), which today are derived from GSTIN digits alone.
- **Decision:** Add **two** endpoints to `bt-tracking-service`, the one service that holds
  `GOOGLE_MAPS_SERVER_KEY` (§3.1 §3, unchanged): `GET /api/tracking/places/autocomplete?q=` and
  `GET /api/tracking/places/details?place_id=`. Both use **Places API (New)** — the provider §3.1
  already permits — `places:autocomplete` and Places Details with a **narrow** field mask
  (`id,location,formattedAddress,addressComponents` only; Places bills by field). They
  **deliberately break the `:bookingId` path convention** of §3.1 §4 because geocoding happens
  BEFORE a booking exists; that break is the whole reason this decision is logged rather than
  silently taken. JWT-gated (authed scope, registered before the `:bookingId` handlers so a
  static `/places/*` path is never shadowed), India-biased (`includedRegionCodes:['in']`),
  Redis-cached (autocomplete 1h by normalised query, details 30d by `place_id`), and
  session-token aware so a search + its one details call bill as a single Google session.
  Details returns lat/lng + formatted address + **pincode + GST `state_code`** (the state name is
  mapped via `lib/india-states.ts`).
- **Consequences:** The post-load form can offer real address search and resolve a chosen address
  to coordinates + pincode + state — feeding a correct geofence pin, a correct routed distance,
  and a complete e-way Part A without leaning on GSTIN alone. The **two-pin** model (an address
  pin vs a dragged exact-gate pin) and the saved-address book are a booking-schema concern
  (migration 0035), NOT a maps-contract one — nothing in §3.1 changes. Cost stays bounded by the
  cache + region bias + narrow masks; the pilot (~20 users) sits inside Google's free monthly tier.

**D-021 — Reverse geocoding (Geocoding API) for map-pin pincode/state on bt-tracking-service**
- **Date:** 2026-09-19 · **Status:** Accepted · **Product ask (Aditya)**
- **Context:** D-020 gave the post-load form address autocomplete + place details (address → coords).
  The shipper then asked to ALSO pick a location by dropping a pin directly on the map ("select
  location on map"), and to have the **pincode filled automatically from that pin**. A dropped pin
  yields only `lat`/`lng`; turning a bare coordinate into a postal code + state is **reverse**
  geocoding. Places API (New) has no reverse-geocode (coords → address) — its `searchNearby` returns
  POIs whose `postal_code` is the nearest *place's*, not the point's, and `addressComponents` there
  is the Enterprise SKU. The only Google surface that returns a `postal_code` for an arbitrary point
  is the **Geocoding API**, which is NOT one of the three APIs §3.1 permits (Routes + Places New +
  Maps JS). Doing it silently would fork the frozen contract — hence this note.
- **Decision:** Add the **Geocoding API to the contract for REVERSE geocoding ONLY**, behind a new
  endpoint `GET /api/tracking/places/reverse?lat=&lng=` on `bt-tracking-service` (the sole holder of
  `GOOGLE_MAPS_SERVER_KEY`, §3.1 §3, unchanged). Server-side, JWT-gated, India-biased (`region=in`),
  and Redis-cached by coordinate rounded to ~11 m (4 dp) for 30 days — but a **non-resolved** answer
  (`ZERO_RESULTS`, or `REQUEST_DENIED` when the API is not enabled) is **never cached**, so the
  feature starts working the instant the GCP toggle is flipped, with no stale negative. It returns
  `pincode` + GST `state_code` (state name mapped via `lib/india-states.ts`, exactly as D-020's
  details do). It **degrades, never breaks**: an unenabled API or an empty point leaves the dropped
  pin coords-only (`resolved:false`), and a raw pin never fabricates a `place_id`. Forward geocoding
  stays on Places New; this adds **reverse only**.
- **GCP / infra (Aditya's step, like the KYC key):** enable the **Geocoding API** in the GCP project,
  add it to the `GOOGLE_MAPS_SERVER_KEY` API restrictions, and set a per-API quota cap (cost control
  per §3.1). Until then the endpoint is inert (returns coords-only). Reverse geocoding is a low-tier
  SKU; with the 30-day coordinate cache and the ~20-user pilot it sits inside Google's free tier.
- **Consequences:** A shipper can drop/drag a pin (or "use my location") and the booking captures
  `pincode` + `state_code` for the e-way bill without a typed address — the same fields D-020 gets
  from a typed address, now also from a pin. §3.1's provider list gains exactly one API, scoped to
  reverse geocoding on one server endpoint; the browser key and Maps JS usage are unchanged. The
  map-pick UI in `bt-app`'s `AddressPicker` is a booking-app concern, not a contract one.

**Next D-number: D-022** _(D-017 and D-018 are the pinned-value rows in §3.3's playbook table —
the D-series is a single global sequence across both logs, never two independent counters.)_

### 3.3 — SESSIONS: build playbook (phases 0-6)

_Folded in from the former `docs/MAPS_TRACKING_SESSIONS.md` (deleted 2026-08-07). A per-phase, copy-paste session playbook for building the
Maps & Tracking feature **ONE phase per working session**, phases **0 → 6, strictly sequential**. §3.1
(CONTRACT) is FROZEN and wins on any conflict with this playbook — this section is operational (how to
run each session), §3.1 is normative (what is locked)._

**Golden rules for every session:** (1) Do exactly ONE phase — do not start the next "while you're
here." (2) Never violate a LOCKED item from §3.1/§3.2 — changing one needs a new `D-xxx` first. (3)
Production-ready only — no stubs, no TODOs, no `throw new Error('not implemented')`. (4) Items tagged
`(INFERRED — confirm)` in §3.1 are not frozen — pin them down during the phase that touches them, then
record the pin as a `D-xxx` in §3.2 and update §3.1.

**START ritual** (paste before anything else, every session):
```
START RITUAL — Maps & Tracking build session.
1. Read BIBLE.md §3.1 IN FULL. It is FROZEN and wins on any conflict.
2. Read BIBLE.md §3.3 "Phase status board" and "Decisions log" below.
3. Read the code the phase touches (bt-tracking-service/src, or the shipper/driver app for those
   phases) — the per-service ROADMAP.md files were deleted 2026-08-07; the code is the state.
4. Confirm OUT LOUD, in one line each: which phase am I doing (exactly ONE of 0-6)? Is the PREVIOUS
   phase's DoD fully checked (if not, STOP — finish it first)? Which LOCKED items does this phase
   touch? Which (INFERRED — confirm) values will I pin this session?
5. Only then start work on that single phase.
```
**Sequencing gate:** Phase N may begin only when Phase N-1's DoD is 100% checked. Phase 0 is a hard
gate — no map code, no service code calling Google, until Phase 0's DoD is green.

**END ritual** (run before ending every session):
```
END RITUAL:
1. Re-open BIBLE.md §3.1 and confirm I contradicted NOTHING locked.
2. Tick this phase's DoD checklist in §3.3. If any box is unticked, mark the phase "IN PROGRESS", not "DONE".
3. Update the "Phase status board" below (⛔→🟡→✅) with a one-line note + date.
4. For every (INFERRED — confirm) value pinned: append a D-xxx row to §3.3's decisions log AND update
   the matching line in §3.1 (§3.1 is the source of truth; this log is the change history).
5. Update §5.2 with what actually shipped this phase.
6. Commit on a feature branch (never straight to main); do NOT push unless asked.
7. State the NEXT phase and its one-line entry condition. Do not start it.
```

**Phase status board** (update in the END ritual; ⛔ not started · 🟡 in progress · ✅ done):

| Phase | Scope | Status | Note/date |
|---|---|---|---|
| 0 | GMP/GCP project + 3 APIs + 2 restricted keys + per-API quota caps (NO code) | ✅ | keys live; browser key allowlist is `https://*.run.app/*` |
| 1 | `bt-tracking-service` skeleton (Fastify, 3006, `/health`, config, Dockerfile, git+remote) + Redis + Google proxy scaffold | ✅ | deployed, healthy |
| 2 | `/route` + `/eta` with Redis caching | ✅ | live |
| 3 | migration 009 `location_history` + `/history` read | ✅ | 2026-07-31 — `/history` built; write side was already live |
| 4 | shipper `<LiveTrackMap/>` + `GET /api/tracking/track/:bookingId` + deep-link helper | ✅ | live |
| 5 | driver nav view + `/pumps` + `/fuel` + `/alerts` | ✅ | 2026-07-31 — endpoints + driver map/insights UI, verified against live data |
| 6 | PWA manifest + service worker + wake lock + route-replay GPS simulator + drive-test checklist | 🟡 | driver PWA + wake lock exist; simulator is `scripts/qa/drive-gps.mjs` |

> **Board reconciled 2026-07-31** (it had every phase at ⛔ while most were shipped). Phase 5 closed
> later the same day when the driver map + insights landed (D-019). Work outside the 0-6 plan also
> shipped on 2026-07-31 — the D-014 evaluator, geofencing, trip telemetry, and the D-016 fleet
> board; it does not belong to a phase and is tracked in §5.2 instead.
>
> **Stale branch warning:** `feat/driver-live-map` @ `8f5f54f` (worktree `bt-wt-frontend`) contains
> an EARLIER, unmerged driver map. It is ~53 commits behind, its `page.tsx` hunk is pre-dark-theme
> and would regress the driver UI, and it adds a second `NavigateButton`. It is superseded by
> D-019 — close it rather than rebasing it.

**Decisions log (D-xxx) for this playbook** — every time an `(INFERRED — confirm)` value is pinned, or
any new call is made that §3.1 doesn't already lock, add a row here **and** edit §3.1's line.
Format: `D-xxx | date | phase | what changed | from → to`.

| ID | Date | Phase | Decision | From → To |
|---|---|---|---|---|
| D-000 | 2026-06-18 | — | Base contract frozen (8 decisions, endpoint set, env keys, provider) | — |
| D-014 | 2026-07-31 | 3-5 | Derived state evaluated on ingest, not on read (see §3.2) | read-time only → `POST /internal/evaluate` per fix |
| D-015 | 2026-07-31 | 5 | Mileage pinned to `vehicle_cost_norms`; DEF costed | MCV 6.0 / HCV 3.5 *(INFERRED)* → per-model, 3-tier fallback |
| D-016 | 2026-07-31 | — | Vehicle-centric fleet board with stated reasons for absent data | driver-keyed `/fleet/live` → vehicle-keyed `/tracking/fleet/overview` |
| D-017 | 2026-07-31 | 3 | `/history` limits pinned | default 500 / max 2000 *(INFERRED)* → confirmed as-is |
| D-019 | 2026-07-31 | 5 | Driver map draws own position from LOCAL GPS, never from `/track` | shipper model (poll server) → device geolocation, so it is free, instant and survives no-signal |
| D-018 | 2026-07-31 | 5 | `/pumps` cached on the ROUNDED ANCHOR, not the booking | `trk:pumps:{id}` → `trk:pumps:{id}:{lat2dp,lng2dp}:{limit}:{radius}` — a booking-keyed cache hands a truck at 60 km/h pumps it passed 5 min ago |

**Pre-seeded pin checklist** (each becomes a `D-xxx` when confirmed): TTLs (route 24h · eta 60s ·
history 15s · pumps 120s · fuel 1h · alerts 30s · track 10s); limits (`/history` default 500/max 2000
· `/pumps radius_m` default 5000, cap 8); mileage-by-class (MCV≈6.0, HCV≈3.5 kmpl); live-position read
mode (`BOOKING_SERVICE_URL` HTTP read-through vs. direct Redis read); `location_history` exact
columns/index; CORS `origin:true`.

---

**Phase 0 — GMP/GCP gate (NO map code).** Goal: stand up the Google Maps Platform footprint. Zero code
this session — console/CLI + secrets only. Hard gate.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 0 only — the GMP/GCP gate. NO map code, NO service code this session.
Deliver, using the LOCKED env-key names from §3.1 §3:
1. A GCP project for Maps (or confirm the target) with BILLING enabled.
2. Enable EXACTLY 3 APIs — Maps JavaScript API, Routes API, Places API (New). Legacy Directions/Places
   are BLOCKED — never enable or reference them.
3. Create TWO physically separate, restricted API keys: NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
   (HTTP-referrer restricted, Maps JS ONLY, referrers cover driver+shipper prod/preview/local origins)
   and GOOGLE_MAPS_SERVER_KEY (SECRET, Routes+Places New ONLY, never NEXT_PUBLIC_, lives only in
   bt-tracking-service).
4. Create/record NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID.
5. Set PER-API QUOTA CAPS sized for a ~20-user pilot inside Google's free tiers (this is the hard cap,
   not the billing budget).
6. Set a billing BUDGET ALERT (informational only).
7. Write down where each key lives (secret store + .env.example placeholders). Do NOT commit real
   values to git.
Since this may be non-interactive: produce an exact copy-paste RUNBOOK (gcloud + console click-paths)
so a human can execute and confirm. Record results back into §3.3's decisions log.
Finish with the END RITUAL. Do NOT start Phase 1.
```
*DoD:* GCP project chosen/billing enabled · exactly the 3 APIs enabled, no legacy anywhere · browser
key referrer-restricted/Maps-JS-only, covers driver+shipper origins · server key secret/restricted to
Routes+Places New, never `NEXT_PUBLIC_` · Map ID recorded · per-API quota caps set on all 3 · budget
alert set · key locations documented, no real values committed · runbook written · ROADMAP/status
board/decisions log updated. *Suggested branch:* n/a (no code).

---

**Phase 1 — `bt-tracking-service` skeleton + Redis + Google proxy scaffold.** Goal: a running Fastify
service on port 3006 with `/health`, config, Redis plugin, JWT auth plugin, Google client scaffold, a
Dockerfile, its own git repo+remote. No real Google calls yet. *Entry:* Phase 0 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 1 only — scaffold bt-tracking-service. Follow §3.1 §2's folder layout and
bootstrap shape EXACTLY. Mirror bt-booking-service/bt-auth-service's conventions (read their
index.ts/plugins/auth.ts/lib/redis.ts/lib/supabase.ts/lib/types.ts first).
Build: package.json ("type":"module", Node 20, Fastify ^4, ioredis, @supabase/supabase-js, zod,
pino/pino-pretty; scripts dev/build/start); tsconfig.json (TS5, ESM, NodeNext); src/index.ts (bootstrap
exactly per §3.1 §2); plugins/redis.ts + plugins/auth.ts (JWT gate, same JWT_SECRET); lib/cache.ts
(trk: namespace + TTL constants from §3.1 §4); lib/google.ts (Routes+Places New client SCAFFOLD,
GOOGLE_MAPS_SERVER_KEY, no legacy refs, no calls wired yet); lib/supabase.ts (service-role client);
lib/booking.ts (typed interface + BOOKING_SERVICE_URL config, implement later); lib/types.ts
(snake_case DTOs + TrackingError mirroring BookingError); routes/tracking.ts (register the module, ZERO
endpoints this phase beyond what compiles — no stub 501s, endpoints land in Phases 2-5);
.env.example (all §3.1 §3 keys, placeholders only); Dockerfile (multi-stage node:20-alpine, USER node,
EXPOSE 3006); init a git repo + GitHub remote under the same org as bt-booking-service, first commit on
a feature branch.
Prove it: npm i, npm run build (tsc clean), npm run dev, curl localhost:3006/health → 200.
Finish with the END RITUAL. Do NOT start Phase 2.
```
*DoD:* folder layout matches §3.1 §2 exactly · `npm run build` clean, `/health` → 200 · bootstrap order
matches (cors→health→redis→scoped auth+routes→listen) · Redis connects/closes gracefully, JWT auth
rejects missing/invalid token with 401 · `lib/cache.ts` exposes `trk:` keys + TTL constants ·
`lib/types.ts` has `TrackingError` + §8.3 codes · `lib/google.ts` scaffolds Routes+Places New only, no
legacy refs · `.env.example` has every key, no real secrets, `.gitignore` covers node_modules/dist/.env
· multi-stage Dockerfile · own git repo+remote, first commit on a feature branch · ROADMAP/board/log
updated. *Suggested branch:* `feat/tracking-skeleton`.

---

**Phase 2 — `/route` + `/eta` (Google Routes + Redis caching).** *Entry:* Phase 1 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 2 only — implement GET /api/tracking/route/:bookingId and
GET /api/tracking/eta/:bookingId per §3.1 §4. Both JWT-gated, snake_case, :bookingId, §8 envelopes.
Implement lib/booking.ts for real: read the live position bt-booking-service owns (30s-TTL Redis).
Confirm the read mode — BOOKING_SERVICE_URL HTTP read-through vs. direct Redis read of shared loc:*
keys — pick one, record as a D-xxx in §3.3, update §3.1 §3's BOOKING_SERVICE_URL note. Do NOT
re-ingest GPS here.
/route: Routes API computeRoutes, Essentials/static, TRAFFIC_UNAWARE. Origin/destination = booking's
source/drop. Cache trk:route:{bookingId}, TTL from lib/cache.ts (24h, INFERRED); serve from cache on
hit, only call Google on miss.
/eta: Routes API computeRoutes, TRAFFIC_AWARE/Pro (D-006). Origin = live position, destination =
booking drop. No recent live position → 200 {success:true,data:null,message:"No recent driver location
— ETA unavailable"} EXACTLY. Cache trk:eta:{bookingId}, TTL 60s (INFERRED).
Validate with zod. Unknown booking → 404 NOT_FOUND. Google/network failure → mapped TrackingError,
never a raw 500 leak.
Test: confirm cache HIT on second call (no second Google call), confirm the null-position branch.
Finish with the END RITUAL. Do NOT start Phase 3.
```
*DoD:* `/route` returns the §4.1 shape, Essentials/`TRAFFIC_UNAWARE`, `tier:"essentials"` · `/eta`
returns the §4.2 shape, `TRAFFIC_AWARE`/Pro, `tier:"traffic_aware_pro"` · `/eta` origin is the live
position from booking-service, GPS not re-ingested · null-position branch exact-matches the spec ·
caching verified (`trk:route:*` 24h, `trk:eta:*` 60s, second call = cache HIT, no extra Google call) ·
both JWT-gated/snake_case/`:bookingId`/zod-validated, unknown booking → 404, Google failures → typed
error · live-position read mode decided + recorded as D-xxx, §3.1 §3 updated · TTLs confirmed/pinned ·
ROADMAP/board/log updated. *Suggested branch:* `feat/tracking-route-eta`.

---

**Phase 3 — migration 009 `location_history` + `/history`.** WRITE ownership stays in
`bt-booking-service` (this service is READ-ONLY). *Entry:* Phase 2 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 3 only — migration 009 location_history + GET /api/tracking/history/:bookingId
per §3.1 §4/§5. CRITICAL (LOCKED, §3.1 §5.1): WRITE owner = bt-booking-service. bt-tracking-service
NEVER writes location_history — READ-ONLY.
1. Migration 009: author it (this may be the first committed migration — check current migration
   conventions). Columns per §3.1 §5 (id, booking_id, driver_id, lat, lng, heading, speed_kmh,
   accuracy_m, recorded_at, created_at), NO PostGIS, index (booking_id, recorded_at). Confirm exact
   column names/types, record any deviation as a D-xxx, update §3.1 §5.
2. WRITE side (booking-service): wire the throttled breadcrumb insert (~1pt/10-15s) into the existing
   POST /location/update path. Decide the throttle mechanism + call-site, implement, record as D-xxx.
   Keep the 30s-TTL Redis live position untouched.
3. READ side (this service): GET /api/tracking/history/:bookingId reads location_history read-only.
   Query: since (ISO-8601), limit (default 500, max 2000 — confirm). Return §4.3 shape ordered by
   recorded_at. Cache trk:history:{bookingId} TTL 15s (INFERRED).
zod-validate. Unknown booking or no rows → 200 with point_count 0/empty points (not 404). JWT-gated,
snake_case.
Finish with the END RITUAL. Do NOT start Phase 4.
```
*DoD:* migration 009 exists, versioned, no PostGIS, indexed, columns confirmed + §3.1 §5 reconciled ·
breadcrumb WRITE lives in `bt-booking-service` (throttled, D-xxx recorded), 30s Redis position
unchanged · `bt-tracking-service` writes nothing to `location_history` · `/history` returns the §4.3
shape, `since`/`limit` work, empty → `point_count:0` not 404 · cached 15s, HIT verified · JWT-gated,
snake_case, zod-validated · ROADMAP/board/log updated. *Suggested branches:* `feat/tracking-history`
(tracking) · `feat/booking-breadcrumb-write` (booking).

---

**Phase 4 — shipper `<LiveTrackMap/>` + `/track` (#8) + deep-link helper.** *Entry:* Phase 3 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 4 only. Three deliverables:
A) BACKEND — GET /api/tracking/track/:bookingId [LOCKED #8], §3.1 §4.7. Compose from trk:route:*/
   trk:eta:* caches — MUST NOT multiply Google calls per §3.1 §6.4. Return the §4.7 shape exactly. No
   live position yet → current_location/eta null, route populated, status from booking. Cache
   trk:track:{bookingId} TTL 10s (INFERRED). JWT-gated, snake_case, :bookingId. Endpoint identity/path
   is LOCKED — do not rename or move it.
B) FRONTEND (shipper/) — <LiveTrackMap/> using @vis.gl/react-google-maps (install it; mandated lib,
   §3.1 §7). Props per §3.1 §7 (confirm exact names, record as D-xxx if adjusted). Vector map via
   NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID + the BROWSER key only (never the server key client-side). Draw:
   decoded polyline, source/dest markers, moving truck marker (heading-rotated), optional history
   trail, ETA label. Data source = the existing 10s poll, now hitting /api/tracking/track/:bookingId.
   Replace raw lat/lng TEXT with the map.
C) FRONTEND (shipper/) — deep-link helper buildNavDeepLink(...) per §3.1 §7 (driver reuses in Phase 5,
   land the shared helper now).
Note D-013: <LiveTrackMap/> is COPIED per app. This phase builds the shipper copy; Phase 5 copies into
driver and keeps them in sync manually.
Test: shipper trip screen renders the map, truck marker moves, route+ETA show, null-position degrades
gracefully. Verify #8 serves from cache (no Google call per poll).
Finish with the END RITUAL. Do NOT start Phase 5.
```
*DoD:* `/track` (#8, identity/path unchanged) returns the §4.7 shape, JWT-gated, snake_case · composes
from cache, verified no fresh Google call per 10s poll · null-position branch correct · `trk:track:*`
cached 10s, verified · `@vis.gl/react-google-maps` installed in shipper/; `<LiveTrackMap/>` renders a
vector map via the browser key + Map ID (server key never in client) · map shows polyline, markers,
moving truck, optional trail, ETA overlay; raw lat/lng text replaced · data fed by the existing 10s
poll now calling `/track`; `follow` centers on truck; graceful null-position UI · `buildNavDeepLink`
implemented per §3.1 §7 · prop names confirmed (D-xxx if adjusted); shipper `next build` passes ·
ROADMAP/board/log updated. *Suggested branches:* `feat/tracking-aggregate` (service) ·
`feat/shipper-live-map` (shipper).

---

**Phase 5 — driver nav view + `/pumps` + `/fuel` + `/alerts`.** *Entry:* Phase 4 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 5 only. Backend (3 endpoints) + driver frontend.
BACKEND: 1) GET /api/tracking/pumps/:bookingId — §3.1 §4.4, Places API New searchNearby,
gas_station, anchored at live position, ranked by distance, TOP-8 (LOCKED default). Cache
trk:pumps:{bookingId} 120s. Legacy Places BLOCKED.
2) GET /api/tracking/fuel/:bookingId — §3.1 §4.5, arithmetic only. fuel = distance_km/mileage_kmpl ×
diesel_price. vehicle_class MCV|HCV prefills mileage (confirm exact kmpl, D-xxx). Overrides:
mileage_kmpl, diesel_price (default DIESEL_PRICE_INR=90), distance_km. Cache base (no-override) 1h; do
NOT cache overridden results.
3) GET /api/tracking/alerts/:bookingId — §3.1 §4.6, geometry only, no Google. LOCKED thresholds:
off_route >500m, idle >15min, near_drop within 2km. Cache 30s.
All 3: JWT-gated, snake_case, :bookingId, zod, typed errors, null-position handled gracefully.
FRONTEND (driver/): COPY <LiveTrackMap/> from shipper/ (D-013 — copy per app, keep in sync manually).
Install @vis.gl/react-google-maps. Driver navigation VIEW: the map + a "Navigate" action calling
buildNavDeepLink (copy the helper) — NOT in-app turn-by-turn. Insights UI: nearest pumps list, fuel
estimate card (editable diesel price + vehicle class), route-alert banners.
Test: pumps ≤8 ranked by distance; fuel math correct with/without overrides, caches only the base;
alerts flip at the locked thresholds; driver map + Navigate deep-link opens Google Maps.
Finish with the END RITUAL. Do NOT start Phase 6.
```
*DoD:* `/pumps` uses Places New searchNearby/gas_station, anchored at live position, top-8, cached
120s, no legacy Places · `/fuel` computes correctly with class prefill + all overrides, base result
cached 1h, overrides not cached, no Google call · `/alerts` computes the LOCKED thresholds over cached
route + live position + history, no Google call, cached 30s · all three JWT-gated/snake_case/
`:bookingId`/zod/typed errors/null-position handled · `<LiveTrackMap/>` copied into driver/,
`@vis.gl/react-google-maps` installed, copies noted as manually-synced · driver navigation view: map +
Navigate deep-link, no in-app turn-by-turn · driver insights UI: pumps/fuel/alerts · mileage-by-class +
pump cap/radius confirmed as D-xxx; driver `next build` passes · ROADMAP/board/log updated. *Suggested
branches:* `feat/tracking-insights` (service) · `feat/driver-nav-insights` (driver).

---

**Phase 6 — PWA (manifest + service worker + wake lock) + route-replay GPS simulator + drive-test.**
No new tracking endpoints. *Entry:* Phase 5 DoD ✅.

*Kickoff prompt:*
```
Do the START RITUAL. Phase 6 only — PWA hardening + testing toolchain.
1) PWA basics (driver/ primary; shipper/ if trivial) — D-008: minimal manifest (name, icons,
   start_url, display standalone); minimal service worker (offline shell/basic caching, do NOT break
   the 10s poll); Screen Wake Lock while a drive/trip screen is active, released on
   blur/visibilitychange/trip-end, graceful when unsupported.
2) Route-replay GPS simulator (§3.1 §6.5): replays a RECORDED path ({lat,lng,recorded_at}[]) into
   POST /location/update at the pilot cadence so the truck marker MOVES end-to-end (map, ETA refresh,
   history breadcrumbs, pumps re-anchor, alerts flip) WITHOUT driving. Ship a sample recorded path on
   the pilot corridor. Cadence/speed configurable.
3) HTTPS/secure-context note + drive-test checklist: geolocation requires HTTPS on the phone. Document
   how to expose dev apps over HTTPS for phone testing; write a real-Android drive-test checklist for
   the pilot corridor (live marker, ETA, off-route/idle/near-drop firing, pumps, fuel, wake lock
   holding, deep-link nav opening Google Maps).
Test: install the driver PWA, confirm wake lock holds during a simulated trip, run the simulator
end-to-end watching every surface update, dry-run the drive-test checklist against the simulator before
the real drive.
Finish with the END RITUAL. This is the last phase — note feature-complete + post-pilot follow-ups
(WebSocket push, threshold tuning after first real drive) as out-of-scope, NOT in-scope changes.
```
*DoD:* PWA manifest added, installable · minimal service worker registered, doesn't break the 10s poll
· Screen Wake Lock acquired/released correctly, graceful when unsupported · route-replay GPS simulator
replays a recorded path at pilot cadence, sample corridor path shipped, cadence/speed configurable ·
end-to-end via simulator verified (marker moves, ETA refreshes, breadcrumbs accumulate, pumps re-anchor,
alerts flip, deep-link nav opens Google Maps) — without driving · HTTPS/secure-context documented ·
real-Android drive-test checklist written · post-pilot follow-ups noted as out-of-scope until a new
decision · ROADMAP/board/log updated; feature marked build-complete. *Suggested branches:*
`feat/driver-pwa-wakelock` (driver) · `feat/tracking-gps-simulator` (tooling).

---

**Cross-phase guardrails (quick reference):** Provider = Routes+Places(New)+Maps JS only, legacy
BLOCKED · `GOOGLE_MAPS_SERVER_KEY` never `NEXT_PUBLIC_` · cost cap = per-API quotas (hard) + restricted
keys + Redis caching, budget alerts don't cap, `/track` must serve from cache · ingestion stays in
booking-service, tracking never re-ingests or writes `location_history` · snake_case JSON, `:bookingId`,
JWT-gated except `/health` · endpoint #8's identity/path is immovable · `<LiveTrackMap/>` copied per
app, no shared package · one phase per session, finish the DoD, run the END ritual, don't spill into
the next phase.

### 3.4 — See also

`docs/MAPS_TRACKING_PLAN.md` — the deep, prose-level engineering companion to §3.1 (architecture
diagrams, endpoint-by-endpoint request/response code, the `<LiveTrackMap/>` component skeleton, the
full migration SQL). Kept as a **separate file**, not inlined here, because it's meant to be read as
implementation-depth reference during the phase that needs it, not top-to-bottom. §3.1 still wins on
any conflict with it.

---

## §4 — Team operating model

_Folded in from the former `docs/CTO_ENGINEERING_STANDARDS.md`, `docs/TEAM_GIT_WORKFLOW.md` and
`docs/IPC_TEAM_PROTOCOL.md` (all deleted 2026-08-07).
Standing process — valid until explicitly changed here, not a dated snapshot. On any conflict about
*how we build*, §2 wins; the frozen §3.1 wins on maps/tracking._

### 4.1 System-design standards (the bar for every change)

A change that violates one of these is `changes_requested` on sight:

1. **Clear service boundaries; own your data.** Each `bt-*` service owns its domain and tables — no
   service reads another's tables directly, talk through the gateway/HTTP. `bt-tracking-service` only
   *reads* `location_history` (D-007) — never rebuild ingestion elsewhere.
2. **API contract before integration.** Publish the route path + request/response shape (snake_case
   for tracking; respect `users.id` ≠ `drivers.id`, see §5) in the report before the frontend
   integrates. Contract changes are additive; breaking changes need a new path/version.
3. **The lifecycle is a server-side state machine, single-sourced.** All transitions enforced in one
   place, guarded (only the authorized actor), idempotent. Illegal transitions return `4xx`, never
   `500`. No client-driven state jumps.
4. **Money and POD operations are idempotent and auditable.** Idempotency key on payment-record and
   POD-close; every state change writes a durable, timestamped row — no ephemeral-only truth for
   anything load-bearing.
5. **Schema lives in version control; no ad-hoc DB edits.** Everything reproducible from
   `supabase/migrations/`; migrations forward-only + idempotent (`IF [NOT] EXISTS`). Service-role key
   bypasses RLS, so all authz is app-code, centralized and tested.
6. **Security is fail-closed.** JWT verified on every protected route; no secret behind
   `NEXT_PUBLIC_` (only the public browser map key/Map ID may be public); PII encrypted at rest;
   secrets are mandatory (no weak in-repo defaults). The gateway is the single CORS + rate-limit
   authority.
7. **Observability is not optional.** Propagate a request/correlation id gateway→service→logs;
   structured logs; health checks that actually probe DB/Redis; a global error handler + graceful
   shutdown per service.
8. **Design around the SPOFs that can't be removed.** Google Maps quota is a fail-closed hard cap on a
   never-cut feature → cache aggressively, degrade gracefully, never hammer. Single Redis/Supabase →
   treat as SPOF; pool connections for many Cloud Run instances.
9. **Vertical slice, walking skeleton first.** Progress = "can booking #1 reach `paid`?", not "is
   service X 100%?".
10. **Tests guard the trust-critical paths.** State machine, auth/RBAC, pricing math, money/POD path —
    automated tests, CI green before merge.
11. **DRY the cross-cutting concerns.** JWT verify, service-role Supabase client, error envelope,
    Fastify bootstrap → shared logic goes to `packages/shared` (see §5), not another copy.
12. **No stubs, TODOs, or `throw 'not implemented'` reach `main`.** Production-ready only.

### 4.2 The stage-gate — the CTO is the sole audit/integration/push authority

**Engineers never merge or push to `main`.** They work on short-lived `feat/*` branches (in their own
isolated worktree, see §4.4) and report. The `cto` node is the only node that audits, integrates, and
pushes. The gate for every task:

1. **Engineer → `report`** to `cto`: branch, files changed, the API contract (paths+payloads),
   accept-criteria evidence, real verification output (build log, curl transcript — not "it
   compiles").
2. **CTO audit (mandatory, no rubber-stamp).** Independently: read the diff, run the build/typecheck/
   tests, **exercise the flow end-to-end** (curl the transition, load the UI), reproduce the claim,
   check the 4xx/403 guards and frozen-contract compliance, check every accept-criterion and that no
   stub/TODO was left behind.
3. **Verdict:** `approved` **only when the CTO has reproduced it** → integrate to `main`, confirm
   green, push. Or `changes_requested` with specifics → the engineer addresses every point and
   re-reports. Loop until it passes; do not merge partial/unverified work.
4. **A stage is only "done" when demoable through the UI on the pilot corridor** — never "endpoint
   200".

**Slice stage gates** (each is a push point): `S1 Lifecycle closure` → `S2 Tracking rendered` →
`S3 POD closes trip` → `S4 Cash-recorded payment` → `S5 Ops board + override`. No stage is called
complete until its predecessor is founder-accepted or explicitly parallel-safe.

### 4.3 Founder sign-off

The CTO's `approved` is necessary but not final:

1. Post a **Stage Completion Report** to the founder: what stage, what's demoable, the exact
   click-path, what's faked-by-Ops, known gaps.
2. The **founder manually verifies the live platform.** Nothing is truly "done" until they've seen it
   work.
3. If the founder finds it lacking, that reopens the stage — trace to the responsible node, issue
   `changes_requested`, rework. The CTO is accountable for anything that reached the founder in a
   state that didn't actually work.

**Honesty is the one non-negotiable, at every layer.** A failure reported as a failure with output is
fine and expected. A "done" that can't be reproduced, a stub shipped to `main`, or scope quietly
changed away from the slice is a fireable breach of trust.

**Engineer scorecard rubric** (tracked in Appendix B): Correctness, Honesty, Contract discipline,
Verification depth, Turnaround. Two consecutive `changes_requested` for the same avoidable reason
(dishonest report, stub in a PR, ignored frozen contract) escalates to the founder with evidence.

### 4.4 Git workflow — worktree isolation + CTO-only push

**Why this exists:** the first wave of reports once arrived tangled because all nodes shared one
working tree — a commit landed on the wrong branch and a naïve merge would have silently lost an
entire task. Root cause: no per-agent isolation. Fixed by giving each node its own working directory
backed by the same shared repo/history — branches can't collide because a branch is checked out in
exactly one worktree.

**Rules (strict):**
1. **Work only inside your own worktree directory.** Never run git commands in another node's worktree
   or the main repo dir.
2. **One node, one branch, one worktree.** For a new task, the CTO creates a fresh worktree + `feat/*`
   branch and tells you the path.
3. **Commit freely inside your worktree** — safe, your commits land on your branch only.
4. **🚫 NEVER push or merge to `main`.** The single strictest rule on the team. Not `git push`, not
   `git merge`, not "just this small fix." Finish a task → report to `cto` with branch + evidence —
   that's the end of your git involvement for that task.
5. **Only the `cto` node pushes, and only after it has checked the work** (read the diff, run the
   build, run the tests, exercised the flow end-to-end against accept-criteria per §4.2). The CTO is
   the sole integration/push authority and is personally answerable to the founder for everything that
   reaches `main`.
6. **If you think something must reach `main`, ask the CTO — never do it yourself.** Bypassing this is
   a fireable breach of trust.

Quick reference:
```
cd <your worktree path>
# ... make changes, build, test ...
git add -A && git commit -m "..."   # commits to YOUR feat/* branch — fine
# DO NOT: git push / git merge / touch main
# → send a `report` to cto with branch + verification evidence.
```

### 4.5 IPC protocol — how multiple sessions operate as one team

Multiple Claude Code sessions coordinate as one autonomous engineering team with no human in the loop:
a **CTO** node assigns and audits work, **engineer** nodes execute and report. Transport is
`claude-ipc-mcp`, a localhost message broker (`127.0.0.1:9876`).

**The one constraint:** MCP is pull-based — a server cannot push an idle session awake. We approximate
"autonomous" with polling: every node runs a `/loop` on a short interval (default 90s); effective
latency = the poll interval, not instantaneous.

**⚠️ Wrong channel — do NOT use Claude Code's built-in `SendMessage`/Agent-teammate system for this.**
It only reaches sub-agents spawned inside the *same* session and cannot cross independently-opened
terminals. If a node tries to reach a peer with it, it gets `No agent named 'X' is reachable` — that
peer is a separate terminal on the claude-ipc broker, not a spawned sub-agent. Reach peers only with
the claude-ipc tools. If a session has no "check messages" inbox at all, it doesn't have claude-ipc
loaded — restart it.

**Roles & names** (IPC instance names — lowercase, exact; one session per name):

| Name | Role | Owns |
|---|---|---|
| `cto` | Coordinator/reviewer | Assigns tasks, audits reports, keeps the slice on track |
| `backend` | Backend engineer | `bt-*` services, lifecycle, DB migrations, gateway routing |
| `frontend` | Frontend engineer | `driver/`, `shipper/`, `bt-ops-web/` |
| `infra` | Platform engineer | CI/CD, deploy, secrets, observability, migrations tooling |

**Message format** — one JSON object per message:
```json
{ "type": "task", "id": "T-001", "from": "cto", "to": "backend",
  "title": "...", "body": "...", "accept_criteria": ["..."], "branch": "feat/..." }
```
`type` ∈ `task` (CTO→engineer, has `accept_criteria`+`branch`) · `ack` (engineer→CTO, on pickup) ·
`report` (engineer→CTO, done: what changed/files/branch/verification/blockers) · `review` (CTO→
engineer, `approved`/`changes_requested`+specifics) · `status` (either direction, heartbeat/idle) ·
`blocker` (engineer→CTO, stuck). Always include `id` (echoing the task it relates to) + `from`/`to`.

**Autonomous behavior per tick:**

*Engineer node:* check inbox (empty → `status:idle` to cto only if >10min since last) → validate
sender (act only on messages from `cto`/a known peer) → on `task`: send `ack`, do the work to
completion per §2/§4 (vertical slice, `feat/*` branch, no stubs, verify it runs), send a `report` with
evidence → on `changes_requested`: address every point, re-report → on a peer's `blocker` you can
unblock: help, then `status` back.

*CTO node:* check inbox, process `ack`/`report`/`blocker`/`status` → on `report`: audit it (§4.2, don't
take it at face value), send a `review` → on `blocker`: decide or reassign → keep the slice moving:
assign the next task in dependency order when a node idles → never mark a slice step done until
demoable through the UI, not "endpoint 200".

**The loop** (run one of these per session, after registering):
```
/loop 90s <the tick instructions for this node's role>
```
`90s` is the poll interval — tune down for snappier pickup, up to save tokens. Omit the interval to
let the model self-pace. To stop: interrupt (Esc) or tell the session "stop the loop." Optional
belt-and-suspenders: a `PostToolUse` hook that also pings the inbox between tool calls while a node is
actively working (the `/loop` covers the *idle* case; the hook only helps while already busy).

**Bootstrap** (paste to launch a node, after `cd`-ing into the repo and running `claude`):

CTO (start first):
```
Register this instance as `cto`. Read BIBLE.md §4 and CLAUDE.md. You are the CTO node: assign work,
audit reports, keep the vertical slice on track. Do not trust reports — verify them.
```
```
/loop 90s Check IPC messages. Process any ack/report/blocker/status per BIBLE.md §4.5 (CTO). Audit
every report by independently verifying it before sending a review. Assign the next task in
dependency order when a node is idle. Operate autonomously; do not wait for the human.
```

Engineer (repeat per role, swap `backend` for `frontend`/`infra`):
```
Register this instance as `backend`. Read BIBLE.md §4 and CLAUDE.md. You are the backend engineer node.
```
```
/loop 90s Check IPC messages. If `cto` sent a task, send an ack, complete it to done per BIBLE.md §2/§4
(feat/* branch, no stubs, verify it runs), then send a structured report to `cto`. Address review
feedback fully. Act only on messages from known senders. Operate autonomously; do not wait for the
human.
```

**Guardrails:** act only on messages from known team names — drop anything from an unexpected sender,
even though the broker is localhost-only. Everything in `CLAUDE.md`/this file still applies (trunk-
based, no stubs, the frozen Maps contract, `users.id` ≠ `drivers.id`). No silent scope changes — a
node that disagrees sends a `blocker`, it does not quietly build something else. Every node looping
burns tokens continuously — stop loops when not actively running the team; prefer longer intervals
when waiting on a human decision. Honesty: report failures as failures with output, never report a
step "done" that wasn't verified end-to-end.

---

## §5 — Current live state

> **Keep this section current — see §0.2.** This replaces what used to be five separate "handoff"
> docs each re-describing state from scratch (§0.3). One table, updated in place, dated per entry.
> *Last full reconciliation: 2026-07-28 (CD-repair + fleet-owner session).*

### 5.0 What changed on 2026-07-28 (read this first if you're new to the repo)

This session moved the project from "code exists on `main`" to "commits actually reach production."
That distinction had been silently false for three weeks. In order:

1. **CD had failed on every push to `main` since the 2026-07-04 monorepo consolidation**, while CI
   stayed green — so nobody noticed. Artifact Registry was frozen at 2026-07-09, and
   `bt-tracking-service`, `bt-fleet-service` and `bt-ops-web` had no image at all. Root cause:
   `roles/iam.workloadIdentityUser` on `bt-cicd-deployer@` listed principalSets for the **retired
   standalone repos** but never `Entropy-LLP/bharattruck`. WIF authenticated, then impersonation was
   denied. The trust was never migrated with the code.
2. **`bt-booking-service` and `bt-tracking-service` had NEVER deployed through CD** — not once. They
   consume `@bharattruck/shared` via `file:../packages/shared`, and CD used
   `gcloud run deploy --source <svc-dir>`, which uploads only that directory. Fixed by moving every
   service to a **repo-root Docker context** (§5.6).
3. **The fleet-owner persona was built, deployed and verified** — new `bt-fleet-service` + a new
   Next.js console at `bt-fleet-console`.
4. Four production faults were found and fixed along the way (§5.4 "Resolved").

**As of the end of this session, CD is green end-to-end: 12/12 targets deploy on merge to `main`.**

### 5.1 Service health (live, Cloud Run, `asia-south1`, project `project-aa0faf06-c115-438a-a36`)

Verified by direct curl **2026-07-28**:

| Service/App | URL (`https://<name>-itcdoenefa-el.a.run.app`) | Health | Notes |
|---|---|---|---|
| `bt-gateway` | `bt-gateway-…` | ✅ 200 | now routes `/api/fleet/` → `bt-fleet-service`; entrypoint now fails **open** (§5.4) |
| `bt-auth-service` | `bt-auth-service-…` | ✅ 200 | KYC still stubbed; `kyc_documents` and `driver_licenses` are **empty** |
| `bt-booking-service` | `bt-booking-service-…` | ✅ 200 | source-of-truth for shared env (JWT/SUPABASE/REDIS/INTERNAL secrets) |
| `bt-pricing-service` | `bt-pricing-service-…` | ✅ 200 | env repaired 2026-07-28; constants still placeholders (Appendix D) |
| `bt-payment-service` | `bt-payment-service-…` | ✅ 200 | env repaired 2026-07-28; `FLEET_SERVICE_URL` added |
| `bt-cargo-ledger` | `bt-cargo-ledger-…` | ✅ 200 | `POD_OTP_PEPPER` set 2026-07-28 |
| `bt-tracking-service` | `bt-tracking-service-…` | ✅ 200 | **all 8 contract endpoints built** as of 2026-07-31, plus `/summary`, `/fleet/overview`, `/fleet/geofences` and internal `/evaluate` (D-014/D-016). Needs `INTERNAL_SERVICE_SECRET` + `TRACKING_SERVICE_URL` (on booking-service) set before the evaluator runs in prod — CD never sets env (§5.3) |
| `bt-fleet-service` | `bt-fleet-service-…` | ✅ 200 | **new** — port 3007, `/api/fleet/*` |
| `bt-shipper` | `bt-shipper-…` | ✅ 200 | live map renders |
| `bt-driver` | `bt-driver-…` | ✅ 200 | deep-link nav only, by design |
| `bt-ops-web` | `bt-ops-web-…` | ✅ 307 | redirects to `/login` — normal |
| `bt-fleet-console` | `bt-fleet-console-…` | ✅ 200 | **new** — fleet-owner console |

All twelve green. Re-run the sweep in §6.2 before trusting this table more than a couple weeks out.

### 5.2 What's built and live

**The three personas now all exist as deployed UIs:**

| Persona | App | Backend | State |
|---|---|---|---|
| Shipper | `bt-shipper` | booking/pricing/tracking | live, map verified |
| Driver | `bt-driver` | booking/tracking/cargo | live; **UI gaps, see §5.4** |
| Fleet owner | `bt-fleet-console` | `bt-fleet-service` | live, verified end-to-end 2026-07-28 |

- **Lifecycle** (`bt-booking-service`): `accepted→in_transit→completed→paid`, assigned-driver guards,
  durable throttled `location_history` breadcrumb write. **There is deliberately NO driver-facing
  `PATCH /bookings/:id/complete`** (see `src/routes/bookings.ts:110`) — completion is closed ONLY by
  receiver-OTP POD or an ops force-complete, because a driver self-completing defeats POD entirely.
  `lifecycle.e2e.mts` now pins that route's *absence* in two states.
- **Tracking**: `/track` aggregate + shipper `<LiveTrackMap/>`. **Extended 2026-07-31** with the
  remaining four contract endpoints (`/history`, `/pumps`, `/fuel`, `/alerts`), a `/summary` trip
  analytics record, and the D-014 on-ingest evaluator — geofence enter/exit with dwell timing,
  off-route/idle/near-drop/speeding alerts with an open→resolved lifecycle, and a `trip_telemetry`
  rollup (driven distance, moving/idle/night hours, stops, top speed, max deviation). Migration
  0019 adds `geofences`, `geofence_events`, `trip_telemetry` and widens `route_alerts`.
  End-to-end verified 2026-07-31 by replaying a synthetic drive along the real Nagpur→Delhi
  polyline: every alert type fired and resolved, dwell was timed, telemetry accumulated.
  **Caveat:** the evaluator is inert in prod until `TRACKING_SERVICE_URL` is set on
  `bt-booking-service` and `INTERNAL_SERVICE_SECRET` on `bt-tracking-service` (§5.3 — CD never
  sets env). Until then ingestion behaves exactly as before, which is the intended failure mode.
- **Driver map + insights** (D-019, NEW): the driver app had GPS ingestion and a deep-link but
  **no map at all**. It now renders a follow-the-truck map on the active trip, plus nearest-pump
  search, a fuel/DEF card with an editable diesel price, and route-alert banners. The driver's own
  position is drawn from `navigator.geolocation` LOCALLY — it never polls `/tracking/track`, since
  round-tripping their own fix through Cloud Run costs money for worse, slower data and stops
  working in exactly the dead zones where the map matters most.
- **Fleet live board** (D-016, NEW): `GET /api/tracking/fleet/overview` + the rebuilt
  `fleet/` **Live Fleet** page — every truck the owner has, not just the ones with a driver
  attached, each with live position, current trip, telemetry, per-model fuel cost and open
  alerts, and a stated reason whenever data is absent.
- **POD** (`bt-cargo-ledger`): receiver-OTP, hashed + peppered, constant-time, 10-min TTL,
  `MAX_VERIFY_ATTEMPTS = 5`. SMTP delivery merged (PR #8). `POD_OTP_PEPPER` now set in prod.
- **Cash payment** (`bt-payment-service`): idempotent settle → `paid` + payout record, outbox saga.
- **Fleet owner** (`bt-fleet-service`, NEW): owners, vehicles, driver affiliation (invite → accept),
  per-order assignment, bulk CSV import, `/fleet/live`, per-asset P&L. Trucks and drivers are
  **independent assets**; a fleet driver owns no truck. Bids carry only the fleet until award; payout
  follows the bidder. P&L is computed from `vehicle_cost_norms` + `vehicle_service_cost_by_age`
  (migration 0018, seeded from the founder's `CV_Parc_Tables.xlsx`) — kmpl by model, DEF as % of
  diesel, oil interval/qty, and **service cost by vehicle age, which is non-linear** (MHCV Cargo
  ₹108k yr1 → ₹209k yr3 → ₹61k yr10), so the flat per-km maintenance figure in `cto-cost.ts` is wrong
  at both ends of the curve.
- **Ops console**: real JWT/RBAC login, live-trip board, force-complete/reassign/cancel.
  `demo-ops@bharattruck.dev` has role **`admin`** (there is no `ops` role value).
- **Dashboard per person + status history + alerts** (2026-10-16, `feat/dashboard-exception-hierarchy`):
  `/dashboard` (bt-app) is now in everyone's rail. `GET /me/summary` (booking-service) returns only
  the panels the person's capabilities unlock, in their front-door order: **fleet** (the redesigned
  owner dashboard — headline tiles, Needs attention, live map, utilisation), **my truck** (an
  owner-driver's own-truck earnings, EMI cover, money owed, bids), **my driving** (current and next
  trips, licence — **no freight amounts**, money follows truck ownership, §1.1) and **my shipments**
  (spend, payment due, bids waiting, loads on the road, spend by lane). Migration **0041** records
  every booking status change with its time (`booking_status_events`, written by a trigger on
  `bookings` that can never fail the booking write; history backfilled and flagged; per-trip
  timestamps in the `booking_milestones` view). Migration **0042** adds `alerts`, raised and resolved
  by two scheduled sweeps (silent GPS; trip not started; delivered but unpaid; licence expiring), shown
  on the person's Home feed and emailed when critical (for a shipper, an overdue payment replaces the
  plain `payment_due` row rather than sitting beside it). **Caveat:** alerts stay empty until the two
  Cloud Scheduler jobs in §7.1 exist, and before 0041/0042 are applied every read degrades to empty
  instead of erroring.

**Migrations applied to live** (`rxbdzbcndpzznvqcbimg`): 0009–0013 (as before) · **0014–0018**
(fleet-owner: `fleet_owners`, `fleet_drivers`, `vehicles` + finance/permits/lanes,
`vehicle_assignments`, `trip_economics`, `vehicle_cost_norms`, `vehicle_service_cost_by_age`).

> **Live schema ≠ repo migrations.** The live DB has ~48 app tables; migrations 0001–0008 were never
> applied and several tables (`trips`, `trip_expenses`, `fuel_estimates`, `saved_lanes`,
> `trip_routes`) predate them. **PostGIS IS installed**, contradicting the frozen no-PostGIS
> decision. Always introspect live before writing a migration.

### 5.3 CI/CD — how deployment actually works now

**Two workflows, both path-filtered via `dorny/paths-filter`.**

`ci.yml` — merge gate. Runs on PRs to `main` and pushes to `main`/`feat/**`. Per changed package:
`npm ci` → `npm run build` (this IS the typecheck gate) → `npm run lint` (**non-blocking**, apps carry
eslint debt) → `npm test`. Redis 7 sidecar for every job. Node pinned to **20** to match the services'
`node:20-alpine` runtime. A separate `gateway` job renders the real `docker-entrypoint.sh` across
three env shapes and asserts nginx syntax.

`deploy.yml` — CD. Fires on push to `main`. Keyless WIF auth impersonating `bt-cicd-deployer@`.

- **Services** → `gcloud builds submit --config cloudbuild.yaml` with the **REPO ROOT** as Docker
  context, then `gcloud run deploy --image`. Root context is **required**: `bt-booking-service` and
  `bt-tracking-service` depend on `file:../packages/shared`, which cannot resolve inside a
  single-service context. Each Dockerfile recreates the repo layout inside the image
  (`/repo/packages/shared` + `/repo/<svc>`); `.npmrc` `install-links=true` then COPIES shared into
  `node_modules` so its transitive deps hoist. `.gcloudignore` keeps the upload to ~3.7 MiB.
- **Apps** → `docker build` on the runner with `NEXT_PUBLIC_*` as `--build-arg` (they are inlined at
  BUILD time — runtime env cannot work), push to AR repo `bt`, then deploy by SHA tag.
- **Env is never set by CD, by design** — an image deploy preserves existing env/SA/port/scaling. A
  new env var is a one-time manual `gcloud run services update`. **Corollary: a service that does not
  exist yet gets CREATED by CD with an EMPTY environment and crash-loops.** Seed it first.
- `--allow-unauthenticated` on both lanes — a brand-new Cloud Run service defaults to requiring IAM
  auth and will serve **403 to everyone** (exactly how `bt-fleet-console` first shipped).
- **Every deploy is now proof-of-life-checked.** Each lane probes what it just shipped (services:
  `/health` must return 200; apps: the root path must return <400, since Next apps have no `/health`),
  using the URL `gcloud run services describe` reports, with a bounded ~60s retry. It **fails the
  job** — a green deploy step alone only meant the revision was created, so both failure shapes above
  (empty-env crash loop, 403-to-everyone) used to ship silently.
- **CI fails if the `packages/shared/**` path filters drift** from the real `file:` dependents
  (`shared-consumer list matches reality` in `ci.yml`, derived from the package.json files). That
  hand-maintained list going stale is how a shared fix merges green and never reaches the service.
- **Concurrency:** `max-parallel: 3` within a run **and** a workflow-level `concurrency: deploy-main`
  group. Both are needed — Cloud Build allows only **60 operation-GET requests/min per project**, and
  `gcloud builds submit` polls while waiting. Two runs overlapping (two PRs merged a minute apart)
  produced 6 concurrent builds and killed one service in each run.
- ⚠️ **MERGING PRs BACK-TO-BACK SILENTLY LOSES DEPLOYS.** `cancel-in-progress: false` does *not* mean
  every run eventually executes: GitHub holds **at most ONE pending run per concurrency group**, and
  each newly-queued run **cancels the one already waiting**. Merging 4 PRs inside a minute (2026-08-02,
  PRs #36–#39) ran the 1st, ran the 4th, and **cancelled #37 and #38 after ~8s each** — so
  `bt-auth-service` and `bt-pricing-service` were merged to `main` but never deployed, with CI all
  green and nothing flagging it. Because CD is path-filtered per commit, a later unrelated merge does
  **not** pick them up; those services stay stale until someone notices.
  **So: after any batch merge, always check `gh run list --workflow=deploy.yml` for `cancelled`** and
  re-run each one (`gh run rerun <id>`, one at a time, waiting for each to finish). Re-running works —
  it replays that commit's own path filter. Better still, merge one PR, wait for its deploy, then
  merge the next. Verify what is actually live with the revision's commit label:
  `gcloud run services describe <svc> --region=asia-south1 --project=<proj>
  --format='value(status.latestReadyRevisionName, spec.template.metadata.labels.commit-sha)'`
  — the sha must match the merge commit.

**Repair scripts** (idempotent, in `scripts/deploy/`): `wire-cicd.sh` (WIF trust + deployer roles +
seed `bt-fleet-service` env + gateway wiring) · `fix-empty-env.sh` (repairs empty env values).

### 5.4 Known issues

**OPEN 2026-10-13 — data-capture gaps found by a full code read (main @ 23362a9; re-checked against
main @ 0894c2f on 2026-10-16).**
Each was re-checked by hand; the complete map (72 data points, 64 gaps) lives outside the repo as the
"data gap map" PDF. The ones that break a flow or mislead a user:
- **An e-way bill made outside the app cannot be recorded, so its trip cannot start.** The manual
  form's `recordEwayBill` never sends `document_uri`, the server rejects a record without it (400,
  `documents/service.ts:674-680`), and `assertPickupDocumentsReady` requires the uploaded copy for every
  intra-state trip, any trip whose states can't be identified, and inter-state loads over ₹50,000
  (`documents/service.ts:809-838`). *Narrowed by #209:* a bill generated in the app on NIC's portal
  stores the portal's PDF link as that copy (`lib/ewb/service.ts`), so the in-app route works once the
  shipper has linked their portal login.
- **POD photo bytes are not kept**: `POD_EVIDENCE_BUCKET` is set in no deploy or infra file, so
  storage is a no-op and only the hashes survive (`booking lib/pod/storage.ts:51-90`).
- **Quotes probably price on straight-line distance**: pricing reaches Google Routes only through
  `TRACKING_INTERNAL_URL`, which `deploy-all.sh` never sets (default is a docker-compose hostname), so it
  falls back to haversine × 1.3 (`pricing lib/tracking-client.ts:62`).
- **Online payments leave the carrier's payout `pending` forever** — no route or screen marks it paid
  out — while the Payment tab tells the shipper it is "Being paid out by BharatTruck"
  (`payment lib/online-payment.ts:70-77`, `components/payment-section.tsx:303`).
- **FIXED since (387ca8c, bec207d): KYC results now reach what the app reads.** A passed verification
  flips `users.kyc_status`, `driver_licenses.status`, `vehicles.rc_status` and
  `bank_accounts.verification_status` (`auth routes/kyc.ts`, `applyVerifiedEffects`), and the booking
  service reads `user_kyc` for the PAN gate (`lib/kyc-gate.ts`).
- **Saved addresses 404**: the route is in booking-service under `/me`, but the gateway sends
  `/api/me/*` (except `/api/me/feed` and `/api/me/summary`) to auth-service.
- **A missing GPS speed counts as parked** (`tracking lib/evaluator.ts:197`); with
  `enableHighAccuracy:false` the browser often sends none, so a moving truck can raise "idle".
- **Doc drift:** `bt-ops-web` was retired in `3f295f4`, but CLAUDE.md still lists it as the ops console.
  Every ops action is API-only behind an `admin` role that only a database edit can grant.

**OPEN 2026-08-02 — the gateway's own 429 is an HTML page, and the apps cannot parse it.**
`bt-gateway/nginx.conf` rate-limits `/api/auth/` with `limit_req zone=otp_zone burst=10 nodelay`
(`otp_zone` = 5r/m, keyed on `$binary_remote_addr`). When it trips, nginx returns its stock
`<html>…429 Too Many Requests…</html>` body. Both apps' `api.ts` call `res.json()` on every response,
so the HTML throws and the user is shown **"Server error — please try again"** instead of anything
about rate limiting. A user who fat-fingers their password a few times in quick succession hits this.
Fix is a gateway `error_page 429` returning the `{success:false, code:…}` envelope the apps expect —
not an app-side change, since every service behind the gateway has the same exposure.
Confirmed live 2026-08-02 by probing `/api/auth/email/login` with a nonexistent address: attempts
1–10 → 401, 11th → nginx's HTML 429.

> Note the layering, which is correct and worth keeping: **nginx limits by IP, the auth service limits
> by identity.** `$binary_remote_addr` at the nginx hop IS the real client (verified: a single-IP probe
> trips it, so it is not collapsing every user onto one bucket), whereas Fastify's `req.ip` is the
> gateway container because there is no `trustProxy` — which is why the service-level throttles
> (`LOGIN_FAIL_LIMIT` etc.) are keyed on the email instead. The two are complementary, not redundant.

**Resolved 2026-07-31 — a fleet-owner bid white-screened the shipper's booking page.**
The shipper labelled each bid with `quote.driver_id.slice(0, 8)`. Migration 016 made
`quotes.driver_id` nullable and added `fleet_owner_id` under
`num_nonnulls(driver_id, fleet_owner_id) = 1`, so a fleet bid leaves `driver_id` NULL — every fleet
bid took the whole page down with `Cannot read properties of null (reading 'slice')`. The shipper's
`Quote` type still declared `driver_id: string`, so TypeScript never flagged it: **the frontend types
are hand-maintained copies of the backend's and drift silently — when a migration changes a column's
nullability, grep the apps for that column, do not trust the app's own type.** Fixed by resolving the
bidding party server-side (`listQuotesForBooking` now returns a `carrier` object: kind + name +
truck/rating), because a uuid prefix was never renderable anyway — `drivers.id`/`fleet_owners.id` are
identities the apps never hold. Two more spots carried the same solo-driver assumption and were fixed
with it: negotiation history labelled a fleet's counter-offer "Driver", and the trip panel announced
"Driver Assigned" the moment a fleet won — but a fleet wins as a *company* and `bookings.driver_id`
stays NULL until the owner pairs a truck in `bt-fleet-service`, so it now reads "Carrier Booked" /
"Awaiting Truck". Pinned by `bt-booking-service/test/quote-carrier.unit.mts`.

**Resolved 2026-07-31 — POD was unreachable for almost every live trip.**
`bookings.receiver_email` is required at creation but the column is nullable, and almost nothing in
the live DB has one: **10 of 11 `in_transit`, 15 of 15 `accepted`, and 621 of 622 `paid` bookings had
no receiver email** (2 rows out of 676 total did). Without an address the driver's POD request has
nowhere to send the delivery code, so those trips could not reach `completed` through POD at all —
only via an ops force-complete, which bypasses the receiver-OTP proof that `§2` puts on the *never
cut* list. Worse, the column was settable **exactly once, at booking creation**: the driver app told
the shipper to "add one before delivery can be confirmed" and no route in the platform could do it.
Fixed by `PATCH /bookings/:id/receiver-email` (shipper-owner or ops; refused on
completed/paid/cancelled), a shipper-app editor, and a `receiver_email_missing` notification so the
shipper learns their driver is blocked instead of both sides waiting. The historical rows are not
backfilled — a receiver address cannot be invented — so an old stuck trip still needs the shipper (or
ops) to supply one.

**Resolved 2026-07-28 — do NOT re-report these:**
- CD failing on every push (WIF trust never migrated) — **fixed**, 12/12 green.
- `bt-booking-service`/`bt-tracking-service` unable to build (`file:` shared dep) — **fixed** via
  root-context builds.
- **Gateway failed CLOSED**: `envsubst` turned an unset `*_SERVICE_URL` into `set $x ;` — invalid
  nginx — so one missing var took **every app** down. Entrypoint now defaults each URL to an
  unroutable address (degrades to a 502 on that one route). CI pins it across three env shapes.
- **`bt-payment-service` + `bt-pricing-service` had FOUR env vars set to the EMPTY STRING**
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`). Names
  present, values blank — so any "is it set?" check that tests the NAME passes. Both also referenced a
  **mutable image tag** while running an older pinned digest, so any config change silently rolled the
  image forward onto a build with a hard `INTERNAL_SERVICE_SECRET must be set` guard.
- **`@supabase/supabase-js` 2.110.x is FATAL on Node 20** — it constructs a RealtimeClient inside
  `createClient()`, which needs native WebSocket (Node 22+). Verified: 2.110.2 and 2.110.8 throw,
  2.100.1 does not. Caused by lockfile drift from a `^2.43.4` caret. **All six services + shared are
  now pinned to 2.100.1 exactly.**
- Nine test files never ran in CI (no `test` script) — **fixed**, all now run.
- `POD_OTP_PEPPER` unset in prod — **set 2026-07-28**.

**Resolved 2026-07-31 — fleet drivers were shown the marketplace on their own trips:**
- A fleet-employed driver opening a trip **already assigned to them and `in_transit`** got a
  **"Submit Your Quote" form**. Reported against Dinesh Chauhan (Shree Balaji Roadlines) on booking
  `f5000000-…-a003`. **620 of 620** bookings assigned to active fleet drivers were affected — every
  fleet driver, every trip.
- **Root cause: the driver booking screen decided what to render from QUOTE OWNERSHIP, not from trip
  assignment.** The whole trip lifecycle (Start Trip / GPS / POD / Navigate) lived inside
  `QuoteStatusSection`, reachable only when `getQuotes()` returned the driver's own quote. A fleet
  driver **never** owns a quote — their owner is the bidder (Q14) — so the screen read that absence as
  "free to bid". The same trap hit a **solo** driver who took a load with `PATCH /accept`: no quote
  row either. Q16 price-masking was working correctly and hid the money, which is why the screenshot
  showed a bid form with no price.
- Three gaps fed it, all now closed:
  1. `getBooking` masked the money for a fleet driver but **did not scope which bookings they could
     read** — `listBookings` returned assignments only while a fetch by id returned ANY booking, so an
     employed driver could read the whole marketplace one UUID at a time. Now 404s anything not
     assigned to them (404, not 403, so ids cannot be probed).
  2. Nothing told the client a driver was fleet-affiliated. `/fleet/drivers/invites/mine` returns
     `status='pending'` rows ONLY, so an ACCEPTED affiliation was invisible to the app. Added
     **`GET /fleet/drivers/me/affiliation`** (bt-fleet-service owns `fleet_drivers`; already routed by
     the gateway's `/api/fleet/` block, no nginx change). Keyed on `status='active'` to match
     `isFleetAffiliatedDriver()` — **the two must stay in agreement**.
  3. `GET /bookings/:id` now stamps **`assigned_to_me`** for driver callers (server-computed: the app
     holds `users.id` from its JWT and cannot compare it to `bookings.driver_id`, which is a
     `drivers.id`). Absent for shipper/admin.
- Driver app now branches on affiliation: `/available` is "My Trips" with a status column, the
  `My Quotes` tab is hidden, and auction/countdown/price furniture is suppressed. The screen picks the
  trip lifecycle from `assigned_to_me`, falling back to the old quote inference when the field is
  absent so a **rolling deploy** (app ahead of API) does not strand a solo driver on "waiting for
  shipper". The shell holds its loading state until affiliation resolves — the provider reads the
  token straight from `localStorage` so that lookup RACES `getMe()` instead of queueing behind it —
  otherwise the SOLO default flashes marketplace chrome at a fleet driver on every page load.
  Covered by `bt-booking-service/test/fleet-driver-scope.e2e.mts` (23 checks).

**Still open:**
1. **The driver app's UI is the weakest surface in the product.** Measured 2026-07-28: server-side is
   fine (55 ms warm TTFB) but the initial payload is **710 KB**. Shipper is 708 KB and the fleet
   console 719 KB — so the driver is *not* uniquely bloated; it is the same Next 16 / React 19
   baseline. What differs is the **user**: the driver app is the only one running on a cheap Android
   on Indian mobile data. Same payload, very different felt cost. Also, **all three apps have
   `min-instances` unset** (backend services use `minScale: 1`), so they cold-start.
2. **PRs #2 (`driver/frontend-revamp`) and #3 (`shipper/frontend-revamp`) are stalled and unsafe to
   merge as-is** — opened 2026-07-15, **30 commits behind `main`**, CI red at the first job (never
   built), description "new frontend design". **#2 deletes `driver/src/lib/nav.ts` with no
   replacement** — that file powers `handleNavigate()`, the Google-Maps deep-link handoff, which is a
   FROZEN Maps contract item. A driver on that build cannot start navigation. Decide: rebase +
   restore nav, or close and re-apply the visual changes onto current `main`.
3. **RESOLVED 2026-07-31 — fleet bidding is wired.** The fleet console can now see open loads,
   place/replace/withdraw bids, reply to counter-offers and read a per-bid price history
   (`GET /api/fleet/auctions`, `GET /api/fleet/bids`; writes reuse the existing
   `/bookings/:id/quotes*` routes). Two bugs fixed with it: `GET /bookings` was returning EVERY
   booking on the platform to any `fleet_owner` account (the role matched no branch in
   `listBookings` and fell through to the unfiltered admin path), and `negotiations.actor_role`
   rejected `fleet_owner`, so fleet bid history had never recorded a single row (migration 0020).
4. **RESOLVED 2026-07-31 — direct bookings are visible to the assigned SOLO driver.** Open since
   2026-07-20, the last piece of the quote-based-driver-flow bug. The fleet fix earlier the same day
   closed the **detail screen** (`assigned_to_me`) and the **fleet** driver's list, leaving the LIST
   for a solo driver: `repository.listBookings` filtered a non-fleet driver to `status='pending'`, so
   a booking left the only list they could see the instant it became theirs — targeted directly at
   them, or won and moved on to `accepted`/`in_transit`. The detail screen rendered such a trip
   correctly **if they could reach its URL**; nothing linked to it.
   The driver branch is now three cases, not two:
   - **fleet-employed** → assignments only, masked (unchanged, Q14/Q16);
   - **solo** → `status='pending'` **OR** `driver_id = <their drivers.id>`, unmasked;
   - **no `drivers` row** → the original pending-only query, unchanged.
   The union matters: a solo driver is both a bidder and the haulier, so returning only their
   assignments would have traded one broken screen for another and removed their ability to find
   work. It needs the caller's `drivers.id` resolved for solo drivers too — `fleetAffiliatedDriverId()`
   became `resolveDriverScope()`, returning `{ driverId, fleetAffiliated }` from the same two lookups
   (no extra queries). Covered by `bt-booking-service/test/driver-list-scope.e2e.mts` (18 checks),
   which asserts the union rather than just the new arm.
5. **Driver's onboarding wizard is built but unreachable** — no in-app link. Blocks a real driver
   entering insurance/bank details, which the payout path needs.
6. **`bt-ops-web` auth and data are still stubbed.**
7. **The rate card is roughly a third of market.** `RATE_PER_KM.hcv` is ₹22/km against a computed
   operating cost of ₹36.71/km and a real fr8.in market rate of ₹58–60/km (32ft MXL; published band
   ₹45–85/km; Mumbai–Delhi ₹83,500 / 1414 km). The cost engine is right; the rate card is wrong.
   Every fleet owner onboarded will see negative margins on paper until this is addressed.
8. **The deployer SA still trusts 14 RETIRED repos**, none archived on GitHub — any of them can still
   mint a token and deploy to production. Remove those principalSets and/or archive the repos.
9. **RLS enabled but unpoliced on most tables** — not a live hole (services use `service_role`, which
   bypasses RLS) but undecided.
10. Gateway 301-redirects `/api/bookings` (no trailing slash) to `http://` — scheme downgrade.
11. **Maps failure handling — fixed in `fleet/` and `driver/`, still open in `shipper/`.**
    The fleet console now has `fleet/src/components/map-guard.tsx`: a render
    watchdog plus an error boundary, so a rejected key costs the map and nothing else.
    `driver/` now carries a copy too (D-019). `shipper/src/components/maps/LiveTrackMap.tsx` is
    the LAST one still handling only a *missing* key — **copy the guard across** (D-013: copy per
    app, no shared package). Three things learned
    building it, all verified 2026-07-31, all worth not rediscovering:
    - A Maps rejection **crashed the whole React tree** ("This page couldn't load"), taking the
      truck list with it. The list needs no Google at all; it must never depend on the map.
    - `gm_authFailure` and console-sniffing are both **unreliable**. Under Next dev the console
      probe never fires — Next captures a pristine `console.error` before app code loads and
      calls that reference, bypassing any wrapper. Patching inside a `useEffect` is worse still:
      StrictMode's double-mount makes cleanup #1 uninstall probe #2.
    - The only dependable signal is **whether tiles actually painted** (`tilesloaded` within 8 s).
      Every cause — bad key, quota, blocked domain, renamed error — collapses to that one state.
12. Shipper has no PWA manifest/service worker (driver has both).
13. Dead tables + stray PostGIS extension in the live schema.
14. Leftover `:rootctx-test` image tags in Artifact Registry from CD verification builds.

### 5.5 Open founder decisions

- **Escrow/RL scope reversal needs re-confirmation** — see §2's banner.
- **The kartik decision** (payment + pricing, Appendix D) — pending.
- **The rate card** (§5.4 item 6) — needs a number from the founder.
- **Notification channel** — **decided 2026-07-31: email** (§5.9, open-decision #6). SMS/WhatsApp/FCM remain post-MVP additions on the same outbox.
- **Registered entity** for Surepass (real KYC) + Razorpay — blocks both.
- **PMO tool's GitHub autotrack is stale** — points at the 11 retired standalone repos.

### 5.6 Honest progress assessment — READ BEFORE PLANNING

> **UPDATE 2026-07-28 (later same day): the first real trip HAS now run end-to-end.** A booking was
> driven through the live gateway entirely by REST — shipper posts → driver bids → shipper awards →
> driver starts → GPS → POD-OTP **emailed and verified** → **settled**. Booking
> `01ae9190-f2be-49a0-b6c7-5deaa77f5253` now has a `pod_receipts` row, a `payments` row
> (status `settled`, ₹36,483, cash) and status `paid`. **`payments` and `pod_receipts` are no longer
> zero.** Getting there required fixing a blocking bug the churn had planted (see below) and adding
> forgot-password. The reusable harness is `scripts/qa/trip-e2e.mjs`. The original day-1 assessment
> below is kept for context; the headline "the product has never been used once" is now **false** —
> it has been used once, on purpose, and the path works. What remains is hardening + volume, not
> first-proof.
>
> **The blocking bug (why `payments` was zero):** `settle()` inserted `payments.status='recorded'`,
> but the live table's `payments_status_check` only allows `pending|captured|settled|failed|refunded`
> — so EVERY cash settlement 500'd on the insert. Not "never run", but "would always fail". The
> `payouts` table used a laxer status vocabulary that accepted `'recorded'`, so the payout wrote and
> the payment did not — a per-table drift straight out of the schema churn this section warns about.
> Fixed (status `'settled'`) + a test assertion pinning the payment status to the DB-allowed set,
> because the Map-backed test fake never enforced the CHECK (the same blind spot that hid the earlier
> payout-wire-shape bug). This is the exact class of fault the day-1 note predicted the manual run
> would surface.

**The North Star is one shipper → one driver → one tracked, proven, PAID interstate trip.**
Day-1 (morning) evidence from the live DB, kept for the record:

| Table | Rows | What it means |
|---|---|---|
| `bookings` | 673 | 621 `paid` — but backdated Jan–Jul 2026 by the fleet demo seed |
| `vehicle_assignments` | 620 | seeded |
| `payouts` | 617 | seeded — written directly, **not** via the payment service |
| **`payments`** | **0** | **`settle()` has NEVER run in production** |
| **`pod_receipts`** | **0** | **POD-OTP has NEVER completed a delivery in production** |
| **`trip_events`** | **0** | lifecycle event log empty |
| **`kyc_documents`** / `driver_licenses` | **0** / **0** | KYC never exercised |
| `location_history` | 126 | some real GPS breadcrumbs, from testing |

**So: not one trip has ever traversed the real production path.** Every "paid" booking is seeded data
written straight to the DB, bypassing POD and payment entirely.

**How to read that.** "Infra wired, three personas set, just the finals remaining" is right about the
first two and optimistic about the third. What is genuinely done is real and was hard: CD works,
twelve targets deploy on merge, three personas exist as deployed UIs, the schema is live, and the
fleet P&L is modelled off real cost data. That is a substantial base.

But the remaining work is **not** finishing touches. The gap between "every service is code-complete
and deploys" and "a trip completes end-to-end" is exactly where MVPs die, because it is where all the
integration faults surface — and this session is the evidence: the code had been correct for weeks
while *four separate production faults* (dead CD, blank env vars, a Node-fatal dependency, a
fail-closed gateway) sat undetected, because nothing had ever actually run the path.

Day-1 characterisation was: *the platform is built; the product has never been used once.* As of the
update box at the top of this section, **it has now been used once, end-to-end, and the path works.**
The next priorities shift from "prove it runs" to "make it safe + real":

1. **DB health (audited 2026-07-28 via the Supabase MCP — reassuring):** referential integrity is
   intact (**zero orphaned FKs** across the whole DB); anon reads **zero rows** from every sensitive
   table (RLS-enabled-no-policy is deny-by-default, and no app ships the anon key), so the "unpoliced
   RLS" worry is safe-by-accident, not a hole. Real cleanup items, all the user's DDL call:
   `trips` (21 rows) + `trip_locations` (76) are **dead legacy** (data but zero code refs); ~14 empty
   unreferenced tables; the stray PostGIS extension; and **3 hot FK columns lack an index**
   (`negotiations.booking_id`, `negotiations.quote_id`, `quotes.driver_id`) — worth adding before
   pilot volume. Blank-column scan found only benign nullable-optional columns (KYC/photos
   unexercised); `vehicles.driver_id` all-NULL is BY DESIGN (fleet model). The one real schema trap
   was `payments_status_check` (fixed above).
2. **Auth hardening (from a full surface audit).** forgot-password/reset now shipped + verified live.
   Still open and real: **no brute-force lockout / rate-limit on `/email/login`** (credential-stuffing
   open); **phone-OTP has no real SMS** (console.log only — and phone is the primary login for Indian
   drivers); no global rate-limit on register/magic-link (SMTP-quota drain); refresh tokens never
   rotate; `/auth/register` lets a user self-assign their own role; password policy has no max length
   (bcrypt silently truncates >72 bytes).
3. **A money-integrity gap the run exposed:** `settle()` takes `amount` fully from the caller and
   never reconciles it against the booking's agreed `quoted_price` — a shipper could settle ₹1 on a
   ₹36,483 trip. Not a crash; a real correctness hole to close before real money moves.
4. **The driver app (§5.4 items 1–4)** — worst UI, heaviest relative payload, stalled PR that deletes
   the Maps nav handoff, and two flow-level holes (direct bookings invisible to the driver; unreachable
   onboarding that gates payout).

---

## §6 — Browser QA harness

_Originally created 2026-07-18 from two separate harness documents, folded in here on 2026-07-20
and since removed. Standing process — still self-iterating per §0.2. **For current known bugs, see §5.4** —
they used to live here; keeping one list instead of two avoids exactly the drift this whole
consolidation exists to fix. This section stays focused on *methodology and tool gotchas*, which don't
go stale the same way a bug list does._

### 6.1 Aim & scope

The recurring job this harness supports: **open the shipper and/or driver app in the browser harness and
verify the UI actually works** — renders, connects to the backend, and the *core* features function —
not just that `next build` succeeds or an endpoint returns 200. Definition of done for a pass: every
core screen loads without a blank/broken render, console errors are triaged (infra vs. real bug), and
anything GPS/Maps-related is checked with extra care (§3 territory — the feature most likely to
silently degrade: wrong key, missing Map ID, stale cache).

**Standing scope rule, unless told otherwise:** the booking creation/negotiation/auction flow (shipper
"New Booking", driver "Browse"/submit-quote) is considered already verified and is **out of scope**
for a routine pass. Test *around* it: existing-booking views, tracking, POD, payments, profile, ops
overrides, anything GPS/Maps. If a session's actual assignment is different, that instruction wins —
this is a default, not a hard rule.

### 6.2 Where the app lives

**Test against the live Cloud Run deployment, not local dev**, unless you're iterating on a fix (see
6.5). Open apps directly: `mcp__Claude_Browser__preview_start({ url: "<app-url>" })` — no dev server
needed; `navigate` on the same tab to move between apps. **Do not attempt to redeploy or change Cloud
Run env vars yourself** — prod mutations are reserved for the founder/CTO (§4); diagnose and report,
draft the fix command if useful, don't run it.

| Service | URL |
|---|---|
| `bt-shipper` | `https://bt-shipper-752385541585.asia-south1.run.app` |
| `bt-driver` | `https://bt-driver-752385541585.asia-south1.run.app` |
| `bt-ops-web` | `https://bt-ops-web-752385541585.asia-south1.run.app` (redirects to `/login`) |
| `bt-gateway` | `https://bt-gateway-752385541585.asia-south1.run.app` (also `bt-gateway-itcdoenefa-el.a.run.app`) |
| `bt-auth-service` | `https://bt-auth-service-752385541585.asia-south1.run.app` |
| `bt-booking-service` | `https://bt-booking-service-752385541585.asia-south1.run.app` |
| `bt-pricing-service` | `https://bt-pricing-service-752385541585.asia-south1.run.app` |
| `bt-payment-service` | `https://bt-payment-service-752385541585.asia-south1.run.app` |
| `bt-cargo-ledger` | `https://bt-cargo-ledger-752385541585.asia-south1.run.app` |
| `bt-tracking-service` | `https://bt-tracking-service-752385541585.asia-south1.run.app` |

Quick health sweep (read-only, safe for any session with `gcloud`/curl):
```bash
for s in bt-auth-service bt-booking-service bt-pricing-service bt-payment-service \
         bt-cargo-ledger bt-tracking-service bt-gateway; do
  u="https://${s}-752385541585.asia-south1.run.app"
  printf '%-22s %s\n' "$s" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u/health")"
done
for s in bt-shipper bt-driver bt-ops-web; do
  u="https://${s}-752385541585.asia-south1.run.app"
  printf '%-22s %s\n' "$s" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u/")"
done
```
To refresh the URL table (services get added/removed): `gcloud run services list --region=asia-south1
--project=project-aa0faf06-c115-438a-a36` (read-only).

### 6.3 Browser tool gotchas (learned the hard way)

- **`tabId` is not optional in practice.** Call `tabs_context` right after `preview_start` to get the
  real `tabId` and pass it on every subsequent call — the first `computer`/`read_console_messages` call
  right after `preview_start` has errored (`expected string, received undefined`) without it.
- **Prefer `read_page` → `ref_N` clicks over raw coordinate clicks.** A coordinate click on a tab button
  has silently no-op'd (likely a toast/overlay shifting layout). When a click seems to do nothing,
  re-run `read_page` and click by `ref` instead of nudging coordinates.
- **…but `read_page` can return `(empty page)` / `Viewport: 0x0` on a page that renders fine**
  (seen 2026-07-31 on the driver app, Next 16 + Turbopack dev). `computer{action:"screenshot"}` showed
  the full UI at the same moment. When that happens, fall back to screenshots + coordinate clicks;
  coordinates are in the **screenshot's** space (the reported "Screenshot size", e.g. 800×450), NOT
  the CSS-pixel space of the image you see.
- **A LOCAL dev server CANNOT call the live Cloud Run gateway from this browser** — the fetch dies as
  a bare `TypeError: Failed to fetch` (CORS; the gateway does not allow `http://localhost:*` origins),
  and the login form just says "Login failed" with **no entry in `read_network_requests`**. The same
  request succeeds from `curl`, so "curl works, browser doesn't" is this, not bad credentials. So the
  `*-dev` launch configs pointed at the live gateway are **not usable for UI testing in this tool**.
  Workarounds: test the **deployed** app (§6.2), or point `NEXT_PUBLIC_API_URL` at a local mock that
  sends `Access-Control-Allow-Origin: *`. The mock route shapes worth knowing: the client calls the
  booking LIST as **`/api/bookings/` with a trailing slash** (`api.ts listBookings`) but the detail as
  `/api/bookings/:id` without one, and it reads auth from `localStorage` keys **`bt_driver_token`** /
  `bt_driver_refresh_token` (settable via `javascript_tool` to skip the login form entirely). A mock
  with switchable personas is the only practical way to see both the fleet-driver and solo-driver
  builds of the driver app side by side.
- **To preview a WORKTREE, the worktree must live under the repo root.** `preview_start` resolves
  `.claude/launch.json` from the **primary working directory only** — a config added to the
  worktree's own copy is invisible ("No server named …"), and an absolute `cwd` is rejected outright
  ("cwd must be a relative path within the project root"). So a `../bt-wt-*` sibling worktree cannot
  be previewed at all. Create it at **`.claude/worktrees/<name>`** instead and point the launch entry
  at `.claude/worktrees/<name>/<app>` — that path is relative and inside the root, so it works.
  Remember `npm ci` in the new worktree; it starts with no `node_modules`. (Learned 2026-07-31
  shipper-QA'ing a branch while another session held the main checkout.)
- **The shipper's localStorage auth keys are `bt_token` / `bt_refresh_token`** — *not* the
  `bt_driver_*` keys listed above, which are the driver app's. Setting the shipper's pair via
  `javascript_tool` skips its login form the same way. A mock never validates the token, so any
  non-empty string works.
- **Both apps' login screens default to the "Phone" tab.** Phone OTP has no SMS provider wired
  (console-logs only) — dead end for testing. Click **"Email"** and use the demo creds (§6.4). Both
  login pages also have a "Dev: Paste JWT directly" collapsible — faster than the form if you already
  have a raw JWT from a prior check.
- **To see which runtime config is baked into a live bundle** (e.g. which Maps key shipped), don't rely
  on `read_network_requests` alone — the Maps JS loader's request may not show up there. Run
  `javascript_tool` and read `document.querySelectorAll('script')` `src` attributes; the key is a
  visible query param on the `maps.googleapis.com/maps/api/js?...&key=...` tag. Fine to do for the
  browser key specifically (referrer-restricted, meant to be public) — never do this hunting for a
  secret key, there isn't one client-side to find.
- **A broken Google Maps key surfaces as Google's own modal** ("This page can't load Google Maps
  correctly / Do you own this website?"). That text alone doesn't say *why* — cross-check
  `read_console_messages` for the real reason (`InvalidKeyMapError`, `RefererNotAllowedMapError`,
  "initialised without a valid Map ID").
- **Check mobile viewport, not just desktop.** `resize_window` presets: `mobile` 375×812, `tablet`
  768×1024, `desktop` 1280×800. Both apps are PWAs aimed primarily at phones — driver especially — so a
  desktop-only pass misses real bugs.
- **Geolocation can't be exercised through these tools.** The driver app's GPS push calls
  `navigator.geolocation.watchPosition`; there's no way to grant/mock browser geolocation permission
  via the browser harness. Treat this as a hard coverage limitation, not a bug, when you can't verify a GPS
  feature end-to-end — say so explicitly rather than guessing.
- **Demo data is asymmetric — verify before assuming a shipper-side booking has a matching driver-side
  view.** As of the last check, `demo-driver` has no quotes/assigned trips at all — don't assume the
  documented demo creds land you on an active-trip/GPS screen (§5.4 item 2).

### 6.4 Demo credentials

> **⚠️ THIS SECTION NO LONGER LISTS PASSWORDS, AND MUST NOT AGAIN.**
>
> It used to, and on **2026-08-16** every account in it turned out not to exist. The table named
> `demo-shipper@bharattruck.dev`, `demo-driver@…`, `demo-ops@…`, `balaji@bharattruck.in` and eight
> `@bharattruck.in` fleet drivers, with a `<firstname>-2026` password pattern. A live query returned
> **zero** rows for any of them, and the oldest user in the project dates to 2026-05-14 — so they had
> not been deleted, they were never in this project. Somebody burned a session on "the login is
> broken" before checking the database.
>
> The cause was duplication: credentials lived in a seed script AND were transcribed here, and only
> one copy got updated. Pointing at the script instead is the fix, because the script cannot drift
> from itself.

> **⚠️ 2026-10-07 — IT HAS HAPPENED AGAIN. The seed script's five accounts do not exist.**
>
> `seed-demo-personas.mjs` names `rajesh@`, `vijay@`, `mahesh@`, `anita@` and `deepak@bharattruck.in`.
> A login as `rajesh@bharattruck.in` returned a real **401** from the live gateway, and
> `SELECT ... FROM users WHERE email LIKE '%@bharattruck.in'` returned **zero rows** — not one of the
> five is in the database. So the fix recorded below (point at the script, because a script cannot
> drift from itself) did **not** hold: the script is the source of truth for what *would* be seeded,
> but nobody has run it against this deployment, and reading it still tells you nothing about who can
> actually log in.
>
> **Therefore: the query below is not optional.** Run it BEFORE typing a password, every time. One
> wrong guess is cheap; ten lock the account for the rest of the window.
>
> Still open: nobody has re-run the seed. Until someone does, a session that needs a logged-in
> surface must get working credentials from the founder — there is no account in this repo that works.

**The live demo accounts are defined in [`scripts/seed/seed-demo-personas.mjs`](../scripts/seed/seed-demo-personas.mjs)**
— read the `ACTORS` map at the top of that file for the current emails and passwords. It seeds five
personas (a shipper, two drivers, two fleet owners) and the loads they trade, and it is the only
source of truth for who can log in.

The three names visible as shippers on the live auction board — Rajesh Kumar, Deepak Sharma, Anita
Desai — are these accounts, which is a quick way to confirm the script matches the deployment.

**Before quoting any credential from anywhere, confirm the account exists:**

```sql
SELECT email, (password_hash IS NOT NULL) AS can_password_login, role
FROM users WHERE email = '<the-address>';
```

Login screens default to **Phone** — switch to **Email** (phone OTP is a dead end, see 6.3).

⚠️ **A "Login failed" toast does NOT by itself mean the password is wrong.** Three different causes
produce it, and they need different fixes:
- the account does not exist (the 2026-08-16 case above) — check with the query;
- the CORS wall when running from a *local* dev server (§6.3) — zero network entries is the tell;
- a genuine wrong password.

There is also a real **lockout** now (added in #134): `LOGIN_FAIL_LIMIT` wrong passwords per account,
default 10, inside `LOGIN_FAIL_WINDOW_S` (default 15 min). Retrying a wrong password in a loop will
eventually lock the account out for the rest of the window, so a session that starts with bad
credentials can end up unable to use the good ones.

**Post-MVP:** the founder's call (2026-08-16) is that seeded credentials in the repo are acceptable
until launch, and that everything gets stripped afterwards. Note for that sweep: the seeded accounts
share this database with a handful of real signups and with consignee names and phone numbers on
live bookings.


### 6.5 Local dev reference

Neither `shipper/` nor `driver/` has an `.env.local` checked in. The Dockerfiles' `NEXT_PUBLIC_API_URL`
build-arg defaults to the live prod gateway, so local dev needs **no local backend** just to render the
page shell:
```bash
cd shipper   # or driver
NEXT_PUBLIC_API_URL=https://bt-gateway-itcdoenefa-el.a.run.app npm run dev   # → localhost:3000
```
Two gotchas:
- **This machine's default `node` is v16** (nvm), but Next 16 needs `>=20.9.0`. Point
  `runtimeExecutable`/`PATH` at an installed v20+ (v20.20.0 confirmed working) in
  `.claude/launch.json` — write out the full resolved `PATH` literally, don't rely on `$PATH`
  expansion inside JSON env values.
- **Login and every other gateway call fail from `localhost` by default** — the prod gateway's CORS
  policy hardcodes the three `bt-*.run.app` origins, no env var opens it for local dev.
  **SOLVED (2026-07-20):** proxy `/api/*` through Next's own `rewrites()` so requests are same-origin
  and CORS never applies — no local backend, no founder CORS change needed. In the app's
  `next.config.ts`:
  ```ts
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [{ source: "/api/:path(.*)", destination: "https://bt-gateway-itcdoenefa-el.a.run.app/api/:path" }]
  },
  ```
  and set `NEXT_PUBLIC_API_URL` to the app's own origin (e.g. `http://localhost:3211`). Verified
  end-to-end: real login, real bookings list, real `/api/tracking/track` — all 200. **Three traps:**
  use `:path(.*)`, not `:path*` (the latter drops the trailing slash and `api.ts` calls `/bookings/`
  **with** one); without `skipTrailingSlashRedirect: true`, Next 308s the trailing slash away and the
  gateway 301s it back → infinite redirect loop; **the gateway's 301 downgrades the scheme to
  `http://`** (§5.4 item 5) and a browser caches a 301 *permanently*, so one bad request poisons that
  URL for the whole origin — recovery is a fresh port (new origin), not clearing app state. Maps
  rendering still needs the live deploy (browser key is referrer-locked to `*.run.app`) — you'll see
  `Live map unavailable — map key not configured.` locally.

Local port map: gateway `8080`, auth `3001`, booking `3002`, pricing `3003`, payment `3004`,
cargo-ledger `3005`, tracking `3006`, any single Next app's dev server `3000`.

### 6.6 Per-app test checklist

**Shipper (`bt-shipper`):** Login (Email tab) → Dashboard/"My Bookings" loads → open an existing
booking's detail page (route/load/price render) → Trip Status stepper reflects real status → live
tracking map renders pins+route or degrades to the placeholder without crashing → Quotes panel only
shows for the booking's actual type/status → Payment/POD section appears once `completed`/`paid` →
mobile viewport. *Out of scope by default:* "New Booking" creation flow.

**Driver (`bt-driver`):** Login (Email tab) → "Available Bookings" (Browse) loads → "My Quotes" tab →
Profile tab (truck type/reg/license) → PWA basics (manifest, service worker registered) → Screen Wake
Lock activates during an active trip (code-level only — can't visually confirm without an active trip,
§5.4 item 2) → Active-trip GPS section (GPS indicator, "Mark as Delivered"→POD-OTP, deep-link
Navigate) — requires an assigned+`in_transit` booking, not reachable with documented demo creds as of
the last check → mobile viewport (primary — this app is used in a truck cab) → onboarding wizard
(`/onboarding/personal` etc.) reachable only by direct URL, see §5.4 item 3. *Out of scope by default:*
submitting a quote / the auction bidding flow.

**Backend dependency map** (a blank panel may be infra, not a UI bug — check `/health` first, §6.2):

| Symptom in the UI | Likely backend dependency |
|---|---|
| Price/quote figures missing or erroring | `bt-pricing-service` |
| Payment status/payout not showing | `bt-payment-service` |
| POD/"Mark as Delivered" failing | `bt-cargo-ledger` |
| Live map/ETA/pumps/fuel/alerts failing | `bt-tracking-service` |
| Anything failing app-wide | `bt-gateway`, or the specific service it proxies to |

### 6.7 Public Maps config (browser-safe, referrer-restricted — not the secret key)

- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=<GOOGLE_API_KEY — kept in Secret Manager, not in git>` — console key
  `bt-browser-maps-js` (HTTP referrers + Maps JavaScript API only). Do **not** use
  `bt-tracking-server` (2 APIs) or the unrestricted `Maps Platform API Key`.
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=f2e0c2b5b35f303a174c310f` — the primary, founder-confirmed value.
  `f2e0c2b5b35f303a607b2ec5` is the historical fallback (if a deploy renders the base map but no
  markers, the Map ID is wrong — swap and rebuild).

Referrer allowlist on the browser key is `https://*.run.app/*`, covering both Cloud Run hostname
styles for the apps — no referrer change needed on redeploy.

> **The map will NOT render on `localhost` — this is expected, not a bug** (learned 2026-07-31).
> That allowlist excludes `http://localhost:*`, so any local dev run gets
> `RefererNotAllowedMapError` and a grey canvas. Do **not** "fix" it by adding localhost to the
> production key or by pasting the unrestricted key into a local `.env` — either move weakens the
> one control that stops a leaked browser key from being used elsewhere. Verify map-adjacent work
> against the deployed `*.run.app` apps (§6.2), and treat localhost as the test case for the
> **degraded** path: with `map-guard.tsx` in place the page must stay fully usable with the map
> replaced by a "Map unavailable" panel. If a local run ever shows a working map, the key
> restriction has been loosened and that is the actual bug.

### 6.8 Where the real secrets live (not here)

| Var | Lives in | How to read (read-only) |
|---|---|---|
| `GOOGLE_MAPS_SERVER_KEY` | `bt-tracking-service` Cloud Run env | `gcloud run services describe bt-tracking-service --region=asia-south1 --project=project-aa0faf06-c115-438a-a36 --format=json` |
| `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `SUPABASE_URL` | `bt-booking-service` Cloud Run env (source of truth, copied to other services on deploy) | same `describe` pattern against `bt-booking-service` |

Reading (`describe`) is fine for diagnosis; **writing/rotating is a founder action** — see §7.

### 6.9 History (condensed)

Initial harness built 2026-07-18 from a full pass against the live deployment (found: Maps key broken,
`LiveTrackMap` degrade gap, Quotes-panel bug — fixed same day, demo-driver has no active trip, driver
Maps/insights UI genuinely not built yet by roadmap, shipper missing PWA manifest, three services
503). 2026-07-18 follow-ups: fixed the Quotes-panel bug; found + documented the local-dev CORS
blocker (later solved, see 6.5); founder supplied corrected Maps values, handed the redeploy command.
2026-07-20: local-dev proxy trick found (6.5); gateway scheme-downgrade 301 bug found (§5.4 item 5);
reconfirmed demo creds + seeded booking still present. Folded into this Bible 2026-07-20 (§0.3).

---

## §7 — Runbooks

_Sources: `docs/runbooks/DEPLOY-stub-pilot.md` (owner: infra) + `docs/runbooks/W1-8-503-env-fix-and-migrations.md`
(owner: infra). Standing operational procedures — update in place as the deploy story changes._

### 7.1 Full-stack deploy (stub-pilot: cash-recorded payments, KYC manual, Maps live)

Uses `gcloud run deploy --source` so each build uses the service's own Dockerfile. **No secret values
appear in this doc** — env values copy from the already-healthy `bt-booking-service` (§7.2) or are the
Phase-0 restricted keys the founder holds (§3.1 §6.5).

```bash
export PROJECT=project-aa0faf06-c115-438a-a36
export REGION=asia-south1
gcloud config set project "$PROJECT"; gcloud config set run/region "$REGION"
# APIs run.googleapis.com, cloudbuild.googleapis.com, artifactregistry.googleapis.com enabled.
# Maps Phase-0 (§3.1 §6.5) done: Maps JS + Routes + Places(New) enabled; 2 restricted keys created.
```

Deploy order follows the dependency chain: **backend services → gateway → apps** (services carry a
circular URL dependency — booking needs pricing/payment/cargo URLs, those need booking's URL — so all
services deploy first to mint URLs, then cross-service env is set, then the edge + apps).

**1. Backend services (6):**
```bash
deploy_svc () { gcloud run deploy "$1" --source "$2" --region "$REGION" --project "$PROJECT" \
  --platform managed --allow-unauthenticated --port 8080; }
deploy_svc bt-auth-service     bt-auth-service
deploy_svc bt-booking-service  bt-booking-service
deploy_svc bt-pricing-service  bt-pricing-service
deploy_svc bt-payment-service  bt-payment-service
deploy_svc bt-cargo-ledger     bt-cargo-ledger
deploy_svc bt-tracking-service bt-tracking-service
```
Required env by service (names only — values are shared secrets already on booking, or Phase-0 keys):

| Service | Required env (beyond NODE_ENV/PORT) |
|---|---|
| `bt-auth-service` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, the **SMTP set** (login OTP / magic link / password reset are sent inline from here), and `BOOKING_SERVICE_URL` + `INTERNAL_SERVICE_SECRET` (for the password-changed security notice) |
| `bt-booking-service` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`, `PRICING_SERVICE_URL`, `PAYMENT_SERVICE_URL`, `CARGO_LEDGER_URL`, plus the **notification set** (migration 021): the **SMTP set** (`SMTP_HOST`,`SMTP_PORT`,`SMTP_USER`,`SMTP_PASS`,`SMTP_FROM`,`EMAIL_DEV_MODE=false`) + `SHIPPER_APP_BASE_URL`, `DRIVER_APP_BASE_URL`, `NOTIFICATIONS_PUBLIC_BASE_URL`. This service hosts the outbox dispatcher for the whole platform — without the SMTP set it silently runs in console-log mode (`GET /health` reports `email:"console"` when it does). Do **not** set `NOTIFICATIONS_DISPATCH_INTERVAL_MS` on Cloud Run — see the scheduler note below. |
| `bt-fleet-service` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`, and `BOOKING_SERVICE_URL` (fleet invites post to the notification outbox; without it an invite is only visible in-app) |
| `bt-pricing-service` | `JWT_SECRET` (only — see §7.2's ticket-vs-code correction) |
| `bt-payment-service` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`, `BOOKING_SERVICE_URL` |
| `bt-cargo-ledger` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `INTERNAL_SERVICE_SECRET`, `BOOKING_SERVICE_URL`, `BLOCKCHAIN_ENABLED=false`, and the **SMTP set** (`SMTP_HOST`,`SMTP_PORT`,`SMTP_USER`,`SMTP_PASS`,`SMTP_FROM`,`EMAIL_DEV_MODE=false`) — required for POD OTP to actually reach the receiver, not fall back to console-only logging |
| `bt-tracking-service` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `JWT_SECRET`, `GOOGLE_MAPS_SERVER_KEY`, `BOOKING_SERVICE_URL`, `DIESEL_PRICE_INR=90` |

Cross-service URLs: after the first deploy, read each with `gcloud run services describe <svc>
--format='value(status.url)'` and set via `--update-env-vars` (merge, never `--set-env-vars` — that
replaces the whole env).

**Notification dispatch on Cloud Run (required, easy to miss).** Queued email is drained by a worker
that only runs when something invokes it. Cloud Run freezes the container between requests unless
CPU-always-allocated is set, so the in-process timer (`NOTIFICATIONS_DISPATCH_INTERVAL_MS`) does **not**
reliably fire there — leave it unset in prod. Create a Cloud Scheduler job instead:

```
gcloud scheduler jobs create http bt-notification-dispatch \
  --location=asia-south1 --schedule="* * * * *" \
  --uri="https://<bt-booking-service-url>/internal/notifications/dispatch" \
  --http-method=POST \
  --headers="x-internal-secret=<INTERNAL_SERVICE_SECRET>"
```

Safe to run concurrently with anything else draining: rows are claimed with a compare-and-swap, so an
overlapping tick finds nothing to do rather than sending duplicates. **Without this job, notifications
queue up in `notification_outbox` and are never sent** — and nothing errors, which is exactly how the
POD OTP shipped looking green while being undeliverable (§5.4 item 10).

**Alert sweeps on Cloud Run (required for alerts to exist at all).** Alerts (migration 0042, table
`alerts`) are raised and resolved only by a sweep — nothing in the request path creates them. Two
Cloud Scheduler jobs, same secret as the dispatch job:

```
gcloud scheduler jobs create http bt-alerts-sweep-frequent \
  --location=asia-south1 --schedule="*/5 * * * *" \
  --uri="https://<bt-booking-service-url>/internal/alerts/sweep?cadence=frequent" \
  --http-method=POST \
  --headers="x-internal-secret=<INTERNAL_SERVICE_SECRET>"

gcloud scheduler jobs create http bt-alerts-sweep-daily \
  --location=asia-south1 --schedule="0 8 * * *" --time-zone="Asia/Kolkata" \
  --uri="https://<bt-booking-service-url>/internal/alerts/sweep?cadence=daily" \
  --http-method=POST \
  --headers="x-internal-secret=<INTERNAL_SERVICE_SECRET>"
```

The frequent sweep looks for live trips whose GPS has gone quiet (warning at 15 min, critical at 2 h);
the daily one looks for accepted trips not started by their pickup date, delivered trips still unpaid
after 3 / 7 days, and driving licences expired or expiring within 30 days. Every run is idempotent — one open
alert per kind + subject + person (`dedupe_key`) — and resolves the alerts whose condition has
cleared. A run emails (`alert_raised`, sent by the dispatch job above) only when an alert opens as,
or escalates to, critical. Each open alert also shows on that person's Home feed. Before 0042 is
applied the sweep answers **503 `ALERTS_NOT_MIGRATED`** and writes nothing, and Home and
`/me/summary` show no alerts rather than erroring — so the jobs can be created before or after the
migration, but alerts appear only once both exist.

**2. Gateway:**
```bash
gcloud run deploy bt-gateway --source bt-gateway --region "$REGION" --project "$PROJECT" \
  --platform managed --allow-unauthenticated --port 8080
```
Confirm `/api/{auth,bookings,quotes,location,tracking,pricing,payments,cargo}` route correctly and
`GET /health` is 200.

**3. Apps (3) — deploy LAST** (they bake `NEXT_PUBLIC_*` at build time — API URL, Maps browser key,
Map ID). ⚠️ The Dockerfiles must have the correct **browser** key + Map ID baked first — that edit
embeds a key value, a founder-gated action (§4.1 rule 6/CLAUDE.md guard) — apply it before building:
```bash
deploy_app () { gcloud run deploy "$1" --source "$2" --region "$REGION" --project "$PROJECT" \
  --platform managed --allow-unauthenticated --port 8080; }
deploy_app bt-driver   driver
deploy_app bt-shipper  shipper
deploy_app bt-ops-web  bt-ops-web
```
`bt-ops-web` also needs its own server env (ops auth/data) set before traffic.

**4. Verify:**
```bash
for s in bt-auth-service bt-booking-service bt-pricing-service bt-payment-service \
         bt-cargo-ledger bt-tracking-service bt-gateway bt-driver bt-shipper bt-ops-web; do
  u=$(gcloud run services describe "$s" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
  echo -n "$s -> "; curl -s -o /dev/null -w "%{http_code}\n" "$u/health" 2>/dev/null || echo "n/a"
done
```
Backend+gateway `/health` = 200; apps: load the PWAs, confirm the map renders and a
`/api/tracking/track/:bookingId` call returns route+ETA. Smoke the slice with the T-115 GPS simulator
(`scripts/gps-simulator/`) to move the truck without a real drive.

### 7.2 The 503 fix + migrations reconcile (resolved 2026-07-20 — kept as the diagnosis reference)

**Root cause of the 503s (both, confirmed):** (a) the deploy workflow ran only `gcloud run deploy
--image` with "existing env preserved," which never *sets* env on a service whose Cloud Run env was
never populated — the container throws at boot and Cloud Run serves 503; (b) `bt-cargo-ledger`
additionally carried `run.googleapis.com/scalingMode: manual` +
`run.googleapis.com/manualInstanceCount: 0` — administratively scaled to zero, which Cloud Run reports
as `Ready=True` (the *revision* is healthy) even though `/health` still 503s with Google's own "Service
is disabled" page. **`Ready=True` is not a sufficient health signal — always curl `/health` too.**

**Required env, verified against code** (differs from the original ticket — see the discrepancy note
below): `bt-cargo-ledger` hard-requires `BOOKING_SERVICE_URL`, `INTERNAL_SERVICE_SECRET`, `REDIS_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and — not optional if POD must actually work — the full
SMTP set (§7.1's table); without it the OTP sender silently falls back to console logging and never
reaches the receiver. `bt-payment-service` hard-requires `BOOKING_SERVICE_URL`,
`INTERNAL_SERVICE_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`.
`bt-pricing-service` requires only `JWT_SECRET` (checked per-request, not a boot throw) + optional
`DIESEL_PRICE_INR`.

**The fix (copy values from the already-healthy `bt-booking-service`):**
```bash
export PROJECT=project-aa0faf06-c115-438a-a36 REGION=asia-south1
bookenv() { gcloud run services describe bt-booking-service --region "$REGION" --project "$PROJECT" \
  --format="json" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[] | select(.name==$k) | .value'; }
INTERNAL_SERVICE_SECRET=$(bookenv INTERNAL_SERVICE_SECRET); JWT_SECRET=$(bookenv JWT_SECRET)
REDIS_URL=$(bookenv REDIS_URL); SUPABASE_URL=$(bookenv SUPABASE_URL)
SUPABASE_SERVICE_ROLE_KEY=$(bookenv SUPABASE_SERVICE_ROLE_KEY)
BOOKING_URL=$(gcloud run services describe bt-booking-service --region "$REGION" --project "$PROJECT" --format='value(status.url)')

gcloud run services update bt-cargo-ledger --region "$REGION" --project "$PROJECT" \
  --update-env-vars "BOOKING_SERVICE_URL=$BOOKING_URL,INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET,REDIS_URL=$REDIS_URL,SUPABASE_URL=$SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY,BLOCKCHAIN_ENABLED=false"
gcloud run services update bt-payment-service --region "$REGION" --project "$PROJECT" \
  --update-env-vars "BOOKING_SERVICE_URL=$BOOKING_URL,INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET,SUPABASE_URL=$SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY,JWT_SECRET=$JWT_SECRET"
gcloud run services update bt-pricing-service --region "$REGION" --project "$PROJECT" \
  --update-env-vars "JWT_SECRET=$JWT_SECRET,DIESEL_PRICE_INR=90"
gcloud run services update bt-cargo-ledger --region "$REGION" --project "$PROJECT" --scaling=auto
```
(`--update-env-vars` merges, never wipes other vars — don't use `--set-env-vars`, it replaces the
whole env.) **Execution note:** an automated agent cannot run these — the harness classifier blocks
direct prod Cloud Run mutations even with chat approval; a human operator with `gcloud` auth runs them
(this is exactly what happened 2026-07-20 — see §5.1, all ten now 200).

**Ticket-vs-code discrepancies** (flagged during the fix, worth remembering): the original ticket said
cargo needed only `REDIS_URL, INTERNAL_SERVICE_SECRET, BOOKING_SERVICE_URL` — code also hard-requires
Supabase creds. Same gap for payment. Pricing's ticket listed Supabase creds it doesn't actually read —
its only real dependency is `JWT_SECRET`. **Lesson: verify required env against `grep process.env` +
the boot-time throws in the actual code, not the ticket text.**

**Migrations reconcile** (`supabase/migrations` vs. live DB `rxbdzbcndpzznvqcbimg`) — all confirmed
applied: `0009_location_history.sql`, `0010_pod_receipts.sql`, `0011_payments_payouts.sql`,
`0012_ops_overrides.sql`, `0013_price_quotes.sql`. The DB's own migration tracking folded 0009-0012 in
via a single reconcile migration; the repo README's planned `0001-0007` baseline was never committed as
files (a separate, still-open item, not part of this 0009+ slice).

**Correction on record:** an earlier version of this runbook claimed a
`0013_add_booking_status_expired.sql` was missing and a prod blocker. Re-verified 2026-07-20 — no such
file was ever meant to exist, the real `0013_price_quotes.sql` is applied, and nothing writes
`booking_status='expired'` (the only `'expired'` writes target the unrelated `quotes.status` text
column). **Do not run an `ALTER TYPE ... ADD VALUE 'expired'`** on `booking_status` — it would add an
enum value no code uses. Revisit only alongside the `jobs.ts` auction-expiry implementation
(`feat/auction-expiry-rebased`, §5.3).

---

## Appendix A — Audit trail & rulings

_Folded in from the former `docs/CTO_AUDIT_FINDINGS.md` (deleted 2026-08-07), the original 2026-07-04 production-readiness audit. Most of the
original P0 backlog (items 1-7: lifecycle dead-end, missing breadcrumb write, unversioned DB schema, no
CI/CD, both apps failing to build, gateway not routing tracking) is now **resolved** per §5.2 — kept
here only as a historical record of what the audit originally found, not a live task list._

### A.1 Rulings that resolved doc contradictions (2026-07-04/07-05 — still binding)

1. **Single authoritative plan = §2.** The old root `ROADMAP.md` was banner-marked superseded and has
   since been deleted; PRD Part 10's original escrow/blockchain/RL sequencing is historical only.
   On any conflict about what we build/cut, §2 wins; the frozen §3.1 wins on tracking/maps specifics.
2. **Retired-repo links fixed** — nobody pushes to the retired standalones/mirrors (Appendix C).
3. **Blockchain/on-chain anchor = OUT** of the first Completed Paid Trip (deferred). Receiver-OTP POD =
   IN. Checkpoint photos may be captured but are not anchored on-chain yet.
4. **Pricing = the existing deterministic rate-card engine (v1).** The from-scratch Python/FastAPI +
   LinUCB rewrite is out as a *deploy target* (its constants are still worth harvesting, Appendix D).
   The PRD-DoD fuel/driver/per-km operating-cost breakdown (not just a commercial split) was the real
   gap — since closed per §5.2.
5. **Maps numbering reconciled** to the frozen scheme: decisions are `D-001..D-013` (§3.2); phases
   follow §3.3's Phase 0-6. Any older "Phase 1-5"/"Decision 1-8" labeling elsewhere is a historical
   alias, not a second scheme.

### A.2 Still-relevant items from the original backlog (P1/P2, not yet fully closed)

- **Auth tokens (access+refresh JWT) in `localStorage`** in both PWAs → XSS = account takeover; no
  CSP/security headers. Not yet hardened as of the last check.
- **No Screen Wake Lock verification live** — code exists (D-008), not yet visually confirmed in a
  real active trip (§5.4 item 2).
- **Zero automated tests** across all services/apps at audit time — since partly addressed (harnesses
  referenced throughout Appendix B's verified merges), but never called "done" as a category.
- **No shared package originally; boilerplate duplicated** — since addressed via `packages/shared`
  (`@bharattruck/shared`, §5.2), migration to other services ongoing.
- **Weak observability** — no correlation/request IDs, shallow health checks, `CORS origin:true`
  everywhere. Not fully addressed.
- **Committed weak default secrets** in `docker-compose.yml` (a 64-hex `ENCRYPTION_KEY` fallback + dev
  `JWT_SECRET` fallbacks) — make them mandatory, drop the `:-` default. Local-only risk, not the live
  deploy, but still open.

### A.3 External gates & single points of failure (still worth tracking)

"Registered entity" gate blocks Surepass (KYC), Razorpay (payments), and GCP-billing scale-up — see
§5.5. Single vendors, no fallback: Surepass, Google Maps (quota is a fail-closed hard cap on a
never-cut feature), Supabase (service-role bypasses RLS, §5.4 item 7), single Redis (OTP+sessions+live
location+caches). Payment/RBI landmine: escrow deferred via cash-recording, but a real launch invokes
RBI PA/escrow licensing — no date/owner/partial plan yet. Capacitor "Go native" is large/unspecified —
reliable Android background GPS is exactly what the web PWA can't do; no spike scheduled as of the
audit.

---

## Appendix B — Engineer scorecard

_Folded in from the former `docs/CTO_SCORECARD.md` (deleted 2026-08-07). Maintained by the `cto` node, reviewed by the founder — append-only,
one row per node, updated on every review. Rubric in §4.3. Marks are evidence-backed, not vibes._

### Standing (as of the last update)

| Node | Correctness | Honesty | Contract discipline | Verification depth | Net |
|---|---|---|---|---|---|
| `backend` | ✅ reproduced first try (e.g. T-BE-1: tsc exit 0 + 18/18 e2e) | ✅ honest caveats, never hidden | ✅ frozen contract + slice scope respected | ✅ real inject()+Redis harnesses, not "compiles" | 🟢🟢 strong |
| `frontend` | ✅ reproduced (both apps compile clean) | ✅✅ self-reported its own process breach unprompted | ✅ frozen Maps contract clean, locked env keys, no legacy APIs | ✅ real build logs, no stubs/fake data | 🟢 strong; one flagged-and-remediated process breach |

### Log (condensed — see git history / prior sessions for full narrative detail)

- **2026-07-04:** shared-working-tree incident (no per-agent isolation) → remediated by establishing
  worktree isolation (§4.4); no fault assigned to either engineer. `frontend` self-reported a
  pushed-before-audit breach unprompted — logged as a ⚠️ watch, not a penalty, given the honesty and
  that it predated the formal worktree rule.
- **2026-07-04/07-05:** first real `main` integration (infra + lifecycle + POD + shadcn + migrations
  009/010), all CTO-verified before merge. `backend`'s T-BE-2 (POD) caught the CTO's own suggested
  "atomicity RPC" conflicting with a locked decision and proved the as-built already blocked
  double-complete — ruled in backend's favor; excellent judgment noted.
  `frontend`'s T-FE-2 code CTO-verified but visual demo deferred (Phase-0 Maps keys absent at the
  time) — refused to fabricate a moving-truck demo, named the exact blocker. Textbook honesty.
- **2026-07-05:** `backend` T-BE-4 (cash payment) verified — also removed fabricated Razorpay
  escrow stubs, enacting the escrow-OUT decision that stood at the time and clearing a no-stubs
  violation. T-BE-5 (pricing breakdown) verified — flagged every vehicle-class/constant assumption for
  the founder's call rather than silently picking. Both ✅✅.
- **2026-07-09:** `backend` T-BE-7 (shared-libs) round-tripped through a `changes_requested` (a "fresh
  checkout" test was a false positive, caught before `main`) then a clean re-verified fix — turned into
  a reusable methodology upgrade (git-worktree fresh-checkout as the verification standard).
  `frontend` T-FE-5 (driver PWA + Wake Lock, D-008) verified + merged; T-FE-3/T-FE-4 (ops console +
  override buttons) verified + merged, completing the entire vertical slice's frontend half.
- **2026-07-11:** SCOPE/COORD EVENT — a second coder (kartik) pushed Python escrow+RL services directly
  to `main`. No force-push/data loss; founder ruling was quarantine (see Appendix D). Preserved on
  `feat/python-engines`, `main` force-reset to the last CTO-verified TS-only commit.

_Nothing here is a final judgment — it's a running record the founder can audit at any time. Append new
entries with a date; don't rewrite old ones._

---

## Appendix C — Monorepo provenance

_Folded in from the former `docs/MONOREPO_PROVENANCE.md` (deleted 2026-08-07). Small, factual, doesn't go stale — kept whole._

Snapshot-consolidated **2026-07-04** from the canonical `Entropy-LLP/*` standalone repos at these
commits. The standalone repos are retained as the historical archive; this monorepo is the go-forward
source of truth.

| Monorepo path | Source repo | Source commit |
|---|---|---|
| `bt-gateway/` | Entropy-LLP/bt-gateway | `6c255b0c2257` |
| `bt-auth-service/` | Entropy-LLP/bt-auth-service | `d743491a5f0f` |
| `bt-booking-service/` | Entropy-LLP/bt-booking-service | `ef36eb98e9a9` |
| `bt-pricing-service/` | Entropy-LLP/bt-pricing-service | `accbd8c06446` |
| `bt-payment-service/` | Entropy-LLP/bt-payment-service | `d32ecad7b9ce` |
| `bt-cargo-ledger/` | Entropy-LLP/bt-cargo-ledger | `39d80f2ff9ea` |
| `bt-ops-web/` | Entropy-LLP/bt-ops-web | `e56e415bd32c` |
| `bt-tracking-service/` | Entropy-LLP/bt-tracking-service | `9bbb092aceed` |
| `driver/` | Entropy-LLP/bt-driver-app | `2615a31fb35c` |
| `shipper/` | Entropy-LLP/bt-shipper-app | `a2d8b587befa` |
| (root) `docker-compose.yml`, `docker-compose.prod.yml`, `Makefile`, `setup.sh`, `infra`, `k8s`, `gps-test.html` | Entropy-LLP/LogisticOS | `babb2b19a8b4` |

---

## Appendix D — Pricing & payments status (for the other coder)

_Folded in from the former `docs/PRICING_PAYMENTS_STATUS.md` (deleted 2026-08-07). Purpose: the coder who owns `bt-pricing-service` +
`bt-payment-service` work outside this team (kartik / `kinbox-ctrl`, a GitHub collaborator) must know
everything happening on those two services — keep this current and flag any change to him directly._

**Decision of record:** the **TypeScript** `bt-pricing-service`/`bt-payment-service` are the MVP anchor
and what deploys to Cloud Run. The **Python** engines (`feat/python-engines`: LinUCB RL pricing +
Razorpay/escrow FastAPI) stay **quarantined** — must NOT re-enter the Node deploy (second runtime +
second DB would break it). They remain the seed for a post-feasibility upgrade (RL behind
`PRICING_MODE=ml`; escrow once it gains real payout+auth+schema reconciliation). Founder call
(2026-07-12): pilot = cash-recorded payments + deterministic pricing — reconfirmed at the time, but see
§2's scope-reversal banner, which post-dates and complicates this.

**Pricing — what changed (live on `main`):** quote-lock added (migration 0013, applied):
`POST /pricing/quote` derives distance server-side (haversine ×1.3, no maps key), persists a
`price_quotes` row, returns `quote_id`. Internal quote-consume endpoints use
`INTERNAL_SERVICE_SECRET`, constant-time. `bt-booking-service` create now binds the booking's
route/weight/load/vehicle_type to the locked quote (shown price == charged price). Service mounts
under `/pricing`. Placeholder cost constants not yet harvested from kartik's `cto_data.py` (open item).

**Payments — what changed:** cash-recorded settle is the pilot path: `POST /payments/settle
{booking_id,amount,mode}` → records + calls booking's internal mark-paid →
`completed→paid`. Outbox saga pre-creates a payout row. No Razorpay/escrow yet (pending §2/§5.5's
reversal reconciliation). `payment/.env.example` is stale (dead `RAZORPAY_*`, missing real required
vars) — cleanup queued.

**The kartik review (evidence + recommendation):** his `ml-engine/cto_data.py` has real, data-grounded
market constants (mileage/DEF/service/oil/wage/capacity by BS-norm) — the single most valuable
artifact — and a real, trainable LinUCB RL agent. BUT: his P0 breakdown endpoint is broken, quote_id +
agent weights are in-memory (vanish on Cloud Run), no auth, scope-creep beyond the PRD (backhaul/
LinearQAgent), committed model/binary artifacts. **→ Keep the CTO's live TS engine as the P0 anchor;
port his constants in; park his RL behind `PRICING_MODE=ml`.** His Razorpay SDK plumbing + HMAC webhook
verification are real and well-layered, BUT escrow "release" moves no actual money (no
RazorpayX/Route, no payout table), refund is a stub, no auth (amount trusted from client), no
cash/direct modes, not wired to booking-service, and it's self-custody escrow — which *worsens* the
RBI exposure the PRD warns against. **→ Keep the CTO's live cash-recorded TS service for the MVP; keep
his engine on the branch as the escrow seed for post-feasibility, only after it gains real
payout+auth+Route+schema reconciliation.**

**Open/coming:** pricing constant-harvest; escrow (self-custody TS mode) + RL — only when the founder
provides Razorpay/Surepass and re-prioritizes (see §2's banner and §5.5). Any change to these two
services gets flagged here + via PR, per the standing instruction to keep kartik informed.
