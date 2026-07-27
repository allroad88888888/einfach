import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  applyViewportFilterHiddenStructuralShiftAtom,
  applyViewportHiddenStructuralShiftAtom,
  clearViewportFilterHiddenRowsAtom,
  DEFAULT_VIEWPORT_FILTER_HIDDEN_STATE,
  effectiveHiddenAtom,
  getFilterHiddenRowsForSheet,
  getHiddenRowsForSheet,
  hideColumnsAtom,
  hideRowsAtom,
  isRowFilterHidden,
  remapIndexSetAfterStructuralShift,
  setViewportFilterHiddenRowsAtom,
  unhideRowsAtom,
  unionHiddenRowsForSheet,
  viewportFilterHiddenAtom,
  viewportHiddenAtom,
} from '../src/viewport'
import type { BackendStructuralShift } from '../src/backend/types'

describe('viewport filter-hidden source atom', () => {
  test('starts empty and reports no rows for any sheet', () => {
    const store = createStore()
    expect(store.getter(viewportFilterHiddenAtom)).toEqual(DEFAULT_VIEWPORT_FILTER_HIDDEN_STATE)
    const state = store.getter(viewportFilterHiddenAtom)
    expect(getFilterHiddenRowsForSheet(state, 'sheet1')).toEqual([])
    expect(isRowFilterHidden(state, 'sheet1', 4)).toBe(false)
  })

  test('whole-set replace sanitises, sorts and de-duplicates', () => {
    const store = createStore()
    expect(
      store.setter(setViewportFilterHiddenRowsAtom, {
        sheetId: 'sheet1',
        rows: [7, 2, 2, 4, -1, 1.5, Number.NaN],
      }),
    ).toBe(true)
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet1')).toEqual([
      2, 4, 7,
    ])
  })

  test('replacing with an equal set reports no change', () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [1, 2] })
    expect(store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [2, 1] })).toBe(
      false,
    )
  })

  test('empty rows clears the sheet key; clear command is equivalent', () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [1, 2] })
    expect(store.setter(clearViewportFilterHiddenRowsAtom, 'sheet1')).toBe(true)
    expect(store.getter(viewportFilterHiddenAtom).rowsBySheet).toEqual({})
    expect(store.setter(clearViewportFilterHiddenRowsAtom, 'sheet1')).toBe(false)
  })

  test('sets are per sheet and do not leak across sheets', () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [1] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet2', rows: [9] })
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet1')).toEqual([
      1,
    ])
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet2')).toEqual([
      9,
    ])
  })

  test('rejects malformed input without mutating', () => {
    const store = createStore()
    expect(store.setter(setViewportFilterHiddenRowsAtom, { sheetId: '', rows: [1] })).toBe(false)
    expect(
      store.setter(setViewportFilterHiddenRowsAtom, {
        sheetId: 'sheet1',
        rows: undefined as unknown as number[],
      }),
    ).toBe(false)
    expect(store.getter(viewportFilterHiddenAtom).rowsBySheet).toEqual({})
  })
})

describe('effectiveHiddenAtom — manual ∪ filter', () => {
  test('degrades to the manual state by identity while the filter set is empty', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet1', indices: [2, 5] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet1', indices: [3] })
    // Referential identity, not just deep equality: with no filter rows the
    // union must not allocate, so nothing downstream re-derives. This is the
    // mechanical reason slice S3 is behaviour-neutral.
    expect(store.getter(effectiveHiddenAtom)).toBe(store.getter(viewportHiddenAtom))
  })

  test('merges both sets, sorted and de-duplicated, with columns passed through', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet1', indices: [5, 2] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet1', indices: [3] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [8, 5, 1] })

    const effective = store.getter(effectiveHiddenAtom)
    expect(effective.rowsBySheet.sheet1).toEqual([1, 2, 5, 8])
    expect(effective.colsBySheet.sheet1).toEqual([3])
  })

  test('surfaces filter rows on sheets that have no manual hidden rows', () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet2', rows: [3] })
    expect(store.getter(effectiveHiddenAtom).rowsBySheet.sheet2).toEqual([3])
  })

  test('unhiding a row does NOT clear the filter set for that row', () => {
    // §3 constraint 3: `Unhide Rows` over a filtered region must never
    // cancel the filter. Separate sets are what makes this expressible.
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet1', indices: [4] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet1', rows: [4] })
    store.setter(unhideRowsAtom, { sheetId: 'sheet1', indices: [4] })

    expect(store.getter(viewportHiddenAtom).rowsBySheet.sheet1).toEqual([])
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet1')).toEqual([
      4,
    ])
    expect(store.getter(effectiveHiddenAtom).rowsBySheet.sheet1).toEqual([4])
  })

  test('unionHiddenRowsForSheet returns the manual array by reference when filter is empty', () => {
    const manual = { rowsBySheet: { sheet1: [1, 2] }, colsBySheet: {} }
    const filter = { rowsBySheet: {} }
    expect(unionHiddenRowsForSheet(manual, filter, 'sheet1')).toBe(manual.rowsBySheet.sheet1)
    expect(unionHiddenRowsForSheet(manual, filter, 'other')).toEqual([])
  })

  test('unionHiddenRowsForSheet returns the filter array by reference when manual is empty', () => {
    const manual = { rowsBySheet: {}, colsBySheet: {} }
    const filter = { rowsBySheet: { sheet1: [4, 6] } }
    expect(unionHiddenRowsForSheet(manual, filter, 'sheet1')).toBe(filter.rowsBySheet.sheet1)
  })
})

// ---------------------------------------------------------------------------
// S5a — the filter-hidden set must follow structural displacement, exactly
// like the manual twin. Before the S5 flip the projection recomputed filter
// visibility on every revision bump, so an insert/delete self-corrected;
// after the flip the set is a snapshot, so it has to be remapped.
// ---------------------------------------------------------------------------

const SHEET = 'sheet-1'

/** 1-based row numbers still painted, given a row count and a hidden set. */
function visibleRowNumbers(rowCount: number, hidden: readonly number[]): number[] {
  const hiddenSet = new Set(hidden)
  const rows: number[] = []
  for (let row = 0; row < rowCount; row += 1) {
    if (!hiddenSet.has(row)) rows.push(row + 1)
  }
  return rows
}

function applyShift(store: ReturnType<typeof createStore>, shift: BackendStructuralShift): boolean {
  return store.setter(applyViewportFilterHiddenStructuralShiftAtom, { sheetId: SHEET, shift })
}

function seedFilterHidden(store: ReturnType<typeof createStore>, rows: readonly number[]) {
  store.setter(setViewportFilterHiddenRowsAtom, { sheetId: SHEET, rows: [...rows] })
}

function filterRows(store: ReturnType<typeof createStore>, sheetId = SHEET): number[] {
  return getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), sheetId)
}

describe('applyViewportFilterHiddenStructuralShiftAtom — displacement', () => {
  const SHIFT_TABLE = [
    // [label, seeded, shift, expected]
    ['insert entirely BEFORE the set', [4, 6], { kind: 'insert', index: 0, count: 1 }, [5, 7]],
    ['insert AT a hidden row', [4, 6], { kind: 'insert', index: 4, count: 1 }, [5, 7]],
    ['insert INSIDE the set', [4, 6], { kind: 'insert', index: 5, count: 1 }, [4, 7]],
    ['insert entirely AFTER the set', [4, 6], { kind: 'insert', index: 9, count: 3 }, [4, 6]],
    ['multi-row insert before', [4, 6], { kind: 'insert', index: 1, count: 3 }, [7, 9]],
    ['delete entirely BEFORE the set', [4, 6], { kind: 'delete', index: 0, count: 2 }, [2, 4]],
    ['delete INSIDE the set', [4, 6], { kind: 'delete', index: 5, count: 1 }, [4, 5]],
    ['delete entirely AFTER the set', [4, 6], { kind: 'delete', index: 9, count: 2 }, [4, 6]],
    ['multi-row delete before', [4, 6], { kind: 'delete', index: 0, count: 3 }, [1, 3]],
  ] as const
  test.each(SHIFT_TABLE)('%s', (...args: (typeof SHIFT_TABLE)[number]) => {
    const [_label, seeded, partial, expected] = args
    const store = createStore()
    seedFilterHidden(store, seeded)
    const shift: BackendStructuralShift = { axis: 'row', ...partial }
    const changed = applyShift(store, shift)
    expect(filterRows(store)).toEqual([...expected])
    // The command's return value is the "did the stored set move" witness the
    // callers use to decide whether a history side payload is warranted.
    expect(changed).toBe(filterRows(store).join() !== [...seeded].join())
  })

  test('a deleted row that is ITSELF filter-hidden leaves the set, it does not slide', () => {
    const store = createStore()
    seedFilterHidden(store, [2, 4, 7])
    expect(applyShift(store, { axis: 'row', kind: 'delete', index: 4, count: 1 })).toBe(true)
    // 4 died with its row; 7 moved back one; 2 was untouched. A "slide"
    // implementation would have produced [2, 4, 6] with 4 still present.
    expect(filterRows(store)).toEqual([2, 6])
  })

  test('a delete band that consumes every hidden row clears the sheet entry', () => {
    const store = createStore()
    seedFilterHidden(store, [3, 4])
    expect(applyShift(store, { axis: 'row', kind: 'delete', index: 3, count: 2 })).toBe(true)
    expect(filterRows(store)).toEqual([])
    // Empty must DROP the key, not store an empty array — `effectiveHiddenAtom`
    // returns the manual state by reference only when no sheet has filter rows.
    expect(store.getter(viewportFilterHiddenAtom).rowsBySheet).toEqual({})
  })

  test('a multi-band delete spanning the whole set drops all of it', () => {
    const store = createStore()
    seedFilterHidden(store, [2, 3, 4, 5])
    expect(applyShift(store, { axis: 'row', kind: 'delete', index: 1, count: 6 })).toBe(true)
    expect(filterRows(store)).toEqual([])
  })

  test('COLUMN shifts are inert — the filter set is a row set', () => {
    const store = createStore()
    seedFilterHidden(store, [1, 4])
    expect(applyShift(store, { axis: 'column', kind: 'insert', index: 0, count: 5 })).toBe(false)
    expect(applyShift(store, { axis: 'column', kind: 'delete', index: 0, count: 5 })).toBe(false)
    expect(filterRows(store)).toEqual([1, 4])
  })

  test('structural ops on one sheet never touch another sheet filter set', () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 5] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-2', rows: [2, 5] })
    expect(applyShift(store, { axis: 'row', kind: 'insert', index: 0, count: 2 })).toBe(true)
    expect(filterRows(store, 'sheet-1')).toEqual([4, 7])
    expect(filterRows(store, 'sheet-2')).toEqual([2, 5])
  })

  test('rejects malformed input and reports no change', () => {
    const store = createStore()
    seedFilterHidden(store, [3])
    const shift: BackendStructuralShift = { axis: 'row', kind: 'insert', index: 0, count: 1 }
    expect(store.setter(applyViewportFilterHiddenStructuralShiftAtom, { sheetId: '', shift })).toBe(
      false,
    )
    expect(
      store.setter(applyViewportFilterHiddenStructuralShiftAtom, {
        sheetId: SHEET,
        shift: {
          axis: 'row',
          kind: 'move',
          index: 0,
          count: 1,
        } as unknown as BackendStructuralShift,
      }),
    ).toBe(false)
    expect(filterRows(store)).toEqual([3])
  })

  test('an empty filter set is a no-op for any shift', () => {
    const store = createStore()
    expect(applyShift(store, { axis: 'row', kind: 'insert', index: 0, count: 1 })).toBe(false)
    expect(store.getter(viewportFilterHiddenAtom).rowsBySheet).toEqual({})
  })

  test('manual and filter sets take the SAME displacement from the same shift', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [1, 4, 8] })
    seedFilterHidden(store, [1, 4, 8])
    const shift: BackendStructuralShift = { axis: 'row', kind: 'delete', index: 3, count: 2 }
    store.setter(applyViewportHiddenStructuralShiftAtom, { sheetId: SHEET, shift })
    applyShift(store, shift)
    const manual = getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)
    expect(filterRows(store)).toEqual(manual)
    expect(manual).toEqual([1, 6])
  })
})

describe('S5a regression — the reported four-step repro', () => {
  // 1. E1='Val', E2..E5 = 10/20/30/40  → source rows 0..4
  // 2. hide row 3 (source row 2, value 20)          → manual  = {2}
  // 3. filter E1:E5, uncheck 10 (source row 1)      → filter  = {1}
  // 4. insert one row at the top (pre-mutation index 0)
  const INSERT: BackendStructuralShift = { axis: 'row', kind: 'insert', index: 0, count: 1 }

  function seedRepro() {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: SHEET, indices: [2] })
    seedFilterHidden(store, [1])
    return store
  }

  test('before the insert the grid paints rows 1, 4, 5', () => {
    const store = seedRepro()
    const hidden = getHiddenRowsForSheet(store.getter(effectiveHiddenAtom), SHEET)
    expect(visibleRowNumbers(5, hidden)).toEqual([1, 4, 5])
  })

  // COUNTER-EXAMPLE, not a tautology: this pins what the UNFIXED path really
  // produced. `remapIndexSetAfterStructuralShift` is applied to the manual set
  // only, and the filter set is left at its pre-insert value — the exact state
  // of the code before this slice. The observed symptom (header row gone, the
  // filtered-out 10 back on screen, row numbers 1/3/5/6) has to fall out of it,
  // or the fix below is being measured against nothing.
  test('leaving the filter set unshifted reproduces the reported corruption', () => {
    const manualBefore = new Set([2])
    const manualAfter = remapIndexSetAfterStructuralShift(manualBefore, INSERT)
    const staleFilter = new Set([1]) // NOT remapped — the bug
    const union = [...new Set([...manualAfter, ...staleFilter])].sort((a, b) => a - b)

    expect([...manualAfter]).toEqual([3])
    expect(visibleRowNumbers(6, union)).toEqual([1, 3, 5, 6])
    // Source row 1 is the header 'Val' after the shift — swallowed.
    expect(union).toContain(1)
    // Source row 2 is the value 10 the filter removed — back on screen.
    expect(union).not.toContain(2)
  })

  test('with the shift applied the grid paints rows 1, 2, 5, 6 and 10 stays hidden', () => {
    const store = seedRepro()
    store.setter(applyViewportHiddenStructuralShiftAtom, { sheetId: SHEET, shift: INSERT })
    applyShift(store, INSERT)

    expect(filterRows(store)).toEqual([2])
    expect(getHiddenRowsForSheet(store.getter(viewportHiddenAtom), SHEET)).toEqual([3])

    const hidden = getHiddenRowsForSheet(store.getter(effectiveHiddenAtom), SHEET)
    expect(visibleRowNumbers(6, hidden)).toEqual([1, 2, 5, 6])
    // The header survived; the filtered-out 10 did not come back.
    expect(hidden).not.toContain(1)
    expect(hidden).toContain(2)
  })
})
