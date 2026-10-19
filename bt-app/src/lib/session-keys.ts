/**
 * FB-10 — QA multi-account partition for the same app in one browser.
 *
 * Default (no `?profile=`): unchanged keys (`{base}`), single-account users unaffected.
 * QA: open `/login?profile=alice` and `/login?profile=bob` in two windows. The active
 * profile is remembered in sessionStorage for this tab so navigations without the
 * query param keep the same partition.
 */
const PROFILE_STORAGE_KEY = 'bt_session_profile'

function sanitizeProfile(raw: string | null): string | null {
  if (!raw) return null
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
  return cleaned || null
}

export function resolveSessionProfile(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const fromUrl = sanitizeProfile(new URLSearchParams(window.location.search).get('profile'))
    if (fromUrl) {
      window.sessionStorage.setItem(PROFILE_STORAGE_KEY, fromUrl)
      return fromUrl
    }
    return sanitizeProfile(window.sessionStorage.getItem(PROFILE_STORAGE_KEY))
  } catch {
    return null
  }
}

export function storageKey(base: string): string {
  const profile = resolveSessionProfile()
  return profile ? `${base}__${profile}` : base
}
