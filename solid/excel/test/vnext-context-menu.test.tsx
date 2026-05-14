/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { menuCommandIntentAtom, menuStateAtom, openMenuAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetContextMenu } from '../src-vnext/context-menu'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function createFakeBackend(): SpreadsheetBackend {
  return {
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
}

describe('vNext SpreadsheetContextMenu', () => {
  it('renders open menu state including position and target metadata', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 1, col: 2 },
      },
      position: { x: 14.7, y: 8.9 },
      source: 'pointer',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const menu = await waitFor(() => getByTestId('spreadsheet-context-menu'))

    expect(menu.style.left).toBe('14px')
    expect(menu.style.top).toBe('8px')
    expect(menu.getAttribute('data-menu-target-kind')).toBe('cell')
    expect(menu.getAttribute('data-menu-target-sheet-id')).toBe('sheet-1')
    expect(getByTestId('context-menu-command-clipboard.copy').textContent).toBe('Copy')
    expect(getByTestId('context-menu-command-cell.clear').textContent).toBe('Delete')
  })

  it('dispatches a menu.command intent when Delete is clicked', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'cell',
        sheetId: 'sheet-1',
        cell: { row: 3, col: 4 },
      },
      position: { x: 0, y: 0 },
      source: 'keyboard',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    const deleteButton = getByTestId('context-menu-command-cell.clear')
    fireEvent.click(deleteButton)

    await waitFor(() =>
      expect(store.getter(menuCommandIntentAtom)).toEqual({
        type: 'menu.command',
        command: 'cell.clear',
        surface: 'context',
        target: {
          kind: 'cell',
          sheetId: 'sheet-1',
          cell: { row: 3, col: 4 },
        },
      }),
    )

    await waitFor(() => expect(store.getter(menuStateAtom).status).toBe('closed'))
  })

  it('dismisses menu on outside mousedown', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(openMenuAtom, {
      surface: 'context',
      target: {
        kind: 'row',
        sheetId: 'sheet-1',
        rowIndex: 2,
      },
      position: { x: 0, y: 0 },
      source: 'pointer',
    })

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetContextMenu />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('spreadsheet-context-menu')).toBeTruthy()

    fireEvent.mouseDown(document.body)

    await waitFor(() => {
      expect(queryByTestId('spreadsheet-context-menu')).toBeNull()
      expect(store.getter(menuStateAtom).status).toBe('closed')
    })
  })
})
