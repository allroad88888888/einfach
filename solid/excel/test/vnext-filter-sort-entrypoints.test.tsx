/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  FilterSortMutationResult,
  SetFilterSortRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  FILTER_SORT_OUTCOME_UNKNOWN_ERROR,
  createVisibleProjectionRequest,
  filterDropdownAtom,
  filterSortEntrypointStateAtom,
  filterSortStateAtom,
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
      }
    },
    ...overrides,
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
    const acknowledgement = deferred<FilterSortMutationResult>()
    const requests: SetFilterSortRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async setFilterSort(request) {
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

    const request = requests[0]!
    acknowledgement.resolve({
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 2,
    })
    await waitFor(() => expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle'))

    expect(store.getter(filterSortStateAtom)['sheet-a']?.directives).toEqual([
      { colIndex: 1, direction: 'asc' },
    ])
    expect(reads.map((read) => read.sheetId)).toEqual(['sheet-a'])
  })

  it('makes an acknowledgement mismatch inert without refresh or transport retry', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 4)
    seedProjection(store, 'sheet-a')
    const requests: SetFilterSortRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async setFilterSort(request) {
        requests.push(request)
        return { sheetId: 'sheet-b', requestId: request.requestId, revision: 2 }
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

    expect(requests).toHaveLength(1)
    expect(reads).toHaveLength(0)
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(true)
    expect(
      container
        .querySelector('[data-testid="spreadsheet-toolbar"]')
        ?.getAttribute('data-filter-sort-status'),
    ).toBe('outcome-unknown')
    expect(container.textContent).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
    expect(container.querySelector('[data-testid="toolbar-filter-sort-refresh-retry"]')).toBeNull()
    expect(container.querySelector('[data-testid="menu-bar-filter-sort-refresh-retry"]')).toBeNull()

    openDataMenu(container)
    const menuSort = button(container, 'menu-bar-item-data.sortAsc')
    expect(menuSort.disabled).toBe(true)
    fireEvent.click(menuSort)
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(reads).toHaveLength(0)
  })

  it('retries only the captured-sheet projection after an acknowledged refresh failure', async () => {
    const store = createStore()
    setTarget(store, 'sheet-a', 1)
    seedProjection(store, 'sheet-a')
    const requests: SetFilterSortRequest[] = []
    const reads: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async setFilterSort(request) {
        requests.push(request)
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 2 }
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
    expect(store.getter(filterSortStateAtom)['sheet-a']?.directives).toEqual([
      { colIndex: 1, direction: 'asc' },
    ])

    setTarget(store, 'sheet-b', 2)
    const retry = button(container, 'toolbar-filter-sort-refresh-retry')
    expect(retry).not.toBeNull()
    fireEvent.click(retry)
    await waitFor(() => expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle'))

    expect(requests).toHaveLength(1)
    expect(reads.map((read) => read.sheetId)).toEqual(['sheet-a', 'sheet-a'])
    expect(button(container, 'toolbar-btn-sort').disabled).toBe(false)
  })
})
