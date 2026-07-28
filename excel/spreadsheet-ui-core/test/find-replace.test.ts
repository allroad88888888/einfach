import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_FIND_REPLACE_FORM_STATE,
  MAX_FIND_PAGE,
  advanceFindCursorAtom,
  captureFindReplaceCapabilityAtom,
  closeFindReplaceAtom,
  commitFindReplaceQueryAtom,
  findReplaceCursorAtom,
  findReplaceCapabilityProjectionAtom,
  findReplaceErrorAtom,
  findReplaceFormAtom,
  findReplaceFormQueryAtom,
  findReplaceMutationBlockedAtom,
  findReplaceOpenAtom,
  findReplaceOperationDiagnosticsAtom,
  findReplacePendingAtom,
  findReplaceQueryAtom,
  findReplaceRefreshRecoveryAtom,
  findReplaceSessionAtom,
  markReplaceAllCappedAtom,
  nextFindReplaceSearchRequestId,
  nextFindReplaceSessionId,
  openFindReplaceAtom,
  openFindReplaceFromEntrypointAtom,
  planFindReplaceMutationIdentity,
  replaceAllCappedAtom,
  runFindReplaceMutationAtom,
  runFindReplaceRefreshRecoveryAtom,
  runFindReplaceSearchAtom,
  setFindMatchesAtom,
  setFindReplaceErrorAtom,
  stepFindReplaceAtom,
  syncFindReplaceTargetAtom,
  updateFindReplaceFormAtom,
} from '../src/find-replace'
import type {
  FindMatch,
  FindReplaceTarget,
  ReplaceMatchesRequest,
  ReplaceMatchesResponse,
  SearchRangeRequest,
  SearchRangeResult,
} from '../src/find-replace'
import {
  selectionAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
  setWorkspaceActiveSheetAtom,
} from '../src'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function match(
  row: number,
  col: number,
  target: FindReplaceTarget | null = 'displayValue',
  matchStart = 0,
  matchEnd = 3,
  sheetId = 'sheet1',
): FindMatch {
  return {
    coord: { row, col },
    sheetId,
    matchStart,
    matchEnd,
    ...(target === null ? {} : { target }),
  }
}

function resultFor(
  request: SearchRangeRequest,
  matches: FindMatch[] = [match(0, 0)],
  totalCount = matches.length,
  revision: number | string | null = request.revision ?? 1,
): SearchRangeResult {
  return {
    kind: 'search-range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    pageStart: request.pageStart,
    matches,
    totalCount,
    ...(revision === null ? {} : { revision }),
  }
}

function prepareStore(
  store: ReturnType<typeof createStore>,
  options: {
    readonly sheetId?: string
    readonly scope?: 'sheet' | 'current-selection' | 'workbook'
    readonly searchFormulas?: boolean
  } = {},
): void {
  const sheetId = options.sheetId ?? 'sheet1'
  store.setter(setSelectionBoundsAtom, { rowCount: 1000, colCount: 100 })
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(setSelectionAtom, {
    kind: 'range',
    sheetId,
    anchor: { row: 2, col: 3 },
    focus: { row: 4, col: 5 },
  })
  store.setter(openFindReplaceAtom)
  store.setter(updateFindReplaceFormAtom, {
    needle: 'foo',
    replacement: 'bar',
    scope: options.scope ?? 'sheet',
    searchFormulas: options.searchFormulas ?? false,
  })
}

async function establishTicket(
  store: ReturnType<typeof createStore>,
  matches: FindMatch[] = [match(0, 0)],
  options: {
    readonly totalCount?: number
    readonly revision?: number | string | null
  } = {},
): Promise<jest.Mock<(request: SearchRangeRequest) => Promise<SearchRangeResult>>> {
  const searchRange = jest.fn(async (request: SearchRangeRequest) =>
    resultFor(
      request,
      matches,
      options.totalCount ?? matches.length,
      options.revision === undefined ? 1 : options.revision,
    ),
  )
  await store.setter(runFindReplaceSearchAtom, { searchRange })
  expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
  return searchRange
}

function exactAcknowledgement(
  request: ReplaceMatchesRequest,
  revision: number | string = 2,
): ReplaceMatchesResponse {
  return {
    requestId: request.requestId,
    replacedCount: request.coords.length,
    revision,
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('find/replace Core lifecycle and compatibility views', () => {
  test('projects backend ports into honest entrypoint capabilities', () => {
    const store = createStore()
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'unknown',
      findEnabled: false,
      replaceEnabled: false,
    })
    expect(store.setter(openFindReplaceFromEntrypointAtom)).toBe(false)
    expect(store.getter(findReplaceOpenAtom)).toBe(false)

    store.setter(captureFindReplaceCapabilityAtom, {})
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'unsupported',
      findEnabled: false,
      replaceEnabled: false,
    })

    const searchRange = async (request: SearchRangeRequest) => resultFor(request)
    store.setter(captureFindReplaceCapabilityAtom, { searchRange })
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'find-only',
      findEnabled: true,
      replaceEnabled: false,
    })
    expect(store.setter(openFindReplaceFromEntrypointAtom)).toBe(true)
    expect(store.getter(findReplaceOpenAtom)).toBe(true)

    store.setter(closeFindReplaceAtom)
    store.setter(captureFindReplaceCapabilityAtom, {
      searchRange,
      async replaceMatches(request) {
        return exactAcknowledgement(request)
      },
    })
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'find-and-replace',
      findEnabled: true,
      replaceEnabled: true,
    })
  })

  test('capability capture does not disturb a pending search ticket', async () => {
    const store = createStore()
    prepareStore(store)
    const result = deferred<SearchRangeResult>()
    let request!: SearchRangeRequest
    const searchRange = jest.fn((nextRequest: SearchRangeRequest) => {
      request = nextRequest
      return result.promise
    })
    store.setter(captureFindReplaceCapabilityAtom, {
      searchRange,
      async replaceMatches(nextRequest) {
        return exactAcknowledgement(nextRequest)
      },
    })

    const pending = store.setter(runFindReplaceSearchAtom, { searchRange })
    await Promise.resolve()
    expect(store.getter(findReplaceSessionAtom).searchPending).toBe(true)

    store.setter(captureFindReplaceCapabilityAtom, {})
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'unsupported',
      findEnabled: false,
      replaceEnabled: false,
    })
    expect(store.getter(findReplaceSessionAtom).searchPending).toBe(true)

    result.resolve(resultFor(request, [match(7, 8)]))
    await pending
    expect(searchRange).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      searchPending: false,
      hasTicketedResult: true,
    })
    expect(store.getter(findReplaceCursorAtom)).toMatchObject({ status: 'ready' })
    expect(store.getter(findReplaceCapabilityProjectionAtom).capability).toBe('unsupported')
  })

  test('identity helpers increment only valid safe identities', () => {
    expect(nextFindReplaceSessionId(0)).toBe(1)
    expect(nextFindReplaceSearchRequestId(41)).toBe(42)
    expect(planFindReplaceMutationIdentity(8)).toEqual({
      requestId: 9,
      operationId: 'find-replace-9',
    })
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      expect(nextFindReplaceSessionId(invalid)).toBeNull()
      expect(nextFindReplaceSearchRequestId(invalid)).toBeNull()
      expect(planFindReplaceMutationIdentity(invalid)).toBeNull()
    }
  })

  test('open, form/query and close reset the public lifecycle', () => {
    const store = createStore()
    expect(store.getter(findReplaceOpenAtom)).toBe(false)
    store.setter(openFindReplaceAtom)
    const sessionId = store.getter(findReplaceSessionAtom).sessionId
    store.setter(updateFindReplaceFormAtom, {
      activeTab: 'replace',
      needle: 'Foo',
      replacement: 'Bar',
      caseSensitive: true,
      wholeMatch: true,
      regex: true,
      searchFormulas: true,
      scope: 'current-selection',
    })
    expect(store.getter(findReplaceFormQueryAtom)).toEqual({
      needle: 'Foo',
      replacement: 'Bar',
      options: {
        caseSensitive: true,
        wholeMatch: true,
        regex: true,
        searchFormulas: true,
        scope: 'current-selection',
      },
    })
    store.setter(closeFindReplaceAtom)
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      open: false,
      searchPending: false,
      mutationPending: false,
      refreshPending: false,
      refreshRecoveryRequired: false,
      hasTicketedResult: false,
    })
    expect(store.getter(findReplaceSessionAtom).sessionId).toBeGreaterThan(sessionId)
    expect(store.getter(findReplaceFormAtom)).toEqual(DEFAULT_FIND_REPLACE_FORM_STATE)
  })

  test('replacement-only edits keep a current result while search option edits invalidate it', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    store.setter(updateFindReplaceFormAtom, { replacement: 'baz' })
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
    store.setter(updateFindReplaceFormAtom, { wholeMatch: true })
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
  })

  test('compatibility writers remain useful views but never authorize mutation', async () => {
    const store = createStore()
    prepareStore(store)
    store.setter(commitFindReplaceQueryAtom, {
      needle: 'foo',
      replacement: 'bar',
      options: { scope: 'sheet' },
    })
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet1',
      pageStart: 0,
      matches: [match(0, 0)],
      totalCount: 1,
    })
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange: async (request) => resultFor(request),
    })
    expect(replaceMatches).not.toHaveBeenCalled()
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_TICKETED_RESULT_REQUIRED')

    const query = store.getter(findReplaceQueryAtom)
    const cursor = store.getter(findReplaceCursorAtom)
    expect(Object.isFrozen(query)).toBe(true)
    expect(Object.isFrozen(query?.options)).toBe(true)
    expect(Object.isFrozen(cursor)).toBe(true)
    expect(Object.isFrozen(cursor.pageMatches)).toBe(true)
    expect(Object.isFrozen(cursor.pageMatches[0])).toBe(true)
    expect(Object.isFrozen(cursor.pageMatches[0]?.coord)).toBe(true)
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(true)
  })

  test('compatibility cursor, cap and error commands are bounded public projections', () => {
    const store = createStore()
    prepareStore(store)
    const matches = Array.from({ length: MAX_FIND_PAGE + 1 }, (_, row) => match(row, 0))
    store.setter(setFindMatchesAtom, {
      kind: 'search-range',
      sheetId: 'sheet1',
      pageStart: 0,
      matches,
      totalCount: matches.length,
    })
    expect(store.getter(findReplaceCursorAtom).pageMatches).toHaveLength(MAX_FIND_PAGE)
    store.setter(advanceFindCursorAtom, -1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(MAX_FIND_PAGE - 1)
    store.setter(markReplaceAllCappedAtom, {
      acknowledgedProjectionCount: MAX_FIND_PAGE,
      totalCount: MAX_FIND_PAGE + 1,
    })
    expect(store.getter(replaceAllCappedAtom)).toEqual({
      acknowledgedProjectionCount: MAX_FIND_PAGE,
      totalCount: MAX_FIND_PAGE + 1,
    })
    store.setter(setFindReplaceErrorAtom, new Error('plain failure'))
    const publicError = store.getter(findReplaceErrorAtom)
    expect(publicError).toMatchObject({
      code: 'BACKEND_ERROR',
      source: 'transport',
    })
    expect(Object.isFrozen(publicError)).toBe(true)
  })
})

describe('find/replace search correlation and focus', () => {
  test('search sends the complete query and focuses the first exact match', async () => {
    const store = createStore()
    prepareStore(store)
    store.setter(updateFindReplaceFormAtom, {
      caseSensitive: true,
      wholeMatch: true,
      regex: false,
      searchFormulas: true,
    })
    const searchRange = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request, [match(7, 8, 'formula')], 1, 'rev-1'),
    )
    await store.setter(runFindReplaceSearchAtom, { searchRange })
    expect(searchRange).toHaveBeenCalledTimes(1)
    expect(searchRange.mock.calls[0]?.[0]).toMatchObject({
      kind: 'search-range',
      sheetId: 'sheet1',
      pageStart: 0,
      pageSize: MAX_FIND_PAGE,
      query: {
        needle: 'foo',
        options: {
          scope: 'sheet',
          caseSensitive: true,
          wholeMatch: true,
          searchFormulas: true,
        },
      },
    })
    expect(store.getter(findReplaceCursorAtom)).toMatchObject({
      status: 'ready',
      currentIndex: 0,
      totalCount: 1,
    })
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 'sheet1',
      anchor: { row: 7, col: 8 },
      focus: { row: 7, col: 8 },
    })
  })

  test('current-selection scope captures the original normalized range and owns its focus write', async () => {
    const store = createStore()
    prepareStore(store, { scope: 'current-selection' })
    const searchRange = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request, [match(3, 4)]),
    )
    await store.setter(runFindReplaceSearchAtom, { searchRange })
    expect(searchRange.mock.calls[0]?.[0].range).toEqual({
      rowStart: 2,
      rowEnd: 4,
      colStart: 3,
      colEnd: 5,
    })
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
  })

  test('same-tick duplicate search dispatches exactly once', async () => {
    const store = createStore()
    prepareStore(store)
    const searchRange = jest.fn(async (request: SearchRangeRequest) => resultFor(request))
    const first = store.setter(runFindReplaceSearchAtom, { searchRange })
    const second = store.setter(runFindReplaceSearchAtom, { searchRange })
    await first
    await second
    expect(searchRange).toHaveBeenCalledTimes(1)
  })

  test('close before the microtask dispatch prevents the search port call', async () => {
    const store = createStore()
    prepareStore(store)
    const searchRange = jest.fn(async (request: SearchRangeRequest) => resultFor(request))
    const pending = store.setter(runFindReplaceSearchAtom, { searchRange })
    store.setter(closeFindReplaceAtom)
    await pending
    expect(searchRange).not.toHaveBeenCalled()
  })

  test.each([
    ['empty needle', { needle: '' }, 'FIND_REPLACE_EMPTY_NEEDLE'],
    ['invalid regex', { needle: '[', regex: true }, 'FIND_REPLACE_INVALID_REGEX'],
    ['workbook scope', { scope: 'workbook' as const }, 'FIND_REPLACE_WORKBOOK_UNAVAILABLE'],
  ])('%s fails validation before dispatch', async (_label, patch, expectedCode) => {
    const store = createStore()
    prepareStore(store)
    store.setter(updateFindReplaceFormAtom, patch)
    const searchRange = jest.fn(async (request: SearchRangeRequest) => resultFor(request))
    await store.setter(runFindReplaceSearchAtom, { searchRange })
    expect(searchRange).not.toHaveBeenCalled()
    expect(store.getter(findReplaceErrorAtom)?.code).toBe(expectedCode)
  })

  test('missing sheet, missing search port and invalid revision fail before dispatch', async () => {
    const noSheet = createStore()
    noSheet.setter(openFindReplaceAtom)
    noSheet.setter(updateFindReplaceFormAtom, { needle: 'foo' })
    const port = jest.fn(async (request: SearchRangeRequest) => resultFor(request))
    await noSheet.setter(runFindReplaceSearchAtom, { searchRange: port })
    expect(port).not.toHaveBeenCalled()
    expect(noSheet.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_SHEET_UNAVAILABLE')

    const store = createStore()
    prepareStore(store)
    await store.setter(runFindReplaceSearchAtom, {})
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_SEARCH_UNAVAILABLE')
    await store.setter(runFindReplaceSearchAtom, { searchRange: port, revision: -1 })
    expect(port).not.toHaveBeenCalled()
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_REVISION_MISMATCH')
  })

  test('plain malformed responses fail exact request/sheet/page/range/revision correlation', async () => {
    const malformedResponses = [
      (request: SearchRangeRequest) => ({
        ...resultFor(request),
        requestId: request.requestId! + 1,
      }),
      (request: SearchRangeRequest) => ({ ...resultFor(request), sheetId: 'sheet2' }),
      (request: SearchRangeRequest) => ({ ...resultFor(request), pageStart: 1 }),
      (request: SearchRangeRequest) =>
        resultFor(
          request,
          Array.from({ length: MAX_FIND_PAGE + 1 }, (_, row) => match(row, 0)),
          MAX_FIND_PAGE + 1,
        ),
      (request: SearchRangeRequest) => resultFor(request, [match(1_048_576, 0)]),
      (request: SearchRangeRequest) =>
        resultFor(request, [match(0, 0, 'displayValue', 0, 3), match(0, 0, 'displayValue', 2, 4)]),
      (request: SearchRangeRequest) => resultFor(request, [match(0, 0, 'formula')]),
      (request: SearchRangeRequest) => ({ ...resultFor(request), revision: -1 }),
    ]

    for (const response of malformedResponses) {
      const store = createStore()
      prepareStore(store)
      await store.setter(runFindReplaceSearchAtom, {
        searchRange: async (request) => response(request) as SearchRangeResult,
      })
      expect(store.getter(findReplaceCursorAtom).status).toBe('error')
      expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_PROTOCOL_ERROR')
      expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
    }
  })

  test.each([
    ['zero-width', 1, 1],
    ['reversed', 2, 1],
  ])(
    '%s spans fail closed without a private ticket or mutation dispatch',
    async (_label, start, end) => {
      const store = createStore()
      prepareStore(store)
      const searchRange = jest.fn(async (request: SearchRangeRequest) =>
        resultFor(request, [match(0, 0, 'displayValue', start, end)]),
      )
      const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
        exactAcknowledgement(request),
      )

      await store.setter(runFindReplaceSearchAtom, { searchRange })

      expect(store.getter(findReplaceCursorAtom).status).toBe('error')
      expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_PROTOCOL_ERROR')
      expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)

      await store.setter(runFindReplaceMutationAtom, {
        action: 'replace-current',
        replaceMatches,
        searchRange,
      })

      expect(replaceMatches).not.toHaveBeenCalled()
      expect(searchRange).toHaveBeenCalledTimes(1)
      expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
    },
  )

  test('plain Error rejection and ordinary unresolved Promise timeout are reported', async () => {
    const rejected = createStore()
    prepareStore(rejected)
    await rejected.setter(runFindReplaceSearchAtom, {
      searchRange: async () => {
        throw new Error('offline')
      },
    })
    expect(rejected.getter(findReplaceErrorAtom)).toMatchObject({
      code: 'BACKEND_ERROR',
      source: 'transport',
    })

    const timedOut = createStore()
    prepareStore(timedOut)
    await timedOut.setter(runFindReplaceSearchAtom, {
      searchRange: () => new Promise<SearchRangeResult>(() => undefined),
      timeoutMs: 1,
    })
    expect(timedOut.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_TIMEOUT')
  })

  test.each(['close', 'retarget', 'A-B-A'])(
    '%s makes an in-flight response stale without publishing focus or results',
    async (mode) => {
      const store = createStore()
      prepareStore(store)
      const pendingResult = deferred<SearchRangeResult>()
      let request!: SearchRangeRequest
      const pending = store.setter(runFindReplaceSearchAtom, {
        searchRange: async (nextRequest) => {
          request = nextRequest
          return pendingResult.promise
        },
      })
      await Promise.resolve()
      if (mode === 'close') {
        store.setter(closeFindReplaceAtom)
      } else {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet2' })
        if (mode === 'A-B-A') {
          store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
        }
      }
      pendingResult.resolve(resultFor(request, [match(9, 9)]))
      await pending
      expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
      expect(store.getter(selectionAtom)).not.toMatchObject({
        anchor: { row: 9, col: 9 },
      })
    },
  )

  test('step wraps the cursor and projects selection; empty step starts a search', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store, [match(1, 1), match(2, 2)])
    store.setter(stepFindReplaceAtom, { direction: 1 })
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)
    expect(store.getter(selectionAtom)).toMatchObject({ anchor: { row: 2, col: 2 } })
    store.setter(stepFindReplaceAtom, { direction: -1 })
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)

    const empty = createStore()
    prepareStore(empty)
    const searchRange = jest.fn(async (request: SearchRangeRequest) => resultFor(request))
    await empty.setter(stepFindReplaceAtom, { direction: 1, searchRange })
    expect(searchRange).toHaveBeenCalledTimes(1)
  })

  test('missing target remains Find-only and formula target requires searchFormulas', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store, [match(0, 0, null)])
    expect(store.getter(findReplaceCursorAtom).status).toBe('ready')
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange: async (request) => resultFor(request),
    })
    expect(replaceMatches).not.toHaveBeenCalled()
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_TARGET_PROVENANCE_REQUIRED')
  })
})

describe('find/replace exact-once mutation and refresh recovery', () => {
  test('exact acknowledgement refreshes projection and search with one mutation call', async () => {
    const store = createStore()
    prepareStore(store, { searchFormulas: true })
    await establishTicket(store, [match(0, 0, 'formula')], { revision: 'rev-1' })
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 'rev-2'),
    )
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const searchRange = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request, [match(1, 1, 'formula')], 1, request.revision),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      revision: 'rev-1',
      replaceMatches,
      acceptAcknowledgedResult,
      searchRange,
    })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(replaceMatches.mock.calls[0]?.[0]).toMatchObject({
      replacement: 'bar',
      revision: 'rev-1',
      coords: [{ target: 'formula', coord: { row: 0, col: 0 } }],
    })
    expect(acceptAcknowledgedResult).toHaveBeenCalledTimes(1)
    expect(searchRange).toHaveBeenCalledTimes(1)
    expect(searchRange.mock.calls[0]?.[0].revision).toBe('rev-2')
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      mutationPending: false,
      refreshPending: false,
      refreshRecoveryRequired: false,
      hasTicketedResult: true,
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      count: 1,
      acknowledgedCount: 1,
      outcomeUnknownCount: 0,
    })
  })

  test('capability capture does not disturb a pending mutation', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const result = deferred<ReplaceMatchesResponse>()
    let request!: ReplaceMatchesRequest
    const replaceMatches = jest.fn((nextRequest: ReplaceMatchesRequest) => {
      request = nextRequest
      return result.promise
    })
    const searchRange = async (nextRequest: SearchRangeRequest) =>
      resultFor(nextRequest, [match(1, 1)], 1, nextRequest.revision)
    store.setter(captureFindReplaceCapabilityAtom, { searchRange, replaceMatches })

    const pending = store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange,
    })
    await Promise.resolve()
    expect(store.getter(findReplaceSessionAtom).mutationPending).toBe(true)

    store.setter(captureFindReplaceCapabilityAtom, { searchRange })
    expect(store.getter(findReplaceCapabilityProjectionAtom)).toEqual({
      capability: 'find-only',
      findEnabled: true,
      replaceEnabled: false,
    })
    expect(store.getter(findReplaceSessionAtom).mutationPending).toBe(true)

    result.resolve(exactAcknowledgement(request, 2))
    await pending
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      mutationPending: false,
      refreshPending: false,
      hasTicketedResult: true,
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      acknowledgedCount: 1,
      outcomeUnknownCount: 0,
    })
    expect(store.getter(findReplaceCapabilityProjectionAtom).capability).toBe('find-only')
  })

  test('capability capture does not disturb an explicit refresh recovery', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: async (request) => exactAcknowledgement(request, 2),
      searchRange: async () => {
        throw new Error('refresh offline')
      },
    })
    const requiredRecovery = store.getter(findReplaceRefreshRecoveryAtom)
    expect(requiredRecovery.status).toBe('required')

    const result = deferred<SearchRangeResult>()
    let request!: SearchRangeRequest
    const searchRange = jest.fn((nextRequest: SearchRangeRequest) => {
      request = nextRequest
      return result.promise
    })
    store.setter(captureFindReplaceCapabilityAtom, { searchRange })
    const pending = store.setter(runFindReplaceRefreshRecoveryAtom, { searchRange })
    await Promise.resolve()
    expect(store.getter(findReplaceSessionAtom).refreshPending).toBe(true)

    store.setter(captureFindReplaceCapabilityAtom, {})
    expect(store.getter(findReplaceCapabilityProjectionAtom).capability).toBe('unsupported')
    expect(store.getter(findReplaceSessionAtom).refreshPending).toBe(true)
    expect(store.getter(findReplaceRefreshRecoveryAtom).operationId).toBe(
      requiredRecovery.operationId,
    )

    result.resolve(resultFor(request, [match(2, 2)], 1, request.revision))
    await pending
    expect(searchRange).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceSessionAtom)).toMatchObject({
      refreshPending: false,
      refreshRecoveryRequired: false,
      hasTicketedResult: true,
    })
    expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
    expect(store.getter(findReplaceCapabilityProjectionAtom).capability).toBe('unsupported')
  })

  test('replace-all sends at most 500 accepted matches and reports the projection cap', async () => {
    const store = createStore()
    prepareStore(store)
    const matches = Array.from({ length: MAX_FIND_PAGE }, (_, row) => match(row, 0))
    await establishTicket(store, matches, { totalCount: MAX_FIND_PAGE + 20, revision: 1 })
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 2),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-all',
      replaceMatches,
      searchRange: async (request) => resultFor(request, [], 0, request.revision),
    })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(replaceMatches.mock.calls[0]?.[0].coords).toHaveLength(MAX_FIND_PAGE)
    expect(store.getter(replaceAllCappedAtom)).toEqual({
      acknowledgedProjectionCount: MAX_FIND_PAGE,
      totalCount: MAX_FIND_PAGE + 20,
    })
  })

  test('same-tick duplicate mutation reserves one Core operation and dispatches once', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request),
    )
    const input = {
      action: 'replace-current' as const,
      replaceMatches,
      searchRange: async (request: SearchRangeRequest) =>
        resultFor(request, [match(0, 0)], 1, request.revision),
    }
    const first = store.setter(runFindReplaceMutationAtom, input)
    const second = store.setter(runFindReplaceMutationAtom, input)
    await first
    await second
    expect(replaceMatches).toHaveBeenCalledTimes(1)
  })

  test('typed applied:false evidence is retryable and never enters the evidence ledger', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceMatches = jest.fn(
      async (request: ReplaceMatchesRequest): Promise<ReplaceMatchesResponse> => ({
        kind: 'replace-matches-not-applied',
        applied: false,
        requestId: request.requestId!,
        error: { code: 'CONFLICT', message: 'not applied', source: 'runtime' },
      }),
    )
    const input = {
      action: 'replace-current' as const,
      replaceMatches,
      searchRange: async (request: SearchRangeRequest) => resultFor(request),
    }
    await store.setter(runFindReplaceMutationAtom, input)
    await store.setter(runFindReplaceMutationAtom, input)
    expect(replaceMatches).toHaveBeenCalledTimes(2)
    expect(store.getter(findReplaceOperationDiagnosticsAtom).count).toBe(0)
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('CONFLICT')
  })

  test('generic rejection requires a same-target read-only Find before a new user Replace', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const oldReplaceTransport = jest.fn(
      async (_request: ReplaceMatchesRequest): Promise<ReplaceMatchesResponse> => {
        throw new Error('connection lost after dispatch')
      },
    )
    const originalSearchTransport = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request),
    )
    const originalInput = {
      action: 'replace-current' as const,
      replaceMatches: oldReplaceTransport,
      searchRange: originalSearchTransport,
    }
    await store.setter(runFindReplaceMutationAtom, originalInput)
    await store.setter(runFindReplaceMutationAtom, originalInput)
    expect(oldReplaceTransport).toHaveBeenCalledTimes(1)
    const originalRequestId = oldReplaceTransport.mock.calls[0]?.[0].requestId
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 1,
      pendingCount: 0,
    })
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(true)
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_OUTCOME_UNKNOWN')
    expect(originalSearchTransport).not.toHaveBeenCalled()

    const reconciliationFind = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request, [match(0, 0)], 1, 2),
    )
    await store.setter(runFindReplaceRefreshRecoveryAtom, {
      searchRange: reconciliationFind,
    })
    expect(oldReplaceTransport).toHaveBeenCalledTimes(1)
    expect(reconciliationFind).toHaveBeenCalledTimes(1)
    expect(reconciliationFind.mock.calls[0]?.[0]).toMatchObject({
      sheetId: 'sheet1',
      range: {
        rowStart: 0,
        rowEnd: 1_048_575,
        colStart: 0,
        colEnd: 16_383,
      },
      query: { needle: 'foo', options: { scope: 'sheet' } },
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 0,
      entries: [{ status: 'outcome-unknown', reconciled: true }],
    })
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(false)

    const newReplaceTransport = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 3),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: newReplaceTransport,
      searchRange: async (request) => resultFor(request, [match(0, 0)], 1, request.revision),
    })
    expect(oldReplaceTransport).toHaveBeenCalledTimes(1)
    expect(newReplaceTransport).toHaveBeenCalledTimes(1)
    expect(newReplaceTransport.mock.calls[0]?.[0].requestId).not.toBe(originalRequestId)
  })

  test('a fresh canonical Find after close reconciles only the same target context', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: async () => {
        throw new Error('unknown after dispatch')
      },
      searchRange: async (request) => resultFor(request),
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom).unreconciledOutcomeUnknownCount).toBe(
      1,
    )

    store.setter(closeFindReplaceAtom)
    store.setter(openFindReplaceAtom)
    store.setter(updateFindReplaceFormAtom, {
      needle: 'foo',
      replacement: 'bar',
      scope: 'sheet',
    })
    await store.setter(runFindReplaceSearchAtom, {
      searchRange: async (request) => resultFor(request, [match(0, 0)], 1, 2),
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 0,
    })
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(false)
  })

  test('an unknown on A does not block B, while A stays blocked until its own canonical Find', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceA = jest.fn(async (): Promise<ReplaceMatchesResponse> => {
      throw new Error('unknown after dispatch')
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: replaceA,
      searchRange: async (request) => resultFor(request),
    })
    expect(replaceA).toHaveBeenCalledTimes(1)

    store.setter(closeFindReplaceAtom)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet2' })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet2',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openFindReplaceAtom)
    store.setter(updateFindReplaceFormAtom, {
      needle: 'foo',
      replacement: 'bar',
      scope: 'sheet',
    })
    await store.setter(runFindReplaceSearchAtom, {
      searchRange: async (request) =>
        resultFor(request, [match(0, 0, 'displayValue', 0, 3, 'sheet2')], 1, 2),
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 1,
      entries: [{ status: 'outcome-unknown', reconciled: false }],
    })
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(false)

    const replaceB = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 3),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: replaceB,
      searchRange: async (request) =>
        resultFor(request, [match(0, 0, 'displayValue', 0, 3, 'sheet2')], 1, request.revision),
    })
    expect(replaceA).toHaveBeenCalledTimes(1)
    expect(replaceB).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      acknowledgedCount: 1,
      outcomeUnknownCount: 1,
      unreconciledOutcomeUnknownCount: 1,
    })

    store.setter(closeFindReplaceAtom)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openFindReplaceAtom)
    store.setter(updateFindReplaceFormAtom, {
      needle: 'foo',
      replacement: 'bar',
      scope: 'sheet',
    })
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(true)
    expect(store.getter(findReplaceOperationDiagnosticsAtom).unreconciledOutcomeUnknownCount).toBe(
      1,
    )

    await store.setter(runFindReplaceSearchAtom, {
      searchRange: async (request) => resultFor(request, [match(0, 0)], 1, 4),
    })
    expect(replaceA).toHaveBeenCalledTimes(1)
    expect(replaceB).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceOperationDiagnosticsAtom).unreconciledOutcomeUnknownCount).toBe(
      0,
    )
    expect(store.getter(findReplaceMutationBlockedAtom)).toBe(false)
  })

  test('plain malformed or wrongly correlated acknowledgements become outcome-unknown', async () => {
    const responses: readonly unknown[] = [
      { requestId: 999, replacedCount: 1, revision: 2 },
      { requestId: 2, replacedCount: 1 },
      { requestId: 2, replacedCount: 2, revision: 2 },
      { requestId: 2, replacedCount: -1, revision: 2 },
      { kind: 'unexpected', requestId: 2, replacedCount: '1', revision: 2 },
    ]
    for (const response of responses) {
      const store = createStore()
      prepareStore(store)
      await establishTicket(store)
      const replaceMatches = jest.fn(async () => response as ReplaceMatchesResponse)
      await store.setter(runFindReplaceMutationAtom, {
        action: 'replace-current',
        replaceMatches,
        searchRange: async (request) => resultFor(request),
      })
      expect(replaceMatches).toHaveBeenCalledTimes(1)
      expect(store.getter(findReplaceOperationDiagnosticsAtom).outcomeUnknownCount).toBe(1)
    }
  })

  test('missing revision, revision mismatch and missing ports never dispatch mutation', async () => {
    const cases = [
      {
        revision: null,
        inputRevision: undefined,
        expected: 'FIND_REPLACE_RESULT_REVISION_REQUIRED',
      },
      { revision: 1, inputRevision: 2, expected: 'FIND_REPLACE_REVISION_MISMATCH' },
    ] as const
    for (const entry of cases) {
      const store = createStore()
      prepareStore(store)
      await establishTicket(store, [match(0, 0)], { revision: entry.revision })
      const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
        exactAcknowledgement(request),
      )
      await store.setter(runFindReplaceMutationAtom, {
        action: 'replace-current',
        replaceMatches,
        searchRange: async (request) => resultFor(request),
        ...(entry.inputRevision === undefined ? {} : { revision: entry.inputRevision }),
      })
      expect(replaceMatches).not.toHaveBeenCalled()
      expect(store.getter(findReplaceErrorAtom)?.code).toBe(entry.expected)
    }

    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      searchRange: async (request) => resultFor(request),
    })
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_REPLACE_UNAVAILABLE')
  })

  test.each(['close', 'retarget', 'A-B-A'])(
    '%s after dispatch keeps an exact acknowledgement unresolved and blocks resend',
    async (mode) => {
      const store = createStore()
      prepareStore(store)
      await establishTicket(store)
      const result = deferred<ReplaceMatchesResponse>()
      let mutationRequest!: ReplaceMatchesRequest
      const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) => {
        mutationRequest = request
        return result.promise
      })
      const pending = store.setter(runFindReplaceMutationAtom, {
        action: 'replace-current',
        replaceMatches,
        searchRange: async (request) => resultFor(request),
      })
      await Promise.resolve()
      if (mode === 'close') {
        store.setter(closeFindReplaceAtom)
        store.setter(openFindReplaceAtom)
      } else {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet2' })
        if (mode === 'A-B-A') {
          store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
        }
      }
      result.resolve(exactAcknowledgement(mutationRequest, 2))
      await pending
      expect(replaceMatches).toHaveBeenCalledTimes(1)
      expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
        acknowledgedCount: 0,
        outcomeUnknownCount: 1,
      })
      expect(store.getter(findReplaceMutationBlockedAtom)).toBe(true)
    },
  )

  test('projection acceptance failure requires an explicit refresh-only recovery', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 2),
    )
    let projectionAttempts = 0
    const acceptAcknowledgedResult = jest.fn(async () => {
      projectionAttempts += 1
      if (projectionAttempts === 1) throw new Error('projection unavailable')
    })
    const searchRange = jest.fn(async (request: SearchRangeRequest) =>
      resultFor(request, [match(1, 1)], 1, request.revision),
    )
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      acceptAcknowledgedResult,
      searchRange,
    })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(searchRange).not.toHaveBeenCalled()
    expect(store.getter(findReplaceRefreshRecoveryAtom)).toMatchObject({
      status: 'required',
      phase: 'projection',
    })
    await store.setter(runFindReplaceRefreshRecoveryAtom, {
      acceptAcknowledgedResult,
      searchRange,
    })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(acceptAcknowledgedResult).toHaveBeenCalledTimes(2)
    expect(searchRange).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
  })

  test('refresh search failure requires explicit recovery and cannot resend mutation', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, 2),
    )
    let searchAttempts = 0
    const searchRange = jest.fn(async (request: SearchRangeRequest) => {
      searchAttempts += 1
      if (searchAttempts === 1) throw new Error('refresh failed')
      return resultFor(request, [match(2, 2)], 1, request.revision)
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange,
    })
    expect(store.getter(findReplaceRefreshRecoveryAtom)).toMatchObject({
      status: 'required',
      phase: 'search',
    })
    await store.setter(runFindReplaceRefreshRecoveryAtom, {})
    expect(store.getter(findReplaceErrorAtom)?.code).toBe('FIND_REPLACE_SEARCH_UNAVAILABLE')
    await store.setter(runFindReplaceRefreshRecoveryAtom, { searchRange })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(searchRange).toHaveBeenCalledTimes(2)
    expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
  })

  test('timeout followed by a current exact late ACK requires refresh-only recovery', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const late = deferred<ReplaceMatchesResponse>()
    let request!: ReplaceMatchesRequest
    const replaceMatches = jest.fn(async (nextRequest: ReplaceMatchesRequest) => {
      request = nextRequest
      return late.promise
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange: async (nextRequest) => resultFor(nextRequest),
      timeoutMs: 1,
    })
    expect(store.getter(findReplaceOperationDiagnosticsAtom).outcomeUnknownCount).toBe(1)
    late.resolve(exactAcknowledgement(request, 2))
    await flushPromises()
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      acknowledgedCount: 1,
      outcomeUnknownCount: 0,
    })
    expect(store.getter(findReplaceRefreshRecoveryAtom)).toMatchObject({
      status: 'required',
      phase: 'search',
    })
    const refreshSearch = jest.fn(async (nextRequest: SearchRangeRequest) =>
      resultFor(nextRequest, [match(1, 1)], 1, nextRequest.revision),
    )
    await store.setter(runFindReplaceRefreshRecoveryAtom, { searchRange: refreshSearch })
    expect(replaceMatches).toHaveBeenCalledTimes(1)
    expect(refreshSearch).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
  })

  test('timeout followed by stale exact late ACK remains outcome-unknown', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const late = deferred<ReplaceMatchesResponse>()
    let request!: ReplaceMatchesRequest
    const replaceMatches = jest.fn(async (nextRequest: ReplaceMatchesRequest) => {
      request = nextRequest
      return late.promise
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches,
      searchRange: async (nextRequest) => resultFor(nextRequest),
      timeoutMs: 1,
    })
    store.setter(closeFindReplaceAtom)
    store.setter(openFindReplaceAtom)
    late.resolve(exactAcknowledgement(request, 2))
    await flushPromises()
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      acknowledgedCount: 0,
      outcomeUnknownCount: 1,
    })
    expect(store.getter(findReplaceRefreshRecoveryAtom).status).toBe('idle')
  })

  test('acknowledged ledger is capped at 32 and unresolved evidence applies backpressure', async () => {
    const store = createStore()
    prepareStore(store)
    await establishTicket(store)
    const replaceMatches = jest.fn(async (request: ReplaceMatchesRequest) =>
      exactAcknowledgement(request, request.requestId!),
    )
    const searchRange = async (request: SearchRangeRequest): Promise<SearchRangeResult> =>
      resultFor(request, [match(0, 0)], 1, request.revision)
    for (let index = 0; index < 33; index += 1) {
      await store.setter(runFindReplaceMutationAtom, {
        action: 'replace-current',
        replaceMatches,
        searchRange,
      })
    }
    expect(replaceMatches).toHaveBeenCalledTimes(33)
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      count: 32,
      acknowledgedCount: 32,
      outcomeUnknownCount: 0,
    })

    const unknown = jest.fn(async (): Promise<ReplaceMatchesResponse> => {
      throw new Error('unknown outcome')
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: unknown,
      searchRange,
    })
    await store.setter(runFindReplaceMutationAtom, {
      action: 'replace-current',
      replaceMatches: unknown,
      searchRange,
    })
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(store.getter(findReplaceOperationDiagnosticsAtom)).toMatchObject({
      count: 32,
      acknowledgedCount: 31,
      outcomeUnknownCount: 1,
    })
  })

  test('two stores keep lifecycle, result tickets and ledgers isolated', async () => {
    const first = createStore()
    const second = createStore()
    prepareStore(first)
    prepareStore(second, { sheetId: 'sheet2' })
    await establishTicket(first)
    expect(first.getter(findReplaceSessionAtom).hasTicketedResult).toBe(true)
    expect(second.getter(findReplaceSessionAtom).hasTicketedResult).toBe(false)
    first.setter(syncFindReplaceTargetAtom)
    expect(second.getter(findReplaceOperationDiagnosticsAtom).count).toBe(0)
    expect(second.getter(findReplacePendingAtom)).toBe(false)
  })
})
