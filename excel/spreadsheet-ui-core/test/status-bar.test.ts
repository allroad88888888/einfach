import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type { DisplayCell } from '../src/backend'
import {
  addSelectionRegionAtom,
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
  STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX,
  STATUS_BAR_PROJECTION_CELLS_MAX,
  statusBarAggregateConfigAtom,
  statusBarAggregateTruncatedAtom,
  statusBarProjectionCellsAtom,
  syncStatusBarProjectionAtom,
  toggleStatusBarAggregateAtom,
  viewModeAtom,
  ZOOM_LEVEL_DEFAULT,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  zoomLevelAtom,
  type StatusBarProjectionSyncInput,
} from '../src/status-bar'

function numericCell(row: number, col: number, value: number): DisplayCell {
  return {
    row,
    col,
    displayValue: String(value),
    valueKind: 'number',
    numericValue: value,
  }
}

function stringCell(row: number, col: number, value: string): DisplayCell {
  return { row, col, displayValue: value, valueKind: 'string' }
}

function blankCell(row: number, col: number): DisplayCell {
  return { row, col, displayValue: '', valueKind: 'blank' }
}

const DEFAULT_BOUNDS = { rowCount: 100, colCount: 100 }
const DEFAULT_PROJECTION_WINDOW = { rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 99 }

function projectionInput(
  cells: readonly DisplayCell[],
  overrides: Partial<StatusBarProjectionSyncInput> = {},
): StatusBarProjectionSyncInput {
  return {
    sheetId: 'sheet-1',
    window: DEFAULT_PROJECTION_WINDOW,
    cells,
    truncated: false,
    ...overrides,
  }
}

const SHEET_RANGE_SELECTION: SelectionState = {
  kind: 'range',
  sheetId: 'sheet-1',
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 4 },
}

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

type ProjectionWindowTruncationCase = [
  label: 'fully outside' | 'partially covered',
  window: NonNullable<StatusBarProjectionSyncInput['window']>,
]

const PROJECTION_WINDOW_TRUNCATION_CASES: ProjectionWindowTruncationCase[] = [
  ['fully outside', { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }],
  ['partially covered', { rowStart: 5, rowEnd: 6, colStart: 5, colEnd: 5 }],
]

const PROJECTION_CELLS_IS_READ_ONLY: AtomHasPublicWrite<typeof statusBarProjectionCellsAtom> = false
const PROJECTION_TRUNCATED_IS_READ_ONLY: AtomHasPublicWrite<
  typeof statusBarAggregateTruncatedAtom
> = false
const AGGREGATES_IS_READ_ONLY: AtomHasPublicWrite<typeof selectionAggregatesAtom> = false
const AGGREGATE_CONFIG_IS_READ_ONLY: AtomHasPublicWrite<typeof statusBarAggregateConfigAtom> = false
const ZOOM_LEVEL_IS_READ_ONLY: AtomHasPublicWrite<typeof zoomLevelAtom> = false
const VIEW_MODE_IS_READ_ONLY: AtomHasPublicWrite<typeof viewModeAtom> = false

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

  test('formatted displays aggregate canonical raw values and raw wins on conflicts', () => {
    const cells: DisplayCell[] = [
      {
        row: 0,
        col: 0,
        displayValue: '$1,234.50',
        valueKind: 'number',
        numericValue: 1_234.5,
      },
      { row: 0, col: 1, displayValue: '999', valueKind: 'number', numericValue: 2 },
    ]
    const selection: SelectionState = {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 1 },
    }

    expect(computeSelectionAggregates(cells, [selection], DEFAULT_BOUNDS)).toEqual({
      sum: 1_236.5,
      average: 618.25,
      count: 2,
      numericCount: 2,
      min: 2,
      max: 1_234.5,
      truncated: false,
    })
  })

  test('missing or invalid numeric facts never fall back to display text and mark truncation', () => {
    const cells: DisplayCell[] = [
      blankCell(0, 0),
      stringCell(0, 1, 'text'),
      { row: 0, col: 2, displayValue: 'TRUE', valueKind: 'boolean' },
      { row: 0, col: 3, displayValue: '#DIV/0!', valueKind: 'error' },
      { row: 0, col: 4, displayValue: '99', valueKind: 'number' },
      { row: 0, col: 5, displayValue: '100', valueKind: 'number', numericValue: Number.NaN },
      numericCell(0, 6, 3),
    ]
    const selection: SelectionState = {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 6 },
    }

    const aggregates = computeSelectionAggregates(cells, [selection], DEFAULT_BOUNDS)

    expect(aggregates).toMatchObject({
      sum: 3,
      average: 3,
      count: 6,
      numericCount: 1,
      min: 3,
      max: 3,
      truncated: true,
    })
  })

  test('blank cells are ignored from count', () => {
    const cells: DisplayCell[] = [numericCell(0, 0, 10), blankCell(0, 1), blankCell(0, 2)]
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

  test('overlapping regions count each projected cell only once', () => {
    const cells: DisplayCell[] = [numericCell(0, 0, 1), numericCell(0, 1, 2), numericCell(0, 2, 3)]
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
        anchor: { row: 0, col: 1 },
        focus: { row: 0, col: 2 },
      },
    ]

    expect(computeSelectionAggregates(cells, regions, DEFAULT_BOUNDS)).toMatchObject({
      sum: 6,
      average: 2,
      count: 3,
      numericCount: 3,
      min: 1,
      max: 3,
      truncated: false,
    })
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

  test('fixed membership budget stops before an unbounded multi-region scan', () => {
    const completeCells = STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX / 2
    const cells = Array.from({ length: completeCells + 1 }, (_unused, index) =>
      numericCell(index + 1, 0, 1),
    )
    const regions: SelectionState[] = [
      {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        focus: { row: 0, col: 0 },
      },
      {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 1, col: 0 },
        focus: { row: completeCells + 1, col: 0 },
      },
    ]

    const aggregates = computeSelectionAggregates(cells, regions, {
      rowCount: completeCells + 2,
      colCount: 1,
    })

    expect(aggregates.count).toBe(completeCells)
    expect(aggregates.sum).toBe(completeCells)
    expect(aggregates.truncated).toBe(true)
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
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([
        numericCell(0, 0, 2),
        numericCell(0, 1, 4),
        numericCell(0, 2, 6),
        numericCell(0, 3, 8),
        numericCell(0, 4, 10),
      ]),
    )

    const aggregates = store.getter(selectionAggregatesAtom)

    expect(aggregates.sum).toBe(30)
    expect(aggregates.average).toBe(6)
    expect(aggregates.count).toBe(5)
    expect(aggregates.min).toBe(2)
    expect(aggregates.max).toBe(10)
  })

  test('refreshes projection values without requiring a selection change', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 100, colCount: 100 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 1 },
    })
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 10), numericCell(0, 1, 20)]),
    )
    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: 30,
      average: 15,
      count: 2,
    })

    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 40), numericCell(0, 1, 60)]),
    )
    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: 100,
      average: 50,
      count: 2,
    })
  })

  test('surfaces truncated flag from atom', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(syncStatusBarProjectionAtom, projectionInput([], { truncated: true }))

    const aggregates = store.getter(selectionAggregatesAtom)

    expect(aggregates.truncated).toBe(true)
  })

  test('exactly 50k cells with one region aggregate completely without truncation', () => {
    const store = createStore()
    const cells = Array.from({ length: STATUS_BAR_PROJECTION_CELLS_MAX }, (_unused, row) =>
      numericCell(row, 0, 1),
    )
    store.setter(setSelectionBoundsAtom, {
      rowCount: STATUS_BAR_PROJECTION_CELLS_MAX,
      colCount: 1,
    })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: STATUS_BAR_PROJECTION_CELLS_MAX - 1, col: 0 },
    })

    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput(cells, {
        window: {
          rowStart: 0,
          rowEnd: STATUS_BAR_PROJECTION_CELLS_MAX - 1,
          colStart: 0,
          colEnd: 0,
        },
      }),
    )

    const aggregates = store.getter(selectionAggregatesAtom)
    expect(aggregates).toMatchObject({
      sum: STATUS_BAR_PROJECTION_CELLS_MAX,
      average: 1,
      count: STATUS_BAR_PROJECTION_CELLS_MAX,
      numericCount: STATUS_BAR_PROJECTION_CELLS_MAX,
      truncated: false,
    })
  })

  test('50k + 1 cells aggregate the deterministic prefix and mark it truncated', () => {
    const store = createStore()
    const inputCellCount = STATUS_BAR_PROJECTION_CELLS_MAX + 1
    const cells = Array.from({ length: inputCellCount }, (_unused, row) => numericCell(row, 0, 1))
    store.setter(setSelectionBoundsAtom, { rowCount: inputCellCount, colCount: 1 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: inputCellCount - 1, col: 0 },
    })
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput(cells, {
        window: { rowStart: 0, rowEnd: inputCellCount - 1, colStart: 0, colEnd: 0 },
      }),
    )

    const projected = store.getter(statusBarProjectionCellsAtom)
    expect(projected).toHaveLength(STATUS_BAR_PROJECTION_CELLS_MAX)
    expect(projected.at(-1)).toMatchObject({ row: STATUS_BAR_PROJECTION_CELLS_MAX - 1 })
    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: STATUS_BAR_PROJECTION_CELLS_MAX,
      count: STATUS_BAR_PROJECTION_CELLS_MAX,
      truncated: true,
    })
  })

  test('full projection coverage stays exact for sparse results', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 4, col: 4 },
    })
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(2, 2, 7)], {
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      }),
    )

    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: 7,
      count: 1,
      truncated: false,
    })
  })

  test.each(PROJECTION_WINDOW_TRUNCATION_CASES)(
    'marks a selection %s the projection window as truncated',
    (_label, window) => {
      const store = createStore()
      store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
      store.setter(setSelectionAtom, {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 5, col: 5 },
        focus: { row: 7, col: 5 },
      })
      store.setter(
        syncStatusBarProjectionAtom,
        projectionInput([numericCell(5, 5, 2), numericCell(6, 5, 3)], { window }),
      )

      expect(store.getter(statusBarAggregateTruncatedAtom)).toBe(true)
    },
  )

  test('any uncovered secondary region marks the complete aggregate as truncated', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 1 },
    })
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 10, col: 0 },
        focus: { row: 10, col: 1 },
      },
    })
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 1), numericCell(0, 1, 2)], {
        window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      }),
    )

    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: 3,
      count: 2,
      truncated: true,
    })
  })

  test('sheet mismatch suppresses stale coordinate aggregates and marks truncation', () => {
    const store = createStore()
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 99)], { sheetId: 'sheet-2' }),
    )

    expect(store.getter(selectionAggregatesAtom)).toEqual({
      sum: 0,
      average: 0,
      count: 0,
      numericCount: 0,
      min: 0,
      max: 0,
      truncated: true,
    })
  })

  test('independent stores keep projection coverage and aggregates isolated', () => {
    const first = createStore()
    const second = createStore()
    first.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    second.setter(selectCellAtom, { sheetId: 'sheet-2', coord: { row: 0, col: 0 } })
    first.setter(syncStatusBarProjectionAtom, projectionInput([numericCell(0, 0, 1)]))
    second.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 2)], { sheetId: 'sheet-2' }),
    )

    expect(first.getter(selectionAggregatesAtom)).toMatchObject({ sum: 1, truncated: false })
    expect(second.getter(selectionAggregatesAtom)).toMatchObject({ sum: 2, truncated: false })

    first.setter(
      syncStatusBarProjectionAtom,
      projectionInput([], { sheetId: 'sheet-other', window: null }),
    )
    expect(first.getter(selectionAggregatesAtom)).toMatchObject({ sum: 0, truncated: true })
    expect(second.getter(selectionAggregatesAtom)).toMatchObject({ sum: 2, truncated: false })
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
    store.setter(
      syncStatusBarProjectionAtom,
      projectionInput([numericCell(0, 0, 100), numericCell(1, 0, 200)]),
    )

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    expect(store.getter(selectionAggregatesAtom).sum).toBe(100)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })
    expect(store.getter(selectionAggregatesAtom).sum).toBe(200)
  })
})

describe('status bar public state boundary', () => {
  test('public state atoms expose neither typed nor runtime write authority', () => {
    expect([
      PROJECTION_CELLS_IS_READ_ONLY,
      PROJECTION_TRUNCATED_IS_READ_ONLY,
      AGGREGATES_IS_READ_ONLY,
      AGGREGATE_CONFIG_IS_READ_ONLY,
      ZOOM_LEVEL_IS_READ_ONLY,
      VIEW_MODE_IS_READ_ONLY,
    ]).toEqual([false, false, false, false, false, false])

    const publicStateAtoms = [
      statusBarProjectionCellsAtom,
      statusBarAggregateTruncatedAtom,
      selectionAggregatesAtom,
      statusBarAggregateConfigAtom,
      zoomLevelAtom,
      viewModeAtom,
    ]
    expect(publicStateAtoms.map((stateAtom) => 'write' in stateAtom)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])

    const store = createStore()
    const unsafeSet = store.setter as unknown as (target: unknown, value: unknown) => unknown
    const readPublicState = () =>
      [
        store.getter(statusBarProjectionCellsAtom),
        store.getter(statusBarAggregateTruncatedAtom),
        store.getter(selectionAggregatesAtom),
        store.getter(statusBarAggregateConfigAtom),
        store.getter(zoomLevelAtom),
        store.getter(viewModeAtom),
      ] as const
    const before = readPublicState()
    const forbiddenValues: readonly unknown[] = [
      [numericCell(0, 0, 99)],
      true,
      {
        sum: 99,
        average: 0,
        count: 0,
        numericCount: 0,
        min: 0,
        max: 0,
        truncated: false,
      },
      { ...DEFAULT_STATUS_BAR_AGGREGATE_CONFIG, sum: false },
      2,
      'page-layout',
    ]

    publicStateAtoms.forEach((stateAtom, index) => {
      expect(() => unsafeSet(stateAtom, forbiddenValues[index])).toThrow()
    })
    expect(readPublicState()).toEqual(before)
  })

  test('projection command snapshots sheet and window metadata before caller mutation', () => {
    const store = createStore()
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const input = {
      sheetId: 'sheet-1',
      window,
      cells: [numericCell(0, 0, 7)],
      truncated: false,
    }
    store.setter(syncStatusBarProjectionAtom, input)

    input.sheetId = 'sheet-2'
    window.rowStart = 10
    window.rowEnd = 10

    expect(store.getter(selectionAggregatesAtom)).toMatchObject({
      sum: 7,
      count: 1,
      truncated: false,
    })
  })

  test('commands copy and deeply freeze projection/config inputs before updating state', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      {
        row: 0,
        col: 0,
        displayValue: '7',
        valueKind: 'number',
        numericValue: 7,
        format: { bold: true },
      },
    ]
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const input = { sheetId: 'sheet-1', window, cells, truncated: true }
    store.setter(syncStatusBarProjectionAtom, input)

    input.sheetId = 'caller-mutated-sheet'
    input.truncated = false
    window.rowStart = 10
    window.rowEnd = 10
    cells[0]!.displayValue = 'caller-mutated'
    cells[0]!.format!.bold = false
    cells.push(numericCell(0, 1, 9))

    const projected = store.getter(statusBarProjectionCellsAtom)
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ displayValue: '7', format: { bold: true } })
    expect(store.getter(statusBarAggregateTruncatedAtom)).toBe(true)
    expect(Object.isFrozen(projected)).toBe(true)
    expect(Object.isFrozen(projected[0])).toBe(true)
    expect(Object.isFrozen(projected[0]!.format)).toBe(true)
    expect(Reflect.set(projected[0]!, 'displayValue', 'forged')).toBe(false)

    const config = {
      sum: false,
      average: true,
      count: true,
      numericCount: true,
      min: false,
      max: false,
    }
    store.setter(setStatusBarAggregateConfigAtom, config)
    config.sum = true
    config.numericCount = false

    const publishedConfig = store.getter(statusBarAggregateConfigAtom)
    expect(publishedConfig.sum).toBe(false)
    expect(publishedConfig.numericCount).toBe(true)
    expect(Object.isFrozen(publishedConfig)).toBe(true)
    expect(Reflect.set(publishedConfig, 'sum', true)).toBe(false)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    const aggregates = store.getter(selectionAggregatesAtom)
    expect(aggregates).toMatchObject({ sum: 7, count: 1, truncated: true })
    expect(Object.isFrozen(aggregates)).toBe(true)

    store.setter(setZoomLevelAtom, 1.5)
    store.setter(setViewModeAtom, 'page-layout')
    expect(store.getter(zoomLevelAtom)).toBe(1.5)
    expect(store.getter(viewModeAtom)).toBe('page-layout')
  })
})
