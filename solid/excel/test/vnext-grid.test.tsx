/** @jsxImportSource solid-js */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  ClearRangeRequest,
  DisplayCell,
  FillRangeRequest,
  FillSeriesRequest,
  RangeProjectionRequest,
  RangeProjectionResult,
  RangeTsvChunkExportResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  ResolveDataEdgeRequest,
  SetCellInputRequest,
  SetFormatRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
  clipboardStateAtom,
  menuIntentAtom,
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
  setFreezeConfigAtom,
  setViewportColumnWidthAtom,
  setViewportRowHeightAtom,
  hideColumnsAtom,
  hideRowsAtom,
  viewportHiddenDiagnosticAtom,
  historyStackAtom,
  getFillHandleWriteRange,
} from '@einfach/spreadsheet-ui-core'
import {
  createWorkerWorkbookSpreadsheetBackend,
  type WorkerWorkbookClient,
} from '../src-vnext/adapter'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetFormatCellsDialog } from '../src-vnext/format-cells'

afterEach(cleanup)

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  coordinates: {
    clientX?: number
    clientY?: number
    ctrlKey?: boolean
    metaKey?: boolean
    detail?: number
  },
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: coordinates.clientX ?? 0,
      clientY: coordinates.clientY ?? 0,
      ctrlKey: coordinates.ctrlKey ?? false,
      metaKey: coordinates.metaKey ?? false,
      detail: coordinates.detail ?? 0,
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

function createFakeBackend(
  options: {
    rowHeights?: ViewportSizeProjectionResult['rowHeights']
    colWidths?: ViewportSizeProjectionResult['colWidths']
    hiddenRowIndices?: number[]
    hiddenColIndices?: number[]
    cells?: DisplayCell[] | ((window: VisibleProjectionRequest['window']) => DisplayCell[])
    freeze?: { rows: number; cols: number }
  } = {},
) {
  const requests: VisibleProjectionRequest[] = []
  const sizeRequests: ViewportSizeProjectionRequest[] = []
  const rowHeightCalls: Array<{ rowIndex: number; heightPx: number }> = []
  const columnWidthCalls: Array<{ colIndex: number; widthPx: number }> = []
  let freeze = options.freeze ?? { rows: 0, cols: 0 }
  let freezeRevision = 0

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
        revision: request.revision ?? 1,
        window: { ...request.window },
        rowHeights: options.rowHeights ?? [],
        colWidths: options.colWidths ?? [],
        hiddenRowIndices: options.hiddenRowIndices,
        hiddenColIndices: options.hiddenColIndices,
      }
    },
    async readFreezeConfig(request) {
      return {
        kind: 'freeze-config',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: freezeRevision,
        freeze: { ...freeze },
      }
    },
    async setFreezeConfig(request) {
      if (request.revision !== undefined && request.revision !== freezeRevision) {
        throw new Error('freeze revision conflict')
      }
      freeze = { ...request.freeze }
      freezeRevision += 1
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: freezeRevision,
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

interface FillSeriesDragOptions {
  readonly sourceCells: DisplayCell[]
  readonly sourceStartAddr?: string
  readonly sourceEndAddr?: string
  readonly targetAddr?: string
  readonly copyOnly?: boolean
  readonly includeFillSeries?: boolean
  readonly includeFillRange?: boolean
  readonly expectedMutation: 'series' | 'range' | 'cells'
  readonly expectedCellWrites?: number
  readonly rangeResult?: (request: RangeProjectionRequest) => RangeProjectionResult
}

async function runFillSeriesDrag(options: FillSeriesDragOptions) {
  const store = createStore()
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  const rangeRequests: RangeProjectionRequest[] = []
  const fillSeriesRequests: FillSeriesRequest[] = []
  const fillRangeRequests: FillRangeRequest[] = []
  const setCellInputRequests: SetCellInputRequest[] = []
  const { backend, requests: visibleRequests } = createFakeBackend({
    cells: options.sourceCells,
  })

  backend.readRangeProjection = async (request) => {
    rangeRequests.push(request)
    return (
      options.rangeResult?.(request) ?? {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells: options.sourceCells,
      }
    )
  }
  if (options.includeFillSeries !== false) {
    backend.fillSeries = async (request) => {
      fillSeriesRequests.push(request)
      const affectedRange = getFillHandleWriteRange(
        request.sourceRange,
        request.targetRange,
        request.direction,
      )!
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 18,
        affectedRange,
        applied: true,
        historyTransactionCount: 1,
        historyDisposition: 'undoable',
      }
    }
  }
  if (options.includeFillRange !== false) {
    backend.fillRange = async (request) => {
      fillRangeRequests.push(request)
      const affectedRange = getFillHandleWriteRange(
        request.sourceRange,
        request.targetRange,
        request.direction,
      )!
      return {
        sheetId: request.sheetId,
        revision: 18,
        affectedRange,
        applied: true,
        historyTransactionCount: 1,
        historyDisposition: 'undoable',
      }
    }
  }
  backend.setCellInput = async (request) => {
    setCellInputRequests.push(request)
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 18,
      affectedRange: {
        rowStart: request.row,
        rowEnd: request.row,
        colStart: request.col,
        colEnd: request.col,
      },
    }
  }

  const viewport = {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 4,
    viewportWidth: 3,
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
    expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(12)
  })

  const sourceStartAddr = options.sourceStartAddr ?? 'A1'
  const sourceEndAddr = options.sourceEndAddr ?? 'A2'
  fireEvent.click(
    container.querySelector(`[data-cell-addr="${sourceStartAddr}"] .spreadsheet-grid-cell-button`)!,
  )
  if (sourceEndAddr !== sourceStartAddr) {
    fireEvent.click(
      container.querySelector(`[data-cell-addr="${sourceEndAddr}"] .spreadsheet-grid-cell-button`)!,
      { shiftKey: true },
    )
  }

  const targetAddr = options.targetAddr ?? 'A4'
  const targetCell = container.querySelector(`[data-cell-addr="${targetAddr}"]`) as HTMLElement
  const originalElementFromPoint = document.elementFromPoint
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => targetCell,
  })

  try {
    const modifier = options.copyOnly === true
    dispatchPointerEvent(getByTestId(`fill-handle-${sourceEndAddr}`), 'pointerdown', {
      clientX: 1,
      clientY: 1,
      ctrlKey: modifier,
    })
    dispatchPointerEvent(window, 'pointermove', {
      clientX: 1,
      clientY: 4,
      ctrlKey: modifier,
    })
    dispatchPointerEvent(window, 'pointerup', {
      clientX: 1,
      clientY: 4,
      ctrlKey: modifier,
    })

    await waitFor(() => {
      if (options.expectedMutation === 'series') {
        expect(fillSeriesRequests).toHaveLength(1)
      } else if (options.expectedMutation === 'range') {
        expect(fillRangeRequests).toHaveLength(1)
      } else {
        expect(setCellInputRequests).toHaveLength(options.expectedCellWrites ?? 2)
      }
    })
    await waitFor(() => {
      expect(visibleRequests.length).toBeGreaterThanOrEqual(2)
    })
  } finally {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    })
  }

  return {
    rangeRequests,
    fillSeriesRequests,
    fillRangeRequests,
    setCellInputRequests,
    visibleRequests,
  }
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

  it('syncs DOM scrolling into viewport metrics and reloads the visible window', async () => {
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

    const scroller = container.querySelector('.spreadsheet-grid-scroll-viewport') as HTMLDivElement
    scroller.scrollTop = 4
    scroller.scrollLeft = 5
    fireEvent.scroll(scroller)

    await waitFor(() => {
      expect(requests[requests.length - 1]?.window).toEqual({
        rowStart: 4,
        rowEnd: 5,
        colStart: 5,
        colEnd: 7,
      })
    })
    expect(store.getter(viewportMetricsAtom)).toMatchObject({
      scrollTop: 4,
      scrollLeft: 5,
    })
    expect(store.getter(visibleWindowAtom)).toEqual({
      rowStart: 4,
      rowEnd: 5,
      colStart: 5,
      colEnd: 7,
    })
    await waitFor(() => {
      expect(
        container.querySelector('[data-row="4"][data-col="5"] .cell-display')?.textContent,
      ).toBe('4,5')
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
    expect(cell.style.background).toBe('rgb(253, 230, 138)')
    expect(display.style.background).toBe('')
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

  it('skips seeded hidden rows/columns and inflates the window so the viewport stays full', async () => {
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

    // Hidden entries are zero-height/zero-width in the scroll math, so a
    // 3×3 pixel viewport still shows 3 visible rows × 3 visible cols.
    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(9)
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
    // The window inflates past the raw span: rows 0,2,3 and cols 0,1,3.
    expect(container.querySelector('[data-cell-addr="A4"]')).not.toBeNull()
    expect(container.querySelector('[data-cell-addr="D1"]')).not.toBeNull()
  })

  it('treats hidden rows as zero-height in the scroll offset math (spacers and total width)', async () => {
    const store = createStore()
    // Local canonical hidden state — no backend hidden support at all.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [0, 1] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet-1', indices: [0] })
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 2,
      scrollLeft: 0,
      viewportHeight: 3,
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

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    // Rows 0 and 1 are hidden (0px): scrollTop=2 lands on row 4, and the
    // top spacer spans rows 0..3 at 2 visible pixels — NOT 4. Before the
    // flip the spacer math counted hidden rows at full height, so the
    // grid drifted by one hidden-row-height per hidden row above.
    const topSpacer = container.querySelector(
      '.spreadsheet-grid-virtual-spacer-row td',
    ) as HTMLElement
    expect(topSpacer).not.toBeNull()
    expect(topSpacer.style.height).toBe('2px')
    expect(container.querySelector('[data-cell-addr="B5"]')).not.toBeNull()

    // Total table width shrinks by the hidden column's width:
    // heading (44) + 9 visible columns × 1px.
    const table = container.querySelector('table.spreadsheet-grid-table') as HTMLElement
    expect(table.style.width).toBe('53px')
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

    // After clicking a merged-cell anchor, the selection covers the full
    // merge range with `anchor` at the top-left and `focus` at the bottom-
    // right. Anchor stays fixed when a subsequent Shift+click extends the
    // selection, so this layout lets the user grow the merge selection by
    // clicking past the bottom-right corner (Excel parity). Pinned by
    // `copy-as.spec.ts:210` 'emits rowspan/colspan on the anchor of a
    // merged A1:B2 region' — without this, Shift+click outside the merge
    // shrinks back through the anchor instead of extending past the focus.
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
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

  it('hosts one fill handle at the normalized bottom-right of a reverse selection', async () => {
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

    const { container, getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(9)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="C3"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(
      container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
      { shiftKey: true },
    )

    await waitFor(() => {
      expect(store.getter(selectionAtom)).toEqual({
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 0, col: 0 },
      })
      expect(container.querySelectorAll('.spreadsheet-grid-fill-handle')).toHaveLength(1)
      expect(getByTestId('fill-handle-C3')).toBeTruthy()
      expect(queryByTestId('fill-handle-A1')).toBeNull()
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
    fireEvent.click(
      container.querySelector('[data-cell-addr="C3"] .spreadsheet-grid-cell-button')!,
      {
        ctrlKey: true,
      },
    )

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
    fireEvent.click(
      container.querySelector('[data-cell-addr="C3"] .spreadsheet-grid-cell-button')!,
      {
        metaKey: true,
      },
    )
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

  it('row header label click selects the row even when the label span receives the event', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 5,
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
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('.spreadsheet-grid-row-header').length).toBeGreaterThan(0)
    })

    const rowHeader = container.querySelector(
      '.spreadsheet-grid-row-header[data-row="3"]',
    ) as HTMLElement
    expect(rowHeader).not.toBeNull()
    expect(rowHeader.getAttribute('data-selected')).toBe('false')
    fireEvent.click(rowHeader)
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'row',
      sheetId: 'sheet-1',
      rowAnchor: 3,
      rowFocus: 3,
    })
    expect(
      container
        .querySelector('.spreadsheet-grid-row-header[data-row="3"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')

    const colHeader = container.querySelector(
      '.spreadsheet-grid-col-header[data-col="2"]',
    ) as HTMLElement
    expect(colHeader).not.toBeNull()
    fireEvent.click(colHeader)
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'column',
      sheetId: 'sheet-1',
      colAnchor: 2,
      colFocus: 2,
    })
    expect(
      container
        .querySelector('.spreadsheet-grid-col-header[data-col="2"]')
        ?.getAttribute('data-selected'),
    ).toBe('true')
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
    expect(store.getter(selectionAtom).sheetId).toBe('sheet-3')

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'PageUp',
      ctrlKey: true,
    })

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionAtom).sheetId).toBe('sheet-2')
  })

  it('commits fill handle drag as a compact backend fillRange request', async () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    const fillRangeRequests: FillRangeRequest[] = []
    const { backend } = createFakeBackend()
    backend.fillRange = async (request) => {
      fillRangeRequests.push(request)
      const affectedRange = getFillHandleWriteRange(
        request.sourceRange,
        request.targetRange,
        request.direction,
      )!
      return {
        sheetId: request.sheetId,
        revision: 18,
        affectedRange,
        applied: true,
        historyTransactionCount: 1,
        historyDisposition: 'undoable',
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

  it('double-clicks the fill handle once when both trusted pointer commits stay in the source', async () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    const rangeRequests: RangeProjectionRequest[] = []
    const resolveRequests: ResolveDataEdgeRequest[] = []
    const fillRangeRequests: FillRangeRequest[] = []
    const { backend, requests: visibleRequests } = createFakeBackend()
    backend.readRangeProjection = async (request) => {
      rangeRequests.push(request)
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells: [
          {
            row: request.range.rowStart,
            col: request.range.colStart,
            displayValue: 'guide-1',
          },
          {
            row: request.range.rowEnd,
            col: request.range.colStart,
            displayValue: 'guide-2',
          },
        ],
      }
    }
    backend.resolveDataEdge = async (request) => {
      resolveRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        target: { row: 2, col: request.from.col },
      }
    }
    backend.fillRange = async (request) => {
      fillRangeRequests.push(request)
      return {
        sheetId: request.sheetId,
        revision: 18,
        affectedRange: getFillHandleWriteRange(
          request.sourceRange,
          request.targetRange,
          request.direction,
        )!,
        applied: true,
        historyTransactionCount: 1,
        historyDisposition: 'undoable',
      }
    }

    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 3,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }
    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(6)
    })
    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)

    const handle = getByTestId('fill-handle-A1')
    const sourceCell = container.querySelector('[data-cell-addr="A1"]') as HTMLElement
    const originalElementFromPoint = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => sourceCell,
    })

    try {
      // Chromium reports detail=0 for both trusted pointerdown/pointerup pairs.
      // Pointer movement that remains inside the selected source keeps each
      // pointer commit directionless; only the following dblclick may fill.
      dispatchPointerEvent(handle, 'pointerdown', { detail: 0, clientX: 1, clientY: 1 })
      dispatchPointerEvent(window, 'pointermove', { detail: 0, clientX: 1, clientY: 1 })
      dispatchPointerEvent(window, 'pointerup', { detail: 0, clientX: 1, clientY: 1 })
      dispatchPointerEvent(handle, 'pointerdown', { detail: 0, clientX: 1, clientY: 1 })
      dispatchPointerEvent(window, 'pointermove', { detail: 0, clientX: 1, clientY: 1 })
      dispatchPointerEvent(window, 'pointerup', { detail: 0, clientX: 1, clientY: 1 })
      fireEvent.dblClick(handle, { detail: 2 })
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      })
    }

    await waitFor(() => {
      expect(fillRangeRequests).toHaveLength(1)
    })
    await waitFor(() => {
      expect(visibleRequests.length).toBeGreaterThanOrEqual(2)
    })
    await flushMicrotasks()

    expect(rangeRequests).toHaveLength(1)
    expect(rangeRequests[0]).toMatchObject({
      kind: 'range',
      sheetId: 'sheet-1',
      reason: 'fill-handle',
      range: { rowStart: 0, rowEnd: 1, colStart: 1, colEnd: 1 },
    })
    expect(resolveRequests).toEqual([
      {
        kind: 'resolve-data-edge',
        sheetId: 'sheet-1',
        from: { row: 0, col: 1 },
        direction: 'down',
        bounds: { rowCount: 6, colCount: 4 },
        requestId: rangeRequests[0].requestId,
        revision: 17,
      },
    ])
    expect(fillRangeRequests).toEqual([
      {
        kind: 'fill-range',
        sheetId: 'sheet-1',
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'down',
        requestId: rangeRequests[0].requestId,
        revision: 17,
      },
    ])
  })

  it('dispatches one numeric fillSeries mutation bound to the accepted projection witness', async () => {
    const sourceCells: DisplayCell[] = [
      { row: 0, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
      { row: 1, col: 0, displayValue: '3', valueKind: 'number', numericValue: 3 },
    ]
    const result = await runFillSeriesDrag({
      sourceCells,
      expectedMutation: 'series',
    })

    expect(result.rangeRequests).toHaveLength(1)
    expect(result.rangeRequests[0]).toMatchObject({
      kind: 'range',
      sheetId: 'sheet-1',
      reason: 'fill-handle',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    })
    expect(result.fillSeriesRequests).toEqual([
      {
        kind: 'fill-series',
        sheetId: 'sheet-1',
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'integer-step',
        step: 2,
        requestId: result.rangeRequests[0].requestId,
        revision: 17,
      },
    ])
    expect(result.fillRangeRequests).toHaveLength(0)
    expect(result.setCellInputRequests).toHaveLength(0)
    expect(result.visibleRequests.length).toBeGreaterThanOrEqual(2)
  })

  it.each([
    {
      name: 'least-squares trend',
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number' as const, numericValue: 1 },
        { row: 1, col: 0, displayValue: '2', valueKind: 'number' as const, numericValue: 2 },
        { row: 2, col: 0, displayValue: '4', valueKind: 'number' as const, numericValue: 4 },
      ],
      sourceEndAddr: 'A3',
      expected: {
        series: 'linear-trend',
        step: 1.5,
      },
    },
    {
      name: 'single calendar date',
      sourceCells: [
        {
          row: 0,
          col: 0,
          displayValue: '2024-01-01',
          valueKind: 'number' as const,
          numericValue: 45_292,
          format: {
            numberFormat: {
              kind: 'date' as const,
              pattern: 'yyyy-mm-dd',
            },
          },
        },
      ],
      sourceEndAddr: 'A1',
      expected: {
        series: 'date-day',
        step: 1,
      },
    },
    {
      name: 'single text-number seed',
      sourceCells: [{ row: 0, col: 0, displayValue: 'Item009', valueKind: 'string' as const }],
      sourceEndAddr: 'A1',
      expected: {
        series: 'text-number',
        step: 1,
        textPattern: { prefix: 'Item', suffix: '', width: 3 },
      },
    },
    {
      name: 'single built-in weekday seed',
      sourceCells: [{ row: 0, col: 0, displayValue: 'Mon', valueKind: 'string' as const }],
      sourceEndAddr: 'A1',
      expected: {
        series: 'weekday-name',
        step: 1,
        list: {
          listName: 'builtin-weekday-short',
          values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
        },
      },
    },
  ])('dispatches $name through the compact fillSeries path', async (testCase) => {
    const result = await runFillSeriesDrag({
      sourceCells: testCase.sourceCells,
      sourceEndAddr: testCase.sourceEndAddr,
      expectedMutation: 'series',
    })

    expect(result.fillSeriesRequests).toHaveLength(1)
    expect(result.fillSeriesRequests[0]).toMatchObject({
      kind: 'fill-series',
      sheetId: 'sheet-1',
      targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      direction: 'down',
      ...testCase.expected,
    })
    expect(result.fillRangeRequests).toHaveLength(0)
    expect(result.setCellInputRequests).toHaveLength(0)
  })

  it.each([
    {
      name: 'constant numeric source',
      sourceCells: [
        { row: 0, col: 0, displayValue: '5', valueKind: 'number' as const, numericValue: 5 },
        { row: 1, col: 0, displayValue: '5', valueKind: 'number' as const, numericValue: 5 },
      ],
      expectedRangeReads: 1,
    },
    {
      name: 'formula source',
      sourceCells: [
        {
          row: 0,
          col: 0,
          displayValue: '1',
          valueKind: 'number' as const,
          numericValue: 1,
          formula: '=1',
        },
        { row: 1, col: 0, displayValue: '2', valueKind: 'number' as const, numericValue: 2 },
      ],
      expectedRangeReads: 1,
    },
    {
      name: 'mixed numeric and string source',
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number' as const, numericValue: 1 },
        { row: 1, col: 0, displayValue: 'x', valueKind: 'string' as const },
      ],
      expectedRangeReads: 1,
    },
    {
      name: 'multi-dimensional source',
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number' as const, numericValue: 1 },
        { row: 0, col: 1, displayValue: '2', valueKind: 'number' as const, numericValue: 2 },
        { row: 1, col: 0, displayValue: '3', valueKind: 'number' as const, numericValue: 3 },
        { row: 1, col: 1, displayValue: '4', valueKind: 'number' as const, numericValue: 4 },
      ],
      sourceEndAddr: 'B2',
      targetAddr: 'B4',
      expectedRangeReads: 0,
    },
  ])('keeps $name on the existing fillRange path', async (testCase) => {
    const result = await runFillSeriesDrag({
      sourceCells: testCase.sourceCells,
      sourceEndAddr: testCase.sourceEndAddr,
      targetAddr: testCase.targetAddr,
      expectedMutation: 'range',
    })

    expect(result.fillSeriesRequests).toHaveLength(0)
    expect(result.fillRangeRequests).toHaveLength(1)
    expect(result.rangeRequests).toHaveLength(testCase.expectedRangeReads)
    if (testCase.expectedRangeReads === 1) {
      expect(result.fillRangeRequests[0]).toMatchObject({
        requestId: result.rangeRequests[0].requestId,
        revision: 17,
      })
    } else {
      expect(result.fillRangeRequests[0]).not.toHaveProperty('requestId')
      expect(result.fillRangeRequests[0]).not.toHaveProperty('revision')
    }
  })

  it.each([
    [
      'missing revision',
      (request: RangeProjectionRequest, cells: DisplayCell[]): RangeProjectionResult => ({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        range: request.range,
        cells,
      }),
    ],
    [
      'truncated projection',
      (request: RangeProjectionRequest, cells: DisplayCell[]): RangeProjectionResult => ({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells,
        truncated: true,
      }),
    ],
    [
      'duplicate coordinate',
      (request: RangeProjectionRequest, cells: DisplayCell[]): RangeProjectionResult => ({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells: [cells[0], cells[0]],
      }),
    ],
    [
      'out-of-range coordinate',
      (request: RangeProjectionRequest, cells: DisplayCell[]): RangeProjectionResult => ({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells: [cells[0], { ...cells[1], row: 99 }],
      }),
    ],
    [
      'missing source cell',
      (request: RangeProjectionRequest, cells: DisplayCell[]): RangeProjectionResult => ({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 17,
        range: request.range,
        cells: [cells[0]],
      }),
    ],
  ])('fails closed to fillRange for a %s', async (_name, makeResult) => {
    const sourceCells: DisplayCell[] = [
      { row: 0, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
      { row: 1, col: 0, displayValue: '3', valueKind: 'number', numericValue: 3 },
    ]
    const result = await runFillSeriesDrag({
      sourceCells,
      expectedMutation: 'range',
      rangeResult: (request) => makeResult(request, sourceCells),
    })

    expect(result.rangeRequests).toHaveLength(1)
    expect(result.fillSeriesRequests).toHaveLength(0)
    expect(result.fillRangeRequests).toHaveLength(1)
    expect(result.fillRangeRequests[0]).not.toHaveProperty('requestId')
    expect(result.fillRangeRequests[0]).not.toHaveProperty('revision')
  })

  it('honors Ctrl copy-only and skips both projection detection and fillSeries', async () => {
    const result = await runFillSeriesDrag({
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
        { row: 1, col: 0, displayValue: '3', valueKind: 'number', numericValue: 3 },
      ],
      copyOnly: true,
      expectedMutation: 'range',
    })

    expect(result.rangeRequests).toHaveLength(0)
    expect(result.fillSeriesRequests).toHaveLength(0)
    expect(result.fillRangeRequests).toHaveLength(1)
    expect(result.fillRangeRequests[0]).not.toHaveProperty('requestId')
    expect(result.fillRangeRequests[0]).not.toHaveProperty('revision')
  })

  it('uses fillRange without a range read when fillSeries capability is absent', async () => {
    const result = await runFillSeriesDrag({
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
        { row: 1, col: 0, displayValue: '3', valueKind: 'number', numericValue: 3 },
      ],
      includeFillSeries: false,
      expectedMutation: 'range',
    })

    expect(result.rangeRequests).toHaveLength(0)
    expect(result.fillRangeRequests).toHaveLength(1)
    expect(result.fillRangeRequests[0]).not.toHaveProperty('requestId')
    expect(result.fillRangeRequests[0]).not.toHaveProperty('revision')
  })

  it('uses the existing per-cell fallback when fillSeries and fillRange are absent', async () => {
    const result = await runFillSeriesDrag({
      sourceCells: [
        { row: 0, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
        { row: 1, col: 0, displayValue: '3', valueKind: 'number', numericValue: 3 },
      ],
      includeFillSeries: false,
      includeFillRange: false,
      expectedMutation: 'cells',
      expectedCellWrites: 2,
    })

    expect(result.rangeRequests).toHaveLength(1)
    expect(result.fillSeriesRequests).toHaveLength(0)
    expect(result.fillRangeRequests).toHaveLength(0)
    expect(result.setCellInputRequests.map((request) => request.input)).toEqual(['1', '3'])
  })

  it('shifts fallback fill formulas from each repeated source coordinate', async () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    const setCellInputRequests: SetCellInputRequest[] = []
    const sourceCells: DisplayCell[] = [
      {
        row: 0,
        col: 0,
        displayValue: 'formula-a',
        valueKind: 'string',
        formula: '=$A1+B$1+$C$1+"A1"',
      },
      {
        row: 0,
        col: 1,
        displayValue: 'formula-b',
        valueKind: 'string',
        formula: '=Sheet1!B1',
      },
    ]
    const { backend } = createFakeBackend({ cells: sourceCells })
    backend.readRangeProjection = async (request) => ({
      kind: 'range',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision,
      range: request.range,
      cells: sourceCells,
    })
    backend.setCellInput = async (request) => {
      setCellInputRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 18,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    }
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 1,
      viewportWidth: 6,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 4,
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
    fireEvent.click(
      container.querySelector('[data-cell-addr="B1"] .spreadsheet-grid-cell-button')!,
      {
        shiftKey: true,
      },
    )

    const targetCell = container.querySelector('[data-cell-addr="F1"]') as HTMLElement
    const originalElementFromPoint = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => targetCell,
    })

    try {
      dispatchPointerEvent(getByTestId('fill-handle-B1'), 'pointerdown', {
        clientX: 2,
        clientY: 1,
      })
      dispatchPointerEvent(window, 'pointermove', { clientX: 6, clientY: 1 })
      dispatchPointerEvent(window, 'pointerup', { clientX: 6, clientY: 1 })

      await waitFor(() => {
        expect(setCellInputRequests).toHaveLength(4)
      })
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      })
    }

    expect(setCellInputRequests).toEqual([
      {
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 2,
        input: '=$A1+D$1+$C$1+"A1"',
      },
      {
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 3,
        input: '=Sheet1!D1',
      },
      {
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 4,
        input: '=$A1+F$1+$C$1+"A1"',
      },
      {
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 5,
        input: '=Sheet1!F1',
      },
    ])
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

  it('keeps the horizontal scroll range in sync with resized columns', async () => {
    const store = createStore()
    const { backend, requests } = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 20,
      viewportWidth: 100,
      rowHeight: 20,
      colWidth: 50,
      rowCount: 1,
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
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(2)
    })

    dispatchPointerEvent(getByTestId('col-resize-0'), 'pointerdown', { clientX: 100 })
    dispatchPointerEvent(window, 'pointermove', { clientX: 250 })
    dispatchPointerEvent(window, 'pointerup', { clientX: 250 })

    await waitFor(() => {
      expect((container.querySelector('.spreadsheet-grid-table') as HTMLElement).style.width).toBe(
        '394px',
      )
    })

    const scroller = container.querySelector('.spreadsheet-grid-scroll-viewport') as HTMLDivElement
    scroller.scrollLeft = 220
    fireEvent.scroll(scroller)

    await waitFor(() => {
      expect(requests[requests.length - 1]?.window).toEqual({
        rowStart: 0,
        rowEnd: 0,
        colStart: 1,
        colEnd: 3,
      })
    })

    expect(store.getter(viewportMetricsAtom).scrollLeft).toBe(220)
    expect(
      (
        container.querySelector(
          '.spreadsheet-grid-row .spreadsheet-grid-virtual-spacer',
        ) as HTMLElement
      ).style.width,
    ).toBe('200px')
    expect(container.querySelector('[data-cell-addr="B1"]')).not.toBeNull()
    expect(container.querySelector('[data-cell-addr="D1"]')).not.toBeNull()
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
        (container.querySelector('.spreadsheet-grid-col-header[data-col="1"]') as HTMLElement).style
          .width,
      ).toBe('132px')
    })

    // One windowed sizes hydration (with requestId) plus the one-shot
    // full-sheet hidden seed (without requestId).
    const windowedSizeRequests = sizeRequests.filter((request) => request.requestId !== undefined)
    expect(windowedSizeRequests).toHaveLength(1)
    expect(windowedSizeRequests[0].window).toEqual({
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

  it('reconciles only the hydrated sizes window and never clobbers locally owned hidden state', async () => {
    const store = createStore()
    store.setter(setViewportRowHeightAtom, {
      sheetId: 'sheet-1',
      rowIndex: 4,
      heightPx: 54,
    })
    store.setter(setViewportColumnWidthAtom, {
      sheetId: 'sheet-1',
      colIndex: 4,
      widthPx: 154,
    })
    // Local canonical hidden commands claim the sheet before mount.
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [4] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet-1', indices: [4] })
    const { backend } = createFakeBackend({
      rowHeights: [{ rowIndex: 1, heightPx: 41 }],
      colWidths: [{ colIndex: 1, widthPx: 131 }],
      hiddenRowIndices: [1],
      hiddenColIndices: [1],
    })
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 6,
      overscanRows: 0,
      overscanCols: 0,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(viewportSizeOverridesAtom)).toEqual({
        rowHeightsBySheet: { 'sheet-1': { '1': 41, '4': 54 } },
        colWidthsBySheet: { 'sheet-1': { '1': 131, '4': 154 } },
      })
    })
    // The one-shot seed skipped: local commands own the sheet, and the
    // backend mirror's hidden slices can never clobber local truth.
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { 'sheet-1': [4] },
      colsBySheet: { 'sheet-1': [4] },
    })
  })

  it('keeps the latest Grid hydration when viewport requests resolve out of order', async () => {
    const store = createStore()
    const { backend, sizeRequests } = createFakeBackend()
    const pending: Array<{
      request: ViewportSizeProjectionRequest
      resolve(result: ViewportSizeProjectionResult): void
    }> = []
    backend.readViewportSizeProjection = (request) => {
      sizeRequests.push(request)
      // The one-shot hidden seed reads without a requestId; answer it
      // immediately as hidden-unsupported so only the windowed sizes
      // hydrations stay pending for the out-of-order race.
      if (request.requestId === undefined) {
        return Promise.resolve({
          kind: 'viewport-size',
          sheetId: request.sheetId,
          window: { ...request.window },
          revision: 1,
          rowHeights: [],
          colWidths: [],
        })
      }
      return new Promise<ViewportSizeProjectionResult>((resolve) => {
        pending.push({ request, resolve: (result) => resolve(result) })
      })
    }
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
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

    await waitFor(() => expect(pending).toHaveLength(1))
    const scroller = container.querySelector('.spreadsheet-grid-scroll-viewport') as HTMLElement
    scroller.scrollTop = 2
    scroller.scrollLeft = 2
    fireEvent.scroll(scroller)
    await waitFor(() => expect(pending).toHaveLength(2))

    const latest = pending[1].request
    pending[1].resolve({
      kind: 'viewport-size',
      sheetId: latest.sheetId,
      requestId: latest.requestId,
      revision: 2,
      window: { ...latest.window },
      rowHeights: [{ rowIndex: 2, heightPx: 42 }],
      colWidths: [{ colIndex: 2, widthPx: 142 }],
      hiddenRowIndices: [],
      hiddenColIndices: [],
    })

    await waitFor(() => {
      expect(store.getter(viewportSizeOverridesAtom)).toEqual({
        rowHeightsBySheet: { 'sheet-1': { '2': 42 } },
        colWidthsBySheet: { 'sheet-1': { '2': 142 } },
      })
    })
    const acceptedSizes = store.getter(viewportSizeOverridesAtom)
    const acceptedHidden = store.getter(viewportHiddenAtom)

    const stale = pending[0].request
    pending[0].resolve({
      kind: 'viewport-size',
      sheetId: stale.sheetId,
      requestId: stale.requestId,
      revision: 1,
      window: { ...stale.window },
      rowHeights: [{ rowIndex: 0, heightPx: 40 }],
      colWidths: [{ colIndex: 0, widthPx: 140 }],
      hiddenRowIndices: [0],
      hiddenColIndices: [0],
    })
    await flushMicrotasks()

    expect(store.getter(viewportSizeOverridesAtom)).toBe(acceptedSizes)
    expect(store.getter(viewportHiddenAtom)).toBe(acceptedHidden)
  })

  it('commits sizes-only metadata from the worker backend without replacing hidden state', async () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [4] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet-1', indices: [4] })
    const hiddenBefore = store.getter(viewportHiddenAtom)
    const client = {
      async initWorkbook(names?: string[]) {
        return [{ idx: 0, name: names?.[0] ?? 'Sheet1' }]
      },
      onCellsDirty() {
        return () => undefined
      },
      async readSparseRange() {
        return []
      },
      async snapshotFormatRange(range: {
        sheet: number
        startRow: number
        startCol: number
        endRow: number
        endCol: number
      }) {
        return { ...range, cellFormats: [], rangeFormats: [] }
      },
      async snapshotViewportSizes(range: {
        sheet: number
        startRow: number
        startCol: number
        endRow: number
        endCol: number
      }) {
        return {
          ...range,
          rowHeights: [{ rowIndex: 1, heightPx: 43 }],
          colWidths: [{ colIndex: 1, widthPx: 143 }],
        }
      },
      dispose() {},
    } as unknown as WorkerWorkbookClient
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      revision: 7,
    })
    await backend.ready()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 6,
      overscanRows: 0,
      overscanCols: 0,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(viewportSizeOverridesAtom)).toEqual({
        rowHeightsBySheet: { 'sheet-1': { '1': 43 } },
        colWidthsBySheet: { 'sheet-1': { '1': 143 } },
      })
    })
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)
    backend.dispose()
  })

  it('commits sizes independently and fails the hidden seed closed on malformed hidden payloads', async () => {
    const store = createStore()
    const hiddenBefore = store.getter(viewportHiddenAtom)
    // hiddenColIndices missing while hiddenRowIndices is present: the
    // hidden seed rejects the payload; the sizes hydration is unaffected
    // because hidden is no longer part of the sizes contract.
    const { backend, sizeRequests } = createFakeBackend({
      rowHeights: [{ rowIndex: 1, heightPx: 41 }],
      colWidths: [{ colIndex: 1, widthPx: 141 }],
      hiddenRowIndices: [1],
    })
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 6,
      colCount: 6,
      overscanRows: 0,
      overscanCols: 0,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(sizeRequests.length).toBeGreaterThanOrEqual(2))
    await flushMicrotasks()
    await waitFor(() => {
      expect(store.getter(viewportSizeOverridesAtom)).toEqual({
        rowHeightsBySheet: { 'sheet-1': { '1': 41 } },
        colWidthsBySheet: { 'sheet-1': { '1': 141 } },
      })
    })
    expect(store.getter(viewportHiddenAtom)).toBe(hiddenBefore)
    expect(store.getter(viewportHiddenDiagnosticAtom)).toMatchObject({
      kind: 'hydrate-failed',
      sheetId: 'sheet-1',
    })
  })

  it('keeps Grid metadata hydration behind the UI-core command boundary', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/grid/SpreadsheetGrid.tsx'),
      'utf8',
    )

    expect(source).toContain('store.setter(hydrateViewportSizeProjectionAtom')
    expect(source).toContain('store.setter(hydrateViewportHiddenAtom')
    expect(source).not.toMatch(/\bbackend\s*\.\s*readViewportSizeProjection\b/)
    expect(source).not.toContain('setViewportHiddenAtom')
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
    fireEvent.click(
      container.querySelector('[data-cell-addr="C2"] .spreadsheet-grid-cell-button')!,
      {
        shiftKey: true,
      },
    )

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

  it('opens the canonical selected range context menu from keyboard without changing selection', async () => {
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

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(16)
    })

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(
      container.querySelector('[data-cell-addr="C2"] .spreadsheet-grid-cell-button')!,
      { shiftKey: true },
    )

    const selectionBefore = store.getter(selectionAtom)
    const activeCell = container.querySelector('[data-cell-addr="C2"]') as HTMLElement
    jest.spyOn(activeCell, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 30,
      bottom: 40,
      width: 10,
      height: 10,
      toJSON: () => ({}),
    } as DOMRect)

    const grid = getByTestId('grid')
    grid.focus()
    fireEvent.keyDown(grid, { key: 'F10', shiftKey: true })

    expect(store.getter(menuStateAtom)).toMatchObject({
      status: 'open',
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 },
      },
      position: { x: 20, y: 40 },
    })
    expect(store.getter(menuIntentAtom)).toMatchObject({
      type: 'menu.open',
      source: 'keyboard',
      target: { kind: 'range', sheetId: 'sheet-1' },
    })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)

    fireEvent.keyDown(grid, { key: 'ContextMenu' })

    expect(store.getter(menuIntentAtom)).toMatchObject({
      type: 'menu.open',
      source: 'keyboard',
      target: { kind: 'range', sheetId: 'sheet-1' },
    })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)
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
    fireEvent.click(
      container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!,
      {
        shiftKey: true,
      },
    )

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
    fireEvent.click(
      container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!,
      {
        shiftKey: true,
      },
    )
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
    backend.setCellInput = async (request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
    })

    // protect the sheet with no unlocked ranges → all cells locked
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
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
    // double-click to trigger edit start
    fireEvent.dblClick(container.querySelector('[data-cell-addr="A1"]')!)

    expect(store.getter(editingSessionAtom).status).toBe('idle')
  })

  it('Ctrl+B on a protected sheet is blocked with zero setFormatRange transport', async () => {
    const store = createStore()
    const setFormatRangeRequests: SetFormatRangeRequest[] = []
    const { backend } = createFakeBackend()
    backend.setFormatRange = async (request) => {
      setFormatRangeRequests.push(request)
      return { sheetId: request.sheetId, revision: 31, affectedRange: request.range }
    }

    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

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
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'b',
      ctrlKey: true,
    })

    await flushMicrotasks()
    expect(setFormatRangeRequests).toHaveLength(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  it('Ctrl+B under an active filter writes one format range over the selection', async () => {
    const store = createStore()
    const setFormatRangeRequests: SetFormatRangeRequest[] = []
    // A filter withheld row 2; every other row keeps its own index (#27 —
    // hidden, not compacted). Under the retired compaction this split into two
    // transports on source rows 5 and 3.
    const { backend } = createFakeBackend({
      cells: (window) => {
        const cells: DisplayCell[] = []
        for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
          if (row === 2) continue
          for (let col = window.colStart; col <= window.colEnd; col += 1) {
            cells.push({ row, col, displayValue: `s${row},${col}` })
          }
        }
        return cells
      },
    })
    backend.setFormatRange = async (request) => {
      setFormatRangeRequests.push(request)
      return { sheetId: request.sheetId, revision: 32, affectedRange: request.range }
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

    // A2:B3 = rows 1..2, cols 0..1. Row 2 is filtered away but stays inside
    // the range: Excel formats through a filtered view, it does not skip rows.
    fireEvent.click(container.querySelector('[data-cell-addr="A2"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(
      container.querySelector('[data-cell-addr="B3"] .spreadsheet-grid-cell-button')!,
      {
        shiftKey: true,
      },
    )
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'b',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(setFormatRangeRequests).toHaveLength(1)
    })
    expect(setFormatRangeRequests.map((request) => request.range)).toEqual([
      { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 1 },
    ])
    expect(setFormatRangeRequests.every((request) => request.format?.bold === true)).toBe(true)
    // One UI history entry per transport (N:N with per-mutation adapters).
    const entries = store.getter(historyStackAtom).entries
    expect(entries).toHaveLength(1)
    expect(entries.every((entry) => entry.kind === 'format.set')).toBe(true)
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

  // Regression for the format-wiping defect: Ctrl+1 used to open Format
  // Cells with no `initialFormat` seed, so the category detector fell back
  // to 'general' and a no-op save silently overwrote the active cell's real
  // number format.
  it('regression: Ctrl+1 seeds Format Cells with the active cell format and preserves it on an unedited save', async () => {
    const store = createStore()
    const setFormatRangeRequests: SetFormatRangeRequest[] = []
    const { backend } = createFakeBackend({
      cells: (window) => {
        const cells: DisplayCell[] = []
        for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
          for (let col = window.colStart; col <= window.colEnd; col += 1) {
            if (row === 0 && col === 0) {
              cells.push({
                row,
                col,
                displayValue: '120.000',
                valueKind: 'number',
                numericValue: 120,
                format: { numberFormat: { kind: 'decimal', digits: 3 } },
              })
              continue
            }
            cells.push({ row, col, displayValue: `${row},${col}` })
          }
        }
        return cells
      },
    })
    backend.setFormatRange = async (request) => {
      setFormatRangeRequests.push(request)
      return { sheetId: request.sheetId, revision: 2, affectedRange: request.range }
    }

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
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(4)
    })

    fireEvent.click(
      container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!,
    )
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: '1',
      ctrlKey: true,
    })

    // The dialog's category radio must reflect the cell's real category
    // ('decimal' -> 'number'), never fall back to 'general'.
    await waitFor(() => {
      expect(
        (
          document.body.querySelector(
            '[data-testid="format-cells-category-number"]',
          ) as HTMLInputElement | null
        )?.checked,
      ).toBe(true)
    })
    expect(
      (
        document.body.querySelector(
          '[data-testid="format-cells-category-general"]',
        ) as HTMLInputElement | null
      )?.checked,
    ).toBe(false)

    fireEvent.click(document.body.querySelector('[data-testid="format-cells-save"]')!)

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0].format?.numberFormat).toEqual({ kind: 'decimal', digits: 3 })
  })

  it('filter chevron renders when column has an active filter rule and opens dropdown on click', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 1, value: 'yes' }] },
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

    expect(store.getter(filterDropdownAtom)).toMatchObject({
      status: 'open',
      sheetId: 'sheet-1',
      colIndex: 1,
    })
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
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'yes' }] },
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
      participant: {
        id: 'user-42',
        displayName: 'Alice',
        colorHint: '#ff0000',
        lastSeenAt: Date.now(),
      },
    })
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'user-42',
      sheetId: 'sheet-1',
      selection: {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 1, col: 1 },
        focus: { row: 1, col: 1 },
      },
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
      expect(store.getter(clipboardStateAtom).status).toBe('ready')
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

  it('applies transform: rotate(...) when format.rotation is numeric (Wave 6.2)', async () => {
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
      expect(container.querySelector('[data-cell-addr="A1"] .cell-display')?.textContent).toContain(
        'long sentence',
      )
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
        cells: [{ row: 0, col: 0, displayValue: 'existing', valueKind: 'string' }],
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
        cells: [{ row: 0, col: 0, displayValue: 'existing', valueKind: 'string' }],
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
        cells: [{ row: 0, col: 0, displayValue: 'existing', valueKind: 'string' }],
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

  describe('freeze boundary attributes', () => {
    it('keeps the locally seeded freeze across a backend swap in the same store', async () => {
      // UI-core canonical: the first mount's one-shot hydration seeds the
      // sheet; a later backend's hydration must not clobber the local
      // view fact, and the divider never disappears while ports resolve.
      const store = createStore()
      const first = createFakeBackend({ freeze: { rows: 2, cols: 2 } })
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 4,
        viewportWidth: 4,
        rowHeight: 1,
        colWidth: 1,
        rowCount: 8,
        colCount: 8,
        overscanRows: 0,
        overscanCols: 0,
      }

      const firstMount = render(() => (
        <SpreadsheetUiProvider backend={first.backend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))
      await waitFor(() => {
        expect(
          firstMount.container.querySelector('[data-testid="freeze-boundary-horizontal"]'),
        ).not.toBeNull()
      })
      firstMount.unmount()

      const second = createFakeBackend({ freeze: { rows: 1, cols: 0 } })
      let readCalls = 0
      second.backend.readFreezeConfig = async (request) => {
        readCalls += 1
        return {
          kind: 'freeze-config',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 7,
          freeze: { rows: 1, cols: 0 },
        }
      }

      const secondMount = render(() => (
        <SpreadsheetUiProvider backend={second.backend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))
      await flushMicrotasks()
      // The local canonical freeze (2,2) survives the swap: both dividers
      // stay up and backend B's differing persisted value is ignored.
      expect(
        secondMount.container.querySelector('[data-testid="freeze-boundary-horizontal"]'),
      ).not.toBeNull()
      expect(
        secondMount.container.querySelector('[data-testid="freeze-boundary-vertical"]'),
      ).not.toBeNull()
      expect(readCalls).toBe(0)
    })

    it('renders the divider from local canonical freeze without backend ports', async () => {
      const store = createStore()
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 4,
        viewportWidth: 4,
        rowHeight: 1,
        colWidth: 1,
        rowCount: 8,
        colCount: 8,
        overscanRows: 0,
        overscanCols: 0,
      }
      store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 2, cols: 2 })
      const portlessBackend: SpreadsheetBackend = {
        ...createFakeBackend().backend,
        readFreezeConfig: undefined,
        setFreezeConfig: undefined,
      }

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={portlessBackend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))
      await flushMicrotasks()

      expect(container.querySelector('svg.spreadsheet-grid-freeze-boundary')).not.toBeNull()
      expect(
        container.querySelectorAll('[data-freeze-boundary-bottom="true"]').length,
      ).toBeGreaterThan(0)
      expect(
        container.querySelectorAll('[data-freeze-boundary-right="true"]').length,
      ).toBeGreaterThan(0)
    })

    it('flags the last frozen row and column with data-freeze-boundary-* on cells and headers', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({ freeze: { rows: 2, cols: 3 } })
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 4,
        viewportWidth: 4,
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

      await flushMicrotasks()

      // Last frozen row index is 1; cells at row=1 should carry the bottom boundary,
      // and only row=1 — not row=0 (mid-frozen) or row=2 (first scrollable).
      const bottomCells = container.querySelectorAll(
        'td.spreadsheet-grid-cell[data-freeze-boundary-bottom="true"]',
      )
      const bottomRows = new Set(Array.from(bottomCells).map((n) => n.getAttribute('data-row')))
      expect(bottomRows).toEqual(new Set(['1']))

      // Last frozen col index is 2; same check on right boundary.
      const rightCells = container.querySelectorAll(
        'td.spreadsheet-grid-cell[data-freeze-boundary-right="true"]',
      )
      const rightCols = new Set(Array.from(rightCells).map((n) => n.getAttribute('data-col')))
      expect(rightCols).toEqual(new Set(['2']))

      // The single cell at row=1, col=2 sits on both boundaries.
      expect(
        container.querySelector(
          'td.spreadsheet-grid-cell[data-row="1"][data-col="2"][data-freeze-boundary-bottom="true"][data-freeze-boundary-right="true"]',
        ),
      ).not.toBeNull()

      // Row header at the last frozen row gets the bottom boundary too.
      expect(
        container.querySelector(
          'th.spreadsheet-grid-row-header[data-row="1"][data-freeze-boundary-bottom="true"]',
        ),
      ).not.toBeNull()
      expect(
        container.querySelector(
          'th.spreadsheet-grid-row-header[data-row="0"][data-freeze-boundary-bottom="true"]',
        ),
      ).toBeNull()

      // Col header at the last frozen col gets the right boundary too.
      expect(
        container.querySelector(
          'th.spreadsheet-grid-col-header[data-col="2"][data-freeze-boundary-right="true"]',
        ),
      ).not.toBeNull()
      expect(
        container.querySelector(
          'th.spreadsheet-grid-col-header[data-col="1"][data-freeze-boundary-right="true"]',
        ),
      ).toBeNull()
    })

    it('does not set boundary attrs when freeze is inactive', async () => {
      const store = createStore()
      const { backend } = createFakeBackend()
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 3,
        viewportWidth: 3,
        rowHeight: 1,
        colWidth: 1,
        rowCount: 5,
        colCount: 5,
        overscanRows: 0,
        overscanCols: 0,
      }

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))

      await flushMicrotasks()

      expect(container.querySelectorAll('[data-freeze-boundary-bottom="true"]')).toHaveLength(0)
      expect(container.querySelectorAll('[data-freeze-boundary-right="true"]')).toHaveLength(0)
    })

    it('renders an SVG overlay with the freeze boundary lines at the cumulative pixel offsets', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({ freeze: { rows: 2, cols: 3 } })
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 8,
        viewportWidth: 8,
        rowHeight: 2,
        colWidth: 4,
        rowCount: 12,
        colCount: 8,
        overscanRows: 0,
        overscanCols: 0,
      }

      // Freeze first 2 rows and first 3 cols. With rowHeight=2 / colWidth=4,
      // the horizontal line should sit at y = headerHeight(2) + 2*2 = 6, and
      // the vertical line at x = rowHeaderWidth(44) + 3*4 = 56.
      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))

      await flushMicrotasks()

      const overlay = container.querySelector('svg.spreadsheet-grid-freeze-boundary')
      expect(overlay).not.toBeNull()

      const horizontal = container.querySelector('[data-testid="freeze-boundary-horizontal"]')
      const vertical = container.querySelector('[data-testid="freeze-boundary-vertical"]')
      expect(horizontal).not.toBeNull()
      expect(vertical).not.toBeNull()

      expect(horizontal!.getAttribute('y1')).toBe('6')
      expect(horizontal!.getAttribute('y2')).toBe('6')
      expect(vertical!.getAttribute('x1')).toBe('56')
      expect(vertical!.getAttribute('x2')).toBe('56')
    })

    it('omits the SVG overlay entirely when freeze is inactive', async () => {
      const store = createStore()
      const { backend } = createFakeBackend()
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 3,
        viewportWidth: 3,
        rowHeight: 1,
        colWidth: 1,
        rowCount: 5,
        colCount: 5,
        overscanRows: 0,
        overscanCols: 0,
      }

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
        </SpreadsheetUiProvider>
      ))

      await flushMicrotasks()

      expect(container.querySelector('svg.spreadsheet-grid-freeze-boundary')).toBeNull()
    })

    it('renders only the horizontal line when only rows are frozen', async () => {
      const store = createStore()
      const { backend } = createFakeBackend({ freeze: { rows: 1, cols: 0 } })
      const viewport = {
        scrollTop: 0,
        scrollLeft: 0,
        viewportHeight: 4,
        viewportWidth: 4,
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

      await flushMicrotasks()

      expect(container.querySelector('[data-testid="freeze-boundary-horizontal"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="freeze-boundary-vertical"]')).toBeNull()
    })
  })
})
