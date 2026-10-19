import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireFleetAccess } from '../lib/fleet-access.js'
import { requireFleetVehicle } from '../lib/vehicles-repo.js'
import {
  fleetSummary,
  fuelComparison,
  perDriverAnalytics,
  perVehicleAnalytics,
  resolvePeriod,
} from '../lib/analytics.js'
import { FleetError, parseOrThrow } from '../lib/types.js'

// -----------------------------------------------------------
// analyticsRoutes — the fleet dashboard (mounted at /fleet/analytics).
// Every number comes from trip_economics; nothing here scans raw bookings or
// location_history at request time.
// -----------------------------------------------------------

const PeriodQuery = z.object({
  from: z.string().datetime({ offset: true, message: 'from must be an ISO-8601 timestamp' }).optional(),
  to: z.string().datetime({ offset: true, message: 'to must be an ISO-8601 timestamp' }).optional(),
})

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /fleet/analytics/summary
  app.get('/summary', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'view_analytics')
    const period = periodOf(req.query)
    return reply.send({ success: true, data: await fleetSummary(owner, period) })
  })

  // GET /fleet/analytics/vehicles — per-asset P&L + EMI coverage + utilization.
  app.get('/vehicles', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'view_analytics')
    const period = periodOf(req.query)
    return reply.send({ success: true, data: { period, vehicles: await perVehicleAnalytics(owner, period) } })
  })

  // GET /fleet/analytics/vehicles/:id
  app.get('/vehicles/:id', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'view_analytics')
    const params = parseOrThrow(IdParam, req.params)
    const period = periodOf(req.query)
    // Re-assert ownership so an id from another fleet 404s rather than returning
    // an empty-but-valid-looking report.
    await requireFleetVehicle(owner.id, params.id)

    const [vehicle] = await perVehicleAnalytics(owner, period, params.id)
    if (!vehicle) throw new FleetError('Vehicle not found in this fleet', 'NOT_FOUND', 404)
    return reply.send({ success: true, data: { period, ...vehicle } })
  })

  // GET /fleet/analytics/drivers
  app.get('/drivers', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'view_analytics')
    const period = periodOf(req.query)
    return reply.send({ success: true, data: { period, drivers: await perDriverAnalytics(owner.id, period) } })
  })

  // GET /fleet/analytics/fuel — modelled vs actual diesel spend.
  app.get('/fuel', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'view_analytics')
    const period = periodOf(req.query)
    return reply.send({ success: true, data: await fuelComparison(owner.id, period) })
  })
}

function periodOf(query: unknown) {
  const parsed = parseOrThrow(PeriodQuery, query)
  const period = resolvePeriod(parsed.from, parsed.to)
  if (new Date(period.from) > new Date(period.to)) {
    throw new FleetError('from must be earlier than to', 'VALIDATION_ERROR', 400)
  }
  return period
}
