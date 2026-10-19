import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import internalAuthPlugin from './plugins/internal-auth.js'
import { paymentRoutes } from './routes/payments.js'
import { internalPaymentRoutes } from './routes/internal.js'
import { razorpayRoutes, razorpayWebhookRoutes } from './routes/razorpay.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, { origin: true })

  // Health check — no auth required
  app.get('/health', () => ({ status: 'ok', service: 'bt-payment-service', ts: new Date().toISOString() }))

  // JWT-gated money endpoints (P1 #11)
  await app.register(async (authedApp) => {
    await authedApp.register(authPlugin)
    await authedApp.register(paymentRoutes, { prefix: '/payments' })
    await authedApp.register(razorpayRoutes, { prefix: '/payments' })
  })

  // Razorpay webhook — no JWT; authenticated by the signature over the raw body.
  await app.register(razorpayWebhookRoutes, { prefix: '/payments' })

  // Internal service-to-service routes (shared-secret gated, not public)
  await app.register(async (internalApp) => {
    await internalApp.register(internalAuthPlugin)
    await internalApp.register(internalPaymentRoutes, { prefix: '/internal' })
  })

  await app.listen({ port: Number(process.env.PORT ?? 3004), host: '0.0.0.0' })
}

bootstrap().catch(err => { console.error(err); process.exit(1) })
