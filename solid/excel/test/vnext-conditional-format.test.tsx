/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  openConditionalFormatEditorAtom,
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
})
