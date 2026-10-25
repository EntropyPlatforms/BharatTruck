'use client'

/**
 * Billing address — saved on the account (users.address/city/state/pincode), for shippers whose
 * invoices and e-way bills need one. Fleet owners keep theirs on the company profile.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { MapPin } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote } from '@/components/stat'
import { ApiError, updateMyAddress } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { BTN_PRIMARY, INPUT, LABEL } from '@/lib/ui'

export default function BillingAddressCard() {
  const { user, refresh } = useAuth()
  const fromUser = () => ({ address: user?.address ?? '', city: user?.city ?? '', state: user?.state ?? '', pincode: user?.pincode ?? '' })
  const [form, setForm] = useState(fromUser)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof ReturnType<typeof fromUser>, v: string) => setForm((f) => ({ ...f, [k]: v }))

  // Keep the form in step when the signed-in user loads or changes.
  const key = `${user?.id}|${user?.address}|${user?.city}|${user?.state}|${user?.pincode}`
  const [seen, setSeen] = useState(key)
  useEffect(() => { if (key !== seen) { setSeen(key); setForm(fromUser()) } }, [key]) // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (form.pincode && !/^[1-9][0-9]{5}$/.test(form.pincode)) { setErr('PIN code is 6 digits.'); return }
    setBusy(true); setErr(null)
    try {
      await updateMyAddress({ address: form.address || null, city: form.city || null, state: form.state || null, pincode: form.pincode || null })
      await refresh()
      toast.success('Billing address saved')
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not save the address.')
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHead icon={<MapPin />} tint="brand" title="Billing address" sub="Printed on your invoices and e-way bills." />
      <form onSubmit={submit} className="p-5 space-y-4">
        <div>
          <label htmlFor="bill_address" className={LABEL}>Address</label>
          <input id="bill_address" value={form.address} onChange={(e) => set('address', e.target.value.slice(0, 300))} placeholder="Shop / building, street, area" className={INPUT} autoComplete="street-address" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><label htmlFor="bill_city" className={LABEL}>City</label><input id="bill_city" value={form.city} onChange={(e) => set('city', e.target.value.slice(0, 80))} className={INPUT} autoComplete="address-level2" /></div>
          <div><label htmlFor="bill_state" className={LABEL}>State</label><input id="bill_state" value={form.state} onChange={(e) => set('state', e.target.value.slice(0, 80))} className={INPUT} autoComplete="address-level1" /></div>
          <div><label htmlFor="bill_pin" className={LABEL}>PIN code</label><input id="bill_pin" inputMode="numeric" value={form.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} className={INPUT} autoComplete="postal-code" /></div>
        </div>
        {err && <ErrorNote message={err} />}
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Saving…' : 'Save address'}</button>
      </form>
    </Card>
  )
}
