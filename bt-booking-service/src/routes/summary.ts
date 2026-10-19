import type { FastifyInstance } from 'fastify'
import { BookingError } from '../lib/types.js'
import { getMySummary } from '../lib/summary/service.js'

export async function summaryRoutes(app: FastifyInstance) {
  // GET /me/summary — "how am I doing?": the dashboard panels this person's capabilities
  // unlock, with money decided on the server (§1.1). Authorized purely by the caller's own
  // identity (the JWT the auth plugin verified); every figure is the caller's own.
  app.get('/summary', async (req, reply) => {
    try {
      const data = await getMySummary(req.user, new Date(), req.log)
      return reply.send({ success: true, data })
    } catch (err) {
      if (err instanceof BookingError) {
        return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
      }
      req.log.error(err, 'Unhandled error in summary route')
      return reply.status(500).send({ success: false, error: 'Internal server error' })
    }
  })
}
