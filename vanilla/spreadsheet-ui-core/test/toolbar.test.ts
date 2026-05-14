import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  closeToolbarSurfaceAtom,
  dispatchToolbarFormatCommandAtom,
  openToolbarDropdownAtom,
  openToolbarPaletteAtom,
  toolbarActiveSurfaceAtom,
  toolbarCommandAvailabilityAtom,
  toolbarIntentAtom,
  clearToolbarIntentAtom,
} from '../src/toolbar'
import { selectAllAtom, selectCellAtom, selectRowsAtom } from '../src/selection'
import { startEditingAtom } from '../src/editing'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

describe('toolbar core', () => {
  test('tracks the active dropdown and palette surface', () => {
    const store = createStore()

    store.setter(openToolbarDropdownAtom, { dropdown: 'number-format' })
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
      kind: 'dropdown',
      id: 'number-format',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: {
        kind: 'dropdown',
        id: 'number-format',
      },
    })

    store.setter(openToolbarPaletteAtom, { palette: 'text-color' })
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
      kind: 'palette',
      id: 'text-color',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: {
        kind: 'palette',
        id: 'text-color',
      },
    })

    store.setter(closeToolbarSurfaceAtom)
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual(null)
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.close',
      source: 'toolbar',
    })
  })

  test('derives command availability from selection kind and editing mode', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 1, col: 1 },
    })

    expect(store.getter(toolbarCommandAvailabilityAtom)).toEqual({
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      editingMode: 'idle',
      bold: true,
      italic: true,
      textColor: true,
      fillColor: true,
      numberFormat: true,
      alignment: true,
    })

    store.setter(selectRowsAtom, {
      sheetId: 'Sheet1',
      rowAnchor: 2,
      rowFocus: 4,
    })
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'row',
      editingMode: 'idle',
      bold: true,
      italic: true,
      textColor: true,
      fillColor: true,
      numberFormat: false,
      alignment: true,
    })

    store.setter(selectAllAtom)
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'all',
      editingMode: 'idle',
      bold: false,
      italic: false,
      textColor: false,
      fillColor: false,
      numberFormat: false,
      alignment: false,
    })

    store.setter(startEditingAtom, {
      sheetId: 'Sheet1',
      cell: { row: 1, col: 1 },
      draft: 'abc',
      source: 'cell',
    })
    expect(store.getter(toolbarCommandAvailabilityAtom)).toMatchObject({
      sheetId: 'Sheet1',
      selectionKind: 'all',
      editingMode: 'drafting',
      bold: false,
      italic: false,
      textColor: false,
      fillColor: false,
      numberFormat: false,
      alignment: false,
    })
  })

  test('dispatches a format command intent for backend adapters', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 3, col: 2 },
    })

    const intent = store.setter(dispatchToolbarFormatCommandAtom, {
      command: 'text-color',
      value: '#ff0000',
    })

    expect(intent).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      command: 'text-color',
      value: '#ff0000',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual(intent)
  })

  test('clears the last toolbar intent after dispatch', () => {
    const store = createStore()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 0, col: 0 },
    })
    store.setter(dispatchToolbarFormatCommandAtom, {
      command: 'bold',
    })

    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      command: 'bold',
      value: null,
    })

    store.setter(clearToolbarIntentAtom)
    expect(store.getter(toolbarIntentAtom)).toEqual(null)
  })
})
