/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  closeFormatCellsAtom,
  formatCellsEditorAtom,
  openFormatCellsAtom,
} from '@einfach/spreadsheet-ui-core'
import { setLocale } from '../src/i18n'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import {
  SpreadsheetFormatCellsDialog,
  SpreadsheetNumberFormatDialogs,
  openNumberFormatDialogAtom,
} from '../src-vnext/format-cells'

const RAW_I18N_KEY_RE =
  /\b(?:toolbar|numberFormatDropdown|numberFormatDialog|formatCells)\.[A-Za-z0-9_.-]+/

afterEach(() => {
  cleanup()
  setLocale('en')
})

setLocale('en')

const RANGE = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 }

function createFakeBackend() {
  const setFormatRangeRequests: unknown[] = []

  const backend: SpreadsheetBackend = {
    readVisibleProjection: async (req) => ({
      kind: 'visible-window',
      sheetId: req.sheetId,
      requestId: req.requestId,
      window: req.window,
      cells: [],
    }),
    readRangeProjection: async (req) => ({
      kind: 'range',
      sheetId: req.sheetId,
      requestId: req.requestId,
      range: req.range,
      cells: [],
    }),
    setCellInput: async (req) => ({ sheetId: req.sheetId }),
    setFormatRange: jest.fn(async (req) => {
      setFormatRangeRequests.push(req)
      return { sheetId: (req as { sheetId: string }).sheetId }
    }),
  }

  return { backend, setFormatRangeRequests }
}

function expectNoRawI18nKeys(text: string | null | undefined) {
  expect(text ?? '').not.toMatch(RAW_I18N_KEY_RE)
}

describe('SpreadsheetFormatCellsDialog', () => {
  it('does not render when editor is closed', () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('format-cells-dialog')).toBeNull()
  })

  it('renders 5 tabs when the editor opens', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-dialog')).toBeTruthy())
    expect(getByTestId('format-cells-tab-number')).toBeTruthy()
    expect(getByTestId('format-cells-tab-alignment')).toBeTruthy()
    expect(getByTestId('format-cells-tab-font')).toBeTruthy()
    expect(getByTestId('format-cells-tab-border')).toBeTruthy()
    expect(getByTestId('format-cells-tab-fill')).toBeTruthy()
  })

  it('renders English and Chinese dialog chrome without raw i18n keys', async () => {
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale)
      const store = createStore()
      const { backend } = createFakeBackend()

      store.setter(openFormatCellsAtom, {
        sheetId: 'sheet-1',
        range: RANGE,
      })

      const { getByTestId } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetFormatCellsDialog />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => expect(getByTestId('format-cells-dialog')).toBeTruthy())
      const dialog = getByTestId('format-cells-dialog')
      const title = dialog.querySelector('.format-cells-title')
      expect(title?.textContent?.trim()).toBeTruthy()
      expectNoRawI18nKeys(title?.textContent)
      expectNoRawI18nKeys(dialog.textContent)
      cleanup()
    }
  })

  it('opens on the Number tab by default and shows all 12 categories', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-panel-number')).toBeTruthy())
    const categories = [
      'general',
      'number',
      'currency',
      'accounting',
      'date',
      'time',
      'percentage',
      'fraction',
      'scientific',
      'text',
      'special',
      'custom',
    ]
    for (const c of categories) {
      expect(getByTestId(`format-cells-category-${c}`)).toBeTruthy()
    }
  })

  it('clicking a tab updates the active tab and renders its panel', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-tab-alignment')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-tab-alignment'))
    await waitFor(() => expect(queryByTestId('format-cells-panel-alignment')).toBeTruthy())

    fireEvent.click(getByTestId('format-cells-tab-font'))
    await waitFor(() => expect(queryByTestId('format-cells-panel-font')).toBeTruthy())

    fireEvent.click(getByTestId('format-cells-tab-border'))
    await waitFor(() => expect(queryByTestId('format-cells-panel-border')).toBeTruthy())

    fireEvent.click(getByTestId('format-cells-tab-fill'))
    await waitFor(() => expect(queryByTestId('format-cells-panel-fill')).toBeTruthy())
  })

  it('selecting a number category updates the draft', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-category-currency')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-category-currency'))

    await waitFor(() => {
      const state = store.getter(formatCellsEditorAtom)
      if (state.status !== 'open') throw new Error('editor closed unexpectedly')
      expect(state.draft.numberFormat?.kind).toBe('currency')
    })
  })

  it('saves currency number format settings from the Number tab', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-category-currency')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-category-currency'))
    await waitFor(() => expect(getByTestId('format-cells-currency-symbol')).toBeTruthy())
    fireEvent.input(getByTestId('format-cells-currency-symbol'), {
      target: { value: '$' },
    })
    fireEvent.click(getByTestId('format-cells-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'currency', symbol: '$', digits: 2 } },
    })
  })

  it('saves yyyy-MM-dd date format settings from the Number tab', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-category-date')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-category-date'))
    await waitFor(() => expect(getByTestId('format-cells-date-pattern')).toBeTruthy())
    fireEvent.input(getByTestId('format-cells-date-pattern'), {
      target: { value: 'yyyy-MM-dd' },
    })
    fireEvent.click(getByTestId('format-cells-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'date', pattern: 'yyyy-MM-dd' } },
    })
  })

  it('preserves a #,##0.00 custom number format when saved', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { numberFormat: { kind: 'custom', pattern: '#,##0.00' } },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-category-custom')).toBeTruthy())
    expect((getByTestId('format-cells-category-custom') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(getByTestId('format-cells-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'custom', pattern: '#,##0.00' } },
    })
  })

  it('number-format currency dialog saves USD with 2 decimals', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openNumberFormatDialogAtom, {
      kind: 'currency',
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNumberFormatDialogs />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('number-format-dialog')).toBeTruthy())
    expectNoRawI18nKeys(getByTestId('number-format-dialog').textContent)
    fireEvent.click(getByTestId('number-format-dialog-option-usd'))
    fireEvent.input(getByTestId('number-format-dialog-decimals'), {
      target: { value: '2' },
    })
    fireEvent.click(getByTestId('number-format-dialog-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'currency', symbol: '$', digits: 2 } },
    })
  })

  it('number-format date/time dialog saves the ISO date pattern', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openNumberFormatDialogAtom, {
      kind: 'dateTime',
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNumberFormatDialogs />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('number-format-dialog')).toBeTruthy())
    expectNoRawI18nKeys(getByTestId('number-format-dialog').textContent)
    fireEvent.click(getByTestId('number-format-dialog-option-date-iso'))
    fireEvent.click(getByTestId('number-format-dialog-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'date', pattern: 'yyyy-MM-dd' } },
    })
  })

  it('number-format number dialog saves the #,##0.00 pattern', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openNumberFormatDialogAtom, {
      kind: 'number',
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNumberFormatDialogs />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('number-format-dialog')).toBeTruthy())
    expectNoRawI18nKeys(getByTestId('number-format-dialog').textContent)
    fireEvent.click(getByTestId('number-format-dialog-option-thousands-decimal'))
    fireEvent.click(getByTestId('number-format-dialog-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { numberFormat: { kind: 'number', digits: 2, thousands: true } },
    })
  })

  it('editing alignment writes back to the draft', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialTab: 'alignment',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-align-horizontal')).toBeTruthy())
    fireEvent.change(getByTestId('format-cells-align-horizontal'), {
      target: { value: 'center' },
    })

    await waitFor(() => {
      const state = store.getter(formatCellsEditorAtom)
      if (state.status !== 'open') throw new Error('editor closed unexpectedly')
      expect(state.draft.align).toBe('center')
    })
  })

  it('Save dispatches backend.setFormatRange with merged draft and closes the dialog', async () => {
    const store = createStore()
    const { backend, setFormatRangeRequests } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
      initialTab: 'font',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-italic')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-italic'))
    fireEvent.click(getByTestId('format-cells-save'))

    await waitFor(() => expect(setFormatRangeRequests).toHaveLength(1))
    expect(setFormatRangeRequests[0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: RANGE,
      format: { bold: true, italic: true },
    })
    await waitFor(() =>
      expect(store.getter(formatCellsEditorAtom).status).toBe('closed'),
    )
  })

  it('Cancel closes the dialog without calling setFormatRange', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-cancel')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-cancel'))

    await waitFor(() =>
      expect(store.getter(formatCellsEditorAtom).status).toBe('closed'),
    )
    expect(backend.setFormatRange).not.toHaveBeenCalled()
  })

  it('draft persists across tab switches', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    // Edit bold on Font tab.
    await waitFor(() => expect(getByTestId('format-cells-tab-font')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-tab-font'))
    await waitFor(() => expect(getByTestId('format-cells-bold')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-bold'))

    // Switch to Alignment, then back to Font — bold checkbox must still be checked.
    fireEvent.click(getByTestId('format-cells-tab-alignment'))
    await waitFor(() => expect(getByTestId('format-cells-align-horizontal')).toBeTruthy())
    fireEvent.click(getByTestId('format-cells-tab-font'))
    await waitFor(() => {
      const bold = getByTestId('format-cells-bold') as HTMLInputElement
      expect(bold.checked).toBe(true)
    })
  })

  it('unsupported number categories show a "coming soon" hint', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('format-cells-category-special-coming-soon')).toBeTruthy(),
    )
  })

  it('closing via the atom hides the dialog', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatCellsDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('format-cells-dialog')).toBeTruthy())
    store.setter(closeFormatCellsAtom)
    await waitFor(() => expect(queryByTestId('format-cells-dialog')).toBeNull())
  })
})
