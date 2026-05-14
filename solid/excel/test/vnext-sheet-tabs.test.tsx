/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createStore } from '@einfach/core'
import { sheetTabsAtom, workspaceSessionAtom } from '@einfach/spreadsheet-ui-core'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetSheetTabs } from '../src-vnext/sheet-tabs'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

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

describe('vNext SpreadsheetSheetTabs', () => {
  it('switches workspace activeSheetId when a tab is clicked', () => {
    const store = createStore()
    const backend = createFakeBackend()

    const sheets = [
      { id: 'sheet-1', name: 'Sheet One' },
      { id: 'sheet-2', name: 'Sheet Two' },
    ]

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    const secondTab = getByRole('tab', { name: 'Sheet Two' })
    fireEvent.click(secondTab)

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(getByRole('tab', { name: 'Sheet Two' }).getAttribute('class')).toContain('is-active')
    expect(getByRole('tab', { name: 'Sheet Two' }).getAttribute('data-active')).toBe('true')
  })

  it('commits a rename draft by Enter through sheet-tab rename intent', () => {
    const store = createStore()
    const backend = createFakeBackend()

    const sheets = [
      { id: 'sheet-1', name: 'Sheet One' },
      { id: 'sheet-2', name: 'Sheet Two' },
    ]

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    const firstTab = getByRole('tab', { name: 'Sheet One' })
    fireEvent.dblClick(firstTab)

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

    expect(store.getter(sheetTabsAtom).lastIntent).toEqual({
      type: 'sheet-tab.rename.commit',
      sheetId: 'sheet-1',
      name: 'Renamed Sheet',
      source: 'pointer',
    })
    expect(store.getter(sheetTabsAtom).rename).toBeNull()
  })

  it('cancels rename draft by Escape', () => {
    const store = createStore()
    const backend = createFakeBackend()

    const sheets = [
      { id: 'sheet-1', name: 'Sheet One' },
      { id: 'sheet-2', name: 'Sheet Two' },
    ]

    const { getByRole } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetSheetTabs sheets={sheets} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.dblClick(getByRole('tab', { name: 'Sheet Two' }))
    const editor = getByRole('textbox')
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(store.getter(sheetTabsAtom).rename).toBeNull()
  })
})
