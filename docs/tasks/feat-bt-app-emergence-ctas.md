# Task: `feat/bt-app-emergence-ctas`

**Relates to:** `docs/ARCHITECTURE_UNIFIED_IDENTITY.md` **§3.5** (emergence moments — the growth
loop), **D-32** (persona as a front door; profile-creation endpoints), **D-33** (completeness /
nudges), **D-21** (config suppresses, never gates). Builds on `feat/derole-fleet-service` (#109),
without which the fleet-management CTA would route into a 403.

## What this branch adds

The first **emergence CTA**: a home nudge that surfaces the ONE next step the user's assets imply,
and **performs the transition** rather than linking to a page that would 403.

- **`bt-app/src/lib/auth.tsx`** — `AuthContext` now exposes the full `PersonaSnapshot`
  (`owned_vehicle_count`, `held_driver_count`, `fleet_owner_id` — previously fetched from `/auth/me`
  and **discarded**) plus a `refresh()` to re-pull after a persona change. `capabilities` unchanged,
  so the shell gating is untouched.
- **`bt-app/src/lib/api.ts`** — `becomeFleetOwner()` = `POST /fleet-owners/me`, `becomeDriver()` =
  `POST /drivers/me` (idempotent identity endpoints, D-32; gateway `location /api/fleet-owners/`,
  `/api/drivers/`).
- **`bt-app/src/components/emergence-cta.tsx`** — computes ONE prompt from the snapshot, dismissible
  (D-21). Primary moment: `operate && !fleet_owner_id` → "Set up fleet management" → `becomeFleetOwner`
  → `refresh` → `/drivers`. Chain: `fleet_owner_id && held_driver_count === 0` → "Invite your first
  driver". It never links to a 403 — it makes the fact true first, then routes.
- **`home/page.tsx`** — renders `<EmergenceCta />` above the feed; renders nothing when no step applies.

## Verification

- `bt-app npm run build` → clean (tsc + next build).
- Live end-to-end against the **deployed** backend with a demo-driver token:
  - `POST /fleet-owners/me` → **201 created** (company placeholder "demo-driver").
  - `/fleet/{owners/me, drivers, vehicles}` → all **200** — the de-role's positive case
    (`role='driver'` + fleet profile → access; was 403 pre-de-role, 404 without a profile).
  - `/auth/me` now carries `fleet_owner_id` → the CTA chain advances to "invite a driver".
  - NOTE: this left demo-driver a fleet owner (`fleet_owners.id = a9a91083…`) — the intended
    emergence outcome and a testable state. Delete that row to reset the demo if needed.
- API-contract + build verification, not browser-automation UI checks (founder's rule).

## Out of scope (follow-ups)

- The D-33 **persona-completeness ring** (`GET /api/me/completeness`, display-only).
- Emergence moments for the shipper→carrier direction (`becomeDriver` is wired but no CTA uses it
  yet — a pure shipper "own a truck? register as a carrier" prompt).
- Driver-side de-role (`requireDriver`) so a shipper-turned-driver can accept fleet invites.
