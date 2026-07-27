/** @jsxImportSource solid-js */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
  allTablesAtom,
  commentSessionAtom,
  createTableSupportedAtom,
  filterSortStateAtom,
  getFilterHiddenRowsForSheet,
  findReplaceOpenAtom,
  lastCreatedTableNameAtom,
  lastToggledTableTotalsAtom,
  toggleTableTotalsSupportedAtom,
  tableDiagnosticAtom,
  helpOverlayAtom,
  hideColumnsAtom,
  hideRowsAtom,
  historyStackAtom,
  initializeSheetTabsAtom,
  pushHistoryAtom,
  MENU_BAR_ITEMS,
  openTopMenuAtom,
  printPreviewOpenAtom,
  protectionUnlockStateAtom,
  removeDuplicatesCapabilityAtom,
  removeDuplicatesErrorAtom,
  removeDuplicatesLifecycleAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesReadRequestIdAtom,
  removeDuplicatesSessionAtom,
  selectionAtom,
  selectionLockedAtom,
  setFilterSortAtom,
  setWorkspaceActiveSheetAtom,
  sheetProtectionAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  openTextToColumnsAtom,
  structureOperationLifecycleAtom,
  textToColumnsEntrypointProjectionAtom,
  textToColumnsOpenAtom,
  textToColumnsSessionAtom,
  textToColumnsSourceAtom,
  topMenuOpenAtom,
  validationRuleEditorAtom,
  viewportShowFormulaBarAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  viewportFreezeAtom,
  viewportFilterHiddenAtom,
  viewportHiddenAtom,
  workspaceSessionAtom,
  type AddSheetRequest,
  type CreateTableRequest,
  type CreateTableResult,
  type DisplayCell,
  type FillRangeRequest,
  type HideColumnsRequest,
  type ImportCellsRequest,
  type ListTablesResult,
  type SpreadsheetTableDescriptor,
  type HideRowsRequest,
  type InsertColumnsRequest,
  type InsertRowsRequest,
  type RangeProjectionRequest,
  type RangeProjectionResult,
  type RemoveDuplicatesControllerPort,
  type SetFilterSortRequest,
  type SetSheetProtectionRequest,
  type SetTableTotalsRowRequest,
  type TableMutationResult,
  type SortRangeRequest,
  type SpreadsheetBackend,
  type SpreadsheetSheetMetadata,
  type UnhideColumnsRequest,
  type UnhideRowsRequest,
  type VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import { createWorkerWorkbookSpreadsheetBackend } from '../src-vnext/adapter'
import type { WorkerLike } from '../src-vnext/adapter'
import { installWorkerRuntimeTs, type WorkerContext } from '../src-vnext/adapter/worker-runtime-ts'
import { setLocale } from '../src/i18n'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

/**
 * Duplex in-process "worker" wired to the real TS runtime (same shape as
 * vnext-worker-ts-failclosed.test.ts) so the fail-closed capability
 * handshake runs end to end without spawning a Worker.
 */
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

/**
 * Legacy-shaped protocol worker: answers `describeCapabilities` (and any
 * other unknown command) with UNKNOWN_COMMAND exactly like the WASM
 * runtime, so the adapter keeps the full-trust contract.
 */
function createLegacyProtocolWorker(): WorkerLike {
  const listeners: Array<(e: MessageEvent) => void> = []
  const respond = (payload: unknown) => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener({ data: payload } as MessageEvent)
    })
  }
  return {
    postMessage(msg: unknown) {
      const { id, cmd } = msg as { id: number; cmd: string }
      if (cmd === 'initWorkbook' || cmd === 'sheetList') {
        respond({ id, ok: true, result: [{ idx: 0, name: 'Sheet1' }] })
        return
      }
      respond({
        id,
        ok: false,
        error: { code: 'UNKNOWN_COMMAND', message: `unknown command: ${cmd}` },
      })
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      listeners.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    terminate() {},
  }
}

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

function setupSelection(store: ReturnType<typeof createStore>) {
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId: 'sheet-1',
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  })
}

function setupHiddenSelection(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    anchor: { row: 2, col: 3 },
    focus: { row: 4, col: 5 },
  })
}

async function activateFormatMenuItem(container: HTMLElement, itemId: string) {
  fireEvent.click(container.querySelector('[data-testid="menu-bar-button-format"]')!)
  await waitFor(() => {
    expect(container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)).not.toBeNull()
  })
  fireEvent.click(container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)!)
}

function matchingTextToColumnsProjection(
  request: RangeProjectionRequest,
  cells: DisplayCell[] = [
    {
      row: request.range.rowStart,
      col: request.range.colStart,
      displayValue: 'alpha,beta',
    },
  ],
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: request.sheetId,
    range: { ...request.range },
    requestId: request.requestId,
    revision: 1,
    cells,
  }
}

function matchingRemoveDuplicatesProjection(
  request: RangeProjectionRequest,
  cells: DisplayCell[] = [
    {
      row: request.range.rowStart,
      col: request.range.colStart,
      displayValue: 'alpha',
    },
  ],
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: request.sheetId,
    range: { ...request.range },
    requestId: request.requestId,
    revision: 7,
    cells,
  }
}

function setupRemoveDuplicatesSelection(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    anchor: { row: 0, col: 0 },
    focus: { row: 4, col: 1 },
  })
}

type RemoveDuplicatesBackend = SpreadsheetBackend &
  Pick<RemoveDuplicatesControllerPort, 'removeRowsExact'>

function addRemoveDuplicatesExactCapability(backend: SpreadsheetBackend): RemoveDuplicatesBackend {
  return {
    ...backend,
    async removeRowsExact() {
      throw new Error('not used')
    },
  }
}

async function activateRemoveDuplicatesMenuItem(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
  await waitFor(() => {
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.removeDuplicates"]'),
    ).not.toBeNull()
  })
  fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.removeDuplicates"]')!)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SpreadsheetMenuBar', () => {
  it('renders the seven top-level menu buttons in the expected order', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    const buttons = container.querySelectorAll('[data-testid^="menu-bar-button-"]')
    expect(buttons).toHaveLength(7)
    const ids = MENU_BAR_ITEMS.map((m) => m.id)
    expect(ids).toEqual(['file', 'edit', 'insert', 'format', 'data', 'view', 'help'])
  })

  it('mounts the shared menu and dialogs as thin UI in both real-worker demos', () => {
    for (const [file, testIdPrefix] of [
      ['VNextWorkerDemo.tsx', 'vnext-worker'],
      ['VNextWorkerTsDemo.tsx', 'vnext-worker-ts'],
    ] as const) {
      const source = readFileSync(join(process.cwd(), 'solid/excel/src-vnext/demos', file), 'utf8')

      expect(source).toContain(`<SpreadsheetMenuBar data-testid="${testIdPrefix}-menu-bar" />`)
      expect(source).toContain(`<SpreadsheetGoToDialog data-testid="${testIdPrefix}-go-to" />`)
      expect(source).toContain(
        `<SpreadsheetTextToColumnsDialog data-testid="${testIdPrefix}-text-to-columns" />`,
      )
      expect(source).not.toContain('openGoToAtom')
      expect(source).not.toContain('runTextToColumnsEntrypointAtom')
      expect(source).not.toContain('CustomEvent')
    }
  })

  it('clicking File renders the File dropdown', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="menu-bar-dropdown-file"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(container.querySelector('[data-testid="menu-bar-dropdown-file"]')).not.toBeNull()
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })
  })

  it('Edit > Undo fires undoHistoryAtom when history has an entry and the backend supports undo', async () => {
    const store = createStore()
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async undoTransaction({ transactionId, requestId }) {
        return { transactionId, requestId, revision: 2 }
      },
    }

    store.setter(pushHistoryAtom, {
      transactionId: 'tx1',
      kind: 'cell.set-input',
      sheetId: 'sheet-1',
      projectionRevision: 1,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.undo"]')!)

    await waitFor(() => {
      const state = store.getter(historyStackAtom)
      expect(state.cursor).toBe(0)
      // dispatchUndo resolves inFlight once the backend acks.
      expect(state.inFlight).toBe(false)
    })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Edit > Undo is a no-op when the backend lacks undoTransaction (history entry preserved, not silently consumed)', () => {
    // Regression for HIGH #6 — previously dispatchUndo would pop the entry
    // and "resolve" it silently when undoTransaction was missing, leaving
    // the workbook mutated but undo lying about its outcome.
    const store = createStore()
    const backend = createBaseBackend()

    store.setter(pushHistoryAtom, {
      transactionId: 'tx1',
      kind: 'cell.set-input',
      sheetId: 'sheet-1',
      projectionRevision: 1,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.undo"]')!)

    const state = store.getter(historyStackAtom)
    // Entry stays on the stack; cursor does NOT decrement.
    expect(state.cursor).toBe(1)
    expect(state.entries).toHaveLength(1)
    expect(state.inFlight).toBe(false)
  })

  it.each([
    {
      itemId: 'edit.fillDown',
      direction: 'down' as const,
      sourceRange: { rowStart: 2, rowEnd: 2, colStart: 3, colEnd: 5 },
      affectedRange: { rowStart: 3, rowEnd: 4, colStart: 3, colEnd: 5 },
    },
    {
      itemId: 'edit.fillUp',
      direction: 'up' as const,
      sourceRange: { rowStart: 4, rowEnd: 4, colStart: 3, colEnd: 5 },
      affectedRange: { rowStart: 2, rowEnd: 3, colStart: 3, colEnd: 5 },
    },
    {
      itemId: 'edit.fillRight',
      direction: 'right' as const,
      sourceRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
      affectedRange: { rowStart: 2, rowEnd: 4, colStart: 4, colEnd: 5 },
    },
    {
      itemId: 'edit.fillLeft',
      direction: 'left' as const,
      sourceRange: { rowStart: 2, rowEnd: 4, colStart: 5, colEnd: 5 },
      affectedRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 4 },
    },
  ])(
    'Edit > $itemId delegates one copy-only compact fill through the $direction source edge',
    async ({ itemId, direction, sourceRange, affectedRange }) => {
      const store = createStore()
      const fillRequests: FillRangeRequest[] = []
      const visibleRequests: VisibleProjectionRequest[] = []
      let rangeReads = 0
      let fallbackMutations = 0
      const backend: SpreadsheetBackend = {
        ...createBaseBackend(),
        async readVisibleProjection(request) {
          visibleRequests.push(request)
          return {
            kind: 'visible-window',
            sheetId: request.sheetId,
            window: { ...request.window },
            requestId: request.requestId,
            revision: 12,
            cells: [],
          }
        },
        async readRangeProjection() {
          rangeReads += 1
          throw new Error('compact fill-command must not read the source range')
        },
        async fillSeries() {
          fallbackMutations += 1
          throw new Error('copy-only fill-command must not detect or execute a series')
        },
        async fillRange(request) {
          fillRequests.push(request)
          return {
            sheetId: request.sheetId,
            revision: 11,
            affectedRange: { ...affectedRange },
            applied: true,
            historyTransactionCount: 1,
            historyDisposition: 'undoable',
          }
        },
        async importCells() {
          fallbackMutations += 1
          throw new Error('compact fillRange must win over importCells')
        },
        async setCellInput() {
          fallbackMutations += 1
          throw new Error('compact fillRange must win over setCellInput')
        },
      }
      const selectionRange = { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 5 }
      const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
      store.setter(selectionAtom, {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: selectionRange.rowEnd, col: selectionRange.colEnd },
        focus: { row: selectionRange.rowStart, col: selectionRange.colStart },
      })
      seedReadyVisibleProjection(store, {
        status: 'ready',
        request: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window,
          requestId: 20,
        },
        result: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window,
          requestId: 20,
          revision: 10,
          cells: [],
        },
      })

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))

      fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
      fireEvent.click(container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)!)

      await waitFor(() => {
        expect(fillRequests).toHaveLength(1)
        expect(visibleRequests).toHaveLength(1)
      })
      expect(fillRequests).toEqual([
        {
          kind: 'fill-range',
          sheetId: 'sheet-1',
          sourceRange,
          targetRange: selectionRange,
          direction,
        },
      ])
      expect(fillRequests[0]).not.toHaveProperty('copyOnly')
      expect({ rangeReads, fallbackMutations }).toEqual({
        rangeReads: 0,
        fallbackMutations: 0,
      })
      expect(visibleRequests[0]).toMatchObject({
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        reason: 'toolbar',
      })
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
        kind: 'range.fill',
        sheetId: 'sheet-1',
        affectedRange,
      })
      expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    },
  )

  it('Edit > Fill Down uses the toolbar range lane and import fallback when fillRange is absent', async () => {
    const store = createStore()
    const rangeRequests: RangeProjectionRequest[] = []
    const importRequests: ImportCellsRequest[] = []
    const visibleRequests: VisibleProjectionRequest[] = []
    const sourceRange = { rowStart: 2, rowEnd: 2, colStart: 3, colEnd: 3 }
    const affectedRange = { rowStart: 3, rowEnd: 3, colStart: 3, colEnd: 3 }
    const selectionRange = { rowStart: 2, rowEnd: 3, colStart: 3, colEnd: 3 }
    const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readVisibleProjection(request) {
        visibleRequests.push(request)
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: { ...request.window },
          requestId: request.requestId,
          revision: 12,
          cells: [],
        }
      },
      async readRangeProjection(request) {
        rangeRequests.push(request)
        return {
          kind: 'range',
          sheetId: request.sheetId,
          range: { ...request.range },
          requestId: request.requestId,
          revision: 10,
          cells: [
            {
              row: sourceRange.rowStart,
              col: sourceRange.colStart,
              displayValue: 'seed',
              valueKind: 'string',
            },
          ],
        }
      },
      async importCells(request) {
        importRequests.push(request)
        return {
          sheetId: request.sheetId,
          revision: 11,
          affectedRange: { ...affectedRange },
        }
      },
      async setCellInput() {
        throw new Error('importCells must win over setCellInput')
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: selectionRange.rowEnd, col: selectionRange.colEnd },
      focus: { row: selectionRange.rowStart, col: selectionRange.colStart },
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 20,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 20,
        revision: 10,
        cells: [],
      },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.fillDown"]')!)

    await waitFor(() => {
      expect(importRequests).toHaveLength(1)
      expect(visibleRequests).toHaveLength(1)
    })
    expect(rangeRequests).toHaveLength(1)
    expect(rangeRequests[0]).toMatchObject({
      kind: 'range',
      sheetId: 'sheet-1',
      range: sourceRange,
      reason: 'toolbar',
    })
    expect(importRequests).toEqual([
      {
        kind: 'import-cells',
        sheetId: 'sheet-1',
        range: affectedRange,
        cells: [{ row: 3, col: 3, input: 'seed' }],
      },
    ])
    expect(visibleRequests[0]).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window,
      reason: 'toolbar',
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Edit > Fill Down is a no-op for a single-cell selection', async () => {
    const store = createStore()
    let rangeReads = 0
    let visibleReads = 0
    let mutations = 0
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readVisibleProjection(request) {
        visibleReads += 1
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: { ...request.window },
          requestId: request.requestId,
          revision: 12,
          cells: [],
        }
      },
      async readRangeProjection(request) {
        rangeReads += 1
        return {
          kind: 'range',
          sheetId: request.sheetId,
          range: { ...request.range },
          requestId: request.requestId,
          revision: 10,
          cells: [],
        }
      },
      async fillSeries() {
        mutations += 1
        throw new Error('single-cell fill-command must not mutate')
      },
      async fillRange() {
        mutations += 1
        throw new Error('single-cell fill-command must not mutate')
      },
      async importCells() {
        mutations += 1
        throw new Error('single-cell fill-command must not mutate')
      },
      async setCellInput() {
        mutations += 1
        throw new Error('single-cell fill-command must not mutate')
      },
    }
    const cell = { row: 2, col: 3 }
    const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: cell,
      focus: cell,
    })
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 20,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 20,
        revision: 10,
        cells: [],
      },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.fillDown"]')!)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect({ mutations, rangeReads, visibleReads }).toEqual({
      mutations: 0,
      rangeReads: 0,
      visibleReads: 0,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Edit > Find opens the find/replace dialog', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceOpenAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.find"]')!)
    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  it('keeps File > Print Preview visible by default and toggles printPreviewOpenAtom', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(printPreviewOpenAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(
      container.querySelector('[data-testid="menu-bar-item-file.printPreview"]'),
    ).not.toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-file.printPreview"]')!)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)
  })

  it('hides a host-gated File item without hiding its siblings or leaving separator artifacts', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar hiddenItemIds={['file.printPreview']} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)

    const dropdown = container.querySelector('[data-testid="menu-bar-dropdown-file"]')!
    expect(dropdown.querySelector('[data-testid="menu-bar-item-file.printPreview"]')).toBeNull()
    for (const itemId of ['file.new', 'file.open', 'file.save', 'file.close']) {
      expect(dropdown.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)).not.toBeNull()
    }

    const entries = Array.from(dropdown.children)
    const roles = entries.map((entry) => entry.getAttribute('role'))
    expect(roles[0]).not.toBe('separator')
    expect(roles[roles.length - 1]).not.toBe('separator')
    expect(roles.filter((role) => role === 'separator')).toHaveLength(1)
    for (let index = 1; index < roles.length; index += 1) {
      expect(roles[index - 1] === 'separator' && roles[index] === 'separator').toBe(false)
    }
    expect(store.getter(printPreviewOpenAtom)).toBe(false)
  })

  it.each([
    {
      edge: 'leading',
      hiddenItemIds: ['file.new', 'file.open', 'file.save', 'file.printPreview'],
      visibleItemIds: ['file.close'],
    },
    {
      edge: 'trailing',
      hiddenItemIds: ['file.printPreview', 'file.close'],
      visibleItemIds: ['file.new', 'file.open', 'file.save'],
    },
  ])('removes $edge separators after host filtering', ({ hiddenItemIds, visibleItemIds }) => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar hiddenItemIds={hiddenItemIds} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    const dropdown = container.querySelector('[data-testid="menu-bar-dropdown-file"]')!
    const visibleItems = Array.from(
      dropdown.querySelectorAll('[data-testid^="menu-bar-item-"]'),
    ).map((item) => item.getAttribute('data-testid')?.replace('menu-bar-item-', ''))

    expect(visibleItems).toEqual(visibleItemIds)
    expect(dropdown.querySelector('[role="separator"]')).toBeNull()
  })

  it('Esc closes an open menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('click outside the menubar closes the open menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const outside = document.createElement('div')
    outside.setAttribute('data-testid', 'outside-target')
    document.body.appendChild(outside)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')

    fireEvent.mouseDown(outside)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    outside.remove()
  })

  it('placeholder items are disabled and do not dispatch', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    const fileNew = container.querySelector(
      '[data-testid="menu-bar-item-file.new"]',
    ) as HTMLButtonElement | null
    expect(fileNew).not.toBeNull()
    expect(fileNew!.disabled).toBe(true)
    // The title contains the placeholder message (translated copy) — assert
    // it is set rather than locking down the wording.
    expect((fileNew!.getAttribute('title') ?? '').length).toBeGreaterThan(0)

    fireEvent.click(fileNew!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')
  })

  it('Alt+F (mnemonic) opens the File menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(topMenuOpenAtom).kind).toBe('idle')
    fireEvent.keyDown(document, { key: 'f', altKey: true })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })
  })

  it('hovering Edit while File is open switches focus to Edit (Excel-style)', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })

    fireEvent.mouseEnter(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'edit' })
  })

  it('openTopMenuAtom / topMenuOpenAtom integration: setter opens, closeTopMenuAtom returns to idle', () => {
    const store = createStore()

    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    store.setter(openTopMenuAtom, 'view')
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'view' })
  })

  it('Insert > Name Manager fires openNameManagerAtom and closes menu', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-insert.nameManager"]')!)

    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it.each([
    ['insert.rowAbove', 'row', 2, 'row.insert'],
    ['insert.rowBelow', 'row', 5, 'row.insert'],
    ['insert.colLeft', 'column', 3, 'column.insert'],
    ['insert.colRight', 'column', 6, 'column.insert'],
  ] as Array<
    [
      itemId: string,
      axis: 'row' | 'column',
      expectedIndex: number,
      expectedOperation: 'row.insert' | 'column.insert',
    ]
  >)(
    'Insert > %s delegates the selected boundary to the Core structural lifecycle',
    async (itemId, axis, expectedIndex, expectedOperation) => {
      const store = createStore()
      const insertRowsRequests: InsertRowsRequest[] = []
      const insertColumnsRequests: InsertColumnsRequest[] = []
      const readVisibleRequests: VisibleProjectionRequest[] = []
      const backend: SpreadsheetBackend = {
        ...createBaseBackend(),
        async readVisibleProjection(request) {
          readVisibleRequests.push(request)
          return {
            kind: 'visible-window',
            sheetId: request.sheetId,
            window: request.window,
            requestId: request.requestId,
            revision: 12,
            cells: [],
          }
        },
        async insertRows(request) {
          insertRowsRequests.push(request)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 11,
          }
        },
        async insertColumns(request) {
          insertColumnsRequests.push(request)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            revision: 11,
          }
        },
      }
      const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
      store.setter(selectionAtom, {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 3 },
        focus: { row: 4, col: 5 },
      })
      seedReadyVisibleProjection(store, {
        status: 'ready',
        request: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window,
          requestId: 20,
        },
        result: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window,
          requestId: 20,
          revision: 10,
          cells: [],
        },
      })

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))

      fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
      fireEvent.click(container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)!)

      await waitFor(() => {
        expect(store.getter(structureOperationLifecycleAtom)).toMatchObject({
          status: 'completed',
          operation: expectedOperation,
          sheetId: 'sheet-1',
          requestId: 1,
          acknowledgedRevision: 11,
        })
      })
      if (axis === 'row') {
        expect(insertRowsRequests).toEqual([
          {
            kind: 'insert-rows',
            sheetId: 'sheet-1',
            rowIndex: expectedIndex,
            count: 1,
            requestId: 1,
            revision: undefined,
          },
        ])
        expect(insertColumnsRequests).toEqual([])
      } else {
        expect(insertColumnsRequests).toEqual([
          {
            kind: 'insert-columns',
            sheetId: 'sheet-1',
            colIndex: expectedIndex,
            count: 1,
            requestId: 1,
            revision: undefined,
          },
        ])
        expect(insertRowsRequests).toEqual([])
      }
      expect(readVisibleRequests).toHaveLength(1)
      expect(readVisibleRequests[0]).toMatchObject({
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        reason: 'toolbar',
      })
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
        kind: expectedOperation,
        sheetId: 'sheet-1',
        projectionRevision: 11,
      })
      expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    },
  )

  it('Insert > structural entries hide when a worker runtime declares structuralEdits:false and stay for legacy runtimes', async () => {
    // Real TS worker backend: the fail-closed capability witness
    // (describeCapabilities → structuralEdits:false) withholds the
    // structural ports, so post-ready menu opens must hide the entries.
    const tsBackend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessTsWorker(),
      sheets: ['Sheet1'],
    })
    await tsBackend.ready()
    const tsRender = render(() => (
      <SpreadsheetUiProvider backend={tsBackend} store={createStore()}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(tsRender.container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    await waitFor(() => {
      expect(
        tsRender.container.querySelector('[data-testid="menu-bar-dropdown-insert"]'),
      ).not.toBeNull()
    })
    for (const itemId of [
      'insert.rowAbove',
      'insert.rowBelow',
      'insert.colLeft',
      'insert.colRight',
    ]) {
      expect(tsRender.container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`)).toBeNull()
    }
    // Non-structural entries survive the gate.
    expect(
      tsRender.container.querySelector('[data-testid="menu-bar-item-insert.sheet"]'),
    ).not.toBeNull()
    tsRender.unmount()
    tsBackend.dispose()

    // Legacy-shaped worker (answers UNKNOWN_COMMAND to the handshake,
    // like the WASM runtime): null witness → full trust → the structural
    // ports stay exposed and the entries stay visible.
    const legacyBackend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createLegacyProtocolWorker(),
      sheets: ['Sheet1'],
    })
    await legacyBackend.ready()
    const legacyRender = render(() => (
      <SpreadsheetUiProvider backend={legacyBackend} store={createStore()}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(legacyRender.container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    await waitFor(() => {
      expect(
        legacyRender.container.querySelector('[data-testid="menu-bar-dropdown-insert"]'),
      ).not.toBeNull()
    })
    for (const itemId of [
      'insert.rowAbove',
      'insert.rowBelow',
      'insert.colLeft',
      'insert.colRight',
    ]) {
      expect(
        legacyRender.container.querySelector(`[data-testid="menu-bar-item-${itemId}"]`),
      ).not.toBeNull()
    }
    legacyRender.unmount()
    legacyBackend.dispose()
  })

  it('Insert > Sheet delegates to the initialized Core sheet-tabs state machine', async () => {
    const store = createStore()
    const initialSheets: SpreadsheetSheetMetadata[] = [{ id: 'sheet-1', name: 'Sheet1', index: 0 }]
    const nextSheets: SpreadsheetSheetMetadata[] = [
      ...initialSheets,
      { id: 'sheet-2', name: 'Sheet2', index: 1 },
    ]
    const addRequests: AddSheetRequest[] = []
    let listCalls = 0
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async listSheets() {
        listCalls += 1
        return {
          sheets: listCalls === 1 ? initialSheets : nextSheets,
          revision: listCalls === 1 ? 3 : 4,
        }
      },
      async addSheet(request) {
        addRequests.push(request)
        return {
          requestId: request.requestId,
          sheetId: 'sheet-2',
          createdSheet: nextSheets[1],
          revision: 4,
        }
      },
    }
    await store.setter(initializeSheetTabsAtom, { backend, sheets: initialSheets })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-insert.sheet"]')!)

    await waitFor(() => {
      expect(store.getter(sheetTabsAtom).lastMutation).toMatchObject({
        kind: 'add',
        outcome: 'acknowledged',
      })
    })
    expect(addRequests).toHaveLength(1)
    expect(addRequests[0]).toMatchObject({
      kind: 'add-sheet',
      name: 'Sheet2',
      revision: 3,
    })
    expect(addRequests[0]?.requestId).toBeGreaterThan(0)
    expect(listCalls).toBe(2)
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(nextSheets)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(historyStackAtom).entries).toEqual([])
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('keeps row, column, and sheet insertion entrypoints as thin Core adapters', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx'),
      'utf8',
    )

    expect(source).toContain('createInsertRowsOperation')
    expect(source).toContain('createInsertColumnsOperation')
    expect(source).toContain('runStructureOperationAtom')
    expect(source).toContain('addSheetTabAtom')
    expect(source).toContain('snap.range.rowStart')
    expect(source).toContain('snap.range.rowEnd + 1')
    expect(source).toContain('snap.range.colStart')
    expect(source).toContain('snap.range.colEnd + 1')
    // No direct INVOCATION of the structural backend ports — mutations
    // must flow through the Core structure-operation lifecycle. Presence
    // reads (`backend.insertRows != null`) are allowed: they gate entry
    // VISIBILITY against the fail-closed capability witness per open.
    expect(source).not.toMatch(/backend\s*\.\s*(insertRows|insertColumns|addSheet)\s*\(/)
    expect(source).not.toContain('pushHistoryAtom')
    expect(source).not.toContain('nextHistoryTransactionId')
    expect(source).not.toContain('createAddSheetOperation')
  })

  it('Insert > Comment opens the comment session for the active cell', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(commentSessionAtom)).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-insert.comment"]')!)

    const session = store.getter(commentSessionAtom)
    expect(session).not.toBeNull()
    expect(session?.sheetId).toBe('sheet-1')
    expect(session?.cell.row).toBe(0)
    expect(session?.cell.col).toBe(0)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Format > Data Validation opens the validation rule editor', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(validationRuleEditorAtom).status).toBe('closed')
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-format"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-format.validation"]')!)
    expect(store.getter(validationRuleEditorAtom).status).toBe('editing')
  })

  it('Format > Hide Row commits the local canonical state and mirrors the delta', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const hideRequests: HideRowsRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async hideRows(request) {
        hideRequests.push(request)
        return { sheetId: request.sheetId }
      },
    }
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.hideRow')
    // Local commit is synchronous — no readback lifecycle, no pending gate.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])
    await waitFor(() => expect(hideRequests).toHaveLength(1))
    expect(hideRequests[0]).toMatchObject({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [2, 3, 4],
    })
  })

  it('Format > Hide Column commits the selected columns locally', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const hideRequests: HideColumnsRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async hideColumns(request) {
        hideRequests.push(request)
        return { sheetId: request.sheetId }
      },
    }
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.hideCol')
    expect(store.getter(viewportHiddenAtom)).toEqual({
      rowsBySheet: { 'sheet-1': [] },
      colsBySheet: { 'sheet-1': [3, 4, 5] },
    })
    await waitFor(() => expect(hideRequests).toHaveLength(1))
    expect(hideRequests[0]?.colIndices).toEqual([3, 4, 5])
  })

  it('Format > Hide Row works fully on a backend without hidden ports', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.hideRow')
    // Pre-flip this reported 'unsupported'; hidden is UI-core canonical now.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])
  })

  it('Format > Protect Sheet commits locally on a backend without protection ports', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.protectSheet')
    // Local commit is synchronous; the worker demo path needs no port.
    expect(store.getter(sheetProtectionAtom)['sheet-1']).toEqual({
      mode: 'protected',
      unlockedRanges: [],
    })
    expect(store.getter(selectionLockedAtom)).toBe('locked')

    await activateFormatMenuItem(container, 'format.unprotectSheet')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('open')
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })

  it('Format > Protect Sheet mirrors into setSheetProtection fire-and-forget when present', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const protectionRequests: SetSheetProtectionRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setSheetProtection(request) {
        protectionRequests.push(request)
        return { sheetId: request.sheetId }
      },
    }
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.protectSheet')
    expect(store.getter(sheetProtectionAtom)['sheet-1'].mode).toBe('protected')
    await waitFor(() => expect(protectionRequests).toHaveLength(1))
    expect(protectionRequests[0]).toMatchObject({
      kind: 'set-sheet-protection',
      sheetId: 'sheet-1',
      mode: 'protected',
      unlockedRanges: [],
    })
  })

  it('Format > Unlock Range opens the unlock dialog for the current selection', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.unlockRange')
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      isOpen: true,
      target: {
        sheetId: 'sheet-1',
        range: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 5 },
      },
    })
  })

  it('Format > Unhide Rows and Unhide Columns use the full local truth intersection', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    // Local canonical facts — including indices no viewport window ever
    // reported (rows 1/7, cols 1/8 are outside the 2..4 × 3..5 selection).
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [1, 2, 4, 7] })
    store.setter(hideColumnsAtom, { sheetId: 'sheet-1', indices: [1, 3, 5, 8] })
    const rowMutations: UnhideRowsRequest[] = []
    const columnMutations: UnhideColumnsRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async unhideRows(request) {
        rowMutations.push(request)
        return { sheetId: request.sheetId }
      },
      async unhideColumns(request) {
        columnMutations.push(request)
        return { sheetId: request.sheetId }
      },
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.unhideRow')
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([1, 7])
    await waitFor(() => expect(rowMutations).toHaveLength(1))
    expect(rowMutations[0]).toMatchObject({
      kind: 'unhide-rows',
      sheetId: 'sheet-1',
      rowIndices: [2, 4],
    })

    await activateFormatMenuItem(container, 'format.unhideCol')
    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([1, 8])
    await waitFor(() => expect(columnMutations).toHaveLength(1))
    expect(columnMutations[0]?.colIndices).toEqual([3, 5])
  })

  it('Format > Unhide without a hidden intersection changes nothing and sends no transport', async () => {
    const store = createStore()
    setupHiddenSelection(store)
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [7] })
    let mutations = 0
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async unhideRows(request) {
        mutations += 1
        return { sheetId: request.sheetId }
      },
    }
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await activateFormatMenuItem(container, 'format.unhideRow')
    await Promise.resolve()
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([7])
    expect(mutations).toBe(0)
  })

  it('renders English and Chinese labels for both Format unhide entries', async () => {
    setLocale('en')
    try {
      const store = createStore()
      setupHiddenSelection(store)
      const { container } = render(() => (
        <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))
      fireEvent.click(container.querySelector('[data-testid="menu-bar-button-format"]')!)

      await waitFor(() => {
        expect(
          container.querySelector('[data-testid="menu-bar-item-format.unhideRow"]')?.textContent,
        ).toContain('Unhide Rows')
        expect(
          container.querySelector('[data-testid="menu-bar-item-format.unhideCol"]')?.textContent,
        ).toContain('Unhide Columns')
      })

      setLocale('zh')
      await waitFor(() => {
        expect(
          container.querySelector('[data-testid="menu-bar-item-format.unhideRow"]')?.textContent,
        ).toContain('取消隐藏行')
        expect(
          container.querySelector('[data-testid="menu-bar-item-format.unhideCol"]')?.textContent,
        ).toContain('取消隐藏列')
      })
    } finally {
      setLocale('zh')
    }
  })

  it('keeps unhide menu routes as source-only Core resolver bridges', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx'),
      'utf8',
    )
    const routeStart = source.indexOf('function routeDispatch')
    const unhideStart = source.indexOf("case 'unhide-rows':", routeStart)
    const unhideEnd = source.indexOf("case 'freeze-panes':", unhideStart)
    const unhideRoutes = source.slice(unhideStart, unhideEnd)

    expect(unhideStart).toBeGreaterThanOrEqual(0)
    expect(unhideEnd).toBeGreaterThan(unhideStart)
    // Selection∩hidden resolution lives in Core; the adapter passes only
    // the action and the optional persistence mirror.
    expect(unhideRoutes).toContain('unhideViewportSelectionAtom')
    expect(unhideRoutes).toContain("dispatch.kind === 'unhide-rows'")
    expect(unhideRoutes).toContain("? 'unhide-rows'")
    expect(unhideRoutes).toContain("'unhide-columns'")
    expect(unhideRoutes).toContain('source: backend')
    for (const forbidden of [
      'selectionSnapshotAtom',
      'viewportHiddenAtom',
      'backend.unhideRows',
      'backend.unhideColumns',
      'setViewportHidden',
      'sheetId:',
      'indices:',
      'window:',
    ]) {
      expect(unhideRoutes).not.toContain(forbidden)
    }
  })

  it('keeps hidden row and column menu routes as thin Core command bridges', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx'),
      'utf8',
    )
    const routeStart = source.indexOf('function routeDispatch')
    const hiddenStart = source.indexOf("case 'hide-rows':", routeStart)
    const hiddenEnd = source.indexOf("case 'freeze-panes':", hiddenStart)
    const hiddenRoutes = source.slice(hiddenStart, hiddenEnd)

    expect(hiddenStart).toBeGreaterThanOrEqual(0)
    expect(hiddenEnd).toBeGreaterThan(hiddenStart)
    // Hidden state is UI-core canonical: routes call the local commands
    // with the backend only as a fire-and-forget persistence mirror.
    expect(hiddenRoutes).toContain('hideRowsAtom')
    expect(hiddenRoutes).toContain('hideColumnsAtom')
    expect(hiddenRoutes).toContain('source: backend')
    expect(source).not.toContain('setViewportHiddenAtom')
    expect(source).not.toContain('runViewportHiddenMutationAtom')
    expect(hiddenRoutes).not.toContain('backend.hideRows')
    expect(hiddenRoutes).not.toContain('backend.hideColumns')
  })

  it('Data > Data Validation also opens the validation rule editor', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.validation"]')!)
    expect(store.getter(validationRuleEditorAtom).status).toBe('editing')
  })

  /**
   * Sort is a physical engine mutation (#29) and the display permutation is
   * retired (#24), so the Data > Sort entries are capability-gated on the
   * backend `sortRange` port and dispatch a `sort-range` request.
   */
  function createSortingBackend(sortRequests: SortRangeRequest[]): SpreadsheetBackend {
    return {
      ...createBaseBackend(),
      async setFilterSort({ sheetId, requestId }) {
        return { sheetId, requestId, revision: 1 }
      },
      async resolveDataEdge(request) {
        return {
          kind: 'resolve-data-edge',
          sheetId: request.sheetId,
          target: request.direction === 'down' ? { row: 6, col: 0 } : { row: 0, col: 4 },
        }
      },
      async sortRange(request) {
        sortRequests.push(request)
        return {
          kind: 'sort-range',
          sheetId: request.sheetId,
          applied: true,
          movedRows: 2,
          movedCells: 8,
          affectedRange: request.range,
          requestId: request.requestId,
          revision: 2,
        }
      },
    }
  }

  it('Data > Sort Asc physically sorts the active column through sortRange', async () => {
    const store = createStore()
    const sortRequests: SortRangeRequest[] = []
    const backend = createSortingBackend(sortRequests)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 3 },
      focus: { row: 2, col: 3 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const sortAsc = container.querySelector(
      '[data-testid="menu-bar-item-data.sortAsc"]',
    ) as HTMLButtonElement
    await waitFor(() => expect(sortAsc.disabled).toBe(false))
    fireEvent.click(sortAsc)

    await waitFor(() => expect(sortRequests).toHaveLength(1))
    expect(sortRequests[0]!.keys).toEqual([{ col: 3, direction: 'asc' }])
    // No display permutation is ever written any more.
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
  })

  it('Data > Sort Desc dispatches a descending physical sort', async () => {
    const store = createStore()
    const sortRequests: SortRangeRequest[] = []
    const backend = createSortingBackend(sortRequests)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 1 },
      focus: { row: 0, col: 1 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const sortDesc = container.querySelector(
      '[data-testid="menu-bar-item-data.sortDesc"]',
    ) as HTMLButtonElement
    await waitFor(() => expect(sortDesc.disabled).toBe(false))
    fireEvent.click(sortDesc)

    await waitFor(() => expect(sortRequests).toHaveLength(1))
    expect(sortRequests[0]!.keys).toEqual([{ col: 1, direction: 'desc' }])
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
  })

  it('hides both Data > Sort entries when the backend exposes no sortRange port', async () => {
    const store = createStore()
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setFilterSort({ sheetId, requestId }) {
        return { sheetId, requestId, revision: 1 }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="menu-bar-item-data.filter"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="menu-bar-item-data.sortAsc"]')).toBeNull()
    expect(container.querySelector('[data-testid="menu-bar-item-data.sortDesc"]')).toBeNull()
  })

  // `Data → Reapply` (#27). Unlike the Sort entries above it never HIDES: its
  // routine unavailable state is "no filter active right now", and an entry
  // that appears the moment you filter and vanishes the moment you clear
  // would be worse than one that greys out.
  it('Data > Reapply is disabled with no active filter and enabled once one exists', async () => {
    const store = createStore()
    const setFilterSortRequests: SetFilterSortRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setFilterSort(request) {
        setFilterSortRequests.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
          historyRecorded: false,
          hiddenRowIndices: [3],
        }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const reapply = () =>
      container.querySelector('[data-testid="menu-bar-item-data.reapply"]') as HTMLButtonElement
    await waitFor(() => expect(reapply()).not.toBeNull())

    // Counter-example: visible but inert, and clicking it dispatches nothing.
    expect(reapply().disabled).toBe(true)
    fireEvent.click(reapply())
    expect(setFilterSortRequests).toHaveLength(0)

    // Commit rules the way an applied filter leaves them.
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }] },
    })

    // The dropdown is still open (a disabled item swallows its own click), so
    // the entry has to un-grey reactively rather than on the next open.
    await waitFor(() => expect(reapply().disabled).toBe(false))
    fireEvent.click(reapply())

    await waitFor(() => expect(setFilterSortRequests).toHaveLength(1))
    // The committed rules go back out verbatim — Reapply re-answers them, it
    // never redefines them.
    expect(setFilterSortRequests[0]).toMatchObject({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })
    await waitFor(() =>
      expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet-1')).toEqual(
        [3],
      ),
    )
  })

  it('Data > Reapply stays visible (disabled) when the backend has no setFilterSort port', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="menu-bar-item-data.reapply"]')).not.toBeNull()
    })
    expect(
      (container.querySelector('[data-testid="menu-bar-item-data.reapply"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  function tableDescriptor(name: string): SpreadsheetTableDescriptor {
    return {
      name,
      sheetId: 'sheet-1',
      sheetName: 'Sheet1',
      sheetIndex: 0,
      range: 'A1:C4',
      hasHeaders: true,
      hasTotals: false,
      columns: ['Name', 'Age', 'City'],
    }
  }

  interface TableBackendOptions {
    createResult?: (request: CreateTableRequest) => CreateTableResult
  }

  function createTableCapableBackend(options: TableBackendOptions = {}): {
    backend: SpreadsheetBackend
    createRequests: CreateTableRequest[]
  } {
    const createRequests: CreateTableRequest[] = []
    let created = false
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async createTable(request) {
        createRequests.push(request)
        if (options.createResult) {
          const result = options.createResult(request)
          if (result.applied) created = true
          return result
        }
        created = true
        return {
          kind: 'create-table',
          applied: true,
          name: request.name ?? 'Table1',
          requestId: request.requestId,
          revision: 1,
        }
      },
      async listTables(): Promise<ListTablesResult> {
        return { tables: created ? [tableDescriptor('Table1')] : [] }
      },
    }
    return { backend, createRequests }
  }

  function setupTableSelection(store: ReturnType<typeof createStore>) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 3, col: 2 },
    })
  }

  it('Data > Create table hides when the backend has no createTable port', () => {
    const store = createStore()
    setupTableSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(createTableSupportedAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    expect(container.querySelector('[data-testid="menu-bar-item-data.createTable"]')).toBeNull()
  })

  it('Data > Create table is visible with a createTable backend and dispatches on the selection', async () => {
    const store = createStore()
    setupTableSelection(store)
    const { backend, createRequests } = createTableCapableBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(createTableSupportedAtom)).toBe(true)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const item = container.querySelector('[data-testid="menu-bar-item-data.createTable"]')
    expect(item).not.toBeNull()
    fireEvent.click(item!)

    await waitFor(() => {
      expect(store.getter(lastCreatedTableNameAtom)).toBe('Table1')
    })
    expect(createRequests).toHaveLength(1)
    expect(createRequests[0]).toMatchObject({
      kind: 'create-table',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 },
    })
    expect(store.getter(allTablesAtom).map((t) => t.name)).toEqual(['Table1'])
    // Visible success feedback: the status span carries the canonical name.
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="menu-bar-create-table-status"]')?.textContent,
      ).toBe('Table1')
    })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Data > Create table on a single-cell selection surfaces an invalid-selection diagnostic', async () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 1 },
      focus: { row: 2, col: 1 },
    })
    const { backend, createRequests } = createTableCapableBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.createTable"]')!)

    await waitFor(() => {
      const errorSpan = container.querySelector('[data-testid="menu-bar-create-table-error"]')
      expect(errorSpan?.getAttribute('data-table-diagnostic-code')).toBe('invalid-selection')
    })
    // No backend call for a locally-rejected selection.
    expect(createRequests).toHaveLength(0)
    expect(store.getter(tableDiagnosticAtom)?.code).toBe('invalid-selection')
  })

  it('Data > Create table maps a structured range-overlap reject to a diagnostic', async () => {
    const store = createStore()
    setupTableSelection(store)
    const { backend } = createTableCapableBackend({
      createResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'range-overlap',
        requestId: request.requestId,
        revision: 1,
      }),
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.createTable"]')!)

    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="menu-bar-create-table-error"]')
          ?.getAttribute('data-table-diagnostic-code'),
      ).toBe('range-overlap')
    })
    expect(store.getter(allTablesAtom)).toEqual([])
    expect(store.getter(lastCreatedTableNameAtom)).toBeNull()
  })

  interface TotalsBackendOptions {
    hasTotals?: boolean
    totalsResult?: (request: SetTableTotalsRowRequest) => TableMutationResult
  }

  function createTotalsCapableBackend(options: TotalsBackendOptions = {}): {
    backend: SpreadsheetBackend
    totalsRequests: SetTableTotalsRowRequest[]
  } {
    const totalsRequests: SetTableTotalsRowRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readVisibleProjection(request) {
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          window: request.window,
          requestId: request.requestId,
          revision: 1,
          cells: [],
        }
      },
      async listTables(): Promise<ListTablesResult> {
        return {
          tables: [{ ...tableDescriptor('Table1'), hasTotals: options.hasTotals ?? false }],
        }
      },
      async setTableTotalsRow(request) {
        totalsRequests.push(request)
        if (options.totalsResult) return options.totalsResult(request)
        return {
          kind: 'table-mutation',
          applied: true,
          name: request.name,
          requestId: request.requestId,
          revision: 2,
        }
      },
    }
    return { backend, totalsRequests }
  }

  it('Data > Toggle totals row hides when the backend has no setTableTotalsRow port', () => {
    const store = createStore()
    setupTableSelection(store)
    // A create-only backend (no totals port) → the entry hides.
    const { backend } = createTableCapableBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    expect(container.querySelector('[data-testid="menu-bar-item-data.toggleTotals"]')).toBeNull()
  })

  it('Data > Toggle totals row flips the totals row of the table under the active cell', async () => {
    const store = createStore()
    // Active cell (0,0) sits inside the Table1 range A1:C4.
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    const { backend, totalsRequests } = createTotalsCapableBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(toggleTableTotalsSupportedAtom)).toBe(true)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const item = container.querySelector('[data-testid="menu-bar-item-data.toggleTotals"]')
    expect(item).not.toBeNull()
    fireEvent.click(item!)

    await waitFor(() => expect(totalsRequests).toHaveLength(1))
    // hasTotals:false in the catalog → the toggle requests enable.
    expect(totalsRequests[0]).toMatchObject({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    // Visible success badge reflects the new totals state.
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="menu-bar-toggle-totals-status"]')
          ?.getAttribute('data-has-totals'),
      ).toBe('true')
    })
    expect(store.getter(lastToggledTableTotalsAtom)).toEqual({ name: 'Table1', hasTotals: true })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Data > Toggle totals row surfaces a no-table diagnostic when the active cell is outside every table', async () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 20, col: 20 },
      focus: { row: 20, col: 20 },
    })
    const { backend, totalsRequests } = createTotalsCapableBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.toggleTotals"]')!)

    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="menu-bar-create-table-error"]')
          ?.getAttribute('data-table-diagnostic-code'),
      ).toBe('no-table-at-selection')
    })
    expect(totalsRequests).toHaveLength(0)
  })

  it('View > Show Gridlines toggles the atom and mirrors aria-checked', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(viewportShowGridlinesAtom)).toBe(true)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    const item = container.querySelector(
      '[data-testid="menu-bar-item-view.gridlines"]',
    ) as HTMLButtonElement
    expect(item.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(item)
    expect(store.getter(viewportShowGridlinesAtom)).toBe(false)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    const item2 = container.querySelector(
      '[data-testid="menu-bar-item-view.gridlines"]',
    ) as HTMLButtonElement
    expect(item2.getAttribute('aria-checked')).toBe('false')
  })

  it('View > Show Headings + Show Formula Bar both toggle their atoms', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(viewportShowHeadingsAtom)).toBe(true)
    expect(store.getter(viewportShowFormulaBarAtom)).toBe(true)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.headings"]')!)
    expect(store.getter(viewportShowHeadingsAtom)).toBe(false)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.formulaBar"]')!)
    expect(store.getter(viewportShowFormulaBarAtom)).toBe(false)
  })

  it('View freeze commands stay enabled and commit locally without freeze ports', () => {
    // UI-core canonical flip: freeze is a view fact — a worker backend
    // without readFreezeConfig / setFreezeConfig still gets full freeze.
    const store = createStore()
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      readFreezeConfig: undefined,
      setFreezeConfig: undefined,
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 1 },
      focus: { row: 2, col: 1 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    const freeze = container.querySelector(
      '[data-testid="menu-bar-item-view.freeze"]',
    ) as HTMLButtonElement
    const unfreeze = container.querySelector(
      '[data-testid="menu-bar-item-view.unfreeze"]',
    ) as HTMLButtonElement
    expect(freeze.disabled).toBe(false)
    expect(unfreeze.disabled).toBe(false)

    fireEvent.click(freeze)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2 },
      colsBySheet: { 'sheet-1': 1 },
    })

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.unfreeze"]')!)
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 0 },
      colsBySheet: { 'sheet-1': 0 },
    })
  })

  it('View freeze mirrors into the persistence hook when the backend exposes one', async () => {
    const store = createStore()
    const setRequests: Array<{ sheetId: string; freeze: { rows: number; cols: number } }> = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setFreezeConfig(request) {
        setRequests.push({ sheetId: request.sheetId, freeze: { ...request.freeze } })
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 2 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.freeze"]')!)
    // Local commit is synchronous; the mirror is fire-and-forget.
    expect(store.getter(viewportFreezeAtom).rowsBySheet['sheet-1']).toBe(3)
    await waitFor(() => {
      expect(setRequests).toEqual([{ sheetId: 'sheet-1', freeze: { rows: 3, cols: 2 } }])
    })
  })

  it('Help > Keyboard Shortcuts opens the shortcuts overlay', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(helpOverlayAtom)).toBe('closed')
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-help"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-help.shortcuts"]')!)
    expect(store.getter(helpOverlayAtom)).toBe('shortcuts')
    expect(getByTestId('spreadsheet-help-overlay-shortcuts')).not.toBeNull()
    expect(getByTestId('spreadsheet-help-overlay-shortcut-list')).not.toBeNull()
  })

  it('Help > About opens the about overlay and Close dismisses it', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-help"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-help.about"]')!)
    expect(store.getter(helpOverlayAtom)).toBe('about')
    expect(getByTestId('spreadsheet-help-overlay-about-body')).not.toBeNull()

    fireEvent.click(getByTestId('spreadsheet-help-overlay-close'))
    expect(store.getter(helpOverlayAtom)).toBe('closed')
  })

  it('Data > Text to Columns is hidden when backend.importCellChunks is absent (capability gating)', () => {
    const store = createStore()
    // Base backend deliberately omits importCellChunks.
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    expect(container.querySelector('[data-testid="menu-bar-item-data.textToColumns"]')).toBeNull()
  })

  it('Data > Text to Columns is visible when backend.importCellChunks is present', () => {
    const store = createStore()
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async importCellChunks() {
        return { sheetId: 'sheet-1' }
      },
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.textToColumns"]'),
    ).not.toBeNull()
  })

  it('Data > Text to Columns dispatches the Core entrypoint and preserves sparse rows', async () => {
    const store = createStore()
    let request: RangeProjectionRequest | null = null
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readRangeProjection(nextRequest) {
        request = nextRequest
        return matchingTextToColumnsProjection(nextRequest, [
          { row: 0, col: 1, displayValue: 'alpha,beta' },
          { row: 2, col: 1, displayValue: 'gamma,delta' },
        ])
      },
      async importCellChunks() {
        return { sheetId: 'sheet-1' }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 1 },
      focus: { row: 2, col: 1 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.textToColumns"]')!)

    await waitFor(() => expect(store.getter(textToColumnsOpenAtom)).toBe(true))
    const observedRequest = request as RangeProjectionRequest | null
    if (observedRequest === null) throw new Error('expected Text to Columns projection request')
    expect(observedRequest).toMatchObject({
      kind: 'range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 },
      reason: 'toolbar',
    })
    expect(observedRequest.requestId).toBeGreaterThan(0)
    expect(store.getter(textToColumnsSourceAtom)).toEqual([
      { sourceRow: 0, text: 'alpha,beta' },
      { sourceRow: 1, text: '' },
      { sourceRow: 2, text: 'gamma,delta' },
    ])
    expect(store.getter(textToColumnsSessionAtom)).toMatchObject({
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 1 },
      sourceRange: { rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 },
    })
  })

  it('Data > Text to Columns binds invalid-target and active-session disabling to Core', () => {
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async importCellChunks() {
        return { sheetId: 'sheet-1' }
      },
    }

    const invalidStore = createStore()
    const invalidView = render(() => (
      <SpreadsheetUiProvider backend={backend} store={invalidStore}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(invalidView.container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const invalidItem = invalidView.container.querySelector(
      '[data-testid="menu-bar-item-data.textToColumns"]',
    ) as HTMLButtonElement
    expect(invalidItem.disabled).toBe(true)
    expect(invalidItem.title).toBe(
      invalidStore.getter(textToColumnsEntrypointProjectionAtom).disabledReason,
    )
    invalidView.unmount()

    const sessionStore = createStore()
    setupSelection(sessionStore)
    sessionStore.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    sessionStore.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [{ sourceRow: 0, text: 'active,session' }],
    })
    const sessionView = render(() => (
      <SpreadsheetUiProvider backend={backend} store={sessionStore}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(sessionView.container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const sessionItem = sessionView.container.querySelector(
      '[data-testid="menu-bar-item-data.textToColumns"]',
    ) as HTMLButtonElement
    expect(sessionItem.disabled).toBe(true)
    expect(sessionItem.title).toBe(
      sessionStore.getter(textToColumnsEntrypointProjectionAtom).disabledReason,
    )
  })

  it('Data > Text to Columns exposes loading, stale, and retry from the Core projection', async () => {
    const store = createStore()
    const first = deferred<RangeProjectionResult>()
    let firstRequest: RangeProjectionRequest | null = null
    let readCount = 0
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readRangeProjection(request) {
        readCount += 1
        if (readCount === 1) {
          firstRequest = request
          return first.promise
        }
        return matchingTextToColumnsProjection(request)
      },
      async importCellChunks() {
        return { sheetId: 'sheet-1' }
      },
    }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 0 },
    })

    const { container, getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.textToColumns"]')!)

    expect(getByTestId('menu-bar-text-to-columns-loading')).not.toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    const loadingItem = container.querySelector(
      '[data-testid="menu-bar-item-data.textToColumns"]',
    ) as HTMLButtonElement
    expect(loadingItem.disabled).toBe(true)
    expect(loadingItem.title).toBe(
      store.getter(textToColumnsEntrypointProjectionAtom).disabledReason,
    )
    expect(readCount).toBe(0)

    await waitFor(() => expect(firstRequest).not.toBeNull())
    expect(readCount).toBe(1)
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 5, col: 0 },
      focus: { row: 6, col: 0 },
    })
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="spreadsheet-menu-bar"]')
          ?.getAttribute('data-text-to-columns-entrypoint-status'),
      ).toBe('stale')
      expect(getByTestId('menu-bar-text-to-columns-status')).not.toBeNull()
    })
    if (firstRequest === null) throw new Error('expected first projection request')
    first.resolve(matchingTextToColumnsProjection(firstRequest))

    await waitFor(() => expect(queryByTestId('menu-bar-text-to-columns-retry')).not.toBeNull())
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    fireEvent.click(getByTestId('menu-bar-text-to-columns-retry'))
    await waitFor(() => expect(store.getter(textToColumnsOpenAtom)).toBe(true))
    expect(readCount).toBe(2)
    expect(store.getter(textToColumnsSessionAtom)?.sourceRange).toEqual({
      rowStart: 5,
      rowEnd: 6,
      colStart: 0,
      colEnd: 0,
    })
  })

  it('Data > Text to Columns exposes a transport error and retry recovery', async () => {
    const store = createStore()
    let readCount = 0
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async readRangeProjection(request) {
        readCount += 1
        if (readCount === 1) throw new Error('projection unavailable')
        return matchingTextToColumnsProjection(request)
      },
      async importCellChunks() {
        return { sheetId: 'sheet-1' }
      },
    }
    setupSelection(store)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.textToColumns"]')!)

    await waitFor(() => {
      expect(getByTestId('menu-bar-text-to-columns-status').textContent).toContain(
        'projection unavailable',
      )
      expect(getByTestId('menu-bar-text-to-columns-retry')).not.toBeNull()
    })
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    fireEvent.click(getByTestId('menu-bar-text-to-columns-retry'))
    await waitFor(() => expect(store.getter(textToColumnsOpenAtom)).toBe(true))
    expect(readCount).toBe(2)
  })

  it('keeps the Text to Columns menu branch as a thin Core command adapter', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx'),
      'utf8',
    )
    const routeStart = source.indexOf('function routeDispatch')
    const start = source.indexOf("case 'open-text-to-columns':", routeStart)
    const end = source.indexOf("case 'open-remove-duplicates':", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const branch = source.slice(start, end)

    expect(branch).toContain('runTextToColumnsEntrypoint()')
    expect(branch).not.toContain('readRangeProjection')
    expect(branch).not.toContain('requestId: 0')
    expect(branch).not.toContain('new Map')
    expect(branch).not.toContain('openTextToColumnsAtom')
    expect(branch).not.toMatch(/\basync\b/)
    expect(source).not.toContain('createSignal')
  })

  it.each(['missing-range-read', 'legacy-removeRows-only'] as const)(
    'Data > Remove Duplicates hides when the Core exact capability is %s',
    async (capabilityCase) => {
      const store = createStore()
      const backend =
        capabilityCase === 'missing-range-read'
          ? ({
              ...addRemoveDuplicatesExactCapability(createBaseBackend()),
              readRangeProjection: undefined,
            } as unknown as SpreadsheetBackend)
          : ({
              ...createBaseBackend(),
              async removeRows() {
                return { sheetId: 'sheet-1', removedRows: 0, revision: 1 }
              },
            } as SpreadsheetBackend)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))

      await waitFor(() => {
        expect(store.getter(removeDuplicatesCapabilityAtom)).toEqual(
          capabilityCase === 'missing-range-read'
            ? { canRead: false, canRemove: true }
            : { canRead: true, canRemove: false },
        )
      })
      fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
      expect(
        container.querySelector('[data-testid="menu-bar-item-data.removeDuplicates"]'),
      ).toBeNull()
    },
  )

  it('Data > Remove Duplicates is visible only with Core read + exact-remove capability', async () => {
    const store = createStore()
    const backend = addRemoveDuplicatesExactCapability(createBaseBackend())

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(removeDuplicatesCapabilityAtom)).toEqual({
        canRead: true,
        canRemove: true,
      })
    })
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.removeDuplicates"]'),
    ).not.toBeNull()
  })

  it('Data > Remove Duplicates dispatches one source-only Core hydration with an exact request', async () => {
    const store = createStore()
    let capturedRequest: RangeProjectionRequest | undefined
    const backend = addRemoveDuplicatesExactCapability({
      ...createBaseBackend(),
      async readRangeProjection(request) {
        capturedRequest = request
        return matchingRemoveDuplicatesProjection(request)
      },
    })
    setupRemoveDuplicatesSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    await activateRemoveDuplicatesMenuItem(container)

    await waitFor(() => {
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
    })
    expect(capturedRequest).toMatchObject({
      kind: 'range',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 1 },
      reason: 'selection',
    })
    expect(capturedRequest?.requestId).toBeGreaterThan(0)
    expect(store.getter(removeDuplicatesSessionAtom)).toMatchObject({
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 4, startCol: 0, endCol: 1 },
      projectionRevision: 7,
    })
  })

  it.each([
    ['empty', [] as DisplayCell[]],
    [
      'sparse',
      [
        { row: 0, col: 0, displayValue: 'header' },
        { row: 3, col: 1, displayValue: 'only one later cell' },
      ] as DisplayCell[],
    ],
  ])('Data > Remove Duplicates accepts an exact %s projection', async (_label, cells) => {
    const store = createStore()
    const backend = addRemoveDuplicatesExactCapability({
      ...createBaseBackend(),
      async readRangeProjection(request) {
        return matchingRemoveDuplicatesProjection(request, cells)
      },
    })
    setupRemoveDuplicatesSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    await activateRemoveDuplicatesMenuItem(container)

    await waitFor(() => {
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
    })
    expect(store.getter(removeDuplicatesSessionAtom)?.cells).toEqual(cells)
  })

  it.each(['rejection', 'truncated acknowledgement'] as const)(
    'Data > Remove Duplicates projects the Core read failure for a transport %s',
    async (failure) => {
      const store = createStore()
      const backend = addRemoveDuplicatesExactCapability({
        ...createBaseBackend(),
        async readRangeProjection(request) {
          if (failure === 'rejection') throw new Error('projection unavailable')
          return {
            ...matchingRemoveDuplicatesProjection(request),
            truncated: true,
          }
        },
      })
      setupRemoveDuplicatesSelection(store)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))
      await activateRemoveDuplicatesMenuItem(container)

      await waitFor(() => {
        expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
      })
      expect(store.getter(removeDuplicatesOpenAtom)).toBe(true)
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
      expect(store.getter(removeDuplicatesErrorAtom)).toContain(
        'could not load a complete projection',
      )
      if (failure === 'rejection') {
        expect(store.getter(removeDuplicatesErrorAtom)).toContain('projection unavailable')
      }
    },
  )

  it.each(['selection', 'workspace-sheet'] as const)(
    'Data > Remove Duplicates ignores a late exact acknowledgement after %s drift',
    async (drift) => {
      const store = createStore()
      const read = deferred<RangeProjectionResult>()
      let capturedRequest: RangeProjectionRequest | undefined
      const backend = addRemoveDuplicatesExactCapability({
        ...createBaseBackend(),
        readRangeProjection(request) {
          capturedRequest = request
          return read.promise
        },
      })
      setupRemoveDuplicatesSelection(store)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetMenuBar />
        </SpreadsheetUiProvider>
      ))
      await activateRemoveDuplicatesMenuItem(container)
      await waitFor(() => expect(capturedRequest).toBeDefined())

      if (drift === 'selection') {
        store.setter(selectionAtom, {
          kind: 'range',
          sheetId: 'sheet-1',
          anchor: { row: 1, col: 0 },
          focus: { row: 4, col: 1 },
        })
      } else {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
      }
      read.resolve(matchingRemoveDuplicatesProjection(capturedRequest!))

      await waitFor(() => {
        expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-stale')
      })
      expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
      expect(store.getter(removeDuplicatesErrorAtom)).toContain('changed while')
    },
  )

  it('Data > Remove Duplicates retry allocates a fresh Core request identity', async () => {
    const store = createStore()
    const requestIds: number[] = []
    const backend = addRemoveDuplicatesExactCapability({
      ...createBaseBackend(),
      async readRangeProjection(request) {
        requestIds.push(request.requestId)
        if (requestIds.length === 1) throw new Error('temporary read failure')
        return matchingRemoveDuplicatesProjection(request)
      },
    })
    setupRemoveDuplicatesSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
    await activateRemoveDuplicatesMenuItem(container)
    await waitFor(() => {
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('read-failed')
    })
    const firstRequestId = store.getter(removeDuplicatesReadRequestIdAtom)

    await activateRemoveDuplicatesMenuItem(container)
    await waitFor(() => {
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('editing')
    })
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toBe(firstRequestId)
    expect(requestIds[1]).toBeGreaterThan(requestIds[0])
    expect(store.getter(removeDuplicatesReadRequestIdAtom)).toBe(requestIds[1])
  })

  it('keeps every Remove Duplicates entry as a thin Core source adapter', () => {
    const menuSource = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx'),
      'utf8',
    )
    const menuHelperStart = menuSource.indexOf('function runRemoveDuplicatesEntrypoint')
    const menuHelperEnd = menuSource.indexOf('function getActiveSheetId', menuHelperStart)
    const menuRouteStart = menuSource.indexOf('function routeDispatch')
    const menuBranchStart = menuSource.indexOf("case 'open-remove-duplicates':", menuRouteStart)
    const menuBranchEnd = menuSource.indexOf("case 'open-format-cells':", menuBranchStart)
    expect(menuHelperStart).toBeGreaterThanOrEqual(0)
    expect(menuHelperEnd).toBeGreaterThan(menuHelperStart)
    expect(menuBranchStart).toBeGreaterThanOrEqual(0)
    expect(menuBranchEnd).toBeGreaterThan(menuBranchStart)
    const menuAdapter =
      menuSource.slice(menuHelperStart, menuHelperEnd) +
      menuSource.slice(menuBranchStart, menuBranchEnd)

    expect(menuAdapter).toContain('openRemoveDuplicatesFromSelectionAtom')
    expect(menuAdapter).toContain('{ source: backend }')
    expect(menuAdapter).toContain('runRemoveDuplicatesEntrypoint()')
    expect(menuAdapter).not.toContain('readRangeProjection')
    expect(menuAdapter).not.toContain('requestId: 0')
    expect(menuAdapter).not.toContain('new Map')
    expect(menuAdapter).not.toContain('openRemoveDuplicatesAtom')
    expect(menuAdapter).not.toContain('removeDuplicatesSheetIdAtom')
    expect(menuAdapter).not.toMatch(/\basync\b/)
    expect(menuSource).toContain('captureRemoveDuplicatesCapabilityAtom')
    expect(menuSource).toContain('useAtomValue(removeDuplicatesCapabilityAtom)')

    const demoSource = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/demos/VNextWave5Demo.tsx'),
      'utf8',
    )
    const demoStart = demoSource.indexOf('function triggerRemoveDuplicatesForSelection')
    const demoEnd = demoSource.indexOf('onMount', demoStart)
    expect(demoStart).toBeGreaterThanOrEqual(0)
    expect(demoEnd).toBeGreaterThan(demoStart)
    const demoAdapter = demoSource.slice(demoStart, demoEnd)
    expect(demoAdapter).toContain('openRemoveDuplicatesFromSelectionAtom')
    expect(demoAdapter).toContain('{ source: backend }')
    expect(demoAdapter).not.toContain('readRangeProjection')
    expect(demoAdapter).not.toContain('requestId: 0')
    expect(demoAdapter).not.toContain('openRemoveDuplicatesAtom')
    expect(demoAdapter).not.toContain('removeDuplicatesSheetIdAtom')
    expect(demoAdapter).not.toMatch(/\basync\b/)

    const providerSource = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/provider/atoms.ts'),
      'utf8',
    )
    expect(providerSource).not.toContain('removeDuplicatesSupportedAtom')
    expect(providerSource).not.toContain('removeDuplicatesSheetIdAtom')
  })
})
