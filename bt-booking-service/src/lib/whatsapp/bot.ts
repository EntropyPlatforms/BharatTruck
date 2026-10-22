// ============================================================
// src/lib/whatsapp/bot.ts — what the bot says. PURE: no database, no network.
//
// Anyone can message the bot first; there is no step in the app. A number that matches an
// account gets a menu (my alerts, my trips, help); any other number gets a short welcome
// and the way in. The bot never asks for documents or identity numbers and turns away
// photos and files — those belong in the app, not in a chat history (WhatsApp's own policy
// forbids collecting sensitive identifiers in chat).
//
// Money: trip lines carry no prices or phone numbers. Alert lines carry only what that
// person's alert already says — and an alert raised for a hired driver never names an
// amount (alerts/rules.ts), so money still follows the truck (§1.1).
// ============================================================

import type { InboundMessage } from './inbound.js'

export type Intent = 'menu' | 'alerts' | 'trips' | 'help' | 'stop' | 'start' | 'media' | 'ship' | 'carry'

export type BotReply =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: Array<{ id: string; title: string }> }

export type AlertLine = { severity: 'critical' | 'warning' | 'info'; title: string; subtitle: string; url: string | null }
export type TripLine = { lane: string; status: string; url: string | null }

export type Turn = {
  /** The matched account, or null for a number that is on no account. */
  person: { firstName: string | null } | null
  /** True on the first menu a matched person sees — the moment alerts are switched on. */
  firstContact: boolean
  base: string | null
  supportEmail: string | null
  alerts?: AlertLine[]
  trips?: TripLine[]
}

export const BUTTON = {
  alerts: 'menu.alerts',
  trips: 'menu.trips',
  help: 'menu.help',
  ship: 'new.ship',
  carry: 'new.carry',
  newHelp: 'new.help',
} as const

const WORDS: Record<string, Intent> = {
  stop: 'stop', unsubscribe: 'stop', 'stop alerts': 'stop',
  start: 'start', subscribe: 'start', 'start alerts': 'start',
  help: 'help', support: 'help',
  alerts: 'alerts', alert: 'alerts', 'my alerts': 'alerts',
  trips: 'trips', trip: 'trips', 'my trips': 'trips', loads: 'trips', 'my loads': 'trips',
}

const BUTTON_INTENT: Record<string, Intent> = {
  [BUTTON.alerts]: 'alerts', [BUTTON.trips]: 'trips', [BUTTON.help]: 'help',
  [BUTTON.ship]: 'ship', [BUTTON.carry]: 'carry', [BUTTON.newHelp]: 'help',
}

export function intentOf(m: InboundMessage): Intent {
  if (m.kind === 'media') return 'media'
  if (m.kind === 'button' && m.buttonId && BUTTON_INTENT[m.buttonId]) return BUTTON_INTENT[m.buttonId]
  const word = (m.text ?? '').trim().toLowerCase().replace(/[!.?]+$/, '')
  return WORDS[word] ?? 'menu'
}

const MORE = 'Send MENU for more options.'
const linkLine = (url: string | null) => (url ? `\n${url}` : '')
const DOT = { critical: '🔴', warning: '🟠', info: '🔵' } as const
const MAX_LINES = 5

function supportLine(t: Turn): string {
  if (t.supportEmail) return `Need a person? Write to ${t.supportEmail}.`
  return t.base ? `Need a person? Open BharatTruck and use Help:\n${t.base}` : 'Need a person? Open the BharatTruck app and use Help.'
}

function knownMenu(t: Turn): BotReply {
  const hi = t.person?.firstName ? `Hi ${t.person.firstName}!` : 'Hi!'
  const notice = t.firstContact
    ? '\n\nCritical alerts about your trips will come here too. Send STOP anytime to turn them off.'
    : ''
  return {
    kind: 'buttons',
    body: `${hi} What would you like to see?${notice}`,
    buttons: [
      { id: BUTTON.alerts, title: 'My alerts' },
      { id: BUTTON.trips, title: 'My trips' },
      { id: BUTTON.help, title: 'Help' },
    ],
  }
}

function newcomerMenu(): BotReply {
  return {
    kind: 'buttons',
    body:
      'Welcome to BharatTruck 🚚\n\n' +
      'We connect shippers with trucks for interstate and local loads, with live tracking and proof of delivery.\n\n' +
      'This WhatsApp number is not on a BharatTruck account yet. What brings you here?',
    buttons: [
      { id: BUTTON.ship, title: 'Ship a load' },
      { id: BUTTON.carry, title: 'I have trucks' },
      { id: BUTTON.newHelp, title: 'Talk to us' },
    ],
  }
}

function alertsReply(t: Turn): BotReply {
  const all = t.alerts ?? []
  if (all.length === 0) return { kind: 'text', body: `No open alerts right now ✅\n\n${MORE}` }
  const lines = all.slice(0, MAX_LINES).map((a) => `${DOT[a.severity]} ${a.title}${a.subtitle ? `\n${a.subtitle}` : ''}${linkLine(a.url)}`)
  const more = all.length > MAX_LINES ? `\n\n+${all.length - MAX_LINES} more in the app${linkLine(t.base ? `${t.base}/home` : null)}` : ''
  return { kind: 'text', body: `Your open alerts:\n\n${lines.join('\n\n')}${more}\n\n${MORE}` }
}

function tripsReply(t: Turn): BotReply {
  const all = t.trips ?? []
  if (all.length === 0) return { kind: 'text', body: `No active trips right now.\n\n${MORE}` }
  const lines = all.slice(0, MAX_LINES).map((x) => `🚚 ${x.lane}\n${x.status}${linkLine(x.url)}`)
  const more = all.length > MAX_LINES ? `\n\n+${all.length - MAX_LINES} more in the app` : ''
  return { kind: 'text', body: `Your trips:\n\n${lines.join('\n\n')}${more}\n\n${MORE}` }
}

export function respond(intent: Intent, t: Turn): BotReply[] {
  const known = t.person !== null
  switch (intent) {
    case 'stop':
      return [{ kind: 'text', body: 'Done. You won’t get alerts here any more. Send START to turn them back on.' }]
    case 'start':
      return [{
        kind: 'text',
        body: known
          ? 'Alerts are back on. Send STOP anytime to turn them off.'
          : 'Got it. Once this number is on a BharatTruck account, your alerts will come here.',
      }]
    case 'media':
      return [{
        kind: 'text',
        body: `Please don’t send documents or photos here. Upload them securely in the BharatTruck app instead.${linkLine(t.base)}\n\n${MORE}`,
      }]
    case 'help':
      return [{
        kind: 'text',
        body: known
          ? `Here’s what you can send me:\n• MENU: your options\n• ALERTS: your open alerts\n• TRIPS: your trips\n• STOP / START: turn alerts off or on\n\n${supportLine(t)}`
          : `${supportLine(t)}\n\n${MORE}`,
      }]
    case 'ship':
      return [{
        kind: 'text',
        body:
          'Post your load in the BharatTruck app. Verified truckers bid on it, and you can follow the truck live.' +
          `${linkLine(t.base ? `${t.base}/post` : null)}\n\n` +
          'Add this mobile number to your profile there, and your updates will come here too.',
      }]
    case 'carry':
      return [{
        kind: 'text',
        body:
          'Add your truck in the BharatTruck app and bid on loads that match your routes.' +
          `${linkLine(t.base)}\n\n` +
          'Add this mobile number to your profile there, and your trip alerts will come here too.',
      }]
    case 'alerts':
      return [known ? alertsReply(t) : newcomerMenu()]
    case 'trips':
      return [known ? tripsReply(t) : newcomerMenu()]
    case 'menu':
      return [known ? knownMenu(t) : newcomerMenu()]
  }
}
