#!/usr/bin/env node
// bt-quality/build.mjs — turn the raw results into the test portal's data and its PDF.
//
//   node bt-quality/build.mjs <results-dir>
//
// Reads every quality-*.json in <results-dir> (one per package from run-suite.mjs, plus
// quality-e2e.json from e2e.mjs) and writes into bt-quality/site/:
//
//   report.json   everything the portal page (site/index.html) shows, plus a short history
//   report.html   the same report as one self-contained, print-ready page
//   report.pdf    report.html printed by headless Chrome (skipped, with a note in the log,
//                 when no Chrome/Edge binary is found)
//
// History: the portal is a static site with no storage of its own, so the previous runs are
// read back from the LIVE portal's report.json (QUALITY_URL) and this run is appended —
// the last 30 are kept. A first run, or an unreachable portal, simply starts a new history.
//
// A package listed in config.json that has NO result file is reported as "not run" and
// makes the run fail: a suite that silently did not execute must never read as green.
// No dependencies (Node 20+).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))
const resultsDir = resolve(process.argv[2] ?? 'quality-results')
const site = join(here, 'site')
const HISTORY_MAX = 30

const read = f => JSON.parse(readFileSync(f, 'utf8'))
const files = existsSync(resultsDir)
  ? readdirSync(resultsDir, { recursive: true }).map(String).filter(f => /quality-[\w.-]+\.json$/.test(f)).map(f => join(resultsDir, f))
  : []
const raw = files.map(read)
const byPackage = new Map(raw.filter(r => r.package).map(r => [r.package, r]))
const e2e = raw.find(r => r.suite === 'e2e') ?? null
// The scenario trace (bt-cargo-ledger/test/scenario-flow.e2e.mts, written when
// QUALITY_SCENARIO_OUT is set): one load per scenario, played from posting to payment.
const scenarioRun = raw.find(r => r.suite === 'scenarios') ?? null

// ── packages ──────────────────────────────────────────────────────────────────

const packages = config.packages.map(p => {
  const r = byPackage.get(p.dir)
  if (!r) {
    return { dir: p.dir, name: p.name, about: p.about, status: 'not_run', duration_ms: 0, totals: { checks: 0, pass: 0, fail: 0, warn: 0, test_files: 0, assertions: 0 }, checks: [] }
  }
  return { dir: p.dir, name: p.name, about: p.about, status: r.status, duration_ms: r.duration_ms, totals: r.totals, checks: r.checks }
})

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0)
const e2eTotals = e2e?.totals ?? { checks: 0, pass: 0, fail: 0, skip: 0 }
const totals = {
  packages: packages.length,
  packages_passed: packages.filter(p => p.status === 'pass').length,
  test_files: sum(packages, p => p.totals.test_files),
  assertions: sum(packages, p => p.totals.assertions),
  // A package that did not run counts as one failed check, so the totals always add up.
  checks: sum(packages, p => p.totals.checks) + e2eTotals.checks + packages.filter(p => p.status === 'not_run').length,
  passed: sum(packages, p => p.totals.pass) + e2eTotals.pass,
  failed: sum(packages, p => p.totals.fail) + e2eTotals.fail + packages.filter(p => p.status === 'not_run').length,
  warnings: sum(packages, p => p.totals.warn),
  skipped: e2eTotals.skip,
  e2e_checks: e2eTotals.checks,
  e2e_passed: e2eTotals.pass,
}
const scenarios = scenarioRun
  ? { status: scenarioRun.status, totals: scenarioRun.totals, list: scenarioRun.scenarios }
  : { status: 'not_run', totals: { scenarios: 0, passed: 0, steps: 0, steps_passed: 0 }, list: [] }
// A missing scenario trace is a failure, like a package that did not run.
const status = totals.failed > 0 || !e2e || e2e.status === 'fail' || scenarios.status !== 'pass' ? 'fail' : 'pass'

const sha = process.env.GITHUB_SHA ?? ''
const repo = process.env.GITHUB_REPOSITORY ?? config.repository
const runId = process.env.GITHUB_RUN_ID ?? ''
const run = {
  id: runId,
  number: Number(process.env.GITHUB_RUN_NUMBER ?? 0),
  url: runId ? `https://github.com/${repo}/actions/runs/${runId}` : '',
  commit: sha,
  commit_url: sha ? `https://github.com/${repo}/commit/${sha}` : '',
  trigger: process.env.QUALITY_TRIGGER ?? process.env.GITHUB_EVENT_NAME ?? 'manual',
  finished_at: new Date().toISOString(),
}

// ── history ───────────────────────────────────────────────────────────────────

let history = []
const liveUrl = process.env.QUALITY_URL
if (liveUrl) {
  try {
    const res = await fetch(`${liveUrl.replace(/\/$/, '')}/report.json`, { signal: AbortSignal.timeout(15_000) })
    if (res.ok) history = (await res.json()).history ?? []
  } catch { /* first run or portal unreachable: start a new history */ }
}
history = [
  { finished_at: run.finished_at, status, commit: sha.slice(0, 7), run_url: run.url, trigger: run.trigger, checks: totals.checks, passed: totals.passed, failed: totals.failed, skipped: totals.skipped },
  ...history.filter(h => h.run_url !== run.url || !run.url),
].slice(0, HISTORY_MAX)

const report = {
  generated_at: run.finished_at,
  status,
  run,
  target: e2e?.target ?? { app: config.app_url, api: config.api_url },
  workflow_url: `https://github.com/${repo}/actions/workflows/quality.yml`,
  totals,
  packages,
  e2e: e2e ? { status: e2e.status, totals: e2e.totals, checks: e2e.checks } : { status: 'not_run', totals: e2eTotals, checks: [] },
  scenarios,
  // Base URL of bt-scenario-runner (the "Try your own scenario" form posts there). Empty
  // when the runner was not deployed: the portal then hides the form.
  runner_url: process.env.RUNNER_URL ?? '',
  history,
}
mkdirSync(site, { recursive: true })
writeFileSync(join(site, 'report.json'), JSON.stringify(report, null, 2))

// ── print-ready HTML (self-contained: the PDF is printed from this file) ──────

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const secs = ms => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)
const when = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST'
const LABEL = { pass: 'Passed', fail: 'Failed', warn: 'Warning', skip: 'Skipped', not_run: 'Not run' }
const badge = s => `<span class="b b-${s}">${LABEL[s] ?? s}</span>`
const GROUPS = { api: 'API and access control', web: 'Pages and assets', browser: 'In a real browser', 'signed-in': 'Signed-in journey', integrations: 'Outside services' }

const pkgRows = packages.map(p => `<tr><td><b>${esc(p.name)}</b><br><span class="m">${esc(p.about)}</span></td><td>${badge(p.status)}</td><td class="n">${p.totals.test_files}</td><td class="n">${p.totals.assertions || '—'}</td><td class="n">${secs(p.duration_ms)}</td></tr>`).join('')
const pkgDetail = packages.map(p => `
  <h3>${esc(p.name)} <span class="m">${esc(p.dir)}</span> ${badge(p.status)}</h3>
  ${p.checks.length === 0 ? '<p class="m">This suite did not run.</p>' : `<table><thead><tr><th>Check</th><th>Result</th><th class="n">Assertions</th><th class="n">Time</th></tr></thead><tbody>
  ${p.checks.map(c => `<tr><td>${esc(c.name)}${c.status !== 'pass' && c.output_tail ? `<pre>${esc(c.output_tail.split('\n').slice(-12).join('\n'))}</pre>` : ''}</td><td>${badge(c.status)}</td><td class="n">${c.assertions ?? '—'}</td><td class="n">${secs(c.duration_ms)}</td></tr>`).join('')}
  </tbody></table>`}`).join('')
const e2eDetail = Object.entries(GROUPS).map(([g, title]) => {
  const list = report.e2e.checks.filter(c => c.group === g)
  if (!list.length) return ''
  return `<h3>${title}</h3><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${list.map(c => `<tr><td>${esc(c.name)}</td><td>${badge(c.status)}</td><td class="m">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>`
}).join('')

// Which user's journey a step belongs to (the portal has a page for each).
const sideOf = s => { const v = s.views ?? ['shipper', 'driver']; return v.length > 1 ? 'Both' : v[0] === 'shipper' ? 'Shipper' : 'Driver' }
const stagesOf = sc => [...new Set(sc.steps.map(s => s.stage))]
const scenarioDetail = scenarios.list.length === 0 ? '<p>The scenarios did not run.</p>' : scenarios.list.map(sc => `
  <h3>${esc(sc.name)} ${badge(sc.status)}</h3>
  <p class="m">${esc(sc.summary)} · ended as <b>${esc(sc.final_status)}</b> · ${sc.steps.filter(s => s.ok).length} of ${sc.steps.length} steps as expected</p>
  <table><thead><tr><th style="width:5%">#</th><th style="width:34%">Step</th><th style="width:15%">Who</th><th style="width:9%">Side</th><th>What happened</th><th style="width:9%">Result</th></tr></thead><tbody>
  ${stagesOf(sc).map(stage => `<tr><td colspan="6" class="stage">${esc(stage)}</td></tr>` + sc.steps.map((s, i) => s.stage !== stage ? '' :
    `<tr><td class="n">${i + 1}</td><td>${esc(s.title)}</td><td class="m">${esc(s.actor)}</td><td class="m">${sideOf(s)}</td><td class="m">${esc(s.got)}</td><td>${badge(s.ok ? 'pass' : 'fail')}</td></tr>`).join('')).join('')}
  </tbody></table>`).join('')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BharatTruck test report — ${esc(when(run.finished_at))}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #14181f; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: -0.3pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 4pt; border-bottom: 1.5pt solid #f2a516; }
  h3 { font-size: 10.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  .brand { color: #d98c07; font-weight: 800; }
  .m { color: #5b6676; font-size: 9pt; font-weight: 400; }
  .verdict { margin: 10pt 0; padding: 10pt 12pt; border-radius: 6pt; font-size: 12pt; font-weight: 700; }
  .verdict.pass { background: #ecfdf5; color: #065f46; border: 1pt solid #a7f3d0; }
  .verdict.fail { background: #fef2f2; color: #991b1b; border: 1pt solid #fecaca; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt; margin: 8pt 0; }
  .kpi { border: 1pt solid #e3e7ee; border-radius: 6pt; padding: 8pt 10pt; }
  .kpi b { display: block; font-size: 16pt; }
  table { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; }
  th, td { text-align: left; padding: 4pt 6pt; border-bottom: 0.75pt solid #e3e7ee; vertical-align: top; }
  th { font-size: 8.5pt; color: #5b6676; font-weight: 600; background: #f5f7fa; }
  tr { break-inside: avoid; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .b { display: inline-block; padding: 1pt 6pt; border-radius: 8pt; font-size: 8.5pt; font-weight: 700; white-space: nowrap; }
  .b-pass { background: #ecfdf5; color: #047857; } .b-fail, .b-not_run { background: #fef2f2; color: #b91c1c; }
  .b-warn { background: #fffbeb; color: #b45309; } .b-skip { background: #f1f5f9; color: #475569; }
  td.stage { background: #fff8e8; font-weight: 700; font-size: 9pt; }
  pre { margin: 4pt 0 0; padding: 5pt 6pt; background: #f5f7fa; border-radius: 4pt; font: 7.5pt/1.35 Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  dl { display: grid; grid-template-columns: 34mm 1fr; gap: 2pt 8pt; margin: 6pt 0; }
  dt { color: #5b6676; } dd { margin: 0; word-break: break-all; }
  footer { margin-top: 16pt; padding-top: 6pt; border-top: 0.75pt solid #e3e7ee; }
</style></head><body>
<h1><span>Bharat</span><span class="brand">Truck</span> — test report</h1>
<p class="m">Automated end-to-end and unit test run · ${esc(when(run.finished_at))}</p>
<div class="verdict ${status}">${status === 'pass' ? `All checks passed — ${totals.passed} of ${totals.checks}` : `${totals.failed} of ${totals.checks} checks failed`}${totals.skipped ? ` · ${totals.skipped} skipped` : ''}${totals.warnings ? ` · ${totals.warnings} warning${totals.warnings === 1 ? '' : 's'}` : ''}</div>
<div class="kpis">
  <div class="kpi"><b>${totals.packages_passed} / ${totals.packages}</b>services and apps green</div>
  <div class="kpi"><b>${totals.test_files}</b>test files run</div>
  <div class="kpi"><b>${totals.assertions}</b>individual assertions</div>
  <div class="kpi"><b>${totals.e2e_passed} / ${totals.e2e_checks}</b>live end-to-end checks</div>
</div>
<dl>
  <dt>Tested site</dt><dd>${esc(report.target.app)}</dd>
  <dt>Tested API</dt><dd>${esc(report.target.api)}</dd>
  <dt>Code version</dt><dd>${esc(sha || 'local run')}</dd>
  <dt>Started by</dt><dd>${esc(run.trigger)}</dd>
  ${run.url ? `<dt>Full run log</dt><dd>${esc(run.url)}</dd>` : ''}
</dl>

<h2>1. Services and apps</h2>
<p class="m">Each package is compiled and type-checked, then every test file is run on its own.</p>
<table><thead><tr><th>Package</th><th>Result</th><th class="n">Test files</th><th class="n">Assertions</th><th class="n">Time</th></tr></thead><tbody>${pkgRows}</tbody></table>

<h2>2. End-to-end checks on the live site</h2>
<p class="m">Run against production, read-only: nothing is created, changed or deleted.</p>
${report.e2e.checks.length ? e2eDetail : '<p>The end-to-end checks did not run.</p>'}

<h2>3. Scenarios: one load from posting to payment</h2>
<p class="m">Each scenario plays a full load through the real booking and delivery-code code: posted, bid on, awarded, picked up, delivered with the receiver's code, and paid, with the access rules checked at every stage. It runs on a throwaway in-memory database, never on the live site. Scenarios are listed in bt-quality/scenarios.json. The "Side" column says whose journey each step belongs to; the portal has a separate page for the shipper's side and the driver's side.</p>
${scenarioDetail}

<h2>4. Detail by package</h2>
${pkgDetail}

<footer class="m">Generated automatically by the BharatTruck test pipeline (bt-quality). "Warning" marks an advisory check that does not fail the run. "Skipped" marks a check that was not configured for this run.</footer>
</body></html>`
writeFileSync(join(site, 'report.html'), html)

// ── PDF ───────────────────────────────────────────────────────────────────────

const chrome = [
  process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(p => existsSync(p))
let pdf = false
if (chrome) {
  const target = join(site, 'report.pdf')
  spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${target}`, pathToFileURL(join(site, 'report.html')).href], { stdio: 'ignore', timeout: 120_000 })
  pdf = existsSync(target)
}
console.log(`report: ${status.toUpperCase()} — ${totals.passed}/${totals.checks} checks passed, ${totals.failed} failed, ${totals.skipped} skipped`)
console.log(`  ${join(site, 'report.json')}\n  ${join(site, 'report.html')}\n  ${pdf ? join(site, 'report.pdf') : 'report.pdf NOT generated (no Chrome/Edge binary found, or printing failed)'}`)
if (process.argv.includes('--require-pdf') && !pdf) process.exit(1)
