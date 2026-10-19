# bt-progress — client progress portal

A public, read-only page that shows the client what has been built, what is in review and
what is live. It rebuilds itself on **every push to `main`** from the `progress` job in
`.github/workflows/deploy.yml`, after the deploy lanes have finished. Nobody edits it by hand.

- `build.mjs` — the generator. Reads merged + open PRs from the GitHub API, the last successful
  deploy run, and this run's deploy result; writes `site/progress.json`.
- `site/index.html` — the page. Fetches `progress.json` and renders the timeline.
- `overrides.json` — client wording for PRs that predate the PR template's block, and `hidden`
  flags for internal-only PRs. Keyed by PR number.
- `manual-entries.json` — items that are not PRs: documents delivered, "Up next" work.
- `config.json` — `since` (PRs merged before this date are ignored), the app URL, the repo.
- `Dockerfile` + `nginx.conf` — static nginx on port 8080, `progress.json` served `no-store`.

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
