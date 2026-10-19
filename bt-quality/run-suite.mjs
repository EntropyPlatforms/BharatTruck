#!/usr/bin/env node
// bt-quality/run-suite.mjs — run ONE package's checks and record the result of each as JSON.
//
//   node bt-quality/run-suite.mjs <package-dir> [out.json]
//
// A "check" is a build step (tsc / next build), lint, or one test file. Test files are run
// ONE AT A TIME — unlike `npm test`, which stops at the first failure — so the report shows
// every file's own verdict. Which files, and how they are run, is read from the package's
// own `test` script, so this never drifts from what CI runs:
//
//   "for f in test/*.mts; do tsx "$f" ...     → every test/*.mts, `tsx <file>`
//   "tsx a.mts && tsx b.mts && ..."           → exactly those files, in that order
//   "tsx --test test/*.test.mts"              → every test/*.test.mts, `tsx --test <file>`
//
// Exit code is always 0 once the JSON is written: a failing suite is a RESULT here, not a
// crash. The workflow's final gate decides what a red result means. No dependencies.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const pkgDir = process.argv[2]
if (!pkgDir) { console.error('usage: run-suite.mjs <package-dir> [out.json]'); process.exit(2) }
const out = resolve(process.argv[3] ?? `quality-${pkgDir.replace(/[\\/]/g, '-')}.json`)
const cwd = resolve(pkgDir)
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}
const TAIL_LINES = 40
const TIMEOUT_MS = 10 * 60_000

/** Run a shell command in the package; return verdict, duration and the tail of its output. */
function run(command) {
  const started = Date.now()
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const lines = output.split(/\r?\n/)
  return {
    ok: r.status === 0,
    exit_code: r.status,
    timed_out: r.error?.code === 'ETIMEDOUT',
    duration_ms: Date.now() - started,
    lines,
    // Kept only for failures (see below) — a passing check's log is noise in a report.
    tail: lines.slice(-TAIL_LINES).join('\n').trim(),
  }
}

/**
 * How many individual assertions a test file reported. These suites print one line per
 * passing check ("  ✓ …", "ok 12 - …", "PASS …"); node:test also prints a "# pass N" /
 * "ℹ pass N" summary, which wins when present. null when the file prints nothing countable.
 */
function countAssertions(lines) {
  let summary = null
  let ticks = 0
  for (const l of lines) {
    const m = /^(?:#|ℹ)\s*pass\s+(\d+)/.exec(l.trim())
    if (m) summary = (summary ?? 0) + Number(m[1])
    if (/^\s*(?:✓|✔|√|PASS\b|ok\s+\d+)/.test(l)) ticks++
  }
  const n = summary ?? ticks
  return n > 0 ? n : null
}

/** The test files this package's `test` script runs, and the command for each. */
function testPlan() {
  const script = scripts.test
  if (!script) return []
  const dir = join(cwd, 'test')
  const files = existsSync(dir) ? readdirSync(dir).sort() : []
  if (/tsx\s+--test\s+test\/\*\.test\.mts/.test(script)) {
    return files.filter(f => f.endsWith('.test.mts')).map(f => ({ file: `test/${f}`, command: `npx tsx --test test/${f}` }))
  }
  if (/for\s+f\s+in\s+test\/\*\.mts/.test(script)) {
    return files.filter(f => f.endsWith('.mts')).map(f => ({ file: `test/${f}`, command: `npx tsx test/${f}` }))
  }
  const explicit = [...script.matchAll(/tsx\s+(test\/[\w./-]+\.mts)/g)].map(m => m[1])
  if (explicit.length) return explicit.map(file => ({ file, command: `npx tsx ${file}` }))
  // Unknown shape: run the script as one check rather than guess.
  return [{ file: 'npm test', command: 'npm test' }]
}

const checks = []
const record = (kind, name, command, { blocking = true } = {}) => {
  process.stdout.write(`── ${pkgDir} · ${name}\n`)
  const r = run(command)
  const check = {
    kind, name, command, blocking,
    status: r.ok ? 'pass' : blocking ? 'fail' : 'warn',
    duration_ms: r.duration_ms,
    assertions: kind === 'test' ? countAssertions(r.lines) : null,
    ...(r.ok ? {} : { exit_code: r.exit_code, timed_out: r.timed_out, output_tail: r.tail }),
  }
  checks.push(check)
  process.stdout.write(`   ${check.status.toUpperCase()} in ${(r.duration_ms / 1000).toFixed(1)}s\n`)
  return r.ok
}

const started = new Date().toISOString()
let built = true
if (scripts.build) built = record('build', scripts.build.startsWith('next') ? 'Production build (next build)' : 'Compile and type-check (tsc)', 'npm run build')
// Lint is advisory, exactly as in ci.yml: the report shows it, it does not fail the run.
if (scripts.lint) record('lint', 'Lint (eslint)', 'npm run lint', { blocking: false })
for (const t of testPlan()) record('test', t.file, t.command)

const count = s => checks.filter(c => c.status === s).length
const result = {
  package: pkgDir,
  started_at: started,
  finished_at: new Date().toISOString(),
  duration_ms: checks.reduce((a, c) => a + c.duration_ms, 0),
  status: count('fail') > 0 ? 'fail' : 'pass',
  built,
  totals: {
    checks: checks.length, pass: count('pass'), fail: count('fail'), warn: count('warn'),
    test_files: checks.filter(c => c.kind === 'test').length,
    assertions: checks.reduce((a, c) => a + (c.assertions ?? 0), 0),
  },
  checks,
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`${pkgDir}: ${result.status.toUpperCase()} — ${result.totals.pass}/${result.totals.checks} checks passed → ${out}`)
