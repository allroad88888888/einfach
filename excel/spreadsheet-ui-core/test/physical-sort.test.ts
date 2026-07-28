import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  PHYSICAL_SORT_CAPABILITY_ERROR,
  PHYSICAL_SORT_REJECTION_MESSAGES,
  beginProjectionAtom,
  captureFilterSortCapabilityAtom,
  captureSortRangeCapabilityAtom,
  clearPhysicalSortDiagnosticAtom,
  filterSortEntrypointStateAtom,
  filterSortStateAtom,
  hideRowsAtom,
  historyStackAtom,
  openFilterDropdownAtom,
  physicalSortDiagnosticAtom,
  physicalSortRejectionMessage,
  resolveProjectionAtom,
  retryFilterSortRefreshAtom,
  runPhysicalSortAtom,
  selectionAtom,
  setFilterSortAtom,
  setViewportFilterHiddenRowsAtom,
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
 * Seed the visible projection UI core consumes. `buildSortExcludedRows` no
 * longer reads it — the excluded set comes from the two hidden-row atoms —
 * so this exists to give the sort command a realistic bounded window, and to
 * show that a window narrower than the sort range changes no answer.
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
  // `setFilterSort` is present so the tests can prove the sort path NEVER
  // touches it: the display-permutation fallback was retired with #24.
  const source: PhysicalSortControllerPort & {
    setFilterSort: (request: SetFilterSortRequest) => Promise<unknown>
  } = {
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

describe('runPhysicalSortAtom — fail-closed capability gate', () => {
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
    // Physical path writes engine data; the retired display permutation is
    // never reached, so `setFilterSort` stays untouched.
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    expect(store.getter(sortRangeSupportedAtom)).toBe(true)
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
  })

  test('without a sortRange port: sorting is unsupported — no transport, no view fallback', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 0, 2)
    const { source, filterRequests } = makePhysicalSource({ withoutSortRange: true })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    // Fail-closed (#24): no display permutation is written and no filter
    // transport is sent — the host simply has no sort.
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    expect(store.getter(sortRangeSupportedAtom)).toBe(false)
    expect(store.getter(physicalSortDiagnosticAtom)).toEqual({
      code: 'unsupported',
      message: PHYSICAL_SORT_CAPABILITY_ERROR,
    })
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('blocked')
    expect(store.getter(filterSortEntrypointStateAtom).error).toBe(PHYSICAL_SORT_CAPABILITY_ERROR)
  })

  test('a null range rejects with invalid-range instead of falling back', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests, filterRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: null,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(0)
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    expect(store.getter(physicalSortDiagnosticAtom)?.code).toBe('invalid-range')
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('blocked')
  })

  test('a key column outside the range rejects with key-out-of-range', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 7)
    const { source, sortRequests, filterRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(0)
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    expect(store.getter(physicalSortDiagnosticAtom)?.code).toBe('key-out-of-range')
  })

  test('an active column filter sorts physically with filtered-out rows excluded', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }] },
    })
    // The host's whole-column scan reported source rows 2 and 4 as filtered
    // out; UI core stores that verbatim. Nothing is inferred from the
    // projection any more, so no projection needs publishing here.
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 4] })
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
    // The filter rule is untouched — sorting never rewrites filter state.
    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
      { kind: 'equals', colIndex: 0, value: 'x' },
    ])
  })
})

describe('runPhysicalSortAtom — filter-hidden excluded rows', () => {
  test('unions manual hidden rows with filter-derived filtered-out rows', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }] },
    })
    // Manually hide row 5 (inside the range); the filter hid row 3. Two
    // separate sets, and excludedRows is the only place they are unioned.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [5] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [3] })
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests[0].excludedRows).toEqual([3, 5])
  })

  test('excludes filtered rows the projection window never covered', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }] },
    })
    // The bounded-window gap this replaces: excluded rows used to be inferred
    // from holes in the source-row echoes the compacted projection carried, so
    // only rows the viewport happened to cover could ever be judged. Here the
    // window shows rows 0..1 only, while rows 1, 3 and 5 are filtered out —
    // the old derivation answered [] for 1 and 5 (outside the observed span)
    // and they moved under the sort. The host's whole-column answer covers the
    // whole extent.
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [1, 3, 5] })
    publishProjection(
      store,
      [
        { row: 0, col: 0, displayValue: 'x' },
        { row: 1, col: 0, displayValue: 'x' },
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

    expect(sortRequests[0].excludedRows).toEqual([1, 3, 5])
  })

  test('a filter whose host reported no hidden rows excludes nothing', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }] },
    })
    const { source, sortRequests } = makePhysicalSource()

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    // Rules recorded, visibility set never populated (a host that cannot
    // compute it degrades exactly here) — excludedRows is empty, not guessed.
    expect(sortRequests).toHaveLength(1)
    expect(sortRequests[0].excludedRows).toEqual([])
  })

  test('ignores filter-hidden rows recorded for a different sheet', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'x' }] },
    })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'other-sheet', rows: [1, 4] })
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

  test('source-too-large: user-readable diagnostic, no history, no data write', async () => {
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
    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules ?? []).toHaveLength(0)
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

/**
 * Lifecycle invariants that used to be pinned on the (retired) display
 * entrypoint. They now belong to the physical command, which owns the same
 * single backend lane and the same `filterSortEntrypointState` ticket.
 */
describe('runPhysicalSortAtom — single backend lane', () => {
  test('an open filter dropdown makes the sort command inert', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests } = makePhysicalSource()
    store.setter(captureFilterSortCapabilityAtom, {
      async setFilterSort(request: SetFilterSortRequest) {
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: noRefresh,
    })

    expect(sortRequests).toHaveLength(0)
  })

  test('a same-tick second dispatch shares one lane and sends one sort-range', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests } = makePhysicalSource()
    const input = {
      source,
      entrypoint: 'toolbar' as const,
      direction: 'asc' as const,
      range: RANGE,
      refreshProjection: noRefresh,
    }

    await Promise.all([
      store.setter(runPhysicalSortAtom, input),
      store.setter(runPhysicalSortAtom, input),
    ])

    expect(sortRequests).toHaveLength(1)
  })

  test('refresh failure keeps the applied ticket and retry never resends the sort', async () => {
    const store = makeStore()
    setActiveCell(store, 'sheet-1', 2, 1)
    const { source, sortRequests } = makePhysicalSource()
    let refreshCalls = 0

    await store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range: RANGE,
      refreshProjection: async () => {
        refreshCalls += 1
        throw new Error('projection failed')
      },
    })

    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')

    await store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: async (sheetId) => {
        refreshCalls += 1
        expect(sheetId).toBe('sheet-1')
      },
    })

    expect(sortRequests).toHaveLength(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
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
