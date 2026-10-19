#!/usr/bin/env bash
# =============================================================================
#  fix-empty-env.sh — repair bt-payment-service / bt-pricing-service prod env
# =============================================================================
# WHAT BROKE
#   `gcloud run services update bt-payment-service --update-env-vars FLEET_SERVICE_URL=...`
#   failed with:
#       The user-provided container failed to start and listen on ... PORT=3004
#   Container log:
#       Error: INTERNAL_SERVICE_SECRET must be set
#         at defaultBookingClient (dist/lib/booking-client.js:46)
#
# WHY (two independent faults that only bite together)
#   1. bt-payment-service and bt-pricing-service each carry FOUR env vars whose VALUE is the
#      empty string — SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET,
#      INTERNAL_SERVICE_SECRET. The names are present, so every "is it set?" check that tests
#      for the NAME passes; only a value check catches it. bt-booking-service, bt-auth-service,
#      bt-cargo-ledger and bt-tracking-service all have real values — it is just these two.
#
#   2. Both services' spec references a MUTABLE TAG (`bt-<svc>:monorepo-fee1677`) rather than a
#      digest, while the running revision is pinned to an OLDER digest:
#           payment  spec -> :monorepo-fee1677 (sha 74dad53, built 19 Jul)
#                    running                    sha 31046be, built  3 Jul
#      Cloud Run re-resolves that tag on EVERY new revision. So any config change at all —
#      including an unrelated env var — silently rolls the image forward from the 3 Jul build
#      to the 19 Jul build. The newer build added a hard `INTERNAL_SERVICE_SECRET must be set`
#      guard, so it refuses to boot against fault #1.
#
#   The two services were therefore serving a stale image, with a newer, un-bootable image
#   already tagged and waiting for any trigger. Fault #1 is the real bug; the env update was
#   only the trigger. A CD deploy would have set it off identically.
#
# SAFETY
#   Additive and idempotent — copies the four values from the healthy bt-booking-service, so no
#   secret is typed here or printed. Cloud Run keeps serving the last good revision if a new one
#   fails, so a bad outcome is a failed rollout, not an outage.
#
# USAGE
#   ./scripts/deploy/fix-empty-env.sh [--dry-run]
# =============================================================================
set -euo pipefail

PROJECT="${PROJECT:-project-aa0faf06-c115-438a-a36}"
REGION="${REGION:-asia-south1}"
SOURCE_SVC=bt-booking-service
TARGETS=(bt-payment-service bt-pricing-service)
VARS=(SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY JWT_SECRET INTERNAL_SERVICE_SECRET)

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

echo "=== source: $SOURCE_SVC   targets: ${TARGETS[*]}"

# 1) Pull the four values from the healthy service. '^@^' delimiter: values contain commas.
PAIRS=$(gcloud run services describe "$SOURCE_SVC" --region="$REGION" --project="$PROJECT" \
          --format=json | python3 -c '
import json,sys
want = "'"${VARS[*]}"'".split()
env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]["env"]
d = {e["name"]: e.get("value","") for e in env}
missing = [k for k in want if not d.get(k)]
if missing:
    sys.exit("FATAL: source service is missing values for %s — cannot repair from it" % missing)
print("^@^" + "@".join(f"{k}={d[k]}" for k in want))
')
echo "resolved ${#VARS[@]} values from $SOURCE_SVC (not printed)"

# 2) Apply. --update-env-vars MERGES; it never drops the vars already set on the target.
for SVC in "${TARGETS[@]}"; do
  echo
  echo "--> $SVC"
  if $DRY_RUN; then
    echo "    [dry-run] would set: ${VARS[*]}"
    continue
  fi
  gcloud run services update "$SVC" \
    --region="$REGION" --project="$PROJECT" \
    --update-env-vars="$PAIRS" \
    --quiet >/dev/null
  echo "    env applied"

  URL=$(gcloud run services describe "$SVC" --region="$REGION" --project="$PROJECT" --format='value(status.url)')
  CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/health" || true)
  READY=$(gcloud run services describe "$SVC" --region="$REGION" --project="$PROJECT" --format='value(status.latestReadyRevisionName)')
  CREATED=$(gcloud run services describe "$SVC" --region="$REGION" --project="$PROJECT" --format='value(status.latestCreatedRevisionName)')
  echo "    /health = $CODE   ready=$READY created=$CREATED"
  [[ "$READY" == "$CREATED" ]] && echo "    OK — new revision is serving" \
                               || echo "    WARN — newest revision did not become ready; still on $READY"
done

# 3) Show that no empty-valued env remains anywhere.
if ! $DRY_RUN; then
  echo
  echo "=== empty-value sweep across all services"
  for S in bt-auth-service bt-booking-service bt-pricing-service bt-payment-service \
           bt-cargo-ledger bt-tracking-service bt-fleet-service; do
    printf '  %-22s ' "$S"
    gcloud run services describe "$S" --region="$REGION" --project="$PROJECT" --format=json 2>/dev/null \
      | python3 -c '
import json,sys
try:
    env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env",[])
except Exception:
    print("(not deployed)"); sys.exit()
empty = [e["name"] for e in env if not e.get("value")]
print("EMPTY: " + ", ".join(empty) if empty else "ok (%d vars)" % len(env))
'
  done
fi

echo
echo "=== done"
