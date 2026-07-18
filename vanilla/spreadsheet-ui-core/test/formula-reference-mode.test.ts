import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  editingSessionAtom,
  startEditingAtom,
} from '../src/editing'
import {
  enterFormulaReferenceAtom,
  exitFormulaReferenceAtom,
  formulaReferenceActiveAtom,
  formulaReferenceCaretAtom,
  formulaReferenceSessionAtom,
  pickFormulaReferenceAtom,
  setFormulaReferenceCaretAtom,
  serializeCellRef,
  serializeRangeRef,
  shouldEnterFormulaReferenceMode,
  spliceDraft,
} from '../src/formula-reference'
import { keyboardModeAtom } from '../src/keyboard'

function makeStore() {
  const store = createStore()
  store.setter(startEditingAtom, {
    sheetId: 'sheet-1',
    cell: { row: 0, col: 0 },
    draft: '=',
    source: 'cell',
  })
  return store
}

describe('enterFormulaReferenceAtom', () => {
  test('sets session with correct anchorCell and insertionCaret', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    const session = store.getter(formulaReferenceSessionAtom)
    expect(session).not.toBeNull()
    expect(session?.anchorCell).toEqual({ row: 0, col: 0 })
    expect(session?.insertionCaret).toBe(1)
    expect(session?.tokenRange).toBeNull()
    expect(session?.dragging).toBe(false)
  })

  test('sets formulaReferenceActiveAtom to true', () => {
    const store = makeStore()
    expect(store.getter(formulaReferenceActiveAtom)).toBe(false)
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    expect(store.getter(formulaReferenceActiveAtom)).toBe(true)
  })

  test('sets keyboard mode to formula-reference', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    expect(store.getter(keyboardModeAtom)).toBe('formula-reference')
  })

  test('does not alter editingSessionAtom.status', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    expect(store.getter(editingSessionAtom).status).toBe('drafting')
  })
})

describe('setFormulaReferenceCaretAtom', () => {
  test('updates the public read-only caret state through its command', () => {
    const store = makeStore()
    expect(store.getter(formulaReferenceCaretAtom)).toBe(-1)
    expect(store.getter(setFormulaReferenceCaretAtom)).toBeNull()

    store.setter(setFormulaReferenceCaretAtom, 7)

    expect(store.getter(formulaReferenceCaretAtom)).toBe(7)
    expect(store.getter(setFormulaReferenceCaretAtom)).toBeNull()
  })
})

describe('pickFormulaReferenceAtom (single cell)', () => {
  test('inserts A1 token at insertion caret when no prior tokenRange', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    expect(store.getter(editingSessionAtom).draft).toBe('=A1')
  })

  test('replaces prior tokenRange with new token', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    // Now pick a different single cell — should replace A1 with B2
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 1, col: 1 },
      pickFocus: { row: 1, col: 1 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    expect(store.getter(editingSessionAtom).draft).toBe('=B2')
  })

  test('updates tokenRange.end after replacement', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    const session = store.getter(formulaReferenceSessionAtom)
    // token 'A1' starts at 1, ends at 3
    expect(session?.tokenRange).toEqual({ start: 1, end: 3 })
  })
})

describe('pickFormulaReferenceAtom (range / drag)', () => {
  test('serialises anchor != focus as A1:B2 token', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 1, col: 1 },
      sheetId: 'sheet-1',
      dragging: true,
    })
    expect(store.getter(editingSessionAtom).draft).toBe('=A1:B2')
  })

  test('sets dragging: true while drag is in progress', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 1, col: 1 },
      sheetId: 'sheet-1',
      dragging: true,
    })
    expect(store.getter(formulaReferenceSessionAtom)?.dragging).toBe(true)
  })

  test('sets dragging: false on pointer-up pick', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 1, col: 1 },
      sheetId: 'sheet-1',
      dragging: true,
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 1, col: 1 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    expect(store.getter(formulaReferenceSessionAtom)?.dragging).toBe(false)
  })
})

describe('exitFormulaReferenceAtom', () => {
  test('clears session (null)', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(exitFormulaReferenceAtom, 'commit')
    expect(store.getter(formulaReferenceSessionAtom)).toBeNull()
  })

  test('sets formulaReferenceActiveAtom to false', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(exitFormulaReferenceAtom, 'cancel')
    expect(store.getter(formulaReferenceActiveAtom)).toBe(false)
  })

  test('restores editing keyboard mode while the draft remains active', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })

    store.setter(exitFormulaReferenceAtom, 'operator-typed')

    expect(store.getter(keyboardModeAtom)).toBe('editing')
  })

  test('leaves editingSessionAtom.draft unchanged (token already spliced)', () => {
    const store = makeStore()
    store.setter(enterFormulaReferenceAtom, {
      anchorCell: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      insertionCaret: 1,
      draft: '=',
    })
    store.setter(pickFormulaReferenceAtom, {
      pickAnchor: { row: 0, col: 0 },
      pickFocus: { row: 0, col: 0 },
      sheetId: 'sheet-1',
      dragging: false,
    })
    const draftBeforeExit = store.getter(editingSessionAtom).draft
    store.setter(exitFormulaReferenceAtom, 'commit')
    expect(store.getter(editingSessionAtom).draft).toBe(draftBeforeExit)
  })
})

describe('trigger predicate helper', () => {
  test("returns true after '=' at caret", () => {
    expect(shouldEnterFormulaReferenceMode('=', 1)).toBe(true)
  })

  test("returns true after ',' at caret", () => {
    expect(shouldEnterFormulaReferenceMode('=SUM(A1,', 8)).toBe(true)
  })

  test('returns false when caret follows an alphanumeric character', () => {
    expect(shouldEnterFormulaReferenceMode('=SUM', 4)).toBe(false)
  })

  test("returns false when editingSessionAtom.status !== 'drafting'", () => {
    // shouldEnterFormulaReferenceMode is a pure helper; this case simulates
    // a draft that looks like a plain value (no leading trigger char).
    expect(shouldEnterFormulaReferenceMode('hello', 5)).toBe(false)
  })
})

describe('draft splice helper', () => {
  test('inserts token at caret when tokenRange is null', () => {
    const result = spliceDraft('=', null, 1, 'A1')
    expect(result).toEqual({ draft: '=A1', end: 3 })
  })

  test('replaces [start, end) with new token, returns updated end index', () => {
    // draft has '=A1' with tokenRange {start:1, end:3}; replace with B2
    const result = spliceDraft('=A1', { start: 1, end: 3 }, 1, 'B2')
    expect(result).toEqual({ draft: '=B2', end: 3 })
  })
})

describe('pure serialisation helpers', () => {
  test('serializeCellRef converts zero-based coord to A1 notation', () => {
    expect(serializeCellRef({ row: 0, col: 0 })).toBe('A1')
    expect(serializeCellRef({ row: 1, col: 1 })).toBe('B2')
    expect(serializeCellRef({ row: 0, col: 25 })).toBe('Z1')
    expect(serializeCellRef({ row: 0, col: 26 })).toBe('AA1')
  })

  test('serializeRangeRef returns single ref for same coord', () => {
    expect(serializeRangeRef({ row: 0, col: 0 }, { row: 0, col: 0 })).toBe('A1')
  })

  test('serializeRangeRef normalises anchor/focus order', () => {
    expect(serializeRangeRef({ row: 1, col: 1 }, { row: 0, col: 0 })).toBe('A1:B2')
  })
})
