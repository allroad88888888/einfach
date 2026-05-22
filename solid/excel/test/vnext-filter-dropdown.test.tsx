/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  createVisibleProjectionRequest,
  filterDropdownAtom,
  filterSortStateAtom,
  openFilterDropdownAtom,
  setFilterSortAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetFilterDropdown } from '../src-vnext/filter-sort'

afterEach(cleanup)

function createFakeBackend(overrides: Partial<SpreadsheetBackend> = {}): SpreadsheetBackend {
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
    ...overrides,
  }
}

describe('vNext SpreadsheetFilterDropdown', () => {
  it('does not render when dropdown is closed', () => {
    const store = createStore()
    const backend = createFakeBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="filter-dropdown"]')).toBeNull()
  })

  it('renders when dropdown is open', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 2 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    const el = container.querySelector('[data-testid="filter-dropdown"]')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('data-sheet-id')).toBe('sheet-1')
    expect(el?.getAttribute('data-col-index')).toBe('2')
    expect(container.querySelector('[data-testid="filter-sort-asc"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="filter-sort-desc"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="filter-clear"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="filter-add-equals"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="filter-equals-input"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="filter-close"]')).not.toBeNull()
  })

  it('sort asc click dispatches setFilterSortAtom and calls backend.setFilterSort', () => {
    const store = createStore()
    const setFilterSortCalls: unknown[] = []
    const backend = createFakeBackend({
      async setFilterSort(req) {
        setFilterSortCalls.push(req)
        return { sheetId: req.sheetId, requestId: undefined, revision: 1 }
      },
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)

    const state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.directives).toEqual([{ colIndex: 0, direction: 'asc' }])
    expect(setFilterSortCalls).toHaveLength(1)
    expect((setFilterSortCalls[0] as { directives: unknown[] }).directives).toEqual([
      { colIndex: 0, direction: 'asc' },
    ])
  })

  it('sort desc click dispatches desc directive', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-sort-desc"]') as HTMLElement)

    const state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.directives).toEqual([{ colIndex: 1, direction: 'desc' }])
  })

  it('clear filter removes the column rule', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 3 })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: {
        rules: [
          { kind: 'equals', colIndex: 3, value: 'hello' },
          { kind: 'equals', colIndex: 5, value: 'world' },
        ],
        directives: [],
      },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-clear"]') as HTMLElement)

    const state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.rules).toEqual([{ kind: 'equals', colIndex: 5, value: 'world' }])
  })

  it('clear filter also removes the sort directive on the same column', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 3 })
    store.setter(setFilterSortAtom, {
      sheetId: 'sheet-1',
      state: {
        rules: [{ kind: 'equals', colIndex: 3, value: 'hello' }],
        directives: [
          { colIndex: 3, direction: 'asc' },
          { colIndex: 5, direction: 'desc' },
        ],
      },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-clear"]') as HTMLElement)

    const state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.rules).toEqual([])
    expect(state['sheet-1']?.directives).toEqual([{ colIndex: 5, direction: 'desc' }])
  })

  it('controlled equals input applies on Enter and on button click', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 4 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    const input = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.tagName).toBe('INPUT')

    fireEvent.input(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    let state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.rules).toEqual([{ kind: 'equals', colIndex: 4, value: 'alpha' }])

    const input2 = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    fireEvent.input(input2, { target: { value: 'beta' } })
    fireEvent.click(container.querySelector('[data-testid="filter-add-equals"]') as HTMLElement)

    state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.rules).toEqual([{ kind: 'equals', colIndex: 4, value: 'beta' }])
  })

  it('refreshes the current visible projection after applying a filter', async () => {
    const store = createStore()
    const readVisibleProjectionCalls: unknown[] = []
    const window = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 }
    const initialRequest = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 1,
      reason: 'viewport',
      window,
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: initialRequest,
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 1,
        revision: 1,
        window,
        cells: [{ row: 1, col: 0, displayValue: 'South' }],
      },
      error: undefined,
    })
    const backend = createFakeBackend({
      async setFilterSort(req) {
        return { sheetId: req.sheetId, requestId: undefined, revision: 2 }
      },
      async readVisibleProjection(req) {
        readVisibleProjectionCalls.push(req)
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

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    const input = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    fireEvent.input(input, { target: { value: '120' } })
    fireEvent.click(container.querySelector('[data-testid="filter-add-equals"]') as HTMLElement)

    await waitFor(() => {
      const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
      expect(snapshot.result?.revision).toBe(2)
      expect(snapshot.result?.cells).toEqual([{ row: 1, col: 0, displayValue: 'North' }])
    })
    expect(readVisibleProjectionCalls).toHaveLength(1)
  })

  it('surfaces backend error in filter-error-text', async () => {
    const store = createStore()
    const backend = createFakeBackend({
      async setFilterSort() {
        throw new Error('backend exploded')
      },
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)

    await waitFor(() => {
      const errorEl = container.querySelector('[data-testid="filter-error-text"]')
      expect(errorEl).not.toBeNull()
      expect(errorEl!.textContent).toBe('backend exploded')
    })
  })

  it('clears error text after a subsequent successful apply', async () => {
    const store = createStore()
    let shouldFail = true
    const backend = createFakeBackend({
      async setFilterSort(req) {
        if (shouldFail) throw new Error('first failed')
        return { sheetId: req.sheetId, requestId: undefined, revision: 1 }
      },
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="filter-error-text"]')).not.toBeNull()
    })

    shouldFail = false
    fireEvent.click(container.querySelector('[data-testid="filter-sort-desc"]') as HTMLElement)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="filter-error-text"]')).toBeNull()
    })
  })

  it('column index 0 still renders dropdown attributes correctly', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    const el = container.querySelector('[data-testid="filter-dropdown"]')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('data-col-index')).toBe('0')
  })

  it('equals input resets when switching to a different column', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 1 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    const input = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    fireEvent.input(input, { target: { value: 'leftover' } })

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 2 })

    const input2 = container.querySelector(
      '[data-testid="filter-equals-input"]',
    ) as HTMLInputElement
    expect(input2.value).toBe('')

    fireEvent.click(container.querySelector('[data-testid="filter-add-equals"]') as HTMLElement)
    const state = store.getter(filterSortStateAtom)
    expect(state['sheet-1']?.rules).toEqual([{ kind: 'equals', colIndex: 2, value: '' }])
  })

  it('stale apply error does not overwrite a later success', async () => {
    const store = createStore()
    let firstReject: ((err: unknown) => void) | null = null
    let secondResolve: (() => void) | null = null
    let call = 0
    const backend = createFakeBackend({
      setFilterSort(req) {
        call += 1
        if (call === 1) {
          return new Promise<{ sheetId: string; requestId?: undefined; revision: number }>(
            (_resolve, reject) => {
              firstReject = reject
            },
          )
        }
        return new Promise<{ sheetId: string; requestId?: undefined; revision: number }>(
          (resolve) => {
            secondResolve = () => resolve({ sheetId: req.sheetId, revision: 2 })
          },
        )
      },
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-testid="filter-sort-desc"]') as HTMLElement)

    secondResolve!()
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[data-testid="filter-error-text"]')).toBeNull()

    firstReject!(new Error('stale failure'))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[data-testid="filter-error-text"]')).toBeNull()
  })

  it('two providers do not interfere with each other apply errors', async () => {
    const storeA = createStore()
    const storeB = createStore()
    let rejectA: ((e: unknown) => void) | null = null
    const backendA = createFakeBackend({
      setFilterSort() {
        return new Promise((_resolve, reject) => {
          rejectA = reject
        })
      },
    })
    const backendB = createFakeBackend({
      async setFilterSort(req) {
        return { sheetId: req.sheetId, requestId: undefined, revision: 1 }
      },
    })

    storeA.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    storeA.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })
    storeB.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    storeB.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })

    const a = render(() => (
      <SpreadsheetUiProvider backend={backendA} store={storeA}>
        <SpreadsheetFilterDropdown data-testid="fdrop-a" />
      </SpreadsheetUiProvider>
    ))
    const b = render(() => (
      <SpreadsheetUiProvider backend={backendB} store={storeB}>
        <SpreadsheetFilterDropdown data-testid="fdrop-b" />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(a.container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)
    fireEvent.click(b.container.querySelector('[data-testid="filter-sort-asc"]') as HTMLElement)

    await waitFor(() => {
      expect(b.container.querySelector('[data-testid="filter-error-text"]')).toBeNull()
    })

    rejectA!(new Error('A failed'))
    await waitFor(() => {
      const errA = a.container.querySelector('[data-testid="filter-error-text"]')
      expect(errA).not.toBeNull()
      expect(errA!.textContent).toBe('A failed')
    })
    expect(b.container.querySelector('[data-testid="filter-error-text"]')).toBeNull()
  })

  it('close button sets dropdown to closed', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })
    expect(store.getter(filterDropdownAtom).status).toBe('open')

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="filter-close"]') as HTMLElement)

    expect(store.getter(filterDropdownAtom).status).toBe('closed')
    expect(container.querySelector('[data-testid="filter-dropdown"]')).toBeNull()
  })
})
