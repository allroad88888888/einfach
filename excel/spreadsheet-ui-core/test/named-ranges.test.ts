import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import { commitNameBoxAtom } from '../src/name-box'
import {
  closeNameManagerAtom,
  deleteNameManagerEntryAtom,
  loadNamedRangeCapabilitiesAtom,
  nameManagerEditorAtom,
  nameManagerDraftGenerationAtom,
  nameManagerKindDraftAtom,
  nameManagerNameDraftAtom,
  nameManagerParamsDraftAtom,
  nameManagerRefersToDraftAtom,
  nameManagerScopeDraftAtom,
  nameManagerSelectedEntryAtom,
  nameManagerSessionIdAtom,
  nameRegistryCacheAtom,
  NAMED_RANGE_CACHE_MAX,
  NAMED_RANGE_MUTATION_LEDGER_MAX,
  NAMED_RANGE_NAME_MAX_LENGTH,
  namedRangeCapabilitiesAtom,
  namedRangeIdentity,
  namedRangeMutationBlockedAtom,
  namedRangeMutationPendingAtom,
  namedRangeMutationStateAtom,
  namedRangeOperationAttemptLedgerAtom,
  namedRangeRegistryStateAtom,
  namedRangeScopeEquals,
  normalizeNamedRangeName,
  openNameManagerAtom,
  refreshNamedRangeRegistryAtom,
  runNamedRangeMutationAtom,
  saveNameManagerAtom,
  setNameRegistryAtom,
  settleNamedRangeMutationAtom,
} from '../src/named-ranges'
import type {
  DeleteNamedRangeRequest,
  ListNamedRangesRequest,
  NamedRange,
  NamedRangeBackendCapabilities,
  NamedRangeControllerPort,
  NamedRangeListResult,
  NamedRangeMutationPayload,
  NamedRangeMutationResult,
  SetNamedRangeRequest,
} from '../src/named-ranges'
import { setSelectionAtom } from '../src/selection'

const CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'static-session',
  scopes: Object.freeze(['workbook', 'sheet'] as const),
  bindings: Object.freeze({ range: true, constant: true, lambda: true }),
  delete: true,
  rangeSemantics: 'stored-definition',
  listAuthority: 'static-session-registry',
  definitionReadback: 'full',
  namesWitness: false,
  mutationAck: 'session-registry-accepted',
  durability: 'session-local',
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

function makePort(overrides: Partial<NamedRangeControllerPort> = {}): NamedRangeControllerPort {
  return {
    readNamedRangeCapabilities: async () => CAPABILITIES,
    listNamedRanges: async (request) => ({ requestId: request.requestId, names: [] }),
    setNamedRange: async (request) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied',
    }),
    deleteNamedRange: async (request) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied',
    }),
    ...overrides,
  }
}

async function prepareCapabilities(
  store: ReturnType<typeof createStore>,
  source: NamedRangeControllerPort,
): Promise<void> {
  store.setter(loadNamedRangeCapabilitiesAtom, { source })
  await flushMicrotasks()
  expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
}

function setRangeMutation(name = 'Alpha'): NamedRangeMutationPayload {
  return {
    action: 'set',
    name,
    scope: 'workbook',
    refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
  }
}

function makeRange(name: string): NamedRange {
  return {
    name,
    scope: 'workbook',
    refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
  }
}

function hasOwnRevision(value: object): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'revision')
}

describe('named-ranges atoms', () => {
  test('initial cache is empty', () => {
    const store = createStore()
    expect(store.getter(nameRegistryCacheAtom)).toEqual([])
  })

  test('setNameRegistryAtom replaces the cache wholesale', () => {
    const store = createStore()

    store.setter(setNameRegistryAtom, {
      names: [makeRange('Alpha'), makeRange('Beta')],
    })
    expect(store.getter(nameRegistryCacheAtom)).toHaveLength(2)
    expect(store.getter(nameRegistryCacheAtom)[0].name).toBe('Alpha')

    store.setter(setNameRegistryAtom, {
      names: [makeRange('Gamma')],
    })
    expect(store.getter(nameRegistryCacheAtom)).toHaveLength(1)
    expect(store.getter(nameRegistryCacheAtom)[0].name).toBe('Gamma')
  })

  test('push beyond cap truncates oldest entries (FIFO)', () => {
    const store = createStore()

    const items = Array.from({ length: NAMED_RANGE_CACHE_MAX + 1 }, (_, i) => makeRange(`Name${i}`))

    store.setter(setNameRegistryAtom, { names: items })
    const snapshot = store.getter(nameRegistryCacheAtom)
    items[NAMED_RANGE_CACHE_MAX].name = 'MutatedOutsideCore'
    items[NAMED_RANGE_CACHE_MAX].refersTo = {
      kind: 'range',
      sheetId: 'external-sheet',
      address: 'Z99',
    }

    expect(snapshot).toHaveLength(NAMED_RANGE_CACHE_MAX)
    expect(snapshot[0].name).toBe('Name1')
    expect(snapshot[snapshot.length - 1]).toEqual(makeRange(`Name${NAMED_RANGE_CACHE_MAX}`))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[snapshot.length - 1])).toBe(true)
    expect(Object.isFrozen(snapshot[snapshot.length - 1].refersTo)).toBe(true)
  })

  test('openNameManagerAtom sets editor state', () => {
    const store = createStore()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    expect(store.getter(nameManagerEditorAtom)).toEqual({ status: 'editing-new' })

    const draft = makeRange('MyName')
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft })
    expect(store.getter(nameManagerEditorAtom)).toEqual({
      status: 'editing-existing',
      draft,
    })
  })

  test('closeNameManagerAtom resets editor to closed', () => {
    const store = createStore()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(closeNameManagerAtom)
    expect(store.getter(nameManagerEditorAtom)).toEqual({ status: 'closed' })
  })
})

describe('named-range public identity', () => {
  test('normalizes valid names without changing their display case', () => {
    expect(normalizeNamedRangeName('  Sales_Total9  ')).toBe('Sales_Total9')
    expect(normalizeNamedRangeName(`_${'a'.repeat(NAMED_RANGE_NAME_MAX_LENGTH - 1)}`)).toHaveLength(
      NAMED_RANGE_NAME_MAX_LENGTH,
    )
  })

  test('rejects names outside the public Excel subset', () => {
    expect(normalizeNamedRangeName('')).toBeNull()
    expect(normalizeNamedRangeName('1Sales')).toBeNull()
    expect(normalizeNamedRangeName('Sales Total')).toBeNull()
    expect(normalizeNamedRangeName(`_${'a'.repeat(NAMED_RANGE_NAME_MAX_LENGTH)}`)).toBeNull()
  })

  test('compares names case-insensitively inside the same scope', () => {
    expect(namedRangeIdentity('Sales', 'workbook')).toBe(namedRangeIdentity('sales', 'workbook'))
    expect(namedRangeIdentity('Sales', { sheetId: 'sheet-1' })).not.toBe(
      namedRangeIdentity('Sales', { sheetId: 'sheet-2' }),
    )
    expect(namedRangeIdentity('Sales', 'workbook')).not.toBe(
      namedRangeIdentity('Sales', { sheetId: 'sheet-1' }),
    )
    expect(namedRangeScopeEquals({ sheetId: 'sheet-1' }, { sheetId: 'sheet-1' })).toBe(true)
    expect(namedRangeScopeEquals({ sheetId: 'sheet-1' }, { sheetId: 'sheet-2' })).toBe(false)
  })
})

describe('NR-C0 capability and shared mutation lane', () => {
  test('C03 requires an explicit ready capability before dispatch and blocks unsupported work', async () => {
    const unloadedStore = createStore()
    const unloadedSet = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const unloadedSource = makePort({ setNamedRange: unloadedSet })

    unloadedStore.setter(runNamedRangeMutationAtom, {
      source: unloadedSource,
      origin: 'name-manager',
      mutation: setRangeMutation('Unloaded'),
    })
    await flushMicrotasks()

    expect(unloadedSet).not.toHaveBeenCalled()
    expect(unloadedStore.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'blocked',
      error: '名称能力不可用',
    })

    const loadingStore = createStore()
    const capabilityRead = deferred<NamedRangeBackendCapabilities>()
    const loadingSet = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const loadingSource = makePort({
      readNamedRangeCapabilities: () => capabilityRead.promise,
      setNamedRange: loadingSet,
    })

    loadingStore.setter(loadNamedRangeCapabilitiesAtom, { source: loadingSource })
    expect(loadingStore.getter(namedRangeCapabilitiesAtom).status).toBe('loading')
    loadingStore.setter(runNamedRangeMutationAtom, {
      source: loadingSource,
      origin: 'name-manager',
      mutation: setRangeMutation('Loading'),
    })
    await Promise.resolve()

    expect(loadingSet).not.toHaveBeenCalled()

    capabilityRead.resolve(CAPABILITIES)
    await flushMicrotasks()

    const unsupportedStore = createStore()
    const unsupportedSet = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const unsupportedSource = makePort({
      readNamedRangeCapabilities: async () => ({
        ...CAPABILITIES,
        bindings: { ...CAPABILITIES.bindings, range: false },
      }),
      setNamedRange: unsupportedSet,
    })
    await prepareCapabilities(unsupportedStore, unsupportedSource)

    unsupportedStore.setter(runNamedRangeMutationAtom, {
      source: unsupportedSource,
      origin: 'name-manager',
      mutation: setRangeMutation('Unsupported'),
    })
    await flushMicrotasks()

    expect(unsupportedSet).not.toHaveBeenCalled()
    expect(unsupportedStore.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'blocked',
      error: '当前名称操作不受支持',
    })

    const unavailableStore = createStore()
    const unavailableSet = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const unavailableSource = makePort({
      readNamedRangeCapabilities: async () => Promise.reject(new Error('capability failed')),
      setNamedRange: unavailableSet,
    })
    unavailableStore.setter(loadNamedRangeCapabilitiesAtom, { source: unavailableSource })
    await flushMicrotasks()
    expect(unavailableStore.getter(namedRangeCapabilitiesAtom).status).toBe('unavailable')

    unavailableStore.setter(runNamedRangeMutationAtom, {
      source: unavailableSource,
      origin: 'name-box',
      mutation: setRangeMutation('Unavailable'),
    })
    await flushMicrotasks()

    expect(unavailableSet).not.toHaveBeenCalled()
  })

  test('C01/C04 synchronously reserves one lane for Manager and NameBox duplicate intents', async () => {
    const store = createStore()
    const transport = deferred<NamedRangeMutationResult>()
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => transport.promise)
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    })
    store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'ManagerName')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, 'B2:C3')

    store.setter(saveNameManagerAtom, { source, activeSheetId: 'sheet-1' })
    const reservedState = store.getter(namedRangeMutationStateAtom)

    expect(reservedState).toMatchObject({
      status: 'pending',
      origin: 'name-manager',
      action: 'set',
    })
    expect(store.getter(namedRangeMutationPendingAtom)).toBe(true)
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(1)
    expect(setNamedRange).not.toHaveBeenCalled()

    const nameBoxTarget = store.setter(commitNameBoxAtom, {
      source,
      input: 'NameBoxName',
    })
    store.setter(saveNameManagerAtom, { source, activeSheetId: 'sheet-1' })

    expect(nameBoxTarget).toMatchObject({ kind: 'define-name', name: 'NameBoxName' })
    expect(store.getter(namedRangeMutationStateAtom)).toBe(reservedState)
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(1)
    expect(setNamedRange).not.toHaveBeenCalled()

    await Promise.resolve()

    expect(setNamedRange).toHaveBeenCalledTimes(1)
    const request = setNamedRange.mock.calls[0][0]
    transport.resolve({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied',
    })
    await flushMicrotasks()
  })

  test('C09 keeps the lane closed while an acknowledged mutation refresh is pending', async () => {
    const store = createStore()
    const mutation = deferred<NamedRangeMutationResult>()
    const registryRead = deferred<NamedRangeListResult>()
    const setNamedRange = jest.fn((request: SetNamedRangeRequest) =>
      setNamedRange.mock.calls.length === 1
        ? mutation.promise
        : Promise.resolve({
            requestId: request.requestId,
            outcome: 'confirmed-not-applied' as const,
          }),
    )
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) => registryRead.promise)
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-manager',
      mutation: setRangeMutation('First'),
    })
    await Promise.resolve()
    const firstRequest = setNamedRange.mock.calls[0][0]
    mutation.resolve({
      requestId: firstRequest.requestId,
      outcome: 'w0-acknowledged',
    })
    await flushMicrotasks(4)

    expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('refreshing')
    expect(listNamedRanges).toHaveBeenCalledTimes(1)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('BlockedDuringRefresh'),
    })
    await Promise.resolve()

    expect(setNamedRange).toHaveBeenCalledTimes(1)

    const listRequest = listNamedRanges.mock.calls[0][0]
    registryRead.resolve({
      requestId: listRequest.requestId,
      revision: 2,
      names: [makeRange('First')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('AllowedAfterRefresh'),
    })
    await flushMicrotasks()

    expect(setNamedRange).toHaveBeenCalledTimes(2)
  })
})

describe('NR-C0 strict mutation settlement', () => {
  test.each(['w0-acknowledged', 'confirmed-not-applied'] as const)(
    'C05 accepts an exact %s result for a set operation',
    async (outcome) => {
      const store = createStore()
      const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
        revision: 7,
        outcome,
      }))
      const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
        requestId: request.requestId,
        revision: 7,
        names: [makeRange('Accepted')],
      }))
      const source = makePort({ setNamedRange, listNamedRanges })
      await prepareCapabilities(store, source)

      store.setter(runNamedRangeMutationAtom, {
        source,
        origin: 'name-manager',
        mutation: setRangeMutation('Accepted'),
      })
      await flushMicrotasks()

      const expectedStatus =
        outcome === 'w0-acknowledged' ? 'acknowledged' : 'confirmed-not-applied'
      expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
        status: expectedStatus,
        outcome,
        error: null,
      })
      const [attempt] = store.getter(namedRangeOperationAttemptLedgerAtom)
      expect([attempt]).toEqual([
        expect.objectContaining({
          status: expectedStatus,
          revision: 7,
        }),
      ])
      expect(hasOwnRevision(attempt)).toBe(true)
      expect(listNamedRanges).toHaveBeenCalledTimes(outcome === 'w0-acknowledged' ? 1 : 0)
    },
  )

  test('C05 omits revision from terminal snapshots when the exact result omits it', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      names: [makeRange('NoRevision')],
    }))
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('NoRevision'),
    })
    await flushMicrotasks()

    const [attempt] = store.getter(namedRangeOperationAttemptLedgerAtom)
    const registry = store.getter(namedRangeRegistryStateAtom)
    expect(attempt.status).toBe('acknowledged')
    expect(hasOwnRevision(attempt)).toBe(false)
    expect(registry.status).toBe('ready')
    expect(hasOwnRevision(registry)).toBe(false)
  })

  test.each([
    [
      'a mismatched requestId',
      (request: SetNamedRangeRequest) => ({
        requestId: Number(request.requestId) + 1,
        outcome: 'w0-acknowledged',
      }),
    ],
    [
      'a missing requestId',
      () => ({
        outcome: 'w0-acknowledged',
      }),
    ],
    [
      'a missing outcome',
      (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
      }),
    ],
    [
      'an unknown outcome',
      (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
        outcome: 'not-a-contract-outcome',
      }),
    ],
    [
      'an invalid revision',
      (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
        outcome: 'w0-acknowledged',
        revision: Number.POSITIVE_INFINITY,
      }),
    ],
    [
      'an own revision property whose value is undefined',
      (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
        outcome: 'w0-acknowledged',
        revision: undefined,
      }),
    ],
  ])('C06 maps %s to an ordinary unconfirmed result', async (_label, response) => {
    const store = createStore()
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      names: [],
    }))
    const source = makePort({
      setNamedRange: async (request) => response(request) as NamedRangeMutationResult,
      listNamedRanges,
    })
    await prepareCapabilities(store, source)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-manager',
      mutation: setRangeMutation('StrictResult'),
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'outcome-unknown',
      outcome: null,
      error: '操作结果未确认',
    })
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error: '操作结果未确认',
    })
    expect(listNamedRanges).not.toHaveBeenCalled()
  })

  test.each([
    ['a rejected transport', new Error('transport failed')],
    ['a typed unknown result', { code: 'NAMED_RANGE_OUTCOME_UNKNOWN' }],
  ])('C06 maps %s to an ordinary unconfirmed result', async (_label, reason) => {
    const store = createStore()
    const source = makePort({
      setNamedRange: async () => Promise.reject(reason),
    })
    await prepareCapabilities(store, source)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('Rejected'),
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'outcome-unknown',
      error: '操作结果未确认',
    })
    expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
  })

  test('C06 treats a resolved adapter outcome-unknown payload as unconfirmed', async () => {
    const store = createStore()
    const source = makePort({
      setNamedRange: async (request) =>
        ({
          requestId: request.requestId,
          outcome: 'outcome-unknown',
          code: 'NAMED_RANGE_OUTCOME_UNKNOWN',
        }) as unknown as NamedRangeMutationResult,
    })
    await prepareCapabilities(store, source)

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('ResolvedUnknown'),
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'outcome-unknown',
      error: '操作结果未确认',
    })
    expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
  })

  test('C07/C08 keeps unknown across UI/refresh and only the same ticket late ack unlocks it', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async () =>
      Promise.reject({ code: 'NAMED_RANGE_OUTCOME_UNKNOWN' }),
    )
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      revision: `r${request.requestId}`,
      names: [makeRange('LastGood')],
    }))
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-manager',
      mutation: setRangeMutation('Unknown'),
    })
    await flushMicrotasks()
    const unresolvedRequestId = store.getter(namedRangeMutationStateAtom).requestId!

    store.setter(closeNameManagerAtom)
    store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(refreshNamedRangeRegistryAtom, { source })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-box',
      mutation: setRangeMutation('BlockedByUnknown'),
    })
    store.setter(settleNamedRangeMutationAtom, {
      source,
      result: {
        requestId: unresolvedRequestId + 1,
        outcome: 'w0-acknowledged',
      },
    })
    await flushMicrotasks()

    expect(setNamedRange).toHaveBeenCalledTimes(1)
    expect(store.getter(namedRangeMutationStateAtom).status).toBe('outcome-unknown')

    store.setter(settleNamedRangeMutationAtom, {
      source,
      result: {
        requestId: unresolvedRequestId,
        outcome: 'w0-acknowledged',
        revision: 9,
      },
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'acknowledged',
      requestId: unresolvedRequestId,
      outcome: 'w0-acknowledged',
    })
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      revision: 9,
    })
    expect(listNamedRanges).toHaveBeenCalledTimes(2)
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    expect(store.getter(namedRangeMutationBlockedAtom)).toBe(false)
  })
})

describe('NR-C0 Manager interaction ownership', () => {
  test('C05 keeps the current Manager draft when the write is confirmed not applied', async () => {
    const store = createStore()
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      names: [],
    }))
    const source = makePort({ listNamedRanges })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'KeepMe')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, 'A1:B2')

    store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-1' })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'confirmed-not-applied',
      outcome: 'confirmed-not-applied',
    })
    expect(listNamedRanges).not.toHaveBeenCalled()
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerSessionIdAtom)).toBe(sessionId)
    expect(store.getter(nameManagerNameDraftAtom)).toBe('KeepMe')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('A1:B2')
  })

  test('C09 closes and resets the owned Manager session only after a valid guarded refresh', async () => {
    const store = createStore()
    const mutation = deferred<NamedRangeMutationResult>()
    const registryRead = deferred<NamedRangeListResult>()
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => mutation.promise)
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) => registryRead.promise)
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'CloseAfterRefresh')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, 'A1')

    store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-1' })
    await Promise.resolve()
    const mutationRequest = setNamedRange.mock.calls[0][0]
    mutation.resolve({
      requestId: mutationRequest.requestId,
      outcome: 'w0-acknowledged',
      revision: 2,
    })
    await flushMicrotasks(4)

    expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('refreshing')
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('CloseAfterRefresh')

    const listRequest = listNamedRanges.mock.calls[0][0]
    registryRead.resolve({
      requestId: listRequest.requestId,
      revision: 2,
      names: [makeRange('CloseAfterRefresh')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    expect(store.getter(nameManagerEditorAtom)).toEqual({ status: 'closed' })
    expect(store.getter(nameManagerSessionIdAtom)).not.toBe(sessionId)
    expect(store.getter(nameManagerSelectedEntryAtom)).toBeNull()
    expect(store.getter(nameManagerNameDraftAtom)).toBe('')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('')
  })

  test.each(['reject', 'mismatched-request', 'invalid-revision', 'undefined-revision'] as const)(
    'C09 keeps last-good projection and Manager draft when refresh ends as %s',
    async (failure) => {
      const store = createStore()
      const listNamedRanges = jest.fn(
        (request: ListNamedRangesRequest): Promise<NamedRangeListResult> => {
          if (failure === 'reject') return Promise.reject(new Error('list failed'))
          if (failure === 'mismatched-request') {
            return Promise.resolve({
              requestId: Number(request.requestId) + 1,
              revision: 2,
              names: [makeRange('Untrusted')],
            })
          }
          return Promise.resolve(
            failure === 'invalid-revision'
              ? {
                  requestId: request.requestId,
                  revision: Number.POSITIVE_INFINITY,
                  names: [makeRange('Untrusted')],
                }
              : {
                  requestId: request.requestId,
                  revision: undefined,
                  names: [makeRange('Untrusted')],
                },
          )
        },
      )
      const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
        requestId: request.requestId,
        outcome: 'w0-acknowledged' as const,
        revision: 2,
      }))
      const source = makePort({ setNamedRange, listNamedRanges })
      store.setter(setNameRegistryAtom, { revision: 1, names: [makeRange('LastGood')] })
      await prepareCapabilities(store, source)
      const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
      store.setter(nameManagerNameDraftAtom, 'StillEditing')
      store.setter(nameManagerKindDraftAtom, 'range')
      store.setter(nameManagerRefersToDraftAtom, 'C3')

      store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-1' })
      await flushMicrotasks()

      expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
      expect(store.getter(namedRangeOperationAttemptLedgerAtom)[0]).toMatchObject({
        status: 'acknowledged',
        revision: 2,
      })
      expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
        status: 'projection-unknown',
        revision: 1,
        error: '名称列表未确认',
      })
      expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual(['LastGood'])
      expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
      expect(store.getter(nameManagerSessionIdAtom)).toBe(sessionId)
      expect(store.getter(nameManagerNameDraftAtom)).toBe('StillEditing')
      expect(store.getter(nameManagerRefersToDraftAtom)).toBe('C3')
      expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
    },
  )

  test('C13 same-session draft edits survive an older exact ack and guarded refresh', async () => {
    const store = createStore()
    const mutation = deferred<NamedRangeMutationResult>()
    const registryRead = deferred<NamedRangeListResult>()
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => mutation.promise)
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) => registryRead.promise)
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'OriginalDraft')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, 'A1')

    store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-1' })
    await Promise.resolve()
    const submittedGeneration = store.getter(nameManagerDraftGenerationAtom)
    store.setter(nameManagerNameDraftAtom, 'NewerDraft')
    store.setter(nameManagerRefersToDraftAtom, 'D4')
    expect(store.getter(nameManagerDraftGenerationAtom)).toBeGreaterThan(submittedGeneration)

    const mutationRequest = setNamedRange.mock.calls[0][0]
    mutation.resolve({ requestId: mutationRequest.requestId, outcome: 'w0-acknowledged' })
    await flushMicrotasks(4)
    const listRequest = listNamedRanges.mock.calls[0][0]
    registryRead.resolve({
      requestId: listRequest.requestId,
      names: [makeRange('OriginalDraft')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    expect(store.getter(nameManagerSessionIdAtom)).toBe(sessionId)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('NewerDraft')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('D4')
  })

  test('C13 a pending delete cannot clear a newer selection in the same Manager session', async () => {
    const store = createStore()
    const mutation = deferred<NamedRangeMutationResult>()
    const registryRead = deferred<NamedRangeListResult>()
    const deleteNamedRange = jest.fn((_request: DeleteNamedRangeRequest) => mutation.promise)
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) => registryRead.promise)
    const source = makePort({ deleteNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)
    const entryA = makeRange('EntryA')
    const entryB = makeRange('EntryB')
    const sessionId = store.setter(openNameManagerAtom, {
      status: 'editing-existing',
      draft: entryA,
    })

    store.setter(deleteNameManagerEntryAtom, { source, sessionId })
    await Promise.resolve()
    store.setter(nameManagerSelectedEntryAtom, entryB)

    const mutationRequest = deleteNamedRange.mock.calls[0][0]
    mutation.resolve({ requestId: mutationRequest.requestId, outcome: 'w0-acknowledged' })
    await flushMicrotasks(4)
    const listRequest = listNamedRanges.mock.calls[0][0]
    registryRead.resolve({ requestId: listRequest.requestId, names: [entryB] })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    expect(store.getter(nameManagerSessionIdAtom)).toBe(sessionId)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-existing')
    expect(store.getter(nameManagerSelectedEntryAtom)).toEqual(entryB)
  })

  test('C13 an older session ack refreshes globally without clearing the current session', async () => {
    const store = createStore()
    const mutation = deferred<NamedRangeMutationResult>()
    const registryRead = deferred<NamedRangeListResult>()
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => mutation.promise)
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) => registryRead.promise)
    const source = makePort({ setNamedRange, listNamedRanges })
    await prepareCapabilities(store, source)
    const oldSessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'OldSessionDraft')
    store.setter(nameManagerRefersToDraftAtom, 'A1')
    store.setter(saveNameManagerAtom, {
      source,
      sessionId: oldSessionId,
      activeSheetId: 'sheet-1',
    })
    await Promise.resolve()

    const currentSessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'CurrentSessionDraft')
    store.setter(nameManagerRefersToDraftAtom, 'B2')

    const mutationRequest = setNamedRange.mock.calls[0][0]
    mutation.resolve({ requestId: mutationRequest.requestId, outcome: 'w0-acknowledged' })
    await flushMicrotasks(4)
    const listRequest = listNamedRanges.mock.calls[0][0]
    registryRead.resolve({
      requestId: listRequest.requestId,
      names: [makeRange('OldSessionDraft')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'acknowledged',
      sessionId: oldSessionId,
    })
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    expect(store.getter(nameManagerSessionIdAtom)).toBe(currentSessionId)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('CurrentSessionDraft')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('B2')
  })

  test('C13 explicit stale-session save and delete intents dispatch nothing', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const deleteNamedRange = jest.fn(async (request: DeleteNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const source = makePort({ setNamedRange, deleteNamedRange })
    await prepareCapabilities(store, source)
    const staleSessionId = store.setter(openNameManagerAtom, {
      status: 'editing-existing',
      draft: makeRange('StaleEntry'),
    })
    const currentEntry = makeRange('CurrentEntry')
    const currentSessionId = store.setter(openNameManagerAtom, {
      status: 'editing-existing',
      draft: currentEntry,
    })
    const stateBefore = store.getter(namedRangeMutationStateAtom)

    store.setter(saveNameManagerAtom, {
      source,
      sessionId: staleSessionId,
      entry: makeRange('StaleEntry'),
    })
    store.setter(deleteNameManagerEntryAtom, {
      source,
      sessionId: staleSessionId,
      entry: makeRange('StaleEntry'),
    })
    await flushMicrotasks()

    expect(setNamedRange).not.toHaveBeenCalled()
    expect(deleteNamedRange).not.toHaveBeenCalled()
    expect(store.getter(namedRangeMutationStateAtom)).toBe(stateBefore)
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(0)
    expect(store.getter(nameManagerSessionIdAtom)).toBe(currentSessionId)
    expect(store.getter(nameManagerEditorAtom)).toMatchObject({
      status: 'editing-existing',
      draft: currentEntry,
    })
    expect(store.getter(nameManagerSelectedEntryAtom)).toEqual(currentEntry)
    expect(store.getter(nameManagerNameDraftAtom)).toBe('CurrentEntry')
  })
})

describe('NR-C0 Store isolation and registry ordering', () => {
  test('C02 keeps equal operations isolated across two workbook Stores', async () => {
    const storeA = createStore()
    const storeB = createStore()
    const mutationA = deferred<NamedRangeMutationResult>()
    const mutationB = deferred<NamedRangeMutationResult>()
    const setA = jest.fn((_request: SetNamedRangeRequest) => mutationA.promise)
    const setB = jest.fn((_request: SetNamedRangeRequest) => mutationB.promise)
    const listA = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      revision: 'store-a',
      names: [makeRange('StoreA')],
    }))
    const listB = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      revision: 'store-b',
      names: [makeRange('StoreB')],
    }))
    const sourceA = makePort({ setNamedRange: setA, listNamedRanges: listA })
    const sourceB = makePort({ setNamedRange: setB, listNamedRanges: listB })
    await prepareCapabilities(storeA, sourceA)
    await prepareCapabilities(storeB, sourceB)
    const sessionA = storeA.setter(openNameManagerAtom, { status: 'editing-new' })
    const sessionB = storeB.setter(openNameManagerAtom, { status: 'editing-new' })

    storeA.setter(runNamedRangeMutationAtom, {
      source: sourceA,
      origin: 'name-manager',
      sessionId: sessionA,
      mutation: setRangeMutation('SameInput'),
    })
    storeB.setter(runNamedRangeMutationAtom, {
      source: sourceB,
      origin: 'name-manager',
      sessionId: sessionB,
      mutation: setRangeMutation('SameInput'),
    })
    await Promise.resolve()

    const requestA = setA.mock.calls[0][0]
    const requestB = setB.mock.calls[0][0]
    expect(requestA.requestId).toBe(requestB.requestId)
    expect(sessionA).toBe(sessionB)
    expect(storeA.getter(namedRangeOperationAttemptLedgerAtom)).not.toBe(
      storeB.getter(namedRangeOperationAttemptLedgerAtom),
    )

    mutationA.resolve({ requestId: requestA.requestId, outcome: 'w0-acknowledged' })
    mutationB.reject(new Error('store-b transport failed'))
    await flushMicrotasks()

    expect(storeA.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
    expect(storeA.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      revision: 'store-a',
    })
    expect(storeA.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual(['StoreA'])
    expect(storeA.getter(namedRangeMutationBlockedAtom)).toBe(false)

    expect(storeB.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'outcome-unknown',
      error: '操作结果未确认',
    })
    expect(storeB.getter(namedRangeRegistryStateAtom).status).toBe('idle')
    expect(storeB.getter(nameRegistryCacheAtom)).toEqual([])
    expect(storeB.getter(namedRangeMutationBlockedAtom)).toBe(true)
    expect(listA).toHaveBeenCalledTimes(1)
    expect(listB).not.toHaveBeenCalled()
  })

  test('C10 publishes only the latest list read when responses return in reverse order', async () => {
    const store = createStore()
    const firstRead = deferred<NamedRangeListResult>()
    const secondRead = deferred<NamedRangeListResult>()
    const listNamedRanges = jest.fn((_request: ListNamedRangesRequest) =>
      listNamedRanges.mock.calls.length === 1 ? firstRead.promise : secondRead.promise,
    )
    const source = makePort({ listNamedRanges })
    await prepareCapabilities(store, source)

    store.setter(refreshNamedRangeRegistryAtom, { source })
    store.setter(refreshNamedRangeRegistryAtom, { source })
    await Promise.resolve()

    expect(listNamedRanges).toHaveBeenCalledTimes(2)
    const firstRequest = listNamedRanges.mock.calls[0][0]
    const secondRequest = listNamedRanges.mock.calls[1][0]
    secondRead.resolve({
      requestId: secondRequest.requestId,
      revision: 'latest',
      names: [makeRange('Latest')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      requestId: secondRequest.requestId,
      revision: 'latest',
    })
    expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual(['Latest'])

    firstRead.resolve({
      requestId: firstRequest.requestId,
      revision: 'stale',
      names: [makeRange('Stale')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      requestId: secondRequest.requestId,
      revision: 'latest',
    })
    expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual(['Latest'])
  })

  test('C11 public refresh keeps the latest 500 entries as a Core-owned deep snapshot', async () => {
    const store = createStore()
    const publicNames = Array.from({ length: NAMED_RANGE_CACHE_MAX + 1 }, (_, index) =>
      makeRange(`PublicName${index}`),
    )
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      revision: 'public-501',
      names: publicNames,
    }))
    const source = makePort({ listNamedRanges })
    await prepareCapabilities(store, source)

    store.setter(refreshNamedRangeRegistryAtom, { source })
    await flushMicrotasks()
    const snapshot = store.getter(nameRegistryCacheAtom)

    publicNames[NAMED_RANGE_CACHE_MAX].name = 'MutatedOutsideCore'
    publicNames[NAMED_RANGE_CACHE_MAX].refersTo = {
      kind: 'range',
      sheetId: 'external-sheet',
      address: 'Z99',
    }

    expect(listNamedRanges).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveLength(NAMED_RANGE_CACHE_MAX)
    expect(snapshot[0].name).toBe('PublicName1')
    expect(snapshot[snapshot.length - 1]).toEqual(makeRange(`PublicName${NAMED_RANGE_CACHE_MAX}`))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[snapshot.length - 1])).toBe(true)
    expect(Object.isFrozen(snapshot[snapshot.length - 1].refersTo)).toBe(true)
  })

  test.each([
    {
      label: 'an own valid revision',
      buildResult: (request: ListNamedRangesRequest): NamedRangeListResult => ({
        requestId: request.requestId,
        revision: 'own-valid',
        names: [makeRange('OwnValid')],
      }),
      expectedRevision: 'own-valid',
      expectedOwnRevision: true,
    },
    {
      label: 'an absent revision',
      buildResult: (request: ListNamedRangesRequest): NamedRangeListResult => ({
        requestId: request.requestId,
        names: [makeRange('Absent')],
      }),
      expectedRevision: undefined,
      expectedOwnRevision: false,
    },
    {
      label: 'an inherited revision',
      buildResult: (request: ListNamedRangesRequest): NamedRangeListResult =>
        Object.assign(Object.create({ revision: 'inherited' }) as object, {
          requestId: request.requestId,
          names: [makeRange('Inherited')],
        }) as NamedRangeListResult,
      expectedRevision: undefined,
      expectedOwnRevision: false,
    },
  ])('publishes $label with exact own-property semantics', async (witness) => {
    const store = createStore()
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) =>
      witness.buildResult(request),
    )
    const source = makePort({ listNamedRanges })
    await prepareCapabilities(store, source)

    store.setter(refreshNamedRangeRegistryAtom, { source })
    await flushMicrotasks()

    const registry = store.getter(namedRangeRegistryStateAtom)
    expect(registry.status).toBe('ready')
    expect(registry.revision).toBe(witness.expectedRevision)
    expect(hasOwnRevision(registry)).toBe(witness.expectedOwnRevision)
  })

  test.each([
    ['undefined', undefined],
    ['non-finite', Number.POSITIVE_INFINITY],
  ])(
    'rejects an own %s revision and preserves the last-good snapshot',
    async (_label, revision) => {
      const store = createStore()
      const lastGoodNames = [makeRange('LastGood')]
      store.setter(setNameRegistryAtom, { revision: 'last-good', names: lastGoodNames })
      const lastGood = store.getter(nameRegistryCacheAtom)
      const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
        requestId: request.requestId,
        revision,
        names: [makeRange('Unconfirmed')],
      }))
      const source = makePort({ listNamedRanges })
      await prepareCapabilities(store, source)

      store.setter(refreshNamedRangeRegistryAtom, { source })
      await flushMicrotasks()

      expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
        status: 'projection-unknown',
        revision: 'last-good',
        error: '名称列表未确认',
      })
      expect(store.getter(nameRegistryCacheAtom)).toBe(lastGood)
      expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual(['LastGood'])
    },
  )
})

describe('NR-C0 bounded operation ledger', () => {
  test('C12 dispatches item 33 by evicting only the oldest terminal attempt', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)

    for (let index = 0; index < NAMED_RANGE_MUTATION_LEDGER_MAX + 1; index += 1) {
      store.setter(runNamedRangeMutationAtom, {
        source,
        origin: 'name-box',
        mutation: setRangeMutation(`Name${index}`),
      })
      await flushMicrotasks(4)
    }

    const ledger = store.getter(namedRangeOperationAttemptLedgerAtom)
    expect(setNamedRange).toHaveBeenCalledTimes(NAMED_RANGE_MUTATION_LEDGER_MAX + 1)
    expect(ledger).toHaveLength(NAMED_RANGE_MUTATION_LEDGER_MAX)
    expect(ledger[0]).toMatchObject({ name: 'Name1', status: 'confirmed-not-applied' })
    expect(ledger[ledger.length - 1]).toMatchObject({
      name: `Name${NAMED_RANGE_MUTATION_LEDGER_MAX}`,
      status: 'confirmed-not-applied',
    })
    expect(ledger.every((attempt) => attempt.status === 'confirmed-not-applied')).toBe(true)
  })

  test('C12 never evicts an unresolved attempt and dispatches no later intent', async () => {
    const store = createStore()
    let dispatchCount = 0
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => {
      dispatchCount += 1
      if (dispatchCount === NAMED_RANGE_MUTATION_LEDGER_MAX) {
        throw new Error('outcome remains unknown')
      }
      return {
        requestId: request.requestId,
        outcome: 'confirmed-not-applied' as const,
      }
    })
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)

    for (let index = 0; index < NAMED_RANGE_MUTATION_LEDGER_MAX; index += 1) {
      store.setter(runNamedRangeMutationAtom, {
        source,
        origin: 'name-box',
        mutation: setRangeMutation(`Name${index}`),
      })
      await flushMicrotasks(4)
    }
    const unresolved = store.getter(namedRangeOperationAttemptLedgerAtom).at(-1)
    expect(unresolved).toMatchObject({
      name: `Name${NAMED_RANGE_MUTATION_LEDGER_MAX - 1}`,
      status: 'outcome-unknown',
    })

    store.setter(runNamedRangeMutationAtom, {
      source,
      origin: 'name-manager',
      mutation: setRangeMutation('MustNotDispatch'),
    })
    await flushMicrotasks()

    expect(setNamedRange).toHaveBeenCalledTimes(NAMED_RANGE_MUTATION_LEDGER_MAX)
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(
      NAMED_RANGE_MUTATION_LEDGER_MAX,
    )
    expect(store.getter(namedRangeOperationAttemptLedgerAtom).at(-1)).toBe(unresolved)
    expect(store.getter(namedRangeMutationStateAtom).status).toBe('outcome-unknown')
    expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
  })
})

describe('NR-C0 workbook generation guards', () => {
  test('an old workbook list result cannot overwrite the current workbook registry', async () => {
    const store = createStore()
    const oldRead = deferred<NamedRangeListResult>()
    const currentRead = deferred<NamedRangeListResult>()
    const oldList = jest.fn((_request: ListNamedRangesRequest) => oldRead.promise)
    const currentList = jest.fn((_request: ListNamedRangesRequest) => currentRead.promise)
    const oldSource = makePort({ listNamedRanges: oldList })
    const currentSource = makePort({ listNamedRanges: currentList })
    await prepareCapabilities(store, oldSource)

    store.setter(refreshNamedRangeRegistryAtom, { source: oldSource })
    await Promise.resolve()
    store.setter(loadNamedRangeCapabilitiesAtom, { source: currentSource })
    await flushMicrotasks()
    store.setter(refreshNamedRangeRegistryAtom, { source: currentSource })
    await Promise.resolve()

    const currentRequest = currentList.mock.calls[0][0]
    currentRead.resolve({
      requestId: currentRequest.requestId,
      revision: 'current-workbook',
      names: [makeRange('CurrentWorkbook')],
    })
    await flushMicrotasks()
    const oldRequest = oldList.mock.calls[0][0]
    oldRead.resolve({
      requestId: oldRequest.requestId,
      revision: 'old-workbook',
      names: [makeRange('OldWorkbook')],
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      requestId: currentRequest.requestId,
      revision: 'current-workbook',
    })
    expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual([
      'CurrentWorkbook',
    ])
  })

  test('a context switch before the microtask transport confirms not-applied with zero dispatch', async () => {
    const store = createStore()
    const oldSet = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const oldSource = makePort({ setNamedRange: oldSet })
    const currentSource = makePort()
    await prepareCapabilities(store, oldSource)

    store.setter(runNamedRangeMutationAtom, {
      source: oldSource,
      origin: 'name-box',
      mutation: setRangeMutation('OldWorkbook'),
    })
    store.setter(loadNamedRangeCapabilitiesAtom, { source: currentSource })
    await flushMicrotasks()

    expect(oldSet).not.toHaveBeenCalled()
    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'confirmed-not-applied',
      outcome: 'confirmed-not-applied',
      error: '工作簿上下文已变化',
    })
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toEqual([
      expect.objectContaining({
        status: 'confirmed-not-applied',
        error: '工作簿上下文已变化',
      }),
    ])
    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
  })

  test('an old dispatched ack settles globally without refreshing or clearing the new workbook UI', async () => {
    const store = createStore()
    const oldMutation = deferred<NamedRangeMutationResult>()
    const oldSet = jest.fn((_request: SetNamedRangeRequest) => oldMutation.promise)
    const oldList = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      names: [makeRange('OldWorkbook')],
    }))
    const oldSource = makePort({ setNamedRange: oldSet, listNamedRanges: oldList })
    const currentSource = makePort()
    await prepareCapabilities(store, oldSource)
    const oldSessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'OldWorkbookDraft')
    store.setter(nameManagerRefersToDraftAtom, 'A1')
    store.setter(saveNameManagerAtom, {
      source: oldSource,
      sessionId: oldSessionId,
      activeSheetId: 'sheet-old',
    })
    await Promise.resolve()

    store.setter(loadNamedRangeCapabilitiesAtom, { source: currentSource })
    const currentSessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'CurrentWorkbookDraft')
    store.setter(nameManagerRefersToDraftAtom, 'C3')
    await flushMicrotasks()
    store.setter(setNameRegistryAtom, {
      revision: 'current-workbook',
      names: [makeRange('CurrentWorkbook')],
    })

    const oldRequest = oldSet.mock.calls[0][0]
    oldMutation.resolve({
      requestId: oldRequest.requestId,
      revision: 'old-workbook',
      outcome: 'w0-acknowledged',
    })
    await flushMicrotasks()

    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'acknowledged',
      sessionId: oldSessionId,
    })
    expect(oldList).not.toHaveBeenCalled()
    expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      revision: 'current-workbook',
    })
    expect(store.getter(nameRegistryCacheAtom).map((entry) => entry.name)).toEqual([
      'CurrentWorkbook',
    ])
    expect(store.getter(nameManagerSessionIdAtom)).toBe(currentSessionId)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('CurrentWorkbookDraft')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('C3')
  })
})

describe('NR-C0 Excel Manager draft normalization', () => {
  test('uses the active sheet for a workbook-scoped range without an explicit sheet', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, '  ActiveSheetRange  ')
    store.setter(nameManagerScopeDraftAtom, 'workbook')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, '  B2:C3  ')

    store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-active' })
    await flushMicrotasks()

    expect(setNamedRange).toHaveBeenCalledWith({
      kind: 'set-named-range',
      name: 'ActiveSheetRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-active', address: 'B2:C3' },
      requestId: expect.any(Number),
    })
  })

  test('uses an explicit Sheet!A1 reference instead of the active sheet fallback', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'ExplicitSheetRange')
    store.setter(nameManagerScopeDraftAtom, 'workbook')
    store.setter(nameManagerKindDraftAtom, 'range')
    store.setter(nameManagerRefersToDraftAtom, '  sheet-explicit ! D4:E5  ')

    store.setter(saveNameManagerAtom, { source, sessionId, activeSheetId: 'sheet-active' })
    await flushMicrotasks()

    expect(setNamedRange.mock.calls[0][0]).toMatchObject({
      name: 'ExplicitSheetRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-explicit', address: 'D4:E5' },
    })
  })

  test('normalizes sheet scope plus lambda parameters and formula body', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
    }))
    const source = makePort({ setNamedRange })
    await prepareCapabilities(store, source)
    const sessionId = store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(nameManagerNameDraftAtom, 'LambdaName')
    store.setter(nameManagerScopeDraftAtom, ' sheet:sheet-2 ')
    store.setter(nameManagerKindDraftAtom, 'lambda')
    store.setter(nameManagerParamsDraftAtom, ' x, y, , z ')
    store.setter(nameManagerRefersToDraftAtom, ' x + y * z ')

    store.setter(saveNameManagerAtom, { source, sessionId })
    await flushMicrotasks()

    expect(setNamedRange.mock.calls[0][0]).toMatchObject({
      name: 'LambdaName',
      scope: { sheetId: 'sheet-2' },
      refersTo: {
        kind: 'lambda',
        params: ['x', 'y', 'z'],
        body: '=x + y * z',
      },
    })
  })
})

describe('NR-C0 static controller boundaries', () => {
  const sourceFiles = [
    'excel/spreadsheet-ui-core/src/named-ranges/index.ts',
    'excel/spreadsheet-ui-core/src/named-ranges/types.ts',
    'excel/spreadsheet-ui-core/src/name-box/index.ts',
    'excel/spreadsheet-ui-core/src/name-box/types.ts',
  ]

  test('C15 keeps NameBox and Manager product state in @einfach/core without global controllers', () => {
    const sources = sourceFiles.map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    const combined = sources.join('\n')
    const bareImports = sources.flatMap((source) =>
      [...source.matchAll(/from ['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier.startsWith('.')),
    )

    expect(new Set(bareImports)).toEqual(new Set(['@einfach/core']))
    expect(combined).not.toMatch(/atom\s*<\s*NamedRangeControllerPort\b/)
    expect(combined).not.toMatch(/^(?:let|var)\s+/m)
    expect(combined).not.toMatch(
      /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/m,
    )
  })

  test('C15 keeps transport writers synchronous and returns no transport Promise', () => {
    const namedRangesSource = readFileSync(
      join(process.cwd(), 'excel/spreadsheet-ui-core/src/named-ranges/index.ts'),
      'utf8',
    )
    const nameBoxSource = readFileSync(
      join(process.cwd(), 'excel/spreadsheet-ui-core/src/name-box/index.ts'),
      'utf8',
    )
    const writers = [
      [namedRangesSource, 'loadNamedRangeCapabilitiesAtom'],
      [namedRangesSource, 'refreshNamedRangeRegistryAtom'],
      [namedRangesSource, 'runNamedRangeMutationAtom'],
      [namedRangesSource, 'settleNamedRangeMutationAtom'],
      [nameBoxSource, 'commitNameBoxAtom'],
    ] as const

    for (const [source, name] of writers) {
      const start = source.indexOf(`export const ${name} = atom(`)
      const end = source.indexOf(`${name}.debugLabel`, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const writer = source.slice(start, end)
      expect(writer).not.toMatch(/\basync\b/)
      expect(writer).not.toMatch(/\breturn[\t ]+(?:void[\t ]+)?Promise\b/)
    }
  })
})
