/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createStore } from '@einfach/core'
import {
  selectionRegionsAtom,
  selectionSnapshotAtom,
  setMultiRegionSelectionAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  workspaceSessionAtom,
  reorderSheetMetadata,
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
        requestId: request.requestId,
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
        requestId: request.requestId,
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
        requestId: request.requestId,
        sheetId: request.sheetId,
        activeSheetId: sheets[Math.min(deleteIndex, sheets.length - 1)]?.id ?? null,
        revision,
        sheets,
      }
    },
    async reorderSheet(request) {
      revision += 1
      sheets = reorderSheetMetadata(sheets, request)
      return {
        requestId: request.requestId,
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
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

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  coordinates: { clientX?: number; clientY?: number },
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: coordinates.clientX ?? 0,
      clientY: coordinates.clientY ?? 0,
    }),
  )
}

describe('vNext SpreadsheetSheetTabs', () => {
  it('switches workspace activeSheetId when a tab is clicked', async () => {
    const store = createStore()
    store.setter(setMultiRegionSelectionAtom, {
      regions: [
        {
          kind: 'range',
          sheetId: 'sheet-1',
          anchor: { row: 1, col: 1 },
          focus: { row: 3, col: 3 },
        },
        {
          kind: 'cell',
          sheetId: 'sheet-1',
          anchor: { row: 6, col: 6 },
          focus: { row: 6, col: 6 },
        },
      ],
      primaryIndex: 0,
    })

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
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-2',
      row: 3,
      col: 3,
    })
    expect(store.getter(selectionRegionsAtom)).toEqual([
      {
        kind: 'cell',
        sheetId: 'sheet-2',
        anchor: { row: 3, col: 3 },
        focus: { row: 3, col: 3 },
      },
    ])
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
    store.setter(setMultiRegionSelectionAtom, {
      regions: [
        {
          kind: 'range',
          sheetId: 'sheet-1',
          anchor: { row: 1, col: 1 },
          focus: { row: 4, col: 2 },
        },
        {
          kind: 'cell',
          sheetId: 'sheet-1',
          anchor: { row: 7, col: 7 },
          focus: { row: 7, col: 7 },
        },
      ],
      primaryIndex: 0,
    })
    fireEvent.click(getByTestId('sheet-tab-add'))
    await flushAsyncWork()
    getByRole('tab', { name: 'Sheet3' })

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-3')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-3',
      row: 4,
      col: 2,
    })
    expect(store.getter(selectionRegionsAtom)).toHaveLength(1)
    expect(store.getter(sheetTabsSheetsAtom).map((sheet) => sheet.name)).toEqual([
      'Sheet One',
      'Sheet Two',
      'Sheet3',
    ])

    fireEvent.contextMenu(getByRole('tab', { name: 'Sheet3' }))
    fireEvent.click(getByTestId('sheet-tab-menu-delete'))
    expect(getByRole('dialog').textContent).toContain('Delete sheet “Sheet3”?')
    fireEvent.click(getByTestId('sheet-tab-delete-confirm'))
    await flushAsyncWork()
    expect(queryByRole('tab', { name: 'Sheet3' })).toBeNull()

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-2',
      row: 4,
      col: 2,
    })
  })

  it('reorders sheet tabs through pointer drag and preserves the active sheet', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
      { id: 'sheet-3', name: 'Sheet Three', index: 2 },
    ]
    const backend = createFakeBackend(sheets)

    const { getByRole, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    fireEvent.click(getByRole('tab', { name: 'Sheet Two' }))
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')

    const handle = getByTestId('sheet-tab-reorder-sheet-3')
    const firstTabItem = getByRole('tab', { name: 'Sheet One' }).closest(
      '[data-sheet-tab-item]',
    ) as HTMLElement
    const originalElementFromPoint = document.elementFromPoint

    document.elementFromPoint = () => firstTabItem
    try {
      dispatchPointerEvent(handle, 'pointerdown', { clientX: 80, clientY: 20 })
      await flushAsyncWork()
      dispatchPointerEvent(window, 'pointermove', { clientX: -1, clientY: 20 })
      await flushAsyncWork()
      dispatchPointerEvent(window, 'pointerup', { clientX: -1, clientY: 20 })
      await flushAsyncWork()
    } finally {
      document.elementFromPoint = originalElementFromPoint
    }

    expect(store.getter(sheetTabsAtom).lastIntent).toMatchObject({
      type: 'sheet-tab.reorder.commit',
      sheetId: 'sheet-3',
      beforeSheetId: 'sheet-1',
    })
    expect(store.getter(sheetTabsSheetsAtom).map((sheet) => sheet.name)).toEqual([
      'Sheet Three',
      'Sheet One',
      'Sheet Two',
    ])
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
  })

  it('disables commands with an explanation when the live list port is missing', async () => {
    const store = createStore()
    const sheets = [{ id: 'sheet-1', name: 'Sheet One', index: 0 }]
    const backend = createFakeBackend(sheets)
    backend.listSheets = undefined

    const { getByRole, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    expect(getByRole('tab', { name: 'Sheet One' }).isConnected).toBe(true)
    const addButton = getByTestId('sheet-tab-add') as HTMLButtonElement
    expect(addButton.disabled).toBe(true)
    expect(addButton.getAttribute('title')).toBe(
      'Add sheet is unavailable without a live sheet list',
    )
    expect(getByRole('alert').textContent).toContain(
      'Live sheet list is unavailable; sheet changes are disabled',
    )
  })

  it('keeps a rejected rename draft and reports the backend error inline', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)
    backend.renameSheet = async () => {
      throw new Error('duplicate sheet name')
    }

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    fireEvent.doubleClick(getByRole('tab', { name: 'Sheet One' }))
    const editor = getByRole('textbox') as HTMLInputElement
    fireEvent.input(editor, { target: { value: 'Sheet Two' } })
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await flushAsyncWork()

    expect((getByRole('textbox') as HTMLInputElement).value).toBe('Sheet Two')
    expect(getByRole('alert').textContent).toContain('duplicate sheet name')
    expect(store.getter(sheetTabsAtom)).toMatchObject({
      rename: { sheetId: 'sheet-1', draftName: 'Sheet Two' },
      lastMutation: { outcome: 'rejected' },
    })
    expect(store.getter(sheetTabsSheetsAtom)[0]?.name).toBe('Sheet One')
  })

  it('ignores a mismatched rename response without changing the visible sheet list', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)
    backend.renameSheet = async (request) => ({
      requestId: (request.requestId ?? 0) + 1,
      sheetId: request.sheetId,
      activeSheetId: request.sheetId,
      revision: 1,
      sheets: sheets.map((sheet) =>
        sheet.id === request.sheetId ? { ...sheet, name: request.name } : sheet,
      ),
    })

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    fireEvent.doubleClick(getByRole('tab', { name: 'Sheet One' }))
    const editor = getByRole('textbox') as HTMLInputElement
    fireEvent.input(editor, { target: { value: 'Renamed' } })
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await flushAsyncWork()

    expect((getByRole('textbox') as HTMLInputElement).value).toBe('Renamed')
    expect(getByRole('alert').textContent).toContain(
      'Ignored a sheet mutation response that did not match its request',
    )
    expect(store.getter(sheetTabsAtom)).toMatchObject({
      rename: { sheetId: 'sheet-1', draftName: 'Renamed' },
      lastMutation: { outcome: 'protocol-error' },
    })
    expect(store.getter(sheetTabsSheetsAtom).map((sheet) => sheet.name)).toEqual([
      'Sheet One',
      'Sheet Two',
    ])
  })

  it('disables the add command while pending and does not dispatch duplicates', async () => {
    const store = createStore()
    const sheets = [
      { id: 'sheet-1', name: 'Sheet One', index: 0 },
      { id: 'sheet-2', name: 'Sheet Two', index: 1 },
    ]
    const backend = createFakeBackend(sheets)
    let addCalls = 0
    let settleAdd: (() => void) | undefined
    backend.addSheet = (request) => {
      addCalls += 1
      return new Promise((resolve) => {
        settleAdd = () => {
          const createdSheet = { id: 'sheet-3', name: 'Sheet3', index: 2 }
          resolve({
            requestId: request.requestId,
            sheetId: createdSheet.id,
            activeSheetId: createdSheet.id,
            createdSheet,
            sheets: [...sheets, createdSheet],
          })
        }
      })
    }

    const { getByRole, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    await flushAsyncWork()
    const addButton = getByTestId('sheet-tab-add') as HTMLButtonElement
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    expect(addCalls).toBe(1)
    await flushAsyncWork()
    expect(addButton.disabled).toBe(true)
    expect(addButton.getAttribute('title')).toBe('Another sheet change is in progress')

    settleAdd?.()
    await flushAsyncWork()
    expect(getByRole('tab', { name: 'Sheet3' }).isConnected).toBe(true)
    expect(addButton.disabled).toBe(false)
  })
})
