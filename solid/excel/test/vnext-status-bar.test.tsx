/** @jsxImportSource solid-js */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  CellRange,
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  beginProjectionAtom,
  dispatchToolbarFormatCommandAtom,
  keyboardModeAtom,
  rejectProjectionAtom,
  resolveProjectionAtom,
  selectCellAtom,
  selectionAggregatesAtom,
  setStatusBarAggregateConfigAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
  statusBarAggregateConfigAtom,
  statusBarProjectionCellsAtom,
  viewModeAtom,
  zoomLevelAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetStatusBar } from '../src-vnext/status-bar'
import { setLocale } from '../src/i18n'
import { seedReadyVisibleProjection } from './projection-test-fixture'

// Status bar tests assert on English labels; pin the locale so the default
// (currently 'zh') doesn't break textContent comparisons.
beforeAll(() => {
  setLocale('en')
})
afterAll(() => {
  setLocale('en')
})

afterEach(() => {
  cleanup()
  setLocale('en')
})

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

function numericCell(row: number, col: number, value: number): DisplayCell {
  return {
    row,
    col,
    displayValue: String(value),
    valueKind: 'number',
    numericValue: value,
  }
}

function beginVisibleRefresh(
  store: ReturnType<typeof createStore>,
  window: CellRange,
): VisibleProjectionRequest {
  const outcome = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: 'sheet-1',
    reason: 'test',
    window,
    retainResult: true,
  })
  if (outcome.status !== 'started' || outcome.request.kind !== 'visible-window') {
    throw new Error(`projection refresh failed to start: ${outcome.status}`)
  }
  return outcome.request
}

function resolveVisibleRefresh(
  store: ReturnType<typeof createStore>,
  request: VisibleProjectionRequest,
  cells: readonly DisplayCell[],
): void {
  const outcome = store.setter(resolveProjectionAtom, {
    request,
    result: {
      kind: 'visible-window',
      sheetId: request.sheetId,
      window: request.window,
      requestId: request.requestId,
      cells: [...cells],
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    },
  })
  if (outcome.status !== 'accepted') {
    throw new Error(`projection refresh failed to resolve: ${outcome.reason}`)
  }
}

describe('vNext SpreadsheetStatusBar', () => {
  it('keeps the status bar a pure consumer of the Provider-owned projection bridge', () => {
    const statusBarSource = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/status-bar/SpreadsheetStatusBar.tsx'),
      'utf8',
    )
    const bridgeSource = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/provider/status-bar-projection-bridge.ts'),
      'utf8',
    )
    const componentSource = statusBarSource.slice(
      statusBarSource.indexOf('export function SpreadsheetStatusBar'),
    )

    expect(statusBarSource).not.toContain('syncStatusBarProjectionAtom')
    expect(componentSource).not.toContain('createEffect(')
    expect(componentSource).not.toContain('onCleanup(')
    expect(componentSource).not.toContain('useStore(')
    expect(componentSource).not.toContain('store.setter(')
    expect(componentSource).not.toContain('rangesIntersect(')
    expect(componentSource).not.toContain('rangeContains(')
    expect(statusBarSource).not.toContain('statusBarProjectionCellsAtom')
    expect(statusBarSource).not.toContain('statusBarAggregateTruncatedAtom')
    expect(bridgeSource).toContain('store.sub(spreadsheetProjectionSnapshotAtom')
    expect(bridgeSource).toContain('store.setter(syncStatusBarProjectionAtom')
  })

  it('shows active address, selection, projection status, and visible metrics', () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 4 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 1, col: 2 },
    })
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
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          numericCell(0, 0, 1),
          numericCell(0, 1, 2),
          numericCell(0, 2, 3),
          numericCell(0, 3, 4),
          numericCell(0, 4, 5),
        ],
      },
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('15'))
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('3')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('5')
    expect(getByTestId('status-aggregates').getAttribute('data-truncated')).toBe('false')
    // Default-off aggregates are present as buttons but values hidden.
    expect(queryByTestId('status-aggregate-min-value')).toBeNull()

    const minButton = getByTestId('status-aggregate-min')
    expect(minButton.getAttribute('aria-pressed')).toBe('false')
    expect(minButton.getAttribute('data-enabled')).toBe('false')

    fireEvent.click(minButton)
    await waitFor(() => expect(store.getter(statusBarAggregateConfigAtom).min).toBe(true))
    expect(minButton.getAttribute('aria-pressed')).toBe('true')
    expect(minButton.getAttribute('data-enabled')).toBe('true')
    expect(getByTestId('status-aggregate-min-value').textContent).toBe('1')

    fireEvent.click(minButton)
    await waitFor(() => expect(store.getter(statusBarAggregateConfigAtom).min).toBe(false))
    expect(minButton.getAttribute('aria-pressed')).toBe('false')
    expect(minButton.getAttribute('data-enabled')).toBe('false')
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
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          numericCell(0, 0, 1),
          { row: 0, col: 1, displayValue: 'a', valueKind: 'string' },
          numericCell(0, 2, 2),
          { row: 0, col: 3, displayValue: 'b', valueKind: 'string' },
        ],
      },
    })
    // Enable numericCount badge for this assertion.
    store.setter(setStatusBarAggregateConfigAtom, {
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

    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('3'))
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('1.5')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('4')
    expect(getByTestId('status-aggregate-numericCount-value').textContent).toBe('2')
  })

  it('marks a selection outside the visible result window as truncated', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 10, col: 0 },
      focus: { row: 11, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 9)],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregates').getAttribute('data-truncated')).toBe('true'),
    )
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('0')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('0')
  })

  it('forwards upstream backend truncation without recomputing it in Solid', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 4)],
        truncated: true,
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregates').getAttribute('data-truncated')).toBe('true'),
    )
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('4')
  })

  it('suppresses stale cells when result and selection sheets differ', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-2',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 99)],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregates').getAttribute('data-truncated')).toBe('true'),
    )
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('0')
    expect(getByTestId('status-aggregate-count-value').textContent).toBe('0')
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

  it('aggregate values round to 2 decimal places (Excel-standard)', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    // Values 120, 180, 240 -> avg=180 (integer, no decimals).
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 120), numericCell(1, 0, 180), numericCell(2, 0, 240)],
      },
    })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregate-average-value').textContent).toBe('180'),
    )
  })

  it('aggregate average rounds 1.234 + 1.567 to two decimals (1.4)', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 1.234), numericCell(1, 0, 1.567)],
      },
    })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregate-average-value').textContent).toBe('1.4'),
    )
  })

  it('aggregate average of a repeating decimal rounds to 2 decimals', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 4 }

    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 1), numericCell(1, 0, 2), numericCell(2, 0, 4)],
      },
    })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    // (1+2+4)/3 = 2.333..., formatted to "2.33"
    await waitFor(() =>
      expect(getByTestId('status-aggregate-average-value').textContent).toBe('2.33'),
    )
  })

  it('aggregates respond to selection changes', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }

    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 10), numericCell(1, 0, 20), numericCell(2, 0, 30)],
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

    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10'))

    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 0 },
    })

    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('60'))
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('20')
  })

  it('refreshes values while loading and error retain the last aggregate', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 10)],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10'))

    const failedRequest = beginVisibleRefresh(store, window)
    await waitFor(() => expect(getByTestId('status-projection').textContent).toBe('Loading'))
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10')

    const rejected = store.setter(rejectProjectionAtom, {
      request: failedRequest,
      error: new Error('refresh failed'),
    })
    expect(rejected.status).toBe('rejected')
    await waitFor(() => expect(getByTestId('status-projection').textContent).toBe('refresh failed'))
    expect(getByTestId('status-projection').getAttribute('aria-label')).toBe('Projection status')
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10')

    const refreshedRequest = beginVisibleRefresh(store, window)
    await waitFor(() => expect(getByTestId('status-projection').textContent).toBe('Loading'))
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10')
    resolveVisibleRefresh(store, refreshedRequest, [numericCell(0, 0, 25)])

    await waitFor(() => expect(getByTestId('status-projection').textContent).toBe('Ready'))
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('25')
    expect(getByTestId('status-aggregate-average-value').textContent).toBe('25')
  })

  it('ignores stale projection generations after a newer aggregate is visible', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 10)],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('10'))

    const staleRequest = beginVisibleRefresh(store, window)
    resolveVisibleRefresh(store, staleRequest, [numericCell(0, 0, 20)])
    const newestRequest = beginVisibleRefresh(store, window)
    resolveVisibleRefresh(store, newestRequest, [numericCell(0, 0, 30)])
    await waitFor(() => expect(getByTestId('status-aggregate-sum-value').textContent).toBe('30'))

    const lateOutcome = store.setter(resolveProjectionAtom, {
      request: staleRequest,
      result: {
        kind: 'visible-window',
        sheetId: staleRequest.sheetId,
        window: staleRequest.window,
        requestId: staleRequest.requestId,
        cells: [numericCell(0, 0, 999)],
      },
    })

    expect(lateOutcome).toEqual({ status: 'ignored', reason: 'stale' })
    expect(getByTestId('status-aggregate-sum-value').textContent).toBe('30')
  })

  it('clears the Core projection mirror when its Provider unmounts and ignores later results', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 10)],
      },
    })

    const rendered = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(10))

    rendered.unmount()
    await waitFor(() => expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(0))
    expect(store.getter(selectionAggregatesAtom).sum).toBe(0)

    const postUnmountRequest = beginVisibleRefresh(store, window)
    resolveVisibleRefresh(store, postUnmountRequest, [numericCell(0, 0, 99)])
    expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(0)
    expect(store.getter(selectionAggregatesAtom).sum).toBe(0)
  })

  it('localizes every status label and exposes grouped pressed controls plus a live summary', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(setSelectionBoundsAtom, { rowCount: 1, colCount: 1 })
    store.setter(setSelectionAtom, { kind: 'all', sheetId: 'sheet-1' })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 7)],
      },
    })

    const { container, getByRole, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('status-selection').textContent).toBe('All'))
    expect(getByTestId('status-projection').textContent).toBe('Ready')
    expect(getByTestId('status-visible-cells').textContent).toBe('1 cells')
    expect(getByTestId('status-loaded-values').textContent).toBe('1 loaded')
    expect(getByTestId('status-last-command').textContent).toBe('Ready')
    expect(getByRole('group', { name: 'Selection aggregates' })).toBe(
      getByTestId('status-aggregates'),
    )
    expect(getByTestId('status-aggregate-sum').getAttribute('aria-label')).toBe('Toggle Sum')
    expect(getByTestId('status-aggregate-sum').getAttribute('aria-pressed')).toBe('true')
    expect(getByTestId('status-aggregate-min').getAttribute('aria-pressed')).toBe('false')
    expect(getByTestId('status-view-mode-normal').getAttribute('aria-label')).toBe('Normal')
    expect(getByTestId('status-zoom-preset-100').getAttribute('aria-label')).toBe(
      'Set zoom to 100%',
    )
    expect(getByTestId('status-zoom-value').getAttribute('aria-label')).toBe('Reset zoom to 100%')
    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label')).not.toBeNull()
      expect(button.getAttribute('aria-pressed')).not.toBeNull()
    }
    const liveSummary = getByTestId('status-aggregates-summary')
    expect(liveSummary.getAttribute('role')).toBe('status')
    expect(liveSummary.getAttribute('aria-live')).toBe('polite')
    expect(liveSummary.getAttribute('aria-atomic')).toBe('true')
    expect(liveSummary.querySelector('button')).toBeNull()
    expect(liveSummary.textContent).toContain('Selection aggregates: Sum 7')

    setLocale('zh')
    await waitFor(() => expect(getByTestId('status-selection').textContent).toBe('全部'))
    expect(getByTestId('status-projection').textContent).toBe('就绪')
    expect(getByTestId('status-projection').getAttribute('aria-label')).toBe('投影状态')
    expect(getByTestId('status-visible-cells').textContent).toBe('1 个单元格')
    expect(getByTestId('status-loaded-values').textContent).toBe('已加载 1 个值')
    expect(getByTestId('status-last-command').textContent).toBe('就绪')
    expect(getByTestId('status-aggregates').getAttribute('aria-label')).toBe('选区聚合')
    expect(getByTestId('status-aggregate-sum').getAttribute('aria-label')).toBe('切换求和')
    expect(getByTestId('status-view-mode-normal').getAttribute('aria-label')).toBe('普通')
    expect(getByTestId('status-zoom-value').getAttribute('aria-label')).toBe('将缩放重置为 100%')
    expect(liveSummary.textContent).toContain('选区聚合：求和 7')

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    store.setter(dispatchToolbarFormatCommandAtom, { command: 'bold' })
    await waitFor(() => expect(getByTestId('status-last-command').textContent).toBe('工具栏 bold'))
  })

  it('shows localized empty and truncated aggregate notices in visible and live text', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })
    store.setter(setStatusBarAggregateConfigAtom, {
      sum: false,
      average: false,
      count: false,
      numericCount: false,
      min: false,
      max: false,
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [numericCell(0, 0, 7)],
        truncated: true,
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getByTestId('status-aggregates').getAttribute('data-truncated')).toBe('true'),
    )
    expect(getByTestId('status-aggregates-empty').textContent).toBe('No aggregates')
    expect(getByTestId('status-aggregates-truncated').textContent).toBe('Partial results')
    expect(getByTestId('status-aggregates-summary').textContent).toBe(
      'Selection aggregates: none. Results are truncated.',
    )

    setLocale('zh')
    await waitFor(() => expect(getByTestId('status-aggregates-empty').textContent).toBe('无聚合项'))
    expect(getByTestId('status-aggregates-truncated').textContent).toBe('结果不完整')
    expect(getByTestId('status-aggregates-summary').textContent).toBe('选区聚合：无。结果不完整。')
  })
})
