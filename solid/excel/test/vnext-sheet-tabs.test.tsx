/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createStore } from '@einfach/core'
import {
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import type { SpreadsheetBackend, SpreadsheetSheetMetadata } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetSheetTabs } from '../src-vnext/sheet-tabs'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function createFakeBackend(seedSheets: SpreadsheetSheetMetadata[] = []) {
  let revision = 0
  let sheets = seedSheets.map((sheet, index) => ({ ...sheet, index }))
  const backend: SpreadsheetBackend = {
    async listSheets() {
      return {
        revision,
        sheets: sheets.map((sheet, index) => ({ ...sheet, index })),
      }
    },
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async addSheet(request) {
      const createdSheet = {
        id: `sheet-${sheets.length + 1}`,
        name: request.name ?? `Sheet${sheets.length + 1}`,
        index: sheets.length,
      }
      revision += 1
      sheets = [...sheets, createdSheet]
      return {
        sheetId: createdSheet.id,
        activeSheetId: createdSheet.id,
        createdSheet,
        revision,
        sheets,
      }
    },
    async renameSheet(request) {
      revision += 1
      sheets = sheets.map((sheet) =>
        sheet.id === request.sheetId ? { ...sheet, name: request.name } : sheet,
      )
      return {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
        revision,
        sheets,
      }
    },
    async deleteSheet(request) {
      revision += 1
      const deleteIndex = sheets.findIndex((sheet) => sheet.id === request.sheetId)
      sheets = sheets
        .filter((sheet) => sheet.id !== request.sheetId)
        .map((sheet, index) => ({ ...sheet, index }))
      return {
        sheetId: request.sheetId,
        activeSheetId: sheets[Math.min(deleteIndex, sheets.length - 1)]?.id ?? null,
        revision,
        sheets,
      }
    },
  }

  return backend
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('vNext SpreadsheetSheetTabs', () => {
  it('switches workspace activeSheetId when a tab is clicked', async () => {
    const store = createStore()

    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-1')
    const secondTab = getByRole('tab', { name: 'Sheet Two' })
    fireEvent.click(secondTab)

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(getByRole('tab', { name: 'Sheet Two' }).getAttribute('class')).toContain('is-active')
    expect(getByRole('tab', { name: 'Sheet Two' }).getAttribute('data-active')).toBe('true')
  })

  it('commits a rename draft by Enter through sheet-tab rename intent', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    const firstTab = getByRole('tab', { name: 'Sheet One' })
    fireEvent.doubleClick(firstTab)

    const editor = getByRole('textbox') as HTMLInputElement
    fireEvent.input(editor, { target: { value: 'Renamed Sheet' } })
    editor.focus()
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    )

    await flushAsyncWork()
    expect(store.getter(sheetTabsAtom).lastIntent).toEqual({
      type: 'sheet-tab.rename.commit',
      sheetId: 'sheet-1',
      name: 'Renamed Sheet',
      source: 'pointer',
    })
    expect(store.getter(sheetTabsAtom).rename).toBeNull()
    expect(store.getter(sheetTabsSheetsAtom)[0].name).toBe('Renamed Sheet')
  })

  it('cancels rename draft by Escape', async () => {
    const store = createStore()

    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    fireEvent.doubleClick(getByRole('tab', { name: 'Sheet Two' }))
    const editor = getByRole('textbox')
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(store.getter(sheetTabsAtom).rename).toBeNull()
  })

  it('adds and deletes sheets through the workbook backend', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)

    const { getByRole, getByTestId, queryByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    fireEvent.click(getByTestId('sheet-tab-add'))
    await flushAsyncWork()
    getByRole('tab', { name: 'Sheet3' })

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-3')
    expect(store.getter(sheetTabsSheetsAtom).map((sheet) => sheet.name)).toEqual([
      'Sheet One',
      'Sheet Two',
      'Sheet3',
    ])

    const originalConfirm = window.confirm
    window.confirm = () => true
    try {
      fireEvent.contextMenu(getByRole('tab', { name: 'Sheet3' }))
      fireEvent.click(getByTestId('sheet-tab-menu-delete'))
      await flushAsyncWork()
      expect(queryByRole('tab', { name: 'Sheet3' })).toBeNull()
    } finally {
      window.confirm = originalConfirm
    }

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
  })
})
