// -----------------------------------------------------------
// credentials — the shipper's e-way bill PORTAL API login (migration 0040,
// eway_portal_credentials). A taxpayer creates an "API user" on ewaybillgst.gov.in (a
// username + password distinct from their portal login) and registers the GSP — Sandbox —
// against it. We hold that username and password so the app can generate bills in their
// name; the password is stored AES-256-GCM encrypted under EWB_CREDENTIALS_KEY and is
// never returned by any route.
// -----------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { supabase } from '../supabase.js'
import { EwbError } from './nic.js'

const TABLE = 'eway_portal_credentials'

function key(): Buffer {
  const hex = (process.env.EWB_CREDENTIALS_KEY ?? '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new EwbError('E-way bill portal credentials cannot be stored: EWB_CREDENTIALS_KEY (32-byte hex) is not set', 503, 'NOT_CONFIGURED')
  }
  return Buffer.from(hex, 'hex')
}

export const credentialsStorageConfigured = () => /^[0-9a-fA-F]{64}$/.test((process.env.EWB_CREDENTIALS_KEY ?? '').trim())

/** iv:tag:ciphertext, all base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(':')
  if (!iv || !tag || !enc) throw new EwbError('Stored portal password is unreadable — enter it again in Settings', 500, 'INTERNAL')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8')
}

export type PortalCredentials = { gstin: string; username: string; password: string }
export type PortalCredentialsView = { configured: boolean; gstin: string | null; username: string | null; updated_at: string | null }

export async function getCredentials(userId: string): Promise<PortalCredentials | null> {
  const { data, error } = await supabase.from(TABLE).select('gstin, username, password_enc').eq('user_id', userId).maybeSingle()
  if (error) {
    if ((error as { code?: string }).code === '42P01') throw new EwbError('E-way bill portal credentials need migration 0040', 503, 'NOT_MIGRATED')
    throw new EwbError(`portal credentials read failed: ${error.message}`, 500, 'INTERNAL')
  }
  if (!data) return null
  const row = data as { gstin: string; username: string; password_enc: string }
  return { gstin: row.gstin, username: row.username, password: decryptSecret(row.password_enc) }
}

export async function getCredentialsView(userId: string): Promise<PortalCredentialsView> {
  const { data, error } = await supabase.from(TABLE).select('gstin, username, updated_at').eq('user_id', userId).maybeSingle()
  if (error) {
    if ((error as { code?: string }).code === '42P01') return { configured: false, gstin: null, username: null, updated_at: null }
    throw new EwbError(`portal credentials read failed: ${error.message}`, 500, 'INTERNAL')
  }
  const row = data as { gstin: string; username: string; updated_at: string } | null
  return row ? { configured: true, gstin: row.gstin, username: row.username, updated_at: row.updated_at } : { configured: false, gstin: null, username: null, updated_at: null }
}

export async function saveCredentials(userId: string, creds: PortalCredentials): Promise<void> {
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, gstin: creds.gstin, username: creds.username, password_enc: encryptSecret(creds.password), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
  if (error) {
    if ((error as { code?: string }).code === '42P01') throw new EwbError('E-way bill portal credentials need migration 0040', 503, 'NOT_MIGRATED')
    throw new EwbError(`portal credentials save failed: ${error.message}`, 500, 'INTERNAL')
  }
}

export async function deleteCredentials(userId: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('user_id', userId)
  if (error && (error as { code?: string }).code !== '42P01') throw new EwbError(`portal credentials delete failed: ${error.message}`, 500, 'INTERNAL')
}
