/**
 * Presentational helpers for the ship surfaces (My Loads, load detail): a short city
 * name out of a full geocoded address, for route titles like "Nagpur → Pune". The
 * full address is always shown elsewhere on the page; this only shortens a heading.
 */

const STATES = new Set([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana',
  'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur',
  'meghalaya', 'mizoram', 'nagaland', 'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu', 'telangana',
  'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'delhi', 'jammu and kashmir', 'ladakh',
  'puducherry', 'chandigarh', 'india',
])

/** "MIDC Hingna, Nagpur, Maharashtra 440016" → "Nagpur". Falls back to the address itself. */
export function cityOf(address: string | null | undefined): string {
  if (!address) return '—'
  const parts = address
    .split(',')
    .map((p) => p.replace(/\b\d{6}\b/g, '').trim())
    .filter((p) => p && !STATES.has(p.toLowerCase()) && !/^\d+$/.test(p))
  if (parts.length === 0) return address.trim()
  return parts[parts.length - 1]
}
