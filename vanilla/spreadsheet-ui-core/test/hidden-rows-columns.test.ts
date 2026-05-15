import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  DEFAULT_VIEWPORT_HIDDEN_STATE,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  isColumnHidden,
  isRowHidden,
  setViewportHiddenAtom,
  viewportHiddenAtom,
} from '../src'

describe('viewportHiddenAtom', () => {
  test('initial hidden state is empty', () => {
    const store = createStore()
    expect(store.getter(viewportHiddenAtom)).toEqual(DEFAULT_VIEWPORT_HIDDEN_STATE)
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('setViewportHiddenAtom stores sorted dedup rows', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
  })

  test('negative or non-integer indices are dropped', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [-1, 0.5, 2, 3.0] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([2, 3])
  })

  test('updating cols only leaves rows untouched', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 1, 5] })
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1, 3, 5])
    expect(state.colsBySheet['A']).toEqual([2])
  })

  test('does not overwrite sibling sheets', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [1], cols: [0] })
    store.setter(setViewportHiddenAtom, { sheetId: 'B', rows: [4], cols: [7] })
    const state = store.getter(viewportHiddenAtom)
    expect(state.rowsBySheet['A']).toEqual([1])
    expect(state.rowsBySheet['B']).toEqual([4])
    expect(state.colsBySheet['A']).toEqual([0])
    expect(state.colsBySheet['B']).toEqual([7])
  })
})

describe('isRowHidden / isColumnHidden', () => {
  test('isRowHidden returns true for a hidden row', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', rows: [3, 1, 5] })
    const state = store.getter(viewportHiddenAtom)
    expect(isRowHidden(state, 'A', 3)).toBe(true)
    expect(isRowHidden(state, 'A', 4)).toBe(false)
  })

  test('isRowHidden returns false for unknown sheet', () => {
    expect(isRowHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })

  test('isColumnHidden is symmetric', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'A', cols: [2, 7] })
    const state = store.getter(viewportHiddenAtom)
    expect(isColumnHidden(state, 'A', 2)).toBe(true)
    expect(isColumnHidden(state, 'A', 3)).toBe(false)
    expect(isColumnHidden(state, 'A', 7)).toBe(true)
  })

  test('isColumnHidden returns false for unknown sheet', () => {
    expect(isColumnHidden(DEFAULT_VIEWPORT_HIDDEN_STATE, 'X', 0)).toBe(false)
  })
})

describe('getHiddenRowsForSheet / getHiddenColumnsForSheet', () => {
  test('returns empty array for unknown sheet', () => {
    expect(getHiddenRowsForSheet(DEFAULT_VIEWPORT_HIDDEN_STATE, 'unknown')).toEqual([])
    expect(getHiddenColumnsForSheet(DEFAULT_VIEWPORT_HIDDEN_STATE, 'unknown')).toEqual([])
  })

  test('returns stored sorted indices for known sheet', () => {
    const store = createStore()
    store.setter(setViewportHiddenAtom, { sheetId: 'S', rows: [9, 2, 4], cols: [5, 1] })
    const state = store.getter(viewportHiddenAtom)
    expect(getHiddenRowsForSheet(state, 'S')).toEqual([2, 4, 9])
    expect(getHiddenColumnsForSheet(state, 'S')).toEqual([1, 5])
  })
})
