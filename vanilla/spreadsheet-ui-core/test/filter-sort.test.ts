import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src'
import {
  MAX_FILTER_LIST_VALUES,
  clearColumnFilterSortAtom,
  clearFilterSortAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortErrorAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  issueFilterSortSyncTicketAtom,
  notifyActiveSheetChangedAtom,
  openFilterDropdownAtom,
  setFilterSortAtom,
  setFilterSortErrorAtom,
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

describe('clearColumnFilterSortAtom', () => {
  test('removes both rules and directives for the column', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: {
        rules: [
          { kind: 'equals', colIndex: 1, value: 'x' },
          { kind: 'equals', colIndex: 2, value: 'y' },
        ],
        directives: [
          { colIndex: 1, direction: 'asc' },
          { colIndex: 2, direction: 'desc' },
        ],
      },
    })
    store.setter(clearColumnFilterSortAtom, { sheetId: 'A', colIndex: 1 })
    const state = store.getter(filterSortStateAtom)['A']
    expect(state?.rules).toEqual([{ kind: 'equals', colIndex: 2, value: 'y' }])
    expect(state?.directives).toEqual([{ colIndex: 2, direction: 'desc' }])
  })

  test('no-op when sheet has no state', () => {
    const store = makeStore()
    store.setter(clearColumnFilterSortAtom, { sheetId: 'missing', colIndex: 0 })
    expect(store.getter(filterSortStateAtom)).toEqual({})
  })

  test('no-op when column has neither rule nor directive', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, {
      sheetId: 'A',
      state: {
        rules: [{ kind: 'equals', colIndex: 1, value: 'x' }],
        directives: [{ colIndex: 1, direction: 'asc' }],
      },
    })
    const before = store.getter(filterSortStateAtom)
    store.setter(clearColumnFilterSortAtom, { sheetId: 'A', colIndex: 9 })
    expect(store.getter(filterSortStateAtom)).toBe(before)
  })
})

describe('setFilterSortErrorAtom', () => {
  test('initial error is empty string', () => {
    const store = makeStore()
    expect(store.getter(filterSortErrorAtom)).toBe('')
  })

  test('stores Error.message', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, new Error('boom'))
    expect(store.getter(filterSortErrorAtom)).toBe('boom')
  })

  test('stores non-Error stringified', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, 'plain')
    expect(store.getter(filterSortErrorAtom)).toBe('plain')
  })

  test('null clears the error', () => {
    const store = makeStore()
    store.setter(setFilterSortErrorAtom, new Error('boom'))
    store.setter(setFilterSortErrorAtom, null)
    expect(store.getter(filterSortErrorAtom)).toBe('')
  })
})

describe('issueFilterSortSyncTicketAtom', () => {
  test('starts at 0 and each issue returns a monotonically increasing ticket', () => {
    const store = makeStore()
    expect(store.getter(filterSortSyncTicketAtom)).toBe(0)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(1)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(2)
    expect(store.setter(issueFilterSortSyncTicketAtom)).toBe(3)
    expect(store.getter(filterSortSyncTicketAtom)).toBe(3)
  })

  test('two separate stores have independent ticket counters', () => {
    const a = makeStore()
    const b = makeStore()
    a.setter(issueFilterSortSyncTicketAtom)
    a.setter(issueFilterSortSyncTicketAtom)
    expect(a.getter(filterSortSyncTicketAtom)).toBe(2)
    expect(b.getter(filterSortSyncTicketAtom)).toBe(0)
    expect(b.setter(issueFilterSortSyncTicketAtom)).toBe(1)
    expect(a.getter(filterSortSyncTicketAtom)).toBe(2)
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

describe('notifyActiveSheetChangedAtom', () => {
  test('dropdown already closed — stays closed after sheet switch', () => {
    const store = makeStore()
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })

  test('dropdown open on sheet A — closes when switching to sheet B', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'closed' })
  })

  test('dropdown open on sheet A — stays open when notified with same sheet A', () => {
    const store = makeStore()
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 2 })
    store.setter(notifyActiveSheetChangedAtom, 'A')
    expect(store.getter(filterDropdownAtom)).toEqual({ status: 'open', sheetId: 'A', colIndex: 2 })
  })

  test('filterSortStateAtom is untouched by sheet switch notification', () => {
    const store = makeStore()
    store.setter(setFilterSortAtom, { sheetId: 'A', state: emptyState })
    store.setter(openFilterDropdownAtom, { sheetId: 'A', colIndex: 0 })
    store.setter(notifyActiveSheetChangedAtom, 'B')
    expect(store.getter(filterSortStateAtom)['A']).toEqual(emptyState)
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
