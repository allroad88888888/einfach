import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'
import { clipboardStateAtom } from '../clipboard'
import type { ClipboardPayloadDescriptor, ClipboardRangeDescriptor } from '../clipboard/types'
import {
  acquireHistoryProducerReservationAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  type HistoryProducerReservation,
} from '../history'
import { selectionSnapshotAtom } from '../selection'
import type { CellRange } from '../shared'
import { workspaceSessionAtom } from '../workspace'
import {
  DEFAULT_PASTE_SPECIAL_OPTIONS,
  type ConfirmPasteSpecialInput,
  type PasteRangeRequest,
  type PasteRangeResult,
  type PasteSpecialControllerPort,
  type PasteSpecialKind,
  type PasteSpecialLifecycleState,
  type PasteSpecialMutationOutcome,
  type PasteSpecialOptions,
  type PasteSpecialSessionSnapshot,
} from './types'

export * from './types'

export const PASTE_SPECIAL_CAPABILITY_ERROR =
  'Paste Special is unavailable because this workbook does not provide pasteRange.'
export const PASTE_SPECIAL_CONTEXT_ERROR =
  'Paste Special needs a copied range and an active target selection. Close the dialog, copy a range, and try again.'
export const PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR =
  'Paste Special for column widths and comments is not supported by the current backend.'
export const PASTE_SPECIAL_ACKNOWLEDGEMENT_ERROR =
  'Paste Special acknowledgement did not match the active request.'
export const PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR =
  'Paste Special may have been applied, but the backend did not return a matching ' +
  'acknowledgement. To avoid a duplicate paste, this request cannot be sent again. ' +
  'Refresh or reconcile the workbook before continuing.'
export const PASTE_SPECIAL_REFRESH_ERROR_PREFIX =
  'Paste Special was acknowledged, but projection refresh failed: '
export const PASTE_SPECIAL_HISTORY_BUSY_ERROR =
  'Paste Special is blocked because another history producer owns the mutation lane.'

export const SUPPORTED_PASTE_SPECIAL_KINDS: readonly PasteSpecialKind[] = Object.freeze([
  'values',
  'formats',
  'values-and-formats',
  'all',
  'transpose',
])

export const PASTE_SPECIAL_BACKEND_KIND_ERROR_PREFIX =
  'Paste Special kind is not supported by the current backend: '

/** Structured pre-dispatch reason for a kind the active backend excluded. */
export function pasteSpecialBackendKindError(kind: PasteSpecialKind): string {
  return `${PASTE_SPECIAL_BACKEND_KIND_ERROR_PREFIX}${kind}.`
}

/**
 * Fail-closed normalization of a backend's `pasteRangeSupportedKinds`
 * declaration: no declaration keeps the legacy full-trust contract, a
 * declaration is intersected with the Core-supported set.
 */
function normalizeSupportedKinds(declared: unknown): readonly PasteSpecialKind[] {
  if (!Array.isArray(declared)) return SUPPORTED_PASTE_SPECIAL_KINDS
  const declaredKinds = declared as readonly unknown[]
  return Object.freeze(SUPPORTED_PASTE_SPECIAL_KINDS.filter((kind) => declaredKinds.includes(kind)))
}

const INITIAL_PASTE_SPECIAL_LIFECYCLE: PasteSpecialLifecycleState = Object.freeze({
  status: 'closed',
  sessionId: 0,
  requestId: null,
  sheetId: null,
})

interface PasteSpecialMutationTicket {
  readonly sessionId: number
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly sessionWitness: PasteSpecialSessionSnapshot
  readonly target: CellRange
  readonly request: PasteRangeRequest
  readonly historyReservation: HistoryProducerReservation
  readonly acknowledgement: PasteSpecialAcknowledgement | null
}

interface PasteSpecialAcknowledgement {
  readonly kind: 'paste-range'
  readonly sheetId: string
  readonly requestId: ProjectionRequestId
  readonly revision: ProjectionRevision
  readonly affectedRange: CellRange
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown Paste Special transport failure.'
  }
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

export function nextPasteSpecialSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextPasteSpecialRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function isPasteSpecialKindSupported(kind: PasteSpecialKind): boolean {
  return kind !== 'column-widths' && kind !== 'comments'
}

function snapshotRange(range: CellRange | null | undefined): CellRange | null {
  if (range == null) return null
  try {
    return Object.freeze({
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      colStart: range.colStart,
      colEnd: range.colEnd,
    })
  } catch {
    return null
  }
}

function snapshotSource(
  source: ClipboardRangeDescriptor | null | undefined,
): ClipboardRangeDescriptor | null {
  if (source == null) return null
  try {
    const range = snapshotRange(source.range)
    if (range === null || typeof source.sheetId !== 'string') return null
    return Object.freeze({ sheetId: source.sheetId, range })
  } catch {
    return null
  }
}

function snapshotPayload(
  payload: ClipboardPayloadDescriptor | null | undefined,
): ClipboardPayloadDescriptor | null {
  if (payload == null) return null
  try {
    const source = snapshotSource(payload.source)
    if (source === null) return null
    return Object.freeze({
      kind: payload.kind,
      source,
      serialization: payload.serialization,
      cellCount: payload.cellCount,
      estimatedBytes: payload.estimatedBytes,
      truncated: payload.truncated,
      includesFormulas: payload.includesFormulas,
      includesErrors: payload.includesErrors,
    })
  } catch {
    return null
  }
}

function snapshotOptions(options: PasteSpecialOptions): PasteSpecialOptions {
  return Object.freeze({
    kind: options.kind,
    op: options.op,
    transpose: options.transpose,
    skipBlanks: options.skipBlanks,
  })
}

function validRange(range: CellRange | null): range is CellRange {
  return (
    range !== null &&
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowStart <= range.rowEnd &&
    range.colStart <= range.colEnd
  )
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function sessionBlockReason(
  session: PasteSpecialSessionSnapshot | null,
  capability: boolean,
  supportedKinds: readonly PasteSpecialKind[],
): string | null {
  if (session !== null && !isPasteSpecialKindSupported(session.options.kind)) {
    return PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR
  }
  if (!capability) return PASTE_SPECIAL_CAPABILITY_ERROR
  if (session !== null && !supportedKinds.includes(session.options.kind)) {
    return pasteSpecialBackendKindError(session.options.kind)
  }
  if (
    session === null ||
    session.sheetId === null ||
    session.sheetId.length === 0 ||
    !validRange(session.target) ||
    session.source === null ||
    session.source.sheetId.length === 0 ||
    !validRange(session.source.range) ||
    session.payload === null ||
    session.payload.source.sheetId !== session.source.sheetId ||
    !sameRange(session.payload.source.range, session.source.range)
  ) {
    return PASTE_SPECIAL_CONTEXT_ERROR
  }
  return null
}

function lifecycleFor(
  status: PasteSpecialLifecycleState['status'],
  sessionId: number,
  sheetId: string | null,
  requestId: ProjectionRequestId | null = null,
): PasteSpecialLifecycleState {
  return Object.freeze({ status, sessionId, requestId, sheetId })
}

function blocksPasteSpecialClose(status: PasteSpecialLifecycleState['status']): boolean {
  return status === 'pending' || status === 'local-acknowledged' || status === 'refreshing'
}

function snapshotAcknowledgement(
  acknowledgement: unknown,
  ticket: PasteSpecialMutationTicket,
): PasteSpecialAcknowledgement | null {
  try {
    if (typeof acknowledgement !== 'object' || acknowledgement === null) return null
    const result = acknowledgement as Partial<PasteRangeResult>
    const kind = result.kind
    const sheetId = result.sheetId
    const requestId = result.requestId
    const revision = result.revision
    const affectedRange = result.affectedRange
    if (
      kind !== 'paste-range' ||
      sheetId !== ticket.sheetId ||
      requestId !== ticket.requestId ||
      !(
        (typeof revision === 'number' && Number.isFinite(revision)) ||
        (typeof revision === 'string' && revision.length > 0)
      ) ||
      typeof affectedRange !== 'object' ||
      affectedRange === null
    ) {
      return null
    }
    const rowStart = affectedRange.rowStart
    const rowEnd = affectedRange.rowEnd
    const colStart = affectedRange.colStart
    const colEnd = affectedRange.colEnd
    const rangeSnapshot = Object.freeze({ rowStart, rowEnd, colStart, colEnd })
    if (!validRange(rangeSnapshot)) return null
    return Object.freeze({
      kind,
      sheetId,
      requestId,
      revision,
      affectedRange: rangeSnapshot,
    })
  } catch {
    return null
  }
}

const pasteSpecialOpenBackingAtom = atom<boolean>(false)
const pasteSpecialOptionsBackingAtom = atom<PasteSpecialOptions>(
  snapshotOptions(DEFAULT_PASTE_SPECIAL_OPTIONS),
)
const pasteSpecialSessionBackingAtom = atom<PasteSpecialSessionSnapshot | null>(null)
const pasteSpecialLifecycleBackingAtom = atom<PasteSpecialLifecycleState>(
  INITIAL_PASTE_SPECIAL_LIFECYCLE,
)
const pasteSpecialErrorBackingAtom = atom<string>('')
const pasteSpecialCapabilityBackingAtom = atom<boolean>(false)
const pasteSpecialSupportedKindsBackingAtom = atom<readonly PasteSpecialKind[]>(
  SUPPORTED_PASTE_SPECIAL_KINDS,
)
const pasteSpecialSessionIdBackingAtom = atom<number>(0)
const pasteSpecialRequestIdBackingAtom = atom<number>(0)

/** Whether the Paste Special dialog is visible. Core is its only writer. */
export const pasteSpecialOpenAtom: Atom<boolean> = atom((get) => get(pasteSpecialOpenBackingAtom))
pasteSpecialOpenAtom.debugLabel = 'spreadsheet.pasteSpecial.open'

/** Core-owned form state, mirrored into the active frozen session by the patch command. */
export const pasteSpecialOptionsAtom: Atom<PasteSpecialOptions> = atom((get) =>
  get(pasteSpecialOptionsBackingAtom),
)
pasteSpecialOptionsAtom.debugLabel = 'spreadsheet.pasteSpecial.options'

export const pasteSpecialSessionAtom: Atom<PasteSpecialSessionSnapshot | null> = atom((get) =>
  get(pasteSpecialSessionBackingAtom),
)
pasteSpecialSessionAtom.debugLabel = 'spreadsheet.pasteSpecial.session'

export const pasteSpecialLifecycleAtom: Atom<PasteSpecialLifecycleState> = atom((get) =>
  get(pasteSpecialLifecycleBackingAtom),
)
pasteSpecialLifecycleAtom.debugLabel = 'spreadsheet.pasteSpecial.lifecycle'

export const pasteSpecialErrorAtom: Atom<string> = atom((get) => get(pasteSpecialErrorBackingAtom))
pasteSpecialErrorAtom.debugLabel = 'spreadsheet.pasteSpecial.error'

/** Read-only projection of the capability captured from the active backend. */
export const pasteSpecialCapabilityAtom: Atom<boolean> = atom((get) =>
  get(pasteSpecialCapabilityBackingAtom),
)
pasteSpecialCapabilityAtom.debugLabel = 'spreadsheet.pasteSpecial.capability'

/**
 * Kinds the captured backend really applies. Defaults to every
 * Core-supported kind (legacy full-trust) until a backend declaring
 * `pasteRangeSupportedKinds` is captured.
 */
export const pasteSpecialSupportedKindsAtom: Atom<readonly PasteSpecialKind[]> = atom((get) =>
  get(pasteSpecialSupportedKindsBackingAtom),
)
pasteSpecialSupportedKindsAtom.debugLabel = 'spreadsheet.pasteSpecial.supportedKinds'

export const pasteSpecialSessionIdAtom: Atom<number> = atom((get) =>
  get(pasteSpecialSessionIdBackingAtom),
)
pasteSpecialSessionIdAtom.debugLabel = 'spreadsheet.pasteSpecial.sessionId'

export const pasteSpecialRequestIdAtom: Atom<number> = atom((get) =>
  get(pasteSpecialRequestIdBackingAtom),
)
pasteSpecialRequestIdAtom.debugLabel = 'spreadsheet.pasteSpecial.requestId'

const activePasteSpecialMutationAtom = atom<PasteSpecialMutationTicket | null>(null)
activePasteSpecialMutationAtom.debugLabel = 'spreadsheet.pasteSpecial.activeMutation'

export const pasteSpecialCanEditAtom = atom((get) => {
  const lifecycle = get(pasteSpecialLifecycleAtom)
  return (
    get(pasteSpecialOpenAtom) &&
    get(activePasteSpecialMutationAtom) === null &&
    (lifecycle.status === 'editing' ||
      lifecycle.status === 'blocked' ||
      lifecycle.status === 'error')
  )
})
pasteSpecialCanEditAtom.debugLabel = 'spreadsheet.pasteSpecial.canEdit'

export const pasteSpecialCanConfirmAtom = atom((get) => {
  const lifecycle = get(pasteSpecialLifecycleAtom)
  return (
    get(pasteSpecialOpenAtom) &&
    get(pasteSpecialCapabilityAtom) &&
    sessionBlockReason(get(pasteSpecialSessionAtom), true, get(pasteSpecialSupportedKindsAtom)) ===
      null &&
    (lifecycle.status === 'editing' ||
      lifecycle.status === 'blocked' ||
      lifecycle.status === 'error')
  )
})
pasteSpecialCanConfirmAtom.debugLabel = 'spreadsheet.pasteSpecial.canConfirm'

/**
 * Closing is unavailable while a launched mutation still needs its strict
 * acknowledgement/history/refresh bookkeeping. Losing that session could
 * leave an applied paste without the corresponding local projection update.
 */
export const pasteSpecialCanCloseAtom = atom((get) => {
  return (
    get(pasteSpecialOpenAtom) && !blocksPasteSpecialClose(get(pasteSpecialLifecycleAtom).status)
  )
})
pasteSpecialCanCloseAtom.debugLabel = 'spreadsheet.pasteSpecial.canClose'

function sessionAuthorityIsCurrent(
  get: Getter,
  session: PasteSpecialSessionSnapshot,
  lifecycle: PasteSpecialLifecycleState,
): boolean {
  return (
    get(activePasteSpecialMutationAtom) === null &&
    get(pasteSpecialOpenAtom) &&
    get(pasteSpecialSessionAtom) === session &&
    get(pasteSpecialSessionIdAtom) === session.sessionId &&
    get(pasteSpecialLifecycleAtom) === lifecycle
  )
}

function ticketIsCurrent(get: Getter, ticket: PasteSpecialMutationTicket): boolean {
  const active = get(activePasteSpecialMutationAtom)
  const lifecycle = get(pasteSpecialLifecycleAtom)
  const session = get(pasteSpecialSessionAtom)
  return (
    active === ticket &&
    get(pasteSpecialOpenAtom) &&
    get(pasteSpecialSessionIdAtom) === ticket.sessionId &&
    session === ticket.sessionWitness &&
    session.sheetId === ticket.sheetId &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.requestId === ticket.requestId
  )
}

/**
 * Closing abandons any retained ticket outright (outcome-unknown or a
 * refresh-failure never resolve on their own). Excel never traps a dialog:
 * once acknowledged, the paste itself already reached the backend, so a
 * stale local reservation must not block the user from dismissing it.
 */
function closePasteSpecialSession(get: Getter, set: Setter): void {
  const nextSessionId = nextPasteSpecialSessionId(get(pasteSpecialSessionIdAtom))
  if (nextSessionId !== null) set(pasteSpecialSessionIdBackingAtom, nextSessionId)
  const sessionId = nextSessionId ?? get(pasteSpecialSessionIdAtom)
  // A retained ticket (outcome-unknown, or an acknowledged paste whose
  // refresh keeps failing) still owns the history producer reservation.
  // Abandoning the dialog must release it too, or the shared lane would
  // stay locked forever with no ticket left to reconcile it.
  const active = get(activePasteSpecialMutationAtom)
  if (active !== null) set(releaseHistoryProducerReservationAtom, active.historyReservation)
  set(activePasteSpecialMutationAtom, null)
  set(pasteSpecialOpenBackingAtom, false)
  set(pasteSpecialSessionBackingAtom, null)
  set(pasteSpecialOptionsBackingAtom, snapshotOptions(DEFAULT_PASTE_SPECIAL_OPTIONS))
  set(pasteSpecialErrorBackingAtom, '')
  set(pasteSpecialLifecycleBackingAtom, lifecycleFor('closed', sessionId, null))
}

export const capturePasteSpecialCapabilityAtom = atom(
  null,
  (get, set, source: PasteSpecialControllerPort) => {
    let available = false
    try {
      available = typeof source?.pasteRange === 'function'
    } catch {
      available = false
    }
    let declaredKinds: unknown
    try {
      declaredKinds = available ? source?.pasteRangeSupportedKinds : undefined
    } catch {
      declaredKinds = undefined
    }
    set(pasteSpecialCapabilityBackingAtom, available)
    set(pasteSpecialSupportedKindsBackingAtom, normalizeSupportedKinds(declaredKinds))
    if (!get(pasteSpecialOpenAtom)) return

    const session = get(pasteSpecialSessionAtom)
    const lifecycle = get(pasteSpecialLifecycleAtom)
    if (
      get(activePasteSpecialMutationAtom) !== null ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'outcome-unknown' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing'
    ) {
      return
    }
    const reason = sessionBlockReason(session, available, get(pasteSpecialSupportedKindsAtom))
    if (reason !== null) {
      set(pasteSpecialErrorBackingAtom, reason)
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor(
          'blocked',
          session?.sessionId ?? get(pasteSpecialSessionIdAtom),
          session?.sheetId ?? null,
        ),
      )
      return
    }

    if (lifecycle.status === 'blocked') {
      set(pasteSpecialErrorBackingAtom, '')
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('editing', session!.sessionId, session!.sheetId),
      )
    }
  },
)
capturePasteSpecialCapabilityAtom.debugLabel = 'spreadsheet.pasteSpecial.captureCapability'

/** Open and freeze target, clipboard and default options as one Core session. */
export const openPasteSpecialAtom = atom(null, (get, set) => {
  // Reopening an already-visible dialog is equivalent to replacing its
  // session. Preserve the current owner while acknowledgement/history/refresh
  // bookkeeping is incomplete.
  if (get(activePasteSpecialMutationAtom) !== null) return
  if (get(pasteSpecialOpenAtom) && blocksPasteSpecialClose(get(pasteSpecialLifecycleAtom).status)) {
    return
  }

  const sessionId = nextPasteSpecialSessionId(get(pasteSpecialSessionIdAtom))
  if (sessionId === null) {
    set(pasteSpecialErrorBackingAtom, 'Paste Special session identity space is exhausted.')
    return
  }

  let sheetId: string | null = null
  let target: CellRange | null = null
  let source: ClipboardRangeDescriptor | null = null
  let payload: ClipboardPayloadDescriptor | null = null
  try {
    const selection = get(selectionSnapshotAtom)
    const workspace = get(workspaceSessionAtom)
    const clipboard = get(clipboardStateAtom)
    sheetId = selection.selection.sheetId || workspace.activeSheetId || null
    target = snapshotRange(selection.range)
    source = snapshotSource(clipboard.source)
    payload = snapshotPayload(clipboard.payload)
  } catch {
    // The blocked session below explains that its frozen context is incomplete.
  }

  // A backend that subdivides the capability may exclude the default
  // kind (format-leg kinds on a format-model-less runtime). Open on the
  // first supported kind instead of opening pre-blocked.
  const supportedKinds = get(pasteSpecialSupportedKindsAtom)
  const options = snapshotOptions(
    supportedKinds.includes(DEFAULT_PASTE_SPECIAL_OPTIONS.kind) || supportedKinds.length === 0
      ? DEFAULT_PASTE_SPECIAL_OPTIONS
      : { ...DEFAULT_PASTE_SPECIAL_OPTIONS, kind: supportedKinds[0] },
  )
  const session: PasteSpecialSessionSnapshot = Object.freeze({
    sessionId,
    sheetId,
    target,
    source,
    payload,
    options,
  })
  const reason = sessionBlockReason(session, get(pasteSpecialCapabilityAtom), supportedKinds)
  set(pasteSpecialSessionIdBackingAtom, sessionId)
  set(activePasteSpecialMutationAtom, null)
  set(pasteSpecialSessionBackingAtom, session)
  set(pasteSpecialOptionsBackingAtom, options)
  set(pasteSpecialOpenBackingAtom, true)
  set(pasteSpecialErrorBackingAtom, reason ?? '')
  set(
    pasteSpecialLifecycleBackingAtom,
    lifecycleFor(reason === null ? 'editing' : 'blocked', sessionId, sheetId),
  )
})
openPasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.openCommand'

/** Close invalidates the session before any late transport result can commit. */
export const closePasteSpecialAtom = atom(null, (get, set) => {
  if (!get(pasteSpecialCanCloseAtom)) return
  closePasteSpecialSession(get, set)
})
closePasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.closeCommand'

/** Patch the Core draft and the active session atomically. */
export const patchPasteSpecialOptionsAtom = atom(
  null,
  (get, set, patch: Partial<PasteSpecialOptions>) => {
    const lifecycle = get(pasteSpecialLifecycleAtom)
    if (
      lifecycle.status === 'pending' ||
      lifecycle.status === 'outcome-unknown' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing' ||
      get(activePasteSpecialMutationAtom) !== null
    ) {
      return
    }
    const next = snapshotOptions({ ...get(pasteSpecialOptionsAtom), ...patch })
    set(pasteSpecialOptionsBackingAtom, next)

    const session = get(pasteSpecialSessionAtom)
    if (session === null || !get(pasteSpecialOpenAtom)) return
    const nextSession = Object.freeze({ ...session, options: next })
    const reason = sessionBlockReason(
      nextSession,
      get(pasteSpecialCapabilityAtom),
      get(pasteSpecialSupportedKindsAtom),
    )
    set(pasteSpecialSessionBackingAtom, nextSession)
    set(pasteSpecialErrorBackingAtom, reason ?? '')
    set(
      pasteSpecialLifecycleBackingAtom,
      lifecycleFor(reason === null ? 'editing' : 'blocked', session.sessionId, session.sheetId),
    )
  },
)
patchPasteSpecialOptionsAtom.debugLabel = 'spreadsheet.pasteSpecial.patchOptions'

/**
 * Core owns transport reservation, strict acknowledgement, history, refresh and retry.
 * A refresh-only retry never sends the already-acknowledged paste a second time.
 */
export const confirmPasteSpecialAtom = atom(
  null,
  async (get, set, input: ConfirmPasteSpecialInput): Promise<PasteSpecialMutationOutcome> => {
    let source: PasteSpecialControllerPort
    let inputSessionId: number
    let refreshProjection: ((sheetId: string) => Promise<void>) | undefined
    try {
      source = input.source
      inputSessionId = input.sessionId
      refreshProjection = input.refreshProjection
    } catch {
      return 'stale'
    }

    const active = get(activePasteSpecialMutationAtom)
    if (active !== null) {
      const lifecycle = get(pasteSpecialLifecycleAtom)
      if (
        active.acknowledgement === null ||
        inputSessionId !== active.sessionId ||
        lifecycle.status !== 'error' ||
        typeof refreshProjection !== 'function'
      ) {
        return lifecycle.status === 'outcome-unknown' ? 'blocked' : 'stale'
      }

      set(pasteSpecialErrorBackingAtom, '')
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('refreshing', active.sessionId, active.sheetId, active.requestId),
      )
      await Promise.resolve()
      if (!ticketIsCurrent(get, active)) return 'stale'
      set(pasteSpecialLifecycleBackingAtom, get(pasteSpecialLifecycleAtom))
      try {
        await refreshProjection(active.sheetId)
      } catch (error) {
        if (!ticketIsCurrent(get, active)) return 'stale'
        set(
          pasteSpecialErrorBackingAtom,
          `${PASTE_SPECIAL_REFRESH_ERROR_PREFIX}${errorMessage(error)}`,
        )
        set(
          pasteSpecialLifecycleBackingAtom,
          lifecycleFor('error', active.sessionId, active.sheetId, active.requestId),
        )
        return 'error'
      }
      if (!ticketIsCurrent(get, active)) return 'stale'
      if (!set(releaseHistoryProducerReservationAtom, active.historyReservation)) {
        set(
          pasteSpecialErrorBackingAtom,
          `${PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR} History ownership could not be reconciled ` +
            'after refresh.',
        )
        set(
          pasteSpecialLifecycleBackingAtom,
          lifecycleFor('outcome-unknown', active.sessionId, active.sheetId, active.requestId),
        )
        return 'outcome-unknown'
      }
      set(activePasteSpecialMutationAtom, null)
      closePasteSpecialSession(get, set)
      return 'completed'
    }

    const session = get(pasteSpecialSessionAtom)
    const lifecycle = get(pasteSpecialLifecycleAtom)
    if (
      !get(pasteSpecialOpenAtom) ||
      session === null ||
      inputSessionId !== session.sessionId ||
      lifecycle.sessionId !== session.sessionId ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'outcome-unknown' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing'
    ) {
      return 'stale'
    }

    const reason = sessionBlockReason(
      session,
      get(pasteSpecialCapabilityAtom),
      get(pasteSpecialSupportedKindsAtom),
    )
    if (reason !== null || typeof refreshProjection !== 'function') {
      set(pasteSpecialErrorBackingAtom, reason ?? PASTE_SPECIAL_CONTEXT_ERROR)
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    let execute: PasteSpecialControllerPort['pasteRange']
    try {
      execute = source?.pasteRange
    } catch {
      execute = undefined
    }
    if (!sessionAuthorityIsCurrent(get, session, lifecycle)) return 'stale'
    if (typeof execute !== 'function') {
      set(pasteSpecialErrorBackingAtom, PASTE_SPECIAL_CAPABILITY_ERROR)
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    const requestId = nextPasteSpecialRequestId(get(pasteSpecialRequestIdAtom))
    if (requestId === null) {
      set(pasteSpecialErrorBackingAtom, 'Paste Special request identity space is exhausted.')
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    const request: PasteRangeRequest = Object.freeze({
      kind: 'paste-range',
      sheetId: session.sheetId!,
      target: session.target!,
      source: Object.freeze({
        sheetId: session.source!.sheetId,
        range: session.source!.range,
        payload: session.payload,
      }),
      pasteKind: session.options.kind,
      op: session.options.op,
      transpose: session.options.transpose,
      skipBlanks: session.options.skipBlanks,
      requestId,
    })
    if (!sessionAuthorityIsCurrent(get, session, lifecycle)) return 'stale'
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      set(pasteSpecialErrorBackingAtom, PASTE_SPECIAL_HISTORY_BUSY_ERROR)
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }
    const ticket: PasteSpecialMutationTicket = Object.freeze({
      sessionId: session.sessionId,
      requestId,
      sheetId: session.sheetId!,
      sessionWitness: session,
      target: session.target!,
      request,
      historyReservation,
      acknowledgement: null,
    })
    set(pasteSpecialRequestIdBackingAtom, requestId)
    set(activePasteSpecialMutationAtom, ticket)
    set(pasteSpecialErrorBackingAtom, '')
    set(
      pasteSpecialLifecycleBackingAtom,
      lifecycleFor('pending', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )

    // Publish reservation before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!ticketIsCurrent(get, ticket)) return 'stale'
    set(pasteSpecialLifecycleBackingAtom, get(pasteSpecialLifecycleAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await execute.call(source, ticket.request)
    } catch (error) {
      if (!ticketIsCurrent(get, ticket)) return 'stale'
      set(
        pasteSpecialErrorBackingAtom,
        `${PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR} Backend detail: ${errorMessage(error)}`,
      )
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }

    if (!ticketIsCurrent(get, ticket)) return 'stale'
    const acknowledgementSnapshot = snapshotAcknowledgement(acknowledgement, ticket)
    if (!ticketIsCurrent(get, ticket)) return 'stale'
    if (acknowledgementSnapshot === null) {
      set(
        pasteSpecialErrorBackingAtom,
        `${PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR} ${PASTE_SPECIAL_ACKNOWLEDGEMENT_ERROR}`,
      )
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }

    const acknowledgedTicket: PasteSpecialMutationTicket = Object.freeze({
      ...ticket,
      acknowledgement: acknowledgementSnapshot,
    })
    set(activePasteSpecialMutationAtom, acknowledgedTicket)
    const historyRecorded = set(pushReservedHistoryAtom, {
      reservation: ticket.historyReservation,
      entry: {
        transactionId: `paste-special-${ticket.sessionId}-${ticket.requestId}`,
        kind: 'cells.import',
        sheetId: ticket.sheetId,
        projectionRevision: acknowledgementSnapshot.revision,
        affectedRange: acknowledgementSnapshot.affectedRange,
      },
    })
    if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!historyRecorded) {
      set(
        pasteSpecialErrorBackingAtom,
        `${PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR} History ownership was unavailable ` +
          'after acknowledgement.',
      )
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }
    set(
      pasteSpecialLifecycleBackingAtom,
      lifecycleFor('local-acknowledged', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )

    await Promise.resolve()
    if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
    set(
      pasteSpecialLifecycleBackingAtom,
      lifecycleFor('refreshing', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )
    try {
      await refreshProjection(ticket.sheetId)
    } catch (error) {
      if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
      set(
        pasteSpecialErrorBackingAtom,
        `${PASTE_SPECIAL_REFRESH_ERROR_PREFIX}${errorMessage(error)}`,
      )
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('error', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'error'
    }
    if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
      set(
        pasteSpecialErrorBackingAtom,
        `${PASTE_SPECIAL_OUTCOME_UNKNOWN_ERROR} History ownership could not be reconciled ` +
          'after refresh.',
      )
      set(
        pasteSpecialLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }
    set(activePasteSpecialMutationAtom, null)
    closePasteSpecialSession(get, set)
    return 'completed'
  },
)
confirmPasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.confirm'
