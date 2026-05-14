/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import { menuCommandIntentAtom, menuStateAtom, openMenuAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { spreadsheetProjectionSnapshotAtom, SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function createFakeBackend() {
  const setCellInputRequests: SetCellInputRequest[] = []
  const clearRangeRequests: ClearRangeRequest[] = []
  const insertRowsRequests: InsertRowsRequest[] = []
  const deleteRowsRequests: DeleteRowsRequest[] = []
  const insertColumnsRequests: InsertColumnsRequest[] = []
  const deleteColumnsRequests: DeleteColumnsRequest[] = []
  const readVisibleRequests: VisibleProjectionRequest[] = []
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
    async readRangeProjection() {
      throw new Error('not used')
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
    readVisibleRequests,
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
