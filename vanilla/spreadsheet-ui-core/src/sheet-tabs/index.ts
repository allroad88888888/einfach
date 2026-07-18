import { atom } from '@einfach/core'
import type { Getter, Setter } from '@einfach/core'
import type {
  ProjectionRevision,
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetSheetMetadata,
} from '../backend'
import { selectCellAtom, selectionSnapshotAtom } from '../selection'
import {
  setWorkspaceActiveSheetAtom,
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
} from '../workspace'
import type { WorkspaceActiveSheetAuthorityWitness } from '../workspace'

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

export type SheetTabsPhase = 'unloaded' | 'loading' | 'ready'

export type SheetTabMutationKind = 'add' | 'rename' | 'delete' | 'reorder'

export type SheetTabMutationPhase = 'pending' | 'acknowledged' | 'refreshing'

export type SheetTabMutationOutcome =
  | 'acknowledged'
  | 'rejected'
  | 'protocol-error'
  | 'projection-error'

export interface SheetTabsCapabilities {
  list: boolean
  add: boolean
  rename: boolean
  delete: boolean
  reorder: boolean
}

export interface SheetTabDeleteConfirmationState {
  sheetId: string
  sheetName: string
}

export interface SheetTabMutationState {
  kind: SheetTabMutationKind
  phase: SheetTabMutationPhase
  requestId: number
  sessionId: number
  sheetId: string | null
  activeSheetIdAtDispatch: string | null
}

export interface SheetTabMutationResultState {
  kind: SheetTabMutationKind
  outcome: SheetTabMutationOutcome
  requestId: number
  sessionId: number
  sheetId: string | null
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
  phase: SheetTabsPhase
  sessionId: number
  loadRequestId: number | null
  capabilities: SheetTabsCapabilities
  mutation: SheetTabMutationState | null
  lastMutation: SheetTabMutationResultState | null
  error: string | null
  contextMenu: SheetTabContextMenuState | null
  rename: SheetTabRenameState | null
  reorder: SheetTabReorderState | null
  deleteConfirmation: SheetTabDeleteConfirmationState | null
  lastIntent: SheetTabIntent | null
}

export interface ActivateSheetTabInput {
  sheetId: string
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

export interface ReorderSheetMetadataInput {
  sheetId: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
}

export interface InitializeSheetTabsInput {
  backend: SpreadsheetBackend
  sheets: readonly SpreadsheetSheetMetadata[]
}

export interface BeginSheetTabRenameCommandInput {
  sheetId: string
  draftName: string
  source?: SheetTabInteractionSource
}

export interface CommitSheetTabRenameCommandInput {
  sheetId: string
}

export interface RequestSheetTabDeleteInput {
  sheetId: string
}

export interface CommitSheetTabReorderCommandInput {
  sheetId: string
}

interface CapturedSheetTabsPorts {
  listSheets?: () => Promise<SheetListResult>
  addSheet?: NonNullable<SpreadsheetBackend['addSheet']>
  renameSheet?: NonNullable<SpreadsheetBackend['renameSheet']>
  deleteSheet?: NonNullable<SpreadsheetBackend['deleteSheet']>
  reorderSheet?: NonNullable<SpreadsheetBackend['reorderSheet']>
}

interface SheetTabMutationPlan extends SheetTabMutationState {
  activeSheetAuthorityWitnessAtDispatch?: WorkspaceActiveSheetAuthorityWitness
  name?: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
}

const NO_SHEET_TAB_CAPABILITIES: SheetTabsCapabilities = Object.freeze({
  list: false,
  add: false,
  rename: false,
  delete: false,
  reorder: false,
})

export const DEFAULT_SHEET_TABS_STATE: SheetTabsState = {
  phase: 'unloaded',
  sessionId: 0,
  loadRequestId: null,
  capabilities: NO_SHEET_TAB_CAPABILITIES,
  mutation: null,
  lastMutation: null,
  error: null,
  contextMenu: null,
  rename: null,
  reorder: null,
  deleteConfirmation: null,
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

  const activeIndex = activeSheetId ? sheets.findIndex((sheet) => sheet.id === activeSheetId) : -1
  if (activeIndex < 0) {
    return sheets[0]?.id ?? null
  }

  const step = direction === 'previous' ? -1 : 1
  const nextIndex = (activeIndex + step + sheets.length) % sheets.length
  return sheets[nextIndex]?.id ?? null
}

export function reorderSheetMetadata(
  sheets: readonly SpreadsheetSheetMetadata[],
  input: ReorderSheetMetadataInput,
): SpreadsheetSheetMetadata[] {
  const normalized = normalizeSheetMetadataList(sheets)
  const sourceIndex = normalized.findIndex((sheet) => sheet.id === input.sheetId)
  if (sourceIndex < 0) {
    return normalized
  }

  const source = normalized[sourceIndex]
  const remaining = normalized.filter((sheet) => sheet.id !== input.sheetId)
  let targetIndex: number | null = null

  if (input.beforeSheetId && input.beforeSheetId !== input.sheetId) {
    const beforeIndex = remaining.findIndex((sheet) => sheet.id === input.beforeSheetId)
    targetIndex = beforeIndex >= 0 ? beforeIndex : null
  } else if (input.afterSheetId && input.afterSheetId !== input.sheetId) {
    const afterIndex = remaining.findIndex((sheet) => sheet.id === input.afterSheetId)
    targetIndex = afterIndex >= 0 ? afterIndex + 1 : null
  } else {
    targetIndex = normalizeOptionalIndex(input.targetIndex ?? null)
  }

  if (targetIndex === null) {
    return reindexSheetMetadata(normalized)
  }

  const clampedIndex = Math.max(0, Math.min(targetIndex, remaining.length))
  return reindexSheetMetadata([
    ...remaining.slice(0, clampedIndex),
    source,
    ...remaining.slice(clampedIndex),
  ])
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

export function createBeginSheetTabReorderIntent(input: BeginSheetTabReorderInput): SheetTabIntent {
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

export function applySheetTabIntent(state: SheetTabsState, intent: SheetTabIntent): SheetTabsState {
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

const sheetTabsPortsAtom = atom<CapturedSheetTabsPorts>({})
sheetTabsPortsAtom.debugLabel = 'spreadsheet.sheetTabs.ports'

const sheetTabsRequestSequenceAtom = atom(0)
sheetTabsRequestSequenceAtom.debugLabel = 'spreadsheet.sheetTabs.requestSequence'

export const sheetTabsSheetStateAtom = atom<SheetTabsSheetState>(DEFAULT_SHEET_TABS_SHEET_STATE)
sheetTabsSheetStateAtom.debugLabel = 'spreadsheet.sheetTabs.sheets'

export const sheetTabsSheetsAtom = atom((get) => get(sheetTabsSheetStateAtom).sheets)
sheetTabsSheetsAtom.debugLabel = 'spreadsheet.sheetTabs.sheetList'

/**
 * Canonical sheet activation command. Workspace and selection move together;
 * crossing a sheet boundary preserves the active-cell coordinate while
 * collapsing ranges and secondary regions that belong to the previous sheet.
 */
export const activateSheetTabAtom = atom(
  null,
  (get, set, input: ActivateSheetTabInput): boolean => {
    if (
      typeof input !== 'object' ||
      input === null ||
      typeof input.sheetId !== 'string' ||
      input.sheetId.length === 0 ||
      !get(sheetTabsSheetStateAtom).sheets.some((sheet) => sheet.id === input.sheetId)
    ) {
      return false
    }

    const workspace = get(workspaceSessionAtom)
    const selection = get(selectionSnapshotAtom)

    if (workspace.activeSheetId !== input.sheetId) {
      set(setWorkspaceActiveSheetAtom, { sheetId: input.sheetId })
    }
    if (selection.activeCell.sheetId !== input.sheetId) {
      set(selectCellAtom, {
        sheetId: input.sheetId,
        coord: {
          row: selection.activeCell.row,
          col: selection.activeCell.col,
        },
        extend: false,
      })
    }

    return true
  },
)
activateSheetTabAtom.debugLabel = 'spreadsheet.sheetTabs.activate'

export const sheetTabsMutationPendingAtom = atom((get) => get(sheetTabsAtom).mutation !== null)
sheetTabsMutationPendingAtom.debugLabel = 'spreadsheet.sheetTabs.mutationPending'

export const dispatchSheetTabIntentAtom = atom(
  (get) => get(sheetTabsAtom),
  (get, set, intent: SheetTabIntent): SheetTabsState => {
    const current = get(sheetTabsAtom)
    if (current.phase !== 'ready' || current.mutation !== null) {
      return current
    }
    const nextState = applySheetTabIntent(current, intent)
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

/**
 * Starts one Core-owned sheet-tab session and refreshes its bounded sheet list.
 * The backend is captured as an inert port bundle; Solid never owns load state
 * or request sequencing.
 */
export const initializeSheetTabsAtom = atom(
  null,
  async (get, set, input: InitializeSheetTabsInput): Promise<void> => {
    const previous = get(sheetTabsAtom)
    const sessionId = nextSheetTabIdentity(previous.sessionId)
    if (sessionId === null) {
      set(sheetTabsPortsAtom, {})
      set(sheetTabsAtom, {
        ...DEFAULT_SHEET_TABS_STATE,
        sessionId: previous.sessionId,
        phase: 'ready',
        error: 'Sheet-tab session identity is unavailable',
      })
      return
    }

    let ports: CapturedSheetTabsPorts
    try {
      ports = captureSheetTabsPorts(input.backend)
    } catch {
      ports = {}
    }
    const capabilities = capabilitiesFromPorts(ports)
    // A new mounted session may represent a different workbook. Never reuse
    // the prior session's projection while its new authoritative list is in
    // flight (or unavailable).
    const seedSheets = normalizeSheetMetadataList(input.sheets)
    set(sheetTabsSheetStateAtom, { sheets: seedSheets })
    commitFallbackActiveSheet(get, set, seedSheets)

    set(sheetTabsPortsAtom, ports)
    if (!ports.listSheets) {
      set(sheetTabsAtom, {
        ...DEFAULT_SHEET_TABS_STATE,
        phase: 'ready',
        sessionId,
        capabilities,
        error: 'Live sheet list is unavailable; sheet changes are disabled',
      })
      return
    }

    const loadRequestId = issueSheetTabRequestId(get, set)
    if (loadRequestId === null) {
      set(sheetTabsAtom, {
        ...DEFAULT_SHEET_TABS_STATE,
        phase: 'ready',
        sessionId,
        capabilities,
        error: 'Sheet-list request identity is unavailable',
      })
      return
    }

    set(sheetTabsAtom, {
      ...DEFAULT_SHEET_TABS_STATE,
      phase: 'loading',
      sessionId,
      loadRequestId,
      capabilities,
    })

    let result: SheetListResult
    try {
      result = await ports.listSheets()
    } catch (error) {
      settleSheetListLoadError(get, set, sessionId, loadRequestId, error)
      return
    }

    const current = get(sheetTabsAtom)
    if (
      current.sessionId !== sessionId ||
      current.phase !== 'loading' ||
      current.loadRequestId !== loadRequestId
    ) {
      return
    }

    const projection = snapshotSheetListProjection(result)
    if (projection === null) {
      settleSheetListLoadError(
        get,
        set,
        sessionId,
        loadRequestId,
        'Sheet-list projection is invalid',
      )
      return
    }

    commitSheetProjection(get, set, projection.sheets, projection.revision, null)
    const settled = get(sheetTabsAtom)
    if (
      settled.sessionId === sessionId &&
      settled.phase === 'loading' &&
      settled.loadRequestId === loadRequestId
    ) {
      set(sheetTabsAtom, {
        ...settled,
        phase: 'ready',
        loadRequestId: null,
        error: null,
      })
    }
  },
)
initializeSheetTabsAtom.debugLabel = 'spreadsheet.sheetTabs.initialize'

/** Invalidates every in-flight load/mutation owned by the mounted session. */
export const disposeSheetTabsAtom = atom(null, (get, set): void => {
  const previous = get(sheetTabsAtom)
  const sessionId = nextSheetTabIdentity(previous.sessionId) ?? previous.sessionId
  set(sheetTabsPortsAtom, {})
  set(sheetTabsAtom, {
    ...DEFAULT_SHEET_TABS_STATE,
    sessionId,
  })
})
disposeSheetTabsAtom.debugLabel = 'spreadsheet.sheetTabs.dispose'

export const beginSheetTabRenameAtom = atom(
  null,
  (get, set, input: BeginSheetTabRenameCommandInput): boolean => {
    const state = get(sheetTabsAtom)
    if (
      !sheetTabMutationCanStart(state, 'rename') ||
      !get(sheetTabsSheetsAtom).some((sheet) => sheet.id === input.sheetId)
    ) {
      return false
    }
    const intent = createBeginSheetTabRenameIntent(input)
    if (intent === null) return false
    set(sheetTabsAtom, {
      ...applySheetTabIntent(state, intent),
      error: null,
    })
    return true
  },
)
beginSheetTabRenameAtom.debugLabel = 'spreadsheet.sheetTabs.beginRename'

export const commitSheetTabRenameAtom = atom(
  null,
  async (get, set, input: CommitSheetTabRenameCommandInput): Promise<void> => {
    const state = get(sheetTabsAtom)
    const rename = state.rename
    if (
      !sheetTabMutationCanStart(state, 'rename') ||
      rename === null ||
      rename.sheetId !== input.sheetId
    ) {
      return
    }
    const name = normalizeSheetTabDraftName(rename.draftName)
    if (name === null) {
      set(sheetTabsAtom, { ...state, error: 'Sheet name cannot be empty' })
      return
    }
    const requestId = issueSheetTabRequestId(get, set)
    if (requestId === null) {
      set(sheetTabsAtom, { ...state, error: 'Sheet mutation request identity is unavailable' })
      return
    }
    await runSheetTabMutation(get, set, {
      kind: 'rename',
      phase: 'pending',
      requestId,
      sessionId: state.sessionId,
      sheetId: rename.sheetId,
      activeSheetIdAtDispatch: get(workspaceSessionAtom).activeSheetId,
      name,
    })
  },
)
commitSheetTabRenameAtom.debugLabel = 'spreadsheet.sheetTabs.commitRename'

export const addSheetTabAtom = atom(null, async (get, set): Promise<void> => {
  const state = get(sheetTabsAtom)
  if (!sheetTabMutationCanStart(state, 'add')) return
  const requestId = issueSheetTabRequestId(get, set)
  if (requestId === null) {
    set(sheetTabsAtom, { ...state, error: 'Sheet mutation request identity is unavailable' })
    return
  }
  await runSheetTabMutation(get, set, {
    kind: 'add',
    phase: 'pending',
    requestId,
    sessionId: state.sessionId,
    sheetId: null,
    activeSheetIdAtDispatch: get(workspaceSessionAtom).activeSheetId,
    activeSheetAuthorityWitnessAtDispatch: get(workspaceActiveSheetAuthorityWitnessAtom),
    name: nextSheetTabName(get(sheetTabsSheetsAtom)),
  })
})
addSheetTabAtom.debugLabel = 'spreadsheet.sheetTabs.add'

export const requestSheetTabDeleteAtom = atom(
  null,
  (get, set, input: RequestSheetTabDeleteInput): boolean => {
    const state = get(sheetTabsAtom)
    const sheets = get(sheetTabsSheetsAtom)
    const sheet = sheets.find((candidate) => candidate.id === input.sheetId)
    if (!sheetTabMutationCanStart(state, 'delete') || sheets.length <= 1 || !sheet) {
      return false
    }
    set(sheetTabsAtom, {
      ...applySheetTabIntent(state, createCloseSheetTabContextMenuIntent('committed')),
      deleteConfirmation: {
        sheetId: sheet.id,
        sheetName: sheet.name,
      },
      error: null,
    })
    return true
  },
)
requestSheetTabDeleteAtom.debugLabel = 'spreadsheet.sheetTabs.requestDelete'

export const cancelSheetTabDeleteAtom = atom(null, (get, set): void => {
  const state = get(sheetTabsAtom)
  if (state.phase !== 'ready' || state.mutation !== null) return
  set(sheetTabsAtom, {
    ...state,
    deleteConfirmation: null,
  })
})
cancelSheetTabDeleteAtom.debugLabel = 'spreadsheet.sheetTabs.cancelDelete'

export const confirmSheetTabDeleteAtom = atom(null, async (get, set): Promise<void> => {
  const state = get(sheetTabsAtom)
  const confirmation = state.deleteConfirmation
  if (!sheetTabMutationCanStart(state, 'delete') || confirmation === null) return
  if (
    get(sheetTabsSheetsAtom).length <= 1 ||
    !get(sheetTabsSheetsAtom).some((sheet) => sheet.id === confirmation.sheetId)
  ) {
    set(sheetTabsAtom, {
      ...state,
      deleteConfirmation: null,
      error: 'The selected sheet is no longer available',
    })
    return
  }
  const requestId = issueSheetTabRequestId(get, set)
  if (requestId === null) {
    set(sheetTabsAtom, { ...state, error: 'Sheet mutation request identity is unavailable' })
    return
  }
  await runSheetTabMutation(get, set, {
    kind: 'delete',
    phase: 'pending',
    requestId,
    sessionId: state.sessionId,
    sheetId: confirmation.sheetId,
    activeSheetIdAtDispatch: get(workspaceSessionAtom).activeSheetId,
  })
})
confirmSheetTabDeleteAtom.debugLabel = 'spreadsheet.sheetTabs.confirmDelete'

export const commitSheetTabReorderAtom = atom(
  null,
  async (get, set, input: CommitSheetTabReorderCommandInput): Promise<void> => {
    const state = get(sheetTabsAtom)
    const reorder = state.reorder
    if (
      !sheetTabMutationCanStart(state, 'reorder') ||
      reorder === null ||
      reorder.sheetId !== input.sheetId
    ) {
      return
    }
    const requestId = issueSheetTabRequestId(get, set)
    if (requestId === null) {
      set(sheetTabsAtom, { ...state, error: 'Sheet mutation request identity is unavailable' })
      return
    }
    await runSheetTabMutation(get, set, {
      kind: 'reorder',
      phase: 'pending',
      requestId,
      sessionId: state.sessionId,
      sheetId: reorder.sheetId,
      activeSheetIdAtDispatch: get(workspaceSessionAtom).activeSheetId,
      beforeSheetId: reorder.beforeSheetId,
      afterSheetId: reorder.afterSheetId,
      targetIndex: reorder.targetIndex,
    })
  },
)
commitSheetTabReorderAtom.debugLabel = 'spreadsheet.sheetTabs.commitReorder'

interface SheetListProjectionSnapshot {
  sheets: SpreadsheetSheetMetadata[]
  revision?: ProjectionRevision
}

function nextSheetTabIdentity(current: number): number | null {
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    return null
  }
  return current + 1
}

function issueSheetTabRequestId(get: Getter, set: Setter): number | null {
  const next = nextSheetTabIdentity(get(sheetTabsRequestSequenceAtom))
  if (next === null) return null
  set(sheetTabsRequestSequenceAtom, next)
  return next
}

function captureSheetTabsPorts(backend: SpreadsheetBackend): CapturedSheetTabsPorts {
  const listSheets = backend.listSheets
  const addSheet = backend.addSheet
  const renameSheet = backend.renameSheet
  const deleteSheet = backend.deleteSheet
  const reorderSheet = backend.reorderSheet

  return {
    ...(typeof listSheets === 'function' ? { listSheets: () => listSheets.call(backend) } : {}),
    ...(typeof addSheet === 'function'
      ? { addSheet: (request: Parameters<typeof addSheet>[0]) => addSheet.call(backend, request) }
      : {}),
    ...(typeof renameSheet === 'function'
      ? {
          renameSheet: (request: Parameters<typeof renameSheet>[0]) =>
            renameSheet.call(backend, request),
        }
      : {}),
    ...(typeof deleteSheet === 'function'
      ? {
          deleteSheet: (request: Parameters<typeof deleteSheet>[0]) =>
            deleteSheet.call(backend, request),
        }
      : {}),
    ...(typeof reorderSheet === 'function'
      ? {
          reorderSheet: (request: Parameters<typeof reorderSheet>[0]) =>
            reorderSheet.call(backend, request),
        }
      : {}),
  }
}

function capabilitiesFromPorts(ports: CapturedSheetTabsPorts): SheetTabsCapabilities {
  const list = typeof ports.listSheets === 'function'
  return {
    list,
    add: list && typeof ports.addSheet === 'function',
    rename: list && typeof ports.renameSheet === 'function',
    delete: list && typeof ports.deleteSheet === 'function',
    reorder: list && typeof ports.reorderSheet === 'function',
  }
}

function sheetTabMutationCanStart(state: SheetTabsState, kind: SheetTabMutationKind): boolean {
  return (
    state.phase === 'ready' &&
    state.sessionId > 0 &&
    state.mutation === null &&
    state.capabilities.list &&
    state.capabilities[kind]
  )
}

function snapshotSheetListProjection(result: unknown): SheetListProjectionSnapshot | null {
  if (typeof result !== 'object' || result === null) return null
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.sheets) || record.sheets.length === 0) return null

  const source = record.sheets as SpreadsheetSheetMetadata[]
  const sheets = normalizeSheetMetadataList(source)
  if (sheets.length !== source.length) return null

  const revision = record.revision
  if (
    revision !== undefined &&
    typeof revision !== 'string' &&
    !(typeof revision === 'number' && Number.isFinite(revision))
  ) {
    return null
  }

  return {
    sheets,
    ...(revision === undefined ? {} : { revision: revision as ProjectionRevision }),
  }
}

function commitFallbackActiveSheet(
  get: Getter,
  set: Setter,
  sheets: readonly SpreadsheetSheetMetadata[],
): void {
  const activeSheetId = get(workspaceSessionAtom).activeSheetId
  const nextActiveSheetId = sheets.some((sheet) => sheet.id === activeSheetId)
    ? activeSheetId
    : (sheets[0]?.id ?? null)
  if (nextActiveSheetId === null) {
    if (activeSheetId !== null) {
      set(setWorkspaceActiveSheetAtom, { sheetId: null })
    }
  } else {
    set(activateSheetTabAtom, { sheetId: nextActiveSheetId })
  }
}

function commitSheetProjection(
  get: Getter,
  set: Setter,
  sheets: readonly SpreadsheetSheetMetadata[],
  revision: ProjectionRevision | undefined,
  preferredActiveSheetId: string | null,
): void {
  const normalized = normalizeSheetMetadataList(sheets)
  set(sheetTabsSheetStateAtom, {
    sheets: normalized,
    revision,
  })

  const currentActiveSheetId = get(workspaceSessionAtom).activeSheetId
  const nextActiveSheetId =
    (preferredActiveSheetId && normalized.some((sheet) => sheet.id === preferredActiveSheetId)
      ? preferredActiveSheetId
      : null) ??
    (currentActiveSheetId && normalized.some((sheet) => sheet.id === currentActiveSheetId)
      ? currentActiveSheetId
      : null) ??
    normalized[0]?.id ??
    null

  if (nextActiveSheetId === null) {
    if (currentActiveSheetId !== null) {
      set(setWorkspaceActiveSheetAtom, { sheetId: null })
    }
  } else {
    set(activateSheetTabAtom, { sheetId: nextActiveSheetId })
  }
}

function settleSheetListLoadError(
  get: Getter,
  set: Setter,
  sessionId: number,
  loadRequestId: number,
  error: unknown,
): void {
  const state = get(sheetTabsAtom)
  if (
    state.sessionId !== sessionId ||
    state.phase !== 'loading' ||
    state.loadRequestId !== loadRequestId
  ) {
    return
  }
  set(sheetTabsAtom, {
    ...state,
    phase: 'ready',
    loadRequestId: null,
    error: sheetTabErrorMessage(error, 'Sheet list failed to load'),
  })
}

function nextSheetTabName(sheets: readonly SpreadsheetSheetMetadata[]): string {
  const names = new Set(sheets.map((sheet) => sheet.name.trim().toLocaleLowerCase()))
  let suffix = sheets.length + 1
  while (names.has(`sheet${suffix}`.toLocaleLowerCase())) suffix += 1
  return `Sheet${suffix}`
}

async function runSheetTabMutation(
  get: Getter,
  set: Setter,
  plan: SheetTabMutationPlan,
): Promise<void> {
  const state = get(sheetTabsAtom)
  if (state.sessionId !== plan.sessionId || !sheetTabMutationCanStart(state, plan.kind)) {
    return
  }

  const ports = get(sheetTabsPortsAtom)
  const sourceSheets = get(sheetTabsSheetsAtom)
  set(sheetTabsAtom, {
    ...state,
    mutation: mutationStateFromPlan(plan),
    lastMutation: null,
    error: null,
  })

  let result: SheetMutationResult
  try {
    result = await invokeSheetTabMutationPort(ports, plan, get(sheetTabsSheetStateAtom).revision)
  } catch (error) {
    settleSheetTabMutation(
      get,
      set,
      plan,
      'rejected',
      sheetTabErrorMessage(error, `Sheet ${plan.kind} failed`),
    )
    return
  }

  if (!sheetTabMutationIsCurrent(get(sheetTabsAtom), plan)) return
  if (!sheetTabMutationResultMatches(result, plan)) {
    settleSheetTabMutation(
      get,
      set,
      plan,
      'protocol-error',
      'Ignored a sheet mutation response that did not match its request',
    )
    return
  }

  const acknowledged = get(sheetTabsAtom)
  set(sheetTabsAtom, {
    ...acknowledged,
    mutation: {
      ...mutationStateFromPlan(plan),
      phase: result.sheets === undefined ? 'refreshing' : 'acknowledged',
    },
  })

  let projection: SheetListProjectionSnapshot | null
  if (result.sheets !== undefined) {
    projection = snapshotSheetListProjection({
      sheets: result.sheets,
      revision: result.revision,
    })
  } else {
    const listSheets = ports.listSheets
    if (!listSheets) {
      settleSheetTabMutation(
        get,
        set,
        plan,
        'projection-error',
        'Sheet mutation was acknowledged, but live sheet refresh is unavailable',
      )
      return
    }
    try {
      projection = snapshotSheetListProjection(await listSheets())
    } catch (error) {
      settleSheetTabMutation(
        get,
        set,
        plan,
        'projection-error',
        sheetTabErrorMessage(error, 'Sheet mutation was acknowledged, but refresh failed'),
      )
      return
    }
  }

  if (!sheetTabMutationIsCurrent(get(sheetTabsAtom), plan)) return
  if (
    projection === null ||
    !projectionConfirmsSheetTabMutation(sourceSheets, projection.sheets, result, plan)
  ) {
    settleSheetTabMutation(
      get,
      set,
      plan,
      'projection-error',
      'Sheet mutation was acknowledged, but the refreshed sheet list did not confirm it',
    )
    return
  }

  const currentActiveSheetId = get(workspaceSessionAtom).activeSheetId
  let preferredActiveSheetId = currentActiveSheetId
  if (currentActiveSheetId === plan.activeSheetIdAtDispatch) {
    if (
      plan.kind === 'add' &&
      get(workspaceActiveSheetAuthorityWitnessAtom) === plan.activeSheetAuthorityWitnessAtDispatch
    ) {
      preferredActiveSheetId = result.activeSheetId ?? result.sheetId ?? currentActiveSheetId
    } else if (plan.kind === 'delete' && currentActiveSheetId === plan.sheetId) {
      preferredActiveSheetId = result.activeSheetId ?? null
    }
  }
  commitSheetProjection(get, set, projection.sheets, projection.revision, preferredActiveSheetId)

  const settled = get(sheetTabsAtom)
  if (!sheetTabMutationIsCurrent(settled, plan)) return
  let nextState = settled
  if (plan.kind === 'rename' && plan.sheetId && plan.name) {
    const commitIntent = createCommitSheetTabRenameIntent({
      sheetId: plan.sheetId,
      name: plan.name,
      source: nextState.rename?.source,
    })
    if (commitIntent) nextState = applySheetTabIntent(nextState, commitIntent)
  } else if (plan.kind === 'reorder' && plan.sheetId) {
    nextState = applySheetTabIntent(
      nextState,
      createCommitSheetTabReorderIntent({
        sheetId: plan.sheetId,
        beforeSheetId: plan.beforeSheetId,
        afterSheetId: plan.afterSheetId,
        targetIndex: plan.targetIndex,
      }),
    )
  }
  set(sheetTabsAtom, {
    ...nextState,
    phase: 'ready',
    mutation: null,
    lastMutation: mutationResultStateFromPlan(plan, 'acknowledged'),
    error: null,
    contextMenu: null,
    deleteConfirmation: plan.kind === 'delete' ? null : nextState.deleteConfirmation,
  })
}

function invokeSheetTabMutationPort(
  ports: CapturedSheetTabsPorts,
  plan: SheetTabMutationPlan,
  revision: ProjectionRevision | undefined,
): Promise<SheetMutationResult> {
  switch (plan.kind) {
    case 'add':
      if (!ports.addSheet) throw new Error('Add sheet is unavailable')
      return ports.addSheet({
        kind: 'add-sheet',
        name: plan.name,
        requestId: plan.requestId,
        revision,
      })
    case 'rename':
      if (!ports.renameSheet || !plan.sheetId || !plan.name) {
        throw new Error('Rename sheet is unavailable')
      }
      return ports.renameSheet({
        kind: 'rename-sheet',
        sheetId: plan.sheetId,
        name: plan.name,
        requestId: plan.requestId,
        revision,
      })
    case 'delete':
      if (!ports.deleteSheet || !plan.sheetId) throw new Error('Delete sheet is unavailable')
      return ports.deleteSheet({
        kind: 'delete-sheet',
        sheetId: plan.sheetId,
        requestId: plan.requestId,
        revision,
      })
    case 'reorder':
      if (!ports.reorderSheet || !plan.sheetId) {
        throw new Error('Reorder sheet is unavailable')
      }
      return ports.reorderSheet({
        kind: 'reorder-sheet',
        sheetId: plan.sheetId,
        beforeSheetId: plan.beforeSheetId,
        afterSheetId: plan.afterSheetId,
        targetIndex: plan.targetIndex,
        requestId: plan.requestId,
        revision,
      })
  }
}

function sheetTabMutationResultMatches(
  result: unknown,
  plan: SheetTabMutationPlan,
): result is SheetMutationResult {
  if (typeof result !== 'object' || result === null) return false
  const record = result as Record<string, unknown>
  if (record.requestId !== plan.requestId) return false

  if (plan.kind === 'add') {
    if (typeof record.sheetId !== 'string' || record.sheetId.length === 0) return false
    if (
      record.createdSheet !== undefined &&
      (typeof record.createdSheet !== 'object' ||
        record.createdSheet === null ||
        (record.createdSheet as Record<string, unknown>).id !== record.sheetId)
    ) {
      return false
    }
    return true
  }
  return record.sheetId === plan.sheetId
}

function projectionConfirmsSheetTabMutation(
  sourceSheets: readonly SpreadsheetSheetMetadata[],
  projectedSheets: readonly SpreadsheetSheetMetadata[],
  result: SheetMutationResult,
  plan: SheetTabMutationPlan,
): boolean {
  switch (plan.kind) {
    case 'add':
      return projectedSheets.some(
        (sheet) => sheet.id === result.sheetId && (!plan.name || sheet.name === plan.name),
      )
    case 'rename':
      return projectedSheets.some((sheet) => sheet.id === plan.sheetId && sheet.name === plan.name)
    case 'delete':
      return (
        projectedSheets.length > 0 && projectedSheets.every((sheet) => sheet.id !== plan.sheetId)
      )
    case 'reorder': {
      if (!plan.sheetId) return false
      const expectedIds = reorderSheetMetadata(sourceSheets, {
        sheetId: plan.sheetId,
        beforeSheetId: plan.beforeSheetId,
        afterSheetId: plan.afterSheetId,
        targetIndex: plan.targetIndex,
      }).map((sheet) => sheet.id)
      return (
        expectedIds.length === projectedSheets.length &&
        expectedIds.every((sheetId, index) => sheetId === projectedSheets[index]?.id)
      )
    }
  }
}

function mutationStateFromPlan(plan: SheetTabMutationPlan): SheetTabMutationState {
  return {
    kind: plan.kind,
    phase: plan.phase,
    requestId: plan.requestId,
    sessionId: plan.sessionId,
    sheetId: plan.sheetId,
    activeSheetIdAtDispatch: plan.activeSheetIdAtDispatch,
  }
}

function mutationResultStateFromPlan(
  plan: SheetTabMutationPlan,
  outcome: SheetTabMutationOutcome,
): SheetTabMutationResultState {
  return {
    kind: plan.kind,
    outcome,
    requestId: plan.requestId,
    sessionId: plan.sessionId,
    sheetId: plan.sheetId,
  }
}

function sheetTabMutationIsCurrent(state: SheetTabsState, plan: SheetTabMutationPlan): boolean {
  return (
    state.sessionId === plan.sessionId &&
    state.mutation?.requestId === plan.requestId &&
    state.mutation.sessionId === plan.sessionId &&
    state.mutation.kind === plan.kind &&
    state.mutation.sheetId === plan.sheetId
  )
}

function settleSheetTabMutation(
  get: Getter,
  set: Setter,
  plan: SheetTabMutationPlan,
  outcome: Exclude<SheetTabMutationOutcome, 'acknowledged'>,
  error: string,
): void {
  const state = get(sheetTabsAtom)
  if (!sheetTabMutationIsCurrent(state, plan)) return
  set(sheetTabsAtom, {
    ...state,
    phase: 'ready',
    mutation: null,
    lastMutation: mutationResultStateFromPlan(plan, outcome),
    error,
  })
}

function sheetTabErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    if (message.length > 0) return message
  }
  if (typeof error === 'string' && error.trim().length > 0) return error.trim()
  return fallback
}

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

function reindexSheetMetadata(
  sheets: readonly SpreadsheetSheetMetadata[],
): SpreadsheetSheetMetadata[] {
  return sheets.map((sheet, index) => ({
    ...sheet,
    index,
  }))
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
