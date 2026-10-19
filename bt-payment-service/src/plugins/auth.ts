import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import jwt from 'jsonwebtoken'

// -----------------------------------------------------------
// JWT auth boundary for the money endpoints (P1 #11). Same custom
// HS256 scheme as the other services (shared JWT_SECRET); the token
// carries users.id as `userId` + `role`.
//
// `role` is a CLAIM, not an authorization axis (D-27): it is the caller's
// primary persona (a mailing address / default surface), and the settlement
// handlers authorize on RELATION-TO-BOOKING via @bharattruck/shared, never on
// this string. It is still fed to resolvePersonas() as `primary_persona` and
// kept as the ops/admin operator flag, which is a distinct axis from the
// emergent personas — see assertSettlementParty.
// -----------------------------------------------------------

export type AuthenticatedUser = {
  userId: string
  role: 'shipper' | 'driver' | 'admin'
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser
  }
}

interface AuthJwtPayload extends jwt.JwtPayload {
  userId: string
  role: string
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ success: false, error: 'Missing Bearer token', code: 'UNAUTHORIZED' })
    }
    let payload: AuthJwtPayload
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as AuthJwtPayload
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid or expired token', code: 'UNAUTHORIZED' })
    }
    if (!payload.userId) {
      return reply.status(401).send({ success: false, error: 'Token missing userId claim', code: 'UNAUTHORIZED' })
    }
    req.user = { userId: payload.userId, role: payload.role as AuthenticatedUser['role'] }
  })
}

export default fp(authPlugin)
