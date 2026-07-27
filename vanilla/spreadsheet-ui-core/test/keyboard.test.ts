import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  activeCellAtom,
  selectionAtom,
  selectionRangeAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src/selection'
import {
  dispatchKeyboardInputAtom,
  keyboardModeAtom,
  lastKeyboardIntentAtom,
  type KeyboardCommandIntent,
  type KeyboardInput,
} from '../src/keyboard'

describe('keyboard core', () => {
  test('moves selection and emits scroll-to-cell intent for arrow keys', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'ArrowRight' })

    expectMoveIntent(intent, { row: 0, col: 1 })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 0,
      col: 1,
    })
    expect(store.getter(lastKeyboardIntentAtom)).toEqual(intent)
  })

  test('shift arrow extends selection by boundary only', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'ArrowDown',
      shiftKey: true,
    })

    expectMoveIntent(intent, { row: 3, col: 2 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 2 },
      focus: { row: 3, col: 2 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 3,
      colStart: 2,
      colEnd: 2,
    })
  })

  test('home and page movement clamp to sheet bounds', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 5, col: 3 },
      focus: { row: 5, col: 3 },
    })

    expectMoveIntent(store.setter(dispatchKeyboardInputAtom, { key: 'Home' }), {
      row: 5,
      col: 0,
    })
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageDown',
        pageRowDelta: 20,
      }),
      {
        row: 9,
        col: 0,
      },
    )
  })

  test('alt page movement uses pageColDelta for horizontal paging', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 8 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 5, col: 1 },
      focus: { row: 5, col: 1 },
    })

    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageDown',
        altKey: true,
        pageColDelta: 4,
      }),
      {
        row: 5,
        col: 5,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'PageUp',
        altKey: true,
        pageColDelta: 10,
      }),
      {
        row: 5,
        col: 0,
      },
    )
  })

  test('shift alt page extends selection horizontally without expanding cells', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 8 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'PageDown',
      altKey: true,
      shiftKey: true,
      pageColDelta: 3,
    })

    expectMoveIntent(intent, { row: 3, col: 5 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 5 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 3,
      rowEnd: 3,
      colStart: 2,
      colEnd: 5,
    })
  })

  test('ctrl arrow and ctrl end jump to sheet boundaries without reading cells', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 4, col: 2 },
    })

    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'ArrowDown',
        ctrlKey: true,
      }),
      {
        row: 9,
        col: 2,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'ArrowRight',
        metaKey: true,
      }),
      {
        row: 9,
        col: 4,
      },
    )
    expectMoveIntent(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'End',
        ctrlKey: true,
      }),
      {
        row: 9,
        col: 4,
      },
    )
  })

  test('shift ctrl arrow extends selection to boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 4, col: 2 },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
    })

    expectMoveIntent(intent, { row: 0, col: 2 })
    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 4, col: 2 },
      focus: { row: 0, col: 2 },
    })
  })

  test('editing mode returns edit intents without moving selection', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    store.setter(keyboardModeAtom, 'editing')

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'Enter',
      shiftKey: true,
    })

    expect(intent).toEqual({
      type: 'editing.commit',
      move: 'up',
    })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 1,
      col: 1,
    })
  })

  test('command shortcuts emit compact intents', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })

    expect(store.setter(dispatchKeyboardInputAtom, { key: 'c', ctrlKey: true })).toEqual({
      type: 'clipboard.copy',
    })
    // Plain Ctrl+V → paste.
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'v', ctrlKey: true })).toEqual({
      type: 'clipboard.paste',
    })
    // Ctrl+Alt+V → paste-special (Excel binding). The alt guard prevents
    // this from falling through to the plain paste arm.
    expect(
      store.setter(dispatchKeyboardInputAtom, { key: 'v', ctrlKey: true, altKey: true }),
    ).toEqual({
      type: 'clipboard.pasteSpecial',
    })
    expect(
      store.setter(dispatchKeyboardInputAtom, { key: 'v', metaKey: true, altKey: true }),
    ).toEqual({
      type: 'clipboard.pasteSpecial',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'PageDown', ctrlKey: true })).toEqual({
      type: 'sheet.activate-adjacent',
      direction: 'next',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'PageUp', metaKey: true })).toEqual({
      type: 'sheet.activate-adjacent',
      direction: 'previous',
    })
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'z', metaKey: true })).toEqual({
      type: 'history.undo',
    })

    const selectAllIntent = store.setter(dispatchKeyboardInputAtom, {
      key: 'a',
      ctrlKey: true,
    })

    expect(selectAllIntent).toEqual({
      type: 'selection.selectAll',
      selection: {
        kind: 'all',
        sheetId: 'Sheet1',
      },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 4,
    })
  })

  test('opens the context menu from navigation mode without mutating selection', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 3 },
    })
    const selectionBefore = store.getter(selectionAtom)

    expect(store.setter(dispatchKeyboardInputAtom, { key: 'F10', shiftKey: true })).toEqual({
      type: 'context-menu.open',
      source: 'keyboard',
    })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'ContextMenu' })).toEqual({
      type: 'context-menu.open',
      source: 'keyboard',
    })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'F10' })).toEqual({
      type: 'none',
      reason: 'unhandled',
    })
  })

  test('does not open the context menu while composing or outside navigation mode', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })

    expect(
      store.setter(dispatchKeyboardInputAtom, {
        key: 'F10',
        shiftKey: true,
        isComposing: true,
      }),
    ).toEqual({ type: 'none', reason: 'composing' })

    store.setter(keyboardModeAtom, 'editing')
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'ContextMenu' })).toEqual({
      type: 'none',
      reason: 'editing-text-navigation',
    })

    store.setter(keyboardModeAtom, 'formula-reference')
    expect(store.setter(dispatchKeyboardInputAtom, { key: 'F10', shiftKey: true })).toEqual({
      type: 'none',
      reason: 'editing-text-navigation',
    })
  })
})

describe('editing.start from printable keys (Excel parity)', () => {
  function makeNavStore() {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    return store
  }

  test('lowercase printable key starts edit with initialDraft and clearOnStart', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: 'a',
      clearOnStart: true,
    })
  })

  test('shift+a yields uppercase A as initialDraft', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'A', shiftKey: true })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: 'A',
      clearOnStart: true,
    })
  })

  test('digit key 5 yields "5" as initialDraft', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: '5' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: '5',
      clearOnStart: true,
    })
  })

  test('space key yields " " as initialDraft', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: ' ' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: ' ',
      clearOnStart: true,
    })
  })

  test('printable key in editing mode does NOT recurse into edit-start', () => {
    const store = makeNavStore()
    store.setter(keyboardModeAtom, 'editing')
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a' })
    expect(intent).toEqual({ type: 'none', reason: 'editing-text-navigation' })
  })

  test('Ctrl+a remains selection.selectAll, not edit-start', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a', ctrlKey: true })
    expect(intent).toEqual({
      type: 'selection.selectAll',
      selection: {
        kind: 'all',
        sheetId: 'Sheet1',
      },
    })
  })

  test('Meta+a remains selection.selectAll, not edit-start', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a', metaKey: true })
    expect(intent).toEqual({
      type: 'selection.selectAll',
      selection: {
        kind: 'all',
        sheetId: 'Sheet1',
      },
    })
  })

  test('Alt+a is not an edit-start trigger (returns unhandled)', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a', altKey: true })
    expect(intent).toEqual({ type: 'none', reason: 'unhandled' })
  })

  test('F2 still starts edit without initialDraft (preserves existing content)', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'F2' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
    })
  })

  test('Backspace starts edit with empty draft and clearOnStart', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Backspace' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: '',
      clearOnStart: true,
    })
  })

  test('Delete still maps to cell.clear with target values', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Delete' })
    expect(intent).toEqual({
      type: 'cell.clear',
      target: 'values',
    })
  })

  test('Ctrl+Delete maps to cell.clear with target all', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Delete', ctrlKey: true })
    expect(intent).toEqual({
      type: 'cell.clear',
      target: 'all',
    })
  })

  test('composing input is ignored even with single-char key', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a', isComposing: true })
    expect(intent).toEqual({ type: 'none', reason: 'composing' })
  })
})

describe('formula-reference mode', () => {
  function makeFormulaRefStore() {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 3 },
      focus: { row: 2, col: 3 },
    })
    store.setter(keyboardModeAtom, 'formula-reference')
    return store
  }

  test('ArrowDown returns formulaReference.arrowPick with rowDelta 1', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'ArrowDown' })
    expect(intent).toEqual({ type: 'formulaReference.arrowPick', rowDelta: 1, colDelta: 0, extend: false })
  })

  test('Shift+ArrowRight returns arrowPick with extend: true', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'ArrowRight', shiftKey: true })
    expect(intent).toEqual({ type: 'formulaReference.arrowPick', rowDelta: 0, colDelta: 1, extend: true })
  })

  test('Escape returns formulaReference.exit with reason cancel', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Escape' })
    expect(intent).toEqual({ type: 'formulaReference.exit', reason: 'cancel' })
  })

  test('Enter returns formulaReference.exit with reason commit', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Enter' })
    expect(intent).toEqual({ type: 'formulaReference.exit', reason: 'commit' })
  })

  test(', keystroke returns formulaReference.exit with reason separator-typed', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: ',' })
    expect(intent).toEqual({ type: 'formulaReference.exit', reason: 'separator-typed' })
  })

  test(') keystroke returns formulaReference.exit with reason close-paren-typed', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: ')' })
    expect(intent).toEqual({ type: 'formulaReference.exit', reason: 'close-paren-typed' })
  })

  test('+ keystroke returns formulaReference.exit with reason operator-typed', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: '+' })
    expect(intent).toEqual({ type: 'formulaReference.exit', reason: 'operator-typed' })
  })

  test('alphanumeric key returns none with reason editing-text-navigation', () => {
    const store = makeFormulaRefStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'a' })
    expect(intent).toEqual({ type: 'none', reason: 'editing-text-navigation' })
  })

  test('dispatch in formula-reference mode does NOT mutate selectionAtom', () => {
    const store = makeFormulaRefStore()
    const selectionBefore = store.getter(selectionAtom)
    store.setter(dispatchKeyboardInputAtom, { key: 'ArrowDown' })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)
  })

  test('formulaReference.exit dispatch does NOT mutate selectionAtom', () => {
    const store = makeFormulaRefStore()
    const selectionBefore = store.getter(selectionAtom)
    store.setter(dispatchKeyboardInputAtom, { key: 'Escape' })
    expect(store.getter(selectionAtom)).toEqual(selectionBefore)
  })
})

describe('format toggle shortcuts (Ctrl+B / Ctrl+I / Ctrl+U)', () => {
  function makeNavStore() {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    return store
  }

  test('Ctrl+B in navigation mode yields format.toggle bold intent', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'b', ctrlKey: true })
    expect(intent).toEqual({ type: 'format.toggle', field: 'bold' })
    expect(store.getter(lastKeyboardIntentAtom)).toEqual(intent)
  })

  test('Ctrl+I yields format.toggle italic intent', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'i', ctrlKey: true })
    expect(intent).toEqual({ type: 'format.toggle', field: 'italic' })
  })

  test('Ctrl+U yields format.toggle underline intent', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'u', ctrlKey: true })
    expect(intent).toEqual({ type: 'format.toggle', field: 'underline' })
  })

  test('Meta+B (mac) yields format.toggle bold intent', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'b', metaKey: true })
    expect(intent).toEqual({ type: 'format.toggle', field: 'bold' })
  })

  test('plain "b" without modifier starts editing rather than toggling format', () => {
    const store = makeNavStore()
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'b' })
    expect(intent).toEqual({
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: 'b',
      clearOnStart: true,
    })
  })

  test('Ctrl+B in editing mode does NOT emit a format toggle', () => {
    const store = makeNavStore()
    store.setter(keyboardModeAtom, 'editing')
    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'b', ctrlKey: true })
    // Editing mode owns the key path; format toggle is suppressed.
    expect(intent.type).not.toBe('format.toggle')
  })
})

function expectMoveIntent(intent: KeyboardCommandIntent, to: { row: number; col: number }) {
  if (intent.type !== 'selection.move') {
    throw new Error(`Expected selection.move intent, received ${intent.type}`)
  }

  expect(intent.to).toEqual(to)
  expect(intent.scroll).toEqual({
    type: 'viewport.scrollToCell',
    target: to,
  })
}

// Kept out of `describe('keyboard core')` on purpose: that block is already at
// the 320-line cap, and folding these in would push it over.
describe('Ctrl+Alt+L reapply shortcut', () => {
  function dispatch(input: KeyboardInput) {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    return store.setter(dispatchKeyboardInputAtom, input)
  }

  test('Ctrl+Alt+L and Cmd+Alt+L emit the Data > Reapply intent', () => {
    expect(dispatch({ key: 'l', ctrlKey: true, altKey: true })).toEqual({
      type: 'filterSort.reapply',
    })
    expect(dispatch({ key: 'L', metaKey: true, altKey: true })).toEqual({
      type: 'filterSort.reapply',
    })
  })

  // Alt is load bearing in both directions: bare Ctrl+L is Excel's Create
  // Table and Ctrl+Shift+L its filter toggle, neither of which is bound here,
  // so claiming those chords would pre-empt them.
  test('leaves bare Ctrl+L and Ctrl+Shift+Alt+L unhandled', () => {
    expect(dispatch({ key: 'l', ctrlKey: true })).toEqual({
      type: 'none',
      reason: 'unhandled',
    })
    expect(dispatch({ key: 'l', ctrlKey: true, altKey: true, shiftKey: true })).toEqual({
      type: 'none',
      reason: 'unhandled',
    })
  })
})
