import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  ImportCellChunksRequest,
  ProjectionRequestId,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../backend/types'
import { resolveContentMutationAtom } from '../editing/mutation-gateway'
import { pushHistoryAtom } from '../history'
import {
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import type {
  ImportCellPlan,
  RunTextToColumnsEntrypointInput,
  RunTextToColumnsFinishInput,
  TextToColumnsColumnFormat,
  TextToColumnsCommitPlan,
  TextToColumnsControllerPort,
  TextToColumnsDelimitedConfig,
  TextToColumnsDelimiter,
  TextToColumnsEntrypointOutcome,
  TextToColumnsEntrypointProjection,
  TextToColumnsEntrypointState,
  TextToColumnsEntrypointTarget,
  TextToColumnsFixedConfig,
  TextToColumnsIntent,
  TextToColumnsLifecycleState,
  TextToColumnsMode,
  TextToColumnsMutationOutcome,
  TextToColumnsNextBlockReason,
  TextToColumnsPreviewRow,
  TextToColumnsSessionSnapshot,
  TextToColumnsSourceRow,
  TextToColumnsTextQualifier,
  TextToColumnsWizardState,
} from './types'
import type { CellCoord, CellRange } from '../shared'
import {
  getFilterHiddenRowsForSheet,
  viewportFilterHiddenAtom,
} from '../viewport/effective-hidden'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'

export * from './types'

/**
 * Bounded cache caps: the preview pane shows at most the first
 * `TEXT_TO_COLUMNS_PREVIEW_CAP` source rows tokenized with the active
 * wizard config, and emits at most
 * `TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP` *cells* (tokens **plus** the
 * trailing `…` marker, if any) across the whole preview grid. The cap
 * protects the renderer against a single pathological row carrying
 * 10k+ delimiters — without it a 100-row preview could explode into
 * millions of DOM cells. When a row is truncated mid-flight we replace
 * the trailing token with a `'…'` sentinel so the user can see the
 * cut visually; the sentinel counts against the cap so the renderer's
 * total cell count is strictly `≤ TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP`.
 * Documented in `text-to-columns/README.md`.
 */
export const TEXT_TO_COLUMNS_PREVIEW_CAP = 100
export const TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP = 500
/**
 * Sentinel appended to a row whose tokens were truncated by the token
 * cap. Renderers can show this verbatim — it carries no semantic value
 * and is not part of the commit plan.
 */
export const TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK = '…'

export const TEXT_TO_COLUMNS_CAPABILITY_ERROR =
  'Text to Columns is unavailable because this workbook does not provide importCellChunks.'
export const TEXT_TO_COLUMNS_CONTEXT_ERROR =
  'Text to Columns needs an active single-column source and a completed wizard.'
export const TEXT_TO_COLUMNS_ACKNOWLEDGEMENT_ERROR =
  'Text to Columns acknowledgement did not match the active request and target.'
export const TEXT_TO_COLUMNS_OUTCOME_UNKNOWN_ERROR =
  'Text to Columns may have been applied, but the backend did not return a matching acknowledgement. To avoid a duplicate import, refresh or reload the workbook before trying again.'
export const TEXT_TO_COLUMNS_TRANSPORT_ERROR_PREFIX = 'Text to Columns could not be applied: '
export const TEXT_TO_COLUMNS_REFRESH_ERROR_PREFIX =
  'Text to Columns was acknowledged, but projection refresh failed: '
export const TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR =
  'Text to Columns requires an active single-column selection.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_PORT_ERROR =
  'Text to Columns source is unavailable because this workbook does not provide range projection reads.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_PENDING_ERROR =
  'Text to Columns source loading is already in progress.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_SESSION_ERROR =
  'Close the current Text to Columns dialog before loading another source.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR =
  'Text to Columns source was ignored because the active sheet, selection, or dialog session changed.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_RESULT_ERROR =
  'Text to Columns could not open because the source projection did not match the active request and target.'
export const TEXT_TO_COLUMNS_ENTRYPOINT_TRANSPORT_ERROR_PREFIX =
  'Text to Columns source could not be loaded: '

/**
 * Runtime read-only Set facade. `Object.freeze(new Set())` still permits
 * `.add/.delete/.clear`, so public projections must not expose a native Set.
 */
class ImmutableReadonlySet<Value> {
  private readonly items: readonly Value[]

  constructor(values: Iterable<Value>) {
    this.items = Object.freeze(Array.from(new Set(values)))
    Object.freeze(this)
  }

  get size(): number {
    return this.items.length
  }

  has(value: Value): boolean {
    return this.items.includes(value)
  }

  forEach(
    callback: (value: Value, valueAgain: Value, set: ReadonlySet<Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.items) {
      callback.call(thisArg, value, value, this as unknown as ReadonlySet<Value>)
    }
  }

  entries(): IterableIterator<[Value, Value]> {
    return this.items.map((value): [Value, Value] => [value, value]).values()
  }

  keys(): IterableIterator<Value> {
    return this.items.values()
  }

  values(): IterableIterator<Value> {
    return this.items.values()
  }

  [Symbol.iterator](): IterableIterator<Value> {
    return this.items.values()
  }
}

Object.freeze(ImmutableReadonlySet.prototype)

function immutableReadonlySet<Value>(values: Iterable<Value>): ReadonlySet<Value> {
  return new ImmutableReadonlySet(values) as unknown as ReadonlySet<Value>
}

function snapshotDelimitedConfig(
  config: TextToColumnsDelimitedConfig,
): TextToColumnsDelimitedConfig {
  return Object.freeze({
    delimiters: immutableReadonlySet(config.delimiters),
    otherChar: config.otherChar,
    treatConsecutiveAsOne: config.treatConsecutiveAsOne,
    textQualifier: config.textQualifier,
  })
}

function snapshotFixedConfig(config: TextToColumnsFixedConfig): TextToColumnsFixedConfig {
  return Object.freeze({ breakpoints: Object.freeze(Array.from(config.breakpoints)) })
}

function snapshotWizardState(state: TextToColumnsWizardState): TextToColumnsWizardState {
  switch (state.step) {
    case 'step-1':
      return Object.freeze({ step: 'step-1', mode: state.mode })
    case 'step-2-delimited':
      return Object.freeze({
        step: 'step-2-delimited',
        mode: 'delimited',
        delimited: snapshotDelimitedConfig(state.delimited),
      })
    case 'step-2-fixed':
      return Object.freeze({
        step: 'step-2-fixed',
        mode: 'fixed',
        fixed: snapshotFixedConfig(state.fixed),
      })
    case 'step-3':
      return Object.freeze({
        step: 'step-3',
        mode: state.mode,
        delimited: snapshotDelimitedConfig(state.delimited),
        fixed: snapshotFixedConfig(state.fixed),
        formats: Object.freeze(Array.from(state.formats)),
      })
  }
}

export const DEFAULT_DELIMITED_CONFIG: TextToColumnsDelimitedConfig = Object.freeze({
  delimiters: immutableReadonlySet<TextToColumnsDelimiter>(['tab']),
  otherChar: '',
  treatConsecutiveAsOne: false,
  textQualifier: '"',
})

export const DEFAULT_FIXED_CONFIG: TextToColumnsFixedConfig = Object.freeze({
  breakpoints: Object.freeze([] as number[]),
})

export const INITIAL_WIZARD_STATE: TextToColumnsWizardState = Object.freeze({
  step: 'step-1',
  mode: 'delimited',
})

const INITIAL_TEXT_TO_COLUMNS_LIFECYCLE: TextToColumnsLifecycleState = Object.freeze({
  status: 'closed',
  sessionId: 0,
  requestId: null,
  sheetId: null,
})

const INITIAL_TEXT_TO_COLUMNS_ENTRYPOINT_STATE: TextToColumnsEntrypointState = Object.freeze({
  status: 'idle',
  operationId: null,
  requestId: null,
  sessionId: null,
  target: null,
  attempt: 0,
  error: '',
})

const EMPTY_TEXT_TO_COLUMNS_SOURCE: readonly TextToColumnsSourceRow[] = Object.freeze([])

interface TextToColumnsMutationTicket {
  readonly sessionId: number
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly target: CellRange
  readonly request: ImportCellChunksRequest
  readonly acknowledgement: BackendMutationResult | null
}

interface TextToColumnsEntrypointTicket {
  readonly operationId: number
  readonly requestId: ProjectionRequestId
  readonly sessionId: number
  readonly session: TextToColumnsSessionSnapshot | null
  readonly open: boolean
  readonly lifecycle: TextToColumnsLifecycleState
  readonly mutation: TextToColumnsMutationTicket | null
  readonly target: TextToColumnsEntrypointTarget
  readonly attempt: number
  readonly request: RangeProjectionRequest
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
}

// --- source ---

/**
 * Lines of the source single-column selection (top-to-bottom). The host
 * dialog populates this immediately after `openTextToColumnsAtom` and
 * clears it on close. Storing it in an atom keeps per-instance dialog
 * state out of `let` locals so the Solid 1.9.12 Provider remount hazard
 * does not strand it.
 */
const textToColumnsSourceStateAtom = atom<readonly TextToColumnsSourceRow[]>(
  EMPTY_TEXT_TO_COLUMNS_SOURCE,
)
textToColumnsSourceStateAtom.debugLabel = 'spreadsheet.textToColumns.source.state'

/**
 * Anchor coordinate (top-left of the source column). Used at commit time
 * to assemble the import plan.
 */
const textToColumnsAnchorStateAtom = atom<CellCoord | null>(null)
textToColumnsAnchorStateAtom.debugLabel = 'spreadsheet.textToColumns.anchor.state'

const textToColumnsSheetIdStateAtom = atom<string | null>(null)
textToColumnsSheetIdStateAtom.debugLabel = 'spreadsheet.textToColumns.sheetId.state'

// --- ui ---

const textToColumnsOpenStateAtom = atom<boolean>(false)
textToColumnsOpenStateAtom.debugLabel = 'spreadsheet.textToColumns.open.state'

const textToColumnsWizardStateAtom = atom<TextToColumnsWizardState>(INITIAL_WIZARD_STATE)
textToColumnsWizardStateAtom.debugLabel = 'spreadsheet.textToColumns.wizard.state'

const textToColumnsSessionIdStateAtom = atom<number>(0)
textToColumnsSessionIdStateAtom.debugLabel = 'spreadsheet.textToColumns.sessionId.state'

const textToColumnsRequestIdStateAtom = atom<number>(0)
textToColumnsRequestIdStateAtom.debugLabel = 'spreadsheet.textToColumns.requestId.state'

const textToColumnsSessionStateAtom = atom<TextToColumnsSessionSnapshot | null>(null)
textToColumnsSessionStateAtom.debugLabel = 'spreadsheet.textToColumns.session.state'

const textToColumnsLifecycleStateAtom = atom<TextToColumnsLifecycleState>(
  INITIAL_TEXT_TO_COLUMNS_LIFECYCLE,
)
textToColumnsLifecycleStateAtom.debugLabel = 'spreadsheet.textToColumns.lifecycle.state'

const textToColumnsErrorStateAtom = atom<string>('')
textToColumnsErrorStateAtom.debugLabel = 'spreadsheet.textToColumns.error.state'

const textToColumnsCapabilityStateAtom = atom<boolean>(false)
textToColumnsCapabilityStateAtom.debugLabel = 'spreadsheet.textToColumns.capability.state'

const activeTextToColumnsMutationAtom = atom<TextToColumnsMutationTicket | null>(null)
activeTextToColumnsMutationAtom.debugLabel = 'spreadsheet.textToColumns.activeMutation'

const textToColumnsEntrypointOperationIdStateAtom = atom<number>(0)
textToColumnsEntrypointOperationIdStateAtom.debugLabel =
  'spreadsheet.textToColumns.entrypoint.operationId.state'

const textToColumnsEntrypointRequestIdStateAtom = atom<number>(0)
textToColumnsEntrypointRequestIdStateAtom.debugLabel =
  'spreadsheet.textToColumns.entrypoint.requestId.state'

const textToColumnsEntrypointStateBackingAtom = atom<TextToColumnsEntrypointState>(
  INITIAL_TEXT_TO_COLUMNS_ENTRYPOINT_STATE,
)
textToColumnsEntrypointStateBackingAtom.debugLabel =
  'spreadsheet.textToColumns.entrypoint.state.backing'

const activeTextToColumnsEntrypointAtom = atom<TextToColumnsEntrypointTicket | null>(null)
activeTextToColumnsEntrypointAtom.debugLabel = 'spreadsheet.textToColumns.entrypoint.active'

// --- derived ---

/**
 * Compatibility read projections. The backing atoms above are deliberately
 * private: hosts can observe the session but cannot bypass Core commands by
 * writing open/session/lifecycle mirrors during an in-flight mutation.
 */
export const textToColumnsSourceAtom: Atom<readonly TextToColumnsSourceRow[]> = atom((get) =>
  get(textToColumnsSourceStateAtom),
)
textToColumnsSourceAtom.debugLabel = 'spreadsheet.textToColumns.source'

export const textToColumnsAnchorAtom: Atom<CellCoord | null> = atom((get) =>
  get(textToColumnsAnchorStateAtom),
)
textToColumnsAnchorAtom.debugLabel = 'spreadsheet.textToColumns.anchor'

export const textToColumnsSheetIdAtom: Atom<string | null> = atom((get) =>
  get(textToColumnsSheetIdStateAtom),
)
textToColumnsSheetIdAtom.debugLabel = 'spreadsheet.textToColumns.sheetId'

export const textToColumnsOpenAtom: Atom<boolean> = atom((get) => get(textToColumnsOpenStateAtom))
textToColumnsOpenAtom.debugLabel = 'spreadsheet.textToColumns.open'

export const textToColumnsWizardAtom: Atom<TextToColumnsWizardState> = atom((get) =>
  get(textToColumnsWizardStateAtom),
)
textToColumnsWizardAtom.debugLabel = 'spreadsheet.textToColumns.wizard'

export const textToColumnsSessionIdAtom: Atom<number> = atom((get) =>
  get(textToColumnsSessionIdStateAtom),
)
textToColumnsSessionIdAtom.debugLabel = 'spreadsheet.textToColumns.sessionId'

export const textToColumnsRequestIdAtom: Atom<number> = atom((get) =>
  get(textToColumnsRequestIdStateAtom),
)
textToColumnsRequestIdAtom.debugLabel = 'spreadsheet.textToColumns.requestId'

export const textToColumnsSessionAtom: Atom<TextToColumnsSessionSnapshot | null> = atom((get) =>
  get(textToColumnsSessionStateAtom),
)
textToColumnsSessionAtom.debugLabel = 'spreadsheet.textToColumns.session'

export const textToColumnsLifecycleAtom: Atom<TextToColumnsLifecycleState> = atom((get) =>
  get(textToColumnsLifecycleStateAtom),
)
textToColumnsLifecycleAtom.debugLabel = 'spreadsheet.textToColumns.lifecycle'

export const textToColumnsErrorAtom: Atom<string> = atom((get) => get(textToColumnsErrorStateAtom))
textToColumnsErrorAtom.debugLabel = 'spreadsheet.textToColumns.error'

export const textToColumnsCapabilityAtom: Atom<boolean> = atom((get) =>
  get(textToColumnsCapabilityStateAtom),
)
textToColumnsCapabilityAtom.debugLabel = 'spreadsheet.textToColumns.capability'

/** Read-only entrypoint lifecycle; only Core command atoms replace the backing state. */
export const textToColumnsEntrypointStateAtom: Atom<TextToColumnsEntrypointState> = atom((get) =>
  get(textToColumnsEntrypointStateBackingAtom),
)
textToColumnsEntrypointStateAtom.debugLabel = 'spreadsheet.textToColumns.entrypoint.state'

export const textToColumnsEntrypointProjectionAtom = atom(
  (get): TextToColumnsEntrypointProjection => {
    const state = get(textToColumnsEntrypointStateBackingAtom)
    const liveTarget = resolveTextToColumnsEntrypointTarget(get)
    const active = get(activeTextToColumnsEntrypointAtom)
    const mutationBusy = get(activeTextToColumnsMutationAtom) !== null
    const sessionBusy =
      get(textToColumnsOpenStateAtom) ||
      get(textToColumnsSessionStateAtom) !== null ||
      get(textToColumnsLifecycleStateAtom).status !== 'closed'
    const pending = active !== null
    const authorityIsCurrent =
      active === null || textToColumnsEntrypointAuthorityIsCurrent(get, active)
    const status = pending && !authorityIsCurrent ? 'stale' : state.status
    const error =
      pending && !authorityIsCurrent ? TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR : state.error
    const target = pending || state.status === 'stale' ? state.target : liveTarget
    const canRun = !pending && !mutationBusy && !sessionBusy && liveTarget !== null
    const canRetry = canRun && (status === 'blocked' || status === 'error' || status === 'stale')
    const disabledReason = pending
      ? authorityIsCurrent
        ? TEXT_TO_COLUMNS_ENTRYPOINT_PENDING_ERROR
        : TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR
      : mutationBusy
        ? TEXT_TO_COLUMNS_ENTRYPOINT_PENDING_ERROR
        : sessionBusy
          ? TEXT_TO_COLUMNS_ENTRYPOINT_SESSION_ERROR
          : liveTarget === null
            ? TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR
            : null
    return Object.freeze({
      ...state,
      status,
      target,
      error,
      pending,
      canRun,
      canRetry,
      disabled: disabledReason !== null,
      disabledReason,
    })
  },
)
textToColumnsEntrypointProjectionAtom.debugLabel = 'spreadsheet.textToColumns.entrypoint.projection'

export const textToColumnsPreviewAtom = atom((get): readonly TextToColumnsPreviewRow[] => {
  const source = get(textToColumnsSourceAtom)
  const wizard = get(textToColumnsWizardAtom)
  const config = effectiveConfig(wizard)
  const capped = source.slice(0, TEXT_TO_COLUMNS_PREVIEW_CAP)

  // Token-cap pass: cumulatively budget tokens across rows so a single
  // pathological row cannot blow the renderer. Once the budget is
  // exhausted we still emit subsequent rows (so the user keeps row
  // anchoring) but with an empty token list — except the first
  // truncated row, which gets a single `…` marker. The marker counts
  // against the cap (so a truncated row emits at most `cap` cells,
  // including the marker — this keeps the renderer's total cell count
  // strictly ≤ TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP across all rows).
  const out: TextToColumnsPreviewRow[] = []
  let budget = TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP
  for (const row of capped) {
    if (budget <= 0) {
      out.push(snapshotPreviewRow(row.sourceRow, []))
      continue
    }
    const tokens = tokenize(row.text, config)
    if (tokens.length <= budget) {
      out.push(snapshotPreviewRow(row.sourceRow, tokens))
      budget -= tokens.length
      continue
    }
    // Reserve one slot for the truncation marker so the total cell
    // count for this row equals the remaining budget exactly.
    const sliced = tokens.slice(0, Math.max(0, budget - 1))
    sliced.push(TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK)
    out.push(snapshotPreviewRow(row.sourceRow, sliced))
    budget = 0
  }
  return Object.freeze(out)
})
textToColumnsPreviewAtom.debugLabel = 'spreadsheet.textToColumns.preview'

export const textToColumnsColumnCountAtom = atom((get) =>
  previewColumnCount(get(textToColumnsPreviewAtom)),
)
textToColumnsColumnCountAtom.debugLabel = 'spreadsheet.textToColumns.columnCount'

export const textToColumnsHasSourceAtom = atom((get) => {
  const session = get(textToColumnsSessionAtom)
  return session !== null && session.rows.length > 0
})
textToColumnsHasSourceAtom.debugLabel = 'spreadsheet.textToColumns.hasSource'

export const textToColumnsNextBlockReasonAtom = atom(
  (get): TextToColumnsNextBlockReason => nextBlockReason(get(textToColumnsWizardAtom)),
)
textToColumnsNextBlockReasonAtom.debugLabel = 'spreadsheet.textToColumns.nextBlockReason'

export const textToColumnsCanEditAtom = atom((get) => {
  const lifecycle = get(textToColumnsLifecycleAtom)
  return (
    get(textToColumnsOpenAtom) &&
    get(activeTextToColumnsMutationAtom) === null &&
    (lifecycle.status === 'editing' ||
      lifecycle.status === 'blocked' ||
      lifecycle.status === 'error')
  )
})
textToColumnsCanEditAtom.debugLabel = 'spreadsheet.textToColumns.canEdit'

export const textToColumnsCanGoBackAtom = atom(
  (get) => get(textToColumnsCanEditAtom) && get(textToColumnsWizardAtom).step !== 'step-1',
)
textToColumnsCanGoBackAtom.debugLabel = 'spreadsheet.textToColumns.canGoBack'

export const textToColumnsCanGoNextAtom = atom(
  (get) => get(textToColumnsCanEditAtom) && get(textToColumnsNextBlockReasonAtom) === null,
)
textToColumnsCanGoNextAtom.debugLabel = 'spreadsheet.textToColumns.canGoNext'

export const textToColumnsCanFinishAtom = atom((get) => {
  const lifecycle = get(textToColumnsLifecycleAtom)
  const active = get(activeTextToColumnsMutationAtom)
  if (!get(textToColumnsOpenAtom)) return false
  if (active !== null) {
    return lifecycle.status === 'error' && active.acknowledgement !== null
  }
  if (!get(textToColumnsCapabilityAtom) || !get(textToColumnsHasSourceAtom)) return false
  const wizard = get(textToColumnsWizardAtom)
  return (
    wizard.step === 'step-3' &&
    wizard.formats.some((format) => format !== 'skip') &&
    (lifecycle.status === 'editing' || lifecycle.status === 'error')
  )
})
textToColumnsCanFinishAtom.debugLabel = 'spreadsheet.textToColumns.canFinish'

function blocksTextToColumnsClose(status: TextToColumnsLifecycleState['status']): boolean {
  return (
    status === 'pending' ||
    status === 'local-acknowledged' ||
    status === 'refreshing' ||
    status === 'outcome-unknown'
  )
}

/**
 * A launched import keeps its session alive until acknowledgement/history
 * and projection refresh bookkeeping have settled.
 */
export const textToColumnsCanCloseAtom = atom(
  (get) =>
    get(textToColumnsOpenAtom) &&
    get(activeTextToColumnsMutationAtom) === null &&
    !blocksTextToColumnsClose(get(textToColumnsLifecycleAtom).status),
)
textToColumnsCanCloseAtom.debugLabel = 'spreadsheet.textToColumns.canClose'

// --- commands ---

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown Text to Columns transport failure.'
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

export function nextTextToColumnsSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextTextToColumnsRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function snapshotRange(range: CellRange): CellRange {
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  })
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function isValidCellRange(range: CellRange): boolean {
  return (
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

function snapshotTextToColumnsEntrypointTarget(
  sheetId: string,
  range: CellRange,
): TextToColumnsEntrypointTarget {
  const targetRange = snapshotRange(range)
  return Object.freeze({
    sheetId,
    range: targetRange,
    anchor: Object.freeze({ row: targetRange.rowStart, col: targetRange.colStart }),
  })
}

function resolveTextToColumnsEntrypointTarget(get: Getter): TextToColumnsEntrypointTarget | null {
  const selection = get(selectionSnapshotAtom)
  const activeCellSheetId = selection.activeCell.sheetId
  const selectionSheetId = selection.selection.sheetId
  const workspaceSheetId = get(workspaceSessionAtom).activeSheetId
  const range = selection.range
  if (
    !activeCellSheetId ||
    !selectionSheetId ||
    !workspaceSheetId ||
    activeCellSheetId !== selectionSheetId ||
    selectionSheetId !== workspaceSheetId ||
    !isValidCellRange(range) ||
    range.colStart !== range.colEnd
  ) {
    return null
  }
  return snapshotTextToColumnsEntrypointTarget(selectionSheetId, range)
}

function sameTextToColumnsEntrypointTarget(
  left: TextToColumnsEntrypointTarget | null,
  right: TextToColumnsEntrypointTarget | null,
): boolean {
  return (
    left?.sheetId === right?.sheetId &&
    left !== null &&
    right !== null &&
    sameRange(left.range, right.range) &&
    left.anchor.row === right.anchor.row &&
    left.anchor.col === right.anchor.col
  )
}

function textToColumnsEntrypointStateFor(
  status: TextToColumnsEntrypointState['status'],
  input: {
    readonly operationId?: number | null
    readonly requestId?: ProjectionRequestId | null
    readonly sessionId?: number | null
    readonly target?: TextToColumnsEntrypointTarget | null
    readonly attempt?: number
    readonly error?: string
  } = {},
): TextToColumnsEntrypointState {
  return Object.freeze({
    status,
    operationId: input.operationId ?? null,
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
    target: input.target ?? null,
    attempt: input.attempt ?? 0,
    error: input.error ?? '',
  })
}

function textToColumnsEntrypointStateForTicket(
  status: TextToColumnsEntrypointState['status'],
  ticket: TextToColumnsEntrypointTicket,
  error = '',
  sessionId = ticket.sessionId,
): TextToColumnsEntrypointState {
  return textToColumnsEntrypointStateFor(status, {
    operationId: ticket.operationId,
    requestId: ticket.requestId,
    sessionId,
    target: ticket.target,
    attempt: ticket.attempt,
    error,
  })
}

function nextTextToColumnsEntrypointAttempt(
  previous: TextToColumnsEntrypointState,
  target: TextToColumnsEntrypointTarget,
): number {
  if (
    (previous.status === 'blocked' || previous.status === 'error' || previous.status === 'stale') &&
    sameTextToColumnsEntrypointTarget(previous.target, target)
  ) {
    return previous.attempt < Number.MAX_SAFE_INTEGER ? previous.attempt + 1 : previous.attempt
  }
  return 1
}

function textToColumnsEntrypointTicketIsOwned(
  get: Getter,
  ticket: TextToColumnsEntrypointTicket,
): boolean {
  const state = get(textToColumnsEntrypointStateBackingAtom)
  return (
    get(activeTextToColumnsEntrypointAtom) === ticket &&
    state.operationId === ticket.operationId &&
    state.requestId === ticket.requestId &&
    state.sessionId === ticket.sessionId &&
    sameTextToColumnsEntrypointTarget(state.target, ticket.target)
  )
}

function textToColumnsEntrypointAuthorityIsCurrent(
  get: Getter,
  ticket: TextToColumnsEntrypointTicket,
): boolean {
  return (
    get(activeTextToColumnsMutationAtom) === ticket.mutation &&
    get(textToColumnsSessionIdAtom) === ticket.sessionId &&
    get(textToColumnsSessionStateAtom) === ticket.session &&
    get(textToColumnsOpenStateAtom) === ticket.open &&
    get(textToColumnsLifecycleStateAtom) === ticket.lifecycle &&
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === ticket.workspaceWitness &&
    sameTextToColumnsEntrypointTarget(resolveTextToColumnsEntrypointTarget(get), ticket.target)
  )
}

/**
 * Materialise the source column as one entry per row in the requested range.
 *
 * `hiddenRows` carries the FILTER-hidden rows for the sheet and is skipped
 * outright. The walk below is dense over `[rowStart..rowEnd]` while the
 * projection is sparse, so a row that is not rendered would be materialised
 * as `text: ''` and later written back as an empty split — clobbering data
 * the user cannot see. Manually hidden rows are NOT passed here: they carry
 * real values in the projection and Excel splits them like any other row.
 * See design-filter-hidden-rows.md §8.1.
 */
function textToColumnsSourceRowsFromResult(
  result: unknown,
  ticket: TextToColumnsEntrypointTicket,
  hiddenRows: ReadonlySet<number>,
): readonly TextToColumnsSourceRow[] | null {
  try {
    if (typeof result !== 'object' || result === null) return null
    const projection = result as Partial<RangeProjectionResult>
    const revisionIsValid =
      projection.revision === undefined ||
      (typeof projection.revision === 'number' && Number.isFinite(projection.revision)) ||
      (typeof projection.revision === 'string' && projection.revision.length > 0)
    if (
      projection.kind !== 'range' ||
      projection.requestId !== ticket.requestId ||
      projection.sheetId !== ticket.target.sheetId ||
      typeof projection.range !== 'object' ||
      projection.range === null ||
      !sameRange(projection.range, ticket.target.range) ||
      (projection.truncated !== undefined && typeof projection.truncated !== 'boolean') ||
      projection.truncated === true ||
      !revisionIsValid ||
      !Array.isArray(projection.cells)
    ) {
      return null
    }

    const byRow = new Map<number, string>()
    for (const candidate of projection.cells) {
      if (typeof candidate !== 'object' || candidate === null) return null
      const cell = candidate as unknown as Record<string, unknown>
      const row = cell.row
      const col = cell.col
      if (
        !Number.isSafeInteger(row) ||
        !Number.isSafeInteger(col) ||
        (row as number) < ticket.target.range.rowStart ||
        (row as number) > ticket.target.range.rowEnd ||
        col !== ticket.target.range.colStart ||
        typeof cell.displayValue !== 'string' ||
        byRow.has(row as number)
      ) {
        return null
      }
      byRow.set(row as number, cell.displayValue)
    }

    const rows: TextToColumnsSourceRow[] = []
    for (let row = ticket.target.range.rowStart; row <= ticket.target.range.rowEnd; row += 1) {
      if (hiddenRows.has(row)) continue
      rows.push(Object.freeze({ sourceRow: row, text: byRow.get(row) ?? '' }))
    }
    return Object.freeze(rows)
  } catch {
    return null
  }
}

function lifecycleFor(
  status: TextToColumnsLifecycleState['status'],
  sessionId: number,
  sheetId: string | null,
  requestId: ProjectionRequestId | null = null,
): TextToColumnsLifecycleState {
  return Object.freeze({ status, sessionId, requestId, sheetId })
}

function snapshotRows(rows: readonly TextToColumnsSourceRow[]): readonly TextToColumnsSourceRow[] {
  return Object.freeze(
    rows.map((row) => Object.freeze({ sourceRow: row.sourceRow, text: row.text })),
  )
}

function snapshotPreviewRow(sourceRow: number, tokens: readonly string[]): TextToColumnsPreviewRow {
  return Object.freeze({ sourceRow, tokens: Object.freeze(Array.from(tokens)) })
}

function sourceRangeFor(anchor: CellCoord, rows: readonly TextToColumnsSourceRow[]): CellRange {
  let rowEnd = anchor.row
  for (const row of rows) {
    if (row.sourceRow > rowEnd) rowEnd = row.sourceRow
  }
  return snapshotRange({
    rowStart: anchor.row,
    rowEnd,
    colStart: anchor.col,
    colEnd: anchor.col,
  })
}

function buildCommitPlan(get: Getter): TextToColumnsCommitPlan | null {
  const wizard = get(textToColumnsWizardAtom)
  const session = get(textToColumnsSessionAtom)
  if (session === null || wizard.step !== 'step-3') return null

  const config: EffectiveConfig = {
    mode: wizard.mode,
    delimited: wizard.delimited,
    fixed: wizard.fixed,
  }
  const keepIndices: number[] = []
  for (let index = 0; index < wizard.formats.length; index += 1) {
    if (wizard.formats[index] !== 'skip') keepIndices.push(index)
  }

  const cells: ImportCellPlan[] = []
  for (const row of session.rows) {
    const tokens = tokenize(row.text, config)
    let outputCol = 0
    for (const sourceTokenIndex of keepIndices) {
      const format = wizard.formats[sourceTokenIndex]
      const baseCell = {
        row: row.sourceRow,
        col: session.anchor.col + outputCol,
        input: tokens[sourceTokenIndex] ?? '',
      }
      const cell: ImportCellPlan =
        format === 'text' ? { ...baseCell, preserveAsText: true } : baseCell
      cells.push(Object.freeze(cell))
      outputCol += 1
    }
  }

  return Object.freeze({
    sheetId: session.sheetId,
    anchor: Object.freeze({ row: session.anchor.row, col: session.anchor.col }),
    sourceRange: session.sourceRange,
    outputColumnCount: keepIndices.length,
    cells: Object.freeze(cells),
  })
}

function targetRangeFor(plan: TextToColumnsCommitPlan): CellRange | null {
  if (plan.outputColumnCount <= 0 || plan.cells.length === 0) return null
  return snapshotRange({
    rowStart: plan.sourceRange.rowStart,
    rowEnd: plan.sourceRange.rowEnd,
    colStart: plan.anchor.col,
    colEnd: plan.anchor.col + plan.outputColumnCount - 1,
  })
}

function acknowledgementMatches(
  acknowledgement: unknown,
  ticket: TextToColumnsMutationTicket,
): acknowledgement is BackendMutationResult {
  try {
    if (typeof acknowledgement !== 'object' || acknowledgement === null) return false
    const result = acknowledgement as BackendMutationResult
    const revisionIsWitness =
      (typeof result.revision === 'number' && Number.isFinite(result.revision)) ||
      (typeof result.revision === 'string' && result.revision.length > 0)
    return (
      result.sheetId === ticket.sheetId &&
      result.requestId === ticket.requestId &&
      result.affectedRange !== undefined &&
      sameRange(result.affectedRange, ticket.target) &&
      revisionIsWitness
    )
  } catch {
    return false
  }
}

function numericHistoryRevision(result: BackendMutationResult): number | null {
  return typeof result.revision === 'number' && Number.isFinite(result.revision)
    ? result.revision
    : null
}

function ticketIsCurrent(get: Getter, ticket: TextToColumnsMutationTicket): boolean {
  const active = get(activeTextToColumnsMutationAtom)
  const lifecycle = get(textToColumnsLifecycleAtom)
  const session = get(textToColumnsSessionAtom)
  return (
    active !== null &&
    active.sessionId === ticket.sessionId &&
    active.requestId === ticket.requestId &&
    get(textToColumnsOpenAtom) &&
    get(textToColumnsSessionIdAtom) === ticket.sessionId &&
    session?.sessionId === ticket.sessionId &&
    session.sheetId === ticket.sheetId &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.requestId === ticket.requestId
  )
}

function closeTextToColumnsSession(get: Getter, set: Setter): void {
  const nextSessionId = nextTextToColumnsSessionId(get(textToColumnsSessionIdAtom))
  if (nextSessionId !== null) set(textToColumnsSessionIdStateAtom, nextSessionId)
  const sessionId = nextSessionId ?? get(textToColumnsSessionIdAtom)
  set(activeTextToColumnsMutationAtom, null)
  set(textToColumnsOpenStateAtom, false)
  set(textToColumnsWizardStateAtom, INITIAL_WIZARD_STATE)
  set(textToColumnsSourceStateAtom, EMPTY_TEXT_TO_COLUMNS_SOURCE)
  set(textToColumnsAnchorStateAtom, null)
  set(textToColumnsSheetIdStateAtom, null)
  set(textToColumnsSessionStateAtom, null)
  set(textToColumnsErrorStateAtom, '')
  set(textToColumnsLifecycleStateAtom, lifecycleFor('closed', sessionId, null))
}

function restoreEditingState(get: Getter, set: Setter): void {
  const session = get(textToColumnsSessionAtom)
  if (session === null || get(activeTextToColumnsMutationAtom) !== null) return
  set(textToColumnsErrorStateAtom, '')
  set(textToColumnsLifecycleStateAtom, lifecycleFor('editing', session.sessionId, session.sheetId))
}

export interface OpenTextToColumnsPayload {
  sheetId: string
  anchor: CellCoord
  rows: readonly TextToColumnsSourceRow[]
}

export const openTextToColumnsAtom = atom(
  null,
  (get, set, payload: OpenTextToColumnsPayload): number | null => {
    // A live ticket is authoritative even if an older host retained a stale
    // open projection. Replacement must never depend on an independently
    // writable UI mirror.
    if (get(activeTextToColumnsMutationAtom) !== null) return null
    if (
      get(textToColumnsOpenAtom) &&
      blocksTextToColumnsClose(get(textToColumnsLifecycleAtom).status)
    )
      return null
    const sessionId = nextTextToColumnsSessionId(get(textToColumnsSessionIdAtom))
    if (sessionId === null) {
      set(textToColumnsErrorStateAtom, 'Text to Columns session identity space is exhausted.')
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('blocked', get(textToColumnsSessionIdAtom), null),
      )
      return null
    }
    const anchor = Object.freeze({ row: payload.anchor.row, col: payload.anchor.col })
    const rows = snapshotRows(payload.rows)
    const sourceRange = sourceRangeFor(anchor, rows)
    const session: TextToColumnsSessionSnapshot = Object.freeze({
      sessionId,
      sheetId: payload.sheetId,
      anchor,
      sourceRange,
      rows,
    })
    set(textToColumnsSessionIdStateAtom, sessionId)
    set(activeTextToColumnsMutationAtom, null)
    set(textToColumnsSessionStateAtom, session)
    set(textToColumnsSheetIdStateAtom, session.sheetId)
    set(textToColumnsAnchorStateAtom, session.anchor)
    set(textToColumnsSourceStateAtom, session.rows)
    set(textToColumnsWizardStateAtom, INITIAL_WIZARD_STATE)
    set(textToColumnsErrorStateAtom, '')
    set(textToColumnsLifecycleStateAtom, lifecycleFor('editing', sessionId, session.sheetId))
    set(textToColumnsOpenStateAtom, true)
    return sessionId
  },
)
openTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.open.command'

/**
 * Core-owned default entrypoint. It freezes selection/workspace/session authority,
 * validates the complete range projection, fills sparse source rows, and only then
 * delegates opening to the existing TTC-C0 session command.
 */
export const runTextToColumnsEntrypointAtom = atom(
  null,
  async (
    get,
    set,
    input: RunTextToColumnsEntrypointInput,
  ): Promise<TextToColumnsEntrypointOutcome> => {
    if (get(activeTextToColumnsEntrypointAtom) !== null) return 'loading'

    const target = resolveTextToColumnsEntrypointTarget(get)
    const previous = get(textToColumnsEntrypointStateBackingAtom)
    const sessionId = get(textToColumnsSessionIdAtom)
    const attempt = target === null ? 1 : nextTextToColumnsEntrypointAttempt(previous, target)

    const session = get(textToColumnsSessionStateAtom)
    const open = get(textToColumnsOpenStateAtom)
    const lifecycle = get(textToColumnsLifecycleStateAtom)
    const mutation = get(activeTextToColumnsMutationAtom)
    if (mutation !== null) {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateFor('blocked', {
          sessionId,
          target,
          attempt,
          error: TEXT_TO_COLUMNS_ENTRYPOINT_PENDING_ERROR,
        }),
      )
      return 'blocked'
    }

    if (open || session !== null || lifecycle.status !== 'closed') {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateFor('blocked', {
          sessionId,
          target,
          attempt,
          error: TEXT_TO_COLUMNS_ENTRYPOINT_SESSION_ERROR,
        }),
      )
      return 'blocked'
    }

    if (target === null) {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateFor('blocked', {
          sessionId,
          attempt,
          error: TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR,
        }),
      )
      return 'blocked'
    }

    let execute: RunTextToColumnsEntrypointInput['source']['readRangeProjection'] | undefined
    try {
      execute = input.source?.readRangeProjection
    } catch {
      execute = undefined
    }
    if (typeof execute !== 'function') {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateFor('blocked', {
          sessionId,
          target,
          attempt,
          error: TEXT_TO_COLUMNS_ENTRYPOINT_PORT_ERROR,
        }),
      )
      return 'blocked'
    }

    const operationId = nextSafeMonotonicIdentity(get(textToColumnsEntrypointOperationIdStateAtom))
    const requestId = nextTextToColumnsRequestId(get(textToColumnsEntrypointRequestIdStateAtom))
    if (operationId === null || requestId === null || !Number.isSafeInteger(sessionId)) {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateFor('blocked', {
          sessionId,
          target,
          attempt,
          error: 'Text to Columns entrypoint identity space is exhausted.',
        }),
      )
      return 'blocked'
    }

    const request: RangeProjectionRequest = Object.freeze({
      kind: 'range',
      sheetId: target.sheetId,
      range: target.range,
      requestId,
      reason: 'toolbar',
    })
    const ticket: TextToColumnsEntrypointTicket = Object.freeze({
      operationId,
      requestId,
      sessionId,
      session,
      open,
      lifecycle,
      mutation,
      target,
      attempt,
      request,
      selectionWitness: get(selectionAuthorityWitnessAtom),
      workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
    })
    set(textToColumnsEntrypointOperationIdStateAtom, operationId)
    set(textToColumnsEntrypointRequestIdStateAtom, requestId)
    set(activeTextToColumnsEntrypointAtom, ticket)
    set(
      textToColumnsEntrypointStateBackingAtom,
      textToColumnsEntrypointStateForTicket('loading', ticket),
    )

    // Publish the reservation before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!textToColumnsEntrypointTicketIsOwned(get, ticket)) return 'stale'
    if (!textToColumnsEntrypointAuthorityIsCurrent(get, ticket)) {
      set(activeTextToColumnsEntrypointAtom, null)
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateForTicket(
          'stale',
          ticket,
          TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR,
        ),
      )
      return 'stale'
    }
    set(textToColumnsEntrypointStateBackingAtom, get(textToColumnsEntrypointStateBackingAtom))

    let projection: unknown
    try {
      projection = await execute.call(input.source, ticket.request)
    } catch (error) {
      if (!textToColumnsEntrypointTicketIsOwned(get, ticket)) return 'stale'
      set(activeTextToColumnsEntrypointAtom, null)
      if (!textToColumnsEntrypointAuthorityIsCurrent(get, ticket)) {
        set(
          textToColumnsEntrypointStateBackingAtom,
          textToColumnsEntrypointStateForTicket(
            'stale',
            ticket,
            TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR,
          ),
        )
        return 'stale'
      }
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateForTicket(
          'error',
          ticket,
          `${TEXT_TO_COLUMNS_ENTRYPOINT_TRANSPORT_ERROR_PREFIX}${errorMessage(error)}`,
        ),
      )
      return 'error'
    }

    if (!textToColumnsEntrypointTicketIsOwned(get, ticket)) return 'stale'
    if (!textToColumnsEntrypointAuthorityIsCurrent(get, ticket)) {
      set(activeTextToColumnsEntrypointAtom, null)
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateForTicket(
          'stale',
          ticket,
          TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR,
        ),
      )
      return 'stale'
    }

    const rows = textToColumnsSourceRowsFromResult(
      projection,
      ticket,
      new Set(getFilterHiddenRowsForSheet(get(viewportFilterHiddenAtom), ticket.target.sheetId)),
    )
    if (rows === null) {
      set(activeTextToColumnsEntrypointAtom, null)
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateForTicket(
          'error',
          ticket,
          TEXT_TO_COLUMNS_ENTRYPOINT_RESULT_ERROR,
        ),
      )
      return 'error'
    }

    const openedSessionId = set(openTextToColumnsAtom, {
      sheetId: ticket.target.sheetId,
      anchor: ticket.target.anchor,
      rows,
    })
    set(activeTextToColumnsEntrypointAtom, null)
    if (openedSessionId === null) {
      set(
        textToColumnsEntrypointStateBackingAtom,
        textToColumnsEntrypointStateForTicket(
          'error',
          ticket,
          'Text to Columns source loaded, but the dialog session could not be opened.',
        ),
      )
      return 'error'
    }
    set(
      textToColumnsEntrypointStateBackingAtom,
      textToColumnsEntrypointStateForTicket('idle', ticket, '', openedSessionId),
    )
    return 'opened'
  },
)
runTextToColumnsEntrypointAtom.debugLabel = 'spreadsheet.textToColumns.entrypoint.run'

export const closeTextToColumnsAtom = atom(null, (get, set) => {
  if (!get(textToColumnsCanCloseAtom)) return
  closeTextToColumnsSession(get, set)
})
closeTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.close'

export const captureTextToColumnsCapabilityAtom = atom(
  null,
  (get, set, source: TextToColumnsControllerPort) => {
    let available = false
    try {
      available = typeof source?.importCellChunks === 'function'
    } catch {
      available = false
    }
    set(textToColumnsCapabilityStateAtom, available)
    if (
      available &&
      get(textToColumnsErrorAtom) === TEXT_TO_COLUMNS_CAPABILITY_ERROR &&
      get(activeTextToColumnsMutationAtom) === null
    ) {
      restoreEditingState(get, set)
    }
  },
)
captureTextToColumnsCapabilityAtom.debugLabel = 'spreadsheet.textToColumns.captureCapability'

/** Core owns every wizard transition; framework adapters dispatch only typed intents. */
export const dispatchTextToColumnsIntentAtom = atom(
  null,
  (get, set, intent: TextToColumnsIntent): boolean => {
    if (!get(textToColumnsCanEditAtom)) return false
    const wizard = get(textToColumnsWizardAtom)
    let next: TextToColumnsWizardState | null = null

    switch (intent.kind) {
      case 'back':
        if (wizard.step === 'step-2-delimited' || wizard.step === 'step-2-fixed') {
          next = { step: 'step-1', mode: wizard.mode }
        } else if (wizard.step === 'step-3') {
          next = makeStepTwoState(wizard.mode, wizard.delimited, wizard.fixed)
        }
        break
      case 'next':
        if (nextBlockReason(wizard) !== null) break
        if (wizard.step === 'step-1') {
          next = makeStepTwoState(wizard.mode)
        } else if (wizard.step === 'step-2-delimited') {
          next = makeStepThreeState(
            'delimited',
            get(textToColumnsColumnCountAtom),
            wizard.delimited,
            DEFAULT_FIXED_CONFIG,
          )
        } else if (wizard.step === 'step-2-fixed') {
          next = makeStepThreeState(
            'fixed',
            get(textToColumnsColumnCountAtom),
            DEFAULT_DELIMITED_CONFIG,
            wizard.fixed,
          )
        }
        break
      case 'set-mode':
        if (wizard.step === 'step-1') {
          next = { step: 'step-1', mode: intent.mode }
        }
        break
      case 'toggle-delimiter':
        if (wizard.step === 'step-2-delimited') {
          const delimiters = new Set(wizard.delimited.delimiters)
          if (delimiters.has(intent.delimiter)) delimiters.delete(intent.delimiter)
          else delimiters.add(intent.delimiter)
          next = {
            ...wizard,
            delimited: { ...wizard.delimited, delimiters },
          }
        }
        break
      case 'set-other-char':
        if (wizard.step === 'step-2-delimited') {
          next = {
            ...wizard,
            delimited: {
              ...wizard.delimited,
              otherChar: intent.value.charAt(0),
            },
          }
        }
        break
      case 'set-treat-consecutive':
        if (wizard.step === 'step-2-delimited') {
          next = {
            ...wizard,
            delimited: {
              ...wizard.delimited,
              treatConsecutiveAsOne: intent.value,
            },
          }
        }
        break
      case 'set-text-qualifier':
        if (wizard.step === 'step-2-delimited') {
          next = {
            ...wizard,
            delimited: {
              ...wizard.delimited,
              textQualifier: intent.value,
            },
          }
        }
        break
      case 'set-fixed-breakpoints':
        if (wizard.step === 'step-2-fixed') {
          const breakpoints = Array.from(
            new Set(
              intent.value
                .split(/[\s,]+/)
                .map((value) => Number.parseInt(value, 10))
                .filter((value) => Number.isSafeInteger(value) && value > 0),
            ),
          ).sort((left, right) => left - right)
          next = { ...wizard, fixed: { breakpoints } }
        }
        break
      case 'set-column-format':
        if (
          wizard.step === 'step-3' &&
          Number.isSafeInteger(intent.columnIndex) &&
          intent.columnIndex >= 0 &&
          intent.columnIndex < wizard.formats.length
        ) {
          const formats = wizard.formats.slice()
          formats[intent.columnIndex] = intent.format
          next = { ...wizard, formats }
        }
        break
    }

    if (next === null) return false
    set(textToColumnsWizardStateAtom, snapshotWizardState(next))
    restoreEditingState(get, set)
    return true
  },
)
dispatchTextToColumnsIntentAtom.debugLabel = 'spreadsheet.textToColumns.dispatchIntent'

/**
 * Write-only command. Returns the assembled `TextToColumnsCommitPlan` so
 * the host adapter can forward it through `importCellChunks`. Returns
 * `null` when the wizard is not on the final step or when source/anchor
 * are missing.
 */
export const confirmTextToColumnsAtom = atom(null, (get, _set): TextToColumnsCommitPlan | null =>
  buildCommitPlan(get),
)
confirmTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.commit'

/** Core owns reservation, strict acknowledgement, refresh, close, and retry. */
export const runTextToColumnsFinishAtom = atom(
  null,
  async (get, set, input: RunTextToColumnsFinishInput): Promise<TextToColumnsMutationOutcome> => {
    const active = get(activeTextToColumnsMutationAtom)
    if (active !== null) {
      const lifecycle = get(textToColumnsLifecycleAtom)
      if (
        active.acknowledgement === null ||
        lifecycle.status !== 'error' ||
        input.sessionId !== active.sessionId ||
        typeof input.refreshProjection !== 'function'
      ) {
        return lifecycle.status === 'outcome-unknown' ? 'outcome-unknown' : 'stale'
      }

      set(textToColumnsErrorStateAtom, '')
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('refreshing', active.sessionId, active.sheetId, active.requestId),
      )
      await Promise.resolve()
      if (!ticketIsCurrent(get, active)) return 'stale'
      set(textToColumnsLifecycleStateAtom, get(textToColumnsLifecycleAtom))
      try {
        await input.refreshProjection(active.sheetId)
      } catch (error) {
        if (!ticketIsCurrent(get, active)) return 'stale'
        set(
          textToColumnsErrorStateAtom,
          `${TEXT_TO_COLUMNS_REFRESH_ERROR_PREFIX}${errorMessage(error)}`,
        )
        set(
          textToColumnsLifecycleStateAtom,
          lifecycleFor('error', active.sessionId, active.sheetId, active.requestId),
        )
        return 'error'
      }
      if (!ticketIsCurrent(get, active)) return 'stale'
      closeTextToColumnsSession(get, set)
      return 'completed'
    }

    const session = get(textToColumnsSessionAtom)
    const lifecycle = get(textToColumnsLifecycleAtom)
    if (
      !get(textToColumnsOpenAtom) ||
      session === null ||
      input.sessionId !== session.sessionId ||
      lifecycle.sessionId !== session.sessionId ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing' ||
      lifecycle.status === 'outcome-unknown'
    ) {
      return 'stale'
    }

    let execute: TextToColumnsControllerPort['importCellChunks']
    try {
      execute = input.source?.importCellChunks
    } catch {
      execute = undefined
    }
    if (typeof execute !== 'function') {
      set(textToColumnsCapabilityStateAtom, false)
      set(textToColumnsErrorStateAtom, TEXT_TO_COLUMNS_CAPABILITY_ERROR)
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }
    set(textToColumnsCapabilityStateAtom, true)

    const plan = buildCommitPlan(get)
    const target = plan === null ? null : targetRangeFor(plan)
    if (
      plan === null ||
      target === null ||
      session.rows.length === 0 ||
      typeof input.refreshProjection !== 'function'
    ) {
      set(textToColumnsErrorStateAtom, TEXT_TO_COLUMNS_CONTEXT_ERROR)
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    // Mutation gateway: a protection block fails closed here, before the
    // transport (zero transport, structured diagnostic recorded by the
    // gateway). The commit plan's rows are source rows already — filtering
    // hides rather than compacts (#27), so the single importCellChunks
    // request can always express the target.
    const resolution = set(resolveContentMutationAtom, {
      kind: 'import-cell-chunks',
      sheetId: session.sheetId,
      range: target,
    })
    if (resolution.status === 'blocked') {
      set(textToColumnsErrorStateAtom, resolution.diagnostic.message)
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    const requestId = nextTextToColumnsRequestId(get(textToColumnsRequestIdAtom))
    if (requestId === null) {
      set(textToColumnsErrorStateAtom, 'Text to Columns request identity space is exhausted.')
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('blocked', session.sessionId, session.sheetId),
      )
      return 'blocked'
    }

    const request: ImportCellChunksRequest = Object.freeze({
      kind: 'import-cell-chunks',
      sheetId: session.sheetId,
      chunks: Object.freeze([plan.cells]),
      range: target,
      requestId,
    })
    const ticket: TextToColumnsMutationTicket = Object.freeze({
      sessionId: session.sessionId,
      requestId,
      sheetId: session.sheetId,
      target,
      request,
      acknowledgement: null,
    })
    set(textToColumnsRequestIdStateAtom, requestId)
    set(activeTextToColumnsMutationAtom, ticket)
    set(textToColumnsErrorStateAtom, '')
    set(
      textToColumnsLifecycleStateAtom,
      lifecycleFor('pending', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )

    // Publish the ticket before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!ticketIsCurrent(get, ticket)) return 'stale'
    set(textToColumnsLifecycleStateAtom, get(textToColumnsLifecycleAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await execute.call(input.source, ticket.request)
    } catch (error) {
      if (!ticketIsCurrent(get, ticket)) return 'stale'
      set(
        textToColumnsErrorStateAtom,
        `${TEXT_TO_COLUMNS_OUTCOME_UNKNOWN_ERROR} Backend detail: ${errorMessage(error)}`,
      )
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }

    if (!ticketIsCurrent(get, ticket)) return 'stale'
    if (!acknowledgementMatches(acknowledgement, ticket)) {
      set(
        textToColumnsErrorStateAtom,
        `${TEXT_TO_COLUMNS_OUTCOME_UNKNOWN_ERROR} ${TEXT_TO_COLUMNS_ACKNOWLEDGEMENT_ERROR}`,
      )
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'outcome-unknown'
    }

    const acknowledgedTicket: TextToColumnsMutationTicket = Object.freeze({
      ...ticket,
      acknowledgement,
    })
    set(activeTextToColumnsMutationAtom, acknowledgedTicket)
    const projectionRevision = numericHistoryRevision(acknowledgement)
    if (projectionRevision !== null) {
      set(pushHistoryAtom, {
        transactionId: `text-to-columns-${ticket.sessionId}-${ticket.requestId}`,
        kind: 'cells.import',
        sheetId: ticket.sheetId,
        projectionRevision,
        affectedRange: ticket.target,
      })
    }
    set(
      textToColumnsLifecycleStateAtom,
      lifecycleFor('local-acknowledged', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )

    await Promise.resolve()
    if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
    set(
      textToColumnsLifecycleStateAtom,
      lifecycleFor('refreshing', ticket.sessionId, ticket.sheetId, ticket.requestId),
    )
    try {
      await input.refreshProjection(ticket.sheetId)
    } catch (error) {
      if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
      set(
        textToColumnsErrorStateAtom,
        `${TEXT_TO_COLUMNS_REFRESH_ERROR_PREFIX}${errorMessage(error)}`,
      )
      set(
        textToColumnsLifecycleStateAtom,
        lifecycleFor('error', ticket.sessionId, ticket.sheetId, ticket.requestId),
      )
      return 'error'
    }
    if (!ticketIsCurrent(get, acknowledgedTicket)) return 'stale'
    closeTextToColumnsSession(get, set)
    return 'completed'
  },
)
runTextToColumnsFinishAtom.debugLabel = 'spreadsheet.textToColumns.finish'

// --- helpers ---

interface EffectiveConfig {
  mode: TextToColumnsMode
  delimited: TextToColumnsDelimitedConfig
  fixed: TextToColumnsFixedConfig
}

function effectiveConfig(state: TextToColumnsWizardState): EffectiveConfig {
  switch (state.step) {
    case 'step-1':
      return {
        mode: state.mode,
        delimited: DEFAULT_DELIMITED_CONFIG,
        fixed: DEFAULT_FIXED_CONFIG,
      }
    case 'step-2-delimited':
      return {
        mode: 'delimited',
        delimited: state.delimited,
        fixed: DEFAULT_FIXED_CONFIG,
      }
    case 'step-2-fixed':
      return {
        mode: 'fixed',
        delimited: DEFAULT_DELIMITED_CONFIG,
        fixed: state.fixed,
      }
    case 'step-3':
      return {
        mode: state.mode,
        delimited: state.delimited,
        fixed: state.fixed,
      }
  }
}

/**
 * Resolve a delimiter token to its literal character. `other` returns the
 * configured `otherChar` (already validated to length 1 by the dialog).
 */
function delimiterChar(delimiter: TextToColumnsDelimiter, otherChar: string): string {
  switch (delimiter) {
    case 'tab':
      return '\t'
    case 'semicolon':
      return ';'
    case 'comma':
      return ','
    case 'space':
      return ' '
    case 'other':
      return otherChar.length > 0 ? otherChar.charAt(0) : ''
  }
}

/**
 * Tokenize a single source row with the active wizard config. Pure: same
 * input ↔ same output. Used by both the preview and the commit-plan
 * builder.
 *
 * Delimited mode honors `textQualifier` (strips outer + unescapes doubled
 * inner quotes) and `treatConsecutiveAsOne` (collapses runs of delimiters
 * into a single split). Fixed mode slices by character offset, padding
 * with empty strings when the row is shorter than the rightmost breakpoint.
 */
export function tokenize(text: string, config: EffectiveConfig): string[] {
  if (config.mode === 'fixed') {
    return tokenizeFixed(text, config.fixed.breakpoints)
  }
  return tokenizeDelimited(text, config.delimited)
}

function tokenizeFixed(text: string, breakpoints: readonly number[]): string[] {
  if (breakpoints.length === 0) return [text]
  const sorted = [...breakpoints].sort((a, b) => a - b).filter((b) => b > 0)
  const cuts = [0, ...sorted]
  const tokens: string[] = []
  for (let i = 0; i < cuts.length; i += 1) {
    const start = cuts[i]
    const end = i + 1 < cuts.length ? cuts[i + 1] : text.length
    if (start >= text.length) {
      tokens.push('')
    } else {
      tokens.push(text.slice(start, Math.min(end, text.length)))
    }
  }
  return tokens
}

function tokenizeDelimited(text: string, config: TextToColumnsDelimitedConfig): string[] {
  const chars = new Set<string>()
  for (const d of config.delimiters) {
    const c = delimiterChar(d, config.otherChar)
    if (c.length > 0) chars.add(c)
  }
  if (chars.size === 0) return [text]

  const qualifier = config.textQualifier === 'none' ? '' : config.textQualifier
  const tokens: string[] = []
  let current = ''
  // Excel/Sheets semantics: the qualifier is only honored when it appears
  // at the start of a field (immediately after a delimiter or at row
  // start). Mid-field qualifier characters are kept as literals.
  let inQualifier = false
  let fieldStart = true
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (qualifier && ch === qualifier) {
      if (inQualifier) {
        // Doubled qualifier inside a qualified token escapes to one literal.
        if (text[i + 1] === qualifier) {
          current += qualifier
          i += 2
          continue
        }
        // Closing qualifier. Any subsequent non-delimiter characters are
        // appended verbatim until the next delimiter (Excel/Sheets behavior).
        inQualifier = false
        fieldStart = false
        i += 1
        continue
      }
      if (fieldStart) {
        // Opening qualifier at field start.
        inQualifier = true
        fieldStart = false
        i += 1
        continue
      }
      // Mid-field qualifier — treat as literal character.
      current += ch
      fieldStart = false
      i += 1
      continue
    }
    if (!inQualifier && chars.has(ch)) {
      tokens.push(current)
      current = ''
      i += 1
      if (config.treatConsecutiveAsOne) {
        while (i < text.length && chars.has(text[i])) i += 1
      }
      fieldStart = true
      continue
    }
    current += ch
    fieldStart = false
    i += 1
  }
  tokens.push(current)
  return tokens
}

// --- step navigation helpers (pure) ---

function nextBlockReason(state: TextToColumnsWizardState): TextToColumnsNextBlockReason {
  if (state.step === 'step-3') return 'already-final'
  if (state.step === 'step-2-delimited') {
    const hasOther = state.delimited.delimiters.has('other') && state.delimited.otherChar.length > 0
    const hasNonOther = Array.from(state.delimited.delimiters).some(
      (delimiter) => delimiter !== 'other',
    )
    return hasOther || hasNonOther ? null : 'delimiter-required'
  }
  if (state.step === 'step-2-fixed') {
    return state.fixed.breakpoints.length > 0 ? null : 'breakpoint-required'
  }
  return null
}

/**
 * Compute how many columns the preview produces under the current config.
 * Used by the dialog to size the Step 3 format selector. Mirrors the
 * commit-plan builder: max token count across the (capped) preview.
 */
export function previewColumnCount(rows: readonly TextToColumnsPreviewRow[]): number {
  let max = 1
  for (const row of rows) {
    if (row.tokens.length > max) max = row.tokens.length
  }
  return max
}

export function makeStepTwoState(
  mode: TextToColumnsMode,
  delimited?: TextToColumnsDelimitedConfig,
  fixed?: TextToColumnsFixedConfig,
): TextToColumnsWizardState {
  if (mode === 'delimited') {
    return snapshotWizardState({
      step: 'step-2-delimited',
      mode: 'delimited',
      delimited: delimited ?? DEFAULT_DELIMITED_CONFIG,
    })
  }
  return snapshotWizardState({
    step: 'step-2-fixed',
    mode: 'fixed',
    fixed: fixed ?? DEFAULT_FIXED_CONFIG,
  })
}

export function makeStepThreeState(
  mode: TextToColumnsMode,
  columnCount: number,
  delimited: TextToColumnsDelimitedConfig,
  fixed: TextToColumnsFixedConfig,
  prevFormats?: readonly TextToColumnsColumnFormat[],
): TextToColumnsWizardState {
  const formats: TextToColumnsColumnFormat[] = []
  for (let i = 0; i < columnCount; i += 1) {
    formats.push(prevFormats?.[i] ?? 'general')
  }
  return snapshotWizardState({
    step: 'step-3',
    mode,
    delimited,
    fixed,
    formats,
  })
}

export type { TextToColumnsTextQualifier }
