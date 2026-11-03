// ============================================================
// src/lib/whatsapp/config.ts
//
// The WhatsApp bot is OFF unless every required setting is present — the same
// all-or-nothing rule as the SMS seam (bt-auth-service lib/sms.ts, D-14). A half-set
// deployment must not half-work: a webhook that accepts messages but cannot reply, or
// that replies but cannot verify Meta's signature, is worse than a clean 503.
//
//   WHATSAPP_ACCESS_TOKEN      Cloud API token (secret) — sends messages
//   WHATSAPP_PHONE_NUMBER_ID   the business number's id in the Cloud API
//   WHATSAPP_APP_SECRET        Meta app secret (secret) — verifies X-Hub-Signature-256
//   WHATSAPP_VERIFY_TOKEN      our own string, echoed by Meta once when the webhook is set up
//
// Optional:
//   WHATSAPP_ALERT_TEMPLATE    approved template name for alerts sent OUTSIDE the 24-hour
//                              window (business-initiated). Unset: those alerts are skipped.
//   WHATSAPP_TEMPLATE_LANGUAGE template language code (default en)
//   WHATSAPP_GRAPH_VERSION     Graph API version (default v23.0)
//   SUPPORT_EMAIL              shown when someone asks for a person
// ============================================================

export const WHATSAPP_REQUIRED_ENV = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const

export type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  appSecret: string
  verifyToken: string
  graphVersion: string
  alertTemplate: string | null
  templateLanguage: string
  supportEmail: string | null
}

type Env = Record<string, string | undefined>

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

/** The config, or null with the names of what is missing. Reads the environment every call. */
export function resolveWhatsAppConfig(env: Env = process.env): { config: WhatsAppConfig | null; missing: string[] } {
  const missing = WHATSAPP_REQUIRED_ENV.filter((k) => !clean(env[k]))
  if (missing.length > 0) return { config: null, missing: [...missing] }
  return {
    config: {
      accessToken: clean(env.WHATSAPP_ACCESS_TOKEN)!,
      phoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID)!,
      appSecret: clean(env.WHATSAPP_APP_SECRET)!,
      verifyToken: clean(env.WHATSAPP_VERIFY_TOKEN)!,
      graphVersion: clean(env.WHATSAPP_GRAPH_VERSION) ?? 'v23.0',
      alertTemplate: clean(env.WHATSAPP_ALERT_TEMPLATE),
      templateLanguage: clean(env.WHATSAPP_TEMPLATE_LANGUAGE) ?? 'en',
      supportEmail: clean(env.SUPPORT_EMAIL),
    },
    missing: [],
  }
}
