import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import jwt from 'jsonwebtoken'

// -----------------------------------------------------------
// JWT auth boundary for pricing (P1 #11). Same custom HS256 scheme as the
// other services (shared JWT_SECRET); token carries users.id as `userId`.
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
