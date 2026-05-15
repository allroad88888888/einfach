/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  ClearValidationRuleRequest,
  SetValidationRuleRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  RangeProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  openValidationRuleEditorAtom,
  validationRuleEditorAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetDataValidationDialog } from '../src-vnext/data-validation'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(() => {
  cleanup()
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
