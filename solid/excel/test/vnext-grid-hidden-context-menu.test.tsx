/** @jsxImportSource solid-js */

import { createStore } from '@einfach/core'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  HideColumnsRequest,
  HideRowsRequest,
  SpreadsheetBackend,
  UnhideColumnsRequest,
  UnhideRowsRequest,
  ViewportSizeProjectionRequest,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  hideRowsAtom,
  selectColumnsAtom,
  selectRowsAtom,
  selectionAtom,
  viewportHiddenAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

beforeEach(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
})

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 8,
  viewportWidth: 5,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 10,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({ row, col, displayValue: `${row},${col}` })
    }
  }
  return cells
}

/** Full backend: persistence mirror ports + full-sheet hidden seed slices. */
function createHiddenBackend(
  initialRows: readonly number[] = [],
  initialCols: readonly number[] = [],
) {
  let rows = [...initialRows]
  let cols = [...initialCols]
  let revision = 1
  const sizeRequests: ViewportSizeProjectionRequest[] = []
  const hideRows: HideRowsRequest[] = []
  const unhideRows: UnhideRowsRequest[] = []
  const hideColumns: HideColumnsRequest[] = []
  const unhideColumns: UnhideColumnsRequest[] = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
    },
    async readRangeProjection(request) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: { ...request.range },
        requestId: request.requestId,
        revision: request.revision,
        cells: [],
      }
    },
    async readViewportSizeProjection(request) {
      sizeRequests.push(request)
      return {
        kind: 'viewport-size',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision ?? revision,
        rowHeights: [],
        colWidths: [],
        hiddenRowIndices: rows.filter(
          (index) => index >= request.window.rowStart && index <= request.window.rowEnd,
        ),
        hiddenColIndices: cols.filter(
          (index) => index >= request.window.colStart && index <= request.window.colEnd,
        ),
      }
    },
    async setCellInput(request) {
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async hideRows(request) {
      hideRows.push(request)
      rows = [...new Set([...rows, ...request.rowIndices])].sort((left, right) => left - right)
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async unhideRows(request) {
      unhideRows.push(request)
      rows = rows.filter((index) => !request.rowIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async hideColumns(request) {
      hideColumns.push(request)
      cols = [...new Set([...cols, ...request.colIndices])].sort((left, right) => left - right)
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async unhideColumns(request) {
      unhideColumns.push(request)
      cols = cols.filter((index) => !request.colIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
  }

  return { backend, sizeRequests, hideRows, unhideRows, hideColumns, unhideColumns }
}

/**
 * Worker-shaped backend: no hidden mutation ports, no hidden slices on the
 * sizes projection. Pre-flip these entry points were fail-closed here; the
 * UI-core canonical flip keeps them fully functional.
 */
function createNoHiddenPortBackend() {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
    },
    async readRangeProjection(request) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: { ...request.range },
        requestId: request.requestId,
        revision: request.revision,
        cells: [],
      }
    },
    async readViewportSizeProjection(request) {
      return {
        kind: 'viewport-size',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision ?? 1,
        rowHeights: [],
        colWidths: [],
      }
    },
    async setCellInput(request) {
      return { sheetId: request.sheetId, requestId: request.requestId, revision: 1 }
    },
  }
  return { backend }
}

function renderGridAndMenu(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      <SpreadsheetContextMenu />
    </SpreadsheetUiProvider>
  ))
}

describe('Grid → ContextMenu hidden rows and columns reachability', () => {
  it('preserves a row selection on an inside right-click and hides the complete selection', async () => {
    const store = createStore()
    const source = createHiddenBackend()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    const { container, getByTestId } = renderGridAndMenu(store, source.backend)

    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')).not.toBeNull()
    })
    fireEvent.contextMenu(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')!, {
      clientX: 12,
      clientY: 34,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'row',
      sheetId: 'sheet-1',
      rowAnchor: 2,
      rowFocus: 4,
    })
    fireEvent.click(getByTestId('context-menu-command-row.hide'))

    // Local canonical state commits synchronously; the mirror follows.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])
    await waitFor(() => {
      expect(source.hideRows).toHaveLength(1)
      expect(source.hideRows[0]?.rowIndices).toEqual([2, 3, 4])
    })
  })

  it('resets an outside column right-click before hiding, preserving existing grid behavior', async () => {
    const store = createStore()
    const source = createHiddenBackend()
    store.setter(selectColumnsAtom, { sheetId: 'sheet-1', colAnchor: 1, colFocus: 2 })
    const { container, getByTestId } = renderGridAndMenu(store, source.backend)

    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-col-header[data-col="4"]')).not.toBeNull()
    })
    fireEvent.contextMenu(
      container.querySelector('.spreadsheet-grid-col-header[data-col="4"]')!,
      { clientX: 20, clientY: 10 },
    )

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'column',
      sheetId: 'sheet-1',
      colAnchor: 4,
      colFocus: 4,
    })
    fireEvent.click(getByTestId('context-menu-command-column.hide'))

    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([4])
    await waitFor(() => {
      expect(source.hideColumns).toHaveLength(1)
      expect(source.hideColumns[0]?.colIndices).toEqual([4])
    })
  })

  it('seeds hidden state once from the backend mirror and unhides through a visible header', async () => {
    const store = createStore()
    const source = createHiddenBackend([3])
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    const { container, getByTestId } = renderGridAndMenu(store, source.backend)

    await waitFor(() => {
      // One-shot seed hydrated the local canonical sets from the mirror.
      expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([3])
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="2"]')).not.toBeNull()
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')).toBeNull()
    })
    fireEvent.contextMenu(container.querySelector('.spreadsheet-grid-row-header[data-row="2"]')!, {
      clientX: 12,
      clientY: 20,
    })

    expect(store.getter(selectionAtom)).toMatchObject({ rowAnchor: 2, rowFocus: 4 })
    fireEvent.click(getByTestId('context-menu-command-row.unhide'))

    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([])
    await waitFor(() => {
      expect(source.unhideRows).toHaveLength(1)
      expect(source.unhideRows[0]?.rowIndices).toEqual([3])
    })
  })

  it('hide and unhide stay available and effective on a backend with no hidden ports', async () => {
    const store = createStore()
    const source = createNoHiddenPortBackend()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    const { container, getByTestId } = renderGridAndMenu(store, source.backend)

    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')).not.toBeNull()
    })
    fireEvent.contextMenu(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')!, {
      clientX: 12,
      clientY: 34,
    })
    // Entry is present (not capability-gated) and works locally.
    fireEvent.click(getByTestId('context-menu-command-row.hide'))
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])

    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')).toBeNull()
    })

    // Unhide through a still-visible header inside a covering selection.
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 1, rowFocus: 5 })
    fireEvent.contextMenu(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')!, {
      clientX: 12,
      clientY: 20,
    })
    fireEvent.click(getByTestId('context-menu-command-row.unhide'))
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([])
  })

  it('local commands claim the sheet so a late seed cannot clobber them', async () => {
    const store = createStore()
    const source = createHiddenBackend([7])
    // Local command BEFORE mount: the sheet is owned locally, the seed skips.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [1] })
    renderGridAndMenu(store, source.backend)

    await waitFor(() => {
      expect(source.sizeRequests.length).toBeGreaterThan(0)
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([1])
  })
})
