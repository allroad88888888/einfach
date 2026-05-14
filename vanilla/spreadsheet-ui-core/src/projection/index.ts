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
import type { CellRange, SheetRef } from '../shared'
import type {
  ProjectionLimitOptions,
  ProjectionRequest,
  ProjectionResult,
  ProjectionValidationCode,
  ProjectionValidationResult,
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
  return Number.isInteger(value)
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
  extra: Omit<
    Extract<ProjectionValidationResult, { ok: false }>['error'],
    'code' | 'message'
  > = {},
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

  if (!isInteger(requestId) || requestId < 0) {
    return makeInvalid(
      'INVALID_REQUEST_ID',
      'Projection request ids must be non-negative integers.',
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
    sameRange(getProjectionRequestRange(request), getProjectionResultRange(result))
  )
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
