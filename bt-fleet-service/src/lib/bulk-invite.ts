import { z } from 'zod'
import {
  findDriverByEmail,
  findDriverByPhone,
  inviteDriver,
  listFleetDrivers,
  toCanonicalPhone,
  type DriverIdentity,
} from './fleet-repo.js'
import { emitNotification } from './notify-emit.js'
import { FleetError, type FleetDriverRow } from './types.js'

// -----------------------------------------------------------
// bulk-invite — invite a whole list of drivers in one call.
//
// SAME FLOW AS ONE INVITE, MANY TIMES. Each row goes through exactly the lookup + insert +
// notification that POST /fleet/drivers/invite runs (findInviteTarget + sendInvite below are
// what that route calls too), so a bulk invitation is indistinguishable from a single one: the
// driver must already have an account, gets the same notification, and must accept from their
// own app. Nothing here creates a login, a password or a drivers row on anyone's behalf.
//
// PER-ROW OUTCOMES, NEVER ALL-OR-NOTHING. A fleet's list always has one stale number or one
// driver who has not signed up yet; that row gets its own status and reason and every other row
// still goes through. Only a request-level problem (no rows, over the cap, not allowed to manage
// drivers) refuses the whole call.
// -----------------------------------------------------------

export const BULK_INVITE_LIMIT = 200

// One invitation channel — the body POST /fleet/drivers/invite accepts.
export type InviteChannel = { driver_phone: string } | { driver_email: string }

// findInviteTarget — channel -> existing driver identity. Email wins when both are sent, which
// is the single-invite route's long-standing rule. Throws the same 400/404 FleetErrors.
export async function findInviteTarget(channel: { driver_phone?: string; driver_email?: string }): Promise<DriverIdentity> {
  return channel.driver_email
    ? findDriverByEmail(channel.driver_email)
    : findDriverByPhone(channel.driver_phone!)
}

type Logger = { warn(obj: unknown, msg: string): void }

// sendInvite — create the pending affiliation and tell the driver. The invite is only
// actionable if the driver hears about it, so the notification is part of "inviting", not an
// extra; it is fire-and-forget (notify-emit.ts) and can never fail the invite.
export async function sendInvite(
  fleetOwnerId: string,
  driver: DriverIdentity,
  invitedBy: string,
  log?: Logger,
): Promise<FleetDriverRow> {
  const affiliation = await inviteDriver(fleetOwnerId, driver.driver_id, invitedBy)
  emitNotification({
    event: 'fleet_invite',
    invite_id: affiliation.id,
    driver_id: driver.driver_id,
    fleet_owner_id: fleetOwnerId,
  }, log)
  return affiliation
}

// ── Row validation (pure) ─────────────────────────────────────

// A row mirrors the single invite body (phone OR email) plus the name the owner typed against
// it. The name is the owner's label for their own list — it is echoed back so the results read
// like their file, and is NEVER written anywhere: the driver's name comes from their own account.
// A spreadsheet cell left empty arrives as '' (or whitespace): that is "not given", not invalid.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const BulkRow = z.object({
  name: z.preprocess(blankToUndefined,
    z.string({ required_error: 'Name is missing', invalid_type_error: 'Name is missing' })
      .trim().max(120, 'Name is too long')),
  driver_phone: z.preprocess(blankToUndefined, z.string().trim().max(20, 'That is not a valid 10-digit Indian mobile number').optional()),
  driver_email: z.preprocess(blankToUndefined,
    z.string().trim().max(254).email('That is not a valid email address').optional()),
}).refine(r => Boolean(r.driver_phone) || Boolean(r.driver_email), {
  message: 'A mobile number or an email is required',
})

export const BulkInviteBody = z.object({
  // Items are validated one by one below, so a malformed row is a per-row 'invalid' rather than
  // a 400 for the whole file. The array itself — present, non-empty, under the cap — is the only
  // thing that can refuse the request.
  drivers: z.array(z.unknown(), { required_error: 'drivers is required' })
    .min(1, 'Add at least one driver')
    .max(BULK_INVITE_LIMIT, `At most ${BULK_INVITE_LIMIT} drivers per upload — split the file and upload the rest separately`),
})

export type BulkInviteStatus =
  | 'invited'           // a new pending invitation was created and the driver notified
  | 'already_in_fleet'  // already an active driver of THIS fleet
  | 'already_invited'   // already holds a pending invitation from THIS fleet
  | 'unavailable'       // already has a live affiliation — which fleet is deliberately not said
  | 'no_account'        // no driver account for that mobile/email: they must sign up first
  | 'duplicate'         // the same driver appears earlier in this upload
  | 'invalid'           // the row itself is wrong (missing name, bad mobile/email)
  | 'failed'            // an unexpected error on this row only; safe to retry

export type BulkInviteResult = {
  row: number                // 1-based position in the submitted list
  name: string | null        // the owner's own label for the row, echoed back
  status: BulkInviteStatus
  reason: string | null
  invite_id: string | null
  // The ACCOUNT the row resolved to (its own name and phone) so the owner can check it is the
  // person they meant. Never returned for 'unavailable', mirroring the single invite's 409.
  driver: { driver_id: string; full_name: string | null; phone_number: string | null } | null
}

type PlannedRow = { row: number; name: string; channel: InviteChannel }

// planRows — PURE. Validate each row and drop in-file duplicates (by canonical mobile / lower-
// cased email, so '+91 98765 43210' and '09876543210' are the same driver). Returns the rows to
// send plus the terminal results for every row that never reaches the database.
export function planRows(input: unknown[]): { planned: PlannedRow[]; done: BulkInviteResult[] } {
  const planned: PlannedRow[] = []
  const done: BulkInviteResult[] = []
  const firstSeen = new Map<string, number>()

  input.forEach((raw, i) => {
    const row = i + 1
    const rawName = typeof (raw as { name?: unknown } | null)?.name === 'string'
      ? ((raw as { name: string }).name.trim() || null)
      : null
    const parsed = BulkRow.safeParse(raw)
    if (!parsed.success) {
      done.push(terminal(row, rawName, 'invalid', parsed.error.errors[0].message))
      return
    }
    const r = parsed.data

    // Same channel choice as findInviteTarget: email when given, else the mobile.
    let channel: InviteChannel
    let key: string
    if (r.driver_email) {
      channel = { driver_email: r.driver_email }
      key = `e:${r.driver_email.toLowerCase()}`
    } else {
      const canonical = toCanonicalPhone(r.driver_phone!)
      if (!canonical) {
        done.push(terminal(row, r.name, 'invalid', 'That is not a valid 10-digit Indian mobile number'))
        return
      }
      channel = { driver_phone: r.driver_phone! }
      key = `p:${canonical}`
    }

    const earlier = firstSeen.get(key)
    if (earlier !== undefined) {
      done.push(terminal(row, r.name, 'duplicate', `Same ${key.startsWith('p:') ? 'mobile number' : 'email'} as row ${earlier}`))
      return
    }
    firstSeen.set(key, row)
    planned.push({ row, name: r.name, channel })
  })

  return { planned, done }
}

function terminal(row: number, name: string | null, status: BulkInviteStatus, reason: string): BulkInviteResult {
  return { row, name, status, reason, invite_id: null, driver: null }
}

// ── Execution ─────────────────────────────────────────────────

// A handful at a time: 200 strictly-sequential rows is several seconds of round trips the owner
// sits through, while an unbounded fan-out would hit the database with 800 queries at once.
const CONCURRENCY = 5

export async function inviteDriversInBulk(
  fleetOwnerId: string,
  invitedBy: string,
  input: unknown[],
  log: Logger & { error(obj: unknown, msg: string): void },
): Promise<BulkInviteResult[]> {
  const { planned, done } = planRows(input)
  const results: BulkInviteResult[] = [...done]
  if (planned.length === 0) return results.sort((a, b) => a.row - b.row)

  // This fleet's own live roster, read once, to name WHY a row is not invited. Only this fleet's
  // rows are read, so nothing about another fleet's roster is ever disclosed.
  const live = new Map<string, FleetDriverRow['status']>()
  for (const r of await listFleetDrivers(fleetOwnerId, ['pending', 'active'])) live.set(r.driver_id, r.status)

  // 1. Resolve every row to an existing driver account (the single invite's lookup).
  const resolved = await mapPool(planned, async (p): Promise<DriverIdentity | BulkInviteResult> => {
    try {
      return await findInviteTarget(p.channel)
    } catch (err) {
      if (err instanceof FleetError && err.code === 'NOT_FOUND') return terminal(p.row, p.name, 'no_account', err.message)
      if (err instanceof FleetError && err.code === 'VALIDATION_ERROR') return terminal(p.row, p.name, 'invalid', err.message)
      log.error({ err, row: p.row }, 'bulk invite: driver lookup failed')
      return terminal(p.row, p.name, 'failed', 'Could not look up this driver — try this row again')
    }
  })

  // 2. In FILE order, decide who gets sent. Two rows can name one driver by different channels
  // (one by mobile, one by email); the earlier row wins and the later one is a 'duplicate' —
  // deterministic, and never a misleading unique-index refusal on the second insert.
  const claimed = new Map<string, number>()
  const toSend: { p: PlannedRow; driver: DriverIdentity }[] = []
  planned.forEach((p, i) => {
    const got = resolved[i]
    if (!('driver_id' in got)) { results.push(got); return }
    const who = identity(got)
    const earlier = claimed.get(got.driver_id)
    if (earlier !== undefined) {
      results.push({ ...terminal(p.row, p.name, 'duplicate', `Same driver as row ${earlier}`), driver: who })
      return
    }
    claimed.set(got.driver_id, p.row)
    const already = live.get(got.driver_id)
    if (already === 'active') {
      results.push({ ...terminal(p.row, p.name, 'already_in_fleet', 'Already an active driver in your fleet'), driver: who })
    } else if (already === 'pending') {
      results.push({ ...terminal(p.row, p.name, 'already_invited', 'Already invited — waiting for the driver to accept'), driver: who })
    } else {
      toSend.push({ p, driver: got })
    }
  })

  // 3. Send — the single invite's insert + notification, one row at a time per worker.
  results.push(...await mapPool(toSend, async ({ p, driver }): Promise<BulkInviteResult> => {
    try {
      const affiliation = await sendInvite(fleetOwnerId, driver, invitedBy, log)
      return { row: p.row, name: p.name, status: 'invited', reason: null, invite_id: affiliation.id, driver: identity(driver) }
    } catch (err) {
      // fleet_drivers_one_live_per_driver: live somewhere this fleet's roster does not show.
      // Same wording as the single invite's 409, and no identity, so the other fleet stays private.
      if (err instanceof FleetError && err.code === 'CONFLICT') return terminal(p.row, p.name, 'unavailable', err.message)
      log.error({ err, row: p.row }, 'bulk invite: insert failed')
      return terminal(p.row, p.name, 'failed', 'Could not send this invitation — try this row again')
    }
  }))

  return results.sort((a, b) => a.row - b.row)
}

function identity(d: DriverIdentity): NonNullable<BulkInviteResult['driver']> {
  return { driver_id: d.driver_id, full_name: d.full_name, phone_number: d.phone_number }
}

// mapPool — Promise.all over `items` with at most CONCURRENCY in flight; output keeps input order.
async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return out
}

// countByStatus — the summary line the results screen leads with.
export function countByStatus(results: BulkInviteResult[]): Record<BulkInviteStatus, number> {
  const counts: Record<BulkInviteStatus, number> = {
    invited: 0, already_in_fleet: 0, already_invited: 0, unavailable: 0,
    no_account: 0, duplicate: 0, invalid: 0, failed: 0,
  }
  for (const r of results) counts[r.status]++
  return counts
}
