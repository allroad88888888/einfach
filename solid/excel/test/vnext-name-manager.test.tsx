/** @jsxImportSource solid-js */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import {
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
  type ListNamedRangesRequest,
  type NamedRange,
  type NamedRangeBackendCapabilities,
  type NamedRangeControllerPort,
  type NamedRangeListResult,
  type NamedRangeMutationResult,
  type SetNamedRangeRequest,
  type SpreadsheetBackend,
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
