/**
 * Read a positive-integer tunable from the environment, falling back on anything that is not a
 * usable positive number — crucially an EMPTY STRING, which `Number('')` coerces to 0. The old
 * `Number(process.env.X ?? default)` only substituted the default for null/undefined, so a
 * Cloud Run var that was set-but-EMPTY became 0: a zero route-cache TTL makes Redis reject `EX 0`
 * (route/track 500), a zero diesel price prints ₹0 fuel, and a zero speed limit flags every moving
 * truck as speeding. `??` never caught these because '' is neither null nor undefined. Review F27.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
