import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance { redis: Redis }
}

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const masked = url.replace(/:\/\/.*@/, '://***@')
  app.log.info(`Redis connecting to: ${masked}`)

  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    family: 4,
    tls: url.startsWith('rediss://') ? {} : undefined,
    retryStrategy(times) {
      if (times > 5) return null
      return Math.min(times * 200, 2000)
    },
  })

  redis.on('error', (err) => app.log.error(`Redis error: ${err.message}`))

  await redis.connect()
  app.decorate('redis', redis)
  app.addHook('onClose', async () => { await redis.quit() })
  app.log.info('Redis connected')
})
