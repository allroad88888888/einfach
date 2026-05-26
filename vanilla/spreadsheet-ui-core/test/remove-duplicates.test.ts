import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src/backend/types'
import {
  closeRemoveDuplicatesAtom,
  deselectAllKeyColumnsAtom,
  findDuplicateRows,
  openRemoveDuplicatesAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesRangeAtom,
  removeDuplicatesScanInputCellsAtom,
  selectAllKeyColumnsAtom,
  toggleKeyColumnAtom,
  type RemoveDuplicatesRange,
} from '../src/remove-duplicates'

function cell(row: number, col: number, value: string, kind: DisplayCell['valueKind'] = 'string'): DisplayCell {
  return { row, col, displayValue: value, valueKind: kind }
}

function range(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): RemoveDuplicatesRange {
  return { startRow, startCol, endRow, endCol }
}

describe('findDuplicateRows', () => {
  test('3 unique rows produce 0 duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'header-a'), cell(0, 1, 'header-b'),
      cell(1, 0, 'apple'), cell(1, 1, '1'),
      cell(2, 0, 'banana'), cell(2, 1, '2'),
      cell(3, 0, 'cherry'), cell(3, 1, '3'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 1),
      keyColumns: new Set([0, 1]),
    })
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(3)
    expect(result.uniqueRows).toBe(3)
    expect(result.headerRow).toBe(0)
  })

  test('3 identical rows mark rows 2 and 3 (header excluded)', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'h'),
      cell(1, 0, 'x'),
      cell(2, 0, 'x'),
      cell(3, 0, 'x'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 0),
      keyColumns: new Set([0]),
    })
    expect(result.duplicateRows).toEqual([2, 3])
    expect(result.scannedRows).toBe(3)
    expect(result.uniqueRows).toBe(1)
  })

  test('multi-column key: same in col A but different in col B is NOT a duplicate', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, 'foo'), cell(1, 1, 'one'),
      cell(2, 0, 'foo'), cell(2, 1, 'two'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('multi-column key: same in selected cols but different in unselected col IS a duplicate', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, 'foo'), cell(1, 1, 'differs-A'), cell(1, 2, 'shared'),
      cell(2, 0, 'foo'), cell(2, 1, 'differs-B'), cell(2, 2, 'shared'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 2),
      keyColumns: new Set([0, 2]), // col 1 (the differing one) is unchecked
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([2])
  })

  test('excludeHeader=true: header row 0 always survives even when it duplicates a data row', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'same'),
      cell(1, 0, 'same'),
      cell(2, 0, 'same'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: true,
    })
    expect(result.duplicateRows).toEqual([2])
    expect(result.headerRow).toBe(0)
  })

  test('excludeHeader=false: header is treated as a data row', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'same'),
      cell(1, 0, 'same'),
      cell(2, 0, 'same'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([1, 2])
    expect(result.headerRow).toBeNull()
    expect(result.scannedRows).toBe(3)
  })

  test('comparison=exact: "foo" vs "Foo" are NOT duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'foo'),
      cell(1, 0, 'Foo'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'exact',
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('comparison=caseInsensitive: "foo" vs "Foo" ARE duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'foo'),
      cell(1, 0, 'Foo'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'caseInsensitive',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('comparison=trim: " x" vs "x " ARE duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, ' x'),
      cell(1, 0, 'x '),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'trim',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('comparison=trimAndIgnoreCase: " Foo " vs "foo" ARE duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, ' Foo '),
      cell(1, 0, 'foo'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
      comparison: 'trimAndIgnoreCase',
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('two rows that are blank in every key column ARE duplicates of each other', () => {
    const cells: DisplayCell[] = [
      // header
      cell(0, 0, 'A'), cell(0, 1, 'B'),
      // rows 1 and 2 have nothing in col 0 or 1
      cell(1, 2, 'side-data-1'),
      cell(2, 2, 'side-data-2'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 2, 1),
      keyColumns: new Set([0, 1]),
    })
    expect(result.duplicateRows).toEqual([2])
    expect(result.scannedRows).toBe(2)
    expect(result.uniqueRows).toBe(1)
  })

  test('sparse projection: missing cells default to blank for tuple purposes', () => {
    const cells: DisplayCell[] = [
      // header
      cell(0, 0, 'h0'), cell(0, 1, 'h1'),
      // row 1: only col 0 present
      cell(1, 0, 'shared'),
      // row 2: only col 0 present, same value
      cell(2, 0, 'shared'),
      // row 3: col 0 same, col 1 differs (now present)
      cell(3, 0, 'shared'), cell(3, 1, 'diff'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 1),
      keyColumns: new Set([0, 1]),
    })
    // rows 1 and 2 share (shared, ''); row 3 is (shared, diff) — unique.
    expect(result.duplicateRows).toEqual([2])
  })

  test('key column outside [startCol..endCol] is reported in ignoredColumns', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, 'a'),
      cell(2, 0, 'a'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 0),
      // col 5 is outside the range — should land in ignoredColumns.
      keyColumns: new Set([0, 5]),
      excludeHeader: false,
    })
    expect(result.ignoredColumns).toEqual([5])
    expect(result.duplicateRows).toEqual([2])
  })

  test('empty range (startRow > endRow) returns scannedRows=0 with no throw', () => {
    const result = findDuplicateRows({
      cells: [],
      range: range(5, 0, 4, 0),
      keyColumns: new Set([0]),
    })
    expect(result.scannedRows).toBe(0)
    expect(result.duplicateRows).toEqual([])
    expect(result.uniqueRows).toBe(0)
    expect(result.headerRow).toBeNull()
  })

  test('single row (after header exclusion) yields zero duplicates', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'header'),
      cell(1, 0, 'only-data'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
    })
    expect(result.scannedRows).toBe(1)
    expect(result.duplicateRows).toEqual([])
  })

  test('empty keyColumns returns noKeyColumns:true without throwing', () => {
    const result = findDuplicateRows({
      cells: [],
      range: range(0, 0, 1, 0),
      keyColumns: new Set<number>(),
    })
    expect(result.noKeyColumns).toBe(true)
    expect(result.duplicateRows).toEqual([])
    expect(result.scannedRows).toBe(0)
    expect(result.uniqueRows).toBe(0)
  })

  test('keyColumns entirely out of range returns noKeyColumns:true and reports ignoredColumns', () => {
    const result = findDuplicateRows({
      cells: [cell(1, 0, 'a'), cell(2, 0, 'a')],
      range: range(1, 0, 2, 0),
      // all key columns sit outside [0..0]
      keyColumns: new Set([5, 7]),
      excludeHeader: false,
    })
    expect(result.noKeyColumns).toBe(true)
    expect(result.ignoredColumns).toEqual([5, 7])
    expect(result.duplicateRows).toEqual([])
  })

  test('tuple key: identical cell containing U+001F across both rows IS a duplicate', () => {
    const cells: DisplayCell[] = [
      cell(0, 0, 'a\x1Fb'),
      cell(1, 0, 'a\x1Fb'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([1])
  })

  test('tuple key: row with single-cell "a\\x1Fb" is NOT a duplicate of row with two cells ["a","b"]', () => {
    // This was the regression in the U+001F-separator scheme: the
    // single-column row produced "a\x1Fb" and the two-column row also
    // produced "a\x1Fb", spuriously colliding. Length-prefixing makes
    // these distinguishable ("3:a\x1Fb" vs "1:a|1:b").
    const cells: DisplayCell[] = [
      // row 0: single key column 0, value contains U+001F
      cell(0, 0, 'a\x1Fb'),
      // row 1: two key columns, 'a' and 'b'
      cell(1, 0, 'a'),
      cell(1, 1, 'b'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 1, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([])
  })

  test('tuple key: newlines, null bytes, and surrogate-pair emoji do not produce false collisions', () => {
    const cells: DisplayCell[] = [
      // row 0: ['a\nb', 'c']
      cell(0, 0, 'a\nb'),
      cell(0, 1, 'c'),
      // row 1: ['a', 'b\nc']  — same chars merged differently
      cell(1, 0, 'a'),
      cell(1, 1, 'b\nc'),
      // row 2: ['a\0b', '']
      cell(2, 0, 'a\x00b'),
      // row 3: ['a', '\0b']   — same chars but split
      cell(3, 0, 'a'),
      cell(3, 1, '\x00b'),
      // row 4 & 5: identical emoji surrogate pair → duplicate of each other.
      cell(4, 0, 'x'),
      cell(4, 1, '😀'),
      cell(5, 0, 'x'),
      cell(5, 1, '😀'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 5, 1),
      keyColumns: new Set([0, 1]),
      excludeHeader: false,
    })
    // Only row 5 collides with row 4.
    expect(result.duplicateRows).toEqual([5])
  })

  test('filter/sort projection: duplicateRows carries originalRow, not visual row', () => {
    // Simulates a sorted projection where visual rows 1..3 map to
    // source rows 42, 7, 19. Two cells share the same value, so the
    // SECOND-seen visual row is a duplicate — but the reported index
    // must be its `originalRow` so backend.removeRows deletes the
    // right source row.
    const c = (row: number, col: number, value: string, originalRow: number): DisplayCell => ({
      row,
      col,
      displayValue: value,
      valueKind: 'string',
      originalRow,
    })
    const cells: DisplayCell[] = [
      c(0, 0, 'header', 0),
      c(1, 0, 'shared', 42),
      c(2, 0, 'unique', 7),
      c(3, 0, 'shared', 19),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(0, 0, 3, 0),
      keyColumns: new Set([0]),
    })
    // Visual row 3 is the duplicate; its source row is 19, NOT 3.
    expect(result.duplicateRows).toEqual([19])
  })

  test('projection bug: cells in same visual row report different originalRow → warn once, keep first', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cells: DisplayCell[] = [
        { row: 1, col: 0, displayValue: 'a', valueKind: 'string', originalRow: 10 },
        // bug: same visual row, conflicting source row
        { row: 1, col: 1, displayValue: 'x', valueKind: 'string', originalRow: 99 },
        { row: 2, col: 0, displayValue: 'a', valueKind: 'string', originalRow: 11 },
        { row: 2, col: 1, displayValue: 'x', valueKind: 'string', originalRow: 11 },
      ]
      const result = findDuplicateRows({
        cells,
        range: range(1, 0, 2, 1),
        keyColumns: new Set([0, 1]),
        excludeHeader: false,
      })
      // visual row 2 dupes visual row 1 → reports source row 11.
      expect(result.duplicateRows).toEqual([11])
      // and warned, but didn't throw.
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('blank-kind cell normalises to empty string regardless of displayValue', () => {
    const cells: DisplayCell[] = [
      cell(1, 0, '', 'blank'),
      cell(2, 0, 'leftover-text', 'blank'),
    ]
    const result = findDuplicateRows({
      cells,
      range: range(1, 0, 2, 0),
      keyColumns: new Set([0]),
      excludeHeader: false,
    })
    expect(result.duplicateRows).toEqual([2])
  })
})

describe('remove-duplicates atoms', () => {
  test('initial state: dialog closed, preview is null', () => {
    const store = createStore()
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesPreviewAtom)).toBeNull()
  })

  test('openRemoveDuplicatesAtom seeds range, cells, defaults keyColumns to all cols in range', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      cell(1, 2, 'foo'),
      cell(1, 3, 'bar'),
    ]
    store.setter(openRemoveDuplicatesAtom, range(1, 2, 5, 4), cells)
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
    expect(store.getter(removeDuplicatesRangeAtom)).toEqual(range(1, 2, 5, 4))
    expect(store.getter(removeDuplicatesScanInputCellsAtom)).toEqual(cells)
    expect(Array.from(store.getter(removeDuplicatesKeyColumnsAtom)).sort()).toEqual([2, 3, 4])
  })

  test('toggleKeyColumnAtom adds and removes a column immutably', () => {
    const store = createStore()
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 2, 2), [])
    const before = store.getter(removeDuplicatesKeyColumnsAtom)
    store.setter(toggleKeyColumnAtom, 1)
    const afterRemove = store.getter(removeDuplicatesKeyColumnsAtom)
    expect(afterRemove).not.toBe(before) // fresh Set reference
    expect(afterRemove.has(1)).toBe(false)
    expect(afterRemove.has(0)).toBe(true)
    expect(afterRemove.has(2)).toBe(true)

    store.setter(toggleKeyColumnAtom, 1)
    const afterReAdd = store.getter(removeDuplicatesKeyColumnsAtom)
    expect(afterReAdd.has(1)).toBe(true)
  })

  test('deselectAllKeyColumnsAtom makes preview report noKeyColumns:true (and uniqueRows=0)', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      cell(0, 0, 'a'),
      cell(1, 0, 'a'),
      cell(2, 0, 'b'),
    ]
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 2, 0), cells)
    // Confirm we get a real preview first.
    const previewBefore = store.getter(removeDuplicatesPreviewAtom)
    expect(previewBefore?.noKeyColumns).toBe(false)

    store.setter(deselectAllKeyColumnsAtom)
    const previewAfter = store.getter(removeDuplicatesPreviewAtom)
    expect(previewAfter).not.toBeNull()
    expect(previewAfter?.noKeyColumns).toBe(true)
    expect(previewAfter?.duplicateRows).toEqual([])
    expect(previewAfter?.scannedRows).toBe(0)
    expect(previewAfter?.uniqueRows).toBe(0)
  })

  test('selectAllKeyColumnsAtom restores the full range column set', () => {
    const store = createStore()
    store.setter(openRemoveDuplicatesAtom, range(0, 1, 4, 3), [])
    store.setter(deselectAllKeyColumnsAtom)
    expect(store.getter(removeDuplicatesKeyColumnsAtom).size).toBe(0)
    store.setter(selectAllKeyColumnsAtom)
    expect(Array.from(store.getter(removeDuplicatesKeyColumnsAtom)).sort()).toEqual([1, 2, 3])
  })

  test('closeRemoveDuplicatesAtom clears range, cells, key columns; preview goes null', () => {
    const store = createStore()
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 2, 0), [cell(0, 0, 'x')])
    store.setter(closeRemoveDuplicatesAtom)
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesRangeAtom)).toBeNull()
    expect(store.getter(removeDuplicatesScanInputCellsAtom)).toEqual([])
    expect(store.getter(removeDuplicatesKeyColumnsAtom).size).toBe(0)
    expect(store.getter(removeDuplicatesPreviewAtom)).toBeNull()
  })

  test('close does not reset comparison or excludeHeader (session-sticky)', () => {
    const store = createStore()
    store.setter(removeDuplicatesComparisonAtom, 'trimAndIgnoreCase')
    store.setter(removeDuplicatesExcludeHeaderAtom, false)
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 1, 0), [])
    store.setter(closeRemoveDuplicatesAtom)
    expect(store.getter(removeDuplicatesComparisonAtom)).toBe('trimAndIgnoreCase')
    expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(false)
  })

  test('preview reflects comparison + excludeHeader atoms', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      cell(0, 0, 'Foo'),
      cell(1, 0, 'foo'),
      cell(2, 0, 'FOO'),
    ]
    store.setter(removeDuplicatesExcludeHeaderAtom, false)
    store.setter(removeDuplicatesComparisonAtom, 'caseInsensitive')
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 2, 0), cells)
    const preview = store.getter(removeDuplicatesPreviewAtom)
    expect(preview?.duplicateRows).toEqual([1, 2])
    expect(preview?.headerRow).toBeNull()
  })

  test('preview reports ignoredColumns for out-of-range key cols (even when other cols still match)', () => {
    const store = createStore()
    store.setter(openRemoveDuplicatesAtom, range(0, 0, 2, 1), [
      cell(0, 0, 'h0'), cell(0, 1, 'h1'),
      cell(1, 0, 'x'), cell(1, 1, 'y'),
      cell(2, 0, 'x'), cell(2, 1, 'y'),
    ])
    // Force a key set containing an out-of-range column.
    store.setter(removeDuplicatesKeyColumnsAtom, new Set([0, 1, 99]))
    const preview = store.getter(removeDuplicatesPreviewAtom)
    expect(preview?.ignoredColumns).toEqual([99])
    expect(preview?.duplicateRows).toEqual([2])
  })

  test('preview is null when dialog is closed but range/cells are still set', () => {
    const store = createStore()
    store.setter(removeDuplicatesRangeAtom, range(0, 0, 1, 0))
    store.setter(removeDuplicatesScanInputCellsAtom, [cell(0, 0, 'a'), cell(1, 0, 'a')])
    store.setter(removeDuplicatesKeyColumnsAtom, new Set([0]))
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    expect(store.getter(removeDuplicatesPreviewAtom)).toBeNull()
  })
})
