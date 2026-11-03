// ============================================================
// src/lib/whatsapp/repository.ts — every database read and write the bot makes.
// Tables: whatsapp_contacts and whatsapp_outbox (migration 0043, service-role only).
// A missing table surfaces as WhatsAppNotMigratedError so callers can degrade instead of 500.
// ============================================================

import { supabase } from '../supabase.js'
import { isMissingRelation } from '../db-errors.js'
import { storedPhoneCandidates } from './phone.js'

export class WhatsAppNotMigratedError extends Error {
  readonly code = 'WHATSAPP_NOT_MIGRATED'
  constructor() {
    super('The WhatsApp tables do not exist yet — apply supabase/migrations/0043_whatsapp.sql')
    this.name = 'WhatsAppNotMigratedError'
  }
}

type DbError = { code?: string; message: string } | null
function check(error: DbError, what: string): void {
  if (!error) return
  if (isMissingRelation(error)) throw new WhatsAppNotMigratedError()
  throw new Error(`${what} failed: ${error.message}`)
}

// ── People ───────────────────────────────────────────────────────────────────

export type Person = { id: string; full_name: string | null; role: string | null }

/**
 * The account behind a mobile number — the same trust as the app's phone sign-in: whoever
 * holds the number is that account. Two exceptions return null (the bot then treats the
 * number as a newcomer):
 *   - an unclaimed receiver record (claimed_at null): it has no owner yet and is reached
 *     only through its claim link (D-22/D-35), never by phone alone;
 *   - more than one account stored the number in different formats.
 */
export async function findPersonByMobile(mobile: string): Promise<Person | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, claimed_at')
    .in('phone_number', storedPhoneCandidates(mobile))
    .limit(5)
  if (error) throw new Error(`users select failed: ${error.message}`)
  const rows = ((data ?? []) as Array<Person & { claimed_at: string | null }>).filter((r) => r.claimed_at)
  return rows.length === 1 ? { id: rows[0].id, full_name: rows[0].full_name, role: rows[0].role } : null
}

export async function phoneOfUser(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('users').select('phone_number').eq('id', userId).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  return (data as { phone_number: string | null } | null)?.phone_number ?? null
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export type Contact = {
  wa_id: string
  user_id: string | null
  alerts_opt_in_at: string | null
  opted_out_at: string | null
  last_inbound_at: string | null
}
const CONTACT_COLUMNS = 'wa_id, user_id, alerts_opt_in_at, opted_out_at, last_inbound_at'

export async function getContact(waId: string): Promise<Contact | null> {
  const { data, error } = await supabase.from('whatsapp_contacts').select(CONTACT_COLUMNS).eq('wa_id', waId).maybeSingle()
  check(error, 'whatsapp_contacts select')
  return (data as Contact | null) ?? null
}

export async function updateContact(waId: string, patch: Partial<Omit<Contact, 'wa_id'>>, nowIso: string): Promise<void> {
  const { error } = await supabase.from('whatsapp_contacts').update({ ...patch, updated_at: nowIso }).eq('wa_id', waId)
  check(error, 'whatsapp_contacts update')
}

/** Note an inbound message: create the contact on first contact, otherwise refresh it. */
export async function recordInbound(waId: string, userId: string | null, nowIso: string): Promise<Contact> {
  const existing = await getContact(waId)
  if (!existing) {
    const row = { wa_id: waId, user_id: userId, alerts_opt_in_at: null, opted_out_at: null, last_inbound_at: nowIso }
    const { error } = await supabase.from('whatsapp_contacts').insert({ ...row, created_at: nowIso, updated_at: nowIso })
    if (!error) return row
    if (error.code !== '23505') check(error, 'whatsapp_contacts insert')
    // 23505: a concurrent message from the same number created it first — refresh below.
  }
  await updateContact(waId, { user_id: userId, last_inbound_at: nowIso }, nowIso)
  const fresh = await getContact(waId)
  return fresh ?? { wa_id: waId, user_id: userId, alerts_opt_in_at: null, opted_out_at: null, last_inbound_at: nowIso }
}

// ── Trips ────────────────────────────────────────────────────────────────────

export type TripRow = {
  id: string
  status: string
  source_address: string | null
  destination_address: string | null
  pickup_date: string | null
  shipper_id: string | null
  driver_id: string | null
  fleet_owner_id: string | null
}
// No price columns are selected at all: trips sent over WhatsApp never carry money.
const TRIP_COLUMNS = 'id, status, source_address, destination_address, pickup_date, shipper_id, driver_id, fleet_owner_id'
export const ACTIVE_TRIP_STATUSES = ['accepted', 'in_transit', 'delivery_asserted']

/** Live trips the person is a party to: as shipper, as the assigned driver, or as the fleet. */
export async function activeTrips(userId: string, driverId: string | null, fleetOwnerId: string | null): Promise<TripRow[]> {
  const run = async (col: string, value: string) => {
    const { data, error } = await supabase
      .from('bookings').select(TRIP_COLUMNS).eq(col, value).in('status', ACTIVE_TRIP_STATUSES).limit(20)
    if (error) throw new Error(`bookings select failed: ${error.message}`)
    return (data ?? []) as TripRow[]
  }
  const batches = await Promise.all([
    run('shipper_id', userId),
    driverId ? run('driver_id', driverId) : Promise.resolve([] as TripRow[]),
    fleetOwnerId ? run('fleet_owner_id', fleetOwnerId) : Promise.resolve([] as TripRow[]),
  ])
  const byId = new Map<string, TripRow>()
  for (const r of batches.flat()) byId.set(r.id, r)
  return [...byId.values()]
}

// ── Outbox ───────────────────────────────────────────────────────────────────

export type OutboxRow = {
  id: string
  wa_id: string
  user_id: string | null
  kind: string
  body_text: string
  template_params: string[]
  dedupe_key: string
  status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed'
  attempts: number
  max_attempts: number
  next_attempt_at: string
}
const OUTBOX_COLUMNS = 'id, wa_id, user_id, kind, body_text, template_params, dedupe_key, status, attempts, max_attempts, next_attempt_at'

export async function insertOutbox(row: {
  wa_id: string; user_id: string | null; kind: string; body_text: string; template_params: string[]; dedupe_key: string
}, nowIso: string): Promise<'queued' | 'duplicate'> {
  const { error } = await supabase.from('whatsapp_outbox')
    .insert({ ...row, status: 'pending', attempts: 0, max_attempts: 5, next_attempt_at: nowIso, created_at: nowIso })
  if (!error) return 'queued'
  if (error.code === '23505') return 'duplicate'
  check(error, 'whatsapp_outbox insert')
  return 'queued'
}

export async function dueOutbox(nowIso: string, limit: number): Promise<OutboxRow[]> {
  const { data, error } = await supabase
    .from('whatsapp_outbox').select(OUTBOX_COLUMNS)
    .in('status', ['pending', 'sending']).lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true }).limit(limit)
  check(error, 'whatsapp_outbox select')
  return (data ?? []) as OutboxRow[]
}

/** Compare-and-swap claim, same as the email dispatcher: only one overlapping drain wins a row. */
export async function claimOutbox(row: OutboxRow, leaseUntilIso: string): Promise<OutboxRow | null> {
  const { data, error } = await supabase
    .from('whatsapp_outbox')
    .update({ status: 'sending', attempts: row.attempts + 1, next_attempt_at: leaseUntilIso, last_error: null })
    .eq('id', row.id).eq('attempts', row.attempts).in('status', ['pending', 'sending'])
    .select(OUTBOX_COLUMNS).maybeSingle()
  check(error, 'whatsapp_outbox claim')
  return (data as OutboxRow | null) ?? null
}

export async function settleOutbox(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('whatsapp_outbox').update(patch).eq('id', id)
  check(error, 'whatsapp_outbox update')
}
