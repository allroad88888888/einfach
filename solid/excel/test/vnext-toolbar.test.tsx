/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  MergeRangeRequest,
  SetFormatRangeRequest,
  SpreadsheetBackend,
  UnmergeRangeRequest,
  VisibleProjectionResult,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  beginProjectionAtom,
  diagnosticsAtom,
  findReplaceOpenAtom,
  formatCellsEditorAtom,
  formatPainterStateAtom,
  historyStackAtom,
  resolveProjectionAtom,
  selectCellAtom,
  setWorkspaceActiveSheetAtom,
  startEditingAtom,
  toolbarActiveSurfaceAtom,
  toolbarIntentAtom,
  toolbarMutationLifecycleAtom,
  setSheetProtectionAtom,
} from '@einfach/spreadsheet-ui-core'
import { setLocale } from '../src/i18n'
import { numberFormatDialogAtom } from '../src-vnext/format-cells'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'

const RAW_I18N_KEY_RE =
  /\b(?:toolbar|numberFormatDropdown|numberFormatDialog|formatCells)\.[A-Za-z0-9_.-]+/

afterEach(() => {
  cleanup()
  setLocale('en')
})

setLocale('en')

function createFakeBackend() {
  const backend: SpreadsheetBackend = {
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

  return backend
}

function createRecordingBackend() {
  const setFormatRangeCalls: SetFormatRangeRequest[] = []
  const mergeRangeCalls: MergeRangeRequest[] = []
  const unmergeRangeCalls: UnmergeRangeRequest[] = []
  const readVisibleProjectionCalls: VisibleProjectionRequest[] = []
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      readVisibleProjectionCalls.push(request)
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        window: { ...request.window },
        cells: [
          {
            row: 0,
            col: 0,
            displayValue: 'A1',
            valueKind: 'string',
            format: { bold: true },
          },
        ],
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async setFormatRange(request) {
      setFormatRangeCalls.push(request)
      return {
        kind: request.kind,
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: { ...request.range },
      }
    },
    async mergeRange(request) {
      mergeRangeCalls.push(request)
      return {
        kind: request.kind,
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: { ...request.range },
      }
    },
    async unmergeRange(request) {
      unmergeRangeCalls.push(request)
      return {
        kind: request.kind,
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 3,
        affectedRange: { ...request.range },
      }
    },
    async setFilterSort(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 4,
      }
    },
  }

  return {
    backend,
    setFormatRangeCalls,
    mergeRangeCalls,
    unmergeRangeCalls,
    readVisibleProjectionCalls,
  }
}

function seedReadyProjection(store: ReturnType<typeof createStore>) {
  seedVisibleProjection(store, {
    kind: 'visible-window',
    sheetId: 'sheet-1',
    requestId: 1,
    window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
    cells: [
      {
        row: 0,
        col: 0,
        displayValue: 'A1',
        valueKind: 'string',
        format: {},
      },
    ],
  })
}

function seedVisibleProjection(
  store: ReturnType<typeof createStore>,
  result: VisibleProjectionResult,
) {
  const begin = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: result.sheetId,
    reason: 'test',
    window: result.window,
  })
  expect(begin.status).toBe('started')
  if (begin.status !== 'started') throw new Error('projection seed lane did not start')

  const resolved = store.setter(resolveProjectionAtom, {
    request: begin.request,
    result: { ...result, requestId: begin.request.requestId },
  })
  expect(resolved.status).toBe('accepted')
}

function getButtons(container: HTMLElement) {
  return {
    bold: container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    italic: container.querySelector('[data-testid="toolbar-btn-italic"]') as HTMLButtonElement,
    underline: container.querySelector(
      '[data-testid="toolbar-btn-underline"]',
    ) as HTMLButtonElement,
    fillColor: container.querySelector(
      '[data-testid="toolbar-btn-fill-color"]',
    ) as HTMLButtonElement,
    textColor: container.querySelector(
      '[data-testid="toolbar-btn-text-color"]',
    ) as HTMLButtonElement,
    numberFormat: container.querySelector(
      '[data-testid="toolbar-btn-number-format"]',
    ) as HTMLButtonElement,
    percent: container.querySelector(
      '[data-testid="toolbar-btn-percent-format"]',
    ) as HTMLButtonElement,
    // Wave 5 merge surface is a single dropdown — the top-level button always
    // opens the menu; the dropdown's four items (merge-center, across-rows,
    // across-cols, unmerge) carry the per-preset disabled state.
    merge: container.querySelector('[data-testid="toolbar-btn-merge"]') as HTMLButtonElement,
    mergeCenterItem: () =>
      container.querySelector('[data-testid="toolbar-merge-center"]') as HTMLButtonElement | null,
    unmergeItem: () =>
      container.querySelector('[data-testid="toolbar-merge-unmerge"]') as HTMLButtonElement | null,
    painter: container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement,
    findReplace: container.querySelector(
      '[data-testid="toolbar-btn-find-replace"]',
    ) as HTMLButtonElement,
  }
}

describe('vNext SpreadsheetToolbar', () => {
  it('enables format buttons for selected cell and range', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
    // createFakeBackend omits mergeRange so the dropdown anchor button is
    // disabled — there is no merge surface to expose.
    expect(buttons.merge.disabled).toBe(true)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 }, extend: true })

    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
    // Still no mergeRange port on the fake backend.
    expect(buttons.merge.disabled).toBe(true)
    // Find/Replace is not an actionable entrypoint without searchRange.
    expect(buttons.findReplace.disabled).toBe(true)
  })

  it('opens Find from the toolbar with a search-only backend', async () => {
    const store = createStore()
    const backend: SpreadsheetBackend = {
      ...createFakeBackend(),
      async searchRange(request) {
        return {
          kind: 'search-range',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: request.revision,
          matches: [],
          pageStart: request.pageStart,
          totalCount: 0,
        }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const button = getButtons(container).findReplace
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(button.getAttribute('data-capability')).toBe('find-only')
    fireEvent.click(button)
    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  it('disables formatting commands while editing is drafting', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=1+1',
      source: 'formula-bar',
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(true)
    expect(buttons.italic.disabled).toBe(true)
    expect(buttons.fillColor.disabled).toBe(true)
    expect(buttons.textColor.disabled).toBe(true)
    expect(buttons.numberFormat.disabled).toBe(true)
    // Drafting also gates the merge dropdown's anchor button.
    expect(buttons.merge.disabled).toBe(true)
  })

  it('dispatches toolbar.format.command intent when bold is clicked', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    )

    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'sheet-1',
      selectionKind: 'cell',
      command: 'bold',
      value: null,
    })
  })

  it('applies bold through backend setFormatRange and refreshes the visible projection', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls, readVisibleProjectionCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'A1',
          valueKind: 'string',
          format: {},
        },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    )

    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
      expect(readVisibleProjectionCalls).toHaveLength(1)
    })
    expect(setFormatRangeCalls[0]).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: expect.any(Number),
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    expect(readVisibleProjectionCalls[0]).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      reason: 'toolbar',
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
    })
    expect(store.getter(spreadsheetProjectionSnapshotAtom).result?.cells[0]?.format).toEqual({
      bold: true,
    })
  })

  it('reconciles a dispatched transport rejection without resending the mutation', async () => {
    const store = createStore()
    const recording = createRecordingBackend()
    const requests: SetFormatRangeRequest[] = []
    const backend: SpreadsheetBackend = {
      ...recording.backend,
      async setFormatRange(request) {
        requests.push(request)
        throw new Error('transport rejected after dispatch')
      },
    }

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedReadyProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).bold)

    await waitFor(() => {
      expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('outcome-unknown')
      expect(
        container.querySelector('[data-testid="toolbar-mutation-refresh-retry"]'),
      ).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="toolbar-mutation-retry"]')).toBeNull()
    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)

    fireEvent.click(
      container.querySelector(
        '[data-testid="toolbar-mutation-refresh-retry"]',
      ) as HTMLButtonElement,
    )

    await waitFor(() => {
      expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
        status: 'outcome-unknown',
        canRetryRefresh: false,
      })
      expect(recording.readVisibleProjectionCalls).toHaveLength(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(container.querySelector('[data-testid="toolbar-mutation-refresh-retry"]')).toBeNull()
    })
    expect(requests).toHaveLength(1)
  })

  it('offers reconcile-only recovery after an ambiguous ACK without resending the mutation', async () => {
    const store = createStore()
    const recording = createRecordingBackend()
    const requests: SetFormatRangeRequest[] = []
    const backend: SpreadsheetBackend = {
      ...recording.backend,
      async setFormatRange(request) {
        requests.push(request)
        return {
          kind: request.kind,
          sheetId: request.sheetId,
          requestId: 999_999,
          revision: 2,
          affectedRange: { ...request.range },
        }
      },
    }

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedReadyProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).bold)

    await waitFor(() => {
      expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('outcome-unknown')
      expect(
        container.querySelector('[data-testid="toolbar-mutation-refresh-retry"]'),
      ).not.toBeNull()
    })
    expect(requests).toHaveLength(1)
    expect(recording.readVisibleProjectionCalls).toHaveLength(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)

    fireEvent.click(
      container.querySelector(
        '[data-testid="toolbar-mutation-refresh-retry"]',
      ) as HTMLButtonElement,
    )

    await waitFor(() => {
      expect(store.getter(toolbarMutationLifecycleAtom)).toMatchObject({
        status: 'outcome-unknown',
        canRetryRefresh: false,
      })
      expect(recording.readVisibleProjectionCalls).toHaveLength(1)
      expect(container.querySelector('[data-testid="toolbar-mutation-refresh-retry"]')).toBeNull()
    })
    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  it('maps toolbar number formats from sorted visible rows to source rows', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 5, col: 4 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 8, colStart: 0, colEnd: 5 },
      cells: [
        {
          row: 5,
          col: 4,
          originalRow: 1,
          displayValue: '300',
          valueKind: 'number',
          format: {},
        },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).percent)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0]).toEqual({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      requestId: expect.any(Number),
      range: { rowStart: 1, rowEnd: 1, colStart: 4, colEnd: 4 },
      format: { numberFormat: { kind: 'percent', digits: 0 } },
    })
  })

  it('fails closed on a format command when a filtered row cannot be mapped', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 6, col: 4 } })
    // The remap is active (originalRow facts exist) but display row 6 carries
    // no fact — the mutation gateway must block instead of guessing a source
    // row (the old lenient helper silently fell back to the display row).
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 8, colStart: 0, colEnd: 5 },
      cells: [
        {
          row: 5,
          col: 4,
          originalRow: 1,
          displayValue: '300',
          valueKind: 'number',
          format: {},
        },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).percent)

    await waitFor(() =>
      expect(
        store.getter(diagnosticsAtom).items.some((item) => item.code === 'MUTATION_UNMAPPED_ROW'),
      ).toBe(true),
    )
    expect(setFormatRangeCalls).toHaveLength(0)
    expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('ready')
  })

  it('renders the Custom row in the number-format dropdown without raw i18n keys', async () => {
    // Wave 5 dropped the per-kind submenu (currency / date-time / number) and
    // routes the Custom row to the full Format Cells dialog. The remaining
    // contract here is that the Custom row renders with a localised label and
    // no raw i18n keys in either supported locale.
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale)
      const store = createStore()
      const backend = createFakeBackend()

      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
      store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetToolbar />
        </SpreadsheetUiProvider>
      ))

      fireEvent.click(getButtons(container).numberFormat)
      const dropdown = document.body.querySelector('[data-testid="number-format-dropdown"]')
      expect(dropdown).not.toBeNull()
      expect(dropdown?.textContent ?? '').not.toMatch(RAW_I18N_KEY_RE)

      const custom = document.body.querySelector(
        '[data-testid="number-format-item-Custom"]',
      ) as HTMLButtonElement | null
      expect(custom).not.toBeNull()
      expect((custom?.textContent ?? '').trim()).not.toBe('')
      expect(custom?.textContent ?? '').not.toMatch(RAW_I18N_KEY_RE)

      // The dropdown no longer renders a nested submenu — the Custom row is a
      // plain item with no aria-haspopup and no submenu siblings.
      expect(custom?.getAttribute('aria-haspopup')).toBeNull()
      expect(document.body.querySelector('[data-testid="number-format-custom-submenu"]')).toBeNull()
      cleanup()
    }
  })

  it('uses the Core active surface as the single authority for all dropdowns and palettes', async () => {
    const store = createStore()
    const { backend } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const surfaceCases = [
      {
        buttonTestId: 'toolbar-btn-h-align',
        surface: { kind: 'dropdown', id: 'alignment' },
        panelTestId: 'toolbar-h-align-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-v-align',
        surface: { kind: 'dropdown', id: 'vertical-alignment' },
        panelTestId: 'toolbar-v-align-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-number-format',
        surface: { kind: 'dropdown', id: 'number-format' },
        panelTestId: 'number-format-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-borders',
        surface: { kind: 'dropdown', id: 'border' },
        panelTestId: 'toolbar-borders-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-merge',
        surface: { kind: 'dropdown', id: 'merge' },
        panelTestId: 'toolbar-merge-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-font-family',
        surface: { kind: 'dropdown', id: 'font-family' },
        panelTestId: 'toolbar-font-family-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-font-size',
        surface: { kind: 'dropdown', id: 'font-size' },
        panelTestId: 'toolbar-font-size-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-rotation',
        surface: { kind: 'dropdown', id: 'rotation' },
        panelTestId: 'toolbar-rotation-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-sort',
        surface: { kind: 'dropdown', id: 'sort' },
        panelTestId: 'toolbar-sort-dropdown',
      },
      {
        buttonTestId: 'toolbar-btn-text-color',
        surface: { kind: 'palette', id: 'text-color' },
        panelTestId: 'toolbar-color-popover',
        paletteMode: 'text',
      },
      {
        buttonTestId: 'toolbar-btn-fill-color',
        surface: { kind: 'palette', id: 'fill-color' },
        panelTestId: 'toolbar-color-popover',
        paletteMode: 'fill',
      },
    ] as const

    const buttons = surfaceCases.map(({ buttonTestId }) => {
      const button = container.querySelector(
        `[data-testid="${buttonTestId}"]`,
      ) as HTMLButtonElement | null
      expect(button).not.toBeNull()
      return button!
    })

    const sortButton = buttons[surfaceCases.findIndex(({ surface }) => surface.id === 'sort')]
    await waitFor(() => expect(sortButton.disabled).toBe(false))

    for (const [index, surfaceCase] of surfaceCases.entries()) {
      const button = buttons[index]
      expect(button.disabled).toBe(false)
      fireEvent.click(button)

      await waitFor(() => {
        expect(store.getter(toolbarActiveSurfaceAtom)).toEqual(surfaceCase.surface)
        expect(
          document.body.querySelector(`[data-testid="${surfaceCase.panelTestId}"]`),
        ).not.toBeNull()
      })

      for (const [buttonIndex, candidate] of buttons.entries()) {
        expect(candidate.getAttribute('aria-expanded')).toBe(
          buttonIndex === index ? 'true' : 'false',
        )
      }

      const palette = document.body.querySelector(
        '[data-testid="toolbar-color-popover"]',
      ) as HTMLElement | null
      if ('paletteMode' in surfaceCase) {
        expect(palette?.dataset.mode).toBe(surfaceCase.paletteMode)
      } else {
        expect(palette).toBeNull()
      }
    }

    fireEvent.click(buttons.at(-1)!)
    await waitFor(() => {
      expect(store.getter(toolbarActiveSurfaceAtom)).toBeNull()
      expect(document.body.querySelector('[data-testid="toolbar-color-popover"]')).toBeNull()
    })
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('opens the Format Cells dialog from the Custom number-format row', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).numberFormat)
    const custom = document.body.querySelector(
      '[data-testid="number-format-item-Custom"]',
    ) as HTMLButtonElement | null
    expect(custom).not.toBeNull()
    fireEvent.click(custom!)

    await waitFor(() => {
      const state = store.getter(formatCellsEditorAtom)
      if (state.status !== 'open') throw new Error('Format Cells dialog did not open')
      // The Custom row routes to the Number tab on first open so users land
      // where the dropdown left them.
      expect(state.activeTab).toBe('number')
      expect(state.range).toEqual({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })
    })

    // The lightweight per-kind dialog must NOT open along the new path.
    const lightweight = store.getter(numberFormatDialogAtom)
    expect(lightweight.status).toBe('closed')
  })

  it('calls backend merge and unmerge ports for the current selection range', async () => {
    const store = createStore()
    const { backend, mergeRangeCalls, unmergeRangeCalls, readVisibleProjectionCalls } =
      createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 1 }, extend: true })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    let buttons = getButtons(container)
    expect(buttons.merge.disabled).toBe(false)

    // Open the dropdown and click 合并居中. The dropdown body lives inside the
    // same toolbar root, so a single fireEvent click on the anchor toggles it
    // open, then the menu item triggers the merge.
    fireEvent.click(buttons.merge)
    const mergeCenterItem = buttons.mergeCenterItem()
    expect(mergeCenterItem).not.toBeNull()
    expect(mergeCenterItem!.disabled).toBe(false)
    expect(buttons.unmergeItem()?.disabled).toBe(true)
    fireEvent.click(mergeCenterItem!)
    await waitFor(() => {
      expect(mergeRangeCalls).toHaveLength(1)
    })
    expect(mergeRangeCalls[0]).toEqual({
      kind: 'merge-range',
      sheetId: 'sheet-1',
      requestId: expect.any(Number),
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    await waitFor(() => {
      expect(readVisibleProjectionCalls).toHaveLength(1)
      expect(store.getter(toolbarMutationLifecycleAtom).status).toBe('ready')
    })

    // The fake backend doesn't mutate the projection. Inject a merge anchor at
    // A1 covering A1:B2 so the unmerge button becomes enabled, then click it.
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 2,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: '',
          mergedSpan: { rows: 2, cols: 2 },
        },
      ],
    })

    buttons = getButtons(container)
    fireEvent.click(buttons.merge)
    const unmergeItem = buttons.unmergeItem()
    expect(unmergeItem).not.toBeNull()
    expect(unmergeItem!.disabled).toBe(false)
    fireEvent.click(unmergeItem!)
    await waitFor(() => {
      expect(unmergeRangeCalls).toHaveLength(1)
    })
    expect(unmergeRangeCalls[0]).toEqual({
      kind: 'unmerge-range',
      sheetId: 'sheet-1',
      requestId: expect.any(Number),
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    expect(readVisibleProjectionCalls).toHaveLength(2)
  })

  it('disables format buttons under Excel sheet editing protection for a locked cell', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(true)
    expect(buttons.italic.disabled).toBe(true)
    expect(buttons.fillColor.disabled).toBe(true)
    expect(buttons.textColor.disabled).toBe(true)
    expect(buttons.numberFormat.disabled).toBe(true)
    // Excel editing protection disables the merge dropdown anchor button.
    expect(buttons.merge.disabled).toBe(true)
  })

  it('renders Comment and Decimal-adjust toolbar buttons', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    // The toolbar surfaces a Comment button alongside the existing history
    // group, plus a pair of Increase / Decrease Decimal buttons at the end
    // of the number-format group. Print Preview was removed for the Wave 5
    // Univer-parity layout (still reachable via menus); the explicit
    // negative check pins that contract.
    expect(container.querySelector('[data-testid="toolbar-btn-print-preview"]')).toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-comment"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-inc-decimal"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="toolbar-btn-dec-decimal"]')).not.toBeNull()
  })

  it('toggles bold off when the active cell is already bold', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'A1',
          valueKind: 'string',
          format: { bold: true },
        },
      ],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(buttons.bold)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ bold: false })
  })

  it('clicking Italic toggles italic on the active cell and pushes a history entry', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: {} }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getButtons(container).italic)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ italic: true })
    await waitFor(() => expect(store.getter(historyStackAtom).entries.length).toBe(1))
    expect(store.getter(historyStackAtom).entries[0].kind).toBe('format.set')
  })

  it('clicking Underline toggles underline on the active cell', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: {} }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.underline).not.toBeNull()
    expect(buttons.underline.disabled).toBe(false)
    fireEvent.click(buttons.underline)

    await waitFor(() => expect(setFormatRangeCalls).toHaveLength(1))
    expect(setFormatRangeCalls[0].format).toEqual({ underline: true })
  })

  it('clicking Merge with a multi-cell selection records a range.merge history entry', async () => {
    const store = createStore()
    const { backend, mergeRangeCalls } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 1 }, extend: true })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    fireEvent.click(buttons.merge)
    const mergeCenterItem = buttons.mergeCenterItem()
    expect(mergeCenterItem).not.toBeNull()
    fireEvent.click(mergeCenterItem!)
    await waitFor(() => expect(mergeRangeCalls).toHaveLength(1))
    await waitFor(() => expect(store.getter(historyStackAtom).entries.length).toBe(1))
    expect(store.getter(historyStackAtom).entries[0].kind).toBe('range.merge')
  })

  it('single click on Format Painter arms the painter after the dblclick window', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const { backend } = createRecordingBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    seedVisibleProjection(store, {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [{ row: 0, col: 0, displayValue: '', valueKind: 'string', format: { bold: true } }],
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    fireEvent.click(getButtons(container).painter)
    jest.advanceTimersByTime(250)
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    jest.useRealTimers()
  })
})
