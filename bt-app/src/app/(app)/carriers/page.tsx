'use client'

/**
 * /carriers — a shipper's Preferred carriers (the fleets and truck drivers they like to give
 * loads to), and the two ways to bring more in: an invite link and a CSV list. The same list
 * labels bids on the load page and fills the Post-a-Load picker.
 */

import { useState } from 'react'
import { Building2, FileUp, Link2, Star, Truck, Users } from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, Loading } from '@/components/stat'
import { BulkCarriersDialog, CarrierInviteDialog } from '@/components/shipper/carrier-onboarding'
import { PreferredBadge, usePreferredCarriers } from '@/components/shipper/preferred-carriers'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'

export default function CarriersPage() {
  const pref = usePreferredCarriers()
  const [linkOpen, setLinkOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)

  return (
    <>
      <PageHeader
        title="My carriers"
        subtitle="The fleet owners and truck drivers you prefer for your loads."
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setBulkOpen(true)} className={BTN_SECONDARY}>
              <FileUp className="w-4 h-4" />
              Add from a list (CSV)
            </button>
            <button type="button" onClick={() => setLinkOpen(true)} className={BTN_PRIMARY}>
              <Link2 className="w-4 h-4" />
              Invite carriers
            </button>
          </div>
        }
      />

      {!pref.loading && !pref.starsEnabled && !pref.error && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
          Adding carriers by invite or list is not switched on yet. Carriers you have finished trips with still show here.
        </p>
      )}

      <Card>
        <CardHead
          icon={<Star />}
          tint="brand"
          title="Preferred carriers"
          sub="Carriers you finished trips with, invited, or starred. Their bids show a Preferred badge, and they see one on your loads."
        />
        {pref.loading ? <Loading label="Loading your carriers" /> : pref.error ? (
          <div className="p-5"><ErrorNote message={pref.error} /></div>
        ) : pref.carriers.length === 0 ? (
          <Empty
            icon={<Users />}
            title="No preferred carriers yet"
            hint="Invite the fleet owners and truck drivers you trust, or upload a list."
            action={<button type="button" onClick={() => setLinkOpen(true)} className={BTN_PRIMARY}><Link2 className="w-4 h-4" />Invite carriers</button>}
          />
        ) : (
          <ul className="divide-y divide-gray-100">
            {pref.carriers.map((c) => (
              <li key={`${c.kind}:${c.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-600" aria-hidden>
                    {c.kind === 'fleet_owner' ? <Building2 className="h-4 w-4" /> : <Truck className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{c.name || 'Unnamed carrier'}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {c.kind === 'fleet_owner' ? 'Fleet' : 'Truck driver'}
                      {c.truck_number ? ` · ${c.truck_number}` : ''}
                      {c.city ? ` · ${c.city}` : ''}
                      {c.phone_masked ? ` · ${c.phone_masked}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <PreferredBadge card={c} showReason />
                  {pref.starsEnabled && c.starred && (
                    <button
                      type="button"
                      onClick={() => void pref.toggleStar(c)}
                      className={cx('text-sm font-medium text-gray-500 hover:text-red-600')}
                      title={c.trips_with_you > 0 ? 'Stays preferred because of your past trips' : undefined}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {linkOpen && <CarrierInviteDialog onClose={() => setLinkOpen(false)} />}
      {bulkOpen && <BulkCarriersDialog onClose={() => setBulkOpen(false)} onDone={() => { setBulkOpen(false); pref.reload() }} />}
    </>
  )
}
