/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  selectCellAtom,
  setWorkspaceActiveSheetAtom,
  startEditingAtom,
  toolbarIntentAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'

afterEach(cleanup)

function createFakeBackend() {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }

  return backend
}

function getButtons(container: HTMLElement) {
  return {
    bold: container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement,
    italic: container.querySelector('[data-testid="toolbar-btn-italic"]') as HTMLButtonElement,
    fillColor: container.querySelector('[data-testid="toolbar-btn-fill-color"]') as HTMLButtonElement,
    textColor: container.querySelector('[data-testid="toolbar-btn-text-color"]') as HTMLButtonElement,
    numberFormat: container.querySelector(
      '[data-testid="toolbar-btn-number-format"]',
    ) as HTMLButtonElement,
  }
}

describe('vNext SpreadsheetToolbar', () => {
  it('enables format buttons for selected cell and range', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 }, extend: true })

    expect(buttons.bold.disabled).toBe(false)
    expect(buttons.italic.disabled).toBe(false)
    expect(buttons.fillColor.disabled).toBe(false)
    expect(buttons.textColor.disabled).toBe(false)
    expect(buttons.numberFormat.disabled).toBe(false)
  })

  it('disables formatting commands while editing is drafting', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
    store.setter(startEditingAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      draft: '=1+1',
      source: 'formula-bar',
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    const buttons = getButtons(container)
    expect(buttons.bold.disabled).toBe(true)
    expect(buttons.italic.disabled).toBe(true)
    expect(buttons.fillColor.disabled).toBe(true)
    expect(buttons.textColor.disabled).toBe(true)
    expect(buttons.numberFormat.disabled).toBe(true)
  })

  it('dispatches toolbar.format.command intent when bold is clicked', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="toolbar-btn-bold"]') as HTMLButtonElement)

    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'sheet-1',
      selectionKind: 'cell',
      command: 'bold',
      value: null,
    })
  })
})
