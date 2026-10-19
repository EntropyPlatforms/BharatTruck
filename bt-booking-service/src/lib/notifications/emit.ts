// ============================================================
// src/lib/notifications/emit.ts
//
// Responsibility: the domain-facing notification API. One function per business
// event; each resolves the audience, snapshots the payload, and queues an outbox
// row. This replaces the `jobs.ts` stubs (notifyDriver / notifyShipper /
// notifyNewQuote), which had been TODO no-ops since the service was written —
// every call site was already there, none of them did anything.
//
// CONTRACT FOR EVERY FUNCTION HERE: never throw, never block the caller's result.
// Awarding an auction is the real work; telling people about it is a consequence.
// A mail server being down must not fail an award, so each function is wrapped in
// its own try/catch and failures are logged, not propagated.
//
// DEDUPE KEYS include the recipient role whenever one event mails more than one
// person (`trip_completed:<id>:shipper` vs `:carrier`). The unique index in
// migration 021 is on dedupe_key alone, so a key that omits the role would let the
// first insert win and silently swallow the second person's email.
// ============================================================

import { enqueueNotification } from '@bharattruck/shared/notifications'
import type { DbBooking, DbQuote } from '../types.js'
import {
  carrierDisplayName,
  carrierRecipient,
  driverDisplay,
  recipientByDriverId,
  recipientByFleetOwnerId,
  recipientByUserId,
  type Recipient,
} from './recipients.js'

type Logger = { warn(obj: unknown, msg: string): void }

/**
 * Route/cargo fields every template shows, snapshotted from the booking.
 *
 * Taken at emit time on purpose: the email must describe the trip as it was when
 * the event happened, not as it looks whenever the dispatcher gets to it.
 */
function bookingPayload(booking: DbBooking): Record<string, unknown> {
  return {
    booking_id: booking.id,
    source_address: booking.source_address,
    destination_address: booking.destination_address,
    load_type: booking.load_type,
    weight_kg: booking.weight_kg,
    pickup_date: booking.pickup_date,
  }
}

/**
 * Run an emit body, swallowing anything it throws.
 *
 * Every public function below is wrapped in this. Without it, a transient
 * `users` lookup failure inside a notification would surface as a 500 on an
 * award that had already been committed to the database.
 */
async function safely(log: Logger | undefined, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log?.warn({ err }, `notification emit failed: ${what} (business operation unaffected)`)
  }
}

// -----------------------------------------------------------
// Auction / marketplace
// -----------------------------------------------------------

/** A carrier bid on a load → tell the shipper. */
export async function emitQuoteReceived(
  booking: DbBooking,
  quote: DbQuote,
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_received', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    const bidderName = await carrierDisplayName(quote)
    await enqueueNotification({
      event: 'quote_received',
      to: shipper.email,
      userId: shipper.userId,
      payload: {
        ...bookingPayload(booking),
        amount: quote.amount,
        message: quote.message,
        bidder_name: bidderName,
      },
      // Keyed on the quote, so a retried submit does not double-notify.
      dedupeKey: `quote_received:${quote.id}`,
    }, log)
  })
}

/** A counter-offer was made → tell whichever side did NOT make it. */
export async function emitQuoteCountered(
  booking: DbBooking,
  quote: DbQuote,
  counteredBy: 'shipper' | 'carrier',
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_countered', async () => {
    const toShipper = counteredBy === 'carrier'
    const recipient: Recipient | null = toShipper
      ? await recipientByUserId(booking.shipper_id)
      : await carrierRecipient(quote)
    if (!recipient) return

    // Name whoever MADE the counter, which is the opposite side from the recipient.
    const actorName = toShipper
      ? await carrierDisplayName(quote)
      : (await recipientByUserId(booking.shipper_id))?.name ?? booking.shipper_name

    await enqueueNotification({
      event: 'quote_countered',
      to: recipient.email,
      userId: recipient.userId,
      payload: {
        ...bookingPayload(booking),
        amount: quote.amount,
        message: quote.message,
        actor_name: actorName,
        recipient_role: toShipper ? 'shipper' : 'carrier',
      },
      // Counters repeat on one quote (up to 5 rounds per the PRD), so the key has to
      // include the round. quote.updated_at moves on every counter and is the cheapest
      // honest discriminator available here.
      dedupeKey: `quote_countered:${quote.id}:${quote.updated_at}`,
    }, log)
  })
}

/**
 * A quote won → tell the winner, and tell everyone who lost.
 *
 * The losing-bidder notice is the half that is easy to skip and shouldn't be: a
 * carrier who never hears back holds capacity for a load they did not get.
 *
 * `losingQuotes` is passed IN rather than looked up here, and that is load-bearing:
 * awarding expires every other open quote, so by the time this runs there is nothing
 * live left to find. The caller has to snapshot the set before it awards.
 */
export async function emitQuoteAwarded(
  booking: DbBooking,
  winningQuote: DbQuote,
  losingQuotes: DbQuote[],
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_awarded', async () => {
    const winner = await carrierRecipient(winningQuote)
    if (winner) {
      await enqueueNotification({
        event: 'quote_awarded',
        to: winner.email,
        userId: winner.userId,
        payload: { ...bookingPayload(booking), amount: winningQuote.amount },
        dedupeKey: `quote_awarded:${winningQuote.id}`,
      }, log)
    }

    // Losing bidders. Whoever was still in play at award time; the winner is not in
    // this set. Guarded against a stale snapshot that still includes the winner, so a
    // future caller cannot mail the winner a loss notice.
    for (const loser of losingQuotes) {
      if (loser.id === winningQuote.id) continue
      const recipient = await carrierRecipient(loser)
      if (!recipient) continue
      await enqueueNotification({
        event: 'quote_lost',
        to: recipient.email,
        userId: recipient.userId,
        payload: bookingPayload(booking),
        dedupeKey: `quote_lost:${loser.id}`,
      }, log)
    }
  })
}

/**
 * The shipper explicitly rejected one bid → tell that bidder.
 *
 * Same `quote_lost` copy as the award path, and the same key shape, so a bid that
 * is rejected and then swept up again by a later award is only mailed about once.
 */
export async function emitQuoteRejected(
  booking: DbBooking,
  quote: DbQuote,
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_lost', async () => {
    const bidder = await carrierRecipient(quote)
    if (!bidder) return

    await enqueueNotification({
      event: 'quote_lost',
      to: bidder.email,
      userId: bidder.userId,
      payload: bookingPayload(booking),
      dedupeKey: `quote_lost:${quote.id}`,
    }, log)
  })
}

/** A bidder pulled out → tell the shipper their option is gone. */
export async function emitQuoteWithdrawn(
  booking: DbBooking,
  quote: DbQuote,
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_withdrawn', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    const bidderName = await carrierDisplayName(quote)
    await enqueueNotification({
      event: 'quote_withdrawn',
      to: shipper.email,
      userId: shipper.userId,
      payload: { ...bookingPayload(booking), bidder_name: bidderName },
      dedupeKey: `quote_withdrawn:${quote.id}`,
    }, log)
  })
}

/**
 * The shipper attached the load to their own fleet (D-10) → tell everyone who had
 * bid on it that the market is closed.
 *
 * There is no winner to congratulate and no shipper to inform: the same human is
 * both parties and they just performed the action. The losing side is the entire
 * audience, and it is the half that matters — a carrier who bid and never hears
 * back holds capacity for a load they are not getting, exactly as on the auction
 * path.
 *
 * The quotes are passed IN rather than looked up here, and that is load-bearing:
 * by the time this runs the caller has already expired them, so a lookup keyed on
 * the live statuses would find nothing and this function could never mail anyone.
 * The caller snapshots the losing set before closing the market.
 *
 * Reuses the `quote_lost` event and the `quote_lost:<quoteId>` key shape the award
 * and reject paths already use, so a bid that was rejected earlier and then swept
 * up by this is still only mailed about once.
 */
/**
 * Tell every losing bidder their quote is closed. Shared by every path that closes a market
 * around live bids — the auction award, a distributor's direct-attach, and a solo driver's
 * instant-accept — so a bid is never silently abandoned regardless of HOW the load was won.
 */
export async function emitQuotesLost(
  booking: DbBooking,
  losingQuotes: DbQuote[],
  log?: Logger,
): Promise<void> {
  await safely(log, 'quote_lost', async () => {
    for (const loser of losingQuotes) {
      const recipient = await carrierRecipient(loser)
      if (!recipient) continue
      await enqueueNotification({
        event: 'quote_lost',
        to: recipient.email,
        userId: recipient.userId,
        payload: bookingPayload(booking),
        dedupeKey: `quote_lost:${loser.id}`,
      }, log)
    }
  })
}

/** A distributor attached their own fleet to their load → tell the losing bidders. */
export async function emitDirectAttached(
  booking: DbBooking,
  losingQuotes: DbQuote[],
  log?: Logger,
): Promise<void> {
  await emitQuotesLost(booking, losingQuotes, log)
}

// -----------------------------------------------------------
// Trip lifecycle
// -----------------------------------------------------------

/** A driver took an open load directly (no auction) → tell the shipper. */
export async function emitBookingAccepted(booking: DbBooking, log?: Logger): Promise<void> {
  await safely(log, 'booking_accepted', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    const driver = await driverDisplay(booking.driver_id)
    await enqueueNotification({
      event: 'booking_accepted',
      to: shipper.email,
      userId: shipper.userId,
      payload: {
        ...bookingPayload(booking),
        driver_name: driver.name,
        truck_number: driver.truckNumber,
      },
      dedupeKey: `booking_accepted:${booking.id}`,
    }, log)
  })
}

/** The truck departed → tell the shipper tracking is live. */
export async function emitTripStarted(booking: DbBooking, log?: Logger): Promise<void> {
  await safely(log, 'trip_started', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    const driver = await driverDisplay(booking.driver_id)
    await enqueueNotification({
      event: 'trip_started',
      to: shipper.email,
      userId: shipper.userId,
      payload: {
        ...bookingPayload(booking),
        driver_name: driver.name,
        truck_number: driver.truckNumber,
      },
      dedupeKey: `trip_started:${booking.id}`,
    }, log)
  })
}

/**
 * The receiver's OTP closed the trip → tell the shipper and the carrier.
 *
 * Both sides get told for different reasons: the shipper that their cargo arrived,
 * the carrier that payment is now due. On a fleet-won trip the carrier notice goes to
 * the OWNER (the commercial party, per founder Q15) and the driver at the wheel is
 * also told, since they are the one who just finished the job.
 */
export async function emitTripCompleted(booking: DbBooking, log?: Logger): Promise<void> {
  await safely(log, 'trip_completed', async () => {
    const amount = booking.final_price ?? booking.quoted_price

    const shipper = await recipientByUserId(booking.shipper_id)
    if (shipper) {
      await enqueueNotification({
        event: 'trip_completed',
        to: shipper.email,
        userId: shipper.userId,
        payload: { ...bookingPayload(booking), amount, recipient_role: 'shipper' },
        dedupeKey: `trip_completed:${booking.id}:shipper`,
      }, log)
    }

    const carrier = await carrierRecipient(booking)
    if (carrier) {
      await enqueueNotification({
        event: 'trip_completed',
        to: carrier.email,
        userId: carrier.userId,
        payload: { ...bookingPayload(booking), amount, recipient_role: 'carrier' },
        dedupeKey: `trip_completed:${booking.id}:carrier`,
      }, log)
    }

    // On a fleet trip the owner was just notified as the carrier; the driver who
    // actually ran the load is a different person and is told separately. Skipped
    // entirely on solo bookings, where the driver IS the carrier and would otherwise
    // get the same email twice.
    if (booking.fleet_owner_id && booking.driver_id) {
      const driver = await recipientByDriverId(booking.driver_id)
      if (driver && driver.email !== carrier?.email) {
        await enqueueNotification({
          event: 'trip_completed',
          to: driver.email,
          userId: driver.userId,
          payload: { ...bookingPayload(booking), amount, recipient_role: 'driver' },
          dedupeKey: `trip_completed:${booking.id}:driver`,
        }, log)
      }
    }
  })
}

/** A booking was cancelled → tell the party who did not cancel it. */
export async function emitBookingCancelled(
  booking: DbBooking,
  cancelledBy: 'shipper' | 'driver',
  log?: Logger,
): Promise<void> {
  await safely(log, 'booking_cancelled', async () => {
    const toShipper = cancelledBy === 'driver'
    const recipient = toShipper
      ? await recipientByUserId(booking.shipper_id)
      : await carrierRecipient(booking)
    if (!recipient) return

    await enqueueNotification({
      event: 'booking_cancelled',
      to: recipient.email,
      userId: recipient.userId,
      payload: {
        ...bookingPayload(booking),
        cancelled_by: cancelledBy,
        recipient_role: toShipper ? 'shipper' : 'carrier',
      },
      dedupeKey: `booking_cancelled:${booking.id}:${toShipper ? 'shipper' : 'carrier'}`,
    }, log)
  })
}

/**
 * The driver reached the drop and there is no consignee address → tell the shipper.
 *
 * The only notification here triggered by a FAILED action rather than a completed
 * one. Without it the trip silently dead-ends: the driver sees "the shipper must
 * add one", the shipper is never told, and the booking sits in `in_transit`
 * forever — taking the payout with it.
 *
 * Keyed on the booking alone, so a driver retrying the button (or several attempts
 * across a day) mails the shipper once rather than once per tap.
 */
export async function emitReceiverEmailMissing(
  booking: DbBooking,
  log?: Logger,
): Promise<void> {
  await safely(log, 'receiver_email_missing', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    await enqueueNotification({
      event: 'receiver_email_missing',
      to: shipper.email,
      userId: shipper.userId,
      payload: bookingPayload(booking),
      dedupeKey: `receiver_email_missing:${booking.id}`,
    }, log)
  })
}

/**
 * Ops manually force-completed or reassigned a booking → tell both parties.
 *
 * Someone's trip changed underneath them without either party doing anything. Not
 * telling them is how a support override becomes a support ticket.
 */
export async function emitOpsOverride(
  booking: DbBooking,
  action: 'force_complete' | 'reassign',
  log?: Logger,
): Promise<void> {
  await safely(log, 'ops_override', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (shipper) {
      await enqueueNotification({
        event: 'ops_override',
        to: shipper.email,
        userId: shipper.userId,
        payload: { ...bookingPayload(booking), action, recipient_role: 'shipper' },
        dedupeKey: `ops_override:${booking.id}:${action}:shipper`,
      }, log)
    }

    const carrier = await carrierRecipient(booking)
    if (carrier) {
      await enqueueNotification({
        event: 'ops_override',
        to: carrier.email,
        userId: carrier.userId,
        payload: { ...bookingPayload(booking), action, recipient_role: 'carrier' },
        dedupeKey: `ops_override:${booking.id}:${action}:carrier`,
      }, log)
    }
  })
}

// -----------------------------------------------------------
// Payments
//
// Emitted from THIS service rather than bt-payment-service: the booking row (route,
// cargo, the shipper's identity) is the payload every money template needs, and it
// lives here. bt-payment-service already calls into booking-service on settle
// (mark-paid) and on trip completion, so the hook rides those existing internal
// calls instead of adding a new cross-service dependency.
// -----------------------------------------------------------

/** A settlement was recorded → receipt to the shipper. */
export async function emitPaymentSettled(
  booking: DbBooking,
  detail: { amount: number; method?: string | null; paymentId?: string | null },
  log?: Logger,
): Promise<void> {
  await safely(log, 'payment_settled', async () => {
    const shipper = await recipientByUserId(booking.shipper_id)
    if (!shipper) return

    await enqueueNotification({
      event: 'payment_settled',
      to: shipper.email,
      userId: shipper.userId,
      payload: {
        ...bookingPayload(booking),
        amount: detail.amount,
        method: detail.method ?? 'Direct',
        payment_id: detail.paymentId ?? null,
      },
      dedupeKey: `payment_settled:${booking.id}`,
    }, log)
  })
}

/** A payout was booked → tell the party that gets paid (owner on a fleet trip). */
export async function emitPayoutRecorded(
  booking: DbBooking,
  detail: { amount: number; status?: string | null },
  log?: Logger,
): Promise<void> {
  await safely(log, 'payout_recorded', async () => {
    const carrier = await carrierRecipient(booking)
    if (!carrier) return

    await enqueueNotification({
      event: 'payout_recorded',
      to: carrier.email,
      userId: carrier.userId,
      payload: {
        ...bookingPayload(booking),
        amount: detail.amount,
        status: detail.status ?? 'Recorded',
      },
      dedupeKey: `payout_recorded:${booking.id}`,
    }, log)
  })
}

// -----------------------------------------------------------
// Fleet
//
// Called over the internal notify route by bt-fleet-service, which owns invites but
// has no dispatcher of its own.
// -----------------------------------------------------------

/** A fleet owner invited a driver → tell the driver they have a decision to make. */
export async function emitFleetInvite(
  detail: { inviteId: string; driverId: string; fleetOwnerId: string },
  log?: Logger,
): Promise<void> {
  await safely(log, 'fleet_invite', async () => {
    const driver = await recipientByDriverId(detail.driverId)
    if (!driver) return
    const owner = await recipientByFleetOwnerId(detail.fleetOwnerId)

    await enqueueNotification({
      event: 'fleet_invite',
      to: driver.email,
      userId: driver.userId,
      payload: { company_name: owner?.companyName ?? null, invite_id: detail.inviteId },
      dedupeKey: `fleet_invite:${detail.inviteId}`,
    }, log)
  })
}

/** The driver answered → tell the owner, who is waiting on it to plan capacity. */
export async function emitFleetInviteAnswered(
  detail: {
    inviteId: string
    driverId: string
    fleetOwnerId: string
    response: 'accepted' | 'declined'
  },
  log?: Logger,
): Promise<void> {
  await safely(log, 'fleet_invite_answered', async () => {
    const owner = await recipientByFleetOwnerId(detail.fleetOwnerId)
    if (!owner) return
    const driver = await driverDisplay(detail.driverId)

    await enqueueNotification({
      event: 'fleet_invite_answered',
      to: owner.email,
      userId: owner.userId,
      payload: { driver_name: driver.name, response: detail.response },
      dedupeKey: `fleet_invite_answered:${detail.inviteId}:${detail.response}`,
    }, log)
  })
}

// -----------------------------------------------------------
// Account
// -----------------------------------------------------------

/** A password was changed → security notice to the account owner. */
export async function emitPasswordChanged(
  detail: { userId: string; changedAt?: string },
  log?: Logger,
): Promise<void> {
  await safely(log, 'password_changed', async () => {
    const user = await recipientByUserId(detail.userId)
    if (!user) return

    const changedAt = detail.changedAt ?? new Date().toISOString()
    await enqueueNotification({
      event: 'password_changed',
      to: user.email,
      userId: user.userId,
      payload: { changed_at: changedAt },
      // A user may legitimately change their password more than once, so the key is
      // per-change, not per-user.
      dedupeKey: `password_changed:${detail.userId}:${changedAt}`,
    }, log)
  })
}
