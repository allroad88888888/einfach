import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import * as spreadsheetUiCore from '../src'
import {
  applyViewportFreezeStructuralShiftAtom,
  DEFAULT_VIEWPORT_FREEZE_STATE,
  getFrozenWindows,
  getVisibleWindow,
  historyStackAtom,
  hydrateViewportFreezeAtom,
  remapFrozenLeadingBand,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  setFreezeConfigAtom,
  viewportFreezeAtom,
  viewportFreezeDiagnosticAtom,
  type HistoryControllerPort,
  type ReadFreezeConfigRequest,
  type SetFreezeConfigRequest,
  type ViewportFreezePersistencePort,
  type ViewportMetrics,
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

function flushMicrotasks(times = 3): Promise<void> {
  let chain = Promise.resolve()
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined)
  return chain
}

function createPersistencePort(seed: { rows: number; cols: number } = { rows: 0, cols: 0 }) {
  const freezeBySheet = new Map<string, { rows: number; cols: number }>()
  const setRequests: SetFreezeConfigRequest[] = []
  let readCalls = 0
  // Also structurally satisfies HistoryControllerPort (both methods optional)
  // so this same mock can double as the `source` for runUndoHistoryAtom in
  // the local-replay history tests below without widening to `{}`.
  const port: ViewportFreezePersistencePort & HistoryControllerPort = {
    async readFreezeConfig(request: ReadFreezeConfigRequest) {
      readCalls += 1
      const freeze = freezeBySheet.get(request.sheetId) ?? seed
      return {
        kind: 'freeze-config' as const,
        sheetId: request.sheetId,
        freeze: { ...freeze },
      }
    },
    async setFreezeConfig(request: SetFreezeConfigRequest) {
      setRequests.push(request)
      freezeBySheet.set(request.sheetId, { ...request.freeze })
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }
  return {
    port,
    setRequests,
    freezeBySheet,
    get readCalls() {
      return readCalls
    },
  }
}

describe('viewportFreezeAtom (UI-core canonical)', () => {
  test('initial state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('does not export a writable freeze projection setter', () => {
    expect('setViewportFreezeAtom' in spreadsheetUiCore).toBe(false)
  })

  test('setFreezeConfigAtom commits synchronously without any backend port', () => {
    const store = createStore()
    const outcome = store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 2, cols: 1 })
    expect(outcome).toBe('committed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 1 },
    })
  })

  test('a single-axis command preserves the other local axis', () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 1, cols: 7 })
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 4 })).toBe('committed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 4 },
      colsBySheet: { A: 7 },
    })
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 2, cols: 1 })
    store.setter(setFreezeConfigAtom, { sheetId: 'B', rows: 5, cols: 3 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2, B: 5 },
      colsBySheet: { A: 1, B: 3 },
    })
  })

  test.each([
    ['negative counts', { rows: -5, cols: -3 }],
    ['NaN counts', { rows: NaN, cols: NaN }],
    ['fractional counts', { rows: 2.9, cols: 1.1 }],
  ])('rejects %s without state or history', (_label, freeze) => {
    const store = createStore()
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A', ...freeze })).toBe('invalid')
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('rejects an empty sheet id and an axis-free command', () => {
    const store = createStore()
    expect(store.setter(setFreezeConfigAtom, { sheetId: '', rows: 1, cols: 1 })).toBe('invalid')
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A' })).toBe('invalid')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  test('a no-op command reports unchanged and records no history', () => {
    const store = createStore()
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 0, cols: 0 })).toBe('unchanged')
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 2, cols: 1 })
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 2, cols: 1 })).toBe('unchanged')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })
})

describe('freeze persistence hook', () => {
  test('mirrors a committed config fire-and-forget', async () => {
    const store = createStore()
    const persistence = createPersistencePort()
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 3, cols: 2, source: persistence.port })
    // Local commit is synchronous even though the mirror is async.
    expect(store.getter(viewportFreezeAtom).rowsBySheet['A']).toBe(3)
    await flushMicrotasks()
    expect(persistence.setRequests).toEqual([
      { kind: 'set-freeze-config', sheetId: 'A', freeze: { rows: 3, cols: 2 } },
    ])
    expect(store.getter(viewportFreezeDiagnosticAtom)).toBeNull()
  })

  test('a persistence failure records a diagnostic and never rolls back local state', async () => {
    const store = createStore()
    const source: ViewportFreezePersistencePort = {
      async setFreezeConfig() {
        throw new Error('persist offline')
      },
    }
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 4, cols: 0, source })).toBe(
      'committed',
    )
    await flushMicrotasks()
    expect(store.getter(viewportFreezeAtom).rowsBySheet['A']).toBe(4)
    expect(store.getter(viewportFreezeDiagnosticAtom)).toEqual({
      kind: 'persist-failed',
      sheetId: 'A',
      message: 'persist offline',
    })
  })

  test('hydrates once per sheet from readFreezeConfig', async () => {
    const store = createStore()
    const persistence = createPersistencePort({ rows: 2, cols: 1 })
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: persistence.port }),
    ).resolves.toBe('hydrated')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 1 },
    })
    // Second hydrate is a no-op seed, even if the persisted value changed.
    persistence.freezeBySheet.set('A', { rows: 9, cols: 9 })
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: persistence.port }),
    ).resolves.toBe('skipped')
    expect(store.getter(viewportFreezeAtom).rowsBySheet['A']).toBe(2)
    expect(persistence.readCalls).toBe(1)
  })

  test('hydration never clobbers a sheet a local command already owns', async () => {
    const store = createStore()
    const persistence = createPersistencePort({ rows: 7, cols: 7 })
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 1, cols: 1 })
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: persistence.port }),
    ).resolves.toBe('skipped')
    expect(store.getter(viewportFreezeAtom).rowsBySheet['A']).toBe(1)
  })

  test('a local write during an in-flight hydration wins over the late seed', async () => {
    const store = createStore()
    const read = deferred<Awaited<ReturnType<NonNullable<typeof port.readFreezeConfig>>>>()
    const port: ViewportFreezePersistencePort = {
      readFreezeConfig: () => read.promise,
    }
    const pending = store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: port })
    store.setter(setFreezeConfigAtom, { sheetId: 'A', rows: 5, cols: 5 })
    read.resolve({ kind: 'freeze-config', sheetId: 'A', freeze: { rows: 2, cols: 2 } })
    await expect(pending).resolves.toBe('skipped')
    expect(store.getter(viewportFreezeAtom).rowsBySheet['A']).toBe(5)
  })

  test('reports unsupported without a read hook and error on invalid payloads', async () => {
    const store = createStore()
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: {} }),
    ).resolves.toBe('unsupported')

    const invalidSource: ViewportFreezePersistencePort = {
      async readFreezeConfig(request) {
        return {
          kind: 'freeze-config' as const,
          sheetId: request.sheetId,
          freeze: { rows: -3, cols: 1 },
        }
      },
    }
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'A', source: invalidSource }),
    ).resolves.toBe('error')
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
    expect(store.getter(viewportFreezeDiagnosticAtom)).toMatchObject({ kind: 'hydrate-failed' })

    const failingSource: ViewportFreezePersistencePort = {
      async readFreezeConfig() {
        throw new Error('read offline')
      },
    }
    await expect(
      store.setter(hydrateViewportFreezeAtom, { sheetId: 'B', source: failingSource }),
    ).resolves.toBe('error')
    expect(store.getter(viewportFreezeDiagnosticAtom)).toEqual({
      kind: 'hydrate-failed',
      sheetId: 'B',
      message: 'read offline',
    })
  })
})

describe('freeze history local replay', () => {
  const historyInput = () => ({
    source: {},
    refreshProjection: async () => {
      throw new Error('local replay must not refresh the backend projection')
    },
  })

  test('replays Freeze A → B → undo B → undo A → redo A → redo B in exact order', async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 1, cols: 2 })
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 3, cols: 4 })
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
    expect(store.getter(historyStackAtom).entries[0]).toMatchObject({ kind: 'viewport.freeze' })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { S: 1 },
      colsBySheet: { S: 2 },
    })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { S: 1 },
      colsBySheet: { S: 2 },
    })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { S: 3 },
      colsBySheet: { S: 4 },
    })
  })

  test('undo needs no undoTransaction and mirrors into the persistence hook', async () => {
    const store = createStore()
    const persistence = createPersistencePort()
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 2, cols: 0, source: persistence.port })
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
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
    expect(persistence.setRequests.map((request) => request.freeze)).toEqual([
      { rows: 2, cols: 0 },
      { rows: 0, cols: 0 },
    ])
  })

  test('an unknown local-replay applier blocks without moving the cursor', async () => {
    const store = createStore()
    store.setter(spreadsheetUiCore.pushHistoryAtom, {
      transactionId: 'local-1',
      kind: 'viewport.freeze',
      sheetId: 'S',
      projectionRevision: 'local',
      localReplay: {
        applyKey: 'viewport.unregistered',
        sheetId: 'S',
        before: null,
        after: { rows: 1, cols: 1 },
      },
    })
    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('blocked')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test('local entries never poison the backend projection-revision witness', async () => {
    const store = createStore()
    // Backend entry establishes revision 7 as the strict witness.
    store.setter(spreadsheetUiCore.pushHistoryAtom, {
      transactionId: 'tx-backend',
      kind: 'cell.set-input',
      sheetId: 'S',
      projectionRevision: 7,
    })
    // A later local freeze entry must not overwrite the witness with its
    // session-local 'local' label.
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 1, cols: 1 })

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

describe('freeze structural shift remap', () => {
  const REMAP_CASES = [
    ['insert above the freeze line grows the band', 3, { kind: 'insert', index: 1, count: 2 }, 5],
    ['insert at the freeze line is untouched', 3, { kind: 'insert', index: 3, count: 2 }, 3],
    ['delete fully inside the band shrinks by count', 4, { kind: 'delete', index: 1, count: 2 }, 2],
    ['delete over the line shrinks by overlap', 3, { kind: 'delete', index: 2, count: 5 }, 2],
    ['delete past the freeze line is untouched', 2, { kind: 'delete', index: 2, count: 3 }, 2],
    ['zero frozen stays zero', 0, { kind: 'insert', index: 0, count: 2 }, 0],
  ] as const
  test.each(REMAP_CASES)(
    'remapFrozenLeadingBand: %s',
    (...args: (typeof REMAP_CASES)[number]) => {
      const [_label, frozen, shift, expected] = args
      expect(remapFrozenLeadingBand(frozen, { axis: 'row', ...shift })).toBe(expected)
    },
  )

  test('applyViewportFreezeStructuralShiftAtom moves the frozen rows and leaves cols alone', () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 3, cols: 2 })
    const moved = store.setter(applyViewportFreezeStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'row', kind: 'insert', index: 0, count: 2 },
    })
    expect(moved).toBe(true)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { S: 5 },
      colsBySheet: { S: 2 },
    })
    // The remap is part of the structural operation — no extra history entry.
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test('column shifts remap the frozen cols', () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 1, cols: 4 })
    store.setter(applyViewportFreezeStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'column', kind: 'delete', index: 1, count: 2 },
    })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { S: 1 },
      colsBySheet: { S: 2 },
    })
  })

  test('ignores sheets without local freeze state and invalid shifts', () => {
    const store = createStore()
    expect(
      store.setter(applyViewportFreezeStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'row', kind: 'insert', index: 0, count: 2 },
      }),
    ).toBe(false)
    store.setter(setFreezeConfigAtom, { sheetId: 'S', rows: 2, cols: 0 })
    expect(
      store.setter(applyViewportFreezeStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'row', kind: 'insert', index: -1, count: 0 },
      }),
    ).toBe(false)
    expect(store.getter(viewportFreezeAtom).rowsBySheet['S']).toBe(2)
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
