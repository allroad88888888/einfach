/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  ImportCellChunksRequest,
  ImportCellInput,
  ImportCellsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  RangeProjectionRequest,
  RangeTsvChunkExportResult,
  RangeTsvExportRequest,
  RangeTsvExportResult,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  clipboardStateAtom,
  menuCommandIntentAtom,
  menuStateAtom,
  openMenuAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { spreadsheetProjectionSnapshotAtom, SpreadsheetUiProvider } from '../src-vnext/provider'

let restoreClipboard: (() => void) | null = null

afterEach(() => {
  cleanup()
  restoreClipboard?.()
  restoreClipboard = null
})

function installClipboard(initialText = '') {
  let text = initialText
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const clipboard = {
    writeText: jest.fn(async (nextText: string) => {
      text = nextText
    }),
    readText: jest.fn(async () => text),
    getText: () => text,
  }

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  })
  restoreClipboard = () => {
    if (previous) {
      Object.defineProperty(navigator, 'clipboard', previous)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  }

  return clipboard
}

function createFakeBackend() {
  const setCellInputRequests: SetCellInputRequest[] = []
  const clearRangeRequests: ClearRangeRequest[] = []
  const insertRowsRequests: InsertRowsRequest[] = []
  const deleteRowsRequests: DeleteRowsRequest[] = []
  const insertColumnsRequests: InsertColumnsRequest[] = []
  const deleteColumnsRequests: DeleteColumnsRequest[] = []
  const importCellsRequests: ImportCellsRequest[] = []
  const importCellChunksRequests: ImportCellChunksRequest[] = []
  const importCellChunkBatches: ImportCellInput[][] = []
  const readVisibleRequests: VisibleProjectionRequest[] = []
  const readRangeRequests: RangeProjectionRequest[] = []
  const exportRangeTsvRequests: RangeTsvExportRequest[] = []
  const consumeExportRangeTsvChunksRequests: RangeTsvExportRequest[] = []
  const rangeCells = [
    { row: 0, col: 0, displayValue: 'A1' },
    { row: 0, col: 1, displayValue: '2', formula: '=A1+1' },
    { row: 1, col: 0, displayValue: 'A2' },
    { row: 1, col: 1, displayValue: 'B2' },
  ]
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      readVisibleRequests.push(request)
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        window: request.window,
        cells: [],
      }
    },
    async readRangeProjection(request) {
      readRangeRequests.push(request)
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        range: request.range,
        cells: rangeCells.filter(
          (cell) =>
            cell.row >= request.range.rowStart &&
            cell.row <= request.range.rowEnd &&
            cell.col >= request.range.colStart &&
            cell.col <= request.range.colEnd,
        ),
      }
    },
    async exportRangeTsv(request): Promise<RangeTsvExportResult> {
      exportRangeTsvRequests.push(request)
      return {
        kind: 'range-tsv',
        sheetId: request.sheetId,
        range: request.range,
        requestId: request.requestId,
        revision: request.revision,
        originAddr: 'A1',
        text: '1\t2',
        estimatedBytes: 3,
      }
    },
    async consumeExportRangeTsvChunks(request, onChunk): Promise<RangeTsvChunkExportResult> {
      consumeExportRangeTsvChunksRequests.push(request)
      await onChunk({
        startRow: request.range.rowStart,
        endRow: request.range.rowEnd,
        text: '1\t2',
      })
      return {
        kind: 'range-tsv-chunks',
        sheetId: request.sheetId,
        range: request.range,
        requestId: request.requestId,
        revision: request.revision,
        originAddr: 'A1',
        estimatedBytes: 3,
      }
    },
    async setCellInput(request) {
      setCellInputRequests.push(request)
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
    async importCells(request) {
      importCellsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: request.range,
      }
    },
    async importCellChunks(request) {
      importCellChunksRequests.push(request)
      for await (const chunk of request.chunks) {
        importCellChunkBatches.push([...chunk])
      }
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: request.range,
      }
    },
    async clearRange(request) {
      clearRangeRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: request.range,
      }
    },
    async insertRows(request) {
      insertRowsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
      }
    },
    async deleteRows(request) {
      deleteRowsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
      }
    },
    async insertColumns(request) {
      insertColumnsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
      }
    },
    async deleteColumns(request) {
      deleteColumnsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
      }
    },
  }

  return {
    backend,
    setCellInputRequests,
    clearRangeRequests,
    insertRowsRequests,
    deleteRowsRequests,
    insertColumnsRequests,
    deleteColumnsRequests,
    importCellsRequests,
    importCellChunksRequests,
    importCellChunkBatches,
    readVisibleRequests,
    readRangeRequests,
    exportRangeTsvRequests,
    consumeExportRangeTsvChunksRequests,
  }
}

describe('vNext SpreadsheetContextMenu', () => {
  it('renders open menu state including position and target metadata', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 1, col: 2 },
      },
      position: { x: 14.7, y: 8.9 },
      source: 'pointer',
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const menu = await waitFor(() => getByTestId('spreadsheet-context-menu'))

    expect(menu.style.left).toBe('14px')
    expect(menu.style.top).toBe('8px')
    expect(menu.getAttribute('data-menu-target-kind')).toBe('cell')
    expect(menu.getAttribute('data-menu-target-sheet-id')).toBe('sheet-1')
    expect(getByTestId('context-menu-command-clipboard.copy').textContent).toBe('Copy')
    expect(getByTestId('context-menu-command-cell.clear').textContent).toBe('Delete')
    expect(queryByTestId('context-menu-command-row.insert')).toBeNull()
    expect(queryByTestId('context-menu-command-column.delete')).toBeNull()
  })

  it('dispatches a menu.command intent when Delete is clicked', async () => {
    const store = createStore()
    const { backend, setCellInputRequests, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [{ row: 3, col: 4, displayValue: 'delete me' }],
      },
    })

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 3, col: 4 },
      },
      position: { x: 0, y: 0 },
      source: 'keyboard',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const deleteButton = getByTestId('context-menu-command-cell.clear')
    fireEvent.click(deleteButton)

    expect(store.getter(menuCommandIntentAtom)).toEqual({
      type: 'menu.command',
      command: 'cell.clear',
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 3, col: 4 },
      },
    })

    await waitFor(() =>
      expect(setCellInputRequests).toEqual([
        {
          kind: 'set-cell-input',
          sheetId: 'sheet-1',
          row: 3,
          col: 4,
          input: '',
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(1))
    expect(readVisibleRequests[0]).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window,
      reason: 'selection',
    })

    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))
  })

  it('keeps menu.command intent when Delete is clicked', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 5, col: 6 },
      },
      position: { x: 0, y: 0 },
      source: 'keyboard',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-cell.clear'))

    expect(store.getter(menuCommandIntentAtom)).toEqual({
      type: 'menu.command',
      command: 'cell.clear',
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 5, col: 6 },
      },
    })

    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))
  })

  it('clears the whole range target when Delete is clicked on a range menu', async () => {
    const store = createStore()
    const { backend, clearRangeRequests, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          { row: 0, col: 0, displayValue: 'A1' },
          { row: 1, col: 2, displayValue: 'C2' },
        ],
      },
    })
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-cell.clear'))

    await waitFor(() =>
      expect(clearRangeRequests).toEqual([
        {
          kind: 'clear-range',
          sheetId: 'sheet-1',
          range,
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(1))
    expect(readVisibleRequests[0]).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window,
      reason: 'selection',
    })
    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))
  })

  it('copies a range target through range projection into the system clipboard', async () => {
    const clipboard = installClipboard()
    const store = createStore()
    const { backend, readRangeRequests } = createFakeBackend()
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }

    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.copy'))

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    expect(readRangeRequests).toEqual([
      {
        kind: 'range',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'clipboard',
        range,
        revision: undefined,
        cancelToken: undefined,
      },
    ])
    expect(clipboard.getText()).toBe('# einfach-clipboard-origin: A1\nA1\t=A1+1\nA2\tB2')
    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'ready',
      intent: {
        type: 'clipboard.copy',
      },
      payload: {
        cellCount: 4,
        includesFormulas: true,
      },
    })
    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))
  })

  it('copies oversized range targets through backend TSV chunk consumption', async () => {
    const clipboard = installClipboard()
    const store = createStore()
    const {
      backend,
      readRangeRequests,
      exportRangeTsvRequests,
      consumeExportRangeTsvChunksRequests,
    } = createFakeBackend()
    const range = { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 99 }

    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.copy'))

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    expect(consumeExportRangeTsvChunksRequests).toEqual([
      {
        kind: 'export-range-tsv',
        sheetId: 'sheet-1',
        range,
        requestId: 1,
      },
    ])
    expect(exportRangeTsvRequests).toEqual([])
    expect(readRangeRequests).toEqual([])
    expect(clipboard.getText()).toBe('# einfach-clipboard-origin: A1\n1\t2')
    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'ready',
      intent: {
        type: 'clipboard.copy',
      },
      payload: {
        cellCount: 10_100,
        serialization: 'tab-separated',
      },
    })
  })

  it('reports unavailable backend streaming export for oversized copy ranges', async () => {
    const store = createStore()
    const { backend, readRangeRequests } = createFakeBackend()
    const range = { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 99 }

    delete backend.exportRangeTsv
    delete backend.consumeExportRangeTsvChunks

    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.copy'))

    await waitFor(() =>
      expect(store.getter(clipboardStateAtom)).toMatchObject({
        status: 'error',
        error: {
          code: 'BACKEND_ERROR',
        },
      }),
    )
    expect(store.getter(clipboardStateAtom).error?.message).toMatch(
      /backend streaming export unavailable/i,
    )
    expect(readRangeRequests).toEqual([])
  })

  it('cuts a range target by copying and then clearing through backend clearRange', async () => {
    const clipboard = installClipboard()
    const store = createStore()
    const { backend, clearRangeRequests, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [],
      },
    })
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.cut'))

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(clearRangeRequests).toEqual([
        {
          kind: 'clear-range',
          sheetId: 'sheet-1',
          range,
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(1))
    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'ready',
      intent: {
        type: 'clipboard.cut',
      },
    })
  })

  it('pastes clipboard TSV at the target top-left and shifts formula references', async () => {
    installClipboard('# einfach-clipboard-origin: B2\n=B2+1\tx')
    const store = createStore()
    const { backend, setCellInputRequests, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [],
      },
    })
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 2, col: 2 },
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.paste'))

    await waitFor(() =>
      expect(setCellInputRequests).toEqual([
        {
          kind: 'set-cell-input',
          sheetId: 'sheet-1',
          row: 2,
          col: 2,
          input: '=C3+1',
        },
        {
          kind: 'set-cell-input',
          sheetId: 'sheet-1',
          row: 2,
          col: 3,
          input: 'x',
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(1))
    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'ready',
      intent: {
        type: 'clipboard.paste',
      },
      target: {
        range: { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 3 },
      },
    })
  })

  it('streams large clipboard paste through backend cell chunks', async () => {
    const rows = ['=B2+1', ...Array.from({ length: 10_000 }, (_value, index) => `row-${index}`)]
    installClipboard(`# einfach-clipboard-origin: B2\n${rows.join('\n')}`)
    const store = createStore()
    const {
      backend,
      importCellsRequests,
      importCellChunksRequests,
      importCellChunkBatches,
      setCellInputRequests,
      readVisibleRequests,
    } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [],
      },
    })
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 2, col: 2 },
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-clipboard.paste'))

    await waitFor(() => expect(importCellChunksRequests).toHaveLength(1))
    expect(importCellsRequests).toEqual([])
    expect(importCellChunksRequests[0]).toMatchObject({
      kind: 'import-cell-chunks',
      sheetId: 'sheet-1',
      range: { rowStart: 2, rowEnd: 10_002, colStart: 2, colEnd: 2 },
    })
    expect('cells' in importCellChunksRequests[0]).toBe(false)
    expect(importCellChunkBatches.length).toBeGreaterThan(1)
    expect(Math.max(...importCellChunkBatches.map((chunk) => chunk.length))).toBeLessThanOrEqual(
      1000,
    )
    expect(importCellChunkBatches.reduce((count, chunk) => count + chunk.length, 0)).toBe(10_001)
    expect(importCellChunkBatches[0][0]).toEqual({
      row: 2,
      col: 2,
      input: '=C3+1',
    })
    expect(importCellChunkBatches.at(-1)?.at(-1)).toEqual({
      row: 10_002,
      col: 2,
      input: 'row-9999',
    })
    expect(setCellInputRequests).toEqual([])
    await waitFor(() => expect(readVisibleRequests).toHaveLength(1))
    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'ready',
      intent: {
        type: 'clipboard.paste',
      },
    })
  })

  it('dismisses menu on outside mousedown', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'row',
        sheetId: 'sheet-1',
        rowIndex: 2,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('spreadsheet-context-menu')).toBeTruthy()

    fireEvent.mouseDown(document.body)

    await waitFor(() => {
      expect(queryByTestId('spreadsheet-context-menu')).toBeNull()
      expect(store.getter(menuStateAtom).status).toBe('closed')
    })
  })

  it('executes row and column structural commands through the backend', async () => {
    const store = createStore()
    const {
      backend,
      insertRowsRequests,
      deleteColumnsRequests,
      readVisibleRequests,
    } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [],
      },
    })
    store.setter(openMenuAtom, {
      surface: 'header',
      target: {
        kind: 'row',
        sheetId: 'sheet-1',
        rowIndex: 2,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-row.insert'))
    await waitFor(() =>
      expect(insertRowsRequests).toEqual([
        {
          kind: 'insert-rows',
          sheetId: 'sheet-1',
          rowIndex: 2,
          count: 1,
        },
      ]),
    )
    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))

    store.setter(openMenuAtom, {
      surface: 'header',
      target: {
        kind: 'column',
        sheetId: 'sheet-1',
        colIndex: 1,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })
    fireEvent.click(getByTestId('context-menu-command-column.delete'))

    await waitFor(() =>
      expect(deleteColumnsRequests).toEqual([
        {
          kind: 'delete-columns',
          sheetId: 'sheet-1',
          colIndex: 1,
          count: 1,
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(2))
  })
})
