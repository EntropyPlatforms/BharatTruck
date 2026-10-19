import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'

// -----------------------------------------------------------
// notificationRoutes — the PUBLIC, UNAUTHENTICATED unsubscribe endpoint.
//
// Unauthenticated on purpose. An unsubscribe link has to work from inside a mail
// client, on a phone, for someone who is not logged in and may not remember they
// have an account — which is exactly the person most likely to reach for "mark as
// spam" if the link asks them to sign in first. The token IS the authorization:
// 256 bits of random from migration 021, and the only capability it grants is
// toggling that one row's category flags.
//
// Mounted OUTSIDE the auth-gated scope in index.ts.
// -----------------------------------------------------------

const UnsubscribeQuery = z.object({
  token: z.string().min(16),
  // Which category to mute. Absent = mute everything optional, which is what the
  // one-click List-Unsubscribe header POSTs.
  category: z.enum(['marketplace', 'trip_updates', 'digests']).optional(),
})

const COLUMN = {
  marketplace:  'email_marketplace',
  trip_updates: 'email_trip_updates',
  digests:      'email_digests',
} as const

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
             background:#f8fafc;margin:0;padding:48px 16px;color:#0f172a">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;padding:32px">
    <p style="margin:0 0 18px 0;font-size:18px;font-weight:700;color:#0f766e">BharatTruck</p>
    <h1 style="margin:0 0 12px 0;font-size:20px">${title}</h1>
    <p style="margin:0;color:#334155;line-height:1.6">${message}</p>
  </div>
</body></html>`
}

export async function notificationRoutes(app: FastifyInstance) {
  /**
   * Apply the opt-out. Shared by GET (a human clicked the link) and POST (the mail
   * client's one-click List-Unsubscribe, per RFC 8058).
   *
   * An unknown token is answered with the SAME success page as a valid one. Returning
   * "no such token" would turn this endpoint into an oracle for probing which tokens
   * exist, and the person unsubscribing gains nothing from being told their link was
   * stale — they are already opted out or were never subscribed.
   */
  async function applyOptOut(token: string, category?: keyof typeof COLUMN): Promise<void> {
    const patch = category
      ? { [COLUMN[category]]: false }
      : { email_marketplace: false, email_trip_updates: false, email_digests: false }

    const { error } = await supabase
      .from('notification_preferences')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('unsubscribe_token', token)

    if (error) throw new Error(`notification_preferences update failed: ${error.message}`)
  }

  // GET /notifications/unsubscribe?token=...&category=...
  app.get('/unsubscribe', async (req, reply) => {
    const parsed = UnsubscribeQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).type('text/html').send(
        page('That link is not valid', 'The unsubscribe link appears to be incomplete. Please use the link from the bottom of a recent BharatTruck email.'),
      )
    }
    try {
      await applyOptOut(parsed.data.token, parsed.data.category)
      return reply.type('text/html').send(
        page(
          'You are unsubscribed',
          parsed.data.category
            ? 'You will no longer receive these updates. Notifications about payments, awarded loads and completed deliveries will still be sent — those are records of your account activity.'
            : 'You will no longer receive optional updates from BharatTruck. Notifications about payments, awarded loads and completed deliveries will still be sent — those are records of your account activity.',
        ),
      )
    } catch (err) {
      req.log.error(err, 'unsubscribe failed')
      return reply.status(500).type('text/html').send(
        page('Something went wrong', 'We could not update your preferences just now. Please try again in a moment.'),
      )
    }
  })

  // POST /notifications/unsubscribe — RFC 8058 one-click, fired by Gmail/Outlook.
  // Must respond 200 with no body for the mail client to treat it as successful.
  app.post('/unsubscribe', async (req, reply) => {
    const parsed = UnsubscribeQuery.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send()
    try {
      await applyOptOut(parsed.data.token, parsed.data.category)
      return reply.status(200).send()
    } catch (err) {
      req.log.error(err, 'one-click unsubscribe failed')
      return reply.status(500).send()
    }
  })
}
