// The trip-expense categories the driver picks from a dropdown, instead of typing free text.
//
// This is the FRONTEND copy of the controlled vocabulary. The single source of truth is the
// CHECK constraint on trip_expenses.category_code in migration 0034 — the server (and the DB)
// reject anything not on this list. The backend services now share ONE copy in
// @bharattruck/shared/expenses; this file stays separate until bt-app is onboarded onto
// @bharattruck/shared. Keep in sync with:
//   - supabase/migrations/0034_analytics_trust_inputs.sql   (the CHECK — authoritative)
//   - packages/shared/src/expenses.ts                       (the backend vocabulary + classifier)

export type ExpenseCategoryCode =
  | 'fuel' | 'def' | 'toll' | 'tyre' | 'repair' | 'parking'
  | 'weighbridge' | 'fine' | 'loading_unloading' | 'driver_allowance' | 'permit' | 'other'

export type ExpenseCategory = { code: ExpenseCategoryCode; label: string }

// Order shown in the dropdown: fuel first (the one the pilferage signal is built on), then
// the common road costs, then the escape hatch.
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { code: 'fuel', label: 'Fuel / Diesel' },
  { code: 'def', label: 'DEF / AdBlue' },
  { code: 'toll', label: 'Toll' },
  { code: 'tyre', label: 'Tyre' },
  { code: 'repair', label: 'Repair / Maintenance' },
  { code: 'parking', label: 'Parking' },
  { code: 'weighbridge', label: 'Weighbridge' },
  { code: 'fine', label: 'Fine / Challan' },
  { code: 'loading_unloading', label: 'Loading / Unloading' },
  { code: 'driver_allowance', label: 'Driver allowance' },
  { code: 'permit', label: 'Permit / Border' },
  { code: 'other', label: 'Other' },
] as const

const LABEL_BY_CODE = new Map(EXPENSE_CATEGORIES.map(c => [c.code, c.label]))

export function expenseCategoryLabel(code: string): string {
  return LABEL_BY_CODE.get(code as ExpenseCategoryCode) ?? code
}
