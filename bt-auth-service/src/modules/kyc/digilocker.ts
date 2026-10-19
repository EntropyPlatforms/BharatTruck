// -----------------------------------------------------------
// digilocker — pull a driver's DRIVING LICENCE (Sarathi) and Aadhaar-backed identity from
// DigiLocker, with the driver's consent, through Sandbox's DigiLocker session APIs.
//
// Why this and not "an mParivahan API": MoRTH exposes no API to private companies; DigiLocker
// is the sanctioned way a citizen shares their Sarathi record with a service. (Vahan RC is NOT
// among the documents Sandbox's DigiLocker offers — only aadhaar, pan, driving_license — so a
// truck's RC still goes through the RC verification seam or ops review.)
//
// Flow (three calls, the middle one is the driver in DigiLocker's own pages):
//   1. start   POST /kyc/digilocker/sessions/init  -> {session_id, authorization_url}
//              The session is pinned to the signed-in user in Redis, so only they can finish it.
//   2. the app sends the driver to authorization_url; DigiLocker returns them to redirect_url.
//   3. status  GET  …/sessions/{id}/status          -> created | succeeded | expired | failed
//      import  GET  …/sessions/{id}/user/profile     -> name, dob, gender (Aadhaar-backed)
//              GET  …/sessions/{id}/documents/driving_license -> issuer XML (presigned URL)
//
// What is kept: the licence fields on driver_licenses (status 'verified'), the user_kyc entry
// (status + DigiLocker id as the reference), and nothing else — no Aadhaar number (DigiLocker
// never hands it over in this flow), no XML, no files.
// -----------------------------------------------------------

import type { Redis } from 'ioredis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sandbox, SandboxClient, SandboxError } from '../../lib/sandbox.js'
import { parseDigiLockerDl, type DigiLockerDl } from './digilocker-dl.js'
import { upsertVerification } from './repository.js'
import { KYCLevel, KYCStatus, type KYCResult } from './types.js'

export type DigiLockerDocType = 'driving_license' | 'aadhaar' | 'pan'

export class DigiLockerError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code: string) {
    super(message)
    this.name = 'DigiLockerError'
  }
}

const SESSION_TTL_S = 24 * 60 * 60
const sessionKey = (id: string) => `digilocker:session:${id}`

export type DigiLockerDeps = {
  client?: SandboxClient
  redis: Redis
  supabase: SupabaseClient
  /** Fetches the presigned document URL. Injected so tests never touch S3. */
  fetchText?: (url: string) => Promise<string>
}

function requireClient(client: SandboxClient) {
  if (!client.configured) {
    throw new DigiLockerError('DigiLocker is not switched on (SANDBOX_API_KEY / SANDBOX_API_SECRET)', 503, 'NOT_CONFIGURED')
  }
}

export async function startSession(
  userId: string,
  args: { doc_types: DigiLockerDocType[]; redirect_url: string; mobile?: string | null },
  deps: DigiLockerDeps,
): Promise<{ session_id: string; authorization_url: string }> {
  const client = deps.client ?? sandbox
  requireClient(client)
  let res
  try {
    res = await client.post<{ session_id?: string; authorization_url?: string }>('/kyc/digilocker/sessions/init', {
      '@entity': 'in.co.sandbox.kyc.digilocker.session.request',
      flow: 'signin',
      redirect_url: args.redirect_url,
      doc_types: args.doc_types,
      options: { pinless: true, ...(args.mobile && /^[6-9]\d{9}$/.test(args.mobile) ? { verified_mobile: args.mobile } : {}) },
      consent_expiry: Date.now() + 2 * 60 * 60 * 1000,
    })
  } catch (err) {
    throw new DigiLockerError(
      err instanceof SandboxError ? `DigiLocker could not start a session (${err.message})` : 'DigiLocker could not start a session',
      502,
      'UPSTREAM',
    )
  }
  const session_id = res.data?.session_id
  const authorization_url = res.data?.authorization_url
  if (!session_id || !authorization_url) throw new DigiLockerError('DigiLocker returned no session', 502, 'UPSTREAM')
  await deps.redis.set(sessionKey(session_id), userId, 'EX', SESSION_TTL_S)
  return { session_id, authorization_url }
}

/** The user a session belongs to — 404 for a session we did not start or that has expired. */
async function requireOwner(sessionId: string, userId: string, redis: Redis): Promise<void> {
  const owner = await redis.get(sessionKey(sessionId))
  if (!owner) throw new DigiLockerError('That DigiLocker session is not known or has expired — start again', 404, 'NOT_FOUND')
  if (owner !== userId) throw new DigiLockerError('That DigiLocker session belongs to another account', 403, 'FORBIDDEN')
}

export type SessionStatus = 'created' | 'succeeded' | 'expired' | 'failed'

export async function sessionStatus(
  sessionId: string,
  userId: string,
  deps: DigiLockerDeps,
): Promise<{ status: SessionStatus; documents_consented: DigiLockerDocType[] }> {
  const client = deps.client ?? sandbox
  requireClient(client)
  await requireOwner(sessionId, userId, deps.redis)
  const res = await client.get<{ status?: string; documents_consented?: string[] }>(`/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/status`)
  const status = (res.data?.status ?? 'failed') as SessionStatus
  return { status, documents_consented: (res.data?.documents_consented ?? []) as DigiLockerDocType[] }
}

export type ImportResult = {
  profile: { name: string | null; date_of_birth: string | null; gender: string | null } | null
  licence: DigiLockerDl | null
  /** What changed on the driver's record. */
  applied: { licence_saved: boolean; aadhaar_recorded: boolean }
  warnings: string[]
}

const defaultFetchText = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`document download ${r.status}`)
  return r.text()
}

/**
 * Finish a consented session: read the profile and the licence, write the licence onto the
 * driver's record as VERIFIED, record the KYC entries. Idempotent — running it twice rewrites
 * the same facts.
 */
export async function importSession(sessionId: string, userId: string, deps: DigiLockerDeps): Promise<ImportResult> {
  const client = deps.client ?? sandbox
  requireClient(client)
  await requireOwner(sessionId, userId, deps.redis)
  const fetchText = deps.fetchText ?? defaultFetchText

  const status = await sessionStatus(sessionId, userId, deps)
  if (status.status !== 'succeeded') {
    throw new DigiLockerError(
      status.status === 'created' ? 'DigiLocker consent has not been completed yet' : 'The DigiLocker session has expired or failed — start again',
      409,
      'SESSION_NOT_READY',
    )
  }

  const warnings: string[] = []
  const result: ImportResult = { profile: null, licence: null, applied: { licence_saved: false, aadhaar_recorded: false }, warnings }

  // Profile — DigiLocker's own identity (Aadhaar-backed when eaadhaar is true).
  try {
    const p = await client.get<{ id?: string; name?: string; date_of_birth?: number | string; gender?: string; eaadhaar?: boolean }>(
      `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/user/profile`,
    )
    const dob = p.data?.date_of_birth
    result.profile = {
      name: typeof p.data?.name === 'string' ? p.data.name.trim() : null,
      date_of_birth: typeof dob === 'number' ? new Date(dob).toISOString().slice(0, 10) : typeof dob === 'string' ? dob.slice(0, 10) : null,
      gender: typeof p.data?.gender === 'string' ? p.data.gender : null,
    }
    if (status.documents_consented.includes('aadhaar') || p.data?.eaadhaar) {
      const r: KYCResult = { status: KYCStatus.Success, kyc_level: KYCLevel.L0, provider_ref: `digilocker:${p.data?.id ?? sessionId}`, raw_response: null, verified_at: new Date() }
      await upsertVerification(deps.supabase, userId, 'DRIVER', 'aadhaar', r)
      result.applied.aadhaar_recorded = true
    }
  } catch (err) {
    warnings.push(`Profile could not be read (${err instanceof Error ? err.message : 'error'})`)
  }

  // Licence — the issuer XML, parsed, written as verified.
  if (status.documents_consented.includes('driving_license')) {
    try {
      const doc = await client.get<{ files?: Array<{ url?: string; metadata?: { ContentType?: string; issuer?: string } }> }>(
        `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/documents/driving_license`,
      )
      const file = doc.data?.files?.find((f) => typeof f.url === 'string')
      if (!file?.url) throw new Error('no licence file in DigiLocker')
      const xml = await fetchText(file.url)
      const licence = parseDigiLockerDl(xml)
      if (!licence.issuing_authority && file.metadata?.issuer) licence.issuing_authority = file.metadata.issuer
      result.licence = licence
      if (!licence.dl_number) {
        warnings.push('The licence document had no readable licence number')
      } else {
        await saveVerifiedLicence(userId, licence, deps.supabase)
        const r: KYCResult = { status: KYCStatus.Success, kyc_level: KYCLevel.L0, provider_ref: `digilocker:${sessionId}`, raw_response: null, verified_at: new Date() }
        await upsertVerification(deps.supabase, userId, 'DRIVER', 'dl', r)
        result.applied.licence_saved = true
      }
    } catch (err) {
      if (err instanceof DigiLockerError) throw err
      warnings.push(`Licence could not be read (${err instanceof Error ? err.message : 'error'})`)
    }
  }

  return result
}

/** driver_licenses: insert or overwrite the driver's row with the issuer's record, status 'verified'. */
async function saveVerifiedLicence(userId: string, licence: DigiLockerDl, supabase: SupabaseClient): Promise<void> {
  const { data: driver, error: dErr } = await supabase.from('drivers').select('id').eq('user_id', userId).maybeSingle()
  if (dErr) throw new Error(`drivers read failed: ${dErr.message}`)
  const driverId = (driver as { id?: string } | null)?.id
  if (!driverId) throw new DigiLockerError('Become a driver first — there is no driver record to attach the licence to', 409, 'NO_DRIVER')

  // A licence number already on another driver's row is a hard stop, as in POST /onboarding/license.
  const { data: dup } = await supabase.from('driver_licenses').select('driver_id').eq('dl_number', licence.dl_number!).neq('driver_id', driverId).maybeSingle()
  if (dup) throw new DigiLockerError('This licence is already registered to another driver account', 409, 'DL_TAKEN')

  const row = {
    dl_number: licence.dl_number,
    vehicle_classes: licence.vehicle_classes,
    // A truck driver needs the transport validity when the licence prints one.
    expiry_date: licence.transport_expiry_date ?? licence.expiry_date,
    status: 'verified',
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabase.from('driver_licenses').select('id').eq('driver_id', driverId).maybeSingle()
  if (existing) {
    const { error } = await supabase.from('driver_licenses').update(row).eq('driver_id', driverId)
    if (error) throw new Error(`driver_licenses update failed: ${error.message}`)
  } else {
    const { error } = await supabase.from('driver_licenses').insert({ driver_id: driverId, ...row })
    if (error) throw new Error(`driver_licenses insert failed: ${error.message}`)
  }
}
