/**
 * seed-ops-user.mjs — one-time dev seed for an OPS/ADMIN user.
 *
 * WHY THIS EXISTS (flagged in T-BE-6): self-serve registration only allows
 * roles shipper/driver/fleet_owner, so no ops/admin user can be created through
 * the app. The ops console (T-FE-3) + the ops override endpoints
 * (/bookings/:id/force-complete, /reassign) require an `admin`-role JWT, so a
 * dev ops user must be seeded out-of-band. This script does that idempotently.
 *
 * PREREQUISITE / FLAG: `admin` must be a valid value of the Postgres
 * `user_role` enum. If it is not yet (see AGENT_HANDOFF gotcha — enum may lag
 * the code that writes roles), add it first, e.g.:
 *   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
 *
 * RUN (from a package that has @supabase/supabase-js + bcrypt installed, e.g.
 * bt-auth-service after `npm install`):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node ../scripts/seed-ops-user.mjs
 * Optional overrides: OPS_SEED_EMAIL, OPS_SEED_PASSWORD.
 *
 * DEV DEFAULT CREDENTIALS: ops@bharattruck.dev / ops-dev-pass-2026
 * (dev/demo only — never use in production).
 */
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcrypt'

const EMAIL = process.env.OPS_SEED_EMAIL ?? 'ops@bharattruck.dev'
const PASSWORD = process.env.OPS_SEED_PASSWORD ?? 'ops-dev-pass-2026'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

const password_hash = await bcrypt.hash(PASSWORD, 12) // cost 12 — matches bt-auth-service

const { data, error } = await supabase
  .from('users')
  .upsert(
    { email: EMAIL, password_hash, full_name: 'Ops Admin (dev)', role: 'admin', email_verified: true },
    { onConflict: 'email' },
  )
  .select('id, email, role')
  .single()

if (error) {
  console.error('Seed failed:', error.message)
  console.error("If this mentions the enum, add 'admin' to user_role first (see header).")
  process.exit(1)
}

console.log('Seeded ops user:', data)
console.log(`Login for the ops console:  ${EMAIL}  /  ${PASSWORD}`)
