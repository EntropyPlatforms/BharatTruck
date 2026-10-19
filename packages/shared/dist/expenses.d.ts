export type ExpenseCategoryCode = 'fuel' | 'def' | 'toll' | 'tyre' | 'repair' | 'parking' | 'weighbridge' | 'fine' | 'loading_unloading' | 'driver_allowance' | 'permit' | 'other';
/** The P&L bucket an expense lands in. Matches the three actuals the model tracks. */
export type ExpenseBucket = 'fuel' | 'toll' | 'other';
export type ExpenseCategory = {
    code: ExpenseCategoryCode;
    /** Dropdown label, English. */
    label: string;
    /** Which running-cost actual this feeds. */
    bucket: ExpenseBucket;
};
export declare const EXPENSE_CATEGORIES: readonly ExpenseCategory[];
export declare const EXPENSE_CATEGORY_CODES: [ExpenseCategoryCode, ...ExpenseCategoryCode[]];
export declare const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategoryCode, string>;
export declare function isExpenseCategoryCode(value: unknown): value is ExpenseCategoryCode;
/** code -> display label; returns the code unchanged when it is not in the vocabulary. */
export declare function expenseCategoryLabel(code: string): string;
/**
 * classifyExpense — the ONE place a trip expense becomes a P&L bucket. PURE, so the pilferage
 * signal is unit-testable without a database.
 *
 * A `category_code` from the controlled vocabulary is authoritative. When it is absent (a
 * legacy row written before 0034), fall back to the old loose substring match over the
 * free-text category — deliberately unchanged, so no historical row is reclassified; new rows
 * simply stop depending on spelling.
 */
export declare function classifyExpense(categoryCode: string | null | undefined, freeTextCategory: string | null | undefined): ExpenseBucket;
