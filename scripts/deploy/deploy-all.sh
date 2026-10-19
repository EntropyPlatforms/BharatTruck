#!/usr/bin/env bash
#
# deploy-all.sh — one-shot stub-pilot deploy of the whole BharatTruck stack to Cloud Run.
#
# Run by the FOUNDER (an authenticated gcloud session). Idempotent: re-running redeploys
# and merges env (never wipes). NO secret or Maps-key VALUES live in this file — shared secrets
# are copied at runtime from the already-healthy bt-booking-service; the Maps browser key + Map ID
# live only in the app Dockerfiles; the Maps SERVER key is passed via the environment (see below).
#
# Usage:
#   ./scripts/deploy/deploy-all.sh                 # deploy everything from the current checkout
#   GOOGLE_MAPS_SERVER_KEY=... ./scripts/deploy/deploy-all.sh   # also wire tracking's server key
#   SKIP_APPS=1 ./scripts/deploy/deploy-all.sh     # backend + gateway only
#   PROJECT=... REGION=... ./scripts/deploy/deploy-all.sh       # override defaults
#
# Order: 6 backend services (--source) -> copy shared env from booking + wire cross-service URLs
#        -> gateway -> apps (driver/shipper/ops) LAST -> health checks.
set -euo pipefail

PROJECT="${PROJECT:-project-aa0faf06-c115-438a-a36}"
REGION="${REGION:-asia-south1}"

# repo root = two levels up from scripts/deploy/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud not found"
command -v python3 >/dev/null || die "python3 not found (used to read booking env)"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || die "no active gcloud account (run: gcloud auth login)"

log "Target project=$PROJECT region=$REGION root=$ROOT"

deploy_source(){ # $1=service  $2=source dir
  log "deploy $1 (--source $2)"
  gcloud run deploy "$1" --source "$2" --region "$REGION" --project "$PROJECT" \
    --platform managed --allow-unauthenticated --port 8080 --quiet
}

svc_url(){ gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" \
             --format='value(status.url)' 2>/dev/null; }

# read one env var VALUE from the healthy booking service (value is never printed)
bookenv(){ gcloud run services describe bt-booking-service --region "$REGION" --project "$PROJECT" \
             --format=json 2>/dev/null | python3 -c \
             "import sys,json;e=json.load(sys.stdin)['spec']['template']['spec']['containers'][0]['env'];print(next((x.get('value','') for x in e if x['name']=='$1'),''))"; }

# set env on a service with '@' as the delimiter so comma-bearing secret values are safe
set_env(){ local svc="$1"; shift; local pairs="$1"
  gcloud run services update "$svc" --region "$REGION" --project "$PROJECT" \
    --update-env-vars "^@^$pairs" --quiet; }

# ── 1. backend services ───────────────────────────────────────────────────────
deploy_source bt-auth-service     bt-auth-service
deploy_source bt-booking-service  bt-booking-service
deploy_source bt-pricing-service  bt-pricing-service
deploy_source bt-payment-service  bt-payment-service
deploy_source bt-cargo-ledger     bt-cargo-ledger
deploy_source bt-tracking-service bt-tracking-service
deploy_source bt-fleet-service    bt-fleet-service

# ── 2. copy shared env from booking + wire cross-service URLs ──────────────────
log "Reading shared env from healthy bt-booking-service (values not printed)"
INTERNAL_SERVICE_SECRET="$(bookenv INTERNAL_SERVICE_SECRET)"
JWT_SECRET="$(bookenv JWT_SECRET)"
REDIS_URL="$(bookenv REDIS_URL)"
SUPABASE_URL="$(bookenv SUPABASE_URL)"
SUPABASE_SERVICE_ROLE_KEY="$(bookenv SUPABASE_SERVICE_ROLE_KEY)"
for v in INTERNAL_SERVICE_SECRET JWT_SECRET REDIS_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  [ -n "${!v}" ] || die "could not read $v from bt-booking-service (is it healthy? is the value in Secret Manager instead of plain env?)"
done

BOOKING_URL="$(svc_url bt-booking-service)"
PRICING_URL="$(svc_url bt-pricing-service)"
PAYMENT_URL="$(svc_url bt-payment-service)"
CARGO_URL="$(svc_url bt-cargo-ledger)"
[ -n "$BOOKING_URL" ] || die "bt-booking-service has no URL yet"

log "Wiring env (merge; idempotent)"
# booking: cross-service URLs (secrets already present on booking)
set_env bt-booking-service "PRICING_SERVICE_URL=$PRICING_URL@PAYMENT_SERVICE_URL=$PAYMENT_URL@CARGO_LEDGER_URL=$CARGO_URL"
# pricing: JWT + (post-quote-lock-merge) SUPABASE pair + INTERNAL_SERVICE_SECRET
set_env bt-pricing-service "JWT_SECRET=$JWT_SECRET@SUPABASE_URL=$SUPABASE_URL@SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY@INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET@DIESEL_PRICE_INR=90"
# payment
set_env bt-payment-service "SUPABASE_URL=$SUPABASE_URL@SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY@JWT_SECRET=$JWT_SECRET@INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET@BOOKING_SERVICE_URL=$BOOKING_URL"
# cargo-ledger
set_env bt-cargo-ledger "SUPABASE_URL=$SUPABASE_URL@SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY@REDIS_URL=$REDIS_URL@INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET@BOOKING_SERVICE_URL=$BOOKING_URL@BLOCKCHAIN_ENABLED=false"
# tracking: DB + redis + jwt + booking url + diesel; server Maps key only if provided
set_env bt-tracking-service "SUPABASE_URL=$SUPABASE_URL@SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY@REDIS_URL=$REDIS_URL@JWT_SECRET=$JWT_SECRET@BOOKING_SERVICE_URL=$BOOKING_URL@DIESEL_PRICE_INR=90"
if [ -n "${GOOGLE_MAPS_SERVER_KEY:-}" ]; then
  set_env bt-tracking-service "GOOGLE_MAPS_SERVER_KEY=$GOOGLE_MAPS_SERVER_KEY"
else
  echo "WARN: GOOGLE_MAPS_SERVER_KEY not provided — tracking route/eta/pumps will fail until it is set (Phase-0 server key). Re-run with GOOGLE_MAPS_SERVER_KEY=... to wire it."
fi

# fleet: same four shared secrets as the others, plus REDIS_URL.
# REDIS_URL must be the SAME instance bt-booking-service writes to — bt-fleet-service only READS
# loc:driver:{id} (booking-service is the sole writer) and owns fleet:{id}:drivers. Point it at a
# different Redis and GET /fleet/live returns an empty map with no error.
set_env bt-fleet-service "SUPABASE_URL=$SUPABASE_URL@SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY@JWT_SECRET=$JWT_SECRET@INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET@REDIS_URL=$REDIS_URL"

# payment calls POST /internal/trip-economics/:bookingId on fleet at completed->paid, so it needs
# the URL. The shared INTERNAL_SERVICE_SECRET above is what authenticates that call.
FLEET_URL="$(svc_url bt-fleet-service)"
[ -n "$FLEET_URL" ] || die "bt-fleet-service has no URL yet"
set_env bt-payment-service "FLEET_SERVICE_URL=$FLEET_URL"

# ── 3. gateway ────────────────────────────────────────────────────────────────
# The gateway template already has the /api/fleet/ location block; it is inert until
# FLEET_SERVICE_URL is set, so this line is what actually turns the fleet API on.
set_env bt-gateway "FLEET_SERVICE_URL=$FLEET_URL"
deploy_source bt-gateway bt-gateway

# ── 4. apps LAST (bake NEXT_PUBLIC_* incl Maps browser key + Map ID from their Dockerfiles) ──
if [ "${SKIP_APPS:-0}" = "1" ]; then
  echo "SKIP_APPS=1 — skipping app deploys"
else
  echo "Assuming driver/shipper Dockerfiles already have the correct Maps browser key + Map ID baked (founder step, DEPLOY-PREP)."
  deploy_source bt-shipper shipper
  deploy_source bt-driver  driver
  deploy_source bt-fleet-console fleet
  deploy_source bt-ops-web bt-ops-web
fi

# ── 5. health ─────────────────────────────────────────────────────────────────
log "Health checks"
for s in bt-auth-service bt-booking-service bt-pricing-service bt-payment-service \
         bt-cargo-ledger bt-tracking-service bt-fleet-service bt-gateway; do
  u="$(svc_url "$s")"; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$u/health" 2>/dev/null || echo 000)"
  printf '  %-22s /health %s  %s\n' "$s" "$code" "$u"
done
if [ "${SKIP_APPS:-0}" != "1" ]; then
  for s in bt-shipper bt-driver bt-fleet-console bt-ops-web; do
    u="$(svc_url "$s")"; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$u/" 2>/dev/null || echo 000)"
    printf '  %-22s /       %s  %s\n' "$s" "$code" "$u"
  done
fi
log "Done. Backend + gateway /health should be 200; apps / should be 200."
