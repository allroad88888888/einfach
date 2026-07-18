import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  DEFAULT_VIEWPORT_HIDDEN_STATE,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  hydrateViewportSizeProjectionAtom,
  isColumnHidden,
  isRowHidden,
  runViewportHiddenMutationAtom,
  runViewportHiddenSelectionMutationAtom,
  selectColumnsAtom,
  selectionAtom,
  selectRowsAtom,
  setMultiRegionSelectionAtom,
  setViewportColumnWidthAtom,
  setViewportHiddenAtom,
  setViewportRowHeightAtom,
  viewportHiddenAtom,
  viewportHiddenLifecycleAtom,
  viewportHiddenProjectionAuthorityAtom,
  viewportSizeOverridesAtom,
  countVisibleIndices,
  getVisibleWindowWithHidden,
  getVisibleWindow,
  type BackendMutationResult,
  type CellRange,
  type HideColumnsRequest,
  type HideRowsRequest,
  type RunViewportHiddenMutationInput,
  type RunViewportHiddenSelectionMutationInput,
  type UnhideColumnsRequest,
  type UnhideRowsRequest,
  type ViewportHiddenControllerPort,
  type ViewportMetrics,
  type ViewportSizeProjectionRequest,
  type ViewportSizeProjectionResult,
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

const HIDDEN_WINDOW: CellRange = {
  rowStart: 3,
  rowEnd: 5,
  colStart: 2,
  colEnd: 7,
}

function matchingHiddenProjection(
  request: ViewportSizeProjectionRequest,
  hiddenRowIndices: number[] = [],
  hiddenColIndices: number[] = [],
): ViewportSizeProjectionResult {
  return {
    kind: 'viewport-size',
    sheetId: request.sheetId,
    window: { ...request.window },
    requestId: request.requestId,
    revision: request.revision ?? 1,
    rowHeights: [],
    colWidths: [],
    hiddenRowIndices,
    hiddenColIndices,
  }
}

function matchingViewportMetadataProjection(
  request: ViewportSizeProjectionRequest,
  overrides: Partial<ViewportSizeProjectionResult> = {},
): ViewportSizeProjectionResult {
  return {
    kind: 'viewport-size',
    sheetId: request.sheetId,
    window: { ...request.window },
    requestId: request.requestId,
    revision: 1,
    rowHeights: [{ rowIndex: request.window.rowStart, heightPx: 30 }],
    colWidths: [{ colIndex: request.window.colStart, widthPx: 80 }],
    hiddenRowIndices: [],
    hiddenColIndices: [],
    ...overrides,
  }
}

function matchingHiddenAcknowledgement(request: {
  sheetId: string
  requestId?: number
}): BackendMutationResult {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: 1,
  }
}

function createCanonicalUnhideSource(
  initialRows: readonly number[],
  initialCols: readonly number[],
  options: Readonly<{ rows?: boolean; columns?: boolean }> = {},
) {
  let rows = [...initialRows]
  let cols = [...initialCols]
  let revision = 10
  const reads: ViewportSizeProjectionRequest[] = []
  const rowMutations: UnhideRowsRequest[] = []
  const columnMutations: UnhideColumnsRequest[] = []
  const source: ViewportHiddenControllerPort = {
    async readViewportSizeProjection(request) {
      reads.push(request)
      return {
        ...matchingHiddenProjection(
          request,
          rows.filter(
            (index) => index >= request.window.rowStart && index <= request.window.rowEnd,
          ),
          cols.filter(
            (index) => index >= request.window.colStart && index <= request.window.colEnd,
          ),
        ),
        revision: request.revision ?? revision,
      }
    },
  }
  if (options.rows !== false) {
    source.unhideRows = async (request) => {
      rowMutations.push(request)
      rows = rows.filter((index) => !request.rowIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    }
  }
  if (options.columns !== false) {
    source.unhideColumns = async (request) => {
      columnMutations.push(request)
      cols = cols.filter((index) => !request.colIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    }
  }

  return { source, reads, rowMutations, columnMutations }
}

describe('viewportHiddenAtom', () => {
  test('initial hidden state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('rejects direct public writes without changing hidden product state', () => {
    const store = createStore()
    const before = store.getter(viewportHiddenAtom)

    expect(() =>
      Reflect.apply(store.setter, store, [
        viewportHiddenAtom,
        { rowsBySheet: { A: [7] }, colsBySheet: { A: [3] } },
      ]),
    ).toThrow()
    expect(store.getter(viewportHiddenAtom)).toBe(before)
  })

  test('setViewportHiddenAtom stores sorted dedup rows', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
  })

  test('negative or non-integer indices are dropped', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [-1, 0.5, 2, 3.0] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([2, 3])
  })

  test('updating cols only leaves rows untouched', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
    expect(state.colsBySheet['A']).toEqual([2])
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [0] })
    store.setter(setViewportHiddenAtom, { sheetId: 'B', rows: [4], cols: [7] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1])
    expect(state.rowsBySheet['B']).toEqual([4])
    expect(state.colsBySheet['A']).toEqual([0])
    expect(state.colsBySheet['B']).toEqual([7])
  })
})

describe('runViewportHiddenMutationAtom', () => {
  test('runs pending → local acknowledgement → canonical read → ready without optimistic state', async () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, {
      sheetId: 'A',
      rows: [1, 3, 4, 50],
      cols: [2, 6, 60],
    })
    const before = store.getter(viewportHiddenAtom)
    const mutation = deferred<BackendMutationResult>()
    const readback = deferred<ViewportSizeProjectionResult>()
    let mutationRequest: HideRowsRequest | undefined
    let readRequest: ViewportSizeProjectionRequest | undefined
    const source: ViewportHiddenControllerPort = {
      hideRows(request) {
        mutationRequest = request
        return mutation.promise
      },
      readViewportSizeProjection(request) {
        readRequest = request
        return readback.promise
      },
    }
    const statuses = [store.getter(viewportHiddenLifecycleAtom).status]
    const unsubscribe = store.sub(viewportHiddenLifecycleAtom, () => {
      statuses.push(store.getter(viewportHiddenLifecycleAtom).status)
    })

    const operation = store.setter(runViewportHiddenMutationAtom, {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [5, 3, 3],
      window: HIDDEN_WINDOW,
    })

    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('pending')
    expect(store.getter(viewportHiddenAtom)).toBe(before)
    expect(mutationRequest).toEqual({
      kind: 'hide-rows',
      sheetId: 'A',
      rowIndices: [3, 5],
      requestId: 1,
    })

    mutation.resolve({ sheetId: 'A', requestId: 1, revision: 7 })
    await Promise.resolve()
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('canonical-reading')
    expect(store.getter(viewportHiddenAtom)).toBe(before)
    expect(readRequest).toEqual({
      kind: 'viewport-size',
      sheetId: 'A',
      window: HIDDEN_WINDOW,
      requestId: 1,
      revision: 7,
    })

    readback.resolve(matchingHiddenProjection(readRequest!, [3, 5], [6]))
    await expect(operation).resolves.toBe('ready')
    unsubscribe()

    expect(statuses[0]).toBe('idle')
    expect(statuses).toContain('local-acknowledged')
    expect(statuses.indexOf('local-acknowledged')).toBeLessThan(
      statuses.indexOf('canonical-reading'),
    )
    expect(statuses.indexOf('canonical-reading')).toBeLessThan(statuses.indexOf('ready'))
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1, 3, 5, 50] },
      colsBySheet: { A: [6, 60] },
    })
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toEqual({
      source,
      sheetId: 'A',
      requestId: 1,
      revision: 7,
      window: HIDDEN_WINDOW,
      ready: true,
    })
  })

  test.each([
    ['hide-rows', 'hideRows', 'rowIndices'],
    ['unhide-rows', 'unhideRows', 'rowIndices'],
    ['hide-columns', 'hideColumns', 'colIndices'],
    ['unhide-columns', 'unhideColumns', 'colIndices'],
  ] as const)(
    'dispatches %s through the matching canonical backend method',
    async (action, expectedMethod, indexKey) => {
      const store = createStore()
      let calledMethod = ''
      let mutationRequest:
        | HideRowsRequest
        | UnhideRowsRequest
        | HideColumnsRequest
        | UnhideColumnsRequest
        | undefined
      const acknowledge = (
        method: string,
        request: HideRowsRequest | UnhideRowsRequest | HideColumnsRequest | UnhideColumnsRequest,
      ) => {
        calledMethod = method
        mutationRequest = request
        return Promise.resolve(matchingHiddenAcknowledgement(request))
      }
      const source: ViewportHiddenControllerPort = {
        hideRows: (request) => acknowledge('hideRows', request),
        unhideRows: (request) => acknowledge('unhideRows', request),
        hideColumns: (request) => acknowledge('hideColumns', request),
        unhideColumns: (request) => acknowledge('unhideColumns', request),
        async readViewportSizeProjection(request) {
          const hidden = action.startsWith('hide-') ? [3, 5] : []
          return action.endsWith('rows')
            ? matchingHiddenProjection(request, hidden, [])
            : matchingHiddenProjection(request, [], hidden)
        },
      }

      await expect(
        store.setter(runViewportHiddenMutationAtom, {
          source,
          sheetId: 'A',
          action,
          indices: [5, 3, 3],
          window: HIDDEN_WINDOW,
        }),
      ).resolves.toBe('ready')

      expect(calledMethod).toBe(expectedMethod)
      expect(mutationRequest).toMatchObject({
        kind: action,
        sheetId: 'A',
        [indexKey]: [3, 5],
        requestId: 1,
      })
    },
  )

  test('reconciles an unhide window without dropping off-window state or retaining removed values', async () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, {
      sheetId: 'A',
      rows: [1, 3, 4, 50],
      cols: [2, 6, 60],
    })
    let mutationRequest: UnhideRowsRequest | undefined
    const source: ViewportHiddenControllerPort = {
      async unhideRows(request) {
        mutationRequest = request
        return matchingHiddenAcknowledgement(request)
      },
      async readViewportSizeProjection(request) {
        return matchingHiddenProjection(request, [], [2])
      },
    }

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'unhide-rows',
        indices: [4, 3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')

    expect(mutationRequest?.rowIndices).toEqual([3, 4])
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1, 50] },
      colsBySheet: { A: [2, 60] },
    })
  })

  test('rejects a mismatched mutation acknowledgement without reading or writing projection state', async () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [2] })
    const before = store.getter(viewportHiddenAtom)
    let readCalls = 0
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        return { sheetId: request.sheetId, requestId: request.requestId! + 1, revision: 1 }
      },
      async readViewportSizeProjection(request) {
        readCalls += 1
        return matchingHiddenProjection(request)
      },
    }

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('recovery-required')

    expect(readCalls).toBe(0)
    expect(store.getter(viewportHiddenAtom)).toBe(before)
    expect(store.getter(viewportHiddenLifecycleAtom)).toMatchObject({
      status: 'recovery-required',
      revision: null,
    })
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      revision: null,
      ready: false,
    })
  })

  test('preserves the exact acknowledgement revision when canonical read transport rejects', async () => {
    const store = createStore()
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 17 }
      },
      async readViewportSizeProjection() {
        throw new Error('readback unavailable')
      },
    }

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('recovery-required')

    expect(store.getter(viewportHiddenLifecycleAtom)).toMatchObject({
      status: 'recovery-required',
      revision: 17,
    })
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      source,
      sheetId: 'A',
      revision: 17,
      ready: false,
    })
  })

  test.each([
    ['sheet identity', (result: ViewportSizeProjectionResult) => ({ ...result, sheetId: 'B' })],
    [
      'request identity',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        requestId: result.requestId! + 1,
      }),
    ],
    ['revision', (result: ViewportSizeProjectionResult) => ({ ...result, revision: 99 })],
    [
      'window',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        window: { ...result.window, rowEnd: result.window.rowEnd + 1 },
      }),
    ],
    [
      'missing hidden rows',
      (result: ViewportSizeProjectionResult) => {
        const malformed = { ...result }
        delete malformed.hiddenRowIndices
        return malformed
      },
    ],
    [
      'missing hidden columns',
      (result: ViewportSizeProjectionResult) => {
        const malformed = { ...result }
        delete malformed.hiddenColIndices
        return malformed
      },
    ],
    [
      'unsorted hidden rows',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenRowIndices: [5, 3] }),
    ],
    [
      'duplicate hidden columns',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenColIndices: [2, 2] }),
    ],
    [
      'out-of-window hidden rows',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenRowIndices: [50] }),
    ],
  ] as const)('fails closed on a malformed canonical readback %s', async (_label, corrupt) => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1, 4, 50], cols: [2, 60] })
    const before = store.getter(viewportHiddenAtom)
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        return matchingHiddenAcknowledgement(request)
      },
      async readViewportSizeProjection(request) {
        return corrupt(matchingHiddenProjection(request, [3], [2])) as ViewportSizeProjectionResult
      },
    }

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('recovery-required')
    expect(store.getter(viewportHiddenAtom)).toBe(before)
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('recovery-required')
  })

  test.each([
    ['empty indices', { indices: [] }],
    ['mixed negative index', { indices: [3, -1] }],
    ['mixed fractional index', { indices: [3, 3.5] }],
    ['mixed unsafe index', { indices: [3, Number.MAX_SAFE_INTEGER + 1] }],
    ['out-of-window index', { indices: [50] }],
    ['invalid action', { action: 'hide-diagonals' }],
    ['invalid window', { window: { ...HIDDEN_WINDOW, rowEnd: 2 } }],
  ] as const)('blocks %s with zero backend transport', async (_label, override) => {
    const store = createStore()
    let mutationCalls = 0
    let readCalls = 0
    const mutate = async (request: {
      sheetId: string
      requestId?: number
    }): Promise<BackendMutationResult> => {
      mutationCalls += 1
      return matchingHiddenAcknowledgement(request)
    }
    const source: ViewportHiddenControllerPort = {
      hideRows: mutate,
      unhideRows: mutate,
      hideColumns: mutate,
      unhideColumns: mutate,
      async readViewportSizeProjection(request) {
        readCalls += 1
        return matchingHiddenProjection(request)
      },
    }
    const input = {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
      ...override,
    } as RunViewportHiddenMutationInput

    await expect(store.setter(runViewportHiddenMutationAtom, input)).resolves.toBe('blocked')
    expect(mutationCalls).toBe(0)
    expect(readCalls).toBe(0)
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('blocked')
  })

  test.each(['mutation', 'readback'] as const)(
    'reports unsupported and performs zero transport when %s capability is missing',
    async (missing) => {
      const store = createStore()
      let mutationCalls = 0
      let readCalls = 0
      const source: ViewportHiddenControllerPort = {
        ...(missing === 'mutation'
          ? {}
          : {
              async hideRows(request: HideRowsRequest) {
                mutationCalls += 1
                return matchingHiddenAcknowledgement(request)
              },
            }),
        ...(missing === 'readback'
          ? {}
          : {
              async readViewportSizeProjection(request: ViewportSizeProjectionRequest) {
                readCalls += 1
                return matchingHiddenProjection(request)
              },
            }),
      }

      await expect(
        store.setter(runViewportHiddenMutationAtom, {
          source,
          sheetId: 'A',
          action: 'hide-rows',
          indices: [3],
          window: HIDDEN_WINDOW,
        }),
      ).resolves.toBe('unsupported')
      expect(mutationCalls).toBe(0)
      expect(readCalls).toBe(0)
      expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('unsupported')
      expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    },
  )

  test('allows only one same-tick mutation lane', async () => {
    const store = createStore()
    const acknowledgement = deferred<BackendMutationResult>()
    let mutationCalls = 0
    let request: HideRowsRequest | undefined
    const source: ViewportHiddenControllerPort = {
      hideRows(input) {
        mutationCalls += 1
        request = input
        return acknowledgement.promise
      },
      async readViewportSizeProjection(input) {
        return matchingHiddenProjection(input, [3], [])
      },
    }
    const input: RunViewportHiddenMutationInput = {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
    }

    const first = store.setter(runViewportHiddenMutationAtom, input)
    const second = store.setter(runViewportHiddenMutationAtom, input)

    await expect(second).resolves.toBe('blocked')
    expect(mutationCalls).toBe(1)
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('pending')
    acknowledgement.resolve(matchingHiddenAcknowledgement(request!))
    await expect(first).resolves.toBe('ready')
  })

  test('fails closed when the canonical local projection changes away and back in flight', async () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [2] })
    const readback = deferred<ViewportSizeProjectionResult>()
    let readRequest: ViewportSizeProjectionRequest | undefined
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        return matchingHiddenAcknowledgement(request)
      },
      readViewportSizeProjection(request) {
        readRequest = request
        return readback.promise
      },
    }

    const operation = store.setter(runViewportHiddenMutationAtom, {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
    })
    await Promise.resolve()
    expect(readRequest).toBeDefined()

    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [9], cols: [2] })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [2] })
    readback.resolve(matchingHiddenProjection(readRequest!, [3], [2]))

    await expect(operation).resolves.toBe('recovery-required')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1] },
      colsBySheet: { A: [2] },
    })
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('recovery-required')
    expect(store.getter(viewportHiddenProjectionAuthorityAtom).ready).toBe(false)
  })

  test('invalidates ready authority and stale revision after an external canonical hydrate', async () => {
    const store = createStore()
    const mutationRequests: HideRowsRequest[] = []
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        mutationRequests.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: mutationRequests.length === 1 ? 7 : 8,
        }
      },
      async readViewportSizeProjection(request) {
        return matchingHiddenProjection(request, [3], [])
      },
    }

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      revision: 7,
      ready: true,
    })

    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [4], cols: [] })
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toEqual({
      source: null,
      sheetId: null,
      requestId: null,
      revision: null,
      window: null,
      ready: false,
    })

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [3],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    expect(mutationRequests[1]).not.toHaveProperty('revision')
  })
})

describe('runViewportHiddenSelectionMutationAtom', () => {
  test('uses canonical intersections and the unchanged full authority window across row → column → row commands', async () => {
    const store = createStore()
    const authorityWindow: CellRange = {
      rowStart: 2,
      rowEnd: 8,
      colStart: 3,
      colEnd: 9,
    }
    const harness = createCanonicalUnhideSource([2, 4, 6, 8], [3, 5, 7, 9])

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: harness.source,
        sheetId: 'A',
        window: authorityWindow,
      }),
    ).resolves.toBe('ready')

    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 3, rowFocus: 6 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('ready')
    expect(harness.rowMutations[0]).toEqual({
      kind: 'unhide-rows',
      sheetId: 'A',
      rowIndices: [4, 6],
      requestId: 2,
      revision: 10,
    })

    store.setter(selectColumnsAtom, { sheetId: 'A', colAnchor: 4, colFocus: 7 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-columns',
      }),
    ).resolves.toBe('ready')
    expect(harness.columnMutations[0]).toEqual({
      kind: 'unhide-columns',
      sheetId: 'A',
      colIndices: [5, 7],
      requestId: 3,
      revision: 11,
    })

    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 2, rowFocus: 8 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('ready')
    expect(harness.rowMutations[1]).toEqual({
      kind: 'unhide-rows',
      sheetId: 'A',
      rowIndices: [2, 8],
      requestId: 4,
      revision: 12,
    })

    expect(harness.reads).toHaveLength(4)
    for (const request of harness.reads) expect(request.window).toEqual(authorityWindow)
    expect(harness.reads.slice(1).map((request) => request.revision)).toEqual([11, 12, 13])
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      source: harness.source,
      sheetId: 'A',
      revision: 13,
      window: authorityWindow,
      ready: true,
    })
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [] },
      colsBySheet: { A: [3, 9] },
    })
  })

  test('blocks multi-selection and an empty canonical intersection with zero transport', async () => {
    const store = createStore()
    const harness = createCanonicalUnhideSource([4], [6])
    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: harness.source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    const readsAfterHydration = harness.reads.length

    store.setter(setMultiRegionSelectionAtom, {
      regions: [
        {
          kind: 'range',
          sheetId: 'A',
          anchor: { row: 3, col: 2 },
          focus: { row: 4, col: 3 },
        },
        {
          kind: 'range',
          sheetId: 'A',
          anchor: { row: 4, col: 4 },
          focus: { row: 5, col: 5 },
        },
      ],
    })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')

    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'A',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 2 },
    })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-columns',
      }),
    ).resolves.toBe('blocked')

    expect(harness.rowMutations).toHaveLength(0)
    expect(harness.columnMutations).toHaveLength(0)
    expect(harness.reads).toHaveLength(readsAfterHydration)
  })

  test('fails closed for unready/null, wrong source, wrong sheet, and insufficient relevant-axis coverage', async () => {
    const unreadyStore = createStore()
    const unready = createCanonicalUnhideSource([4], [6])
    unreadyStore.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 4 })
    expect(unreadyStore.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      revision: null,
      ready: false,
    })
    await expect(
      unreadyStore.setter(runViewportHiddenSelectionMutationAtom, {
        source: unready.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')
    expect(unready.reads).toHaveLength(0)
    expect(unready.rowMutations).toHaveLength(0)

    const store = createStore()
    const harness = createCanonicalUnhideSource([4], [6])
    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: harness.source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    const readsAfterHydration = harness.reads.length

    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 4 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: { ...harness.source },
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')

    store.setter(selectRowsAtom, { sheetId: 'B', rowAnchor: 4 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')

    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 2, rowFocus: 4 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')

    store.setter(selectColumnsAtom, { sheetId: 'A', colAnchor: 6, colFocus: 8 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-columns',
      }),
    ).resolves.toBe('blocked')

    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'invalid-action',
      } as unknown as RunViewportHiddenSelectionMutationInput),
    ).resolves.toBe('blocked')

    expect(harness.rowMutations).toHaveLength(0)
    expect(harness.columnMutations).toHaveLength(0)
    expect(harness.reads).toHaveLength(readsAfterHydration)
  })

  test('invalid and empty commands do not supersede an active hydration ticket', async () => {
    const store = createStore()
    const inFlight = deferred<ViewportSizeProjectionResult>()
    const reads: ViewportSizeProjectionRequest[] = []
    let unhideCalls = 0
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        reads.push(request)
        if (reads.length === 1) return matchingHiddenProjection(request, [4], [])
        return inFlight.promise
      },
      async unhideRows(request) {
        unhideCalls += 1
        return matchingHiddenAcknowledgement(request)
      },
    }

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    const hydration = store.setter(hydrateViewportSizeProjectionAtom, {
      source,
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })
    expect(reads).toHaveLength(2)

    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 3 })
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')
    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source,
        action: 'invalid-action',
      } as unknown as RunViewportHiddenSelectionMutationInput),
    ).resolves.toBe('blocked')

    inFlight.resolve(matchingHiddenProjection(reads[1]!, [4], []))
    await expect(hydration).resolves.toBe('ready')
    expect(unhideCalls).toBe(0)
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      requestId: reads[1]!.requestId,
      ready: true,
    })
  })

  test('blocks a second resolver click without overwriting an active mutation lifecycle', async () => {
    const store = createStore()
    const mutation = deferred<BackendMutationResult>()
    const reads: ViewportSizeProjectionRequest[] = []
    const mutations: UnhideRowsRequest[] = []
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        reads.push(request)
        return matchingHiddenProjection(request, reads.length === 1 ? [4] : [], [])
      },
      async unhideRows(request) {
        mutations.push(request)
        return mutation.promise
      },
    }
    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 4 })

    const first = store.setter(runViewportHiddenSelectionMutationAtom, {
      source,
      action: 'unhide-rows',
    })
    expect(mutations).toHaveLength(1)
    const pending = store.getter(viewportHiddenLifecycleAtom)
    expect(pending).toMatchObject({
      status: 'pending',
      action: 'unhide-rows',
      requestId: 2,
      revision: 1,
      window: HIDDEN_WINDOW,
    })

    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('blocked')
    expect(store.getter(viewportHiddenLifecycleAtom)).toBe(pending)
    expect(mutations).toHaveLength(1)
    expect(reads).toHaveLength(1)

    mutation.resolve({ sheetId: 'A', requestId: 2, revision: 11 })
    await expect(first).resolves.toBe('ready')
    expect(reads).toHaveLength(2)
    expect(reads[1]).toEqual({
      kind: 'viewport-size',
      sheetId: 'A',
      window: HIDDEN_WINDOW,
      requestId: 2,
      revision: 11,
    })
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('ready')
  })

  test('delegates capability failure to the existing unsupported lifecycle', async () => {
    const store = createStore()
    const harness = createCanonicalUnhideSource([4], [], { rows: false })
    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: harness.source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')
    const readsAfterHydration = harness.reads.length
    store.setter(selectRowsAtom, { sheetId: 'A', rowAnchor: 4 })

    await expect(
      store.setter(runViewportHiddenSelectionMutationAtom, {
        source: harness.source,
        action: 'unhide-rows',
      }),
    ).resolves.toBe('unsupported')
    expect(harness.reads).toHaveLength(readsAfterHydration)
    expect(store.getter(viewportHiddenLifecycleAtom)).toMatchObject({
      status: 'unsupported',
      action: 'unhide-rows',
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })
  })
})

describe('hydrateViewportSizeProjectionAtom', () => {
  test('atomically reconciles the exact window while preserving off-window and sibling-sheet metadata', async () => {
    const store = createStore()
    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 1, heightPx: 22 })
    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 3, heightPx: 24 })
    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 50, heightPx: 26 })
    store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 1, widthPx: 70 })
    store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 2, widthPx: 75 })
    store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 60, widthPx: 90 })
    store.setter(setViewportRowHeightAtom, { sheetId: 'B', rowIndex: 4, heightPx: 35 })
    store.setter(setViewportColumnWidthAtom, { sheetId: 'B', colIndex: 5, widthPx: 105 })
    store.setter(setViewportHiddenAtom, {
      sheetId: 'A',
      rows: [1, 3, 4, 50],
      cols: [1, 2, 6, 60],
    })
    store.setter(setViewportHiddenAtom, { sheetId: 'B', rows: [4], cols: [5] })

    let capturedRequest: ViewportSizeProjectionRequest | undefined
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        capturedRequest = request
        return matchingViewportMetadataProjection(request, {
          revision: 13,
          rowHeights: [{ rowIndex: 4, heightPx: 44 }],
          colWidths: [{ colIndex: 6, widthPx: 166 }],
          hiddenRowIndices: [5],
          hiddenColIndices: [7],
        })
      },
    }

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('ready')

    expect(capturedRequest).toEqual({
      kind: 'viewport-size',
      sheetId: 'A',
      window: HIDDEN_WINDOW,
      requestId: 1,
    })
    expect(store.getter(viewportSizeOverridesAtom)).toEqual({
      rowHeightsBySheet: {
        A: { '1': 22, '4': 44, '50': 26 },
        B: { '4': 35 },
      },
      colWidthsBySheet: {
        A: { '1': 70, '6': 166, '60': 90 },
        B: { '5': 105 },
      },
    })
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { A: [1, 5, 50], B: [4] },
      colsBySheet: { A: [1, 7, 60], B: [5] },
    })
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toEqual({
      source,
      sheetId: 'A',
      requestId: 1,
      revision: 13,
      window: HIDDEN_WINDOW,
      ready: true,
    })
  })

  test('commits sizes-only worker results without interpreting absent hidden arrays as empty', async () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1, 4, 50], cols: [2, 60] })
    const hiddenBefore = store.getter(viewportHiddenAtom)
    const lifecycleBefore = store.getter(viewportHiddenLifecycleAtom)
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        const result = matchingViewportMetadataProjection(request, {
          revision: 9,
          rowHeights: [{ rowIndex: 4, heightPx: 48 }],
          colWidths: [{ colIndex: 6, widthPx: 144 }],
        })
        delete result.hiddenRowIndices
        delete result.hiddenColIndices
        return result
      },
    }

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('sizes-only')

    expect(store.getter(viewportSizeOverridesAtom)).toEqual({
      rowHeightsBySheet: { A: { '4': 48 } },
      colWidthsBySheet: { A: { '6': 144 } },
    })
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)
    expect(store.getter(viewportHiddenLifecycleAtom)).toBe(lifecycleBefore)
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toEqual({
      source,
      sheetId: 'A',
      requestId: 1,
      revision: 9,
      window: HIDDEN_WINDOW,
      ready: false,
    })
  })

  test.each([
    ['kind', (result: ViewportSizeProjectionResult) => ({ ...result, kind: 'range' })],
    ['sheet', (result: ViewportSizeProjectionResult) => ({ ...result, sheetId: 'B' })],
    [
      'request id',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        requestId: result.requestId! + 1,
      }),
    ],
    [
      'missing revision',
      (result: ViewportSizeProjectionResult) => ({ ...result, revision: undefined }),
    ],
    [
      'non-finite revision',
      (result: ViewportSizeProjectionResult) => ({ ...result, revision: Number.NaN }),
    ],
    [
      'window',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        window: { ...result.window, rowEnd: result.window.rowEnd + 1 },
      }),
    ],
    ['row array', (result: ViewportSizeProjectionResult) => ({ ...result, rowHeights: null })],
    [
      'unsorted rows',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [
          { rowIndex: 4, heightPx: 24 },
          { rowIndex: 3, heightPx: 24 },
        ],
      }),
    ],
    [
      'duplicate rows',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [
          { rowIndex: 3, heightPx: 24 },
          { rowIndex: 3, heightPx: 25 },
        ],
      }),
    ],
    [
      'out-of-window row',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [{ rowIndex: 2, heightPx: 24 }],
      }),
    ],
    [
      'unsafe row',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [{ rowIndex: Number.MAX_SAFE_INTEGER + 1, heightPx: 24 }],
      }),
    ],
    [
      'non-finite row height',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [{ rowIndex: 3, heightPx: Number.NaN }],
      }),
    ],
    [
      'out-of-range row height',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        rowHeights: [{ rowIndex: 3, heightPx: 15 }],
      }),
    ],
    ['column array', (result: ViewportSizeProjectionResult) => ({ ...result, colWidths: null })],
    [
      'unsorted columns',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        colWidths: [
          { colIndex: 3, widthPx: 80 },
          { colIndex: 2, widthPx: 80 },
        ],
      }),
    ],
    [
      'duplicate columns',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        colWidths: [
          { colIndex: 2, widthPx: 80 },
          { colIndex: 2, widthPx: 81 },
        ],
      }),
    ],
    [
      'out-of-window column',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        colWidths: [{ colIndex: 8, widthPx: 80 }],
      }),
    ],
    [
      'non-finite column width',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        colWidths: [{ colIndex: 2, widthPx: Number.POSITIVE_INFINITY }],
      }),
    ],
    [
      'out-of-range column width',
      (result: ViewportSizeProjectionResult) => ({
        ...result,
        colWidths: [{ colIndex: 2, widthPx: 39 }],
      }),
    ],
    [
      'single hidden row axis absent',
      (result: ViewportSizeProjectionResult) => {
        const malformed = { ...result }
        delete malformed.hiddenRowIndices
        return malformed
      },
    ],
    [
      'single hidden column axis absent',
      (result: ViewportSizeProjectionResult) => {
        const malformed = { ...result }
        delete malformed.hiddenColIndices
        return malformed
      },
    ],
    [
      'unsorted hidden rows',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenRowIndices: [5, 3] }),
    ],
    [
      'duplicate hidden columns',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenColIndices: [2, 2] }),
    ],
    [
      'out-of-window hidden rows',
      (result: ViewportSizeProjectionResult) => ({ ...result, hiddenRowIndices: [2] }),
    ],
  ] as const)('blocks malformed %s with zero partial projection write', async (_label, corrupt) => {
    const store = createStore()
    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 3, heightPx: 25 })
    store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 2, widthPx: 90 })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [4], cols: [2] })
    const sizeBefore = store.getter(viewportSizeOverridesAtom)
    const hiddenBefore = store.getter(viewportHiddenAtom)
    const lifecycleBefore = store.getter(viewportHiddenLifecycleAtom)
    const authorityBefore = store.getter(viewportHiddenProjectionAuthorityAtom)
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        return corrupt(
          matchingViewportMetadataProjection(request, {
            rowHeights: [{ rowIndex: 4, heightPx: 44 }],
            colWidths: [{ colIndex: 6, widthPx: 166 }],
            hiddenRowIndices: [5],
            hiddenColIndices: [7],
          }),
        ) as ViewportSizeProjectionResult
      },
    }

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('blocked')
    expect(store.getter(viewportSizeOverridesAtom)).toBe(sizeBefore)
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)
    expect(store.getter(viewportHiddenLifecycleAtom)).toBe(lifecycleBefore)
    expect(store.getter(viewportHiddenProjectionAuthorityAtom)).toBe(authorityBefore)
  })

  test('reports unsupported or rejected reads with zero projection write', async () => {
    const store = createStore()
    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 3, heightPx: 25 })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [4], cols: [2] })
    const sizeBefore = store.getter(viewportSizeOverridesAtom)
    const hiddenBefore = store.getter(viewportHiddenAtom)

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: {},
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('unsupported')
    expect(store.getter(viewportSizeOverridesAtom)).toBe(sizeBefore)
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: {
          async readViewportSizeProjection() {
            throw new Error('offline')
          },
        },
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('blocked')
    expect(store.getter(viewportSizeOverridesAtom)).toBe(sizeBefore)
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)
  })

  test('uses latest-wins ordering for concurrent hydrations', async () => {
    const store = createStore()
    const reads: Array<{
      request: ViewportSizeProjectionRequest
      operation: ReturnType<typeof deferred<ViewportSizeProjectionResult>>
    }> = []
    const source: ViewportHiddenControllerPort = {
      readViewportSizeProjection(request) {
        const operation = deferred<ViewportSizeProjectionResult>()
        reads.push({ request, operation })
        return operation.promise
      },
    }

    const first = store.setter(hydrateViewportSizeProjectionAtom, {
      source,
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })
    const second = store.setter(hydrateViewportSizeProjectionAtom, {
      source,
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })
    expect(reads.map(({ request }) => request.requestId)).toEqual([1, 2])

    reads[1].operation.resolve(
      matchingViewportMetadataProjection(reads[1].request, {
        revision: 2,
        rowHeights: [{ rowIndex: 4, heightPx: 42 }],
      }),
    )
    await expect(second).resolves.toBe('ready')
    reads[0].operation.resolve(
      matchingViewportMetadataProjection(reads[0].request, {
        revision: 1,
        rowHeights: [{ rowIndex: 4, heightPx: 41 }],
      }),
    )
    await expect(first).resolves.toBe('stale')
    expect(store.getter(viewportSizeOverridesAtom).rowHeightsBySheet['A']).toEqual({ '4': 42 })
  })

  test('blocks hydration behind a mutation without cancelling or overwriting that mutation lane', async () => {
    const store = createStore()
    const acknowledgement = deferred<BackendMutationResult>()
    let mutationRequest: HideRowsRequest | undefined
    let readCalls = 0
    const source: ViewportHiddenControllerPort = {
      hideRows(request) {
        mutationRequest = request
        return acknowledgement.promise
      },
      async readViewportSizeProjection(request) {
        readCalls += 1
        return matchingHiddenProjection(request, [3], [])
      },
    }
    const mutation = store.setter(runViewportHiddenMutationAtom, {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
    })

    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('blocked')
    expect(readCalls).toBe(0)
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('pending')
    acknowledgement.resolve({
      sheetId: 'A',
      requestId: mutationRequest!.requestId,
      revision: 7,
    })
    await expect(mutation).resolves.toBe('ready')
  })

  test('lets a valid mutation supersede an active hydration with zero stale hydrate write', async () => {
    const store = createStore()
    const hydrationRead = deferred<ViewportSizeProjectionResult>()
    const acknowledgement = deferred<BackendMutationResult>()
    let hydrationRequest: ViewportSizeProjectionRequest | undefined
    let mutationRequest: HideRowsRequest | undefined
    let readCalls = 0
    const source: ViewportHiddenControllerPort = {
      readViewportSizeProjection(request) {
        readCalls += 1
        if (readCalls === 1) {
          hydrationRequest = request
          return hydrationRead.promise
        }
        return Promise.resolve(matchingHiddenProjection(request, [3], []))
      },
      hideRows(request) {
        mutationRequest = request
        return acknowledgement.promise
      },
    }
    const hydration = store.setter(hydrateViewportSizeProjectionAtom, {
      source,
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })
    const mutation = store.setter(runViewportHiddenMutationAtom, {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
    })

    hydrationRead.resolve(
      matchingViewportMetadataProjection(hydrationRequest!, {
        rowHeights: [{ rowIndex: 4, heightPx: 44 }],
        hiddenRowIndices: [5],
      }),
    )
    await expect(hydration).resolves.toBe('stale')
    expect(store.getter(viewportSizeOverridesAtom)).toEqual({
      rowHeightsBySheet: {},
      colWidthsBySheet: {},
    })
    acknowledgement.resolve({
      sheetId: 'A',
      requestId: mutationRequest!.requestId,
      revision: 8,
    })
    await expect(mutation).resolves.toBe('ready')
  })

  test('does not let an invalid mutation cancel an active hydration', async () => {
    const store = createStore()
    const read = deferred<ViewportSizeProjectionResult>()
    let request: ViewportSizeProjectionRequest | undefined
    const source: ViewportHiddenControllerPort = {
      readViewportSizeProjection(input) {
        request = input
        return read.promise
      },
      async hideRows(input) {
        return matchingHiddenAcknowledgement(input)
      },
    }
    const hydration = store.setter(hydrateViewportSizeProjectionAtom, {
      source,
      sheetId: 'A',
      window: HIDDEN_WINDOW,
    })

    await expect(
      store.setter(runViewportHiddenMutationAtom, {
        source,
        sheetId: 'A',
        action: 'hide-rows',
        indices: [],
        window: HIDDEN_WINDOW,
      }),
    ).resolves.toBe('blocked')
    read.resolve(matchingViewportMetadataProjection(request!))
    await expect(hydration).resolves.toBe('ready')
  })

  test.each(['hidden', 'row-height', 'column-width'] as const)(
    'rejects %s ABA changes while hydration is in flight',
    async (axis) => {
      const store = createStore()
      store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 4, heightPx: 24 })
      store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 3, widthPx: 80 })
      store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [4], cols: [3] })
      const sizeBefore = store.getter(viewportSizeOverridesAtom)
      const hiddenBefore = store.getter(viewportHiddenAtom)
      const read = deferred<ViewportSizeProjectionResult>()
      let request: ViewportSizeProjectionRequest | undefined
      const source: ViewportHiddenControllerPort = {
        readViewportSizeProjection(input) {
          request = input
          return read.promise
        },
      }
      const hydration = store.setter(hydrateViewportSizeProjectionAtom, {
        source,
        sheetId: 'A',
        window: HIDDEN_WINDOW,
      })

      if (axis === 'hidden') {
        store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [5], cols: [3] })
        store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [4], cols: [3] })
      } else if (axis === 'row-height') {
        store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 4, heightPx: 25 })
        store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 4, heightPx: 24 })
      } else {
        store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 3, widthPx: 81 })
        store.setter(setViewportColumnWidthAtom, { sheetId: 'A', colIndex: 3, widthPx: 80 })
      }
      read.resolve(
        matchingViewportMetadataProjection(request!, {
          rowHeights: [{ rowIndex: 4, heightPx: 44 }],
          colWidths: [{ colIndex: 3, widthPx: 144 }],
          hiddenRowIndices: [5],
          hiddenColIndices: [4],
        }),
      )

      await expect(hydration).resolves.toBe('stale')
      expect(store.getter(viewportSizeOverridesAtom)).toEqual(sizeBefore)
      expect(store.getter(viewportHiddenAtom)).toEqual(hiddenBefore)
    },
  )

  test('does not let an unrelated size setter force hidden mutation recovery', async () => {
    const store = createStore()
    const readback = deferred<ViewportSizeProjectionResult>()
    let readRequest: ViewportSizeProjectionRequest | undefined
    const source: ViewportHiddenControllerPort = {
      async hideRows(request) {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 7 }
      },
      readViewportSizeProjection(request) {
        readRequest = request
        return readback.promise
      },
    }
    const mutation = store.setter(runViewportHiddenMutationAtom, {
      source,
      sheetId: 'A',
      action: 'hide-rows',
      indices: [3],
      window: HIDDEN_WINDOW,
    })
    await Promise.resolve()
    expect(readRequest).toBeDefined()

    store.setter(setViewportRowHeightAtom, { sheetId: 'A', rowIndex: 4, heightPx: 44 })
    readback.resolve(matchingHiddenProjection(readRequest!, [3], []))
    await expect(mutation).resolves.toBe('ready')
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('ready')
  })

  test('never sends a cached hidden revision on a later refresh hydration', async () => {
    const store = createStore()
    const requests: ViewportSizeProjectionRequest[] = []
    const source: ViewportHiddenControllerPort = {
      async readViewportSizeProjection(request) {
        requests.push(request)
        return matchingViewportMetadataProjection(request, { revision: requests.length })
      },
    }
    const input = { source, sheetId: 'A', window: HIDDEN_WINDOW }

    await expect(store.setter(hydrateViewportSizeProjectionAtom, input)).resolves.toBe('ready')
    await expect(store.setter(hydrateViewportSizeProjectionAtom, input)).resolves.toBe('ready')
    expect(requests).toHaveLength(2)
    expect(requests[1]).not.toHaveProperty('revision')
  })
})

describe('isRowHidden / isColumnHidden', () => {
  test('isRowHidden returns true for a hidden row', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(isRowHidden(state, 'A', 3)).toBe(true)
    expect(isRowHidden(state, 'A', 4)).toBe(false)
  })

  test('isRowHidden returns false for unknown sheet', () => {
    expect(isRowHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })

  test('isColumnHidden is symmetric', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2, 7] })
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
    store.setter(setViewportHiddenAtom, { sheetId: 'S', rows: [9, 2, 4], cols: [5, 1] })
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
