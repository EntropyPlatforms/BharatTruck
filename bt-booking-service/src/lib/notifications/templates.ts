// ============================================================
// src/lib/notifications/templates.ts
//
// Responsibility: turn an outbox row (event_type + payload snapshot) into a
// rendered EmailMessage. This is the ONLY place that knows what a notification
// looks like — producers emit typed events and never touch copy.
//
// Rendering happens at SEND time from the payload captured at EMIT time, so a
// template never re-reads the domain. That is what makes a "you won this load at
// Rs.36,483" email still say Rs.36,483 after the booking is edited, and it keeps
// the dispatcher free of domain queries.
// ============================================================

import {
  EVENT_CATEGORY,
  type EmailMessage,
  type NotificationEvent,
} from '@bharattruck/shared/notifications'

// -----------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------

/**
 * HTML-escape every interpolated value.
 *
 * Payloads carry user-supplied text — shipper names, addresses, negotiation
 * messages. Unescaped, a quote message containing markup would break the layout
 * at best and forge a convincing "click here" phishing block inside a genuine
 * BharatTruck email at worst. Every template below interpolates through `h()`.
 */
function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Plain-text interpolation — no escaping, but nullish becomes empty, never "undefined". */
function t(value: unknown): string {
  return String(value ?? '')
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

/** Indian-grouped rupees, e.g. ₹36,483. Non-numeric input degrades to a dash. */
function money(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? inr.format(n) : '—'
}

/** "Mumbai → Delhi" from the payload's route fields, tolerating either missing. */
function route(p: Payload): string {
  const from = t(p.source_address) || 'pickup'
  const to = t(p.destination_address) || 'drop'
  return `${from} → ${to}`
}

/**
 * "Tue, 4 Aug 2026" from a YYYY-MM-DD pickup_date.
 *
 * A raw `2026-08-04` in a pickup line is the kind of detail that makes an email read
 * as machine output. Anything unparseable is passed through untouched rather than
 * guessed at — a wrong date on a pickup is worse than an ugly one.
 */
function prettyDate(value: unknown): string {
  const raw = t(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return raw
  // en-GB, not en-IN: en-IN renders "Tue, 4 Aug, 2026" with a stray comma before the
  // year. Same day-first order Indian readers expect, without the typo-looking punctuation.
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

/** A short human booking reference. Full UUIDs are unreadable in an email subject. */
function ref(bookingId: unknown): string {
  return String(bookingId ?? '').slice(0, 8).toUpperCase()
}

// -----------------------------------------------------------
// Layout
//
// Table-based with inline styles ON PURPOSE. Outlook's Word rendering engine ignores
// most modern CSS — flexbox and grid silently collapse — and several clients strip
// <style> blocks. So every load-bearing style is inline, and the <style> block in the
// head carries only ENHANCEMENTS (dark mode, mobile bumps) that the design is still
// correct without.
//
// Deliberately image-free. Images are blocked by default in a lot of clients, so a
// wordmark drawn as text always renders — and it keeps the payload small, which
// matters on the patchy mobile data a driver reads this on.
// -----------------------------------------------------------

const BRAND = '#0f766e'
const INK = '#0f172a'
const BODY_INK = '#334155'
const MUTED = '#64748b'
const HAIRLINE = '#e2e8f0'

/**
 * Accent per message tone.
 *
 * Without this a cancellation and a won auction are visually identical, which is a
 * real failure at a glance in a crowded inbox: colour is the first thing read and it
 * should carry the gist. Kept to three so it stays a signal rather than decoration.
 */
export type Tone = 'positive' | 'neutral' | 'attention'

const TONE: Record<Tone, { accent: string; wash: string }> = {
  positive:  { accent: '#0f766e', wash: '#f0fdfa' }, // won, delivered, paid
  neutral:   { accent: '#334155', wash: '#f8fafc' }, // informational
  attention: { accent: '#b45309', wash: '#fffbeb' }, // cancelled, lost, support override
}

type LayoutOptions = {
  heading: string
  bodyHtml: string
  tone: Tone
  /**
   * Inbox preview text. Without it every BharatTruck email previews as the wordmark,
   * so a full inbox reads as sixteen identical rows — the single highest-leverage
   * thing in an email after the subject line.
   */
  preheader: string
  /** The one number that matters, shown large. Money events only. */
  hero?: { label: string; value: string } | null
  /** Primary call-to-action. Omitted when there is nothing useful to open. */
  cta?: { label: string; url: string } | null
  /** Rendered as a one-click unsubscribe footer when the category is opt-out-able. */
  unsubscribeUrl?: string | null
}

function layout({ heading, bodyHtml, tone, preheader, hero, cta, unsubscribeUrl }: LayoutOptions): string {
  const { accent, wash } = TONE[tone]

  const heroBlock = hero
    ? `<tr><td style="padding:0 0 20px 0">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                style="background:${wash};border-radius:8px;border-left:3px solid ${accent}">
           <tr><td style="padding:14px 16px">
             <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};padding-bottom:2px">
               ${h(hero.label)}</div>
             <div style="font-size:26px;font-weight:700;color:${INK};line-height:1.2">${h(hero.value)}</div>
           </td></tr>
         </table></td></tr>`
    : ''

  // Padding sits on the <td>, not the <a>: Outlook desktop drops padding on an inline
  // anchor, which collapses the button to bare underlined text.
  const button = cta
    ? `<tr><td style="padding:4px 0 26px 0">
         <table role="presentation" cellpadding="0" cellspacing="0">
           <tr><td bgcolor="${accent}" style="border-radius:6px">
             <a href="${h(cta.url)}" class="bt-btn"
                style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;
                       color:#ffffff;text-decoration:none;border-radius:6px">${h(cta.label)}</a>
           </td></tr>
         </table></td></tr>`
    : ''

  const optOut = unsubscribeUrl
    ? `<br><a href="${h(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">Unsubscribe from these updates</a>`
    : ''

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!-- Tells Apple Mail / Outlook the design handles both schemes, so they stop
     force-inverting and producing muddy near-unreadable greys. -->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${h(heading)}</title>
<style>
  /* Enhancements only — every rule below is safe to lose. */
  @media (max-width:600px) {
    .bt-card { padding:22px 20px !important; }
    .bt-h1 { font-size:19px !important; }
    .bt-btn { display:block !important; text-align:center !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bt-bg   { background:#0b1220 !important; }
    .bt-card { background:#111a2b !important; }
    .bt-h1, .bt-strong { color:#f1f5f9 !important; }
    .bt-body { color:#cbd5e1 !important; }
    .bt-muted{ color:#94a3b8 !important; }
    .bt-rule { border-color:#1e293b !important; }
    .bt-wash { background:#152033 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9">
<!-- Preheader: shown in the inbox list, never in the opened message. The nbsp run
     stops the client pulling body copy in after it. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${h(preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden">${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bt-bg"
       style="background:#f1f5f9;padding:28px 12px;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bt-card"
           style="max-width:560px;background:#ffffff;border-radius:12px;padding:30px 32px">

      <tr><td class="bt-rule" style="padding-bottom:18px;border-bottom:1px solid ${HAIRLINE}">
        <span style="font-size:17px;font-weight:700;color:${BRAND};letter-spacing:-.01em">Bharat</span><span
              style="font-size:17px;font-weight:700;color:${INK};letter-spacing:-.01em" class="bt-strong">Truck</span>
      </td></tr>

      <tr><td style="padding:24px 0 10px 0">
        <h1 class="bt-h1" style="margin:0;font-size:21px;line-height:1.35;color:${INK};font-weight:700">${h(heading)}</h1>
      </td></tr>

      <tr><td class="bt-body" style="padding:0 0 18px 0;color:${BODY_INK};font-size:15px;line-height:1.6">
        ${bodyHtml}
      </td></tr>

      ${heroBlock}
      ${button}

      <tr><td class="bt-rule" style="border-top:1px solid ${HAIRLINE};padding-top:16px">
        <p class="bt-muted" style="margin:0;color:${MUTED};font-size:12px;line-height:1.6">
          BharatTruck — interstate freight, booked and tracked.<br>
          Entropy LLP, Pune, Maharashtra, India.${optOut}
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`
}

/**
 * The origin → destination block.
 *
 * Given its own treatment rather than a table row because the lane IS the identity of
 * a freight email — it is what the reader uses to work out which of their five live
 * loads this is about, before reading anything else.
 */
function routeBlock(p: Payload): string {
  const from = t(p.source_address) || 'Pickup'
  const to = t(p.destination_address) || 'Drop'
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 4px 0">
    <tr><td style="padding:0 0 4px 0;color:${INK};font-size:15px;font-weight:600" class="bt-strong">${h(from)}</td></tr>
    <tr><td style="padding:0 0 4px 0;color:${MUTED};font-size:13px;line-height:1" class="bt-muted">↓</td></tr>
    <tr><td style="color:${INK};font-size:15px;font-weight:600" class="bt-strong">${h(to)}</td></tr>
  </table>`
}

/** A label/value detail block — the shape almost every template needs. */
function details(rows: Array<[string, string]>): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0 0;font-size:14px">
    ${rows
      .map(
        ([label, value]) =>
          `<tr>
             <td class="bt-muted" style="padding:5px 16px 5px 0;color:${MUTED};white-space:nowrap;vertical-align:top">${h(label)}</td>
             <td class="bt-strong" style="padding:5px 0;color:${INK};font-weight:600;vertical-align:top">${h(value)}</td>
           </tr>`,
      )
      .join('')}
  </table>`
}

/** A quoted message from the other party, set apart from our own copy. */
function quoteBlock(message: unknown): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0 0">
    <tr><td class="bt-wash" style="background:#f8fafc;border-radius:6px;padding:12px 14px;
             color:${BODY_INK};font-size:14px;line-height:1.55;font-style:italic">“${h(message)}”</td></tr>
  </table>`
}

/** Text-mode equivalent of `details`. */
function detailsText(rows: Array<[string, string]>): string {
  return rows.map(([label, value]) => `${label}: ${value}`).join('\n')
}

// -----------------------------------------------------------
// Render context + template contract
// -----------------------------------------------------------

export type Payload = Record<string, unknown>

export type RenderContext = {
  /** Where the shipper app is served, for deep links into a booking. */
  shipperBaseUrl: string | null
  /** Where the driver app is served. */
  driverBaseUrl: string | null
  /** Populated only for opt-out-able categories; drives the footer + List-Unsubscribe. */
  unsubscribeUrl: string | null
}

type Rendered = {
  subject: string
  heading: string
  /** Inbox preview line. Should carry the gist without repeating the subject. */
  preheader: string
  tone: Tone
  /** Body paragraphs, HTML. */
  bodyHtml: string
  /** Body, plain text. */
  bodyText: string
  /** The one number that matters, shown large. Money events only. */
  hero?: { label: string; value: string } | null
  cta?: { label: string; url: string } | null
}

type Template = (p: Payload, ctx: RenderContext) => Rendered

/** Deep link into a booking in whichever app the recipient uses, or null if unconfigured. */
function bookingUrl(base: string | null, bookingId: unknown): string | null {
  if (!base || !bookingId) return null
  return `${base.replace(/\/+$/, '')}/bookings/${String(bookingId)}`
}

// -----------------------------------------------------------
// The catalogue
// -----------------------------------------------------------

const TEMPLATES: Record<NotificationEvent, Template> = {
  // ── Marketplace / auction ────────────────────────────────────

  quote_received: (p, ctx) => {
    const bidder = t(p.bidder_name) || 'A carrier'
    const rows: Array<[string, string]> = [
      ['Load', t(p.load_type) || '—'],
      ['Pickup', prettyDate(p.pickup_date) || 'See booking'],
      ['Reference', ref(p.booking_id)],
    ]
    return {
      subject: `New bid of ${money(p.amount)} on your load ${ref(p.booking_id)}`,
      heading: 'You have a new bid',
      preheader: `${bidder} bid ${money(p.amount)} on ${route(p)}`,
      tone: 'neutral',
      hero: { label: 'Bid amount', value: money(p.amount) },
      bodyHtml:
        `<p style="margin:0 0 14px 0"><strong class="bt-strong" style="color:${INK}">${h(bidder)}</strong> has bid on your load.</p>` +
        routeBlock(p) + details(rows) + (p.message ? quoteBlock(p.message) : ''),
      bodyText:
        `${bidder} has bid on your load.\n\n${route(p)}\n\n` +
        detailsText([['Bid amount', money(p.amount)], ...rows]) +
        (p.message ? `\n\nMessage: "${t(p.message)}"` : ''),
      cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
        ? { label: 'Review bids', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
        : null,
    }
  },

  quote_countered: (p, ctx) => {
    // The counter travels in both directions, so the deep link has to follow the
    // recipient rather than the event. `recipient_role` is set by the producer.
    const toShipper = p.recipient_role === 'shipper'
    const base = toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl
    const actor = t(p.actor_name) || 'The other party'
    return {
      subject: `Counter-offer of ${money(p.amount)} on ${ref(p.booking_id)}`,
      heading: 'A counter-offer was made',
      preheader: `${actor} countered at ${money(p.amount)} on ${route(p)}`,
      tone: 'neutral',
      hero: { label: 'New price', value: money(p.amount) },
      bodyHtml:
        `<p style="margin:0 0 14px 0"><strong class="bt-strong" style="color:${INK}">${h(actor)}</strong> has countered with a new price.</p>` +
        routeBlock(p) + details([['Reference', ref(p.booking_id)]]) +
        (p.message ? quoteBlock(p.message) : ''),
      bodyText:
        `${actor} has countered with a new price.\n\n${route(p)}\n\n` +
        detailsText([['New price', money(p.amount)], ['Reference', ref(p.booking_id)]]) +
        (p.message ? `\n\nMessage: "${t(p.message)}"` : ''),
      cta: bookingUrl(base, p.booking_id)
        ? { label: 'View the negotiation', url: bookingUrl(base, p.booking_id)! }
        : null,
    }
  },

  quote_awarded: (p, ctx) => {
    const rows: Array<[string, string]> = [
      ['Pickup', prettyDate(p.pickup_date) || 'See booking'],
      ['Load', t(p.load_type) || '—'],
      ['Reference', ref(p.booking_id)],
    ]
    return {
      subject: `You won load ${ref(p.booking_id)} — ${money(p.amount)}`,
      heading: 'Your bid won',
      preheader: `${route(p)} is yours at ${money(p.amount)}. Confirm your truck and driver.`,
      tone: 'positive',
      hero: { label: 'Agreed price', value: money(p.amount) },
      bodyHtml:
        `<p style="margin:0 0 14px 0">The shipper has awarded you this load. Confirm your truck and
         driver, then start the trip from the app when you reach pickup.</p>` +
        routeBlock(p) + details(rows),
      bodyText:
        `The shipper has awarded you this load. Confirm your truck and driver, then start the trip ` +
        `from the app when you reach pickup.\n\n${route(p)}\n\n` +
        detailsText([['Agreed price', money(p.amount)], ...rows]),
      cta: bookingUrl(ctx.driverBaseUrl, p.booking_id)
        ? { label: 'Open the trip', url: bookingUrl(ctx.driverBaseUrl, p.booking_id)! }
        : null,
    }
  },

  quote_lost: (p, ctx) => ({
    subject: `Load ${ref(p.booking_id)} went to another carrier`,
    heading: 'This load was awarded elsewhere',
    preheader: `${route(p)} went to another carrier. Your bid is now closed.`,
    tone: 'attention',
    bodyHtml:
      `<p style="margin:0 0 14px 0">The shipper has awarded this load to another carrier. Your bid is
       now closed — there are other loads open on the board.</p>` + routeBlock(p),
    bodyText:
      `The shipper has awarded this load to another carrier. Your bid is now closed — ` +
      `there are other loads open on the board.\n\n${route(p)}`,
    cta: ctx.driverBaseUrl
      ? { label: 'Browse open loads', url: `${ctx.driverBaseUrl.replace(/\/+$/, '')}/available` }
      : null,
  }),

  quote_withdrawn: (p, ctx) => {
    const bidder = t(p.bidder_name) || 'A carrier'
    return {
      subject: `A bid was withdrawn on load ${ref(p.booking_id)}`,
      heading: 'A carrier withdrew their bid',
      preheader: `${bidder} pulled out of ${route(p)}. Other bids are unaffected.`,
      tone: 'attention',
      bodyHtml:
        `<p style="margin:0 0 14px 0"><strong class="bt-strong" style="color:${INK}">${h(bidder)}</strong>
         has withdrawn their bid. Any other bids on this load are unaffected.</p>` + routeBlock(p),
      bodyText:
        `${bidder} has withdrawn their bid. Any other bids on this load are unaffected.\n\n${route(p)}`,
      cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
        ? { label: 'Review remaining bids', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
        : null,
    }
  },

  // ── Trip lifecycle ──────────────────────────────────────────

  booking_accepted: (p, ctx) => {
    const rows: Array<[string, string]> = [
      ['Driver', t(p.driver_name) || 'Assigned'],
      ['Truck', t(p.truck_number) || '—'],
      ['Pickup', prettyDate(p.pickup_date) || 'See booking'],
      ['Reference', ref(p.booking_id)],
    ]
    return {
      subject: `A driver accepted your load ${ref(p.booking_id)}`,
      heading: 'Your load has a driver',
      preheader: `${t(p.driver_name) || 'A driver'} is taking ${route(p)}.`,
      tone: 'positive',
      bodyHtml:
        `<p style="margin:0 0 14px 0">A driver has taken your load. You will be able to track the
         truck live once the trip starts.</p>` + routeBlock(p) + details(rows),
      bodyText:
        `A driver has taken your load. You will be able to track the truck live once the trip ` +
        `starts.\n\n${route(p)}\n\n` + detailsText(rows),
      cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
        ? { label: 'View booking', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
        : null,
    }
  },

  trip_started: (p, ctx) => {
    const rows: Array<[string, string]> = [
      ['Driver', t(p.driver_name) || '—'],
      ['Truck', t(p.truck_number) || '—'],
      ['Reference', ref(p.booking_id)],
    ]
    return {
      subject: `Your shipment ${ref(p.booking_id)} is on the way`,
      heading: 'The truck has departed',
      preheader: `${route(p)} is in transit. Live position and ETA are updating now.`,
      tone: 'positive',
      bodyHtml:
        `<p style="margin:0 0 14px 0">Your shipment is now in transit. Live position and ETA update
         as the truck moves.</p>` + routeBlock(p) + details(rows),
      bodyText:
        `Your shipment is now in transit. Live position and ETA update as the truck moves.\n\n` +
        `${route(p)}\n\n` + detailsText(rows),
      cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
        ? { label: 'Track live', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
        : null,
    }
  },

  trip_completed: (p, ctx) => {
    // Same event, three audiences (shipper / driver / fleet owner). The carrier side
    // cares that payment is now due; the shipper side cares that it arrived.
    const toShipper = p.recipient_role === 'shipper'
    const lead = toShipper
      ? 'The receiver has confirmed delivery with their one-time code. This trip is complete.'
      : 'The receiver has confirmed delivery. This trip is complete and payment is now due.'
    const rows: Array<[string, string]> = [
      ['Confirmed by', 'Receiver OTP'],
      ['Reference', ref(p.booking_id)],
    ]
    const base = toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl
    return {
      subject: `Delivery confirmed for ${ref(p.booking_id)}`,
      heading: 'Delivery confirmed',
      preheader: toShipper
        ? `${route(p)} was delivered and confirmed by the receiver.`
        : `${route(p)} is complete. Payment of ${money(p.amount)} is now due.`,
      tone: 'positive',
      hero: { label: 'Agreed price', value: money(p.amount) },
      bodyHtml: `<p style="margin:0 0 14px 0">${h(lead)}</p>` + routeBlock(p) + details(rows),
      bodyText: `${lead}\n\n${route(p)}\n\n` +
        detailsText([['Agreed price', money(p.amount)], ...rows]),
      cta: bookingUrl(base, p.booking_id)
        ? { label: 'View trip', url: bookingUrl(base, p.booking_id)! }
        : null,
    }
  },

  booking_cancelled: (p, ctx) => {
    const toShipper = p.recipient_role === 'shipper'
    const by = t(p.cancelled_by) || 'other party'
    return {
      subject: `Load ${ref(p.booking_id)} was cancelled`,
      heading: 'This booking was cancelled',
      preheader: `${route(p)} was cancelled by the ${by}. No further action is needed.`,
      tone: 'attention',
      bodyHtml:
        `<p style="margin:0 0 14px 0">This booking was cancelled by the
         <strong class="bt-strong" style="color:${INK}">${h(by)}</strong>. No further action is
         needed.</p>` + routeBlock(p) + details([['Reference', ref(p.booking_id)]]),
      bodyText:
        `This booking was cancelled by the ${by}. No further action is needed.\n\n${route(p)}\n\n` +
        detailsText([['Reference', ref(p.booking_id)]]),
      cta: bookingUrl(toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl, p.booking_id)
        ? { label: 'View booking', url: bookingUrl(toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl, p.booking_id)! }
        : null,
    }
  },

  ops_override: (p, ctx) => {
    const toShipper = p.recipient_role === 'shipper'
    const action = p.action === 'reassign' ? 'reassigned to a different driver' : 'marked complete'
    return {
      subject: `Booking ${ref(p.booking_id)} was updated by BharatTruck support`,
      heading: 'Support updated your booking',
      preheader: `${route(p)} was ${action} by our operations team.`,
      tone: 'attention',
      bodyHtml:
        `<p style="margin:0 0 14px 0">Our operations team has
         <strong class="bt-strong" style="color:${INK}">${h(action)}</strong> your booking. If this
         was not expected, reply to this email and we will look into it.</p>` +
        routeBlock(p) + details([['Reference', ref(p.booking_id)]]),
      bodyText:
        `Our operations team has ${action} your booking. If this was not expected, reply to this ` +
        `email and we will look into it.\n\n${route(p)}\n\n` +
        detailsText([['Reference', ref(p.booking_id)]]),
      cta: bookingUrl(toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl, p.booking_id)
        ? { label: 'View booking', url: bookingUrl(toShipper ? ctx.shipperBaseUrl : ctx.driverBaseUrl, p.booking_id)! }
        : null,
    }
  },

  receiver_email_missing: (p, ctx) => ({
    subject: `Action needed — add a receiver email for ${ref(p.booking_id)}`,
    heading: 'Your driver cannot deliver without a receiver email',
    preheader: `The truck has reached ${t(p.destination_address) || 'the drop'} but there is no address to send the delivery code to.`,
    tone: 'attention',
    bodyHtml:
      `<p style="margin:0 0 14px 0">Your driver has arrived and tried to confirm delivery, but this
       booking has <strong class="bt-strong" style="color:${INK}">no receiver email</strong> — so
       there is nowhere to send the one-time delivery code.</p>
       <p style="margin:0 0 14px 0">Add the consignee's email on the booking and the driver can send
       the code straight away. <strong class="bt-strong" style="color:${INK}">The trip cannot be
       completed until you do</strong>, and payment is not released until it is.</p>` +
      routeBlock(p) + details([['Reference', ref(p.booking_id)]]),
    bodyText:
      `Your driver has arrived and tried to confirm delivery, but this booking has NO RECEIVER ` +
      `EMAIL — so there is nowhere to send the one-time delivery code.\n\n` +
      `Add the consignee's email on the booking and the driver can send the code straight away. ` +
      `The trip cannot be completed until you do, and payment is not released until it is.\n\n` +
      `${route(p)}\n\n` + detailsText([['Reference', ref(p.booking_id)]]),
    cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
      ? { label: 'Add receiver email', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
      : null,
  }),

  // ── Payments ────────────────────────────────────────────────

  payment_settled: (p, ctx) => {
    const rows: Array<[string, string]> = [
      ['Method', (t(p.method) || 'Direct').toUpperCase()],
      ['Reference', t(p.payment_id) || ref(p.booking_id)],
      ['Booking', ref(p.booking_id)],
    ]
    return {
      subject: `Payment receipt — ${money(p.amount)} for ${ref(p.booking_id)}`,
      heading: 'Payment recorded',
      preheader: `Receipt for ${money(p.amount)} on ${route(p)}. Keep this for your records.`,
      tone: 'positive',
      hero: { label: 'Amount paid', value: money(p.amount) },
      bodyHtml:
        `<p style="margin:0 0 14px 0">We have recorded your payment for this trip. Keep this email
         as your receipt.</p>` + routeBlock(p) + details(rows),
      bodyText:
        `We have recorded your payment for this trip. Keep this email as your receipt.\n\n` +
        `${route(p)}\n\n` + detailsText([['Amount paid', money(p.amount)], ...rows]),
      cta: bookingUrl(ctx.shipperBaseUrl, p.booking_id)
        ? { label: 'View booking', url: bookingUrl(ctx.shipperBaseUrl, p.booking_id)! }
        : null,
    }
  },

  payout_recorded: (p, ctx) => {
    const rows: Array<[string, string]> = [
      ['Status', t(p.status) || 'Recorded'],
      ['Booking', ref(p.booking_id)],
    ]
    return {
      subject: `Payout of ${money(p.amount)} recorded for ${ref(p.booking_id)}`,
      heading: 'Your payout is recorded',
      preheader: `${money(p.amount)} for ${route(p)} is recorded against your account.`,
      tone: 'positive',
      hero: { label: 'Payout', value: money(p.amount) },
      bodyHtml:
        `<p style="margin:0 0 14px 0">The payout for this completed trip has been recorded against
         your account.</p>` + routeBlock(p) + details(rows),
      bodyText:
        `The payout for this completed trip has been recorded against your account.\n\n` +
        `${route(p)}\n\n` + detailsText([['Payout', money(p.amount)], ...rows]),
      cta: bookingUrl(ctx.driverBaseUrl, p.booking_id)
        ? { label: 'View trip', url: bookingUrl(ctx.driverBaseUrl, p.booking_id)! }
        : null,
    }
  },

  // ── Fleet ───────────────────────────────────────────────────

  fleet_invite: (p, ctx) => {
    const company = t(p.company_name) || 'A fleet'
    return {
      subject: `${company} invited you to drive for them`,
      heading: 'You have a fleet invitation',
      preheader: `${company} wants you to join their fleet. Accept or decline in the app.`,
      tone: 'neutral',
      bodyHtml:
        `<p style="margin:0 0 12px 0"><strong class="bt-strong" style="color:${INK}">${h(company)}</strong>
         has invited you to join their fleet on BharatTruck.</p>
         <p style="margin:0">If you accept, they will assign you loads and trucks directly, and you
         will no longer bid on the open load board yourself. You can decline if you would rather keep
         driving independently.</p>`,
      bodyText:
        `${company} has invited you to join their fleet on BharatTruck.\n\n` +
        `If you accept, they will assign you loads and trucks directly, and you will no longer bid ` +
        `on the open load board yourself. You can decline if you would rather keep driving independently.`,
      cta: ctx.driverBaseUrl
        ? { label: 'Review the invitation', url: `${ctx.driverBaseUrl.replace(/\/+$/, '')}/invites` }
        : null,
    }
  },

  fleet_invite_answered: (p, _ctx) => {
    const accepted = p.response === 'accepted'
    const driver = t(p.driver_name) || 'A driver'
    return {
      subject: `${driver} ${accepted ? 'joined' : 'declined'} your fleet`,
      heading: accepted ? 'A driver joined your fleet' : 'A driver declined your invitation',
      preheader: accepted
        ? `${driver} accepted. You can now assign them loads and trucks.`
        : `${driver} declined your invitation.`,
      tone: accepted ? 'positive' : 'attention',
      bodyHtml: accepted
        ? `<p style="margin:0"><strong class="bt-strong" style="color:${INK}">${h(driver)}</strong> has
           accepted your invitation. You can now assign them loads and trucks.</p>`
        : `<p style="margin:0"><strong class="bt-strong" style="color:${INK}">${h(driver)}</strong> has
           declined your invitation.</p>`,
      bodyText: accepted
        ? `${driver} has accepted your invitation. You can now assign them loads and trucks.`
        : `${driver} has declined your invitation.`,
      cta: null,
    }
  },

  // ── Account ─────────────────────────────────────────────────

  password_changed: (p, _ctx) => ({
    subject: 'Your BharatTruck password was changed',
    heading: 'Your password was changed',
    preheader: 'If this was not you, reset your password immediately and contact us.',
    tone: 'attention',
    bodyHtml:
      `<p style="margin:0 0 12px 0">The password on your BharatTruck account was changed
       ${p.changed_at ? `on <strong class="bt-strong" style="color:${INK}">${h(p.changed_at)}</strong>` : 'just now'}.</p>
       <p style="margin:0">If this was you, nothing further is needed. <strong class="bt-strong"
       style="color:${INK}">If it was not</strong>, reset your password immediately and contact us —
       someone else may have access to your account.</p>`,
    bodyText:
      `The password on your BharatTruck account was changed ${p.changed_at ? `on ${t(p.changed_at)}` : 'just now'}.\n\n` +
      `If this was you, nothing further is needed. If it was NOT, reset your password immediately ` +
      `and contact us — someone else may have access to your account.`,
    cta: null,
  }),

  // ── Alerts ──────────────────────────────────────────────────

  // A critical problem the scheduled sweep found (src/lib/alerts). The title and subtitle
  // were written for this person's persona by the rule — a 'driver' alert never carries a
  // freight amount — so the template only frames them.
  alert_raised: (p, ctx) => {
    const title = t(p.title) || 'Something needs your attention'
    const subtitle = t(p.subtitle)
    const base = p.persona === 'shipper' ? ctx.shipperBaseUrl : ctx.driverBaseUrl
    const url = bookingUrl(base, p.booking_id)
    const rows: Array<[string, string]> = p.booking_id ? [['Reference', ref(p.booking_id)]] : []
    return {
      subject: `Needs attention — ${title}`,
      heading: title,
      preheader: subtitle || 'Open BharatTruck to see what needs you.',
      tone: 'attention',
      bodyHtml:
        (subtitle ? `<p style="margin:0 0 14px 0">${h(subtitle)}</p>` : '') +
        `<p style="margin:0 0 14px 0">This stays on your BharatTruck home screen until it is resolved.</p>` +
        (rows.length ? details(rows) : ''),
      bodyText:
        (subtitle ? `${subtitle}\n\n` : '') +
        `This stays on your BharatTruck home screen until it is resolved.` +
        (rows.length ? `\n\n${detailsText(rows)}` : ''),
      cta: url ? { label: 'Open in BharatTruck', url } : null,
    }
  },
}

// -----------------------------------------------------------
// renderNotification
//
// Returns null for an unknown event_type rather than throwing. Producers are allowed
// to deploy ahead of this file (event_type is free text, by design in migration 021),
// and one unrenderable row must never take down the drain loop for every other row.
// The dispatcher parks a null result as 'failed' with a clear reason.
// -----------------------------------------------------------

export function renderNotification(
  event: string,
  payload: Payload,
  ctx: RenderContext,
): EmailMessage | null {
  const template = TEMPLATES[event as NotificationEvent]
  if (!template) return null

  const r = template(payload, ctx)

  // Only opt-out-able categories get an unsubscribe affordance. Putting one on a
  // payment receipt would be both misleading (we will still send it) and a support
  // burden when it appears not to work.
  const optOutable = EVENT_CATEGORY[event as NotificationEvent] !== 'transactional'
  const unsubscribeUrl = optOutable ? ctx.unsubscribeUrl : null

  const html = layout({
    heading: r.heading,
    bodyHtml: r.bodyHtml,
    tone: r.tone,
    preheader: r.preheader,
    hero: r.hero,
    cta: r.cta,
    unsubscribeUrl,
  })

  const text =
    `${r.heading}\n\n${r.bodyText}` +
    (r.cta ? `\n\n${r.cta.label}: ${r.cta.url}` : '') +
    (unsubscribeUrl ? `\n\n---\nUnsubscribe from these updates: ${unsubscribeUrl}` : '')

  return {
    to: '', // filled in by the dispatcher from the outbox row
    subject: r.subject,
    html,
    text,
    // RFC 8058 / RFC 2369. Gmail and Outlook render a native unsubscribe control from
    // these, which is a far better outcome than the recipient reaching for "mark as spam".
    headers: unsubscribeUrl
      ? {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
  }
}

/** Exposed for tests + the dispatcher's unknown-event check. */
export function isKnownEvent(event: string): event is NotificationEvent {
  return event in TEMPLATES
}
