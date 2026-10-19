import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { verifyJwt, extractBearer, JwtError, type AuthenticatedUser } from '@bharattruck/shared/auth'

// Thin Fastify adapter over the shared HS256 verify (T-BE-7). The JWT verify +
// identity contract live in @bharattruck/shared/auth; this only wires it onto
// the request. Error messages/statuses are unchanged.

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const token = extractBearer(req.headers.authorization)
    if (!token) {
      return reply.status(401).send({ success: false, error: 'Missing Bearer token' })
    }
    try {
      req.user = verifyJwt(token, process.env.JWT_SECRET!)
    } catch (err) {
      if (err instanceof JwtError) {
        return reply.status(401).send({ success: false, error: err.message })
      }
      throw err
    }
  })
}

export default fp(authPlugin)
