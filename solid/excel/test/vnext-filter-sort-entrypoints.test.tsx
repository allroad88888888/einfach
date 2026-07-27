/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  SortRangeRequest,
  SortRangeResult,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  FILTER_SORT_OUTCOME_UNKNOWN_ERROR,
  createVisibleProjectionRequest,
  filterDropdownAtom,
  filterSortEntrypointStateAtom,
  physicalSortDiagnosticAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createBackend(overrides: Partial<SpreadsheetBackend> = {}): SpreadsheetBackend {
  return {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 1,
        window: request.window,
        cells: [],
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async setFilterSort(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 1,
        historyRecorded: false,
        hiddenRowIndices: [],
      }
    },
    // Sort is a physical engine mutation and the display permutation is
    // retired (#24), so every sort entrypoint here rides `sortRange`.
    async resolveDataEdge(request) {
      return {
        kind: 'resolve-data-edge',
        sheetId: request.sheetId,
        target: request.direction === 'down' ? { row: 8, col: 0 } : { row: 0, col: 5 },
      }
    },
    async sortRange(request) {
      return appliedSortResult(request)
    },
    ...overrides,
  }
}

function appliedSortResult(request: SortRangeRequest): SortRangeResult {
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
}

function setTarget(store: ReturnType<typeof createStore>, sheetId: string, colIndex: number): void {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId,
    anchor: { row: 0, col: colIndex },
    focus: { row: 0, col: colIndex },
  })
}

function seedProjection(store: ReturnType<typeof createStore>, sheetId: string): void {
  const window = { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 5 }
  const request = createVisibleProjectionRequest({
    sheetId,
    requestId: 1,
    reason: 'viewport',
    window,
  })
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request,
    result: {
      kind: 'visible-window',
      sheetId,
      requestId: request.requestId,
      revision: 1,
      window,
      cells: [],
    },
    error: undefined,
  })
}

function renderEntrypoints(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetMenuBar />
      <SpreadsheetToolbar />
    </SpreadsheetUiProvider>
  ))
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
}

async function waitForEntrypointsEnabled(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(button(container, 'toolbar-btn-filter').disabled).toBe(false)
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(false)
  })
}

function openDataMenu(container: HTMLElement): void {
  if (!container.querySelector('[data-testid="menu-bar-dropdown-data"]')) {
    fireEvent.click(button(container, 'menu-bar-button-data'))
  }
}

function clickMenuSort(container: HTMLElement, direction: 'asc' | 'desc'): void {
  openDataMenu(container)
  fireEvent.click(
    button(container, `menu-bar-item-data.sort${direction === 'asc' ? 'Asc' : 'Desc'}`),
  )
}

function clickToolbarSort(container: HTMLElement, direction: 'asc' | 'desc'): void {
  fireEvent.click(button(container, 'toolbar-btn-sort'))
  fireEvent.click(button(container, `toolbar-sort-${direction}`))
}

describe('vNext filter/sort entrypoints', () => {
  it('opens the Core-owned filter draft from the toolbar and blocks menu sorting', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 2)
    const { container } = renderEntrypoints(store, createBackend())
    await waitForEntrypointsEnabled(container)

    fireEvent.click(button(container, 'toolbar-btn-filter'))

    expect(store.getter(filterDropdownAtom)).toEqual({
      status: 'open',
      sheetId: 'sheet-a',
      colIndex: 2,
    })
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(true)
    openDataMenu(container)
    expect(button(container, 'menu-bar-item-data.sortAsc').disabled).toBe(true)
    expect(button(container, 'menu-bar-item-data.sortDesc').disabled).toBe(true)
    expect(button(container, 'menu-bar-item-data.filter').disabled).toBe(true)
  })

  it('keeps toolbar and menu on one Core lane through post-launch target drift', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 1)
    seedProjection(store, 'sheet-a')
    const acknowledgement = deferred<SortRangeResult>()
    const requests: SortRangeRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      sortRange(request) {
        requests.push(request)
        return acknowledgement.promise
      },
      async readVisibleProjection(request) {
        reads.push(request)
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
          window: request.window,
          cells: [],
        }
      },
    })
    const { container } = renderEntrypoints(store, backend)
    await waitForEntrypointsEnabled(container)

    clickToolbarSort(container, 'asc')
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(button(container, 'spreadsheet-toolbar').getAttribute('data-filter-sort-status')).toBe(
      'pending',
    )

    setTarget(store, 'sheet-b', 3)
    await waitFor(() => {
      expect(button(container, 'spreadsheet-toolbar').getAttribute('data-filter-sort-status')).toBe(
        'stale',
      )
    })
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(true)
    openDataMenu(container)
    const menuSort = button(container, 'menu-bar-item-data.sortDesc')
    expect(menuSort.disabled).toBe(true)
    fireEvent.click(menuSort)
    expect(requests).toHaveLength(1)

    acknowledgement.resolve(appliedSortResult(requests[0]!))
    await waitFor(() => expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle'))

    expect(requests[0]!.keys).toEqual([{ col: 1, direction: 'asc' }])
    expect(reads.map((read) => read.sheetId)).toEqual(['sheet-a'])
  })

  it('makes a sort transport failure inert without refresh or transport retry', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 4)
    seedProjection(store, 'sheet-a')
    const requests: SortRangeRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async sortRange(request) {
        requests.push(request)
        throw new Error('worker transport failed')
      },
      async readVisibleProjection(request) {
        reads.push(request)
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
          window: request.window,
          cells: [],
        }
      },
    })
    const { container } = renderEntrypoints(store, backend)
    await waitForEntrypointsEnabled(container)

    clickMenuSort(container, 'desc')
    await waitFor(() =>
      expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown'),
    )

    // One transport, no projection refresh, and no refresh-retry affordance:
    // a sort that never confirmed must not pretend the view is stale.
    expect(requests).toHaveLength(1)
    expect(reads).toHaveLength(0)
    expect(
      container
        .querySelector('[data-testid="spreadsheet-toolbar"]')
        ?.getAttribute('data-filter-sort-status'),
    ).toBe('outcome-unknown')
    expect(container.textContent).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
    expect(container.querySelector('[data-testid="toolbar-filter-sort-refresh-retry"]')).toBeNull()
    expect(container.querySelector('[data-testid="menu-bar-filter-sort-refresh-retry"]')).toBeNull()

    // Unlike the retired display entrypoint (which pinned a non-resendable
    // ticket), the physical command releases the single lane once the engine
    // transport itself fails, so the user can retry the data mutation.
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(false)
  })

  it('retries only the captured-sheet projection after an acknowledged refresh failure', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 1)
    seedProjection(store, 'sheet-a')
    const requests: SortRangeRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async sortRange(request) {
        requests.push(request)
        return appliedSortResult(request)
      },
      async readVisibleProjection(request) {
        reads.push(request)
        if (reads.length === 1) throw new Error('projection failed')
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 2,
          window: request.window,
          cells: [],
        }
      },
    })
    const { container } = renderEntrypoints(store, backend)
    await waitForEntrypointsEnabled(container)

    clickToolbarSort(container, 'asc')
    await waitFor(() =>
      expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed'),
    )
    expect(requests).toHaveLength(1)
    expect(reads.map((read) => read.sheetId)).toEqual(['sheet-a'])
    expect(requests[0]!.keys).toEqual([{ col: 1, direction: 'asc' }])

    setTarget(store, 'sheet-b', 2)
    const retry = button(container, 'toolbar-filter-sort-refresh-retry')
    expect(retry).not.toBeNull()
    fireEvent.click(retry)
    await waitFor(() => expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle'))

    expect(requests).toHaveLength(1)
    expect(reads.map((read) => read.sheetId)).toEqual(['sheet-a', 'sheet-a'])
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(false)
  })

  it('hides both sort entrypoints when the backend exposes no sortRange port', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 2)
    const backend = createBackend({ sortRange: undefined, resolveDataEdge: undefined })
    const { container } = renderEntrypoints(store, backend)
    await waitFor(() => expect(button(container, 'toolbar-btn-filter').disabled).toBe(false))

    // Fail-closed (#24): no physical-sort port → no sort entry anywhere.
    expect(container.querySelector('[data-testid="toolbar-btn-sort"]')).toBeNull()
    openDataMenu(container)
    expect(container.querySelector('[data-testid="menu-bar-item-data.sortAsc"]')).toBeNull()
    expect(container.querySelector('[data-testid="menu-bar-item-data.sortDesc"]')).toBeNull()
    expect(button(container, 'menu-bar-item-data.filter').disabled).toBe(false)
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
  })
})
