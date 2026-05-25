import { atom } from '@einfach/core'
import type { Getter, Setter } from '@einfach/core'
import type {
  MenuCloseIntent,
  MenuCloseReason,
  MenuCommandIntent,
  MenuCommandKind,
  MenuHighlightIntent,
  MenuIntent,
  MenuOpenInput,
  MenuOpenIntent,
  MenuPosition,
  MenuState,
  MenuRangeTarget,
  MenuTarget,
  MenuTargetKind,
} from './types'

export * from './types'

const DEFAULT_MENU_STATE: MenuState = {
  status: 'closed',
  surface: null,
  target: null,
  position: null,
  highlightedCommand: null,
}

export const menuStateAtom = atom<MenuState>(DEFAULT_MENU_STATE)
menuStateAtom.debugLabel = 'spreadsheet.menu.state'

export const menuIntentAtom = atom<MenuIntent | null>(null)
menuIntentAtom.debugLabel = 'spreadsheet.menu.intent'

export const menuOpenAtom = atom((get) => get(menuStateAtom).status === 'open')
menuOpenAtom.debugLabel = 'spreadsheet.menu.isOpen'

export const menuTargetAtom = atom((get) => get(menuStateAtom).target)
menuTargetAtom.debugLabel = 'spreadsheet.menu.target'

export const menuPositionAtom = atom((get) => get(menuStateAtom).position)
menuPositionAtom.debugLabel = 'spreadsheet.menu.position'

export const menuHighlightAtom = atom((get) => get(menuStateAtom).highlightedCommand)
menuHighlightAtom.debugLabel = 'spreadsheet.menu.highlight'

export const menuCommandIntentAtom = atom((get) => {
  const intent = get(menuIntentAtom)

  return intent !== null && intent.type === 'menu.command' ? intent : null
})
menuCommandIntentAtom.debugLabel = 'spreadsheet.menu.commandIntent'

export function createMenuOpenIntent(input: MenuOpenInput): MenuOpenIntent | null {
  const target = normalizeMenuTarget(input.target)

  if (target === null || !isTargetAllowedForSurface(input.surface, target.kind)) {
    return null
  }

  const position = normalizeMenuPosition(input.position)

  if (position === null) {
    return null
  }

  return {
    type: 'menu.open',
    surface: input.surface,
    target,
    position,
    source: input.source ?? 'programmatic',
  }
}

export function createMenuCloseIntent(
  reason: MenuCloseReason = 'dismissed',
): MenuCloseIntent {
  return {
    type: 'menu.close',
    reason,
  }
}

export function createMenuHighlightIntent(
  command: MenuCommandKind | null,
): MenuHighlightIntent {
  return {
    type: 'menu.highlight',
    command,
  }
}

export function createMenuCommandIntent(
  command: MenuCommandKind,
  input: { surface: MenuOpenIntent['surface']; target: MenuTarget },
): MenuCommandIntent | null {
  const target = normalizeMenuTarget(input.target)

  if (target === null || !isCommandAllowedForTarget(command, target.kind)) {
    return null
  }

  return {
    type: 'menu.command',
    command,
    surface: input.surface,
    target,
  }
}

export function applyMenuIntent(state: MenuState, intent: MenuIntent): MenuState {
  switch (intent.type) {
    case 'menu.open':
      return {
        status: 'open',
        surface: intent.surface,
        target: intent.target,
        position: intent.position,
        highlightedCommand: null,
      }
    case 'menu.close':
      return {
        ...DEFAULT_MENU_STATE,
      }
    case 'menu.highlight':
      if (state.status !== 'open') {
        return state
      }

      return {
        ...state,
        highlightedCommand: intent.command,
      }
    case 'menu.command':
      return state
    default:
      return assertNever(intent)
  }
}

function commitMenuIntent(
  get: Getter,
  set: Setter,
  intent: MenuIntent,
): MenuState {
  const nextState = applyMenuIntent(get(menuStateAtom), intent)
  set(menuStateAtom, nextState)
  set(menuIntentAtom, intent)
  return nextState
}

export const dispatchMenuIntentAtom = atom(
  (get) => get(menuStateAtom),
  (get, set, intent: MenuIntent): MenuState => {
    return commitMenuIntent(get, set, intent)
  },
)
dispatchMenuIntentAtom.debugLabel = 'spreadsheet.menu.dispatchIntent'

export const openMenuAtom = atom(
  (get) => get(menuStateAtom),
  (get, set, input: MenuOpenInput): MenuState => {
    const intent = createMenuOpenIntent(input)

    if (intent === null) {
      return get(menuStateAtom)
    }

    return commitMenuIntent(get, set, intent)
  },
)
openMenuAtom.debugLabel = 'spreadsheet.menu.open'

export const closeMenuAtom = atom(
  (get) => get(menuStateAtom),
  (get, set, reason?: MenuCloseReason): MenuState => {
    return commitMenuIntent(get, set, createMenuCloseIntent(reason))
  },
)
closeMenuAtom.debugLabel = 'spreadsheet.menu.close'

export const updateMenuHighlightAtom = atom(
  (get) => get(menuStateAtom),
  (get, set, command: MenuCommandKind | null): MenuState => {
    return commitMenuIntent(get, set, createMenuHighlightIntent(command))
  },
)
updateMenuHighlightAtom.debugLabel = 'spreadsheet.menu.highlight.update'

export const dispatchMenuCommandAtom = atom(
  (get) => get(menuCommandIntentAtom),
  (get, set, command: MenuCommandKind): MenuCommandIntent | null => {
    const state = get(menuStateAtom)

    if (state.status !== 'open' || state.surface === null || state.target === null) {
      return null
    }

    const intent = createMenuCommandIntent(command, {
      surface: state.surface,
      target: state.target,
    })

    if (intent === null) {
      return null
    }

    set(menuIntentAtom, intent)
    return intent
  },
)
dispatchMenuCommandAtom.debugLabel = 'spreadsheet.menu.command'

export const clearMenuIntentAtom = atom(
  (get) => get(menuIntentAtom),
  (_get, set) => {
    set(menuIntentAtom, null)
  },
)
clearMenuIntentAtom.debugLabel = 'spreadsheet.menu.clearIntent'

function normalizeMenuPosition(position: MenuPosition): MenuPosition | null {
  const x = normalizeCoordinate(position.x)
  const y = normalizeCoordinate(position.y)

  if (x === null || y === null) {
    return null
  }

  return { x, y }
}

function normalizeMenuTarget(target: MenuTarget): MenuTarget | null {
  if (!isValidSheetId(target.sheetId)) {
    return null
  }

  switch (target.kind) {
    case 'cell':
      return isValidIndex(target.cell.row) && isValidIndex(target.cell.col)
        ? {
            kind: 'cell',
            sheetId: target.sheetId,
            cell: {
              row: normalizeCoordinate(target.cell.row)!,
              col: normalizeCoordinate(target.cell.col)!,
            },
          }
        : null
    case 'range':
      return normalizeRangeTarget(target.sheetId, target.range)
    case 'row':
      return isValidIndex(target.rowIndex)
        ? {
            kind: 'row',
            sheetId: target.sheetId,
            rowIndex: normalizeCoordinate(target.rowIndex)!,
          }
        : null
    case 'column':
      return isValidIndex(target.colIndex)
        ? {
            kind: 'column',
            sheetId: target.sheetId,
            colIndex: normalizeCoordinate(target.colIndex)!,
          }
        : null
    case 'all':
      return {
        kind: 'all',
        sheetId: target.sheetId,
      }
    case 'sheet-tab':
      return {
        kind: 'sheet-tab',
        sheetId: target.sheetId,
      }
    default:
      return assertNever(target)
  }
}

function normalizeRangeTarget(sheetId: string, range: MenuRangeTarget['range']): MenuTarget | null {
  if (
    !isValidIndex(range.rowStart) ||
    !isValidIndex(range.rowEnd) ||
    !isValidIndex(range.colStart) ||
    !isValidIndex(range.colEnd)
  ) {
    return null
  }

  const rowStart = normalizeCoordinate(range.rowStart)!
  const rowEnd = normalizeCoordinate(range.rowEnd)!
  const colStart = normalizeCoordinate(range.colStart)!
  const colEnd = normalizeCoordinate(range.colEnd)!

  if (rowEnd < rowStart || colEnd < colStart) {
    return null
  }

  return {
    kind: 'range',
    sheetId,
    range: {
      rowStart,
      rowEnd,
      colStart,
      colEnd,
    },
  }
}

function isTargetAllowedForSurface(surface: MenuOpenIntent['surface'], kind: MenuTargetKind): boolean {
  switch (surface) {
    case 'cell':
      return kind === 'cell' || kind === 'range'
    case 'header':
      return kind === 'row' || kind === 'column' || kind === 'all'
    case 'context':
      return true
    default:
      return assertNever(surface)
  }
}

function isCommandAllowedForTarget(command: MenuCommandKind, kind: MenuTargetKind): boolean {
  switch (command) {
    case 'row.insert':
    case 'row.delete':
      return kind === 'row' || kind === 'all'
    case 'column.insert':
    case 'column.delete':
      return kind === 'column' || kind === 'all'
    case 'formatting.open':
      return kind !== 'sheet-tab'
    case 'clipboard.copy':
    case 'clipboard.cut':
    case 'clipboard.paste':
    case 'cell.clear':
      return kind !== 'sheet-tab'
    case 'view.freezeRowsHere':
      return kind === 'row' || kind === 'cell' || kind === 'range'
    case 'view.freezeColsHere':
      return kind === 'column' || kind === 'cell' || kind === 'range'
    case 'view.freezePanes':
      return kind === 'cell' || kind === 'range'
    case 'view.unfreeze':
      return kind !== 'sheet-tab'
    default:
      return assertNever(command)
  }
}

function normalizeCoordinate(value: number): number | null {
  if (!Number.isFinite(value) || !Number.isInteger(Math.trunc(value)) || value < 0) {
    return null
  }

  return Math.trunc(value)
}

function isValidIndex(value: number): boolean {
  return normalizeCoordinate(value) !== null
}

function isValidSheetId(sheetId: string): boolean {
  return sheetId.trim().length > 0
}

function assertNever(value: never): never {
  throw new RangeError(`Unexpected menu value: ${String(value)}`)
}
