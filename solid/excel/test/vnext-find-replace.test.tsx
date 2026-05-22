/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  ReplaceMatchesRequest,
  ReplaceMatchesResult,
  SearchRangeRequest,
  SearchRangeResult,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  advanceFindCursorAtom,
  findReplaceCursorAtom,
  findReplaceOpenAtom,
  selectionAtom,
  setFindMatchesAtom,
  setViewportMetricsAtom,
  viewportMetricsAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetFindReplaceDialog } from '../src-vnext/find-replace'

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

function createSearchBackend(
  searchSpy: (req: SearchRangeRequest) => Promise<SearchRangeResult>,
  replaceSpy?: (req: ReplaceMatchesRequest) => Promise<ReplaceMatchesResult>,
): SpreadsheetBackend {
  return {
    ...createBaseBackend(),
    searchRange: searchSpy,
    replaceMatches: replaceSpy,
  }
}

function getEls(container: HTMLElement) {
  return {
    dialog: container.querySelector('[data-testid="find-replace-dialog"]'),
    needle: container.querySelector('[data-testid="find-needle-input"]') as HTMLInputElement | null,
    replacement: container.querySelector(
      '[data-testid="find-replacement-input"]',
    ) as HTMLInputElement | null,
    caseSensitive: container.querySelector(
      '[data-testid="find-opt-case-sensitive"]',
    ) as HTMLInputElement | null,
    wholeMatch: container.querySelector(
      '[data-testid="find-opt-whole-match"]',
    ) as HTMLInputElement | null,
    regex: container.querySelector('[data-testid="find-opt-regex"]') as HTMLInputElement | null,
    formulas: container.querySelector(
      '[data-testid="find-opt-formulas"]',
    ) as HTMLInputElement | null,
    scopeSelect: container.querySelector(
      '[data-testid="find-scope-select"]',
    ) as HTMLSelectElement | null,
    findNext: container.querySelector('[data-testid="find-next-button"]') as HTMLButtonElement | null,
    findPrev: container.querySelector('[data-testid="find-prev-button"]') as HTMLButtonElement | null,
    replace: container.querySelector('[data-testid="replace-button"]') as HTMLButtonElement | null,
    replaceAll: container.querySelector(
      '[data-testid="replace-all-button"]',
    ) as HTMLButtonElement | null,
    close: container.querySelector('[data-testid="find-close-button"]') as HTMLButtonElement | null,
    status: container.querySelector('[data-testid="find-status-text"]'),
    error: container.querySelector('[data-testid="find-error-text"]'),
  }
}

describe('SpreadsheetFindReplaceDialog', () => {
  it('does not render when findReplaceOpenAtom is false', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    expect(getEls(container).dialog).toBeNull()
  })

  it('renders when findReplaceOpenAtom is true', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(findReplaceOpenAtom, true)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const els = getEls(container)
    expect(els.dialog).not.toBeNull()
    expect(els.needle).not.toBeNull()
    expect(els.replacement).not.toBeNull()
    expect(els.findNext).not.toBeNull()
    expect(els.findPrev).not.toBeNull()
    expect(els.replace).not.toBeNull()
    expect(els.replaceAll).not.toBeNull()
    expect(els.close).not.toBeNull()
    expect(els.status).not.toBeNull()
  })

  it('submitting find form calls backend.searchRange with the needle and dispatches result via setFindMatchesAtom', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 },
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 },
      ],
      pageStart: 0,
      totalCount: 2,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => fakeResult)
    const backend = createSearchBackend(searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { needle } = getEls(container)
    fireEvent.input(needle!, { target: { value: 'foo' } })
    fireEvent.keyDown(needle!, { key: 'Enter' })

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(1)
    })

    const req = searchSpy.mock.calls[0]![0]
    expect(req.query.needle).toBe('foo')
    expect(req.kind).toBe('search-range')

    const cursor = store.getter(findReplaceCursorAtom)
    expect(cursor.totalCount).toBe(2)
    expect(cursor.pageMatches).toHaveLength(2)
  })

  it('shows status text as "currentIndex + 1 of totalCount"', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 2, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 3, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 4, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
      ],
      pageStart: 0,
      totalCount: 5,
    })
    // advance to index 1
    store.setter(advanceFindCursorAtom, 1)

    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { status } = getEls(container)
    // Default locale is `zh`; the en variant of this key is `'{current} of {total}'`.
    expect(status?.textContent).toBe('2 / 5')
  })

  it('Find next click calls advanceFindCursorAtom(1)', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 2, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
      ],
      pageStart: 0,
      totalCount: 3,
    })

    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)
    fireEvent.click(getEls(container).findNext!)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)
  })

  it('Find next moves selection to the matched cell and scrolls into view', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 5 },
        { coord: { row: 5, col: 2 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 5 },
      ],
      pageStart: 0,
      totalCount: 2,
    })

    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).findNext!)
    const selectionAfterNext = store.getter(selectionAtom)
    expect(selectionAfterNext.sheetId).toBe('sheet-1')
    expect(selectionAfterNext.kind).toBe('cell')
    expect((selectionAfterNext as { anchor: { row: number; col: number } }).anchor).toEqual({
      row: 5,
      col: 2,
    })
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)

    fireEvent.click(getEls(container).findPrev!)
    const selectionAfterPrev = store.getter(selectionAtom)
    expect((selectionAfterPrev as { anchor: { row: number; col: number } }).anchor).toEqual({
      row: 1,
      col: 0,
    })
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)
  })

  it('Find next dispatches scrollToCellAtom for the matched coord', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    store.setter(setViewportMetricsAtom, {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 240,
      viewportWidth: 480,
      rowHeight: 24,
      colWidth: 96,
      rowCount: 1000,
      colCount: 100,
      overscanRows: 0,
      overscanCols: 0,
    })
    const initialMetrics = store.getter(viewportMetricsAtom)
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 200, col: 5 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
      ],
      pageStart: 0,
      totalCount: 2,
    })

    const backend = createBaseBackend()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).findNext!)
    const after = store.getter(viewportMetricsAtom)
    expect(after.scrollTop).not.toBe(initialMetrics.scrollTop)
  })

  it('Find next triggers a search when no matches have been committed yet', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 2, col: 1 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 5 },
      ],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => fakeResult)
    const backend = createSearchBackend(searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { needle, findNext } = getEls(container)
    fireEvent.input(needle!, { target: { value: 'North' } })
    fireEvent.click(findNext!)

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(1)
    })
    expect(store.getter(findReplaceCursorAtom).totalCount).toBe(1)
  })

  it('Replace button calls backend.replaceMatches for the current match', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 },
      ],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => fakeSearchResult)
    const replaceCalls: ReplaceMatchesRequest[] = []
    const replaceSpy = jest.fn(async (req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> => {
      replaceCalls.push(req)
      return { replacedCount: 1 }
    })
    const backend = createSearchBackend(searchSpy, replaceSpy)

    // pre-populate matches so replace has something to act on
    store.setter(setFindMatchesAtom, fakeSearchResult)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { replacement, replace } = getEls(container)
    fireEvent.input(replacement!, { target: { value: 'bar' } })
    fireEvent.click(replace!)

    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledTimes(1)
    })
    expect(replaceCalls[0]!.coords).toHaveLength(1)
    expect(replaceCalls[0]!.replacement).toBe('bar')
    expect(replaceCalls[0]!.coords[0]!.coord).toEqual({ row: 0, col: 0 })
  })

  it('Close button sets findReplaceOpenAtom to false', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceOpenAtom)).toBe(true)
    fireEvent.click(getEls(container).close!)
    expect(store.getter(findReplaceOpenAtom)).toBe(false)
  })

  it('resets form fields when the dialog reopens after being closed', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const initial = getEls(container)
    fireEvent.input(initial.needle!, { target: { value: 'foo' } })
    fireEvent.input(initial.replacement!, { target: { value: 'bar' } })
    fireEvent.click(initial.caseSensitive!)
    fireEvent.click(initial.wholeMatch!)
    fireEvent.click(initial.regex!)
    fireEvent.click(initial.formulas!)
    fireEvent.change(initial.scopeSelect!, { target: { value: 'workbook' } })

    expect(initial.needle!.value).toBe('foo')
    expect(initial.caseSensitive!.checked).toBe(true)
    expect(initial.scopeSelect!.value).toBe('workbook')

    store.setter(findReplaceOpenAtom, false)
    await waitFor(() => {
      expect(getEls(container).dialog).toBeNull()
    })
    store.setter(findReplaceOpenAtom, true)

    await waitFor(() => {
      expect(getEls(container).dialog).not.toBeNull()
    })
    const after = getEls(container)
    expect(after.needle!.value).toBe('')
    expect(after.replacement!.value).toBe('')
    expect(after.caseSensitive!.checked).toBe(false)
    expect(after.wholeMatch!.checked).toBe(false)
    expect(after.regex!.checked).toBe(false)
    expect(after.formulas!.checked).toBe(false)
    expect(after.scopeSelect!.value).toBe('sheet')
  })

  it('surfaces a replaceMatches failure via find-error-text', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [{ coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 }],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => fakeSearchResult)
    const replaceSpy = jest.fn(async (_req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> => {
      throw new Error('replace exploded')
    })
    const backend = createSearchBackend(searchSpy, replaceSpy)

    store.setter(setFindMatchesAtom, fakeSearchResult)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replace!)

    await waitFor(() => {
      const err = getEls(container).error
      expect(err).not.toBeNull()
      expect(err!.textContent).toBe('replace exploded')
    })
    expect(store.getter(findReplaceCursorAtom).status).toBe('error')
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('surfaces a replace-all failure via find-error-text', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [{ coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 }],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => fakeSearchResult)
    const replaceSpy = jest.fn(async (_req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> => {
      throw new Error('bulk replace exploded')
    })
    const backend = createSearchBackend(searchSpy, replaceSpy)

    store.setter(setFindMatchesAtom, fakeSearchResult)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replaceAll!)

    await waitFor(() => {
      const err = getEls(container).error
      expect(err).not.toBeNull()
      expect(err!.textContent).toBe('bulk replace exploded')
    })
  })

  it('clears find-error-text after a subsequent successful search dispatch', async () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [{ coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 }],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (_req: SearchRangeRequest) => {
      throw new Error('first search failed')
    })
    const backend = createSearchBackend(searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { needle } = getEls(container)
    fireEvent.input(needle!, { target: { value: 'foo' } })
    fireEvent.keyDown(needle!, { key: 'Enter' })

    await waitFor(() => {
      const err = getEls(container).error
      expect(err).not.toBeNull()
      expect(err!.textContent).toBe('first search failed')
    })

    store.setter(setFindMatchesAtom, fakeSearchResult)

    await waitFor(() => {
      expect(getEls(container).error).toBeNull()
    })
    expect(store.getter(findReplaceCursorAtom).status).toBe('ready')
  })

  it('does not crash when backend omits searchRange — find is a no-op', () => {
    const store = createStore()
    store.setter(findReplaceOpenAtom, true)
    const backend = createBaseBackend() // no searchRange

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    const { needle } = getEls(container)
    fireEvent.input(needle!, { target: { value: 'anything' } })
    // Should not throw — just no-op
    expect(() => fireEvent.keyDown(needle!, { key: 'Enter' })).not.toThrow()

    // cursor stays idle because searchRange was never called
    expect(store.getter(findReplaceCursorAtom).status).toBe('idle')
  })
})
