import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  clearViewportFilterHiddenRowsAtom,
  DEFAULT_VIEWPORT_FILTER_HIDDEN_STATE,
  effectiveHiddenAtom,
  getFilterHiddenRowsForSheet,
  hideColumnsAtom,
  hideRowsAtom,
  isRowFilterHidden,
  setViewportFilterHiddenRowsAtom,
  unhideRowsAtom,
  unionHiddenRowsForSheet,
  viewportFilterHiddenAtom,
  viewportHiddenAtom,
} from '../src/viewport'

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
