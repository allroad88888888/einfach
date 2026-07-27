import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import * as spreadsheetUiCore from '../src'
import {
  applyViewportHiddenStructuralShiftAtom,
  countVisibleIndices,
  DEFAULT_VIEWPORT_HIDDEN_STATE,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  getVisibleWindow,
  getVisibleWindowWithHidden,
  hideColumnsAtom,
  hideRowsAtom,
  historyStackAtom,
  hydrateViewportHiddenAtom,
  isColumnHidden,
  isRowHidden,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  selectColumnsAtom,
  selectRowsAtom,
  unhideColumnsAtom,
  unhideRowsAtom,
  unhideViewportSelectionAtom,
  viewportHiddenAtom,
  viewportHiddenDiagnosticAtom,
  type HideColumnsRequest,
  type HideRowsRequest,
  type HistoryControllerPort,
  type UnhideColumnsRequest,
  type UnhideRowsRequest,
  type ViewportHiddenPersistencePort,
  type ViewportMetrics,
  type ViewportSizeProjectionRequest,
} from '../src'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function flushMicrotasks(times = 3): Promise<void> {
  let chain = Promise.resolve()
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined)
  return chain
}

/**
 * Persistence-mirror double: absolute per-sheet sets plus a log of every
 * hide/unhide delta and every seed read. Matches the shape of the
 * static-backend hidden mirror.
 */
function createPersistencePort(
  seedRows: readonly number[] = [],
  seedCols: readonly number[] = [],
) {
  let rows = [...seedRows]
  let cols = [...seedCols]
  const reads: ViewportSizeProjectionRequest[] = []
  const hideRows: HideRowsRequest[] = []
  const unhideRows: UnhideRowsRequest[] = []
  const hideColumns: HideColumnsRequest[] = []
  const unhideColumns: UnhideColumnsRequest[] = []
  // Also structurally satisfies HistoryControllerPort (both methods optional)
  // so this same mock can double as the `source` for runUndoHistoryAtom in
  // the local-replay history tests below without widening to `{}`.
  const port: ViewportHiddenPersistencePort & HistoryControllerPort = {
    async readViewportSizeProjection(request) {
      reads.push(request)
      return {
        kind: 'viewport-size',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: 1,
        rowHeights: [],
        colWidths: [],
        hiddenRowIndices: [...rows],
        hiddenColIndices: [...cols],
      }
    },
    async hideRows(request) {
      hideRows.push(request)
      rows = [...new Set([...rows, ...request.rowIndices])].sort((a, b) => a - b)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async unhideRows(request) {
      unhideRows.push(request)
      rows = rows.filter((index) => !request.rowIndices.includes(index))
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async hideColumns(request) {
      hideColumns.push(request)
      cols = [...new Set([...cols, ...request.colIndices])].sort((a, b) => a - b)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async unhideColumns(request) {
      unhideColumns.push(request)
      cols = cols.filter((index) => !request.colIndices.includes(index))
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }
  return {
    port,
    reads,
    hideRows,
    unhideRows,
    hideColumns,
    unhideColumns,
    get rows() {
      return rows
    },
    get cols() {
      return cols
    },
  }
}

describe('viewportHiddenAtom (UI-core canonical)', () => {
  test('initial hidden state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('does not export the old writable hidden setter or authority machinery', () => {
    expect('setViewportHiddenAtom' in spreadsheetUiCore).toBe(false)
    expect('runViewportHiddenMutationAtom' in spreadsheetUiCore).toBe(false)
    expect('runViewportHiddenSelectionMutationAtom' in spreadsheetUiCore).toBe(false)
    expect('viewportHiddenLifecycleAtom' in spreadsheetUiCore).toBe(false)
    expect('viewportHiddenProjectionAuthorityAtom' in spreadsheetUiCore).toBe(false)
    expect('isViewportHiddenProjectionReady' in spreadsheetUiCore).toBe(false)
  })

  test('hideRowsAtom commits synchronously without any backend port', () => {
    const store = createStore()
    const outcome = store.setter(hideRowsAtom, { sheetId: 'A', indices: [3, 1, 3] })
    expect(outcome).toBe('committed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1, 3] },
      colsBySheet: { A: [] },
    })
  })

  test('hide and unhide compose per axis and keep the other axis untouched', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2, 4] })
    store.setter(hideColumnsAtom, { sheetId: 'A', indices: [1] })
    expect(store.setter(unhideRowsAtom, { sheetId: 'A', indices: [2] })).toBe('committed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [4] },
      colsBySheet: { A: [1] },
    })
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [1] })
    store.setter(hideRowsAtom, { sheetId: 'B', indices: [7] })
    store.setter(hideColumnsAtom, { sheetId: 'B', indices: [2] })
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1], B: [7] },
      colsBySheet: { A: [], B: [2] },
    })
  })

  test.each([
    ['negative indices', [-1, 2]],
    ['fractional indices', [1.5]],
    ['non-finite indices', [NaN]],
    ['empty indices', []],
  ])('rejects %s without state or history', (_label, indices) => {
    const store = createStore()
    expect(store.setter(hideRowsAtom, { sheetId: 'A', indices })).toBe('invalid')
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('rejects an empty sheet id', () => {
    const store = createStore()
    expect(store.setter(hideRowsAtom, { sheetId: '', indices: [1] })).toBe('invalid')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('a no-op command reports unchanged and records no history', () => {
    const store = createStore()
    expect(store.setter(unhideRowsAtom, { sheetId: 'A', indices: [5] })).toBe('unchanged')
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [5] })
    expect(store.setter(hideRowsAtom, { sheetId: 'A', indices: [5] })).toBe('unchanged')
    expect(store.setter(unhideColumnsAtom, { sheetId: 'A', indices: [5] })).toBe('unchanged')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })
})

describe('hidden persistence hook', () => {
  test('mirrors a committed hide delta fire-and-forget', async () => {
    const store = createStore()
    const persistence = createPersistencePort()
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2, 3], source: persistence.port })
    // Local commit is synchronous even though the mirror is async.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['A']).toEqual([2, 3])
    await flushMicrotasks()
    expect(persistence.hideRows).toEqual([
      { kind: 'hide-rows', sheetId: 'A', rowIndices: [2, 3] },
    ])
    expect(store.getter(viewportHiddenDiagnosticAtom)).toBeNull()
  })

  test('mirrors only the actual delta on hide over an existing set', async () => {
    const store = createStore()
    const persistence = createPersistencePort()
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [2, 3], source: persistence.port })
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [3, 4], source: persistence.port })
    await flushMicrotasks()
    expect(persistence.hideRows.map((request) => request.rowIndices)).toEqual([[2, 3], [4]])
  })

  test('a persistence failure records a diagnostic and never rolls back local state', async () => {
    const store = createStore()
    const source: ViewportHiddenPersistencePort = {
      async hideColumns() {
        throw new Error('persist offline')
      },
    }
    expect(store.setter(hideColumnsAtom, { sheetId: 'A', indices: [1], source })).toBe('committed')
    await flushMicrotasks()
    expect(store.getter(viewportHiddenAtom).colsBySheet['A']).toEqual([1])
    expect(store.getter(viewportHiddenDiagnosticAtom)).toEqual({
      kind: 'persist-failed',
      sheetId: 'A',
      message: 'persist offline',
    })
  })

  test('commands work fully without any port and skip mirroring silently', () => {
    const store = createStore()
    expect(store.setter(hideRowsAtom, { sheetId: 'A', indices: [1], source: {} })).toBe(
      'committed',
    )
    expect(store.getter(viewportHiddenDiagnosticAtom)).toBeNull()
  })

  test('hydrates once per sheet from the full-sheet hidden slices', async () => {
    const store = createStore()
    const persistence = createPersistencePort([2, 5], [1])
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 100,
        colCount: 50,
        source: persistence.port,
      }),
    ).resolves.toBe('hydrated')
    expect(persistence.reads).toHaveLength(1)
    expect(persistence.reads[0]?.window).toEqual({
      rowStart: 0,
      rowEnd: 99,
      colStart: 0,
      colEnd: 49,
    })
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [2, 5] },
      colsBySheet: { A: [1] },
    })
    // Second hydrate is a no-op seed, even if the persisted value changed.
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 100,
        colCount: 50,
        source: persistence.port,
      }),
    ).resolves.toBe('skipped')
    expect(persistence.reads).toHaveLength(1)
  })

  test('hydration never clobbers a sheet a local command already owns', async () => {
    const store = createStore()
    const persistence = createPersistencePort([9], [9])
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [1] })
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 10,
        colCount: 10,
        source: persistence.port,
      }),
    ).resolves.toBe('skipped')
    expect(store.getter(viewportHiddenAtom).rowsBySheet['A']).toEqual([1])
  })

  test('a local write during an in-flight hydration wins over the late seed', async () => {
    const store = createStore()
    type SizeRead = NonNullable<ViewportHiddenPersistencePort['readViewportSizeProjection']>
    const read = deferred<Awaited<ReturnType<SizeRead>>>()
    const port: ViewportHiddenPersistencePort = {
      readViewportSizeProjection: () => read.promise,
    }
    const pending = store.setter(hydrateViewportHiddenAtom, {
      sheetId: 'A',
      rowCount: 10,
      colCount: 10,
      source: port,
    })
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [5] })
    read.resolve({
      kind: 'viewport-size',
      sheetId: 'A',
      window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
      revision: 1,
      rowHeights: [],
      colWidths: [],
      hiddenRowIndices: [2],
      hiddenColIndices: [],
    })
    await expect(pending).resolves.toBe('skipped')
    expect(store.getter(viewportHiddenAtom).rowsBySheet['A']).toEqual([5])
  })

  test('reports unsupported for a missing read port or absent hidden slices', async () => {
    const store = createStore()
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 10,
        colCount: 10,
        source: {},
      }),
    ).resolves.toBe('unsupported')

    // A worker-style backend serves sizes but omits hidden slices.
    const sizesOnly: ViewportHiddenPersistencePort = {
      async readViewportSizeProjection(request) {
        return {
          kind: 'viewport-size',
          sheetId: request.sheetId,
          window: { ...request.window },
          revision: 1,
          rowHeights: [],
          colWidths: [],
        }
      },
    }
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 10,
        colCount: 10,
        source: sizesOnly,
      }),
    ).resolves.toBe('unsupported')
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    // An unsupported seed does not own the sheet — a later capable port may seed it.
    const persistence = createPersistencePort([3], [])
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 10,
        colCount: 10,
        source: persistence.port,
      }),
    ).resolves.toBe('hydrated')
    expect(store.getter(viewportHiddenAtom).rowsBySheet['A']).toEqual([3])
  })

  test('reports error with a diagnostic on rejected reads and malformed payloads', async () => {
    const store = createStore()
    const failing: ViewportHiddenPersistencePort = {
      async readViewportSizeProjection() {
        throw new Error('read offline')
      },
    }
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'A',
        rowCount: 10,
        colCount: 10,
        source: failing,
      }),
    ).resolves.toBe('error')
    expect(store.getter(viewportHiddenDiagnosticAtom)).toEqual({
      kind: 'hydrate-failed',
      sheetId: 'A',
      message: 'read offline',
    })

    const halfPayload: ViewportHiddenPersistencePort = {
      async readViewportSizeProjection(request) {
        return {
          kind: 'viewport-size',
          sheetId: request.sheetId,
          window: { ...request.window },
          revision: 1,
          rowHeights: [],
          colWidths: [],
          hiddenRowIndices: [1],
        }
      },
    }
    await expect(
      store.setter(hydrateViewportHiddenAtom, {
        sheetId: 'B',
        rowCount: 10,
        colCount: 10,
        source: halfPayload,
      }),
    ).resolves.toBe('error')
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(viewportHiddenDiagnosticAtom)).toMatchObject({
      kind: 'hydrate-failed',
      sheetId: 'B',
    })
  })
})

describe('hidden selection unhide command', () => {
  test('unhides only the selection∩hidden intersection from the full local truth', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [1, 3, 8] })
    store.setter(selectRowsAtom, { sheetId: 'S', rowAnchor: 2, rowFocus: 4 })
    expect(store.setter(unhideViewportSelectionAtom, { action: 'unhide-rows' })).toBe('committed')
    // Row 3 was hidden inside the selection; rows 1 and 8 stay hidden even
    // though no windowed mirror ever reported them.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['S']).toEqual([1, 8])
  })

  test('reports unchanged when the selection covers no hidden index', () => {
    const store = createStore()
    store.setter(hideColumnsAtom, { sheetId: 'S', indices: [9] })
    store.setter(selectColumnsAtom, { sheetId: 'S', colAnchor: 1, colFocus: 3 })
    expect(store.setter(unhideViewportSelectionAtom, { action: 'unhide-columns' })).toBe(
      'unchanged',
    )
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test('reports invalid without a usable single selection', () => {
    const store = createStore()
    expect(store.setter(unhideViewportSelectionAtom, { action: 'unhide-rows' })).toBe('invalid')
    expect(
      store.setter(unhideViewportSelectionAtom, {
        action: 'wrong' as unknown as 'unhide-rows',
      }),
    ).toBe('invalid')
  })
})

describe('hidden history local replay', () => {
  const historyInput = () => ({
    source: {},
    refreshProjection: async () => {
      throw new Error('local replay must not refresh the backend projection')
    },
  })

  test('replays hide A → hide B → undo B → undo A → redo A → redo B in exact order', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [2, 3] })
    store.setter(hideColumnsAtom, { sheetId: 'S', indices: [1] })
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
    expect(store.getter(historyStackAtom).entries[0]).toMatchObject({ kind: 'viewport.hidden' })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { S: [2, 3] },
      colsBySheet: { S: [] },
    })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { S: [] },
      colsBySheet: { S: [] },
    })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { S: [2, 3] },
      colsBySheet: { S: [] },
    })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { S: [2, 3] },
      colsBySheet: { S: [1] },
    })
  })

  test('undo needs no undoTransaction and mirrors the delta into the hook', async () => {
    const store = createStore()
    const persistence = createPersistencePort()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [2, 3], source: persistence.port })
    await flushMicrotasks()
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: persistence.port,
        refreshProjection: async () => {
          throw new Error('local replay must not refresh the backend projection')
        },
      }),
    ).resolves.toBe('completed')
    await flushMicrotasks()
    expect(store.getter(viewportHiddenAtom).rowsBySheet['S']).toEqual([])
    expect(persistence.hideRows.map((request) => request.rowIndices)).toEqual([[2, 3]])
    expect(persistence.unhideRows.map((request) => request.rowIndices)).toEqual([[2, 3]])
    expect(persistence.rows).toEqual([])
  })

  test('local hidden entries never poison the backend projection-revision witness', async () => {
    const store = createStore()
    store.setter(spreadsheetUiCore.pushHistoryAtom, {
      transactionId: 'tx-backend',
      kind: 'cell.set-input',
      sheetId: 'S',
      projectionRevision: 7,
    })
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [4] })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')

    const undoRequests: Array<{ transactionId: string; revision: unknown }> = []
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: {
          async undoTransaction(request) {
            undoRequests.push({ transactionId: request.transactionId, revision: request.revision })
            return {
              transactionId: request.transactionId,
              requestId: request.requestId,
              revision: 8,
            }
          },
        },
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    expect(undoRequests).toEqual([{ transactionId: 'tx-backend', revision: 7 }])
  })
})

describe('hidden structural shift remap', () => {
  test('insert above shifts hidden rows down; cols untouched', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [3, 6] })
    store.setter(hideColumnsAtom, { sheetId: 'S', indices: [2] })
    const moved = store.setter(applyViewportHiddenStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'row', kind: 'insert', index: 4, count: 2 },
    })
    expect(moved).toBe(true)
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { S: [3, 8] },
      colsBySheet: { S: [2] },
    })
    // The remap is part of the structural operation — no extra history entry.
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
  })

  test('delete drops hidden indices inside the deleted band', () => {
    const store = createStore()
    store.setter(hideColumnsAtom, { sheetId: 'S', indices: [1, 3, 7] })
    store.setter(applyViewportHiddenStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'column', kind: 'delete', index: 2, count: 3 },
    })
    expect(store.getter(viewportHiddenAtom).colsBySheet['S']).toEqual([1, 4])
  })

  test('ignores sheets without hidden state and invalid shifts', () => {
    const store = createStore()
    expect(
      store.setter(applyViewportHiddenStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'row', kind: 'insert', index: 0, count: 1 },
      }),
    ).toBe(false)
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [5] })
    expect(
      store.setter(applyViewportHiddenStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'row', kind: 'insert', index: -1, count: 0 },
      }),
    ).toBe(false)
    expect(store.getter(viewportHiddenAtom).rowsBySheet['S']).toEqual([5])
  })
})

describe('isRowHidden / isColumnHidden', () => {
  test('isRowHidden returns true for a hidden row', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'A', indices: [3, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(isRowHidden(state, 'A', 3)).toBe(true)
    expect(isRowHidden(state, 'A', 4)).toBe(false)
  })

  test('isRowHidden returns false for unknown sheet', () => {
    expect(isRowHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })

  test('isColumnHidden is symmetric', () => {
    const store = createStore()
    store.setter(hideColumnsAtom, { sheetId: 'A', indices: [2, 7] })
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
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [9, 2, 4] })
    store.setter(hideColumnsAtom, { sheetId: 'S', indices: [5, 1] })
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
    const result = getVisibleWindowWithHidden(m, {
      rows: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
      cols: [],
    })
    expect(result).toEqual(base)
  })
})
