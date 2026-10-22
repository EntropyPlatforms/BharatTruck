// Two small guards for the inbound path:
//   - once():   Meta retries a webhook delivery it thinks failed, so the same message id can
//               arrive twice. The bot must answer it once.
//   - allow():  a per-number rate limit, so one chatty (or scripted) sender cannot make the
//               bot hammer the database and the Cloud API.
// Redis in production, memory in tests. Redis is imported lazily: lib/redis.ts connects at
// import time and refuses to load without REDIS_URL, which tests do not have.

export interface InboundGuard {
  /** True the first time a key is seen within ttlSeconds. */
  once(key: string, ttlSeconds: number): Promise<boolean>
  /** True while the key has been hit at most `max` times in the current window. */
  allow(key: string, max: number, windowSeconds: number): Promise<boolean>
}

export function memoryGuard(now: () => number = Date.now): InboundGuard {
  const seen = new Map<string, number>()
  const hits = new Map<string, { count: number; until: number }>()
  return {
    async once(key, ttl) {
      const t = now()
      const exp = seen.get(key)
      if (exp !== undefined && exp > t) return false
      seen.set(key, t + ttl * 1000)
      return true
    },
    async allow(key, max, windowS) {
      const t = now()
      const h = hits.get(key)
      if (!h || h.until <= t) { hits.set(key, { count: 1, until: t + windowS * 1000 }); return true }
      h.count++
      return h.count <= max
    },
  }
}

/**
 * Redis-backed guard. If Redis is unreachable both checks let the message through: a rare
 * double reply is better than a bot that goes silent whenever the cache hiccups.
 */
export function redisGuard(): InboundGuard {
  const client = async () => (await import('../redis.js')).redis
  return {
    async once(key, ttl) {
      try {
        return (await (await client()).set(key, '1', 'EX', ttl, 'NX')) === 'OK'
      } catch { return true }
    },
    async allow(key, max, windowS) {
      try {
        const r = await client()
        const n = await r.incr(key)
        if (n === 1) await r.expire(key, windowS)
        return n <= max
      } catch { return true }
    },
  }
}
