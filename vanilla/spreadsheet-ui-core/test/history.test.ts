import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_HISTORY_CAP,
  canRedoAtom,
  canUndoAtom,
  clearHistoryAtom,
  historyCanRetryRefreshAtom,
  historyInFlightAtom,
  historyLifecycleAtom,
  historyStackAtom,
  pushHistoryAtom,
  retryHistoryRefreshAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  type HistoryControllerPort,
  type HistoryEntry,
  type HistoryMutationResult,
  type HistoryRedoRequest,
  type HistoryUndoRequest,
} from '../src/history'
import { setFreezeConfigAtom, viewportFreezeAtom } from '../src/viewport/freeze'
import { hideRowsAtom, viewportHiddenAtom } from '../src/viewport/hidden'

function makeEntry(id: string, revision: number | string = 0): HistoryEntry {
  return {
    transactionId: id,
    kind: 'cell.set-input',
    sheetId: 'sheet-1',
    projectionRevision: revision,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

function exactAcknowledgement(
  request: Pick<HistoryUndoRequest, 'transactionId' | 'requestId'>,
  revision: number | string = 2,
): HistoryMutationResult {
  return {
    transactionId: request.transactionId,
    requestId: request.requestId,
    revision,
  }
}

describe('history Core lifecycle', () => {
  test('push owns an immutable bounded stack and truncates the redo tail', async () => {
    const store = createStore()
    const affectedRange = { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 3 }
    const sourceEntry: HistoryEntry = {
      ...makeEntry('tx-1', 'rev-a'),
      affectedRange,
    }
    expect(store.setter(pushHistoryAtom, sourceEntry)).toBe(true)
    affectedRange.rowEnd = 99

    const firstSnapshot = store.getter(historyStackAtom)
    expect(firstSnapshot.entries[0].affectedRange?.rowEnd).toBe(1)
    expect(Object.isFrozen(firstSnapshot)).toBe(true)
    expect(Object.isFrozen(firstSnapshot.entries)).toBe(true)
    expect(Object.isFrozen(firstSnapshot.entries[0])).toBe(true)
    expect(Object.isFrozen(firstSnapshot.entries[0].affectedRange)).toBe(true)

    const source: HistoryControllerPort = {
      async undoTransaction(request) {
        return exactAcknowledgement(request, 'rev-b')
      },
    }
    await store.setter(runUndoHistoryAtom, {
      source,
      refreshProjection: async () => {},
    })
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    expect(store.setter(pushHistoryAtom, makeEntry('tx-2', 'rev-c'))).toBe(true)
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1 })
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).toEqual([
      'tx-2',
    ])
  })

  test('push past the cap evicts the oldest descriptors', () => {
    const store = createStore()
    for (let index = 0; index < DEFAULT_HISTORY_CAP + 5; index += 1) {
      store.setter(pushHistoryAtom, makeEntry(`tx-${index}`, index))
    }
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(DEFAULT_HISTORY_CAP)
    expect(state.cursor).toBe(DEFAULT_HISTORY_CAP)
    expect(state.entries[0].transactionId).toBe('tx-5')
    expect(state.entries.at(-1)?.transactionId).toBe(`tx-${DEFAULT_HISTORY_CAP + 4}`)
  })

  test('publishes a frozen ticket before transport and does not move cursor before exact ACK', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 'base-rev'))
    const acknowledgement = deferred<HistoryMutationResult>()
    const refresh = deferred<void>()
    let observedRequest: HistoryUndoRequest | null = null
    const source: HistoryControllerPort = {
      undoTransaction(request) {
        observedRequest = request
        return acknowledgement.promise
      },
    }

    const operation = store.setter(runUndoHistoryAtom, {
      source,
      refreshProjection: () => refresh.promise,
    })
    await flushMicrotasks()

    expect(observedRequest).toMatchObject({
      kind: 'undo-transaction',
      transactionId: 'tx-1',
      requestId: 1,
      revision: 'base-rev',
    })
    expect(Object.isFrozen(observedRequest)).toBe(true)
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(historyInFlightAtom)).toBe(true)
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'pending',
      sessionId: 1,
      action: 'undo',
      transactionId: 'tx-1',
      requestId: 1,
      revision: 'base-rev',
    })

    acknowledgement.resolve(exactAcknowledgement(observedRequest!, 'ack-rev'))
    await flushMicrotasks()
    expect(store.getter(historyStackAtom).cursor).toBe(0)
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'refreshing',
      acknowledgedRevision: 'ack-rev',
    })

    refresh.resolve()
    await expect(operation).resolves.toBe('completed')
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(store.getter(historyInFlightAtom)).toBe(false)
    expect(store.getter(canRedoAtom)).toBe(true)
  })

  test('each matching ACK advances the Core base revision used by the next undo or redo', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) =>
      exactAcknowledgement(request, request.requestId === 1 ? 3 : 5),
    )
    const redo = jest.fn(async (request: HistoryRedoRequest) => exactAcknowledgement(request, 4))
    const source: HistoryControllerPort = { undoTransaction: undo, redoTransaction: redo }
    const refreshProjection = async () => {}

    await expect(store.setter(runUndoHistoryAtom, { source, refreshProjection })).resolves.toBe(
      'completed',
    )
    expect(undo.mock.calls[0]![0]).toMatchObject({ requestId: 1, revision: 1 })
    expect(store.getter(historyStackAtom).cursor).toBe(0)
    expect(store.getter(canRedoAtom)).toBe(true)

    await expect(store.setter(runRedoHistoryAtom, { source, refreshProjection })).resolves.toBe(
      'completed',
    )
    expect(redo.mock.calls[0]![0]).toMatchObject({ requestId: 2, revision: 3 })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(canUndoAtom)).toBe(true)

    await expect(store.setter(runUndoHistoryAtom, { source, refreshProjection })).resolves.toBe(
      'completed',
    )
    expect(undo.mock.calls[1]![0]).toMatchObject({ requestId: 3, revision: 4 })
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('rejects invalid entry revisions without retaining history or starting transport', async () => {
    for (const revision of [Number.NaN, Number.POSITIVE_INFINITY, '']) {
      const store = createStore()
      const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request))
      const redo = jest.fn(async (request: HistoryRedoRequest) => exactAcknowledgement(request))
      const source: HistoryControllerPort = { undoTransaction: undo, redoTransaction: redo }
      const refreshProjection = jest.fn(async () => {})

      expect(store.setter(pushHistoryAtom, makeEntry('tx-invalid', revision))).toBe(false)
      expect(store.getter(historyStackAtom)).toMatchObject({ entries: [], cursor: 0 })
      await expect(store.setter(runUndoHistoryAtom, { source, refreshProjection })).resolves.toBe(
        'blocked',
      )
      await expect(store.setter(runRedoHistoryAtom, { source, refreshProjection })).resolves.toBe(
        'blocked',
      )
      expect(undo).not.toHaveBeenCalled()
      expect(redo).not.toHaveBeenCalled()
      expect(refreshProjection).not.toHaveBeenCalled()
      expect(store.getter(historyLifecycleAtom)).toMatchObject({
        status: 'ready',
        action: null,
        error: '',
      })
    }
  })

  test('checks an empty stack before reading transport capability or writing lifecycle noise', async () => {
    const store = createStore()
    const initialLifecycle = store.getter(historyLifecycleAtom)
    let capabilityReads = 0
    const source = {
      get undoTransaction(): HistoryControllerPort['undoTransaction'] {
        capabilityReads += 1
        throw new Error('undo capability must not be read for an empty stack')
      },
      get redoTransaction(): HistoryControllerPort['redoTransaction'] {
        capabilityReads += 1
        throw new Error('redo capability must not be read for an empty stack')
      },
    }
    const refreshProjection = jest.fn(async () => {})

    await expect(store.setter(runUndoHistoryAtom, { source, refreshProjection })).resolves.toBe(
      'blocked',
    )
    await expect(store.setter(runRedoHistoryAtom, { source, refreshProjection })).resolves.toBe(
      'blocked',
    )
    expect(capabilityReads).toBe(0)
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(store.getter(historyLifecycleAtom)).toBe(initialLifecycle)
  })

  test('same-lane re-entry and duplicate dispatch are blocked before transport settles', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    store.setter(pushHistoryAtom, makeEntry('tx-2', 2))
    const acknowledgement = deferred<HistoryMutationResult>()
    const undo = jest.fn((request: HistoryUndoRequest) => acknowledgement.promise)
    const source: HistoryControllerPort = { undoTransaction: undo }
    const input = { source, refreshProjection: async () => {} }

    const first = store.setter(runUndoHistoryAtom, input)
    const duplicate = store.setter(runUndoHistoryAtom, input)
    await expect(duplicate).resolves.toBe('blocked')
    await flushMicrotasks()
    expect(undo).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).cursor).toBe(2)
    expect(store.setter(pushHistoryAtom, makeEntry('tx-3', 3))).toBe(false)
    expect(store.setter(clearHistoryAtom)).toBe(false)

    acknowledgement.resolve(exactAcknowledgement(undo.mock.calls[0]![0], 3))
    await expect(first).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test.each([
    [
      'foreign transactionId',
      (request: HistoryUndoRequest) => ({
        ...exactAcknowledgement(request),
        transactionId: 'foreign',
      }),
    ],
    [
      'missing requestId',
      (request: HistoryUndoRequest) => ({ transactionId: request.transactionId, revision: 2 }),
    ],
    [
      'foreign requestId',
      (request: HistoryUndoRequest) => ({
        ...exactAcknowledgement(request),
        requestId: request.requestId + 1,
      }),
    ],
    [
      'missing revision',
      (request: HistoryUndoRequest) => ({
        transactionId: request.transactionId,
        requestId: request.requestId,
      }),
    ],
  ])('strict ACK rejects %s as OutcomeUnknown', async (_label, resultFor) => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => resultFor(request))
    const source: HistoryControllerPort = { undoTransaction: undo }
    const input = { source, refreshProjection: async () => {} }

    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('outcome-unknown')
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1, inFlight: false })
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedRevision: null,
    })
    expect(store.getter(canUndoAtom)).toBe(false)
    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('blocked')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  test('transport rejection becomes OutcomeUnknown and never resends the mutation', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (_request: HistoryUndoRequest): Promise<HistoryMutationResult> => {
      throw new Error('connection dropped after write boundary')
    })
    const source: HistoryControllerPort = { undoTransaction: undo }
    const input = { source, refreshProjection: async () => {} }

    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('outcome-unknown')
    expect(store.getter(historyLifecycleAtom).error).toContain('connection dropped')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('blocked')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  test('structured not-applied ACK is OutcomeUnknown; cursor and witness stay', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(
      async (request: HistoryUndoRequest): Promise<HistoryMutationResult> => ({
        transactionId: request.transactionId,
        requestId: request.requestId,
        revision: 9,
        applied: false,
        notAppliedReason: 'unknown transactionId: tx-1',
      }),
    )
    const source: HistoryControllerPort = { undoTransaction: undo }
    const input = { source, refreshProjection: async () => {} }

    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('outcome-unknown')
    const lifecycle = store.getter(historyLifecycleAtom)
    expect(lifecycle.status).toBe('outcome-unknown')
    expect(lifecycle.error).toContain('not applied')
    expect(lifecycle.error).toContain('unknown transactionId: tx-1')
    // The backend positively confirmed nothing changed: the cursor must
    // not move and the not-applied revision must not become the witness.
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(lifecycle.acknowledgedRevision).toBeNull()
    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('blocked')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  test('transport timeout is OutcomeUnknown and a late stale ACK cannot commit or reopen the lane', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const late = deferred<HistoryMutationResult>()
    let request: HistoryUndoRequest | null = null
    const source: HistoryControllerPort = {
      undoTransaction(nextRequest) {
        request = nextRequest
        return late.promise
      },
    }
    const input = { source, refreshProjection: async () => {}, timeoutMs: 1 }

    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('outcome-unknown')
    expect(store.getter(historyLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    late.resolve(exactAcknowledgement(request!, 2))
    await flushMicrotasks()
    expect(store.getter(historyLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    await expect(store.setter(runUndoHistoryAtom, input)).resolves.toBe('blocked')
  })

  test('matching ACK plus refresh failure commits cursor and permits refresh-only retry', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 2))
    const redo = jest.fn(async (request: HistoryRedoRequest) => exactAcknowledgement(request, 3))
    const source: HistoryControllerPort = { undoTransaction: undo, redoTransaction: redo }
    const firstRefresh = jest.fn(async () => {
      throw new Error('projection unavailable')
    })

    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: firstRefresh }),
    ).resolves.toBe('refresh-failed')
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0, inFlight: false })
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'refresh-failed',
      acknowledgedRevision: 2,
    })
    expect(store.getter(historyCanRetryRefreshAtom)).toBe(true)
    expect(undo).toHaveBeenCalledTimes(1)

    const retryRefresh = jest.fn(async () => {})
    await expect(
      store.setter(retryHistoryRefreshAtom, { refreshProjection: retryRefresh }),
    ).resolves.toBe('completed')
    expect(retryRefresh).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(store.getter(canRedoAtom)).toBe(true)

    await expect(
      store.setter(runRedoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(redo).toHaveBeenCalledTimes(1)
    expect(redo.mock.calls[0]![0]).toMatchObject({ revision: 2 })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test('refresh timeout is RefreshFailed, not OutcomeUnknown, and retry never calls transport', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 2))
    const source: HistoryControllerPort = { undoTransaction: undo }

    await expect(
      store.setter(runUndoHistoryAtom, {
        source,
        refreshProjection: () => new Promise<void>(() => {}),
        timeoutMs: 1,
      }),
    ).resolves.toBe('refresh-failed')
    expect(store.getter(historyLifecycleAtom).status).toBe('refresh-failed')
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    await expect(
      store.setter(retryHistoryRefreshAtom, { refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  test('missing capability blocks without consuming the entry and a valid later port may proceed', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    await expect(
      store.setter(runUndoHistoryAtom, { source: {}, refreshProjection: async () => {} }),
    ).resolves.toBe('blocked')
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1, inFlight: false })
    expect(store.getter(historyLifecycleAtom).status).toBe('blocked')
    expect(store.getter(canUndoAtom)).toBe(true)

    const source: HistoryControllerPort = {
      async undoTransaction(request) {
        return exactAcknowledgement(request, 2)
      },
    }
    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('clear resets a settled stack, while entries remain bounded metadata', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-bounded', 99))
    expect(Object.keys(store.getter(historyStackAtom).entries[0]).sort()).toEqual(
      ['transactionId', 'kind', 'sheetId', 'projectionRevision'].sort(),
    )
    expect(store.setter(clearHistoryAtom)).toBe(true)
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0, inFlight: false })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })
})

describe('backend entries with local side payloads', () => {
  function makeBackendSource(revisions: { undo: number; redo: number }): HistoryControllerPort & {
    undoCalls: HistoryUndoRequest[]
    redoCalls: HistoryRedoRequest[]
  } {
    const undoCalls: HistoryUndoRequest[] = []
    const redoCalls: HistoryRedoRequest[] = []
    return {
      undoCalls,
      redoCalls,
      async undoTransaction(request) {
        undoCalls.push(request)
        return {
          transactionId: request.transactionId,
          requestId: request.requestId,
          revision: revisions.undo,
        }
      },
      async redoTransaction(request) {
        redoCalls.push(request)
        return {
          transactionId: request.transactionId,
          requestId: request.requestId,
          revision: revisions.redo,
        }
      },
    }
  }

  test('undo/redo of a structural entry replays its freeze and hidden side payloads', async () => {
    const store = createStore()
    // Establish the post-shift local facts (as the structural operation left them).
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [4] })
    // Two local entries were recorded; a backend structural entry follows.
    store.setter(pushHistoryAtom, {
      transactionId: 'tx-structural',
      kind: 'row.delete',
      sheetId: 'sheet-1',
      projectionRevision: 10,
      localSidePayloads: [
        {
          applyKey: 'viewport.freeze',
          sheetId: 'sheet-1',
          before: { rows: 4, cols: 1 },
          after: { rows: 2, cols: 1 },
        },
        {
          applyKey: 'viewport.hidden',
          sheetId: 'sheet-1',
          before: { rows: [2, 6], cols: [] },
          after: { rows: [4], cols: [] },
        },
      ],
    })

    const source = makeBackendSource({ undo: 11, redo: 12 })
    await expect(
      store.setter(runUndoHistoryAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    // Backend transaction ran AND the local view facts were restored from
    // the exact recorded snapshots — a delete's index membership cannot be
    // recovered by inverting the shift.
    expect(source.undoCalls).toHaveLength(1)
    expect(store.getter(viewportFreezeAtom).rowsBySheet['sheet-1']).toBe(4)
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 6])

    await expect(
      store.setter(runRedoHistoryAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    expect(source.redoCalls).toHaveLength(1)
    expect(store.getter(viewportFreezeAtom).rowsBySheet['sheet-1']).toBe(2)
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([4])
  })

  test('side payloads still require the backend transaction to be acknowledged', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [4] })
    store.setter(pushHistoryAtom, {
      transactionId: 'tx-structural',
      kind: 'row.delete',
      sheetId: 'sheet-1',
      projectionRevision: 10,
      localSidePayloads: [
        {
          applyKey: 'viewport.hidden',
          sheetId: 'sheet-1',
          before: { rows: [2, 6], cols: [] },
          after: { rows: [4], cols: [] },
        },
      ],
    })
    const failing: HistoryControllerPort = {
      async undoTransaction() {
        throw new Error('undo offline')
      },
    }
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: failing,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('outcome-unknown')
    // No acknowledgement → no local restore.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([4])
  })

  test('side payloads are dropped from entries that also carry localReplay', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, {
      transactionId: 'tx-conflict',
      kind: 'viewport.hidden',
      sheetId: 'sheet-1',
      projectionRevision: 'local',
      localReplay: {
        applyKey: 'viewport.hidden',
        sheetId: 'sheet-1',
        before: { rows: [] },
        after: { rows: [1] },
      },
      localSidePayloads: [
        {
          applyKey: 'viewport.freeze',
          sheetId: 'sheet-1',
          before: null,
          after: { rows: 1, cols: 0 },
        },
      ],
    })
    const entry = store.getter(historyStackAtom).entries[0]!
    expect(entry.localReplay).toBeDefined()
    expect(entry.localSidePayloads).toBeUndefined()
  })
})
