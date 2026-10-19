# Task: `feat/bt-app-completeness-ring`

**Relates to:** `docs/ARCHITECTURE_UNIFIED_IDENTITY.md` **D-33** (the persona-completeness ring) and
**D-31** (KYC prompts, never gates). The display half of the persona-onboarding model whose action
half is the emergence CTAs (#110). Pure frontend — `GET /api/me/completeness` +
`POST /api/me/acknowledgements` (bt-auth-service identity routes) already exist and are gateway-routed.

## What this branch adds

- **`bt-app/src/lib/types.ts`** — `CompletenessReport` / `PersonaCompleteness` / `CompletenessItem`,
  mirrored from `bt-auth-service/src/lib/completeness.ts`. Carries `gates_nothing: true`.
- **`bt-app/src/lib/api.ts`** — `getMyCompleteness()` (GET), `acknowledgePersona(kind)` (POST — the
  D-31 self-declaration; the server stores the exact text served, keyed by kind).
- **`bt-app/src/components/completeness-section.tsx`** — for each persona the user HAS, an SVG ring
  (% filled) + the item list (`verified` / `declared` / `needed`). Every `missing` item with an
  acknowledgement kind shows **"I'll provide later"** → `acknowledgePersona` → refetch (the item flips
  to `declared`). Never blanks: loading / error / empty / content.
- **`bt-app/src/app/(app)/settings/page.tsx`** — rendered ABOVE the fleet-owner-gated content, so the
  ring shows for EVERY account (shipper / driver / fleet owner), not just fleet owners (the rest of
  the page is `GET /fleet/owners/me`-gated and would 404 a non-owner).

## Why it never gates

The whole point of D-31/D-33: a low percentage is a nudge, not a permission decision. The payload's
`gates_nothing: true` says so in-band, and this UI treats it that way — nothing here disables a
surface or an action; the only interactive control turns a `missing` item into a `declared` one.

## Verification

- `bt-app npm run build` → clean (tsc + next build).
- Live with a demo-driver token: `GET /me/completeness` → the 3-persona report
  (`gates_nothing:true`, shipper/driver/fleet_owner rings); `POST /me/acknowledgements` with an
  invalid kind → **400** "Invalid enum value" (route deployed, enum-validated). The happy-path flip
  (`missing` → `declared`) follows from the backend (`acknowledged_kinds` feeds `computeCompleteness`);
  the probe stayed non-mutating to avoid piling acknowledgement rows onto the demo account.

## Out of scope (follow-ups)

- Surfacing the ring anywhere beyond settings (e.g. a compact home summary).
- Real KYC upload (the `/kyc` routes are 501 today, so items resolve to `declared`/`needed`, never
  `verified` yet — the `verified` branch is wired for the day KYC lands).
