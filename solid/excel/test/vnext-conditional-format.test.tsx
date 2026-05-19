/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  closeConditionalFormatEditorAtom,
  openConditionalFormatEditorAtom,
  selectionAtom,
  workspaceSessionAtom,
  type ConditionalFormatRuleEntry,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetConditionalFormatDialog } from '../src-vnext/conditional-formatting'

afterEach(cleanup)

function createFakeBackend() {
  const setConditionalFormatRuleRequests: unknown[] = []
  const removeConditionalFormatRuleRequests: unknown[] = []

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
    setConditionalFormatRule: jest.fn(async (req) => {
      setConditionalFormatRuleRequests.push(req)
      return { sheetId: (req as { sheetId: string }).sheetId }
    }),
    removeConditionalFormatRule: jest.fn(async (req) => {
      removeConditionalFormatRuleRequests.push(req)
      return { sheetId: (req as { sheetId: string }).sheetId }
    }),
  }

  return { backend, setConditionalFormatRuleRequests, removeConditionalFormatRuleRequests }
}

const sampleEntry: ConditionalFormatRuleEntry = {
  id: 'rule-1',
  priority: 1,
  scope: { range: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 } },
  rule: { kind: 'cell-value', operator: 'gt', value: '10', format: { bold: true } },
}

describe('SpreadsheetConditionalFormatDialog', () => {
  it('does not render when editor is closed', () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('conditional-format-dialog')).toBeNull()
  })

  it('renders dialog and rule list when editor is open', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(conditionalFormatRulesCacheAtom, {
      sheetId: 'sheet-1',
      rules: [sampleEntry],
    })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('conditional-format-dialog')).toBeTruthy())
    const list = getByTestId('cf-rule-list')
    expect(list.querySelectorAll('li').length).toBe(1)
    expect(list.querySelector('[data-rule-id="rule-1"]')).toBeTruthy()
  })

  it('dispatches setConditionalFormatRule and closes on Save', async () => {
    const store = createStore()
    const { backend, setConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(conditionalFormatRulesCacheAtom, {
      sheetId: 'sheet-1',
      rules: [sampleEntry],
    })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-save-button'))

    await waitFor(() => expect(setConditionalFormatRuleRequests).toHaveLength(1))
    expect(setConditionalFormatRuleRequests[0]).toMatchObject({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-1',
      ruleId: 'rule-1',
      rule: sampleEntry.rule,
    })
    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(false))
  })

  it('dispatches removeConditionalFormatRule and closes on Remove', async () => {
    const store = createStore()
    const { backend, removeConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(conditionalFormatRulesCacheAtom, { sheetId: 'sheet-2', rules: [sampleEntry] })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-remove-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-remove-button'))

    await waitFor(() => expect(removeConditionalFormatRuleRequests).toHaveLength(1))
    expect(removeConditionalFormatRuleRequests[0]).toMatchObject({
      kind: 'remove-conditional-format-rule',
      sheetId: 'sheet-2',
      ruleId: 'rule-1',
    })
    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(false))
  })

  it('closes without dispatching on Cancel', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-cancel-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-cancel-button'))

    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(false))
    expect(backend.setConditionalFormatRule).not.toHaveBeenCalled()
    expect(backend.removeConditionalFormatRule).not.toHaveBeenCalled()
  })

  it('renders kind selector with all rule kinds', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openConditionalFormatEditorAtom, null)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-rule-kind-select')).toBeTruthy())
    const select = getByTestId('cf-rule-kind-select') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain('cell-value')
    expect(options).toContain('formula')
    expect(options).toContain('data-bar')
    expect(options).toContain('color-scale')
    expect(options).toContain('top-bottom')
  })

  it('surfaces backend errors on Save and clears them on the next attempt', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    let shouldFail = true
    backend.setConditionalFormatRule = jest.fn(async (req) => {
      if (shouldFail) throw new Error('boom')
      return { sheetId: (req as { sheetId: string }).sheetId }
    })

    store.setter(conditionalFormatRulesCacheAtom, { sheetId: 'sheet-1', rules: [sampleEntry] })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-save-button'))

    await waitFor(() => expect(getByTestId('cf-error-text').textContent).toBe('boom'))
    expect(store.getter(conditionalFormatEditorAtom).open).toBe(true)

    shouldFail = false
    fireEvent.click(getByTestId('cf-save-button'))
    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(false))
    expect(queryByTestId('cf-error-text')).toBeNull()
  })

  it('surfaces backend errors on Remove', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()
    backend.removeConditionalFormatRule = jest.fn(async () => {
      throw new Error('remove failed')
    })

    store.setter(conditionalFormatRulesCacheAtom, { sheetId: 'sheet-1', rules: [sampleEntry] })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-remove-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-remove-button'))

    await waitFor(() => expect(getByTestId('cf-error-text').textContent).toBe('remove failed'))
    expect(store.getter(conditionalFormatEditorAtom).open).toBe(true)
  })

  it('prefers workspace active sheet id over rules cache when present', async () => {
    const store = createStore()
    const { backend, setConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(workspaceSessionAtom, {
      activeSheetId: 'active-sheet',
      viewportRevision: 0,
      projectionRequestRevision: 0,
      committedProjectionRequestRevision: 0,
    })
    store.setter(conditionalFormatRulesCacheAtom, {
      sheetId: 'stale-sheet',
      rules: [sampleEntry],
    })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-save-button'))

    await waitFor(() => expect(setConditionalFormatRuleRequests).toHaveLength(1))
    expect(setConditionalFormatRuleRequests[0]).toMatchObject({
      sheetId: 'active-sheet',
    })
  })

  it('falls back to rules cache sheet id when workspace active sheet is unset', async () => {
    const store = createStore()
    const { backend, setConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(conditionalFormatRulesCacheAtom, { sheetId: 'cache-sheet', rules: [sampleEntry] })
    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-save-button'))

    await waitFor(() => expect(setConditionalFormatRuleRequests).toHaveLength(1))
    expect(setConditionalFormatRuleRequests[0]).toMatchObject({ sheetId: 'cache-sheet' })
  })

  it('uses current selection range as scope when no draft scope exists', async () => {
    const store = createStore()
    const { backend, setConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(workspaceSessionAtom, {
      activeSheetId: 'sheet-a',
      viewportRevision: 0,
      projectionRequestRevision: 0,
      committedProjectionRequestRevision: 0,
    })
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'sheet-a',
      anchor: { row: 2, col: 1 },
      focus: { row: 4, col: 3 },
    })
    store.setter(openConditionalFormatEditorAtom, null)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-save-button')).toBeTruthy())
    fireEvent.click(getByTestId('cf-save-button'))

    await waitFor(() => expect(setConditionalFormatRuleRequests).toHaveLength(1))
    expect(setConditionalFormatRuleRequests[0]).toMatchObject({
      scope: { range: { rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 3 } },
    })
  })

  it('resets signals when dialog is reopened without a draft', async () => {
    const store = createStore()
    const { backend, setConditionalFormatRuleRequests } = createFakeBackend()

    store.setter(openConditionalFormatEditorAtom, sampleEntry)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetConditionalFormatDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('cf-rule-kind-select')).toBeTruthy())
    const select = getByTestId('cf-rule-kind-select') as HTMLSelectElement
    // Initially mirrors the sample entry's kind.
    await waitFor(() => expect(select.value).toBe('cell-value'))

    // Switch to a different kind, then close.
    fireEvent.change(select, { target: { value: 'formula' } })
    await waitFor(() => expect(select.value).toBe('formula'))

    store.setter(closeConditionalFormatEditorAtom)
    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(false))

    // Reopen without a draft — selectedKind should reset to 'cell-value'.
    store.setter(openConditionalFormatEditorAtom, null)
    await waitFor(() => expect(store.getter(conditionalFormatEditorAtom).open).toBe(true))
    const reopenedSelect = getByTestId('cf-rule-kind-select') as HTMLSelectElement
    await waitFor(() => expect(reopenedSelect.value).toBe('cell-value'))

    // Sanity-check: save uses default rule for cell-value.
    fireEvent.click(getByTestId('cf-save-button'))
    await waitFor(() => expect(setConditionalFormatRuleRequests).toHaveLength(1))
    expect(setConditionalFormatRuleRequests[0]).toMatchObject({
      rule: { kind: 'cell-value' },
    })
  })
})
