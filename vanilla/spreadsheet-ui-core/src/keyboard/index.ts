import { atom } from '@einfach/core'
import type { CellCoord } from '../shared'
import {
  clearNonPrimaryRegionsAtom,
  getActiveCell,
  moveSelection,
  normalizeSelection,
  selectionAtom,
  selectionBoundsAtom,
  selectionRegionsAtom,
  setPrimaryRegionAtom,
  type ActiveSelectionCell,
  type SelectionBounds,
  type SelectionState,
} from '../selection'
import type {
  KeyboardCommandIntent,
  KeyboardInput,
  KeyboardMode,
  KeyboardMoveReason,
  MoveSelectionIntent,
} from './types'

export * from './types'

export const keyboardModeAtom = atom<KeyboardMode>('navigation')
keyboardModeAtom.debugLabel = 'spreadsheet.keyboard.mode'

export const lastKeyboardIntentAtom = atom<KeyboardCommandIntent>({
  type: 'none',
  reason: 'unhandled',
})
lastKeyboardIntentAtom.debugLabel = 'spreadsheet.keyboard.lastIntent'

export const clearKeyboardIntentAtom = atom(
  (get) => get(lastKeyboardIntentAtom),
  (_get, set) => {
    set(lastKeyboardIntentAtom, {
      type: 'none',
      reason: 'unhandled',
    })
  },
)
clearKeyboardIntentAtom.debugLabel = 'spreadsheet.keyboard.clearIntent'

export const dispatchKeyboardInputAtom = atom(
  (get) => get(lastKeyboardIntentAtom),
  (get, set, input: KeyboardInput): KeyboardCommandIntent => {
    const intent = getKeyboardCommandIntent(input, {
      mode: get(keyboardModeAtom),
      selection: get(selectionAtom),
      bounds: get(selectionBoundsAtom),
      selectionRegionCount: get(selectionRegionsAtom).length,
    })

    if (intent.type !== 'formulaReference.arrowPick' && intent.type !== 'formulaReference.exit') {
      if (intent.type === 'selection.move') {
        set(setPrimaryRegionAtom, intent.selection)
      } else if (intent.type === 'selection.selectAll') {
        set(selectionAtom, intent.selection)
      } else if (intent.type === 'selection.clearNonPrimary') {
        set(clearNonPrimaryRegionsAtom, { keepPrimary: true })
      }
    }

    set(lastKeyboardIntentAtom, intent)
    return intent
  },
)
dispatchKeyboardInputAtom.debugLabel = 'spreadsheet.keyboard.dispatch'

export interface KeyboardCommandState {
  mode: KeyboardMode
  selection: SelectionState
  bounds: SelectionBounds
  selectionRegionCount?: number
}

export function getKeyboardCommandIntent(
  input: KeyboardInput,
  state: KeyboardCommandState,
): KeyboardCommandIntent {
  if (input.isComposing) {
    return {
      type: 'none',
      reason: 'composing',
    }
  }

  if (state.mode === 'editing') {
    return getEditingModeIntent(input)
  }

  if (state.mode === 'formula-reference') {
    return getFormulaReferenceModeIntent(input)
  }

  const commandIntent = getCommandShortcutIntent(input, state)
  if (commandIntent.type !== 'none') {
    return commandIntent
  }

  if (input.key === 'Escape' && (state.selectionRegionCount ?? 1) > 1) {
    return {
      type: 'selection.clearNonPrimary',
      keepPrimary: true,
    }
  }

  if (input.altKey && !isHorizontalPageInput(input)) {
    return {
      type: 'none',
      reason: 'unhandled',
    }
  }

  const movementIntent = getMovementIntent(input, state)
  if (movementIntent.type !== 'none') {
    return movementIntent
  }

  if (input.key === 'F2') {
    return {
      type: 'editing.start',
      source: 'keyboard',
    }
  }

  if (input.key === 'Backspace') {
    return {
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: '',
      clearOnStart: true,
    }
  }

  if (input.key === 'Delete') {
    return {
      type: 'cell.clear',
      target: input.ctrlKey || input.metaKey ? 'all' : 'values',
    }
  }

  if (
    input.key.length === 1 &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.altKey
  ) {
    return {
      type: 'editing.start',
      source: 'keyboard',
      initialDraft: input.key,
      clearOnStart: true,
    }
  }

  return {
    type: 'none',
    reason: 'unhandled',
  }
}

function getEditingModeIntent(input: KeyboardInput): KeyboardCommandIntent {
  if (input.key === 'Escape') {
    return {
      type: 'editing.cancel',
    }
  }

  if (input.key === 'Enter') {
    return {
      type: 'editing.commit',
      move: input.shiftKey ? 'up' : 'down',
    }
  }

  if (input.key === 'Tab') {
    return {
      type: 'editing.commit',
      move: input.shiftKey ? 'left' : 'right',
    }
  }

  return {
    type: 'none',
    reason: 'editing-text-navigation',
  }
}

const FORMULA_REF_OPERATORS = new Set(['+', '-', '*', '/', '^', '&', '%', '<', '>', '='])

function getFormulaReferenceModeIntent(input: KeyboardInput): KeyboardCommandIntent {
  if (input.key === 'Escape') {
    return { type: 'formulaReference.exit', reason: 'cancel' }
  }

  if (input.key === 'Enter' || input.key === 'Tab') {
    return { type: 'formulaReference.exit', reason: 'commit' }
  }

  switch (input.key) {
    case 'ArrowUp':
      return { type: 'formulaReference.arrowPick', rowDelta: -1, colDelta: 0, extend: Boolean(input.shiftKey) }
    case 'ArrowDown':
      return { type: 'formulaReference.arrowPick', rowDelta: 1, colDelta: 0, extend: Boolean(input.shiftKey) }
    case 'ArrowLeft':
      return { type: 'formulaReference.arrowPick', rowDelta: 0, colDelta: -1, extend: Boolean(input.shiftKey) }
    case 'ArrowRight':
      return { type: 'formulaReference.arrowPick', rowDelta: 0, colDelta: 1, extend: Boolean(input.shiftKey) }
  }

  if (input.key.length === 1) {
    if (input.key === ')') {
      return { type: 'formulaReference.exit', reason: 'close-paren-typed' }
    }
    if (input.key === ',') {
      return { type: 'formulaReference.exit', reason: 'separator-typed' }
    }
    if (FORMULA_REF_OPERATORS.has(input.key)) {
      return { type: 'formulaReference.exit', reason: 'operator-typed' }
    }
  }

  return { type: 'none', reason: 'editing-text-navigation' }
}

function getCommandShortcutIntent(
  input: KeyboardInput,
  state: KeyboardCommandState,
): KeyboardCommandIntent {
  if (!input.ctrlKey && !input.metaKey) {
    return {
      type: 'none',
      reason: 'unhandled',
    }
  }

  switch (input.key.toLowerCase()) {
    case 'a':
      return {
        type: 'selection.selectAll',
        selection: normalizeSelection(
          {
            kind: 'all',
            sheetId: state.selection.sheetId,
          },
          state.bounds,
        ),
      }
    case 'c':
      return {
        type: 'clipboard.copy',
      }
    case 'x':
      return {
        type: 'clipboard.cut',
      }
    case 'v':
      // Ctrl+Alt+V is reserved for Paste Special (Excel binding). Without
      // the alt guard, the plain paste intent would fire first and swallow
      // the dispatch. See keyboard/types.ts: KeyboardClipboardIntent.
      if (input.altKey) {
        return {
          type: 'clipboard.pasteSpecial',
        }
      }
      return {
        type: 'clipboard.paste',
      }
    case 'z':
      return {
        type: 'history.undo',
      }
    case 'y':
      return {
        type: 'history.redo',
      }
    case 'g':
      return {
        type: 'go-to.open',
      }
    case 'b':
      return {
        type: 'format.toggle',
        field: 'bold',
      }
    case 'i':
      return {
        type: 'format.toggle',
        field: 'italic',
      }
    case 'u':
      return {
        type: 'format.toggle',
        field: 'underline',
      }
    case 'pageup':
      return {
        type: 'sheet.activate-adjacent',
        direction: 'previous',
      }
    case 'pagedown':
      return {
        type: 'sheet.activate-adjacent',
        direction: 'next',
      }
    default:
      return {
        type: 'none',
        reason: 'unhandled',
      }
  }
}

function getMovementIntent(
  input: KeyboardInput,
  state: KeyboardCommandState,
): KeyboardCommandIntent {
  switch (input.key) {
    case 'ArrowUp':
      return createMoveIntent(input, state, 'arrow', getArrowMovement(input, state, -1, 0))
    case 'ArrowDown':
      return createMoveIntent(input, state, 'arrow', getArrowMovement(input, state, 1, 0))
    case 'ArrowLeft':
      return createMoveIntent(input, state, 'arrow', getArrowMovement(input, state, 0, -1))
    case 'ArrowRight':
      return createMoveIntent(input, state, 'arrow', getArrowMovement(input, state, 0, 1))
    case 'Tab':
      return createMoveIntent(input, state, 'tab', { colDelta: input.shiftKey ? -1 : 1 })
    case 'Enter':
      return createMoveIntent(input, state, 'enter', { rowDelta: input.shiftKey ? -1 : 1 })
    case 'Home':
      return createMoveIntent(input, state, 'home', {
        row: input.ctrlKey || input.metaKey ? 0 : undefined,
        col: 0,
      })
    case 'PageUp':
      if (input.altKey) {
        return createMoveIntent(input, state, 'page', {
          colDelta: -normalizePageDelta(input.pageColDelta),
        })
      }

      return createMoveIntent(input, state, 'page', {
        rowDelta: -normalizePageDelta(input.pageRowDelta),
      })
    case 'PageDown':
      if (input.altKey) {
        return createMoveIntent(input, state, 'page', {
          colDelta: normalizePageDelta(input.pageColDelta),
        })
      }

      return createMoveIntent(input, state, 'page', {
        rowDelta: normalizePageDelta(input.pageRowDelta),
      })
    case 'End':
      return createMoveIntent(input, state, 'end', {
        row: input.ctrlKey || input.metaKey ? state.bounds.rowCount - 1 : undefined,
        col: state.bounds.colCount - 1,
      })
    default:
      return {
        type: 'none',
        reason: 'unhandled',
      }
  }
}

function isHorizontalPageInput(input: KeyboardInput): boolean {
  return input.key === 'PageUp' || input.key === 'PageDown'
}

function getArrowMovement(
  input: KeyboardInput,
  state: KeyboardCommandState,
  rowDirection: -1 | 0 | 1,
  colDirection: -1 | 0 | 1,
): {
  rowDelta?: number
  colDelta?: number
  row?: number
  col?: number
} {
  if (!input.ctrlKey && !input.metaKey) {
    return {
      rowDelta: rowDirection === 0 ? undefined : rowDirection,
      colDelta: colDirection === 0 ? undefined : colDirection,
    }
  }

  return {
    row:
      rowDirection === 0
        ? undefined
        : rowDirection < 0
          ? 0
          : state.bounds.rowCount - 1,
    col:
      colDirection === 0
        ? undefined
        : colDirection < 0
          ? 0
          : state.bounds.colCount - 1,
  }
}

function createMoveIntent(
  input: KeyboardInput,
  state: KeyboardCommandState,
  reason: KeyboardMoveReason,
  movement: {
    rowDelta?: number
    colDelta?: number
    row?: number
    col?: number
  },
): MoveSelectionIntent {
  const currentSelection = normalizeSelection(state.selection, state.bounds)
  const from = stripSheetId(getActiveCell(currentSelection, state.bounds))
  const nextSelection = moveSelection(currentSelection, state.bounds, {
    ...movement,
    extend: input.key === 'Tab' ? false : Boolean(input.shiftKey),
  })
  const to = stripSheetId(getActiveCell(nextSelection, state.bounds))

  return {
    type: 'selection.move',
    reason,
    key: input.key,
    extend: input.key === 'Tab' ? false : Boolean(input.shiftKey),
    from,
    to,
    scroll: {
      type: 'viewport.scrollToCell',
      target: to,
    },
    selection: nextSelection,
  }
}

function normalizePageDelta(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20
  }

  return Math.max(1, Math.trunc(Math.abs(value)))
}

function stripSheetId(cell: ActiveSelectionCell): CellCoord {
  return {
    row: cell.row,
    col: cell.col,
  }
}
