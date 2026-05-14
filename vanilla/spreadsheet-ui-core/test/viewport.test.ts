import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  getCellViewportRect,
  getViewportColumnWidth,
  getViewportRowHeight,
  getViewportScrollForCell,
  getVisibleWindow,
  scrollToCellAtom,
  setViewportColumnWidthAtom,
  setViewportMetricsAtom,
  setViewportRowHeightAtom,
  visibleWindowAtom,
  viewportSizeOverridesAtom,
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
    rowCount: 1000,
    colCount: 100,
    overscanRows: 1,
    overscanCols: 1,
    ...overrides,
  }
}

describe('getVisibleWindow', () => {
  test('derives an overscanned visible window from scroll metrics', () => {
    expect(getVisibleWindow(metrics({ scrollTop: 40, scrollLeft: 100 }))).toEqual({
      rowStart: 1,
      rowEnd: 7,
      colStart: 1,
      colEnd: 6,
    })
  })

  test('clamps the window at sheet boundaries', () => {
    expect(
      getVisibleWindow(
        metrics({
          scrollTop: 999_999,
          scrollLeft: 999_999,
          rowCount: 10,
          colCount: 5,
        }),
      ),
    ).toEqual({
      rowStart: 4,
      rowEnd: 9,
      colStart: 0,
      colEnd: 4,
    })
  })

  test('returns an empty window when either axis is empty', () => {
    expect(getVisibleWindow(metrics({ rowCount: 0 }))).toEqual({
      rowStart: 0,
      rowEnd: -1,
      colStart: 0,
      colEnd: -1,
    })
  })

  test('derives visible window from viewport atoms', () => {
    const store = createStore()

    store.setter(
      setViewportMetricsAtom,
      metrics({
        scrollTop: 80,
        scrollLeft: 150,
        viewportHeight: 40,
        viewportWidth: 100,
        overscanRows: 0,
        overscanCols: 0,
      }),
    )

    expect(store.getter(visibleWindowAtom)).toEqual({
      rowStart: 4,
      rowEnd: 5,
      colStart: 3,
      colEnd: 4,
    })
  })

  test('computes cell rect relative to current scroll offset', () => {
    expect(
      getCellViewportRect(
        { row: 6, col: 4 },
        metrics({
          scrollTop: 80,
          scrollLeft: 150,
        }),
      ),
    ).toEqual({
      row: 6,
      col: 4,
      top: 40,
      left: 50,
      height: 20,
      width: 50,
    })
  })

  test('scrolls to a cell only when it falls outside the viewport', () => {
    expect(
      getViewportScrollForCell(
        metrics({
          scrollTop: 80,
          scrollLeft: 150,
          viewportHeight: 100,
          viewportWidth: 100,
        }),
        { coord: { row: 5, col: 3 } },
      ),
    ).toEqual({
      scrollTop: 80,
      scrollLeft: 150,
    })

    expect(
      getViewportScrollForCell(
        metrics({
          scrollTop: 0,
          scrollLeft: 0,
          viewportHeight: 100,
          viewportWidth: 100,
        }),
        { coord: { row: 10, col: 5 } },
      ),
    ).toEqual({
      scrollTop: 120,
      scrollLeft: 200,
    })
  })

  test('scroll-to-cell atom updates metrics and clamps to sheet bounds', () => {
    const store = createStore()

    store.setter(
      setViewportMetricsAtom,
      metrics({
        rowCount: 20,
        colCount: 10,
        viewportHeight: 100,
        viewportWidth: 100,
      }),
    )

    expect(
      store.setter(scrollToCellAtom, {
        coord: { row: 99, col: 99 },
        rowAlign: 'end',
        colAlign: 'end',
      }),
    ).toEqual({
      scrollTop: 300,
      scrollLeft: 400,
    })
    expect(store.getter(visibleWindowAtom)).toEqual({
      rowStart: 14,
      rowEnd: 19,
      colStart: 7,
      colEnd: 9,
    })
  })

  test('stores row and column size overrides sparsely by sheet', () => {
    const store = createStore()

    store.setter(setViewportRowHeightAtom, {
      sheetId: 'sheet-1',
      rowIndex: 2,
      heightPx: 36.4,
    })
    store.setter(setViewportColumnWidthAtom, {
      sheetId: 'sheet-1',
      colIndex: 1,
      widthPx: 128.6,
    })
    store.setter(setViewportColumnWidthAtom, {
      sheetId: 'sheet-2',
      colIndex: 1,
      widthPx: 72,
    })

    const state = store.getter(viewportSizeOverridesAtom)
    expect(state).toEqual({
      rowHeightsBySheet: {
        'sheet-1': {
          '2': 36,
        },
      },
      colWidthsBySheet: {
        'sheet-1': {
          '1': 129,
        },
        'sheet-2': {
          '1': 72,
        },
      },
    })
    expect(getViewportRowHeight(state, 'sheet-1', 2, 24)).toBe(36)
    expect(getViewportRowHeight(state, 'sheet-2', 2, 24)).toBe(24)
    expect(getViewportRowHeight(state, 'sheet-2', 2, 1)).toBe(1)
    expect(getViewportColumnWidth(state, 'sheet-1', 1, 96)).toBe(129)
    expect(getViewportColumnWidth(state, 'sheet-2', 1, 96)).toBe(72)
    expect(getViewportColumnWidth(state, 'sheet-2', 2, 1)).toBe(1)
  })
})
