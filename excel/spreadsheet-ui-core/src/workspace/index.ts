import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'

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

declare const workspaceActiveSheetAuthorityWitnessBrand: unique symbol

/**
 * Opaque identity for the active-sheet authority epoch. Consumers may retain
 * and compare this value by reference, but only the workspace write funnel can
 * rotate it.
 */
export interface WorkspaceActiveSheetAuthorityWitness {
  readonly [workspaceActiveSheetAuthorityWitnessBrand]: true
}

export const DEFAULT_WORKSPACE_SESSION_STATE: WorkspaceSessionState = Object.freeze({
  activeSheetId: null,
  viewportRevision: 0,
  projectionRequestRevision: 0,
  committedProjectionRequestRevision: 0,
})

const MAX_WORKSPACE_SHEET_ID_LENGTH = 512
const MAX_WORKBOOK_LOCALE_LENGTH = 128

export function createWorkspaceSessionState(
  input: Partial<WorkspaceSessionState> = {},
): WorkspaceSessionState {
  try {
    const record = input as Record<string, unknown>
    const activeSheetId = normalizeSheetId((record.activeSheetId ?? null) as string | null)
    const viewportRevision = normalizeRevision((record.viewportRevision ?? 0) as number)
    const projectionRequestRevision = normalizeRevision(
      (record.projectionRequestRevision ?? 0) as number,
    )
    const committedProjectionRequestRevision = Math.min(
      normalizeRevision((record.committedProjectionRequestRevision ?? 0) as number),
      projectionRequestRevision,
    )
    const snapshot = snapshotWorkspaceSessionInput({
      activeSheetId,
      viewportRevision,
      projectionRequestRevision,
      committedProjectionRequestRevision,
    })
    return snapshot.kind === 'valid'
      ? snapshot.value
      : snapshotWorkspaceSessionState(DEFAULT_WORKSPACE_SESSION_STATE)
  } catch {
    return snapshotWorkspaceSessionState(DEFAULT_WORKSPACE_SESSION_STATE)
  }
}

export function normalizeSheetId(sheetId: string | null): string | null {
  if (sheetId === null || typeof sheetId !== 'string') {
    return null
  }

  return sheetId.length === 0 || sheetId.length > MAX_WORKSPACE_SHEET_ID_LENGTH ? null : sheetId
}

export function normalizeRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return 0
  }

  return revision
}

export function setWorkspaceActiveSheetId(
  state: WorkspaceSessionState,
  sheetId: string | null,
): WorkspaceSessionState {
  const current = snapshotWorkspaceSessionInput(state)
  const nextSheetId = snapshotSheetIdInput(sheetId)
  if (current.kind === 'invalid' || nextSheetId.kind === 'invalid') return state

  return snapshotWorkspaceSessionState({
    ...current.value,
    activeSheetId: nextSheetId.value,
  })
}

export function advanceWorkspaceViewportRevision(
  state: WorkspaceSessionState,
  step = 1,
): WorkspaceSessionState {
  const current = snapshotWorkspaceSessionInput(state)
  const normalizedStep = normalizePositiveStep(step)
  if (
    current.kind === 'invalid' ||
    normalizedStep === null ||
    current.value.viewportRevision > Number.MAX_SAFE_INTEGER - normalizedStep
  ) {
    return state
  }
  return snapshotWorkspaceSessionState({
    ...current.value,
    viewportRevision: current.value.viewportRevision + normalizedStep,
  })
}

export function requestWorkspaceProjectionRevision(state: WorkspaceSessionState): {
  state: WorkspaceSessionState
  requestRevision: number | null
} {
  const current = snapshotWorkspaceSessionInput(state)
  if (
    current.kind === 'invalid' ||
    current.value.projectionRequestRevision === Number.MAX_SAFE_INTEGER
  ) {
    return { state, requestRevision: null }
  }
  const requestRevision = current.value.projectionRequestRevision + 1

  return {
    requestRevision,
    state: snapshotWorkspaceSessionState({
      ...current.value,
      projectionRequestRevision: requestRevision,
    }),
  }
}

export function commitWorkspaceProjectionRevision(
  state: WorkspaceSessionState,
  requestRevision: number,
): WorkspaceSessionState {
  const current = snapshotWorkspaceSessionInput(state)
  if (current.kind === 'invalid' || !Number.isSafeInteger(requestRevision) || requestRevision < 0) {
    return state
  }

  if (requestRevision !== current.value.projectionRequestRevision) {
    return state
  }

  if (requestRevision < current.value.committedProjectionRequestRevision) {
    return state
  }

  return snapshotWorkspaceSessionState({
    ...current.value,
    committedProjectionRequestRevision: requestRevision,
  })
}

export function isWorkspaceProjectionStale(
  state: WorkspaceSessionState,
  requestRevision: number,
): boolean {
  const current = snapshotWorkspaceSessionInput(state)
  if (current.kind === 'invalid' || !Number.isSafeInteger(requestRevision) || requestRevision < 0) {
    return true
  }

  return requestRevision < current.value.projectionRequestRevision
}

function normalizePositiveStep(step: number): number | null {
  if (!Number.isSafeInteger(step) || step <= 0) {
    return null
  }

  return step
}

function createWorkspaceActiveSheetAuthorityWitness(): WorkspaceActiveSheetAuthorityWitness {
  return Object.freeze({}) as WorkspaceActiveSheetAuthorityWitness
}

function snapshotWorkspaceSessionState(state: WorkspaceSessionState): WorkspaceSessionState {
  return Object.freeze({
    activeSheetId: state.activeSheetId,
    viewportRevision: state.viewportRevision,
    projectionRequestRevision: state.projectionRequestRevision,
    committedProjectionRequestRevision: state.committedProjectionRequestRevision,
  })
}

type WorkspaceSessionUpdate =
  | WorkspaceSessionState
  | ((previous: WorkspaceSessionState) => WorkspaceSessionState)

/**
 * Workbook-wide BCP-47 locale tag used by the projection-layer number-format
 * pipeline (Wave 6.3). Adapters that don't override it fall back to `'en-US'`.
 *
 * Cell-level `SpreadsheetCellFormat.locale` overrides this value when set.
 */
export const DEFAULT_WORKBOOK_LOCALE = 'en-US'

type WorkspaceInputSnapshot<T> =
  | { readonly kind: 'valid'; readonly value: T }
  | { readonly kind: 'invalid' }

function snapshotSheetIdInput(candidate: unknown): WorkspaceInputSnapshot<string | null> {
  if (candidate === null || candidate === '') return { kind: 'valid', value: null }
  return typeof candidate === 'string' && candidate.length <= MAX_WORKSPACE_SHEET_ID_LENGTH
    ? { kind: 'valid', value: candidate }
    : { kind: 'invalid' }
}

function snapshotWorkspaceSessionInput(
  candidate: unknown,
): WorkspaceInputSnapshot<WorkspaceSessionState> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const activeSheetId = snapshotSheetIdInput(record.activeSheetId)
    const viewportRevision = record.viewportRevision
    const projectionRequestRevision = record.projectionRequestRevision
    const committedProjectionRequestRevision = record.committedProjectionRequestRevision
    if (
      activeSheetId.kind === 'invalid' ||
      !Number.isSafeInteger(viewportRevision) ||
      (viewportRevision as number) < 0 ||
      !Number.isSafeInteger(projectionRequestRevision) ||
      (projectionRequestRevision as number) < 0 ||
      !Number.isSafeInteger(committedProjectionRequestRevision) ||
      (committedProjectionRequestRevision as number) < 0 ||
      (committedProjectionRequestRevision as number) > (projectionRequestRevision as number)
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({
        activeSheetId: activeSheetId.value,
        viewportRevision: viewportRevision as number,
        projectionRequestRevision: projectionRequestRevision as number,
        committedProjectionRequestRevision: committedProjectionRequestRevision as number,
      }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotSetActiveSheetInput(
  candidate: unknown,
): WorkspaceInputSnapshot<SetWorkspaceActiveSheetInput> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const sheetId = snapshotSheetIdInput((candidate as Record<string, unknown>).sheetId)
    return sheetId.kind === 'invalid'
      ? { kind: 'invalid' }
      : { kind: 'valid', value: Object.freeze({ sheetId: sheetId.value }) }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotCommitProjectionInput(
  candidate: unknown,
): WorkspaceInputSnapshot<CommitWorkspaceProjectionInput> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const requestRevision = (candidate as Record<string, unknown>).requestRevision
    return Number.isSafeInteger(requestRevision) && (requestRevision as number) >= 0
      ? {
          kind: 'valid',
          value: Object.freeze({ requestRevision: requestRevision as number }),
        }
      : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotWorkbookLocaleInput(candidate: unknown): WorkspaceInputSnapshot<string> {
  if (typeof candidate !== 'string') return { kind: 'invalid' }
  if (candidate.length === 0) return { kind: 'valid', value: DEFAULT_WORKBOOK_LOCALE }
  return candidate.length <= MAX_WORKBOOK_LOCALE_LENGTH
    ? { kind: 'valid', value: candidate }
    : { kind: 'invalid' }
}

interface WorkspaceAuthorityState {
  readonly session: WorkspaceSessionState
  readonly locale: string
  readonly activeSheetWitness: WorkspaceActiveSheetAuthorityWitness
  readonly epoch: object
}

interface WorkspaceWriteAuthority extends WorkspaceAuthorityState {
  readonly authority: WorkspaceAuthorityState
}

function createWorkspaceAuthorityState(
  session: WorkspaceSessionState,
  locale: string,
  activeSheetWitness: WorkspaceActiveSheetAuthorityWitness,
): WorkspaceAuthorityState {
  return Object.freeze({
    session,
    locale,
    activeSheetWitness,
    epoch: Object.freeze({}),
  })
}

const workspaceAuthorityStateAtom = atom<WorkspaceAuthorityState>(
  createWorkspaceAuthorityState(
    snapshotWorkspaceSessionState(DEFAULT_WORKSPACE_SESSION_STATE),
    DEFAULT_WORKBOOK_LOCALE,
    createWorkspaceActiveSheetAuthorityWitness(),
  ),
)
workspaceAuthorityStateAtom.debugLabel = 'spreadsheet.workspace.internal.authorityState'

const workspaceSessionStateAtom: Atom<WorkspaceSessionState> = atom(
  (get) => get(workspaceAuthorityStateAtom).session,
)
workspaceSessionStateAtom.debugLabel = 'spreadsheet.workspace.internal.sessionState'

function captureWorkspaceWriteAuthority(get: Getter): WorkspaceWriteAuthority {
  const authority = get(workspaceAuthorityStateAtom)
  return {
    authority,
    session: authority.session,
    locale: authority.locale,
    activeSheetWitness: authority.activeSheetWitness,
    epoch: authority.epoch,
  }
}

function workspaceWriteAuthorityIsCurrent(get: Getter, captured: WorkspaceWriteAuthority): boolean {
  const live = get(workspaceAuthorityStateAtom)
  return live === captured.authority && live.epoch === captured.epoch
}

function nextActiveSheetWitness(
  captured: WorkspaceWriteAuthority,
  nextSession: WorkspaceSessionState,
): WorkspaceActiveSheetAuthorityWitness {
  return captured.session.activeSheetId === nextSession.activeSheetId
    ? captured.activeSheetWitness
    : createWorkspaceActiveSheetAuthorityWitness()
}

function commitWorkspaceAuthority(
  set: Setter,
  captured: WorkspaceWriteAuthority,
  nextSession: WorkspaceSessionState,
  nextLocale: string,
): void {
  set(
    workspaceAuthorityStateAtom,
    createWorkspaceAuthorityState(
      nextSession,
      nextLocale,
      nextActiveSheetWitness(captured, nextSession),
    ),
  )
}

export const workspaceActiveSheetAuthorityWitnessAtom: Atom<WorkspaceActiveSheetAuthorityWitness> =
  atom((get) => get(workspaceAuthorityStateAtom).activeSheetWitness)
workspaceActiveSheetAuthorityWitnessAtom.debugLabel =
  'spreadsheet.workspace.activeSheetAuthorityWitness'

/**
 * Controlled facade preserving the original public read/write contract. The
 * private aggregate commits session, locale epoch, and active-sheet witness in
 * one core write so re-entrant observers cannot publish a split authority.
 */
export const workspaceSessionAtom = atom(
  (get) => snapshotWorkspaceSessionState(get(workspaceSessionStateAtom)),
  (get, set, update: WorkspaceSessionUpdate): void => {
    const captured = captureWorkspaceWriteAuthority(get)
    let proposedState: unknown
    try {
      proposedState =
        typeof update === 'function'
          ? update(snapshotWorkspaceSessionState(captured.session))
          : update
    } catch {
      return
    }
    const nextState = snapshotWorkspaceSessionInput(proposedState)
    if (nextState.kind === 'invalid' || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    commitWorkspaceAuthority(set, captured, nextState.value, captured.locale)
  },
)
workspaceSessionAtom.debugLabel = 'spreadsheet.workspace.session'

export const setWorkspaceActiveSheetAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, input: SetWorkspaceActiveSheetInput): WorkspaceSessionState => {
    const captured = captureWorkspaceWriteAuthority(get)
    const nextInput = snapshotSetActiveSheetInput(input)
    if (nextInput.kind === 'invalid' || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return get(workspaceSessionAtom)
    }
    const nextState = snapshotWorkspaceSessionState(
      setWorkspaceActiveSheetId(captured.session, nextInput.value.sheetId),
    )
    commitWorkspaceAuthority(set, captured, nextState, captured.locale)
    return nextState
  },
)
setWorkspaceActiveSheetAtom.debugLabel = 'spreadsheet.workspace.setActiveSheet'

export const advanceWorkspaceViewportAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, step: number = 1): WorkspaceSessionState => {
    const captured = captureWorkspaceWriteAuthority(get)
    if (!Number.isSafeInteger(step) || step <= 0) return get(workspaceSessionAtom)
    const proposed = advanceWorkspaceViewportRevision(captured.session, step)
    if (proposed === captured.session || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return get(workspaceSessionAtom)
    }
    const nextState = snapshotWorkspaceSessionState(proposed)
    commitWorkspaceAuthority(set, captured, nextState, captured.locale)
    return nextState
  },
)
advanceWorkspaceViewportAtom.debugLabel = 'spreadsheet.workspace.advanceViewportRevision'

export const requestWorkspaceProjectionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set): WorkspaceProjectionRevision | null => {
    const captured = captureWorkspaceWriteAuthority(get)
    const result = requestWorkspaceProjectionRevision(captured.session)
    if (result.requestRevision === null || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return null
    }
    const nextState = snapshotWorkspaceSessionState(result.state)
    commitWorkspaceAuthority(set, captured, nextState, captured.locale)
    return result.requestRevision
  },
)
requestWorkspaceProjectionAtom.debugLabel = 'spreadsheet.workspace.requestProjectionRevision'

export const commitWorkspaceProjectionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set, input: CommitWorkspaceProjectionInput): WorkspaceSessionState => {
    const captured = captureWorkspaceWriteAuthority(get)
    const nextInput = snapshotCommitProjectionInput(input)
    if (nextInput.kind === 'invalid' || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return get(workspaceSessionAtom)
    }
    const proposed = commitWorkspaceProjectionRevision(
      captured.session,
      nextInput.value.requestRevision,
    )
    if (proposed === captured.session) return get(workspaceSessionAtom)
    const nextState = snapshotWorkspaceSessionState(proposed)
    commitWorkspaceAuthority(set, captured, nextState, captured.locale)
    return nextState
  },
)
commitWorkspaceProjectionAtom.debugLabel = 'spreadsheet.workspace.commitProjectionRevision'

export const resetWorkspaceSessionAtom = atom(
  (get) => get(workspaceSessionAtom),
  (get, set): WorkspaceSessionState => {
    const captured = captureWorkspaceWriteAuthority(get)
    const nextState = snapshotWorkspaceSessionState(DEFAULT_WORKSPACE_SESSION_STATE)
    if (!workspaceWriteAuthorityIsCurrent(get, captured)) return get(workspaceSessionAtom)
    commitWorkspaceAuthority(set, captured, nextState, captured.locale)
    return nextState
  },
)
resetWorkspaceSessionAtom.debugLabel = 'spreadsheet.workspace.resetSession'

type WorkbookLocaleUpdate = string | ((previous: string) => string)

export const workbookLocaleAtom = atom(
  (get) => get(workspaceAuthorityStateAtom).locale,
  (get, set, update: WorkbookLocaleUpdate): void => {
    const captured = captureWorkspaceWriteAuthority(get)
    let proposedLocale: unknown
    try {
      proposedLocale = typeof update === 'function' ? update(captured.locale) : update
    } catch {
      return
    }
    const nextLocale = snapshotWorkbookLocaleInput(proposedLocale)
    if (nextLocale.kind === 'invalid' || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    commitWorkspaceAuthority(set, captured, captured.session, nextLocale.value)
  },
)
workbookLocaleAtom.debugLabel = 'spreadsheet.workspace.locale'

export const setWorkbookLocaleAtom = atom(
  (get) => get(workbookLocaleAtom),
  (get, set, locale: string): string => {
    const captured = captureWorkspaceWriteAuthority(get)
    const nextLocale = snapshotWorkbookLocaleInput(locale)
    if (nextLocale.kind === 'invalid' || !workspaceWriteAuthorityIsCurrent(get, captured)) {
      return get(workbookLocaleAtom)
    }
    commitWorkspaceAuthority(set, captured, captured.session, nextLocale.value)
    return nextLocale.value
  },
)
setWorkbookLocaleAtom.debugLabel = 'spreadsheet.workspace.setLocale'
