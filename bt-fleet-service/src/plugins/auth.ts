import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import jwt from 'jsonwebtoken'

// -----------------------------------------------------------
// JWT auth boundary. Same custom HS256 scheme as the other services (shared
// JWT_SECRET); the token carries users.id as `userId` plus `role`.
//
// IDENTITY: `userId` is users.id and NOTHING else. drivers.id is a separate row
// (fleet_drivers.driver_id, bookings.driver_id, quotes.driver_id and the Redis
// loc:* keys all reference drivers.id), and fleet_owners.id is a third. Every
// resolution from userId to either of those goes through fleet-repo.ts.
// -----------------------------------------------------------

export type AuthenticatedUser = { userId: string; role: string }

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
    req.user = { userId: payload.userId, role: payload.role }
  })
}

export default fp(authPlugin)
