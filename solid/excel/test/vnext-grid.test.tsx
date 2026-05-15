/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  FillRangeRequest,
  ResolveDataEdgeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  menuStateAtom,
  selectionAtom,
  selectionRegionsAtom,
  setSheetTabsSheetsAtom,
  setWorkspaceActiveSheetAtom,
  viewportSizeOverridesAtom,
  visibleWindowAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  coordinates: { clientX?: number; clientY?: number },
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: coordinates.clientX ?? 0,
      clientY: coordinates.clientY ?? 0,
    }),
  )
}

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({
        row,
        col,
        displayValue: `${row},${col}`,
      })
    }
  }
  return cells
}

function createFakeBackend(options: {
  rowHeights?: ViewportSizeProjectionResult['rowHeights']
  colWidths?: ViewportSizeProjectionResult['colWidths']
  cells?: DisplayCell[] | ((window: VisibleProjectionRequest['window']) => DisplayCell[])
} = {}) {
  const requests: VisibleProjectionRequest[] = []
  const sizeRequests: ViewportSizeProjectionRequest[] = []
  const rowHeightCalls: Array<{ rowIndex: number; heightPx: number }> = []
  const columnWidthCalls: Array<{ colIndex: number; widthPx: number }> = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      requests.push(request)
      const cells =
        typeof options.cells === 'function'
          ? options.cells(request.window)
          : (options.cells ?? buildCells(request.window))
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells,
      }
      return result
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async readViewportSizeProjection(request) {
      sizeRequests.push(request)
      return {
        kind: 'viewport-size',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        window: { ...request.window },
        rowHeights: options.rowHeights ?? [],
        colWidths: options.colWidths ?? [],
      }
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async setRowHeight(request) {
      rowHeightCalls.push({ rowIndex: request.rowIndex, heightPx: request.heightPx })
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async setColumnWidth(request) {
      columnWidthCalls.push({ colIndex: request.colIndex, widthPx: request.widthPx })
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }

  return { backend, requests, sizeRequests, rowHeightCalls, columnWidthCalls }
}

describe('vNext SpreadsheetGrid', () => {
  it('requests and renders only the visible viewport window', async () => {
    const store = createStore()
    const { backend, requests } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 10,
      colCount: 10,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await flushMicrotasks()

    expect(requests).toHaveLength(1)
    expect(requests[0].window).toEqual({
      rowStart: 0,
      rowEnd: 1,
      colStart: 0,
      colEnd: 2,
    })
    expect(store.getter(visibleWindowAtom)).toEqual({
      rowStart: 0,
      rowEnd: 1,
      colStart: 0,
      colEnd: 2,
    })
    expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(6)
    expect(container.querySelectorAll('.spreadsheet-grid-row-header')).toHaveLength(2)
    expect(container.querySelectorAll('.spreadsheet-grid-col-header')).toHaveLength(3)
    await waitFor(() => {
      expect(
        container.querySelector('[data-row="1"][data-col="2"] .cell-display')?.textContent,
      ).toBe('1,2')
    })
  })

  it('renders projected cell format styles without creating cell atoms', async () => {
    const store = createStore()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 1,
      viewportWidth: 1,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 2,
      colCount: 2,
      overscanRows: 0,
      overscanCols: 0,
    }
    const backend: SpreadsheetBackend = {
      async readVisibleProjection(request) {
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: { ...request.window },
          requestId: request.requestId,
          revision: request.revision,
          cells: [
            {
              row: 0,
              col: 0,
              displayValue: 'Styled',
              valueKind: 'string',
              format: {
                bold: true,
                italic: true,
                align: 'right',
                fgColor: '#ff0000',
              },
            },
          ],
        }
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent).toBe(
        'Styled',
      )
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.fontWeight).toBe('700')
    expect(display.style.fontStyle).toBe('italic')
    expect(display.style.textAlign).toBe('right')
    expect(display.style.color).toBe('rgb(255, 0, 0)')
  })

  it('writes selection clicks back into the core store', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.click(
      container.querySelector('[data-row="1"][data-col="1"] .spreadsheet-grid-cell-button')!,
    )

    await flushMicrotasks()

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
  })

  it('renders Ctrl/Cmd-click disjoint cell selections from the core multi-range state', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 3,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 6,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(9)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="C3"] .spreadsheet-grid-cell-button')!, {
      ctrlKey: true,
    })

    expect(store.getter(selectionRegionsAtom)).toEqual([
      {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        focus: { row: 0, col: 0 },
      },
      {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 2, col: 2 },
      },
    ])
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    })
    expect(container.querySelector('[data-cell-addr="A1"]')?.getAttribute('data-selected')).toBe(
      'true',
    )
    expect(container.querySelector('[data-cell-addr="C3"]')?.getAttribute('data-selected')).toBe(
      'true',
    )
  })

  it('collapses disjoint selections to the primary region on Escape', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 3,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 6,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(9)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="C3"] .spreadsheet-grid-cell-button')!, {
      metaKey: true,
    })
    expect(store.getter(selectionRegionsAtom)).toHaveLength(2)

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'Escape' })

    expect(store.getter(selectionRegionsAtom)).toEqual([
      {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 2, col: 2 },
      },
    ])
    expect(container.querySelector('[data-cell-addr="A1"]')?.getAttribute('data-selected')).toBe(
      'false',
    )
    expect(container.querySelector('[data-cell-addr="C3"]')?.getAttribute('data-selected')).toBe(
      'true',
    )
  })

  it('supports row and column header selection without materializing cells', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 3,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 8,
      colCount: 8,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(9)
    })

    fireEvent.click(container.querySelector('.spreadsheet-grid-row-header[data-row="2"]')!)
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'row',
      sheetId: 'sheet-1',
      rowAnchor: 2,
      rowFocus: 2,
    })
    expect(container.querySelector('[data-cell-addr="A3"]')?.getAttribute('data-selected')).toBe(
      'true',
    )

    fireEvent.click(container.querySelector('.spreadsheet-grid-col-header[data-col="1"]')!)
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'column',
      sheetId: 'sheet-1',
      colAnchor: 1,
      colFocus: 1,
    })
    expect(container.querySelector('[data-cell-addr="B1"]')?.getAttribute('data-selected')).toBe(
      'true',
    )
  })

  it('supports shift range selection and keyboard movement through core atoms', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
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

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.mouseDown(container.querySelector('[data-cell-addr="C2"]')!, { shiftKey: true })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 2 },
    })
    expect(container.querySelector('[data-cell-addr="B2"]')?.getAttribute('data-selected')).toBe(
      'true',
    )

    const grid = container.querySelector('[data-testid="grid"]')!
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    })
  })

  it('passes visible column count into horizontal page keyboard movement', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
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

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'PageDown',
      altKey: true,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 5 },
      focus: { row: 1, col: 5 },
    })
  })

  it('maps ctrl page keys to adjacent sheet activation through core atoms', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    store.setter(setSheetTabsSheetsAtom, {
      sheets: [
        { id: 'sheet-1', name: 'Sheet1', index: 0 },
        { id: 'sheet-2', name: 'Sheet2', index: 1 },
        { id: 'sheet-3', name: 'Sheet3', index: 2 },
      ],
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    const viewport = {
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

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-2" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'PageDown',
      ctrlKey: true,
    })

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-3')

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'PageUp',
      ctrlKey: true,
    })

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
  })

  it('commits fill handle drag as a compact backend fillRange request', async () => {
    const store = createStore()
    const fillRangeRequests: FillRangeRequest[] = []
    const { backend } = createFakeBackend()
    backend.fillRange = async (request) => {
      fillRangeRequests.push(request)
      return {
        sheetId: request.sheetId,
        affectedRange: request.targetRange,
      }
    }
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 3,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 10,
      colCount: 10,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(6)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    const targetCell = container.querySelector('[data-cell-addr="A3"]') as HTMLElement
    const originalElementFromPoint = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => targetCell,
    })

    try {
      dispatchPointerEvent(getByTestId('fill-handle-A1'), 'pointerdown', {
        clientX: 1,
        clientY: 1,
      })
      dispatchPointerEvent(window, 'pointermove', { clientX: 1, clientY: 3 })
      dispatchPointerEvent(window, 'pointerup', { clientX: 1, clientY: 3 })

      await waitFor(() => {
        expect(fillRangeRequests).toHaveLength(1)
      })
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      })
    }

    expect(fillRangeRequests[0]).toEqual({
      kind: 'fill-range',
      sheetId: 'sheet-1',
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
    })
  })

  it('uses backend data-edge resolution for ctrl arrow movement when available', async () => {
    const store = createStore()
    const resolveRequests: ResolveDataEdgeRequest[] = []
    const { backend } = createFakeBackend()
    backend.resolveDataEdge = async (request) => {
      resolveRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        target: { row: request.from.row, col: 4 },
      }
    }
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 4,
      viewportWidth: 5,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 10,
      colCount: 10,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(20)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'ArrowRight',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(store.getter(selectionAtom)).toEqual({
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 1, col: 4 },
        focus: { row: 1, col: 4 },
      })
    })

    expect(resolveRequests).toEqual([
      {
        kind: 'resolve-data-edge',
        sheetId: 'sheet-1',
        from: { row: 1, col: 1 },
        direction: 'right',
        bounds: { rowCount: 10, colCount: 10 },
      },
    ])
  })

  it('supports ctrl boundary movement and context menu intents', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
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

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'ArrowRight',
      ctrlKey: true,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 9 },
      focus: { row: 1, col: 9 },
    })

    fireEvent.contextMenu(container.querySelector('.spreadsheet-grid-row-header[data-row="2"]')!, {
      clientX: 12,
      clientY: 34,
    })

    expect(store.getter(menuStateAtom)).toMatchObject({
      status: 'open',
      surface: 'header',
      target: {
        kind: 'row',
        sheetId: 'sheet-1',
        rowIndex: 2,
      },
      position: {
        x: 12,
        y: 34,
      },
    })
  })

  it('resizes visible rows and columns through sparse viewport atoms', async () => {
    const store = createStore()
    const { backend, rowHeightCalls, columnWidthCalls } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 48,
      viewportWidth: 192,
      rowHeight: 24,
      colWidth: 96,
      rowCount: 4,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    dispatchPointerEvent(getByTestId('col-resize-1'), 'pointerdown', { clientX: 100 })
    dispatchPointerEvent(window, 'pointermove', { clientX: 132 })
    dispatchPointerEvent(window, 'pointerup', { clientX: 132 })

    dispatchPointerEvent(getByTestId('row-resize-1'), 'pointerdown', { clientY: 30 })
    dispatchPointerEvent(window, 'pointermove', { clientY: 42 })
    dispatchPointerEvent(window, 'pointerup', { clientY: 42 })

    expect(store.getter(viewportSizeOverridesAtom)).toEqual({
      rowHeightsBySheet: {
        'sheet-1': {
          '1': 36,
        },
      },
      colWidthsBySheet: {
        'sheet-1': {
          '1': 128,
        },
      },
    })
    expect(columnWidthCalls).toEqual([{ colIndex: 1, widthPx: 128 }])
    expect(rowHeightCalls).toEqual([{ rowIndex: 1, heightPx: 36 }])
    expect(
      (container.querySelector('.spreadsheet-grid-col-header[data-col="1"]') as HTMLElement).style
        .width,
    ).toBe('128px')
    expect(
      (container.querySelector('.spreadsheet-grid-row-header[data-row="1"]') as HTMLElement).style
        .height,
    ).toBe('36px')
    expect((container.querySelector('[data-cell-addr="B2"]') as HTMLElement).style.width).toBe(
      '128px',
    )
    expect((container.querySelector('[data-cell-addr="B2"]') as HTMLElement).style.height).toBe(
      '36px',
    )
  })

  it('autofits visible rows and columns through resize handle double-click', async () => {
    const store = createStore()
    const { backend, rowHeightCalls, columnWidthCalls } = createFakeBackend({
      cells: [
        { row: 0, col: 0, displayValue: 'A1' },
        {
          row: 0,
          col: 1,
          displayValue: 'A very long visible value that should drive column autofit',
          valueKind: 'string',
        },
        { row: 1, col: 0, displayValue: 'A2' },
        {
          row: 1,
          col: 1,
          displayValue: 'Tall',
          valueKind: 'string',
          format: { fontSize: 32 },
        },
      ],
    })
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 48,
      viewportWidth: 192,
      rowHeight: 24,
      colWidth: 96,
      rowCount: 4,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.dblClick(getByTestId('col-resize-1'))
    fireEvent.dblClick(getByTestId('row-resize-1'))

    await waitFor(() => {
      expect(columnWidthCalls).toHaveLength(1)
      expect(rowHeightCalls).toHaveLength(1)
    })

    expect(columnWidthCalls[0]).toMatchObject({ colIndex: 1 })
    expect(columnWidthCalls[0].widthPx).toBeGreaterThan(220)
    expect(rowHeightCalls[0]).toMatchObject({ rowIndex: 1 })
    expect(rowHeightCalls[0].heightPx).toBeGreaterThan(36)
    expect(
      (container.querySelector('.spreadsheet-grid-col-header[data-col="1"]') as HTMLElement).style
        .width,
    ).toBe(`${columnWidthCalls[0].widthPx}px`)
    expect(
      (container.querySelector('.spreadsheet-grid-row-header[data-row="1"]') as HTMLElement).style
        .height,
    ).toBe(`${rowHeightCalls[0].heightPx}px`)
    expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
  })

  it('hydrates row and column size metadata from the backend visible window', async () => {
    const store = createStore()
    const { backend, sizeRequests } = createFakeBackend({
      rowHeights: [{ rowIndex: 1, heightPx: 40 }],
      colWidths: [{ colIndex: 1, widthPx: 132 }],
    })
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 48,
      viewportWidth: 192,
      rowHeight: 24,
      colWidth: 96,
      rowCount: 4,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(
        (container.querySelector('.spreadsheet-grid-col-header[data-col="1"]') as HTMLElement)
          .style.width,
      ).toBe('132px')
    })

    expect(sizeRequests).toHaveLength(1)
    expect(sizeRequests[0].window).toEqual({
      rowStart: 0,
      rowEnd: 1,
      colStart: 0,
      colEnd: 1,
    })
    expect(store.getter(viewportSizeOverridesAtom)).toEqual({
      rowHeightsBySheet: {
        'sheet-1': {
          '1': 40,
        },
      },
      colWidthsBySheet: {
        'sheet-1': {
          '1': 132,
        },
      },
    })
    expect(
      (container.querySelector('.spreadsheet-grid-row-header[data-row="1"]') as HTMLElement).style
        .height,
    ).toBe('40px')
  })

  it('preserves selected range when opening a cell context menu inside it', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
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

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="C2"] .spreadsheet-grid-cell-button')!, {
      shiftKey: true,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 2 },
    })

    fireEvent.contextMenu(container.querySelector('[data-cell-addr="B2"]')!, {
      clientX: 22,
      clientY: 44,
    })

    expect(store.getter(menuStateAtom)).toMatchObject({
      status: 'open',
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range: {
          rowStart: 0,
          rowEnd: 1,
          colStart: 0,
          colEnd: 2,
        },
      },
    })
  })
})
