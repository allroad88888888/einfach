/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  formulaBarDraftAtom,
  formulaBarStateAtom,
  selectCellAtom,
} from '@einfach/spreadsheet-ui-core'
import { spreadsheetProjectionSnapshotAtom } from '../src-vnext/provider/atoms'
import { SpreadsheetFormulaBar } from '../src-vnext/formula-bar'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function createVisibleProjectionResult(
  window: VisibleProjectionRequest['window'],
  sheetId = 'sheet-1',
): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId,
    requestId: 1,
    window,
    cells: [
      { row: 0, col: 0, displayValue: 'A1', formula: '=1' },
      { row: 0, col: 1, displayValue: 'B1', formula: '=A1+1' },
      { row: 1, col: 0, displayValue: 'A2' },
      { row: 1, col: 1, displayValue: 'B2', formula: '=A1+B1' },
    ],
    revision: 'rev-1',
  }
}

function createBackend(
  readResult: VisibleProjectionResult,
  setCellInputSpy: (request: SetCellInputRequest) => Promise<BackendMutationResult>,
) {
  const readVisibleProjection = jest.fn(async (request: VisibleProjectionRequest) => {
    return readResult
  })

  const backend: SpreadsheetBackend = {
    readVisibleProjection,
    readRangeProjection: async () => {
      throw new Error('not used')
    },
    setCellInput: setCellInputSpy,
  }

  return { backend, readVisibleProjection }
}

describe('vNext SpreadsheetFormulaBar', () => {
  it('shows selected visible cell address and draft from projection snapshot', async () => {
    const store = createStore()
    const window = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const result = createVisibleProjectionResult(window, 'sheet-1')
    const setCellInput = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    const { backend } = createBackend(result, setCellInput)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result,
    })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormulaBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('formula-bar-addr').textContent).toBe('A1'))
    expect((getByTestId('formula-bar-input') as HTMLInputElement).value).toBe('=1')

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 1, col: 1 },
    })
    await waitFor(() => expect(getByTestId('formula-bar-addr').textContent).toBe('B2'))
    expect((getByTestId('formula-bar-input') as HTMLInputElement).value).toBe('=A1+B1')
  })

  it('keeps active cell draft when scrolling moves the visible projection away', async () => {
    const store = createStore()
    const initialWindow = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
    const initialResult = createVisibleProjectionResult(initialWindow, 'sheet-1')
    const setCellInput = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    const { backend } = createBackend(initialResult, setCellInput)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: initialWindow,
        requestId: 1,
      },
      result: initialResult,
    })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormulaBar />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('formula-bar-input') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('=1'))

    const scrolledWindow = { rowStart: 10, rowEnd: 12, colStart: 0, colEnd: 1 }
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window: scrolledWindow,
        requestId: 2,
      },
      result: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        requestId: 2,
        window: scrolledWindow,
        cells: [{ row: 10, col: 0, displayValue: 'A11' }],
        revision: 'rev-2',
      },
    })

    await waitFor(() => expect(input.value).toBe('=1'))
    expect(store.getter(formulaBarStateAtom).draft).toBe('=1')
  })

  it('syncs an empty draft for a visible blank selected cell', async () => {
    const store = createStore()
    const window = { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 2 }
    const result: VisibleProjectionResult = {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      window,
      cells: [],
      revision: 'rev-1',
    }
    const setCellInput = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    const { backend } = createBackend(result, setCellInput)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result,
    })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 2 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormulaBar />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('formula-bar-addr').textContent).toBe('C1'))
    expect((getByTestId('formula-bar-input') as HTMLInputElement).value).toBe('')
  })

  it('submits draft via backend.setCellInput on Enter', async () => {
    const store = createStore()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const result = createVisibleProjectionResult(window, 'sheet-1')
    const setCellInput = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    const { backend, readVisibleProjection } = createBackend(result, setCellInput)

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result,
    })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormulaBar />
      </SpreadsheetUiProvider>
    ))

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const input = getByTestId('formula-bar-input') as HTMLInputElement
    fireEvent.input(input, { target: { value: '=99' } })
    expect(input.value).toBe('=99')
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    )

    await waitFor(() =>
      expect(setCellInput).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'set-cell-input',
          sheetId: 'sheet-1',
          row: 0,
          col: 0,
          input: '=99',
        }),
      ),
    )
    await waitFor(() => expect(readVisibleProjection).toHaveBeenCalledTimes(1))
  })

  it('restores synced draft on Escape', async () => {
    const store = createStore()
    const window = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
    const result = createVisibleProjectionResult(window, 'sheet-1')
    const setCellInput = jest.fn(async () => ({ sheetId: 'sheet-1' }))
    const { backend } = createBackend(result, setCellInput)

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId: 'sheet-1',
        window,
        requestId: 1,
      },
      result,
    })
    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormulaBar />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('formula-bar-input') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'interim' } })
    expect(input.value).toBe('interim')

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      }),
    )

    expect(store.getter(formulaBarDraftAtom)).toBe('=1')
    expect(store.getter(formulaBarStateAtom).draft).toBe('=1')
    await waitFor(() => expect(input.value).toBe('=1'))
  })
})
