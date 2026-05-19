import { atom } from '@einfach/core'

export type WorkspaceProjectionRevision = number

export interface WorkspaceSessionState {
  activeSheetId: string | null
  viewportRevision: number
  projectionRequestRevision: number
  committedProjectionRequestRevision: number
}

export interface SetWorkspaceActiveSheetInput {
  sheetId: string | null
}

export interface CommitWorkspaceProjectionInput {
  requestRevision: WorkspaceProjectionRevision
}

export const DEFAULT_WORKSPACE_SESSION_STATE: WorkspaceSessionState = {
  activeSheetId: null,
  viewportRevision: 0,
  projectionRequestRevision: 0,
  committedProjectionRequestRevision: 0,
}

export function createWorkspaceSessionState(
  input: Partial<WorkspaceSessionState> = {},
): WorkspaceSessionState {
  return {
    activeSheetId: normalizeSheetId(input.activeSheetId ?? null),
    viewportRevision: normalizeRevision(input.viewportRevision ?? 0),
    projectionRequestRevision: normalizeRevision(input.projectionRequestRevision ?? 0),
    committedProjectionRequestRevision: normalizeRevision(
      input.committedProjectionRequestRevision ?? 0,
    ),
  }
}

export function normalizeSheetId(sheetId: string | null): string | null {
  if (sheetId === null) {
    return null
  }

  return sheetId.length === 0 ? null : sheetId
}

export function normalizeRevision(revision: number): number {
  if (!Number.isInteger(revision) || revision < 0) {
    return 0
  }

  return revision
}

export function setWorkspaceActiveSheetId(
  state: WorkspaceSessionState,
  sheetId: string | null,
): WorkspaceSessionState {
  return {
    ...state,
    activeSheetId: normalizeSheetId(sheetId),
  }
}

export function advanceWorkspaceViewportRevision(
  state: WorkspaceSessionState,
  step = 1,
): WorkspaceSessionState {
  return {
    ...state,
    viewportRevision: state.viewportRevision + normalizePositiveStep(step),
  }
}

export function requestWorkspaceProjectionRevision(
  state: WorkspaceSessionState,
): {
  state: WorkspaceSessionState
  requestRevision: number
} {
  const requestRevision = state.projectionRequestRevision + 1

  return {
    requestRevision,
    state: {
      ...state,
      projectionRequestRevision: requestRevision,
    },
  }
}

export function commitWorkspaceProjectionRevision(
  state: WorkspaceSessionState,
  requestRevision: number,
): WorkspaceSessionState {
  if (!Number.isInteger(requestRevision) || requestRevision < 0) {
    return state
  }

  if (requestRevision !== state.projectionRequestRevision) {
    return state
  }

  if (requestRevision < state.committedProjectionRequestRevision) {
    return state
  }

  return {
    ...state,
    committedProjectionRequestRevision: requestRevision,
  }
}

export function isWorkspaceProjectionStale(
  state: WorkspaceSessionState,
  requestRevision: number,
): boolean {
  return (
    Number.isInteger(requestRevision) &&
    requestRevision >= 0 &&
    requestRevision < state.projectionRequestRevision
  )
}

function normalizePositiveStep(step: number): number {
  if (!Number.isInteger(step) || step <= 0) {
    return 1
  }

  return step
}

export const workspaceSessionAtom = atom<WorkspaceSessionState>(DEFAULT_WORKSPACE_SESSION_STATE)
workspaceSessionAtom.debugLabel = 'spreadsheet.workspace.session'

export const setWorkspaceActiveSheetAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, input: SetWorkspaceActiveSheetInput): WorkspaceSessionState => {
    const nextState = setWorkspaceActiveSheetId(get(workspaceSessionAtom), input.sheetId)
    set(workspaceSessionAtom, nextState)
    return nextState
  },
)
setWorkspaceActiveSheetAtom.debugLabel = 'spreadsheet.workspace.setActiveSheet'

export const advanceWorkspaceViewportAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, step: number = 1): WorkspaceSessionState => {
    const nextState = advanceWorkspaceViewportRevision(get(workspaceSessionAtom), step)
    set(workspaceSessionAtom, nextState)
    return nextState
  },
)
advanceWorkspaceViewportAtom.debugLabel = 'spreadsheet.workspace.advanceViewportRevision'

export const requestWorkspaceProjectionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set): WorkspaceProjectionRevision => {
    const result = requestWorkspaceProjectionRevision(get(workspaceSessionAtom))
    set(workspaceSessionAtom, result.state)
    return result.requestRevision
  },
)
requestWorkspaceProjectionAtom.debugLabel = 'spreadsheet.workspace.requestProjectionRevision'

export const commitWorkspaceProjectionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, input: CommitWorkspaceProjectionInput): WorkspaceSessionState => {
    const nextState = commitWorkspaceProjectionRevision(
      get(workspaceSessionAtom),
      input.requestRevision,
    )
    set(workspaceSessionAtom, nextState)
    return nextState
  },
)
commitWorkspaceProjectionAtom.debugLabel = 'spreadsheet.workspace.commitProjectionRevision'

export const resetWorkspaceSessionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (_get, set): WorkspaceSessionState => {
    set(workspaceSessionAtom, DEFAULT_WORKSPACE_SESSION_STATE)
    return DEFAULT_WORKSPACE_SESSION_STATE
  },
)
resetWorkspaceSessionAtom.debugLabel = 'spreadsheet.workspace.resetSession'

/**
 * Workbook-wide BCP-47 locale tag used by the projection-layer number-format
 * pipeline (Wave 6.3). Adapters that don't override it fall back to `'en-US'`.
 *
 * Cell-level `SpreadsheetCellFormat.locale` overrides this value when set.
 */
export const DEFAULT_WORKBOOK_LOCALE = 'en-US'

export const workbookLocaleAtom = atom<string>(DEFAULT_WORKBOOK_LOCALE)
workbookLocaleAtom.debugLabel = 'spreadsheet.workspace.locale'

export const setWorkbookLocaleAtom = atom(
  (get) => get(workbookLocaleAtom),
  (_get, set, locale: string): string => {
    const next = typeof locale === 'string' && locale.length > 0 ? locale : DEFAULT_WORKBOOK_LOCALE
    set(workbookLocaleAtom, next)
    return next
  },
)
setWorkbookLocaleAtom.debugLabel = 'spreadsheet.workspace.setLocale'
