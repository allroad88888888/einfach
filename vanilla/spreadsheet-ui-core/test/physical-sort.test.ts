import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  PHYSICAL_SORT_REJECTION_MESSAGES,
  beginProjectionAtom,
  captureSortRangeCapabilityAtom,
  clearPhysicalSortDiagnosticAtom,
  filterSortEntrypointStateAtom,
  filterSortStateAtom,
  hideRowsAtom,
  historyStackAtom,
  physicalSortDiagnosticAtom,
  physicalSortRejectionMessage,
  resolveProjectionAtom,
  runPhysicalSortAtom,
  selectionAtom,
  setFilterSortAtom,
  setWorkspaceActiveSheetAtom,
  sortRangeSupportedAtom,
} from '../src'
import type {
  CellRange,
  DisplayCell,
  PhysicalSortControllerPort,
  SetFilterSortRequest,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
  VisibleProjectionResult,
} from '../src'

function makeStore() {
  return createStore()
}

function setActiveCell(
  store: ReturnType<typeof makeStore>,
  sheetId: string,
  row: number,
  col: number,
) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId,
    anchor: { row, col },
    focus: { row, col },
  })
}

const RANGE: CellRange = { rowStart: 1, rowEnd: 5, colStart: 0, colEnd: 3 }

/**
 * Seed the visible projection UI core consumes so `buildSortExcludedRows` can
 * derive filter-hidden rows from `DisplayCell.originalRow` gaps. Window covers
 * display rows 0..(cells max row); source rows a filter compresses away simply
 * have no cell here.
 */
function publishProjection(
  store: ReturnType<typeof makeStore>,
  cells: DisplayCell[],
  sheetId = 'sheet-1',
  window: CellRange = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 },
) {
  const outcome = store.setter(beginProjectionAtom, { kind: 'visible-window', sheetId, window })
  if (outcome.status !== 'started') throw new Error(`projection begin: ${outcome.status}`)
  const result: VisibleProjectionResult = {
    kind: 'visible-window',
    sheetId,
    requestId: outcome.request.requestId,
    window: { ...window },
    cells,
  }
  const resolved = store.setter(resolveProjectionAtom, { request: outcome.request, result })
  if (resolved.status !== 'accepted') throw new Error(`projection resolve: ${resolved.status}`)
}

function appliedResult(request: SortRangeRequest, movedRows: number): SortRangeResult {
  return {
    kind: 'sort-range',
    sheetId: request.sheetId,
    applied: true,
    movedRows,
    movedCells: movedRows,
    affectedRange: request.range,
    requestId: request.requestId,
    revision: 42,
  }
}

interface PhysicalSourceOptions {
  result?: (request: SortRangeRequest) => SortRangeResult
  throwError?: unknown
  withoutSortRange?: boolean
}

function makePhysicalSource(options: PhysicalSourceOptions = {}) {
  const sortRequests: SortRangeRequest[] = []
  const filterRequests: SetFilterSortRequest[] = []
  const source: PhysicalSortControllerPort = {
    async setFilterSort(request) {
      filterRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }
  if (!options.withoutSortRange) {
    source.sortRange = async (request) => {
      sortRequests.push(request)
      if (options.throwError !== undefined) throw options.throwError
      return options.result ? options.result(request) : appliedResult(request, 3)
    }
  }
  return { source, sortRequests, filterRequests }
}

const noRefresh = async () => undefined

describe('runPhysicalSortAtom — capability split', () => {
  test('with a sortRange port: dispatches a sort-range keyed by the active column', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests, filterRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'desc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(1)
    expect(sortRequests[0]).toMatchObject({
      kind: 'sort-range',
      sheetId: 'sheet-1',
      range: RANGE,
      keys: [{ col: 1, direction: 'desc' }],
    })
    // Physical path writes engine data, never a display directive.
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives ?? []).toEqual([])
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(sortRangeSupportedAtom)).toBe(true)
  })

  test('without a sortRange port: falls back to display permutation (directives)', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 0, 2)
    const { source, filterRequests } = makePhysicalSource({ withoutSortRange: true })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: null,
      refreshProjection: noRefresh,
    })

    expect(filterRequests).toHaveLength(1)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 2, direction: 'asc' },
    ])
    expect(store.getter(sortRangeSupportedAtom)).toBe(false)
  })

  test('null range falls back to the display permutation even when the port exists', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: null,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 1, direction: 'asc' },
    ])
  })

  test('a key column outside the range falls back to the display permutation', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 7)
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 7, direction: 'asc' },
    ])
  })

  test('an active column filter now sorts physically with filtered-out rows excluded', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }], directives: [] },
    })
    // Filter compresses source rows 2 and 4 away: display rows carry
    // originalRow 0 (header), 1, 3, 5. The gaps inside the observed span are
    // the filtered-out rows.
    publishProjection(store, [
      { row: 0, col: 0, displayValue: 'head', originalRow: 0 },
      { row: 1, col: 0, displayValue: 'x', originalRow: 1 },
      { row: 2, col: 0, displayValue: 'x', originalRow: 3 },
      { row: 3, col: 0, displayValue: 'x', originalRow: 5 },
    ])
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    // Filter-active sheets sort physically (flip step 3): filtered-out rows ride
    // in excludedRows so the engine leaves them in place; no display directive.
    expect(sortRequests).toHaveLength(1)
    expect(sortRequests[0].excludedRows).toEqual([2, 4])
    expect(sortRequests[0].keys).toEqual([{ col: 1, direction: 'asc' }])
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives ?? []).toEqual([])
  })
})

describe('runPhysicalSortAtom — filter-hidden excluded rows', () => {
  test('unions manual hidden rows with filter-derived filtered-out rows', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }], directives: [] },
    })
    // Manually hide row 5 (inside the range); filter compresses row 3 away.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [5] })
    publishProjection(store, [
      { row: 0, col: 0, displayValue: 'head', originalRow: 0 },
      { row: 1, col: 0, displayValue: 'x', originalRow: 1 },
      { row: 2, col: 0, displayValue: 'x', originalRow: 2 },
      { row: 3, col: 0, displayValue: 'x', originalRow: 4 },
      { row: 4, col: 0, displayValue: 'x', originalRow: 5 },
    ])
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    // Observed span 1..5 (row 5 present but also manually hidden); gap 3 is
    // filtered out; union with hidden row 5, sorted ascending.
    expect(sortRequests[0].excludedRows).toEqual([3, 5])
  })

  test('reasons only inside the observed span (bounded projection window)', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }], directives: [] },
    })
    // Projection window only observes source rows 2 and 4 (scrolled). Row 3 is
    // a gap inside [2..4] → excluded; rows 1 and 5 are outside the observed
    // span → left in the reorder set (bounded-window semantics).
    publishProjection(
      store,
      [
        { row: 0, col: 0, displayValue: 'x', originalRow: 2 },
        { row: 1, col: 0, displayValue: 'x', originalRow: 4 },
      ],
      'sheet-1',
      { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 3 },
    )
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests[0].excludedRows).toEqual([3])
  })

  test('a filter with no consumed projection excludes nothing derived', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }], directives: [] },
    })
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    // Still physical (no directives), but with no projection to read the
    // filtered-out rows cannot be derived — excludedRows is empty.
    expect(sortRequests).toHaveLength(1)
    expect(sortRequests[0].excludedRows).toEqual([])
  })

  test('ignores a projection published for a different sheet', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }], directives: [] },
    })
    publishProjection(
      store,
      [
        { row: 0, col: 0, displayValue: 'x', originalRow: 1 },
        { row: 1, col: 0, displayValue: 'x', originalRow: 4 },
      ],
      'other-sheet',
    )
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests[0].excludedRows).toEqual([])
  })

  test('explicit target sorts the given column, not the selection (dropdown path)', async () => {
    const store = makeStore()
    // Selection is on column 1, but the dropdown targets column 2.
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'desc',
      range: RANGE,
      target: { sheetId: 'sheet-1', colIndex: 2 },
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(1)
    expect(sortRequests[0].keys).toEqual([{ col: 2, direction: 'desc' }])
  })
})

describe('runPhysicalSortAtom — excluded rows', () => {
  test('carries hidden rows clipped to the sort range', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 0)
    // 0 sits above the range start (1); 9 sits below the range end (5); 3 is inside.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [0, 3, 9] })
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests[0].excludedRows).toEqual([3])
  })

  test('omits hidden rows on a different sheet', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 0)
    store.setter(hideRowsAtom, { sheetId: 'other', indices: [2, 3] })
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests[0].excludedRows).toEqual([])
  })
})

describe('runPhysicalSortAtom — history & no-op', () => {
  test('an applied sort with movedRows > 0 pushes ONE range.sort history entry', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ result: (request) => appliedResult(request, 4) })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    const stack = store.getter(historyStackAtom)
    expect(stack.entries).toHaveLength(1)
    expect(stack.entries[0]).toMatchObject({
      kind: 'range.sort',
      sheetId: 'sheet-1',
      projectionRevision: 42,
    })
  })

  test('a no-op sort (movedRows === 0) resolves applied but pushes NO history entry', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ result: (request) => appliedResult(request, 0) })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
    // Lifecycle still settles to idle (the lane is free for the next sort).
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
  })
})

describe('runPhysicalSortAtom — structured rejections', () => {
  function rejected(code: SortRangeRejectionCode, extra: Record<string, unknown> = {}) {
    return (request: SortRangeRequest): SortRangeResult => ({
      kind: 'sort-range-not-applied',
      sheetId: request.sheetId,
      applied: false,
      code,
      requestId: request.requestId,
      revision: 7,
      ...extra,
    })
  }

  test('source-too-large: user-readable diagnostic, no history, no directives', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ result: rejected('source-too-large') })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(store.getter(physicalSortDiagnosticAtom)).toMatchObject({
      code: 'source-too-large',
      message: PHYSICAL_SORT_REJECTION_MESSAGES['source-too-large'],
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives ?? []).toEqual([])
  })

  test('merge-in-range: maps to the unmerge prompt', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ result: rejected('merge-in-range') })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(store.getter(physicalSortDiagnosticAtom)?.message).toBe(
      PHYSICAL_SORT_REJECTION_MESSAGES['merge-in-range'],
    )
  })

  test('spill-in-range: carries the intersecting anchor', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({
      result: rejected('spill-in-range', { anchor: 'C3' }),
    })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(store.getter(physicalSortDiagnosticAtom)).toMatchObject({
      code: 'spill-in-range',
      anchor: 'C3',
    })
  })

  test('a subsequent applied sort clears the diagnostic', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const rejectingSource = makePhysicalSource({ result: rejected('source-too-large') })
    await store.setter(runPhysicalSortAtom, {
      source: rejectingSource.source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })
    expect(store.getter(physicalSortDiagnosticAtom)).not.toBeNull()

    const applyingSource = makePhysicalSource()
    await store.setter(runPhysicalSortAtom, {
      source: applyingSource.source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
  })

  test('clearPhysicalSortDiagnosticAtom resets the diagnostic', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ result: rejected('source-too-large') })
    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })
    expect(store.getter(physicalSortDiagnosticAtom)).not.toBeNull()
    store.setter(clearPhysicalSortDiagnosticAtom)
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
  })
})

describe('runPhysicalSortAtom — transport failure', () => {
  test('a thrown sortRange rejects into outcome-unknown, records no history', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source } = makePhysicalSource({ throwError: new Error('worker crashed') })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })
})

describe('sortRange capability witness', () => {
  test('captureSortRangeCapabilityAtom reflects the port presence', () => {
    const store = makeStore()
    expect(store.getter(sortRangeSupportedAtom)).toBe(false)
    store.setter(captureSortRangeCapabilityAtom, {
      sortRange: async () => appliedResult({ kind: 'sort-range' } as SortRangeRequest, 0),
    })
    expect(store.getter(sortRangeSupportedAtom)).toBe(true)
    store.setter(captureSortRangeCapabilityAtom, {})
    expect(store.getter(sortRangeSupportedAtom)).toBe(false)
  })

  test('physicalSortRejectionMessage returns the mapped prompt', () => {
    expect(physicalSortRejectionMessage('spill-in-range')).toBe(
      PHYSICAL_SORT_REJECTION_MESSAGES['spill-in-range'],
    )
    expect(physicalSortRejectionMessage('invalid-payload', 'raw detail')).toBe(
      PHYSICAL_SORT_REJECTION_MESSAGES['invalid-payload'],
    )
  })
})
