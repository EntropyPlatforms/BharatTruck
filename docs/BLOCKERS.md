# BLOCKERS — things only a human can unblock

> **Maintained live.** When I hit something I cannot do myself, it lands here and I move on to
> something I can. Nothing in this file is waiting on more engineering — each item needs a
> credential, an account, a click, or a decision that is not mine to make.
>
> Last updated: **2026-08-06**

---

## Legend

| | |
|---|---|
| 🔴 | Blocks a shipped feature from working in production |
| 🟠 | Blocks a feature from being *finished*; the code is built and inert |
| 🟡 | Not blocking today; will block before the pilot |

---

## 🔴 Blocking now

### B-1 · Razorpay credentials — automated payouts

**What's needed:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and a Razorpay
**Route** account (Route is the product that lets money move to *stakeholder-owned* linked accounts
rather than resting with the platform — that is the design, and it is also what keeps us out of GTA
territory, see `INDIA_FREIGHT_COMPLIANCE.md §1.3`).

**Where it stands:** the three env vars are declared in `bt-payment-service/.env.example` and are
**empty**; Cloud Run has none of them set. Searched the repo, the other services and GCP Secret
Manager — the only secrets in the project belong to an unrelated app (`anvaya-*`).

**What is built (2026-10-03):** the shipper's **online collection** — Razorpay Standard Checkout:
`bt-payment-service/src/routes/razorpay.ts` (order, verify, sync, signed webhook) and the "Pay online"
button in `bt-app/src/components/payment-section.tsx`. It is **off until the keys are set**
(`GET /payments/config` reports it; the app then shows only the record-a-payment form). Tested against
a fake gateway only — it has never run against Razorpay itself, because no keys exist.

**What is NOT built:** the payout leg. An online payment lands in the **platform's** Razorpay account and
the carrier's payout row is written `pending`; someone pays the carrier by hand. That is collection
*without* Route, i.e. money resting with the platform — the very thing the Route design above avoids.
**Decide before using live keys** whether that is acceptable for the pilot or whether Route transfers
must come first. Test keys (`rzp_test_…`) carry no such question.

**Consequence while blocked:** settlement stays **record-only**, which is exactly today's behaviour
and is a legitimate MVP mode. Nothing is broken; the online path is simply inert.

**To switch on:** create the Razorpay account, then
`gcloud run services update bt-payment-service --region=asia-south1 --update-env-vars RAZORPAY_KEY_ID=…,RAZORPAY_KEY_SECRET=…,RAZORPAY_WEBHOOK_SECRET=…`
(CD preserves existing env, so this is a one-time manual set — see `BIBLE.md §5.3`). In the Razorpay
dashboard add a webhook to `<gateway>/api/payments/razorpay/webhook` for `payment.captured` and
`order.paid`, with the same secret as `RAZORPAY_WEBHOOK_SECRET`. Start with test keys.

---

### B-2 · DLT registration — phone OTP

**What's needed:** TRAI **DLT** registration (entity ID + registered header + approved SMS templates),
and an SMS provider account (MSG91 / Twilio / Gupshup).

**Where it stands:** `POST /auth/send-otp` generates a real OTP and **console-logs it** — there is no
SMS provider wired. Every phone-OTP send site goes through one seam so that wiring a provider is a
config change, not a code change.

**Consequence while blocked:** phone login is a dead end for real users. Email OTP works. POD receiver
confirmation falls back to email.

**Why it can't be rushed:** DLT template approval takes days to weeks and cannot start until the
entity is registered. **This is the longest-lead item on the list — start it first.**

**What DLT registration produces** (all three are needed before an operator carries a message):
a **principal entity id** for the company; a **registered sender header** (the 6-character id the SMS
appears from, e.g. `BHTRUK`); and one or more **pre-approved templates** — exact message text with
variable slots. Text that does not match an approved template is rejected, and a run of rejections is
what gets a header suspended. It is filed against the company's legal identity (GSTIN, authorised
signatory, letterhead), so it needs the founder, not a code change.

**The seam that is already built (D-14, 2026-08-03).** `bt-auth-service/src/lib/sms.ts` is the only
way a phone OTP leaves the service. One `SmsProvider`, resolved once at boot:

- **`ConsoleSmsProvider` — the default**, and what runs on every environment today. It prints the
  same two lines this service printed before the seam existed, so nothing about the pilot changes.
- **`Msg91SmsProvider`** — a real MSG91 flow-API call, **unreachable without env vars**.

**The switch.** Live SMS is opt-in *and* all-or-nothing — `SMS_PROVIDER` must select a provider and
every credential it needs must be non-empty, or the service logs one warning at boot and stays on the
console. A half-filled config must not take phone login down, and must not fire a send the operator
will reject anyway:

| Env var | Source | Required |
|---|---|---|
| `SMS_PROVIDER=msg91` | ours — the opt-in | yes |
| `MSG91_AUTH_KEY` | MSG91 dashboard | yes |
| `MSG91_SENDER_ID` | **DLT** — the registered header | yes |
| `MSG91_TEMPLATE_ID` | **DLT** — a *pre-approved* template | yes |
| `MSG91_TEMPLATE_VAR` | **DLT** — variable name in that template (default `otp`) | no |
| `MSG91_DLT_TE_ID` | **DLT** — template entity id, when the operator wants it echoed | no |
| `MSG91_BASE_URL`, `SMS_TIMEOUT_MS` | ours — overrides | no |

Documented in `bt-auth-service/.env.example`; pinned by `bt-auth-service/test/sms-provider.e2e.mts`.

**When it clears:** set the vars on the `bt-auth-service` Cloud Run service and redeploy. No code
change, no migration. Confirm the boot line reads `[sms] provider=msg91` rather than the
`SMS_PROVIDER is unset` warning — that line is the difference between codes being delivered and codes
being logged.

---

## 🟠 Blocking completion

### B-3 · GSP contract — in-platform e-way bill generation

**What's needed:** a contract with a GST Suvidha Provider, and likely **ISO 27001:2013** (at least one
GSP requires it within 90 days of go-live — a 3–6 month exercise).

**Where it stands:** deliberately **out of MVP** by your decision. We record and attach an
externally-generated e-way bill instead. The full API contract, validations and error codes are
documented in `INDIA_FREIGHT_COMPLIANCE.md §4.8` so the later swap is a base-URL-and-credentials
change, not a rewrite.

**Also needed per customer, and it cannot be automated:** every shipper *and* every fleet owner must
log into the e-way bill portal → Registration → For GSP → OTP → pick the GSP → create an API
username/password. ~2 minutes each, and it is the biggest onboarding-funnel drop-off risk.

---

### B-4 · Legal opinion — GTA exposure

**What's needed:** a written opinion from Indian indirect-tax counsel.

**Why:** issuing a consignment note in your own name is what makes a platform a **GTA** under GST.
Two 2025-26 rulings held an e-commerce platform to be the GTA on exactly that basis, despite it owning
no trucks. Our design (LR in the fleet owner's name, in their series) is the right structure and is
well supported — but **no court has decided the case where the document names one party and the
commercial substance points at another, and that case is ours.**

The checklist is in `INDIA_FREIGHT_COMPLIANCE.md §10`. Five items, the sharpest being
**Carriage by Road Act s.3 registration** — s.2(a) defines "common carrier" to include *"a goods
booking company, contractor, agent, broker"*, which is broad enough to reach a freight marketplace,
and operating unregistered is still a punished act after the 2026 Jan Vishwas amendment. **That
exposure is not solved by keeping our name off the LR.**

---

### B-8 · GCS WORM bucket — POD original-photo bytes

**What's needed:** a Google Cloud Storage bucket in `asia-south1` with a **locked retention policy**
(years, per `INDIA_FREIGHT_COMPLIANCE.md §8.1`) so POD originals are un-deletable for the retention
period, and one env var — `POD_EVIDENCE_GCS_BUCKET` — set on `bt-booking-service` Cloud Run.

**Where it stands:** the POD evidence path (migration 0025, `feat/pod-rebuild`) is built and the
metadata half is fully live — `pod_evidence` records the on-device SHA-256, server time, geofence
result and the intended object key. The BYTES half is **inert**: `bt-booking-service/src/lib/pod/storage.ts`
computes the canonical `gs://…/pod/<booking>/<sha256>.bin` key and, with no bucket configured,
**no-ops the upload and warns**, recording `storage_status='no_op'` on the row. No credential is invented.

**Why GCS and not Supabase Storage:** the compliance requirement is true WORM / object-lock (§5.4
server-side) — the hash and audit log are only credible if the bytes provably could not be swapped.
GCS gives that via a locked bucket retention policy + object holds, enforced by the platform;
Supabase Storage has no first-class immutability guarantee. The rest of the stack is already GCP
`asia-south1`, so the trust boundary does not move. Rationale is in the file header.

**Consequence while blocked:** a POD captured today has a durable, hashed, geofenced METADATA record
but **no retained original image**. That is a legitimate-but-weaker state, surfaced in the logs (a
`storage is inert` warn per capture) and on the row (`storage_status='no_op'`), never silently. The
driver app should still PUT the original bytes to the signed URL once the bucket exists — this service
never touches the pixels, precisely so it can never re-encode them (IT Act s.7(b)).

**To unblock:** create the bucket with a locked retention policy, grant the `bt-booking-service`
service account `roles/storage.objectCreator`, then
`gcloud run services update bt-booking-service --region=asia-south1 --update-env-vars POD_EVIDENCE_GCS_BUCKET=<bucket>`.
No code change, no migration. Confirm a fresh capture records `storage_status='stored'` and a
`gs://…` URI rather than the inert warn.

---

## 🟡 Not blocking yet

### B-5 · Gateway returns HTML on 429

`bt-gateway` rate-limits `/api/auth/` and returns nginx's stock HTML error page. Both apps call
`res.json()` on every response, so it throws and the user sees *"Server error — please try again"*
instead of anything about rate limiting. Reachable by mistyping a password a few times.

Fix is an `error_page 429` in the gateway returning the `{success, code}` envelope. Not done yet
because it is a gateway config change and every service behind it shares the exposure — worth doing
once, deliberately. Recorded in `BIBLE.md §5.4`.

### B-6 · `SMTP_DAILY_BUDGET` defaults to 500/day

Now live across all auth mail. Fine at pilot scale; **raise it before any campaign**, because hitting
it also stops real verification codes. `gcloud run services update bt-auth-service --update-env-vars SMTP_DAILY_BUDGET=…`

### B-7 · West Bengal e-way bill threshold is unverified

Two independent research passes reached **different conclusions** about when WB's intra-state
threshold changed. The threshold table is built effective-dated with per-row notification provenance
precisely so this is answerable later — but the WB row should be confirmed against the state gazette
before anyone relies on it. `INDIA_FREIGHT_COMPLIANCE.md §0.2`.

---

## ✅ Resolved

| | Item | Resolution |
|---|---|---|
| ~~B-0~~ | Migration 0022 could not be applied — `apply_migration` is classifier-blocked | Founder authorised `execute_sql`; applied and verified 2026-08-03, ledger row written by hand. Procedure recorded for next time. |
