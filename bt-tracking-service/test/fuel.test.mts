/**
 * Fuel model tests — the tiered mileage fallback and the arithmetic.
 *
 * The point of these is the FALLBACK LADDER, not the multiplication. A fleet dashboard has
 * to put a fuel number on every truck, including the ones whose paperwork was never filled
 * in, and it has to be honest about which of those numbers is measured and which is a guess.
 * Each test below pins one rung of that ladder plus the label it reports.
 *
 * `resolveMileageFrom` and `computeFuel` are pure — the norms table is passed in — so no
 * database is needed here. (The env vars below only satisfy the Supabase client's
 * module-level guard, which fires on import of the repository chain.)
 *
 * Run: npx tsx test/fuel.test.mts
 */
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.DIESEL_PRICE_INR = '90'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormRow } from '../src/lib/fuel.js'

// Dynamic import, deliberately: static `import` declarations are hoisted and evaluated
// BEFORE the assignments above, and fuel.ts pulls in the Supabase client, which throws at
// module scope when its env vars are missing. Importing after the env is set keeps this a
// dependency-free unit test. (The type-only import above is erased at compile time and so
// costs nothing at runtime.)
const { resolveMileageFrom, computeFuel } = await import('../src/lib/fuel.js')

/**
 * A slice of the real `vehicle_cost_norms` table (migration 0018, from the founder's
 * CV_Parc_Tables.xlsx). Values are the live ones, including the NULL kmpl_bs4 on light
 * categories that the BS4-fallback test depends on.
 */
const NORMS: NormRow[] = [
  { model_category: 'HCV Cargo 42-48T', vehicle_class: 'HCV', kmpl_bs6: '3.36', kmpl_bs4: '2.90', def_pct_bs6: '0.0545', def_pct_bs4: '0.0320' },
  { model_category: 'HCV Cargo 25-31T', vehicle_class: 'HCV', kmpl_bs6: '4.03', kmpl_bs4: '4.13', def_pct_bs6: '0.0464', def_pct_bs4: '0.0315' },
  { model_category: 'MCV Cargo (15-19T)', vehicle_class: 'MCV', kmpl_bs6: '4.98', kmpl_bs4: '5.00', def_pct_bs6: '0.0508', def_pct_bs4: '0.0197' },
  { model_category: 'ICV Cargo (Upto 14T)', vehicle_class: 'LCV', kmpl_bs6: '6.23', kmpl_bs4: null, def_pct_bs6: '0.0324', def_pct_bs4: '0.0000' },
]

test('tier 1 — an exactly-matched model uses its own BS6 figure', () => {
  const r = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS6' })
  assert.equal(r.basis, 'vehicle_norms')
  assert.equal(r.mileage_kmpl, 3.36)
  assert.equal(r.def_pct, 0.0545)
  assert.equal(r.vehicle_class, 'HCV')
})

test('tier 1 — a BS4 truck uses the BS4 column, not BS6', () => {
  const r = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS4' })
  assert.equal(r.mileage_kmpl, 2.9, 'BS4 is thirstier here and must not silently read BS6')
  assert.equal(r.def_pct, 0.032)
})

test('tier 1 — BS6_PH2 reads the BS6 figures', () => {
  // BS6_PH2 is a real value in the live vehicles table with no dedicated norms column.
  const r = resolveMileageFrom(NORMS, { model_category: 'MCV Cargo (15-19T)', emission_norm: 'BS6_PH2' })
  assert.equal(r.basis, 'vehicle_norms')
  assert.equal(r.mileage_kmpl, 4.98)
})

test('tier 1 — a missing emission norm assumes BS6 and says so', () => {
  const r = resolveMileageFrom(NORMS, { model_category: 'MCV Cargo (15-19T)', emission_norm: null })
  assert.equal(r.mileage_kmpl, 4.98)
  assert.match(r.basis_note, /BS6 assumed/)
})

test('tier 1 — a BS4 light truck falls back to BS6 when kmpl_bs4 is NULL', () => {
  // ICV/LCV/SCV were never sold in BS4 in this parc, so those cells are NULL. Returning
  // null mileage here would divide by zero downstream and report a fuel cost of 0.
  const r = resolveMileageFrom(NORMS, { model_category: 'ICV Cargo (Upto 14T)', emission_norm: 'BS4' })
  assert.equal(r.basis, 'vehicle_norms')
  assert.equal(r.mileage_kmpl, 6.23)
})

test('tier 2 — an unknown model falls back to its class average', () => {
  // Category not in the table, but the "HCV" prefix is still readable.
  const r = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 60T Special', emission_norm: 'BS6' })
  assert.equal(r.basis, 'vehicle_class')
  assert.equal(r.vehicle_class, 'HCV')
  // Mean of the two HCV BS6 rows: (3.36 + 4.03) / 2.
  assert.ok(Math.abs(r.mileage_kmpl - 3.695) < 0.001, `expected ~3.695, got ${r.mileage_kmpl}`)
  assert.match(r.basis_note, /class average/)
})

test('tier 3 — a truck with no model category lands on the default, labelled', () => {
  const r = resolveMileageFrom(NORMS, { model_category: null, emission_norm: null })
  assert.equal(r.basis, 'default')
  assert.equal(r.mileage_kmpl, 3.5)
  // The note has to tell the owner how to fix it, not just that it is a guess.
  assert.match(r.basis_note, /no model category/i)
})

test('tier 3 — an empty norms table still produces a number', () => {
  // A reference-data outage must degrade one column of the dashboard, not blank the fleet.
  const r = resolveMileageFrom([], { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS6' })
  assert.equal(r.basis, 'default')
  assert.ok(r.mileage_kmpl > 0)
})

test('computeFuel does the arithmetic, including DEF', () => {
  const lookup = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS6' })
  const f = computeFuel({ distanceKm: 1400, lookup, overridden: [] })

  // 1400 km / 3.36 kmpl = 416.666... L, displayed to 2dp.
  assert.equal(f.litres_required, 416.67)
  // Rs 37,500 exactly — and that is the point of this assertion: the cost is derived from
  // the UNROUNDED litres (416.666... x 90), not from the rounded display value (which would
  // give 37,500.30). Rounding intermediates compounds across a fleet-wide total.
  assert.equal(f.diesel_cost_inr, 37500)
  // DEF at 5.45% of the diesel spend.
  assert.ok(Math.abs(f.def_cost_inr - 37500 * 0.0545) < 0.05, `DEF was ${f.def_cost_inr}`)
  assert.ok(Math.abs(f.estimated_fuel_cost_inr - (f.diesel_cost_inr + f.def_cost_inr)) < 0.02)
})

test('computeFuel honours a diesel-price override', () => {
  const lookup = resolveMileageFrom(NORMS, { model_category: 'MCV Cargo (15-19T)', emission_norm: 'BS6' })
  const base = computeFuel({ distanceKm: 100, lookup, overridden: [] })
  const dearer = computeFuel({ distanceKm: 100, lookup, dieselPriceOverride: 100, overridden: ['diesel_price'] })

  assert.equal(base.diesel_price_inr, 90, 'defaults to DIESEL_PRICE_INR')
  assert.equal(dearer.diesel_price_inr, 100)
  assert.ok(dearer.estimated_fuel_cost_inr > base.estimated_fuel_cost_inr)
  assert.deepEqual(dearer.inputs_overridden, ['diesel_price'])
})

test('computeFuel relabels the basis when mileage is overridden', () => {
  // An owner-supplied mileage is no longer the norms table's claim, and the UI must not
  // keep presenting it as measured reference data.
  const lookup = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS6' })
  const f = computeFuel({ distanceKm: 100, lookup, mileageOverride: 5, overridden: ['mileage_kmpl'] })

  assert.equal(f.mileage_kmpl, 5)
  assert.equal(f.litres_required, 20)
  assert.notEqual(f.basis, 'vehicle_norms')
  assert.match(f.basis_note, /supplied by the caller/)
})

test('computeFuel returns zero rather than Infinity on a zero-distance trip', () => {
  const lookup = resolveMileageFrom(NORMS, { model_category: 'HCV Cargo 42-48T', emission_norm: 'BS6' })
  const f = computeFuel({ distanceKm: 0, lookup, overridden: [] })
  assert.equal(f.litres_required, 0)
  assert.equal(f.estimated_fuel_cost_inr, 0)
})
