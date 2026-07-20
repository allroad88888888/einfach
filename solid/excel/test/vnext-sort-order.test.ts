/**
 * Shared physical-sort comparator (`sort-order.ts`) unit spec — the TS mirror of
 * the Rust `sort_cmp` tests in `rust/excel-core/src/sort.rs`. These lock the
 * normative order (design §3.2) independently of the WASM engine so a
 * comparator regression is caught fast; the cross-engine golden parity lives in
 * `vnext-sort-static-wasm-parity.test.ts`.
 */

import { describe, expect, test } from '@jest/globals'

import {
  compareSortText,
  compareSortValues,
  compareSortValuesWithDirection,
  planPhysicalSort,
  SORT_TYPE_RANK,
  type ResolvedSortKey,
  type SortValue,
} from '../src-vnext/adapter/sort-order'

const num = (value: number): SortValue => ({ kind: 'number', value })
const text = (value: string): SortValue => ({ kind: 'text', value })
const bool = (value: boolean): SortValue => ({ kind: 'boolean', value })
const err: SortValue = { kind: 'error' }
const empty: SortValue = { kind: 'empty' }

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

describe('sort comparator — normative order (Rust sort_cmp parity)', () => {
  test('type order ascending: number < text < boolean < error < empty', () => {
    const ordered = [num(5), text('a'), bool(false), err, empty]
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        expect(sign(compareSortValues(ordered[i], ordered[j], false))).toBe(sign(i - j))
      }
    }
    expect(SORT_TYPE_RANK).toEqual({ number: 0, text: 1, boolean: 2, error: 3, empty: 4 })
  })

  test('empty sorts LAST in both directions', () => {
    for (const dir of ['asc', 'desc'] as const) {
      expect(compareSortValuesWithDirection(empty, num(1), false, dir)).toBe(1)
      expect(compareSortValuesWithDirection(num(1), empty, false, dir)).toBe(-1)
      expect(compareSortValuesWithDirection(empty, empty, false, dir)).toBe(0)
    }
  })

  test('numbers: negatives, zero, date serials, NaN', () => {
    expect(sign(compareSortValues(num(-3), num(0), false))).toBe(-1)
    expect(sign(compareSortValues(num(0), num(0.5), false))).toBe(-1)
    expect(sign(compareSortValues(num(45_000), num(45_001), false))).toBe(-1)
    // NaN equals NaN, sorts after every real number, before text.
    expect(compareSortValues(num(NaN), num(NaN), false)).toBe(0)
    expect(sign(compareSortValues(num(Number.MAX_VALUE), num(NaN), false))).toBe(-1)
    expect(sign(compareSortValues(num(NaN), text('a'), false))).toBe(-1)
  })

  test('text: case fold default, case sensitive, non-ASCII fold', () => {
    expect(sign(compareSortValues(text('apple'), text('Banana'), false))).toBe(-1)
    expect(compareSortValues(text('APPLE'), text('apple'), false)).toBe(0)
    // Case-sensitive: plain code-point order ('B'=66 < 'a'=97).
    expect(sign(compareSortValues(text('Banana'), text('apple'), true))).toBe(-1)
    expect(sign(compareSortValues(text('APPLE'), text('apple'), true))).toBe(-1)
    // Non-ASCII fold: 'É' folds to 'é'.
    expect(compareSortValues(text('É'), text('é'), false)).toBe(0)
  })

  test('text compares by CODE POINT, not UTF-16 code unit', () => {
    // U+FFFF (BMP) vs U+1F600 (😀, astral). By code point FFFF < 1F600, so
    // '￿' < '😀'. A naive UTF-16 comparison would order the astral char
    // FIRST (its lead surrogate 0xD83D < 0xFFFF) — this pins code-point order.
    expect(sign(compareSortText('￿', '\u{1F600}', true))).toBe(-1)
    expect(sign(compareSortText('\u{1F600}', '￿', true))).toBe(1)
  })

  test('booleans FALSE < TRUE; errors mutually equal', () => {
    expect(sign(compareSortValues(bool(false), bool(true), false))).toBe(-1)
    expect(compareSortValues(bool(true), bool(true), false)).toBe(0)
    expect(compareSortValues(err, err, false)).toBe(0)
  })

  test('descending reverses the non-empty comparison including type classes', () => {
    expect(sign(compareSortValuesWithDirection(num(1), num(2), false, 'desc'))).toBe(1)
    // A number is the LAST non-empty class under descending (before empty).
    expect(sign(compareSortValuesWithDirection(text('a'), num(2), false, 'desc'))).toBe(-1)
  })
})

describe('slot algorithm — planPhysicalSort', () => {
  const asc = (col: number): ResolvedSortKey => ({ col, direction: 'asc', caseSensitive: false })

  test('stable permutation of equal keys and identity no-op', () => {
    // keys 2,1,2,1 on rows 0..3 → stable asc: rows 1,3 (key 1) then 0,2 (key 2).
    const keys = [num(2), num(1), num(2), num(1)]
    const plan = planPhysicalSort(0, 3, [], [asc(0)], (row) => keys[row])
    expect(plan.rowPermutation).toEqual([
      [0, 1],
      [1, 3],
      [2, 0],
      [3, 2],
    ])

    const sorted = [num(1), num(2), num(3)]
    const noop = planPhysicalSort(0, 2, [], [asc(0)], (row) => sorted[row])
    expect(noop.rowMap.size).toBe(0)
    expect(noop.rowPermutation).toEqual([])
  })

  test('excluded rows keep their slot and never compare', () => {
    // row 1 excluded; visible rows 0,2,3 with keys 4,2,1 → 1,2,4 (rows 3,2,0).
    const keys = [num(4), num(999), num(2), num(1)]
    const plan = planPhysicalSort(0, 3, [1], [asc(0)], (row) => keys[row])
    expect(plan.visibleRows).toEqual([0, 2, 3])
    // No permutation pair touches the excluded row 1.
    expect(plan.rowPermutation.every(([slot, src]) => slot !== 1 && src !== 1)).toBe(true)
    expect(plan.rowMap.get(1)).toBeUndefined()
  })
})
