# bt-progress — client progress portal

A public page that shows the client what has been built, what is in review and what is live,
plus a code-protected Requests page where the client raises changes and features (see below). It rebuilds itself on **every push to `main`** from the `progress` job in
`.github/workflows/deploy.yml`, after the deploy lanes have finished. Nobody edits it by hand.

- `build.mjs` — the generator. Reads merged + open PRs from the GitHub API, the last successful
  deploy run, and this run's deploy result; writes `site/progress.json`.
- `site/index.html` — the page. Fetches `progress.json` and renders the timeline.
- `overrides.json` — client wording for PRs that predate the PR template's block, and `hidden`
  flags for internal-only PRs. Keyed by PR number.
- `manual-entries.json` — items that are not PRs: documents delivered, "Up next" work.
- `config.json` — `since` (PRs merged before this date are ignored), the app URL, the repo.
- `server.mjs` — serves `site/` on port 8080 (`progress.json` `no-store`, unknown paths fall back
  to the log) and the requests API. Node built-ins only; the `Dockerfile` runs it on node:20-alpine.
- `site/requests.html` + `lib/tickets.mjs` — the Requests page and its store.
- `site/portal.css` — styles shared by both pages.

## Requests (client tickets)

`/requests.html` lets the client raise a request — a new feature, a change, an add-on, something
broken, or a question — and the team reply, set a status (New → Reviewing → Planned → In progress →
Done / Not planned) and link the PR that delivers it. Both sides see the whole thread.

- **Access:** two codes. `PORTAL_CLIENT_CODE` raises, reads and replies; `PORTAL_TEAM_CODE` also
  changes status and PR links. Wrong codes are rate-limited per caller. The Build Log stays open.
- **Storage:** one JSON object per request in a Cloud Storage bucket (`TICKETS_BUCKET`), written
  with the Cloud Run service's own identity — no database table, no key in the image. Updates are
  guarded by the object generation, so simultaneous replies never overwrite each other.
- **Not set up** (no bucket or no codes): the page says so; the Build Log is unaffected.
- **Local:** `PORTAL_CLIENT_CODE=a PORTAL_TEAM_CODE=b node server.mjs` keeps requests in memory.
- **Tests:** `npm test` — API, access codes, validation, concurrent edits, the GCS store.

One-time setup, in Cloud Shell (env and secrets set this way are kept by every later deploy):

```
PROJECT=project-aa0faf06-c115-438a-a36; REGION=asia-south1; BUCKET=bt-client-requests-aa0faf06
SA=752385541585-compute@developer.gserviceaccount.com   # bt-progress runs as the default compute SA
gcloud storage buckets create gs://$BUCKET --project $PROJECT --location $REGION --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member serviceAccount:$SA --role roles/storage.objectAdmin
openssl rand -base64 12 | tr -d '\n' | gcloud secrets create portal-client-code --data-file=- --project $PROJECT
openssl rand -base64 12 | tr -d '\n' | gcloud secrets create portal-team-code --data-file=- --project $PROJECT
for s in portal-client-code portal-team-code; do gcloud secrets add-iam-policy-binding $s --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $PROJECT; done
gcloud run services update bt-progress --region $REGION --project $PROJECT --update-env-vars TICKETS_BUCKET=$BUCKET --update-secrets PORTAL_CLIENT_CODE=portal-client-code:latest,PORTAL_TEAM_CODE=portal-team-code:latest
```

Read a code: `gcloud secrets versions access latest --secret portal-client-code --project $PROJECT`.

## Where client wording comes from

Every PR description carries a `client-log` block (`.github/pull_request_template.md`):

```
<!-- client-log
title: Drivers can join with just their licence
summary: One or two plain sentences on what changed for the client.
see: Where they will notice it in the app.
areas: Driver, Fleet owner
-->
```

`areas` is any of Driver, Shipper, Fleet owner, Platform, Documents. `hidden: true` keeps a PR
off the portal. A PR without the block shows its title (conventional-commit prefix removed) and
areas from its labels.

## Statuses

| status   | meaning                                                                       |
|----------|-------------------------------------------------------------------------------|
| `live`   | merge commit is an ancestor of the last *successful* deploy (this run if green) |
| `deploy` | merged, but the deploy that carries it has not succeeded yet                  |
| `review` | open, non-draft PR against `main`                                             |
| `next`   | from `manual-entries.json`                                                    |

## Offline check

```
PROGRESS_FIXTURE=test/fixture.json GITHUB_SHA=$(git rev-parse HEAD) DEPLOY_OK=true node build.mjs
```

## Adding or changing an entry after the fact

Edit `overrides.json` (PR work) or `manual-entries.json` (documents, up-next), merge; the next
deploy run republishes the portal.
