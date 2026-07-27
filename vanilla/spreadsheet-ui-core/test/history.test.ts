import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_HISTORY_CAP,
  DEFAULT_HISTORY_TIMEOUT_MS,
  HISTORY_LOCAL_REPLAY_ERROR,
  acquireHistoryProducerReservationAtom,
  canRedoAtom,
  canUndoAtom,
  clearHistoryAtom,
  historyCanRetryRefreshAtom,
  historyInFlightAtom,
  historyLifecycleAtom,
  historyStackAtom,
  pushHistoryAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  retryHistoryRefreshAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  type HistoryControllerPort,
  type HistoryEntry,
  type HistoryMutationResult,
  type HistoryRedoRequest,
  type RunHistoryCommandInput,
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

  test(
    'producer reservation is opaque, identity-owned, and supports one push per backend transaction',
    () => {
    const store = createStore()
    const foreignStore = createStore()
    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    const foreignReservation = foreignStore.setter(acquireHistoryProducerReservationAtom)
    if (reservation === null || foreignReservation === null) {
      throw new Error('expected both isolated stores to acquire their producer lane')
    }

    expect(Object.isFrozen(reservation)).toBe(true)
    expect(Object.keys(reservation)).toEqual([])
    expect(Object.getPrototypeOf(reservation)).toBeNull()
    expect(
      store.setter(pushReservedHistoryAtom, {
        reservation: foreignReservation,
        entry: makeEntry('tx-foreign', 1),
      }),
    ).toBe(false)
    expect(store.setter(releaseHistoryProducerReservationAtom, foreignReservation)).toBe(false)
    expect(store.setter(pushHistoryAtom, makeEntry('tx-ordinary', 1))).toBe(false)

    expect(
      store.setter(pushReservedHistoryAtom, {
        reservation,
        entry: makeEntry('tx-1', 1),
      }),
    ).toBe(true)
    expect(
      store.setter(pushReservedHistoryAtom, {
        reservation,
        entry: makeEntry('tx-2', 2),
      }),
    ).toBe(true)
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).toEqual([
      'tx-1',
      'tx-2',
    ])

    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(false)
    expect(
      store.setter(pushReservedHistoryAtom, {
        reservation,
        entry: makeEntry('tx-after-release', 3),
      }),
    ).toBe(false)
    expect(store.setter(pushHistoryAtom, makeEntry('tx-ordinary', 3))).toBe(true)
  })

  test(
    'legacy push reserves atomically while snapshotting each hostile descriptor field once',
    () => {
    const store = createStore()
    const reads: Record<string, number> = {}
    const read = <T>(key: string, value: T): T => {
      reads[key] = (reads[key] ?? 0) + 1
      return value
    }
    const nestedPushes: boolean[] = []
    const nestedClears: boolean[] = []
    const nestedReservations: unknown[] = []

    const affectedRange = Object.defineProperties(
      {},
      {
        rowStart: { get: () => read('range.rowStart', 0) },
        rowEnd: { get: () => read('range.rowEnd', 1) },
        colStart: { get: () => read('range.colStart', 2) },
        colEnd: { get: () => read('range.colEnd', 3) },
      },
    )
    const sidePayload = Object.defineProperties(
      {},
      {
        applyKey: { get: () => read('payload.applyKey', 'viewport.freeze') },
        sheetId: { get: () => read('payload.sheetId', 'sheet-1') },
        before: { get: () => read('payload.before', null) },
        after: { get: () => read('payload.after', { rows: 1, cols: 0 }) },
      },
    )
    const sidePayloads: unknown[] = []
    Object.defineProperty(sidePayloads, '0', {
      configurable: true,
      get: () => read('sidePayloads[0]', sidePayload),
    })

    const entry = Object.defineProperties(
      {},
      {
        transactionId: {
          get() {
            reads.transactionId = (reads.transactionId ?? 0) + 1
            nestedPushes.push(store.setter(pushHistoryAtom, makeEntry('tx-interloper', 9)))
            nestedClears.push(store.setter(clearHistoryAtom))
            nestedReservations.push(store.setter(acquireHistoryProducerReservationAtom))
            return 'tx-hostile'
          },
        },
        kind: { get: () => read('kind', 'range.fill') },
        sheetId: { get: () => read('sheetId', 'sheet-1') },
        projectionRevision: { get: () => read('projectionRevision', 1) },
        affectedRange: { get: () => read('affectedRange', affectedRange) },
        localReplay: { get: () => read('localReplay', undefined) },
        localSidePayloads: { get: () => read('localSidePayloads', sidePayloads) },
      },
    ) as HistoryEntry

    expect(store.setter(pushHistoryAtom, entry)).toBe(true)
    expect(nestedPushes).toEqual([false])
    expect(nestedClears).toEqual([false])
    expect(nestedReservations).toEqual([null])
    expect(reads).toEqual({
      transactionId: 1,
      kind: 1,
      sheetId: 1,
      projectionRevision: 1,
      affectedRange: 1,
      localReplay: 1,
      localSidePayloads: 1,
      'range.rowStart': 1,
      'range.rowEnd': 1,
      'range.colStart': 1,
      'range.colEnd': 1,
      'sidePayloads[0]': 1,
      'payload.applyKey': 1,
      'payload.sheetId': 1,
      'payload.before': 1,
      'payload.after': 1,
    })
    expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
      transactionId: 'tx-hostile',
      affectedRange: { rowStart: 0, rowEnd: 1, colStart: 2, colEnd: 3 },
    })

    const throwingEntry = Object.defineProperty({}, 'transactionId', {
      get() {
        throw new Error('hostile entry')
      },
    }) as HistoryEntry
    expect(store.setter(pushHistoryAtom, throwingEntry)).toBe(false)
    expect(
      store.setter(pushHistoryAtom, {
        ...makeEntry('tx-invalid-kind', 2),
        kind: 'range.unknown' as HistoryEntry['kind'],
      }),
    ).toBe(false)
    expect(store.setter(pushHistoryAtom, makeEntry('tx-after-throw', 2))).toBe(true)
  })

  test('same-tick producer/history races admit only the first owner in either order', async () => {
    const producerFirst = createStore()
    producerFirst.setter(pushHistoryAtom, makeEntry('tx-producer-first', 1))
    const reservation = producerFirst.setter(acquireHistoryProducerReservationAtom)
    if (reservation === null) throw new Error('expected producer reservation')
    const blockedUndo = jest.fn(async (request: HistoryUndoRequest) =>
      exactAcknowledgement(request, 2),
    )

    await expect(
      producerFirst.setter(runUndoHistoryAtom, {
        source: { undoTransaction: blockedUndo },
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    expect(blockedUndo).not.toHaveBeenCalled()
    expect(producerFirst.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(producerFirst.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)

    const historyFirst = createStore()
    historyFirst.setter(pushHistoryAtom, makeEntry('tx-history-first', 1))
    const acknowledgement = deferred<HistoryMutationResult>()
    let request: HistoryUndoRequest | null = null
    const undo = jest.fn((nextRequest: HistoryUndoRequest) => {
      request = nextRequest
      return acknowledgement.promise
    })
    const operation = historyFirst.setter(runUndoHistoryAtom, {
      source: { undoTransaction: undo },
      refreshProjection: async () => {},
    })

    expect(historyFirst.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await flushMicrotasks()
    expect(undo).toHaveBeenCalledTimes(1)
    acknowledgement.resolve(exactAcknowledgement(request!, 2))
    await expect(operation).resolves.toBe('completed')
  })

  test(
    'producer ownership blocks both history directions, local replay, clear, and capability flags',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, {
      transactionId: 'tx-local',
      kind: 'viewport.freeze',
      sheetId: 'sheet-1',
      projectionRevision: 'local',
      localReplay: {
        applyKey: 'viewport.freeze',
        sheetId: 'sheet-1',
        before: null,
        after: { rows: 1, cols: 0 },
      },
    })
    store.setter(pushHistoryAtom, makeEntry('tx-backend', 2))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 3))
    const redo = jest.fn(async (request: HistoryRedoRequest) => exactAcknowledgement(request, 4))
    const source: HistoryControllerPort = { undoTransaction: undo, redoTransaction: redo }
    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(store.getter(canUndoAtom)).toBe(true)
    expect(store.getter(canRedoAtom)).toBe(true)

    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    if (reservation === null) throw new Error('expected producer reservation')
    expect(store.getter(canUndoAtom)).toBe(false)
    expect(store.getter(canRedoAtom)).toBe(false)
    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('blocked')
    await expect(
      store.setter(runRedoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('blocked')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).not.toHaveBeenCalled()
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1 })
    expect(store.setter(clearHistoryAtom)).toBe(false)

    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
    expect(store.getter(canUndoAtom)).toBe(true)
    expect(store.getter(canRedoAtom)).toBe(true)
  })

  test(
    'local replay owns the producer lane across persistence getter and synchronous method re-entry',
    async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    const nestedOutcomes: Array<Promise<unknown>> = []
    const nestedPushes: boolean[] = []
    const nestedClears: boolean[] = []
    const nestedReservations: unknown[] = []
    const observedCursors: number[] = []

    const attemptReentry = (action: 'undo' | 'redo') => {
      observedCursors.push(store.getter(historyStackAtom).cursor)
      nestedPushes.push(store.setter(pushHistoryAtom, makeEntry(`tx-${action}-interloper`, 9)))
      nestedClears.push(store.setter(clearHistoryAtom))
      nestedReservations.push(store.setter(acquireHistoryProducerReservationAtom))
      nestedOutcomes.push(
        store.setter(action === 'undo' ? runUndoHistoryAtom : runRedoHistoryAtom, {
          source: {},
          refreshProjection: async () => {},
        }),
      )
    }

    const persist = jest.fn(() => {
      attemptReentry('redo')
      return new Promise<never>(() => {})
    })
    const persistenceSource = Object.defineProperty({}, 'setFreezeConfig', {
      get() {
        attemptReentry('undo')
        return persist
      },
    }) as HistoryControllerPort

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: persistenceSource,
        refreshProjection: async () => {
          throw new Error('local replay must not refresh')
        },
      }),
    ).resolves.toBe('completed')
    await expect(Promise.all(nestedOutcomes)).resolves.toEqual(['blocked', 'blocked'])

    expect(observedCursors).toEqual([1, 1])
    expect(nestedPushes).toEqual([false, false])
    expect(nestedClears).toEqual([false, false])
    expect(nestedReservations).toEqual([null, null])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0 })
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).toHaveLength(
      1,
    )
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')

    const releasedLane = store.setter(acquireHistoryProducerReservationAtom)
    expect(releasedLane).not.toBeNull()
    if (releasedLane !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, releasedLane)).toBe(true)
    }
  })

  test(
    'local replay reserves the producer lane before reading the command source getter',
    async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    const nestedOutcomes: Array<Promise<unknown>> = []
    const observedCanUndo: boolean[] = []
    const nestedPushes: boolean[] = []
    const nestedClears: boolean[] = []
    const nestedReservations: unknown[] = []
    let sourceReads = 0
    const command = Object.defineProperty({ refreshProjection: async () => {} }, 'source', {
      get() {
        sourceReads += 1
        observedCanUndo.push(store.getter(canUndoAtom))
        nestedPushes.push(store.setter(pushHistoryAtom, makeEntry('tx-source-interloper', 9)))
        nestedClears.push(store.setter(clearHistoryAtom))
        nestedReservations.push(store.setter(acquireHistoryProducerReservationAtom))
        nestedOutcomes.push(
          store.setter(runUndoHistoryAtom, {
            source: {},
            refreshProjection: async () => {},
          }),
          store.setter(runRedoHistoryAtom, {
            source: {},
            refreshProjection: async () => {},
          }),
        )
        throw new Error('command source getter failed')
      },
    }) as RunHistoryCommandInput

    await expect(store.setter(runUndoHistoryAtom, command)).resolves.toBe('blocked')
    await expect(Promise.all(nestedOutcomes)).resolves.toEqual(['blocked', 'blocked'])
    expect(sourceReads).toBe(1)
    expect(observedCanUndo).toEqual([false])
    expect(nestedPushes).toEqual([false])
    expect(nestedClears).toEqual([false])
    expect(nestedReservations).toEqual([null])
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1 })
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'blocked',
      error: HISTORY_LOCAL_REPLAY_ERROR,
    })

    const releasedLane = store.setter(acquireHistoryProducerReservationAtom)
    expect(releasedLane).not.toBeNull()
    if (releasedLane !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, releasedLane)).toBe(true)
    }
  })

  test('local replay releases its exact reservation when a persistence getter throws', async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    const persistenceSource = Object.defineProperty({}, 'setFreezeConfig', {
      get() {
        throw new Error('persistence getter failed')
      },
    }) as HistoryControllerPort

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: persistenceSource,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('blocked')
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1 })
    expect(store.getter(historyLifecycleAtom)).toMatchObject({
      status: 'blocked',
      error: HISTORY_LOCAL_REPLAY_ERROR,
    })
    expect(store.getter(canUndoAtom)).toBe(true)

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: {},
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('local replay releases its reservation after synchronous persistence failure', async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    const nestedOutcomes: Array<Promise<unknown>> = []
    const persistenceSource = {
      setFreezeConfig() {
        expect(store.setter(pushHistoryAtom, makeEntry('tx-sync-interloper', 9))).toBe(false)
        expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
        nestedOutcomes.push(
          store.setter(runUndoHistoryAtom, {
            source: {},
            refreshProjection: async () => {},
          }),
        )
        throw new Error('synchronous persistence failure')
      },
    } as HistoryControllerPort

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: persistenceSource,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    await expect(Promise.all(nestedOutcomes)).resolves.toEqual(['blocked'])
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0 })
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')

    await expect(
      store.setter(runRedoHistoryAtom, {
        source: {},
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test(
    'local replay descriptors never replace the backend projection revision witness',
    async () => {
    const store = createStore()
    expect(store.setter(pushHistoryAtom, makeEntry('tx-backend', 'backend-base'))).toBe(true)
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })).toBe(
      'committed',
    )

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: {},
        refreshProjection: async () => {
          throw new Error('local replay must not refresh')
        },
      }),
    ).resolves.toBe('completed')

    const undo = jest.fn(async (request: HistoryUndoRequest) =>
      exactAcknowledgement(request, 'backend-next'),
    )
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: { undoTransaction: undo },
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(undo.mock.calls[0]![0]).toMatchObject({
      transactionId: 'tx-backend',
      revision: 'backend-base',
    })
  })

  test('rejected fire-and-forget local persistence does not retain the producer lane', async () => {
    const store = createStore()
    store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 1 })
    const persistenceSource = {
      setFreezeConfig() {
        return Promise.reject(new Error('asynchronous persistence failure'))
      },
    } as HistoryControllerPort

    await expect(
      store.setter(runUndoHistoryAtom, {
        source: persistenceSource,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    await flushMicrotasks()

    const releasedLane = store.setter(acquireHistoryProducerReservationAtom)
    expect(releasedLane).not.toBeNull()
    if (releasedLane !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, releasedLane)).toBe(true)
    }
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('blocked ordinary push preserves the redo tail owned by an active producer', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    store.setter(pushHistoryAtom, makeEntry('tx-2', 2))
    const source: HistoryControllerPort = {
      async undoTransaction(request) {
        return exactAcknowledgement(request, 3)
      },
      async redoTransaction(request) {
        return exactAcknowledgement(request, 4)
      },
    }
    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')

    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    if (reservation === null) throw new Error('expected producer reservation')
    expect(store.setter(pushHistoryAtom, makeEntry('tx-interloper', 9))).toBe(false)
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.transactionId)).toEqual([
      'tx-1',
      'tx-2',
    ])
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)

    await expect(
      store.setter(runRedoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(store.getter(historyStackAtom).cursor).toBe(2)
  })

  test(
    'terminal history tickets block producer acquisition even when inFlight is false',
    async () => {
    const outcomeUnknownStore = createStore()
    outcomeUnknownStore.setter(pushHistoryAtom, makeEntry('tx-unknown', 1))
    await expect(
      outcomeUnknownStore.setter(runUndoHistoryAtom, {
        source: {
          async undoTransaction() {
            throw new Error('connection lost after dispatch')
          },
        },
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('outcome-unknown')
    expect(outcomeUnknownStore.getter(historyInFlightAtom)).toBe(false)
    expect(outcomeUnknownStore.getter(historyLifecycleAtom).status).toBe('outcome-unknown')
    expect(outcomeUnknownStore.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    const refreshFailedStore = createStore()
    refreshFailedStore.setter(pushHistoryAtom, makeEntry('tx-refresh-failed', 1))
    await expect(
      refreshFailedStore.setter(runUndoHistoryAtom, {
        source: {
          async undoTransaction(request) {
            return exactAcknowledgement(request, 2)
          },
        },
        refreshProjection: async () => {
          throw new Error('projection refresh failed')
        },
      }),
    ).resolves.toBe('refresh-failed')
    expect(refreshFailedStore.getter(historyInFlightAtom)).toBe(false)
    expect(refreshFailedStore.getter(historyLifecycleAtom).status).toBe('refresh-failed')
    expect(refreshFailedStore.setter(acquireHistoryProducerReservationAtom)).toBeNull()
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

  test(
    'freezes command ports under one-read getters and executes through the captured receiver',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const reads = {
      source: 0,
      capability: 0,
      refreshProjection: 0,
      timeoutMs: 0,
    }
    const nestedPushes: boolean[] = []
    const attemptReentry = () => {
      nestedPushes.push(store.setter(pushHistoryAtom, makeEntry('tx-interloper', 9)))
    }
    let receiver: unknown
    function execute(this: object, request: HistoryUndoRequest): Promise<HistoryMutationResult> {
      receiver = this
      return Promise.resolve(exactAcknowledgement(request, 2))
    }
    const source = Object.defineProperty({}, 'undoTransaction', {
      get() {
        reads.capability += 1
        attemptReentry()
        return execute
      },
    }) as HistoryControllerPort
    const refresh = jest.fn(async () => {})
    const command = Object.defineProperties(
      {},
      {
        source: {
          get() {
            reads.source += 1
            attemptReentry()
            return source
          },
        },
        refreshProjection: {
          get() {
            reads.refreshProjection += 1
            attemptReentry()
            return refresh
          },
        },
        timeoutMs: {
          get() {
            reads.timeoutMs += 1
            attemptReentry()
            return 100
          },
        },
      },
    ) as RunHistoryCommandInput

    await expect(store.setter(runUndoHistoryAtom, command)).resolves.toBe('completed')
    expect(reads).toEqual({
      source: 1,
      capability: 1,
      refreshProjection: 1,
      timeoutMs: 1,
    })
    expect(nestedPushes).toEqual([false, false, false, false])
    expect(receiver).toBe(source)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('invalid command timeouts normalize once to the positive finite default', async () => {
    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    try {
      for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const store = createStore()
        store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
        await expect(
          store.setter(runUndoHistoryAtom, {
            source: {
              async undoTransaction(request) {
                return exactAcknowledgement(request, 2)
              },
            },
            refreshProjection: async () => {},
            timeoutMs,
          }),
        ).resolves.toBe('completed')
      }
      expect(timeoutSpy.mock.calls.map((call) => call[1])).toEqual(
        Array(8).fill(DEFAULT_HISTORY_TIMEOUT_MS),
      )
    } finally {
      timeoutSpy.mockRestore()
    }
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

  test(
    'strict ACK snapshots every field once and blocks getter re-entry before commit',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const reads = {
      transactionId: 0,
      requestId: 0,
      revision: 0,
      applied: 0,
      notAppliedReason: 0,
    }
    const nestedOutcomes: Array<Promise<unknown>> = []
    const nestedPushes: boolean[] = []
    const nestedReservations: unknown[] = []
    const source: HistoryControllerPort = {
      async undoTransaction(request) {
        return Object.defineProperties(
          {},
          {
            transactionId: {
              get() {
                reads.transactionId += 1
                nestedPushes.push(store.setter(pushHistoryAtom, makeEntry('tx-interloper', 9)))
                nestedReservations.push(store.setter(acquireHistoryProducerReservationAtom))
                nestedOutcomes.push(
                  store.setter(runUndoHistoryAtom, {
                    source,
                    refreshProjection: async () => {},
                  }),
                )
                return request.transactionId
              },
            },
            requestId: {
              get() {
                reads.requestId += 1
                return request.requestId
              },
            },
            revision: {
              get() {
                reads.revision += 1
                return 2
              },
            },
            applied: {
              get() {
                reads.applied += 1
                return true
              },
            },
            notAppliedReason: {
              get() {
                reads.notAppliedReason += 1
                return undefined
              },
            },
          },
        ) as HistoryMutationResult
      },
    }

    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    await expect(Promise.all(nestedOutcomes)).resolves.toEqual(['blocked'])
    expect(reads).toEqual({
      transactionId: 1,
      requestId: 1,
      revision: 1,
      applied: 1,
      notAppliedReason: 1,
    })
    expect(nestedPushes).toEqual([false])
    expect(nestedReservations).toEqual([null])
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test(
    'a throwing ACK field is malformed, but every classifier field is still observed once',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const reads = new Map<string, number>()
    const count = (key: string) => reads.set(key, (reads.get(key) ?? 0) + 1)
    const source: HistoryControllerPort = {
      async undoTransaction(request) {
        return Object.defineProperties(
          {},
          {
            transactionId: {
              get() {
                count('transactionId')
                return request.transactionId
              },
            },
            requestId: {
              get() {
                count('requestId')
                throw new Error('hostile ACK')
              },
            },
            revision: {
              get() {
                count('revision')
                return 2
              },
            },
            applied: {
              get() {
                count('applied')
                return true
              },
            },
            notAppliedReason: {
              get() {
                count('notAppliedReason')
                return undefined
              },
            },
          },
        ) as HistoryMutationResult
      },
    }

    await expect(
      store.setter(runUndoHistoryAtom, { source, refreshProjection: async () => {} }),
    ).resolves.toBe('outcome-unknown')
    expect(Object.fromEntries(reads)).toEqual({
      transactionId: 1,
      requestId: 1,
      revision: 1,
      applied: 1,
      notAppliedReason: 1,
    })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(canUndoAtom)).toBe(false)
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
    let replacement: Promise<unknown> | null = null
    const unsubscribe = store.sub(canRedoAtom, () => {
      if (replacement !== null || !store.getter(canRedoAtom)) return
      replacement = store.setter(runRedoHistoryAtom, {
        source,
        refreshProjection: async () => {},
      })
    })
    await expect(
      store.setter(retryHistoryRefreshAtom, { refreshProjection: retryRefresh }),
    ).resolves.toBe('completed')
    expect(retryRefresh).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(replacement).not.toBeNull()
    await expect(replacement!).resolves.toBe('completed')
    unsubscribe()
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(redo).toHaveBeenCalledTimes(1)
    expect(redo.mock.calls[0]![0]).toMatchObject({ revision: 2 })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test(
    'retry snapshots the failed ticket before getters and rejects getter-driven replacement',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 2))
    await expect(
      store.setter(runUndoHistoryAtom, {
        source: { undoTransaction: undo },
        refreshProjection: async () => {
          throw new Error('first refresh failed')
        },
      }),
    ).resolves.toBe('refresh-failed')

    const nestedRefresh = jest.fn(async () => {})
    const outerRefresh = jest.fn(async () => {})
    let nestedOperation: Promise<unknown> | null = null
    let refreshGetterReads = 0
    const hostileRetry = Object.defineProperty({}, 'refreshProjection', {
      get() {
        refreshGetterReads += 1
        nestedOperation = store.setter(retryHistoryRefreshAtom, {
          refreshProjection: nestedRefresh,
        })
        return outerRefresh
      },
    })

    await expect(
      store.setter(retryHistoryRefreshAtom, hostileRetry as RunHistoryCommandInput),
    ).resolves.toBe('blocked')
    expect(nestedOperation).not.toBeNull()
    await expect(nestedOperation!).resolves.toBe('completed')
    expect(refreshGetterReads).toBe(1)
    expect(outerRefresh).not.toHaveBeenCalled()
    expect(nestedRefresh).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(store.getter(canRedoAtom)).toBe(true)
  })

  test(
    'refresh timeout retains a refresh-only ticket and late completion is inert after retry',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 2))
    const source: HistoryControllerPort = { undoTransaction: undo }
    const lateRefresh = deferred<void>()

    await expect(
      store.setter(runUndoHistoryAtom, {
        source,
        refreshProjection: () => lateRefresh.promise,
        timeoutMs: 1,
      }),
    ).resolves.toBe('refresh-failed')
    expect(store.getter(historyLifecycleAtom).status).toBe('refresh-failed')
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    await expect(
      store.setter(retryHistoryRefreshAtom, { refreshProjection: async () => {} }),
    ).resolves.toBe('completed')
    expect(undo).toHaveBeenCalledTimes(1)
    lateRefresh.resolve()
    await flushMicrotasks()
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test(
    'successful finalization clears its ticket last so a subscriber replacement survives',
    async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const undo = jest.fn(async (request: HistoryUndoRequest) => exactAcknowledgement(request, 2))
    const redo = jest.fn(async (request: HistoryRedoRequest) => exactAcknowledgement(request, 3))
    const source: HistoryControllerPort = { undoTransaction: undo, redoTransaction: redo }
    let replacementStarted = false
    let replacement: Promise<unknown> | null = null
    const unsubscribe = store.sub(canRedoAtom, () => {
      if (replacementStarted || !store.getter(canRedoAtom)) return
      replacementStarted = true
      replacement = store.setter(runRedoHistoryAtom, {
        source,
        refreshProjection: async () => {},
      })
    })

    await expect(
      store.setter(runUndoHistoryAtom, {
        source,
        refreshProjection: async () => {},
      }),
    ).resolves.toBe('completed')
    expect(replacementStarted).toBe(true)
    expect(replacement).not.toBeNull()
    await expect(replacement!).resolves.toBe('completed')
    unsubscribe()

    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).toHaveBeenCalledTimes(1)
    expect(redo.mock.calls[0]![0]).toMatchObject({ revision: 2 })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(historyLifecycleAtom).status).toBe('ready')
    expect(store.getter(canUndoAtom)).toBe(true)
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
