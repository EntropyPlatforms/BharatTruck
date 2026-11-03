// Turns a Cloud API webhook body into the few message shapes the bot understands.
// Delivery receipts (`statuses`) and anything that is not a WhatsApp messages change are
// ignored. The payload is untrusted input even after the signature check — every field is
// read defensively.

export type InboundKind = 'text' | 'button' | 'media' | 'other'

export type InboundMessage = {
  /** Meta's message id (wamid…) — the idempotency key; Meta retries deliveries. */
  id: string
  /** Sender's wa_id: country code + number, digits only. */
  from: string
  /** Which of our business numbers it was sent to. */
  phoneNumberId: string | null
  kind: InboundKind
  /** Text body, or the tapped button's title. */
  text: string | null
  /** The tapped button's id (reply buttons, list rows, template quick replies). */
  buttonId: string | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

const MEDIA = new Set(['image', 'document', 'audio', 'video', 'sticker'])

function toMessage(m: unknown, phoneNumberId: string | null): InboundMessage | null {
  if (!isObj(m)) return null
  const id = str(m.id)
  const from = str(m.from)
  const type = str(m.type)
  if (!id || !from || !/^\d{8,15}$/.test(from) || !type) return null
  const base = { id, from, phoneNumberId }

  if (type === 'text') {
    const body = isObj(m.text) ? str(m.text.body) : null
    return { ...base, kind: 'text', text: body, buttonId: null }
  }
  if (type === 'interactive' && isObj(m.interactive)) {
    const reply = isObj(m.interactive.button_reply) ? m.interactive.button_reply
      : isObj(m.interactive.list_reply) ? m.interactive.list_reply : null
    if (reply) return { ...base, kind: 'button', text: str(reply.title), buttonId: str(reply.id) }
  }
  if (type === 'button' && isObj(m.button)) {
    // A quick-reply button on a template message.
    return { ...base, kind: 'button', text: str(m.button.text), buttonId: str(m.button.payload) }
  }
  if (MEDIA.has(type)) return { ...base, kind: 'media', text: null, buttonId: null }
  return { ...base, kind: 'other', text: null, buttonId: null }
}

export function parseWebhook(body: unknown): InboundMessage[] {
  if (!isObj(body) || body.object !== 'whatsapp_business_account') return []
  const out: InboundMessage[] = []
  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue
      const value = change.value
      if (value.messaging_product !== 'whatsapp') continue
      const phoneNumberId = isObj(value.metadata) ? str(value.metadata.phone_number_id) : null
      for (const m of arr(value.messages)) {
        const msg = toMessage(m, phoneNumberId)
        if (msg) out.push(msg)
      }
    }
  }
  return out
}
