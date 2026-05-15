import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src/backend/types'
import {
  MAX_UNLOCKED_RANGES,
  DEFAULT_SHEET_PROTECTION,
  sheetProtectionAtom,
  setSheetProtectionAtom,
  clearSheetProtectionAtom,
  activeCellLockedAtom,
  selectionLockedAtom,
  getSheetProtection,
  rangesIntersect,
  isCoordUnlocked,
  isRangeFullyUnlocked,
  isRangePartiallyUnlocked,
} from '../src/protection'
import { selectionAtom } from '../src/selection'

describe('protection constants', () => {
  test('MAX_UNLOCKED_RANGES is 256', () => {
    expect(MAX_UNLOCKED_RANGES).toBe(256)
  })

  test('DEFAULT_SHEET_PROTECTION is open with empty ranges', () => {
    expect(DEFAULT_SHEET_PROTECTION).toEqual({ mode: 'open', unlockedRanges: [] })
  })
})

describe('sheetProtectionAtom', () => {
  test('initial state is empty map', () => {
    const store = createStore()
    expect(store.getter(sheetProtectionAtom)).toEqual({})
  })

  test('setSheetProtectionAtom stores per-sheet state', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'A',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 }] },
    })
    const state = store.getter(sheetProtectionAtom)
    expect(state['A']).toEqual({
      mode: 'protected',
      unlockedRanges: [{ rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 }],
    })
  })

  test('setSheetProtectionAtom truncates unlockedRanges at MAX_UNLOCKED_RANGES', () => {
    const store = createStore()
    const ranges = Array.from({ length: 257 }, (_, i) => ({
      rowStart: i,
      rowEnd: i,
      colStart: 0,
      colEnd: 0,
    }))
    store.setter(setSheetProtectionAtom, {
      sheetId: 'B',
      state: { mode: 'protected', unlockedRanges: ranges },
    })
    const state = store.getter(sheetProtectionAtom)
    expect(state['B'].unlockedRanges).toHaveLength(MAX_UNLOCKED_RANGES)
  })

  test('clearSheetProtectionAtom removes entry', () => {
    const store = createStore()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'A',
      state: { mode: 'protected', unlockedRanges: [] },
    })
    store.setter(clearSheetProtectionAtom, 'A')
    expect(store.getter(sheetProtectionAtom)['A']).toBeUndefined()
  })
})

describe('getSheetProtection', () => {
  test('returns DEFAULT_SHEET_PROTECTION for unknown sheetId', () => {
    expect(getSheetProtection({}, 'unknown')).toEqual(DEFAULT_SHEET_PROTECTION)
  })

  test('returns stored protection for known sheetId', () => {
    const state = { S: { mode: 'protected' as const, unlockedRanges: [] } }
    expect(getSheetProtection(state, 'S')).toEqual({ mode: 'protected', unlockedRanges: [] })
  })
})

describe('rangesIntersect', () => {
  const a = { rowStart: 2, rowEnd: 5, colStart: 2, colEnd: 5 }

  test('overlapping ranges intersect', () => {
    const b = { rowStart: 3, rowEnd: 7, colStart: 3, colEnd: 7 }
    expect(rangesIntersect(a, b)).toBe(true)
  })

  test('adjacent row ranges do not intersect', () => {
    const b = { rowStart: 6, rowEnd: 8, colStart: 2, colEnd: 5 }
    expect(rangesIntersect(a, b)).toBe(false)
  })

  test('adjacent col ranges do not intersect', () => {
    const b = { rowStart: 2, rowEnd: 5, colStart: 6, colEnd: 8 }
    expect(rangesIntersect(a, b)).toBe(false)
  })

  test('touching corner ranges do not intersect', () => {
    const b = { rowStart: 6, rowEnd: 8, colStart: 6, colEnd: 8 }
    expect(rangesIntersect(a, b)).toBe(false)
  })

  test('fully contained range intersects', () => {
    const b = { rowStart: 3, rowEnd: 4, colStart: 3, colEnd: 4 }
    expect(rangesIntersect(a, b)).toBe(true)
  })
})

describe('isCoordUnlocked', () => {
  test('open sheet: any coord is unlocked', () => {
    const state = { S: { mode: 'open' as const, unlockedRanges: [] } }
    expect(isCoordUnlocked(state, 'S', { row: 100, col: 100 })).toBe(true)
  })

  test('unknown sheet (defaults to open): coord is unlocked', () => {
    expect(isCoordUnlocked({}, 'X', { row: 0, col: 0 })).toBe(true)
  })

  test('protected sheet: coord inside unlocked range is unlocked', () => {
    const state = {
      S: {
        mode: 'protected' as const,
        unlockedRanges: [{ rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 3 }],
      },
    }
    expect(isCoordUnlocked(state, 'S', { row: 2, col: 2 })).toBe(true)
  })

  test('protected sheet: coord outside unlocked range is locked', () => {
    const state = {
      S: {
        mode: 'protected' as const,
        unlockedRanges: [{ rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 3 }],
      },
    }
    expect(isCoordUnlocked(state, 'S', { row: 0, col: 0 })).toBe(false)
  })

  test('protected sheet with no unlocked ranges: all cells locked', () => {
    const state = { S: { mode: 'protected' as const, unlockedRanges: [] } }
    expect(isCoordUnlocked(state, 'S', { row: 0, col: 0 })).toBe(false)
  })
})

describe('isRangeFullyUnlocked', () => {
  const unlockedState = {
    S: {
      mode: 'protected' as const,
      unlockedRanges: [{ rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }],
    },
  }

  test('open sheet: any range is fully unlocked', () => {
    const state = { S: { mode: 'open' as const, unlockedRanges: [] } }
    expect(isRangeFullyUnlocked(state, 'S', { rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 99 })).toBe(true)
  })

  test('range fully inside unlocked rectangle: true', () => {
    expect(isRangeFullyUnlocked(unlockedState, 'S', { rowStart: 1, rowEnd: 5, colStart: 1, colEnd: 5 })).toBe(true)
  })

  test('range partially outside unlocked rectangle: false', () => {
    expect(isRangeFullyUnlocked(unlockedState, 'S', { rowStart: 5, rowEnd: 12, colStart: 0, colEnd: 9 })).toBe(false)
  })

  test('range area > 10000 cells: false (hard reject)', () => {
    const state = {
      S: {
        mode: 'protected' as const,
        unlockedRanges: [{ rowStart: 0, rowEnd: 99999, colStart: 0, colEnd: 99999 }],
      },
    }
    expect(isRangeFullyUnlocked(state, 'S', { rowStart: 0, rowEnd: 199, colStart: 0, colEnd: 99 })).toBe(false)
  })

  test('empty unlocked ranges with protected mode: false', () => {
    const state = { S: { mode: 'protected' as const, unlockedRanges: [] } }
    expect(isRangeFullyUnlocked(state, 'S', { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })).toBe(false)
  })
})

describe('isRangePartiallyUnlocked', () => {
  const state = {
    S: {
      mode: 'protected' as const,
      unlockedRanges: [{ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }],
    },
  }

  test('open sheet: returns false', () => {
    const open = { S: { mode: 'open' as const, unlockedRanges: [] } }
    expect(isRangePartiallyUnlocked(open, 'S', { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 })).toBe(false)
  })

  test('range straddling locked and unlocked: true', () => {
    expect(isRangePartiallyUnlocked(state, 'S', { rowStart: 3, rowEnd: 7, colStart: 0, colEnd: 4 })).toBe(true)
  })

  test('range fully locked: false', () => {
    expect(isRangePartiallyUnlocked(state, 'S', { rowStart: 6, rowEnd: 8, colStart: 0, colEnd: 4 })).toBe(false)
  })

  test('range fully unlocked: false', () => {
    expect(isRangePartiallyUnlocked(state, 'S', { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 })).toBe(false)
  })
})

describe('activeCellLockedAtom', () => {
  test('open mode: always false', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'S', anchor: { row: 5, col: 5 }, focus: { row: 5, col: 5 } })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'open', unlockedRanges: [] },
    })
    expect(store.getter(activeCellLockedAtom)).toBe(false)
  })

  test('no protection entry (defaults open): false', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'S', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    expect(store.getter(activeCellLockedAtom)).toBe(false)
  })

  test('protected sheet, active cell outside unlocked range: true', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'S', anchor: { row: 10, col: 10 }, focus: { row: 10, col: 10 } })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 }] },
    })
    expect(store.getter(activeCellLockedAtom)).toBe(true)
  })

  test('protected sheet, active cell inside unlocked range: false', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'S', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 }] },
    })
    expect(store.getter(activeCellLockedAtom)).toBe(false)
  })
})

describe('selectionLockedAtom', () => {
  test('open mode: returns open', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'S', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(setSheetProtectionAtom, { sheetId: 'S', state: { mode: 'open', unlockedRanges: [] } })
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })

  test('no entry (defaults open): returns open', () => {
    const store = createStore()
    store.setter(selectionAtom, { kind: 'cell', sheetId: 'X', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })

  test('protected, selection fully inside unlocked range: open', () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'S',
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 3 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 }] },
    })
    expect(store.getter(selectionLockedAtom)).toBe('open')
  })

  test('protected, selection fully locked: locked', () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'S',
      anchor: { row: 10, col: 10 },
      focus: { row: 12, col: 12 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 }] },
    })
    expect(store.getter(selectionLockedAtom)).toBe('locked')
  })

  test('protected, selection partially unlocked: partial', () => {
    const store = createStore()
    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'S',
      anchor: { row: 3, col: 0 },
      focus: { row: 7, col: 4 },
    })
    store.setter(setSheetProtectionAtom, {
      sheetId: 'S',
      state: { mode: 'protected', unlockedRanges: [{ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 }] },
    })
    expect(store.getter(selectionLockedAtom)).toBe('partial')
  })
})

describe('DisplayCell locked field typechecks', () => {
  test('DisplayCell with locked: true is valid', () => {
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: '',
      locked: true,
    }
    expect(cell.locked).toBe(true)
  })

  test('DisplayCell without locked field is valid', () => {
    const cell: DisplayCell = { row: 0, col: 0, displayValue: '' }
    expect(cell.locked).toBeUndefined()
  })
})
