import type { BookingStatus, QuoteStatus } from './types'
import { pill, type PillTone } from './ui'

// One colour per booking and bid state, shared by every screen. `color` is the full
// pill class (tinted fill + matching border, the 2026-10 light redesign) so existing
// call sites that render `<span className={`... ${color}`}>` keep working.
function entry(label: string, tone: PillTone) {
  return { label, tone, color: pill(tone) }
}

export const bookingStatusConfig: Record<BookingStatus, { label: string; tone: PillTone; color: string }> = {
  pending:     entry('Pending', 'amber'),
  negotiating: entry('Negotiating', 'blue'),
  accepted:    entry('Accepted', 'green'),
  in_transit:  entry('In transit', 'indigo'),
  // Driver says delivered, receiver could not confirm — ops closes it (migration 0025).
  delivery_asserted: entry('Awaiting confirmation', 'orange'),
  completed:   entry('Delivered', 'teal'),
  cancelled:   entry('Cancelled', 'red'),
  paid:        entry('Paid', 'green'),
}

export const quoteStatusConfig: Record<QuoteStatus, { label: string; tone: PillTone; color: string }> = {
  submitted: entry('Submitted', 'blue'),
  countered: entry('Countered', 'orange'),
  accepted:  entry('Accepted', 'green'),
  rejected:  entry('Rejected', 'red'),
  withdrawn: entry('Withdrawn', 'slate'),
  expired:   entry('Expired', 'slate'),
}
