# feat/bt-app-foundation — the unified app, Phase 1

**Branch:** `feat/bt-app-foundation` · **Deleted on merge** (CLAUDE.md §0.4).

Phase 1 of `docs/UNIFIED_APP_PLAN.md`: the walking skeleton of `bt-app`, the ONE front door.

## What this lays down
- **`bt-app/`** — forked from `fleet/` (the strongest UI, D-36). Next 16 / React 19 / Tailwind 4. Ships **alongside** the three focused apps; touches no backend and not `bt-gateway`.
- **Capability-gated shell** (`src/lib/nav.ts`, `src/lib/auth.tsx`, `src/components/app-shell.tsx`): reads `GET /auth/me` → `personas.capabilities` and reveals nav by capability (never a role string, D-27). A pure fleet owner sees exactly today's fleet console.
- **Home action feed** (`src/app/(app)/home`): `GET /me/feed`, each row tagged with its persona (D-38).
- **Placeholders** (`/loads`, `/post`, `/my-trips` + `components/coming-soon.tsx`): the ship/drive surfaces are grafted in Phases 2–3; until then the nav item shows (the capability is real) but points at the focused app — never half-built.
- **CI/CD**: `bt-app` added to the `ci.yml` and `deploy.yml` path filters and the deploy app-partition jq (dir `bt-app` → Cloud Run service `bt-app`, maps=true, google=false). Service auto-created on first deploy.

## Deferred to later phases
- Phase 2: graft the real ship surfaces (My Loads, Post a Load, shipment map, receiver POD).
- Phase 3: graft the real drive surfaces (My Trips, Navigate, POD capture).
- Google Sign-In (google=false today; password login only, D-34).
- Retire the three focused apps (post-pilot).
