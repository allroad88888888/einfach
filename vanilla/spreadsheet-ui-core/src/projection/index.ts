import { atom, type Atom } from '@einfach/core'
import type {
  DisplayCell,
  ProjectionCancelToken,
  ProjectionRequestId,
  ProjectionRequestReason,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '../backend'
import type { CellRange, SheetRef, SpreadsheetError } from '../shared'
import type {
  BeginProjectionInput,
  ProjectionLimitOptions,
  ProjectionBeginOutcome,
  ProjectionRejectOutcome,
  ProjectionRequest,
  ProjectionResolveOutcome,
  ProjectionResult,
  ProjectionSnapshot,
  ProjectionValidationCode,
  ProjectionValidationError,
  ProjectionValidationResult,
  RejectProjectionInput,
  ReportProjectionErrorInput,
  ResolveProjectionInput,
} from './types'

export * from './types'

export const DEFAULT_MAX_PROJECTION_CELLS = 50_000

export interface CreateVisibleProjectionRequestInput extends SheetRef {
  window: CellRange
  requestId: ProjectionRequestId
  reason?: ProjectionRequestReason
  revision?: ProjectionRevision
  cancelToken?: ProjectionCancelToken
}

export interface CreateRangeProjectionRequestInput extends SheetRef {
  range: CellRange
  requestId: ProjectionRequestId
  reason: ProjectionRequestReason
  revision?: ProjectionRevision
  cancelToken?: ProjectionCancelToken
}

function copyRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function isInteger(value: number) {
  return Number.isSafeInteger(value)
}

function sameRange(left: CellRange, right: CellRange) {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function makeInvalid(
  code: ProjectionValidationCode,
  message: string,
  extra: Omit<Extract<ProjectionValidationResult, { ok: false }>['error'], 'code' | 'message'> = {},
): ProjectionValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  }
}

export function createVisibleProjectionRequest(
  input: CreateVisibleProjectionRequestInput,
): VisibleProjectionRequest {
  return {
    kind: 'visible-window',
    sheetId: input.sheetId,
    window: copyRange(input.window),
    requestId: input.requestId,
    reason: input.reason,
    revision: input.revision,
    cancelToken: input.cancelToken,
  }
}

export function createRangeProjectionRequest(
  input: CreateRangeProjectionRequestInput,
): RangeProjectionRequest {
  return {
    kind: 'range',
    sheetId: input.sheetId,
    range: copyRange(input.range),
    requestId: input.requestId,
    reason: input.reason,
    revision: input.revision,
    cancelToken: input.cancelToken,
  }
}

export function getProjectionRequestRange(request: ProjectionRequest): CellRange {
  return request.kind === 'visible-window' ? request.window : request.range
}

export function getProjectionResultRange(result: ProjectionResult): CellRange {
  return result.kind === 'visible-window' ? result.window : result.range
}

export function isEmptyRange(range: CellRange): boolean {
  return range.rowEnd < range.rowStart || range.colEnd < range.colStart
}

export function countRangeCells(range: CellRange): number {
  if (isEmptyRange(range)) {
    return 0
  }
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

export function isCellInRange(cell: DisplayCell, range: CellRange): boolean {
  return (
    cell.row >= range.rowStart &&
    cell.row <= range.rowEnd &&
    cell.col >= range.colStart &&
    cell.col <= range.colEnd
  )
}

export function getProjectionWindowKey(sheetId: string, range: CellRange): string {
  return `${sheetId}:${range.rowStart}:${range.rowEnd}:${range.colStart}:${range.colEnd}`
}

function validateProjectionRange(
  sheetId: string,
  requestId: ProjectionRequestId,
  range: CellRange,
  options: ProjectionLimitOptions = {},
): ProjectionValidationResult {
  const maxCells = options.maxCells ?? DEFAULT_MAX_PROJECTION_CELLS

  if (sheetId.length === 0) {
    return makeInvalid('INVALID_SHEET', 'Projection requests must include a sheet id.')
  }

  if (!isInteger(requestId) || requestId === 0) {
    return makeInvalid(
      'INVALID_REQUEST_ID',
      'Projection request ids must be non-zero safe integers.',
    )
  }

  if (
    !isInteger(range.rowStart) ||
    !isInteger(range.rowEnd) ||
    !isInteger(range.colStart) ||
    !isInteger(range.colEnd) ||
    range.rowStart < 0 ||
    range.colStart < 0
  ) {
    return makeInvalid('INVALID_RANGE', 'Projection ranges must use non-negative integer bounds.', {
      range,
    })
  }

  if (isEmptyRange(range)) {
    return makeInvalid('EMPTY_RANGE', 'Empty ranges should not be sent to the backend.', {
      range,
    })
  }

  const cellCount = countRangeCells(range)
  if (cellCount > maxCells) {
    return makeInvalid('RANGE_TOO_LARGE', 'Projection requests must remain bounded.', {
      range,
      cellCount,
      maxCells,
    })
  }

  return {
    ok: true,
    cellCount,
  }
}

export function validateProjectionRequest(
  request: ProjectionRequest,
  options: ProjectionLimitOptions = {},
): ProjectionValidationResult {
  return validateProjectionRange(
    request.sheetId,
    request.requestId,
    getProjectionRequestRange(request),
    options,
  )
}

export function isProjectionResultForRequest(
  request: ProjectionRequest,
  result: ProjectionResult,
): boolean {
  return (
    request.kind === result.kind &&
    request.sheetId === result.sheetId &&
    request.requestId === result.requestId &&
    sameRange(getProjectionRequestRange(request), getProjectionResultRange(result)) &&
    projectionRevisionsCorrelate(request.revision, result.revision)
  )
}

/**
 * Revision is an optional content version, not a request identity witness.
 * An omitted request revision lets the backend establish the current version;
 * an explicit request version must be echoed exactly.
 */
export function projectionRevisionsCorrelate(
  requestRevision: ProjectionRevision | undefined,
  resultRevision: ProjectionRevision | undefined,
): boolean {
  return requestRevision === undefined || requestRevision === resultRevision
}

export function validateProjectionResult(
  result: ProjectionResult,
  options: ProjectionLimitOptions & { request?: ProjectionRequest } = {},
): ProjectionValidationResult {
  if (options.request && !isProjectionResultForRequest(options.request, result)) {
    return makeInvalid('STALE_RESULT', 'Projection result does not match its request.')
  }

  const range = getProjectionResultRange(result)
  const requestValidation = validateProjectionRange(
    result.sheetId,
    result.requestId,
    range,
    options,
  )

  if (!requestValidation.ok) {
    return requestValidation
  }

  if (result.cells.length > requestValidation.cellCount) {
    return makeInvalid(
      'RESULT_TOO_LARGE',
      'Projection results may not contain more cells than the requested range.',
      {
        range,
        cellCount: result.cells.length,
        maxCells: requestValidation.cellCount,
      },
    )
  }

  for (const cell of result.cells) {
    if (!isCellInRange(cell, range)) {
      return makeInvalid(
        'CELL_OUT_OF_RANGE',
        'Projection results may only include cells inside the requested range.',
        { range },
      )
    }
  }

  return {
    ok: true,
    cellCount: requestValidation.cellCount,
  }
}

export function createEmptyVisibleProjectionResult(
  request: VisibleProjectionRequest,
): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision,
    window: copyRange(request.window),
    cells: [],
  }
}

const MAX_PROJECTION_ERROR_TEXT = 512

const IDLE_PROJECTION_SNAPSHOT: ProjectionSnapshot = Object.freeze({
  status: 'idle',
  request: undefined,
  result: undefined,
  error: undefined,
})

interface ProjectionLaneTicket<Request extends ProjectionRequest = ProjectionRequest> {
  readonly request: Request
  readonly retainResult: boolean
}

interface VisibleProjectionLaneState {
  readonly active: ProjectionLaneTicket<VisibleProjectionRequest> | null
  readonly queued: ProjectionLaneTicket<VisibleProjectionRequest> | null
}

interface ProjectionLaneState {
  readonly visibleWindow: VisibleProjectionLaneState
  readonly range: ProjectionLaneTicket<RangeProjectionRequest> | null
}

const EMPTY_PROJECTION_LANES: ProjectionLaneState = Object.freeze({
  visibleWindow: Object.freeze({ active: null, queued: null }),
  range: null,
})

function freezeProjectionValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeProjectionValue(item))) as T
  }

  const snapshot: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    snapshot[key] = freezeProjectionValue(child)
  }
  return Object.freeze(snapshot) as T
}

function freezeProjectionRequest(request: ProjectionRequest): ProjectionRequest {
  return freezeProjectionValue(request)
}

function freezeProjectionResult(result: ProjectionResult): ProjectionResult {
  return freezeProjectionValue(result)
}

function freezeProjectionValidationError(
  error: ProjectionValidationError,
): ProjectionValidationError {
  return freezeProjectionValue(error)
}

function freezeProjectionSnapshot(snapshot: ProjectionSnapshot): ProjectionSnapshot {
  return Object.freeze({
    status: snapshot.status,
    request: snapshot.request,
    result: snapshot.result,
    error: snapshot.error,
  })
}

function boundedText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value.length > 0 ? value : fallback
  return text.slice(0, MAX_PROJECTION_ERROR_TEXT)
}

function projectionErrorFrom(
  error: unknown,
  fallbackMessage = 'Spreadsheet projection failed.',
  code?: string,
): SpreadsheetError {
  const fallbackCode = code ?? 'BACKEND_ERROR'
  let source: Partial<SpreadsheetError> = {}
  try {
    if (typeof error === 'object' && error !== null) {
      source = error as Partial<SpreadsheetError>
    }
  } catch {
    source = {}
  }

  let message = fallbackMessage
  try {
    if (error instanceof Error) message = error.message
    else if (typeof source.message === 'string') message = source.message
  } catch {
    message = fallbackMessage
  }

  const snapshot: SpreadsheetError = {
    code: boundedText(source.code, fallbackCode),
    message: boundedText(message, fallbackMessage),
  }
  if (source.severity !== undefined) snapshot.severity = source.severity
  if (source.source !== undefined) snapshot.source = source.source
  if (source.hint !== undefined) snapshot.hint = boundedText(source.hint, '')
  return Object.freeze(snapshot)
}

function sameProjectionRequest(left: ProjectionRequest, right: ProjectionRequest): boolean {
  return (
    left.kind === right.kind &&
    left.sheetId === right.sheetId &&
    left.requestId === right.requestId &&
    left.revision === right.revision &&
    sameRange(getProjectionRequestRange(left), getProjectionRequestRange(right))
  )
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
export function nextProjectionRequestId(sequence: number): ProjectionRequestId | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

// Product state is writable only inside this module. Framework packages receive
// read-only atoms plus typed commands below.
const projectionSnapshotBackingAtom = atom<ProjectionSnapshot>(IDLE_PROJECTION_SNAPSHOT)
const projectionRequestSequenceBackingAtom = atom(0)
const projectionLaneBackingAtom = atom<ProjectionLaneState>(EMPTY_PROJECTION_LANES)

projectionSnapshotBackingAtom.debugLabel = 'spreadsheet.projection.snapshot.state'
projectionRequestSequenceBackingAtom.debugLabel = 'spreadsheet.projection.requestSequence.state'
projectionLaneBackingAtom.debugLabel = 'spreadsheet.projection.lanes.state'

export const projectionSnapshotAtom: Atom<ProjectionSnapshot> = atom((get) =>
  get(projectionSnapshotBackingAtom),
)
projectionSnapshotAtom.debugLabel = 'spreadsheet.projection.snapshot'

export const projectionRequestIdAtom: Atom<number> = atom((get) =>
  get(projectionRequestSequenceBackingAtom),
)
projectionRequestIdAtom.debugLabel = 'spreadsheet.projection.requestId'

export const issueProjectionRequestIdAtom = atom(
  (get) => get(projectionRequestIdAtom),
  (get, set): ProjectionRequestId | null => {
    const next = nextProjectionRequestId(get(projectionRequestSequenceBackingAtom))
    if (next !== null) set(projectionRequestSequenceBackingAtom, next)
    return next
  },
)
issueProjectionRequestIdAtom.debugLabel = 'spreadsheet.projection.issueRequestId'

function createProjectionRequest(
  input: BeginProjectionInput,
  requestId: ProjectionRequestId,
): ProjectionRequest {
  if (input.kind === 'visible-window') {
    return createVisibleProjectionRequest({
      sheetId: input.sheetId,
      window: input.window,
      requestId,
      reason: input.reason,
      revision: input.revision,
      cancelToken: input.cancelToken,
    })
  }
  return createRangeProjectionRequest({
    sheetId: input.sheetId,
    range: input.range,
    requestId,
    reason: input.reason,
    revision: input.revision,
    cancelToken: input.cancelToken,
  })
}

export const beginProjectionAtom = atom(
  null,
  (get, set, input: BeginProjectionInput): ProjectionBeginOutcome => {
    const lanes = get(projectionLaneBackingAtom)
    // Range reads keep strict busy semantics. Visible reads validate and issue
    // an identity before entering the one-slot latest-wins queue below.
    if (input.kind === 'range' && lanes.range !== null) {
      return Object.freeze({ status: 'busy' })
    }

    const requestId = nextProjectionRequestId(get(projectionRequestSequenceBackingAtom))
    if (requestId === null) {
      const error = projectionErrorFrom(
        null,
        'Projection request id capacity reached.',
        'REQUEST_ID_EXHAUSTED',
      )
      if (input.kind === 'visible-window' && lanes.visibleWindow.active === null) {
        const current = get(projectionSnapshotBackingAtom)
        set(
          projectionSnapshotBackingAtom,
          freezeProjectionSnapshot({ ...current, status: 'error', error }),
        )
      }
      return Object.freeze({ status: 'exhausted', error })
    }

    const candidate = createProjectionRequest(input, requestId)
    const validation = validateProjectionRequest(candidate, { maxCells: input.maxCells })
    if (!validation.ok) {
      return Object.freeze({
        status: 'invalid',
        error: freezeProjectionValidationError(validation.error),
      })
    }

    const request = freezeProjectionRequest(candidate)
    set(projectionRequestSequenceBackingAtom, requestId)

    if (request.kind === 'visible-window') {
      const ticket: ProjectionLaneTicket<VisibleProjectionRequest> = Object.freeze({
        request,
        retainResult: input.retainResult === true,
      })
      const current = get(projectionSnapshotBackingAtom)

      if (lanes.visibleWindow.active !== null) {
        // Capacity is exactly one: a newer visible intent replaces the queued
        // one, but never starts another backend transport.
        set(
          projectionLaneBackingAtom,
          Object.freeze({
            ...lanes,
            visibleWindow: Object.freeze({
              active: lanes.visibleWindow.active,
              queued: ticket,
            }),
          }),
        )
        set(
          projectionSnapshotBackingAtom,
          freezeProjectionSnapshot({
            status: 'loading',
            request,
            result: ticket.retainResult ? current.result : undefined,
            error: undefined,
          }),
        )
        return Object.freeze({ status: 'queued', request })
      }

      set(
        projectionLaneBackingAtom,
        Object.freeze({
          ...lanes,
          visibleWindow: Object.freeze({ active: ticket, queued: null }),
        }),
      )
      set(
        projectionSnapshotBackingAtom,
        freezeProjectionSnapshot({
          status: 'loading',
          request,
          result: input.retainResult === true ? current.result : undefined,
          error: undefined,
        }),
      )
      return Object.freeze({ status: 'started', request })
    }

    const ticket: ProjectionLaneTicket<RangeProjectionRequest> = Object.freeze({
      request,
      retainResult: false,
    })
    set(projectionLaneBackingAtom, Object.freeze({ ...lanes, range: ticket }))
    return Object.freeze({ status: 'started', request })
  },
)
beginProjectionAtom.debugLabel = 'spreadsheet.projection.begin'

/** Clears the display projection without releasing an in-flight backend lane. */
export const resetProjectionAtom = atom(null, (_get, set): void => {
  set(projectionSnapshotBackingAtom, IDLE_PROJECTION_SNAPSHOT)
})
resetProjectionAtom.debugLabel = 'spreadsheet.projection.reset'

export const resolveProjectionAtom = atom(
  null,
  (get, set, input: ResolveProjectionInput): ProjectionResolveOutcome => {
    const lanes = get(projectionLaneBackingAtom)
    if (input.request.kind === 'visible-window') {
      const active = lanes.visibleWindow.active
      if (active === null || !sameProjectionRequest(active.request, input.request)) {
        return Object.freeze({ status: 'ignored', reason: 'stale' })
      }

      let result: ProjectionResult | undefined
      let validation: ProjectionValidationResult | undefined
      try {
        result = freezeProjectionResult(input.result)
        validation = validateProjectionResult(result, { request: active.request })
      } catch {
        validation = undefined
      }

      const successor = lanes.visibleWindow.queued
      set(
        projectionLaneBackingAtom,
        Object.freeze({
          ...lanes,
          visibleWindow: Object.freeze({ active: successor, queued: null }),
        }),
      )

      if (validation === undefined || !validation.ok || result === undefined) {
        // A malformed response settles only the exact active transport. If a
        // successor exists it was already made active and the old mismatch
        // must not become the final product error.
        if (successor === null) {
          const current = get(projectionSnapshotBackingAtom)
          if (
            current.status === 'loading' &&
            current.request !== undefined &&
            sameProjectionRequest(current.request, active.request)
          ) {
            const error = projectionErrorFrom(
              null,
              'Projection result did not match the active request.',
              'PROJECTION_RESULT_MISMATCH',
            )
            set(
              projectionSnapshotBackingAtom,
              freezeProjectionSnapshot({
                status: 'error',
                request: active.request,
                result: current.result,
                error,
              }),
            )
          }
        }
        return Object.freeze({
          status: 'ignored',
          reason: 'mismatch',
          ...(successor === null ? {} : { nextRequest: successor.request }),
        })
      }

      if (successor !== null) {
        // The queued begin already published the latest loading request and
        // applied its own retainResult policy. Never publish the older result.
        return Object.freeze({
          status: 'accepted',
          result,
          nextRequest: successor.request,
        })
      }

      const current = get(projectionSnapshotBackingAtom)
      if (
        current.status !== 'loading' ||
        current.request === undefined ||
        !sameProjectionRequest(current.request, active.request)
      ) {
        return Object.freeze({ status: 'ignored', reason: 'stale' })
      }
      set(
        projectionSnapshotBackingAtom,
        freezeProjectionSnapshot({
          status: 'ready',
          request: active.request,
          result,
          error: undefined,
        }),
      )
      return Object.freeze({ status: 'accepted', result })
    }

    const active = lanes.range
    if (active === null || !sameProjectionRequest(active.request, input.request)) {
      return Object.freeze({ status: 'ignored', reason: 'stale' })
    }

    let result: ProjectionResult | undefined
    let validation: ProjectionValidationResult | undefined
    try {
      result = freezeProjectionResult(input.result)
      validation = validateProjectionResult(result, { request: active.request })
    } catch {
      validation = undefined
    }
    set(projectionLaneBackingAtom, Object.freeze({ ...lanes, range: null }))
    if (validation === undefined || !validation.ok || result === undefined) {
      return Object.freeze({ status: 'ignored', reason: 'mismatch' })
    }
    return Object.freeze({ status: 'accepted', result })
  },
)
resolveProjectionAtom.debugLabel = 'spreadsheet.projection.resolve'

export const rejectProjectionAtom = atom(
  null,
  (get, set, input: RejectProjectionInput): ProjectionRejectOutcome => {
    const lanes = get(projectionLaneBackingAtom)
    const error = projectionErrorFrom(input.error, input.fallbackMessage)

    if (input.request.kind === 'visible-window') {
      const active = lanes.visibleWindow.active
      if (active === null || !sameProjectionRequest(active.request, input.request)) {
        return Object.freeze({ status: 'ignored', reason: 'stale' })
      }

      const successor = lanes.visibleWindow.queued
      set(
        projectionLaneBackingAtom,
        Object.freeze({
          ...lanes,
          visibleWindow: Object.freeze({ active: successor, queued: null }),
        }),
      )

      const current = get(projectionSnapshotBackingAtom)
      if (
        successor === null &&
        current.status === 'loading' &&
        current.request !== undefined &&
        sameProjectionRequest(current.request, active.request)
      ) {
        set(
          projectionSnapshotBackingAtom,
          freezeProjectionSnapshot({
            status: 'error',
            request: active.request,
            result: current.result,
            error,
          }),
        )
      }
      return Object.freeze({
        status: 'rejected',
        error,
        ...(successor === null ? {} : { nextRequest: successor.request }),
      })
    }

    const active = lanes.range
    if (active === null || !sameProjectionRequest(active.request, input.request)) {
      return Object.freeze({ status: 'ignored', reason: 'stale' })
    }
    set(projectionLaneBackingAtom, Object.freeze({ ...lanes, range: null }))
    return Object.freeze({ status: 'rejected', error })
  },
)
rejectProjectionAtom.debugLabel = 'spreadsheet.projection.reject'

export const reportProjectionErrorAtom = atom(
  null,
  (get, set, input: ReportProjectionErrorInput): SpreadsheetError => {
    const error = projectionErrorFrom(input.error, input.fallbackMessage, input.code)
    const current = get(projectionSnapshotBackingAtom)
    set(
      projectionSnapshotBackingAtom,
      freezeProjectionSnapshot({
        ...current,
        status: 'error',
        error,
      }),
    )
    return error
  },
)
reportProjectionErrorAtom.debugLabel = 'spreadsheet.projection.reportError'

export function createEmptyRangeProjectionResult(
  request: RangeProjectionRequest,
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision,
    range: copyRange(request.range),
    cells: [],
  }
}
