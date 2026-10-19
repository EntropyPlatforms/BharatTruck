import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { podRoutes } from './routes/pod.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, { origin: true })
  // /cargo/shipments removed (review F28): the multi-leg shipment + merkle/blockchain ledger is OUT
  // of MVP, and its handlers were an UNAUTHENTICATED stub that fabricated success and executed
  // out-of-scope chain code, reachable through the public gateway. The real POD path is /cargo/pod
  // (receiver-OTP). Re-add behind auth when the ledger feature is actually built.
  await app.register(podRoutes, { prefix: '/cargo/pod' })
  app.get('/health', () => ({
    status: 'ok',
    service: 'bt-cargo-ledger',
    blockchain_enabled: process.env.BLOCKCHAIN_ENABLED === 'true',
    ts: new Date().toISOString(),
  }))
  await app.listen({ port: Number(process.env.PORT ?? 3005), host: '0.0.0.0' })
}

bootstrap().catch(err => { console.error(err); process.exit(1) })
