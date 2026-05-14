import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  activeCellAtom,
  selectAllAtom,
  selectCellAtom,
  selectColumnsAtom,
  selectRowsAtom,
  selectionAtom,
  selectionRangeAtom,
  setSelectionBoundsAtom,
  setSelectionAtom,
} from '../src/selection'

describe('selection core', () => {
  test('clamps cell selection to sheet bounds', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 20, col: 9 },
    })

    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 9,
      col: 4,
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 9,
      rowEnd: 9,
      colStart: 4,
      colEnd: 4,
    })
  })

  test('extends ranges by keeping only anchor and focus boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 1_000_000, colCount: 16_000 })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 2, col: 3 },
    })
    store.setter(selectCellAtom, {
      coord: { row: 999_999, col: 15_999 },
      extend: true,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 3 },
      focus: { row: 999_999, col: 15_999 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 999_999,
      colStart: 3,
      colEnd: 15_999,
    })
    expect('cells' in store.getter(selectionAtom)).toBe(false)
  })

  test('derives row, column, and all selections from boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(selectRowsAtom, {
      sheetId: 'Sheet1',
      rowAnchor: 4,
      rowFocus: 2,
    })

    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 4,
      colStart: 0,
      colEnd: 4,
    })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 2,
      col: 0,
    })

    store.setter(selectColumnsAtom, {
      colAnchor: 3,
      colFocus: 1,
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 1,
      colEnd: 3,
    })

    store.setter(selectAllAtom)
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 4,
    })
  })

  test('normalizes direct selection writes', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 50, col: -5 },
      focus: { row: 50, col: -5 },
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 9, col: 0 },
      focus: { row: 9, col: 0 },
    })
  })
})
