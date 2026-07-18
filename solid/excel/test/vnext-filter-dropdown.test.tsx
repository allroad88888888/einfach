/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  FilterSortMutationResult,
  SetFilterSortRequest,
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
  setFilterSortAtom,
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
    expect(button(container, 'filter-sort-asc')).not.toBeNull()
    expect(button(container, 'filter-clear')).not.toBeNull()
  })

  it('disables mutation controls and explains a missing setFilterSort port', async () => {
    const store = createStore()
    const backend = createFakeBackend({ setFilterSort: undefined })
    openDropdown(store)

    const { container } = renderDropdown(store, backend)

    await waitFor(() => {
      expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked')
      expect(button(container, 'filter-sort-asc').disabled).toBe(true)
    })
    expect(container.querySelector('[data-testid="filter-error-text"]')?.textContent).toBe(
      FILTER_SORT_CAPABILITY_ERROR,
    )
    expect(button(container, 'filter-close').disabled).toBe(false)
    fireEvent.click(button(container, 'filter-sort-asc'))
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()
  })

  it('commits a sort only after a strict matching acknowledgement', async () => {
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

    fireEvent.click(button(container, 'filter-sort-asc'))

    await waitFor(() => {
      expect(calls).toHaveLength(1)
      expect(button(container, 'filter-sort-asc').disabled).toBe(true)
    })
    expect(store.getter(filterSortStateAtom)['sheet-1']).toBeUndefined()

    ack.resolve({
      sheetId: calls[0]!.sheetId,
      requestId: calls[0]!.requestId,
      revision: 1,
    })
    await waitFor(() => {
      expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
        { colIndex: 0, direction: 'asc' },
      ])
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

    const asc = button(container, 'filter-sort-asc')
    fireEvent.click(asc)
    fireEvent.click(asc)

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
      state: { rules: [], directives: [{ colIndex: 3, direction: 'desc' }] },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)
    const draftBefore = store.getter(filterSortDraftAtom)

    fireEvent.click(button(container, 'filter-sort-asc'))

    await waitFor(() => {
      const text = container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain(FILTER_SORT_ACKNOWLEDGEMENT_ERROR)
      expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    })
    fireEvent.click(button(container, 'filter-sort-asc'))
    expect(calls).toBe(1)
    expect(button(container, 'filter-close').disabled).toBe(true)
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 3, direction: 'desc' },
    ])
    expect(store.getter(filterSortDraftAtom)).toEqual(draftBefore)
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

    fireEvent.click(button(container, 'filter-sort-asc'))
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

    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 0, direction: 'asc' },
    ])
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
      state: { rules: [], directives: [{ colIndex: 4, direction: 'desc' }] },
    })
    openDropdown(store)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)
    const draftBefore = store.getter(filterSortDraftAtom)

    fireEvent.click(button(container, 'filter-sort-asc'))

    await waitFor(() => {
      const text = container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain('backend exploded')
    })
    expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
      { colIndex: 4, direction: 'desc' },
    ])
    expect(store.getter(filterSortDraftAtom)).toEqual(draftBefore)
  })

  it('makes the selected column primary while preserving sort tie-breakers', async () => {
    const store = createStore()
    const calls: SetFilterSortRequest[] = []
    const backend = createFakeBackend({
      async setFilterSort(req) {
        calls.push(req)
        return { sheetId: req.sheetId, requestId: req.requestId, revision: 1 }
      },
    })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: {
        rules: [{ kind: 'equals', colIndex: 4, value: 'open' }],
        directives: [
          { colIndex: 0, direction: 'desc' },
          { colIndex: 2, direction: 'asc' },
        ],
      },
    })
    openDropdown(store, 1)
    const { container } = renderDropdown(store, backend)
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-sort-asc'))

    const expected = [
      { colIndex: 1, direction: 'asc' },
      { colIndex: 0, direction: 'desc' },
      { colIndex: 2, direction: 'asc' },
    ]
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual(expected),
    )
    expect(calls[0]!.directives).toEqual(expected)
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

  it('clears filter and sort independently, then clears the whole column', async () => {
    const store = createStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: {
        rules: [
          { kind: 'equals', colIndex: 1, value: 'x' },
          { kind: 'equals', colIndex: 2, value: 'y' },
        ],
        directives: [
          { colIndex: 1, direction: 'asc' },
          { colIndex: 2, direction: 'desc' },
        ],
      },
    })
    openDropdown(store, 1)
    const { container } = renderDropdown(store, createFakeBackend())
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-clear-filter'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']).toEqual({
        rules: [{ kind: 'equals', colIndex: 2, value: 'y' }],
        directives: [
          { colIndex: 1, direction: 'asc' },
          { colIndex: 2, direction: 'desc' },
        ],
      }),
    )
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-clear-sort'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
        { colIndex: 2, direction: 'desc' },
      ]),
    )
    await waitForEditing(store)

    fireEvent.click(button(container, 'filter-clear'))
    await waitFor(() =>
      expect(store.getter(filterSortStateAtom)['sheet-1']).toEqual({
        rules: [{ kind: 'equals', colIndex: 2, value: 'y' }],
        directives: [{ colIndex: 2, direction: 'desc' }],
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

    fireEvent.click(button(container, 'filter-sort-asc'))

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

    fireEvent.click(button(a.container, 'filter-sort-asc'))
    fireEvent.click(button(b.container, 'filter-sort-asc'))

    await waitFor(() => {
      const text = a.container.querySelector('[data-testid="filter-error-text"]')?.textContent
      expect(text).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(text).toContain('A failed')
    })
    await waitFor(() =>
      expect(storeB.getter(filterSortStateAtom)['sheet-1']?.directives).toEqual([
        { colIndex: 0, direction: 'asc' },
      ]),
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
