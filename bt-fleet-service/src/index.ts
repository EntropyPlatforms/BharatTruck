import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import internalAuthPlugin from './plugins/internal-auth.js'
import { ownerRoutes } from './routes/owners.js'
import { driverRoutes } from './routes/drivers.js'
import { vehicleRoutes } from './routes/vehicles.js'
import { assignmentRoutes } from './routes/assignment.js'
import { auctionRoutes } from './routes/auctions.js'
import { analyticsRoutes } from './routes/analytics.js'
import { internalFleetRoutes } from './routes/internal.js'
import { FleetError } from './lib/types.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  },
})

// One error boundary for the whole service: routes throw FleetError and every
// handler emits the same {success,error,code} envelope. Anything else is a bug and
// becomes a logged 500 with no internals leaked to the caller.
app.setErrorHandler((err, req, reply) => {
  if (err instanceof FleetError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  // Fastify's own client-side failures (malformed JSON, unsupported media type).
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.status(err.statusCode).send({ success: false, error: err.message, code: 'VALIDATION_ERROR' })
  }
  req.log.error(err, 'Unhandled error in bt-fleet-service')
  return reply.status(500).send({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' })
})

app.setNotFoundHandler((req, reply) =>
  reply.status(404).send({ success: false, error: `Route ${req.method} ${req.url} not found`, code: 'NOT_FOUND' }),
)

async function bootstrap() {
  await app.register(cors, { origin: true })

  // Health check — no auth required.
  app.get('/health', () => ({
    status: 'ok', service: 'bt-fleet-service', version: 'v1-fleet-owner', ts: new Date().toISOString(),
  }))

  // JWT-gated fleet API. Mounted under /fleet so the gateway rewrite
  // (/api/fleet/(.*) -> /fleet/$1) reaches these paths unchanged.
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(async (fleet) => {
      await fleet.register(ownerRoutes,      { prefix: '/owners' })
      await fleet.register(driverRoutes,     { prefix: '/drivers' })
      await fleet.register(vehicleRoutes,    { prefix: '/vehicles' })
      await fleet.register(analyticsRoutes,  { prefix: '/analytics' })
      // Bookings, the assign step and the live map sit at the /fleet root.
      // Unprefixed, alongside assignmentRoutes: both own /fleet-level paths
      // (/fleet/auctions, /fleet/bids, /fleet/live, /fleet/bookings).
      await fleet.register(auctionRoutes)
      await fleet.register(assignmentRoutes)
    }, { prefix: '/fleet' })
  })

  // Internal service-to-service routes (shared-secret gated, not gateway-exposed).
  await app.register(async (internal) => {
    await internal.register(internalAuthPlugin)
    await internal.register(internalFleetRoutes, { prefix: '/internal' })
  })

  await app.listen({ port: Number(process.env.PORT ?? 3007), host: '0.0.0.0' })
}

bootstrap().catch(err => { console.error(err); process.exit(1) })
