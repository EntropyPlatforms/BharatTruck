// -----------------------------------------------------------
// Trip-expense controlled vocabulary + the P&L classifier. The ONE home for the expense
// category list.
//
// WHY: the fuel-variance / pilferage signal (bt-fleet-service analytics) diffs modelled diesel
// against what the driver actually filled. That "actually filled" number originally came from a
// substring match over a FREE-TEXT category, so the signal literally depended on spelling. The
// category is now a closed set chosen from a dropdown, and the classifier keys off the code.
//
// The `code` values are the CONTRACT with the database: they must match the CHECK constraint on
// trip_expenses.category_code (migration 0034). The write endpoint's zod enum
// (bt-booking-service) and the fleet roll-up both derive from EXPENSE_CATEGORIES here, so the
// vocabulary is written down once. (bt-app carries its own dropdown copy for now — it is not
// yet a @bharattruck/shared consumer; keep it in step with this list and the 0034 CHECK.)
// -----------------------------------------------------------
// Ordered for the dropdown: the two categories the model separates first (fuel, toll), then the
// rest, then the escape hatch. Every code here MUST appear in the 0034 CHECK constraint.
export const EXPENSE_CATEGORIES = [
    { code: 'fuel', label: 'Fuel / Diesel', bucket: 'fuel' },
    { code: 'def', label: 'DEF / AdBlue', bucket: 'other' },
    { code: 'toll', label: 'Toll', bucket: 'toll' },
    { code: 'tyre', label: 'Tyre', bucket: 'other' },
    { code: 'repair', label: 'Repair / Maintenance', bucket: 'other' },
    { code: 'parking', label: 'Parking', bucket: 'other' },
    { code: 'weighbridge', label: 'Weighbridge', bucket: 'other' },
    { code: 'fine', label: 'Fine / Challan', bucket: 'other' },
    { code: 'loading_unloading', label: 'Loading / Unloading', bucket: 'other' },
    { code: 'driver_allowance', label: 'Driver allowance', bucket: 'other' },
    { code: 'permit', label: 'Permit / Border', bucket: 'other' },
    { code: 'other', label: 'Other', bucket: 'other' },
];
// Derived views so no caller re-lists the vocabulary. EXPENSE_CATEGORY_CODES is a non-empty
// tuple so it can feed z.enum directly; EXPENSE_CATEGORY_LABELS is the code -> label record.
export const EXPENSE_CATEGORY_CODES = EXPENSE_CATEGORIES.map(c => c.code);
export const EXPENSE_CATEGORY_LABELS = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.code, c.label]));
const BY_CODE = new Map(EXPENSE_CATEGORIES.map(c => [c.code, c]));
export function isExpenseCategoryCode(value) {
    return typeof value === 'string' && BY_CODE.has(value);
}
/** code -> display label; returns the code unchanged when it is not in the vocabulary. */
export function expenseCategoryLabel(code) {
    return BY_CODE.get(code)?.label ?? code;
}
/**
 * classifyExpense — the ONE place a trip expense becomes a P&L bucket. PURE, so the pilferage
 * signal is unit-testable without a database.
 *
 * A `category_code` from the controlled vocabulary is authoritative. When it is absent (a
 * legacy row written before 0034), fall back to the old loose substring match over the
 * free-text category — deliberately unchanged, so no historical row is reclassified; new rows
 * simply stop depending on spelling.
 */
export function classifyExpense(categoryCode, freeTextCategory) {
    if (categoryCode && BY_CODE.has(categoryCode)) {
        return BY_CODE.get(categoryCode).bucket;
    }
    const text = (freeTextCategory ?? '').toLowerCase();
    if (text.includes('fuel') || text.includes('diesel'))
        return 'fuel';
    if (text.includes('toll'))
        return 'toll';
    return 'other';
}
