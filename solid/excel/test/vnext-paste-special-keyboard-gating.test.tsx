/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  copyClipboardAtom,
  pasteSpecialOpenAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

/**
 * Wave 7.3 review MEDIUM #3: the global Ctrl+Alt+V shortcut must not
 * pop the Paste Special dialog when (a) the backend omits `pasteRange`
 * or (b) the clipboard has no copyable payload. The core keyboard
 * dispatcher under `vanilla/spreadsheet-ui-core/src/keyboard` stays a
 * pure intent translator; gating lives at the host wiring layer in
 * `SpreadsheetGrid`.
 */

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({ row, col, displayValue: `${row},${col}` })
    }
  }
  return cells
}

function createBackend(opts: { withPasteRange: boolean }): SpreadsheetBackend {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
      return result
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },
  }
  if (opts.withPasteRange) {
    backend.pasteRange = async (request) => ({
      kind: 'paste-range',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision,
      affectedRange: request.target,
    })
  }
  return backend
}

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

function seedClipboardSource(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    },
  })
}

describe('Ctrl+Alt+V dispatcher gating', () => {
  it('does not open the dialog when backend lacks pasteRange capability', async () => {
    const store = createStore()
    const backend = createBackend({ withPasteRange: false })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    // Capability missing → dialog never opens.
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('does not open the dialog when the clipboard has no copyable payload', async () => {
    const store = createStore()
    const backend = createBackend({ withPasteRange: true })
    // Note: NO copyClipboardAtom seed — clipboard.source / payload remain null.
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('opens the dialog when capability + clipboard payload are both present', async () => {
    const store = createStore()
    const backend = createBackend({ withPasteRange: true })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
  })
})
