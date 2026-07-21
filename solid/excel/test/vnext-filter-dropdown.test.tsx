/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  FilterSortMutationResult,
  ResolveDataEdgeRequest,
  SetFilterSortRequest,
  SortRangeRequest,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  FILTER_SORT_ACKNOWLEDGEMENT_ERROR,
  FILTER_SORT_CAPABILITY_ERROR,
  FILTER_SORT_OUTCOME_UNKNOWN_ERROR,
  createVisibleProjectionRequest,
  filterDropdownAtom,
  filterSortDraftAtom,
  filterSortLifecycleAtom,
  filterSortStateAtom,
  openFilterDropdownAtom,
  selectionAtom,
  setFilterSortAtom,
  setViewportFilterHiddenRowsAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetFilterDropdown } from '../src-vnext/filter-sort'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function createFakeBackend(overrides: Partial<SpreadsheetBackend> = {}): SpreadsheetBackend {
  return {
    async readVisibleProjection(req) {
      return {
        kind: 'visible-window',
        sheetId: req.sheetId,
        requestId: req.requestId,
        revision: 1,
        window: req.window,
        cells: [],
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async setFilterSort(req) {
      return { sheetId: req.sheetId, requestId: req.requestId, revision: 1 }
    },
    ...overrides,
  }
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

function renderDropdown(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetFilterDropdown />
    </SpreadsheetUiProvider>
  ))
}

function openDropdown(store: ReturnType<typeof createStore>, colIndex = 0) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex })
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
}

async function waitForEditing(store: ReturnType<typeof createStore>) {
  await waitFor(() => expect(store.getter(filterSortLifecycleAtom).status).toBe('editing'))
}

/**
 * Drive one filter mutation through the dropdown. Sort is no longer a
 * `setFilterSort` payload (#24 retired the display permutation), so the filter
 * lifecycle tests use an equals draft as their transport vehicle.
 */
function applyEqualsDraft(container: HTMLElement, value: string) {
  const condition = container.querySelector(
    '[data-testid="filter-condition-kind"]',
  ) as HTMLSelectElement
  fireEvent.change(condition, { target: { value: 'equals' } })
  fireEvent.input(container.querySelector('[data-testid="filter-equals-input"]')!, {
    target: { value },
  })
  fireEvent.click(button(container, 'filter-add-equals'))
}

const equalsRule = (colIndex: number, value: string) =>
  ({ kind: 'equals', colIndex, value }) as const

describe('vNext SpreadsheetFilterDropdown', () => {
  it('does not render when dropdown is closed', () => {
    const { container } = renderDropdown(createStore(), createFakeBackend())

    expect(container.querySelector('[data-testid="filter-dropdown"]')).toBeNull()
  })

  it('renders an open Core-owned draft with no implicit condition', async () => {
    const store = createStore()
    openDropdown(store, 2)

    const { container } = renderDropdown(store, createFakeBackend())
    await waitForEditing(store)

    const dropdown = container.querySelector('[data-testid="filter-dropdown"]')
    const condition = container.querySelector(
      '[data-testid="filter-condition-kind"]',
    ) as HTMLSelectElement
    expect(dropdown?.getAttribute('data-sheet-id')).toBe('sheet-1')
    expect(dropdown?.getAttribute('data-col-index')).toBe('2')
    expect(dropdown?.getAttribute('data-filter-sort-status')).toBe('editing')
    expect(condition.value).toBe('none')
    expect(container.querySelector('[data-testid="filter-equals-input"]')).toBeNull()
    // The fake backend exposes no `sortRange` port, so the sort section is
    // withheld entirely (#24) — only the filter controls render.
    expect(container.querySelector('[data-testid="filter-sort-section"]')).toBeNull()
    expect(button(container, 'filter-clear')).not.toBeNull()
  })

  it('disables mutation controls and explains a missing setFilterSort port', async () => {
    const store = createStore()
    const backend = createFakeBackend({ setFilterSort: undefined })
    openDropdown(store)

    const { container } = renderDropdown(store, backend)

    await waitFor(() => {
      expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked')
      expect(button(container, 'filter-add-equals').disabled).toBe(true)
    })
    expect(container.querySelector('[data-testid="filter-error-text"]')?.textContent).toBe(
      FILTER_SORT_CAPABILITY_ERROR,
    )
    expect(button(container, 'filter-close').disabled).toBe(false)
    fireEvent.click(button(container, 'filter-add-equals'))
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
  })

  it('commits a filter only after a strict matching acknowledgement', async () => {
    const store = createStore()
    const calls: SetFilterSortRequest[] = []
    const ack = deferred<FilterSortMutationResult>()
    const backend = createFakeBackend({
      setFilterSort(req) {
        calls.push(req)
        return ack.promise
      },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'alpha')

    await waitFor(() => {
      expect(calls).toHaveLength(1)
      expect(button(container, 'filter-add-equals').disabled).toBe(true)
    })
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()

    ack.resolve({
      sheetId: calls[0]!.sheetId,
      requestId: calls[0]!.requestId,
      revision: 1,
    })
    await waitFor(() => {
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(0, 'alpha')])
      expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    })
  })

  it('blocks a same-session double click while the first mutation is pending', async () => {
    const store = createStore()
    const calls: SetFilterSortRequest[] = []
    const ack = deferred<FilterSortMutationResult>()
    const backend = createFakeBackend({
      setFilterSort(req) {
        calls.push(req)
        return ack.promise
      },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'alpha')
    fireEvent.click(button(container, 'filter-add-equals'))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(store.getter(filterSortLifecycleAtom).status).toBe('pending')
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()

    ack.resolve({ sheetId: 'sheet-1', requestId: calls[0]!.requestId, revision: 1 })
    await waitForEditing(store)
  })

  it('retains a mismatched acknowledgement without committing or resending', async () => {
    const store = createStore()
    let calls = 0
    const backend = createFakeBackend({
      async setFilterSort(req) {
        calls += 1
        return { sheetId: req.sheetId, requestId: (req.requestId ?? 0) + 1, revision: 1 }
      },
    })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [equalsRule(3, 'seed')] },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'alpha')

    await waitFor(() => {
      const text = container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain(FILTER_SORT_ACKNOWLEDGEMENT_ERROR)
      expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    })
    fireEvent.click(button(container, 'filter-add-equals'))
    expect(calls).toBe(1)
    expect(button(container, 'filter-close').disabled).toBe(true)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(3, 'seed')])
  })

  it('keeps close and reopen inert until the active request settles', async () => {
    const store = createStore()
    const calls: SetFilterSortRequest[] = []
    const firstAck = deferred<FilterSortMutationResult>()
    const backend = createFakeBackend({
      setFilterSort(req) {
        calls.push(req)
        return firstAck.promise
      },
    })
    openDropdown(store, 0)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'alpha')
    await waitFor(() => expect(calls).toHaveLength(1))
    const sessionId = store.getter(filterSortDraftAtom).sessionId
    expect(button(container, 'filter-close').disabled).toBe(true)
    fireEvent.click(button(container, 'filter-close'))
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })
    expect(store.getter(filterSortDraftAtom).sessionId).toBe(sessionId)
    expect(store.getter(filterDropdownAtom)).toMatchObject({
      status: 'open',
      sheetId: 'sheet-1',
      colIndex: 0,
    })

    firstAck.resolve({ sheetId: 'sheet-1', requestId: calls[0]!.requestId, revision: 1 })
    await waitForEditing(store)

    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(0, 'alpha')])
    expect(store.getter(filterDropdownAtom)).toMatchObject({
      status: 'open',
      sheetId: 'sheet-1',
      colIndex: 0,
    })
  })

  it('keeps committed state unchanged on transport rejection and exposes the error', async () => {
    const store = createStore()
    const backend = createFakeBackend({
      async setFilterSort() {
        throw new Error('backend exploded')
      },
    })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [equalsRule(4, 'seed')] },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'alpha')

    await waitFor(() => {
      const text = container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain('backend exploded')
    })
    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(4, 'seed')])
  })

  it('applies projected value-list selection only after Apply', async () => {
    const store = createStore()
    const window = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 }
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'viewport',
        window,
      }),
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 1,
        window,
        cells: [
          { row: 0, col: 0, displayValue: 'Region' },
          { row: 1, col: 0, displayValue: 'North' },
          { row: 2, col: 0, displayValue: 'South' },
          { row: 3, col: 0, displayValue: 'Central' },
        ],
      },
      error: undefined,
    })
    openDropdown(store)
    const { container } = renderDropdown(store, createFakeBackend())
    await waitForEditing(store)
    await waitFor(() =>
      expect(container.querySelectorAll('.filter-value-option[data-filter-value]')).toHaveLength(3),
    )

    fireEvent.input(container.querySelector('[data-testid="filter-search-input"]')!, {
      target: { value: 'south' },
    })
    expect(container.querySelectorAll('.filter-value-option[data-filter-value]')).toHaveLength(1)
    fireEvent.click(container.querySelector('[data-testid="filter-value-South"]') as HTMLElement)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    fireEvent.click(button(container, 'filter-add-equals'))

    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
        { kind: 'list', colIndex: 0, values: ['Central', 'North'] },
      ]),
    )
  })

  it('applies equals, contains, and range drafts through the Core command', async () => {
    const store = createStore()
    openDropdown(store, 1)
    const { container } = renderDropdown(store, createFakeBackend())
    await waitForEditing(store)
    const condition = container.querySelector(
      '[data-testid="filter-condition-kind"]',
    ) as HTMLSelectElement

    fireEvent.change(condition, { target: { value: 'equals' } })
    const equalsInput = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    fireEvent.input(equalsInput, { target: { value: 'alpha' } })
    fireEvent.keyDown(equalsInput, { key: 'Enter' })
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
        { kind: 'equals', colIndex: 1, value: 'alpha' },
      ]),
    )
    await waitForEditing(store)

    fireEvent.change(condition, { target: { value: 'contains' } })
    fireEvent.input(container.querySelector('[data-testid="filter-contains-input"]')!, {
      target: { value: 'west' },
    })
    fireEvent.click(button(container, 'filter-add-equals'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
        { kind: 'contains', colIndex: 1, value: 'west' },
      ]),
    )
    await waitForEditing(store)

    fireEvent.change(condition, { target: { value: 'range' } })
    fireEvent.input(container.querySelector('[data-testid="filter-range-min-input"]')!, {
      target: { value: '10' },
    })
    fireEvent.input(container.querySelector('[data-testid="filter-range-max-input"]')!, {
      target: { value: '20' },
    })
    fireEvent.click(button(container, 'filter-add-equals'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
        { kind: 'range', colIndex: 1, min: 10, max: 20 },
      ]),
    )
  })

  it('clears the column filter, then clears the whole column', async () => {
    const store = createStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [equalsRule(1, 'x'), equalsRule(2, 'y')] },
    })
    openDropdown(store, 1)
    const { container } = renderDropdown(store, createFakeBackend())
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-clear-filter'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']).toEqual({
        rules: [equalsRule(2, 'y')],
      }),
    )
    await waitForEditing(store)

    // `clear-column` now collapses onto the same rules-only semantics: there
    // is no per-column sort state left to clear (#24).
    fireEvent.click(button(container, 'filter-clear'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']).toEqual({
        rules: [equalsRule(2, 'y')],
      }),
    )
  })

  it('refreshes the visible projection after acknowledgement', async () => {
    const store = createStore()
    const reads: unknown[] = []
    const window = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 }
    seedReadyVisibleProjection(store, {
      status: 'ready',
      request: createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 1,
        reason: 'viewport',
        window,
      }),
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 1,
        window,
        cells: [],
      },
      error: undefined,
    })
    const backend = createFakeBackend({
      async setFilterSort(req) {
        return { sheetId: req.sheetId, requestId: req.requestId, revision: 2 }
      },
      async readVisibleProjection(req) {
        reads.push(req)
        return {
          kind: 'visible-window',
          sheetId: req.sheetId,
          requestId: req.requestId,
          revision: 2,
          window: req.window,
          cells: [{ row: 1, col: 0, displayValue: 'North' }],
        }
      },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    applyEqualsDraft(container, 'North')

    await waitFor(() => {
      expect(store.getter(spreadsheetProjectionSnapshotAtom).result?.revision).toBe(2)
      expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    })
    expect(reads).toHaveLength(1)
  })

  it('isolates errors between two provider stores', async () => {
    const storeA = createStore()
    const storeB = createStore()
    const backendA = createFakeBackend({
      async setFilterSort() {
        throw new Error('A failed')
      },
    })
    openDropdown(storeA)
    openDropdown(storeB)
    const a = renderDropdown(storeA, backendA)
    const b = renderDropdown(storeB, createFakeBackend())
    await Promise.all([waitForEditing(storeA), waitForEditing(storeB)])

    applyEqualsDraft(a.container, 'alpha')
    applyEqualsDraft(b.container, 'beta')

    await waitFor(() => {
      const text = a.container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain('A failed')
    })
    await waitFor(() =>
      expect(storeB.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(0, 'beta')]),
    )
    expect(b.container.querySelector('[data-testid="filter-error-text"]')).toBeNull()
  })

  it('closes without requiring mutation capability', async () => {
    const store = createStore()
    openDropdown(store)
    const { container } = renderDropdown(store, createFakeBackend({ setFilterSort: undefined }))
    await waitFor(() => expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked'))

    fireEvent.click(button(container, 'filter-close'))

    expect(store.getter(filterDropdownAtom).status).toBe('closed')
    expect(store.getter(filterSortLifecycleAtom).status).toBe('closed')
    expect(container.querySelector('[data-testid="filter-dropdown"]')).toBeNull()
  })
})

describe('vNext SpreadsheetFilterDropdown — physical sort (design-engine-sort S6)', () => {
  function createPhysicalBackend(
    sortRequests: SortRangeRequest[],
    filterRequests: SetFilterSortRequest[],
    lastRow = 5,
    lastCol = 3,
  ): SpreadsheetBackend {
    return createFakeBackend({
      async setFilterSort(req) {
        filterRequests.push(req)
        return { sheetId: req.sheetId, requestId: req.requestId, revision: 1 }
      },
      async resolveDataEdge(req: ResolveDataEdgeRequest) {
        return {
          sheetId: req.sheetId,
          requestId: req.requestId,
          target: req.direction === 'down' ? { row: lastRow, col: 0 } : { row: 0, col: lastCol },
        }
      },
      async sortRange(req: SortRangeRequest) {
        sortRequests.push(req)
        return {
          kind: 'sort-range',
          sheetId: req.sheetId,
          applied: true,
          movedRows: 3,
          movedCells: 12,
          affectedRange: req.range,
          requestId: req.requestId,
          revision: 2,
        }
      },
    })
  }

  it('dispatches a physical sort keyed by the dropdown column and closes the dropdown', async () => {
    const store = createStore()
    const sortRequests: SortRangeRequest[] = []
    const filterRequests: SetFilterSortRequest[] = []
    // Selection sits on column 0; the dropdown targets column 2. The physical
    // sort must key on the dropdown's column, not the selection's.
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 0 },
      focus: { row: 2, col: 0 },
    })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 2 })
    const backend = createPhysicalBackend(sortRequests, filterRequests)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-sort-desc'))

    await waitFor(() => expect(sortRequests).toHaveLength(1))
    expect(sortRequests[0]).toMatchObject({
      kind: 'sort-range',
      sheetId: 'sheet-1',
      keys: [{ col: 2, direction: 'desc' }],
      range: { rowStart: 1, rowEnd: 5, colStart: 0, colEnd: 3 },
    })
    // The retired display permutation is never written.
    expect(filterRequests).toHaveLength(0)
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
    // Excel closes the AutoFilter menu once a sort applies.
    await waitFor(() => expect(store.getter(filterDropdownAtom).status).toBe('closed'))
  })

  it('carries filter-hidden rows in excludedRows, read from the canonical set', async () => {
    const store = createStore()
    const sortRequests: SortRangeRequest[] = []
    const filterRequests: SetFilterSortRequest[] = []
    // Filter is active on column 0 and the host reported source rows 2 and 4 as
    // filtered out. UI core holds that answer directly now — it is no longer
    // reverse-engineered from gaps in the projected rows, so no projection is
    // needed here and rows outside the viewport are covered just as well.
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: { rules: [equalsRule(0, 'x')] },
    })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [2, 4] })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })
    const backend = createPhysicalBackend(sortRequests, filterRequests)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-sort-asc'))

    await waitFor(() => expect(sortRequests).toHaveLength(1))
    expect(sortRequests[0].keys).toEqual([{ col: 1, direction: 'asc' }])
    expect(sortRequests[0].excludedRows).toEqual([2, 4])
  })

  it('withholds the whole sort section when the host has no sortRange port', async () => {
    const store = createStore()
    const filterRequests: SetFilterSortRequest[] = []
    // No sortRange port → the host cannot sort at all (#24, fail-closed).
    const backend = createFakeBackend({
      async setFilterSort(req) {
        filterRequests.push(req)
        return { sheetId: req.sheetId, requestId: req.requestId, revision: 1 }
      },
    })
    openDropdown(store, 3)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    expect(container.querySelector('[data-testid="filter-sort-section"]')).toBeNull()
    expect(container.querySelector('[data-testid="filter-sort-asc"]')).toBeNull()
    expect(container.querySelector('[data-testid="filter-sort-desc"]')).toBeNull()
    // Filtering still works on the same host — only sort is withheld.
    applyEqualsDraft(container, 'x')
    await waitFor(() => expect(filterRequests).toHaveLength(1))
    expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([equalsRule(3, 'x')])
  })
})
