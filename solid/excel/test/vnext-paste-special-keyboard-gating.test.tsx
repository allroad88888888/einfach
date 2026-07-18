/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  PasteRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  capturePasteSpecialCapabilityAtom,
  copyClipboardAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialOpenAtom,
  setWorkspaceActiveSheetAtom,
  topMenuOpenAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

/**
 * Wave 7.3 review MEDIUM #3: the global Ctrl+Alt+V shortcut must not
 * pop the Paste Special dialog when (a) the backend omits `pasteRange`
 * or (b) the clipboard has no copyable payload. The core keyboard
 * dispatcher under `vanilla/spreadsheet-ui-core/src/keyboard` stays a
 * pure intent translator; gating lives at the host wiring layer in
 * `SpreadsheetGrid`.
 */

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({ row, col, displayValue: `${row},${col}` })
    }
  }
  return cells
}

function createBackend(opts: {
  withPasteRange: boolean
  pasteRangeRequests?: PasteRangeRequest[]
}): SpreadsheetBackend {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
      return result
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput(request) {
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
  }
  if (opts.withPasteRange) {
    backend.pasteRange = async (request) => {
      opts.pasteRangeRequests?.push(request)
      return {
        kind: 'paste-range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: request.target,
      }
    }
  }
  return backend
}

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 4,
  viewportWidth: 4,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 10,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

function seedClipboardSource(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    },
  })
}

describe('Ctrl+Alt+V dispatcher gating', () => {
  it('does not open the dialog when backend lacks pasteRange capability', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: false, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    // Capability missing → dialog never opens.
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('does not open the dialog when the clipboard has no copyable payload', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    // Note: NO copyClipboardAtom seed — clipboard.source / payload remain null.
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('opens the dialog when capability + clipboard payload are both present', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })

    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('ignores a supported shortcut event that an upstream handler already prevented', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    const event = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()
    expect(event.defaultPrevented).toBe(true)
    container.querySelector<HTMLElement>('[data-testid="grid"]')!.dispatchEvent(event)

    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(pasteRangeRequests).toHaveLength(0)
  })
})

describe('Edit > Paste Special capability gating', () => {
  it('hides the menu item when the canonical capability is false', () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: false, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(container.querySelector('[data-testid="menu-bar-item-edit.pasteSpecial"]')).toBeNull()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('opens from the menu when the canonical capability is true without invoking transport', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="menu-bar-item-edit.pasteSpecial"]'),
      ).not.toBeNull()
    })
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.pasteSpecial"]')!)

    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('fails closed when capability is revoked during a stale menu activation', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedClipboardSource(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    let pasteSpecialItem: HTMLElement | null = null
    await waitFor(() => {
      pasteSpecialItem = container.querySelector<HTMLElement>(
        '[data-testid="menu-bar-item-edit.pasteSpecial"]',
      )
      expect(pasteSpecialItem).not.toBeNull()
    })

    pasteSpecialItem!.addEventListener(
      'click',
      () => store.setter(capturePasteSpecialCapabilityAtom, {}),
      { capture: true, once: true },
    )
    fireEvent.click(pasteSpecialItem!)

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(pasteRangeRequests).toHaveLength(0)
  })
})
