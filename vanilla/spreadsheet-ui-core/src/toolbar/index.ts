import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import { editingSessionAtom } from '../editing'
import { nextHistoryTransactionId, pushHistoryAtom } from '../history'
import { selectionAtom } from '../selection'
import { workspaceSessionAtom } from '../workspace'
import type {
  MergeRangeRequest,
  ProjectionRequestId,
  ProjectionRevision,
  SetFormatRangeRequest,
  SpreadsheetBorderSpec,
  SpreadsheetBorders,
  SpreadsheetCellFormat,
  UnmergeRangeRequest,
} from '../backend/types'
import type { CellRange } from '../shared'
import type {
  OpenToolbarDropdownInput,
  OpenToolbarPaletteInput,
  ToolbarActiveSurface,
  ToolbarAvailabilitySnapshot,
  ToolbarCommandAvailability,
  ToolbarDropdownKind,
  ToolbarFormatCommandInput,
  ToolbarFormatCommandIntent,
  ToolbarFormatCommandKind,
  ToolbarIntent,
  ToolbarMutationControllerPort,
  ToolbarBackendMutationResult,
  ToolbarMutationIdentityPlan,
  ToolbarMutationLifecycleState,
  ToolbarMutationOperation,
  ToolbarMutationOutcome,
  ToolbarMutationStep,
  ToolbarPaletteKind,
  RunToolbarMutationInput,
  ToolbarUiState,
} from './types'

export * from './types'

export function createToolbarUiState(): ToolbarUiState {
  return Object.freeze({
    activeSurface: null,
  })
}

export function createToolbarSurfaceIntent(surface: ToolbarActiveSurface): ToolbarIntent {
  const snapshot = Object.freeze({ kind: surface.kind, id: surface.id })
  return Object.freeze({
    type: 'toolbar.surface.open',
    source: 'toolbar',
    surface: snapshot,
  })
}

export function createToolbarFormatCommandIntent(
  input: ToolbarFormatCommandInput,
  snapshot: ToolbarAvailabilitySnapshot,
): ToolbarFormatCommandIntent | null {
  if (snapshot.sheetId === null) {
    return null
  }

  return Object.freeze({
    type: 'toolbar.format.command',
    source: 'toolbar',
    sheetId: snapshot.sheetId,
    selectionKind: snapshot.selectionKind,
    command: input.command,
    value: input.value ?? null,
  })
}

export function getToolbarCommandAvailability(
  snapshot: ToolbarAvailabilitySnapshot,
): ToolbarCommandAvailability {
  const isEditing = snapshot.editingMode === 'drafting'
  const hasSheet = snapshot.sheetId !== null
  const canFormatSelection =
    hasSheet &&
    !isEditing &&
    (snapshot.selectionKind === 'cell' || snapshot.selectionKind === 'range')
  const canStyleSelection = hasSheet && !isEditing && snapshot.selectionKind !== 'all'

  return Object.freeze({
    sheetId: snapshot.sheetId,
    selectionKind: snapshot.selectionKind,
    editingMode: snapshot.editingMode,
    bold: canStyleSelection,
    italic: canStyleSelection,
    textColor: canStyleSelection,
    fillColor: canStyleSelection,
    numberFormat: canFormatSelection,
    alignment: canStyleSelection,
    verticalAlignment: canStyleSelection,
    underline: canStyleSelection,
    strikethrough: canStyleSelection,
    wrap: canStyleSelection,
    rotation: canStyleSelection,
    indent: canStyleSelection,
    border: canStyleSelection,
    fontFamily: canStyleSelection,
    fontSize: canStyleSelection,
  })
}

export function isToolbarFormatCommandAvailable(
  command: ToolbarFormatCommandKind,
  availability: ToolbarCommandAvailability,
): boolean {
  switch (command) {
    case 'bold':
      return availability.bold
    case 'italic':
      return availability.italic
    case 'text-color':
      return availability.textColor
    case 'fill-color':
      return availability.fillColor
    case 'number-format':
      return availability.numberFormat
    case 'alignment':
      return availability.alignment
    case 'vertical-alignment':
      return availability.verticalAlignment
    case 'underline':
      return availability.underline
    case 'strikethrough':
      return availability.strikethrough
    case 'wrap':
      return availability.wrap
    case 'rotation':
      return availability.rotation
    case 'indent-increase':
    case 'indent-decrease':
      return availability.indent
    case 'border':
      return availability.border
    case 'font-family':
      return availability.fontFamily
    case 'font-size':
    case 'font-size-up':
    case 'font-size-down':
      return availability.fontSize
    default:
      return false
  }
}

const toolbarUiStateBackingAtom = atom<ToolbarUiState>(Object.freeze(createToolbarUiState()))
toolbarUiStateBackingAtom.debugLabel = 'spreadsheet.toolbar.uiBacking'

/** Read-only Core-owned toolbar surface state; adapters use typed commands for transitions. */
export const toolbarUiStateAtom: Atom<ToolbarUiState> = atom((get) =>
  get(toolbarUiStateBackingAtom),
)
toolbarUiStateAtom.debugLabel = 'spreadsheet.toolbar.ui'

const toolbarIntentBackingAtom = atom<ToolbarIntent | null>(null)
toolbarIntentBackingAtom.debugLabel = 'spreadsheet.toolbar.intentBacking'

/** Read-only Core-owned intent projection; only typed toolbar commands write its backing atom. */
export const toolbarIntentAtom: Atom<ToolbarIntent | null> = atom((get) =>
  get(toolbarIntentBackingAtom),
)
toolbarIntentAtom.debugLabel = 'spreadsheet.toolbar.intent'

export const toolbarActiveSurfaceAtom: Atom<ToolbarActiveSurface | null> = atom(
  (get) => get(toolbarUiStateBackingAtom).activeSurface,
)
toolbarActiveSurfaceAtom.debugLabel = 'spreadsheet.toolbar.activeSurface'

export const toolbarCommandAvailabilityAtom = atom((get): ToolbarCommandAvailability => {
  const selection = get(selectionAtom)
  const editing = get(editingSessionAtom)
  const workspace = get(workspaceSessionAtom)

  return getToolbarCommandAvailability({
    sheetId: workspace.activeSheetId ?? (selection.sheetId.length > 0 ? selection.sheetId : null),
    selectionKind: selection.kind,
    editingMode: editing.status,
  })
})
toolbarCommandAvailabilityAtom.debugLabel = 'spreadsheet.toolbar.commandAvailability'

export const openToolbarDropdownAtom = atom(
  (get) => get(toolbarUiStateBackingAtom),
  (_get, set, input: OpenToolbarDropdownInput) => {
    const surface: ToolbarActiveSurface = Object.freeze({
      kind: 'dropdown',
      id: input.dropdown,
    })

    set(
      toolbarUiStateBackingAtom,
      Object.freeze({
        activeSurface: surface,
      }),
    )
    set(toolbarIntentBackingAtom, createToolbarSurfaceIntent(surface))
    return surface
  },
)
openToolbarDropdownAtom.debugLabel = 'spreadsheet.toolbar.openDropdown'

export const openToolbarPaletteAtom = atom(
  (get) => get(toolbarUiStateBackingAtom),
  (_get, set, input: OpenToolbarPaletteInput) => {
    const surface: ToolbarActiveSurface = Object.freeze({
      kind: 'palette',
      id: input.palette,
    })

    set(
      toolbarUiStateBackingAtom,
      Object.freeze({
        activeSurface: surface,
      }),
    )
    set(toolbarIntentBackingAtom, createToolbarSurfaceIntent(surface))
    return surface
  },
)
openToolbarPaletteAtom.debugLabel = 'spreadsheet.toolbar.openPalette'

export const closeToolbarSurfaceAtom = atom(
  (get) => get(toolbarUiStateBackingAtom),
  (_get, set) => {
    set(
      toolbarUiStateBackingAtom,
      Object.freeze({
        activeSurface: null,
      }),
    )
    set(
      toolbarIntentBackingAtom,
      Object.freeze({
        type: 'toolbar.surface.close',
        source: 'toolbar',
      }),
    )
    return null
  },
)
closeToolbarSurfaceAtom.debugLabel = 'spreadsheet.toolbar.closeSurface'

export const dispatchToolbarFormatCommandAtom = atom(
  (get) => get(toolbarIntentAtom),
  (get, set, input: ToolbarFormatCommandInput) => {
    const selection = get(selectionAtom)
    const workspace = get(workspaceSessionAtom)
    const availability = get(toolbarCommandAvailabilityAtom)
    const commandAvailable = isToolbarFormatCommandAvailable(input.command, availability)

    if (!commandAvailable) {
      return null
    }

    const intent = createToolbarFormatCommandIntent(
      {
        ...input,
        sheetId:
          input.sheetId ??
          workspace.activeSheetId ??
          (selection.sheetId.length > 0 ? selection.sheetId : null),
      },
      {
        sheetId:
          workspace.activeSheetId ?? (selection.sheetId.length > 0 ? selection.sheetId : null),
        selectionKind: selection.kind,
        editingMode: get(editingSessionAtom).status,
      },
    )

    if (intent === null) {
      return null
    }

    set(toolbarIntentBackingAtom, intent)
    return intent
  },
)
dispatchToolbarFormatCommandAtom.debugLabel = 'spreadsheet.toolbar.dispatchFormatCommand'

export const clearToolbarIntentAtom = atom(
  (get) => get(toolbarIntentBackingAtom),
  (_get, set) => {
    set(toolbarIntentBackingAtom, null)
    return null
  },
)
clearToolbarIntentAtom.debugLabel = 'spreadsheet.toolbar.clearIntent'

export const TOOLBAR_MUTATION_CAPABILITY_ERROR =
  'Toolbar mutation is unavailable because this workbook does not provide the required transport.'
export const TOOLBAR_MUTATION_ACKNOWLEDGEMENT_ERROR =
  'Toolbar mutation acknowledgement did not match the active request.'
export const TOOLBAR_MUTATION_OUTCOME_UNKNOWN_ERROR =
  'Toolbar mutation result is unknown. Reconcile workbook data before another mutation.'

type CapturedToolbarMutationRequest =
  | Readonly<SetFormatRangeRequest>
  | Readonly<MergeRangeRequest>
  | Readonly<UnmergeRangeRequest>

interface CapturedToolbarMutationStep {
  readonly kind: ToolbarMutationStep['kind']
  readonly requestId: ProjectionRequestId
  readonly range: Readonly<CellRange>
  readonly request: CapturedToolbarMutationRequest
  readonly execute: () => Promise<ToolbarBackendMutationResult>
}

type ToolbarMutationHistoryKind = 'format.set' | 'range.merge' | 'range.unmerge'

interface ToolbarMutationTicket {
  readonly sessionId: number
  readonly operation: ToolbarMutationOperation
  readonly sheetId: string
  readonly requestId: ProjectionRequestId
  readonly affectedRange: Readonly<CellRange>
  readonly steps: readonly CapturedToolbarMutationStep[]
  readonly historyKind: ToolbarMutationHistoryKind
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

const INITIAL_TOOLBAR_MUTATION_LIFECYCLE: ToolbarMutationLifecycleState = Object.freeze({
  status: 'ready',
  sessionId: 0,
  operation: null,
  sheetId: null,
  requestId: null,
  affectedRange: null,
  acknowledgedRevision: null,
  acknowledgedCount: 0,
  totalCount: 0,
  canRetryRefresh: false,
  error: '',
})

const toolbarMutationLifecycleBackingAtom = atom<ToolbarMutationLifecycleState>(
  INITIAL_TOOLBAR_MUTATION_LIFECYCLE,
)
toolbarMutationLifecycleBackingAtom.debugLabel = 'spreadsheet.toolbar.mutationLifecycleBacking'

const activeToolbarMutationTicketAtom = atom<ToolbarMutationTicket | null>(null)
activeToolbarMutationTicketAtom.debugLabel = 'spreadsheet.toolbar.activeMutationTicket'

/** Held until the currently executing raw transport/refresh promise has settled. */
const toolbarMutationTransportLaneAtom = atom<ToolbarMutationTicket | null>(null)
toolbarMutationTransportLaneAtom.debugLabel = 'spreadsheet.toolbar.mutationTransportLane'

const toolbarMutationSessionSequenceAtom = atom(0)
toolbarMutationSessionSequenceAtom.debugLabel = 'spreadsheet.toolbar.mutationSessionSequence'

const toolbarMutationRequestSequenceAtom = atom(0)
toolbarMutationRequestSequenceAtom.debugLabel = 'spreadsheet.toolbar.mutationRequestSequence'

/** Read-only Core-owned mutation lifecycle; adapters render but never write it. */
export const toolbarMutationLifecycleAtom: Atom<ToolbarMutationLifecycleState> = atom((get) =>
  get(toolbarMutationLifecycleBackingAtom),
)
toolbarMutationLifecycleAtom.debugLabel = 'spreadsheet.toolbar.mutationLifecycle'

/** Pure safe-integer allocator used by both toolbar mutation identity lanes. */
export function nextToolbarMutationIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

/** Atomically plans every identity before any private sequence is advanced. */
export function planToolbarMutationIdentities(
  sessionSequence: number,
  requestSequence: number,
  requestCount: number,
): ToolbarMutationIdentityPlan | null {
  if (!Number.isSafeInteger(requestCount) || requestCount <= 0) return null
  const sessionId = nextToolbarMutationIdentity(sessionSequence)
  if (sessionId === null) return null

  const requestIds: ProjectionRequestId[] = []
  let nextRequestSequence = requestSequence
  for (let index = 0; index < requestCount; index += 1) {
    const requestId = nextToolbarMutationIdentity(nextRequestSequence)
    if (requestId === null) return null
    requestIds.push(requestId)
    nextRequestSequence = requestId
  }

  return Object.freeze({
    sessionId,
    requestIds: Object.freeze(requestIds),
    requestSequence: nextRequestSequence,
  })
}

function isProjectionRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function isCellRange(value: Readonly<CellRange>): boolean {
  return (
    Number.isSafeInteger(value.rowStart) &&
    Number.isSafeInteger(value.rowEnd) &&
    Number.isSafeInteger(value.colStart) &&
    Number.isSafeInteger(value.colEnd) &&
    value.rowStart >= 0 &&
    value.colStart >= 0 &&
    value.rowStart <= value.rowEnd &&
    value.colStart <= value.colEnd
  )
}

function snapshotRange(range: Readonly<CellRange>): Readonly<CellRange> {
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  })
}

function snapshotBorderSpec(
  spec: SpreadsheetBorderSpec | undefined,
): SpreadsheetBorderSpec | undefined {
  return spec ? Object.freeze({ ...spec }) : undefined
}

function snapshotBorders(borders: SpreadsheetBorders | undefined): SpreadsheetBorders | undefined {
  if (!borders) return undefined
  return Object.freeze({
    ...(borders.top ? { top: snapshotBorderSpec(borders.top) } : {}),
    ...(borders.right ? { right: snapshotBorderSpec(borders.right) } : {}),
    ...(borders.bottom ? { bottom: snapshotBorderSpec(borders.bottom) } : {}),
    ...(borders.left ? { left: snapshotBorderSpec(borders.left) } : {}),
  })
}

function snapshotFormat(format: SpreadsheetCellFormat | null): SpreadsheetCellFormat | null {
  if (format === null) return null
  return Object.freeze({
    ...format,
    ...(format.numberFormat ? { numberFormat: Object.freeze({ ...format.numberFormat }) } : {}),
    ...(format.borders ? { borders: snapshotBorders(format.borders) } : {}),
  })
}

function rangesEqual(left: unknown, right: Readonly<CellRange>): boolean {
  if (typeof left !== 'object' || left === null) return false
  const range = left as Partial<CellRange>
  return (
    range.rowStart === right.rowStart &&
    range.rowEnd === right.rowEnd &&
    range.colStart === right.colStart &&
    range.colEnd === right.colEnd
  )
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
    return 'Unknown toolbar mutation transport failure.'
  }
}

function lifecycleFor(
  status: ToolbarMutationLifecycleState['status'],
  input: Partial<Omit<ToolbarMutationLifecycleState, 'status'>> = {},
): ToolbarMutationLifecycleState {
  return Object.freeze({
    status,
    sessionId: input.sessionId ?? 0,
    operation: input.operation ?? null,
    sheetId: input.sheetId ?? null,
    requestId: input.requestId ?? null,
    affectedRange: input.affectedRange ?? null,
    acknowledgedRevision: input.acknowledgedRevision ?? null,
    acknowledgedCount: input.acknowledgedCount ?? 0,
    totalCount: input.totalCount ?? 0,
    canRetryRefresh: input.canRetryRefresh ?? false,
    error: input.error ?? '',
  })
}

function lifecycleForTicket(
  status: ToolbarMutationLifecycleState['status'],
  ticket: ToolbarMutationTicket,
  input: {
    readonly acknowledgedRevision?: ProjectionRevision | null
    readonly acknowledgedCount?: number
    readonly canRetryRefresh?: boolean
    readonly error?: string
  } = {},
): ToolbarMutationLifecycleState {
  return lifecycleFor(status, {
    sessionId: ticket.sessionId,
    operation: ticket.operation,
    sheetId: ticket.sheetId,
    requestId: ticket.requestId,
    affectedRange: ticket.affectedRange,
    acknowledgedRevision: input.acknowledgedRevision ?? null,
    acknowledgedCount: input.acknowledgedCount ?? 0,
    totalCount: ticket.steps.length,
    canRetryRefresh: input.canRetryRefresh ?? false,
    error: input.error ?? '',
  })
}

function operationAcceptsStep(
  operation: ToolbarMutationOperation,
  step: ToolbarMutationStep,
): boolean {
  switch (operation) {
    case 'format':
    case 'border-batch':
      return step.kind === 'set-format-range'
    case 'merge':
      return step.kind === 'merge-range'
    case 'unmerge':
      return step.kind === 'unmerge-range'
    default:
      return false
  }
}

function historyKindForOperation(
  operation: ToolbarMutationOperation,
): ToolbarMutationHistoryKind | null {
  switch (operation) {
    case 'format':
    case 'border-batch':
      return 'format.set'
    case 'merge':
      return 'range.merge'
    case 'unmerge':
      return 'range.unmerge'
    default:
      return null
  }
}

function capturePort<K extends keyof ToolbarMutationControllerPort>(
  source: ToolbarMutationControllerPort,
  key: K,
): ToolbarMutationControllerPort[K] | null {
  try {
    const method = source[key]
    return typeof method === 'function'
      ? (method.bind(source) as ToolbarMutationControllerPort[K])
      : null
  } catch {
    return null
  }
}

function strictAcknowledgementRevision(
  result: unknown,
  ticket: ToolbarMutationTicket,
  step: CapturedToolbarMutationStep,
): ProjectionRevision | null {
  try {
    if (typeof result !== 'object' || result === null) return null
    const acknowledgement = result as Partial<ToolbarBackendMutationResult>
    if (
      acknowledgement.sheetId !== ticket.sheetId ||
      acknowledgement.kind !== step.kind ||
      acknowledgement.requestId !== step.requestId ||
      !rangesEqual(acknowledgement.affectedRange, step.range) ||
      !isProjectionRevision(acknowledgement.revision)
    ) {
      return null
    }
    return acknowledgement.revision
  } catch {
    return null
  }
}

function buildMutationTicket(
  get: Getter,
  set: Setter,
  input: RunToolbarMutationInput,
): ToolbarMutationTicket | null {
  const historyKind = historyKindForOperation(input.operation)
  if (
    historyKind === null ||
    typeof input.sheetId !== 'string' ||
    input.sheetId.length === 0 ||
    !isCellRange(input.affectedRange) ||
    !Array.isArray(input.steps) ||
    input.steps.length === 0 ||
    typeof input.refreshProjection !== 'function'
  ) {
    return null
  }

  const setFormatRange = capturePort(input.source, 'setFormatRange')
  const mergeRange = capturePort(input.source, 'mergeRange')
  const unmergeRange = capturePort(input.source, 'unmergeRange')
  if (
    input.steps.some(
      (step) =>
        !isCellRange(step.range) ||
        !operationAcceptsStep(input.operation, step) ||
        (step.kind === 'set-format-range' && setFormatRange === null) ||
        (step.kind === 'merge-range' && mergeRange === null) ||
        (step.kind === 'unmerge-range' && unmergeRange === null),
    )
  ) {
    return null
  }

  const identityPlan = planToolbarMutationIdentities(
    get(toolbarMutationSessionSequenceAtom),
    get(toolbarMutationRequestSequenceAtom),
    input.steps.length,
  )
  if (identityPlan === null) return null

  const capturedSteps: CapturedToolbarMutationStep[] = []
  for (const [index, step] of input.steps.entries()) {
    const requestId = identityPlan.requestIds[index]
    if (requestId === undefined) return null
    const range = snapshotRange(step.range)

    if (step.kind === 'set-format-range' && setFormatRange) {
      const request = Object.freeze({
        kind: 'set-format-range' as const,
        sheetId: input.sheetId,
        requestId,
        range,
        format: snapshotFormat(step.format),
      })
      capturedSteps.push(
        Object.freeze({
          kind: step.kind,
          requestId,
          range,
          request,
          execute: () => setFormatRange(request),
        }),
      )
    } else if (step.kind === 'merge-range' && mergeRange) {
      const request = Object.freeze({
        kind: 'merge-range' as const,
        sheetId: input.sheetId,
        requestId,
        range,
      })
      capturedSteps.push(
        Object.freeze({
          kind: step.kind,
          requestId,
          range,
          request,
          execute: () => mergeRange(request),
        }),
      )
    } else if (step.kind === 'unmerge-range' && unmergeRange) {
      const request = Object.freeze({
        kind: 'unmerge-range' as const,
        sheetId: input.sheetId,
        requestId,
        range,
      })
      capturedSteps.push(
        Object.freeze({
          kind: step.kind,
          requestId,
          range,
          request,
          execute: () => unmergeRange(request),
        }),
      )
    }
  }

  if (capturedSteps.length !== input.steps.length) return null
  set(toolbarMutationSessionSequenceAtom, identityPlan.sessionId)
  set(toolbarMutationRequestSequenceAtom, identityPlan.requestSequence)
  return Object.freeze({
    sessionId: identityPlan.sessionId,
    operation: input.operation,
    sheetId: input.sheetId,
    requestId: capturedSteps[0].requestId,
    affectedRange: snapshotRange(input.affectedRange),
    steps: Object.freeze(capturedSteps),
    historyKind,
    refreshProjection: input.refreshProjection,
  })
}

async function executeMutationTicket(
  get: Getter,
  set: Setter,
  ticket: ToolbarMutationTicket,
): Promise<ToolbarMutationOutcome> {
  if (get(toolbarMutationTransportLaneAtom) !== null) return 'blocked'
  set(toolbarMutationTransportLaneAtom, ticket)
  try {
    let acknowledgedCount = 0
    let acknowledgedRevision: ProjectionRevision | null = null
    set(toolbarMutationLifecycleBackingAtom, lifecycleForTicket('pending', ticket))

    for (const step of ticket.steps) {
      let result: ToolbarBackendMutationResult
      try {
        result = await step.execute()
      } catch (error) {
        if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
        set(
          toolbarMutationLifecycleBackingAtom,
          lifecycleForTicket('outcome-unknown', ticket, {
            acknowledgedRevision,
            acknowledgedCount,
            canRetryRefresh: true,
            error: `${TOOLBAR_MUTATION_OUTCOME_UNKNOWN_ERROR} ${errorMessage(error)}`,
          }),
        )
        return 'outcome-unknown'
      }

      if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
      const revision = strictAcknowledgementRevision(result, ticket, step)
      if (revision === null) {
        set(
          toolbarMutationLifecycleBackingAtom,
          lifecycleForTicket('outcome-unknown', ticket, {
            acknowledgedRevision,
            acknowledgedCount,
            canRetryRefresh: true,
            error:
              `${TOOLBAR_MUTATION_OUTCOME_UNKNOWN_ERROR} ${TOOLBAR_MUTATION_ACKNOWLEDGEMENT_ERROR}`,
          }),
        )
        return 'outcome-unknown'
      }
      acknowledgedCount += 1
      acknowledgedRevision = revision
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleForTicket('pending', ticket, { acknowledgedRevision, acknowledgedCount }),
      )
    }

    set(
      toolbarMutationLifecycleBackingAtom,
      lifecycleForTicket('local-acknowledged', ticket, {
        acknowledgedRevision,
        acknowledgedCount,
      }),
    )
    const historyRecorded = set(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId('toolbar'),
      kind: ticket.historyKind,
      sheetId: ticket.sheetId,
      projectionRevision: acknowledgedRevision as ProjectionRevision,
      affectedRange: ticket.affectedRange,
    })
    if (!historyRecorded) {
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleForTicket('outcome-unknown', ticket, {
          acknowledgedRevision,
          acknowledgedCount,
          canRetryRefresh: true,
          error:
            `${TOOLBAR_MUTATION_OUTCOME_UNKNOWN_ERROR} History rejected the acknowledged mutation.`,
        }),
      )
      return 'outcome-unknown'
    }

    set(
      toolbarMutationLifecycleBackingAtom,
      lifecycleForTicket('refreshing', ticket, { acknowledgedRevision, acknowledgedCount }),
    )
    try {
      await ticket.refreshProjection(ticket.sheetId)
    } catch (error) {
      if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleForTicket('refresh-failed', ticket, {
          acknowledgedRevision,
          acknowledgedCount,
          canRetryRefresh: true,
          error: `Toolbar mutation was acknowledged, but refresh failed: ${errorMessage(error)}`,
        }),
      )
      return 'refresh-failed'
    }

    if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
    set(activeToolbarMutationTicketAtom, null)
    set(
      toolbarMutationLifecycleBackingAtom,
      lifecycleForTicket('ready', ticket, { acknowledgedRevision, acknowledgedCount }),
    )
    return 'completed'
  } finally {
    if (get(toolbarMutationTransportLaneAtom) === ticket) {
      set(toolbarMutationTransportLaneAtom, null)
    }
  }
}

export const runToolbarMutationAtom = atom(
  (get) => get(toolbarMutationLifecycleAtom),
  async (get, set, input: RunToolbarMutationInput): Promise<ToolbarMutationOutcome> => {
    if (
      get(activeToolbarMutationTicketAtom) !== null ||
      get(toolbarMutationTransportLaneAtom) !== null
    ) {
      return 'blocked'
    }
    const ticket = buildMutationTicket(get, set, input)
    if (ticket === null) {
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleFor('blocked', {
          sessionId: get(toolbarMutationSessionSequenceAtom),
          operation: input.operation,
          sheetId: input.sheetId || null,
          affectedRange: isCellRange(input.affectedRange)
            ? snapshotRange(input.affectedRange)
            : null,
          error: TOOLBAR_MUTATION_CAPABILITY_ERROR,
        }),
      )
      return 'blocked'
    }
    set(activeToolbarMutationTicketAtom, ticket)
    return executeMutationTicket(get, set, ticket)
  },
)
runToolbarMutationAtom.debugLabel = 'spreadsheet.toolbar.runMutation'

/**
 * Kept as a compatibility command, but intentionally fails closed. Once a
 * backend promise has been awaited, a rejection cannot prove the mutation was
 * not applied; callers must reconcile with retryToolbarMutationRefreshAtom.
 */
export const retryToolbarMutationAtom = atom(
  (get) => get(toolbarMutationLifecycleAtom),
  async (): Promise<ToolbarMutationOutcome> => 'blocked',
)
retryToolbarMutationAtom.debugLabel = 'spreadsheet.toolbar.retryMutation'

/** Refresh/reconcile only: never resends a mutation after ACK or ambiguous settlement. */
export const retryToolbarMutationRefreshAtom = atom(
  (get) => get(toolbarMutationLifecycleAtom),
  async (get, set): Promise<ToolbarMutationOutcome> => {
    const ticket = get(activeToolbarMutationTicketAtom)
    const lifecycle = get(toolbarMutationLifecycleBackingAtom)
    if (
      ticket === null ||
      get(toolbarMutationTransportLaneAtom) !== null ||
      (lifecycle.status !== 'refresh-failed' && lifecycle.status !== 'outcome-unknown') ||
      !lifecycle.canRetryRefresh ||
      lifecycle.sessionId !== ticket.sessionId
    ) {
      return 'blocked'
    }

    set(toolbarMutationTransportLaneAtom, ticket)
    try {
      const terminalStatus = lifecycle.status
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleForTicket('refreshing', ticket, {
          acknowledgedRevision: lifecycle.acknowledgedRevision,
          acknowledgedCount: lifecycle.acknowledgedCount,
        }),
      )
      try {
        await ticket.refreshProjection(ticket.sheetId)
      } catch (error) {
        if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
        set(
          toolbarMutationLifecycleBackingAtom,
          lifecycleForTicket(terminalStatus, ticket, {
            acknowledgedRevision: lifecycle.acknowledgedRevision,
            acknowledgedCount: lifecycle.acknowledgedCount,
            canRetryRefresh: true,
            error: `Toolbar reconciliation refresh failed: ${errorMessage(error)}`,
          }),
        )
        return terminalStatus === 'refresh-failed' ? 'refresh-failed' : 'outcome-unknown'
      }
      if (get(activeToolbarMutationTicketAtom) !== ticket) return 'stale'
      set(activeToolbarMutationTicketAtom, null)
      if (terminalStatus === 'outcome-unknown') {
        set(
          toolbarMutationLifecycleBackingAtom,
          lifecycleForTicket('outcome-unknown', ticket, {
            acknowledgedRevision: lifecycle.acknowledgedRevision,
            acknowledgedCount: lifecycle.acknowledgedCount,
            canRetryRefresh: false,
            error: 'Projection refreshed, but the toolbar mutation outcome remains unknown.',
          }),
        )
        return 'outcome-unknown'
      }
      set(
        toolbarMutationLifecycleBackingAtom,
        lifecycleForTicket('ready', ticket, {
          acknowledgedRevision: lifecycle.acknowledgedRevision,
          acknowledgedCount: lifecycle.acknowledgedCount,
        }),
      )
      return 'completed'
    } finally {
      if (get(toolbarMutationTransportLaneAtom) === ticket) {
        set(toolbarMutationTransportLaneAtom, null)
      }
    }
  },
)
retryToolbarMutationRefreshAtom.debugLabel = 'spreadsheet.toolbar.retryMutationRefresh'

/**
 * Invalidates the active session without releasing an unsettled transport lane.
 * Late results therefore resolve as stale, and a replacement mutation remains
 * blocked until the raw promise has actually settled. Recovery-bearing
 * refresh-failed/outcome-unknown tickets cannot be reset away; their only legal
 * exit is refresh-only reconciliation.
 */
export const resetToolbarMutationAtom = atom(
  (get) => get(toolbarMutationLifecycleAtom),
  (get, set): boolean => {
    const ticket = get(activeToolbarMutationTicketAtom)
    if (ticket === null) return false
    const lifecycle = get(toolbarMutationLifecycleBackingAtom)
    if (
      (lifecycle.status === 'refresh-failed' || lifecycle.status === 'outcome-unknown') &&
      lifecycle.canRetryRefresh
    ) {
      return false
    }
    set(activeToolbarMutationTicketAtom, null)
    set(toolbarMutationLifecycleBackingAtom, INITIAL_TOOLBAR_MUTATION_LIFECYCLE)
    return true
  },
)
resetToolbarMutationAtom.debugLabel = 'spreadsheet.toolbar.resetMutation'

export function isToolbarDropdownKind(
  value: ToolbarActiveSurface['id'],
): value is ToolbarDropdownKind {
  return (
    value === 'alignment' ||
    value === 'vertical-alignment' ||
    value === 'number-format' ||
    value === 'border' ||
    value === 'merge' ||
    value === 'font-family' ||
    value === 'font-size' ||
    value === 'rotation' ||
    value === 'sort'
  )
}

export function isToolbarPaletteKind(
  value: ToolbarActiveSurface['id'],
): value is ToolbarPaletteKind {
  return value === 'text-color' || value === 'fill-color'
}
