import { atom } from '@einfach/core'
import type { ProjectionRevision, SpreadsheetSheetMetadata } from '../backend'

export type SheetTabInteractionSource = 'pointer' | 'keyboard' | 'context-menu' | 'programmatic'

export type SheetTabIntent =
  | {
      type: 'sheet-tab.context-menu.open'
      sheetId: string
      x: number
      y: number
      source: SheetTabInteractionSource
    }
  | {
      type: 'sheet-tab.context-menu.close'
      reason: 'dismissed' | 'sheet-changed' | 'committed' | 'cancelled'
    }
  | {
      type: 'sheet-tab.rename.begin'
      sheetId: string
      draftName: string
      source: SheetTabInteractionSource
    }
  | {
      type: 'sheet-tab.rename.change'
      sheetId: string
      draftName: string
    }
  | {
      type: 'sheet-tab.rename.commit'
      sheetId: string
      name: string
      source: SheetTabInteractionSource
    }
  | {
      type: 'sheet-tab.rename.cancel'
      sheetId: string
      reason: 'escape' | 'blur' | 'sheet-changed'
    }
  | {
      type: 'sheet-tab.reorder.begin'
      sheetId: string
      source: SheetTabInteractionSource
    }
  | {
      type: 'sheet-tab.reorder.update'
      sheetId: string
      beforeSheetId: string | null
      afterSheetId: string | null
      targetIndex: number | null
    }
  | {
      type: 'sheet-tab.reorder.commit'
      sheetId: string
      beforeSheetId: string | null
      afterSheetId: string | null
      targetIndex: number | null
    }
  | {
      type: 'sheet-tab.reorder.cancel'
      sheetId: string
      reason: 'escape' | 'blur' | 'sheet-changed'
    }

export interface SheetTabContextMenuState {
  sheetId: string
  x: number
  y: number
  source: SheetTabInteractionSource
}

export interface SheetTabRenameState {
  sheetId: string
  draftName: string
  source: SheetTabInteractionSource
}

export interface SheetTabReorderState {
  sheetId: string
  beforeSheetId: string | null
  afterSheetId: string | null
  targetIndex: number | null
  source: SheetTabInteractionSource
}

export interface SheetTabsState {
  contextMenu: SheetTabContextMenuState | null
  rename: SheetTabRenameState | null
  reorder: SheetTabReorderState | null
  lastIntent: SheetTabIntent | null
}

export interface SheetTabsSheetState {
  sheets: SpreadsheetSheetMetadata[]
  revision?: ProjectionRevision
}

export interface SetSheetTabsSheetsInput {
  sheets: readonly SpreadsheetSheetMetadata[]
  revision?: ProjectionRevision
}

export interface OpenSheetTabContextMenuInput {
  sheetId: string
  x: number
  y: number
  source?: SheetTabInteractionSource
}

export interface BeginSheetTabRenameInput {
  sheetId: string
  draftName: string
  source?: SheetTabInteractionSource
}

export interface UpdateSheetTabRenameInput {
  draftName: string
}

export interface CommitSheetTabRenameInput {
  sheetId: string
  name: string
  source?: SheetTabInteractionSource
}

export interface BeginSheetTabReorderInput {
  sheetId: string
  source?: SheetTabInteractionSource
}

export interface UpdateSheetTabReorderInput {
  sheetId: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
}

export interface CommitSheetTabReorderInput extends UpdateSheetTabReorderInput {}

export const DEFAULT_SHEET_TABS_STATE: SheetTabsState = {
  contextMenu: null,
  rename: null,
  reorder: null,
  lastIntent: null,
}

export const DEFAULT_SHEET_TABS_SHEET_STATE: SheetTabsSheetState = {
  sheets: [],
  revision: undefined,
}

export function normalizeSheetTabDraftName(name: string): string | null {
  const normalized = name.trim()

  return normalized.length === 0 ? null : normalized
}

export function getAdjacentSheetId(
  sheets: readonly SpreadsheetSheetMetadata[],
  activeSheetId: string | null,
  direction: 'previous' | 'next',
): string | null {
  if (sheets.length === 0) {
    return null
  }

  const activeIndex = activeSheetId
    ? sheets.findIndex((sheet) => sheet.id === activeSheetId)
    : -1
  if (activeIndex < 0) {
    return sheets[0]?.id ?? null
  }

  const step = direction === 'previous' ? -1 : 1
  const nextIndex = (activeIndex + step + sheets.length) % sheets.length
  return sheets[nextIndex]?.id ?? null
}

export function createOpenSheetTabContextMenuIntent(
  input: OpenSheetTabContextMenuInput,
): SheetTabIntent {
  return {
    type: 'sheet-tab.context-menu.open',
    sheetId: input.sheetId,
    x: normalizeCoordinate(input.x),
    y: normalizeCoordinate(input.y),
    source: input.source ?? 'pointer',
  }
}

export function createCloseSheetTabContextMenuIntent(
  reason: 'dismissed' | 'sheet-changed' | 'committed' | 'cancelled' = 'dismissed',
): SheetTabIntent {
  return {
    type: 'sheet-tab.context-menu.close',
    reason,
  }
}

export function createBeginSheetTabRenameIntent(
  input: BeginSheetTabRenameInput,
): SheetTabIntent | null {
  if (normalizeSheetTabDraftName(input.draftName) === null) {
    return null
  }

  return {
    type: 'sheet-tab.rename.begin',
    sheetId: input.sheetId,
    draftName: input.draftName,
    source: input.source ?? 'programmatic',
  }
}

export function createUpdateSheetTabRenameIntent(
  sheetId: string,
  draftName: string,
): SheetTabIntent | null {
  if (draftName.length === 0) {
    return null
  }

  return {
    type: 'sheet-tab.rename.change',
    sheetId,
    draftName,
  }
}

export function createCommitSheetTabRenameIntent(
  input: CommitSheetTabRenameInput,
): SheetTabIntent | null {
  const name = normalizeSheetTabDraftName(input.name)

  if (name === null) {
    return null
  }

  return {
    type: 'sheet-tab.rename.commit',
    sheetId: input.sheetId,
    name,
    source: input.source ?? 'programmatic',
  }
}

export function createBeginSheetTabReorderIntent(
  input: BeginSheetTabReorderInput,
): SheetTabIntent {
  return {
    type: 'sheet-tab.reorder.begin',
    sheetId: input.sheetId,
    source: input.source ?? 'programmatic',
  }
}

export function createUpdateSheetTabReorderIntent(
  input: UpdateSheetTabReorderInput,
): SheetTabIntent {
  return {
    type: 'sheet-tab.reorder.update',
    sheetId: input.sheetId,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    targetIndex: normalizeOptionalIndex(input.targetIndex ?? null),
  }
}

export function createCommitSheetTabReorderIntent(
  input: CommitSheetTabReorderInput,
): SheetTabIntent {
  return {
    type: 'sheet-tab.reorder.commit',
    sheetId: input.sheetId,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    targetIndex: normalizeOptionalIndex(input.targetIndex ?? null),
  }
}

export function createCancelSheetTabRenameIntent(
  sheetId: string,
  reason: 'escape' | 'blur' | 'sheet-changed',
): SheetTabIntent {
  return {
    type: 'sheet-tab.rename.cancel',
    sheetId,
    reason,
  }
}

export function createCancelSheetTabReorderIntent(
  sheetId: string,
  reason: 'escape' | 'blur' | 'sheet-changed',
): SheetTabIntent {
  return {
    type: 'sheet-tab.reorder.cancel',
    sheetId,
    reason,
  }
}

export function applySheetTabIntent(
  state: SheetTabsState,
  intent: SheetTabIntent,
): SheetTabsState {
  switch (intent.type) {
    case 'sheet-tab.context-menu.open':
      return {
        ...state,
        contextMenu: {
          sheetId: intent.sheetId,
          x: intent.x,
          y: intent.y,
          source: intent.source,
        },
        lastIntent: intent,
      }
    case 'sheet-tab.context-menu.close':
      return {
        ...state,
        contextMenu: null,
        lastIntent: intent,
      }
    case 'sheet-tab.rename.begin':
      return {
        ...state,
        rename: {
          sheetId: intent.sheetId,
          draftName: intent.draftName,
          source: intent.source,
        },
        lastIntent: intent,
      }
    case 'sheet-tab.rename.change':
      if (state.rename === null || state.rename.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        rename: {
          ...state.rename,
          draftName: intent.draftName,
        },
        lastIntent: intent,
      }
    case 'sheet-tab.rename.commit':
      if (state.rename === null || state.rename.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        rename: null,
        contextMenu: null,
        lastIntent: intent,
      }
    case 'sheet-tab.rename.cancel':
      if (state.rename === null || state.rename.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        rename: null,
        lastIntent: intent,
      }
    case 'sheet-tab.reorder.begin':
      return {
        ...state,
        reorder: {
          sheetId: intent.sheetId,
          beforeSheetId: null,
          afterSheetId: null,
          targetIndex: null,
          source: intent.source,
        },
        lastIntent: intent,
      }
    case 'sheet-tab.reorder.update':
      if (state.reorder === null || state.reorder.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        reorder: {
          ...state.reorder,
          beforeSheetId: intent.beforeSheetId,
          afterSheetId: intent.afterSheetId,
          targetIndex: intent.targetIndex,
        },
        lastIntent: intent,
      }
    case 'sheet-tab.reorder.commit':
      if (state.reorder === null || state.reorder.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        reorder: null,
        lastIntent: intent,
      }
    case 'sheet-tab.reorder.cancel':
      if (state.reorder === null || state.reorder.sheetId !== intent.sheetId) {
        return state
      }

      return {
        ...state,
        reorder: null,
        lastIntent: intent,
      }
    default:
      return state
  }
}

export const sheetTabsAtom = atom<SheetTabsState>(DEFAULT_SHEET_TABS_STATE)
sheetTabsAtom.debugLabel = 'spreadsheet.sheetTabs.state'

export const sheetTabsSheetStateAtom = atom<SheetTabsSheetState>(
  DEFAULT_SHEET_TABS_SHEET_STATE,
)
sheetTabsSheetStateAtom.debugLabel = 'spreadsheet.sheetTabs.sheets'

export const sheetTabsSheetsAtom = atom((get) => get(sheetTabsSheetStateAtom).sheets)
sheetTabsSheetsAtom.debugLabel = 'spreadsheet.sheetTabs.sheetList'

export const dispatchSheetTabIntentAtom = atom(
  (get) => get(sheetTabsAtom),
  (get, set, intent: SheetTabIntent): SheetTabsState => {
    const nextState = applySheetTabIntent(get(sheetTabsAtom), intent)
    set(sheetTabsAtom, nextState)
    return nextState
  },
)
dispatchSheetTabIntentAtom.debugLabel = 'spreadsheet.sheetTabs.dispatchIntent'

export const setSheetTabsSheetsAtom = atom(
  (get) => get(sheetTabsSheetStateAtom),
  (_get, set, input: SetSheetTabsSheetsInput): SheetTabsSheetState => {
    const nextState: SheetTabsSheetState = {
      sheets: normalizeSheetMetadataList(input.sheets),
      revision: input.revision,
    }
    set(sheetTabsSheetStateAtom, nextState)
    return nextState
  },
)
setSheetTabsSheetsAtom.debugLabel = 'spreadsheet.sheetTabs.setSheets'

export const patchSheetTabsSheetNameAtom = atom(
  (get) => get(sheetTabsSheetStateAtom),
  (get, set, input: { sheetId: string; name: string }): SheetTabsSheetState => {
    const normalizedName = normalizeSheetTabDraftName(input.name)
    if (normalizedName === null) {
      return get(sheetTabsSheetStateAtom)
    }

    const current = get(sheetTabsSheetStateAtom)
    const nextSheets = current.sheets.map((sheet) =>
      sheet.id === input.sheetId ? { ...sheet, name: normalizedName } : sheet,
    )
    const nextState: SheetTabsSheetState = {
      ...current,
      sheets: nextSheets,
    }
    set(sheetTabsSheetStateAtom, nextState)
    return nextState
  },
)
patchSheetTabsSheetNameAtom.debugLabel = 'spreadsheet.sheetTabs.patchSheetName'

function normalizeSheetMetadataList(
  sheets: readonly SpreadsheetSheetMetadata[],
): SpreadsheetSheetMetadata[] {
  const normalized: SpreadsheetSheetMetadata[] = []
  const seen = new Set<string>()

  sheets.forEach((sheet, index) => {
    const id = sheet.id.trim()
    const name = normalizeSheetTabDraftName(sheet.name)

    if (id.length === 0 || name === null || seen.has(id)) {
      return
    }

    seen.add(id)
    normalized.push({
      id,
      name,
      index: Number.isInteger(sheet.index) && sheet.index >= 0 ? sheet.index : index,
    })
  })

  return normalized
}

function normalizeCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.trunc(value)
}

function normalizeOptionalIndex(value: number | null): number | null {
  if (value === null) {
    return null
  }

  if (!Number.isInteger(value) || value < 0) {
    return null
  }

  return value
}
