#!/usr/bin/env node
// bt-progress/build.mjs — generates site/progress.json, the data behind the client
// progress portal (bt-progress, a static Cloud Run service).
//
// Runs inside .github/workflows/deploy.yml on EVERY push to main, after the deploy lanes,
// so the portal always reflects what just merged and whether it went live. Sources:
//
//   • merged PRs on main (GitHub API)  → status "live" when their merge commit is an ancestor
//                                         of the last SUCCESSFUL deploy (this run if it passed,
//                                         else the previous green run), otherwise "deploy"
//   • open, non-draft PRs on main      → status "review"
//   • manual-entries.json              → documents delivered, "Up next" items (status "next")
//   • overrides.json                   → client-language wording / `hidden` flags by PR number
//   • history-entries.json             → the frozen log from the previous repository
//                                         (Entropy-LLP/bharattruck, PRs merged 2026-09-19 →
//                                         2026-10-17), all live. The code moved here as one commit
//                                         on 2026-10-19 without its PRs, so this file keeps the
//                                         client's history; its old PR numbers are dropped because
//                                         this repository's numbering restarted at #1.
//
// Client wording comes from a block in the PR description (see .github/pull_request_template.md):
//
//   <!-- client-log
//   title: Drivers can join with just their licence
//   summary: One or two plain sentences on what changed for the client.
//   see: Where they will notice it in the app.
//   areas: Driver, Fleet owner
//   hidden: true            (optional — keep an internal-only PR off the portal)
//   -->
//
// A PR without the block falls back to its title with the conventional-commit prefix removed
// and areas from its labels — readable, but write the block. Only PRs merged on or after
// config.since are included, so the portal starts at the engagement, not at the repo's birth.
//
// No dependencies: Node 20's fetch + git. Offline smoke test:
//   PROGRESS_FIXTURE=test/fixture.json GITHUB_SHA=$(git rev-parse HEAD) DEPLOY_OK=true node build.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))
const repo = process.env.GITHUB_REPOSITORY ?? config.repository
const token = process.env.GITHUB_TOKEN
const headSha = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD'])
const deployOk = process.env.DEPLOY_OK === 'true'
const fixture = process.env.PROGRESS_FIXTURE

export const AREAS = ['Driver', 'Shipper', 'Fleet owner', 'Platform', 'Documents']
const STATUSES = new Set(['live', 'deploy', 'review', 'next'])

function git(args) {
  return execFileSync('git', args, { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** True when `sha` is reachable from `target` (i.e. the deploy at `target` contains it). */
export function isAncestor(sha, target) {
  if (!sha || !target) return false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, target], { cwd: here, stdio: 'ignore' })
    return true
  } catch { return false }
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'bt-progress',
    },
  })
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${await res.text()}`)
  return res.json()
}

async function loadSource() {
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8'))
  if (!token) throw new Error('GITHUB_TOKEN is required (or PROGRESS_FIXTURE for an offline run)')
  const closed = await gh(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`)
  const open = await gh(`/repos/${repo}/pulls?state=open&base=main&per_page=50`)
  let lastSuccessSha = null
  try {
    const runs = await gh(`/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=1`)
    lastSuccessSha = runs.workflow_runs?.[0]?.head_sha ?? null
  } catch (e) {
    console.warn(`could not read the last successful deploy run (${e.message}); merged PRs will read as "deploying" unless this run passed`)
  }
  return {
    merged: closed.filter(p => p.merged_at),
    open: open.filter(p => !p.draft),
    lastSuccessSha,
  }
}

/** The `<!-- client-log … -->` block of a PR body, as {title, summary, see, areas, hidden}. */
export function parseClientLog(body) {
  const m = /<!--\s*client-log\s*\n([\s\S]*?)-->/.exec(body ?? '')
  if (!m) return null
  const out = {}
  for (const raw of m[1].split('\n')) {
    const line = raw.trim()
    const kv = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (!value) continue
    if (key === 'areas') out.areas = normaliseAreas(value.split(','))
    else if (key === 'hidden') out.hidden = /^(true|yes|1)$/i.test(value)
    else if (key === 'title' || key === 'summary' || key === 'see') out[key] = value
  }
  return out
}

export function normaliseAreas(list) {
  const seen = new Set()
  for (const item of list ?? []) {
    const needle = String(item).trim().toLowerCase().replace(/[-_]/g, ' ')
    const hit = AREAS.find(a => a.toLowerCase() === needle)
    if (hit) seen.add(hit)
  }
  return [...seen]
}

/** "feat(auth): create-account flow…" → "Create-account flow…" */
export function humaniseTitle(title) {
  const stripped = String(title ?? '').replace(/^(feat|fix|chore|docs|refactor|perf|test|ci|build|style)(\([^)]*\))?!?:\s*/i, '').trim()
  return stripped ? stripped[0].toUpperCase() + stripped.slice(1) : String(title ?? '')
}

function readJson(name, fallback) {
  const p = join(here, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback
}

export function buildEntries({ merged, open, lastSuccessSha }, { overrides, manual, since, head, ok }) {
  const liveSha = ok ? head : lastSuccessSha
  const entries = []

  for (const pr of merged) {
    const mergedOn = pr.merged_at.slice(0, 10)
    const override = overrides[String(pr.number)] ?? {}
    if (mergedOn < since && !Object.keys(override).length) continue
    const block = parseClientLog(pr.body) ?? {}
    const merged_ = { ...block, ...override }
    if (merged_.hidden) continue
    const areas = merged_.areas?.length ? merged_.areas : normaliseAreas((pr.labels ?? []).map(l => l.name))
    entries.push({
      id: `pr-${pr.number}`,
      pr: pr.number,
      date: merged_.date ?? mergedOn,
      status: isAncestor(pr.merge_commit_sha, liveSha) ? 'live' : 'deploy',
      title: merged_.title ?? humaniseTitle(pr.title),
      summary: merged_.summary ?? '',
      see: merged_.see ?? '',
      areas: areas.length ? areas : ['Platform'],
    })
  }

  for (const pr of open) {
    const block = parseClientLog(pr.body) ?? {}
    const override = overrides[String(pr.number)] ?? {}
    const merged_ = { ...block, ...override }
    if (merged_.hidden) continue
    const areas = merged_.areas?.length ? merged_.areas : normaliseAreas((pr.labels ?? []).map(l => l.name))
    entries.push({
      id: `pr-${pr.number}`,
      pr: pr.number,
      date: (pr.updated_at ?? pr.created_at).slice(0, 10),
      status: 'review',
      title: merged_.title ?? humaniseTitle(pr.title),
      summary: merged_.summary ?? '',
      see: merged_.see ?? '',
      areas: areas.length ? areas : ['Platform'],
    })
  }

  for (const m of manual) {
    if (!STATUSES.has(m.status)) continue
    entries.push({
      id: m.id ?? `manual-${entries.length}`,
      pr: m.pr ?? null,
      date: m.date,
      status: m.status,
      title: m.title,
      summary: m.summary ?? '',
      see: m.see ?? '',
      areas: normaliseAreas(m.areas).length ? normaliseAreas(m.areas) : ['Platform'],
    })
  }

  // Dated newest first; "Up next" last regardless of its placeholder date.
  entries.sort((a, b) => {
    if ((a.status === 'next') !== (b.status === 'next')) return a.status === 'next' ? 1 : -1
    return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.pr ?? 0) - (a.pr ?? 0)
  })
  return { entries, liveSha }
}

async function main() {
  const source = await loadSource()
  const overrides = readJson('overrides.json', {})
  // The previous repository's log rides along as manual entries (status "live").
  const manual = [...readJson('manual-entries.json', []), ...readJson('history-entries.json', [])]
  const { entries, liveSha } = buildEntries(source, { overrides, manual, since: config.since, head: headSha, ok: deployOk })

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    head_sha: headSha,
    live_sha: liveSha,
    deploy_ok: deployOk,
    app_url: config.app_url,
    areas: AREAS,
    entries,
  }
  const dist = join(here, 'site')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'progress.json'), JSON.stringify(out, null, 2) + '\n')
  const counts = entries.reduce((acc, e) => ((acc[e.status] = (acc[e.status] ?? 0) + 1), acc), {})
  console.log(`progress.json: ${entries.length} entries`, counts, `live_sha=${liveSha ?? 'none'} deploy_ok=${deployOk}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1) })
}
