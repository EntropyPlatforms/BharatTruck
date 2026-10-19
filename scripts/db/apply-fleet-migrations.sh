#!/usr/bin/env bash
# Apply the fleet-owner migrations (0014-0018) to the live Supabase project.
#
# WHY THIS SCRIPT EXISTS: the running services authenticate to Supabase with the
# service-role key, which speaks PostgREST — it can read and write ROWS but cannot
# execute DDL. Applying these migrations needs one of the two credentials below,
# neither of which is present in Cloud Run, the repo, or the local CLI config.
#
# Provide EITHER:
#   (a) a Supabase personal access token   -> `supabase login`, then run this script
#   (b) the project's Postgres password    -> export SUPABASE_DB_PASSWORD=... and run
#
# 0014 must land and COMMIT before 0015 runs: `alter type ... add value` cannot be
# used in the same transaction that references the new label. `supabase db push`
# applies files in order in separate transactions, which satisfies this.

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-rxbdzbcndpzznvqcbimg}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Project: $PROJECT_REF"

if ! supabase projects list >/dev/null 2>&1 && [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  cat >&2 <<'EOF'
ERROR: no credential available to run DDL.

  Option (a):  supabase login          # opens a browser, stores an access token
  Option (b):  export SUPABASE_DB_PASSWORD='<project db password>'
               (Supabase dashboard -> Project Settings -> Database -> Password)

Then re-run this script.
EOF
  exit 1
fi

echo "==> Linking..."
if [[ -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
  supabase link --project-ref "$PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
else
  supabase link --project-ref "$PROJECT_REF"
fi

echo "==> Applying migrations (forward-only, additive)..."
supabase db push

echo "==> Verifying against the live schema..."
node "$REPO_ROOT/scripts/db/verify-fleet-schema.mjs"
