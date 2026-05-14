/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { menuStateAtom, selectionAtom, visibleWindowAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
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

function createFakeBackend() {
  const requests: VisibleProjectionRequest[] = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      requests.push(request)
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
    async setCellInput() {
      throw new Error('not used')
    },
  }

  return { backend, requests }
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
})
