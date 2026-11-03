import type { FastifyInstance, FastifyRequest } from 'fastify'
import { resolveWhatsAppConfig } from '../lib/whatsapp/config.js'
import { safeEqual, verifyMetaSignature } from '../lib/whatsapp/signature.js'
import { parseWebhook } from '../lib/whatsapp/inbound.js'
import { CloudApiSender, type WhatsAppSender } from '../lib/whatsapp/client.js'
import { redisGuard, type InboundGuard } from '../lib/whatsapp/guard.js'
import { handleInbound } from '../lib/whatsapp/service.js'

export type WhatsAppRouteOptions = {
  /** Tests inject these; production builds them from the environment. */
  sender?: WhatsAppSender
  guard?: InboundGuard
  now?: () => Date
}

type RawRequest = FastifyRequest & { rawBody?: Buffer }

const NOT_CONFIGURED = { success: false, error: 'WhatsApp is not configured', code: 'WHATSAPP_NOT_CONFIGURED' }

// Public and unauthenticated by design — Meta calls it — and gated instead by the
// X-Hub-Signature-256 check below. Mounted at /whatsapp; the gateway forwards /api/whatsapp/*.
export async function whatsappRoutes(app: FastifyInstance, opts: WhatsAppRouteOptions) {
  // The signature covers the exact bytes Meta sent, so this scope keeps the raw body
  // instead of letting the default parser throw it away. Scoped to this plugin only.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    ;(req as RawRequest).rawBody = body as Buffer
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {})
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode?: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  const guard = opts.guard ?? redisGuard()

  // GET /whatsapp/webhook — Meta's one-off check when the webhook URL is saved: echo the
  // challenge only if the verify token is ours.
  app.get('/webhook', async (req, reply) => {
    const { config } = resolveWhatsAppConfig()
    if (!config) return reply.status(503).send(NOT_CONFIGURED)
    const q = req.query as Record<string, string | undefined>
    const ok = q['hub.mode'] === 'subscribe' && !!q['hub.verify_token'] && safeEqual(q['hub.verify_token'], config.verifyToken)
    if (!ok) return reply.status(403).send({ success: false, error: 'Verification failed' })
    return reply.type('text/plain').send(q['hub.challenge'] ?? '')
  })

  // POST /whatsapp/webhook — incoming messages. Answers 200 once the signature is good,
  // even if a reply fails: a non-200 makes Meta resend the whole batch.
  app.post('/webhook', async (req, reply) => {
    const { config } = resolveWhatsAppConfig()
    if (!config) return reply.status(503).send(NOT_CONFIGURED)

    const raw = (req as RawRequest).rawBody
    if (!raw || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, config.appSecret)) {
      req.log.warn('whatsapp webhook: bad or missing signature — dropped')
      return reply.status(401).send({ success: false, error: 'Invalid signature' })
    }

    const deps = { config, sender: opts.sender ?? new CloudApiSender(config), guard, now: opts.now, log: req.log }
    const messages = parseWebhook(req.body).filter((m) => !m.phoneNumberId || m.phoneNumberId === config.phoneNumberId)
    const outcome = { received: messages.length, answered: 0, duplicates: 0, rate_limited: 0 }
    for (const m of messages) {
      try {
        const o = await handleInbound(m, deps)
        if (o === 'answered') outcome.answered++
        else if (o === 'duplicate') outcome.duplicates++
        else outcome.rate_limited++
      } catch (err) {
        req.log.error({ err: (err as Error).message }, 'whatsapp message handling failed')
      }
    }
    return reply.send({ success: true, data: outcome })
  })
}
