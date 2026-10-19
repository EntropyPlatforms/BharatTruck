/**
 * The pure consignee rules (D-22).
 *
 * Two of these look like input hygiene and are not:
 *
 *   - PHONE NORMALISATION is the dedup mechanism. `users_phone_number_key` is
 *     what stops one human becoming two parties, and a unique index can only
 *     dedup values SPELLED the same way. If '+91 98765 43210' and '9876543210'
 *     go in verbatim, the receiver gets two records, two shipment histories and
 *     two claims — and the second one is the one their OTP will not match.
 *   - The GSTIN pattern is enforced twice, once in TypeScript and once as a
 *     CHECK in migration 0026. Two spellings of one rule drift, and the
 *     direction they drift in is a 500 from the database on a request the
 *     service already said was valid. The last section pins them CHARACTER FOR
 *     CHARACTER against the migration file rather than trusting a comment.
 *
 * Pure functions, no Postgres.
 *
 * Run: npx tsx test/consignee-rules.unit.mts
 */
import { readFileSync } from 'node:fs'
import * as rules from '../src/lib/consignee/rules.js'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n── one human, one party: every spelling of a mobile number collapses to one')
{
  const canonical = '9876543210'
  for (const spelling of [
    '9876543210',
    '+919876543210',
    '+91 98765 43210',
    '91 9876543210',
    '09876543210',
    '0 98765-43210',
    '  98765 43210  ',
    '(98765) 43210',
    '98765.43210',
  ]) {
    check(`${JSON.stringify(spelling)} -> ${canonical}`, rules.normalizeIndianMobile(spelling) === canonical)
  }
}

console.log('\n── and everything that is not an Indian mobile is REFUSED, not stored best-effort')
{
  // A wrong number here is a POD code sent to a stranger, so there is no
  // "close enough" outcome — either it is the number or it is null.
  for (const bad of [
    '',
    '   ',
    '912345678',        // 9 digits
    '98765432101',      // 11 digits, no trunk prefix
    '5876543210',       // Indian mobiles start 6-9
    '0224567890',       // landline
    '+1 415 555 0100',  // not India
    'nine8765 43210',
    '98765abcde',
    '+91',
  ]) {
    check(`refuses ${JSON.stringify(bad)}`, rules.normalizeIndianMobile(bad) === null)
  }

  // The trunk/country prefixes are only stripped at the lengths where they
  // cannot be part of a real subscriber number.
  check("does not strip a leading '91' from a 10-digit number", rules.normalizeIndianMobile('9112345678') === '9112345678')
  check('the canonical pattern is the one bt-auth-service writes',
    rules.INDIA_MOBILE_PATTERN.source === '^[6-9]\\d{9}$')
}

console.log('\n── GSTIN: 15 characters, fixed shape')
{
  check('accepts a regular registration', rules.isGstin('27AAAAA0000A1Z5'))
  check('accepts the specimen GSTIN in the compliance doc', rules.isGstin('29AABCV3609C1ZJ'))
  // The 14th character is not pinned to 'Z': it varies for OIDAR and UN-body
  // registrations, and rejecting a real registration is the worse error.
  check('accepts a non-Z registration character', rules.isGstin('07AAAAA0000A1C5'))

  check('REJECTS 14 characters', !rules.isGstin('27AAAAA0000A1Z'))
  check('REJECTS 16 characters', !rules.isGstin('27AAAAA0000A1Z55'))
  check('REJECTS lowercase — a GSTIN is canonically uppercase', !rules.isGstin('27aaaaa0000a1z5'))
  check('REJECTS a non-numeric state code', !rules.isGstin('AAAAAAA0000A1Z5'))
  check('REJECTS a PAN in the wrong shape', !rules.isGstin('2712345AAAAA1Z5'))
  check('REJECTS the literal URP — absence is spelled NULL, not URP', !rules.isGstin('URP'))
  check('REJECTS the empty string', !rules.isGstin(''))
}

console.log('\n── the migration and the service agree, character for character')
{
  const migration = readFileSync(
    new URL('../../supabase/migrations/0026_consignee_party.sql', import.meta.url).pathname, 'utf8')

  // The regex the CHECK constraint applies, lifted out of the SQL rather than
  // retyped here — retyping it is the drift this test exists to catch.
  const checkPattern = migration.match(/gstin ~ '(\^.+\$)'/)?.[1]
  check('migration 0026 constrains users.gstin with a regex', !!checkPattern)
  check('and it is IDENTICAL to GSTIN_PATTERN in consignee/rules.ts',
    checkPattern === rules.GSTIN_PATTERN.source)

  // The two columns the model turns on, and the one that must NOT be dropped yet.
  check('0026 adds users.claimed_at', /add column if not exists claimed_at/.test(migration))
  check('0026 adds bookings.consignee_user_id referencing users(id)',
    /add column if not exists consignee_user_id uuid references public\.users\(id\)/.test(migration))
  check('and indexes it', /create index if not exists bookings_consignee_user_idx/.test(migration))
  check('🔴 0026 does NOT drop receiver_email — bt-cargo-ledger still reads it',
    !/drop column[\s\S]*receiver_email/i.test(migration))
  check('🔴 and it backfills claimed_at from created_at, or the live user base reads as unclaimed',
    /set claimed_at = created_at/.test(migration))
}

console.log('\n── the disclosure projection cannot widen by accident')
{
  // ConsigneeParty is a type, so it is gone at runtime; the guarantee that
  // matters is that the SELECT filling it names its columns explicitly. A
  // `select('*')` there would leak email and GSTIN the day someone widened the
  // type, which is exactly the change this pins against.
  const repositorySrc = readFileSync(
    new URL('../src/lib/consignee/repository.ts', import.meta.url).pathname, 'utf8')

  check('the projection query selects named columns, never *',
    /\.select\('id, full_name, phone_number, city'\)/.test(repositorySrc))
  check('🔴 nothing in the consignee repository selects * from users',
    !/from\('users'\)[\s\S]{0,120}\.select\('\*'\)/.test(repositorySrc))

  // 🔴 The security rule, pinned structurally. `ignoreDuplicates` is ON CONFLICT
  // DO NOTHING; the moment that becomes DO UPDATE (ignoreDuplicates: false, or
  // an .update() on a matched row), posting a booking becomes an
  // unauthenticated write to any profile on the platform.
  check('the party upsert is ON CONFLICT DO NOTHING',
    /ignoreDuplicates: true/.test(repositorySrc))
  check('🔴 the consignee repository never updates a users row',
    !/from\('users'\)[\s\S]{0,200}\.update\(/.test(repositorySrc))
  check('🔴 an unclaimed record is created with claimed_at explicitly null',
    /claimed_at:\s*null/.test(repositorySrc))
  // Read off the upsert PAYLOAD rather than the whole file, which names both
  // columns in prose to explain why it must never write them.
  const upsertPayload = repositorySrc.match(/\.upsert\(([\s\S]*?)\{ onConflict/)?.[1] ?? ''
  check('🔴 and no credential is ever written onto one',
    upsertPayload.length > 0 && !/password_hash|google_sub/.test(upsertPayload))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
