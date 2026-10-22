// The one seam every WhatsApp message leaves through. CloudApiSender talks to Meta's
// Cloud API; tests inject their own WhatsAppSender. The access token never appears in a
// log line or an error message.

import type { WhatsAppConfig } from './config.js'

export type OutboundMessage =
  | { type: 'text'; to: string; body: string }
  | { type: 'buttons'; to: string; body: string; buttons: Array<{ id: string; title: string }> }
  | { type: 'template'; to: string; name: string; language: string; params: string[] }

export interface WhatsAppSender {
  /** Resolves with Meta's message id, or throws WhatsAppSendError. */
  send(message: OutboundMessage): Promise<{ id: string | null }>
}

export class WhatsAppSendError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message)
    this.name = 'WhatsAppSendError'
  }
}

// Cloud API limits: a reply-button title is at most 20 characters, at most 3 buttons, and an
// interactive body at most 1024 characters; a text body at most 4096.
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

// Template parameters may not contain newlines, tabs or long runs of spaces.
export const templateParam = (s: string) => clip(s.replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim() || '-', 1000)

/** The exact JSON body for POST /{phone-number-id}/messages. Pure, so it is tested directly. */
export function toCloudApiPayload(m: OutboundMessage): Record<string, unknown> {
  const head = { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.to }
  switch (m.type) {
    case 'text':
      return { ...head, type: 'text', text: { preview_url: true, body: clip(m.body, 4096) } }
    case 'buttons':
      return {
        ...head,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clip(m.body, 1024) },
          action: {
            buttons: m.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })),
          },
        },
      }
    case 'template':
      return {
        ...head,
        type: 'template',
        template: {
          name: m.name,
          language: { code: m.language },
          components: [{ type: 'body', parameters: m.params.map((p) => ({ type: 'text', text: templateParam(p) })) }],
        },
      }
  }
}

const SEND_TIMEOUT_MS = 10_000

export class CloudApiSender implements WhatsAppSender {
  constructor(private readonly config: WhatsAppConfig) {}

  async send(message: OutboundMessage): Promise<{ id: string | null }> {
    const url = `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toCloudApiPayload(message)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch (err) {
      throw new WhatsAppSendError(`WhatsApp send failed: ${(err as Error).name}`, null, true)
    }
    const json = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } }
      | null
    if (!res.ok) {
      const detail = json?.error?.message ?? `HTTP ${res.status}`
      // 429 and 5xx are worth retrying; a 4xx (bad template, number not on WhatsApp) is not.
      throw new WhatsAppSendError(`WhatsApp send refused: ${detail}`, res.status, res.status === 429 || res.status >= 500)
    }
    return { id: json?.messages?.[0]?.id ?? null }
  }
}
