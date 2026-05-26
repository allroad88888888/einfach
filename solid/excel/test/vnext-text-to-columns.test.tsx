/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  ImportCellChunksRequest,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  openTextToColumnsAtom,
  textToColumnsOpenAtom,
  textToColumnsWizardAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetTextToColumnsDialog } from '../src-vnext/text-to-columns'

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

function createImportSpyBackend(spy: (req: ImportCellChunksRequest) => Promise<BackendMutationResult>): SpreadsheetBackend {
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
    delimitedRadio: container.querySelector(
      '[data-testid="ttc-mode-delimited"]',
    ) as HTMLInputElement | null,
    fixedRadio: container.querySelector('[data-testid="ttc-mode-fixed"]') as HTMLInputElement | null,
    delimComma: container.querySelector('[data-testid="ttc-delim-comma"]') as HTMLInputElement | null,
    delimTab: container.querySelector('[data-testid="ttc-delim-tab"]') as HTMLInputElement | null,
    error: container.querySelector('[data-testid="ttc-no-source-error"]'),
    preview: container.querySelector('[data-testid="ttc-preview"]'),
  }
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

    const back = container.querySelector(
      '[data-testid="ttc-back-button"]',
    ) as HTMLButtonElement
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
    const commaBox = container.querySelector(
      '[data-testid="ttc-delim-comma"]',
    ) as HTMLInputElement
    const tabBox = container.querySelector(
      '[data-testid="ttc-delim-tab"]',
    ) as HTMLInputElement
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
    const select = container.querySelector(
      '[data-testid="ttc-format-0"]',
    ) as HTMLSelectElement
    const dateOption = Array.from(select.options).find((o) => o.value === 'date')
    expect(dateOption).toBeDefined()
    expect(dateOption!.disabled).toBe(true)
    expect(dateOption!.getAttribute('title')).toMatch(/not yet supported|不支持/)
  })

  it('Finish calls backend.importCellChunks with assembled plan and closes', async () => {
    const store = createStore()
    const spy = jest.fn(
      async (_req: ImportCellChunksRequest): Promise<BackendMutationResult> => ({
        sheetId: 'sheet-1',
      }),
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

    // Advance step 1 -> 2.
    fireEvent.click(getEls(container).next!)
    // Set delimiter to comma.
    const tabBox = container.querySelector(
      '[data-testid="ttc-delim-tab"]',
    ) as HTMLInputElement
    fireEvent.click(tabBox)
    const commaBox = container.querySelector(
      '[data-testid="ttc-delim-comma"]',
    ) as HTMLInputElement
    fireEvent.click(commaBox)
    // Advance to step 3.
    fireEvent.click(getEls(container).next!)
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
})
