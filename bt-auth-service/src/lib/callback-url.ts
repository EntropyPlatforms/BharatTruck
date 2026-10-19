// -----------------------------------------------------------
// callback_url origin allowlist.
//
// /auth/forgot-password lets the caller name the page the emailed reset link lands on,
// because the front-end knows its own origin. Unvalidated, that parameter is an
// unauthenticated account takeover: anyone can POST a victim's address with a callback_url
// pointing at a host they control, and the victim is mailed a REAL single-use password-reset
// token addressed to the attacker's origin. One click and the token is theirs.
//
// zod's .url() does not help — it accepts any absolute URL, including every host on
// the internet and non-http schemes. What decides where the browser actually delivers
// the token is the ORIGIN (protocol + host + port), so that is what we compare, and
// we compare it by equality against a set.
//
// Never by string prefix. Prefix matching is bypassable from both ends:
//   https://evil.example/?next=https://app.bharattruck.in   — allowed value as a suffix
//   https://app.bharattruck.in.evil.example/auth/callback   — allowed value as a prefix
//   https://app.bharattruck.in@evil.example/auth/callback   — allowed value as userinfo
// new URL() resolves all three to the attacker's origin; a startsWith() check does not.
// -----------------------------------------------------------

type Env = Record<string, string | undefined>

/**
 * Hosts allowed to be reached over plain http.
 *
 * Everywhere else must be https — an emailed token travelling over cleartext is
 * readable by anyone on the path, which defeats the point of it being single-use.
 * Loopback is the exception because the default link env vars are themselves
 * http://localhost, and dev has no certificate.
 */
function isLoopback(hostname: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal, so match both spellings.
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** The origin `raw` would deliver a token to, or null if it may never receive one. */
function deliverableOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // javascript:, data: and custom app schemes all parse, and their `origin` is the
  // opaque "null" — which would sail through a set lookup if "null" ever got in.
  // Only a page fetched over http(s) can complete one of these flows anyway.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return null
  return url.origin
}

/**
 * The set of origins an emailed link may point at.
 *
 * `bases` are the reset URLs this service would pick on its own (PASSWORD_RESET_URL, or
 * the per-role *_RESET_PASSWORD_URL fallback and its default) — deriving the allowlist
 * from them means it cannot drift from the deployment: an origin we are already willing to
 * email unprompted is an origin a caller may ask for by name.
 *
 * ALLOWED_CALLBACK_ORIGINS adds origins that have no reset env var of their own yet —
 * the unified app serves all three personas from a single origin.
 *
 * Entries that fail the http(s)/https rule are dropped rather than throwing: a
 * mistyped env var must not take sign-in down, and dropping it only ever narrows
 * what is accepted.
 */
export function callbackOriginAllowlist(bases: Iterable<string>, env: Env = process.env): ReadonlySet<string> {
  const origins = new Set<string>()

  for (const base of bases) {
    const origin = deliverableOrigin(base)
    if (origin) origins.add(origin)
  }

  for (const entry of (env.ALLOWED_CALLBACK_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const origin = deliverableOrigin(trimmed)
    if (origin) origins.add(origin)
  }

  return origins
}

/** True when `raw` is an http(s) URL whose origin is on the allowlist. */
export function isAllowedCallbackUrl(raw: string, allowed: ReadonlySet<string>): boolean {
  const origin = deliverableOrigin(raw)
  return origin !== null && allowed.has(origin)
}
