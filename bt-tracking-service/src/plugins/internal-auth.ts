import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'

// -----------------------------------------------------------
// internalAuthPlugin — shared-secret gate for service-to-service routes.
//
// Mirrors bt-booking-service/src/plugins/internal-auth.ts exactly, including the
// fail-closed 503 when the secret is unconfigured: a service that cannot verify callers
// must refuse them, not wave them through.
//
// The only caller today is bt-booking-service's GPS ingestion path, which fires
// POST /internal/evaluate after each accepted /location/update. The gateway does not
// expose /internal/* publicly, so this is defence in depth rather than the only barrier.
// -----------------------------------------------------------

const internalAuthPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET
    if (!secret) {
      req.log.error('INTERNAL_SERVICE_SECRET is not configured; refusing internal request')
      return reply
        .status(503)
        .send({ success: false, error: 'Internal auth not configured', code: 'MISCONFIGURED' })
    }
    const provided = req.headers['x-internal-secret']
    if (typeof provided !== 'string' || provided !== secret) {
      return reply.status(401).send({ success: false, error: 'Invalid internal secret', code: 'UNAUTHORIZED' })
    }
  })
}

export default fp(internalAuthPlugin)
