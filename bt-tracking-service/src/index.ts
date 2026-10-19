import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import internalAuthPlugin from './plugins/internal-auth.js'
import { trackingRoutes } from './routes/tracking.js'
import { fleetTrackingRoutes } from './routes/fleet.js'
import { placesRoutes } from './routes/places.js'
import { internalRoutes } from './routes/internal.js'
import { TrackingError } from './lib/types.js'

const app = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, { origin: true })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TrackingError) {
      return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
    }
    req.log.error(err)
    return reply.status(500).send({ success: false, error: 'Internal server error' })
  })

  // Health check — no auth required
  app.get('/health', () => ({ status: 'ok', service: 'bt-tracking-service', ts: new Date().toISOString() }))

  // Auth-gated routes (end-user JWT).
  //
  // Registration order inside the scope matters: the fleet routes go on FIRST so
  // `/tracking/fleet/overview` is matched by its own handler. Registering them after
  // trackingRoutes would let `/tracking/:bookingId`-shaped paths shadow them, and the
  // failure would be a confusing 400 "Invalid bookingId" rather than a clean 404.
  await app.register(async (authedApp) => {
    await authedApp.register(authPlugin)
    await authedApp.register(fleetTrackingRoutes, { prefix: '/tracking/fleet' })
    // Static-prefixed, so it goes on before the `/tracking/:...` handlers for the same reason
    // the fleet routes do — a clean 404/400 beats being shadowed by a bookingId matcher (D-020).
    await authedApp.register(placesRoutes, { prefix: '/tracking/places' })
    await authedApp.register(trackingRoutes, { prefix: '/tracking' })
  })

  // Service-to-service routes (shared secret, never exposed by the gateway). Separate
  // scope so the JWT plugin never runs for them and vice versa.
  await app.register(async (internalApp) => {
    await internalApp.register(internalAuthPlugin)
    await internalApp.register(internalRoutes, { prefix: '/internal' })
  })

  await app.listen({ port: Number(process.env.PORT ?? 3006), host: '0.0.0.0' })
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
