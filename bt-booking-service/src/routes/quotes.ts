import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError, SubmitQuoteBodySchema, CounterQuoteBodySchema } from '../lib/types.js'
import * as quoteSvc from '../lib/quote-service.js'

const uuid = z.string().uuid()

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in quote routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

function parseUuid(reply: FastifyReply, value: string, field: string): string | null {
  const parsed = uuid.safeParse(value)
  if (!parsed.success) {
    reply.status(400).send({
      success: false,
      error: `${field} must be a valid UUID`,
      code: 'VALIDATION_ERROR',
    })
    return null
  }
  return parsed.data
}

export async function quoteRoutes(app: FastifyInstance) {

  // POST /bookings/:bookingId/quotes — driver submits a quote
  app.post('/:bookingId/quotes', async (req, reply) => {
    const { bookingId: rawBookingId } = req.params as { bookingId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const parsed = SubmitQuoteBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      })
    }
    try {
      const quote = await quoteSvc.submitQuote(bookingId, parsed.data, req.user, req.log)
      return reply.status(201).send({ success: true, data: quote })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // GET /bookings/:bookingId/quotes — list quotes (role-scoped)
  app.get('/:bookingId/quotes', async (req, reply) => {
    const { bookingId: rawBookingId } = req.params as { bookingId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    try {
      const quotes = await quoteSvc.listQuotes(bookingId, req.user)
      return reply.send({ success: true, data: quotes })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // PATCH /bookings/:bookingId/quotes/:quoteId/counter — counter-offer
  app.patch('/:bookingId/quotes/:quoteId/counter', async (req, reply) => {
    const { bookingId: rawBookingId, quoteId: rawQuoteId } = req.params as { bookingId: string; quoteId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const quoteId = parseUuid(reply, rawQuoteId, 'quoteId')
    if (!quoteId) return
    const parsed = CounterQuoteBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      })
    }
    try {
      const quote = await quoteSvc.counterQuote(bookingId, quoteId, parsed.data, req.user, req.log)
      return reply.send({ success: true, data: quote })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // PATCH /bookings/:bookingId/quotes/:quoteId/accept — shipper awards
  app.patch('/:bookingId/quotes/:quoteId/accept', async (req, reply) => {
    const { bookingId: rawBookingId, quoteId: rawQuoteId } = req.params as { bookingId: string; quoteId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const quoteId = parseUuid(reply, rawQuoteId, 'quoteId')
    if (!quoteId) return
    try {
      const booking = await quoteSvc.acceptQuote(bookingId, quoteId, req.user, req.log)
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // PATCH /bookings/:bookingId/quotes/:quoteId/reject — shipper rejects
  app.patch('/:bookingId/quotes/:quoteId/reject', async (req, reply) => {
    const { bookingId: rawBookingId, quoteId: rawQuoteId } = req.params as { bookingId: string; quoteId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const quoteId = parseUuid(reply, rawQuoteId, 'quoteId')
    if (!quoteId) return
    try {
      const quote = await quoteSvc.rejectQuote(bookingId, quoteId, req.user, req.log)
      return reply.send({ success: true, data: quote })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // PATCH /bookings/:bookingId/quotes/:quoteId/withdraw — driver withdraws
  app.patch('/:bookingId/quotes/:quoteId/withdraw', async (req, reply) => {
    const { bookingId: rawBookingId, quoteId: rawQuoteId } = req.params as { bookingId: string; quoteId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const quoteId = parseUuid(reply, rawQuoteId, 'quoteId')
    if (!quoteId) return
    try {
      const quote = await quoteSvc.withdrawQuote(bookingId, quoteId, req.user, req.log)
      return reply.send({ success: true, data: quote })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // GET /bookings/:bookingId/quotes/:quoteId/history — negotiation log
  app.get('/:bookingId/quotes/:quoteId/history', async (req, reply) => {
    const { bookingId: rawBookingId, quoteId: rawQuoteId } = req.params as { bookingId: string; quoteId: string }
    const bookingId = parseUuid(reply, rawBookingId, 'bookingId')
    if (!bookingId) return
    const quoteId = parseUuid(reply, rawQuoteId, 'quoteId')
    if (!quoteId) return
    try {
      const history = await quoteSvc.getQuoteHistory(bookingId, quoteId, req.user)
      return reply.send({ success: true, data: history })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
