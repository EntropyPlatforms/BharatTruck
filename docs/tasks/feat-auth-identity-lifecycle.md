# Task: `feat/auth-identity-lifecycle`

**Relates to:** `docs/ARCHITECTURE_UNIFIED_IDENTITY.md` **§10.1** decisions **D-31** (KYC prompts,
never gates), **D-32** (primary persona is a front door, not a ladder), **D-33** (the persona
completeness ring), **D-35** (the consignee is not a persona — an emailed claim link to a standalone
form, no KYC), building on **D-22** (the consignee is a shipper-kind party, claimed or unclaimed).
All additive; nothing existing changes meaning.

## What this branch adds (all in `bt-auth-service`)

Three coherent additions on the shared auth surface, one PR.

### Part 1 — profile-creation endpoints (D-32)

The forward path for a persona to come into being in-app, from any starting persona, without
re-signup. Replaces the signup role-branch (`ensureRoleProfile`) as the way profile rows are born;
that branch stays for back-compat.

- `POST /drivers/me` — creates the caller's `drivers` row (idempotent; UNIQUE(user_id) makes a repeat
  a no-op returning the existing row). What a shipper does when they add their first truck.
- `POST /fleet-owners/me` — creates the caller's `fleet_owners` row (idempotent; does not overwrite an
  edited company name). Accepts optional `company_name`/`gstin`/business fields; **none required**
  (D-31). A user who declared "fleet owner" at signup, or a driver who grew into one, calls this.

Authorize on OWN identity only: the `user_id` is taken from the verified JWT, never the body, so one
user can never create another's profile. `fleet-owners` body is `.strict()`, so a smuggled `user_id`
is a 400.

### Part 2 — persona completeness + acknowledgements (D-33 / D-31)

- `GET /me/completeness` — per persona surface the human HAS (shipper always; driver = has a `drivers`
  row; fleet owner = has a `fleet_owners` row), reports each D-33 requirement item as
  `verified | declared | missing`, with a per-persona and an overall percentage. Requirement sets:
  driver = Aadhaar + PAN + driving licence; fleet owner = GST + business/bank; shipper = GST
  (informational). **DISPLAY-ONLY. NEVER GATES** (D-31) — the payload even carries `gates_nothing: true`.
  KYC is stubbed today (the `/kyc` routes are 501), so most items resolve to `declared` (via an
  acknowledgement) or `missing`; the `verified` branch lights up the day real KYC lands.
- `POST /me/acknowledgements { kind }` — records a VERSIONED self-declaration (D-31). Stores the exact
  server-owned statement text verbatim (not a boolean — a boolean proves nothing later), keyed by
  `kind + version`. The canonical registry is `src/lib/acknowledgements.ts`. Re-prompting when facts
  materially change is a noted FUTURE refinement, not built here.

### Migration `0028_persona_acknowledgements.sql` — **not applied to production**

Strictly additive, idempotent, forward-only. One table (`persona_acknowledgements`) + one index.
History, not state: re-signing after a version bump appends a row; the completeness read only asks
"is there ANY of this kind". Applied BY HAND per `supabase/migrations/README.md` — this branch does
not apply it. Until applied, `POST /me/acknowledgements` 500s on the missing table (loud, correct)
and completeness reports declarable items as `missing` — no gate exists to fail closed.

### Part 3 — consignee claim (D-35)

Off the KYC/onboarding surface entirely — a consignee carries no persona, no ring, no KYC.

- `POST /auth/consignee/claim/complete { token, password }` — verifies a single-use claim token
  (signed JWT + a Redis key deleted on use, mirroring the password-reset pattern), confirms the target
  `users` row is UNCLAIMED (`claimed_at IS NULL`, no `password_hash`/`google_sub`), sets the password,
  stamps `claimed_at = now()`, and logs them straight in. A burned token, an already-claimed row, and
  a credentialed real account are each refused cleanly (no takeover).
- `POST /internal/consignee/claim-invite { consignee_user_id }` — internal-secret gated; emails the
  claim link via the auth-service SMTP path. Unclaimed-only and idempotent (a duplicate emit for an
  already-claimed / no-email consignee is a 200 no-op, so a booking-service retry stays green). No KYC
  or persona required — a lightweight join.

### New env / gateway

- `CONSIGNEE_CLAIM_URL` — standalone claim-form origin the emailed link points at (documented in
  `bt-auth-service/.env.example`; falls back to a visibly-broken localhost dev link when unset).
- Gateway: new `/api/drivers/`, `/api/fleet-owners/`, `/api/me/` location blocks route to
  `bt-auth-service` (`nginx.conf.template` + the reference `nginx.conf`). `/api/auth/...` already
  covers the consignee claim-complete path; the internal invite is service-to-service (not exposed).

## Follow-ups (out of scope here)

- Wire `bt-booking-service` to call `POST /internal/consignee/claim-invite` when it creates a new
  consignee. The endpoint is complete and tested standalone; the caller is a separate integration.
- Phone-based claim invites (D-26) for the phone-only consignees that dominate this market.

## Tests

`test/identity-lifecycle.e2e.mts` (32 checks) and `test/consignee-claim.e2e.mts` (17 checks), in the
existing in-memory Fastify + fake Redis/Supabase idiom. Full suite green; `npm run build` clean.
