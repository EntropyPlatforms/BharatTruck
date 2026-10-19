'use client'

/**
 * Trip expenses — the driver logs what a trip actually cost, choosing a category from a
 * DROPDOWN instead of typing free text.
 *
 * WHY: the fleet dashboard's fuel-variance / pilferage signal diffs modelled diesel against
 * what the driver actually filled, but nothing ever created those rows, and the field it read
 * (category) was free text — the signal depended on a driver spelling "fuel". This is the
 * write surface (bt-booking-service POST /bookings/:id/expenses); category_code is a
 * controlled vocabulary (migration 0034) so the signal is spelling-proof.
 *
 * - READ  (GET  /bookings/:id/expenses): what has been logged, newest first, with a total.
 * - WRITE (POST /bookings/:id/expenses): the assigned driver adds one, while the trip is live
 *   (accepted → completed). Fuel entries can carry litres/rate so a later check can compare
 *   against the state diesel price.
 *
 * Never blanks: loading / error / empty / content, with a clear message on every failure.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  CircleDot, Droplet, Ellipsis, FileCheck, Fuel, Lock, Milestone, PackageOpen, Receipt, ReceiptText, Scale,
  SquareParking, UserRound, Wrench, type LucideIcon,
} from 'lucide-react'

import { Card, CardHead, ErrorNote, Loading } from '@/components/stat'
import { ApiError, getTripExpenses, logTripExpense } from '@/lib/api'
import { EXPENSE_CATEGORIES, expenseCategoryLabel, type ExpenseCategoryCode } from '@/lib/expense-categories'
import { inr, shortDate } from '@/lib/format'
import { BTN_PRIMARY, INPUT, LABEL, cx } from '@/lib/ui'
import type { Booking, BookingStatus, TripExpense } from '@/lib/types'

// Matches EXPENSE_LOGGABLE_STATUSES in bt-booking-service/src/lib/expenses.ts — the trip must
// be underway (or just delivered) for a cost to make sense. Outside this the list is read-only.
const LOGGABLE: BookingStatus[] = ['accepted', 'in_transit', 'delivery_asserted', 'completed']

const inputCls = cx(INPUT, 'h-12! text-[0.9375rem]!')

// One icon per category for the picker grid (display only — the codes and labels stay
// exactly the twelve in lib/expense-categories.ts).
const CATEGORY_ICON: Record<ExpenseCategoryCode, LucideIcon> = {
  fuel: Fuel,
  def: Droplet,
  toll: Milestone,
  tyre: CircleDot,
  repair: Wrench,
  parking: SquareParking,
  weighbridge: Scale,
  fine: ReceiptText,
  loading_unloading: PackageOpen,
  driver_allowance: UserRound,
  permit: FileCheck,
  other: Ellipsis,
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

export default function TripExpenses({
  booking,
  canDrive,
  onChanged,
}: {
  booking: Booking
  canDrive: boolean
  onChanged?: () => void
}) {
  const [rows, setRows] = useState<TripExpense[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [category, setCategory] = useState<ExpenseCategoryCode>('fuel')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [litres, setLitres] = useState('')
  const [odometer, setOdometer] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      setRows(await getTripExpenses(booking.id))
    } catch (err) {
      setError(messageOf(err))
      setRows([])
    }
  }, [booking.id])

  useEffect(() => { void load() }, [load])

  // Only the assigned driver gets this surface; the fleet owner reads the same costs on the
  // analytics Fuel page. A non-driver viewer sees nothing here.
  if (!canDrive) return null

  const canLog = LOGGABLE.includes(booking.status)
  const total = (rows ?? []).reduce((sum, r) => sum + Number(r.amount || 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const amt = Number(amount)
    if (!(amt > 0)) { toast.error('Enter an amount greater than zero'); return }
    const litresNum = litres.trim() ? Number(litres) : undefined
    const odoNum = odometer.trim() ? Number(odometer) : undefined
    if (litres.trim() && !(Number(litres) > 0)) { toast.error('Litres must be greater than zero'); return }

    setSaving(true)
    try {
      await logTripExpense(booking.id, {
        category_code: category,
        amount: amt,
        ...(description.trim() ? { description: description.trim() } : {}),
        // litres/rate are only meaningful for fuel, and the rate is derived so the driver
        // enters two numbers, not three.
        ...(category === 'fuel' && litresNum ? { litres: litresNum, rate_per_litre: Math.round((amt / litresNum) * 100) / 100 } : {}),
        ...(odoNum !== undefined ? { odometer_km: odoNum } : {}),
      })
      toast.success('Expense logged')
      setAmount(''); setDescription(''); setLitres(''); setOdometer('')
      await load()
      onChanged?.()
    } catch (err) {
      toast.error(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHead
        title="Trip expenses"
        sub="What this trip cost — fuel, toll, repairs. Pick a category so the fleet's fuel check stays accurate."
        icon={<Receipt />}
        tint="amber"
      />

      <div className="p-4 sm:p-5">
        {canLog ? (
          <form onSubmit={submit} className="space-y-4">
            <fieldset>
              <legend className={LABEL}>Category</legend>
              <div role="radiogroup" aria-label="Category" className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {EXPENSE_CATEGORIES.map((c) => {
                  const on = c.code === category
                  const Icon = CATEGORY_ICON[c.code]
                  return (
                    <button
                      key={c.code}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setCategory(c.code)}
                      className={cx(
                        'min-h-[76px] rounded-xl border px-1.5 py-2.5 flex flex-col items-center justify-center gap-1.5 text-center transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                        on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-gray-200 bg-white hover:bg-gray-50',
                      )}
                    >
                      <Icon className={cx('w-5 h-5', on ? 'text-brand-700' : 'text-blue-600')} />
                      <span className={cx('text-xs leading-tight', on ? 'font-bold text-gray-900' : 'font-medium text-gray-700')}>
                        {c.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="exp-amount" className={LABEL}>Amount (₹)</label>
              <input
                id="exp-amount"
                type="number" inputMode="decimal" step="0.01" min="0"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00" className={cx(INPUT, 'h-12! text-lg! font-semibold tabular-nums')}
              />
            </div>

            {category === 'fuel' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="exp-litres" className={LABEL}>Litres (optional)</label>
                  <input
                    id="exp-litres"
                    type="number" inputMode="decimal" step="0.01" min="0"
                    value={litres} onChange={(e) => setLitres(e.target.value)}
                    placeholder="e.g. 120" className={`${inputCls} tabular-nums`}
                  />
                </div>
                <div>
                  <label htmlFor="exp-odo" className={LABEL}>Odometer km (optional)</label>
                  <input
                    id="exp-odo"
                    type="number" inputMode="numeric" step="1" min="0"
                    value={odometer} onChange={(e) => setOdometer(e.target.value)}
                    placeholder="e.g. 158230" className={`${inputCls} tabular-nums`}
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="exp-note" className={LABEL}>Note (optional)</label>
              <input
                id="exp-note"
                type="text" maxLength={500}
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Pump name, reason…" className={inputCls}
              />
            </div>

            <button type="submit" disabled={saving} className={cx(BTN_PRIMARY, 'h-14! w-full text-base!')}>
              {saving ? 'Saving…' : 'Add expense'}
            </button>
          </form>
        ) : (
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-3.5 py-3 flex items-center gap-3">
            <Lock className="w-5 h-5 text-gray-500 shrink-0" />
            <p className="text-sm text-gray-600">
              Expenses can be added while a trip is running. This one is {booking.status.replace('_', ' ')}.
            </p>
          </div>
        )}

        <div className="mt-5">
          {rows === null ? (
            <Loading label="Loading expenses" />
          ) : error ? (
            <ErrorNote message={error} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-400">No expenses logged yet.</p>
          ) : (
            <>
              <p className="text-base font-bold text-gray-900 mb-2">Expenses ({rows.length})</p>
              <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                {rows.map((r) => {
                  const code = (r.category_code ?? r.category) as ExpenseCategoryCode
                  const Icon = CATEGORY_ICON[code] ?? Ellipsis
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-3.5 py-3">
                      <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                        <Icon className="w-5 h-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[0.9375rem] font-semibold text-gray-900 truncate">
                          {expenseCategoryLabel(r.category_code ?? r.category)}
                          {r.litres != null && <span className="font-normal text-gray-500"> · {r.litres} L</span>}
                        </p>
                        {r.description && <p className="text-sm text-gray-500 truncate">{r.description}</p>}
                        <p className="text-xs text-gray-400">{shortDate(r.expense_date)}</p>
                      </div>
                      <span className="text-[0.9375rem] font-semibold text-gray-900 tabular-nums shrink-0 ml-2">{inr(Number(r.amount))}</span>
                    </li>
                  )
                })}
                <li className="flex items-center justify-between px-3.5 py-3 bg-gray-50">
                  <span className="text-[0.9375rem] font-semibold text-gray-700">Total</span>
                  <span className="text-lg font-bold text-emerald-600 tabular-nums">{inr(total)}</span>
                </li>
              </ul>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
