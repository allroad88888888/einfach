/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  HistoryEntry,
  HistoryTransactionResult,
  RedoTransactionRequest,
  SpreadsheetBackend,
  UndoTransactionRequest,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  historyLifecycleAtom,
  historyStackAtom,
  pushHistoryAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetHistoryTimeline } from '../src-vnext/history'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function createBaseBackend(): SpreadsheetBackend {
  return {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
}

function entry(
  transactionId: string,
  kind: HistoryEntry['kind'],
  revision: number | string,
): HistoryEntry {
  return {
    transactionId,
    kind,
    sheetId: 'sheet-1',
    projectionRevision: revision,
  }
}

function seedEntries(store: ReturnType<typeof createStore>, count: number) {
  for (let index = 0; index < count; index += 1) {
    store.setter(pushHistoryAtom, entry(`tx-${index}`, 'cell.set-input', index + 1))
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

function exactAcknowledgement(
  request: UndoTransactionRequest | RedoTransactionRequest,
  revision: number | string = 99,
): HistoryTransactionResult {
  return {
    transactionId: request.transactionId,
    requestId: request.requestId,
    revision,
  }
}

function seedVisibleProjection(store: ReturnType<typeof createStore>) {
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request: undefined,
    result: {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      requestId: 0,
      revision: 'visible-base',
      cells: [],
    },
    error: undefined,
  })
}

describe('SpreadsheetHistoryTimeline', () => {
  it('renders the empty read-only Core projection', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline')).toBeTruthy()
    expect(getByTestId('history-timeline').getAttribute('data-lifecycle-status')).toBe('ready')
    expect(getByTestId('history-timeline-empty')).toBeTruthy()
    expect((getByTestId('history-timeline-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId('history-timeline-redo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps invalid Core seed revisions out of the timeline and starts no transport', () => {
    const store = createStore()
    for (const revision of [Number.NaN, Number.POSITIVE_INFINITY, '']) {
      expect(store.setter(pushHistoryAtom, entry('tx-invalid', 'cell.set-input', revision))).toBe(
        false,
      )
    }
    const undoSpy = jest.fn(async (request: UndoTransactionRequest) =>
      exactAcknowledgement(request),
    )
    const redoSpy = jest.fn(async (request: RedoTransactionRequest) =>
      exactAcknowledgement(request),
    )
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      undoTransaction: undoSpy,
      redoTransaction: redoSpy,
    }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline-empty')).toBeTruthy()
    fireEvent.click(getByTestId('history-timeline-undo'))
    fireEvent.click(getByTestId('history-timeline-redo'))
    expect(undoSpy).not.toHaveBeenCalled()
    expect(redoSpy).not.toHaveBeenCalled()
    expect(store.getter(historyLifecycleAtom)).toMatchObject({ status: 'ready', error: '' })
  })

  it('renders entries, a string revision, cursor, and current marker from Core', () => {
    const store = createStore()
    const backend = createBaseBackend()
    seedEntries(store, 2)
    store.setter(pushHistoryAtom, entry('tx-string', 'format.set', 'rev-string'))

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelectorAll('[data-testid^="history-timeline-entry-"]')).toHaveLength(3)
    expect(getByTestId('history-timeline-entry-0').getAttribute('data-transaction-id')).toBe('tx-0')
    expect(getByTestId('history-timeline-entry-2').textContent).toContain('rev rev-string')
    expect(getByTestId('history-timeline-cursor').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '3 / 3',
    )
    expect(getByTestId('history-timeline-entry-2').getAttribute('data-current')).toBe('true')
    expect(getByTestId('history-timeline-entry-1').getAttribute('data-current')).toBe('false')
  })

  it('publishes the strict request before transport and does not move the cursor before ACK', async () => {
    const store = createStore()
    seedEntries(store, 2)
    const acknowledgement = deferred<HistoryTransactionResult>()
    const undoSpy = jest.fn((_request: UndoTransactionRequest) => acknowledgement.promise)
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    fireEvent.click(getByTestId('history-timeline-undo'))

    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1))
    const request = undoSpy.mock.calls[0]![0]
    expect(request).toMatchObject({
      kind: 'undo-transaction',
      transactionId: 'tx-1',
      requestId: 1,
      revision: 2,
    })
    expect(Object.isFrozen(request)).toBe(true)
    expect(store.getter(historyStackAtom).cursor).toBe(2)
    expect(getByTestId('history-timeline').getAttribute('data-lifecycle-status')).toBe('pending')
    expect((getByTestId('history-timeline-undo') as HTMLButtonElement).disabled).toBe(true)

    acknowledgement.resolve(exactAcknowledgement(request, 'ack-revision'))
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('ready'))
    expect(undoSpy).toHaveBeenCalledTimes(1)
  })

  it('uses each exact ACK revision as the next Core undo or redo request base', async () => {
    const store = createStore()
    seedEntries(store, 2)
    const undoSpy = jest.fn(async (request: UndoTransactionRequest) =>
      exactAcknowledgement(request, request.requestId === 1 ? 3 : 5),
    )
    const redoSpy = jest.fn(async (request: RedoTransactionRequest) =>
      exactAcknowledgement(request, 4),
    )
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      undoTransaction: undoSpy,
      redoTransaction: redoSpy,
    }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1))
    expect(undoSpy.mock.calls[0]![0]).toMatchObject({ requestId: 1, revision: 2 })
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
    await waitFor(() =>
      expect((getByTestId('history-timeline-redo') as HTMLButtonElement).disabled).toBe(false),
    )

    fireEvent.click(getByTestId('history-timeline-redo'))
    await waitFor(() => expect(redoSpy).toHaveBeenCalledTimes(1))
    expect(redoSpy.mock.calls[0]![0]).toMatchObject({
      transactionId: 'tx-1',
      requestId: 2,
      revision: 3,
    })
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(2))
    await waitFor(() =>
      expect((getByTestId('history-timeline-undo') as HTMLButtonElement).disabled).toBe(false),
    )

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(2))
    expect(undoSpy.mock.calls[1]![0]).toMatchObject({
      transactionId: 'tx-1',
      requestId: 3,
      revision: 4,
    })
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
  })

  it('jumps through repeated Core undo commands without a Solid-owned cursor', async () => {
    const store = createStore()
    seedEntries(store, 4)
    const undoSpy = jest.fn(async (request: UndoTransactionRequest) =>
      exactAcknowledgement(request, request.revision ?? 0),
    )
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-jump-0'))

    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
    expect(undoSpy).toHaveBeenCalledTimes(3)
    expect(undoSpy.mock.calls.map(([request]) => request.transactionId)).toEqual([
      'tx-3',
      'tx-2',
      'tx-1',
    ])
  })

  it.each([
    [
      'missing requestId',
      (request: UndoTransactionRequest): HistoryTransactionResult => ({
        transactionId: request.transactionId,
        revision: 2,
      }),
    ],
    [
      'foreign requestId',
      (request: UndoTransactionRequest): HistoryTransactionResult => ({
        transactionId: request.transactionId,
        requestId: Number(request.requestId) + 100,
        revision: 2,
      }),
    ],
  ])('keeps the cursor and locks resend for a %s acknowledgement', async (_label, resultFor) => {
    const store = createStore()
    seedEntries(store, 1)
    const undoSpy = jest.fn(async (request: UndoTransactionRequest) => resultFor(request))
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('outcome-unknown'))

    expect(store.getter(historyStackAtom).cursor).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(getByTestId('history-timeline-status').getAttribute('data-status')).toBe(
      'outcome-unknown',
    )
    expect((getByTestId('history-timeline-undo') as HTMLButtonElement).disabled).toBe(true)
    expect(queryByTestId('history-timeline-retry-refresh')).toBeNull()
    fireEvent.click(getByTestId('history-timeline-undo'))
    expect(undoSpy).toHaveBeenCalledTimes(1)
  })

  it('retains history and marks OutcomeUnknown when transport rejects', async () => {
    const store = createStore()
    seedEntries(store, 2)
    const undoSpy = jest.fn(async (_request: UndoTransactionRequest) => {
      throw new Error('connection dropped after write boundary')
    })
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('outcome-unknown'))

    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 2, inFlight: false })
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
    expect(getByTestId('history-timeline-status').textContent).toContain('connection dropped')
    fireEvent.click(getByTestId('history-timeline-undo'))
    expect(undoSpy).toHaveBeenCalledTimes(1)
  })

  it('commits an exact ACK, exposes RefreshFailed, and retries refresh without resending undo', async () => {
    const store = createStore()
    seedEntries(store, 1)
    seedVisibleProjection(store)
    let refreshAttempt = 0
    const readVisibleProjection = jest.fn(
      async (request: VisibleProjectionRequest): Promise<VisibleProjectionResult> => {
        refreshAttempt += 1
        if (refreshAttempt === 1) throw new Error('projection unavailable')
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: request.window,
          requestId: request.requestId,
          revision: 'visible-fresh',
          cells: [],
        }
      },
    )
    const undoSpy = jest.fn(async (request: UndoTransactionRequest) =>
      exactAcknowledgement(request, 'ack-revision'),
    )
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      readVisibleProjection,
      undoTransaction: undoSpy,
    }

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('refresh-failed'))

    expect(store.getter(historyStackAtom).cursor).toBe(0)
    expect(undoSpy).toHaveBeenCalledTimes(1)
    expect(readVisibleProjection).toHaveBeenCalledTimes(1)
    expect(getByTestId('history-timeline-status').textContent).toContain('projection unavailable')
    expect(getByTestId('history-timeline-retry-refresh')).toBeTruthy()

    fireEvent.click(getByTestId('history-timeline-retry-refresh'))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('ready'))

    expect(readVisibleProjection).toHaveBeenCalledTimes(2)
    expect(undoSpy).toHaveBeenCalledTimes(1)
    expect(queryByTestId('history-timeline-retry-refresh')).toBeNull()
  })

  it('leaves an entry available when the backend lacks undo capability', async () => {
    const store = createStore()
    seedEntries(store, 1)
    const backend = createBaseBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(store.getter(historyLifecycleAtom).status).toBe('blocked'))
    expect(store.getter(historyStackAtom)).toMatchObject({ cursor: 1, inFlight: false })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  it('applies a custom formatTimestamp callback to entry labels', () => {
    const store = createStore()
    const backend = createBaseBackend()
    seedEntries(store, 1)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline formatTimestamp={(item) => `T${item.projectionRevision}`} />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline-entry-0').textContent).toContain('T1')
  })
})
