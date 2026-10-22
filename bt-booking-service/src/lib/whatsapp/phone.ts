// WhatsApp identifies a person by `wa_id`: country code + number, digits only (919876543210).
// users.phone_number holds a bare 10-digit Indian mobile — the shape the phone-OTP route
// writes — though profile edits may have stored it with +91, 91 or 0 in front. The platform
// is India-only, so only Indian mobiles are matched.

const INDIAN_MOBILE = /^[6-9]\d{9}$/

/** wa_id -> bare 10-digit Indian mobile, or null for anything that is not one. */
export function indianMobileFromWaId(waId: string): string | null {
  const d = waId.replace(/\D/g, '')
  return d.length === 12 && d.startsWith('91') && INDIAN_MOBILE.test(d.slice(2)) ? d.slice(2) : null
}

/** Every way the same mobile may have been stored on users.phone_number. */
export function storedPhoneCandidates(mobile: string): string[] {
  const grouped = `${mobile.slice(0, 5)} ${mobile.slice(5)}`
  return [mobile, `+91${mobile}`, `91${mobile}`, `0${mobile}`, `+91 ${mobile}`, `+91-${mobile}`, grouped, `+91 ${grouped}`, `0${grouped}`]
}

/** A stored phone number -> wa_id, or null when it is not a valid Indian mobile. */
export function waIdFromStoredPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  const ten =
    d.length === 10 ? d
    : d.length === 12 && d.startsWith('91') ? d.slice(2)
    : d.length === 11 && d.startsWith('0') ? d.slice(1)
    : null
  return ten && INDIAN_MOBILE.test(ten) ? `91${ten}` : null
}
