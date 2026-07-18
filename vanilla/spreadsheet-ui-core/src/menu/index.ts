import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import { selectionRegionsAtom, selectionSnapshotAtom } from '../selection'
import {
  runViewportHiddenMutationAtom,
  runViewportHiddenSelectionMutationAtom,
  viewportHiddenAtom,
  viewportHiddenLifecycleAtom,
  viewportHiddenProjectionAuthorityAtom,
} from '../viewport'
import type {
  ViewportHiddenCommandOutcome,
  ViewportHiddenControllerPort,
  ViewportHiddenLifecycleStatus,
  ViewportHiddenMutationAction,
  ViewportHiddenProjectionAuthorityState,
  ViewportHiddenState,
} from '../viewport'
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
  ViewportHiddenContextMenuCommandKind,
} from './types'

export * from './types'

const DEFAULT_MENU_STATE: MenuState = {
  status: 'closed',
  surface: null,
  target: null,
  position: null,
  highlightedCommand: null,
}

const menuStateBackingAtom = atom<MenuState>(DEFAULT_MENU_STATE)
menuStateBackingAtom.debugLabel = 'spreadsheet.menu.stateBacking'

export const menuStateAtom: Atom<MenuState> = atom((get) => get(menuStateBackingAtom))
menuStateAtom.debugLabel = 'spreadsheet.menu.state'

const menuIntentBackingAtom = atom<MenuIntent | null>(null)
menuIntentBackingAtom.debugLabel = 'spreadsheet.menu.intentBacking'

export const menuIntentAtom: Atom<MenuIntent | null> = atom((get) => get(menuIntentBackingAtom))
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
  const nextState = applyMenuIntent(get(menuStateBackingAtom), intent)
  set(menuStateBackingAtom, nextState)
  set(menuIntentBackingAtom, intent)
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

    set(menuIntentBackingAtom, intent)
    return intent
  },
)
dispatchMenuCommandAtom.debugLabel = 'spreadsheet.menu.command'

export const clearMenuIntentAtom = atom(
  (get) => get(menuIntentAtom),
  (_get, set) => {
    set(menuIntentBackingAtom, null)
  },
)
clearMenuIntentAtom.debugLabel = 'spreadsheet.menu.clearIntent'

export interface RunViewportHiddenContextMenuCommandInput {
  readonly source: ViewportHiddenControllerPort
  readonly command: ViewportHiddenContextMenuCommandKind
}

export type ViewportHiddenContextMenuCommandAvailability = (
  source: ViewportHiddenControllerPort,
  command: ViewportHiddenContextMenuCommandKind,
) => boolean

type ResolvedViewportHiddenContextMenuCommand = Readonly<{
  action: ViewportHiddenMutationAction
  sheetId: string
  targetIndex: number
  selectionStart: number
  selectionEnd: number
}>

const ACTIVE_VIEWPORT_HIDDEN_LIFECYCLE_STATUSES: readonly ViewportHiddenLifecycleStatus[] = [
  'pending',
  'local-acknowledged',
  'canonical-reading',
]

export function isViewportHiddenContextMenuCommand(
  command: unknown,
): command is ViewportHiddenContextMenuCommandKind {
  return (
    command === 'row.hide' ||
    command === 'row.unhide' ||
    command === 'column.hide' ||
    command === 'column.unhide'
  )
}

function viewportHiddenActionForContextMenuCommand(
  command: ViewportHiddenContextMenuCommandKind,
): ViewportHiddenMutationAction {
  switch (command) {
    case 'row.hide':
      return 'hide-rows'
    case 'row.unhide':
      return 'unhide-rows'
    case 'column.hide':
      return 'hide-columns'
    case 'column.unhide':
      return 'unhide-columns'
  }
}

function supportsViewportHiddenContextMenuCommand(
  source: ViewportHiddenControllerPort,
  action: ViewportHiddenMutationAction,
): boolean {
  if (!source || typeof source.readViewportSizeProjection !== 'function') return false

  switch (action) {
    case 'hide-rows':
      return typeof source.hideRows === 'function'
    case 'unhide-rows':
      return typeof source.unhideRows === 'function'
    case 'hide-columns':
      return typeof source.hideColumns === 'function'
    case 'unhide-columns':
      return typeof source.unhideColumns === 'function'
  }
}

function isViewportHiddenLifecycleBlocked(status: ViewportHiddenLifecycleStatus): boolean {
  return (
    status === 'recovery-required' ||
    ACTIVE_VIEWPORT_HIDDEN_LIFECYCLE_STATUSES.includes(status)
  )
}

function resolveViewportHiddenContextMenuCommand(
  get: Getter,
  command: ViewportHiddenContextMenuCommandKind,
): ResolvedViewportHiddenContextMenuCommand | null {
  const state = get(menuStateAtom)
  const target = state.target
  const regions = get(selectionRegionsAtom)
  const snapshot = get(selectionSnapshotAtom)
  const selectsRows = command === 'row.hide' || command === 'row.unhide'

  if (
    state.status !== 'open' ||
    (state.surface !== 'header' && state.surface !== 'context') ||
    regions.length !== 1 ||
    !target ||
    target.sheetId !== snapshot.selection.sheetId ||
    regions[0]?.sheetId !== snapshot.selection.sheetId ||
    snapshot.selection.kind !== (selectsRows ? 'row' : 'column') ||
    target.kind !== (selectsRows ? 'row' : 'column')
  ) {
    return null
  }

  const targetIndex = target.kind === 'row' ? target.rowIndex : target.colIndex
  const selectionStart = selectsRows ? snapshot.range.rowStart : snapshot.range.colStart
  const selectionEnd = selectsRows ? snapshot.range.rowEnd : snapshot.range.colEnd
  if (targetIndex < selectionStart || targetIndex > selectionEnd) return null

  return Object.freeze({
    action: viewportHiddenActionForContextMenuCommand(command),
    sheetId: target.sheetId,
    targetIndex,
    selectionStart,
    selectionEnd,
  })
}

function createSelectedAxisIndices(start: number, end: number): readonly number[] {
  const indices: number[] = []
  for (let index = start; index <= end; index += 1) {
    indices.push(index)
  }
  return Object.freeze(indices)
}

function resolvedViewportHiddenContextMenuCommandIsAvailable(
  resolution: ResolvedViewportHiddenContextMenuCommand | null,
  source: ViewportHiddenControllerPort,
  lifecycleStatus: ViewportHiddenLifecycleStatus,
  authority: ViewportHiddenProjectionAuthorityState,
  hidden: ViewportHiddenState,
): boolean {
  if (
    resolution === null ||
    !supportsViewportHiddenContextMenuCommand(source, resolution.action) ||
    isViewportHiddenLifecycleBlocked(lifecycleStatus)
  ) {
    return false
  }

  if (resolution.action === 'hide-rows' || resolution.action === 'hide-columns') return true

  const authorityWindow = authority.window
  if (
    !authority.ready ||
    authority.source !== source ||
    authority.sheetId !== resolution.sheetId ||
    authority.revision === null ||
    authorityWindow === null
  ) {
    return false
  }

  const authorityStart =
    resolution.action === 'unhide-rows' ? authorityWindow.rowStart : authorityWindow.colStart
  const authorityEnd =
    resolution.action === 'unhide-rows' ? authorityWindow.rowEnd : authorityWindow.colEnd
  if (authorityStart > resolution.selectionStart || authorityEnd < resolution.selectionEnd) {
    return false
  }

  const hiddenIndices =
    resolution.action === 'unhide-rows'
      ? (hidden.rowsBySheet[resolution.sheetId] ?? [])
      : (hidden.colsBySheet[resolution.sheetId] ?? [])
  return hiddenIndices.some(
    (index) => index >= resolution.selectionStart && index <= resolution.selectionEnd,
  )
}

/** Reactive, fail-closed capability and authority gate for header context-menu commands. */
export const viewportHiddenContextMenuCommandAvailabilityAtom = atom(
  (get): ViewportHiddenContextMenuCommandAvailability => {
    const resolutions: Readonly<
      Record<ViewportHiddenContextMenuCommandKind, ResolvedViewportHiddenContextMenuCommand | null>
    > = Object.freeze({
      'row.hide': resolveViewportHiddenContextMenuCommand(get, 'row.hide'),
      'row.unhide': resolveViewportHiddenContextMenuCommand(get, 'row.unhide'),
      'column.hide': resolveViewportHiddenContextMenuCommand(get, 'column.hide'),
      'column.unhide': resolveViewportHiddenContextMenuCommand(get, 'column.unhide'),
    })
    const lifecycleStatus = get(viewportHiddenLifecycleAtom).status
    const authority = get(viewportHiddenProjectionAuthorityAtom)
    const hidden = get(viewportHiddenAtom)

    return (source, command) =>
      resolvedViewportHiddenContextMenuCommandIsAvailable(
        resolutions[command],
        source,
        lifecycleStatus,
        authority,
        hidden,
      )
  },
)
viewportHiddenContextMenuCommandAvailabilityAtom.debugLabel =
  'spreadsheet.menu.viewportHiddenCommandAvailability'

function menuIntentMatchesViewportHiddenCommand(
  get: Getter,
  command: ViewportHiddenContextMenuCommandKind,
): boolean {
  const state = get(menuStateAtom)
  const intent = get(menuCommandIntentAtom)
  if (
    state.status !== 'open' ||
    state.surface === null ||
    state.target === null ||
    intent === null ||
    intent.command !== command ||
    intent.surface !== state.surface
  ) {
    return false
  }

  const target = state.target
  const intentTarget = intent.target
  if (target.kind !== intentTarget.kind || target.sheetId !== intentTarget.sheetId) return false
  if (target.kind === 'row' && intentTarget.kind === 'row') {
    return target.rowIndex === intentTarget.rowIndex
  }
  if (target.kind === 'column' && intentTarget.kind === 'column') {
    return target.colIndex === intentTarget.colIndex
  }
  return false
}

/**
 * Routes a validated menu intent into the existing canonical hidden-state commands.
 * Adapters provide transport only; Core re-checks intent, selection, capability and authority.
 */
export const runViewportHiddenContextMenuCommandAtom = atom(
  null,
  async (
    get,
    set,
    input: RunViewportHiddenContextMenuCommandInput,
  ): Promise<ViewportHiddenCommandOutcome> => {
    if (
      !input ||
      !isViewportHiddenContextMenuCommand(input.command) ||
      !menuIntentMatchesViewportHiddenCommand(get, input.command)
    ) {
      return 'blocked'
    }

    const resolution = resolveViewportHiddenContextMenuCommand(get, input.command)
    if (
      resolution === null ||
      isViewportHiddenLifecycleBlocked(get(viewportHiddenLifecycleAtom).status)
    ) {
      return 'blocked'
    }
    if (!supportsViewportHiddenContextMenuCommand(input.source, resolution.action)) {
      return 'unsupported'
    }

    if (resolution.action === 'unhide-rows' || resolution.action === 'unhide-columns') {
      if (
        !resolvedViewportHiddenContextMenuCommandIsAvailable(
          resolution,
          input.source,
          get(viewportHiddenLifecycleAtom).status,
          get(viewportHiddenProjectionAuthorityAtom),
          get(viewportHiddenAtom),
        )
      ) {
        return 'blocked'
      }
      return set(runViewportHiddenSelectionMutationAtom, {
        source: input.source,
        action: resolution.action,
      })
    }

    const window =
      resolution.action === 'hide-rows'
        ? {
            rowStart: resolution.selectionStart,
            rowEnd: resolution.selectionEnd,
            colStart: 0,
            colEnd: 0,
          }
        : {
            rowStart: 0,
            rowEnd: 0,
            colStart: resolution.selectionStart,
            colEnd: resolution.selectionEnd,
          }
    return set(runViewportHiddenMutationAtom, {
      source: input.source,
      sheetId: resolution.sheetId,
      action: resolution.action,
      indices: createSelectedAxisIndices(resolution.selectionStart, resolution.selectionEnd),
      window,
    })
  },
)
runViewportHiddenContextMenuCommandAtom.debugLabel =
  'spreadsheet.menu.runViewportHiddenCommand'

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
    case 'row.hide':
    case 'row.unhide':
      return kind === 'row'
    case 'column.insert':
    case 'column.delete':
      return kind === 'column' || kind === 'all'
    case 'column.hide':
    case 'column.unhide':
      return kind === 'column'
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
