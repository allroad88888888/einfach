import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DATA_VALIDATION_MUTATION_LEDGER_MAX,
  DEFAULT_VALIDATION_RULE_FORM_STATE,
  closeValidationRuleEditorAtom,
  dataValidationMutationBlockedAtom,
  dataValidationOperationAttemptLedgerAtom,
  evaluateValidationLocal,
  nextDataValidationSessionId,
  openValidationRuleEditorAtom,
  runDataValidationMutationAtom,
  validationRuleEditorAtom,
  validationRuleFormAtom,
  validationRuleFormRuleAtom,
  validationStatusAtom,
  updateValidationRuleFormAtom,
  type DisplayCell,
  type DataValidationMutationAcknowledgement,
  type DataValidationOperationAttempt,
  type ClearValidationRuleRequest,
  type SetValidationRuleRequest,
  type ValidationListRule,
  type ValidationOutcome,
  type ValidationRangeRule,
  type ValidationRegexRule,
  type ValidationFormulaRule,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  workspaceSessionAtom,
} from '../src'
import { startEditingAtom } from '../src/editing'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('data-validation', () => {
  test('initial editor state is closed', () => {
    const store = createStore()
    expect(store.getter(validationRuleEditorAtom)).toEqual({
      status: 'closed',
      sessionId: 0,
      requestId: null,
      targetSheetId: null,
      hasRuleDraft: false,
      form: DEFAULT_VALIDATION_RULE_FORM_STATE,
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom)).toEqual(DEFAULT_VALIDATION_RULE_FORM_STATE)
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
  })

  test('session identities cross the safe boundary once and exhaust without reuse', () => {
    expect(nextDataValidationSessionId(0)).toBe(1)
    expect(nextDataValidationSessionId(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(nextDataValidationSessionId(Number.MAX_SAFE_INTEGER)).toBe(-1)
    expect(nextDataValidationSessionId(-1)).toBe(-2)
    expect(nextDataValidationSessionId(Number.MIN_SAFE_INTEGER + 1)).toBe(Number.MIN_SAFE_INTEGER)
    expect(nextDataValidationSessionId(Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(nextDataValidationSessionId(Number.MIN_SAFE_INTEGER)).toBeNull()

    const sampledIdentities = [
      0,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      -1,
      -2,
      Number.MIN_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER,
    ]
    expect(sampledIdentities.every(Number.isSafeInteger)).toBe(true)
    expect(new Set(sampledIdentities).size).toBe(sampledIdentities.length)

    expect(nextDataValidationSessionId(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
    expect(nextDataValidationSessionId(Number.MIN_SAFE_INTEGER - 1)).toBeNull()
    expect(nextDataValidationSessionId(Number.NaN)).toBeNull()
    expect(nextDataValidationSessionId(Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('real editor lifecycle commands reserve distinct safe identities per store', () => {
    const firstStore = createStore()
    const secondStore = createStore()
    const firstStoreSessionIds = [firstStore.getter(validationRuleEditorAtom).sessionId]

    firstStore.setter(openValidationRuleEditorAtom, {})
    firstStoreSessionIds.push(firstStore.getter(validationRuleEditorAtom).sessionId)
    firstStore.setter(closeValidationRuleEditorAtom)
    firstStoreSessionIds.push(firstStore.getter(validationRuleEditorAtom).sessionId)
    firstStore.setter(openValidationRuleEditorAtom, {})
    firstStoreSessionIds.push(firstStore.getter(validationRuleEditorAtom).sessionId)

    secondStore.setter(openValidationRuleEditorAtom, {})

    expect(firstStoreSessionIds).toEqual([0, 1, 2, 3])
    expect(firstStoreSessionIds.every(Number.isSafeInteger)).toBe(true)
    expect(new Set(firstStoreSessionIds).size).toBe(firstStoreSessionIds.length)
    expect(secondStore.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 1,
    })
  })

  test('openValidationRuleEditorAtom sets editor with range, draft, and mode', () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 2 }
    const draft: ValidationListRule = { kind: 'list', values: ['a', 'b', 'c'], dropdown: true }
    store.setter(openValidationRuleEditorAtom, { range, draft, mode: 'reject' })
    expect(store.getter(validationRuleEditorAtom)).toEqual({
      status: 'editing',
      sessionId: 1,
      requestId: null,
      targetSheetId: null,
      range,
      hasRuleDraft: true,
      form: {
        ...DEFAULT_VALIDATION_RULE_FORM_STATE,
        kind: 'list',
        mode: 'reject',
        listValues: 'a, b, c',
      },
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom)).toEqual({
      ...DEFAULT_VALIDATION_RULE_FORM_STATE,
      kind: 'list',
      mode: 'reject',
      listValues: 'a, b, c',
    })
  })

  test('opening snapshots caller-owned range and draft values', () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 }
    const values = ['original']
    const draft: ValidationListRule = { kind: 'list', values, dropdown: true }

    store.setter(openValidationRuleEditorAtom, { range, draft })
    range.rowStart = 99
    values[0] = 'mutated'
    draft.dropdown = false

    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      form: { listValues: 'original', listDropdown: true },
    })
  })

  test('closeValidationRuleEditorAtom resets to closed', () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 2 }
    const draft: ValidationListRule = { kind: 'list', values: ['x'], dropdown: false }
    store.setter(openValidationRuleEditorAtom, { range, draft, mode: 'warn' })
    store.setter(updateValidationRuleFormAtom, { listValues: 'changed' })
    store.setter(closeValidationRuleEditorAtom)
    expect(store.getter(validationRuleEditorAtom)).toEqual({
      status: 'closed',
      sessionId: 2,
      requestId: null,
      targetSheetId: null,
      hasRuleDraft: false,
      form: DEFAULT_VALIDATION_RULE_FORM_STATE,
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom)).toEqual(DEFAULT_VALIDATION_RULE_FORM_STATE)
  })

  test('opening an already-open editor retargets and rebuilds the form', () => {
    const store = createStore()
    const firstRange = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const secondRange = { rowStart: 4, rowEnd: 6, colStart: 2, colEnd: 3 }
    store.setter(openValidationRuleEditorAtom, { range: firstRange })
    store.setter(updateValidationRuleFormAtom, { listValues: 'keep' })

    store.setter(openValidationRuleEditorAtom, {
      range: secondRange,
      draft: { kind: 'list', values: ['replacement'], dropdown: true },
      mode: 'reject',
    })

    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 2,
      requestId: null,
      targetSheetId: null,
      range: secondRange,
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom)).toEqual({
      ...DEFAULT_VALIDATION_RULE_FORM_STATE,
      kind: 'list',
      mode: 'reject',
      listValues: 'replacement',
    })
  })

  test('validation rule form derives list, range, regex, and formula rules', () => {
    const store = createStore()
    store.setter(openValidationRuleEditorAtom, {})

    store.setter(updateValidationRuleFormAtom, {
      listValues: ' alpha, , beta ',
      listDropdown: false,
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'list',
      values: ['alpha', 'beta'],
      dropdown: false,
    })

    store.setter(updateValidationRuleFormAtom, {
      kind: 'range',
      rangeMin: '2',
      rangeMax: '',
      rangeIntegerOnly: true,
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'range',
      min: 2,
      max: undefined,
      integerOnly: true,
    })

    store.setter(updateValidationRuleFormAtom, {
      kind: 'regex',
      regexPattern: '^ok$',
      regexFlags: 'i',
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'regex',
      pattern: '^ok$',
      flags: 'i',
    })

    store.setter(updateValidationRuleFormAtom, {
      kind: 'formula',
      formulaText: '=A1>0',
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'formula',
      formula: '=A1>0',
    })
  })

  test('opening preserves rule semantics that the dialog does not render', () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

    store.setter(openValidationRuleEditorAtom, {
      range,
      draft: { kind: 'range', min: 1, max: 3, integerOnly: true },
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'range',
      min: 1,
      max: 3,
      integerOnly: true,
    })

    store.setter(openValidationRuleEditorAtom, {
      range,
      draft: { kind: 'regex', pattern: '^ok$', flags: 'i' },
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'regex',
      pattern: '^ok$',
      flags: 'i',
    })

    store.setter(openValidationRuleEditorAtom, {
      range,
      draft: { kind: 'list', values: ['x'], dropdown: false },
    })
    expect(store.getter(validationRuleFormRuleAtom)).toEqual({
      kind: 'list',
      values: ['x'],
      dropdown: false,
    })
  })

  test('validation rule form state is isolated between stores', () => {
    const firstStore = createStore()
    const secondStore = createStore()
    firstStore.setter(openValidationRuleEditorAtom, {})
    firstStore.setter(updateValidationRuleFormAtom, { formulaText: '=A1' })

    expect(firstStore.getter(validationRuleFormAtom).formulaText).toBe('=A1')
    expect(secondStore.getter(validationRuleFormAtom)).toEqual(DEFAULT_VALIDATION_RULE_FORM_STATE)
  })

  test('save snapshots the core form, acknowledges the result, and closes', async () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 3, colStart: 2, colEnd: 4 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 'revision-2',
      affectedRange: request.range,
    }))
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(openValidationRuleEditorAtom, { range })
    store.setter(updateValidationRuleFormAtom, {
      kind: 'range',
      mode: 'reject',
      rangeMin: '10',
      rangeMax: '20',
    })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
      acceptAcknowledgedResult,
    })

    expect(setRule).toHaveBeenCalledWith({
      kind: 'set-validation-rule',
      sheetId: 'sheet-1',
      range,
      rule: { kind: 'range', min: 10, max: 20 },
      mode: 'reject',
      requestId: 1,
    })
    expect(acceptAcknowledgedResult).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 'revision-2',
      affectedRange: range,
    })
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toMatchObject([
      {
        operationId: 'data-validation-1',
        requestId: 1,
        sessionId: 1,
        action: 'save',
        sheetId: 'sheet-1',
        range,
        baseRevision: null,
        status: 'acknowledged',
        resultRevision: 'revision-2',
      },
    ])
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'closed',
      sessionId: 2,
      pending: false,
      error: null,
    })
  })

  test('publishes one consistent pending editor and ledger snapshot before deferred transport settles', async () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const setRule = jest.fn(() => backend.promise)
    const snapshots: Array<{
      source: 'editor' | 'ledger'
      editorPending: boolean
      editorRequestId: number | null
      attemptRequestId: number | undefined
      attemptStatus: DataValidationOperationAttempt['status'] | undefined
    }> = []
    const recordSnapshot = (source: 'editor' | 'ledger') => {
      const editor = store.getter(validationRuleEditorAtom)
      const attempt = store.getter(dataValidationOperationAttemptLedgerAtom).at(-1)
      snapshots.push({
        source,
        editorPending: editor.pending,
        editorRequestId: editor.requestId,
        attemptRequestId: attempt?.requestId,
        attemptStatus: attempt?.status,
      })
    }
    const unsubscribeEditor = store.sub(validationRuleEditorAtom, () => recordSnapshot('editor'))
    const unsubscribeLedger = store.sub(dataValidationOperationAttemptLedgerAtom, () =>
      recordSnapshot('ledger'),
    )
    store.setter(openValidationRuleEditorAtom, { range })
    snapshots.length = 0

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
    })

    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      requestId: 1,
      pending: true,
    })
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toMatchObject([
      { requestId: 1, status: 'pending' },
    ])
    await Promise.resolve()

    expect(setRule).toHaveBeenCalledTimes(1)
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snapshots.some(({ source }) => source === 'editor')).toBe(true)
    expect(snapshots.some(({ source }) => source === 'ledger')).toBe(true)
    expect(snapshots).toEqual(
      snapshots.map((snapshot) => ({
        ...snapshot,
        editorPending: true,
        editorRequestId: 1,
        attemptRequestId: 1,
        attemptStatus: 'pending',
      })),
    )

    backend.resolve({
      sheetId: 'sheet-1',
      requestId: 1,
      affectedRange: range,
    })
    await pending
    unsubscribeEditor()
    unsubscribeLedger()
  })

  test('same-tick duplicate mutation commands dispatch transport only once', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const setRule = jest.fn(() => backend.promise)
    store.setter(openValidationRuleEditorAtom, { range })

    const first = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
    })
    const duplicate = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
    })
    await Promise.resolve()

    expect(setRule).toHaveBeenCalledTimes(1)
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toMatchObject([
      { requestId: 1, status: 'pending' },
    ])

    backend.resolve({
      sheetId: 'sheet-1',
      requestId: 1,
      affectedRange: range,
    })
    await Promise.all([first, duplicate])
    expect(setRule).toHaveBeenCalledTimes(1)
  })

  test('an explicit sheet target remains independent of fallback authority rotations', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'workspace-b' })
      store.setter(selectionAtom, {
        kind: 'cell',
        sheetId: 'selection-b',
        anchor: { row: 1, col: 1 },
        focus: { row: 1, col: 1 },
      })
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: request.range,
      }
    })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'workspace-a' })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'selection-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-explicit',
      setRule,
      acceptAcknowledgedResult,
    })

    expect(setRule).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: 'sheet-explicit', requestId: 1 }),
    )
    expect(acceptAcknowledgedResult).toHaveBeenCalledTimes(1)
    expect(store.getter(validationRuleEditorAtom).status).toBe('closed')
  })

  test('workspace fallback rejects an A to B to A authority rotation before transport', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, { action: 'save', setRule })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-b' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 1,
      requestId: 1,
      pending: false,
      error: 'Data validation target changed before transport dispatch',
    })
  })

  test('workspace fallback survives a public snapshot replacement that preserves target authority', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, { action: 'save', setRule })
    store.setter(workspaceSessionAtom, (current) => ({
      ...current,
      viewportRevision: current.viewportRevision + 1,
    }))
    await pending

    expect(setRule).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: 'sheet-a', requestId: 1 }),
    )
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0].status).toBe('acknowledged')
    expect(store.getter(validationRuleEditorAtom).status).toBe('closed')
  })

  test('selection fallback rejects an A to B to A authority rotation before transport', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, { action: 'save', setRule })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-b',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 1,
      requestId: 1,
      pending: false,
      error: 'Data validation target changed before transport dispatch',
    })
  })

  test('activating workspace authority revokes a captured selection fallback before transport', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-selection',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, { action: 'save', setRule })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-workspace' })
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      requestId: 1,
      pending: false,
      error: 'Data validation target changed before transport dispatch',
    })
  })

  test('a session opened in the pending flush window prevents stale transport', async () => {
    const store = createStore()
    const firstRange = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const secondRange = { rowStart: 5, rowEnd: 5, colStart: 5, colEnd: 5 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(openValidationRuleEditorAtom, { range: firstRange })

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
    })
    store.setter(openValidationRuleEditorAtom, {
      range: secondRange,
      draft: { kind: 'list', values: ['new'], dropdown: true },
    })
    await pending

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 2,
      range: secondRange,
      form: { kind: 'list', listValues: 'new' },
      requestId: null,
      pending: false,
      error: null,
    })
  })

  test('workspace A to B to A rotation after transport blocks stale reconciliation', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule: async (request) => {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-b' })
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          affectedRange: request.range,
        }
      },
      acceptAcknowledgedResult,
    })

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      sheetId: 'sheet-a',
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 1,
      requestId: 1,
      pending: true,
    })
  })

  test('reconciliation callback cannot close a newer editor session', async () => {
    const store = createStore()
    const firstRange = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const secondRange = { rowStart: 4, rowEnd: 4, colStart: 8, colEnd: 8 }
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-fallback' })
    store.setter(openValidationRuleEditorAtom, { range: firstRange })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule: async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: request.range,
      }),
      acceptAcknowledgedResult: async () => {
        store.setter(openValidationRuleEditorAtom, {
          range: secondRange,
          draft: { kind: 'regex', pattern: '^new$' },
        })
      },
    })

    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0].status).toBe('acknowledged')
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 2,
      range: secondRange,
      form: { kind: 'regex', regexPattern: '^new$' },
      requestId: null,
      pending: false,
      error: null,
    })
  })

  test('workspace authority rotation after transport blocks stale reconciliation', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule: async (request) => {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-b' })
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          affectedRange: request.range,
        }
      },
      acceptAcknowledgedResult,
    })

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      sheetId: 'sheet-a',
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      requestId: 1,
      pending: true,
    })
  })

  test('selection authority rotation after transport blocks stale reconciliation', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule: async (request) => {
        store.setter(selectionAtom, {
          kind: 'cell',
          sheetId: 'sheet-b',
          anchor: { row: 1, col: 1 },
          focus: { row: 1, col: 1 },
        })
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          affectedRange: request.range,
        }
      },
      acceptAcknowledgedResult,
    })

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      sheetId: 'sheet-a',
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      requestId: 1,
      pending: true,
    })
  })

  test('workspace A to B to A before rejection settles only the ledger', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const setRule = jest.fn(() => backend.promise)
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule,
      acceptAcknowledgedResult,
    })
    await Promise.resolve()

    expect(setRule).toHaveBeenCalledTimes(1)
    const pendingEditor = store.getter(validationRuleEditorAtom)
    expect(pendingEditor).toMatchObject({
      status: 'editing',
      sessionId: 1,
      requestId: 1,
      targetSheetId: 'sheet-a',
      pending: true,
      error: null,
    })
    let editorSettlementEmissions = 0
    const ledgerSettlementSnapshots: Array<{
      editor: typeof pendingEditor
      editorEmissions: number
      status: DataValidationOperationAttempt['status']
    }> = []
    const unsubscribeEditor = store.sub(validationRuleEditorAtom, () => {
      editorSettlementEmissions += 1
    })
    const unsubscribeLedger = store.sub(dataValidationOperationAttemptLedgerAtom, () => {
      const attempt = store.getter(dataValidationOperationAttemptLedgerAtom).at(-1)
      if (attempt?.status === 'outcome-unknown') {
        ledgerSettlementSnapshots.push({
          editor: store.getter(validationRuleEditorAtom),
          editorEmissions: editorSettlementEmissions,
          status: attempt.status,
        })
      }
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-b' })
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    backend.reject(new Error('transport outcome unknown'))
    await pending
    unsubscribeEditor()
    unsubscribeLedger()

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      sheetId: 'sheet-a',
      error: 'transport outcome unknown',
    })
    expect(ledgerSettlementSnapshots).toHaveLength(1)
    const ledgerSettlement = ledgerSettlementSnapshots[0]!
    expect(ledgerSettlement.status).toBe('outcome-unknown')
    expect(ledgerSettlement.editor).toBe(pendingEditor)
    expect(ledgerSettlement.editor.pending).toBe(true)
    expect(ledgerSettlement.editor.error).toBeNull()
    expect(ledgerSettlement.editorEmissions).toBe(0)
    expect(store.getter(validationRuleEditorAtom)).toBe(pendingEditor)
    expect(editorSettlementEmissions).toBe(0)
    // Data-validation mutations expose no list callback, so that frozen proof is N/A.
  })

  test('selection A to B to A before invalid acknowledgement settles only the ledger', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const setRule = jest.fn(() => backend.promise)
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(openValidationRuleEditorAtom, { range })

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      setRule,
      acceptAcknowledgedResult,
    })
    await Promise.resolve()

    expect(setRule).toHaveBeenCalledTimes(1)
    const pendingEditor = store.getter(validationRuleEditorAtom)
    expect(pendingEditor).toMatchObject({
      status: 'editing',
      sessionId: 1,
      requestId: 1,
      targetSheetId: 'sheet-a',
      pending: true,
      error: null,
    })
    let editorSettlementEmissions = 0
    const ledgerSettlementSnapshots: Array<{
      editor: typeof pendingEditor
      editorEmissions: number
      status: DataValidationOperationAttempt['status']
    }> = []
    const unsubscribeEditor = store.sub(validationRuleEditorAtom, () => {
      editorSettlementEmissions += 1
    })
    const unsubscribeLedger = store.sub(dataValidationOperationAttemptLedgerAtom, () => {
      const attempt = store.getter(dataValidationOperationAttemptLedgerAtom).at(-1)
      if (attempt?.status === 'outcome-unknown') {
        ledgerSettlementSnapshots.push({
          editor: store.getter(validationRuleEditorAtom),
          editorEmissions: editorSettlementEmissions,
          status: attempt.status,
        })
      }
    })

    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-b',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-a',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    backend.resolve({
      sheetId: 'sheet-other',
      requestId: 1,
      affectedRange: range,
    })
    await pending
    unsubscribeEditor()
    unsubscribeLedger()

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      sheetId: 'sheet-a',
      error: 'Data validation acknowledgement targeted a different sheet',
    })
    expect(ledgerSettlementSnapshots).toHaveLength(1)
    const ledgerSettlement = ledgerSettlementSnapshots[0]!
    expect(ledgerSettlement.status).toBe('outcome-unknown')
    expect(ledgerSettlement.editor).toBe(pendingEditor)
    expect(ledgerSettlement.editor.pending).toBe(true)
    expect(ledgerSettlement.editor.error).toBeNull()
    expect(ledgerSettlement.editorEmissions).toBe(0)
    expect(store.getter(validationRuleEditorAtom)).toBe(pendingEditor)
    expect(editorSettlementEmissions).toBe(0)
    // Data-validation mutations expose no list callback, so that frozen proof is N/A.
  })

  test.each([
    {
      name: 'synchronous transport throw',
      run: (_request: SetValidationRuleRequest): Promise<DataValidationMutationAcknowledgement> => {
        throw new Error('synchronous transport failure')
      },
      finalStatus: 'outcome-unknown' as const,
    },
    {
      name: 'immediately fulfilled transport',
      run: (request: SetValidationRuleRequest) =>
        Promise.resolve({
          sheetId: request.sheetId,
          requestId: request.requestId,
          affectedRange: request.range,
        }),
      finalStatus: 'acknowledged' as const,
    },
  ])('publishes pending before $name settles', async ({ run, finalStatus }) => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const snapshots: Array<{
      editorPending: boolean
      attemptStatus: DataValidationOperationAttempt['status'] | undefined
    }> = []
    const recordSnapshot = () => {
      snapshots.push({
        editorPending: store.getter(validationRuleEditorAtom).pending,
        attemptStatus: store.getter(dataValidationOperationAttemptLedgerAtom).at(-1)?.status,
      })
    }
    const unsubscribeEditor = store.sub(validationRuleEditorAtom, recordSnapshot)
    const unsubscribeLedger = store.sub(dataValidationOperationAttemptLedgerAtom, recordSnapshot)
    store.setter(openValidationRuleEditorAtom, { range })
    snapshots.length = 0

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule: run,
    })

    const pendingIndex = snapshots.findIndex(
      ({ editorPending, attemptStatus }) => editorPending && attemptStatus === 'pending',
    )
    const settledIndex = snapshots.findIndex(({ attemptStatus }) => attemptStatus === finalStatus)
    expect(pendingIndex).toBeGreaterThanOrEqual(0)
    expect(settledIndex).toBeGreaterThan(pendingIndex)
    unsubscribeEditor()
    unsubscribeLedger()
  })

  test('clear dispatches a core-owned range snapshot', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 5, colStart: 1, colEnd: 1 }
    const clearRule = jest.fn(async (request: ClearValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: 'sheet-2',
      clearRule,
    })

    expect(clearRule).toHaveBeenCalledWith({
      kind: 'clear-validation-rule',
      sheetId: 'sheet-2',
      range,
      requestId: 1,
    })
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      action: 'clear',
      sheetId: 'sheet-2',
      range,
      status: 'acknowledged',
    })
    expect(store.getter(validationRuleEditorAtom).status).toBe('closed')
  })

  test('late acknowledgement settles the journal without polluting a reopened target', async () => {
    const store = createStore()
    const firstRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const secondRange = { rowStart: 8, rowEnd: 9, colStart: 3, colEnd: 4 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(openValidationRuleEditorAtom, {
      range: firstRange,
      draft: { kind: 'list', values: ['old'], dropdown: true },
    })

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-a',
      setRule: () => backend.promise,
      acceptAcknowledgedResult,
    })
    await Promise.resolve()
    const pendingSessionId = store.getter(validationRuleEditorAtom).sessionId
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      sessionId: 1,
      requestId: 1,
      targetSheetId: 'sheet-a',
      pending: true,
    })
    store.setter(updateValidationRuleFormAtom, { listValues: 'ignored while pending' })
    expect(store.getter(validationRuleFormAtom).listValues).toBe('old')

    store.setter(closeValidationRuleEditorAtom)
    store.setter(openValidationRuleEditorAtom, {
      range: secondRange,
      draft: { kind: 'list', values: ['new'], dropdown: true },
      mode: 'reject',
    })
    const reopenedSessionId = store.getter(validationRuleEditorAtom).sessionId
    expect(Number.isSafeInteger(pendingSessionId)).toBe(true)
    expect(Number.isSafeInteger(reopenedSessionId)).toBe(true)
    expect(reopenedSessionId).not.toBe(pendingSessionId)
    backend.resolve({
      sheetId: 'sheet-a',
      requestId: 1,
      revision: 5,
      affectedRange: firstRange,
    })
    await pending

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      resultRevision: 5,
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: reopenedSessionId,
      requestId: null,
      targetSheetId: null,
      range: secondRange,
      form: {
        kind: 'list',
        mode: 'reject',
        listValues: 'new',
      },
      pending: false,
      error: null,
    })
  })

  test('late clear acknowledgement cannot close or overwrite a reopened target', async () => {
    const store = createStore()
    const firstRange = { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 }
    const secondRange = { rowStart: 12, rowEnd: 13, colStart: 5, colEnd: 6 }
    const backend = deferred<DataValidationMutationAcknowledgement>()
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    let dispatchedRequest: ClearValidationRuleRequest | undefined
    store.setter(openValidationRuleEditorAtom, {
      range: firstRange,
      draft: { kind: 'list', values: ['old'], dropdown: true },
    })

    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: 'sheet-a',
      clearRule: (request) => {
        dispatchedRequest = request
        return backend.promise
      },
      acceptAcknowledgedResult,
    })
    await Promise.resolve()
    expect(dispatchedRequest).toBeDefined()

    store.setter(closeValidationRuleEditorAtom)
    store.setter(openValidationRuleEditorAtom, {
      range: secondRange,
      draft: { kind: 'regex', pattern: '^new$' },
      mode: 'reject',
    })
    const reopenedSessionId = store.getter(validationRuleEditorAtom).sessionId
    backend.resolve({
      sheetId: dispatchedRequest!.sheetId,
      requestId: dispatchedRequest!.requestId!,
      revision: 6,
      affectedRange: dispatchedRequest!.range,
    })
    await pending

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      action: 'clear',
      status: 'acknowledged',
      resultRevision: 6,
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: reopenedSessionId,
      requestId: null,
      targetSheetId: null,
      range: secondRange,
      form: {
        kind: 'regex',
        mode: 'reject',
        regexPattern: '^new$',
      },
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom).regexPattern).toBe('^new$')
  })

  test('late rejection becomes outcome-unknown without polluting a retargeted editor', async () => {
    const store = createStore()
    const backend = deferred<DataValidationMutationAcknowledgement>()
    store.setter(openValidationRuleEditorAtom, {
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })
    const pending = store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-a',
      setRule: () => backend.promise,
    })
    await Promise.resolve()

    const nextRange = { rowStart: 10, rowEnd: 10, colStart: 2, colEnd: 2 }
    store.setter(openValidationRuleEditorAtom, {
      range: nextRange,
      draft: { kind: 'regex', pattern: '^new$' },
    })
    backend.reject(new Error('transport outcome unknown'))
    await pending

    expect(store.getter(dataValidationMutationBlockedAtom)).toBe(true)
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error: 'transport outcome unknown',
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      sessionId: 2,
      range: nextRange,
      form: { kind: 'regex', regexPattern: '^new$' },
      pending: false,
      error: null,
    })
  })

  test.each([
    {
      name: 'missing sheet id',
      response: (request: SetValidationRuleRequest) => ({ requestId: request.requestId }),
      error: 'Data validation acknowledgement targeted a different sheet',
    },
    {
      name: 'mismatched sheet id',
      response: (request: SetValidationRuleRequest) => ({
        sheetId: 'sheet-other',
        requestId: request.requestId,
      }),
      error: 'Data validation acknowledgement targeted a different sheet',
    },
    {
      name: 'missing request id',
      response: (request: SetValidationRuleRequest) => ({ sheetId: request.sheetId }),
      error: 'Data validation acknowledgement returned a different request id',
    },
    {
      name: 'mismatched request id',
      response: (request: SetValidationRuleRequest) => ({
        sheetId: request.sheetId,
        requestId: (request.requestId ?? 0) + 1,
      }),
      error: 'Data validation acknowledgement returned a different request id',
    },
  ])('$name acknowledgement becomes outcome-unknown', async ({ response, error }) => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(openValidationRuleEditorAtom, { range })

    await expect(
      store.setter(runDataValidationMutationAtom, {
        action: 'save',
        sheetId: 'sheet-1',
        setRule: async (request) => response(request),
        acceptAcknowledgedResult,
      }),
    ).resolves.toBeUndefined()

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationMutationBlockedAtom)).toBe(true)
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error,
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      pending: false,
      error,
    })
  })

  test('mismatched acknowledgement range becomes outcome-unknown', async () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const acceptAcknowledgedResult = jest.fn(async () => undefined)
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule: async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: { rowStart: 5, rowEnd: 5, colStart: 5, colEnd: 5 },
      }),
      acceptAcknowledgedResult,
    })

    expect(acceptAcknowledgedResult).not.toHaveBeenCalled()
    expect(store.getter(dataValidationMutationBlockedAtom)).toBe(true)
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'outcome-unknown',
      error: 'Data validation acknowledgement targeted a different range',
    })
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      pending: false,
      error: 'Data validation acknowledgement targeted a different range',
    })
  })

  test('transport and acknowledgement objects are snapshotted away from core authority', async () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 }
    const getterReads = { sheetId: 0, requestId: 0, affectedRange: 0, revision: 0 }
    const acceptAcknowledgedResult = jest.fn(
      async (acknowledgement: DataValidationMutationAcknowledgement) => {
        expect(Object.isFrozen(acknowledgement)).toBe(true)
        expect(Object.isFrozen(acknowledgement.affectedRange)).toBe(true)
        expect(Reflect.set(acknowledgement.affectedRange!, 'rowStart', 99)).toBe(false)
      },
    )
    store.setter(openValidationRuleEditorAtom, {
      range,
      draft: { kind: 'list', values: ['kept'], dropdown: true },
    })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule: async (request) => {
        const requestId = request.requestId
        request.range.rowStart = 99
        if (request.rule.kind === 'list') request.rule.values.push('transport-mutation')
        return Object.defineProperties(
          {},
          {
            sheetId: {
              get: () => {
                getterReads.sheetId += 1
                return 'sheet-1'
              },
            },
            requestId: {
              get: () => {
                getterReads.requestId += 1
                return requestId
              },
            },
            affectedRange: {
              get: () => {
                getterReads.affectedRange += 1
                return range
              },
            },
            revision: {
              get: () => {
                getterReads.revision += 1
                return 'revision-snapshot'
              },
            },
          },
        )
      },
      acceptAcknowledgedResult,
    })

    expect(getterReads).toEqual({ sheetId: 1, requestId: 1, affectedRange: 1, revision: 1 })
    expect(acceptAcknowledgedResult).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      requestId: 1,
      affectedRange: range,
      revision: 'revision-snapshot',
    })
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0]).toMatchObject({
      status: 'acknowledged',
      range,
      resultRevision: 'revision-snapshot',
    })
  })

  test('acknowledgement acceptance failure keeps the current editor open', async () => {
    const store = createStore()
    const range = { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 }
    store.setter(openValidationRuleEditorAtom, { range })

    await store.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: 'sheet-1',
      clearRule: async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      }),
      acceptAcknowledgedResult: async () => {
        throw new Error('projection refresh failed')
      },
    })

    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0].status).toBe('acknowledged')
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      pending: false,
      error: 'Mutation acknowledged; result acceptance failed: projection refresh failed',
    })
  })

  test('an outcome-unknown attempt blocks later commands before reading input or dispatching', async () => {
    const store = createStore()
    const firstRange = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const secondRange = { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 }
    store.setter(openValidationRuleEditorAtom, { range: firstRange })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule: async () => {
        throw new Error('outcome is unknown')
      },
    })

    const ledgerBeforeBlockedCommand = store.getter(dataValidationOperationAttemptLedgerAtom)
    expect(ledgerBeforeBlockedCommand).toMatchObject([
      { requestId: 1, status: 'outcome-unknown', error: 'outcome is unknown' },
    ])

    store.setter(openValidationRuleEditorAtom, { range: secondRange })
    const backend = jest.fn(async () => ({ sheetId: 'sheet-1', requestId: 2 }))
    let callerPropertyReads = 0
    const blockedInput = Object.defineProperties(
      {},
      {
        action: {
          get: () => {
            callerPropertyReads += 1
            return 'save'
          },
        },
        sheetId: {
          get: () => {
            callerPropertyReads += 1
            return 'sheet-1'
          },
        },
        setRule: {
          get: () => {
            callerPropertyReads += 1
            return backend
          },
        },
      },
    )

    await store.setter(runDataValidationMutationAtom, blockedInput as never)

    expect(callerPropertyReads).toBe(0)
    expect(backend).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toBe(ledgerBeforeBlockedCommand)
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      range: secondRange,
      pending: false,
      error: 'Data validation is blocked by an operation with an unknown outcome',
    })
  })

  test('bounded journal evicts only the oldest acknowledged attempts', async () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 }
    const setRule = jest.fn(async (request: SetValidationRuleRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))

    for (let index = 0; index < DATA_VALIDATION_MUTATION_LEDGER_MAX + 1; index += 1) {
      store.setter(openValidationRuleEditorAtom, { range })
      await store.setter(runDataValidationMutationAtom, {
        action: 'save',
        sheetId: 'sheet-1',
        setRule,
      })
    }

    const ledger = store.getter(dataValidationOperationAttemptLedgerAtom)
    expect(setRule).toHaveBeenCalledTimes(DATA_VALIDATION_MUTATION_LEDGER_MAX + 1)
    expect(ledger).toHaveLength(DATA_VALIDATION_MUTATION_LEDGER_MAX)
    expect(ledger.every((attempt) => attempt.status === 'acknowledged')).toBe(true)
    expect(ledger.map((attempt) => attempt.requestId)).toEqual(
      Array.from({ length: DATA_VALIDATION_MUTATION_LEDGER_MAX }, (_, index) => index + 2),
    )
    expect(new Set(ledger.map((attempt) => attempt.operationId)).size).toBe(
      DATA_VALIDATION_MUTATION_LEDGER_MAX,
    )
  })

  test('public editor, form, rule, and ledger atoms expose deeply frozen read-only snapshots', async () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 1, colStart: 2, colEnd: 2 }
    store.setter(openValidationRuleEditorAtom, {
      range,
      draft: { kind: 'list', values: ['kept'], dropdown: true },
    })

    const editor = store.getter(validationRuleEditorAtom)
    const form = store.getter(validationRuleFormAtom)
    const rule = store.getter(validationRuleFormRuleAtom) as ValidationListRule
    expect(Object.isFrozen(DEFAULT_VALIDATION_RULE_FORM_STATE)).toBe(true)
    expect(Object.isFrozen(editor)).toBe(true)
    expect(Object.isFrozen(editor.range)).toBe(true)
    expect(Object.isFrozen(editor.form)).toBe(true)
    expect(Object.isFrozen(form)).toBe(true)
    expect(Object.isFrozen(rule)).toBe(true)
    expect(Object.isFrozen(rule.values)).toBe(true)
    expect(Reflect.set(editor.form, 'listValues', 'mutated')).toBe(false)
    expect(Reflect.set(editor.range!, 'rowStart', 99)).toBe(false)
    expect(Reflect.set(rule.values, '0', 'mutated')).toBe(false)
    expect(store.getter(validationRuleFormAtom).listValues).toBe('kept')
    expect(store.getter(validationRuleEditorAtom).range).toEqual(range)

    const unsafeSet = store.setter as unknown as (target: unknown, value: unknown) => unknown
    expect(() => unsafeSet(validationRuleEditorAtom, editor)).toThrow()
    expect(() => unsafeSet(validationRuleFormAtom, form)).toThrow()

    await store.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: 'sheet-1',
      clearRule: async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: request.range,
      }),
    })

    const ledger = store.getter(dataValidationOperationAttemptLedgerAtom)
    expect(Object.isFrozen(ledger)).toBe(true)
    expect(Object.isFrozen(ledger[0])).toBe(true)
    expect(Object.isFrozen(ledger[0].range)).toBe(true)
    expect(Reflect.set(ledger[0].range, 'rowStart', 99)).toBe(false)
    expect(() => unsafeSet(dataValidationOperationAttemptLedgerAtom, [])).toThrow()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)[0].range).toEqual(range)
  })

  test('missing capability does not create an operation attempt', async () => {
    const store = createStore()
    store.setter(openValidationRuleEditorAtom, {
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
    })

    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom).error).toContain('unavailable')
  })

  test('missing range rejects before backend dispatch', async () => {
    const store = createStore()
    const setRule = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    store.setter(openValidationRuleEditorAtom, {})

    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: 'sheet-1',
      setRule,
    })

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom).error).toContain('target range')
  })

  test('missing sheet rejects before backend dispatch', async () => {
    const store = createStore()
    const setRule = jest.fn(async () => ({ sheetId: '' }))
    store.setter(openValidationRuleEditorAtom, {
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    await store.setter(runDataValidationMutationAtom, { action: 'save', setRule })

    expect(setRule).not.toHaveBeenCalled()
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
    expect(store.getter(validationRuleEditorAtom).error).toContain('active sheet')
  })

  test('operation attempt state is isolated between stores', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    firstStore.setter(openValidationRuleEditorAtom, {
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    await firstStore.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: 'sheet-1',
      clearRule: async (request) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
      }),
    })

    expect(firstStore.getter(dataValidationOperationAttemptLedgerAtom)).toHaveLength(1)
    expect(secondStore.getter(dataValidationOperationAttemptLedgerAtom)).toEqual([])
  })

  describe('evaluateValidationLocal — list rule', () => {
    const listRule: ValidationListRule = {
      kind: 'list',
      values: ['foo', 'bar', 'baz'],
      dropdown: false,
    }

    test('returns null when input is in values', () => {
      expect(evaluateValidationLocal(listRule, 'foo')).toBeNull()
    })

    test('returns outcome with list_mismatch when input is not in values', () => {
      const outcome = evaluateValidationLocal(listRule, 'qux')
      expect(outcome).not.toBeNull()
      expect(outcome?.code).toBe('validation.list_mismatch')
      expect(outcome?.severity).toBe('error')
    })
  })

  describe('evaluateValidationLocal — range rule', () => {
    test('returns null when value is within min/max', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      expect(evaluateValidationLocal(rule, '15')).toBeNull()
    })

    test('returns range_out_of_bounds when value is below min', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      const outcome = evaluateValidationLocal(rule, '5')
      expect(outcome?.code).toBe('validation.range_out_of_bounds')
    })

    test('returns range_out_of_bounds when value is above max', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      const outcome = evaluateValidationLocal(rule, '25')
      expect(outcome?.code).toBe('validation.range_out_of_bounds')
    })

    test('returns range_not_integer when integerOnly and value is a float', () => {
      const rule: ValidationRangeRule = { kind: 'range', integerOnly: true }
      const outcome = evaluateValidationLocal(rule, '1.5')
      expect(outcome?.code).toBe('validation.range_not_integer')
    })

    test('returns null when integerOnly and value is an integer', () => {
      const rule: ValidationRangeRule = { kind: 'range', integerOnly: true }
      expect(evaluateValidationLocal(rule, '3')).toBeNull()
    })
  })

  describe('evaluateValidationLocal — regex rule', () => {
    test('returns regex_mismatch when pattern does not match', () => {
      const rule: ValidationRegexRule = { kind: 'regex', pattern: '^\\d+$' }
      const outcome = evaluateValidationLocal(rule, 'abc')
      expect(outcome?.code).toBe('validation.regex_mismatch')
    })

    test('returns null when pattern matches', () => {
      const rule: ValidationRegexRule = { kind: 'regex', pattern: '^\\d+$' }
      expect(evaluateValidationLocal(rule, '123')).toBeNull()
    })

    test('returns regex_invalid instead of throwing for an invalid pattern', () => {
      const rule: ValidationRegexRule = { kind: 'regex', pattern: '[' }
      let outcome: ValidationOutcome | null = null

      expect(() => {
        outcome = evaluateValidationLocal(rule, 'anything')
      }).not.toThrow()
      expect(outcome).toMatchObject({
        code: 'validation.regex_invalid',
        severity: 'error',
      })
    })

    test('returns regex_invalid instead of throwing for invalid flags', () => {
      const rule: ValidationRegexRule = {
        kind: 'regex',
        pattern: '^ok$',
        flags: 'ii',
      }
      let outcome: ValidationOutcome | null = null

      expect(() => {
        outcome = evaluateValidationLocal(rule, 'ok')
      }).not.toThrow()
      expect(outcome).toMatchObject({
        code: 'validation.regex_invalid',
        severity: 'error',
      })
    })
  })

  describe('evaluateValidationLocal — formula rule', () => {
    test('returns null (deferred to backend)', () => {
      const rule: ValidationFormulaRule = { kind: 'formula', formula: '=ISNUMBER(A1)' }
      expect(evaluateValidationLocal(rule, 'anything')).toBeNull()
    })
  })

  describe('validationStatusAtom', () => {
    test('returns null when no editing session is active', () => {
      const store = createStore()
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('returns null when editor is closed during edit', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'hello',
        source: 'cell',
      })
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('returns null for a real range opened without a rule draft', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'anything',
        source: 'cell',
      })
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      })

      expect(store.getter(validationRuleEditorAtom).hasRuleDraft).toBe(false)
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('changing only mode does not attach the default empty list rule', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'anything',
        source: 'cell',
      })
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      })
      store.setter(updateValidationRuleFormAtom, { mode: 'reject' })

      expect(store.getter(validationRuleEditorAtom).hasRuleDraft).toBe(false)
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('editing a rule field attaches the live canonical form preview', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'invalid',
        source: 'cell',
      })
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      })
      store.setter(updateValidationRuleFormAtom, { listValues: 'valid' })

      expect(store.getter(validationRuleEditorAtom).hasRuleDraft).toBe(true)
      expect(store.getter(validationStatusAtom)?.code).toBe('validation.list_mismatch')
    })

    test('invalid live regex state returns an outcome and never throws', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'ok',
        source: 'cell',
      })
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        draft: { kind: 'regex', pattern: '^ok$', flags: 'ii' },
      })

      expect(() => store.getter(validationStatusAtom)).not.toThrow()
      expect(store.getter(validationStatusAtom)).toMatchObject({
        code: 'validation.regex_invalid',
        severity: 'error',
      })
    })

    test('returns outcome when editor has rule and draft mismatches', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'invalid',
        source: 'cell',
      })
      const draft: ValidationListRule = { kind: 'list', values: ['valid'], dropdown: false }
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        draft,
        mode: 'reject',
      })
      const outcome = store.getter(validationStatusAtom)
      expect(outcome).not.toBeNull()
      expect(outcome?.code).toBe('validation.list_mismatch')
    })

    test('returns null when draft matches list rule', () => {
      const store = createStore()
      store.setter(startEditingAtom, {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'valid',
        source: 'cell',
      })
      const draft: ValidationListRule = { kind: 'list', values: ['valid'], dropdown: false }
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        draft,
        mode: 'warn',
      })
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('rule attachment and live status stay isolated between stores', () => {
      const firstStore = createStore()
      const secondStore = createStore()
      const editInput = {
        sheetId: 's1',
        cell: { row: 0, col: 0 },
        draft: 'invalid',
        source: 'cell' as const,
      }
      const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

      firstStore.setter(startEditingAtom, editInput)
      secondStore.setter(startEditingAtom, editInput)
      firstStore.setter(openValidationRuleEditorAtom, { range })
      secondStore.setter(openValidationRuleEditorAtom, { range })
      firstStore.setter(updateValidationRuleFormAtom, { listValues: 'valid' })

      expect(firstStore.getter(validationRuleEditorAtom).hasRuleDraft).toBe(true)
      expect(firstStore.getter(validationStatusAtom)?.code).toBe('validation.list_mismatch')
      expect(secondStore.getter(validationRuleEditorAtom).hasRuleDraft).toBe(false)
      expect(secondStore.getter(validationStatusAtom)).toBeNull()
    })
  })

  test('DisplayCell with validation field typechecks', () => {
    const outcome: ValidationOutcome = {
      code: 'validation.list_mismatch',
      severity: 'error',
      message: 'bad value',
    }
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: 'x',
      validation: outcome,
    }
    expect(cell.validation?.code).toBe('validation.list_mismatch')
    expect(cell.validation?.severity).toBe('error')
    expect(cell.validation?.message).toBe('bad value')
  })
})
