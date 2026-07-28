import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'

import {
  DEFAULT_EDITING_COMMIT_TIMEOUT_MS,
  cancelEditingAtom,
  commitEditingAtom,
  editingCommitLifecycleAtom,
  editingIntentAtom,
  editingSessionAtom,
  retryEditingRefreshAtom,
  runEditingCommitAtom,
  startEditingAtom,
  updateEditingDraftState,
  type EditingCommitAcknowledgement,
  type EditingCommitOutcome,
  type EditingCommitRequest,
  type EditingControllerPort,
  type EditingSessionState,
  type EditingStartInput,
  type RetryEditingRefreshInput,
  type RunEditingCommitInput,
} from '../src/editing'
import {
  acquireHistoryProducerReservationAtom,
  canUndoAtom,
  historyStackAtom,
  pushHistoryAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
} from '../src/history'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

function startCellEdit(store: ReturnType<typeof createStore>, draft = '=B2+2') {
  store.setter(startEditingAtom, {
    sheetId: 'sheet-1',
    cell: { row: 4, col: 2 },
    draft,
    source: 'cell',
  })
}

function expectHistoryLaneAvailable(store: ReturnType<typeof createStore>) {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation === null) throw new Error('expected history producer lane to be available')
  expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
}

describe('editing core', () => {
  test('starts from a cell source and keeps a bounded session only', () => {
    const store = createStore()
    const input: EditingStartInput = {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      draft: '=A1+1',
      source: 'cell',
    }

    store.setter(startEditingAtom, input)

    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'drafting',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 2, col: 3 },
        source: 'cell',
      },
      draft: '=A1+1',
      diagnostic: null,
    })
    expect(store.getter(editingIntentAtom)).toEqual({
      type: 'editing.start',
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      source: 'cell',
    })
  })

  test('updates draft from formula bar and paste without widening the session', () => {
    const state: EditingSessionState = {
      status: 'drafting',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'formula-bar',
      },
      draft: '=SUM(A1:A3)',
      diagnostic: null,
    }

    const afterFormulaBar = updateEditingDraftState(state, {
      draft: '=SUM(A1:A3)+1',
      source: 'formula-bar',
    })
    const afterPaste = updateEditingDraftState(afterFormulaBar, {
      draft: '42',
      source: 'paste',
    })

    expect(afterFormulaBar).toMatchObject({
      status: 'drafting',
      draft: '=SUM(A1:A3)+1',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'formula-bar',
      },
    })
    expect(afterPaste).toMatchObject({
      draft: '42',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 1, col: 1 },
        source: 'paste',
      },
    })
  })

  test('stages a legacy commit intent without clearing the session, then can cancel', () => {
    const store = createStore()

    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      draft: '=B2+1',
      source: 'cell',
    })

    const commitIntent = store.setter(commitEditingAtom, {
      input: '=B2+2',
      move: 'down',
      source: 'cell',
    })

    expect(commitIntent).toEqual({
      type: 'editing.commit',
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      source: 'cell',
      input: '=B2+2',
      move: 'down',
    })
    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'drafting',
      source: {
        sheetId: 'sheet-1',
        cell: { row: 4, col: 2 },
        source: 'cell',
      },
      draft: '=B2+2',
      diagnostic: null,
    })

    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      draft: 'text',
      source: 'paste',
    })

    const cancelIntent = store.setter(cancelEditingAtom)

    expect(cancelIntent).toEqual({
      type: 'editing.cancel',
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
      source: 'paste',
    })
    expect(store.getter(editingSessionAtom)).toEqual({
      status: 'cancelled',
      source: null,
      draft: '',
      diagnostic: null,
    })
  })

  test('ignores commit when no edit session is active', () => {
    const store = createStore()

    expect(store.setter(commitEditingAtom, { input: 'noop', source: 'cell' })).toBeNull()
    expect(store.getter(editingIntentAtom)).toBeNull()
  })

  test(
    'does not publish a ticket or launch transport while another history producer owns the lane',
    async () => {
    const store = createStore()
    let transportCalls = 0
    startCellEdit(store, 'blocked by history')
    const sessionBefore = store.getter(editingSessionAtom)
    const reservation = store.setter(acquireHistoryProducerReservationAtom)
    expect(reservation).not.toBeNull()
    if (reservation === null) throw new Error('expected external history reservation')

    await expect(
      store.setter(runEditingCommitAtom, {
        source: {
          async setCellInput(request) {
            transportCalls += 1
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              revision: 'must-not-run',
            }
          },
        },
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('blocked')

    expect(transportCalls).toBe(0)
    expect(store.getter(editingSessionAtom)).toBe(sessionBefore)
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0, entries: [] })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
  })

  test('snapshots caller getters once and preserves the source method receiver', async () => {
    const store = createStore()
    startCellEdit(store, 'receiver')
    const inputReads: Record<string, number> = {}
    let methodReads = 0
    let receiver: unknown
    let refreshCalls = 0

    const execute = async function (
      this: unknown,
      request: EditingCommitRequest,
    ): Promise<EditingCommitAcknowledgement> {
      receiver = this
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 'rev-receiver',
      }
    }
    const source = Object.defineProperty({}, 'setCellInput', {
      get() {
        methodReads += 1
        if (methodReads > 1) throw new Error('method getter was re-read')
        return execute
      },
    }) as EditingControllerPort
    const count = <T>(key: string, value: T) => ({
      get() {
        inputReads[key] = (inputReads[key] ?? 0) + 1
        if (inputReads[key] > 1) throw new Error(`${key} getter was re-read`)
        return value
      },
    })
    const input = Object.defineProperties(
      {},
      {
        source: count('source', source),
        commitSource: count('commitSource', 'formula-bar'),
        move: count('move', 'down'),
        refreshProjection: count('refreshProjection', async () => {
          refreshCalls += 1
        }),
        timeoutMs: count('timeoutMs', 25_000),
      },
    ) as RunEditingCommitInput

    await expect(store.setter(runEditingCommitAtom, input)).resolves.toBe('completed')

    expect(inputReads).toEqual({
      source: 1,
      commitSource: 1,
      move: 1,
      refreshProjection: 1,
      timeoutMs: 1,
    })
    expect(methodReads).toBe(1)
    expect(receiver).toBe(source)
    expect(refreshCalls).toBe(1)
  })

  test('caller getter re-entry cannot overtake the replacement ticket it publishes', async () => {
    const store = createStore()
    startCellEdit(store, 'getter reentry')
    let replacement: Promise<EditingCommitOutcome> | undefined
    let replacementTransportCalls = 0
    let outerTransportCalls = 0
    const reads: Record<string, number> = {}
    let methodReads = 0

    const replacementInput: RunEditingCommitInput = {
      source: {
        async setCellInput(request) {
          replacementTransportCalls += 1
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 'rev-replacement',
          }
        },
      },
      refreshProjection: async () => undefined,
    }
    const outerSource = Object.defineProperty({}, 'setCellInput', {
      get() {
        methodReads += 1
        return async (request: EditingCommitRequest) => {
          outerTransportCalls += 1
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 'must-not-run',
          }
        }
      },
    }) as EditingControllerPort
    const once = <T>(key: string, value: () => T) => ({
      get() {
        reads[key] = (reads[key] ?? 0) + 1
        if (reads[key] > 1) throw new Error(`${key} getter was re-read`)
        return value()
      },
    })
    const outerInput = Object.defineProperties(
      {},
      {
        source: once('source', () => {
          replacement = store.setter(runEditingCommitAtom, replacementInput)
          return outerSource
        }),
        commitSource: once('commitSource', () => 'cell'),
        move: once('move', () => 'none'),
        refreshProjection: once('refreshProjection', () => async () => undefined),
        timeoutMs: once('timeoutMs', () => 25_000),
      },
    ) as RunEditingCommitInput

    await expect(store.setter(runEditingCommitAtom, outerInput)).resolves.toBe('blocked')
    expect(replacement).toBeDefined()
    await expect(replacement).resolves.toBe('completed')

    expect(reads).toEqual({
      source: 1,
      commitSource: 1,
      move: 1,
      refreshProjection: 1,
      timeoutMs: 1,
    })
    expect(methodReads).toBe(1)
    expect(outerTransportCalls).toBe(0)
    expect(replacementTransportCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test('an acquisition notification replacement remains authoritative', async () => {
    const store = createStore()
    store.setter(pushHistoryAtom, {
      transactionId: 'editing-acquire-seed',
      kind: 'cell.set-input',
      sheetId: 'sheet-1',
      projectionRevision: 1,
    })
    startCellEdit(store, 'original')
    let replaced = false
    let transportCalls = 0
    const unsubscribe = store.sub(canUndoAtom, () => {
      if (!replaced && !store.getter(canUndoAtom)) {
        replaced = true
        store.setter(startEditingAtom, {
          sheetId: 'replacement-sheet',
          cell: { row: 7, col: 8 },
          draft: 'replacement',
          source: 'keyboard',
        })
      }
    })

    const outcome = await store.setter(runEditingCommitAtom, {
      source: {
        async setCellInput(request) {
          transportCalls += 1
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 2,
          }
        },
      },
      refreshProjection: async () => undefined,
    })
    unsubscribe()

    expect(outcome).toBe('blocked')
    expect(replaced).toBe(true)
    expect(transportCalls).toBe(0)
    expect(store.getter(editingSessionAtom)).toMatchObject({
      status: 'drafting',
      source: {
        sheetId: 'replacement-sheet',
        cell: { row: 7, col: 8 },
      },
      draft: 'replacement',
    })
    expectHistoryLaneAvailable(store)
  })

  test('freezes one safe request and serializes formula-bar/grid re-entry onto one lane', async () => {
    const store = createStore()
    const acknowledgement = deferred<EditingCommitAcknowledgement>()
    const requests: EditingCommitRequest[] = []
    startCellEdit(store)

    const first = store.setter(runEditingCommitAtom, {
      source: {
        setCellInput(request) {
          requests.push(request)
          return acknowledgement.promise
        },
      },
      commitSource: 'formula-bar',
      move: 'down',
      refreshProjection: async () => undefined,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getter(editingCommitLifecycleAtom)).toMatchObject({
      status: 'pending',
      sheetId: 'sheet-1',
      cell: { row: 4, col: 2 },
    })
    expect(store.getter(editingSessionAtom)).toMatchObject({
      status: 'drafting',
      draft: '=B2+2',
    })
    expect(requests).toHaveLength(1)
    expect(Number.isSafeInteger(requests[0].requestId)).toBe(true)
    expect(requests[0].requestId).toBeGreaterThan(0)
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(runEditingCommitAtom, {
        source: {
          async setCellInput(request) {
            return { sheetId: request.sheetId }
          },
        },
        commitSource: 'cell',
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('blocked')
    expect(requests).toHaveLength(1)

    acknowledgement.resolve({
      sheetId: requests[0].sheetId,
      requestId: requests[0].requestId,
      revision: 'rev-2',
    })
    await expect(first).resolves.toBe('completed')
    expect(store.getter(editingSessionAtom).status).toBe('idle')
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1 })
    expectHistoryLaneAvailable(store)
  })

  test(
    'reads an accessor acknowledgement exactly once and rejects an out-of-target range',
    async () => {
    const store = createStore()
    startCellEdit(store, 'ack accessors')
    const ackReads: Record<string, number> = {}
    const rangeReads: Record<string, number> = {}
    let blockedReentry = false
    const once = <T>(reads: Record<string, number>, key: string, value: () => T) => ({
      get() {
        reads[key] = (reads[key] ?? 0) + 1
        if (reads[key] > 1) throw new Error(`${key} getter was re-read`)
        return value()
      },
    })

    const outcome = await store.setter(runEditingCommitAtom, {
      source: {
        async setCellInput(request) {
          const affectedRange = Object.defineProperties(
            {},
            {
              rowStart: once(rangeReads, 'rowStart', () => request.row),
              rowEnd: once(rangeReads, 'rowEnd', () => request.row),
              colStart: once(rangeReads, 'colStart', () => request.col),
              colEnd: once(rangeReads, 'colEnd', () => request.col),
            },
          )
          return Object.defineProperties(
            {},
            {
              sheetId: once(ackReads, 'sheetId', () => request.sheetId),
              requestId: once(ackReads, 'requestId', () => request.requestId),
              revision: once(ackReads, 'revision', () => {
                blockedReentry =
                  store.setter(cancelEditingAtom) === null &&
                  store.setter(startEditingAtom, {
                    sheetId: 'must-not-replace',
                    cell: { row: 0, col: 0 },
                    draft: 'must-not-replace',
                    source: 'cell',
                  }).draft === 'ack accessors'
                return 'rev-accessors'
              }),
              affectedRange: once(ackReads, 'affectedRange', () => affectedRange),
            },
          ) as EditingCommitAcknowledgement
        },
      },
      refreshProjection: async () => undefined,
    })

    expect(outcome).toBe('completed')
    expect(ackReads).toEqual({ sheetId: 1, requestId: 1, revision: 1, affectedRange: 1 })
    expect(rangeReads).toEqual({ rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 })
    expect(blockedReentry).toBe(true)

    const uncertainStore = createStore()
    startCellEdit(uncertainStore, 'outside range')
    await expect(
      uncertainStore.setter(runEditingCommitAtom, {
        source: {
          async setCellInput(request) {
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              revision: 'rev-outside',
              affectedRange: {
                rowStart: request.row + 1,
                rowEnd: request.row + 1,
                colStart: request.col,
                colEnd: request.col,
              },
            }
          },
        },
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('outcome-unknown')
    expect(uncertainStore.getter(historyStackAtom).entries).toHaveLength(0)
    expect(uncertainStore.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('a thrown acknowledgement getter fails closed and retains the exact ticket', async () => {
    const store = createStore()
    startCellEdit(store, 'throwing ack')
    let transportCalls = 0
    const source: EditingControllerPort = {
      async setCellInput() {
        transportCalls += 1
        return Object.defineProperty({}, 'sheetId', {
          get() {
            throw new Error('host ACK getter failed')
          },
        }) as EditingCommitAcknowledgement
      },
    }

    await expect(
      store.setter(runEditingCommitAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('outcome-unknown')

    expect(store.getter(editingCommitLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(
      store.setter(runEditingCommitAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('blocked')
    expect(transportCalls).toBe(1)
  })

  test('retains the frozen draft after a rejected transport and permits an explicit retry', async () => {
    const store = createStore()
    let attempts = 0
    const seenInputs: string[] = []
    startCellEdit(store, '=SUM(A1:A3)')

    const source = {
      async setCellInput(request: EditingCommitRequest) {
        attempts += 1
        seenInputs.push(request.input)
        if (attempts === 1) throw new Error('backend rejected edit')
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'rev-retry',
        }
      },
    }

    await expect(
      store.setter(runEditingCommitAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('rejected')
    expect(store.getter(editingCommitLifecycleAtom).status).toBe('rejected')
    expect(store.getter(editingSessionAtom)).toMatchObject({
      status: 'drafting',
      draft: '=SUM(A1:A3)',
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    // The lane and history reservation are released: a fresh reservation and
    // an explicit retry are both immediately available.
    const probe = store.setter(acquireHistoryProducerReservationAtom)
    expect(probe).not.toBeNull()
    if (probe !== null) store.setter(releaseHistoryProducerReservationAtom, probe)

    await expect(
      store.setter(runEditingCommitAtom, {
        source,
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    expect(attempts).toBe(2)
    expect(seenInputs).toEqual(['=SUM(A1:A3)', '=SUM(A1:A3)'])
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  test.each([
    ['mismatched request id', (request: EditingCommitRequest) => request.requestId + 1, 'rev-3'],
    ['zero revision', (request: EditingCommitRequest) => request.requestId, 0],
  ])(
    'treats a %s acknowledgement as outcome-unknown without history or resend',
    async (_label, acknowledgementRequestId, revision) => {
      const store = createStore()
      let transportCalls = 0
      startCellEdit(store, 'uncertain')
      const source = {
        async setCellInput(request: EditingCommitRequest) {
          transportCalls += 1
          return {
            sheetId: request.sheetId,
            requestId: acknowledgementRequestId(request),
            revision,
          }
        },
      }

      await expect(
        store.setter(runEditingCommitAtom, {
          source,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('outcome-unknown')
      expect(store.getter(editingCommitLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(editingSessionAtom)).toMatchObject({
        status: 'drafting',
        draft: 'uncertain',
      })
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
      await expect(
        store.setter(runEditingCommitAtom, {
          source,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('blocked')
      expect(store.setter(cancelEditingAtom)).toBeNull()
      expect(transportCalls).toBe(1)
    },
  )

  test(
    'retains the ticket and reservation when the exact ACK cannot be mirrored into history',
    async () => {
    const store = createStore()
    let transportCalls = 0
    startCellEdit(store, 'history failure')
    const pushReservedHistoryWrite = pushReservedHistoryAtom.write
    pushReservedHistoryAtom.write = () => false
    try {
      await expect(
        store.setter(runEditingCommitAtom, {
          source: {
            async setCellInput(request) {
              transportCalls += 1
              return {
                sheetId: request.sheetId,
                requestId: request.requestId,
                revision: 'rev-history-rejected',
              }
            },
          },
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('outcome-unknown')
    } finally {
      pushReservedHistoryAtom.write = pushReservedHistoryWrite
    }

    expect(transportCalls).toBe(1)
    expect(store.getter(editingCommitLifecycleAtom)).toMatchObject({
      status: 'outcome-unknown',
      acknowledgedRevision: 'rev-history-rejected',
    })
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 0, entries: [] })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    await expect(
      store.setter(runEditingCommitAtom, {
        source: {
          async setCellInput() {
            transportCalls += 1
            throw new Error('must not resend')
          },
        },
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('blocked')
    expect(transportCalls).toBe(1)
  })

  test('records history once and retries only refresh after an exact acknowledgement', async () => {
    const store = createStore()
    let transportCalls = 0
    let refreshCalls = 0
    startCellEdit(store, 'acknowledged')
    const refreshProjection = async () => {
      refreshCalls += 1
      if (refreshCalls === 1) throw new Error('projection unavailable')
    }

    await expect(
      store.setter(runEditingCommitAtom, {
        source: {
          async setCellInput(request) {
            transportCalls += 1
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              revision: 42,
            }
          },
        },
        refreshProjection,
      }),
    ).resolves.toBe('refresh-failed')
    expect(store.getter(editingCommitLifecycleAtom)).toMatchObject({
      status: 'refresh-failed',
      acknowledgedRevision: 42,
    })
    expect(store.getter(editingSessionAtom).draft).toBe('acknowledged')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await expect(
      store.setter(runEditingCommitAtom, {
        source: {},
        refreshProjection,
      }),
    ).resolves.toBe('blocked')
    await expect(store.setter(retryEditingRefreshAtom, { refreshProjection })).resolves.toBe(
      'completed',
    )
    expect(transportCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(editingSessionAtom).status).toBe('idle')
    expectHistoryLaneAvailable(store)
  })

  test(
    'uses finite custom/default mutation deadlines and ignores late fulfilment or rejection',
    async () => {
    jest.useFakeTimers()
    try {
      const fulfilledStore = createStore()
      const fulfilledGate = deferred<EditingCommitAcknowledgement>()
      const fulfilledRequests: EditingCommitRequest[] = []
      startCellEdit(fulfilledStore, 'late fulfilment')
      const fulfilledCommit = fulfilledStore.setter(runEditingCommitAtom, {
        source: {
          setCellInput(request) {
            fulfilledRequests.push(request)
            return fulfilledGate.promise
          },
        },
        refreshProjection: async () => undefined,
        timeoutMs: 25,
      })
      await flushMicrotasks()
      expect(fulfilledRequests).toHaveLength(1)

      await jest.advanceTimersByTimeAsync(24)
      expect(fulfilledStore.getter(editingCommitLifecycleAtom).status).toBe('pending')
      await jest.advanceTimersByTimeAsync(1)
      await expect(fulfilledCommit).resolves.toBe('outcome-unknown')
      fulfilledGate.resolve({
        sheetId: fulfilledRequests[0].sheetId,
        requestId: fulfilledRequests[0].requestId,
        revision: 'late-revision',
      })
      await flushMicrotasks()
      expect(fulfilledStore.getter(editingCommitLifecycleAtom).status).toBe('outcome-unknown')
      expect(fulfilledStore.getter(historyStackAtom).entries).toHaveLength(0)
      expect(fulfilledStore.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      const rejectedStore = createStore()
      const rejectedGate = deferred<EditingCommitAcknowledgement>()
      let rejectedTransportCalls = 0
      startCellEdit(rejectedStore, 'late rejection')
      const rejectedCommit = rejectedStore.setter(runEditingCommitAtom, {
        source: {
          setCellInput() {
            rejectedTransportCalls += 1
            return rejectedGate.promise
          },
        },
        refreshProjection: async () => undefined,
        // Invalid values safely select the 15 second default.
        timeoutMs: 0,
      })
      await flushMicrotasks()
      await jest.advanceTimersByTimeAsync(DEFAULT_EDITING_COMMIT_TIMEOUT_MS - 1)
      expect(rejectedStore.getter(editingCommitLifecycleAtom).status).toBe('pending')
      await jest.advanceTimersByTimeAsync(1)
      await expect(rejectedCommit).resolves.toBe('outcome-unknown')
      rejectedGate.reject(new Error('late rejection is still observed'))
      await flushMicrotasks()

      expect(rejectedTransportCalls).toBe(1)
      expect(rejectedStore.getter(editingCommitLifecycleAtom).status).toBe('outcome-unknown')
      expect(rejectedStore.getter(historyStackAtom).entries).toHaveLength(0)
      expect(rejectedStore.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  test(
    'retry freezes its getters, times out only refresh, and never resends or re-pushes',
    async () => {
    jest.useFakeTimers()
    try {
      const store = createStore()
      let transportCalls = 0
      let initialRefreshCalls = 0
      startCellEdit(store, 'refresh retry')
      await expect(
        store.setter(runEditingCommitAtom, {
          source: {
            async setCellInput(request) {
              transportCalls += 1
              return {
                sheetId: request.sheetId,
                requestId: request.requestId,
                revision: 'rev-refresh-retry',
              }
            },
          },
          refreshProjection: async () => {
            initialRefreshCalls += 1
            throw new Error('initial refresh failed')
          },
        }),
      ).resolves.toBe('refresh-failed')
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)

      const retryGate = deferred<void>()
      let retryRefreshReads = 0
      let retryTimeoutReads = 0
      let retryRefreshCalls = 0
      const retryInput = Object.defineProperties(
        {},
        {
          refreshProjection: {
            get() {
              retryRefreshReads += 1
              if (retryRefreshReads > 1) throw new Error('retry refresh getter re-read')
              return () => {
                retryRefreshCalls += 1
                return retryGate.promise
              }
            },
          },
          timeoutMs: {
            get() {
              retryTimeoutReads += 1
              if (retryTimeoutReads > 1) throw new Error('retry timeout getter re-read')
              return 20
            },
          },
        },
      ) as RetryEditingRefreshInput
      const retry = store.setter(retryEditingRefreshAtom, retryInput)
      await flushMicrotasks()
      await jest.advanceTimersByTimeAsync(20)
      await expect(retry).resolves.toBe('refresh-failed')

      expect(retryRefreshReads).toBe(1)
      expect(retryTimeoutReads).toBe(1)
      expect(retryRefreshCalls).toBe(1)
      expect(transportCalls).toBe(1)
      expect(initialRefreshCalls).toBe(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      retryGate.reject(new Error('late retry rejection'))
      await flushMicrotasks()
      expect(store.getter(editingCommitLifecycleAtom).status).toBe('refresh-failed')

      const nestedGate = deferred<void>()
      let nestedRetry: Promise<EditingCommitOutcome> | undefined
      let outerRefreshReads = 0
      let outerTimeoutReads = 0
      let nestedRefreshCalls = 0
      const reentrantRetryInput = Object.defineProperties(
        {},
        {
          refreshProjection: {
            get() {
              outerRefreshReads += 1
              nestedRetry = store.setter(retryEditingRefreshAtom, {
                refreshProjection: () => {
                  nestedRefreshCalls += 1
                  return nestedGate.promise
                },
                timeoutMs: 100,
              })
              return async () => {
                throw new Error('superseded retry callback must not run')
              }
            },
          },
          timeoutMs: {
            get() {
              outerTimeoutReads += 1
              return 100
            },
          },
        },
      ) as RetryEditingRefreshInput
      await expect(store.setter(retryEditingRefreshAtom, reentrantRetryInput)).resolves.toBe(
        'blocked',
      )
      expect(nestedRetry).toBeDefined()
      expect(outerRefreshReads).toBe(1)
      expect(outerTimeoutReads).toBe(1)
      expect(nestedRefreshCalls).toBe(1)

      nestedGate.resolve()
      await expect(nestedRetry).resolves.toBe('completed')
      expect(transportCalls).toBe(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(editingSessionAtom).status).toBe('idle')
      expectHistoryLaneAvailable(store)
    } finally {
      jest.useRealTimers()
    }
  })

  test(
    'push/release/session subscribers cannot replace a ticket before active clears last',
    async () => {
    const store = createStore()
    startCellEdit(store, 'clear active last')
    let pushReplacementAttempts = 0
    let releaseReplacementAttempts = 0
    let idleReplacementAttempts = 0
    const replacementInput: EditingStartInput = {
      sheetId: 'replacement',
      cell: { row: 9, col: 9 },
      draft: 'replacement',
      source: 'keyboard',
    }
    const unsubscribeHistory = store.sub(historyStackAtom, () => {
      if (pushReplacementAttempts === 0 && store.getter(historyStackAtom).entries.length === 1) {
        pushReplacementAttempts += 1
        store.setter(startEditingAtom, replacementInput)
      }
    })
    const unsubscribeRelease = store.sub(canUndoAtom, () => {
      if (releaseReplacementAttempts === 0 && store.getter(canUndoAtom)) {
        releaseReplacementAttempts += 1
        store.setter(startEditingAtom, replacementInput)
      }
    })
    const unsubscribeSession = store.sub(editingSessionAtom, () => {
      if (idleReplacementAttempts === 0 && store.getter(editingSessionAtom).status === 'idle') {
        idleReplacementAttempts += 1
        store.setter(startEditingAtom, replacementInput)
      }
    })

    await expect(
      store.setter(runEditingCommitAtom, {
        source: {
          async setCellInput(request) {
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              revision: 'rev-clear-last',
            }
          },
        },
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')
    unsubscribeHistory()
    unsubscribeRelease()
    unsubscribeSession()

    expect(pushReplacementAttempts).toBe(1)
    expect(releaseReplacementAttempts).toBe(1)
    expect(idleReplacementAttempts).toBe(1)
    expect(store.getter(editingSessionAtom).status).toBe('idle')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)

    store.setter(startEditingAtom, replacementInput)
    expect(store.getter(editingSessionAtom)).toMatchObject({
      status: 'drafting',
      source: { sheetId: 'replacement', cell: { row: 9, col: 9 } },
      draft: 'replacement',
    })
  })
})
