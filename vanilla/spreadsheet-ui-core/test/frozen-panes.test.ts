import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import * as spreadsheetUiCore from '../src'
import {
  DEFAULT_VIEWPORT_FREEZE_STATE,
  getFrozenWindows,
  getVisibleWindow,
  isViewportFreezeProjectionReady,
  readViewportFreezeCanonicalAtom,
  runViewportFreezeMutationAtom,
  viewportFreezeAtom,
  viewportFreezeLifecycleAtom,
  viewportFreezeProjectionAuthorityAtom,
  type BackendMutationResult,
  type ReadFreezeConfigRequest,
  type ReadFreezeConfigResult,
  type SetFreezeConfigRequest,
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

async function hydrateFreeze(
  store: ReturnType<typeof createStore>,
  sheetId: string,
  freeze: { rows: number; cols: number },
  revision = 1,
) {
  return store.setter(readViewportFreezeCanonicalAtom, {
    sheetId,
    source: {
      async readFreezeConfig(request) {
        return {
          kind: 'freeze-config' as const,
          sheetId,
          requestId: request.requestId,
          revision,
          freeze,
        }
      },
      async setFreezeConfig(request) {
        return { sheetId, requestId: request.requestId, revision }
      },
    },
  })
}

describe('viewportFreezeAtom', () => {
  test('initial state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('does not export a writable freeze projection setter', () => {
    expect('setViewportFreezeAtom' in spreadsheetUiCore).toBe(false)
  })

  test('stores canonical rows and cols per sheet', async () => {
    const store = createStore()
    await expect(hydrateFreeze(store, 'A', { rows: 2, cols: 1 })).resolves.toBe('committed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 1 },
    })
  })

  test('a later canonical projection can update rows while retaining cols', async () => {
    const store = createStore()
    await hydrateFreeze(store, 'A', { rows: 2, cols: 1 })
    await hydrateFreeze(store, 'A', { rows: 0, cols: 1 }, 2)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 0 },
      colsBySheet: { A: 1 },
    })
  })

  test('a later canonical projection can update cols while retaining rows', async () => {
    const store = createStore()
    await hydrateFreeze(store, 'A', { rows: 3, cols: 4 })
    await hydrateFreeze(store, 'A', { rows: 3, cols: 7 }, 2)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 3 },
      colsBySheet: { A: 7 },
    })
  })

  test('does not overwrite sibling sheets', async () => {
    const store = createStore()
    await hydrateFreeze(store, 'A', { rows: 2, cols: 1 })
    await hydrateFreeze(store, 'B', { rows: 5, cols: 3 }, 2)
    const state = store.getter(viewportFreezeAtom)
    expect(state.rowsBySheet['A']).toBe(2)
    expect(state.colsBySheet['A']).toBe(1)
    expect(state.rowsBySheet['B']).toBe(5)
    expect(state.colsBySheet['B']).toBe(3)
  })

  test('rejects negative canonical values', async () => {
    const store = createStore()
    await expect(hydrateFreeze(store, 'A', { rows: -5, cols: -3 })).resolves.toBe('error')
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
  })

  test('rejects NaN canonical values', async () => {
    const store = createStore()
    await expect(hydrateFreeze(store, 'A', { rows: NaN, cols: NaN })).resolves.toBe('error')
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
  })

  test('rejects fractional canonical values', async () => {
    const store = createStore()
    await expect(hydrateFreeze(store, 'A', { rows: 2.9, cols: 1.1 })).resolves.toBe('error')
    expect(store.getter(viewportFreezeAtom)).toEqual(DEFAULT_VIEWPORT_FREEZE_STATE)
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

describe('canonical freeze authority', () => {
  test('does not project a requested freeze until the mutation ACK and canonical readback complete', async () => {
    const store = createStore()
    const mutation = deferred<BackendMutationResult>()
    const canonicalRead = deferred<ReadFreezeConfigResult>()
    let setRequest: SetFreezeConfigRequest | undefined
    let readRequest: ReadFreezeConfigRequest | undefined
    const statuses = [store.getter(viewportFreezeLifecycleAtom).status]
    const source = {
      setFreezeConfig(request: SetFreezeConfigRequest) {
        setRequest = request
        return mutation.promise
      },
      readFreezeConfig(request: ReadFreezeConfigRequest) {
        readRequest = request
        return canonicalRead.promise
      },
    }

    const pending = store.setter(runViewportFreezeMutationAtom, {
      source,
      sheetId: 'A',
      rows: 4,
      cols: 2,
    })

    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('validating')
    statuses.push(store.getter(viewportFreezeLifecycleAtom).status)
    await Promise.resolve()
    expect(setRequest?.freeze).toEqual({ rows: 4, cols: 2 })
    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('mutating')
    statuses.push(store.getter(viewportFreezeLifecycleAtom).status)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: {},
      colsBySheet: {},
    })

    mutation.resolve({ sheetId: 'A', requestId: setRequest?.requestId, revision: 7 })
    await Promise.resolve()

    expect(readRequest).toEqual({
      kind: 'read-freeze-config',
      sheetId: 'A',
      requestId: setRequest?.requestId,
      revision: 7,
    })
    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('canonical-reading')
    statuses.push(store.getter(viewportFreezeLifecycleAtom).status)
    expect(store.getter(viewportFreezeAtom).rowsBySheet.A).toBeUndefined()

    canonicalRead.resolve({
      kind: 'freeze-config',
      sheetId: 'A',
      requestId: setRequest?.requestId,
      revision: 7,
      freeze: { rows: 4, cols: 2 },
    })

    await expect(pending).resolves.toBe('committed')
    statuses.push(store.getter(viewportFreezeLifecycleAtom).status)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 4 },
      colsBySheet: { A: 2 },
    })
    expect(statuses).toEqual([
      'idle',
      'validating',
      'mutating',
      'canonical-reading',
      'committed',
    ])
  })

  test('marks a failed or mismatched mutation as recovery-required without a local half-commit', async () => {
    const store = createStore()
    await hydrateFreeze(store, 'A', { rows: 1, cols: 2 })

    await expect(
      store.setter(runViewportFreezeMutationAtom, {
        source: {
          async setFreezeConfig(request) {
            return { sheetId: request.sheetId, requestId: 999, revision: 1 }
          },
          async readFreezeConfig(request) {
            return {
              kind: 'freeze-config' as const,
              sheetId: request.sheetId,
              requestId: request.requestId,
              revision: request.revision,
              freeze: { rows: 8, cols: 8 },
            }
          },
        },
        sheetId: 'A',
        rows: 8,
        cols: 2,
      }),
    ).resolves.toBe('recovery-required')

    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('recovery-required')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 1 },
      colsBySheet: { A: 2 },
    })
  })

  test('preflights a single-axis mutation and preserves the other canonical axis with a revision precondition', async () => {
    const store = createStore()
    let canonical = { rows: 1, cols: 7 }
    let revision = 3
    let setRequest: SetFreezeConfigRequest | undefined
    const source = {
      async readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision,
          freeze: canonical,
        }
      },
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        setRequest = request
        canonical = { ...request.freeze }
        revision += 1
        return { sheetId: request.sheetId, requestId: request.requestId, revision }
      },
    }

    await expect(
      store.setter(runViewportFreezeMutationAtom, {
        source,
        sheetId: 'A',
        rows: 4,
      }),
    ).resolves.toBe('committed')

    expect(setRequest).toMatchObject({
      freeze: { rows: 4, cols: 7 },
      revision: 3,
    })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 4 },
      colsBySheet: { A: 7 },
    })
  })

  test('invalidates an old supported authority projection while a new supported authority hydrates', async () => {
    const store = createStore()
    const sourceA = {
      async readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 1,
          freeze: { rows: 2, cols: 3 },
        }
      },
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 1 }
      },
    }
    await store.setter(readViewportFreezeCanonicalAtom, { source: sourceA, sheetId: 'A' })
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        sourceA,
        'A',
      ),
    ).toBe(true)

    const nextRead = deferred<ReadFreezeConfigResult>()
    const sourceB = {
      readFreezeConfig: () => nextRead.promise,
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 8 }
      },
    }
    const pending = store.setter(readViewportFreezeCanonicalAtom, { source: sourceB, sheetId: 'A' })

    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 3 },
    })
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        sourceB,
        'A',
      ),
    ).toBe(false)

    await Promise.resolve()
    const requestId = store.getter(viewportFreezeLifecycleAtom).requestId
    nextRead.resolve({
      kind: 'freeze-config',
      sheetId: 'A',
      requestId: requestId!,
      revision: 8,
      freeze: { rows: 5, cols: 1 },
    })
    await expect(pending).resolves.toBe('committed')
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        sourceB,
        'A',
      ),
    ).toBe(true)
  })

  test('masks sheet A projection while the same backend hydrates sheet B', async () => {
    const store = createStore()
    const sheetBRead = deferred<ReadFreezeConfigResult>()
    let sheetBRequest: ReadFreezeConfigRequest | undefined
    const source = {
      readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        if (request.sheetId === 'A') {
          return Promise.resolve({
            kind: 'freeze-config',
            sheetId: 'A',
            requestId: request.requestId,
            revision: 1,
            freeze: { rows: 2, cols: 3 },
          })
        }
        sheetBRequest = request
        return sheetBRead.promise
      },
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 2 }
      },
    }

    await expect(
      store.setter(readViewportFreezeCanonicalAtom, { source, sheetId: 'A' }),
    ).resolves.toBe('committed')
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        source,
        'A',
      ),
    ).toBe(true)

    const pending = store.setter(readViewportFreezeCanonicalAtom, { source, sheetId: 'B' })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 3 },
    })
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        source,
        'A',
      ),
    ).toBe(false)
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        source,
        'B',
      ),
    ).toBe(false)

    await Promise.resolve()
    await Promise.resolve()
    sheetBRead.resolve({
      kind: 'freeze-config',
      sheetId: 'B',
      requestId: sheetBRequest?.requestId,
      revision: 2,
      freeze: { rows: 1, cols: 4 },
    })
    await expect(pending).resolves.toBe('committed')
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        source,
        'B',
      ),
    ).toBe(true)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2, B: 1 },
      colsBySheet: { A: 3, B: 4 },
    })
  })

  test('an authority read supersedes an older pending mutation and prevents its late ACK from committing', async () => {
    const store = createStore()
    const mutation = deferred<BackendMutationResult>()
    let mutationRequest: SetFreezeConfigRequest | undefined
    const sourceA = {
      setFreezeConfig(request: SetFreezeConfigRequest) {
        mutationRequest = request
        return mutation.promise
      },
      async readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 1,
          freeze: { rows: 1, cols: 1 },
        }
      },
    }
    const pendingMutation = store.setter(runViewportFreezeMutationAtom, {
      source: sourceA,
      sheetId: 'A',
      rows: 4,
      cols: 4,
    })
    await Promise.resolve()

    const sourceB = {
      async readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 9,
          freeze: { rows: 2, cols: 6 },
        }
      },
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 9 }
      },
    }
    const pendingRead = store.setter(readViewportFreezeCanonicalAtom, {
      source: sourceB,
      sheetId: 'A',
    })
    mutation.resolve({
      sheetId: 'A',
      requestId: mutationRequest?.requestId,
      revision: 2,
    })

    await expect(pendingMutation).resolves.toBe('stale')
    await expect(pendingRead).resolves.toBe('committed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 6 },
    })
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        sourceB,
        'A',
      ),
    ).toBe(true)
  })

  test('reports canonical read errors and unsupported transports without changing the projection', async () => {
    const errorStore = createStore()
    await hydrateFreeze(errorStore, 'A', { rows: 2, cols: 3 })
    await expect(
      errorStore.setter(readViewportFreezeCanonicalAtom, {
        sheetId: 'A',
        source: {
          async setFreezeConfig(request) {
            return { sheetId: request.sheetId, requestId: request.requestId, revision: 1 }
          },
          async readFreezeConfig() {
            throw new Error('read failed')
          },
        },
      }),
    ).resolves.toBe('error')
    expect(errorStore.getter(viewportFreezeLifecycleAtom).status).toBe('error')
    expect(errorStore.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 2 },
      colsBySheet: { A: 3 },
    })

    const unsupportedStore = createStore()
    await hydrateFreeze(unsupportedStore, 'A', { rows: 5, cols: 6 })
    await expect(
      unsupportedStore.setter(runViewportFreezeMutationAtom, {
        source: {},
        sheetId: 'A',
        rows: 9,
      }),
    ).resolves.toBe('unsupported')
    expect(unsupportedStore.getter(viewportFreezeLifecycleAtom).status).toBe('unsupported')
    expect(unsupportedStore.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 5 },
      colsBySheet: { A: 6 },
    })
    expect(unsupportedStore.getter(viewportFreezeLifecycleAtom).canonical).toBeNull()
  })

  test('rejects one-sided authority during hydration without invoking either transport', async () => {
    const store = createStore()
    await hydrateFreeze(store, 'A', { rows: 5, cols: 6 })
    let readOnlyCalls = 0
    let setOnlyCalls = 0
    const readOnlySource = {
      async readFreezeConfig(request: ReadFreezeConfigRequest): Promise<ReadFreezeConfigResult> {
        readOnlyCalls += 1
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
          freeze: { rows: 9, cols: 9 },
        }
      },
    }
    const setOnlySource = {
      async setFreezeConfig(request: SetFreezeConfigRequest): Promise<BackendMutationResult> {
        setOnlyCalls += 1
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 2 }
      },
    }

    await expect(
      store.setter(readViewportFreezeCanonicalAtom, {
        source: readOnlySource,
        sheetId: 'A',
      }),
    ).resolves.toBe('unsupported')
    await expect(
      store.setter(readViewportFreezeCanonicalAtom, {
        source: setOnlySource,
        sheetId: 'A',
      }),
    ).resolves.toBe('unsupported')

    expect(readOnlyCalls).toBe(0)
    expect(setOnlyCalls).toBe(0)
    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('unsupported')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { A: 5 },
      colsBySheet: { A: 6 },
    })
    expect(
      isViewportFreezeProjectionReady(
        store.getter(viewportFreezeProjectionAuthorityAtom),
        setOnlySource,
        'A',
      ),
    ).toBe(false)
  })
})
