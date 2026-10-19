'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  getToken, setToken as saveToken, clearToken,
  getRefreshToken, setRefreshToken as saveRefreshToken, clearRefreshToken,
  getMe, refreshAccessToken,
} from './api'
import type { AuthUser, Capability, MeResponse, PersonaSnapshot } from './types'

type AuthContextType = {
  token: string | null
  user: AuthUser | null
  /**
   * What this human MAY DO, computed server-side from their assets (GET /auth/me →
   * personas.capabilities). The shell gates every surface on these, never on `role`.
   * `null` means "not resolved yet" (still loading, or the server could not answer);
   * an empty array is never a real answer because everyone has at least `ship`.
   */
  capabilities: Capability[] | null
  /**
   * The full persona snapshot from /auth/me — the asset counts + ids the emergence CTAs
   * read (owned_vehicle_count, held_driver_count, fleet_owner_id). null until resolved, or
   * when the server could not resolve personas (the capability fallback still gates the shell).
   */
  personas: PersonaSnapshot | null
  isReady: boolean
  login: (accessToken: string, refreshToken: string, user?: AuthUser) => void
  logout: () => void
  /**
   * Re-pull /auth/me so a persona change (e.g. the user JUST became a fleet owner via an
   * emergence CTA) is reflected without a full reload — the counts and capabilities update
   * and any surface reading them re-evaluates.
   */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  token: null, user: null, capabilities: null, personas: null, isReady: false,
  login: () => {}, logout: () => {}, refresh: async () => {},
})

/**
 * Capabilities to fall back to when the server could NOT resolve them (personas is
 * null — e.g. the 0022 identity columns are not applied on the database this build
 * talks to). Absence is not "this human may do nothing": blanking the UI on a
 * transient resolver error would lock a fleet owner out of a working console. We
 * derive a safe set from the primary persona so the shell still gates sensibly, and
 * it is replaced by the authoritative set the moment /auth/me answers.
 *
 * This is the ONLY place `role` influences the shell, and only as a degraded
 * fallback — the authoritative source is always personas.capabilities.
 */
function fallbackCapabilities(role: AuthUser['role']): Capability[] {
  switch (role) {
    case 'fleet_owner': return ['ship', 'carry', 'operate']
    case 'driver':      return ['ship', 'drive']
    case 'admin':       return ['ship', 'drive', 'carry', 'operate']
    case 'shipper':
    default:            return ['ship']
  }
}

function capabilitiesFrom(res: MeResponse): Capability[] {
  return res.personas ? res.personas.capabilities : fallbackCapabilities(res.user.role)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null)
  const [personas, setPersonas] = useState<PersonaSnapshot | null>(null)
  const [isReady, setIsReady] = useState(false)

  // Pull the profile AND capabilities in one /auth/me call. Used both on cold load
  // (a stored token) and right after login (the login response carries the user but
  // NOT capabilities, so the nav would render ungated until this runs).
  async function loadProfile() {
    const res = await getMe()
    setUser(res.user)
    setCapabilities(capabilitiesFrom(res))
    setPersonas(res.personas)
  }

  useEffect(() => {
    async function init() {
      const stored = getToken()
      if (!stored) { setIsReady(true); return }
      setTokenState(stored)

      try {
        await loadProfile()
      } catch {
        const rt = getRefreshToken()
        if (rt) {
          try {
            const { access_token } = await refreshAccessToken(rt)
            saveToken(access_token)
            setTokenState(access_token)
            await loadProfile()
          } catch {
            clearToken(); clearRefreshToken(); setTokenState(null)
          }
        } else {
          clearToken(); setTokenState(null)
        }
      }
      setIsReady(true)
    }
    init()
  }, [])

  function login(accessToken: string, refreshToken: string, userData?: AuthUser) {
    saveToken(accessToken)
    if (refreshToken) saveRefreshToken(refreshToken)
    setTokenState(accessToken)
    if (userData) setUser(userData)
    // Capabilities are not in the login response — fetch them so the nav gates on the
    // real set rather than the login user's role. Best-effort: a failure here leaves
    // capabilities null and the shell shows only the always-on surfaces until the next
    // /auth/me succeeds.
    loadProfile().catch(() => {})
  }

  function logout() {
    clearToken(); clearRefreshToken()
    setTokenState(null); setUser(null); setCapabilities(null); setPersonas(null)
  }

  return (
    <AuthContext.Provider value={{ token, user, capabilities, personas, isReady, login, logout, refresh: loadProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() { return useContext(AuthContext) }
