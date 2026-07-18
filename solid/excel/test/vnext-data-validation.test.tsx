/** @jsxImportSource solid-js */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  ClearValidationRuleRequest,
  SetValidationRuleRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  RangeProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  dataValidationOperationAttemptLedgerAtom,
  openValidationRuleEditorAtom,
  validationRuleEditorAtom,
  validationRuleFormAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetDataValidationDialog } from '../src-vnext/data-validation'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { setLocale } from '../src/i18n'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setLocale('en')
})

function createFakeBackend() {
  const setValidationRuleRequests: SetValidationRuleRequest[] = []
  const clearValidationRuleRequests: ClearValidationRuleRequest[] = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request: VisibleProjectionRequest) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        window: request.window,
        cells: [],
      }
    },
    async readRangeProjection(request: RangeProjectionRequest) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        range: request.range,
        cells: [],
      }
    },
    async setCellInput(request) {
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async setValidationRule(request) {
      setValidationRuleRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async clearValidationRule(request) {
      clearValidationRuleRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }

  return { backend, setValidationRuleRequests, clearValidationRuleRequests }
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

const testRange = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }

describe('SpreadsheetDataValidationDialog', () => {
  it('does not render when editor status is closed', () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('validation-dialog')).toBeNull()
  })

  it('renders when editor status is editing', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, { range: testRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    const dialog = await waitFor(() => getByTestId('validation-dialog'))
    expect(dialog).toBeTruthy()
    expect(getByTestId('validation-range').textContent).toBe('A1:B3')
  })

  it('Save calls backend.setValidationRule with constructed list rule and closes', async () => {
    const store = createStore()
    const { backend, setValidationRuleRequests } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, { range: testRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    // kind is 'list' by default — fill in values
    const valuesInput = await waitFor(() => getByTestId('validation-list-values'))
    fireEvent.input(valuesInput, { target: { value: 'yes, no, maybe' } })

    fireEvent.click(getByTestId('validation-save-button'))

    await waitFor(() => expect(setValidationRuleRequests).toHaveLength(1))
    expect(setValidationRuleRequests[0]).toMatchObject({
      kind: 'set-validation-rule',
      sheetId: 'sheet-1',
      range: testRange,
      rule: {
        kind: 'list',
        values: ['yes', 'no', 'maybe'],
        dropdown: true,
      },
      mode: 'warn',
    })
    await waitFor(() => expect(store.getter(validationRuleEditorAtom).status).toBe('closed'))
  })

  it('Save with range kind sends correct min/max rule', async () => {
    const store = createStore()
    const { backend, setValidationRuleRequests } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, { range: testRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-2" />
      </SpreadsheetUiProvider>
    ))

    // switch to 'range' kind
    const kindSelect = await waitFor(() => getByTestId('validation-kind-select'))
    fireEvent.change(kindSelect, { target: { value: 'range' } })

    const minInput = await waitFor(() => getByTestId('validation-range-min'))
    const maxInput = getByTestId('validation-range-max')
    fireEvent.input(minInput, { target: { value: '1' } })
    fireEvent.input(maxInput, { target: { value: '100' } })

    fireEvent.click(getByTestId('validation-save-button'))

    await waitFor(() => expect(setValidationRuleRequests).toHaveLength(1))
    expect(setValidationRuleRequests[0].rule).toMatchObject({ kind: 'range', min: 1, max: 100 })
  })

  it('Clear calls backend.clearValidationRule and closes', async () => {
    const store = createStore()
    const { backend, clearValidationRuleRequests } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, { range: testRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => getByTestId('validation-dialog'))
    fireEvent.click(getByTestId('validation-clear-button'))

    await waitFor(() => expect(clearValidationRuleRequests).toHaveLength(1))
    expect(clearValidationRuleRequests[0]).toMatchObject({
      kind: 'clear-validation-rule',
      sheetId: 'sheet-1',
      range: testRange,
    })
    await waitFor(() => expect(store.getter(validationRuleEditorAtom).status).toBe('closed'))
  })

  it('Cancel closes without calling backend', async () => {
    const store = createStore()
    const { backend, setValidationRuleRequests, clearValidationRuleRequests } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, { range: testRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => getByTestId('validation-dialog'))
    fireEvent.click(getByTestId('validation-cancel-button'))

    await waitFor(() => expect(store.getter(validationRuleEditorAtom).status).toBe('closed'))
    expect(setValidationRuleRequests).toHaveLength(0)
    expect(clearValidationRuleRequests).toHaveLength(0)
  })

  it('keeps a reopened draft intact when the prior dispatched Save acknowledges late', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const deferred = createDeferred<BackendMutationResult>()
    let dispatchedRequest: SetValidationRuleRequest | undefined
    const backend: SpreadsheetBackend = {
      ...baseBackend,
      setValidationRule(request) {
        dispatchedRequest = request
        return deferred.promise
      },
    }
    const reopenedRange = { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 }

    store.setter(openValidationRuleEditorAtom, { range: testRange })
    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(await waitFor(() => view.getByTestId('validation-list-values')), {
      target: { value: 'old-session' },
    })
    fireEvent.click(view.getByTestId('validation-save-button'))
    await waitFor(() => expect(dispatchedRequest).toBeDefined())
    expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toMatchObject([
      { status: 'pending', sheetId: 'sheet-1', range: testRange },
    ])

    fireEvent.click(view.getByTestId('validation-cancel-button'))
    await waitFor(() => expect(view.queryByTestId('validation-dialog')).toBeNull())
    store.setter(openValidationRuleEditorAtom, { range: reopenedRange })
    fireEvent.input(await waitFor(() => view.getByTestId('validation-list-values')), {
      target: { value: 'new-session' },
    })

    deferred.resolve({
      sheetId: dispatchedRequest!.sheetId,
      requestId: dispatchedRequest!.requestId,
      affectedRange: dispatchedRequest!.range,
    })

    await waitFor(() =>
      expect(store.getter(dataValidationOperationAttemptLedgerAtom)).toMatchObject([
        { status: 'acknowledged', sheetId: 'sheet-1', range: testRange },
      ]),
    )
    expect(store.getter(validationRuleEditorAtom)).toMatchObject({
      status: 'editing',
      range: reopenedRange,
      pending: false,
      error: null,
    })
    expect(store.getter(validationRuleFormAtom).listValues).toBe('new-session')
    expect(view.getByTestId('validation-range').textContent).toBe('D5:E6')
    expect((view.getByTestId('validation-list-values') as HTMLInputElement).value).toBe(
      'new-session',
    )
  })

  it('shows "no range selected" when editor has no range', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openValidationRuleEditorAtom, {})

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetDataValidationDialog sheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    const rangeEl = await waitFor(() => getByTestId('validation-range'))
    expect(rangeEl.textContent).toBe('no range selected')
  })
})
