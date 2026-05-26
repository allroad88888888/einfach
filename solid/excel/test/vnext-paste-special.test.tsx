/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  PasteRangeRequest,
  PasteRangeResult,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  closePasteSpecialAtom,
  copyClipboardAtom,
  historyStackAtom,
  openPasteSpecialAtom,
  patchPasteSpecialOptionsAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { createVisibleProjectionRequest } from '@einfach/spreadsheet-ui-core'
import {
  SpreadsheetUiProvider,
  spreadsheetProjectionSnapshotAtom,
} from '../src-vnext/provider'
import { SpreadsheetPasteSpecialDialog } from '../src-vnext/paste-special'

afterEach(cleanup)

function createBackendWithPasteRange(
  spy: (req: PasteRangeRequest) => Promise<PasteRangeResult>,
): SpreadsheetBackend {
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
    pasteRange: spy,
  }
}

function createBackendWithoutPasteRange(): SpreadsheetBackend {
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

function seedClipboard(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    anchor: { row: 2, col: 0 },
    focus: { row: 2, col: 0 },
  })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    },
  })
}

describe('SpreadsheetPasteSpecialDialog', () => {
  it('does not render when pasteSpecialOpenAtom is false', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))
    expect(container.querySelector('[data-testid="paste-special-dialog"]')).toBeNull()
  })

  it('renders the radio group, op select and toggles when open', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="paste-special-dialog"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-kind-values"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="paste-special-kind-values-and-formats"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-op-select"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-transpose"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-skip-blanks"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-confirm-button"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paste-special-cancel-button"]')).not.toBeNull()
  })

  it('cancel button closes the dialog', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-cancel-button"]') as HTMLElement,
    )
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('close-x button closes the dialog', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-close-x"]') as HTMLElement,
    )
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('selecting a kind radio patches the options atom', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-kind-values"]') as HTMLElement,
    )
    expect(store.getter(pasteSpecialOptionsAtom).kind).toBe('values')
  })

  it('confirm calls backend.pasteRange with the chosen options and closes the dialog', async () => {
    const store = createStore()
    const fakeResult: PasteRangeResult = {
      kind: 'paste-range',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 1,
    }
    const pasteSpy = jest.fn(async (_req: PasteRangeRequest) => fakeResult)
    const backend = createBackendWithPasteRange(pasteSpy)
    seedClipboard(store)
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-kind-values"]') as HTMLElement,
    )

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-confirm-button"]') as HTMLElement,
    )

    await waitFor(() => {
      expect(pasteSpy).toHaveBeenCalledTimes(1)
    })
    const req = pasteSpy.mock.calls[0]![0]
    expect(req.kind).toBe('paste-range')
    expect(req.pasteKind).toBe('values')
    expect(req.op).toBe('none')
    expect(req.sheetId).toBe('sheet-1')

    await waitFor(() => {
      expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    })
  })

  it('confirm with no pasteRange port closes the dialog without throwing', async () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    store.setter(openPasteSpecialAtom)
    // Swallow the expected console.warn so the test output stays clean.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="paste-special-confirm-button"]') as HTMLElement,
    )

    await waitFor(() => {
      expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    })
    warnSpy.mockRestore()
  })

  it('openPasteSpecialAtom is the wiring point for the Ctrl+Alt+V intent', () => {
    const store = createStore()
    const backend = createBackendWithoutPasteRange()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    store.setter(openPasteSpecialAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="paste-special-dialog"]')).not.toBeNull()
    store.setter(closePasteSpecialAtom)
  })

  it(
    // Wave 7.3 review HIGH #1: under Solid 1.9.12 the consumer body
    // re-executes on unrelated atom mutations. The previous dialog used
    // a `createEffect<boolean>(wasOpen)` open-edge to reset form
    // values, which would re-fire with stale `prev` and wipe the user's
    // selections mid-interaction. With reset moved store-side
    // (`openPasteSpecialAtom`), the user's chosen options must survive
    // a sibling atom mutation that triggers the consumer-body remount.
    'form options survive a sibling atom mutation (Solid 1.9.12 remount hazard)',
    () => {
      const store = createStore()
      const backend = createBackendWithoutPasteRange()
      store.setter(openPasteSpecialAtom)

      render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetPasteSpecialDialog />
        </SpreadsheetUiProvider>
      ))

      // Pick a non-default kind + op + flags via the patch atom (the
      // same path the form controls invoke).
      store.setter(patchPasteSpecialOptionsAtom, {
        kind: 'values',
        op: 'multiply',
        transpose: true,
        skipBlanks: true,
      })

      // Mutate an unrelated atom — under 1.9.12 this triggers the
      // consumer-body re-execution. If the open-edge reset hazard had
      // survived the fix, this would clobber the options back to
      // defaults.
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-other' })

      expect(store.getter(pasteSpecialOptionsAtom)).toEqual({
        kind: 'values',
        op: 'multiply',
        transpose: true,
        skipBlanks: true,
      })
    },
  )

  it(
    // Wave 7.3 review HIGH #2: confirm must record a history entry +
    // refresh the visible projection so undo works and the grid
    // repaints. Mirrors the regular Ctrl+V flow in SpreadsheetGrid.
    'confirm records a history entry and refreshes the visible projection',
    async () => {
      const store = createStore()
      const fakeResult: PasteRangeResult = {
        kind: 'paste-range',
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 9,
        affectedRange: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 1 },
      }
      const pasteSpy = jest.fn(async (_req: PasteRangeRequest) => fakeResult)
      const readSpy = jest.fn(async (_req: unknown) => {
        const result: VisibleProjectionResult = {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
          requestId: 0,
          revision: 9,
          cells: [],
        }
        return result
      })
      const backend: SpreadsheetBackend = {
        readVisibleProjection: readSpy as unknown as SpreadsheetBackend['readVisibleProjection'],
        async readRangeProjection() {
          throw new Error('not used')
        },
        async setCellInput() {
          throw new Error('not used')
        },
        pasteRange: pasteSpy,
      }

      // Seed clipboard + selection so the dialog has a valid paste target.
      seedClipboard(store)
      // Seed an initial projection-snapshot so refreshVisibleProjection
      // has a window/sheetId to re-fetch against.
      const request = createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 0,
        window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      })
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'ready',
        request,
        result: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
          requestId: 0,
          revision: 1,
          cells: [],
        },
        error: undefined,
      })

      store.setter(openPasteSpecialAtom)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetPasteSpecialDialog />
        </SpreadsheetUiProvider>
      ))

      const before = store.getter(historyStackAtom).entries.length

      fireEvent.click(
        container.querySelector('[data-testid="paste-special-confirm-button"]') as HTMLElement,
      )

      await waitFor(() => {
        expect(pasteSpy).toHaveBeenCalledTimes(1)
      })

      // History: one new entry, kind `cells.import`, with the
      // backend's affectedRange and projectionRevision propagated.
      await waitFor(() => {
        const entries = store.getter(historyStackAtom).entries
        expect(entries.length).toBe(before + 1)
        const last = entries[entries.length - 1]
        expect(last.kind).toBe('cells.import')
        expect(last.sheetId).toBe('sheet-1')
        expect(last.projectionRevision).toBe(9)
      })

      // Projection refresh: readVisibleProjection must be called
      // post-confirm so the grid repaints.
      await waitFor(() => {
        expect(readSpy).toHaveBeenCalled()
      })

      // Dialog closed.
      await waitFor(() => {
        expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
      })
    },
  )
})
