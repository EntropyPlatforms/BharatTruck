import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'

// -----------------------------------------------------------
// internalAuthPlugin
// Guards service-to-service ("internal") routes with a shared
// secret header instead of a user JWT. These routes are called by
// trusted sibling services (e.g. bt-cargo-ledger completing a trip
// after a verified receiver OTP), never by end-user clients — the
// gateway does not expose /internal/* publicly.
// -----------------------------------------------------------

const internalAuthPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET
    if (!secret) {
      req.log.error('INTERNAL_SERVICE_SECRET is not configured; refusing internal request')
      return reply.status(503).send({ success: false, error: 'Internal auth not configured', code: 'MISCONFIGURED' })
    }
    const provided = req.headers['x-internal-secret']
    if (typeof provided !== 'string' || provided !== secret) {
      return reply.status(401).send({ success: false, error: 'Invalid internal secret', code: 'UNAUTHORIZED' })
    }
  })
}

export default fp(internalAuthPlugin)
