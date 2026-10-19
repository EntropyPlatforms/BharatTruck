import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

// -----------------------------------------------------------
// internalAuthPlugin — shared-secret gate for service-to-service
// routes (e.g. booking-service reading/consuming a locked price_quote).
// Fails closed if INTERNAL_SERVICE_SECRET is unset. Not gateway-exposed.
// -----------------------------------------------------------

const internalAuthPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET
    if (!secret) {
      req.log.error('INTERNAL_SERVICE_SECRET is not configured; refusing internal request')
      return reply.status(503).send({ success: false, error: 'Internal auth not configured', code: 'MISCONFIGURED' })
    }
    const provided = req.headers['x-internal-secret']
    // Constant-time compare so response time does not leak a prefix-match length
    // of the shared secret. timingSafeEqual requires equal-length buffers, so the
    // length check gates it (length itself is not the secret).
    const a = typeof provided === 'string' ? Buffer.from(provided) : Buffer.alloc(0)
    const b = Buffer.from(secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.status(401).send({ success: false, error: 'Invalid internal secret', code: 'UNAUTHORIZED' })
    }
  })
}

export default fp(internalAuthPlugin)
