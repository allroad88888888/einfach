/** @jsxImportSource solid-js */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
  allTablesAtom,
  deleteNameManagerEntryAtom,
  nameManagerDraftGenerationAtom,
  nameManagerEditorAtom,
  nameManagerNameDraftAtom,
  nameManagerRefersToDraftAtom,
  nameManagerScopeDraftAtom,
  nameManagerSelectedEntryAtom,
  nameManagerSessionIdAtom,
  namedRangeCapabilitiesAtom,
  namedRangeMutationBlockedAtom,
  namedRangeMutationStateAtom,
  namedRangeRegistryStateAtom,
  openNameManagerAtom,
  setSheetTabsSheetsAtom,
  type DeleteNamedRangeRequest,
  type DeleteTableRequest,
  type ListNamedRangesRequest,
  type ListTablesRequest,
  type ListTablesResult,
  type NamedRange,
  type NamedRangeBackendCapabilities,
  type NamedRangeControllerPort,
  type NamedRangeListResult,
  type NamedRangeMutationResult,
  type RenameTableRequest,
  type SetNamedRangeRequest,
  type SpreadsheetBackend,
  type SpreadsheetTableDescriptor,
  type TableMutationResult,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetNameManagerDialog } from '../src-vnext/named-ranges'
import { SpreadsheetUiProvider, type NamedRangeCapabilityPort } from '../src-vnext/provider'
import { setLocale } from '../src/i18n'

afterEach(cleanup)

beforeEach(() => {
  setLocale('en')
})

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

const SAMPLE_ENTRY: NamedRange = Object.freeze({
  name: 'MyRange',
  scope: 'workbook',
  refersTo: Object.freeze({ kind: 'range', sheetId: 'sheet-1', address: 'A1:B5' }),
})

const NEW_SESSION_ENTRY: NamedRange = Object.freeze({
  name: 'NewSession',
  scope: Object.freeze({ sheetId: 'sheet-2' }),
  refersTo: Object.freeze({ kind: 'range', sheetId: 'sheet-2', address: 'C3:D4' }),
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

type NamedRangeBackend = SpreadsheetBackend & NamedRangeControllerPort

function makeBackend(overrides: Partial<NamedRangeBackend> = {}): NamedRangeBackend {
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
    async readNamedRangeCapabilities() {
      return CAPABILITIES
    },
    async listNamedRanges(request) {
      return { requestId: request.requestId, revision: 1, names: [] }
    },
    ...overrides,
  }
}

function seedSheets(store: Store): void {
  store.setter(setSheetTabsSheetsAtom, {
    sheets: [
      { id: 'sheet-1', name: 'Sheet 1', index: 0 },
      { id: 'sheet-2', name: 'Sheet 2', index: 1 },
    ],
  })
}

function renderManager(store: Store, backend: NamedRangeBackend) {
  const readCapabilities = backend.readNamedRangeCapabilities
  const namedRangeCapabilityPort: NamedRangeCapabilityPort | undefined =
    typeof readCapabilities === 'function'
      ? { readNamedRangeCapabilities: readCapabilities.bind(backend) }
      : undefined
  return render(() => (
    <SpreadsheetUiProvider
      backend={backend}
      namedRangeCapabilityPort={namedRangeCapabilityPort}
      store={store}
    >
      <SpreadsheetNameManagerDialog />
    </SpreadsheetUiProvider>
  ))
}

async function waitUntilReady(store: Store): Promise<void> {
  await waitFor(() => {
    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
  })
}

function fillRangeDraft(getByTestId: (testId: string) => HTMLElement, name = 'NewName'): void {
  fireEvent.input(getByTestId('name-input'), { target: { value: name } })
  fireEvent.input(getByTestId('name-refers-to'), { target: { value: 'A1:B2' } })
}

describe('SpreadsheetNameManagerDialog core adapter', () => {
  it('does not render while closed and uses canonical sheet scope option values', async () => {
    const store = createStore()
    const backend = makeBackend()
    seedSheets(store)

    const view = renderManager(store, backend)
    expect(view.queryByTestId('name-manager-dialog')).toBeNull()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    await waitUntilReady(store)

    const select = view.getByTestId('name-scope-select') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'workbook',
      'sheet:sheet-1',
      'sheet:sheet-2',
    ])

    fireEvent.change(select, { target: { value: 'sheet:sheet-2' } })
    expect(store.getter(nameManagerScopeDraftAtom)).toBe('sheet:sheet-2')
  })

  it('saves through core and closes only after the exact acknowledged refresh settles', async () => {
    const store = createStore()
    const mutationResult = deferred<NamedRangeMutationResult>()
    const refreshedRegistry = deferred<NamedRangeListResult>()
    let listCall = 0
    const setNamedRange = jest.fn((request: SetNamedRangeRequest) => mutationResult.promise)
    const listNamedRanges = jest.fn((request: ListNamedRangesRequest) => {
      listCall += 1
      if (listCall === 1) {
        return Promise.resolve({ requestId: request.requestId, revision: 1, names: [] })
      }
      return refreshedRegistry.promise
    })
    const backend = makeBackend({ setNamedRange, listNamedRanges })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    await waitFor(() =>
      expect((view.getByTestId('name-save-button') as HTMLButtonElement).disabled).toBe(false),
    )

    fillRangeDraft(view.getByTestId, 'Sales_2026')
    fireEvent.change(view.getByTestId('name-scope-select'), {
      target: { value: 'sheet:sheet-2' },
    })
    fireEvent.click(view.getByTestId('name-save-button'))

    await waitFor(() => expect(setNamedRange).toHaveBeenCalledTimes(1))
    const request = setNamedRange.mock.calls[0][0]
    expect(Number.isSafeInteger(request.requestId)).toBe(true)
    expect(request).toMatchObject({
      kind: 'set-named-range',
      name: 'Sales_2026',
      scope: { sheetId: 'sheet-2' },
      refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'A1:B2' },
    })
    expect(store.getter(namedRangeMutationStateAtom).status).toBe('pending')
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')

    mutationResult.resolve({
      requestId: request.requestId,
      outcome: 'w0-acknowledged',
      revision: 2,
    })

    await waitFor(() => {
      expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
      expect(store.getter(namedRangeRegistryStateAtom).status).toBe('refreshing')
      expect(listNamedRanges).toHaveBeenCalledTimes(2)
    })
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(view.queryByTestId('name-manager-dialog')).not.toBeNull()

    const refreshRequest = listNamedRanges.mock.calls[1][0]
    refreshedRegistry.resolve({
      requestId: refreshRequest.requestId,
      revision: 2,
      names: [
        {
          name: 'Sales_2026',
          scope: { sheetId: 'sheet-2' },
          refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'A1:B2' },
        },
      ],
    })

    await waitFor(() => expect(store.getter(nameManagerEditorAtom).status).toBe('closed'))
    expect(store.getter(namedRangeRegistryStateAtom)).toMatchObject({
      status: 'ready',
      requestId: refreshRequest.requestId,
    })
    expect(view.queryByTestId('name-manager-dialog')).toBeNull()
  })

  it('deletes the core-selected entry with a strict request and refreshes the registry', async () => {
    const store = createStore()
    let listCall = 0
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => {
      listCall += 1
      return {
        requestId: request.requestId,
        revision: listCall,
        names: listCall === 1 ? [SAMPLE_ENTRY] : [],
      }
    })
    const deleteNamedRange = jest.fn(async (request: DeleteNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
      revision: 2,
    }))
    const backend = makeBackend({ listNamedRanges, deleteNamedRange })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    const entryButton = view.getByTestId('name-list').querySelector('button')!
    fireEvent.click(entryButton)

    await waitFor(() => {
      expect(store.getter(nameManagerEditorAtom).status).toBe('editing-existing')
      expect((view.getByTestId('name-delete-button') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(view.getByTestId('name-delete-button'))

    await waitFor(() => expect(deleteNamedRange).toHaveBeenCalledTimes(1))
    const request = deleteNamedRange.mock.calls[0][0]
    expect(Number.isSafeInteger(request.requestId)).toBe(true)
    expect(request).toMatchObject({
      kind: 'delete-named-range',
      name: 'MyRange',
      scope: 'workbook',
    })
    await waitFor(() => expect(store.getter(nameManagerEditorAtom).status).toBe('closed'))
    expect(listNamedRanges).toHaveBeenCalledTimes(2)
    expect(store.getter(namedRangeRegistryStateAtom).names).toEqual([])
  })

  it('keeps the current draft and selection after an exact confirmed-not-applied result', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'confirmed-not-applied' as const,
      revision: 1,
    }))
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      revision: 1,
      names: [SAMPLE_ENTRY],
    }))
    const backend = makeBackend({ setNamedRange, listNamedRanges })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft: SAMPLE_ENTRY })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    fireEvent.input(view.getByTestId('name-refers-to'), { target: { value: 'D4:E8' } })
    fireEvent.click(view.getByTestId('name-save-button'))

    await waitFor(() =>
      expect(store.getter(namedRangeMutationStateAtom).status).toBe('confirmed-not-applied'),
    )
    expect(listNamedRanges).toHaveBeenCalledTimes(1)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-existing')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('MyRange')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('D4:E8')
    expect(store.getter(nameManagerSelectedEntryAtom)).toEqual(SAMPLE_ENTRY)
    expect(view.getByTestId('name-error-text').textContent).toContain('draft is kept')
  })

  it.each(['malformed-result', 'rejected-result'] as const)(
    'keeps the draft unconfirmed for a %s',
    async (mode) => {
      const store = createStore()
      const setNamedRange = jest.fn(
        (_request: SetNamedRangeRequest): Promise<NamedRangeMutationResult> =>
          mode === 'malformed-result'
            ? Promise.resolve({})
            : Promise.reject(new Error('transport failed')),
      )
      const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
        requestId: request.requestId,
        revision: 1,
        names: [],
      }))
      const backend = makeBackend({ setNamedRange, listNamedRanges })
      seedSheets(store)
      store.setter(openNameManagerAtom, { status: 'editing-new' })

      const view = renderManager(store, backend)
      await waitUntilReady(store)
      fillRangeDraft(view.getByTestId, 'UnconfirmedName')
      fireEvent.click(view.getByTestId('name-save-button'))

      await waitFor(() =>
        expect(store.getter(namedRangeMutationStateAtom).status).toBe('outcome-unknown'),
      )
      expect(store.getter(namedRangeMutationBlockedAtom)).toBe(true)
      expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
      expect(store.getter(nameManagerNameDraftAtom)).toBe('UnconfirmedName')
      expect(store.getter(nameManagerRefersToDraftAtom)).toBe('A1:B2')
      expect(listNamedRanges).toHaveBeenCalledTimes(1)
      expect((view.getByTestId('name-save-button') as HTMLButtonElement).disabled).toBe(true)
      expect(view.getByTestId('name-error-text').textContent).toContain('could not be confirmed')
    },
  )

  it('does not let a late old save result close or overwrite a newer manager session', async () => {
    const store = createStore()
    const oldMutation = deferred<NamedRangeMutationResult>()
    const oldRefresh = deferred<NamedRangeListResult>()
    let listCall = 0
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => oldMutation.promise)
    const listNamedRanges = jest.fn((request: ListNamedRangesRequest) => {
      listCall += 1
      if (listCall === 1) {
        return Promise.resolve({ requestId: request.requestId, revision: 1, names: [] })
      }
      return oldRefresh.promise
    })
    const backend = makeBackend({ setNamedRange, listNamedRanges })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    fillRangeDraft(view.getByTestId, 'OldSession')
    fireEvent.click(view.getByTestId('name-save-button'))
    await waitFor(() => expect(setNamedRange).toHaveBeenCalledTimes(1))
    const oldRequest = setNamedRange.mock.calls[0][0]

    fireEvent.click(view.getByTestId('name-close-button'))
    expect(store.getter(nameManagerEditorAtom).status).toBe('closed')
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft: NEW_SESSION_ENTRY })

    await waitFor(() => {
      expect((view.getByTestId('name-input') as HTMLInputElement).value).toBe('NewSession')
      expect((view.getByTestId('name-scope-select') as HTMLSelectElement).value).toBe(
        'sheet:sheet-2',
      )
    })

    oldMutation.resolve({
      requestId: oldRequest.requestId,
      outcome: 'w0-acknowledged',
      revision: 2,
    })
    await waitFor(() => expect(listNamedRanges).toHaveBeenCalledTimes(2))
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-existing')

    const refreshRequest = listNamedRanges.mock.calls[1][0]
    oldRefresh.resolve({
      requestId: refreshRequest.requestId,
      revision: 2,
      names: [NEW_SESSION_ENTRY],
    })

    await waitFor(() => expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready'))
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-existing')
    expect(store.getter(nameManagerSelectedEntryAtom)).toEqual(NEW_SESSION_ENTRY)
    expect(store.getter(nameManagerNameDraftAtom)).toBe('NewSession')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('C3:D4')
    expect(view.queryByTestId('name-manager-dialog')).not.toBeNull()
  })

  it('does not let an acknowledged refresh close a newer draft generation in the same session', async () => {
    const store = createStore()
    const mutationResult = deferred<NamedRangeMutationResult>()
    const refreshedRegistry = deferred<NamedRangeListResult>()
    let listCall = 0
    const setNamedRange = jest.fn((_request: SetNamedRangeRequest) => mutationResult.promise)
    const listNamedRanges = jest.fn((request: ListNamedRangesRequest) => {
      listCall += 1
      if (listCall === 1) {
        return Promise.resolve({ requestId: request.requestId, revision: 1, names: [] })
      }
      return refreshedRegistry.promise
    })
    const backend = makeBackend({ setNamedRange, listNamedRanges })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    fillRangeDraft(view.getByTestId, 'OriginalDraft')
    fireEvent.click(view.getByTestId('name-save-button'))
    await waitFor(() => expect(setNamedRange).toHaveBeenCalledTimes(1))
    const request = setNamedRange.mock.calls[0][0]
    const submittedGeneration = store.getter(nameManagerDraftGenerationAtom)

    store.setter(nameManagerNameDraftAtom, 'NewerDraft')
    store.setter(nameManagerRefersToDraftAtom, 'D4')
    expect(store.getter(nameManagerDraftGenerationAtom)).toBeGreaterThan(submittedGeneration)

    mutationResult.resolve({
      requestId: request.requestId,
      outcome: 'w0-acknowledged',
      revision: 2,
    })
    await waitFor(() => expect(listNamedRanges).toHaveBeenCalledTimes(2))
    const refreshRequest = listNamedRanges.mock.calls[1][0]
    refreshedRegistry.resolve({
      requestId: refreshRequest.requestId,
      revision: 2,
      names: [SAMPLE_ENTRY],
    })

    await waitFor(() => expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready'))
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
    expect(store.getter(nameManagerNameDraftAtom)).toBe('NewerDraft')
    expect(store.getter(nameManagerRefersToDraftAtom)).toBe('D4')
    expect((view.getByTestId('name-input') as HTMLInputElement).value).toBe('NewerDraft')
    expect((view.getByTestId('name-refers-to') as HTMLInputElement).value).toBe('D4')
    expect(view.queryByTestId('name-manager-dialog')).not.toBeNull()
  })

  it('keeps mutation transport at zero when named-range capability is unavailable', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: request.requestId,
      names: [],
    }))
    const backend = makeBackend({
      readNamedRangeCapabilities: undefined,
      setNamedRange,
      listNamedRanges,
    })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitFor(() => expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('unavailable'))

    fillRangeDraft(view.getByTestId, 'UnavailableName')
    const save = view.getByTestId('name-save-button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    await Promise.resolve()

    expect(listNamedRanges).not.toHaveBeenCalled()
    expect(setNamedRange).not.toHaveBeenCalled()
    expect(view.getByTestId('name-error-text').textContent).toContain(
      'unavailable for this workbook',
    )
  })

  it('keeps mutation transport at zero when the initial list projection is unconfirmed', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
      requestId: (request.requestId ?? 0) + 1,
      revision: 1,
      names: [],
    }))
    const backend = makeBackend({ setNamedRange, listNamedRanges })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitFor(() =>
      expect(store.getter(namedRangeRegistryStateAtom).status).toBe('projection-unknown'),
    )

    fillRangeDraft(view.getByTestId, 'UnknownListName')
    const save = view.getByTestId('name-save-button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    await Promise.resolve()

    expect(listNamedRanges).toHaveBeenCalledTimes(1)
    expect(setNamedRange).not.toHaveBeenCalled()
    expect(view.getByTestId('name-error-text').textContent).toContain(
      'name list could not be confirmed',
    )
  })

  it('delegates validation to core and does not send an invalid draft', async () => {
    const store = createStore()
    const setNamedRange = jest.fn(async (request: SetNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const backend = makeBackend({ setNamedRange })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    fireEvent.click(view.getByTestId('name-save-button'))

    await waitFor(() => expect(store.getter(namedRangeMutationStateAtom).status).toBe('blocked'))
    expect(setNamedRange).not.toHaveBeenCalled()
    expect(view.getByTestId('name-error-text').textContent).toBe('Name is required')
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
  })

  it('localizes a known core blocked reason in English without entering transport', async () => {
    const store = createStore()
    const deleteNamedRange = jest.fn(async (request: DeleteNamedRangeRequest) => ({
      requestId: request.requestId,
      outcome: 'w0-acknowledged' as const,
    }))
    const backend = makeBackend({ deleteNamedRange })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    store.setter(deleteNameManagerEntryAtom, {
      source: backend,
      sessionId: store.getter(nameManagerSessionIdAtom),
    })

    await waitFor(() => expect(store.getter(namedRangeMutationStateAtom).status).toBe('blocked'))
    expect(deleteNamedRange).not.toHaveBeenCalled()
    expect(view.getByTestId('name-error-text').textContent).toBe('Select a name to delete.')
  })

  it('contains no direct backend mutation/list orchestration or local product-state atom', () => {
    const source = readFileSync(
      join(process.cwd(), 'solid/excel/src-vnext/named-ranges/SpreadsheetNameManagerDialog.tsx'),
      'utf8',
    )

    expect(source).not.toMatch(/\bawait\b/)
    expect(source).not.toMatch(/backend\.(?:setNamedRange|deleteNamedRange|listNamedRanges)/)
    expect(source).not.toMatch(/\batom\s*\(/)
    expect(source).not.toContain('nameRegistryCacheAtom')
    expect(source).not.toContain('setNameRegistryAtom')
    expect(source).not.toContain('listNamedRanges')
    expect(source).toContain('saveNameManagerAtom')
    expect(source).toContain('deleteNameManagerEntryAtom')
    expect(source).toContain('namedRangeRegistryStateAtom')
    expect(source).toContain('namedRangeMutationStateAtom')
  })
})

const SALES_TABLE: SpreadsheetTableDescriptor = Object.freeze({
  name: 'SalesTable',
  sheetId: 'sheet-1',
  sheetName: 'Sheet 1',
  sheetIndex: 0,
  range: 'A1:C10',
  hasHeaders: true,
  hasTotals: true,
  columns: Object.freeze(['Region', 'Q1', 'Q2']),
})

const COSTS_TABLE: SpreadsheetTableDescriptor = Object.freeze({
  name: 'CostsTable',
  sheetId: 'sheet-2',
  sheetName: 'Sheet 2',
  sheetIndex: 1,
  range: 'B2:D8',
  hasHeaders: true,
  hasTotals: false,
  columns: Object.freeze(['Item', 'Budget', 'Actual']),
})

describe('SpreadsheetNameManagerDialog tables region', () => {
  it('refreshes the catalog on open and lists every workbook table', async () => {
    const store = createStore()
    const listTables = jest.fn(
      async (request: ListTablesRequest): Promise<ListTablesResult> => ({
        requestId: request.requestId,
        revision: 1,
        tables: [SALES_TABLE, COSTS_TABLE],
      }),
    )
    const backend = makeBackend({ listTables })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    await waitFor(() => expect(listTables).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(store.getter(allTablesAtom).length).toBe(2))

    expect(view.getByTestId('name-manager-tables')).not.toBeNull()
    const list = view.getByTestId('name-manager-tables-list')
    expect(list.querySelectorAll('li').length).toBe(2)

    const text = list.textContent ?? ''
    expect(text).toContain('SalesTable')
    expect(text).toContain('Sheet 1')
    expect(text).toContain('A1:C10')
    expect(text).toContain('Region, Q1, Q2')
    expect(text).toContain('CostsTable')
    expect(text).toContain('B2:D8')

    // Totals badge only on the table that carries a totals row.
    const totals = list.querySelectorAll('[data-testid="name-manager-table-totals"]')
    expect(totals.length).toBe(1)
    const salesRow = list.querySelector('[data-table-name="SalesTable"]') as HTMLElement
    expect(salesRow.textContent).toContain('Totals row')
    const costsRow = list.querySelector('[data-table-name="CostsTable"]') as HTMLElement
    expect(costsRow.querySelector('[data-testid="name-manager-table-totals"]')).toBeNull()
  })

  it('does not read the table catalog until the dialog opens', async () => {
    const store = createStore()
    const listTables = jest.fn(
      async (request: ListTablesRequest): Promise<ListTablesResult> => ({
        requestId: request.requestId,
        revision: 1,
        tables: [SALES_TABLE],
      }),
    )
    const backend = makeBackend({ listTables })
    seedSheets(store)

    const view = renderManager(store, backend)
    await Promise.resolve()
    expect(listTables).not.toHaveBeenCalled()
    expect(view.queryByTestId('name-manager-tables')).toBeNull()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    await waitUntilReady(store)
    await waitFor(() => expect(listTables).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(view.getByTestId('name-manager-tables-list').querySelectorAll('li').length).toBe(1),
    )
  })

  it('shows the empty state when the workbook has no tables', async () => {
    const store = createStore()
    const listTables = jest.fn(
      async (request: ListTablesRequest): Promise<ListTablesResult> => ({
        requestId: request.requestId,
        revision: 1,
        tables: [],
      }),
    )
    const backend = makeBackend({ listTables })
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)
    await waitFor(() => expect(listTables).toHaveBeenCalledTimes(1))

    expect(view.getByTestId('name-manager-tables')).not.toBeNull()
    await waitFor(() => expect(view.getByTestId('name-manager-tables-empty')).not.toBeNull())
    expect(view.queryByTestId('name-manager-tables-list')).toBeNull()
  })

  it('hides the tables region when the backend omits listTables', async () => {
    const store = createStore()
    const backend = makeBackend()
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const view = renderManager(store, backend)
    await waitUntilReady(store)

    expect(view.queryByTestId('name-manager-tables')).toBeNull()
    expect(view.queryByTestId('name-manager-tables-list')).toBeNull()
    expect(view.queryByTestId('name-manager-tables-empty')).toBeNull()
  })
})

describe('SpreadsheetNameManagerDialog table row actions', () => {
  interface LifecycleHarness {
    backend: NamedRangeBackend
    listTables: jest.Mock<(request: ListTablesRequest) => Promise<ListTablesResult>>
    renameTable: jest.Mock<(request: RenameTableRequest) => Promise<TableMutationResult>>
    deleteTable: jest.Mock<(request: DeleteTableRequest) => Promise<TableMutationResult>>
    catalog: () => readonly SpreadsheetTableDescriptor[]
  }

  function makeLifecycleHarness(
    options: {
      renameResult?: (request: RenameTableRequest) => TableMutationResult
      withoutRename?: boolean
      withoutDelete?: boolean
    } = {},
  ): LifecycleHarness {
    let catalog: readonly SpreadsheetTableDescriptor[] = [SALES_TABLE, COSTS_TABLE]

    const listTables = jest.fn(
      async (request: ListTablesRequest): Promise<ListTablesResult> => ({
        requestId: request.requestId,
        revision: 1,
        tables: [...catalog],
      }),
    )
    const renameTable = jest.fn(
      async (request: RenameTableRequest): Promise<TableMutationResult> => {
        if (options.renameResult) return options.renameResult(request)
        catalog = catalog.map((table) =>
          table.name === request.name ? { ...table, name: request.newName } : table,
        )
        return {
          kind: 'table-mutation',
          applied: true,
          name: request.newName,
          requestId: request.requestId,
          revision: 2,
        }
      },
    )
    const deleteTable = jest.fn(
      async (request: DeleteTableRequest): Promise<TableMutationResult> => {
        catalog = catalog.filter((table) => table.name !== request.name)
        return {
          kind: 'table-mutation',
          applied: true,
          name: request.name,
          requestId: request.requestId,
          revision: 2,
        }
      },
    )

    const overrides: Partial<NamedRangeBackend> = { listTables }
    if (!options.withoutRename) overrides.renameTable = renameTable
    if (!options.withoutDelete) overrides.deleteTable = deleteTable

    return {
      backend: makeBackend(overrides),
      listTables,
      renameTable,
      deleteTable,
      catalog: () => catalog,
    }
  }

  async function openWithTables(harness: LifecycleHarness) {
    const store = createStore()
    seedSheets(store)
    store.setter(openNameManagerAtom, { status: 'editing-new' })
    const view = renderManager(store, harness.backend)
    await waitUntilReady(store)
    await waitFor(() => expect(harness.listTables).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(view.getByTestId('name-manager-tables-list').querySelectorAll('li').length).toBe(2),
    )
    return { store, view }
  }

  function row(view: { getByTestId: (id: string) => HTMLElement }, name: string): HTMLElement {
    const found = view
      .getByTestId('name-manager-tables-list')
      .querySelector(`[data-table-name="${name}"]`)
    expect(found).not.toBeNull()
    return found as HTMLElement
  }

  it('renders a rename and delete affordance on every table row', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    for (const name of ['SalesTable', 'CostsTable']) {
      const target = row(view, name)
      expect(target.querySelector('[data-testid="name-manager-table-rename"]')).not.toBeNull()
      expect(target.querySelector('[data-testid="name-manager-table-delete"]')).not.toBeNull()
    }
  })

  it('hides each row action when the backend omits the matching port', async () => {
    const harness = makeLifecycleHarness({ withoutRename: true, withoutDelete: true })
    const { view } = await openWithTables(harness)

    const target = row(view, 'SalesTable')
    expect(target.querySelector('[data-testid="name-manager-table-rename"]')).toBeNull()
    expect(target.querySelector('[data-testid="name-manager-table-delete"]')).toBeNull()

    const renameOnly = makeLifecycleHarness({ withoutDelete: true })
    const second = await openWithTables(renameOnly)
    const secondRow = row(second.view, 'SalesTable')
    expect(secondRow.querySelector('[data-testid="name-manager-table-rename"]')).not.toBeNull()
    expect(secondRow.querySelector('[data-testid="name-manager-table-delete"]')).toBeNull()
  })

  it('renames a table inline and refreshes the listing from the engine', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'SalesTable').querySelector(
        '[data-testid="name-manager-table-rename"]',
      ) as HTMLElement,
    )

    const input = row(view, 'SalesTable').querySelector(
      '[data-testid="name-manager-table-rename-input"]',
    ) as HTMLInputElement
    expect(input.value).toBe('SalesTable')
    fireEvent.input(input, { target: { value: 'Revenue' } })
    fireEvent.click(
      row(view, 'SalesTable').querySelector(
        '[data-testid="name-manager-table-rename-save"]',
      ) as HTMLElement,
    )

    await waitFor(() => expect(harness.renameTable).toHaveBeenCalledTimes(1))
    expect(harness.renameTable.mock.calls[0][0]).toMatchObject({
      kind: 'rename-table',
      name: 'SalesTable',
      newName: 'Revenue',
    })
    // Applied → the catalog is re-read from the engine and the row re-labels.
    await waitFor(() => expect(harness.listTables).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(row(view, 'Revenue')).not.toBeNull())
    expect(
      view.getByTestId('name-manager-tables-list').querySelector('[data-table-name="SalesTable"]'),
    ).toBeNull()
    // The inline editor closes on success.
    expect(view.queryByTestId('name-manager-table-rename-input')).toBeNull()
    expect(view.queryByTestId('name-manager-tables-error')).toBeNull()
  })

  it('rejects an invalid rename locally, keeps the draft and shows the diagnostic', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'SalesTable').querySelector(
        '[data-testid="name-manager-table-rename"]',
      ) as HTMLElement,
    )
    const input = view.getByTestId('name-manager-table-rename-input') as HTMLInputElement
    fireEvent.input(input, { target: { value: '2 Bad Name' } })
    fireEvent.click(view.getByTestId('name-manager-table-rename-save'))

    // Pre-validated in UI core → zero transport.
    await waitFor(() => expect(view.getByTestId('name-manager-tables-error')).not.toBeNull())
    expect(harness.renameTable).not.toHaveBeenCalled()
    expect(view.getByTestId('name-manager-tables-error').dataset.tableDiagnosticCode).toBe(
      'invalid-name',
    )
    // Draft survives so the user can correct it.
    expect((view.getByTestId('name-manager-table-rename-input') as HTMLInputElement).value).toBe(
      '2 Bad Name',
    )
  })

  it('surfaces a structured rename reject as a localized diagnostic', async () => {
    const harness = makeLifecycleHarness({
      renameResult: (request) => ({
        kind: 'table-mutation-not-applied',
        applied: false,
        code: 'name-conflict',
        requestId: request.requestId,
        revision: 3,
      }),
    })
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'SalesTable').querySelector(
        '[data-testid="name-manager-table-rename"]',
      ) as HTMLElement,
    )
    fireEvent.input(view.getByTestId('name-manager-table-rename-input'), {
      target: { value: 'CostsTable' },
    })
    fireEvent.click(view.getByTestId('name-manager-table-rename-save'))

    await waitFor(() => expect(harness.renameTable).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(view.getByTestId('name-manager-tables-error').dataset.tableDiagnosticCode).toBe(
        'name-conflict',
      ),
    )
    expect(view.getByTestId('name-manager-tables-error').textContent).toContain(
      'That name is already in use.',
    )
    // Rejected → the row keeps its old name and the editor stays open.
    expect(row(view, 'SalesTable')).not.toBeNull()
    expect(view.getByTestId('name-manager-table-rename-input')).not.toBeNull()
  })

  it('cancels an inline rename without touching the backend', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'SalesTable').querySelector(
        '[data-testid="name-manager-table-rename"]',
      ) as HTMLElement,
    )
    fireEvent.input(view.getByTestId('name-manager-table-rename-input'), {
      target: { value: 'Revenue' },
    })
    fireEvent.click(view.getByTestId('name-manager-table-rename-cancel'))

    expect(view.queryByTestId('name-manager-table-rename-input')).toBeNull()
    expect(harness.renameTable).not.toHaveBeenCalled()
    expect(row(view, 'SalesTable')).not.toBeNull()
  })

  it('deletes a table only after the inline confirmation step', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'CostsTable').querySelector(
        '[data-testid="name-manager-table-delete"]',
      ) as HTMLElement,
    )
    // The first click only arms the confirmation — nothing is sent.
    expect(harness.deleteTable).not.toHaveBeenCalled()
    const prompt = view.getByTestId('name-manager-table-delete-prompt')
    expect(prompt.textContent).toContain('CostsTable')

    fireEvent.click(view.getByTestId('name-manager-table-delete-confirm'))
    await waitFor(() => expect(harness.deleteTable).toHaveBeenCalledTimes(1))
    expect(harness.deleteTable.mock.calls[0][0]).toMatchObject({
      kind: 'delete-table',
      name: 'CostsTable',
    })
    await waitFor(() =>
      expect(view.getByTestId('name-manager-tables-list').querySelectorAll('li').length).toBe(1),
    )
    expect(
      view.getByTestId('name-manager-tables-list').querySelector('[data-table-name="CostsTable"]'),
    ).toBeNull()
  })

  it('cancelling the delete confirmation sends nothing', async () => {
    const harness = makeLifecycleHarness()
    const { view } = await openWithTables(harness)

    fireEvent.click(
      row(view, 'CostsTable').querySelector(
        '[data-testid="name-manager-table-delete"]',
      ) as HTMLElement,
    )
    fireEvent.click(view.getByTestId('name-manager-table-delete-cancel'))

    expect(view.queryByTestId('name-manager-table-delete-prompt')).toBeNull()
    expect(harness.deleteTable).not.toHaveBeenCalled()
    expect(row(view, 'CostsTable')).not.toBeNull()
  })
})
