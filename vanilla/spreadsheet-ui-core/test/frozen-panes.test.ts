import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  DEFAULT_VIEWPORT_FREEZE_STATE,
  getFrozenWindows,
  getVisibleWindow,
  setViewportFreezeAtom,
  viewportFreezeAtom,
  type ViewportMetrics,
} from '../src'

function metrics(overrides: Partial<ViewportMetrics> = {}): ViewportMetrics {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 100,
    viewportWidth: 200,
    rowHeight: 20,
    colWidth: 50,
    rowCount: 100,
    colCount: 50,
    overscanRows: 0,
    overscanCols: 0,
    ...overrides,
  }
}

const EMPTY = { rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 }

describe('viewportFreezeAtom', () => {
  test('initial state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('stores rows and cols per sheet', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 2, cols: 1 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 1 },
    })
  })

  test('updating rows only leaves cols unchanged', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 2, cols: 1 })
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 0 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 0 },
      colsBySheet: { A: 1 },
    })
  })

  test('updating cols only leaves rows unchanged', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 3, cols: 4 })
    store.setter(setViewportFreezeAtom, { sheetId: 'A', cols: 7 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 3 },
      colsBySheet: { A: 7 },
    })
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 2, cols: 1 })
    store.setter(setViewportFreezeAtom, { sheetId: 'B', rows: 5, cols: 3 })
    const state = store.getter(viewportFreezeAtom)
    expect(state.rowsBySheet['A']).toBe(2)
    expect(state.colsBySheet['A']).toBe(1)
    expect(state.rowsBySheet['B']).toBe(5)
    expect(state.colsBySheet['B']).toBe(3)
  })

  test('negative values clamp to 0', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: -5, cols: -3 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 0 },
      colsBySheet: { A: 0 },
    })
  })

  test('NaN values clamp to 0', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: NaN, cols: NaN })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 0 },
      colsBySheet: { A: 0 },
    })
  })

  test('fractional values are truncated', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, { sheetId: 'A', rows: 2.9, cols: 1.1 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 1 },
    })
  })
})

describe('getFrozenWindows', () => {
  test('freeze {rows:0, cols:0} — topLeft/topRight/bottomLeft empty, bottomRight equals getVisibleWindow', () => {
    const m = metrics({ scrollTop: 40, scrollLeft: 100 })
    const full = getVisibleWindow(m)
    const result = getFrozenWindows(m, { rows: 0, cols: 0 })
    expect(result.topLeft).toEqual(EMPTY)
    expect(result.topRight).toEqual(EMPTY)
    expect(result.bottomLeft).toEqual(EMPTY)
    expect(result.bottomRight).toEqual(full)
  })

  test('freeze rows only — topLeft/bottomLeft empty, topRight has frozen rows', () => {
    const m = metrics()
    const result = getFrozenWindows(m, { rows: 2, cols: 0 })
    expect(result.topLeft).toEqual(EMPTY)
    expect(result.bottomLeft).toEqual(EMPTY)
    expect(result.topRight.rowStart).toBe(0)
    expect(result.topRight.rowEnd).toBe(1)
  })

  test('freeze cols only — topLeft/topRight empty, bottomLeft has frozen cols', () => {
    const m = metrics()
    const result = getFrozenWindows(m, { rows: 0, cols: 3 })
    expect(result.topLeft).toEqual(EMPTY)
    expect(result.topRight).toEqual(EMPTY)
    expect(result.bottomLeft.colStart).toBe(0)
    expect(result.bottomLeft.colEnd).toBe(2)
  })

  test('freeze rows=2, cols=3 — all four quadrants non-empty with correct boundaries', () => {
    const m = metrics({ scrollTop: 100, scrollLeft: 200 })
    const result = getFrozenWindows(m, { rows: 2, cols: 3 })

    expect(result.topLeft).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 })

    expect(result.topRight.rowStart).toBe(0)
    expect(result.topRight.rowEnd).toBe(1)
    expect(result.topRight.colStart).toBeGreaterThanOrEqual(3)

    expect(result.bottomLeft.rowStart).toBeGreaterThanOrEqual(2)
    expect(result.bottomLeft.colStart).toBe(0)
    expect(result.bottomLeft.colEnd).toBe(2)

    expect(result.bottomRight.rowStart).toBeGreaterThanOrEqual(2)
    expect(result.bottomRight.colStart).toBeGreaterThanOrEqual(3)
  })

  test('freeze covers entire visible area — bottomRight is empty', () => {
    const m = metrics({ rowCount: 5, colCount: 5 })
    const result = getFrozenWindows(m, { rows: 5, cols: 0 })
    expect(result.bottomRight).toEqual(EMPTY)
    expect(result.bottomLeft).toEqual(EMPTY)
  })

  test('freeze covers entire col range — bottomRight is empty', () => {
    const m = metrics({ rowCount: 5, colCount: 5 })
    const result = getFrozenWindows(m, { rows: 0, cols: 5 })
    expect(result.bottomRight).toEqual(EMPTY)
    expect(result.topRight).toEqual(EMPTY)
  })

  test('scroll offsets: frozen quadrants start at 0, scrolling quadrants start at scroll position', () => {
    const m = metrics({ scrollTop: 60, scrollLeft: 150, overscanRows: 0, overscanCols: 0 })
    const result = getFrozenWindows(m, { rows: 2, cols: 3 })

    expect(result.topLeft.rowStart).toBe(0)
    expect(result.topLeft.colStart).toBe(0)

    const full = getVisibleWindow(m)
    expect(result.bottomRight.rowStart).toBe(Math.max(2, full.rowStart))
    expect(result.bottomRight.colStart).toBe(Math.max(3, full.colStart))
    expect(result.bottomRight.rowEnd).toBe(full.rowEnd)
    expect(result.bottomRight.colEnd).toBe(full.colEnd)
  })

  test('freeze rows=2 with scrollTop=0 — topRight and bottomRight share same col range', () => {
    const m = metrics({ scrollTop: 0, scrollLeft: 0, overscanRows: 0, overscanCols: 0 })
    const result = getFrozenWindows(m, { rows: 2, cols: 0 })
    const full = getVisibleWindow(m)
    expect(result.topRight.colStart).toBe(full.colStart)
    expect(result.topRight.colEnd).toBe(full.colEnd)
    expect(result.bottomRight.colStart).toBe(full.colStart)
    expect(result.bottomRight.colEnd).toBe(full.colEnd)
  })
})
