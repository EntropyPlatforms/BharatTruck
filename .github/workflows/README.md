# GitHub Actions — CI & CD

Three workflows drive the monorepo:

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR to `main`, push to `main`/`feat/**` | Path-filtered `npm ci` + build (tsc / `next build`) + tests for each changed package; gateway nginx syntax check. Merge gate. |
| `deploy.yml` | push to `main` (+ manual `workflow_dispatch`) | Path-filtered **Continuous Deploy** to GCP Cloud Run (`asia-south1`). Only changed services/apps rebuild+deploy. |
| `quality.yml` | after each deploy to `main`, daily, and manual | Runs **every** package's tests plus read-only end-to-end checks on the live site, and publishes the result with a PDF report to the test portal (`bt-quality`). A report, not a merge gate. See `bt-quality/README.md`. |

Both are path-filtered (`dorny/paths-filter`) so a change touches only what it affects. A change to a
workflow file itself redeploys/rebuilds everything (safety).

---

## `deploy.yml` — what deploys, and how

- **Backend services** — `bt-gateway`, `bt-auth-service`, `bt-booking-service`, `bt-pricing-service`,
  `bt-payment-service`, `bt-cargo-ledger`, `bt-tracking-service` (dir name == Cloud Run service name).
  Deployed with `gcloud run deploy <svc> --source <dir>` (Cloud Build builds each dir's Dockerfile).
  **Env vars are NOT set by CD** — a source deploy preserves existing Cloud Run env, runtime service
  account, port and scaling. Each revision is SHA-tagged (`--revision-suffix`) and commit-sha-labelled.

- **Apps** — `driver` → **`bt-driver`**, `shipper` → **`bt-shipper`**, `bt-ops-web` → **`bt-ops-web`**.
  Next.js `NEXT_PUBLIC_*` are inlined into the client bundle at **build** time, so the app path builds
  the image in the runner with `docker build --build-arg …`, pushes to Artifact Registry, then
  `gcloud run deploy --image`. Build args come from GitHub repo variables/secrets (below) — **no key
  is committed**. Only `driver`/`shipper` render a map, so only they receive the Maps build args;
  `bt-ops-web` gets `NEXT_PUBLIC_API_URL` only.

### Adding a NEW backend env var (one-time, manual)

CD deliberately never writes env vars. When a service starts requiring a new one:

```bash
gcloud run services update <svc> \
  --region asia-south1 --project project-aa0faf06-c115-438a-a36 \
  --update-env-vars KEY=VALUE      # merges; does NOT wipe other vars
```

---

## GitHub repo config the founder must set

**Settings → Secrets and variables → Actions**

### Variables (public values)
| Name | Example | Used by |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://bt-gateway-itcdoenefa-el.a.run.app` | driver, shipper, bt-ops-web |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | the vector Map ID | driver, shipper |

### Secrets (masked in logs)
| Name | Value | Used by |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | HTTP-referrer-restricted Maps JS **browser** key | driver, shipper |

> The browser key is public once inlined into client JS, but it is a **Secret** so it stays masked in
> CI logs; safety comes from the HTTP-referrer restriction on the Google key (add the Cloud Run app
> domains to that key's allowed referrers). The **server** Maps key (`GOOGLE_MAPS_SERVER_KEY`) is a
> Cloud Run runtime env var on `bt-tracking-service` — it is **not** a GitHub secret and never touches CI.

No `GCP_SA_KEY` / JSON key is used — auth is keyless via Workload Identity Federation.

---

## FOUNDER PREREQUISITE — one-time GCP IAM setup

Auth is keyless (GitHub OIDC → Workload Identity Federation). The provider/pool already exists
(`projects/752385541585/locations/global/workloadIdentityPools/github-pool/providers/github`); the
deployer service account is `bt-cicd-deployer@project-aa0faf06-c115-438a-a36.iam.gserviceaccount.com`.

```bash
export PROJECT=project-aa0faf06-c115-438a-a36
export PROJECT_NUMBER=752385541585
export SA=bt-cicd-deployer@${PROJECT}.iam.gserviceaccount.com
export REPO=Entropy-LLP/bharattruck

# 1) WIF binding — let THIS repo impersonate the deployer SA via OIDC (no key).
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${REPO}"

# 2) Project roles the deploy needs (see table below for what each is for).
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer
do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA}" --role "$ROLE" >/dev/null
done
```

| Role | Why |
|---|---|
| `roles/run.admin` | Create/deploy Cloud Run revisions. |
| `roles/iam.serviceAccountUser` | Act AS the Cloud Run runtime service account. |
| `roles/cloudbuild.builds.editor` | Run the `--source` Cloud Build builds (backend services). |
| `roles/artifactregistry.writer` | Push app images + store Cloud Build output. |

Notes:
- `--source` deploys stage images in the `cloud-run-source-deploy` Artifact Registry repo. It is
  auto-created on the first `--source` deploy (needs create permission once) — the CTO's manual
  `--source` deploys already created it, so `artifactregistry.writer` is sufficient for CI. If it does
  not exist, either pre-create it or grant `roles/artifactregistry.admin` for the first run.
- App images push to the existing `bt` repo: `asia-south1-docker.pkg.dev/${PROJECT}/bt/<svc>`.
