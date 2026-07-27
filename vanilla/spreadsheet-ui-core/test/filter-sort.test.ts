import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  FILTER_SORT_ACKNOWLEDGEMENT_ERROR,
  FILTER_SORT_CAPABILITY_ERROR,
  FILTER_SORT_INVALID_INPUT_ERROR,
  FILTER_SORT_OUTCOME_UNKNOWN_ERROR,
  FILTER_SORT_PENDING_ERROR,
  FILTER_SORT_REFRESH_TIMEOUT_ERROR,
  FILTER_SORT_TRANSPORT_TIMEOUT_ERROR,
  MAX_FILTER_LIST_VALUES,
  MAX_FILTER_SORT_SHEETS,
  acquireHistoryProducerReservationAtom,
  captureFilterSortCapabilityAtom,
  clearHistoryAtom,
  clearColumnFilterSortAtom,
  clearColumnFilterRulesAtom,
  clearFilterSortAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortDraftAtom,
  filterSortCapabilityAtom,
  filterSortCanCloseAtom,
  filterSortEntrypointProjectionAtom,
  filterSortEntrypointStateAtom,
  filterSortErrorAtom,
  filterSortLifecycleAtom,
  filterSortSessionIdAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  getFilterHiddenRowsForSheet,
  historyStackAtom,
  issueFilterSortSyncTicketAtom,
  notifyActiveSheetChangedAtom,
  openFilterDropdownAtom,
  openFilterDropdownFromEntrypointAtom,
  physicalSortDiagnosticAtom,
  reapplyFilterAtom,
  reconcileFilterSortRulesFromEngineAtom,
  releaseHistoryProducerReservationAtom,
  retryFilterSortRefreshAtom,
  runFilterSortMutationAtom,
  runPhysicalSortAtom,
  selectionAtom,
  setFilterSortAtom,
  setFilterSortErrorAtom,
  setViewportFilterHiddenRowsAtom,
  setWorkspaceActiveSheetAtom,
  updateFilterSortAvailableValuesAtom,
  updateFilterSortDraftAtom,
  viewportFilterHiddenAtom,
} from '../src'
import type {
  CellRange,
  ColumnFilterRule,
  FilterSortControllerPort,
  FilterSortMutationResult,
  FilterSortState,
  PhysicalSortControllerPort,
  ReapplyFilterInput,
  RetryFilterSortRefreshInput,
  RunFilterSortMutationInput,
  RunPhysicalSortInput,
  SetFilterSortRequest,
  SortRangeRequest,
  SortRangeResult,
} from '../src'

function makeStore() {
  return createStore()
}

function expectHistoryProducerLaneAvailable(store: ReturnType<typeof makeStore>): void {
  const reservation = store.setter(acquireHistoryProducerReservationAtom)
  expect(reservation).not.toBeNull()
  if (reservation !== null) {
    expect(store.setter(releaseHistoryProducerReservationAtom, reservation)).toBe(true)
  }
}

const emptyState: FilterSortState = { rules: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('filterSortStateAtom', () => {
  test('initial state is empty map', () => {
    const store = makeStore()
    expect(store.getter(filterSortStateAtom)).toEqual({})
  })
})

describe('filterDropdownAtom', () => {
  test('initial state is closed', () => {
    const store = makeStore()
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })
})

describe('public filter and sort state boundary', () => {
  test('exports product state atoms without public write authority', () => {
    expect(
      [
        filterSortStateAtom,
        filterDropdownAtom,
        filterSortErrorAtom,
        filterSortSyncTicketAtom,
        filterSortSessionIdAtom,
        filterSortCapabilityAtom,
        filterSortDraftAtom,
        filterSortLifecycleAtom,
      ].map((stateAtom) => 'write' in stateAtom),
    ).toEqual([false, false, false, false, false, false, false, false])
  })

  test('publishes deeply immutable state, dropdown, draft, and lifecycle snapshots', () => {
    const store = makeStore()
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }
    const inputValues = ['two', 'one', 'two']
    const inputRule = { kind: 'list' as const, colIndex: 0, values: inputValues }
    store.setter(setFilterSortAtom, { sheetId: 'A', state: { rules: [inputRule] } })
    inputRule.colIndex = 7
    inputValues[0] = 'changed-after-dispatch'
    store.setter(captureFilterSortCapabilityAtom, source)
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 0 })
    const sessionId = store.getter(filterSortSessionIdAtom)
    store.setter(updateFilterSortDraftAtom, {
      sessionId,
      patch: { selectedValues: ['two'] },
    })
    store.setter(updateFilterSortAvailableValuesAtom, {
      sessionId,
      sheetId: 'A',
      colIndex: 0,
      values: ['three'],
    })

    const stateBySheet = store.getter(filterSortStateAtom)
    const state = stateBySheet['A']!
    const listRule = state.rules[0]!
    const dropdown = store.getter(filterDropdownAtom)
    const draft = store.getter(filterSortDraftAtom)
    const lifecycle = store.getter(filterSortLifecycleAtom)

    expect(Object.isFrozen(stateBySheet)).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(state.rules[0]?.colIndex).toBe(0)
    expect(Object.isFrozen(state.rules)).toBe(true)
    expect(Object.isFrozen(listRule)).toBe(true)
    expect(listRule.kind).toBe('list')
    if (listRule.kind === 'list') {
      expect(listRule.values).toEqual(['two', 'one', 'two'])
      expect(Object.isFrozen(listRule.values)).toBe(true)
    }
    expect(Object.isFrozen(dropdown)).toBe(true)
    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.selectedValues)).toBe(true)
    expect(Object.isFrozen(draft.availableValues)).toBe(true)
    expect(Object.isFrozen(lifecycle)).toBe(true)
  })
})

describe('setFilterSortAtom', () => {
  test('stores state per sheet', () => {
    const store = makeStore()
    const state: FilterSortState = {
      rules: [{ kind: 'equals', colIndex: 0, value: 'foo' }],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    expect(store.getter(filterSortStateAtom)['A']).toEqual(state)
  })

  test('subsequent set for same sheet overwrites', () => {
    const store = makeStore()
    const s1: FilterSortState = {
      rules: [{ kind: 'equals', colIndex: 0, value: 'a' }],
    }
    const s2: FilterSortState = {
      rules: [{ kind: 'contains', colIndex: 1, value: 'b' }],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state: s1 })
    store.setter(setFilterSortAtom, { sheetId: 'A', state: s2 })
    expect(store.getter(filterSortStateAtom)['A']).toEqual(s2)
  })

  test('set for different sheets adds new entry', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(setFilterSortAtom, { sheetId: 'B', state: emptyState })
    const bySheet = store.getter(filterSortStateAtom)
    expect(Object.keys(bySheet).sort()).toEqual(['A', 'B'])
  })

  test('caps per-sheet state and deterministically evicts the oldest inserted sheet', () => {
    const store = makeStore()
    const insertedSheetIds = Array.from({ length: MAX_FILTER_SORT_SHEETS }, (_, index) =>
      String(MAX_FILTER_SORT_SHEETS - index),
    )
    for (const sheetId of insertedSheetIds) {
      store.setter(setFilterSortAtom, { sheetId, state: emptyState })
    }

    const atLimit = store.getter(filterSortStateAtom)
    expect(Object.keys(atLimit)).toHaveLength(MAX_FILTER_SORT_SHEETS)
    expect(atLimit[insertedSheetIds[0]!]).toBeDefined()

    store.setter(setFilterSortAtom, { sheetId: 'overflow', state: emptyState })

    const afterOverflow = store.getter(filterSortStateAtom)
    expect(Object.keys(afterOverflow)).toHaveLength(MAX_FILTER_SORT_SHEETS)
    expect(afterOverflow[insertedSheetIds[0]!]).toBeUndefined()
    expect(afterOverflow[insertedSheetIds[1]!]).toBeDefined()
    expect(afterOverflow['overflow']).toBeDefined()
    expect(Object.isFrozen(afterOverflow)).toBe(true)
    expect(Object.isFrozen(afterOverflow['overflow'])).toBe(true)
    expect(Object.isFrozen(afterOverflow['overflow']!.rules)).toBe(true)
  })

  test('updates an existing sheet at the cap without evicting or reordering entries', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_FILTER_SORT_SHEETS; index += 1) {
      store.setter(setFilterSortAtom, { sheetId: `sheet-${index}`, state: emptyState })
    }
    const updatedState: FilterSortState = {
      rules: [{ kind: 'equals', colIndex: 2, value: 'updated' }],
    }

    store.setter(setFilterSortAtom, { sheetId: 'sheet-0', state: updatedState })

    const afterUpdate = store.getter(filterSortStateAtom)
    expect(Object.keys(afterUpdate)).toHaveLength(MAX_FILTER_SORT_SHEETS)
    expect(afterUpdate['sheet-0']).toEqual(updatedState)
    expect(afterUpdate['sheet-1']).toBeDefined()
    expect(afterUpdate[`sheet-${MAX_FILTER_SORT_SHEETS - 1}`]).toBeDefined()

    store.setter(setFilterSortAtom, { sheetId: 'new-sheet', state: emptyState })

    const afterNextInsert = store.getter(filterSortStateAtom)
    expect(Object.keys(afterNextInsert)).toHaveLength(MAX_FILTER_SORT_SHEETS)
    expect(afterNextInsert['sheet-0']).toBeUndefined()
    expect(afterNextInsert['sheet-1']).toBeDefined()
    expect(afterNextInsert['new-sheet']).toBeDefined()
  })

  test('list rule with 10001 values is truncated to MAX_FILTER_LIST_VALUES', () => {
    const store = makeStore()
    const values = Array.from({ length: MAX_FILTER_LIST_VALUES + 1 }, (_, i) => String(i))
    const state: FilterSortState = {
      rules: [{ kind: 'list', colIndex: 0, values }],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    const stored = store.getter(filterSortStateAtom)['A']
    const rule = stored.rules[0]
    expect(rule.kind).toBe('list')
    if (rule.kind === 'list') {
      expect(rule.values.length).toBe(MAX_FILTER_LIST_VALUES)
    }
  })

  test('list rule at exactly MAX_FILTER_LIST_VALUES is kept intact', () => {
    const store = makeStore()
    const values = Array.from({ length: MAX_FILTER_LIST_VALUES }, (_, i) => String(i))
    const state: FilterSortState = {
      rules: [{ kind: 'list', colIndex: 0, values }],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    const stored = store.getter(filterSortStateAtom)['A']
    const rule = stored.rules[0]
    if (rule.kind === 'list') {
      expect(rule.values.length).toBe(MAX_FILTER_LIST_VALUES)
    }
  })
})

describe('clearFilterSortAtom', () => {
  test('removes the sheet entry', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(setFilterSortAtom, { sheetId: 'B', state: emptyState })
    store.setter(clearFilterSortAtom, 'A')
    const bySheet = store.getter(filterSortStateAtom)
    expect('A' in bySheet).toBe(false)
    expect('B' in bySheet).toBe(true)
  })

  test('closes any open dropdown', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(clearFilterSortAtom, 'A')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })

  test('explicit clear frees capacity without evicting another sheet on the next insert', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_FILTER_SORT_SHEETS; index += 1) {
      store.setter(setFilterSortAtom, { sheetId: `sheet-${index}`, state: emptyState })
    }

    store.setter(clearFilterSortAtom, 'sheet-0')
    store.setter(setFilterSortAtom, { sheetId: 'replacement', state: emptyState })

    const bySheet = store.getter(filterSortStateAtom)
    expect(Object.keys(bySheet)).toHaveLength(MAX_FILTER_SORT_SHEETS)
    expect(bySheet['sheet-0']).toBeUndefined()
    expect(bySheet['sheet-1']).toBeDefined()
    expect(bySheet['replacement']).toBeDefined()
    expect(Object.isFrozen(bySheet)).toBe(true)
  })
})

describe('clearColumnFilterSortAtom', () => {
  test('removes the rules for the column', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: {
        rules: [
          { kind: 'equals', colIndex: 1, value: 'x' },
          { kind: 'equals', colIndex: 2, value: 'y' },
        ],
      },
    })
    store.setter(clearColumnFilterSortAtom, { sheetId: 'A', colIndex: 1 })
    const state = store.getter(filterSortStateAtom)['A']
    expect(state?.rules).toEqual([{ kind: 'equals', colIndex: 2, value: 'y' }])
  })

  test('no-op when sheet has no state', () => {
    const store = makeStore()
    store.setter(clearColumnFilterSortAtom, { sheetId: 'missing', colIndex: 0 })
    expect(store.getter(filterSortStateAtom)).toEqual({})
  })

  test('no-op when the column has no rule', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: { rules: [{ kind: 'equals', colIndex: 1, value: 'x' }] },
    })
    const before = store.getter(filterSortStateAtom)
    store.setter(clearColumnFilterSortAtom, { sheetId: 'A', colIndex: 9 })
    expect(store.getter(filterSortStateAtom)).toBe(before)
  })
})

describe('clearColumnFilterRulesAtom', () => {
  test('removes only the rules for the requested column', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: {
        rules: [
          { kind: 'equals', colIndex: 1, value: 'x' },
          { kind: 'equals', colIndex: 2, value: 'y' },
        ],
      },
    })

    store.setter(clearColumnFilterRulesAtom, { sheetId: 'A', colIndex: 1 })

    const state = store.getter(filterSortStateAtom)['A']
    expect(state?.rules).toEqual([{ kind: 'equals', colIndex: 2, value: 'y' }])
  })
})

describe('setFilterSortErrorAtom', () => {
  test('initial error is empty string', () => {
    const store = makeStore()
    expect(store.getter(filterSortErrorAtom)).toBe('')
  })

  test('stores Error.message', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, new Error('boom'))
    expect(store.getter(filterSortErrorAtom)).toBe('boom')
  })

  test('stores non-Error stringified', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, 'plain')
    expect(store.getter(filterSortErrorAtom)).toBe('plain')
  })

  test('null clears the error', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, new Error('boom'))
    store.setter(setFilterSortErrorAtom, null)
    expect(store.getter(filterSortErrorAtom)).toBe('')
  })
})

describe('issueFilterSortSyncTicketAtom', () => {
  test('starts at 0 and each issue returns a monotonically increasing ticket', () => {
    const store = makeStore()
    expect(store.getter(filterSortSyncTicketAtom)).toBe(0)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(1)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(2)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(3)
    expect(store.getter(filterSortSyncTicketAtom)).toBe(3)
  })

  test('two separate stores have independent ticket counters', () => {
    const a = makeStore()
    const b = makeStore()
    a.setter(issueFilterSortSyncTicketAtom)
    a.setter(issueFilterSortSyncTicketAtom)
    expect(a.getter(filterSortSyncTicketAtom)).toBe(2)
    expect(b.getter(filterSortSyncTicketAtom)).toBe(0)
    expect(b.setter(issueFilterSortSyncTicketAtom)).toBe(1)
    expect(a.getter(filterSortSyncTicketAtom)).toBe(2)
  })
})

describe('openFilterDropdownAtom', () => {
  test('sets dropdown to open with sheetId and colIndex', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 3 })
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'X', colIndex: 3 })
  })

  test('replaces existing open dropdown when called again', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 1 })
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 5 })
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'X', colIndex: 5 })
  })
})

describe('closeFilterDropdownAtom', () => {
  test('resets dropdown to closed', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 0 })
    expect(store.getter(filterSortCanCloseAtom)).toBe(true)
    store.setter(closeFilterDropdownAtom)
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })
})

describe('notifyActiveSheetChangedAtom', () => {
  test('dropdown already closed — stays closed after sheet switch', () => {
    const store = makeStore()
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })

  test('dropdown open on sheet A — closes when switching to sheet B', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })

  test('dropdown open on sheet A — stays open when notified with same sheet A', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(notifyActiveSheetChangedAtom, 'A')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'A', colIndex: 2 })
  })

  test('filterSortStateAtom is untouched by sheet switch notification', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 0 })
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterSortStateAtom)['A']).toEqual(emptyState)
  })
})

describe('Core-owned filter/sort mutation lifecycle', () => {
  function openWithCapability(
    store: ReturnType<typeof makeStore>,
    source: FilterSortControllerPort,
    colIndex = 1,
  ) {
    store.setter(captureFilterSortCapabilityAtom, source)
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex })
    return store.getter(filterSortDraftAtom).sessionId
  }

  /**
   * Open a dropdown session whose draft already carries an equals condition,
   * so `apply-draft` commits an observable rule. Sort intents no longer exist
   * (#24 retired the display permutation); filter rules are the only payload
   * this transport lane ever carries.
   */
  function openWithEqualsDraft(
    store: ReturnType<typeof makeStore>,
    source: FilterSortControllerPort,
    value: string,
    colIndex = 1,
  ) {
    const sessionId = openWithCapability(store, source, colIndex)
    store.setter(updateFilterSortDraftAtom, {
      sessionId,
      patch: { conditionKind: 'equals', equalsInput: value },
    })
    return sessionId
  }

  const equalsRule = (colIndex: number, value: string): ColumnFilterRule => ({
    kind: 'equals',
    colIndex,
    value,
  })

  const applyDraft = { kind: 'apply-draft' } as const

  test('opens with a Core-owned draft whose default condition is none', () => {
    const store = makeStore()
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }

    const sessionId = openWithCapability(store, source, 2)

    expect(store.getter(filterSortDraftAtom)).toMatchObject({
      sessionId,
      sheetId: 'A',
      colIndex: 2,
      conditionKind: 'none',
      selectionMode: 'all',
    })
    expect(store.getter(filterSortLifecycleAtom)).toEqual({
      status: 'editing',
      sessionId,
      requestId: null,
      sheetId: 'A',
      colIndex: 2,
    })
  })

  test('missing setFilterSort blocks inline without transport or committed mutation', async () => {
    const store = makeStore()
    const source: FilterSortControllerPort = {}
    const sessionId = openWithEqualsDraft(store, source, 'x')

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(store.getter(filterSortStateAtom)).toEqual({})
    expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked')
    expect(store.getter(filterSortErrorAtom)).toBe(FILTER_SORT_CAPABILITY_ERROR)
  })

  test(
    'an external history reservation blocks apply before transport without over-releasing',
    async () => {
    const store = makeStore()
    const calls: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        calls.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: true,
          revision: 1,
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    const externalReservation = store.setter(acquireHistoryProducerReservationAtom)
    expect(externalReservation).not.toBeNull()

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(calls).toHaveLength(0)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked')
    expect(store.getter(filterSortErrorAtom)).toBe(FILTER_SORT_PENDING_ERROR)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    if (externalReservation !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, externalReservation)).toBe(true)
    }
    expectHistoryProducerLaneAvailable(store)
  })

  test('reserves pending synchronously, blocks double dispatch, and commits only after strict ack', async () => {
    const store = makeStore()
    const acknowledgement = deferred<FilterSortMutationResult>()
    const calls: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      setFilterSort(request) {
        calls.push(request)
        return acknowledgement.promise
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    const input = {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    }

    const first = store.setter(runFilterSortMutationAtom, input)
    const second = store.setter(runFilterSortMutationAtom, input)
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('pending')
    expect(store.getter(filterSortStateAtom)['A']).toBeUndefined()
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    acknowledgement.resolve({
      sheetId: 'A',
      requestId: calls[0]!.requestId,
      historyRecorded: false,
      revision: 2,
      hiddenRowIndices: [],
    })
    await Promise.all([first, second])

    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'a source getter that re-enters then throws cannot overwrite the replacement mutation',
    async () => {
    const store = makeStore()
    const requests: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        requests.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: false,
          revision: 2,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'replacement')
    const stableInput: RunFilterSortMutationInput = {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    }
    let replacement: Promise<void> | undefined
    const hostileInput = Object.create(null) as RunFilterSortMutationInput
    Object.defineProperty(hostileInput, 'source', {
      get() {
        replacement = store.setter(runFilterSortMutationAtom, stableInput)
        throw new Error('outer source getter failed after re-entry')
      },
    })

    await store.setter(runFilterSortMutationAtom, hostileInput)
    await replacement

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'replacement')])
    expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    expect(store.getter(filterSortErrorAtom)).toBe('')
    expectHistoryProducerLaneAvailable(store)
  })

  test('requests recordHistory and pushes ONE paired filter.set entry when the backend recorded', async () => {
    const store = makeStore()
    const calls: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        calls.push(request)
        // The adapter is the sole judge of "changed"; it recorded, so UI core
        // must pair exactly one entry.
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 7,
          historyRecorded: true,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    // The apply carried the opt-in so the backend could record undoably.
    expect(calls[0]!.recordHistory).toBe(true)
    const entries = store.getter(historyStackAtom).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'filter.set', sheetId: 'A', projectionRevision: 7 })
    expect(calls).toHaveLength(1)
    expectHistoryProducerLaneAvailable(store)
  })

  test('pushes NO history entry when the backend reports historyRecorded falsy (no skew)', async () => {
    const store = makeStore()
    const source: FilterSortControllerPort = {
      // A strictly acknowledged no-op: the apply committed but nothing was
      // recorded, so pushing a UI-core entry would offset the stacks by one.
      async setFilterSort(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 7,
          historyRecorded: false,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expectHistoryProducerLaneAvailable(store)
  })

  test('snapshots each host ACK getter and hidden-row item exactly once', async () => {
    const store = makeStore()
    const topLevelReads = {
      sheetId: 0,
      requestId: 0,
      historyRecorded: 0,
      revision: 0,
      hiddenRowIndices: 0,
    }
    const hiddenReads = { length: 0, 0: 0, 1: 0 }
    const hiddenRows = new Proxy([2, 4], {
      get(target, property, receiver) {
        if (property === 'length' || property === '0' || property === '1') {
          hiddenReads[property] += 1
          if (hiddenReads[property] > 1) {
            throw new Error(`hidden row ${property} was read twice`)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    let capturedRequest: SetFilterSortRequest | undefined
    const acknowledgement = new Proxy(Object.create(null) as FilterSortMutationResult, {
      get(_target, property) {
        if (
          property === 'sheetId' ||
          property === 'requestId' ||
          property === 'historyRecorded' ||
          property === 'revision' ||
          property === 'hiddenRowIndices'
        ) {
          topLevelReads[property] += 1
          if (topLevelReads[property] > 1) {
            throw new Error(`${property} was read twice`)
          }
        }
        switch (property) {
          case 'sheetId':
            return capturedRequest?.sheetId
          case 'requestId':
            return capturedRequest?.requestId
          case 'historyRecorded':
            return true
          case 'revision':
            return 17
          case 'hiddenRowIndices':
            return hiddenRows
          default:
            return undefined
        }
      },
    })
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        capturedRequest = request
        return acknowledgement
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(topLevelReads).toEqual({
      sheetId: 1,
      requestId: 1,
      historyRecorded: 1,
      revision: 1,
      hiddenRowIndices: 1,
    })
    expect(hiddenReads).toEqual({ length: 1, 0: 1, 1: 1 })
    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    const committedHiddenRows = getFilterHiddenRowsForSheet(
      store.getter(viewportFilterHiddenAtom),
      'A',
    )
    expect(committedHiddenRows).toEqual([2, 4])
    expect(committedHiddenRows).not.toBe(hiddenRows)
    expect(store.getter(historyStackAtom).entries[0]?.projectionRevision).toBe(17)
    expectHistoryProducerLaneAvailable(store)
  })

  test.each([
    [
      'missing historyRecorded',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 7,
        hiddenRowIndices: [],
      }),
    ],
    [
      'missing hiddenRowIndices',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: 7,
      }),
    ],
    [
      'missing revision',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        hiddenRowIndices: [],
      }),
    ],
    [
      'NaN revision',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: Number.NaN,
        hiddenRowIndices: [],
      }),
    ],
    [
      'empty-string revision',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: '',
        hiddenRowIndices: [],
      }),
    ],
    [
      'negative hidden row index',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: 7,
        hiddenRowIndices: [-1],
      }),
    ],
    [
      'fractional hidden row index',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: 7,
        hiddenRowIndices: [1.5],
      }),
    ],
    [
      'unsafe hidden row index',
      (request: SetFilterSortRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        historyRecorded: false,
        revision: 7,
        hiddenRowIndices: [Number.MAX_SAFE_INTEGER + 1],
      }),
    ],
  ])('%s makes the apply outcome uncertain without committing', async (_label, resultFor) => {
    const store = makeStore()
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        return resultFor(request)
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(filterSortStateAtom)).toEqual({})
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('a malformed transaction verdict retains the apply ticket and reservation', async () => {
    const store = makeStore()
    let transportCalls = 0
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        transportCalls += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: 'not-a-verdict',
          revision: 7,
        } as unknown as FilterSortMutationResult
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(transportCalls).toBe(1)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(filterSortStateAtom)).toEqual({})
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })
    expect(transportCalls).toBe(1)
  })

  test('a malformed revision retains the apply ticket and reservation', async () => {
    const store = makeStore()
    let transportCalls = 0
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        transportCalls += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: true,
          revision: { malformed: true },
          hiddenRowIndices: [],
        } as unknown as FilterSortMutationResult
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(transportCalls).toBe(1)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(filterSortStateAtom)).toEqual({})
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('reconcileFilterSortRulesFromEngineAtom set-or-removes the committed rules', () => {
    const store = makeStore()
    // Absent → present (undo of a clear / redo of an apply).
    store.setter(reconcileFilterSortRulesFromEngineAtom, {
      sheetId: 'A',
      rules: [equalsRule(1, 'x')],
    })
    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    // Present → absent (undo of an apply): empty rules REMOVE the entry, they
    // do not leave an inert `{rules:[]}` the funnel indicator would misread.
    store.setter(reconcileFilterSortRulesFromEngineAtom, { sheetId: 'A', rules: [] })
    expect(store.getter(filterSortStateAtom)).toEqual({})
  })

  test.each([
    ['requestId', (request: SetFilterSortRequest) => ({ sheetId: request.sheetId, requestId: 99 })],
    [
      'sheetId',
      (request: SetFilterSortRequest) => ({ sheetId: 'B', requestId: request.requestId }),
    ],
  ])(
    'retains a non-resendable ticket after a mismatched %s acknowledgement',
    async (_field, resultFor) => {
      const store = makeStore()
      const calls: SetFilterSortRequest[] = []
      const source: FilterSortControllerPort = {
        async setFilterSort(request) {
          calls.push(request)
          return resultFor(request)
        },
      }
      const sessionId = openWithEqualsDraft(store, source, 'x')
      const draftBefore = store.getter(filterSortDraftAtom)

      await store.setter(runFilterSortMutationAtom, {
        source,
        sessionId,
        intent: applyDraft,
        refreshProjection: async () => undefined,
      })

      expect(store.getter(filterSortStateAtom)).toEqual({})
      expect(store.getter(filterSortDraftAtom)).toEqual(draftBefore)
      expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(filterSortErrorAtom)).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
      expect(store.getter(filterSortErrorAtom)).toContain(FILTER_SORT_ACKNOWLEDGEMENT_ERROR)
      expect(store.getter(filterSortCanCloseAtom)).toBe(false)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      await store.setter(runFilterSortMutationAtom, {
        source,
        sessionId,
        intent: applyDraft,
        refreshProjection: async () => undefined,
      })

      let refreshCalls = 0
      await store.setter(retryFilterSortRefreshAtom, {
        refreshProjection: async () => {
          refreshCalls += 1
        },
      })

      expect(calls).toHaveLength(1)
      expect(refreshCalls).toBe(0)
    },
  )

  test('transport rejection retains an outcome-unknown ticket and cannot be resent', async () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: { rules: [equalsRule(1, 'seed')] },
    })
    let calls = 0
    const source: FilterSortControllerPort = {
      async setFilterSort() {
        calls += 1
        throw new Error('transport rejected')
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'next')
    const draftBefore = store.getter(filterSortDraftAtom)

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })

    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'seed')])
    expect(store.getter(filterSortDraftAtom)).toEqual(draftBefore)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('outcome-unknown')
    expect(store.getter(filterSortErrorAtom)).toContain(FILTER_SORT_OUTCOME_UNKNOWN_ERROR)
    expect(store.getter(filterSortErrorAtom)).toContain('transport rejected')
    expect(store.getter(filterSortCanCloseAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })
    expect(calls).toBe(1)
  })

  test('pending close and direct reopen are inert so the active ticket can settle', async () => {
    const store = makeStore()
    const acknowledgement = deferred<FilterSortMutationResult>()
    let request: SetFilterSortRequest | undefined
    const source: FilterSortControllerPort = {
      setFilterSort(nextRequest) {
        request = nextRequest
        return acknowledgement.promise
      },
    }
    const oldSessionId = openWithEqualsDraft(store, source, 'x')
    const pending = store.setter(runFilterSortMutationAtom, {
      source,
      sessionId: oldSessionId,
      intent: applyDraft,
      refreshProjection: async () => undefined,
    })
    await Promise.resolve()

    expect(store.getter(filterSortCanCloseAtom)).toBe(false)
    store.setter(closeFilterDropdownAtom)
    store.setter(clearFilterSortAtom, 'A')
    store.setter(clearColumnFilterSortAtom, { sheetId: 'A', colIndex: 1 })
    store.setter(clearColumnFilterRulesAtom, { sheetId: 'A', colIndex: 1 })
    store.setter(captureFilterSortCapabilityAtom, {})
    store.setter(notifyActiveSheetChangedAtom, 'B')
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 3 })
    store.setter(openFilterDropdownFromEntrypointAtom, {
      source,
      entrypoint: 'toolbar',
    })
    expect(store.getter(filterDropdownAtom)).toEqual({
      status: 'open',
      sheetId: 'A',
      colIndex: 1,
    })
    expect(store.getter(filterSortCapabilityAtom)).toBe(true)
    expect(store.getter(filterSortDraftAtom).sessionId).toBe(oldSessionId)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('pending')

    acknowledgement.resolve({
      sheetId: 'A',
      requestId: request!.requestId,
      historyRecorded: false,
      revision: 2,
      hiddenRowIndices: [],
    })
    await pending

    expect(store.getter(filterSortCanCloseAtom)).toBe(true)
    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    expect(store.getter(filterSortLifecycleAtom)).toMatchObject({
      status: 'editing',
      sessionId: oldSessionId,
      sheetId: 'A',
      colIndex: 1,
    })
  })

  test('refresh failure keeps the acknowledged ticket and retry refresh never resends', async () => {
    const store = makeStore()
    let transportCalls = 0
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        transportCalls += 1
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: false,
          revision: 3,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    let refreshCalls = 0

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => {
        refreshCalls += 1
        expect(store.getter(filterSortLifecycleAtom).status).toBe('refreshing')
        throw new Error('projection failed')
      },
    })

    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    expect(store.getter(filterSortLifecycleAtom).status).toBe('refresh-failed')
    expect(store.getter(filterSortErrorAtom)).toContain('projection failed')
    expect(store.getter(filterSortCanCloseAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: async (sheetId) => {
        refreshCalls += 1
        expect(sheetId).toBe('A')
      },
    })

    expect(transportCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    expect(store.getter(filterSortCanCloseAtom)).toBe(true)
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'a mutation retry getter cannot bind its stale callback ' +
      'after a nested retry advances the ticket',
    async () => {
    const store = makeStore()
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: false,
          revision: 3,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionId = openWithEqualsDraft(store, source, 'x')
    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: applyDraft,
      refreshProjection: async () => {
        throw new Error('initial refresh failed')
      },
    })
    expect(store.getter(filterSortLifecycleAtom).status).toBe('refresh-failed')

    let replacementCalls = 0
    let staleCalls = 0
    let replacement: Promise<void> | undefined
    const hostileInput = Object.create(null) as RetryFilterSortRefreshInput
    Object.defineProperty(hostileInput, 'refreshProjection', {
      get() {
        replacement = store.setter(retryFilterSortRefreshAtom, {
          refreshProjection: async () => {
            replacementCalls += 1
          },
        })
        return async () => {
          staleCalls += 1
        }
      },
    })

    await store.setter(retryFilterSortRefreshAtom, hostileInput)
    await replacement

    expect(replacementCalls).toBe(1)
    expect(staleCalls).toBe(0)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    expectHistoryProducerLaneAvailable(store)
  })

  test('invalid range is inline-blocked before transport dispatch', async () => {
    const store = makeStore()
    const calls: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        calls.push(request)
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }
    const sessionId = openWithCapability(store, source)
    store.setter(updateFilterSortDraftAtom, {
      sessionId,
      patch: { conditionKind: 'range', rangeMinInput: '20', rangeMaxInput: '10' },
    })

    await store.setter(runFilterSortMutationAtom, {
      source,
      sessionId,
      intent: { kind: 'apply-draft' },
      refreshProjection: async () => undefined,
    })

    expect(calls).toHaveLength(0)
    expect(store.getter(filterSortLifecycleAtom).status).toBe('blocked')
    expect(store.getter(filterSortErrorAtom)).toBe(FILTER_SORT_INVALID_INPUT_ERROR)
  })

  test('independent stores reserve request and session sequences independently', async () => {
    const storeA = makeStore()
    const storeB = makeStore()
    const requestsA: SetFilterSortRequest[] = []
    const requestsB: SetFilterSortRequest[] = []
    const sourceA: FilterSortControllerPort = {
      async setFilterSort(request) {
        requestsA.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: false,
          revision: 1,
          hiddenRowIndices: [],
        }
      },
    }
    const sourceB: FilterSortControllerPort = {
      async setFilterSort(request) {
        requestsB.push(request)
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          historyRecorded: false,
          revision: 1,
          hiddenRowIndices: [],
        }
      },
    }
    const sessionA = openWithEqualsDraft(storeA, sourceA, 'a')
    const sessionB = openWithEqualsDraft(storeB, sourceB, 'b')

    await Promise.all([
      storeA.setter(runFilterSortMutationAtom, {
        source: sourceA,
        sessionId: sessionA,
        intent: applyDraft,
        refreshProjection: async () => undefined,
      }),
      storeB.setter(runFilterSortMutationAtom, {
        source: sourceB,
        sessionId: sessionB,
        intent: applyDraft,
        refreshProjection: async () => undefined,
      }),
    ])

    expect(requestsA[0]?.requestId).toBe(1)
    expect(requestsB[0]?.requestId).toBe(1)
    expect(storeA.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'a')])
    expect(storeB.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'b')])
  })
})

describe('shared history producer lane — physical sort', () => {
  const range: CellRange = { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 2 }
  const target = { sheetId: 'A', colIndex: 1 }

  function setPhysicalAuthority(
    store: ReturnType<typeof makeStore>,
    sheetId: string,
    colIndex: number,
  ): void {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId,
      anchor: { row: 0, col: colIndex },
      focus: { row: 0, col: colIndex },
    })
  }

  function appliedResult(
    request: SortRangeRequest,
    movedRows: number,
    revision: unknown = 11,
  ): SortRangeResult {
    return {
      kind: 'sort-range',
      sheetId: request.sheetId,
      applied: true,
      movedRows,
      movedCells: movedRows,
      affectedRange: request.range,
      requestId: request.requestId,
      revision,
    } as SortRangeResult
  }

  function sourceFor(
    execute: (request: SortRangeRequest) => SortRangeResult | Promise<SortRangeResult>,
  ): { source: PhysicalSortControllerPort; requests: SortRangeRequest[] } {
    const requests: SortRangeRequest[] = []
    return {
      source: {
        async sortRange(request) {
          requests.push(request)
          return execute(request)
        },
      },
      requests,
    }
  }

  const runInput = (source: PhysicalSortControllerPort) => ({
    source,
    entrypoint: 'toolbar' as const,
    direction: 'asc' as const,
    target,
    range,
    refreshProjection: async () => undefined,
  })

  test(
    'a source getter that re-enters then throws cannot overwrite the replacement physical sort',
    async () => {
    const store = makeStore()
    const { source, requests } = sourceFor((request) => appliedResult(request, 0))
    const stableInput = runInput(source)
    let replacement: Promise<void> | undefined
    const hostileInput = Object.create(null) as RunPhysicalSortInput
    Object.defineProperty(hostileInput, 'source', {
      get() {
        replacement = store.setter(runPhysicalSortAtom, stableInput)
        throw new Error('outer source getter failed after re-entry')
      },
    })

    await store.setter(runPhysicalSortAtom, hostileInput)
    await replacement

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expect(store.getter(physicalSortDiagnosticAtom)).toBeNull()
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'snapshots every physical-sort input and freezes the request before reservation',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: { rules: [{ kind: 'equals', colIndex: 1, value: 'x' }] },
    })
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'A', rows: [2] })

    const reads = {
      source: 0,
      transport: 0,
      entrypoint: 0,
      direction: 0,
      range: 0,
      target: 0,
      refreshProjection: 0,
      timeoutMs: 0,
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 0,
      sheetId: 0,
      colIndex: 0,
    }
    let rowStart = 1
    let rowEnd = 3
    let colStart = 0
    let colEnd = 2
    let targetSheetId = 'A'
    let targetColIndex = 1
    const callerRange = Object.create(null) as CellRange
    Object.defineProperties(callerRange, {
      rowStart: {
        get() {
          reads.rowStart += 1
          if (reads.rowStart > 1) throw new Error('rowStart was read twice')
          return rowStart
        },
      },
      rowEnd: {
        get() {
          reads.rowEnd += 1
          if (reads.rowEnd > 1) throw new Error('rowEnd was read twice')
          return rowEnd
        },
      },
      colStart: {
        get() {
          reads.colStart += 1
          if (reads.colStart > 1) throw new Error('colStart was read twice')
          return colStart
        },
      },
      colEnd: {
        get() {
          reads.colEnd += 1
          if (reads.colEnd > 1) throw new Error('colEnd was read twice')
          return colEnd
        },
      },
    })
    const callerTarget = Object.create(null) as { sheetId: string; colIndex: number }
    Object.defineProperties(callerTarget, {
      sheetId: {
        get() {
          reads.sheetId += 1
          if (reads.sheetId > 1) throw new Error('target sheetId was read twice')
          return targetSheetId
        },
      },
      colIndex: {
        get() {
          reads.colIndex += 1
          if (reads.colIndex > 1) throw new Error('target colIndex was read twice')
          return targetColIndex
        },
      },
    })

    const requests: SortRangeRequest[] = []
    let originalTransportCalls = 0
    let replacementTransportCalls = 0
    const originalTransport: NonNullable<PhysicalSortControllerPort['sortRange']> = async (
      request,
    ) => {
      originalTransportCalls += 1
      requests.push(request)
      return appliedResult(request, 0)
    }
    const replacementTransport: NonNullable<PhysicalSortControllerPort['sortRange']> = async (
      request,
    ) => {
      replacementTransportCalls += 1
      return appliedResult(request, 0)
    }
    let currentTransport = originalTransport
    const source = Object.create(null) as PhysicalSortControllerPort
    Object.defineProperty(source, 'sortRange', {
      get() {
        reads.transport += 1
        if (reads.transport > 1) throw new Error('sortRange was read twice')
        return currentTransport
      },
    })
    let originalRefreshCalls = 0
    let replacementRefreshCalls = 0
    let currentRefresh = async () => {
      originalRefreshCalls += 1
    }
    const input = Object.create(null) as RunPhysicalSortInput
    Object.defineProperties(input, {
      source: {
        get() {
          reads.source += 1
          if (reads.source > 1) throw new Error('source was read twice')
          return source
        },
      },
      entrypoint: {
        get() {
          reads.entrypoint += 1
          if (reads.entrypoint > 1) throw new Error('entrypoint was read twice')
          return 'toolbar'
        },
      },
      direction: {
        get() {
          reads.direction += 1
          if (reads.direction > 1) throw new Error('direction was read twice')
          return 'asc'
        },
      },
      range: {
        get() {
          reads.range += 1
          if (reads.range > 1) throw new Error('range was read twice')
          return callerRange
        },
      },
      target: {
        get() {
          reads.target += 1
          if (reads.target > 1) throw new Error('target was read twice')
          return callerTarget
        },
      },
      refreshProjection: {
        get() {
          reads.refreshProjection += 1
          if (reads.refreshProjection > 1) {
            throw new Error('refreshProjection was read twice')
          }
          return currentRefresh
        },
      },
      timeoutMs: {
        get() {
          reads.timeoutMs += 1
          if (reads.timeoutMs > 1) throw new Error('timeoutMs was read twice')
          return 100
        },
      },
    })

    const pending = store.setter(runPhysicalSortAtom, input)
    // The public command is now suspended at its first await: mutate every
    // caller-owned source and the hidden-row backing that built the request.
    rowStart = 10
    rowEnd = 20
    colStart = 10
    colEnd = 20
    targetSheetId = 'B'
    targetColIndex = 19
    currentTransport = replacementTransport
    currentRefresh = async () => {
      replacementRefreshCalls += 1
    }
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'A', rows: [3] })
    await pending

    expect(reads).toEqual({
      source: 1,
      transport: 1,
      entrypoint: 1,
      direction: 1,
      range: 1,
      target: 1,
      refreshProjection: 1,
      timeoutMs: 1,
      rowStart: 1,
      rowEnd: 1,
      colStart: 1,
      colEnd: 1,
      sheetId: 1,
      colIndex: 1,
    })
    expect(originalTransportCalls).toBe(1)
    expect(replacementTransportCalls).toBe(0)
    expect(originalRefreshCalls).toBe(1)
    expect(replacementRefreshCalls).toBe(0)
    expect(requests[0]).toEqual({
      kind: 'sort-range',
      sheetId: 'A',
      range,
      keys: [{ col: 1, direction: 'asc' }],
      excludedRows: [2],
      requestId: 1,
    })
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen(requests[0]!.range)).toBe(true)
    expect(Object.isFrozen(requests[0]!.keys)).toBe(true)
    expect(Object.isFrozen(requests[0]!.keys[0])).toBe(true)
    expect(Object.isFrozen(requests[0]!.excludedRows)).toBe(true)
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'an external reservation blocks transport and remains owned by its exact token',
    async () => {
    const store = makeStore()
    const { source, requests } = sourceFor((request) => appliedResult(request, 2))
    const externalReservation = store.setter(acquireHistoryProducerReservationAtom)
    expect(externalReservation).not.toBeNull()

    await store.setter(runPhysicalSortAtom, runInput(source))

    expect(requests).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'blocked',
      error: FILTER_SORT_PENDING_ERROR,
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    if (externalReservation !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, externalReservation)).toBe(true)
    }
    expectHistoryProducerLaneAvailable(store)
  })

  test('an explicit target ignores selection drift and still completes', async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const { source, requests } = sourceFor((request) => appliedResult(request, 0))

    const pending = store.setter(runPhysicalSortAtom, runInput(source))
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'A',
      anchor: { row: 0, col: 2 },
      focus: { row: 0, col: 2 },
    })
    await pending

    expect(requests).toHaveLength(1)
    expect(requests[0]?.sheetId).toBe('A')
    expect(requests[0]?.keys[0]?.col).toBe(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test('selection-derived target drift releases the unsent ticket as stale', async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const { source, requests } = sourceFor((request) => appliedResult(request, 0))

    const pending = store.setter(runPhysicalSortAtom, {
      source,
      entrypoint: 'toolbar',
      direction: 'asc',
      range,
      refreshProjection: async () => undefined,
    })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'A',
      anchor: { row: 0, col: 2 },
      focus: { row: 0, col: 2 },
    })
    await pending

    expect(requests).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('stale')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'explicit-target workspace drift before transport releases only the unsent ticket',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const { source, requests } = sourceFor((request) => appliedResult(request, 2))

    const pending = store.setter(runPhysicalSortAtom, runInput(source))
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'B' })
    await pending

    expect(requests).toHaveLength(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('stale')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'authority drift after transport but before an applied ACK still settles to idle',
    async () => {
    // The authority gate is only valid BEFORE dispatch (#50 follow-up): once
    // the transport has run, a well-formed matching ACK must be processed to
    // completion — history push, projection refresh, and lane release all
    // happen regardless of authority drift.
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const acknowledgement = deferred<SortRangeResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)
    let refreshCalls = 0

    const pending = store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        refreshCalls += 1
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    const activeIdentity = store.getter(filterSortEntrypointStateAtom)

    setPhysicalAuthority(store, 'B', 1)
    acknowledgement.resolve(appliedResult(requests[0]!, 2))
    await pending

    expect(refreshCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'idle',
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'authority drift after transport but before a structured rejection still settles to error',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const acknowledgement = deferred<SortRangeResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)
    let refreshCalls = 0

    const pending = store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        refreshCalls += 1
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    const activeIdentity = store.getter(filterSortEntrypointStateAtom)

    setPhysicalAuthority(store, 'B', 1)
    acknowledgement.resolve({
      kind: 'sort-range-not-applied',
      sheetId: requests[0]!.sheetId,
      applied: false,
      code: 'merge-in-range',
      requestId: requests[0]!.requestId,
      revision: 10,
    })
    await pending

    expect(refreshCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'error',
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expectHistoryProducerLaneAvailable(store)
  })

  test('pending owns the lane; one moved sort pairs one history entry and releases', async () => {
    const store = makeStore()
    const acknowledgement = deferred<SortRangeResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)

    const pending = store.setter(runPhysicalSortAtom, runInput(source))
    await Promise.resolve()
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    acknowledgement.resolve(appliedResult(requests[0]!, 2))
    await pending

    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries[0]).toMatchObject({
      kind: 'range.sort',
      sheetId: 'A',
      projectionRevision: 11,
      affectedRange: range,
    })
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test('a strictly acknowledged no-op pushes no history and releases', async () => {
    const store = makeStore()
    const { source, requests } = sourceFor((request) => appliedResult(request, 0))

    await store.setter(runPhysicalSortAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'a physical ACK getter that changes authority still settles and blocks a same-tick replacement',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    let capturedRequest: SortRangeRequest | undefined
    let replacement: Promise<void> | undefined
    const replacementRequests: SortRangeRequest[] = []
    const replacementSource: PhysicalSortControllerPort = {
      async sortRange(request) {
        replacementRequests.push(request)
        return appliedResult(request, 0)
      },
    }
    const acknowledgement = new Proxy(Object.create(null) as SortRangeResult, {
      get(_target, property) {
        switch (property) {
          case 'sheetId':
            store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'B' })
            replacement = store.setter(runPhysicalSortAtom, runInput(replacementSource))
            return capturedRequest?.sheetId
          case 'requestId':
            return capturedRequest?.requestId
          case 'applied':
            return true
          case 'kind':
            return 'sort-range'
          case 'movedRows':
          case 'movedCells':
            return 0
          case 'affectedRange':
            return capturedRequest?.range
          case 'revision':
            return 4
          default:
            return undefined
        }
      },
    })
    let refreshCalls = 0
    const source: PhysicalSortControllerPort = {
      async sortRange(request) {
        capturedRequest = request
        return acknowledgement
      },
    }

    await store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        refreshCalls += 1
      },
    })
    await replacement

    // The same-tick replacement is still blocked by the single-lane guard
    // (the original ticket is still active when it is dispatched) — but the
    // original ticket's own authority drift no longer blocks it from
    // settling: it is a strict no-op (movedRows 0) so no history is pushed,
    // yet the refresh still runs and the lane still releases to idle.
    expect(refreshCalls).toBe(1)
    expect(replacementRequests).toHaveLength(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'a correlated structured rejection proves no mutation and releases without history',
    async () => {
    const store = makeStore()
    const { source, requests } = sourceFor((request) => ({
      kind: 'sort-range-not-applied',
      sheetId: request.sheetId,
      applied: false,
      code: 'merge-in-range',
      requestId: request.requestId,
      revision: 10,
    }))

    await store.setter(runPhysicalSortAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('error')
    expectHistoryProducerLaneAvailable(store)
  })

  test.each([
    [
      'identity mismatch',
      (request: SortRangeRequest) => ({
        ...appliedResult(request, 2),
        requestId: request.requestId! + 1,
      }),
    ],
    [
      'malformed getter',
      (_request: SortRangeRequest) =>
        new Proxy(Object.create(null) as SortRangeResult, {
          get() {
            throw new Error('malformed acknowledgement')
          },
        }),
    ],
  ])('%s retains the physical ticket and cannot resend', async (_label, resultFor) => {
    const store = makeStore()
    const { source, requests } = sourceFor(resultFor)

    await store.setter(runPhysicalSortAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(runPhysicalSortAtom, runInput(source))
    expect(requests).toHaveLength(1)
  })

  test.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['empty-string', ''],
    ['malformed-object', { malformed: true }],
  ])(
    'an applied ACK with a %s revision retains the physical ticket and reservation',
    async (_label, revision) => {
      const store = makeStore()
      const { source, requests } = sourceFor(
        (request) =>
          ({
            ...appliedResult(request, 2),
            revision,
          }) as SortRangeResult,
      )

      await store.setter(runPhysicalSortAtom, runInput(source))

      expect(requests).toHaveLength(1)
      expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    },
  )

  test(
    'refresh failure retains one mutation/history pair; retry releases without resend',
    async () => {
    const store = makeStore()
    const { source, requests } = sourceFor((request) => appliedResult(request, 2))
    let refreshCalls = 0

    await store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        refreshCalls += 1
        throw new Error('projection failed')
      },
    })

    expect(requests).toHaveLength(1)
    expect(refreshCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: async (sheetId) => {
        refreshCalls += 1
        expect(sheetId).toBe('A')
      },
    })

    expect(requests).toHaveLength(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'authority drift during refresh still completes the acknowledged ticket to idle',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const { source, requests } = sourceFor((request) => appliedResult(request, 2))
    const refreshStarted = deferred<void>()
    const refresh = deferred<void>()

    const pending = store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        refreshStarted.resolve(undefined)
        await refresh.promise
      },
    })
    await refreshStarted.promise
    const activeIdentity = store.getter(filterSortEntrypointStateAtom)
    expect(requests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)

    setPhysicalAuthority(store, 'B', 1)
    refresh.resolve(undefined)
    await pending

    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'idle',
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expectHistoryProducerLaneAvailable(store)
  })

  test('transport failure retains the physical ticket and reservation', async () => {
    const store = makeStore()
    const { source, requests } = sourceFor(async () => {
      throw new Error('transport failed')
    })

    await store.setter(runPhysicalSortAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('transport uses the 15s default deadline and late rejection is inert', async () => {
    jest.useFakeTimers()
    try {
      const store = makeStore()
      setPhysicalAuthority(store, 'A', 1)
      const transport = deferred<SortRangeResult>()
      const { source, requests } = sourceFor(() => transport.promise)

      const pending = store.setter(runPhysicalSortAtom, runInput(source))
      await Promise.resolve()
      expect(requests).toHaveLength(1)

      await jest.advanceTimersByTimeAsync(14_999)
      expect(store.getter(filterSortEntrypointStateAtom).status).toBe('pending')
      await jest.advanceTimersByTimeAsync(1)
      await pending

      const timedOut = store.getter(filterSortEntrypointStateAtom)
      expect(timedOut.status).toBe('outcome-unknown')
      expect(timedOut.error).toContain(FILTER_SORT_TRANSPORT_TIMEOUT_ERROR)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      transport.reject(new Error('late transport rejection'))
      await Promise.resolve()
      await Promise.resolve()
      expect(store.getter(filterSortEntrypointStateAtom)).toEqual(timedOut)

      await store.setter(runPhysicalSortAtom, runInput(source))
      expect(requests).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test(
    'refresh timeout is refresh-failed, retains the token, and ignores late settlement',
    async () => {
    jest.useFakeTimers()
    try {
      const store = makeStore()
      setPhysicalAuthority(store, 'A', 1)
      const { source, requests } = sourceFor((request) => appliedResult(request, 0))
      const refreshStarted = deferred<void>()
      const refresh = deferred<void>()

      const pending = store.setter(runPhysicalSortAtom, {
        ...runInput(source),
        timeoutMs: 25,
        refreshProjection: async () => {
          refreshStarted.resolve(undefined)
          await refresh.promise
        },
      })
      await refreshStarted.promise
      await jest.advanceTimersByTimeAsync(25)
      await pending

      const timedOut = store.getter(filterSortEntrypointStateAtom)
      expect(requests).toHaveLength(1)
      expect(timedOut.status).toBe('refresh-failed')
      expect(timedOut.error).toContain(FILTER_SORT_REFRESH_TIMEOUT_ERROR)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      refresh.resolve(undefined)
      await Promise.resolve()
      await Promise.resolve()
      expect(store.getter(filterSortEntrypointStateAtom)).toEqual(timedOut)

      await store.setter(runPhysicalSortAtom, runInput(source))
      expect(requests).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('retry refresh has its own captured deadline and never resends transport', async () => {
    jest.useFakeTimers()
    try {
      const store = makeStore()
      setPhysicalAuthority(store, 'A', 1)
      const { source, requests } = sourceFor((request) => appliedResult(request, 0))
      await store.setter(runPhysicalSortAtom, {
        ...runInput(source),
        refreshProjection: async () => {
          throw new Error('initial refresh failed')
        },
      })
      expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')

      const retryStarted = deferred<void>()
      const retryRefresh = deferred<void>()
      const retry = store.setter(retryFilterSortRefreshAtom, {
        timeoutMs: 30,
        refreshProjection: async () => {
          retryStarted.resolve(undefined)
          await retryRefresh.promise
        },
      })
      await retryStarted.promise
      await jest.advanceTimersByTimeAsync(30)
      await retry

      const timedOut = store.getter(filterSortEntrypointStateAtom)
      expect(requests).toHaveLength(1)
      expect(timedOut.status).toBe('refresh-failed')
      expect(timedOut.error).toContain(FILTER_SORT_REFRESH_TIMEOUT_ERROR)
      expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

      retryRefresh.resolve(undefined)
      await Promise.resolve()
      await Promise.resolve()
      expect(store.getter(filterSortEntrypointStateAtom)).toEqual(timedOut)
      expect(requests).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test(
    'an entrypoint retry getter cannot bind its stale ' +
      'callback after a nested retry advances the ticket',
    async () => {
    const store = makeStore()
    setPhysicalAuthority(store, 'A', 1)
    const { source, requests } = sourceFor((request) => appliedResult(request, 0))
    await store.setter(runPhysicalSortAtom, {
      ...runInput(source),
      refreshProjection: async () => {
        throw new Error('initial refresh failed')
      },
    })
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')

    let replacementCalls = 0
    let staleCalls = 0
    let replacement: Promise<void> | undefined
    const hostileInput = Object.create(null) as RetryFilterSortRefreshInput
    Object.defineProperty(hostileInput, 'refreshProjection', {
      get() {
        replacement = store.setter(retryFilterSortRefreshAtom, {
          refreshProjection: async () => {
            replacementCalls += 1
          },
        })
        return async () => {
          staleCalls += 1
        }
      },
    })

    await store.setter(retryFilterSortRefreshAtom, hostileInput)
    await replacement

    expect(requests).toHaveLength(1)
    expect(replacementCalls).toBe(1)
    expect(staleCalls).toBe(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })
})

describe('shared history producer lane — Reapply', () => {
  function prepareReapply(store: ReturnType<typeof makeStore>): void {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'A' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'A',
      anchor: { row: 0, col: 1 },
      focus: { row: 0, col: 1 },
    })
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: { rules: [{ kind: 'equals', colIndex: 1, value: 'x' }] },
    })
  }

  function sourceFor(execute: (request: SetFilterSortRequest) => unknown | Promise<unknown>): {
    source: FilterSortControllerPort
    requests: SetFilterSortRequest[]
  } {
    const requests: SetFilterSortRequest[] = []
    return {
      source: {
        async setFilterSort(request) {
          requests.push(request)
          return (await execute(request)) as FilterSortMutationResult
        },
      },
      requests,
    }
  }

  function matchedResult(
    request: SetFilterSortRequest,
    overrides: Partial<FilterSortMutationResult> = {},
  ): FilterSortMutationResult {
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      historyRecorded: false,
      revision: 3,
      hiddenRowIndices: [2],
      ...overrides,
    }
  }

  const runInput = (
    source: FilterSortControllerPort,
    refreshProjection: (sheetId: string) => Promise<void> = async () => undefined,
  ) => ({
    source,
    entrypoint: 'menu-bar' as const,
    refreshProjection,
  })

  test(
    'a source getter that re-enters then throws cannot overwrite the replacement Reapply',
    async () => {
    const store = makeStore()
    prepareReapply(store)
    const { source, requests } = sourceFor((request) => matchedResult(request))
    const stableInput = runInput(source)
    let replacement: Promise<void> | undefined
    const hostileInput = Object.create(null) as ReapplyFilterInput
    Object.defineProperty(hostileInput, 'source', {
      get() {
        replacement = store.setter(reapplyFilterAtom, stableInput)
        throw new Error('outer source getter failed after re-entry')
      },
    })

    await store.setter(reapplyFilterAtom, hostileInput)
    await replacement

    expect(requests).toHaveLength(1)
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'A')).toEqual([2])
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test('a foreign reservation blocks transport and is never over-released', async () => {
    const store = makeStore()
    prepareReapply(store)
    const { source, requests } = sourceFor((request) => matchedResult(request))
    const externalReservation = store.setter(acquireHistoryProducerReservationAtom)
    expect(externalReservation).not.toBeNull()

    await store.setter(reapplyFilterAtom, runInput(source))

    expect(requests).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'blocked',
      error: FILTER_SORT_PENDING_ERROR,
    })
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
    if (externalReservation !== null) {
      expect(store.setter(releaseHistoryProducerReservationAtom, externalReservation)).toBe(true)
    }
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'pending owns the lane, blocks another producer, then releases with zero history',
    async () => {
    const store = makeStore()
    prepareReapply(store)
    const acknowledgement = deferred<FilterSortMutationResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)
    const physicalRequests: SortRangeRequest[] = []

    const pending = store.setter(reapplyFilterAtom, runInput(source))
    await Promise.resolve()
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      kind: 'set-filter-sort',
      sheetId: 'A',
      recordHistory: false,
    })
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('pending')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(runPhysicalSortAtom, {
      source: {
        async sortRange(request) {
          physicalRequests.push(request)
          return {
            kind: 'sort-range',
            sheetId: request.sheetId,
            requestId: request.requestId,
            applied: true,
            movedRows: 1,
            movedCells: 1,
            affectedRange: request.range,
            revision: 4,
          }
        },
      },
      entrypoint: 'toolbar',
      direction: 'asc',
      target: { sheetId: 'A', colIndex: 1 },
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      refreshProjection: async () => undefined,
    })
    expect(physicalRequests).toHaveLength(0)

    acknowledgement.resolve(matchedResult(requests[0]!))
    await pending

    expect(requests).toHaveLength(1)
    expect(requests[0]!.recordHistory).toBe(false)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test('reset and close attempts cannot release an unsettled transport reservation', async () => {
    const store = makeStore()
    prepareReapply(store)
    const acknowledgement = deferred<FilterSortMutationResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)

    const pending = store.setter(reapplyFilterAtom, runInput(source))
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    const activeIdentity = store.getter(filterSortEntrypointStateAtom)

    expect(store.setter(clearHistoryAtom)).toBe(false)
    store.setter(clearFilterSortAtom, 'A')
    store.setter(closeFilterDropdownAtom)
    await store.setter(reapplyFilterAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortStateAtom)['A']).toBeDefined()
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'pending',
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    acknowledgement.resolve(matchedResult(requests[0]!))
    await pending

    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })

  test(
    'authority witness drift makes a correlated stale completion retain its ticket and token',
    async () => {
    const store = makeStore()
    prepareReapply(store)
    const acknowledgement = deferred<FilterSortMutationResult>()
    const { source, requests } = sourceFor(() => acknowledgement.promise)
    let refreshCalls = 0

    const pending = store.setter(
      reapplyFilterAtom,
      runInput(source, async () => {
        refreshCalls += 1
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    const activeIdentity = store.getter(filterSortEntrypointStateAtom)

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'B' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'B',
      anchor: { row: 0, col: 1 },
      focus: { row: 0, col: 1 },
    })
    expect(store.getter(filterSortEntrypointProjectionAtom).status).toBe('stale')

    acknowledgement.resolve(matchedResult(requests[0]!))
    await pending

    expect(refreshCalls).toBe(0)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      status: 'stale',
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    // Public commands cannot replace an active ticket. A second dispatch is
    // therefore the constructible stale-completion race: it stays transport-0
    // and leaves the exact observable ticket identity untouched.
    await store.setter(reapplyFilterAtom, runInput(source))
    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom)).toMatchObject({
      operationId: activeIdentity.operationId,
      requestId: activeIdentity.requestId,
    })
    expect(store.setter(clearHistoryAtom)).toBe(false)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test(
    'a Reapply ACK getter that changes authority cannot commit or admit a replacement',
    async () => {
    const store = makeStore()
    prepareReapply(store)
    let capturedRequest: SetFilterSortRequest | undefined
    let replacement: Promise<void> | undefined
    const acknowledgement = new Proxy(Object.create(null) as FilterSortMutationResult, {
      get(_target, property) {
        switch (property) {
          case 'sheetId':
            store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'B' })
            replacement = store.setter(reapplyFilterAtom, runInput(source))
            return capturedRequest?.sheetId
          case 'requestId':
            return capturedRequest?.requestId
          case 'historyRecorded':
            return false
          case 'revision':
            return 5
          case 'hiddenRowIndices':
            return [2]
          default:
            return undefined
        }
      },
    })
    const requests: SetFilterSortRequest[] = []
    const source: FilterSortControllerPort = {
      async setFilterSort(request) {
        requests.push(request)
        capturedRequest = request
        return acknowledgement
      },
    }
    let refreshCalls = 0

    await store.setter(
      reapplyFilterAtom,
      runInput(source, async () => {
        refreshCalls += 1
      }),
    )
    await replacement

    expect(requests).toHaveLength(1)
    expect(refreshCalls).toBe(0)
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'A')).toEqual([])
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('stale')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()
  })

  test('transport failure retains the ticket and reservation without resend', async () => {
    const store = makeStore()
    prepareReapply(store)
    const { source, requests } = sourceFor(async () => {
      throw new Error('transport failed')
    })

    await store.setter(reapplyFilterAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(reapplyFilterAtom, runInput(source))
    expect(requests).toHaveLength(1)
  })

  test.each([
    [
      'identity mismatch',
      (request: SetFilterSortRequest) =>
        matchedResult(request, { requestId: request.requestId! + 1 }),
    ],
    [
      'history contract violation',
      (request: SetFilterSortRequest) => matchedResult(request, { historyRecorded: true }),
    ],
    [
      'missing history verdict',
      (request: SetFilterSortRequest) => {
        const { historyRecorded: _historyRecorded, ...result } = matchedResult(request)
        return result as FilterSortMutationResult
      },
    ],
    [
      'missing revision',
      (request: SetFilterSortRequest) => {
        const { revision: _revision, ...result } = matchedResult(request)
        return result as FilterSortMutationResult
      },
    ],
    [
      'NaN revision',
      (request: SetFilterSortRequest) => matchedResult(request, { revision: Number.NaN }),
    ],
    [
      'empty-string revision',
      (request: SetFilterSortRequest) => matchedResult(request, { revision: '' }),
    ],
    [
      'malformed getter',
      (_request: SetFilterSortRequest) =>
        new Proxy(Object.create(null) as FilterSortMutationResult, {
          get() {
            throw new Error('malformed acknowledgement')
          },
        }),
    ],
  ])('%s retains the ticket and reservation without resend', async (_label, resultFor) => {
    const store = makeStore()
    prepareReapply(store)
    const { source, requests } = sourceFor(resultFor)

    await store.setter(reapplyFilterAtom, runInput(source))

    expect(requests).toHaveLength(1)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(reapplyFilterAtom, runInput(source))
    expect(requests).toHaveLength(1)
  })

  test('refresh failure retains zero history; retry releases without resend', async () => {
    const store = makeStore()
    prepareReapply(store)
    const { source, requests } = sourceFor((request) => matchedResult(request))
    let refreshCalls = 0

    await store.setter(
      reapplyFilterAtom,
      runInput(source, async () => {
        refreshCalls += 1
        throw new Error('projection failed')
      }),
    )

    expect(requests).toHaveLength(1)
    expect(refreshCalls).toBe(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('refresh-failed')
    expect(store.setter(acquireHistoryProducerReservationAtom)).toBeNull()

    await store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: async (sheetId) => {
        refreshCalls += 1
        expect(sheetId).toBe('A')
      },
    })

    expect(requests).toHaveLength(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(store.getter(filterSortEntrypointStateAtom).status).toBe('idle')
    expectHistoryProducerLaneAvailable(store)
  })
})
