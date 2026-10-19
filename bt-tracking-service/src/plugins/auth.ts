import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AuthenticatedUser } from '../lib/types.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser
  }
}

interface CustomJwtPayload {
  userId: string
  role: string
  iat?: number
  exp?: number
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ success: false, error: 'Missing Bearer token' })
    }

    const token = header.slice(7)
    let payload: CustomJwtPayload

    try {
      payload = jwt.verify(token, process.env.JWT_SECRET!) as CustomJwtPayload
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid or expired token' })
    }

    // `userId` is the only claim that identifies anybody, so it is the only one required —
    // the same rule bt-auth-service and bt-fleet-service apply (D-27: the role string is no
    // longer an authorization axis). Requiring `role` here as well made this the one service
    // that refused a valid session whose access token was refreshed from an older refresh
    // token without a role: every other page worked, and Live Fleet / live tracking answered
    // 401, which the app read as "session expired" and signed the user out.
    if (!payload.userId) {
      return reply.status(401).send({ success: false, error: 'Token missing required claims' })
    }

    req.user = {
      userId: payload.userId,
      role: (payload.role ?? 'shipper') as AuthenticatedUser['role'],
    }
  })
}

export default fp(authPlugin)
