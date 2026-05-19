/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  closeNameManagerAtom,
  nameManagerEditorAtom,
  nameRegistryCacheAtom,
  openNameManagerAtom,
  setSheetTabsSheetsAtom,
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
    fireEvent.input(getByTestId('name-refers-to'), { target: { value: 'sheet-1!A1:B5' } })
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

  it('surfaces backend setNamedRange errors via name-error-text', async () => {
    const store = createStore()
    const failingBackend: SpreadsheetBackend = {
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
      setNamedRange: jest.fn(async () => {
        throw new Error('boom')
      }),
    }

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={failingBackend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-input')).toBeTruthy())
    fireEvent.input(getByTestId('name-input'), { target: { value: 'Failing' } })
    fireEvent.input(getByTestId('name-refers-to'), { target: { value: 'sheet-1!A1' } })
    fireEvent.click(getByTestId('name-save-button'))

    await waitFor(() => expect(queryByTestId('name-error-text')).toBeTruthy())
    expect(getByTestId('name-error-text').textContent).toBe('boom')
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
  })

  it('renders one option per sheet in the scope select', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(setSheetTabsSheetsAtom, {
      sheets: [
        { id: 'sheet-1', name: 'Sheet 1', index: 0 },
        { id: 'sheet-2', name: 'Sheet 2', index: 1 },
      ],
    })
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-scope-select')).toBeTruthy())
    const select = getByTestId('name-scope-select') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['workbook', 'sheet-1', 'sheet-2'])
  })

  it('resets form fields when the dialog closes and reopens without a draft', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-input')).toBeTruthy())
    fireEvent.input(getByTestId('name-input'), { target: { value: 'StaleName' } })
    fireEvent.input(getByTestId('name-refers-to'), { target: { value: 'sheet-1!Z9' } })

    store.setter(closeNameManagerAtom)
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    await waitFor(() => {
      const input = getByTestId('name-input') as HTMLInputElement
      expect(input.value).toBe('')
    })
    expect((getByTestId('name-refers-to') as HTMLInputElement).value).toBe('')
    expect((getByTestId('name-scope-select') as HTMLSelectElement).value).toBe('workbook')
  })

  it('populates form fields from the draft when the dialog opens', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-existing', draft: sampleEntry })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-input')).toBeTruthy())
    expect((getByTestId('name-input') as HTMLInputElement).value).toBe('MyRange')
    expect((getByTestId('name-refers-to') as HTMLInputElement).value).toBe('sheet-1!A1:B5')
    expect((getByTestId('name-scope-select') as HTMLSelectElement).value).toBe('workbook')
  })

  it('blocks submission and shows an error when the name is empty', async () => {
    const store = createStore()
    const { backend, setNamedRangeRequests } = createFakeBackend()

    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('name-save-button'))

    await waitFor(() => expect(queryByTestId('name-error-text')).toBeTruthy())
    expect(getByTestId('name-error-text').textContent).toBe('Name is required')
    expect(setNamedRangeRequests).toHaveLength(0)
    expect(store.getter(nameManagerEditorAtom).status).toBe('editing-new')
  })

  it('clears prior error when selecting an existing entry', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(nameRegistryCacheAtom, [sampleEntry])
    store.setter(openNameManagerAtom, { status: 'editing-new' })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameManagerDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('name-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('name-save-button'))
    await waitFor(() => expect(queryByTestId('name-error-text')).toBeTruthy())

    fireEvent.click(getByTestId('name-list').querySelector('[data-name="MyRange"]')!)

    await waitFor(() => expect(queryByTestId('name-error-text')).toBeNull())
  })
})
