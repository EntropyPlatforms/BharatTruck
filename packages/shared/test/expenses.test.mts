// The trip-expense controlled vocabulary + classifyExpense, now shared by the booking write
// endpoint (its zod enum) and the fleet pilferage roll-up. These pin the vocabulary's internal
// consistency and the classifier's two-tier logic (code authoritative, free-text legacy fallback).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_CODES,
  EXPENSE_CATEGORY_LABELS,
  classifyExpense,
  isExpenseCategoryCode,
  expenseCategoryLabel,
} from '../src/expenses.ts'

test('the derived views stay consistent with EXPENSE_CATEGORIES', () => {
  assert.equal(EXPENSE_CATEGORY_CODES.length, EXPENSE_CATEGORIES.length)
  // Codes tuple is exactly the categories' codes, in order.
  assert.deepEqual([...EXPENSE_CATEGORY_CODES], EXPENSE_CATEGORIES.map(c => c.code))
  // Every code has a label, and only those codes.
  assert.deepEqual(Object.keys(EXPENSE_CATEGORY_LABELS).sort(), [...EXPENSE_CATEGORY_CODES].sort())
  for (const c of EXPENSE_CATEGORIES) assert.equal(EXPENSE_CATEGORY_LABELS[c.code], c.label)
})

test('classifyExpense: a controlled code is authoritative', () => {
  assert.equal(classifyExpense('fuel', null), 'fuel')
  assert.equal(classifyExpense('toll', null), 'toll')
  assert.equal(classifyExpense('tyre', null), 'other')
  assert.equal(classifyExpense('def', null), 'other')
})

test('classifyExpense: the code wins over conflicting free text', () => {
  // A "toll" code with "diesel" in the free text is still a toll — the code is trusted.
  assert.equal(classifyExpense('toll', 'diesel top-up'), 'toll')
})

test('classifyExpense: legacy rows (no code) fall back to the loose free-text match', () => {
  assert.equal(classifyExpense(null, 'diesel filling'), 'fuel')
  assert.equal(classifyExpense(null, 'FUEL'), 'fuel')
  assert.equal(classifyExpense(null, 'toll plaza'), 'toll')
  assert.equal(classifyExpense(undefined, 'dhaba lunch'), 'other')
  assert.equal(classifyExpense(null, null), 'other')
})

test('an unknown code is not treated as controlled — it falls through to free text', () => {
  assert.equal(classifyExpense('made_up', 'diesel'), 'fuel')
  assert.equal(classifyExpense('made_up', null), 'other')
})

test('isExpenseCategoryCode + expenseCategoryLabel', () => {
  assert.equal(isExpenseCategoryCode('fuel'), true)
  assert.equal(isExpenseCategoryCode('made_up'), false)
  assert.equal(isExpenseCategoryCode(42), false)
  assert.equal(expenseCategoryLabel('fuel'), 'Fuel / Diesel')
  assert.equal(expenseCategoryLabel('made_up'), 'made_up') // unknown -> returned unchanged
})
