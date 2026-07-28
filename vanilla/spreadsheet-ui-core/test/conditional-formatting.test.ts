import { describe, expect, jest, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import {
  CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX,
  CONDITIONAL_FORMAT_RULES_MAX,
  closeConditionalFormatEditorAtom,
  conditionalFormatEditorAtom,
  conditionalFormatMutationBlockedAtom,
  conditionalFormatOperationAttemptLedgerAtom,
  conditionalFormatRulesCacheAtom,
  nextConditionalFormatRequestId,
  nextConditionalFormatSessionId,
  openConditionalFormatEditorAtom,
  runConditionalFormatMutationAtom,
  setSelectionAtom,
  setConditionalFormatRulesAtom,
  setWorkspaceActiveSheetAtom,
  type CellValueRule,
  type ConditionalFormatMutationAcknowledgement,
  type ConditionalFormatOperationAttempt,
  type ConditionalFormatRuleEntry,
  type ConditionalFormatScope,
  type DisplayCell,
  type ListConditionalFormatRulesRequest,
  type RemoveConditionalFormatRuleRequest,
  type RunConditionalFormatMutationInput,
  type SetConditionalFormatRuleRequest,
  type SpreadsheetCellFormat,
} from '../src'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const TARGET_SCOPE: ConditionalFormatScope = {
  range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
}

function copyScope(scope: ConditionalFormatScope): ConditionalFormatScope {
  return { range: { ...scope.range } }
}

function makeEntry(
  id: string,
  priority = 0,
  format: SpreadsheetCellFormat = { bold: true },
): ConditionalFormatRuleEntry {
  const rule: CellValueRule = {
    kind: 'cell-value',
    operator: 'eq',
    value: '1',
    format,
  }
  return {
    id,
    scope: copyScope(TARGET_SCOPE),
    priority,
    rule,
  }
}

function prepareOpenStore(store: Store, entry: ConditionalFormatRuleEntry | null = null): void {
  store.setter(setConditionalFormatRulesAtom, {
    sheetId: 'sheet-1',
    rules: [],
    revision: 7,
  })
  store.setter(openConditionalFormatEditorAtom, entry)
}

function acknowledged(
  request: { readonly sheetId: string; readonly requestId?: number },
  revision?: string | number,
): ConditionalFormatMutationAcknowledgement {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    ...(revision === undefined ? {} : { revision }),
  }
}

function saveInput(
  setRule: RunConditionalFormatMutationInput['setRule'],
  extra: Partial<RunConditionalFormatMutationInput> = {},
): RunConditionalFormatMutationInput {
  return {
    action: 'save',
    sheetId: 'sheet-1',
    scope: copyScope(TARGET_SCOPE),
    setRule,
    ...extra,
  }
}

describe('conditional-formatting core state machine', () => {
  test('starts with private per-store sources and readonly empty projections', () => {
    const first = createStore()
    const second = createStore()

    first.setter(setConditionalFormatRulesAtom, {
      sheetId: 'sheet-1',
      rules: [makeEntry('first')],
    })
    first.setter(openConditionalFormatEditorAtom, makeEntry('draft'))

    expect(first.getter(conditionalFormatRulesCacheAtom).sheetId).toBe('sheet-1')
    expect(first.getter(conditionalFormatEditorAtom)).toMatchObject({ open: true, sessionId: 1 })
    expect(second.getter(conditionalFormatRulesCacheAtom)).toEqual({ sheetId: null, rules: [] })
    expect(second.getter(conditionalFormatEditorAtom)).toEqual({
      open: false,
      sessionId: 0,
      requestId: null,
      ruleId: null,
      draft: null,
      selectedKind: 'cell-value',
      pending: false,
      error: null,
    })
    expect(second.getter(conditionalFormatOperationAttemptLedgerAtom)).toEqual([])
  })

  test('snapshots, caps, and recursively freezes rules supplied by callers', () => {
    const store = createStore()
    const deepFormat: SpreadsheetCellFormat = {
      bold: true,
      numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
      borders: { top: { style: 'thin', color: '#111111' } },
    }
    const entries = Array.from({ length: 201 }, (_, index) =>
      makeEntry(`r${index}`, index, deepFormat),
    )

    store.setter(setConditionalFormatRulesAtom, {
      sheetId: 'sheet-1',
      rules: entries,
      revision: 8,
    })
    entries[200].id = 'caller-mutated'
    entries[200].scope.range.rowStart = 99
    ;(entries[200].rule as CellValueRule).format.bold = false

    const cache = store.getter(conditionalFormatRulesCacheAtom)
    const last = cache.rules.at(-1)!
    expect(cache).toMatchObject({ sheetId: 'sheet-1', revision: 8 })
    expect(cache.rules).toHaveLength(CONDITIONAL_FORMAT_RULES_MAX)
    expect(cache.rules[0].id).toBe('r1')
    expect(last).toMatchObject({ id: 'r200', scope: { range: { rowStart: 1 } } })
    expect((last.rule as CellValueRule).format.bold).toBe(true)
    expect(Object.isFrozen(cache)).toBe(true)
    expect(Object.isFrozen(cache.rules)).toBe(true)
    expect(Object.isFrozen(last)).toBe(true)
    expect(Object.isFrozen(last.scope)).toBe(true)
    expect(Object.isFrozen(last.scope.range)).toBe(true)
    expect(Object.isFrozen(last.rule)).toBe(true)
    expect(Object.isFrozen((last.rule as CellValueRule).format)).toBe(true)
    expect(Object.isFrozen((last.rule as CellValueRule).format.numberFormat!)).toBe(true)
    expect(Object.isFrozen((last.rule as CellValueRule).format.borders!)).toBe(true)
    expect(Object.isFrozen((last.rule as CellValueRule).format.borders!.top!)).toBe(true)
    expect(Reflect.set(cache, 'sheetId', 'other-sheet')).toBe(false)
  })

  test('public cache, editor, and ledger projections reject direct writes', async () => {
    const store = createStore()
    prepareOpenStore(store, makeEntry('draft'))
    const beforeCache = store.getter(conditionalFormatRulesCacheAtom)
    const beforeEditor = store.getter(conditionalFormatEditorAtom)
    const unsafeSet = store.setter as unknown as (target: unknown, value: unknown) => unknown

    expect(() =>
      unsafeSet(conditionalFormatRulesCacheAtom, { sheetId: 'evil', rules: [] }),
    ).toThrow()
    expect(() => unsafeSet(conditionalFormatEditorAtom, { ...beforeEditor, open: false })).toThrow()
    expect(() => unsafeSet(conditionalFormatOperationAttemptLedgerAtom, [])).toThrow()
    expect(store.getter(conditionalFormatRulesCacheAtom)).toEqual(beforeCache)
    expect(store.getter(conditionalFormatEditorAtom)).toEqual(beforeEditor)

    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<SetConditionalFormatRuleRequest>()
    const pending = store.setter(
      runConditionalFormatMutationAtom,
      saveInput((request) => {
        started.resolve(request)
        return gate.promise
      }),
    )
    const request = await started.promise
    const attempt = store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]
    expect(Object.isFrozen(store.getter(conditionalFormatOperationAttemptLedgerAtom))).toBe(true)
    expect(Object.isFrozen(attempt)).toBe(true)
    expect(Object.isFrozen(attempt.scope!)).toBe(true)
    expect(Object.isFrozen(attempt.scope!.range)).toBe(true)
    gate.resolve(acknowledged(request))
    await pending
  })

  test('open and close create safe distinct sessions, while identity helpers never reuse', () => {
    const store = createStore()
    store.setter(openConditionalFormatEditorAtom, makeEntry('r1'))
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      sessionId: 1,
      ruleId: 'r1',
    })
    store.setter(closeConditionalFormatEditorAtom)
    store.setter(openConditionalFormatEditorAtom, null)
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      sessionId: 3,
      ruleId: null,
    })

    for (const nextIdentity of [nextConditionalFormatRequestId, nextConditionalFormatSessionId]) {
      expect(nextIdentity(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
      expect(nextIdentity(Number.MAX_SAFE_INTEGER)).toBe(-1)
      expect(nextIdentity(-1)).toBe(-2)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER + 1)).toBe(Number.MIN_SAFE_INTEGER)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER)).toBeNull()
      expect(nextIdentity(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
      expect(nextIdentity(Number.NaN)).toBeNull()
    }
  })

  test('fallback workspace witness rejects A-B-A authority before transport dispatch', async () => {
    const store = createStore()
    const setRule = jest.fn(async (request: SetConditionalFormatRuleRequest) =>
      acknowledged(request),
    )
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-a', rules: [] })
    store.setter(openConditionalFormatEditorAtom, null)

    const pending = store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      scope: copyScope(TARGET_SCOPE),
      setRule,
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-b' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      pending: false,
      error: null,
    })
  })

  test('fallback selection witness rejects A-B-A authority before transport dispatch', async () => {
    const store = createStore()
    const setRule = jest.fn(async (request: SetConditionalFormatRuleRequest) =>
      acknowledged(request),
    )
    const selectionA = {
      kind: 'cell' as const,
      sheetId: 'sheet-a',
      anchor: { row: 1, col: 3 },
      focus: { row: 2, col: 4 },
    }
    const selectionB = {
      kind: 'cell' as const,
      sheetId: 'sheet-a',
      anchor: { row: 7, col: 8 },
      focus: { row: 9, col: 10 },
    }
    store.setter(setSelectionAtom, selectionA)
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-a', rules: [] })
    store.setter(openConditionalFormatEditorAtom, null)

    const pending = store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      sheetId: 'sheet-a',
      setRule,
    })
    store.setter(setSelectionAtom, selectionB)
    store.setter(setSelectionAtom, selectionA)
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      pending: false,
      error: null,
    })
  })

  test('publishes a coherent pending editor and journal before transport invocation', async () => {
    const store = createStore()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<SetConditionalFormatRuleRequest>()
    const snapshots: Array<{
      source: 'editor' | 'ledger'
      pending: boolean
      requestId: number | null
      attemptStatus: ConditionalFormatOperationAttempt['status'] | undefined
    }> = []
    prepareOpenStore(store)
    const capture = (source: 'editor' | 'ledger') => {
      const editor = store.getter(conditionalFormatEditorAtom)
      snapshots.push({
        source,
        pending: editor.pending,
        requestId: editor.requestId,
        attemptStatus: store.getter(conditionalFormatOperationAttemptLedgerAtom).at(-1)?.status,
      })
    }
    const unsubscribeEditor = store.sub(conditionalFormatEditorAtom, () => capture('editor'))
    const unsubscribeLedger = store.sub(conditionalFormatOperationAttemptLedgerAtom, () =>
      capture('ledger'),
    )

    const pending = store.setter(
      runConditionalFormatMutationAtom,
      saveInput((request) => {
        expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
          pending: true,
          requestId: request.requestId,
        })
        expect(store.getter(conditionalFormatOperationAttemptLedgerAtom).at(-1)).toMatchObject({
          status: 'pending',
          requestId: request.requestId,
        })
        started.resolve(request)
        return gate.promise
      }),
    )
    expect(snapshots).toEqual([])
    const request = await started.promise

    expect(snapshots.map(({ source }) => source).sort()).toEqual(['editor', 'ledger'])
    expect(snapshots).toEqual(
      snapshots.map((snapshot) => ({
        ...snapshot,
        pending: true,
        requestId: 1,
        attemptStatus: 'pending',
      })),
    )
    gate.resolve(acknowledged(request, 8))
    await pending
    unsubscribeEditor()
    unsubscribeLedger()
  })

  test('same-tick close/reopen cancels a reservation before journal or transport launch', async () => {
    const store = createStore()
    const setRule = jest.fn(async (request: SetConditionalFormatRuleRequest) =>
      acknowledged(request),
    )
    prepareOpenStore(store)

    const pending = store.setter(runConditionalFormatMutationAtom, saveInput(setRule))
    store.setter(closeConditionalFormatEditorAtom)
    store.setter(openConditionalFormatEditorAtom, makeEntry('new-session'))
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      sessionId: 3,
      ruleId: 'new-session',
      pending: false,
      error: null,
    })
  })

  test.each([
    {
      name: 'synchronous throw',
      run: (
        _request: SetConditionalFormatRuleRequest,
      ): Promise<ConditionalFormatMutationAcknowledgement> => {
        throw new Error('synchronous transport failure')
      },
      finalStatus: 'outcome-unknown' as const,
    },
    {
      name: 'immediate fulfilment',
      run: (request: SetConditionalFormatRuleRequest) => Promise.resolve(acknowledged(request)),
      finalStatus: 'acknowledged' as const,
    },
  ])('pending publication precedes $name settlement', async ({ run, finalStatus }) => {
    const store = createStore()
    const snapshots: Array<{
      pending: boolean
      status: ConditionalFormatOperationAttempt['status'] | undefined
    }> = []
    prepareOpenStore(store)
    const capture = () => {
      snapshots.push({
        pending: store.getter(conditionalFormatEditorAtom).pending,
        status: store.getter(conditionalFormatOperationAttemptLedgerAtom).at(-1)?.status,
      })
    }
    const unsubscribeEditor = store.sub(conditionalFormatEditorAtom, capture)
    const unsubscribeLedger = store.sub(conditionalFormatOperationAttemptLedgerAtom, capture)

    await store.setter(runConditionalFormatMutationAtom, saveInput(run))

    const pendingIndex = snapshots.findIndex(
      ({ pending, status }) => pending && status === 'pending',
    )
    const settledIndex = snapshots.findIndex(({ status }) => status === finalStatus)
    expect(pendingIndex).toBeGreaterThanOrEqual(0)
    expect(settledIndex).toBeGreaterThan(pendingIndex)
    unsubscribeEditor()
    unsubscribeLedger()
  })

  test.each([
    {
      name: 'missing request id',
      result: (request: SetConditionalFormatRuleRequest) => ({ sheetId: request.sheetId }),
    },
    {
      name: 'wrong request id',
      result: (request: SetConditionalFormatRuleRequest) => ({
        sheetId: request.sheetId,
        requestId: (request.requestId ?? 0) + 1,
      }),
    },
    {
      name: 'unsafe request id',
      result: (request: SetConditionalFormatRuleRequest) => ({
        sheetId: request.sheetId,
        requestId: Number.MAX_SAFE_INTEGER + 1,
      }),
    },
    {
      name: 'wrong sheet',
      result: (request: SetConditionalFormatRuleRequest) => ({
        sheetId: `${request.sheetId}-other`,
        requestId: request.requestId,
      }),
    },
  ])('strict acknowledgement rejects $name', async ({ result }) => {
    const store = createStore()
    prepareOpenStore(store)

    await store.setter(
      runConditionalFormatMutationAtom,
      saveInput(async (request) => result(request)),
    )

    expect(store.getter(conditionalFormatMutationBlockedAtom)).toBe(true)
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
    })
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      pending: false,
    })
  })

  test('ledger settlement is subscriber-visible before editor settlement', async () => {
    const store = createStore()
    const observed: Array<{
      status: ConditionalFormatOperationAttempt['status']
      pending: boolean
    }> = []
    prepareOpenStore(store)
    const unsubscribe = store.sub(conditionalFormatOperationAttemptLedgerAtom, () => {
      const status = store.getter(conditionalFormatOperationAttemptLedgerAtom).at(-1)?.status
      if (status !== undefined && status !== 'pending') {
        observed.push({ status, pending: store.getter(conditionalFormatEditorAtom).pending })
      }
    })

    await store.setter(
      runConditionalFormatMutationAtom,
      saveInput(async (request) => acknowledged(request, 9)),
    )
    unsubscribe()

    expect(observed).toEqual([{ status: 'acknowledged', pending: true }])
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({ open: false, pending: false })
  })

  test('post-transport workspace A-B-A loss keeps rejection as ledger evidence only', async () => {
    const store = createStore()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<SetConditionalFormatRuleRequest>()
    const setRule = jest.fn((request: SetConditionalFormatRuleRequest) => {
      started.resolve(request)
      return gate.promise
    })
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const listRules = jest.fn(async () => ({
      sheetId: 'sheet-fallback',
      requestId: 1,
      rules: [],
    }))
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-fallback' })
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-fallback', rules: [] })
    store.setter(openConditionalFormatEditorAtom, null)

    const pending = store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      scope: copyScope(TARGET_SCOPE),
      setRule,
      acceptAcknowledgedResult,
      listRules,
    })
    await started.promise
    const pendingEditor = store.getter(conditionalFormatEditorAtom)
    const editorSideEffect = jest.fn()
    const unsubscribeEditor = store.sub(conditionalFormatEditorAtom, editorSideEffect)

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-other' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-fallback' })
    gate.reject(new Error('workspace outcome unknown'))
    await pending
    unsubscribeEditor()

    expect(setRule).toHaveBeenCalledTimes(1)
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error: 'workspace outcome unknown',
    })
    expect(store.getter(conditionalFormatEditorAtom)).toBe(pendingEditor)
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      pending: true,
      error: null,
      requestId: 1,
    })
    expect(editorSideEffect).not.toHaveBeenCalled()
    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(listRules).not.toHaveBeenCalled()
  })

  test('post-transport selection loss leaves invalid ack as ledger evidence', async () => {
    const store = createStore()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<SetConditionalFormatRuleRequest>()
    const selectionA = {
      kind: 'cell' as const,
      sheetId: 'sheet-a',
      anchor: { row: 1, col: 3 },
      focus: { row: 2, col: 4 },
    }
    const selectionB = {
      kind: 'cell' as const,
      sheetId: 'sheet-a',
      anchor: { row: 6, col: 7 },
      focus: { row: 8, col: 9 },
    }
    const setRule = jest.fn((request: SetConditionalFormatRuleRequest) => {
      started.resolve(request)
      return gate.promise
    })
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const listRules = jest.fn(async () => ({
      sheetId: 'sheet-a',
      requestId: 1,
      rules: [],
    }))
    store.setter(setSelectionAtom, selectionA)
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-a', rules: [] })
    store.setter(openConditionalFormatEditorAtom, null)

    const pending = store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      sheetId: 'sheet-a',
      setRule,
      acceptAcknowledgedResult,
      listRules,
    })
    const request = await started.promise
    const pendingEditor = store.getter(conditionalFormatEditorAtom)
    const editorSideEffect = jest.fn()
    const unsubscribeEditor = store.sub(conditionalFormatEditorAtom, editorSideEffect)

    store.setter(setSelectionAtom, selectionB)
    gate.resolve({
      sheetId: request.sheetId,
      requestId: (request.requestId ?? 0) + 1,
    })
    await pending
    unsubscribeEditor()

    expect(setRule).toHaveBeenCalledTimes(1)
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
    })
    expect(store.getter(conditionalFormatEditorAtom)).toBe(pendingEditor)
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      pending: true,
      error: null,
      requestId: 1,
    })
    expect(editorSideEffect).not.toHaveBeenCalled()
    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(listRules).not.toHaveBeenCalled()
  })

  test('late acknowledgement never emits, refreshes, closes, or overwrites a newer session', async () => {
    const store = createStore()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<SetConditionalFormatRuleRequest>()
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const listRules = jest.fn(async () => ({
      sheetId: 'sheet-a',
      requestId: 1,
      rules: [makeEntry('stale-list')],
    }))
    store.setter(setConditionalFormatRulesAtom, {
      sheetId: 'sheet-a',
      rules: [makeEntry('a-before')],
      revision: 1,
    })
    store.setter(openConditionalFormatEditorAtom, makeEntry('a-draft'))

    const pending = store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      sheetId: 'sheet-a',
      scope: copyScope(TARGET_SCOPE),
      setRule: (request: any) => {
        started.resolve(request)
        return gate.promise
      },
      acceptAcknowledgedResult,
      listRules,
    })
    const request = await started.promise
    store.setter(closeConditionalFormatEditorAtom)
    store.setter(setConditionalFormatRulesAtom, {
      sheetId: 'sheet-b',
      rules: [makeEntry('b-current')],
      revision: 8,
    })
    store.setter(openConditionalFormatEditorAtom, makeEntry('new-session'))
    const newSession = store.getter(conditionalFormatEditorAtom).sessionId
    gate.resolve(acknowledged(request, 9))
    await pending

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(listRules).not.toHaveBeenCalled()
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      resultRevision: 9,
    })
    expect(store.getter(conditionalFormatRulesCacheAtom)).toMatchObject({
      sheetId: 'sheet-b',
      revision: 8,
      rules: [{ id: 'b-current' }],
    })
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      sessionId: newSession,
      ruleId: 'new-session',
      pending: false,
      error: null,
    })
  })

  test('late rejection journals unknown outcome without polluting a reopened editor', async () => {
    const store = createStore()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    const started = deferred<void>()
    prepareOpenStore(store)
    const pending = store.setter(
      runConditionalFormatMutationAtom,
      saveInput(() => {
        started.resolve(undefined)
        return gate.promise
      }),
    )
    await started.promise
    store.setter(closeConditionalFormatEditorAtom)
    store.setter(openConditionalFormatEditorAtom, makeEntry('new-session'))
    gate.reject(new Error('late outcome unknown'))
    await pending

    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error: 'late outcome unknown',
    })
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      ruleId: 'new-session',
      pending: false,
      error: null,
    })
  })

  test('current acknowledged mutation accepts a strict listed snapshot and then closes', async () => {
    const store = createStore()
    const listedEntry = makeEntry('listed')
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const listRules = jest.fn(async (request: ListConditionalFormatRulesRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 9,
      rules: [listedEntry],
    }))
    prepareOpenStore(store)

    await store.setter(
      runConditionalFormatMutationAtom,
      saveInput(async (request) => acknowledged(request, 8), {
        acceptAcknowledgedResult,
        listRules,
      }),
    )
    listedEntry.id = 'caller-mutated'

    expect(acceptAcknowledgedResult).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 8,
    })
    expect(listRules).toHaveBeenCalledWith({
      kind: 'list-conditional-format-rules',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 8,
    })
    expect(store.getter(conditionalFormatRulesCacheAtom)).toMatchObject({
      sheetId: 'sheet-1',
      revision: 9,
      rules: [{ id: 'listed' }],
    })
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({ open: false, pending: false })
  })

  test('late listed rules cannot overwrite a newer cache or editor', async () => {
    const store = createStore()
    const listed = deferred<{
      sheetId: string
      requestId: number
      revision: number
      rules: readonly ConditionalFormatRuleEntry[]
    }>()
    const listStarted = deferred<void>()
    prepareOpenStore(store)
    const pending = store.setter(
      runConditionalFormatMutationAtom,
      saveInput(async (request) => acknowledged(request, 8), {
        listRules: (_request) => {
          listStarted.resolve(undefined)
          return listed.promise
        },
      }),
    )
    await listStarted.promise
    store.setter(closeConditionalFormatEditorAtom)
    store.setter(setConditionalFormatRulesAtom, {
      sheetId: 'sheet-b',
      rules: [makeEntry('b-current')],
      revision: 20,
    })
    store.setter(openConditionalFormatEditorAtom, makeEntry('new-session'))
    listed.resolve({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 9,
      rules: [makeEntry('stale')],
    })
    await pending

    expect(store.getter(conditionalFormatRulesCacheAtom)).toMatchObject({
      sheetId: 'sheet-b',
      revision: 20,
      rules: [{ id: 'b-current' }],
    })
    expect(store.getter(conditionalFormatEditorAtom)).toMatchObject({
      open: true,
      ruleId: 'new-session',
      pending: false,
      error: null,
    })
  })

  test('caller mutation after reservation cannot alter the core-owned request snapshot', async () => {
    const store = createStore()
    const entry = makeEntry('snapshot-rule')
    const explicitScope = copyScope(TARGET_SCOPE)
    const started = deferred<SetConditionalFormatRuleRequest>()
    const gate = deferred<ConditionalFormatMutationAcknowledgement>()
    prepareOpenStore(store, entry)
    const input = saveInput((request) => {
      started.resolve(request)
      return gate.promise
    })
    input.scope = explicitScope

    const pending = store.setter(runConditionalFormatMutationAtom, input)
    explicitScope.range.rowStart = 99
    entry.scope.range.rowStart = 88
    ;(entry.rule as CellValueRule).value = 'caller-mutated'
    input.sheetId = 'caller-mutated'
    const request = await started.promise

    expect(request).toMatchObject({
      sheetId: 'sheet-1',
      scope: { range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 } },
      rule: { kind: 'cell-value', value: '1' },
    })
    gate.resolve(acknowledged(request))
    await pending
  })

  test('remove uses the same strict ticket and ledger contract', async () => {
    const store = createStore()
    const removeRule = jest.fn(async (request: RemoveConditionalFormatRuleRequest) =>
      acknowledged(request, 12),
    )
    prepareOpenStore(store, makeEntry('remove-me'))

    await store.setter(runConditionalFormatMutationAtom, {
      action: 'remove',
      sheetId: 'sheet-1',
      scope: copyScope(TARGET_SCOPE),
      removeRule,
    })

    expect(removeRule).toHaveBeenCalledWith({
      kind: 'remove-conditional-format-rule',
      sheetId: 'sheet-1',
      ruleId: 'remove-me',
      requestId: 1,
      revision: 7,
    })
    expect(store.getter(conditionalFormatOperationAttemptLedgerAtom)[0]).toMatchObject({
      action: 'remove',
      ruleId: 'remove-me',
      scope: null,
      status: 'acknowledged',
      resultRevision: 12,
    })
  })

  test('bounded journal evicts only acknowledged history through public commands', async () => {
    const store = createStore()
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-1', rules: [] })
    for (let index = 1; index <= CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX + 1; index += 1) {
      store.setter(openConditionalFormatEditorAtom, null)
      await store.setter(
        runConditionalFormatMutationAtom,
        saveInput(async (request) => acknowledged(request, index)),
      )
    }

    const ledger = store.getter(conditionalFormatOperationAttemptLedgerAtom)
    expect(ledger).toHaveLength(CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX)
    expect(ledger[0]).toMatchObject({ operationId: 'conditional-format-2', requestId: 2 })
    expect(ledger.at(-1)).toMatchObject({
      operationId: `conditional-format-${CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX + 1}`,
      requestId: CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX + 1,
    })
    expect(ledger.every((attempt: any) => attempt.status === 'acknowledged')).toBe(true)
  })

  test('DisplayCell keeps conditional formatting as projection data beside base format', () => {
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: '42',
      format: { italic: true },
      conditionalFormat: { bold: true },
    }
    expect(cell.conditionalFormat?.bold).toBe(true)
    expect(cell.format?.italic).toBe(true)
  })
})
