/** @jsxImportSource solid-js */

/**
 * Parity #11 — Paste Special UI flow over the REAL in-process TS worker
 * stack (worker-demo composition: menu bar + dialog + worker backend).
 *
 * Pins the capability unlock this slice ships:
 *  - the Edit > Paste Special entry APPEARS once the worker backend
 *    exposes `pasteRange` (it was hidden before),
 *  - post-ready recapture subdivides the kinds to the value leg
 *    (TS runtime declares no format model) and the dialog renders the
 *    format-leg radios disabled with the structured backend reason,
 *  - open falls back to the 'values' kind so the dialog starts editable,
 *  - confirm walks the full strict chain against the real adapter:
 *    transport → exact ACK → history entry → projection refresh → close,
 *    and the engine really holds the pasted values afterwards.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
  copyClipboardAtom,
  createVisibleProjectionRequest,
  historyStackAtom,
  openPasteSpecialAtom,
  pasteSpecialBackendKindError,
  patchPasteSpecialOptionsAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialLifecycleAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  pasteSpecialSupportedKindsAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  type CellRange,
  type DisplayCell,
} from '@einfach/spreadsheet-ui-core'

import {
  installWorkerRuntimeTs,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike, WorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import { SpreadsheetPasteSpecialDialog } from '../src-vnext/paste-special'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

const SHEET = 'sheet-1'

function createInProcessTsWorker(): WorkerLike {
  const toWorker: Array<(e: MessageEvent) => void> = []
  const toClient: Array<(e: MessageEvent) => void> = []
  const workerCtx: WorkerContext = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type, listener) {
      toWorker.push(listener)
    },
  }
  installWorkerRuntimeTs(workerCtx)
  return {
    postMessage(msg: unknown) {
      for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      toClient.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = toClient.indexOf(listener)
      if (index >= 0) toClient.splice(index, 1)
    },
    terminate() {},
  }
}

async function createBackend(): Promise<WorkerWorkbookSpreadsheetBackend> {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: () => createInProcessTsWorker(),
    sheets: [{ id: SHEET, name: 'Sheet1' }],
  })
  await backend.ready()
  return backend
}

type Store = ReturnType<typeof createStore>

/** Frozen dialog context: 2x2 source at rows 1-2 / cols 0-1, target anchored at (4,2). */
function seedPasteContext(store: Store) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: SHEET,
    anchor: { row: 4, col: 2 },
    focus: { row: 5, col: 3 },
  })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 1 },
    },
    includesFormulas: true,
  })
}

function seedProjection(store: Store) {
  const request = createVisibleProjectionRequest({
    sheetId: SHEET,
    requestId: 0,
    window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 8 },
    reason: 'test',
  })
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request,
    result: {
      kind: 'visible-window',
      sheetId: SHEET,
      window: request.window,
      requestId: request.requestId,
      revision: 1,
      cells: [],
    },
    error: undefined,
  })
}

let projectionRequestId = 1000

async function displayAt(
  backend: WorkerWorkbookSpreadsheetBackend,
  row: number,
  col: number,
): Promise<string> {
  const range: CellRange = { rowStart: row, rowEnd: row, colStart: col, colEnd: col }
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId: SHEET,
    range,
    requestId: projectionRequestId++,
    reason: 'viewport',
  } as never)
  const cells = result.cells as DisplayCell[]
  return cells.find((cell) => cell.row === row && cell.col === col)?.displayValue ?? ''
}

describe('worker demo Paste Special — full dialog flow (in-process TS worker)', () => {
  it('unlocks the Edit menu entry and completes a values paste end to end', async () => {
    const store = createStore()
    const backend = await createBackend()
    await backend.importCells!({
      kind: 'import-cells',
      sheetId: SHEET,
      cells: [
        { row: 1, col: 0, input: '7' },
        { row: 1, col: 1, input: 'hello' },
        { row: 2, col: 0, input: '8' },
        { row: 2, col: 1, input: '9' },
        { row: 4, col: 2, input: 'stale' },
      ],
    })
    seedPasteContext(store)
    seedProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    // Post-ready recapture: capability true, kinds subdivided fail-closed.
    await waitFor(() => {
      expect(store.getter(pasteSpecialCapabilityAtom)).toBe(true)
      expect(store.getter(pasteSpecialSupportedKindsAtom)).toEqual(['values', 'transpose'])
    })

    // The Edit menu entry appears now that the worker backend implements
    // pasteRange (this was the hidden entry before this slice).
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    const menuItem = container.querySelector('[data-testid="menu-bar-item-edit.pasteSpecial"]')
    expect(menuItem).not.toBeNull()
    fireEvent.click(menuItem!)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)

    // Open fell back to the first backend-supported kind: the dialog
    // starts editable instead of pre-blocked on 'values-and-formats'.
    expect(store.getter(pasteSpecialOptionsAtom).kind).toBe('values')
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    })

    // Format-leg kinds degrade to disabled radios with the structured reason.
    for (const kind of ['formats', 'values-and-formats', 'all'] as const) {
      const radio = container.querySelector<HTMLInputElement>(
        `[data-testid="paste-special-kind-${kind}"]`,
      )
      expect(radio?.disabled).toBe(true)
      expect(radio?.closest('label')?.title).toBe(pasteSpecialBackendKindError(kind))
    }
    const valuesRadio = container.querySelector<HTMLInputElement>(
      '[data-testid="paste-special-kind-values"]',
    )
    expect(valuesRadio?.disabled).toBe(false)
    expect(valuesRadio?.checked).toBe(true)

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="paste-special-confirm-button"]',
    )
    expect(confirm?.disabled).toBe(false)
    fireEvent.click(confirm!)

    // Full strict chain: transport → exact ACK → history → refresh → close.
    await waitFor(() => expect(store.getter(pasteSpecialOpenAtom)).toBe(false))
    const history = store.getter(historyStackAtom)
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({
      kind: 'cells.import',
      sheetId: SHEET,
      affectedRange: { rowStart: 4, rowEnd: 5, colStart: 2, colEnd: 3 },
    })

    // The engine really holds the pasted values.
    expect(await displayAt(backend, 4, 2)).toBe('7')
    expect(await displayAt(backend, 4, 3)).toBe('hello')
    expect(await displayAt(backend, 5, 2)).toBe('8')
    expect(await displayAt(backend, 5, 3)).toBe('9')
    backend.dispose()
  })

  it('blocks a format-leg kind pre-dispatch with the structured backend reason', async () => {
    const store = createStore()
    const backend = await createBackend()
    seedPasteContext(store)
    seedProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPasteSpecialDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(pasteSpecialSupportedKindsAtom)).toEqual(['values', 'transpose'])
    })
    store.setter(openPasteSpecialAtom)
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    })

    // The radio renders disabled (jsdom's fireEvent bypasses the DOM
    // disabled guard, so the core block below is the real fail-closed
    // pin: even a patch that sneaks through cannot reach transport).
    const formatsRadio = container.querySelector<HTMLInputElement>(
      '[data-testid="paste-special-kind-formats"]',
    )
    expect(formatsRadio?.disabled).toBe(true)

    store.setter(patchPasteSpecialOptionsAtom, { kind: 'formats' })
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="paste-special-error"]')?.textContent,
      ).toBe(pasteSpecialBackendKindError('formats'))
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="paste-special-confirm-button"]',
        )?.disabled,
      ).toBe(true)
    })

    // Switching back to a supported kind recovers without reopening.
    store.setter(patchPasteSpecialOptionsAtom, { kind: 'values' })
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    backend.dispose()
  })
})
