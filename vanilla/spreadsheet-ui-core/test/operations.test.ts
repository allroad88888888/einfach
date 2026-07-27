import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type {
  BackendMutationResult,
  StructureOperationControllerPort,
  StructureOperationRequest,
} from '../src'
import {
  acquireHistoryProducerReservationAtom,
  historyStackAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
} from '../src/history'
import { setFreezeConfigAtom, viewportFreezeAtom } from '../src/viewport/freeze'
import { hideRowsAtom, viewportHiddenAtom } from '../src/viewport/hidden'
import {
  getFilterHiddenRowsForSheet,
  setViewportFilterHiddenRowsAtom,
  viewportFilterHiddenAtom,
} from '../src/viewport/effective-hidden'
import {
  createAddSheetOperation,
  createDeleteColumnsOperation,
  createDeleteRowsOperation,
  createDeleteSheetOperation,
  createInsertColumnsOperation,
  createInsertRowsOperation,
  createRenameSheetOperation,
  createReorderSheetOperation,
  createSetCellOperation,
  getOperationCellRange,
  isSheetMutationOperation,
  nextStructureOperationRequestId,
  planFilterVisibleRowDeletions,
  resetStructureOperationLifecycleAtom,
  runFilterVisibleRowDeleteAtom,
  retryStructureOperationRefreshAtom,
  runStructureOperationAtom,
  structureOperationCanRetryRefreshAtom,
  structureOperationLifecycleAtom,
} from '../src/operations'

function expectHistoryProducerLaneAvailable(store: ReturnType<typeof createStore>): void {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation === null) throw new Error('expected the history producer lane to be available')
  expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
}

describe('operations core', () => {
  test('creates normalized intents for the common spreadsheet mutations', () => {
    expect(
      createSetCellOperation({
        sheetId: 'sheet-1',
        row: 3,
        col: 4,
        input: '=A1+1',
      }),
    ).toEqual({
      kind: 'cell.set-input',
      sheetId: 'sheet-1',
      row: 3,
      col: 4,
      input: '=A1+1',
      source: undefined,
      requestId: undefined,
      revision: undefined,
    })

    expect(
      createInsertRowsOperation({
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
      }),
    ).toMatchObject({
      kind: 'row.insert',
      sheetId: 'sheet-1',
      rowIndex: 2,
      count: 3,
    })

    expect(
      createDeleteColumnsOperation({
        sheetId: 'sheet-1',
        colIndex: 1,
        count: 2,
      }),
    ).toMatchObject({
      kind: 'column.delete',
      sheetId: 'sheet-1',
      colIndex: 1,
      count: 2,
    })

    expect(
      createRenameSheetOperation({
        sheetId: 'sheet-1',
        sheetName: '  Summary  ',
      }),
    ).toEqual({
      kind: 'sheet.rename',
      sheetId: 'sheet-1',
      sheetName: 'Summary',
      source: undefined,
      requestId: undefined,
      revision: undefined,
    })
  })

  test('guards invalid counts and missing reorder placement hints', () => {
    expect(() =>
      createSetCellOperation({
        sheetId: 'sheet-1',
        row: 1.5,
        col: 4,
        input: 'x',
      }),
    ).toThrow(RangeError)

    expect(() =>
      createInsertRowsOperation({
        sheetId: 'sheet-1',
        rowIndex: 0,
        count: 0,
      }),
    ).toThrow(RangeError)

    expect(() =>
      createDeleteColumnsOperation({
        sheetId: 'sheet-1',
        colIndex: -1,
        count: 1,
      }),
    ).toThrow(RangeError)

    expect(() =>
      createAddSheetOperation({
        sheetName: '   ',
      }),
    ).toThrow(RangeError)

    expect(() =>
      createReorderSheetOperation({
        sheetId: 'sheet-1',
      }),
    ).toThrow(RangeError)

    expect(
      isSheetMutationOperation(
        createDeleteSheetOperation({
          sheetId: 'sheet-1',
        }),
      ),
    ).toBe(true)

    expect(
      getOperationCellRange(
        createInsertColumnsOperation({
          sheetId: 'sheet-1',
          colIndex: 4,
          count: 2,
        }),
      ),
    ).toBeNull()
  })

  test('owns all four structural mutations, strict acknowledgements, history, and refresh', async () => {
    const store = createStore()
    const requests: StructureOperationRequest[] = []
    let revision = 40
    const acknowledge = (request: StructureOperationRequest): BackendMutationResult => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: ++revision,
    })
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        requests.push(request as StructureOperationRequest)
        return acknowledge(request as StructureOperationRequest)
      },
      async deleteRows(request) {
        requests.push(request as StructureOperationRequest)
        return acknowledge(request as StructureOperationRequest)
      },
      async insertColumns(request) {
        requests.push(request as StructureOperationRequest)
        return acknowledge(request as StructureOperationRequest)
      },
      async deleteColumns(request) {
        requests.push(request as StructureOperationRequest)
        return acknowledge(request as StructureOperationRequest)
      },
    }
    const refreshedSheets: string[] = []
    const refreshProjection = async (sheetId: string) => {
      refreshedSheets.push(sheetId)
    }
    const intents = [
      createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 2, count: 3 }),
      createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 4, count: 1 }),
      createInsertColumnsOperation({ sheetId: 'sheet-1', colIndex: 5, count: 2 }),
      createDeleteColumnsOperation({ sheetId: 'sheet-1', colIndex: 1, count: 1 }),
    ]

    for (const intent of intents) {
      await expect(
        store.setter(runStructureOperationAtom, { intent, source, refreshProjection }),
      ).resolves.toBe('completed')
    }

    expect(requests).toEqual([
      {
        kind: 'insert-rows',
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
        requestId: 1,
        revision: undefined,
      },
      {
        kind: 'delete-rows',
        sheetId: 'sheet-1',
        rowIndex: 4,
        count: 1,
        requestId: 2,
        revision: undefined,
      },
      {
        kind: 'insert-columns',
        sheetId: 'sheet-1',
        colIndex: 5,
        count: 2,
        requestId: 3,
        revision: undefined,
      },
      {
        kind: 'delete-columns',
        sheetId: 'sheet-1',
        colIndex: 1,
        count: 1,
        requestId: 4,
        revision: undefined,
      },
    ])
    expect(refreshedSheets).toEqual(['sheet-1', 'sheet-1', 'sheet-1', 'sheet-1'])
    expect(store.getter(historyStackAtom).entries).toHaveLength(4)
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.kind)).toEqual(
      intents.map((intent) => intent.kind),
    )
    expect(
      new Set(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).size,
    ).toBe(4)
    expectHistoryProducerLaneAvailable(store)
    expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
      status: 'completed',
      operation: 'column.delete',
      sheetId: 'sheet-1',
      requestId: 4,
      acknowledgedRevision: 44,
      error: '',
    })
  })

  test('rejects invalid intents and reports missing capability as unsupported', async () => {
    const store = createStore()
    const refreshProjection = async () => undefined

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: {
          kind: 'row.insert',
          sheetId: 'sheet-1',
          rowIndex: -1,
          count: 1,
        } as never,
        source: {},
        refreshProjection,
      }),
    ).resolves.toBe('rejected')
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('rejected')

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createDeleteColumnsOperation({
          sheetId: 'sheet-1',
          colIndex: 1,
          count: 1,
        }),
        source: {},
        refreshProjection,
      }),
    ).resolves.toBe('unsupported')
    expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
      status: 'unsupported',
      operation: 'column.delete',
      requestId: null,
    })
    expect(store.getter(historyStackAtom).entries).toEqual([])
  })

  test(
    'validates before acquisition and launches zero transport when another producer owns history',
    async () => {
    const store = createStore()
    const foreignStore = createStore()
    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    const foreignReservation = foreignStore.setter(acquireHistoryProducerReservationAtom)
    if (reservation === null || foreignReservation === null) {
      throw new Error('expected both isolated stores to acquire their producer lane')
    }
    let mutationCount = 0
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        mutationCount += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
        }
      },
    }

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: {
          kind: 'row.insert',
          sheetId: 'sheet-1',
          rowIndex: -1,
          count: 1,
        } as never,
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('rejected')
    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertRowsOperation({
          sheetId: 'sheet-1',
          rowIndex: 0,
          count: 1,
        }),
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('stale')

    expect(mutationCount).toBe(0)
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(store.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(false)
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(false)
    expect(store.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(false)
    expect(foreignStore.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(
      true,
    )
    expectHistoryProducerLaneAvailable(store)
  })

  test.each([
    ['transport rejection', new Error('connection reset')],
    ['missing request id', { sheetId: 'sheet-1', revision: 3 }],
    ['wrong request id', { sheetId: 'sheet-1', requestId: 99, revision: 3 }],
    ['missing revision', { sheetId: 'sheet-1', requestId: 1 }],
    ['wrong sheet', { sheetId: 'sheet-2', requestId: 1, revision: 3 }],
    [
      'malformed affected range',
      {
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 3,
        affectedRange: { rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 0 },
      },
    ],
    [
      'malformed structural shift',
      {
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 3,
        structuralShift: { axis: 'row', kind: 'insert', index: -1, count: 1 } as const,
      },
    ],
  ])('keeps %s terminal as outcome-unknown without refresh or history', async (_label, result) => {
    const store = createStore()
    let mutationCount = 0
    let refreshCount = 0
    const source: StructureOperationControllerPort = {
      async insertRows() {
        mutationCount += 1
        if (result instanceof Error) throw result
        return result
      },
    }
    const input = {
      intent: createInsertRowsOperation({
        sheetId: 'sheet-1',
        rowIndex: 0,
        count: 1,
      }),
      source,
      refreshProjection: async () => {
        refreshCount += 1
      },
    }

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('outcome-unknown')

    expect(store.getter(structureOperationLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(mutationCount).toBe(1)
    expect(refreshCount).toBe(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    expectHistoryProducerLaneAvailable(store)
  })

  test('snapshots every top-level and nested ACK getter exactly once', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    const historyEntriesBefore = store.getter(historyStackAtom).entries.length
    const reads = {
      sheetId: 0,
      requestId: 0,
      revision: 0,
      affectedRange: 0,
      structuralShift: 0,
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 0,
      axis: 0,
      kind: 0,
      index: 0,
      count: 0,
    }
    type GetterField = keyof typeof reads
    const statefulValue = <T>(field: GetterField, first: T, later: T): T => {
      reads[field] += 1
      return reads[field] === 1 ? first : later
    }
    let refreshCount = 0
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        const affectedRange = {
          get rowStart() {
            return statefulValue('rowStart', 1, -1)
          },
          get rowEnd() {
            return statefulValue('rowEnd', 3, -1)
          },
          get colStart() {
            return statefulValue('colStart', 2, -1)
          },
          get colEnd() {
            return statefulValue('colEnd', 4, -1)
          },
        }
        const structuralShift = {
          get axis() {
            return statefulValue('axis', 'row', 'invalid-axis')
          },
          get kind() {
            return statefulValue('kind', 'insert', 'invalid-kind')
          },
          get index() {
            return statefulValue('index', 1, -1)
          },
          get count() {
            return statefulValue('count', 1, 0)
          },
        }
        return {
          get sheetId() {
            return statefulValue('sheetId', request.sheetId, 'wrong-sheet')
          },
          get requestId() {
            return statefulValue('requestId', request.requestId, -999)
          },
          get revision() {
            return statefulValue('revision', 7, Number.NaN)
          },
          get affectedRange() {
            return statefulValue('affectedRange', affectedRange, null)
          },
          get structuralShift() {
            return statefulValue('structuralShift', structuralShift, null)
          },
        } as unknown as BackendMutationResult
      },
    }

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 1, count: 1 }),
        source,
        refreshProjection: async () => {
          refreshCount += 1
        },
      }),
    ).resolves.toBe('completed')

    expect(reads).toEqual({
      sheetId: 1,
      requestId: 1,
      revision: 1,
      affectedRange: 1,
      structuralShift: 1,
      rowStart: 1,
      rowEnd: 1,
      colStart: 1,
      colEnd: 1,
      axis: 1,
      kind: 1,
      index: 1,
      count: 1,
    })
    expect(refreshCount).toBe(1)
    expect(store.getter(structureOperationLifecycleAtom).acknowledgedRevision).toBe(7)
    const historyEntries = store.getter(historyStackAtom).entries
    expect(historyEntries).toHaveLength(historyEntriesBefore + 1)
    expect(historyEntries[historyEntries.length - 1]).toMatchObject({
      projectionRevision: 7,
      affectedRange: { rowStart: 1, rowEnd: 3, colStart: 2, colEnd: 4 },
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([3])
    expectHistoryProducerLaneAvailable(store)
  })

  test.each(['revision', 'affectedRange.rowEnd', 'structuralShift.count'] as const)(
    'fails closed when the %s ACK getter throws',
    async (throwingField) => {
      const store = createStore()
      let refreshCount = 0
      const source: StructureOperationControllerPort = {
        async insertRows(request) {
          const affectedRange = {
            rowStart: 0,
            get rowEnd() {
              if (throwingField === 'affectedRange.rowEnd') {
                throw new Error('affected range getter failed')
              }
              return 0
            },
            colStart: 0,
            colEnd: 0,
          }
          const structuralShift = {
            axis: 'row' as const,
            kind: 'insert' as const,
            index: 0,
            get count() {
              if (throwingField === 'structuralShift.count') {
                throw new Error('structural shift getter failed')
              }
              return 1
            },
          }
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            get revision() {
              if (throwingField === 'revision') {
                throw new Error('revision getter failed')
              }
              return 8
            },
            affectedRange,
            structuralShift,
          }
        },
      }

      await expect(
        store.setter(runStructureOperationAtom, {
          intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 1 }),
          source,
          refreshProjection: async () => {
            refreshCount += 1
          },
        }),
      ).resolves.toBe('outcome-unknown')

      expect(store.getter(structureOperationLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(historyStackAtom).entries).toEqual([])
      expect(refreshCount).toBe(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
      expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
      expectHistoryProducerLaneAvailable(store)
    },
  )

  test('retains the ticket and reservation when an exact ACK cannot enter history', async () => {
    const store = createStore()
    let mutationCount = 0
    let refreshCount = 0
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        mutationCount += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'revision-history-rejected',
        }
      },
    }
    const input = {
      intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 1 }),
      source,
      refreshProjection: async () => {
        refreshCount += 1
      },
    }
    const pushReservedHistoryWrite = pushReservedHistoryAtom.write
    pushReservedHistoryAtom.write = () => false
    try {
      await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('outcome-unknown')
    } finally {
      pushReservedHistoryAtom.write = pushReservedHistoryWrite
    }

    expect(mutationCount).toBe(1)
    expect(refreshCount).toBe(0)
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedRevision: 'revision-history-rejected',
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    expectHistoryProducerLaneAvailable(store)
  })

  test('records history once and retries only refresh after an exact acknowledgement', async () => {
    const store = createStore()
    let mutationCount = 0
    let refreshCount = 0
    const source: StructureOperationControllerPort = {
      async deleteRows(request) {
        mutationCount += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'revision-2',
        }
      },
    }

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 7, count: 2 }),
        source,
        refreshProjection: async () => {
          refreshCount += 1
          throw new Error('projection offline')
        },
      }),
    ).resolves.toBe('refresh-failed')

    expect(mutationCount).toBe(1)
    expect(refreshCount).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(structureOperationCanRetryRefreshAtom)).toBe(true)
    expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
      status: 'refresh-failed',
      acknowledgedRevision: 'revision-2',
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 7, count: 2 }),
        source,
        refreshProjection: async () => {
          refreshCount += 1
        },
      }),
    ).resolves.toBe('stale')
    expect(mutationCount).toBe(1)
    expect(refreshCount).toBe(1)

    await expect(
      store.setter(retryStructureOperationRefreshAtom, {
        refreshProjection: async (sheetId) => {
          expect(sheetId).toBe('sheet-1')
          refreshCount += 1
        },
      }),
    ).resolves.toBe('completed')

    expect(mutationCount).toBe(1)
    expect(refreshCount).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(structureOperationCanRetryRefreshAtom)).toBe(false)
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('completed')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'fails reset closed while transport is pending and releases only after it settles',
    async () => {
    const store = createStore()
    let capturedRequest: StructureOperationRequest | null = null
    let rejectMutation!: (reason?: unknown) => void
    let mutationCount = 0
    const source: StructureOperationControllerPort = {
      insertColumns(request) {
        mutationCount += 1
        if (mutationCount === 1) {
          capturedRequest = request as StructureOperationRequest
          return new Promise((_resolve, reject) => {
            rejectMutation = reject
          })
        }
        return Promise.resolve({
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 9,
        })
      },
    }
    let refreshCount = 0
    const input = {
      intent: createInsertColumnsOperation({ sheetId: 'sheet-1', colIndex: 3, count: 1 }),
      source,
      refreshProjection: async () => {
        refreshCount += 1
      },
    }
    const run = store.setter(runStructureOperationAtom, input)

    await Promise.resolve()
    await Promise.resolve()
    expect(capturedRequest).not.toBeNull()
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)

    rejectMutation(new Error('late transport rejection'))

    await expect(run).resolves.toBe('outcome-unknown')
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(refreshCount).toBe(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('stale')
    expectHistoryProducerLaneAvailable(store)

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('completed')
    expect(mutationCount).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(refreshCount).toBe(1)
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'keeps the mutation lane reserved after timeout until transport settles and reset succeeds',
    async () => {
    const store = createStore()
    let capturedRequest: StructureOperationRequest | null = null
    let resolveMutation!: (result: BackendMutationResult) => void
    let mutationCount = 0
    const source: StructureOperationControllerPort = {
      insertRows(request) {
        mutationCount += 1
        if (mutationCount === 1) {
          capturedRequest = request as StructureOperationRequest
          return new Promise((resolve) => {
            resolveMutation = resolve
          })
        }
        return Promise.resolve({
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 12,
        })
      },
    }
    let refreshCount = 0
    const input = {
      intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 2, count: 1 }),
      source,
      refreshProjection: async () => {
        refreshCount += 1
      },
      timeoutMs: 1,
    }

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('outcome-unknown')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)

    resolveMutation({
      sheetId: 'sheet-1',
      requestId: capturedRequest!.requestId,
      revision: 11,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    expectHistoryProducerLaneAvailable(store)

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('completed')
    expect(mutationCount).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(refreshCount).toBe(1)
    expectHistoryProducerLaneAvailable(store)
  })

  test('reserves the pending ticket before transport so same-tick re-entry is stale', async () => {
    const store = createStore()
    let capturedRequest: StructureOperationRequest | null = null
    let resolveMutation!: (result: BackendMutationResult) => void
    let mutationCount = 0
    const source: StructureOperationControllerPort = {
      insertRows(request) {
        mutationCount += 1
        capturedRequest = request as StructureOperationRequest
        return new Promise((resolve) => {
          resolveMutation = resolve
        })
      },
    }
    const input = {
      intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 1, count: 1 }),
      source,
      refreshProjection: async () => undefined,
    }

    const first = store.setter(runStructureOperationAtom, input)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    await Promise.resolve()
    await Promise.resolve()
    resolveMutation({
      sheetId: 'sheet-1',
      requestId: capturedRequest!.requestId,
      revision: 2,
    })

    await expect(first).resolves.toBe('completed')
    expect(mutationCount).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expectHistoryProducerLaneAvailable(store)
  })

  test('allocates safe request ids across rollover and stops at exhaustion', () => {
    expect(nextStructureOperationRequestId(0)).toBe(1)
    expect(nextStructureOperationRequestId(Number.MAX_SAFE_INTEGER)).toBe(-1)
    expect(nextStructureOperationRequestId(-1)).toBe(-2)
    expect(nextStructureOperationRequestId(Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(nextStructureOperationRequestId(Number.NaN)).toBeNull()
  })
})

describe('structural shift → local view facts + history side payloads', () => {
  interface ShiftSpec {
    axis: 'row' | 'column'
    kind: 'insert' | 'delete'
    index: number
    count: number
  }

  async function runShiftedOperation(
    store: ReturnType<typeof createStore>,
    intent:
      | ReturnType<typeof createDeleteRowsOperation>
      | ReturnType<typeof createInsertRowsOperation>,
    shift: ShiftSpec,
  ) {
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 90,
          structuralShift: shift,
        }
      },
      async deleteRows(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 91,
          structuralShift: shift,
        }
      },
    }
    await expect(
      store.setter(runStructureOperationAtom, {
        intent,
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
  }

  test('delete rows drops hidden membership, remaps freeze, records payloads', async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 4, cols: 1 })
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2, 6] })
    const entriesBefore = store.getter(historyStackAtom).entries.length

    await runShiftedOperation(
      store,
      createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 2, count: 2 }),
      { axis: 'row', kind: 'delete', index: 2, count: 2 },
    )

    // Hidden row 2 died with the deleted band; row 6 shifted to 4.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([4])
    // Freeze band shrank by the in-band overlap.
    expect(store.getter(viewportFreezeAtom).rowsBySheet['sheet-1']).toBe(2)

    const entries = store.getter(historyStackAtom).entries
    expect(entries).toHaveLength(entriesBefore + 1)
    const entry = entries[entries.length - 1]!
    expect(entry.localReplay).toBeUndefined()
    expect(entry.localSidePayloads).toHaveLength(2)
    expect(entry.localSidePayloads?.[0]).toMatchObject({
      applyKey: 'viewport.freeze',
      sheetId: 'sheet-1',
      before: { rows: 4, cols: 1 },
      after: { rows: 2, cols: 1 },
    })
    expect(entry.localSidePayloads?.[1]).toMatchObject({
      applyKey: 'viewport.hidden',
      sheetId: 'sheet-1',
      before: { rows: [2, 6], cols: [] },
      after: { rows: [4], cols: [] },
    })
  })

  test('a shift that moves nothing records no side payloads', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [1] })
    await runShiftedOperation(
      store,
      createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 5, count: 1 }),
      { axis: 'row', kind: 'insert', index: 5, count: 1 },
    )
    const entries = store.getter(historyStackAtom).entries
    expect(entries[entries.length - 1]?.localSidePayloads).toBeUndefined()
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([1])
  })

  test('an acknowledgement without structuralShift leaves local view facts untouched', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3] })
    const source: StructureOperationControllerPort = {
      async insertRows(request) {
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 5 }
      },
    }
    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 1 }),
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([3])
    const entries = store.getter(historyStackAtom).entries
    expect(entries[entries.length - 1]?.localSidePayloads).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // S5a — the FILTER-hidden set takes the same displacement as the manual one.
  // -------------------------------------------------------------------------

  function filterRowsOf(store: ReturnType<typeof createStore>, sheetId = 'sheet-1'): number[] {
    return getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), sheetId)
  }

  test('COUNTER-EXAMPLE: an unwired filter applier leaves the set one band off', async () => {
    // The exact pre-S5a state: only the manual applier is wired, so an insert
    // above an active filter leaves every filter index stale. Driven through
    // the real structural operation, seeding ONLY the manual set — which is
    // what the code did before this slice, and what the assertion below is
    // measured against.
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    const staleFilterRows = [1]

    await runShiftedOperation(
      store,
      createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 1 }),
      { axis: 'row', kind: 'insert', index: 0, count: 1 },
    )

    // Manual moved. An unshifted filter set would now hide row 1 — the header
    // that just slid down into it — while row 2, the row the filter actually
    // removed, would be painted again.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([3])
    expect(staleFilterRows).not.toEqual([2])
    expect(staleFilterRows).toContain(1)
  })

  test('insert above an active filter shifts the set but records NO filter payload (E8)', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [1] })

    await runShiftedOperation(
      store,
      createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 1 }),
      { axis: 'row', kind: 'insert', index: 0, count: 1 },
    )

    // The optimistic forward shift still keeps the render cache in step the same
    // tick the engine self-shifts its owned filter.
    expect(filterRowsOf(store)).toEqual([2])
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([3])

    // Since E8 the FILTER-hidden set carries no history side payload: the engine
    // owns the filter and its `restoreFilters` snapshot restores it on undo,
    // after which the provider re-hydrates this cache from the engine. Only the
    // manual `viewport.hidden` payload rides the entry now.
    const entries = store.getter(historyStackAtom).entries
    const payloads = entries[entries.length - 1]!.localSidePayloads!
    expect(payloads.map((payload) => payload.applyKey)).toEqual(['viewport.hidden'])
    expect(payloads.some((payload) => payload.applyKey === 'viewport.filterHidden')).toBe(false)
  })

  test('a delete band consuming filter-hidden rows drops them from the set', async () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 3, 7] })

    await runShiftedOperation(
      store,
      createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 2, count: 2 }),
      { axis: 'row', kind: 'delete', index: 2, count: 2 },
    )

    // 2 and 3 died with the band; 7 moved back two.
    expect(filterRowsOf(store)).toEqual([5])
  })

  test('a COLUMN shift leaves the filter set alone and records no filter payload', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [2] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [1, 4] })

    const source: StructureOperationControllerPort = {
      async insertColumns(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 92,
          structuralShift: { axis: 'column', kind: 'insert', index: 0, count: 2 },
        }
      },
    }
    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertColumnsOperation({ sheetId: 'sheet-1', colIndex: 0, count: 2 }),
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')

    expect(filterRowsOf(store)).toEqual([1, 4])
    const entries = store.getter(historyStackAtom).entries
    const payloads = entries[entries.length - 1]?.localSidePayloads ?? []
    expect(payloads.some((payload) => payload.applyKey === 'viewport.filterHidden')).toBe(false)
  })

  test('a structural op on one sheet never displaces another sheet filter set', async () => {
    const store = createStore()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 5] })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-2', rows: [2, 5] })

    await runShiftedOperation(
      store,
      createInsertRowsOperation({ sheetId: 'sheet-1', rowIndex: 0, count: 3 }),
      { axis: 'row', kind: 'insert', index: 0, count: 3 },
    )

    expect(filterRowsOf(store, 'sheet-1')).toEqual([5, 8])
    expect(filterRowsOf(store, 'sheet-2')).toEqual([2, 5])
  })

  // REMOVED at E8: "undo/redo of the structural entry round-trips the filter
  // set exactly" asserted the FILTER-hidden set was restored by a UI-core
  // history LOCAL-REPLAY side payload — the mechanism E8 deleted. The engine
  // now owns the filter and restores it from its own `restoreFilters` snapshot
  // (worker) / full-sheet capture (static) on the backend transaction, after
  // which the provider re-hydrates `viewportFilterHiddenAtom` from the engine
  // (`readSheetHiddenState.filterRows`). That backend-owned round-trip — the
  // delete-band-has-no-inverse case included — is covered by the adapter suites
  // (vnext-structural-remap-static, vnext-worker-undo-wasm) and the #27
  // real-backend e2e, not by a bare UI-core harness that has no engine to read.
})

// ---------------------------------------------------------------------------
// §8.3 — deleting a row span skips FILTER-hidden rows
//
// See solid/excel/docs/online-excel-parity/design-filter-hidden-rows.md §8.3.
// Excel deletes only the visible rows of a selection spanning a filtered
// region; manually hidden rows inside the span are deleted normally. The
// COUNTER-EXAMPLE tests drive the unguarded single-span delete and assert the
// data loss it causes before showing the planner removing it.
// ---------------------------------------------------------------------------

describe('operations / delete rows over a filtered region (§8.3)', () => {
  function deleteRowsHarness() {
    const requests: StructureOperationRequest[] = []
    let revision = 100
    const source: StructureOperationControllerPort = {
      async deleteRows(request) {
        requests.push(request as StructureOperationRequest)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: ++revision,
        } satisfies BackendMutationResult
      },
    }
    const refreshedSheets: string[] = []
    const refreshProjection = async (sheetId: string) => {
      refreshedSheets.push(sheetId)
    }
    return { requests, source, refreshProjection, refreshedSheets }
  }

  test('COUNTER-EXAMPLE: the unguarded single-span delete destroys filtered-out rows', async () => {
    // User sees rows 2 and 6 and drags across them. Rows 3, 4, 5 are
    // filter-hidden and hold data the user cannot see.
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createDeleteRowsOperation({ sheetId: 'sheet-1', rowIndex: 2, count: 5 }),
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    // One span covering 2..6 — the three invisible rows go with it.
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ kind: 'delete-rows', rowIndex: 2, count: 5 })
  })

  test('the guarded command deletes only the visible rows, highest run first', async () => {
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [3, 4, 5] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 5,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    // Rows 3, 4, 5 survive; 6 is deleted before 2 so 2 keeps its index.
    expect(
      requests.map((request) => ({
        rowIndex: (request as { rowIndex: number }).rowIndex,
        count: (request as { count: number }).count,
      })),
    ).toEqual([
      { rowIndex: 6, count: 1 },
      { rowIndex: 2, count: 1 },
    ])
  })

  test('planner returns the span verbatim when nothing is filter-hidden', () => {
    expect(planFilterVisibleRowDeletions({ rowIndex: 4, count: 3 })).toEqual([
      { rowIndex: 4, count: 3 },
    ])
    expect(planFilterVisibleRowDeletions({ rowIndex: 4, count: 3, filterHiddenRows: [] })).toEqual([
      { rowIndex: 4, count: 3 },
    ])
    expect(
      planFilterVisibleRowDeletions({ rowIndex: 4, count: 3, filterHiddenRows: [99] }),
    ).toEqual([{ rowIndex: 4, count: 3 }])
  })

  test('planner coalesces adjacent visible rows into maximal runs, descending', () => {
    // Span 0..9, hidden {2,3,7}. Visible runs ascending: 0-1, 4-6, 8-9.
    expect(
      planFilterVisibleRowDeletions({ rowIndex: 0, count: 10, filterHiddenRows: [2, 3, 7] }),
    ).toEqual([
      { rowIndex: 8, count: 2 },
      { rowIndex: 4, count: 3 },
      { rowIndex: 0, count: 2 },
    ])
  })

  test('planner descending order is what keeps later runs addressable', () => {
    const runs = planFilterVisibleRowDeletions({
      rowIndex: 0,
      count: 10,
      filterHiddenRows: [2, 3, 7],
    })
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i].rowIndex + runs[i].count).toBeLessThanOrEqual(runs[i - 1].rowIndex)
    }
  })

  test('planner handles hidden rows at both edges of the span', () => {
    expect(
      planFilterVisibleRowDeletions({ rowIndex: 5, count: 4, filterHiddenRows: [5, 8] }),
    ).toEqual([{ rowIndex: 6, count: 2 }])
  })

  test('planner returns nothing when every row in the span is filter-hidden', () => {
    expect(
      planFilterVisibleRowDeletions({ rowIndex: 2, count: 3, filterHiddenRows: [2, 3, 4] }),
    ).toEqual([])
  })

  test('planner rejects malformed spans instead of guessing', () => {
    expect(planFilterVisibleRowDeletions({ rowIndex: 0, count: 0 })).toEqual([])
    expect(planFilterVisibleRowDeletions({ rowIndex: -1, count: 2 })).toEqual([])
    expect(planFilterVisibleRowDeletions({ rowIndex: 1.5, count: 2 })).toEqual([])
    expect(planFilterVisibleRowDeletions({ rowIndex: 0, count: 2.5 })).toEqual([])
  })

  test('an entirely filter-hidden selection launches ZERO transport', async () => {
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 3, 4] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('no-visible-rows')
    // The one thing that must never happen: falling back to the raw span.
    expect(requests).toEqual([])
  })

  test('MANUALLY hidden rows are deleted along with the visible ones', async () => {
    // Excel parity pin (§8.3 / §8.1 adjudication 2): only the FILTER set is
    // subtracted. `hideRowsAtom` must not shrink the deletion.
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3, 4] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 5,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ rowIndex: 2, count: 5 })
  })

  test('with no filter the guarded command is identical to the raw structure op', async () => {
    const store = createStore()
    const { requests, source, refreshProjection, refreshedSheets } = deleteRowsHarness()

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 4,
        count: 2,
        operationSource: 'selection',
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ kind: 'delete-rows', rowIndex: 4, count: 2 })
    expect(refreshedSheets).toEqual(['sheet-1'])
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('completed')
  })

  test('each run is its own history entry so undo unwinds them one at a time', async () => {
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [3] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')

    const entries = store.getter(historyStackAtom).entries
    expect(requests).toHaveLength(2)
    expect(entries.filter((entry) => entry.kind === 'row.delete')).toHaveLength(2)
    expect(new Set(entries.map((entry) => entry.transactionId)).size).toBe(2)
    expectHistoryProducerLaneAvailable(store)
  })

  test('a failing run stops the sequence and surfaces that run outcome', async () => {
    const store = createStore()
    const requests: StructureOperationRequest[] = []
    const source: StructureOperationControllerPort = {
      async deleteRows(request) {
        requests.push(request as StructureOperationRequest)
        // First (highest) run succeeds, the next one never acknowledges.
        if (requests.length === 1) {
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 7,
          } satisfies BackendMutationResult
        }
        throw new Error('backend exploded')
      },
    }
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [3] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
        source,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('outcome-unknown')
    expect(requests).toHaveLength(2)
  })

  test('rejects a missing sheet id without touching the backend', async () => {
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: '',
        rowIndex: 0,
        count: 1,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('rejected')
    expect(requests).toEqual([])
  })

  test('filter-hidden sets are per sheet', async () => {
    const store = createStore()
    const { requests, source, refreshProjection } = deleteRowsHarness()
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-2', rows: [3] })

    await expect(
      store.setter(runFilterVisibleRowDeleteAtom, {
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
        source,
        refreshProjection,
      }),
    ).resolves.toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ rowIndex: 2, count: 3 })
  })
})
