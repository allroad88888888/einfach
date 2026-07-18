import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  blurNameBoxAtom,
  classifyNameBoxInput,
  commitNameBoxAtom,
  findNamedRange,
  focusNameBoxAtom,
  isValidName,
  nameBoxDisplayAtom,
  nameBoxStateAtom,
  parseA1Cell,
  parseA1Range,
  revertNameBoxAtom,
  updateNameBoxInputAtom,
} from '../src/name-box'
import {
  loadNamedRangeCapabilitiesAtom,
  nameRegistryCacheAtom,
  namedRangeMutationStateAtom,
  namedRangeOperationAttemptLedgerAtom,
  type NamedRange,
  type NamedRangeBackendCapabilities,
  type NamedRangeControllerPort,
  type NamedRangeMutationResult,
  type SetNamedRangeRequest,
} from '../src/named-ranges'
import { selectionSnapshotAtom, setSelectionAtom } from '../src/selection'

const RANGE = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

const CAPABILITIES: NamedRangeBackendCapabilities = {
  runtime: 'static-session',
  scopes: ['workbook', 'sheet'],
  bindings: { range: true, constant: true, lambda: true },
  delete: true,
  rangeSemantics: 'stored-definition',
  listAuthority: 'static-session-registry',
  definitionReadback: 'full',
  namesWitness: true,
  mutationAck: 'session-registry-accepted',
  durability: 'session-local',
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('NameBox A1 parsing', () => {
  test('accepts the last Excel cell and rejects addresses outside the grid', () => {
    expect(parseA1Cell('XFD1048576')).toEqual({ row: 1_048_575, col: 16_383 })
    expect(parseA1Cell('A0')).toBeNull()
    expect(parseA1Cell('XFE1')).toBeNull()
    expect(parseA1Cell('A1048577')).toBeNull()
  })

  test('normalizes a reversed range', () => {
    expect(parseA1Range('D5:B2')).toEqual({
      rowStart: 1,
      rowEnd: 4,
      colStart: 1,
      colEnd: 3,
    })
  })

  test('accepts a 255-character name and rejects a 256-character name', () => {
    const maxLengthName = `N${'a'.repeat(254)}`
    const overLengthName = `${maxLengthName}a`
    const context = { sheetId: 'sheet-1', selectionRange: RANGE }

    expect(isValidName(maxLengthName)).toBe(true)
    expect(classifyNameBoxInput(maxLengthName, [], context)).toMatchObject({
      kind: 'define-name',
      name: maxLengthName,
    })
    expect(isValidName(overLengthName)).toBe(false)
    expect(classifyNameBoxInput(overLengthName, [], context)).toEqual({
      kind: 'invalid',
      reason: 'unrecognized',
    })
  })
})

describe('NameBox named-range resolution', () => {
  const registry: NamedRange[] = [
    {
      name: 'Rate',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'workbook-target', address: 'A1' },
    },
    {
      name: 'Rate',
      scope: { sheetId: 'sheet-1' },
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:C3' },
    },
    {
      name: 'Rate',
      scope: { sheetId: 'sheet-2' },
      refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'D4' },
    },
  ]

  test('prefers current-sheet scope, falls back to workbook, and excludes other sheets', () => {
    expect(findNamedRange(registry, 'rate', 'sheet-1')?.scope).toEqual({
      sheetId: 'sheet-1',
    })
    expect(findNamedRange(registry, 'RATE', 'sheet-3')?.scope).toBe('workbook')

    const otherSheetOnly = registry.filter((entry) => entry.scope !== 'workbook')
    const target = classifyNameBoxInput('Rate', otherSheetOnly, {
      sheetId: 'sheet-3',
      selectionRange: RANGE,
    })
    expect(target.kind).toBe('define-name')
  })

  test('keeps first-match compatibility for legacy callers without sheet context', () => {
    const sheetOnly: NamedRange[] = [
      {
        name: 'LocalOnly',
        scope: { sheetId: 'sheet-2' },
        refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'D4' },
      },
    ]

    expect(findNamedRange(sheetOnly, 'LocalOnly')).toBe(sheetOnly[0])
  })

  test('navigates only range bindings', () => {
    const context = { sheetId: 'sheet-1', selectionRange: RANGE }
    const constant: NamedRange = {
      name: 'ConstantName',
      scope: 'workbook',
      refersTo: { kind: 'constant', value: '42' },
    }
    const lambda: NamedRange = {
      name: 'LambdaName',
      scope: 'workbook',
      refersTo: { kind: 'lambda', params: ['x'], body: '=x * 2' },
    }

    expect(classifyNameBoxInput('ConstantName', [constant], context)).toEqual({
      kind: 'invalid',
      reason: 'named-range-not-resolvable',
    })
    expect(classifyNameBoxInput('LambdaName', [lambda], context)).toEqual({
      kind: 'invalid',
      reason: 'named-range-not-resolvable',
    })
  })

  test('uses current-sheet scope for display and navigation', () => {
    const store = createStore()
    store.setter(nameRegistryCacheAtom, registry)
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const target = store.setter(commitNameBoxAtom, { input: 'Rate' })

    expect(target.kind).toBe('named-range')
    expect(store.getter(selectionSnapshotAtom).selection).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    })
    expect(store.getter(nameBoxDisplayAtom)).toBe('Rate')
  })
})

describe('NameBox edit sessions', () => {
  test('invalid input reverts to the canonical display', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    const sessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, { sessionId, input: '!!invalid' })

    const target = store.setter(commitNameBoxAtom, {
      input: '!!invalid',
      sessionId,
    })

    expect(target.kind).toBe('invalid')
    expect(store.getter(nameBoxStateAtom)).toMatchObject({
      input: 'B2',
      display: 'B2',
      error: true,
      mode: 'idle',
      sessionId,
    })
    expect(store.getter(namedRangeMutationStateAtom)).toMatchObject({
      status: 'idle',
      requestId: null,
    })
  })

  test('a 256-character name is rejected and reverted before mutation preflight', () => {
    const store = createStore()
    const overLengthName = `N${'a'.repeat(255)}`
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    const sessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, { sessionId, input: overLengthName })

    const target = store.setter(commitNameBoxAtom, {
      input: overLengthName,
      sessionId,
    })

    expect(target).toEqual({ kind: 'invalid', reason: 'unrecognized' })
    expect(store.getter(nameBoxStateAtom)).toMatchObject({
      input: 'B2',
      display: 'B2',
      error: true,
      mode: 'idle',
      sessionId,
    })
  })

  test('events from an older session cannot overwrite the current input', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    const oldSessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, { sessionId: oldSessionId, input: 'OldDraft' })
    const currentSessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, {
      sessionId: currentSessionId,
      input: 'CurrentDraft',
    })

    expect(
      store.setter(updateNameBoxInputAtom, {
        sessionId: oldSessionId,
        input: 'StaleDraft',
      }),
    ).toBe(false)
    expect(store.setter(revertNameBoxAtom, { sessionId: oldSessionId })).toBe(false)
    expect(store.setter(blurNameBoxAtom, { sessionId: oldSessionId })).toBe(false)
    expect(
      store.setter(commitNameBoxAtom, {
        sessionId: oldSessionId,
        input: 'StaleDraft',
      }),
    ).toEqual({ kind: 'invalid', reason: 'stale-session' })
    expect(store.getter(nameBoxStateAtom)).toMatchObject({
      input: 'CurrentDraft',
      focused: true,
      mode: 'typing',
      sessionId: currentSessionId,
    })
  })
})

describe('NameBox define-name command', () => {
  test('dedupes Enter and blur intents and does not replace a newer draft', async () => {
    const store = createStore()
    let observedRequest: SetNamedRangeRequest | undefined
    let settleMutation: ((result: NamedRangeMutationResult) => void) | undefined
    const setNamedRange = jest.fn(
      (request: SetNamedRangeRequest) =>
        new Promise<NamedRangeMutationResult>((resolve) => {
          observedRequest = request
          settleMutation = resolve
        }),
    )
    const source: NamedRangeControllerPort = {
      readNamedRangeCapabilities: async () => CAPABILITIES,
      setNamedRange,
      listNamedRanges: async (request) => ({
        requestId: request.requestId,
        names: [
          {
            name: 'BrandNew',
            scope: 'workbook',
            refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:E5' },
          },
        ],
        authority: 'static-session-registry',
        definitionReadback: 'full',
      }),
    }
    store.setter(loadNamedRangeCapabilitiesAtom, { source })
    await flushMicrotasks()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 2 },
      focus: { row: 4, col: 4 },
    })
    const oldSessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, { sessionId: oldSessionId, input: 'BrandNew' })

    const first = store.setter(commitNameBoxAtom, {
      source,
      sessionId: oldSessionId,
      input: 'BrandNew',
    })
    const firstMutationState = store.getter(namedRangeMutationStateAtom)

    expect(first).toMatchObject({
      kind: 'define-name',
      sheetId: 'sheet-1',
      name: 'BrandNew',
      range: { rowStart: 2, rowEnd: 4, colStart: 2, colEnd: 4 },
    })
    expect(store.getter(nameBoxStateAtom)).toMatchObject({
      input: 'BrandNew',
      error: false,
      focused: true,
      mode: 'idle',
      sessionId: oldSessionId,
    })
    expect(firstMutationState).toMatchObject({
      status: 'pending',
      origin: 'name-box',
      sessionId: oldSessionId,
      action: 'set',
    })
    expect(firstMutationState.requestId).toEqual(expect.any(Number))
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(1)
    expect(setNamedRange).not.toHaveBeenCalled()

    const duplicate = store.setter(commitNameBoxAtom, {
      source,
      sessionId: oldSessionId,
      input: 'BrandNew',
    })
    expect(store.setter(blurNameBoxAtom, { sessionId: oldSessionId })).toBe(true)

    expect(first.kind).toBe('define-name')
    expect(duplicate.kind).toBe('define-name')
    expect(store.getter(namedRangeMutationStateAtom)).toBe(firstMutationState)
    expect(store.getter(namedRangeOperationAttemptLedgerAtom)).toHaveLength(1)
    expect(setNamedRange).not.toHaveBeenCalled()

    const currentSessionId = store.setter(focusNameBoxAtom)
    store.setter(updateNameBoxInputAtom, {
      sessionId: currentSessionId,
      input: 'CurrentDraft',
    })
    await Promise.resolve()

    expect(setNamedRange).toHaveBeenCalledTimes(1)
    expect(observedRequest).toMatchObject({
      kind: 'set-named-range',
      name: 'BrandNew',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:E5' },
    })
    expect(observedRequest?.requestId).toEqual(expect.any(Number))
    settleMutation?.({
      requestId: observedRequest?.requestId,
      outcome: 'w0-acknowledged',
      authority: 'static-session-registry',
    })
    await flushMicrotasks()

    expect(store.getter(nameBoxStateAtom)).toMatchObject({
      input: 'CurrentDraft',
      focused: true,
      mode: 'typing',
      sessionId: currentSessionId,
    })
  })
})
