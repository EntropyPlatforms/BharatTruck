import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import * as feed from '../lib/feed/service.js'

// limit/offset pagination over the merged, sorted feed (D-38, §10.2). Coerced from
// query strings; bounds enforced again in the service so a direct caller cannot
// skip them. offset defaults to 0, limit to the service default.
const FeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in feed routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

export async function feedRoutes(app: FastifyInstance) {
  // GET /me/feed — the unified, capability-aware "what needs me right now?" action
  // feed (D-38). Authorized purely by the caller's identity (the JWT the auth
  // plugin already verified); the feed only ever contains the caller's own items.
  app.get('/feed', async (req, reply) => {
    const parsed = FeedQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      })
    }
    try {
      const page = await feed.getFeed(req.user, parsed.data, req.log)
      return reply.send({ success: true, data: page })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
