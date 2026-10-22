import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import * as repo from '../lib/repository.js'
import * as bahi from '../lib/bahi/service.js'

// Bahi Khata link (registered under /bookings → gateway /api/bookings/bahi/…):
//   GET    /bahi/connection        is this account linked, to which Bahi company, GST rate
//   PUT    /bahi/connection        { token, gst_rate } — pinged, then stored encrypted
//   PATCH  /bahi/connection        { gst_rate }
//   DELETE /bahi/connection        unlink (the token stays valid in Bahi until revoked there)
//   GET    /bahi/postings          this account's recent postings
//   POST   /:id/bahi/sync          re-post this account's side of one paid load

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  reply.log.error(err, 'Unhandled error in bahi routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

function parse<T>(reply: FastifyReply, schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  const issue = parsed.error.errors[0]
  reply.status(400).send({ success: false, error: issue.message, code: 'VALIDATION_ERROR' })
  return null
}

const IdParams = z.object({ id: z.string().uuid('id must be a valid UUID') })

export async function bahiRoutes(app: FastifyInstance) {
  app.get('/bahi/connection', async (req, reply) => {
    try { return reply.send({ success: true, data: await bahi.connectionView(req.user.userId) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.put('/bahi/connection', async (req, reply) => {
    const body = parse(reply, bahi.ConnectBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await bahi.connect(req.user.userId, body) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.patch('/bahi/connection', async (req, reply) => {
    const body = parse(reply, bahi.SettingsBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await bahi.updateSettings(req.user.userId, body) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.delete('/bahi/connection', async (req, reply) => {
    try { await bahi.disconnect(req.user.userId); return reply.send({ success: true, data: await bahi.connectionView(req.user.userId) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.get('/bahi/postings', async (req, reply) => {
    try { return reply.send({ success: true, data: await bahi.recentPostings(req.user.userId) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.post('/:id/bahi/sync', async (req, reply) => {
    const params = parse(reply, IdParams, req.params)
    if (!params) return
    try {
      const booking = await repo.getBookingById(params.id)
      if (!booking) throw new BookingError('Booking not found', 'NOT_FOUND', 404)
      return reply.send({ success: true, data: await bahi.retryForUser(booking, req.user.userId) })
    } catch (err) { return handleError(reply, err) }
  })
}
