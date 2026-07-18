import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type {
  BackendMutationResult,
  StructureOperationControllerPort,
  StructureOperationRequest,
} from '../src'
import { historyStackAtom } from '../src/history'
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
  resetStructureOperationLifecycleAtom,
  retryStructureOperationRefreshAtom,
  runStructureOperationAtom,
  structureOperationCanRetryRefreshAtom,
  structureOperationLifecycleAtom,
} from '../src/operations'

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

  test.each([
    ['transport rejection', new Error('connection reset')],
    ['missing request id', { sheetId: 'sheet-1', revision: 3 }],
    ['wrong request id', { sheetId: 'sheet-1', requestId: 99, revision: 3 }],
    ['missing revision', { sheetId: 'sheet-1', requestId: 1 }],
    ['wrong sheet', { sheetId: 'sheet-2', requestId: 1, revision: 3 }],
  ])('keeps %s terminal as outcome-unknown without refresh or history', async (_label, result) => {
    const store = createStore()
    let refreshCount = 0
    const source: StructureOperationControllerPort = {
      async insertRows() {
        if (result instanceof Error) throw result
        return result
      },
    }

    await expect(
      store.setter(runStructureOperationAtom, {
        intent: createInsertRowsOperation({
          sheetId: 'sheet-1',
          rowIndex: 0,
          count: 1,
        }),
        source,
        refreshProjection: async () => {
          refreshCount += 1
        },
      }),
    ).resolves.toBe('outcome-unknown')

    expect(store.getter(structureOperationLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(refreshCount).toBe(0)
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
  })

  test('keeps the mutation lane reserved after a pending ticket reset until transport settles', async () => {
    const store = createStore()
    let capturedRequest: StructureOperationRequest | null = null
    let resolveMutation!: (result: BackendMutationResult) => void
    let mutationCount = 0
    const source: StructureOperationControllerPort = {
      insertColumns(request) {
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
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)

    resolveMutation({
      sheetId: 'sheet-1',
      requestId: capturedRequest!.requestId,
      revision: 8,
    })

    await expect(run).resolves.toBe('stale')
    expect(store.getter(structureOperationLifecycleAtom).status).toBe('stale')
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(refreshCount).toBe(0)

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('completed')
    expect(mutationCount).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(refreshCount).toBe(1)
  })

  test('keeps the mutation lane reserved after timeout and reset until transport settles', async () => {
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
    expect(store.setter(resetStructureOperationLifecycleAtom)).toBe(true)
    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('stale')
    expect(mutationCount).toBe(1)

    resolveMutation({
      sheetId: 'sheet-1',
      requestId: capturedRequest!.requestId,
      revision: 11,
    })
    await Promise.resolve()
    await Promise.resolve()

    await expect(store.setter(runStructureOperationAtom, input)).resolves.toBe('completed')
    expect(mutationCount).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(refreshCount).toBe(1)
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
  })

  test('allocates safe request ids across rollover and stops at exhaustion', () => {
    expect(nextStructureOperationRequestId(0)).toBe(1)
    expect(nextStructureOperationRequestId(Number.MAX_SAFE_INTEGER)).toBe(-1)
    expect(nextStructureOperationRequestId(-1)).toBe(-2)
    expect(nextStructureOperationRequestId(Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(nextStructureOperationRequestId(Number.NaN)).toBeNull()
  })
})
