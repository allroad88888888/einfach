/**
 * Wave B / B3 — refs / a1 / ranges tests.
 *
 * Discipline: pure functions only — no atoms, no store, no Solid. Every
 * test is fully described by its inputs/outputs.
 */
import { describe, expect, test } from '@jest/globals'

import {
  EXCEL_MAX_COL,
  EXCEL_MAX_ROW,
  EXPAND_MAX_CELLS,
  RangeTooLargeError,
  cellKey,
  colIndexToName,
  colNameToIndex,
  expandRange,
  formatA1,
  iterateRange,
  normalizeRange,
  parseA1,
  parseRange,
  parseRangeString,
  rangeContains,
  rangesIntersect,
} from '../src/refs'

describe('refs/a1 — colNameToIndex', () => {
  test("'A' -> 0", () => {
    expect(colNameToIndex('A')).toBe(0)
  })
  test("'Z' -> 25", () => {
    expect(colNameToIndex('Z')).toBe(25)
  })
  test("'AA' -> 26", () => {
    expect(colNameToIndex('AA')).toBe(26)
  })
  test("'AB' -> 27", () => {
    expect(colNameToIndex('AB')).toBe(27)
  })
  test("'AZ' -> 51", () => {
    expect(colNameToIndex('AZ')).toBe(51)
  })
  test("'BA' -> 52", () => {
    expect(colNameToIndex('BA')).toBe(52)
  })
  test("'ZZ' -> 701", () => {
    expect(colNameToIndex('ZZ')).toBe(701)
  })
  test("'AAA' -> 702", () => {
    expect(colNameToIndex('AAA')).toBe(702)
  })
  test("'XFD' -> 16383 (Excel max)", () => {
    expect(colNameToIndex('XFD')).toBe(EXCEL_MAX_COL)
  })
  test('lowercase is accepted', () => {
    expect(colNameToIndex('a')).toBe(0)
    expect(colNameToIndex('xfd')).toBe(16383)
    expect(colNameToIndex('aA')).toBe(26)
  })
  test('empty input returns -1', () => {
    expect(colNameToIndex('')).toBe(-1)
  })
  test('non-letter input returns -1', () => {
    expect(colNameToIndex('1')).toBe(-1)
    expect(colNameToIndex('A1')).toBe(-1)
    expect(colNameToIndex('-')).toBe(-1)
  })
  test("'XFE' (one past XFD) returns -1", () => {
    expect(colNameToIndex('XFE')).toBe(-1)
  })
  test('round-trip through colIndexToName covers boundaries', () => {
    for (const idx of [0, 25, 26, 51, 52, 701, 702, 16383]) {
      expect(colNameToIndex(colIndexToName(idx))).toBe(idx)
    }
  })
})

describe('refs/a1 — colIndexToName', () => {
  test('0 -> A, 25 -> Z, 26 -> AA, 16383 -> XFD', () => {
    expect(colIndexToName(0)).toBe('A')
    expect(colIndexToName(25)).toBe('Z')
    expect(colIndexToName(26)).toBe('AA')
    expect(colIndexToName(16383)).toBe('XFD')
  })
  test('throws on negative', () => {
    expect(() => colIndexToName(-1)).toThrow(RangeError)
  })
  test('throws on > max', () => {
    expect(() => colIndexToName(16384)).toThrow(RangeError)
  })
  test('throws on non-integer', () => {
    expect(() => colIndexToName(1.5)).toThrow(RangeError)
  })
})

describe('refs/a1 — parseA1', () => {
  test('A1 -> row 0, col 0, no absolute', () => {
    expect(parseA1('A1')).toEqual({ row: 0, col: 0, absRow: false, absCol: false })
  })
  test('B2 -> row 1, col 1', () => {
    expect(parseA1('B2')).toEqual({ row: 1, col: 1, absRow: false, absCol: false })
  })
  test('Z1 -> row 0, col 25', () => {
    expect(parseA1('Z1')).toEqual({ row: 0, col: 25, absRow: false, absCol: false })
  })
  test('AA1 -> row 0, col 26', () => {
    expect(parseA1('AA1')).toEqual({ row: 0, col: 26, absRow: false, absCol: false })
  })
  test('AA12 -> row 11, col 26', () => {
    expect(parseA1('AA12')).toEqual({ row: 11, col: 26, absRow: false, absCol: false })
  })
  test('XFD1048576 (Excel max corner)', () => {
    expect(parseA1('XFD1048576')).toEqual({
      row: EXCEL_MAX_ROW,
      col: EXCEL_MAX_COL,
      absRow: false,
      absCol: false,
    })
  })
  test('$A$1 -> both absolute', () => {
    expect(parseA1('$A$1')).toEqual({ row: 0, col: 0, absRow: true, absCol: true })
  })
  test('$A1 -> col absolute only', () => {
    expect(parseA1('$A1')).toEqual({ row: 0, col: 0, absRow: false, absCol: true })
  })
  test('A$1 -> row absolute only', () => {
    expect(parseA1('A$1')).toEqual({ row: 0, col: 0, absRow: true, absCol: false })
  })
  test('lowercase a1 normalizes', () => {
    expect(parseA1('a1')).toEqual({ row: 0, col: 0, absRow: false, absCol: false })
    expect(parseA1('xfd1048576')).toEqual({
      row: EXCEL_MAX_ROW,
      col: EXCEL_MAX_COL,
      absRow: false,
      absCol: false,
    })
  })
  test('rejects empty / whitespace', () => {
    expect(parseA1('')).toBeNull()
    expect(parseA1('   ')).toBeNull()
    expect(parseA1(' A1')).toBeNull()
    expect(parseA1('A1 ')).toBeNull()
  })
  test('rejects letters-only / digits-only', () => {
    expect(parseA1('A')).toBeNull()
    expect(parseA1('1')).toBeNull()
    expect(parseA1('$A')).toBeNull()
    expect(parseA1('$1')).toBeNull()
  })
  test('rejects stray $ markers', () => {
    expect(parseA1('$$A1')).toBeNull()
    expect(parseA1('A$$1')).toBeNull()
    expect(parseA1('A1$')).toBeNull()
  })
  test('rejects row 0 / negative row', () => {
    expect(parseA1('A0')).toBeNull()
  })
  test('rejects leading-zero rows like A01', () => {
    expect(parseA1('A01')).toBeNull()
    expect(parseA1('A001')).toBeNull()
  })
  test('rejects column past XFD', () => {
    expect(parseA1('XFE1')).toBeNull()
    expect(parseA1('AAAA1')).toBeNull() // 4 letters fail regex
  })
  test('rejects row past 1048576', () => {
    expect(parseA1('A1048577')).toBeNull()
    expect(parseA1('A9999999')).toBeNull()
  })
  test('rejects mixed garbage', () => {
    expect(parseA1('A1B')).toBeNull()
    expect(parseA1('1A')).toBeNull()
    expect(parseA1('Sheet2!A1')).toBeNull() // cross-sheet — caller's problem
  })
  test('non-string input returns null', () => {
    // @ts-expect-error testing runtime guard
    expect(parseA1(null)).toBeNull()
    // @ts-expect-error testing runtime guard
    expect(parseA1(undefined)).toBeNull()
    // @ts-expect-error testing runtime guard
    expect(parseA1(42)).toBeNull()
  })
})

describe('refs/a1 — formatA1', () => {
  test('inverse of parseA1 for unmarked cells', () => {
    expect(formatA1({ row: 0, col: 0 })).toBe('A1')
    expect(formatA1({ row: 1, col: 1 })).toBe('B2')
    expect(formatA1({ row: 11, col: 26 })).toBe('AA12')
    expect(formatA1({ row: EXCEL_MAX_ROW, col: EXCEL_MAX_COL })).toBe('XFD1048576')
  })
  test('emits $ on absolute flags', () => {
    expect(formatA1({ row: 0, col: 0, absRow: true })).toBe('A$1')
    expect(formatA1({ row: 0, col: 0, absCol: true })).toBe('$A1')
    expect(formatA1({ row: 0, col: 0, absRow: true, absCol: true })).toBe('$A$1')
  })
  test('round-trips every shape produced by parseA1', () => {
    const inputs = ['A1', 'B2', 'AA12', '$A$1', '$A1', 'A$1', 'XFD1048576']
    for (const a1 of inputs) {
      const parsed = parseA1(a1)
      expect(parsed).not.toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(formatA1(parsed!)).toBe(a1)
    }
  })
  test('throws on out-of-bounds row/col', () => {
    expect(() => formatA1({ row: -1, col: 0 })).toThrow(RangeError)
    expect(() => formatA1({ row: 0, col: -1 })).toThrow(RangeError)
    expect(() => formatA1({ row: EXCEL_MAX_ROW + 1, col: 0 })).toThrow(RangeError)
    expect(() => formatA1({ row: 0, col: EXCEL_MAX_COL + 1 })).toThrow(RangeError)
  })
})

describe('refs/ranges — cellKey', () => {
  test('formats <row>:<col>', () => {
    expect(cellKey({ row: 0, col: 0 })).toBe('0:0')
    expect(cellKey({ row: 9, col: 25 })).toBe('9:25')
    expect(cellKey({ row: EXCEL_MAX_ROW, col: EXCEL_MAX_COL })).toBe(
      `${EXCEL_MAX_ROW}:${EXCEL_MAX_COL}`,
    )
  })
})

describe('refs/ranges — parseRange (two endpoints)', () => {
  test("'A1','B10' -> { 0..9 rows, 0..1 cols }", () => {
    expect(parseRange('A1', 'B10')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test("'B10','A1' normalizes start <= end", () => {
    expect(parseRange('B10', 'A1')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test('absolute markers are tolerated and discarded', () => {
    expect(parseRange('$A$1', '$B$10')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test('whole columns: A,A -> all rows in col 0', () => {
    expect(parseRange('A', 'A')).toEqual({
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROW,
      colStart: 0,
      colEnd: 0,
    })
  })
  test('whole columns: A,C -> all rows, cols 0..2', () => {
    expect(parseRange('A', 'C')).toEqual({
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROW,
      colStart: 0,
      colEnd: 2,
    })
  })
  test('whole rows: 1,1 -> row 0 across all cols', () => {
    expect(parseRange('1', '1')).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: EXCEL_MAX_COL,
    })
  })
  test('whole rows: 2,5 -> rows 1..4 across all cols', () => {
    expect(parseRange('2', '5')).toEqual({
      rowStart: 1,
      rowEnd: 4,
      colStart: 0,
      colEnd: EXCEL_MAX_COL,
    })
  })
  test('mixed shapes (cell + col) returns null', () => {
    expect(parseRange('A1', 'B')).toBeNull()
    expect(parseRange('A', 'B2')).toBeNull()
  })
  test('mixed shapes (cell + row) returns null', () => {
    expect(parseRange('A1', '5')).toBeNull()
    expect(parseRange('1', 'A1')).toBeNull()
  })
  test('mixed shapes (col + row) returns null', () => {
    expect(parseRange('A', '5')).toBeNull()
    expect(parseRange('5', 'A')).toBeNull()
  })
  test('malformed endpoints return null', () => {
    expect(parseRange('foo', 'A1')).toBeNull()
    expect(parseRange('A1', 'foo')).toBeNull()
    expect(parseRange('', '')).toBeNull()
  })
})

describe('refs/ranges — parseRangeString', () => {
  test("'A1:B10' is the canonical case", () => {
    expect(parseRangeString('A1:B10')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test("'B10:A1' normalizes endpoints", () => {
    expect(parseRangeString('B10:A1')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test("'A:A' -> whole column", () => {
    expect(parseRangeString('A:A')).toEqual({
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROW,
      colStart: 0,
      colEnd: 0,
    })
  })
  test("'1:1' -> whole row", () => {
    expect(parseRangeString('1:1')).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: EXCEL_MAX_COL,
    })
  })
  test("'$A$1:$B$10' tolerates absolute markers", () => {
    expect(parseRangeString('$A$1:$B$10')).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 1,
    })
  })
  test('missing colon -> null', () => {
    expect(parseRangeString('A1B10')).toBeNull()
  })
  test('multiple colons -> null (cross-sheet must split prefix first)', () => {
    expect(parseRangeString('A1:B10:C20')).toBeNull()
  })
  test('empty endpoint -> null', () => {
    expect(parseRangeString(':A1')).toBeNull()
    expect(parseRangeString('A1:')).toBeNull()
    expect(parseRangeString(':')).toBeNull()
  })
  test('mixed shape (cell + col) -> null', () => {
    expect(parseRangeString('A1:B')).toBeNull()
  })
  test('non-string input -> null', () => {
    // @ts-expect-error runtime guard
    expect(parseRangeString(null)).toBeNull()
    // @ts-expect-error runtime guard
    expect(parseRangeString(undefined)).toBeNull()
  })
})

describe('refs/ranges — normalizeRange', () => {
  test('passes already-normalized ranges through', () => {
    const r = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 5 }
    expect(normalizeRange(r)).toEqual(r)
  })
  test('swaps inverted rows', () => {
    expect(normalizeRange({ rowStart: 9, rowEnd: 0, colStart: 0, colEnd: 0 })).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 0,
    })
  })
  test('swaps inverted cols', () => {
    expect(normalizeRange({ rowStart: 0, rowEnd: 0, colStart: 9, colEnd: 0 })).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 9,
    })
  })
  test('swaps both', () => {
    expect(normalizeRange({ rowStart: 5, rowEnd: 2, colStart: 7, colEnd: 3 })).toEqual({
      rowStart: 2,
      rowEnd: 5,
      colStart: 3,
      colEnd: 7,
    })
  })
})

describe('refs/ranges — iterateRange', () => {
  test('1x1 range yields its single cell', () => {
    const out = Array.from(iterateRange({ rowStart: 4, rowEnd: 4, colStart: 7, colEnd: 7 }))
    expect(out).toEqual([{ row: 4, col: 7 }])
  })
  test('2x3 range row-major order', () => {
    const out = Array.from(iterateRange({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 }))
    expect(out).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ])
  })
  test('handles inverted ranges by normalizing internally', () => {
    const out = Array.from(iterateRange({ rowStart: 1, rowEnd: 0, colStart: 1, colEnd: 0 }))
    expect(out).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ])
  })
  test('whole-column range iterates lazily (no materialization)', () => {
    const it = iterateRange({
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROW,
      colStart: 0,
      colEnd: 0,
    })
    // Pull the first 3 and stop.
    const first = it.next().value
    const second = it.next().value
    const third = it.next().value
    expect(first).toEqual({ row: 0, col: 0 })
    expect(second).toEqual({ row: 1, col: 0 })
    expect(third).toEqual({ row: 2, col: 0 })
  })
})

describe('refs/ranges — expandRange', () => {
  test('1x1 -> single coord', () => {
    expect(expandRange({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })).toEqual([
      { row: 0, col: 0 },
    ])
  })
  test('2x2 row-major', () => {
    expect(expandRange({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ])
  })
  test('exactly EXPAND_MAX_CELLS is allowed', () => {
    // 100k cells = 100 rows x 1000 cols
    const out = expandRange({ rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 999 })
    expect(out).toHaveLength(EXPAND_MAX_CELLS)
  })
  test('one cell past EXPAND_MAX_CELLS throws RangeTooLargeError', () => {
    expect(() =>
      expandRange({ rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 1000 }),
    ).toThrow(RangeTooLargeError)
  })
  test('RangeTooLargeError carries the offending range + count', () => {
    try {
      expandRange({ rowStart: 0, rowEnd: EXCEL_MAX_ROW, colStart: 0, colEnd: 0 })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(RangeTooLargeError)
      const err = e as RangeTooLargeError
      expect(err.cellCount).toBe(EXCEL_MAX_ROW + 1)
      expect(err.range.rowStart).toBe(0)
      expect(err.range.colStart).toBe(0)
    }
  })
})

describe('refs/ranges — rangeContains', () => {
  const r = { rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 3 }
  test('inside', () => {
    expect(rangeContains(r, { row: 3, col: 2 })).toBe(true)
  })
  test('corners (inclusive)', () => {
    expect(rangeContains(r, { row: 2, col: 1 })).toBe(true)
    expect(rangeContains(r, { row: 4, col: 3 })).toBe(true)
    expect(rangeContains(r, { row: 2, col: 3 })).toBe(true)
    expect(rangeContains(r, { row: 4, col: 1 })).toBe(true)
  })
  test('outside on each side', () => {
    expect(rangeContains(r, { row: 1, col: 2 })).toBe(false)
    expect(rangeContains(r, { row: 5, col: 2 })).toBe(false)
    expect(rangeContains(r, { row: 3, col: 0 })).toBe(false)
    expect(rangeContains(r, { row: 3, col: 4 })).toBe(false)
  })
  test('handles inverted range input', () => {
    expect(rangeContains({ rowStart: 4, rowEnd: 2, colStart: 3, colEnd: 1 }, { row: 3, col: 2 })).toBe(
      true,
    )
  })
})

describe('refs/ranges — rangesIntersect', () => {
  test('overlapping interiors', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
        { rowStart: 3, rowEnd: 8, colStart: 3, colEnd: 8 },
      ),
    ).toBe(true)
  })
  test('touching at the corner is intersection (inclusive)', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
        { rowStart: 2, rowEnd: 4, colStart: 2, colEnd: 4 },
      ),
    ).toBe(true)
  })
  test('side-by-side with gap returns false', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
        { rowStart: 0, rowEnd: 5, colStart: 6, colEnd: 10 },
      ),
    ).toBe(false)
  })
  test('stacked with row gap returns false', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 5 },
        { rowStart: 3, rowEnd: 5, colStart: 0, colEnd: 5 },
      ),
    ).toBe(false)
  })
  test('full containment intersects', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 10 },
        { rowStart: 3, rowEnd: 4, colStart: 3, colEnd: 4 },
      ),
    ).toBe(true)
  })
  test('whole-column vs cell range', () => {
    expect(
      rangesIntersect(
        { rowStart: 0, rowEnd: EXCEL_MAX_ROW, colStart: 0, colEnd: 0 },
        { rowStart: 5, rowEnd: 10, colStart: 0, colEnd: 3 },
      ),
    ).toBe(true)
  })
  test('inverted input is normalized', () => {
    expect(
      rangesIntersect(
        { rowStart: 5, rowEnd: 0, colStart: 5, colEnd: 0 },
        { rowStart: 2, rowEnd: 3, colStart: 2, colEnd: 3 },
      ),
    ).toBe(true)
  })
})
