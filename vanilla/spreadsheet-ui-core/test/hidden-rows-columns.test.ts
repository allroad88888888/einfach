import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  DEFAULT_VIEWPORT_HIDDEN_STATE,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  isColumnHidden,
  isRowHidden,
  setViewportHiddenAtom,
  viewportHiddenAtom,
  countVisibleIndices,
  getVisibleWindowWithHidden,
  getVisibleWindow,
  type ViewportMetrics,
} from '../src'

describe('viewportHiddenAtom', () => {
  test('initial hidden state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('setViewportHiddenAtom stores sorted dedup rows', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
  })

  test('negative or non-integer indices are dropped', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [-1, 0.5, 2, 3.0] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([2, 3])
  })

  test('updating cols only leaves rows untouched', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
    expect(state.colsBySheet['A']).toEqual([2])
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [0] })
    store.setter(setViewportHiddenAtom, { sheetId: 'B', rows: [4], cols: [7] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1])
    expect(state.rowsBySheet['B']).toEqual([4])
    expect(state.colsBySheet['A']).toEqual([0])
    expect(state.colsBySheet['B']).toEqual([7])
  })
})

describe('isRowHidden / isColumnHidden', () => {
  test('isRowHidden returns true for a hidden row', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(isRowHidden(state, 'A', 3)).toBe(true)
    expect(isRowHidden(state, 'A', 4)).toBe(false)
  })

  test('isRowHidden returns false for unknown sheet', () => {
    expect(isRowHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })

  test('isColumnHidden is symmetric', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2, 7] })
    const state = store.getter(viewportHiddenAtom)
    expect(isColumnHidden(state, 'A', 2)).toBe(true)
    expect(isColumnHidden(state, 'A', 3)).toBe(false)
    expect(isColumnHidden(state, 'A', 7)).toBe(true)
  })

  test('isColumnHidden returns false for unknown sheet', () => {
    expect(isColumnHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })
})

describe('getHiddenRowsForSheet / getHiddenColumnsForSheet', () => {
  test('returns empty array for unknown sheet', () => {
    expect(getHiddenRowsForSheet(DEFAULT_VIEWPORT_HIDDEN_STATE, 'unknown')).toEqual([])
    expect(getHiddenColumnsForSheet(DEFAULT_VIEWPORT_HIDDEN_STATE, 'unknown')).toEqual([])
  })

  test('returns stored sorted indices for known sheet', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'S', rows: [9, 2, 4], cols: [5, 1] })
    const state = store.getter(viewportHiddenAtom)
    expect(getHiddenRowsForSheet(state, 'S')).toEqual([2, 4, 9])
    expect(getHiddenColumnsForSheet(state, 'S')).toEqual([1, 5])
  })
})

function baseMetrics(overrides: Partial<ViewportMetrics> = {}): ViewportMetrics {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 200,
    viewportWidth: 500,
    rowHeight: 20,
    colWidth: 50,
    rowCount: 100,
    colCount: 20,
    overscanRows: 0,
    overscanCols: 0,
    ...overrides,
  }
}

describe('countVisibleIndices', () => {
  test('counts non-hidden indices in range', () => {
    expect(countVisibleIndices(0, 9, [3, 5])).toBe(8)
  })

  test('returns full count when no hidden indices', () => {
    expect(countVisibleIndices(0, 9, [])).toBe(10)
  })

  test('returns 0 for empty range', () => {
    expect(countVisibleIndices(5, 4, [3])).toBe(0)
  })

  test('ignores hidden indices outside the range', () => {
    expect(countVisibleIndices(2, 6, [0, 1, 7, 8])).toBe(5)
  })

  test('returns 0 when all indices in range are hidden', () => {
    expect(countVisibleIndices(0, 2, [0, 1, 2])).toBe(0)
  })
})

describe('getVisibleWindowWithHidden', () => {
  test('no hidden — produces the same window as getVisibleWindow', () => {
    const m = baseMetrics()
    const base = getVisibleWindow(m)
    const result = getVisibleWindowWithHidden(m, { rows: [], cols: [] })
    expect(result).toEqual(base)
  })

  test('2 hidden rows inside window inflates rowEnd by 2', () => {
    // viewportHeight=200, rowHeight=20 → 10 visible rows, rowStart=0, rowEnd=9
    const m = baseMetrics()
    const base = getVisibleWindow(m)
    expect(base.rowEnd).toBe(9)
    const result = getVisibleWindowWithHidden(m, { rows: [3, 5], cols: [] })
    // rows 3 and 5 are hidden; need 10 visible → rowEnd moves to 11
    expect(result.rowEnd).toBe(11)
    expect(result.rowStart).toBe(0)
    expect(result.colEnd).toBe(base.colEnd)
  })

  test('2 hidden cols inside window inflates colEnd by 2', () => {
    // viewportWidth=500, colWidth=50 → 10 visible cols, colStart=0, colEnd=9
    const m = baseMetrics()
    const base = getVisibleWindow(m)
    expect(base.colEnd).toBe(9)
    const result = getVisibleWindowWithHidden(m, { rows: [], cols: [2, 7] })
    expect(result.colEnd).toBe(11)
    expect(result.colStart).toBe(0)
    expect(result.rowEnd).toBe(base.rowEnd)
  })

  test('hidden indices beyond rowCount are ignored / clamped to last row', () => {
    const m = baseMetrics({ rowCount: 5 })
    // rowStart=0, rowEnd=4 (only 5 rows, viewportHeight=200 but clamped)
    const result = getVisibleWindowWithHidden(m, { rows: [999, 1000], cols: [] })
    expect(result.rowEnd).toBe(4)
  })

  test('hidden rows beyond the sheet boundary do not inflate past rowCount-1', () => {
    // 12 rows, 10 visible, hide rows 8 and 9 which are at the end of the window
    const m = baseMetrics({ rowCount: 12 })
    const base = getVisibleWindow(m)
    expect(base.rowEnd).toBe(9)
    const result = getVisibleWindowWithHidden(m, { rows: [8, 9], cols: [] })
    // Need 10 visible rows from 0..11; rows 8,9 hidden → walk to 11 to get 10 visible
    expect(result.rowEnd).toBe(11)
    expect(result.rowEnd).toBeLessThanOrEqual(11) // rowCount - 1
  })

  test('returns empty window when rowCount or colCount is 0', () => {
    const result = getVisibleWindowWithHidden(baseMetrics({ rowCount: 0 }), { rows: [0], cols: [] })
    expect(result).toEqual({ rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 })
  })

  test('hidden rows outside base window do not affect result', () => {
    const m = baseMetrics()
    const base = getVisibleWindow(m)
    // hide rows 50-60 which are far beyond the window
    const result = getVisibleWindowWithHidden(m, { rows: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60], cols: [] })
    expect(result).toEqual(base)
  })
})
