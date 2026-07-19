/** @jsxImportSource solid-js */

/**
 * Parity #04 — merge on the WORKER path, UI layer (jsdom) over the real
 * in-process TS worker stack.
 *
 * The toolbar merge dropdown gates on port EXISTENCE
 * (`!backend.mergeRange`); now that the worker adapter implements the
 * host-overlay ports the button unlocks on the worker demos without any
 * toolbar change. This suite pins that unlock end-to-end: select B2:C3,
 * toolbar merge-center, the grid renders the anchor with
 * rowspan/colspan from the projection overlay, one `range.merge`
 * history entry lands, and Ctrl+Z splits the merge back apart through
 * the host-orchestrated transaction log.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
  historyStackAtom,
  selectCellAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'

import {
  installWorkerRuntimeTs,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike } from '../src-vnext/adapter'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 6,
  viewportWidth: 6,
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

function td(container: HTMLElement, addr: string): HTMLTableCellElement | null {
  return container.querySelector(`td[data-cell-addr="${addr}"]`)
}

describe('worker path merge — toolbar unlock and grid rendering (jsdom)', () => {
  it('merge button is enabled, merge-center spans the anchor, Ctrl+Z splits it apart', async () => {
    const worker = createInProcessTsWorker()
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => worker,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    })
    await backend.ready()

    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 1 } })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 2, col: 2 },
      extend: true,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    // Capability unlock: the dropdown anchor reads `!backend.mergeRange`
    // — present on the worker adapter now, so the button is enabled.
    const mergeButton = container.querySelector(
      '[data-testid="toolbar-btn-merge"]',
    ) as HTMLButtonElement
    expect(mergeButton.disabled).toBe(false)

    fireEvent.click(mergeButton)
    const mergeCenter = (await waitFor(() => {
      const item = container.querySelector('[data-testid="toolbar-merge-center"]')
      expect(item).not.toBeNull()
      return item
    })) as HTMLButtonElement
    expect(mergeCenter.disabled).toBe(false)
    fireEvent.click(mergeCenter)

    // The projection round-trips through the worker adapter overlay and
    // the grid renders the anchor spanning B2:C3.
    await waitFor(() => {
      const anchor = td(container, 'B2')
      expect(anchor?.getAttribute('data-merge-anchor')).toBe('true')
      expect(anchor?.getAttribute('rowspan')).toBe('2')
      expect(anchor?.getAttribute('colspan')).toBe('2')
    })
    expect(td(container, 'C3')).toBeNull()

    // Exactly one history entry for the whole user action.
    const stack = store.getter(historyStackAtom)
    expect(stack.entries).toHaveLength(1)
    expect(stack.entries[0]?.kind).toBe('range.merge')
    expect(stack.cursor).toBe(1)

    // Ctrl+Z replays the merge record through the worker adapter and the
    // grid splits back apart.
    const grid = container.querySelector('[data-testid="grid"]')!
    fireEvent.keyDown(grid, { key: 'z', ctrlKey: true })
    await waitFor(() => {
      const anchor = td(container, 'B2')
      expect(anchor?.getAttribute('data-merge-anchor')).toBe('false')
      expect(anchor?.getAttribute('rowspan')).toBe('1')
      expect(anchor?.getAttribute('colspan')).toBe('1')
      expect(td(container, 'C3')).not.toBeNull()
      expect(store.getter(historyStackAtom).cursor).toBe(0)
    })

    backend.dispose()
  })
})
