# @bharattruck/shared

**The libraries folder.** Cross-cutting code that is reused across services lives HERE and is imported —
never copy-pasted per service. Mandated by the founder (2026-07-04): "components reused again and again,
we use from there." Enforced by `docs/BIBLE.md §4.1` item 11.

## Why

The audit found the same code copy-pasted many times: JWT verify (3×), the Supabase service-role client
(3×), the error envelope (per-service `TrackingError`/`BookingError`/…), and the Fastify bootstrap (7×).
That is a production-grade defect: a fix or security patch has to be made in N places and drifts. This
package is the single source for those.

## Module surface (extraction roadmap)

| Module | Status | Replaces |
|---|---|---|
| `errors` — `AppError`, `ErrorCode`, `errorEnvelope()`, `ok()`, `ApiEnvelope<T>` | ✅ built | per-service error classes + ad-hoc `{success:false,error,code}` |
| `auth` — HS256 JWT verify + `AuthenticatedUser`, the `users.id` vs `drivers.id` helper contract | ⏳ next | `authenticate.ts` copies |
| `db` — Supabase **service-role** client factory (validates `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` at boot) | ⏳ | `lib/supabase.ts` copies |
| `fleet` — fleet-owner **tenant isolation**: `resolveFleetOwnerByUserId`, `isFleetAffiliatedDriver`, `canFleetAccessBooking` | ✅ built | nothing — new with the fleet persona, shared from day one so no service hand-rolls the predicate |
| `notifications` — `EmailSender`/SMTP transport contract, the async event catalogue + categories, `enqueueNotification()` | ✅ built | the inline `sendMail()` copies in `bt-auth-service` (3×) and `bt-cargo-ledger`. **Only `bt-booking-service` consumes it so far** — migrating the other two is a separate CTO-sequenced change per the rules below; they still use the identical `SMTP_*` env contract meanwhile. Deliberately takes **no** nodemailer dependency: the consuming service injects the transport. |
| `redis` — shared ioredis client + key helpers | ⏳ | per-service redis setup |
| `http` — Fastify bootstrap (global error handler mapping `AppError`→envelope, request-id, health, graceful shutdown) | ⏳ | 7× bootstrap copies |
| `config` — Zod-validated env loader (fail-fast on missing secrets; no `JWT_SECRET!` assertions) | ⏳ | scattered `process.env.X!` |

## Migration sequence (deliberately NOT a big-bang)

Extraction is **sequenced to avoid colliding with in-flight slice work** (e.g. backend is currently building
POD inside `bt-cargo-ledger`). Rules:
1. New code imports from here immediately.
2. Existing services are migrated **one module + one service at a time**, each as its own reviewed change,
   CI green, no behaviour change — never a sweeping rename across all 7 at once.
3. The CTO sequences these so they never land on top of an engineer's active branch.

## Tooling note (workspace wiring — pending)

Consuming `@bharattruck/shared` from the services needs **npm workspaces** at the repo root, which changes
`npm ci` to run from root. That also requires reworking `.github/workflows/ci.yml` (currently per-package
`npm ci`). This is a coordinated change the CTO makes when the first service migrates — until then this
package builds standalone (`npm run build`) and is the canonical reference implementation.
