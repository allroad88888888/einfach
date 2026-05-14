import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  getCellViewportRect,
  getViewportScrollForCell,
  getVisibleWindow,
  scrollToCellAtom,
  setViewportMetricsAtom,
  visibleWindowAtom,
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
})
