# Task: `feat/derole-fleet-service`

**Relates to:** `docs/ARCHITECTURE_UNIFIED_IDENTITY.md` **D-27** (authorize on relation/capability,
not the JWT `role`) and **§10.3 item 1** (de-role-ify authorization — "the hard blocker"). The
earlier de-role (booking/tracking/payment/auth) **skipped bt-fleet-service**; this closes that gap.

## Why

`bt-fleet-service` gated every owner-scoped route on `user.role === 'fleet_owner'`
(`requireFleetOwner`, `fleet-repo.ts`) plus the register route (`owners.ts`). So an **owner-driver**
(JWT `role: 'driver'`, `operate` capability, owns trucks, no `fleet_owner` row) is **403'd out of
every fleet surface** — verified live for demo-driver on `/fleet/{vehicles,drivers,auctions,owners/me}`.
Two consequences: (1) a **live "tour of 403s"** — the unified shell shows "My Fleet" (operate=true) but
the page 403s; (2) the **blocker under the emergence CTAs** — "become a fleet owner" can't unlock
anything while the JWT role stays `driver`.

## What changed

- **`requireFleetOwner`** (`bt-fleet-service/src/lib/fleet-repo.ts`) — dropped the `role` check.
  Authorization is now the **resolved fleet-owner profile** (`getFleetOwnerByUserId`, which was already
  the tenancy gate). A caller with a `fleet_owners` row is a fleet owner for the request, whatever the
  stale JWT role says.
- **`POST /fleet/owners`** (`owners.ts`) — dropped the `role` gate. Any authenticated user may create
  **their own** fleet profile (D-32); `user_id` comes from the token, never the body, so no account can
  mint another's, and the existing-profile **409** stays the only guard.

## Tenancy — the top risk, and why it's unchanged

Every owner-scoped query still scopes by the `fleet_owner_id` resolved from the caller's **own**
`user_id`. A caller with no fleet profile still gets a **404**; no caller can reach another fleet's
estate. The change **removed a redundant, stricter gate** on top of the real (tenancy) gate — it did
not touch the scoping. A user with `role != 'fleet_owner'` gains access **only** if they hold their own
fleet profile, so nothing is retroactively exposed (no such user has a profile today).

## Out of scope (follow-up)

- The **driver-side** gates (`requireDriver`, and the invite-target `role === 'driver'` check in
  `findDriverByPhone`) — a separate, driver-side de-role (a shipper who became a driver accepting an
  invite). Not part of the fleet-owner blocker.

## Verification

- `bt-fleet-service`: `npm run build` (tsc) → clean; `npm test` → all green, **including the
  cross-tenant asset-ownership seam `assignment-seam.test.mts` (15/15)** — isolation preserved.
- **Live, post-deploy:** create demo-driver's fleet profile via the idempotent
  `POST /identity/fleet-owners/me`, then confirm `GET /fleet/owners/me` returns **200** for
  demo-driver (JWT `role: 'driver'`) where it 403'd before — the de-role working end to end.
