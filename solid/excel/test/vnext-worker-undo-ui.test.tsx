/** @jsxImportSource solid-js */

/**
 * Worker demo Ctrl+Z semantics — UI layer over the REAL in-process TS
 * worker stack (parity #15/#36).
 *
 * The history-dispatch capability gate (`backendSupportsUndo`) opens
 * automatically now that the worker adapter implements
 * `undoTransaction` / `redoTransaction`: committing a cell edit through
 * the real grid editor records a backend entry in the History timeline,
 * and Ctrl+Z / Ctrl+Y on the grid replay it through the worker engine.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { historyLifecycleAtom, historyStackAtom } from '@einfach/spreadsheet-ui-core'

import {
  installWorkerRuntimeTs,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike } from '../src-vnext/adapter'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetHistoryTimeline } from '../src-vnext/history'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 4,
  viewportWidth: 4,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 10,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

function createInProcessTsWorker(): WorkerLike {
  const toWorker: Array<(e: MessageEvent) => void> = []
  const toClient: Array<(e: MessageEvent) => void> = []
  const workerCtx: WorkerContext = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type, listener) {
      toWorker.push(listener)
    },
  }
  installWorkerRuntimeTs(workerCtx)
  return {
    postMessage(msg: unknown) {
      for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      toClient.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = toClient.indexOf(listener)
      if (index >= 0) toClient.splice(index, 1)
    },
    terminate() {},
  }
}

function gridCellText(container: HTMLElement, addr: string): string {
  return (
    container.querySelector(`[data-cell-addr="${addr}"] .spreadsheet-grid-cell-button`)
      ?.textContent ?? ''
  )
}

async function commitCellEdit(container: HTMLElement, addr: string, value: string) {
  fireEvent.click(
    container.querySelector(`[data-cell-addr="${addr}"] .spreadsheet-grid-cell-button`)!,
  )
  fireEvent.dblClick(container.querySelector(`[data-cell-addr="${addr}"]`)!)
  const editor = (await waitFor(() => {
    const input = container.querySelector('input.cell-input')
    expect(input).not.toBeNull()
    return input
  })) as HTMLInputElement
  fireEvent.input(editor, { target: { value } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  await waitFor(() => {
    expect(container.querySelector('input.cell-input')).toBeNull()
  })
}

describe('worker path Ctrl+Z semantics (grid + history timeline)', () => {
  it('records backend entries for grid edits and replays them via Ctrl+Z / Ctrl+Y', async () => {
    const worker = createInProcessTsWorker()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => worker,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })
    await backend.ready()

    const store = createStore()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
        <SpreadsheetHistoryTimeline data-testid="history-timeline" />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    await commitCellEdit(container, 'A1', '5')
    await commitCellEdit(container, 'A1', '7')
    await waitFor(() => {
      expect(gridCellText(container, 'A1')).toBe('7')
    })

    // The timeline shows two backend entries — the capability gate is
    // open on the worker path now that the port exists.
    await waitFor(() => {
      const stack = store.getter(historyStackAtom)
      expect(stack.entries).toHaveLength(2)
      expect(stack.cursor).toBe(2)
    })
    expect(
      container.querySelectorAll('[data-testid^="history-timeline-entry-"]'),
    ).toHaveLength(2)
    expect(
      container.querySelector('[data-testid="history-timeline-entry-0"]')?.getAttribute(
        'data-kind',
      ),
    ).toBe('cell.set-input')

    const grid = container.querySelector('[data-testid="grid"]')!

    // Each history action owns the transport lane until its refresh
    // settles, and the grid may repaint from the replay's cellsDirty
    // push before the ACK commits the cursor — so every step awaits the
    // cell text, the cursor, AND the lane returning to ready.
    const settled = (text: string, cursor: number) => async () => {
      await waitFor(() => {
        expect(gridCellText(container, 'A1')).toBe(text)
        expect(store.getter(historyStackAtom).cursor).toBe(cursor)
        expect(store.getter(historyLifecycleAtom).status).toBe('ready')
      })
    }

    // Ctrl+Z: back to the first committed value.
    fireEvent.keyDown(grid, { key: 'z', ctrlKey: true })
    await settled('5', 1)()

    // Second Ctrl+Z: back to the pristine cell.
    fireEvent.keyDown(grid, { key: 'z', ctrlKey: true })
    await settled('', 0)()

    // Ctrl+Y replays forward.
    fireEvent.keyDown(grid, { key: 'y', ctrlKey: true })
    await settled('5', 1)()

    backend.dispose()
  })

  it('timeline undo button drives the worker backend too', async () => {
    const worker = createInProcessTsWorker()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => worker,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })
    await backend.ready()

    const store = createStore()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
        <SpreadsheetHistoryTimeline data-testid="history-timeline" />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    await commitCellEdit(container, 'B2', 'hello')
    await waitFor(() => {
      expect(gridCellText(container, 'B2')).toBe('hello')
    })

    const undoButton = container.querySelector(
      '[data-testid="history-timeline-undo"]',
    ) as HTMLButtonElement
    await waitFor(() => {
      expect(undoButton.disabled).toBe(false)
    })
    fireEvent.click(undoButton)
    await waitFor(() => {
      expect(gridCellText(container, 'B2')).toBe('')
      expect(store.getter(historyStackAtom).cursor).toBe(0)
    })

    backend.dispose()
  })
})
