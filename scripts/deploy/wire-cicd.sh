#!/usr/bin/env bash
# =============================================================================
#  wire-cicd.sh — one-time repair of the monorepo → Cloud Run CD path
# =============================================================================
# WHY THIS EXISTS
#   `deploy` has failed on every push to main since the monorepo consolidation, while `ci` passed.
#   That is why Artifact Registry images are stale (newest: 2026-07-09) and why bt-tracking-service,
#   bt-fleet-service and bt-ops-web have no image at all.
#
#   Root cause (from the run-30295800265 log):
#       ERROR: (gcloud.run.deploy) There was a problem refreshing your current auth tokens:
#       'Unable to acquire impersonated credentials' ... iam.serviceAccounts.getAccessToken denied
#
#   WIF authenticates the GitHub run fine, then IMPERSONATING the deployer SA is denied. The
#   `roles/iam.workloadIdentityUser` binding on bt-cicd-deployer lists principalSets for the RETIRED
#   standalone repos (Entropy-LLP/bt-auth-service, .../LogisticOS, deltaos1997/*) — but never
#   Entropy-LLP/bharattruck, the monorepo everything now lives in. So the trust was never migrated
#   when the repos were consolidated on 2026-07-04.
#
#   Secondary gap: the deployer SA holds only run.admin + artifactregistry.writer. A `--source`
#   deploy also needs to act as the runtime SA and to drive Cloud Build.
#
# SAFETY
#   Idempotent — every step is additive and re-runnable. No secret is ever printed: step 3 copies
#   env vars service-to-service inside gcloud, so values never touch a terminal or this file.
#   Nothing here deletes or replaces an existing binding.
#
# USAGE
#   ./scripts/deploy/wire-cicd.sh            # do it
#   ./scripts/deploy/wire-cicd.sh --dry-run  # print what it would do
# =============================================================================
set -euo pipefail

PROJECT=project-aa0faf06-c115-438a-a36
PROJECT_NUMBER=752385541585
REGION=asia-south1
REPO=${REPO:-EntropyPlatforms/BharatTruck}
DEPLOYER="bt-cicd-deployer@${PROJECT}.iam.gserviceaccount.com"
POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool"
PRINCIPAL="principalSet://iam.googleapis.com/${POOL}/attribute.repository/${REPO}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

run() {
  if $DRY_RUN; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

echo "=== project: $PROJECT   repo: $REPO"
echo

# -----------------------------------------------------------------------------
# 1) THE BLOCKER — let the monorepo impersonate the deployer SA.
# -----------------------------------------------------------------------------
echo "[1/5] Trust ${REPO} on ${DEPLOYER} (roles/iam.workloadIdentityUser)"
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="$PRINCIPAL" \
  --condition=None \
  --quiet >/dev/null
echo "  ok"

# -----------------------------------------------------------------------------
# 2) Roles the deployer SA is missing for `gcloud run deploy --source`.
#      iam.serviceAccountUser   — act AS the Cloud Run runtime SA (compute default).
#      cloudbuild.builds.editor — submit the Cloud Build that builds each Dockerfile.
#      storage.admin            — read/write the Cloud Build source-staging bucket. Google documents
#                                 this for source deploys; it can later be narrowed to
#                                 roles/storage.objectAdmin on gs://${PROJECT}_cloudbuild once that
#                                 bucket exists.
#    (run.admin + artifactregistry.writer are already granted.)
# -----------------------------------------------------------------------------
echo "[2/5] Grant missing project roles to the deployer SA"
for ROLE in roles/iam.serviceAccountUser roles/cloudbuild.builds.editor roles/storage.admin; do
  echo "  + $ROLE"
  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOYER}" \
    --role="$ROLE" \
    --condition=None \
    --quiet >/dev/null
done
echo "  ok"

# -----------------------------------------------------------------------------
# 3) Create bt-fleet-service WITH its env before CD ever touches it.
#    CD deploys with `--source` and deliberately sets NO env vars (a source deploy preserves
#    existing env). For a service that does not exist yet that means CD would CREATE it with an
#    empty environment — no SUPABASE_URL, no JWT_SECRET — and it would crash-loop on boot.
#    So seed it here. Values are copied straight from bt-booking-service, which already holds the
#    exact 6 vars bt-fleet-service reads; they are piped between gcloud calls and never printed.
# -----------------------------------------------------------------------------
echo "[3/5] Create bt-fleet-service (env copied from bt-booking-service, never printed)"
if gcloud run services describe bt-fleet-service --region="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  already exists — skipping create"
else
  ENV_CSV=$(gcloud run services describe bt-booking-service \
    --region="$REGION" --project="$PROJECT" \
    --format='json(spec.template.spec.containers[0].env)' \
  | python3 -c '
import json,sys
want = {"NODE_ENV","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","REDIS_URL","JWT_SECRET","INTERNAL_SERVICE_SECRET"}
env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]["env"]
got = {e["name"]: e.get("value","") for e in env if e["name"] in want}
missing = want - got.keys()
if missing:
    sys.exit("FATAL: bt-booking-service is missing %s" % sorted(missing))
# ^ delimiter: values are URLs/secrets that may contain commas
print("^|^" + "|".join(f"{k}={v}" for k,v in got.items()))
')
  # Names only — used for the redacted dry-run line. Never derived from the values.
  ENV_CSV_NAMES="NODE_ENV,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,REDIS_URL,JWT_SECRET,INTERNAL_SERVICE_SECRET"
  ENV_CSV_COUNT=6
  # NOT via run(): that helper echoes its expanded arguments, which would print every secret
  # value to the terminal and into CI logs. Print a redacted line instead, and only ever pass
  # $ENV_CSV to a real gcloud invocation.
  if $DRY_RUN; then
    echo "  [dry-run] gcloud run deploy bt-fleet-service --source bt-fleet-service" \
         "--port=3007 --min-instances=0 --max-instances=3 --set-env-vars=<${ENV_CSV_COUNT} vars: ${ENV_CSV_NAMES}>"
  else
    gcloud run deploy bt-fleet-service \
      --source bt-fleet-service \
      --region="$REGION" --project="$PROJECT" \
      --port=3007 \
      --allow-unauthenticated \
      --min-instances=0 --max-instances=3 \
      --set-env-vars="$ENV_CSV" \
      --quiet
    echo "  created"
  fi
fi

# -----------------------------------------------------------------------------
# 4) Point the gateway at the new service.
#    bt-gateway's nginx template has a `set $fleet_upstream ${FLEET_SERVICE_URL};` line. The
#    entrypoint now defaults that to an unroutable address if unset (so a missing var degrades to a
#    502 on /api/fleet/ instead of refusing to start the whole gateway) — but it still needs the
#    REAL url to actually serve the fleet console.
# -----------------------------------------------------------------------------
echo "[4/5] Set FLEET_SERVICE_URL on bt-gateway"
if $DRY_RUN; then
  echo "  [dry-run] would read bt-fleet-service url and update bt-gateway"
else
  FLEET_URL=$(gcloud run services describe bt-fleet-service \
    --region="$REGION" --project="$PROJECT" --format='value(status.url)')
  [[ -n "$FLEET_URL" ]] || { echo "FATAL: bt-fleet-service has no url"; exit 1; }
  echo "  -> $FLEET_URL"
  # --update-env-vars merges; it does NOT wipe the other *_SERVICE_URL vars.
  gcloud run services update bt-gateway \
    --region="$REGION" --project="$PROJECT" \
    --update-env-vars="FLEET_SERVICE_URL=${FLEET_URL}" \
    --quiet >/dev/null
  echo "  ok (bt-gateway)"

  # bt-payment-service ALSO reads FLEET_SERVICE_URL — src/lib/fleet-emit.ts posts trip economics
  # to the fleet service after a settlement. It "skips silently" when the var is unset, so a fleet
  # owner's P&L would quietly stop updating after every payout with no error anywhere.
  gcloud run services update bt-payment-service \
    --region="$REGION" --project="$PROJECT" \
    --update-env-vars="FLEET_SERVICE_URL=${FLEET_URL}" \
    --quiet >/dev/null
  echo "  ok (bt-payment-service)"
fi

# -----------------------------------------------------------------------------
# 5) Verify the thing that was actually broken.
# -----------------------------------------------------------------------------
echo "[5/5] Verify"
if $DRY_RUN; then
  echo "  [dry-run] skipped"
else
  echo "  WIF principalSets trusted on the deployer SA:"
  gcloud iam service-accounts get-iam-policy "$DEPLOYER" --project="$PROJECT" --format=json \
    | python3 -c '
import json,sys
pol = json.load(sys.stdin)
found = False
for b in pol.get("bindings", []):
    if b["role"] == "roles/iam.workloadIdentityUser":
        for m in b["members"]:
            repo = m.rsplit("attribute.repository/", 1)[-1]
            mark = "  <-- monorepo" if repo == "EntropyPlatforms/BharatTruck" else ""
            if mark: found = True
            print(f"    {repo}{mark}")
print()
print("  RESULT: monorepo trusted -> CD can deploy" if found
      else "  RESULT: monorepo STILL NOT trusted -> CD will keep failing")
'
  echo
  echo "  deployer SA project roles:"
  gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.members:${DEPLOYER}" --format='value(bindings.role)' | sed 's/^/    /'
fi

echo
echo "=== done. Next: merge feat/fleet-console to main — CD takes over from there."
