# Runbook — deploying `bt-fleet-service` + the fleet console

> **Retired 2026-09-26:** the fleet console (`fleet/` → Cloud Run `bt-fleet-console`) was removed from
> the repo; its surface lives in `bt-app`. The `bt-fleet-service` half of this runbook still applies.

Everything in the repo is wired. What remains needs credentials this environment does not have:
there are **no gcloud credentials on this machine** (`gcloud auth list` → "No credentialed
accounts", no ADC file, no service-account key), and `gcloud auth login` is an interactive browser
flow. So the two commands below are yours to run.

Project `project-aa0faf06-c115-438a-a36`, region `asia-south1`.

---

## What is already done

| | |
|---|---|
| Migrations `0014`–`0018` | **applied and verified** on live `rxbdzbcndpzznvqcbimg` |
| Seed fleet | **applied** — Shree Balaji Roadlines, 12 trucks, 620 trips |
| `bt-gateway` `/api/fleet/` route | already in `nginx.conf.template` — **inert until `FLEET_SERVICE_URL` is set** |
| `deploy.yml` | `bt-fleet-service` + `fleet` → `bt-fleet-console` added |
| `deploy-all.sh` | deploys fleet, sets its env, sets `FLEET_SERVICE_URL` on gateway + payment |
| `fix-blank-env.py` | `fleet` target added |
| `ci.yml` | `fleet` app and `packages/shared` added |

## What is NOT done

- No Cloud Run service exists yet for either `bt-fleet-service` or `bt-fleet-console`.
- Their env vars have never been set.

---

## Path A — via CI (preferred, no local gcloud needed)

`deploy.yml` fires on push to `main` and authenticates with Workload Identity Federation, so CI
needs no key from you.

1. Merge the fleet PRs into `main`. CD path-filters and deploys `bt-fleet-service` (and
   `bt-fleet-console`, and — because `packages/shared` changed — `bt-booking-service` and
   `bt-tracking-service`, which is what carries the tenant-isolation fix into the running services).

2. **CD deliberately sets no env vars** (`deploy.yml:11-14`) — a `--source` deploy preserves
   existing env, and a per-commit `--set-env-vars` would wipe anything unlisted. So the first
   revision of `bt-fleet-service` will boot green and 500 on every data route. Fix it once:

```bash
python3 scripts/ops/fix-blank-env.py fleet
```

That copies `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET`
and `REDIS_URL` off the healthy `bt-booking-service` without ever printing them.

3. Point the gateway and the payment service at it, then redeploy the gateway so the template
   re-renders:

```bash
FLEET_URL=$(gcloud run services describe bt-fleet-service --region asia-south1 --project project-aa0faf06-c115-438a-a36 --format='value(status.url)')
gcloud run services update bt-gateway --region asia-south1 --update-env-vars "FLEET_SERVICE_URL=$FLEET_URL"
gcloud run services update bt-payment-service --region asia-south1 --update-env-vars "FLEET_SERVICE_URL=$FLEET_URL"
gcloud run deploy bt-gateway --source bt-gateway --region asia-south1 --project project-aa0faf06-c115-438a-a36 --quiet
```

4. Set the console's build-time config. `NEXT_PUBLIC_*` are inlined into the client bundle at build
   time, so they are `--build-arg`s from GitHub repo config, not runtime env. The repo already has
   `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (Variables) and
   `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (Secret) — the console reuses all three, so nothing new is
   needed. **But the browser key is HTTP-referrer restricted**: add the `bt-fleet-console` Cloud Run
   URL to its allowed referrers in the Google Cloud console, or the map will silently fail to load
   for this app only.

---

## Path B — one-shot from your laptop

```bash
gcloud auth login
GOOGLE_MAPS_SERVER_KEY=... bash scripts/deploy/deploy-all.sh
```

`deploy-all.sh` now deploys `bt-fleet-service`, reads the five shared secrets off the healthy
`bt-booking-service`, sets fleet's env, sets `FLEET_SERVICE_URL` on both the gateway and
`bt-payment-service`, redeploys the gateway, then deploys `bt-fleet-console` with the apps and
health-checks all of them.

---

## Verifying it actually works

```bash
curl -s "$(gcloud run services describe bt-fleet-service --region asia-south1 --format='value(status.url)')/health"
```

`/health` returning `ok` proves very little here — **four of the five env vars are read lazily**
(`SUPABASE_URL`/`KEY` build the client on first query, `REDIS_URL` only on `/fleet/live`,
`JWT_SECRET` only when verifying a token). A misconfigured service boots green and fails every real
request. So verify through the gateway with a real token instead:

```bash
# balaji@bharattruck.in / balaji-2026 is the seeded fleet owner
TOKEN=$(curl -s -X POST "$GATEWAY/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"balaji@bharattruck.in","password":"balaji-2026"}' | jq -r .data.access_token)

curl -s "$GATEWAY/api/fleet/owners/me"        -H "authorization: Bearer $TOKEN" | jq .
curl -s "$GATEWAY/api/fleet/vehicles"         -H "authorization: Bearer $TOKEN" | jq '.data | length'   # expect 12
curl -s "$GATEWAY/api/fleet/analytics/summary" -H "authorization: Bearer $TOKEN" | jq .data.vehicles_covering_emi  # expect 7
```

If `/fleet/vehicles` returns 12 and the summary reports 7 of 12 covering EMI, the service, its env,
the gateway route and the seeded data are all correct end to end.

`GET /fleet/live` is the one endpoint that needs Redis specifically — if everything else works and
that returns empty, `REDIS_URL` is pointing at a different instance from the one
`bt-booking-service` writes `loc:driver:{id}` to.

---

## Traps worth knowing before you run this

- **Do not name the console `bt-fleet-service`.** That is the backend API. The console is
  `bt-fleet-console`.
- **`PORT`**: the service reads `process.env.PORT ?? 3007` and Cloud Run injects `8080`. Never pin
  3007 in the Cloud Run config.
- **`INTERNAL_SERVICE_SECRET` must be byte-identical** to `bt-payment-service`'s, or the
  `trip-economics` roll-up posts and gets a 503 — and that hook is fire-and-forget with no retry, so
  the loss is silent and permanent for that trip.
- **`REDIS_URL` contains a password with `@` in it.** `deploy-all.sh` uses the `^@^` delimiter form
  of `--update-env-vars`, which collides. `fix-blank-env.py` picks a delimiter absent from all
  values specifically to avoid this — prefer it for anything touching Redis.
