/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  dispatchToolbarFormatCommandAtom,
  selectCellAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider, spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider'
import { SpreadsheetStatusBar } from '../src-vnext/status-bar'

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

describe('vNext SpreadsheetStatusBar', () => {
  it('shows active address, selection, projection status, and visible metrics', () => {
    const store = createStore()
    const backend = createFakeBackend()
    const window = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 4 }

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 1, col: 2 },
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
        cells: [
          { row: 1, col: 2, displayValue: 'C2' },
          { row: 5, col: 4, displayValue: 'E6' },
        ],
      },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('status-active-cell').textContent).toBe('C2')
    expect(getByTestId('status-selection').textContent).toBe('C2')
    expect(getByTestId('status-projection').textContent).toBe('Ready')
    expect(getByTestId('status-visible-cells').textContent).toBe('30 cells')
    expect(getByTestId('status-loaded-values').textContent).toBe('2 loaded')
    expect(getByTestId('status-last-command').textContent).toBe('Ready')
  })

  it('updates from core selection and toolbar atoms', async () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetStatusBar />
      </SpreadsheetUiProvider>
    ))

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 2, col: 2 },
      extend: true,
    })
    store.setter(dispatchToolbarFormatCommandAtom, { command: 'bold' })

    await waitFor(() => expect(getByTestId('status-active-cell').textContent).toBe('C3'))
    expect(getByTestId('status-selection').textContent).toBe('A1:C3')
    expect(getByTestId('status-last-command').textContent).toBe('Toolbar bold')
  })
})
