import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  PHYSICAL_SORT_REJECTION_MESSAGES,
  captureSortRangeCapabilityAtom,
  clearPhysicalSortDiagnosticAtom,
  filterSortEntrypointStateAtom,
  filterSortStateAtom,
  hideRowsAtom,
  historyStackAtom,
  physicalSortDiagnosticAtom,
  physicalSortRejectionMessage,
  runPhysicalSortAtom,
  selectionAtom,
  setFilterSortAtom,
  setWorkspaceActiveSheetAtom,
  sortRangeSupportedAtom,
} from '../src'
import type {
  CellRange,
  PhysicalSortControllerPort,
  SetFilterSortRequest,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
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

  test('an active column filter routes to display permutation, not sortRange', async () => {
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

    // Physical sort cannot yet exclude filtered-out rows (flip step 3), so the
    // combined filter+sort keeps flowing through the display permutation.
    expect(sortRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 1, direction: 'asc' },
    ])
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
