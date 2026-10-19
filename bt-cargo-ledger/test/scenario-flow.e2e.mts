/**
 * Scenario flow — every scenario in bt-quality/scenarios.json, played end to end by the
 * scenario engine (../scenario/engine.mts): one load from posting to payment through the
 * REAL bt-booking-service and bt-cargo-ledger code, on an in-memory database. See the
 * engine's header for exactly what is real and what is simulated.
 *
 * It is a test (it fails the suite when a step does not behave as expected) AND the source
 * of the "Scenarios" section on the test portal: with QUALITY_SCENARIO_OUT set it writes
 * the step-by-step trace as JSON (see bt-quality/build.mjs).
 *
 * Run: npx tsx test/scenario-flow.e2e.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runScenario, shutdown, type Scenario, type ScenarioResult } from '../scenario/engine.mjs'

const scenarios: Scenario[] = JSON.parse(readFileSync(new URL('../../bt-quality/scenarios.json', import.meta.url), 'utf8'))

async function main() {
  const results: ScenarioResult[] = []
  for (const sc of scenarios) {
    console.log(`\n══ ${sc.name} ══`)
    results.push(await runScenario(sc, s => console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  [${s.stage}] ${s.title} — ${s.got}`)))
  }
  await shutdown()

  const all = results.flatMap(r => r.steps)
  const failed = all.filter(s => !s.ok)
  const out = process.env.QUALITY_SCENARIO_OUT
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({
      suite: 'scenarios', finished_at: new Date().toISOString(), status: failed.length ? 'fail' : 'pass',
      totals: { scenarios: results.length, passed: results.filter(x => x.status === 'pass').length, steps: all.length, steps_passed: all.length - failed.length },
      scenarios: results,
    }, null, 2))
    console.log(`\ntrace → ${out}`)
  }

  console.log(`\n${failed.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${all.length - failed.length} checks passed, ${failed.length} failed`)
  if (failed.length) failed.forEach(s => console.log(`  ✗ ${s.title} — expected ${s.expected}, got ${s.got}`))
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
