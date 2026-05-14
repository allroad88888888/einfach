/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  SetFormatRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  selectCellAtom,
  setWorkspaceActiveSheetAtom,
  startEditingAtom,
  toolbarIntentAtom,
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
  }

  return { backend, setFormatRangeCalls, readVisibleProjectionCalls }
}

function getButtons(container: HTMLElement) {
  return {
    bold: container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    italic: container.querySelector('[data-testid="toolbar-btn-italic"]') as HTMLButtonElement,
    fillColor: container.querySelector('[data-testid="toolbar-btn-fill-color"]') as HTMLButtonElement,
    textColor: container.querySelector('[data-testid="toolbar-btn-text-color"]') as HTMLButtonElement,
    numberFormat: container.querySelector(
      '[data-testid="toolbar-btn-number-format"]',
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

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 }, extend: true })

    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
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
})
