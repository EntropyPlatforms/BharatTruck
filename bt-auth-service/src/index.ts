import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { supabasePlugin } from './plugins/supabase.js'
import { redisPlugin } from './plugins/redis.js'
import { authRoutes } from './routes/auth.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { onboardingOcrRoutes } from './routes/onboarding-ocr.js'
import { kycRoutes } from './routes/kyc.js'
import { identityRoutes } from './routes/identity.js'
import { consigneeClaimRoutes, consigneeInternalRoutes } from './routes/consignee.js'
import { getSmsProvider } from './lib/sms.js'
import { getKycProvider } from './modules/kyc/provider.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function bootstrap() {
  // Resolve the SMS provider here, not on the first OTP: whether phone codes are
  // being delivered or merely logged is startup information. An operator must
  // learn it from the boot banner, not from a user who never got their code.
  getSmsProvider()
  // Same reasoning for KYC: whether identity documents are verified against a vendor or recorded
  // for manual review is startup information, announced once here rather than on the first verify.
  getKycProvider()

  await app.register(cors, { origin: true })
  await app.register(supabasePlugin)
  await app.register(redisPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  // Consignee claim completion lives under /auth so it routes through the existing gateway
  // /api/auth/ block (D-35); it is its own plugin to keep the claim flow off the auth surface's
  // internals. The internal invite emitter is service-to-service only (secret-gated, /internal).
  await app.register(consigneeClaimRoutes, { prefix: '/auth' })
  await app.register(consigneeInternalRoutes, { prefix: '/internal' })
  await app.register(onboardingRoutes, { prefix: '/onboarding' })
  // Scan a licence / cheque to fill the onboarding forms. Off until DOCAI_OCR_PROCESSOR_ID is set.
  await app.register(onboardingOcrRoutes, { prefix: '/onboarding' })
  await app.register(kycRoutes, { prefix: '/kyc' })
  // Identity-lifecycle: in-app profile creation (D-32), the completeness ring (D-33), acknowledgements
  // (D-31). Registered at the root so the paths are exactly /drivers/me, /fleet-owners/me, /me/*.
  await app.register(identityRoutes)
  app.get('/health', () => ({ status: 'ok', service: 'bt-auth-service', ts: new Date().toISOString() }))
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })
}

bootstrap().catch(err => { console.error(err); process.exit(1) })
