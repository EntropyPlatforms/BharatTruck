import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import internalAuthPlugin from './plugins/internal-auth.js'
import { pricingRoutes } from './routes/pricing.js'
import { internalPricingRoutes } from './routes/internal.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, { origin: true })

  // Health check — no auth required
  app.get('/health', () => ({ status: 'ok', service: 'bt-pricing-service', version: 'v1-static+cto-breakdown', ts: new Date().toISOString() }))

  // JWT-gated public pricing (P1 #11). Mounted under /pricing so the gateway
  // rewrite (/api/pricing/(.*) -> /pricing/$1) reaches POST /pricing/quote.
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    await authed.register(pricingRoutes, { prefix: '/pricing' })
  })

  // Internal service-to-service routes (shared-secret gated, not gateway-exposed).
  // bt-booking-service reads + consumes the price-lock here.
  await app.register(async (internal) => {
    await internal.register(internalAuthPlugin)
    await internal.register(internalPricingRoutes, { prefix: '/internal' })
  })

  await app.listen({ port: Number(process.env.PORT ?? 3003), host: '0.0.0.0' })
}

bootstrap().catch(err => { console.error(err); process.exit(1) })
