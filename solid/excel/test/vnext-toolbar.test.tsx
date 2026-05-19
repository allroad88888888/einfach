/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  MergeRangeRequest,
  SetFormatRangeRequest,
  SpreadsheetBackend,
  UnmergeRangeRequest,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  formatPainterStateAtom,
  historyStackAtom,
  selectCellAtom,
  setWorkspaceActiveSheetAtom,
  startEditingAtom,
  toolbarIntentAtom,
  setSheetProtectionAtom,
  findReplaceOpenAtom,
  printPreviewOpenAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'

afterEach(cleanup)

function createFakeBackend() {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }

  return backend
}

function createRecordingBackend() {
  const setFormatRangeCalls: SetFormatRangeRequest[] = []
  const mergeRangeCalls: MergeRangeRequest[] = []
  const unmergeRangeCalls: UnmergeRangeRequest[] = []
  const readVisibleProjectionCalls: VisibleProjectionRequest[] = []
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      readVisibleProjectionCalls.push(request)
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        window: { ...request.window },
        cells: [
          {
            row: 0,
            col: 0,
            displayValue: 'A1',
            valueKind: 'string',
            format: { bold: true },
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
    async setFormatRange(request) {
      setFormatRangeCalls.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: { ...request.range },
      }
    },
    async mergeRange(request) {
      mergeRangeCalls.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: { ...request.range },
      }
    },
    async unmergeRange(request) {
      unmergeRangeCalls.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 3,
        affectedRange: { ...request.range },
      }
    },
  }

  return { backend, setFormatRangeCalls, mergeRangeCalls, unmergeRangeCalls, readVisibleProjectionCalls }
}

function getButtons(container: HTMLElement) {
  return {
    bold: container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    italic: container.querySelector('[data-testid="toolbar-btn-italic"]') as HTMLButtonElement,
    underline: container.querySelector(
      '[data-testid="toolbar-btn-underline"]',
    ) as HTMLButtonElement,
    fillColor: container.querySelector('[data-testid="toolbar-btn-fill-color"]') as HTMLButtonElement,
    textColor: container.querySelector('[data-testid="toolbar-btn-text-color"]') as HTMLButtonElement,
    numberFormat: container.querySelector(
      '[data-testid="toolbar-btn-number-format"]',
    ) as HTMLButtonElement,
    merge: container.querySelector('[data-testid="toolbar-btn-merge-cells"]') as HTMLButtonElement,
    unmerge: container.querySelector(
      '[data-testid="toolbar-btn-unmerge-cells"]',
    ) as HTMLButtonElement,
    find: container.querySelector('[data-testid="toolbar-btn-find"]') as HTMLButtonElement,
    printPreview: container.querySelector('[data-testid="toolbar-btn-print-preview"]') as HTMLButtonElement,
    painter: container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement,
  }
}

describe('vNext SpreadsheetToolbar', () => {
  it('enables format buttons for selected cell and range', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
    expect(buttons.merge.disabled).toBe(true)
    expect(buttons.unmerge.disabled).toBe(true)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 }, extend: true })

    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
    expect(buttons.merge.disabled).toBe(true)
    expect(buttons.unmerge.disabled).toBe(true)
  })

  it('disables formatting commands while editing is drafting', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=1+1',
      source: 'formula-bar',
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(true)
    expect(buttons.italic.disabled).toBe(true)
    expect(buttons.fillColor.disabled).toBe(true)
    expect(buttons.textColor.disabled).toBe(true)
    expect(buttons.numberFormat.disabled).toBe(true)
    expect(buttons.merge.disabled).toBe(true)
    expect(buttons.unmerge.disabled).toBe(true)
  })

  it('dispatches toolbar.format.command intent when bold is clicked', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement)

    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'sheet-1',
      selectionKind: 'cell',
      command: 'bold',
      value: null,
    })
  })

  it('applies bold through backend setFormatRange and refreshes the visible projection', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls, readVisibleProjectionCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [
          {
            row: 0,
            col: 0,
            displayValue: 'A1',
            valueKind: 'string',
            format: {},
          },
        ],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement)

    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
      expect(readVisibleProjectionCalls).toHaveLength(1)
    })
    expect(setFormatRangeCalls[0]).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    expect(readVisibleProjectionCalls[0]).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      reason: 'toolbar',
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
    })
    expect(store.getter(spreadsheetProjectionSnapshotAtom).result?.cells[0]?.format).toEqual({
      bold: true,
    })
  })

  it('calls backend merge and unmerge ports for the current selection range', async () => {
    const store = createStore()
    const { backend, mergeRangeCalls, unmergeRangeCalls, readVisibleProjectionCalls } =
      createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 1 }, extend: true })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    let buttons = getButtons(container)
    expect(buttons.merge.disabled).toBe(false)
    expect(buttons.unmerge.disabled).toBe(true)

    fireEvent.click(buttons.merge)
    await waitFor(() => {
      expect(mergeRangeCalls).toHaveLength(1)
    })
    expect(mergeRangeCalls[0]).toEqual({
      kind: 'merge-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    await waitFor(() => {
      expect(readVisibleProjectionCalls).toHaveLength(1)
    })

    // The fake backend doesn't mutate the projection. Inject a merge anchor at
    // A1 covering A1:B2 so the unmerge button becomes enabled, then click it.
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 2,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 2,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [
          {
            row: 0,
            col: 0,
            displayValue: '',
            mergedSpan: { rows: 2, cols: 2 },
          },
        ],
      },
      error: undefined,
    })

    buttons = getButtons(container)
    expect(buttons.unmerge.disabled).toBe(false)
    fireEvent.click(buttons.unmerge)
    await waitFor(() => {
      expect(unmergeRangeCalls).toHaveLength(1)
    })
    expect(unmergeRangeCalls[0]).toEqual({
      kind: 'unmerge-range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    expect(readVisibleProjectionCalls).toHaveLength(2)
  })

  it('disables format buttons when active cell is locked in a protected sheet', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(true)
    expect(buttons.italic.disabled).toBe(true)
    expect(buttons.fillColor.disabled).toBe(true)
    expect(buttons.textColor.disabled).toBe(true)
    expect(buttons.numberFormat.disabled).toBe(true)
    expect(buttons.merge.disabled).toBe(true)
    expect(buttons.unmerge.disabled).toBe(true)
  })

  it('Find button opens findReplaceOpenAtom', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceOpenAtom)).toBe(false)

    const buttons = getButtons(container)
    expect(buttons.find).not.toBeNull()
    fireEvent.click(buttons.find)

    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  it('Print preview button toggles printPreviewOpenAtom', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(printPreviewOpenAtom)).toBe(false)

    const buttons = getButtons(container)
    expect(buttons.printPreview).not.toBeNull()
    fireEvent.click(buttons.printPreview)

    expect(store.getter(printPreviewOpenAtom)).toBe(true)

    // re-query button in case Solid replaced the DOM node after re-render
    const buttons2 = getButtons(container)
    fireEvent.click(buttons2.printPreview)
    expect(store.getter(printPreviewOpenAtom)).toBe(false)
  })

  it('toggles bold off when the active cell is already bold', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [
          {
            row: 0,
            col: 0,
            displayValue: 'A1',
            valueKind: 'string',
            format: { bold: true },
          },
        ],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(buttons.bold)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ bold: false })
  })

  it('clicking Italic toggles italic on the active cell and pushes a history entry', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: {} }],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).italic)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ italic: true })
    await waitFor(() => expect(store.getter(historyStackAtom).entries.length).toBe(1))
    expect(store.getter(historyStackAtom).entries[0].kind).toBe('format.set')
  })

  it('clicking Underline toggles underline on the active cell', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: {} }],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.underline).not.toBeNull()
    expect(buttons.underline.disabled).toBe(false)
    fireEvent.click(buttons.underline)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ underline: true })
  })

  it('clicking Merge with a multi-cell selection records a range.merge history entry', async () => {
    const store = createStore()
    const { backend, mergeRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 1 }, extend: true })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).merge)
    await waitFor(() => expect(mergeRangeCalls).toHaveLength(1))
    await waitFor(() => expect(store.getter(historyStackAtom).entries.length).toBe(1))
    expect(store.getter(historyStackAtom).entries[0].kind).toBe('range.merge')
  })

  it('single click on Format Painter arms the painter after the dblclick window', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const { backend } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
        cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: { bold: true } }],
      },
      error: undefined,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    fireEvent.click(getButtons(container).painter)
    jest.advanceTimersByTime(250)
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    jest.useRealTimers()
  })
})
