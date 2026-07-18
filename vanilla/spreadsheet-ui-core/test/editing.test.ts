import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
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
  type EditingCommitRequest,
  type EditingSessionState,
  type EditingStartInput,
} from '../src/editing'
import { historyStackAtom } from '../src/history'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function startCellEdit(store: ReturnType<typeof createStore>, draft = '=B2+2') {
  store.setter(startEditingAtom, {
    sheetId: 'sheet-1',
    cell: { row: 4, col: 2 },
    draft,
    source: 'cell',
  })
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
  })
})
