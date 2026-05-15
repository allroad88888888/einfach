import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src'
import {
  MAX_FILTER_LIST_VALUES,
  clearFilterSortAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortStateAtom,
  openFilterDropdownAtom,
  setFilterSortAtom,
} from '../src'
import type { FilterSortState } from '../src'

function makeStore() {
  return createStore()
}

const emptyState: FilterSortState = { rules: [], directives: [] }

describe('filterSortStateAtom', () => {
  test('initial state is empty map', () => {
    const store = makeStore()
    expect(store.getter(filterSortStateAtom)).toEqual({})
  })
})

describe('filterDropdownAtom', () => {
  test('initial state is closed', () => {
    const store = makeStore()
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })
})

describe('setFilterSortAtom', () => {
  test('stores state per sheet', () => {
    const store = makeStore()
    const state: FilterSortState = {
      rules: [{ kind: 'equals', colIndex: 0, value: 'foo' }],
      directives: [{ colIndex: 0, direction: 'asc' }],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    expect(store.getter(filterSortStateAtom)['A']).toEqual(state)
  })

  test('subsequent set for same sheet overwrites', () => {
    const store = makeStore()
    const s1: FilterSortState = { rules: [{ kind: 'equals', colIndex: 0, value: 'a' }], directives: [] }
    const s2: FilterSortState = { rules: [{ kind: 'contains', colIndex: 1, value: 'b' }], directives: [] }
    store.setter(setFilterSortAtom, { sheetId: 'A', state: s1 })
    store.setter(setFilterSortAtom, { sheetId: 'A', state: s2 })
    expect(store.getter(filterSortStateAtom)['A']).toEqual(s2)
  })

  test('set for different sheets adds new entry', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(setFilterSortAtom, { sheetId: 'B', state: emptyState })
    const bySheet = store.getter(filterSortStateAtom)
    expect(Object.keys(bySheet).sort()).toEqual(['A', 'B'])
  })

  test('list rule with 10001 values is truncated to MAX_FILTER_LIST_VALUES', () => {
    const store = makeStore()
    const values = Array.from({ length: MAX_FILTER_LIST_VALUES + 1 }, (_, i) => String(i))
    const state: FilterSortState = {
      rules: [{ kind: 'list', colIndex: 0, values }],
      directives: [],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    const stored = store.getter(filterSortStateAtom)['A']
    const rule = stored.rules[0]
    expect(rule.kind).toBe('list')
    if (rule.kind === 'list') {
      expect(rule.values.length).toBe(MAX_FILTER_LIST_VALUES)
    }
  })

  test('list rule at exactly MAX_FILTER_LIST_VALUES is kept intact', () => {
    const store = makeStore()
    const values = Array.from({ length: MAX_FILTER_LIST_VALUES }, (_, i) => String(i))
    const state: FilterSortState = {
      rules: [{ kind: 'list', colIndex: 0, values }],
      directives: [],
    }
    store.setter(setFilterSortAtom, { sheetId: 'A', state })
    const stored = store.getter(filterSortStateAtom)['A']
    const rule = stored.rules[0]
    if (rule.kind === 'list') {
      expect(rule.values.length).toBe(MAX_FILTER_LIST_VALUES)
    }
  })
})

describe('clearFilterSortAtom', () => {
  test('removes the sheet entry', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(setFilterSortAtom, { sheetId: 'B', state: emptyState })
    store.setter(clearFilterSortAtom, 'A')
    const bySheet = store.getter(filterSortStateAtom)
    expect('A' in bySheet).toBe(false)
    expect('B' in bySheet).toBe(true)
  })

  test('closes any open dropdown', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(clearFilterSortAtom, 'A')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })
})

describe('openFilterDropdownAtom', () => {
  test('sets dropdown to open with sheetId and colIndex', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 3 })
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'X', colIndex: 3 })
  })

  test('replaces existing open dropdown when called again', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 1 })
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 5 })
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'X', colIndex: 5 })
  })
})

describe('closeFilterDropdownAtom', () => {
  test('resets dropdown to closed', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'X', colIndex: 0 })
    store.setter(closeFilterDropdownAtom)
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })
})

describe('DisplayCell.originalRow', () => {
  test('accepts originalRow alongside row (type-check)', () => {
    const cell: DisplayCell = {
      row: 5,
      col: 2,
      displayValue: 'hello',
      originalRow: 42,
    }
    expect(cell.originalRow).toBe(42)
    expect(cell.row).toBe(5)
  })

  test('originalRow is optional', () => {
    const cell: DisplayCell = { row: 0, col: 0, displayValue: '' }
    expect(cell.originalRow).toBeUndefined()
  })
})
