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
} from '@einfach/spreadsheet-ui-core'
import { setLocale } from '../src/i18n'
import { numberFormatDialogAtom } from '../src-vnext/format-cells'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'

const RAW_I18N_KEY_RE =
  /\b(?:toolbar|numberFormatDropdown|numberFormatDialog|formatCells)\.[A-Za-z0-9_.-]+/

const MORE_FORMAT_LABELS = {
  en: {
    currency: /More currency formats(?:\.\.\.|…)?/,
    'date-time': /More date (?:&|and) time formats(?:\.\.\.|…)?/,
    number: /More number formats(?:\.\.\.|…)?/,
  },
  zh: {
    currency: /更多货币格式(?:\.\.\.|…)?/,
    'date-time': /更多日期(?:与|和)时间格式(?:\.\.\.|…)?/,
    number: /更多数字格式(?:\.\.\.|…)?/,
  },
} as const

const MORE_FORMAT_TEST_IDS = {
  currency: 'number-format-custom-currency',
  'date-time': 'number-format-custom-dateTime',
  number: 'number-format-custom-number',
} as const

afterEach(() => {
  cleanup()
  setLocale('en')
})

setLocale('en')

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
    percent: container.querySelector(
      '[data-testid="toolbar-btn-percent-format"]',
    ) as HTMLButtonElement,
    // Wave 5 merge surface is a single dropdown — the top-level button always
    // opens the menu; the dropdown's four items (merge-center, across-rows,
    // across-cols, unmerge) carry the per-preset disabled state.
    merge: container.querySelector('[data-testid="toolbar-btn-merge"]') as HTMLButtonElement,
    mergeCenterItem: () =>
      container.querySelector('[data-testid="toolbar-merge-center"]') as HTMLButtonElement | null,
    unmergeItem: () =>
      container.querySelector('[data-testid="toolbar-merge-unmerge"]') as HTMLButtonElement | null,
    painter: container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement,
  }
}

function getMoreFormatButton(
  kind: 'currency' | 'date-time' | 'number',
  locale: 'en' | 'zh',
): HTMLButtonElement | null {
  const customTestId = MORE_FORMAT_TEST_IDS[kind]
  const byCustomTestId = document.body.querySelector(
    `[data-testid="${customTestId}"]`,
  ) as HTMLButtonElement | null
  if (byCustomTestId) return byCustomTestId

  const byTestId = document.body.querySelector(
    `[data-testid="number-format-more-${kind}"]`,
  ) as HTMLButtonElement | null
  if (byTestId) return byTestId

  const label = MORE_FORMAT_LABELS[locale][kind]
  const match = Array.from(document.body.querySelectorAll('button,[role="menuitem"]')).find((el) =>
    label.test(el.textContent ?? ''),
  )
  return (match as HTMLButtonElement | undefined) ?? null
}

async function openCustomFormatSubmenu(container: HTMLElement) {
  fireEvent.click(getButtons(container).numberFormat)
  const dropdown = document.body.querySelector('[data-testid="number-format-dropdown"]')
  expect(dropdown).not.toBeNull()
  expect(dropdown?.textContent ?? '').not.toMatch(RAW_I18N_KEY_RE)

  const custom = document.body.querySelector(
    '[data-testid="number-format-item-Custom"]',
  ) as HTMLButtonElement | null
  expect(custom).not.toBeNull()
  fireEvent.pointerEnter(custom!)
  fireEvent.mouseEnter(custom!)
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
    // createFakeBackend omits mergeRange so the dropdown anchor button is
    // disabled — there is no merge surface to expose.
    expect(buttons.merge.disabled).toBe(true)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 }, extend: true })

    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
    // Still no mergeRange port on the fake backend.
    expect(buttons.merge.disabled).toBe(true)
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
    // Drafting also gates the merge dropdown's anchor button.
    expect(buttons.merge.disabled).toBe(true)
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

  it('maps toolbar number formats from sorted visible rows to source rows', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 5, col: 4 } })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'test',
        window: { rowStart: 0, rowEnd: 8, colStart: 0, colEnd: 5 },
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        window: { rowStart: 0, rowEnd: 8, colStart: 0, colEnd: 5 },
        cells: [
          {
            row: 5,
            col: 4,
            originalRow: 1,
            displayValue: '300',
            valueKind: 'number',
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

    fireEvent.click(getButtons(container).percent)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0]).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 1, colStart: 4, colEnd: 4 },
      format: { numberFormat: { kind: 'percent', digits: 0 } },
    })
  })

  it('renders localized custom-format submenu entries without raw i18n keys', async () => {
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale)
      const store = createStore()
      const backend = createFakeBackend()

      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
      store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetToolbar />
        </SpreadsheetUiProvider>
      ))

      await openCustomFormatSubmenu(container)

      await waitFor(() => {
        expect(getMoreFormatButton('currency', locale)).not.toBeNull()
        expect(getMoreFormatButton('date-time', locale)).not.toBeNull()
        expect(getMoreFormatButton('number', locale)).not.toBeNull()
      })
      const text = [
        getMoreFormatButton('currency', locale)?.textContent,
        getMoreFormatButton('date-time', locale)?.textContent,
        getMoreFormatButton('number', locale)?.textContent,
      ].join(' ')
      expect(text).toMatch(MORE_FORMAT_LABELS[locale].currency)
      expect(text).toMatch(MORE_FORMAT_LABELS[locale]['date-time'])
      expect(text).toMatch(MORE_FORMAT_LABELS[locale].number)
      expect(text).not.toMatch(RAW_I18N_KEY_RE)
      cleanup()
    }
  })

  it('opens the currency number-format dialog from the custom-format submenu', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    await openCustomFormatSubmenu(container)
    await waitFor(() => expect(getMoreFormatButton('currency', 'en')).not.toBeNull())
    fireEvent.click(getMoreFormatButton('currency', 'en')!)

    await waitFor(() => {
      const state = store.getter(numberFormatDialogAtom)
      if (state.status !== 'open') throw new Error('number-format dialog did not open')
      expect(state.kind).toBe('currency')
      expect(state.range).toEqual({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })
      expect(state.digits).toBe(2)
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

    // Open the dropdown and click 合并居中. The dropdown body lives inside the
    // same toolbar root, so a single fireEvent click on the anchor toggles it
    // open, then the menu item triggers the merge.
    fireEvent.click(buttons.merge)
    const mergeCenterItem = buttons.mergeCenterItem()
    expect(mergeCenterItem).not.toBeNull()
    expect(mergeCenterItem!.disabled).toBe(false)
    expect(buttons.unmergeItem()?.disabled).toBe(true)
    fireEvent.click(mergeCenterItem!)
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
    fireEvent.click(buttons.merge)
    const unmergeItem = buttons.unmergeItem()
    expect(unmergeItem).not.toBeNull()
    expect(unmergeItem!.disabled).toBe(false)
    fireEvent.click(unmergeItem!)
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
    // Protected sheet → the merge dropdown anchor button is disabled.
    expect(buttons.merge.disabled).toBe(true)
  })

  it('renders Print Preview, Comment, and Decimal-adjust toolbar buttons', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    // The toolbar surfaces Print Preview + Comment alongside the existing
    // history group, and a pair of Increase / Decrease Decimal buttons at
    // the end of the number-format group.
    expect(container.querySelector('[data-testid="toolbar-btn-print-preview"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-comment"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-inc-decimal"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-dec-decimal"]')).not.toBeNull()
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

    const buttons = getButtons(container)
    fireEvent.click(buttons.merge)
    const mergeCenterItem = buttons.mergeCenterItem()
    expect(mergeCenterItem).not.toBeNull()
    fireEvent.click(mergeCenterItem!)
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
