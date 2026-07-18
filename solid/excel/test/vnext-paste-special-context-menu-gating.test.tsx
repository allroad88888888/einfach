/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  PasteRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  capturePasteSpecialCapabilityAtom,
  copyClipboardAtom,
  menuStateAtom,
  openMenuAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialLifecycleAtom,
  pasteSpecialOpenAtom,
  pasteSpecialSessionIdAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function createBackend(options: {
  withPasteRange: boolean
  pasteRangeRequests: PasteRangeRequest[]
}): SpreadsheetBackend {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: [],
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

  if (options.withPasteRange) {
    backend.pasteRange = async (request) => {
      options.pasteRangeRequests.push(request)
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

function seedPasteSpecialContext(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    },
  })
  store.setter(openMenuAtom, {
    surface: 'context',
    target: {
      kind: 'cell',
      sheetId: 'sheet-1',
      cell: { row: 1, col: 1 },
    },
    position: { x: 0, y: 0 },
    source: 'pointer',
  })
}

describe('Context Menu > Paste Special capability gating', () => {
  it('hides the entry when the canonical capability is false', () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: false, pasteRangeRequests })
    seedPasteSpecialContext(store)

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(queryByTestId('context-menu-command-clipboard.pasteSpecial')).toBeNull()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialSessionIdAtom)).toBe(0)
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('opens the Core session when supported without invoking paste transport', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedPasteSpecialContext(store)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const item = await waitFor(() => getByTestId('context-menu-command-clipboard.pasteSpecial'))
    expect(item.textContent).toBe('选择性粘贴…')
    fireEvent.click(item)

    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    expect(store.getter(menuStateAtom).status).toBe('closed')
    expect(pasteRangeRequests).toHaveLength(0)
  })

  it('fails closed when capability is revoked during a stale activation', async () => {
    const store = createStore()
    const pasteRangeRequests: PasteRangeRequest[] = []
    const backend = createBackend({ withPasteRange: true, pasteRangeRequests })
    seedPasteSpecialContext(store)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const item = await waitFor(() => getByTestId('context-menu-command-clipboard.pasteSpecial'))
    item.addEventListener('click', () => store.setter(capturePasteSpecialCapabilityAtom, {}), {
      capture: true,
      once: true,
    })
    fireEvent.click(item)

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(store.getter(pasteSpecialSessionIdAtom)).toBe(0)
    expect(store.getter(menuStateAtom).status).toBe('open')
    expect(pasteRangeRequests).toHaveLength(0)
  })
})
