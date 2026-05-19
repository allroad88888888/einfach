/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  ClearRangeRequest,
  DisplayCell,
  FillRangeRequest,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvChunkExportResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ResolveDataEdgeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  clipboardStateAtom,
  menuStateAtom,
  selectionAtom,
  selectionRegionsAtom,
  addSelectionRegionAtom,
  selectRowsAtom,
  setSheetTabsSheetsAtom,
  setWorkspaceActiveSheetAtom,
  viewportHiddenAtom,
  viewportMetricsAtom,
  viewportSizeOverridesAtom,
  visibleWindowAtom,
  workspaceSessionAtom,
  setSheetProtectionAtom,
  editingSessionAtom,
  findReplaceOpenAtom,
  setFilterSortAtom,
  filterDropdownAtom,
  applyPresenceUpdateAtom,
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
  hiddenRowIndices?: number[]
  hiddenColIndices?: number[]
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
        hiddenRowIndices: options.hiddenRowIndices,
        hiddenColIndices: options.hiddenColIndices,
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

  it('renders conditional format overlays and validation indicators from projection metadata', async () => {
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
              displayValue: 'Flagged',
              valueKind: 'string',
              format: {
                bgColor: '#ffffff',
                fgColor: '#111111',
              },
              conditionalFormat: {
                bgColor: '#fde68a',
                fgColor: '#7f1d1d',
                bold: true,
              },
              validation: {
                code: 'validation.list_mismatch',
                severity: 'error',
                message: 'Value must be one of: open, closed',
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
        'Flagged',
      )
    })

    const cell = container.querySelector('[data-cell-addr="A1"]') as HTMLElement
    const display = cell.querySelector('.cell-display') as HTMLElement
    expect(display.style.background).toBe('rgb(253, 230, 138)')
    expect(display.style.color).toBe('rgb(127, 29, 29)')
    expect(display.style.fontWeight).toBe('700')
    expect(cell.getAttribute('data-has-conditional-format')).toBe('true')
    expect(cell.getAttribute('data-validation-code')).toBe('validation.list_mismatch')
    expect(cell.getAttribute('data-validation-severity')).toBe('error')
    expect(cell.getAttribute('title')).toBe('Value must be one of: open, closed')
  })

  it('renders rich hyperlink and rich text values from projection metadata', async () => {
    const store = createStore()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 1,
      viewportWidth: 2,
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
              displayValue: 'Fallback',
              valueKind: 'string',
              richValue: {
                kind: 'hyperlink',
                url: 'https://example.com/docs',
                label: 'Docs',
              },
            },
            {
              row: 0,
              col: 1,
              displayValue: 'Plain fallback',
              valueKind: 'string',
              richValue: {
                kind: 'rich-text',
                runs: [
                  { text: 'Paid ', format: { bold: true } },
                  { text: 'invoice', format: { italic: true, color: '#0f766e' } },
                ],
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
        'Docs',
      )
      expect(container.querySelector('[data-cell-addr="B1"] .cell-display')?.textContent).toBe(
        'Paid invoice',
      )
    })

    const hyperlinkCell = container.querySelector('[data-cell-addr="A1"]') as HTMLElement
    const hyperlink = hyperlinkCell.querySelector('.cell-rich-link') as HTMLElement
    expect(hyperlinkCell.getAttribute('data-rich-kind')).toBe('hyperlink')
    expect(hyperlinkCell.getAttribute('data-rich-url')).toBe('https://example.com/docs')
    expect(hyperlink.getAttribute('data-rich-url')).toBe('https://example.com/docs')

    const richTextCell = container.querySelector('[data-cell-addr="B1"]') as HTMLElement
    const runs = richTextCell.querySelectorAll('.cell-rich-text span')
    expect(richTextCell.getAttribute('data-rich-kind')).toBe('rich-text')
    expect((runs[0] as HTMLElement).style.fontWeight).toBe('700')
    expect((runs[1] as HTMLElement).style.fontStyle).toBe('italic')
    expect((runs[1] as HTMLElement).style.color).toBe('rgb(15, 118, 110)')
  })

  it('skips rows and columns marked hidden by viewport projection metadata', async () => {
    const store = createStore()
    const { backend } = createFakeBackend({
      hiddenRowIndices: [1],
      hiddenColIndices: [2],
    })
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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { 'sheet-1': [1] },
      colsBySheet: { 'sheet-1': [2] },
    })
    expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).toBeNull()
    expect(container.querySelector('.spreadsheet-grid-col-header[data-col="2"]')).toBeNull()
    expect(container.querySelector('[data-cell-addr="A1"]')).not.toBeNull()
    expect(container.querySelector('[data-cell-addr="A2"]')).toBeNull()
    expect(container.querySelector('[data-cell-addr="C1"]')).toBeNull()
  })

  it('renders merged projection cells as one spanned anchor and selects the full merge', async () => {
    const store = createStore()
    const { backend } = createFakeBackend({
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'Merged',
          valueKind: 'string',
          mergedSpan: { rows: 2, cols: 2 },
        },
        { row: 0, col: 1, displayValue: '', valueKind: 'blank', mergeAnchor: { row: 0, col: 0 } },
        { row: 1, col: 0, displayValue: '', valueKind: 'blank', mergeAnchor: { row: 0, col: 0 } },
        { row: 1, col: 1, displayValue: '', valueKind: 'blank', mergeAnchor: { row: 0, col: 0 } },
        { row: 0, col: 2, displayValue: 'C1' },
        { row: 1, col: 2, displayValue: 'C2' },
        { row: 2, col: 0, displayValue: 'A3' },
        { row: 2, col: 1, displayValue: 'B3' },
        { row: 2, col: 2, displayValue: 'C3' },
      ],
    })
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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent).toBe(
        'Merged',
      )
    })

    const anchor = container.querySelector('[data-cell-addr="A1"]') as HTMLTableCellElement
    expect(anchor.rowSpan).toBe(2)
    expect(anchor.colSpan).toBe(2)
    expect(anchor.getAttribute('data-merge-anchor')).toBe('true')
    expect(container.querySelector('[data-cell-addr="B1"]')).toBeNull()
    expect(container.querySelector('[data-cell-addr="A2"]')).toBeNull()
    expect(container.querySelector('[data-cell-addr="B2"]')).toBeNull()

    fireEvent.click(anchor.querySelector('.spreadsheet-grid-cell-button')!)

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 0, col: 0 },
    })
    expect(anchor.getAttribute('data-selected')).toBe('true')
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

  it('PageDown at viewport edge advances scroll position to follow the selection', async () => {
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

    fireEvent.click(container.querySelector('[data-cell-addr="A4"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'PageDown' })

    await flushMicrotasks()

    // selection moved by one page (4 rows)
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 7, col: 0 },
    })
    // viewport scrollTop updated so off-screen cell is visible
    expect(store.getter(viewportMetricsAtom).scrollTop).toBeGreaterThan(0)
  })

  it('Ctrl+C in the focused grid invokes the copy path and updates clipboard state', async () => {
    const store = createStore()
    const rangeRequests: RangeProjectionRequest[] = []
    const { backend } = createFakeBackend()
    backend.readRangeProjection = async (request) => {
      rangeRequests.push(request)
      const result: RangeProjectionResult = {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: [{ row: 0, col: 0, displayValue: 'hello' }],
      }
      return result
    }

    const writeText = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'c', ctrlKey: true })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })

    expect(rangeRequests).toHaveLength(1)
    expect(rangeRequests[0].range).toEqual({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })
    expect(store.getter(clipboardStateAtom).status).toBe('ready')
    expect(store.getter(clipboardStateAtom).intent?.type).toBe('clipboard.copy')
  })

  it('Ctrl+V in the focused grid invokes the paste path', async () => {
    const store = createStore()
    const setCellInputCalls: Array<{ row: number; col: number; input: string }> = []
    const { backend } = createFakeBackend()
    backend.setCellInput = async (request) => {
      setCellInputCalls.push({ row: request.row, col: request.col, input: request.input })
      return { sheetId: request.sheetId, requestId: request.requestId }
    }

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: jest.fn<() => Promise<string>>().mockResolvedValue('pasted'),
      },
    })

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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'v', ctrlKey: true })

    await waitFor(() => {
      expect(setCellInputCalls).toHaveLength(1)
    })

    expect(setCellInputCalls[0]).toMatchObject({ row: 1, col: 1, input: 'pasted' })
    expect(store.getter(clipboardStateAtom).status).toBe('ready')
    expect(store.getter(clipboardStateAtom).intent?.type).toBe('clipboard.paste')
  })

  it('Delete on a 2x2 range selection calls clearRange with the full range', async () => {
    const store = createStore()
    const clearRangeCalls: ClearRangeRequest[] = []
    const { backend } = createFakeBackend()
    backend.clearRange = async (request) => {
      clearRangeCalls.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    }
    backend.setCellInput = async () => {
      throw new Error('setCellInput should not be called for multi-cell clear')
    }

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

    // select A1:B2 (2x2 range)
    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!, {
      shiftKey: true,
    })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'range',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'Delete' })

    await waitFor(() => {
      expect(clearRangeCalls).toHaveLength(1)
    })

    expect(clearRangeCalls[0]).toMatchObject({
      kind: 'clear-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
  })

  it('Delete on multi-region selection calls clearRange once per region', async () => {
    const store = createStore()
    const clearRangeCalls: ClearRangeRequest[] = []
    const { backend } = createFakeBackend()
    backend.clearRange = async (request) => {
      clearRangeCalls.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    }
    backend.setCellInput = async () => {
      throw new Error('setCellInput should not be called for multi-region clear')
    }

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

    // Set primary region A1:B2 via click + shift-click
    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!, {
      shiftKey: true,
    })
    // Add second region C3:D4 directly via the store atom
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 3, col: 3 },
      },
    })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(2)

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'Delete' })

    await waitFor(() => {
      expect(clearRangeCalls).toHaveLength(2)
    })

    const ranges = clearRangeCalls.map((r) => r.range).sort((a, b) => a.rowStart - b.rowStart)
    expect(ranges[0]).toMatchObject({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })
    expect(ranges[1]).toMatchObject({ rowStart: 2, rowEnd: 3, colStart: 2, colEnd: 3 })
  })

  it('blocks edit start on a locked cell in a protected sheet', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    backend.setCellInput = async (request) => ({ sheetId: request.sheetId, requestId: request.requestId })

    // protect the sheet with no unlocked ranges → all cells locked
    store.setter(setSheetProtectionAtom, { sheetId: 'sheet-1', state: { mode: 'protected', unlockedRanges: [] } })

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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    // double-click to trigger edit start
    fireEvent.dblClick(container.querySelector('[data-cell-addr="A1"]')!)

    expect(store.getter(editingSessionAtom).status).toBe('idle')
  })

  it('Ctrl+F opens find-replace atom', async () => {
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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    expect(store.getter(findReplaceOpenAtom)).toBe(false)

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'f', ctrlKey: true })

    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  it('filter chevron renders when column has an active filter rule and opens dropdown on click', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 1, value: 'yes' }], directives: [] },
    })

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
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
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(6)
    })

    // col 0 has no filter rule
    expect(container.querySelector('[data-testid="filter-chevron-0"]')).toBeNull()
    // col 1 has a filter rule
    const chevron = container.querySelector('[data-testid="filter-chevron-1"]') as HTMLButtonElement
    expect(chevron).not.toBeNull()

    fireEvent.click(chevron)

    expect(store.getter(filterDropdownAtom)).toMatchObject({ status: 'open', sheetId: 'sheet-1', colIndex: 1 })
  })

  it('switching active sheet closes an open filter dropdown', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(setSheetTabsSheetsAtom, {
      sheets: [
        { id: 'sheet-1', name: 'Sheet1', index: 0 },
        { id: 'sheet-2', name: 'Sheet2', index: 1 },
      ],
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'yes' }], directives: [] },
    })

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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    const chevron = container.querySelector('[data-testid="filter-chevron-0"]') as HTMLButtonElement
    fireEvent.click(chevron)
    expect(store.getter(filterDropdownAtom)).toMatchObject({ status: 'open' })

    // switch active sheet
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    await flushMicrotasks()

    expect(store.getter(filterDropdownAtom)).toMatchObject({ status: 'closed' })
  })

  it('renders remote cursor overlay for each presence participant on this sheet', async () => {
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

    expect(container.querySelector('[data-testid="remote-cursor-user-42"]')).toBeNull()

    store.setter(applyPresenceUpdateAtom, {
      kind: 'join',
      participant: { id: 'user-42', displayName: 'Alice', colorHint: '#ff0000', lastSeenAt: Date.now() },
    })
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'user-42',
      sheetId: 'sheet-1',
      selection: { kind: 'cell', sheetId: 'sheet-1', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } },
    })

    await waitFor(() => {
      expect(container.querySelector('[data-testid="remote-cursor-user-42"]')).not.toBeNull()
    })

    const cursorEl = container.querySelector('[data-testid="remote-cursor-user-42"]') as HTMLElement
    expect(cursorEl.style.border).toContain('#ff0000')
    expect(cursorEl.style.position).toBe('absolute')
  })

  it('Ctrl+C origin marker uses correct A1 label for columns at AA boundary', async () => {
    const store = createStore()
    const rangeRequests: RangeProjectionRequest[] = []
    const { backend } = createFakeBackend()
    backend.readRangeProjection = async (request) => {
      rangeRequests.push(request)
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: [],
      }
    }

    const writeText = jest.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
      colCount: 30,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    // Select cell at col index 26 (AA) row 0
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 26 },
        focus: { row: 0, col: 26 },
      },
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    const written = writeText.mock.calls[0][0]
    expect(written).toContain('AA1')
    expect(written).not.toContain('[1')
  })

  it('Ctrl+C on a full-row selection uses the streaming export path, not in-memory materialization', async () => {
    const store = createStore()
    const streamCalls: RangeTsvExportRequest[] = []
    const rangeRequests: RangeProjectionRequest[] = []
    const { backend } = createFakeBackend()
    backend.readRangeProjection = async (request) => {
      rangeRequests.push(request)
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: [],
      }
    }
    backend.consumeExportRangeTsvChunks = async (request, onChunk) => {
      streamCalls.push(request)
      // emit two small chunks; do NOT materialize a full row in memory
      onChunk({ startRow: 0, endRow: 0, text: 'one\ttwo\tthree' })
      const result: RangeTsvChunkExportResult = {
        kind: 'range-tsv-chunks',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        originAddr: 'A1',
        estimatedBytes: 13,
      }
      return result
    }

    const writeText = jest.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 4,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
      colCount: 16_384,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    // Full-row selection spans the entire column range (16_384 cells).
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 0, rowFocus: 0 })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })

    // Streaming path was used.
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0].range).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 16_383,
    })
    // Non-streaming path was NOT used.
    expect(rangeRequests).toHaveLength(0)
    expect(store.getter(clipboardStateAtom).status).toBe('ready')
  })

  it('Ctrl+C on full-row selection without streaming backend surfaces a clipboard error', async () => {
    const store = createStore()
    const rangeRequests: RangeProjectionRequest[] = []
    const { backend } = createFakeBackend()
    backend.readRangeProjection = async (request) => {
      rangeRequests.push(request)
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: [],
      }
    }
    // no consumeExportRangeTsvChunks / exportRangeTsv on backend

    const writeText = jest.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 4,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
      colCount: 16_384,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 0, rowFocus: 0 })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(store.getter(clipboardStateAtom).error).not.toBeNull()
    })
    expect(rangeRequests).toHaveLength(0)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('Ctrl+C on a full-row selection via exportRangeTsv fallback when only that is available', async () => {
    const store = createStore()
    const exportCalls: RangeTsvExportRequest[] = []
    const { backend } = createFakeBackend()
    backend.readRangeProjection = async (request) => ({
      kind: 'range',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision,
      range: request.range,
      cells: [],
    })
    backend.exportRangeTsv = async (request) => {
      exportCalls.push(request)
      const result: RangeTsvExportResult = {
        kind: 'range-tsv',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        originAddr: 'A1',
        text: 'short',
        estimatedBytes: 5,
      }
      return result
    }

    const writeText = jest.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 4,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
      colCount: 16_384,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 0, rowFocus: 0 })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    expect(exportCalls).toHaveLength(1)
  })

  it("applies transform: rotate(...) when format.rotation is numeric (Wave 6.2)", async () => {
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
              displayValue: 'Rotated',
              valueKind: 'string',
              format: { rotation: 90 },
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
        'Rotated',
      )
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.transform).toBe('rotate(90deg)')
    expect(display.style.transformOrigin).toContain('center')
  })

  it("uses writing-mode: vertical-rl when format.rotation is 'vertical' (Wave 6.2)", async () => {
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
              displayValue: 'Stacked',
              valueKind: 'string',
              format: { rotation: 'vertical' },
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
        'Stacked',
      )
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.writingMode).toBe('vertical-rl')
    expect(display.style.transform).toBe('')
  })

  it("applies white-space: normal when format.overflow is 'wrap' (Wave 6.2)", async () => {
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
              displayValue: 'A long sentence that should wrap onto multiple lines.',
              valueKind: 'string',
              format: { overflow: 'wrap' },
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
      expect(
        container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent,
      ).toContain('long sentence')
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.whiteSpace).toBe('normal')
    expect(display.style.wordBreak).toBe('break-word')
  })

  it("applies text-overflow: ellipsis when format.overflow is 'clip' (Wave 6.2)", async () => {
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
              displayValue: 'A very long value that does not fit',
              valueKind: 'string',
              format: { overflow: 'clip' },
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
      expect(container.querySelector('[data-cell-addr="A1"] .cell-display')).not.toBeNull()
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.textOverflow).toBe('ellipsis')
    expect(display.style.overflow).toBe('hidden')
    expect(display.style.whiteSpace).toBe('nowrap')
  })

  it("maps horizontalAlign 'fill' / 'justify' / 'distributed' to expected text-align (Wave 6.2)", async () => {
    const store = createStore()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 1,
      viewportWidth: 3,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 2,
      colCount: 3,
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
              displayValue: 'fill',
              valueKind: 'string',
              format: { align: 'fill' },
            },
            {
              row: 0,
              col: 1,
              displayValue: 'justify',
              valueKind: 'string',
              format: { align: 'justify' },
            },
            {
              row: 0,
              col: 2,
              displayValue: 'distributed',
              valueKind: 'string',
              format: { align: 'distributed' },
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
        'fill',
      )
    })

    const fillCell = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    const justifyCell = container.querySelector(
      '[data-cell-addr="B1"] .cell-display',
    ) as HTMLElement
    const distributedCell = container.querySelector(
      '[data-cell-addr="C1"] .cell-display',
    ) as HTMLElement

    expect(fillCell.style.textAlign).toBe('left')
    expect(justifyCell.style.textAlign).toBe('justify')
    expect(distributedCell.style.textAlign).toBe('justify')
    expect(distributedCell.style.textAlignLast).toBe('justify')
  })

  it('legacy format.wrap still produces wrap CSS (Wave 6.2 back-compat)', async () => {
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
              displayValue: 'Long content that should still wrap from the legacy flag',
              valueKind: 'string',
              format: { wrap: true },
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
      expect(container.querySelector('[data-cell-addr="A1"] .cell-display')).not.toBeNull()
    })

    const display = container.querySelector('[data-cell-addr="A1"] .cell-display') as HTMLElement
    expect(display.style.whiteSpace).toBe('normal')
  })

  describe('editing flow (Excel parity)', () => {
    it('single click + printable key starts edit with that key as initial draft', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({
        cells: [
          { row: 0, col: 0, displayValue: 'existing', valueKind: 'string' },
        ],
      })
      backend.setCellInput = async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      })

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
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => {
        expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
      })

      fireEvent.click(
        container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
      )
      fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'a' })

      await flushMicrotasks()

      const session = store.getter(editingSessionAtom)
      expect(session.status).toBe('drafting')
      expect(session.draft).toBe('a')
      const input = container.querySelector('input.cell-input') as HTMLInputElement
      expect(input).not.toBeNull()
      expect(input.value).toBe('a')
    })

    it('shift+printable key uses uppercase as initial draft', async () => {
      const store = createStore()
      const { backend } = createFakeBackend()
      backend.setCellInput = async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      })

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
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => {
        expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
      })

      fireEvent.click(
        container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
      )
      fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
        key: 'B',
        shiftKey: true,
      })

      await flushMicrotasks()

      expect(store.getter(editingSessionAtom).draft).toBe('B')
    })

    it('F2 preserves existing cell content as initial draft', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({
        cells: [
          { row: 0, col: 0, displayValue: 'existing', valueKind: 'string' },
        ],
      })
      backend.setCellInput = async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      })

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
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => {
        expect(container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent).toBe(
          'existing',
        )
      })

      fireEvent.click(
        container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
      )
      fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'F2' })

      await flushMicrotasks()

      expect(store.getter(editingSessionAtom).draft).toBe('existing')
    })

    it('Backspace clears existing content and enters edit with empty draft', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({
        cells: [
          { row: 0, col: 0, displayValue: 'existing', valueKind: 'string' },
        ],
      })
      backend.setCellInput = async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      })

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
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => {
        expect(container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent).toBe(
          'existing',
        )
      })

      fireEvent.click(
        container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
      )
      fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'Backspace' })

      await flushMicrotasks()

      const session = store.getter(editingSessionAtom)
      expect(session.status).toBe('drafting')
      expect(session.draft).toBe('')
    })

    it('cell render uses a plain div (not a button) for cell-button wrapper', async () => {
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

      const wrappers = container.querySelectorAll('.spreadsheet-grid-cell-button')
      expect(wrappers.length).toBeGreaterThan(0)
      for (const node of Array.from(wrappers)) {
        expect(node.tagName.toLowerCase()).toBe('div')
      }
    })
  })
})
