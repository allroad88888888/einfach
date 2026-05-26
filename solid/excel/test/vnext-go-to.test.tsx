/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  RangeProjectionRequest,
  RangeProjectionResult,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  goToOpenAtom,
  goToHistoryAtom,
  goToInputAtom,
  goToLocatorAtom,
  goToModeAtom,
  openGoToAtom,
  selectionAtom,
  selectionRegionsAtom,
  setSelectionBoundsAtom,
  setSheetTabsSheetsAtom,
  setNameRegistryAtom,
  setViewportMetricsAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetGoToDialog } from '../src-vnext/go-to'

afterEach(cleanup)

function createBaseBackend(
  cells: RangeProjectionResult['cells'] = [],
): SpreadsheetBackend {
  return {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult> {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: request.range,
        requestId: request.requestId,
        cells,
      }
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
}

function bootstrap(store: ReturnType<typeof createStore>) {
  store.setter(setSelectionBoundsAtom, { rowCount: 100, colCount: 26 })
  store.setter(setSheetTabsSheetsAtom, {
    sheets: [
      { id: 'sheet1', name: 'Sheet1', index: 0 },
      { id: 'sheet2', name: 'Sheet2', index: 1 },
    ],
  })
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
  store.setter(setViewportMetricsAtom, {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 240,
    viewportWidth: 480,
    rowHeight: 24,
    colWidth: 80,
    rowCount: 20,
    colCount: 8,
    overscanRows: 0,
    overscanCols: 0,
  })
  store.setter(setNameRegistryAtom, {
    names: [
      {
        name: 'MyRange',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet1', address: 'B2:D4' },
      },
    ],
  })
}

describe('SpreadsheetGoToDialog', () => {
  it('does not render when closed', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    expect(container.querySelector('[data-testid="go-to-dialog"]')).toBeNull()
  })

  it('open + Enter on A1 routes selection to A1', async () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)

    const input = await waitFor(() => {
      const el = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
      expect(el).not.toBeNull()
      return el
    })
    fireEvent.input(input, { target: { value: 'C5' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      anchor: { row: 4, col: 2 },
    })
    expect(store.getter(goToOpenAtom)).toBe(false)
    expect(store.getter(goToHistoryAtom)).toContain('C5')
  })

  it('parses A1:C5 range into a range selection', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    const input = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'A1:C5' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'range',
      anchor: { row: 0, col: 0 },
      focus: { row: 4, col: 2 },
    })
  })

  it('parses R1C1 reference', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    const input = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'R3C2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      anchor: { row: 2, col: 1 },
    })
  })

  it('resolves named range via nameRegistryCacheAtom', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    const input = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'MyRange' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'range',
      sheetId: 'sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 3 },
    })
  })

  it('parses sheet-qualified address and switches active sheet', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    const input = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'Sheet2!B3' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 'sheet2',
      anchor: { row: 2, col: 1 },
    })
  })

  it('surfaces inline error for invalid address', async () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    const input = container.querySelector('[data-testid="go-to-input"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'ZZ999XYZ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const err = await waitFor(() => {
      const el = container.querySelector('[data-testid="go-to-error-text"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(err.textContent ?? '').toContain('ZZ999XYZ')
    expect(store.getter(goToOpenAtom)).toBe(true)
  })

  it('Special mode: blanks locator finds blanks absent from sparse projection', async () => {
    const store = createStore()
    bootstrap(store)
    // Narrow the viewport metrics so the host's used-range envelope matches
    // our 3×3 fixture. The backend's sparse projection emits ONLY the 3
    // populated cells (10/20/30 on the diagonal); blank coords are absent.
    // Expected blanks inside the 3×3 rect = 9 - 3 = 6 coords. Coalesced:
    //   row 0: blanks at cols 1,2  → 1 range
    //   row 1: blanks at col 0, col 2 → 2 cells (gap at col 1)
    //   row 2: blanks at cols 0,1  → 1 range
    // Total = 4 regions covering 6 cells.
    store.setter(setViewportMetricsAtom, {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 100,
      viewportWidth: 240,
      rowHeight: 24,
      colWidth: 80,
      rowCount: 3,
      colCount: 3,
      overscanRows: 0,
      overscanCols: 0,
    })
    const cells = [
      { row: 0, col: 0, displayValue: '10', valueKind: 'number' as const },
      { row: 1, col: 1, displayValue: '20', valueKind: 'number' as const },
      { row: 2, col: 2, displayValue: '30', valueKind: 'number' as const },
    ]
    const backend = createBaseBackend(cells)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    // Switch to special tab
    const specialTab = container.querySelector('[data-testid="go-to-tab-special"]') as HTMLButtonElement
    fireEvent.click(specialTab)
    const blanksRadio = container.querySelector(
      '[data-testid="go-to-locator-blanks"]',
    ) as HTMLInputElement
    expect(blanksRadio.checked).toBe(true)
    const confirm = container.querySelector(
      '[data-testid="go-to-confirm-button"]',
    ) as HTMLButtonElement
    fireEvent.click(confirm)

    await waitFor(() => {
      const regions = store.getter(selectionRegionsAtom)
      // 4 coalesced regions covering 6 blank coords.
      expect(regions.length).toBe(4)
      // Verify the cell count by summing each region's coverage.
      let covered = 0
      for (const r of regions) {
        if (r.kind === 'cell') {
          covered += 1
        } else if (r.kind === 'range') {
          covered +=
            (r.focus.row - r.anchor.row + 1) * (r.focus.col - r.anchor.col + 1)
        }
      }
      expect(covered).toBe(6)
    })
  })

  it('Special mode: last-cell locator selects bottom-right populated cell', async () => {
    const store = createStore()
    bootstrap(store)
    const cells = [
      { row: 0, col: 0, displayValue: '1', valueKind: 'number' as const },
      { row: 2, col: 3, displayValue: '9', valueKind: 'number' as const },
    ]
    const backend = createBaseBackend(cells)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    fireEvent.click(container.querySelector('[data-testid="go-to-tab-special"]')!)
    fireEvent.click(container.querySelector('[data-testid="go-to-locator-last-cell"]')!)
    fireEvent.click(container.querySelector('[data-testid="go-to-confirm-button"]')!)

    await waitFor(() => {
      expect(store.getter(selectionAtom)).toMatchObject({
        kind: 'cell',
        anchor: { row: 2, col: 3 },
      })
    })
  })

  it('Special mode: shows "no matches" inline when scan returns 0 cells', async () => {
    const store = createStore()
    bootstrap(store)
    const cells = [
      { row: 0, col: 0, displayValue: '1', valueKind: 'number' as const },
    ]
    const backend = createBaseBackend(cells)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    fireEvent.click(container.querySelector('[data-testid="go-to-tab-special"]')!)
    fireEvent.click(container.querySelector('[data-testid="go-to-locator-comments"]')!)
    fireEvent.click(container.querySelector('[data-testid="go-to-confirm-button"]')!)

    const err = await waitFor(() => {
      const el = container.querySelector('[data-testid="go-to-error-text"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(err.textContent ?? '').toBeTruthy()
    expect(store.getter(goToOpenAtom)).toBe(true)
  })

  it('precedents radio is disabled', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    fireEvent.click(container.querySelector('[data-testid="go-to-tab-special"]')!)
    const precedents = container.querySelector(
      '[data-testid="go-to-locator-precedents"]',
    ) as HTMLInputElement
    expect(precedents.disabled).toBe(true)
  })

  it('open-edge resets mode and input', async () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    // Pre-set special + non-empty input; the open-edge effect should reset
    // them when the dialog flips from closed → open.
    store.setter(openGoToAtom)
    fireEvent.click(container.querySelector('[data-testid="go-to-tab-special"]')!)
    expect(store.getter(goToModeAtom)).toBe('special')

    // Close dialog
    const closeBtn = container.querySelector('[data-testid="go-to-cancel-button"]') as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(store.getter(goToOpenAtom)).toBe(false)

    // Re-open — the open-edge effect should reset mode to 'simple' and clear input.
    store.setter(openGoToAtom)
    await waitFor(() => {
      expect(store.getter(goToModeAtom)).toBe('simple')
      expect(store.getter(goToInputAtom)).toBe('')
    })
  })

  it('locator radio selection round-trips through goToLocatorAtom', () => {
    const store = createStore()
    bootstrap(store)
    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGoToDialog />
      </SpreadsheetUiProvider>
    ))
    store.setter(openGoToAtom)
    fireEvent.click(container.querySelector('[data-testid="go-to-tab-special"]')!)
    fireEvent.click(container.querySelector('[data-testid="go-to-locator-formulas"]')!)
    expect(store.getter(goToLocatorAtom)).toMatchObject({ kind: 'formulas' })

    const subtype = container.querySelector(
      '[data-testid="go-to-subtype-select"]',
    ) as HTMLSelectElement
    expect(subtype).not.toBeNull()
    fireEvent.change(subtype, { target: { value: 'number' } })
    expect(store.getter(goToLocatorAtom)).toMatchObject({
      kind: 'formulas',
      valueKind: 'number',
    })
  })
})
