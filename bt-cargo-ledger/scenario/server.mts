/**
 * Scenario runner service — the backend of the "Try your own scenario" form on the test
 * portal (bt-quality). One endpoint:
 *
 *   POST /run   { scenario }  →  { success, data: ScenarioResult }
 *
 * It plays the submitted scenario through the scenario engine (./engine.mts): the real
 * booking and delivery-code code on an in-memory database. It holds NO secret and reaches
 * NO live system — there is nothing here to protect except compute — so it is public, with
 * strict input limits and a small per-address rate limit. Deployed by quality.yml as the
 * Cloud Run service `bt-scenario-runner` (max one instance).
 *
 * Run locally: npx tsx scenario/server.mts   (PORT defaults to 8080)
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { z } from 'zod'
import { init, runScenario, type Scenario } from './engine.mjs'

const Place = z.object({
  label: z.string().trim().min(2).max(60),
  lat: z.number().min(6).max(37.5),      // India's bounding box
  lng: z.number().min(68).max(97.5),
  state_code: z.string().regex(/^\d{2}$/),
})
const ScenarioBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  from: Place,
  to: Place,
  weight_kg: z.number().positive().max(60_000),
  vehicle_type: z.enum(['mini_truck', 'lcv', 'hcv', 'trailer']),
  load_type: z.string().trim().min(1).max(40).default('general'),
  quoted_price: z.number().int().positive().max(5_000_000),
  consignment_value_inr: z.number().nonnegative().max(100_000_000),
  receiver: z.object({
    name: z.string().trim().min(2).max(60),
    phone: z.string().regex(/^[6-9]\d{9}$/, 'a 10-digit Indian mobile number'),
    email: z.string().email().max(120),
  }),
  bids: z.array(z.object({
    carrier: z.string().trim().min(2).max(40),
    amount: z.number().int().positive().max(5_000_000),
  })).min(1).max(6),
}).refine(s => new Set(s.bids.map(b => b.carrier.toLowerCase())).size === s.bids.length, { message: 'Each carrier can bid once — carrier names must be different', path: ['bids'] })
  .refine(s => s.from.label !== s.to.label, { message: 'Pickup and drop must be different places', path: ['to'] })

// Small fixed-window limit per address: this is a demo endpoint, not an API.
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 12
const hits = new Map<string, { n: number; reset: number }>()
function allowed(ip: string): boolean {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + WINDOW_MS }); return true }
  h.n++
  return h.n <= MAX_PER_WINDOW
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k) }, WINDOW_MS).unref()

const app = Fastify({ logger: true, bodyLimit: 16 * 1024, trustProxy: true })
// The portal is a different origin (its own Cloud Run URL); the endpoint is public anyway.
await app.register(cors, { origin: true, methods: ['POST', 'GET'] })

app.get('/health', () => ({ status: 'ok', service: 'bt-scenario-runner', ts: new Date().toISOString() }))

app.post('/run', async (req, reply) => {
  if (!allowed(req.ip)) {
    return reply.status(429).send({ success: false, code: 'RATE_LIMITED', error: 'Too many runs — wait a minute and try again.' })
  }
  const parsed = ScenarioBody.safeParse((req.body as any)?.scenario ?? req.body)
  if (!parsed.success) {
    const issue = parsed.error.errors[0]
    return reply.status(400).send({ success: false, code: 'VALIDATION_ERROR', error: `${issue.path.join('.') || 'scenario'}: ${issue.message}` })
  }
  const s = parsed.data
  const scenario: Scenario = {
    ...s,
    id: 'custom',
    name: s.name ?? `${s.from.label} to ${s.to.label}`,
  }
  try {
    return reply.send({ success: true, data: await runScenario(scenario) })
  } catch (err) {
    req.log.error({ err }, 'scenario run failed')
    return reply.status(500).send({ success: false, code: 'RUN_FAILED', error: 'The scenario could not be played.' })
  }
})

await init()
await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' })
