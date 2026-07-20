import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src'
import {
  FILTER_SORT_ACKNOWLEDGEMENT_ERROR,
  FILTER_SORT_CAPABILITY_ERROR,
  FILTER_SORT_INVALID_INPUT_ERROR,
  FILTER_SORT_OUTCOME_UNKNOWN_ERROR,
  MAX_FILTER_LIST_VALUES,
  MAX_FILTER_SORT_SHEETS,
  captureFilterSortCapabilityAtom,
  clearColumnFilterSortAtom,
  clearColumnFilterRulesAtom,
  clearFilterSortAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortDraftAtom,
  filterSortCapabilityAtom,
  filterSortCanCloseAtom,
  filterSortEntrypointOperationIdAtom,
  filterSortEntrypointStateAtom,
  filterSortErrorAtom,
  filterSortLifecycleAtom,
  filterSortSessionIdAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  issueFilterSortSyncTicketAtom,
  notifyActiveSheetChangedAtom,
  openFilterDropdownAtom,
  openFilterDropdownFromEntrypointAtom,
  retryFilterSortRefreshAtom,
  runFilterSortMutationAtom,
  setFilterSortAtom,
  setFilterSortErrorAtom,
  updateFilterSortAvailableValuesAtom,
  updateFilterSortDraftAtom,
} from '../src'
import type {
  FilterSortControllerPort,
  FilterSortMutationResult,
  FilterSortState,
  SetFilterSortRequest,
} from '../src'

function makeStore() {
  return createStore()
}

const emptyState: FilterSortState = { rules: [] }

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const FILTER_SORT_STATE_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortStateAtom> = false
const FILTER_DROPDOWN_IS_READ_ONLY: AtomHasPublicWrite<typeof filterDropdownAtom> = false
const FILTER_SORT_ERROR_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortErrorAtom> = false
const FILTER_SORT_SYNC_TICKET_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortSyncTicketAtom> =
  false
const FILTER_SORT_SESSION_ID_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortSessionIdAtom> =
  false
const FILTER_SORT_CAPABILITY_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortCapabilityAtom> =
  false
const FILTER_SORT_DRAFT_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortDraftAtom> = false
const FILTER_SORT_LIFECYCLE_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortLifecycleAtom> = false
const ENTRYPOINT_STATE_IS_READ_ONLY: AtomHasPublicWrite<typeof filterSortEntrypointStateAtom> =
  false
const ENTRYPOINT_OPERATION_ID_IS_READ_ONLY: AtomHasPublicWrite<
  typeof filterSortEntrypointOperationIdAtom
> = false

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
      directives: [],
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

  const equalsRule = (colIndex: number, value: string) => ({
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

    acknowledgement.resolve({
      sheetId: 'A',
      requestId: calls[0]!.requestId,
      revision: 2,
    })
    await Promise.all([first, second])

    expect(store.getter(filterSortStateAtom)['A']?.rules).toEqual([equalsRule(1, 'x')])
    expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
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
      revision: 2,
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
        return { sheetId: request.sheetId, requestId: request.requestId, revision: 3 }
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
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }
    const sourceB: FilterSortControllerPort = {
      async setFilterSort(request) {
        requestsB.push(request)
        return { sheetId: request.sheetId, requestId: request.requestId }
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

describe('DisplayCell.originalRow', () => {
  test('accepts originalRow alongside row (type-check)', () => {
    const cell: DisplayCell = {
      row: 5,
      col: 2,
      displayValue: 'hello',
      originalRow: 42,
    }
    expect(cell.originalRow).toBe(42)
    expect(cell.row).toBe(5)
  })

  test('originalRow is optional', () => {
    const cell: DisplayCell = { row: 0, col: 0, displayValue: '' }
    expect(cell.originalRow).toBeUndefined()
  })
})
