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
} from '@einfach/spreadsheet-ui-core'
import { historyStackAtom, pushHistoryAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetHistoryTimeline } from '../src-vnext/history'

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

function entry(transactionId: string, kind: HistoryEntry['kind'], rev: number): HistoryEntry {
  return {
    transactionId,
    kind,
    sheetId: 'sheet-1',
    projectionRevision: rev,
  }
}

function seedEntries(store: ReturnType<typeof createStore>, n: number) {
  for (let i = 0; i < n; i++) {
    store.setter(pushHistoryAtom, entry(`tx-${i}`, 'cell.set-input', i + 1))
  }
}

describe('SpreadsheetHistoryTimeline', () => {
  it('renders empty state when stack has no entries', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline')).toBeTruthy()
    expect(getByTestId('history-timeline-empty')).toBeTruthy()
    expect((getByTestId('history-timeline-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId('history-timeline-redo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders one list item per entry with kind label', () => {
    const store = createStore()
    const backend = createBaseBackend()
    seedEntries(store, 3)

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelectorAll('[data-testid^="history-timeline-entry-"]').length).toBe(3)
    const first = getByTestId('history-timeline-entry-0')
    expect(first.getAttribute('data-transaction-id')).toBe('tx-0')
    expect(first.getAttribute('data-kind')).toBe('cell.set-input')
    expect(first.textContent).toContain('cell.set-input')
    expect(first.textContent).toContain('rev 1')
  })

  it('shows cursor "N / M" and marks the current entry', () => {
    const store = createStore()
    const backend = createBaseBackend()
    seedEntries(store, 3)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline-cursor').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '3 / 3',
    )
    expect(getByTestId('history-timeline-entry-2').getAttribute('data-current')).toBe('true')
    expect(getByTestId('history-timeline-entry-1').getAttribute('data-current')).toBe('false')
  })

  it('Undo click calls backend.undoTransaction with the top entry transactionId', async () => {
    const store = createStore()
    seedEntries(store, 2)
    const undoSpy = jest.fn(
      async (req: UndoTransactionRequest): Promise<HistoryTransactionResult> => ({
        transactionId: req.transactionId,
        revision: 99,
      }),
    )
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))

    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1))
    expect(undoSpy.mock.calls[0]![0].transactionId).toBe('tx-1')
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
    expect(store.getter(historyStackAtom).inFlight).toBe(false)
  })

  it('Redo click after an undo calls backend.redoTransaction and advances the cursor', async () => {
    const store = createStore()
    seedEntries(store, 2)

    const undoSpy = jest.fn(
      async (req: UndoTransactionRequest): Promise<HistoryTransactionResult> => ({
        transactionId: req.transactionId,
      }),
    )
    const redoSpy = jest.fn(
      async (req: RedoTransactionRequest): Promise<HistoryTransactionResult> => ({
        transactionId: req.transactionId,
      }),
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
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))

    fireEvent.click(getByTestId('history-timeline-redo'))

    await waitFor(() => expect(redoSpy).toHaveBeenCalledTimes(1))
    expect(redoSpy.mock.calls[0]![0].transactionId).toBe('tx-1')
    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(2))
  })

  it('clicking an entry jumps to that point via repeated undo/redo dispatches', async () => {
    const store = createStore()
    seedEntries(store, 4) // cursor=4

    const undoSpy = jest.fn(
      async (req: UndoTransactionRequest): Promise<HistoryTransactionResult> => ({
        transactionId: req.transactionId,
      }),
    )
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    // Jump to index 0 — i.e. cursor should land at 1 (entry 0 applied, entries 1..3 reverted)
    fireEvent.click(getByTestId('history-timeline-jump-0'))

    await waitFor(() => expect(store.getter(historyStackAtom).cursor).toBe(1))
    expect(undoSpy).toHaveBeenCalledTimes(3)
    expect(undoSpy.mock.calls[0]![0].transactionId).toBe('tx-3')
    expect(undoSpy.mock.calls[1]![0].transactionId).toBe('tx-2')
    expect(undoSpy.mock.calls[2]![0].transactionId).toBe('tx-1')
  })

  it('Undo with no backend.undoTransaction is a no-op: entry stays on the stack (HIGH #6 regression guard)', async () => {
    // Previously dispatchUndo silently consumed the entry and marked
    // it ok-resolved when the backend lacked undoTransaction, which
    // made Ctrl+Z lie about having reverted the workbook. The new
    // contract: dispatchUndo refuses to touch the stack when the
    // backend can't undo. Hosts that record an entry must gate on
    // `recordHistoryEntry` (or call `backendSupportsUndo`).
    const store = createStore()
    seedEntries(store, 1)
    const backend = createBaseBackend() // no undoTransaction

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    // Give the async dispatch a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const state = store.getter(historyStackAtom)
    expect(state.cursor).toBe(1)
    expect(state.entries).toHaveLength(1)
    expect(state.inFlight).toBe(false)
  })

  it('clears the stack when undoTransaction throws', async () => {
    const store = createStore()
    seedEntries(store, 2)

    const undoSpy = jest.fn(
      async (_req: UndoTransactionRequest): Promise<HistoryTransactionResult> => {
        throw new Error('rollback failed')
      },
    )
    const backend: SpreadsheetBackend = { ...createBaseBackend(), undoTransaction: undoSpy }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('history-timeline-undo'))
    await waitFor(() => expect(store.getter(historyStackAtom).entries.length).toBe(0))
    expect(store.getter(historyStackAtom).cursor).toBe(0)
    expect(store.getter(historyStackAtom).inFlight).toBe(false)
  })

  it('applies a custom formatTimestamp callback to entry labels', () => {
    const store = createStore()
    const backend = createBaseBackend()
    seedEntries(store, 1)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetHistoryTimeline formatTimestamp={(e) => `T${e.projectionRevision}`} />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('history-timeline-entry-0').textContent).toContain('T1')
  })
})
