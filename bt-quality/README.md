# bt-quality — the test portal

A public, read-only page that shows the result of the latest automated test run, with a
downloadable PDF report. It is the testing counterpart of `bt-progress` (the client progress
portal) and is built and deployed the same way: a static nginx image on Cloud Run
(`bt-quality`, `asia-south1`), rebuilt by a GitHub Actions workflow.

## What runs, and when

`.github/workflows/quality.yml`:

| Job | Does |
|---|---|
| `suites` | For **every** package in `config.json`: `npm ci`, compile, lint, then each test file on its own (`run-suite.mjs`). |
| `e2e` | Read-only end-to-end checks against the live site (`e2e.mjs`): API access control, pages and assets, and a real headless Chrome session. |
| `publish` | Merges the results (`build.mjs`) into `site/report.json`, `site/report.html` and `site/report.pdf`, builds the image and deploys it. |
| `verdict` | Fails the run if any blocking check failed — after the portal is published, so a red run is visible there. |

It runs after every deploy to `main`, once a day (07:00 IST), and on demand
(Actions → **quality** → *Run workflow*). The portal itself has no run button; it states the schedule.
It is a report, not a merge gate: `ci.yml` remains the gate on pull requests.

## Scenarios: one load from posting to payment

`scenarios.json` lists named scenarios (route, weight, truck type, locked price, consignment value,
receiver, and who bids what). On every run, `bt-cargo-ledger/test/scenario-flow.e2e.mts` plays each one
through the REAL booking and delivery-code code — post, bid, award, pickup document gate, in transit,
delivery code, delivered, paid — and checks the access rules at each stage. The portal and the PDF show
every step with who did it and what happened.

It runs on an in-memory database and an in-memory Redis, with the pricing service and the email stubbed.
Nothing touches the live site. The freight documents are placed directly into that database (issuing
them uses Postgres functions); the gate that reads them is the real code.

**Add a scenario:** add an entry to `scenarios.json`. `vehicle_type` is one of `mini_truck`, `lcv`,
`hcv`, `trailer`; `state_code` is the GST state code of each end (it decides whether an e-way bill is
needed). The lowest bid wins.

### One page per user type

Every step carries `views` (`shipper`, `driver` or both), set by the engine from who acts. The portal has
three pages sharing `portal.css` and `portal.js`: `index.html` (the full report, every step),
`shipper.html` and `driver.html` (the same scenarios and the same form, showing only that side's steps).

## Try your own scenario (the form on the portal)

The portal has a form: pick the cities, weight, truck type, price, value of goods, receiver and up to six
bids, press Run, and that load is played step by step. The form posts to **bt-scenario-runner**, a small
Cloud Run service (`bt-cargo-ledger/scenario/server.mts`, image from `bt-cargo-ledger/scenario/Dockerfile`,
built from the repo root) that wraps the same engine (`scenario/engine.mts`) the saved scenarios use.

It is public, like the portal, because there is nothing behind it to protect: no secret, no live database,
no outbound calls. Inputs are validated and size-limited, runs are rate-limited per address, and the service
is capped at one instance. Nothing typed into the form is stored. `quality.yml` deploys it in the publish
job and passes its URL to `build.mjs` (`runner_url` in `report.json`); if that deploy fails the portal
hides the form and the rest of the report is unaffected.

## The live checks never write

`e2e.mjs` only reads. No registration, no bookings, no edits. The two `POST`s it makes carry an
empty body that the server must reject at validation.

### Optional: the signed-in journey

Add two repository secrets for a dedicated **test** account (one of the `*@bharattruck.test`
accounts — never a real customer's):

- `E2E_EMAIL`
- `E2E_PASSWORD`

With them set, the run also signs in, reads the profile, feed and loads list, and opens the
app signed in. Without them that group is reported as **Skipped**, never as passed.

## Files

| File | Role |
|---|---|
| `run-suite.mjs` | Runs one package's checks; one JSON result. Reads the test plan from the package's own `test` script. |
| `e2e.mjs` | The live checks. Needs Node 22+ and a Chrome/Edge binary for the browser group. |
| `build.mjs` | Results → `report.json` / `report.html` / `report.pdf`, plus a 30-run history read back from the live portal. |
| `config.json` | The packages to report on, with their plain-language names. Keep in step with the workflow's matrix. |
| `site/index.html` | The portal page. Reads `report.json`. |
| `Dockerfile`, `nginx.conf` | The static image. |

A package listed in `config.json` with no result is reported as **Not run** and fails the run —
a suite that silently did not execute must never read as green.

## Run it locally

```bash
node bt-quality/run-suite.mjs bt-tracking-service out/quality-bt-tracking-service.json
node bt-quality/e2e.mjs out/quality-e2e.json          # Node 22+
node bt-quality/build.mjs out                          # writes bt-quality/site/report.*
```

Then serve `bt-quality/site/` with any static server and open it. (Packages you did not run
locally show as "Not run".)
