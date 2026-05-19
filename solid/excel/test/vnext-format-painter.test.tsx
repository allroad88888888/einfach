/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  SetFormatRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  applyFormatPainterAtom,
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  exitFormatPainterAtom,
  formatPainterClipboardAtom,
  formatPainterStateAtom,
  selectCellAtom,
  setSelectionAtom,
  setWorkspaceActiveSheetAtom,
  type CapturedFormat,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'
import { SpreadsheetFormatPainter } from '../src-vnext/format-painter'

afterEach(cleanup)

function richFormat(): CapturedFormat['format'] {
  return {
    bold: true,
    italic: true,
    underline: true,
    align: 'center',
    fontSize: 16,
    fgColor: '#112233',
    bgColor: '#ffeecc',
    wrap: true,
    numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
    borders: {
      top: { style: 'thin', color: '#000000' },
      bottom: { style: 'medium' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    },
  }
}

function makeProjectionResult(sheetId: string): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId,
    requestId: 1,
    window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
    cells: [
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: richFormat() },
      { row: 1, col: 0, displayValue: 'A2', valueKind: 'string', format: {} },
      { row: 2, col: 2, displayValue: 'C3', valueKind: 'string', format: {} },
    ],
  }
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
          { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: richFormat() },
          { row: 1, col: 0, displayValue: 'A2', valueKind: 'string', format: richFormat() },
          { row: 2, col: 2, displayValue: 'C3', valueKind: 'string', format: richFormat() },
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

function primeStoreWithProjection(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
  store.setter(spreadsheetProjectionSnapshotAtom, {
    status: 'ready',
    request: {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      reason: 'test',
      window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
    },
    result: makeProjectionResult('sheet-1'),
    error: undefined,
  })
}

describe('SpreadsheetFormatPainter atoms (integration)', () => {
  it('applyFormatPainterAtom on a range applies to the full target range, not just first cell', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })

    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 4, col: 3 },
    })

    await waitFor(() => {
      expect(setFormatRangeCalls.length).toBeGreaterThanOrEqual(1)
    })
    const call = setFormatRangeCalls[setFormatRangeCalls.length - 1]!
    expect(call.kind).toBe('set-format-range')
    expect(call.sheetId).toBe('sheet-1')
    expect(call.range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    expect(call.format).toEqual(richFormat())
  })
})

describe('SpreadsheetToolbar format painter button', () => {
  it('renders a format-painter button with aria-pressed reflecting state', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    store.setter(armFormatPainterAtom, { format: richFormat() })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.dataset.formatPainterState).toBe('armed')
  })

  it('single click arms the painter with the active cell format after the dblclick window', () => {
    jest.useFakeTimers()
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement

    fireEvent.click(btn)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')

    jest.advanceTimersByTime(250)

    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    const clip = store.getter(formatPainterClipboardAtom)
    expect(clip).not.toBeNull()
    expect(clip!.format.bold).toBe(true)
    expect(clip!.format.numberFormat).toEqual({ kind: 'currency', symbol: '$', digits: 2 })
    expect(clip!.format.borders?.top?.style).toBe('thin')
    expect(clip!.format.bgColor).toBe('#ffeecc')

    jest.useRealTimers()
  })

  it('double click puts the painter in sticky mode', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    fireEvent.dblClick(btn)

    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
  })

  it('clicking the button while sticky toggles painter off to idle', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)
    store.setter(armFormatPainterStickyAtom, { format: richFormat() })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    fireEvent.click(btn)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
  })

  it('selecting a different cell while armed applies the format and returns to idle', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })
    expect(store.getter(formatPainterStateAtom)).toBe('armed')

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 } })

    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
    })
    expect(setFormatRangeCalls[0]!.range).toEqual({
      rowStart: 2,
      rowEnd: 2,
      colStart: 2,
      colEnd: 2,
    })
    expect(setFormatRangeCalls[0]!.format).toEqual(richFormat())
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
  })

  it('in sticky mode, two consecutive cell selections both apply and state stays sticky', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterStickyAtom, { format: richFormat() })

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })
    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
    })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 } })
    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(2)
    })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(setFormatRangeCalls[1]!.range).toEqual({
      rowStart: 2,
      rowEnd: 2,
      colStart: 2,
      colEnd: 2,
    })
  })

  it('pressing Escape exits the painter to idle', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)
    store.setter(armFormatPainterAtom, { format: richFormat() })

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  it('applyFormatPainterAtom returns false when the painter is idle', () => {
    const store = createStore()
    const applied = store.setter(applyFormatPainterAtom)
    expect(applied).toBe(false)
  })

  it('exitFormatPainterAtom while sticky also clears clipboard', () => {
    const store = createStore()
    store.setter(armFormatPainterStickyAtom, { format: richFormat() })
    store.setter(exitFormatPainterAtom)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })
})
