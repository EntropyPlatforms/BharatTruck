#!/usr/bin/env node
// Verify the fleet-owner schema against the LIVE database.
//
// Reads the real shape from PostgREST's OpenAPI document rather than trusting the
// .sql files — per the founder's standing rule: what is LIVE is the source of truth,
// the migration files are only a record of intent.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/db/verify-fleet-schema.mjs
// The service-role key can be lifted from any deployed service:
//   gcloud run services describe bt-booking-service --region=asia-south1 --format=json

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  process.exit(2)
}

// [table, [required columns]] — the shape migrations 0014-0018 are supposed to produce.
const EXPECTED_TABLES = [
  ['fleet_owners',        ['id', 'user_id', 'company_name', 'monthly_overhead_inr', 'is_active']],
  ['fleet_drivers',       ['id', 'fleet_owner_id', 'driver_id', 'status', 'monthly_salary_inr']],
  ['vehicle_assignments', ['id', 'fleet_owner_id', 'booking_id', 'vehicle_id', 'driver_id', 'released_at']],
  ['vehicle_finance',     ['vehicle_id', 'emi_amount_inr', 'insurance_annual_inr', 'permit_annual_inr']],
  ['vehicle_permits',     ['vehicle_id', 'permit_type', 'allowed_states', 'expiry_date']],
  ['vehicle_lanes',       ['vehicle_id', 'origin_city', 'destination_city', 'is_primary']],
  ['trip_economics',      ['booking_id', 'fleet_owner_id', 'vehicle_id', 'revenue_inr', 'running_cost_inr', 'net_profit_inr']],
  ['vehicle_cost_norms',  ['model_category', 'super_category', 'vehicle_class', 'kmpl_bs6', 'wage_weight']],
  ['vehicle_service_cost_by_age', ['super_category', 'age_years', 'annual_cost_inr']],
  ['fleet_cost_settings', ['diesel_price_inr', 'def_price_inr', 'engine_oil_price_inr', 'gear_oil_price_inr']],
]

// [table, column] pairs added to tables that already existed live.
const EXPECTED_COLUMNS = [
  ['vehicles', 'fleet_owner_id'], ['vehicles', 'model_category'], ['vehicles', 'emission_norm'],
  ['vehicles', 'manufacture_year'], ['vehicles', 'volume_cuft'], ['vehicles', 'current_odometer_km'],
  ['quotes', 'fleet_owner_id'],
  ['bookings', 'fleet_owner_id'], ['bookings', 'vehicle_id'],
  ['payouts', 'fleet_owner_id'], ['payouts', 'payee_type'],
  ['location_history', 'vehicle_id'], ['trips', 'vehicle_id'],
  ['trip_expenses', 'vehicle_id'], ['trip_expenses', 'booking_id'],
  ['trip_expenses', 'litres'], ['trip_expenses', 'odometer_km'],
]

// Columns that MUST have become nullable for fleet ownership to be representable.
const EXPECTED_NULLABLE = [['vehicles', 'driver_id'], ['quotes', 'driver_id']]

const res = await fetch(`${URL_}/rest/v1/`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/openapi+json' },
})
if (!res.ok) {
  console.error(`OpenAPI fetch failed: ${res.status}`)
  process.exit(2)
}
const defs = (await res.json()).definitions ?? {}

const fail = []
const ok = []

for (const [table, cols] of EXPECTED_TABLES) {
  const def = defs[table]
  if (!def) { fail.push(`MISSING TABLE  ${table}`); continue }
  const missing = cols.filter(c => !def.properties?.[c])
  if (missing.length) fail.push(`TABLE ${table}: missing columns ${missing.join(', ')}`)
  else ok.push(`table ${table}`)
}

for (const [table, col] of EXPECTED_COLUMNS) {
  const def = defs[table]
  if (!def) { fail.push(`MISSING TABLE  ${table}`); continue }
  if (!def.properties?.[col]) fail.push(`COLUMN ${table}.${col} missing`)
  else ok.push(`column ${table}.${col}`)
}

for (const [table, col] of EXPECTED_NULLABLE) {
  const def = defs[table]
  if (!def?.properties?.[col]) { fail.push(`COLUMN ${table}.${col} missing`); continue }
  if ((def.required ?? []).includes(col)) fail.push(`COLUMN ${table}.${col} is still NOT NULL — fleet rows cannot be inserted`)
  else ok.push(`nullable ${table}.${col}`)
}

// The user_role enum must carry 'fleet_owner' or every fleet signup 500s.
const roleEnum = defs.users?.properties?.role?.enum ?? []
if (!roleEnum.includes('fleet_owner')) fail.push(`users.role enum lacks 'fleet_owner' (live: ${roleEnum.join('|') || 'unknown'})`)
else ok.push(`enum user_role includes fleet_owner`)

// Reference data actually seeded?
for (const [table, min] of [['vehicle_cost_norms', 9], ['vehicle_service_cost_by_age', 40]]) {
  if (!defs[table]) continue
  const r = await fetch(`${URL_}/rest/v1/${table}?select=*`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  })
  const count = Number((r.headers.get('content-range') ?? '/0').split('/')[1])
  if (count < min) fail.push(`SEED ${table}: ${count} rows, expected >= ${min}`)
  else ok.push(`seed ${table} (${count} rows)`)
}

console.log(`\n${ok.length} checks passed`)
if (fail.length) {
  console.error(`\n${fail.length} FAILED:`)
  for (const f of fail) console.error('  x ' + f)
  process.exit(1)
}
console.log('Live schema matches the fleet-owner migrations.')
