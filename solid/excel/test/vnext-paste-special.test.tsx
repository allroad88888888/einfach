/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
  PASTE_SPECIAL_CAPABILITY_ERROR,
  PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR,
  PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR,
  closePasteSpecialAtom,
  copyClipboardAtom,
  createVisibleProjectionRequest,
  diagnosticsAtom,
  historyStackAtom,
  openPasteSpecialAtom,
  patchPasteSpecialOptionsAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialLifecycleAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  selectionAtom,
  setSheetProtectionAtom,
  setWorkspaceActiveSheetAtom,
  type PasteRangeRequest,
  type PasteRangeResult,
  type SpreadsheetBackend,
  type VisibleProjectionRequest,
  type VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { pasteSpecialSupportedAtom, SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetPasteSpecialDialog } from '../src-vnext/paste-special'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

type Store = ReturnType<typeof createStore>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function visibleResult(request: VisibleProjectionRequest): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId: request.sheetId,
    window: request.window,
    requestId: request.requestId,
    revision: 9,
    cells: [],
  }
}

function strictPasteResult(request: PasteRangeRequest): PasteRangeResult {
  return {
    kind: 'paste-range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: 9,
    affectedRange: request.target,
  }
}

function createBackend(
  input: {
    pasteRange?: (request: PasteRangeRequest) => Promise<PasteRangeResult>
    readVisibleProjection?: (request: VisibleProjectionRequest) => Promise<VisibleProjectionResult>
  } = {},
): SpreadsheetBackend {
  const base: SpreadsheetBackend = {
    readVisibleProjection:
      input.readVisibleProjection ??
      (async (request: VisibleProjectionRequest) => visibleResult(request)),
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
  return input.pasteRange === undefined ? base : { ...base, pasteRange: input.pasteRange }
}

function seedPasteContext(
  store: Store,
  input: {
    sheetId?: string
    sourceSheetId?: string
    targetRow?: number
    sourceRow?: number
  } = {},
) {
  const sheetId = input.sheetId ?? 'sheet-1'
  const sourceSheetId = input.sourceSheetId ?? 'source-sheet'
  const targetRow = input.targetRow ?? 4
  const sourceRow = input.sourceRow ?? 1
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId,
    anchor: { row: targetRow, col: 2 },
    focus: { row: targetRow + 1, col: 3 },
  })
  store.setter(copyClipboardAtom, {
    source: {
      sheetId: sourceSheetId,
      range: {
        rowStart: sourceRow,
        rowEnd: sourceRow + 1,
        colStart: 0,
        colEnd: 1,
      },
    },
    includesFormulas: true,
  })
}

function seedProjection(store: Store) {
  const request = createVisibleProjectionRequest({
    sheetId: 'sheet-1',
    requestId: 0,
    window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 8 },
    reason: 'test',
  })
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request,
    result: visibleResult(request),
    error: undefined,
  })
}

function renderDialog(store: Store, backend: SpreadsheetBackend) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetPasteSpecialDialog />
    </SpreadsheetUiProvider>
  ))
}

function queryButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector(`[data-testid="${testId}"]`)
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${testId}`)
  }
  return button
}

describe('SpreadsheetPasteSpecialDialog thin Core projection', () => {
  it('keeps the Solid compatibility alias identical to the canonical read-only atom', () => {
    expect(pasteSpecialSupportedAtom).toBe(pasteSpecialCapabilityAtom)
    expect('write' in pasteSpecialSupportedAtom).toBe(false)
  })

  it('captures a supported backend at provider creation without mounting the dialog', () => {
    const store = createStore()
    const backend = createBackend({
      pasteRange: async (request) => strictPasteResult(request),
    })

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div data-testid="provider-only-child" />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(true)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('captures an unsupported backend at provider creation without mounting the dialog', () => {
    const store = createStore()

    render(() => (
      <SpreadsheetUiProvider backend={createBackend()} store={store}>
        <div data-testid="provider-only-child" />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('keeps a worker-shaped backend without pasteRange closed and transport-free', () => {
    const store = createStore()
    const readVisibleProjection = jest.fn(async (request: VisibleProjectionRequest) =>
      visibleResult(request),
    )
    const backend = createBackend({ readVisibleProjection })
    const { container } = renderDialog(store, backend)

    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    expect(container.querySelector('[data-testid="paste-special-dialog"]')).toBeNull()
    expect(readVisibleProjection).not.toHaveBeenCalled()
  })

  it('does not render while the Core session is closed', () => {
    const store = createStore()
    const { container } = renderDialog(store, createBackend())
    expect(container.querySelector('[data-testid="paste-special-dialog"]')).toBeNull()
  })

  it('missing pasteRange remains blocked, explained, and cancellable', async () => {
    const store = createStore()
    seedPasteContext(store)
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, createBackend())

    const confirm = queryButton(container, 'paste-special-confirm-button')
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('blocked')
      expect(confirm.disabled).toBe(true)
    })
    expect(container.querySelector('[data-testid="paste-special-error"]')?.textContent).toBe(
      PASTE_SPECIAL_CAPABILITY_ERROR,
    )
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)

    fireEvent.click(queryButton(container, 'paste-special-cancel-button'))
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('renders unsupported comments and column widths as disabled with an explanation', async () => {
    const store = createStore()
    seedPasteContext(store)
    store.setter(openPasteSpecialAtom)
    const backend = createBackend({
      pasteRange: async (request) => strictPasteResult(request),
    })
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    })
    const comments = container.querySelector(
      '[data-testid="paste-special-kind-comments"]',
    ) as HTMLInputElement
    const widths = container.querySelector(
      '[data-testid="paste-special-kind-column-widths"]',
    ) as HTMLInputElement
    expect(comments.disabled).toBe(true)
    expect(widths.disabled).toBe(true)
    expect(
      container.querySelector('[data-testid="paste-special-unsupported-explanation"]')?.textContent,
    ).toBe(PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR)
  })

  it('projects Core form state and preserves it across a sibling atom mutation', async () => {
    const store = createStore()
    seedPasteContext(store)
    store.setter(openPasteSpecialAtom)
    const backend = createBackend({
      pasteRange: async (request) => strictPasteResult(request),
    })
    renderDialog(store, backend)
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    })

    store.setter(patchPasteSpecialOptionsAtom, {
      kind: 'values',
      op: 'multiply',
      transpose: true,
      skipBlanks: true,
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-other' })

    expect(store.getter(pasteSpecialOptionsAtom)).toEqual({
      kind: 'values',
      op: 'multiply',
      transpose: true,
      skipBlanks: true,
    })
  })

  it('confirms the frozen Core session, records strict-ack history, refreshes, and closes', async () => {
    const store = createStore()
    seedPasteContext(store)
    seedProjection(store)
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => strictPasteResult(request))
    const readVisibleProjection = jest.fn(async (request: VisibleProjectionRequest) =>
      visibleResult(request),
    )
    const backend = createBackend({ pasteRange, readVisibleProjection })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(
      container.querySelector('[data-testid="paste-special-kind-values"]') as HTMLElement,
    )

    // Live selection/clipboard drift after open must not redirect the request.
    seedPasteContext(store, {
      sheetId: 'sheet-other',
      sourceSheetId: 'source-other',
      targetRow: 50,
      sourceRow: 60,
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))

    await waitFor(() => expect(pasteRange).toHaveBeenCalledTimes(1))
    const request = pasteRange.mock.calls[0]![0]
    expect(request.sheetId).toBe('sheet-1')
    expect(request.target).toEqual({
      rowStart: 4,
      rowEnd: 5,
      colStart: 2,
      colEnd: 3,
    })
    expect(request.source.sheetId).toBe('source-sheet')
    expect(request.source.range).toEqual({
      rowStart: 1,
      rowEnd: 2,
      colStart: 0,
      colEnd: 1,
    })
    expect(request.pasteKind).toBe('values')

    await waitFor(() => expect(readVisibleProjection).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(store.getter(pasteSpecialOpenAtom)).toBe(false))
    const history = store.getter(historyStackAtom)
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({
      kind: 'cells.import',
      sheetId: 'sheet-1',
      projectionRevision: 9,
      affectedRange: request.target,
    })
  })

  it('blocks confirm on a protected sheet with zero pasteRange transport', async () => {
    const store = createStore()
    seedPasteContext(store)
    seedProjection(store)
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => strictPasteResult(request))
    const backend = createBackend({ pasteRange })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))

    // The mutation gateway fails closed before the Core confirm command runs:
    // the session survives, no transport is launched, and the structured
    // diagnostic records the locked block.
    await waitFor(() =>
      expect(
        store
          .getter(diagnosticsAtom)
          .items.some((item) => item.code === 'MUTATION_BLOCKED_LOCKED'),
      ).toBe(true),
    )
    expect(pasteRange).not.toHaveBeenCalled()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  it('blocks confirm while a display→source remap is active, zero transport', async () => {
    const store = createStore()
    seedPasteContext(store)
    // Active filter/sort remap: the frozen session target carries display
    // rows that no longer equal source rows, and the single pasteRange
    // request cannot express the permutation — fail closed.
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 0,
      window: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 8 },
      reason: 'test',
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request,
      result: {
        ...visibleResult(request),
        cells: [
          { row: 4, col: 2, displayValue: 'a', originalRow: 7 },
          { row: 5, col: 2, displayValue: 'b', originalRow: 9 },
        ],
      },
      error: undefined,
    })
    const pasteRange = jest.fn(async (pasteRequest: PasteRangeRequest) =>
      strictPasteResult(pasteRequest),
    )
    const backend = createBackend({ pasteRange })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))

    await waitFor(() =>
      expect(
        store.getter(diagnosticsAtom).items.some((item) => item.code === 'MUTATION_UNMAPPED_ROW'),
      ).toBe(true),
    )
    expect(pasteRange).not.toHaveBeenCalled()
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
  })

  it('transport rejection remains outcome-unknown and disables duplicate confirm', async () => {
    const store = createStore()
    seedPasteContext(store)
    const pasteRange = jest.fn(async (_request: PasteRangeRequest) => {
      throw new Error('connection lost after send')
    })
    const backend = createBackend({ pasteRange })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))

    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('outcome-unknown')
    })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(true)
    expect(container.querySelector('[data-testid="paste-special-error"]')?.textContent).toContain(
      PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR,
    )
    expect(queryButton(container, 'paste-special-cancel-button').disabled).toBe(false)
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    fireEvent.click(queryButton(container, 'paste-special-cancel-button'))
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  it('refresh error keeps the dialog and retries refresh without resending paste', async () => {
    const store = createStore()
    seedPasteContext(store)
    seedProjection(store)
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => strictPasteResult(request))
    const readVisibleProjection = jest
      .fn<(request: VisibleProjectionRequest) => Promise<VisibleProjectionResult>>()
      .mockRejectedValueOnce(new Error('projection offline'))
      .mockImplementationOnce(async (request) => visibleResult(request))
    const backend = createBackend({ pasteRange, readVisibleProjection })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('error')
    })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(readVisibleProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(queryButton(container, 'paste-special-cancel-button').disabled).toBe(false)

    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))
    await waitFor(() => expect(store.getter(pasteSpecialOpenAtom)).toBe(false))
    expect(pasteRange).toHaveBeenCalledTimes(1)
    expect(readVisibleProjection).toHaveBeenCalledTimes(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  it('pending work disables Cancel/X and ignores Escape until acknowledgement completes', async () => {
    const store = createStore()
    seedPasteContext(store)
    seedProjection(store)
    const transport = deferred<PasteRangeResult>()
    let sent: PasteRangeRequest | null = null
    const pasteRange = jest.fn(async (request: PasteRangeRequest) => {
      sent = request
      return transport.promise
    })
    const backend = createBackend({ pasteRange })
    store.setter(openPasteSpecialAtom)
    const { container } = renderDialog(store, backend)

    await waitFor(() => {
      expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(false)
    })
    fireEvent.click(queryButton(container, 'paste-special-confirm-button'))
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('pending')
    })
    expect(
      container.querySelector('[data-testid="paste-special-dialog"]')?.getAttribute('aria-busy'),
    ).toBe('true')
    expect(queryButton(container, 'paste-special-confirm-button').disabled).toBe(true)
    expect(queryButton(container, 'paste-special-cancel-button').disabled).toBe(true)
    expect(queryButton(container, 'paste-special-close-x').disabled).toBe(true)

    fireEvent.click(queryButton(container, 'paste-special-cancel-button'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    transport.resolve(strictPasteResult(sent!))
    await waitFor(() => expect(store.getter(pasteSpecialOpenAtom)).toBe(false))
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  it('close-x dispatches the Core close command', async () => {
    const store = createStore()
    seedPasteContext(store)
    store.setter(openPasteSpecialAtom)
    const backend = createBackend({
      pasteRange: async (request) => strictPasteResult(request),
    })
    const { container } = renderDialog(store, backend)
    await waitFor(() => {
      expect(store.getter(pasteSpecialLifecycleAtom).status).toBe('editing')
    })

    fireEvent.click(queryButton(container, 'paste-special-close-x'))
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
    // Idempotent external close remains harmless after the UI dispatch.
    store.setter(closePasteSpecialAtom)
  })
})
