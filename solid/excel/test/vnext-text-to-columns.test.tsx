/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  ImportCellChunksRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  captureTextToColumnsCapabilityAtom,
  openTextToColumnsAtom,
  textToColumnsOpenAtom,
  textToColumnsWizardAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetTextToColumnsDialog } from '../src-vnext/text-to-columns'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function createBaseBackend(): SpreadsheetBackend {
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

function createImportSpyBackend(
  spy: (req: ImportCellChunksRequest) => Promise<BackendMutationResult>,
): SpreadsheetBackend {
  return {
    ...createBaseBackend(),
    importCellChunks: spy,
  }
}

function getEls(container: HTMLElement) {
  return {
    dialog: container.querySelector('[data-testid="text-to-columns-dialog"]'),
    stepLabel: container.querySelector('[data-testid="ttc-step-label"]'),
    back: container.querySelector('[data-testid="ttc-back-button"]') as HTMLButtonElement | null,
    next: container.querySelector('[data-testid="ttc-next-button"]') as HTMLButtonElement | null,
    cancel: container.querySelector(
      '[data-testid="ttc-cancel-button"]',
    ) as HTMLButtonElement | null,
    finish: container.querySelector(
      '[data-testid="ttc-finish-button"]',
    ) as HTMLButtonElement | null,
    close: container.querySelector('[data-testid="dialog-close-x"]') as HTMLButtonElement | null,
    delimitedRadio: container.querySelector(
      '[data-testid="ttc-mode-delimited"]',
    ) as HTMLInputElement | null,
    fixedRadio: container.querySelector(
      '[data-testid="ttc-mode-fixed"]',
    ) as HTMLInputElement | null,
    delimComma: container.querySelector(
      '[data-testid="ttc-delim-comma"]',
    ) as HTMLInputElement | null,
    delimTab: container.querySelector('[data-testid="ttc-delim-tab"]') as HTMLInputElement | null,
    error: container.querySelector('[data-testid="ttc-no-source-error"]'),
    mutationError: container.querySelector('[data-testid="ttc-mutation-error"]'),
    preview: container.querySelector('[data-testid="ttc-preview"]'),
  }
}

function advanceToFinalStep(container: HTMLElement) {
  fireEvent.click(getEls(container).next!)
  fireEvent.click(container.querySelector('[data-testid="ttc-delim-tab"]')!)
  fireEvent.click(container.querySelector('[data-testid="ttc-delim-comma"]')!)
  fireEvent.click(getEls(container).next!)
}

function matchingAcknowledgement(request: ImportCellChunksRequest): BackendMutationResult {
  if (request.requestId === undefined || request.range === undefined) {
    throw new Error('expected request identity and target range')
  }
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: 1,
    affectedRange: request.range,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SpreadsheetTextToColumnsDialog', () => {
  it('does not render when textToColumnsOpenAtom is false', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))

    expect(getEls(container).dialog).toBeNull()
  })

  it('renders dialog with step-1 controls when open', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [
        { sourceRow: 0, text: 'a,b,c' },
        { sourceRow: 1, text: 'd,e,f' },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))

    const els = getEls(container)
    expect(els.dialog).not.toBeNull()
    expect(els.delimitedRadio?.checked).toBe(true)
    expect(els.next).not.toBeNull()
  })

  it('Next from step-1 advances to step-2-delimited; Back returns to step-1', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    const { next } = getEls(container)
    fireEvent.click(next!)
    expect(store.getter(textToColumnsWizardAtom).step).toBe('step-2-delimited')

    const back = container.querySelector('[data-testid="ttc-back-button"]') as HTMLButtonElement
    fireEvent.click(back)
    expect(store.getter(textToColumnsWizardAtom).step).toBe('step-1')
  })

  it('toggling the comma delimiter updates the preview tokens', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b,c' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(getEls(container).next!)
    const commaBox = container.querySelector('[data-testid="ttc-delim-comma"]') as HTMLInputElement
    const tabBox = container.querySelector('[data-testid="ttc-delim-tab"]') as HTMLInputElement
    fireEvent.click(tabBox) // uncheck default tab
    fireEvent.click(commaBox) // check comma

    await waitFor(() => {
      const cell0 = container.querySelector('[data-testid="ttc-preview-cell-0-0"]')
      const cell2 = container.querySelector('[data-testid="ttc-preview-cell-0-2"]')
      expect(cell0?.textContent).toBe('a')
      expect(cell2?.textContent).toBe('c')
    })
  })

  it('renders error and disables Finish when source is empty (non-single-column selection)', () => {
    const store = createStore()
    const backend = createBaseBackend()
    // Mimic the menu-bar dispatch when range is multi-column: rows[] = [].
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    const els = getEls(container)
    expect(els.error).not.toBeNull()
    expect(els.finish?.disabled).toBe(true)
  })

  it('Cancel closes the dialog', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(getEls(container).cancel!)
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
  })

  it('Next is disabled on step-2-delimited when no delimiter is active', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b,c' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    // Step 1 -> Step 2 delimited (tab default is active).
    fireEvent.click(getEls(container).next!)
    expect(store.getter(textToColumnsWizardAtom).step).toBe('step-2-delimited')

    // Uncheck the only active delimiter (tab).
    const tab = container.querySelector('[data-testid="ttc-delim-tab"]') as HTMLInputElement
    fireEvent.click(tab)

    // Next should now be disabled and clicking it should not advance.
    const next = container.querySelector('[data-testid="ttc-next-button"]') as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(container.querySelector('[data-testid="ttc-next-disabled-hint"]')).not.toBeNull()
    fireEvent.click(next)
    expect(store.getter(textToColumnsWizardAtom).step).toBe('step-2-delimited')

    // Re-enable comma — Next becomes available.
    const comma = container.querySelector('[data-testid="ttc-delim-comma"]') as HTMLInputElement
    fireEvent.click(comma)
    const nextAgain = container.querySelector(
      '[data-testid="ttc-next-button"]',
    ) as HTMLButtonElement
    expect(nextAgain.disabled).toBe(false)
  })

  it('Step 3 Date format option is disabled with explanatory tooltip', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(getEls(container).next!) // step 2
    fireEvent.click(container.querySelector('[data-testid="ttc-delim-tab"]')!)
    fireEvent.click(container.querySelector('[data-testid="ttc-delim-comma"]')!)
    fireEvent.click(getEls(container).next!) // step 3
    const select = container.querySelector('[data-testid="ttc-format-0"]') as HTMLSelectElement
    const dateOption = Array.from(select.options).find((o) => o.value === 'date')
    expect(dateOption).toBeDefined()
    expect(dateOption!.disabled).toBe(true)
    expect(dateOption!.getAttribute('title')).toMatch(/not yet supported|不支持/)
  })

  it('Finish calls backend.importCellChunks with assembled plan and closes', async () => {
    const store = createStore()
    const spy = jest.fn(
      async (request: ImportCellChunksRequest): Promise<BackendMutationResult> =>
        matchingAcknowledgement(request),
    )
    const backend = createImportSpyBackend(spy)
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [
        { sourceRow: 0, text: 'a,b' },
        { sourceRow: 1, text: 'c,d' },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))

    advanceToFinalStep(container)
    // Finish.
    fireEvent.click(getEls(container).finish!)

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1)
    })
    const req = spy.mock.calls[0]![0]
    expect(req.sheetId).toBe('sheet-1')
    expect(req.kind).toBe('import-cell-chunks')

    // Drain the chunk source to inspect emitted cells.
    const collected: { row: number; col: number; input: string; preserveAsText?: boolean }[] = []
    for await (const chunk of req.chunks) {
      for (const c of chunk) collected.push(c)
    }
    expect(collected).toEqual([
      { row: 0, col: 0, input: 'a' },
      { row: 0, col: 1, input: 'b' },
      { row: 1, col: 0, input: 'c' },
      { row: 1, col: 1, input: 'd' },
    ])

    await waitFor(() => {
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    })
  })

  it('keeps X, Cancel, and Escape blocked through pending, acknowledgement, and refresh', async () => {
    const store = createStore()
    const acknowledgement = deferred<BackendMutationResult>()
    const projection = deferred<VisibleProjectionResult>()
    let importRequest: ImportCellChunksRequest | null = null
    let projectionRequest: VisibleProjectionRequest | null = null
    const importSpy = jest.fn((request: ImportCellChunksRequest) => {
      importRequest = request
      return acknowledgement.promise
    })
    const backend: SpreadsheetBackend = {
      ...createImportSpyBackend(importSpy),
      async readVisibleProjection(request) {
        projectionRequest = request
        return projection.promise
      },
    }
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: undefined,
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 10 },
        requestId: 0,
        revision: 0,
        cells: [],
      },
      error: undefined,
    })
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    advanceToFinalStep(container)
    await waitFor(() => {
      expect(getEls(container).finish?.disabled).toBe(false)
    })
    fireEvent.click(getEls(container).finish!)
    fireEvent.click(getEls(container).finish!)

    await waitFor(() => {
      expect(getEls(container).dialog?.getAttribute('data-lifecycle')).toBe('pending')
    })
    expect(getEls(container).dialog?.getAttribute('aria-busy')).toBe('true')
    expect(getEls(container).close?.disabled).toBe(true)
    expect(getEls(container).cancel?.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)

    await Promise.resolve()
    expect(importSpy).toHaveBeenCalledTimes(1)
    if (importRequest === null) throw new Error('expected import request')
    acknowledgement.resolve(matchingAcknowledgement(importRequest))
    await Promise.resolve()
    expect(getEls(container).dialog?.getAttribute('data-lifecycle')).toBe('local-acknowledged')
    expect(getEls(container).dialog?.getAttribute('aria-busy')).toBe('true')
    expect(getEls(container).close?.disabled).toBe(true)
    expect(getEls(container).cancel?.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)

    await Promise.resolve()
    expect(getEls(container).dialog?.getAttribute('data-lifecycle')).toBe('refreshing')
    expect(getEls(container).dialog?.getAttribute('aria-busy')).toBe('true')
    expect(getEls(container).close?.disabled).toBe(true)
    expect(getEls(container).cancel?.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)

    const requestedProjection = projectionRequest as VisibleProjectionRequest | null
    if (requestedProjection === null) throw new Error('expected projection refresh request')
    projection.resolve({
      kind: 'visible-window',
      sheetId: requestedProjection.sheetId,
      window: requestedProjection.window,
      requestId: requestedProjection.requestId,
      revision: 2,
      cells: [],
    })
    await waitFor(() => {
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    })
    expect(importSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps an acknowledged refresh error locked and retries only projection refresh', async () => {
    const store = createStore()
    const importSpy = jest.fn(async (request: ImportCellChunksRequest) =>
      matchingAcknowledgement(request),
    )
    let projectionCount = 0
    const backend: SpreadsheetBackend = {
      ...createImportSpyBackend(importSpy),
      async readVisibleProjection(request) {
        projectionCount += 1
        if (projectionCount === 1) throw new Error('projection unavailable')
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: request.window,
          requestId: request.requestId,
          revision: 2,
          cells: [],
        }
      },
    }
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: undefined,
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 10 },
        requestId: 0,
        revision: 0,
        cells: [],
      },
      error: undefined,
    })
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    advanceToFinalStep(container)
    await waitFor(() => {
      expect(getEls(container).finish?.disabled).toBe(false)
    })
    fireEvent.click(getEls(container).finish!)

    await waitFor(() => {
      expect(getEls(container).dialog?.getAttribute('data-lifecycle')).toBe('error')
      expect(getEls(container).mutationError?.textContent).toMatch(/projection unavailable/)
    })
    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(projectionCount).toBe(1)
    store.setter(captureTextToColumnsCapabilityAtom, {})
    await waitFor(() => {
      expect(getEls(container).finish?.disabled).toBe(false)
    })
    expect(getEls(container).close?.disabled).toBe(true)
    expect(getEls(container).cancel?.disabled).toBe(true)
    fireEvent.click(getEls(container).close!)
    fireEvent.click(getEls(container).cancel!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)
    expect(
      store.setter(openTextToColumnsAtom, {
        sheetId: 'sheet-2',
        anchor: { row: 0, col: 0 },
        rows: [{ sourceRow: 0, text: 'new,value' }],
      }),
    ).toBeNull()

    fireEvent.click(getEls(container).finish!)
    await waitFor(() => {
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    })
    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(projectionCount).toBe(2)
  })

  it('projects outcome-unknown as an immutable dialog and never resends', async () => {
    const store = createStore()
    const importSpy = jest.fn(async (): Promise<BackendMutationResult> => {
      throw new Error('connection ended after send')
    })
    const backend = createImportSpyBackend(importSpy)
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'a,b' }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetTextToColumnsDialog />
      </SpreadsheetUiProvider>
    ))
    advanceToFinalStep(container)
    await waitFor(() => {
      expect(getEls(container).finish?.disabled).toBe(false)
    })
    fireEvent.click(getEls(container).finish!)

    await waitFor(() => {
      expect(getEls(container).dialog?.getAttribute('data-lifecycle')).toBe('outcome-unknown')
      expect(getEls(container).mutationError?.textContent).toMatch(/avoid a duplicate import/)
    })
    expect(getEls(container).finish?.disabled).toBe(true)
    expect(getEls(container).close?.disabled).toBe(true)
    expect(getEls(container).cancel?.disabled).toBe(true)
    fireEvent.click(getEls(container).finish!)
    fireEvent.click(getEls(container).close!)
    fireEvent.click(getEls(container).cancel!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)
  })
})
