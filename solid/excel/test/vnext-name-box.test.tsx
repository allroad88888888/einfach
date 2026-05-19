/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  CellRange,
  NamedRange,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  addSelectionRegionAtom,
  classifyNameBoxInput,
  nameBoxDisplayAtom,
  nameBoxErrorAtom,
  nameBoxInputAtom,
  nameBoxModeAtom,
  nameRegistryCacheAtom,
  primarySelectionRegionAtom,
  selectCellAtom,
  selectionRangeAtom,
  selectionSnapshotAtom,
  setSelectionAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetNameBox } from '../src-vnext/name-box'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function noopBackend(overrides: Partial<SpreadsheetBackend> = {}): SpreadsheetBackend {
  return {
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
    ...overrides,
  }
}

function pressKey(input: HTMLInputElement, key: string, code = key) {
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function setUpStore() {
  const store = createStore()
  store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
  return store
}

describe('classifyNameBoxInput (pure parser)', () => {
  const context = {
    sheetId: 'sheet-1',
    selectionRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } as CellRange,
  }

  it('parses A1 cell references', () => {
    const target = classifyNameBoxInput('B10', [], context)
    expect(target.kind).toBe('cell')
    if (target.kind === 'cell') {
      expect(target.coord).toEqual({ row: 9, col: 1 })
      expect(target.sheetId).toBe('sheet-1')
    }
  })

  it('parses A1 ranges', () => {
    const target = classifyNameBoxInput('B2:D5', [], context)
    expect(target.kind).toBe('range')
    if (target.kind === 'range') {
      expect(target.range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    }
  })

  it('resolves a registered named range', () => {
    const registry: NamedRange[] = [
      {
        name: 'MyRange',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:D4' },
      },
    ]
    const target = classifyNameBoxInput('MyRange', registry, context)
    expect(target.kind).toBe('named-range')
    if (target.kind === 'named-range') {
      expect(target.name).toBe('MyRange')
      expect(target.range).toEqual({ rowStart: 2, rowEnd: 3, colStart: 2, colEnd: 3 })
    }
  })

  it('proposes define-name for a valid new identifier', () => {
    const target = classifyNameBoxInput('NewName', [], context)
    expect(target.kind).toBe('define-name')
    if (target.kind === 'define-name') {
      expect(target.name).toBe('NewName')
      expect(target.range).toEqual(context.selectionRange)
    }
  })

  it('flags unrecognized garbage as invalid', () => {
    const target = classifyNameBoxInput('!!not a name', [], context)
    expect(target.kind).toBe('invalid')
  })
})

describe('SpreadsheetNameBox display', () => {
  it('shows the A1 address for a single-cell selection', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect((getByTestId('name-box-input') as HTMLInputElement).value).toBe('A1')
    })
    expect(store.getter(nameBoxDisplayAtom)).toBe('A1')
  })

  it('shows the matching defined name when selection equals it', async () => {
    const store = setUpStore()
    const named: NamedRange = {
      name: 'MyRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:C3' },
    }
    store.setter(nameRegistryCacheAtom, [named])
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect((getByTestId('name-box-input') as HTMLInputElement).value).toBe('MyRange')
    })
    expect(store.getter(nameBoxDisplayAtom)).toBe('MyRange')
  })

  it('shows only the primary range address when multiple regions exist', async () => {
    const store = setUpStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 5, col: 5 },
        focus: { row: 6, col: 6 },
      },
      makePrimary: true,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      const value = (getByTestId('name-box-input') as HTMLInputElement).value
      expect(value).toBe('F6:G7')
    })

    const primary = store.getter(primarySelectionRegionAtom)
    expect(primary.kind).toBe('range')
  })
})

describe('SpreadsheetNameBox commit', () => {
  it('navigates to an A1 cell on Enter', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'B10' } })
    pressKey(input, 'Enter')

    await waitFor(() => {
      const snapshot = store.getter(selectionSnapshotAtom)
      expect(snapshot.activeCell.row).toBe(9)
      expect(snapshot.activeCell.col).toBe(1)
    })
    expect(store.getter(nameBoxModeAtom)).toBe('idle')
    expect(store.getter(nameBoxErrorAtom)).toBe(false)
  })

  it('selects a range on Enter', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'B2:D5' } })
    pressKey(input, 'Enter')

    await waitFor(() => {
      const range = store.getter(selectionRangeAtom)
      expect(range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    })
  })

  it('jumps to a defined name target', async () => {
    const store = setUpStore()
    store.setter(nameRegistryCacheAtom, [
      {
        name: 'TaxRate',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'D4:E5' },
      },
    ])

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'TaxRate' } })
    pressKey(input, 'Enter')

    await waitFor(() => {
      const range = store.getter(selectionRangeAtom)
      expect(range).toEqual({ rowStart: 3, rowEnd: 4, colStart: 3, colEnd: 4 })
    })
  })

  it('defines a new name via backend.setNamedRange and leaves selection unchanged', async () => {
    const store = setUpStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 2 },
      focus: { row: 4, col: 4 },
    })

    const setNamedRange = jest.fn(async () => ({}))
    const backend = noopBackend({ setNamedRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'BrandNew' } })
    pressKey(input, 'Enter')

    await waitFor(() => expect(setNamedRange).toHaveBeenCalledTimes(1))
    const call = (setNamedRange as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(call).toMatchObject({
      kind: 'set-named-range',
      name: 'BrandNew',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:E5' },
    })

    const range = store.getter(selectionRangeAtom)
    expect(range).toEqual({ rowStart: 2, rowEnd: 4, colStart: 2, colEnd: 4 })
    expect(store.getter(nameBoxErrorAtom)).toBe(false)
  })

  it('reverts and flashes error on invalid input', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: '!!nope' } })
    pressKey(input, 'Enter')

    await waitFor(() => expect(store.getter(nameBoxErrorAtom)).toBe(true))
    expect(store.getter(nameBoxInputAtom)).toBe('A1')
    expect(store.getter(selectionSnapshotAtom).activeCell.row).toBe(0)
    expect(store.getter(selectionSnapshotAtom).activeCell.col).toBe(0)
  })

  it('Escape reverts without committing', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'Z99' } })
    pressKey(input, 'Escape')

    expect(store.getter(nameBoxInputAtom)).toBe('A1')
    expect(store.getter(selectionSnapshotAtom).activeCell.row).toBe(0)
    expect(store.getter(nameBoxErrorAtom)).toBe(false)
  })

  it('blur with unchanged input is a no-op', async () => {
    const store = setUpStore()
    const setNamedRange = jest.fn(async () => ({}))
    const backend = noopBackend({ setNamedRange })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.blur(input)

    await waitFor(() => expect(store.getter(nameBoxModeAtom)).toBe('idle'))
    expect(setNamedRange).not.toHaveBeenCalled()
    expect(store.getter(selectionSnapshotAtom).activeCell.row).toBe(0)
  })
})
