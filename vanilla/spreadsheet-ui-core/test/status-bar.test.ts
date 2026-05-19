import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type { DisplayCell } from '../src/backend'
import {
  selectCellAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
  type SelectionState,
} from '../src/selection'
import {
  computeSelectionAggregates,
  DEFAULT_STATUS_BAR_AGGREGATE_CONFIG,
  resetZoomLevelAtom,
  selectionAggregatesAtom,
  setStatusBarAggregateConfigAtom,
  setViewModeAtom,
  setZoomLevelAtom,
  snapZoomToPreset,
  statusBarAggregateConfigAtom,
  statusBarAggregateTruncatedAtom,
  statusBarProjectionCellsAtom,
  toggleStatusBarAggregateAtom,
  viewModeAtom,
  ZOOM_LEVEL_DEFAULT,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  zoomLevelAtom,
} from '../src/status-bar'

function numericCell(row: number, col: number, value: number): DisplayCell {
  return {
    row,
    col,
    displayValue: String(value),
    valueKind: 'number',
  }
}

function stringCell(row: number, col: number, value: string): DisplayCell {
  return { row, col, displayValue: value, valueKind: 'string' }
}

function blankCell(row: number, col: number): DisplayCell {
  return { row, col, displayValue: '', valueKind: 'blank' }
}

const DEFAULT_BOUNDS = { rowCount: 100, colCount: 100 }

const SHEET_RANGE_SELECTION: SelectionState = {
  kind: 'range',
  sheetId: 'sheet-1',
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 4 },
}

describe('status-bar aggregates', () => {
  test('sum / average / count over a 5-cell numeric range', () => {
    const cells: DisplayCell[] = [
      numericCell(0, 0, 1),
      numericCell(0, 1, 2),
      numericCell(0, 2, 3),
      numericCell(0, 3, 4),
      numericCell(0, 4, 5),
    ]

    const aggregates = computeSelectionAggregates(cells, [SHEET_RANGE_SELECTION], DEFAULT_BOUNDS)

    expect(aggregates.sum).toBe(15)
    expect(aggregates.average).toBe(3)
    expect(aggregates.count).toBe(5)
    expect(aggregates.numericCount).toBe(5)
    expect(aggregates.min).toBe(1)
    expect(aggregates.max).toBe(5)
    expect(aggregates.truncated).toBe(false)
  })

  test('mixed numeric and string cells track count vs numericCount separately', () => {
    const cells: DisplayCell[] = [
      numericCell(0, 0, 1),
      stringCell(0, 1, 'a'),
      numericCell(0, 2, 2),
      stringCell(0, 3, 'b'),
    ]
    const selection: SelectionState = {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 3 },
    }

    const aggregates = computeSelectionAggregates(cells, [selection], DEFAULT_BOUNDS)

    expect(aggregates.sum).toBe(3)
    expect(aggregates.average).toBe(1.5)
    expect(aggregates.count).toBe(4)
    expect(aggregates.numericCount).toBe(2)
    expect(aggregates.min).toBe(1)
    expect(aggregates.max).toBe(2)
  })

  test('blank cells are ignored from count', () => {
    const cells: DisplayCell[] = [
      numericCell(0, 0, 10),
      blankCell(0, 1),
      blankCell(0, 2),
    ]
    const selection: SelectionState = {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 2 },
    }

    const aggregates = computeSelectionAggregates(cells, [selection], DEFAULT_BOUNDS)

    expect(aggregates.count).toBe(1)
    expect(aggregates.numericCount).toBe(1)
    expect(aggregates.sum).toBe(10)
    expect(aggregates.min).toBe(10)
    expect(aggregates.max).toBe(10)
  })

  test('empty selection returns zeroed aggregates', () => {
    const aggregates = computeSelectionAggregates([], [], DEFAULT_BOUNDS)

    expect(aggregates).toEqual({
      sum: 0,
      average: 0,
      count: 0,
      numericCount: 0,
      min: 0,
      max: 0,
      truncated: false,
    })
  })

  test('selection covering no cells stays at zero', () => {
    const cells: DisplayCell[] = [numericCell(0, 0, 10), numericCell(0, 1, 20)]
    const selection: SelectionState = {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 5, col: 5 },
      focus: { row: 5, col: 6 },
    }

    const aggregates = computeSelectionAggregates(cells, [selection], DEFAULT_BOUNDS)

    expect(aggregates.count).toBe(0)
    expect(aggregates.sum).toBe(0)
    expect(aggregates.average).toBe(0)
  })

  test('multi-region selection aggregates across primary regions', () => {
    const cells: DisplayCell[] = [
      numericCell(0, 0, 1),
      numericCell(0, 1, 2),
      numericCell(2, 0, 10),
      numericCell(2, 1, 20),
      numericCell(5, 5, 999),
    ]
    const regions: SelectionState[] = [
      {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        focus: { row: 0, col: 1 },
      },
      {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 0 },
        focus: { row: 2, col: 1 },
      },
    ]

    const aggregates = computeSelectionAggregates(cells, regions, DEFAULT_BOUNDS)

    expect(aggregates.sum).toBe(33)
    expect(aggregates.count).toBe(4)
    expect(aggregates.numericCount).toBe(4)
    expect(aggregates.min).toBe(1)
    expect(aggregates.max).toBe(20)
  })

  test('truncated flag propagates from caller', () => {
    const aggregates = computeSelectionAggregates(
      [numericCell(0, 0, 1)],
      [
        {
          kind: 'range',
          sheetId: 'sheet-1',
          anchor: { row: 0, col: 0 },
          focus: { row: 0, col: 0 },
        },
      ],
      DEFAULT_BOUNDS,
      { truncated: true },
    )

    expect(aggregates.truncated).toBe(true)
    expect(aggregates.sum).toBe(1)
  })
})

describe('selectionAggregatesAtom', () => {
  test('derives aggregates from projection cells + active selection', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 100, colCount: 100 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 4 },
    })
    store.setter(statusBarProjectionCellsAtom, [
      numericCell(0, 0, 2),
      numericCell(0, 1, 4),
      numericCell(0, 2, 6),
      numericCell(0, 3, 8),
      numericCell(0, 4, 10),
    ])

    const aggregates = store.getter(selectionAggregatesAtom)

    expect(aggregates.sum).toBe(30)
    expect(aggregates.average).toBe(6)
    expect(aggregates.count).toBe(5)
    expect(aggregates.min).toBe(2)
    expect(aggregates.max).toBe(10)
  })

  test('surfaces truncated flag from atom', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(statusBarAggregateTruncatedAtom, true)

    const aggregates = store.getter(selectionAggregatesAtom)

    expect(aggregates.truncated).toBe(true)
  })
})

describe('statusBarAggregateConfigAtom', () => {
  test('defaults enable sum / average / count', () => {
    const store = createStore()
    expect(store.getter(statusBarAggregateConfigAtom)).toEqual(DEFAULT_STATUS_BAR_AGGREGATE_CONFIG)
  })

  test('toggling one key leaves the others untouched', () => {
    const store = createStore()
    store.setter(toggleStatusBarAggregateAtom, 'sum')
    const next = store.getter(statusBarAggregateConfigAtom)

    expect(next.sum).toBe(false)
    expect(next.average).toBe(true)
    expect(next.count).toBe(true)
    expect(next.numericCount).toBe(false)
    expect(next.min).toBe(false)
    expect(next.max).toBe(false)

    store.setter(toggleStatusBarAggregateAtom, 'numericCount')
    const after = store.getter(statusBarAggregateConfigAtom)
    expect(after.numericCount).toBe(true)
    expect(after.sum).toBe(false)
  })

  test('setStatusBarAggregateConfigAtom replaces the whole config', () => {
    const store = createStore()
    store.setter(setStatusBarAggregateConfigAtom, {
      sum: false,
      average: false,
      count: false,
      numericCount: true,
      min: true,
      max: true,
    })

    const config = store.getter(statusBarAggregateConfigAtom)
    expect(config.sum).toBe(false)
    expect(config.numericCount).toBe(true)
    expect(config.min).toBe(true)
    expect(config.max).toBe(true)
  })
})

describe('zoomLevelAtom', () => {
  test('defaults to 1.0', () => {
    const store = createStore()
    expect(store.getter(zoomLevelAtom)).toBe(ZOOM_LEVEL_DEFAULT)
  })

  test('setZoomLevelAtom clamps to [min, max]', () => {
    const store = createStore()
    store.setter(setZoomLevelAtom, 1.5)
    expect(store.getter(zoomLevelAtom)).toBe(1.5)

    store.setter(setZoomLevelAtom, 10)
    expect(store.getter(zoomLevelAtom)).toBe(ZOOM_LEVEL_MAX)

    store.setter(setZoomLevelAtom, -1)
    expect(store.getter(zoomLevelAtom)).toBe(ZOOM_LEVEL_MIN)
  })

  test('resetZoomLevelAtom restores 1.0', () => {
    const store = createStore()
    store.setter(setZoomLevelAtom, 2)
    store.setter(resetZoomLevelAtom)
    expect(store.getter(zoomLevelAtom)).toBe(1)
  })

  test('snapZoomToPreset rounds to the nearest preset', () => {
    expect(snapZoomToPreset(0.6)).toBe(0.5)
    expect(snapZoomToPreset(0.85)).toBe(0.75)
    expect(snapZoomToPreset(1.1)).toBe(1)
    expect(snapZoomToPreset(1.4)).toBe(1.5)
    expect(snapZoomToPreset(1.8)).toBe(2)
  })
})

describe('viewModeAtom', () => {
  test('defaults to normal', () => {
    const store = createStore()
    expect(store.getter(viewModeAtom)).toBe('normal')
  })

  test('setViewModeAtom updates the mode', () => {
    const store = createStore()
    store.setter(setViewModeAtom, 'page-break-preview')
    expect(store.getter(viewModeAtom)).toBe('page-break-preview')

    store.setter(setViewModeAtom, 'page-layout')
    expect(store.getter(viewModeAtom)).toBe('page-layout')

    store.setter(setViewModeAtom, 'normal')
    expect(store.getter(viewModeAtom)).toBe('normal')
  })
})

describe('selectionAggregatesAtom reacts to selection changes', () => {
  test('aggregates change when active cell moves', () => {
    const store = createStore()
    store.setter(statusBarProjectionCellsAtom, [
      numericCell(0, 0, 100),
      numericCell(1, 0, 200),
    ])

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    expect(store.getter(selectionAggregatesAtom).sum).toBe(100)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })
    expect(store.getter(selectionAggregatesAtom).sum).toBe(200)
  })
})
