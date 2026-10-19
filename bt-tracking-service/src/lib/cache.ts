import { redis, lockKey, LOCK_TTL_SECONDS } from './redis.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Read `key` from Redis; on a miss, acquire a short NX lock and compute.
 * If another worker already holds the lock, briefly poll the cache instead of
 * making a duplicate upstream (Google) call — this is the stampede guard that
 * keeps us to ~1 Routes call per booking even under concurrent viewers.
 */
export async function getOrCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const hit = await redis.get(key)
  if (hit) return { value: JSON.parse(hit) as T, cached: true }

  const lock = lockKey(key)
  const gotLock = await redis.set(lock, '1', 'EX', LOCK_TTL_SECONDS, 'NX')

  if (!gotLock) {
    // Someone else is computing — poll the cache for up to ~3s.
    for (let i = 0; i < 15; i++) {
      await sleep(200)
      const v = await redis.get(key)
      if (v) return { value: JSON.parse(v) as T, cached: true }
    }
    // Fell through (lock holder slow/dead): compute ourselves rather than fail.
  }

  try {
    const value = await compute()
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    return { value, cached: false }
  } finally {
    if (gotLock) await redis.del(lock)
  }
}

/** Force a fresh compute and overwrite the cache (used by POST /route). */
export async function computeAndSet<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const value = await compute()
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  return value
}
