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
  historyStackAtom,
  hydrateViewportFreezeAtom,
  menuCommandIntentAtom,
  menuStateAtom,
  openMenuAtom,
  structureOperationLifecycleAtom,
  viewportFreezeAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { spreadsheetProjectionSnapshotAtom, SpreadsheetUiProvider } from '../src-vnext/provider'
import { seedReadyVisibleProjection } from './projection-test-fixture'

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
  const setFreezeConfigRequests: Parameters<
    NonNullable<SpreadsheetBackend['setFreezeConfig']>
  >[0][] = []
  let structuralRevision = 0
  let freezeRevision = 0
  let freeze = { rows: 0, cols: 0 }
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
        revision: ++structuralRevision,
      }
    },
    async deleteRows(request) {
      deleteRowsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: ++structuralRevision,
      }
    },
    async insertColumns(request) {
      insertColumnsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: ++structuralRevision,
      }
    },
    async deleteColumns(request) {
      deleteColumnsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: ++structuralRevision,
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
      setFreezeConfigRequests.push(request)
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
    setFreezeConfigRequests,
    seedFreeze(next: { rows: number; cols: number }) {
      freeze = { ...next }
      freezeRevision += 1
    },
  }
}

async function hydrateFreeze(
  store: ReturnType<typeof createStore>,
  backend: SpreadsheetBackend,
) {
  await store.setter(hydrateViewportFreezeAtom, {
    source: backend,
    sheetId: 'sheet-1',
  })
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
    // Default locale is `zh`; English variants are 'Copy' and 'Delete'.
    expect(getByTestId('context-menu-command-clipboard.copy').textContent).toBe('复制')
    expect(getByTestId('context-menu-command-cell.clear').textContent).toBe('删除')
    expect(queryByTestId('context-menu-command-row.insert')).toBeNull()
    expect(queryByTestId('context-menu-command-column.delete')).toBeNull()
  })

  it('focuses the first keyboard-opened item and restores the opener on Escape', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { getByTestId, queryByTestId } = render(() => (
      <>
        <button type="button" data-testid="menu-opener">
          Open menu
        </button>
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetContextMenu />
        </SpreadsheetUiProvider>
      </>
    ))

    const opener = getByTestId('menu-opener') as HTMLButtonElement
    opener.focus()
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 1, col: 2 },
      },
      position: { x: 14, y: 8 },
      source: 'keyboard',
    })

    const firstMenuItem = await waitFor(() => getByTestId('context-menu-command-clipboard.copy'))
    await waitFor(() => expect(document.activeElement).toBe(firstMenuItem))

    fireEvent.keyDown(firstMenuItem, { key: 'Escape' })

    await waitFor(() => {
      expect(queryByTestId('spreadsheet-context-menu')).toBeNull()
      expect(store.getter(menuStateAtom).status).toBe('closed')
      expect(document.activeElement).toBe(opener)
    })
  })

  it('does not steal focus when the menu is opened from a pointer', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { getByTestId } = render(() => (
      <>
        <button type="button" data-testid="menu-opener">
          Open menu
        </button>
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetContextMenu />
        </SpreadsheetUiProvider>
      </>
    ))

    const opener = getByTestId('menu-opener') as HTMLButtonElement
    opener.focus()
    store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 1, col: 2 },
      },
      position: { x: 14, y: 8 },
      source: 'pointer',
    })

    await waitFor(() => expect(getByTestId('spreadsheet-context-menu')).toBeTruthy())
    await Promise.resolve()
    expect(document.activeElement).toBe(opener)
  })

  it('dispatches a menu.command intent when Delete is clicked', async () => {
    const store = createStore()
    const { backend, setCellInputRequests, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    seedReadyVisibleProjection(store, {
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

    seedReadyVisibleProjection(store, {
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

  it('reports a rejected non-structural clear through the existing projection error channel', async () => {
    const store = createStore()
    const { backend, readVisibleRequests } = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 }
    backend.clearRange = async () => {
      throw new Error('clear failed')
    }

    seedReadyVisibleProjection(store, {
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

    fireEvent.click(getByTestId('context-menu-command-cell.clear'))

    await waitFor(() =>
      expect(store.getter(spreadsheetProjectionSnapshotAtom)).toMatchObject({
        status: 'error',
        error: {
          code: 'BACKEND_ERROR',
          message: 'clear failed',
        },
      }),
    )
    expect(readVisibleRequests).toEqual([])
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

    seedReadyVisibleProjection(store, {
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

    seedReadyVisibleProjection(store, {
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

    seedReadyVisibleProjection(store, {
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

  it('dispatches row and column structural intents through the Core lifecycle', async () => {
    const store = createStore()
    const { backend, insertRowsRequests, deleteColumnsRequests, readVisibleRequests } =
      createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    seedReadyVisibleProjection(store, {
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
          requestId: 1,
          revision: undefined,
        },
      ]),
    )
    await waitFor(() =>
      expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
        status: 'completed',
        operation: 'row.insert',
        requestId: 1,
        acknowledgedRevision: 1,
      }),
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
          requestId: 2,
          revision: undefined,
        },
      ]),
    )
    await waitFor(() => expect(readVisibleRequests).toHaveLength(2))
    expect(store.getter(historyStackAtom).entries).toHaveLength(2)
    expect(store.getter(historyStackAtom).entries.map((entry) => entry.kind)).toEqual([
      'row.insert',
      'column.delete',
    ])
    expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
      status: 'completed',
      operation: 'column.delete',
      requestId: 2,
      acknowledgedRevision: 2,
    })
  })

  it('reports missing structural capability in Core without rewriting projection state', async () => {
    const store = createStore()
    const { backend, insertRowsRequests, readVisibleRequests } = createFakeBackend()
    backend.insertRows = undefined
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }
    seedReadyVisibleProjection(store, {
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
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 2 },
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
      expect(store.getter(structureOperationLifecycleAtom).status).toBe('unsupported'),
    )
    expect(insertRowsRequests).toEqual([])
    expect(readVisibleRequests).toEqual([])
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(store.getter(spreadsheetProjectionSnapshotAtom).status).toBe('ready')
  })

  it('keeps a mismatched structural acknowledgement outcome-unknown and does not refresh', async () => {
    const store = createStore()
    const { backend, insertRowsRequests, readVisibleRequests } = createFakeBackend()
    backend.insertRows = async (request) => {
      insertRowsRequests.push(request)
      return {
        sheetId: request.sheetId,
        requestId: (request.requestId ?? 0) + 1,
        revision: 1,
      }
    }
    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 2 },
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
      expect(store.getter(structureOperationLifecycleAtom).status).toBe('outcome-unknown'),
    )
    expect(insertRowsRequests).toHaveLength(1)
    expect(readVisibleRequests).toEqual([])
    expect(store.getter(historyStackAtom).entries).toEqual([])
  })

  it('freezes rows above the clicked row from the row header context menu', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 3 },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-view.freezeRowsHere'))

    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1']).toBe(3)
      expect(freeze.colsBySheet['sheet-1'] ?? 0).toBe(0)
    })
  })

  it('freezes columns to the left of the clicked column from the col header context menu', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'column', sheetId: 'sheet-1', colIndex: 2 },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-view.freezeColsHere'))

    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.colsBySheet['sheet-1']).toBe(2)
      expect(freeze.rowsBySheet['sheet-1'] ?? 0).toBe(0)
    })
  })

  it('freezes panes at the active cell from a cell context menu', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 2, col: 1 } },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-view.freezePanes'))

    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1']).toBe(2)
      expect(freeze.colsBySheet['sheet-1']).toBe(1)
    })
  })

  it('shows all four freeze actions on a cell right-click and labels them short-form', async () => {
    const store = createStore()
    const { backend, seedFreeze } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 3, col: 2 } },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })
    // Pre-activate canonical freeze so Unfreeze is also visible.
    seedFreeze({ rows: 1, cols: 0 })
    await hydrateFreeze(store, backend)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    // Default locale is zh; short labels match the screenshot.
    expect(getByTestId('context-menu-command-view.freezePanes').textContent).toBe('冻结')
    expect(getByTestId('context-menu-command-view.freezeRowsHere').textContent).toBe('冻结行')
    expect(getByTestId('context-menu-command-view.freezeColsHere').textContent).toBe('冻结列')
    expect(getByTestId('context-menu-command-view.unfreeze').textContent).toBe('取消冻结')
    // Count goes into the tooltip, not the visible label.
    expect(getByTestId('context-menu-command-view.freezeRowsHere').getAttribute('title')).toBe(
      '冻结上方 3 行',
    )
    expect(getByTestId('context-menu-command-view.freezeColsHere').getAttribute('title')).toBe(
      '冻结左侧 2 列',
    )
  })

  it('freezes rows only via cell-target Freeze row — preserves col freeze', async () => {
    const store = createStore()
    const { backend, seedFreeze } = createFakeBackend()

    // Start with cols already frozen; "Freeze row" must not clear that axis.
    seedFreeze({ rows: 0, cols: 2 })
    await hydrateFreeze(store, backend)
    store.setter(openMenuAtom, {
      surface: 'context',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 3, col: 1 } },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-view.freezeRowsHere'))
    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1']).toBe(3)
      expect(freeze.colsBySheet['sheet-1']).toBe(2)
    })
  })

  it('freezes cols only via cell-target Freeze column — preserves row freeze', async () => {
    const store = createStore()
    const { backend, seedFreeze } = createFakeBackend()

    seedFreeze({ rows: 2, cols: 0 })
    await hydrateFreeze(store, backend)
    store.setter(openMenuAtom, {
      surface: 'context',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 1, col: 4 } },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('context-menu-command-view.freezeColsHere'))
    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1']).toBe(2)
      expect(freeze.colsBySheet['sheet-1']).toBe(4)
    })
  })

  it('shows Unfreeze only when freeze is active on the target sheet', async () => {
    const store = createStore()
    const { backend, seedFreeze } = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 4 },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    // No freeze yet — Unfreeze is hidden.
    expect(queryByTestId('context-menu-command-view.unfreeze')).toBeNull()

    // Activate canonical freeze on this sheet, re-open the menu, and the item appears.
    seedFreeze({ rows: 2, cols: 0 })
    await hydrateFreeze(store, backend)
    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 4 },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    await waitFor(() => expect(queryByTestId('context-menu-command-view.unfreeze')).not.toBeNull())

    fireEvent.click(queryByTestId('context-menu-command-view.unfreeze')!)
    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1'] ?? 0).toBe(0)
      expect(freeze.colsBySheet['sheet-1'] ?? 0).toBe(0)
    })
  })

  it('keeps locally seeded freeze when a later backend hydration resolves', async () => {
    // One-shot seed semantics: the first hydration (or any local command)
    // owns the sheet — a second backend's late hydration result must not
    // clobber the local canonical state.
    const store = createStore()
    const first = createFakeBackend()
    first.seedFreeze({ rows: 2, cols: 1 })
    await hydrateFreeze(store, first.backend)

    const second = createFakeBackend()
    const hydration = store.setter(hydrateViewportFreezeAtom, {
      source: second.backend,
      sheetId: 'sheet-1',
    })

    store.setter(openMenuAtom, {
      surface: 'header',
      target: { kind: 'row', sheetId: 'sheet-1', rowIndex: 4 },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={second.backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    // The locally owned freeze stays visible: Unfreeze is offered.
    expect(queryByTestId('context-menu-command-view.unfreeze')).not.toBeNull()
    await expect(hydration).resolves.toBe('skipped')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2 },
      colsBySheet: { 'sheet-1': 1 },
    })
  })

  it('offers freeze commands and commits locally without backend freeze ports', async () => {
    const store = createStore()
    const fake = createFakeBackend()
    const portlessBackend: SpreadsheetBackend = {
      ...fake.backend,
      readFreezeConfig: undefined,
      setFreezeConfig: undefined,
    }
    store.setter(openMenuAtom, {
      surface: 'context',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 2, col: 2 } },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={portlessBackend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('context-menu-command-view.freezePanes')).not.toBeNull()
    expect(getByTestId('context-menu-command-view.freezeRowsHere')).not.toBeNull()
    expect(getByTestId('context-menu-command-view.freezeColsHere')).not.toBeNull()

    fireEvent.click(getByTestId('context-menu-command-view.freezePanes'))
    await waitFor(() => {
      const freeze = store.getter(viewportFreezeAtom)
      expect(freeze.rowsBySheet['sheet-1']).toBe(2)
      expect(freeze.colsBySheet['sheet-1']).toBe(2)
    })
    // Portless backend: nothing was mirrored, nothing failed.
    expect(fake.setFreezeConfigRequests).toEqual([])
  })
})
