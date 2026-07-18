/** @jsxImportSource solid-js */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
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
  closeFindReplaceAtom,
  findReplaceCursorAtom,
  findReplaceErrorAtom,
  findReplaceMutationBlockedAtom,
  findReplaceOpenAtom,
  findReplaceOperationDiagnosticsAtom,
  findReplaceRefreshRecoveryAtom,
  findReplaceSessionAtom,
  openFindReplaceAtom,
  runFindReplaceSearchAtom,
  selectionAtom,
  setFindMatchesAtom,
  setViewportMetricsAtom,
  setWorkspaceActiveSheetAtom,
  updateFindReplaceFormAtom,
  viewportMetricsAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetFindReplaceDialog } from '../src-vnext/find-replace'
import { setLocale } from '../src/i18n'

afterEach(cleanup)
beforeEach(() => setLocale('en'))

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

function requireSafeRequestId(requestId: number | undefined): number {
  expect(Number.isSafeInteger(requestId)).toBe(true)
  return requestId!
}

function acknowledgeSearch(
  request: SearchRangeRequest,
  result: SearchRangeResult,
): SearchRangeResult {
  return {
    ...result,
    requestId: requireSafeRequestId(request.requestId),
    ...(request.revision === undefined ? {} : { revision: request.revision }),
  }
}

function acknowledgeReplace(
  request: ReplaceMatchesRequest,
  result: ReplaceMatchesResult,
): ReplaceMatchesResult {
  return {
    ...result,
    requestId: requireSafeRequestId(request.requestId),
    revision: result.revision ?? 'replace-acknowledged-revision',
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function prepareOpenSheetStore(store: ReturnType<typeof createStore>, sheetId = 'sheet-1'): void {
  store.setter(openFindReplaceAtom)
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
}

async function establishTicketedResult(
  store: ReturnType<typeof createStore>,
  searchRange: (req: SearchRangeRequest) => Promise<SearchRangeResult>,
  input: { needle?: string; replacement?: string } = {},
): Promise<void> {
  prepareOpenSheetStore(store)
  store.setter(updateFindReplaceFormAtom, {
    needle: input.needle ?? 'foo',
    replacement: input.replacement ?? '',
  })
  await store.setter(runFindReplaceSearchAtom, { searchRange })
}

function getEls(container: HTMLElement) {
  return {
    dialog: container.querySelector('[data-testid="find-replace-dialog"]'),
    needle: container.querySelector('[data-testid="find-needle-input"]') as HTMLInputElement | null,
    replacement: container.querySelector(
      '[data-testid="find-replacement-input"]',
    ) as HTMLInputElement | null,
    replaceTab: container.querySelector('[data-testid="replace-tab"]') as HTMLButtonElement | null,
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
    findNext: container.querySelector(
      '[data-testid="find-next-button"]',
    ) as HTMLButtonElement | null,
    findPrev: container.querySelector(
      '[data-testid="find-prev-button"]',
    ) as HTMLButtonElement | null,
    replace: container.querySelector('[data-testid="replace-button"]') as HTMLButtonElement | null,
    replaceAll: container.querySelector(
      '[data-testid="replace-all-button"]',
    ) as HTMLButtonElement | null,
    close: container.querySelector('[data-testid="find-close-button"]') as HTMLButtonElement | null,
    status: container.querySelector('[data-testid="find-status-text"]'),
    error: container.querySelector('[data-testid="find-error-text"]'),
    refreshStatus: container.querySelector('[data-testid="find-refresh-status"]'),
    refreshRetry: container.querySelector(
      '[data-testid="find-refresh-retry-button"]',
    ) as HTMLButtonElement | null,
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
    store.setter(openFindReplaceAtom)

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

  it('keeps Find enabled and explicitly disables Replace with a search-only backend', async () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
    const backend = createSearchBackend(async (request) =>
      acknowledgeSearch(request, {
        kind: 'search-range',
        sheetId: request.sheetId,
        matches: [],
        pageStart: request.pageStart,
        totalCount: 0,
      }),
    )

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getEls(container).dialog?.getAttribute('data-capability')).toBe('find-only'),
    )
    const els = getEls(container)
    expect(els.needle?.disabled).toBe(false)
    expect(els.findNext?.disabled).toBe(false)
    expect(els.replaceTab?.disabled).toBe(true)
    expect(els.replacement?.disabled).toBe(true)
    expect(els.replace?.disabled).toBe(true)
    expect(els.replaceAll?.disabled).toBe(true)
  })

  it('submitting find form calls backend.searchRange with the needle and commits the result', async () => {
    const store = createStore()
    prepareOpenSheetStore(store)

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
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => acknowledgeSearch(req, fakeResult))
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
      expect(store.getter(findReplaceCursorAtom).totalCount).toBe(2)
    })

    const req = searchSpy.mock.calls[0]![0]
    expect(req.query.needle).toBe('foo')
    expect(req.kind).toBe('search-range')

    const cursor = store.getter(findReplaceCursorAtom)
    expect(cursor.pageMatches).toHaveLength(2)
  })

  it('shows status text as "currentIndex + 1 of totalCount"', () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
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
    expect(status?.textContent).toBe('2 of 5')
  })

  it('Find next advances a guarded ticketed cursor', async () => {
    const store = createStore()
    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 2, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
      ],
      pageStart: 0,
      totalCount: 3,
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => acknowledgeSearch(req, fakeResult))
    await establishTicketedResult(store, searchSpy)

    const backend = createSearchBackend(searchSpy)
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)
    fireEvent.click(getEls(container).findNext!)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)
  })

  it('Find next moves selection to the matched cell and scrolls into view', async () => {
    const store = createStore()
    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 5 },
        { coord: { row: 5, col: 2 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 5 },
      ],
      pageStart: 0,
      totalCount: 2,
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => acknowledgeSearch(req, fakeResult))
    await establishTicketedResult(store, searchSpy)

    const backend = createSearchBackend(searchSpy)
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

  it('Find next dispatches scrollToCellAtom for the matched coord', async () => {
    const store = createStore()
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
    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
        { coord: { row: 200, col: 5 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 1 },
      ],
      pageStart: 0,
      totalCount: 2,
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => acknowledgeSearch(req, fakeResult))
    await establishTicketedResult(store, searchSpy)
    const initialMetrics = store.getter(viewportMetricsAtom)

    const backend = createSearchBackend(searchSpy)
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
    prepareOpenSheetStore(store)

    const fakeResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 2, col: 1 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 5,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => acknowledgeSearch(req, fakeResult))
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
      expect(store.getter(findReplaceCursorAtom).totalCount).toBe(1)
    })
  })

  it('Replace button calls receiver-bound backend methods for the current match', async () => {
    const store = createStore()

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'replace-current-find-revision',
    }
    let searchReceiver: SpreadsheetBackend | undefined
    let replaceReceiver: SpreadsheetBackend | undefined
    const searchSpy = jest.fn(async function (this: SpreadsheetBackend, req: SearchRangeRequest) {
      searchReceiver = this
      return acknowledgeSearch(req, fakeSearchResult)
    })
    const replaceCalls: ReplaceMatchesRequest[] = []
    const replaceSpy = jest.fn(async function (
      this: SpreadsheetBackend,
      req: ReplaceMatchesRequest,
    ): Promise<ReplaceMatchesResult> {
      replaceReceiver = this
      replaceCalls.push(req)
      return acknowledgeReplace(req, { replacedCount: 1 })
    })
    const backend = createSearchBackend(searchSpy, replaceSpy)

    await establishTicketedResult(store, searchSpy.bind(backend))
    searchReceiver = undefined

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
      expect(searchSpy).toHaveBeenCalledTimes(2)
    })
    expect(searchReceiver).toBe(backend)
    expect(replaceReceiver).toBe(backend)
    expect(replaceCalls[0]!.coords).toHaveLength(1)
    expect(replaceCalls[0]!.replacement).toBe('bar')
    expect(replaceCalls[0]!.coords[0]!.coord).toEqual({ row: 0, col: 0 })
    expect(replaceCalls[0]!.coords[0]!.target).toBe('displayValue')
  })

  it('retries only the refresh after an acknowledged Replace refresh fails', async () => {
    const store = createStore()
    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'refresh-retry-find-revision',
    }
    let searchAttempt = 0
    const searchSpy = jest.fn(async (request: SearchRangeRequest) => {
      searchAttempt += 1
      if (searchAttempt === 2) throw new Error('Could not refresh Find results')
      return acknowledgeSearch(request, fakeSearchResult)
    })
    const replaceSpy = jest.fn(async (request: ReplaceMatchesRequest) =>
      acknowledgeReplace(request, { replacedCount: 1 }),
    )
    const backend = createSearchBackend(searchSpy, replaceSpy)
    await establishTicketedResult(store, searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replace!)
    await waitFor(() => {
      expect(store.getter(findReplaceRefreshRecoveryAtom)).toMatchObject({
        status: 'required',
        phase: 'search',
      })
      expect(getEls(container).refreshStatus?.textContent).toBe('Refreshing Find results')
      expect(getEls(container).refreshRetry?.textContent).toBe('Retry refresh')
    })
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(2)

    fireEvent.click(getEls(container).refreshRetry!)
    await waitFor(() => {
      expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
      expect(getEls(container).refreshRetry).toBeNull()
      expect(store.getter(findReplaceCursorAtom).status).toBe('ready')
    })
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(3)
  })

  it('does not let an old refresh result overwrite a reopened dialog', async () => {
    const store = createStore()
    const oldSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'old-find-revision',
    }
    const reopenedSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 8, col: 2 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'reopened-find-revision',
    }
    const deferredRefresh = createDeferred<SearchRangeResult>()
    let deferredRequest: SearchRangeRequest | undefined
    let searchAttempt = 0
    const searchSpy = jest.fn((request: SearchRangeRequest): Promise<SearchRangeResult> => {
      searchAttempt += 1
      if (searchAttempt === 2) return Promise.reject(new Error('Refresh needs a retry'))
      if (searchAttempt === 3) {
        deferredRequest = request
        return deferredRefresh.promise
      }
      return Promise.resolve(
        acknowledgeSearch(request, searchAttempt === 1 ? oldSearchResult : reopenedSearchResult),
      )
    })
    const replaceSpy = jest.fn(async (request: ReplaceMatchesRequest) =>
      acknowledgeReplace(request, { replacedCount: 1 }),
    )
    const backend = createSearchBackend(searchSpy, replaceSpy)
    await establishTicketedResult(store, searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replace!)
    await waitFor(() => {
      expect(getEls(container).refreshRetry).not.toBeNull()
    })
    fireEvent.click(getEls(container).refreshRetry!)
    await waitFor(() => {
      expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('refreshing')
      expect(searchSpy).toHaveBeenCalledTimes(3)
    })

    fireEvent.click(getEls(container).close!)
    await waitFor(() => {
      expect(getEls(container).dialog).toBeNull()
    })
    store.setter(openFindReplaceAtom)
    await waitFor(() => {
      expect(getEls(container).dialog).not.toBeNull()
    })
    fireEvent.input(getEls(container).needle!, { target: { value: 'new' } })
    fireEvent.keyDown(getEls(container).needle!, { key: 'Enter' })
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(4)
      expect(store.getter(findReplaceCursorAtom).pageMatches[0]?.coord).toEqual({
        row: 8,
        col: 2,
      })
    })

    deferredRefresh.resolve(acknowledgeSearch(deferredRequest!, oldSearchResult))
    await deferredRefresh.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
    expect(store.getter(findReplaceCursorAtom).pageMatches[0]?.coord).toEqual({ row: 8, col: 2 })
  })

  it('revisionless Find remains navigable but Replace is pre-port blocked', async () => {
    const store = createStore()
    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        { coord: { row: 0, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 },
        { coord: { row: 1, col: 0 }, sheetId: 'sheet-1', matchStart: 0, matchEnd: 3 },
      ],
      pageStart: 0,
      totalCount: 2,
    }
    const searchSpy = jest.fn(async (request: SearchRangeRequest) =>
      acknowledgeSearch(request, fakeSearchResult),
    )
    const replaceSpy = jest.fn(async (request: ReplaceMatchesRequest) =>
      acknowledgeReplace(request, { replacedCount: 1 }),
    )
    await establishTicketedResult(store, searchSpy, { replacement: 'bar' })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={createSearchBackend(searchSpy, replaceSpy)} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).findNext!)
    expect(store.getter(findReplaceCursorAtom)).toMatchObject({
      status: 'ready',
      currentIndex: 1,
      totalCount: 2,
    })
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)

    fireEvent.click(getEls(container).replace!)

    await waitFor(() => {
      expect(getEls(container).error?.textContent).toBe(
        'Replace requires a response-owned projection revision',
      )
    })
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_RESULT_REVISION_REQUIRED')
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceCursorAtom).status).toBe('ready')
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
  })

  it('switching sheets clears the previous Find result before returning to the first sheet', async () => {
    const store = createStore()
    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) =>
      acknowledgeSearch(req, fakeSearchResult),
    )
    const replaceSpy = jest.fn(
      async (req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> =>
        acknowledgeReplace(req, { replacedCount: 1 }),
    )
    const backend = createSearchBackend(searchSpy, replaceSpy)
    await establishTicketedResult(store, searchSpy, { replacement: 'bar' })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    await waitFor(() => {
      expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
      expect(store.getter(findReplaceCursorAtom).status).toBe('idle')
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    await waitFor(() => {
      expect(getEls(container).replace?.disabled).toBe(true)
    })
    fireEvent.click(getEls(container).replace!)
    expect(getEls(container).error).toBeNull()
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps sheet B authoritative when sheet A acknowledges a dispatched Replace late', async () => {
    const store = createStore()
    const deferredReplace = createDeferred<ReplaceMatchesResult>()
    let dispatchedRequest: ReplaceMatchesRequest | undefined
    const searchSpy = jest.fn(async (request: SearchRangeRequest) =>
      acknowledgeSearch(request, {
        kind: 'search-range',
        sheetId: request.sheetId,
        matches: [
          {
            coord: request.sheetId === 'sheet-1' ? { row: 0, col: 0 } : { row: 5, col: 2 },
            sheetId: request.sheetId,
            matchStart: 0,
            matchEnd: 3,
            target: 'displayValue',
          },
        ],
        pageStart: 0,
        totalCount: 1,
        revision: `${request.sheetId}-revision`,
      }),
    )
    const replaceSpy = jest.fn((request: ReplaceMatchesRequest) => {
      dispatchedRequest = request
      return deferredReplace.promise
    })
    const backend = createSearchBackend(searchSpy, replaceSpy)
    await establishTicketedResult(store, searchSpy, { replacement: 'bar' })
    const sheetASessionId = store.getter(findReplaceSessionAtom).sessionId

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replace!)
    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledTimes(1)
      expect(dispatchedRequest?.coords[0]?.sheetId).toBe('sheet-1')
      expect(store.getter(findReplaceSessionAtom).mutationPending).toBe(true)
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-2',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    await waitFor(() => {
      expect(store.getter(findReplaceSessionAtom).sessionId).not.toBe(sheetASessionId)
      expect(store.getter(findReplaceCursorAtom).status).toBe('idle')
      expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
        count: 1,
        pendingCount: 0,
        outcomeUnknownCount: 1,
        unreconciledOutcomeUnknownCount: 1,
      })
    })

    fireEvent.keyDown(getEls(container).needle!, { key: 'Enter' })
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(2)
      expect(searchSpy.mock.calls[1]![0].sheetId).toBe('sheet-2')
      expect(store.getter(findReplaceCursorAtom)).toMatchObject({
        status: 'ready',
        pageMatches: [{ sheetId: 'sheet-2', coord: { row: 5, col: 2 } }],
      })
      expect(store.getter(findReplaceMutationBlockedAtom)).toBe(false)
    })

    deferredReplace.resolve(acknowledgeReplace(dispatchedRequest!, { replacedCount: 1 }))
    await deferredReplace.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(searchSpy).toHaveBeenCalledTimes(2)
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      open: true,
      mutationPending: false,
      hasTicketedResult: true,
    })
    expect(store.getter(findReplaceCursorAtom)).toMatchObject({
      status: 'ready',
      pageMatches: [{ sheetId: 'sheet-2', coord: { row: 5, col: 2 } }],
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      count: 1,
      pendingCount: 0,
      acknowledgedCount: 0,
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 1,
    })
    expect(getEls(container).replace?.disabled).toBe(false)
    expect(getEls(container).error).toBeNull()
  })

  it('Close button sets findReplaceOpenAtom to false', () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
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
    store.setter(openFindReplaceAtom)
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

    store.setter(closeFindReplaceAtom)
    await waitFor(() => {
      expect(getEls(container).dialog).toBeNull()
    })
    store.setter(openFindReplaceAtom)

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

  it('blocks another Replace when the backend outcome is unknown', async () => {
    const store = createStore()

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'replace-failure-find-revision',
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) =>
      acknowledgeSearch(req, fakeSearchResult),
    )
    const replaceSpy = jest.fn(
      async (_req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> => {
        throw new Error('replace exploded')
      },
    )
    const backend = createSearchBackend(searchSpy, replaceSpy)

    await establishTicketedResult(store, searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replace!)

    await waitFor(() => {
      expect(getEls(container).error?.textContent).toBe(
        'Replace rejected after dispatch without exact not-applied evidence',
      )
      expect(getEls(container).replace?.disabled).toBe(true)
    })
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_OUTCOME_UNKNOWN')
    fireEvent.click(getEls(container).replace!)
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it('blocks another Replace all when the backend outcome is unknown', async () => {
    const store = createStore()

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
      revision: 'replace-all-failure-find-revision',
    }
    const searchSpy = jest.fn(async (req: SearchRangeRequest) =>
      acknowledgeSearch(req, fakeSearchResult),
    )
    const replaceSpy = jest.fn(
      async (_req: ReplaceMatchesRequest): Promise<ReplaceMatchesResult> => {
        throw new Error('bulk replace exploded')
      },
    )
    const backend = createSearchBackend(searchSpy, replaceSpy)

    await establishTicketedResult(store, searchSpy)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getEls(container).replaceAll!)

    await waitFor(() => {
      expect(getEls(container).error?.textContent).toBe(
        'Replace rejected after dispatch without exact not-applied evidence',
      )
      expect(getEls(container).replaceAll?.disabled).toBe(true)
    })
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_OUTCOME_UNKNOWN')
    fireEvent.click(getEls(container).replaceAll!)
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it('clears find-error-text after a subsequent successful search dispatch', async () => {
    const store = createStore()
    prepareOpenSheetStore(store)

    const fakeSearchResult: SearchRangeResult = {
      kind: 'search-range',
      sheetId: 'sheet-1',
      matches: [
        {
          coord: { row: 0, col: 0 },
          sheetId: 'sheet-1',
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      pageStart: 0,
      totalCount: 1,
    }
    let attempt = 0
    const searchSpy = jest.fn(async (req: SearchRangeRequest) => {
      attempt += 1
      if (attempt === 1) throw new Error('first search failed')
      return acknowledgeSearch(req, fakeSearchResult)
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

    fireEvent.keyDown(needle!, { key: 'Enter' })

    await waitFor(() => {
      expect(getEls(container).error).toBeNull()
      expect(store.getter(findReplaceCursorAtom).status).toBe('ready')
    })
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  it('disables Find actions instead of reporting a late error when searchRange is absent', async () => {
    const store = createStore()
    prepareOpenSheetStore(store)
    const backend = createBaseBackend() // no searchRange

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFindReplaceDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() =>
      expect(getEls(container).dialog?.getAttribute('data-capability')).toBe('unsupported'),
    )
    const { findNext, findPrev, needle } = getEls(container)
    expect(findNext?.disabled).toBe(true)
    expect(findPrev?.disabled).toBe(true)
    fireEvent.input(needle!, { target: { value: 'anything' } })
    expect(() => fireEvent.keyDown(needle!, { key: 'Enter' })).not.toThrow()

    expect(getEls(container).error).toBeNull()
    expect(store.getter(findReplaceErrorAtom)).toBeNull()
    expect(store.getter(findReplaceCursorAtom).status).toBe('idle')
  })
})
