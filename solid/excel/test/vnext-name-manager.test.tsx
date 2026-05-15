/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  nameManagerEditorAtom,
  nameRegistryCacheAtom,
  openNameManagerAtom,
  type NamedRange,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetNameManagerDialog } from '../src-vnext/named-ranges'

afterEach(cleanup)

function createFakeBackend() {
  const setNamedRangeRequests: unknown[] = []
  const deleteNamedRangeRequests: unknown[] = []

  const backend: SpreadsheetBackend = {
    readVisibleProjection: async (req) => ({
      kind: 'visible-window',
      sheetId: req.sheetId,
      requestId: req.requestId,
      window: req.window,
      cells: [],
    }),
    readRangeProjection: async (req) => ({
      kind: 'range',
      sheetId: req.sheetId,
      requestId: req.requestId,
      range: req.range,
      cells: [],
    }),
    setCellInput: async (req) => ({ sheetId: req.sheetId }),
    setNamedRange: jest.fn(async (req) => {
      setNamedRangeRequests.push(req)
      return {}
    }),
    deleteNamedRange: jest.fn(async (req) => {
      deleteNamedRangeRequests.push(req)
      return {}
    }),
  }

  return { backend, setNamedRangeRequests, deleteNamedRangeRequests }
}

const sampleEntry: NamedRange = {
  name: 'MyRange',
  scope: 'workbook',
  refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B5' },
}

describe('SpreadsheetNameManagerDialog', () => {
  it('does not render when editor status is closed', () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('name-manager-dialog')).toBeNull()
  })

  it('renders dialog and name list when editor is open', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(nameRegistryCacheAtom, [sampleEntry])
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-manager-dialog')).toBeTruthy())
    const list = getByTestId('name-list')
    expect(list.querySelectorAll('li').length).toBe(1)
    expect(list.querySelector('[data-name="MyRange"]')).toBeTruthy()
  })

  it('dispatches setNamedRange and closes on Save', async () => {
    const store = createStore()
    const { backend, setNamedRangeRequests } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-input')).toBeTruthy())

    fireEvent.input(getByTestId('name-input'), { target: { value: 'NewName' } })
    fireEvent.click(getByTestId('name-save-button'))

    await waitFor(() => expect(setNamedRangeRequests).toHaveLength(1))
    expect(setNamedRangeRequests[0]).toMatchObject({
      kind: 'set-named-range',
      name: 'NewName',
      scope: 'workbook',
    })
    await waitFor(() => expect(store.getter(nameManagerEditorAtom).status).toBe('closed'))
  })

  it('dispatches deleteNamedRange when Delete is clicked after selecting an entry', async () => {
    const store = createStore()
    const { backend, deleteNamedRangeRequests } = createFakeBackend()

    store.setter(nameRegistryCacheAtom, [sampleEntry])
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft: sampleEntry })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-list')).toBeTruthy())
    // Click the list item to select it
    fireEvent.click(getByTestId('name-list').querySelector('[data-name="MyRange"]')!)
    fireEvent.click(getByTestId('name-delete-button'))

    await waitFor(() => expect(deleteNamedRangeRequests).toHaveLength(1))
    expect(deleteNamedRangeRequests[0]).toMatchObject({
      kind: 'delete-named-range',
      name: 'MyRange',
      scope: 'workbook',
    })
  })

  it('closes editor on Close without dispatching', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-close-button')).toBeTruthy())
    fireEvent.click(getByTestId('name-close-button'))

    await waitFor(() => expect(store.getter(nameManagerEditorAtom).status).toBe('closed'))
    expect(backend.setNamedRange).not.toHaveBeenCalled()
    expect(backend.deleteNamedRange).not.toHaveBeenCalled()
  })

  it('shows name-input and name-scope-select fields', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-input')).toBeTruthy())
    expect(getByTestId('name-scope-select')).toBeTruthy()
    const select = getByTestId('name-scope-select') as HTMLSelectElement
    expect(select.options[0].value).toBe('workbook')
  })
})
