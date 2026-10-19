// ============================================================
// src/lib/consignee/repository.ts
//
// Responsibility: the ONLY path between this service and a consignee party row.
//
// 🔴 THE SHARPEST EDGE IN THIS SLICE, STATED ONCE AT THE TOP:
//
//   A consignee is a `public.users` row, and the phone that identifies it is
//   supplied by WHOEVER IS POSTING THE LOAD — not by the person it describes.
//   So a caller can always name a phone number that already belongs to a real,
//   claimed account. When that happens we LINK to that row and WRITE NOTHING TO
//   IT. Not the name, not the email, not the GSTIN, not the address.
//
//   Take that away — resolve the party with an ON CONFLICT DO UPDATE, say — and
//   posting a booking becomes an unauthenticated write to any account on the
//   platform: type a stranger's mobile number, supply a name and a GSTIN, and
//   their profile is yours to rewrite. There is no permission check that could
//   rescue that shape, because the caller IS authorised to post a booking. The
//   only defence is that the linking path never updates, which is why
//   resolveConsigneeParty() returns early on a hit and why the insert below is
//   DO NOTHING rather than DO UPDATE.
//
// MISSING-SCHEMA TOLERANCE, same contract as documents/repository.ts and
// fleet.ts: migrations are applied BY HAND while CD deploys this service on
// merge (CLAUDE.md), so this code runs against a pre-0026 database for some
// window. A WRITE fails loudly with a 503 naming the migration — silently
// dropping the party the goods are for, on the one column that makes a trip
// closeable, is far worse than an error an operator can read. READS never touch
// a 0026-only column: the projection selects columns `users` has always had, and
// it is only ever reached via `bookings.consignee_user_id`, which is simply
// absent on a pre-0026 row.
//
// IDENTITY: a consignee id is a `users.id` — the same id space as the JWT's
// `userId` and as `bookings.shipper_id`. NOT drivers.id, NOT fleet_owners.id
// (see the identity contract in CLAUDE.md).
// ============================================================

import { supabase } from '../supabase.js'
import { BookingError } from '../types.js'
import type { ConsigneeInput } from '../types.js'
import type { ConsigneeParty } from './rules.js'

// PostgREST reports an unknown TABLE as 42P01 / PGRST205 and an unknown COLUMN
// as 42703 / PGRST204. For this slice all four mean the same thing: migration
// 0026 has not been applied to this database yet.
const MISSING_SCHEMA_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])

type DbError = { code?: string; message?: string } | null

export function isConsigneeSchemaMissing(error: DbError): boolean {
  return !!error?.code && MISSING_SCHEMA_CODES.has(error.code)
}

// UPSTREAM_ERROR/503 rather than 500, exactly as documents/repository.ts does
// it: the request was well formed, the platform is not ready to answer it yet,
// and the identical retry succeeds once the migration lands.
export function consigneeSchemaNotMigrated(what: string): BookingError {
  return new BookingError(
    `${what} is unavailable: the consignee-party schema (migration 0026) is not applied to this database`,
    'UPSTREAM_ERROR',
    503,
  )
}

// -----------------------------------------------------------
// findUserIdByPhone — the link half of the match, and a read-only one.
//
// `users_phone_number_key` guarantees at most one row, so this is a point
// lookup on an index rather than a scan.
// -----------------------------------------------------------

async function findUserIdByPhone(phone: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('phone_number', phone)
    .maybeSingle()

  if (error) throw new Error(`Consignee phone lookup failed: ${error.message}`)
  return (data as { id: string } | null)?.id ?? null
}

// -----------------------------------------------------------
// resolveConsigneeParty — phone in, users.id out.
//
// Two outcomes, and which one happens is decided entirely by the unique index:
//
//   LINK   the phone already belongs to a users row. That row IS the consignee.
//          Every other field the caller sent is DISCARDED for the purposes of
//          that row (see the block comment at the top of this file). The load
//          then appears under that party's inbound list, and if they have not
//          claimed yet, their whole history is waiting when they do.
//
//   CREATE the phone is new. Insert a party record with NO credential:
//          `claimed_at: null` explicitly (migration 0026 defaults the column to
//          now() so that every ORDINARY signup path stays correct without
//          knowing the column exists — this is the one writer that must opt
//          out), and no password_hash and no google_sub, ever. §9.2's anti-goal:
//          an unclaimed consignee is not an account with a weak password, it has
//          no credential at all. It cannot be logged into, only claimed.
//
// CONCURRENCY: two shippers posting loads for the same new consignee in the same
// instant must produce ONE party, not a duplicate and not a 500. The insert is
// `ON CONFLICT DO NOTHING` against `users_phone_number_key` (supabase-js's
// `ignoreDuplicates`), so the loser of the race gets an empty result rather than
// an error, and re-reads the winner's row. Serialisation happens in the index;
// no application-level lock is involved and none would help.
// -----------------------------------------------------------

export async function resolveConsigneeParty(input: ConsigneeInput): Promise<string> {
  const existingId = await findUserIdByPhone(input.phone)
  if (existingId) return existingId

  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        // Shipper-KIND, because there is only one kind of party: the human who
        // receives today ships tomorrow, and when they claim this record they
        // can post their own load without changing anything about it.
        role:         'shipper',
        full_name:    input.name,
        phone_number: input.phone,
        email:        input.email   ?? null,
        gstin:        input.gstin   ?? null,
        address:      input.address ?? null,
        city:         input.city    ?? null,
        state:        input.state   ?? null,
        pincode:      input.pincode ?? null,
        // 🔴 The whole model in one field. Do not remove it and do not let it
        // fall through to the column default.
        claimed_at:   null,
      },
      { onConflict: 'phone_number', ignoreDuplicates: true },
    )
    .select('id')

  if (error) {
    if (isConsigneeSchemaMissing(error)) throw consigneeSchemaNotMigrated('Naming a consignee')
    // 23505 cannot come from the phone index (DO NOTHING absorbs that), so it is
    // a conflict on some OTHER unique column — an email that already belongs to
    // a different party today, or a constraint added later. Re-read by phone
    // first, because the harmless interpretation is that we simply lost a race;
    // only if that finds nothing is this a genuine clash worth telling the
    // caller about, and it is theirs to fix, not a server fault.
    if (error.code === '23505') {
      const raced = await findUserIdByPhone(input.phone)
      if (raced) return raced
      throw new BookingError(
        'Another party already holds one of the consignee contact details supplied',
        'CONFLICT',
        409,
      )
    }
    throw new BookingError(`Consignee party could not be recorded: ${error.message}`, 'INTERNAL', 500)
  }

  const insertedId = (data as Array<{ id: string }> | null)?.[0]?.id
  if (insertedId) return insertedId

  // Empty result = DO NOTHING fired, i.e. a concurrent create won. Its row is
  // committed and visible by the time our statement returned.
  const winnerId = await findUserIdByPhone(input.phone)
  if (winnerId) return winnerId

  throw new BookingError('Consignee party could not be recorded', 'INTERNAL', 500)
}

// -----------------------------------------------------------
// getConsigneeParties — the read projection, for a whole page of bookings.
//
// One `in` query for the page rather than a lookup per row: a shipper's booking
// list is dozens of rows and most of them name the same handful of regular
// customers. Selects only the three columns ConsigneeParty declares, so widening
// the disclosure is impossible without editing the type AND this select — a
// `select('*')` here would leak email and GSTIN the moment someone added them to
// the projection type.
//
// Every column read here predates 0026, so this query is safe on a database
// without the migration. It cannot be REACHED there anyway: its only caller keys
// off `bookings.consignee_user_id`, which such a database does not return.
// -----------------------------------------------------------

export async function getConsigneeParties(userIds: string[]): Promise<Map<string, ConsigneeParty>> {
  const parties = new Map<string, ConsigneeParty>()
  if (userIds.length === 0) return parties

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, phone_number, city')
    .in('id', userIds)

  if (error) throw new Error(`Consignee lookup failed: ${error.message}`)

  for (const row of (data ?? []) as Array<{
    id: string
    full_name: string | null
    phone_number: string | null
    city: string | null
  }>) {
    parties.set(row.id, {
      name:  row.full_name    ?? null,
      phone: row.phone_number ?? null,
      city:  row.city         ?? null,
    })
  }

  return parties
}
