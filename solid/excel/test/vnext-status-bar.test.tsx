/** @jsxImportSource solid-js */

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  dispatchToolbarFormatCommandAtom,
  keyboardModeAtom,
  selectCellAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
  statusBarAggregateConfigAtom,
  viewModeAtom,
  zoomLevelAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetStatusBar } from '../src-vnext/status-bar'
import { setLocale } from '../src/i18n'

// Status bar tests assert on English labels; pin the locale so the default
// (currently 'zh') doesn't break textContent comparisons.
beforeAll(() => {
  setLocale('en')
})
afterAll(() => {
  setLocale('en')
})

afterEach(cleanup)

function createFakeBackend(): SpreadsheetBackend {
  return {
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
}

describe('vNext SpreadsheetStatusBar', () => {
  it('shows active address, selection, projection status, and visible metrics', () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 4 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 1, col: 2 },
    })
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
          { row: 1, col: 2, displayValue: 'C2' },
          { row: 5, col: 4, displayValue: 'E6' },
        ],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('status-active-cell').textContent).toBe('C2')
    expect(getByTestId('status-selection').textContent).toBe('C2')
    expect(getByTestId('status-projection').textContent).toBe('Ready')
    expect(getByTestId('status-visible-cells').textContent).toBe('30 cells')
    expect(getByTestId('status-loaded-values').textContent).toBe('2 loaded')
    expect(getByTestId('status-last-command').textContent).toBe('Ready')
  })

  it('updates from core selection and toolbar atoms', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 2, col: 2 },
      extend: true,
    })
    store.setter(dispatchToolbarFormatCommandAtom, { command: 'bold' })

    await waitFor(() => expect(getByTestId('status-active-cell').textContent).toBe('C3'))
    expect(getByTestId('status-selection').textContent).toBe('A1:C3')
    expect(getByTestId('status-last-command').textContent).toBe('Toolbar bold')
  })

  it('renders selection aggregates and supports click-to-toggle config', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(setSelectionBoundsAtom, { rowCount: 100, colCount: 100 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 4 },
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          { row: 0, col: 0, displayValue: '1', valueKind: 'number' },
          { row: 0, col: 1, displayValue: '2', valueKind: 'number' },
          { row: 0, col: 2, displayValue: '3', valueKind: 'number' },
          { row: 0, col: 3, displayValue: '4', valueKind: 'number' },
          { row: 0, col: 4, displayValue: '5', valueKind: 'number' },
        ],
      },
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregate-sum-value').textContent).toBe('15'),
    )
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('3')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('5')
    // Default-off aggregates are present as buttons but values hidden.
    expect(queryByTestId('status-aggregate-min-value')).toBeNull()

    fireEvent.click(getByTestId('status-aggregate-sum'))
    await waitFor(() => expect(store.getter(statusBarAggregateConfigAtom).sum).toBe(false))
    expect(queryByTestId('status-aggregate-sum-value')).toBeNull()
    expect(store.getter(statusBarAggregateConfigAtom).average).toBe(true)
    expect(store.getter(statusBarAggregateConfigAtom).count).toBe(true)
  })

  it('aggregates mixed numeric and string cells correctly', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 3 },
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          { row: 0, col: 0, displayValue: '1', valueKind: 'number' },
          { row: 0, col: 1, displayValue: 'a', valueKind: 'string' },
          { row: 0, col: 2, displayValue: '2', valueKind: 'number' },
          { row: 0, col: 3, displayValue: 'b', valueKind: 'string' },
        ],
      },
    })
    // Enable numericCount badge for this assertion.
    store.setter(statusBarAggregateConfigAtom, {
      sum: true,
      average: true,
      count: true,
      numericCount: true,
      min: false,
      max: false,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregate-sum-value').textContent).toBe('3'),
    )
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('1.5')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('4')
    expect(getByTestId('status-aggregate-numericCount-value').textContent).toBe('2')
  })

  it('zoom preset and slider update zoomLevelAtom; % display resets', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('status-zoom-value').textContent).toBe('100%')
    expect(store.getter(zoomLevelAtom)).toBe(1)

    fireEvent.click(getByTestId('status-zoom-preset-150'))
    await waitFor(() => expect(store.getter(zoomLevelAtom)).toBe(1.5))
    expect(getByTestId('status-zoom-value').textContent).toBe('150%')

    const slider = getByTestId('status-zoom-slider') as HTMLInputElement
    slider.value = '125'
    fireEvent.input(slider)
    await waitFor(() => expect(store.getter(zoomLevelAtom)).toBe(1.25))

    fireEvent.click(getByTestId('status-zoom-value'))
    await waitFor(() => expect(store.getter(zoomLevelAtom)).toBe(1))
    expect(getByTestId('status-zoom-value').textContent).toBe('100%')
  })

  it('view-mode buttons toggle the atom', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(viewModeAtom)).toBe('normal')
    expect(getByTestId('status-view-mode-normal').getAttribute('data-active')).toBe('true')

    fireEvent.click(getByTestId('status-view-mode-page-break-preview'))
    await waitFor(() => expect(store.getter(viewModeAtom)).toBe('page-break-preview'))
    expect(getByTestId('status-view-mode-page-break-preview').getAttribute('data-active')).toBe(
      'true',
    )

    fireEvent.click(getByTestId('status-view-mode-page-layout'))
    await waitFor(() => expect(store.getter(viewModeAtom)).toBe('page-layout'))

    fireEvent.click(getByTestId('status-view-mode-normal'))
    await waitFor(() => expect(store.getter(viewModeAtom)).toBe('normal'))
  })

  it('mode badge mirrors keyboardModeAtom', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('status-mode-badge').textContent).toBe('Ready')

    store.setter(keyboardModeAtom, 'editing')
    await waitFor(() => expect(getByTestId('status-mode-badge').textContent).toBe('Edit'))
    expect(getByTestId('status-mode-badge').getAttribute('data-mode')).toBe('edit')

    store.setter(keyboardModeAtom, 'formula-reference')
    await waitFor(() => expect(getByTestId('status-mode-badge').textContent).toBe('Point'))

    store.setter(keyboardModeAtom, 'navigation')
    await waitFor(() => expect(getByTestId('status-mode-badge').textContent).toBe('Ready'))
  })

  it('aggregates respond to selection changes', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          { row: 0, col: 0, displayValue: '10', valueKind: 'number' },
          { row: 1, col: 0, displayValue: '20', valueKind: 'number' },
          { row: 2, col: 0, displayValue: '30', valueKind: 'number' },
        ],
      },
    })

    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10'),
    )

    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 0 },
    })

    await waitFor(() =>
      expect(getByTestId('status-aggregate-sum-value').textContent).toBe('60'),
    )
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('20')
  })
})
