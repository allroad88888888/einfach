import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  BackendStructuralShift,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRequestId,
  ProjectionRevision,
} from '../backend/types'
import { nextHistoryTransactionId, pushHistoryAtom } from '../history'
import type { HistoryLocalReplayPayload } from '../history'
import {
  applyOutlineStructuralShiftAtom,
  getOutlineGroupsForSheet,
  OUTLINE_REPLAY_KEY,
  outlineAtom,
  type OutlineGroup,
} from '../outline'
import type { CellCoord, CellRange } from '../shared'
import {
  applyViewportFreezeStructuralShiftAtom,
  getViewportFreezeForSheet,
  VIEWPORT_FREEZE_REPLAY_KEY,
  viewportFreezeAtom,
} from '../viewport/freeze'
import {
  applyViewportHiddenStructuralShiftAtom,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  VIEWPORT_HIDDEN_REPLAY_KEY,
  viewportHiddenAtom,
} from '../viewport/hidden'

export type SpreadsheetOperationSource =
  | 'keyboard'
  | 'formula-bar'
  | 'selection'
  | 'sheet-tabs'
  | 'toolbar'
  | 'clipboard'
  | 'diagnostics'
  | 'programmatic'
  | 'test'

export type SpreadsheetOperationKind =
  | 'cell.set-input'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'

export interface SpreadsheetOperationBase {
  kind: SpreadsheetOperationKind
  source?: SpreadsheetOperationSource
  requestId?: number
  revision?: number | string
}

export interface SetCellOperationIntent extends SpreadsheetOperationBase {
  kind: 'cell.set-input'
  sheetId: string
  row: number
  col: number
  input: string
}

export interface InsertRowsOperationIntent extends SpreadsheetOperationBase {
  kind: 'row.insert'
  sheetId: string
  rowIndex: number
  count: number
}

export interface DeleteRowsOperationIntent extends SpreadsheetOperationBase {
  kind: 'row.delete'
  sheetId: string
  rowIndex: number
  count: number
}

export interface InsertColumnsOperationIntent extends SpreadsheetOperationBase {
  kind: 'column.insert'
  sheetId: string
  colIndex: number
  count: number
}

export interface DeleteColumnsOperationIntent extends SpreadsheetOperationBase {
  kind: 'column.delete'
  sheetId: string
  colIndex: number
  count: number
}

export interface AddSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.add'
  sheetName: string
  beforeSheetId: string | null
  afterSheetId: string | null
}

export interface DeleteSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.delete'
  sheetId: string
}

export interface RenameSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.rename'
  sheetId: string
  sheetName: string
}

export interface ReorderSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.reorder'
  sheetId: string
  beforeSheetId: string | null
  afterSheetId: string | null
  targetIndex: number | null
}

export type SpreadsheetOperationIntent =
  | SetCellOperationIntent
  | InsertRowsOperationIntent
  | DeleteRowsOperationIntent
  | InsertColumnsOperationIntent
  | DeleteColumnsOperationIntent
  | AddSheetOperationIntent
  | DeleteSheetOperationIntent
  | RenameSheetOperationIntent
  | ReorderSheetOperationIntent

export interface OperationContext {
  source?: SpreadsheetOperationSource
  requestId?: number
  revision?: number | string
}

export interface SetCellOperationInput extends OperationContext, CellCoord {
  sheetId: string
  input: string
}

export interface RowOperationInput extends OperationContext {
  sheetId: string
  rowIndex: number
  count: number
}

export interface ColumnOperationInput extends OperationContext {
  sheetId: string
  colIndex: number
  count: number
}

export interface AddSheetOperationInput extends OperationContext {
  sheetName: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
}

export interface DeleteSheetOperationInput extends OperationContext {
  sheetId: string
}

export interface RenameSheetOperationInput extends OperationContext {
  sheetId: string
  sheetName: string
}

export interface ReorderSheetOperationInput extends OperationContext {
  sheetId: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
}

export function createSetCellOperation(input: SetCellOperationInput): SetCellOperationIntent {
  return {
    kind: 'cell.set-input',
    sheetId: input.sheetId,
    row: normalizeIndex(input.row),
    col: normalizeIndex(input.col),
    input: input.input,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createInsertRowsOperation(input: RowOperationInput): InsertRowsOperationIntent {
  return createRowOperation('row.insert', input)
}

export function createDeleteRowsOperation(input: RowOperationInput): DeleteRowsOperationIntent {
  return createRowOperation('row.delete', input)
}

export function createInsertColumnsOperation(
  input: ColumnOperationInput,
): InsertColumnsOperationIntent {
  return createColumnOperation('column.insert', input)
}

export function createDeleteColumnsOperation(
  input: ColumnOperationInput,
): DeleteColumnsOperationIntent {
  return createColumnOperation('column.delete', input)
}

export function createAddSheetOperation(input: AddSheetOperationInput): AddSheetOperationIntent {
  const sheetName = normalizeSheetName(input.sheetName)

  if (sheetName === null) {
    throw new RangeError('Sheet name must not be empty.')
  }

  return {
    kind: 'sheet.add',
    sheetName,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createDeleteSheetOperation(
  input: DeleteSheetOperationInput,
): DeleteSheetOperationIntent {
  return {
    kind: 'sheet.delete',
    sheetId: input.sheetId,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createRenameSheetOperation(
  input: RenameSheetOperationInput,
): RenameSheetOperationIntent {
  const sheetName = normalizeSheetName(input.sheetName)

  if (sheetName === null) {
    throw new RangeError('Sheet name must not be empty.')
  }

  return {
    kind: 'sheet.rename',
    sheetId: input.sheetId,
    sheetName,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createReorderSheetOperation(
  input: ReorderSheetOperationInput,
): ReorderSheetOperationIntent {
  if (
    input.beforeSheetId === undefined &&
    input.afterSheetId === undefined &&
    input.targetIndex === undefined
  ) {
    throw new RangeError('A reorder operation needs a placement hint.')
  }

  return {
    kind: 'sheet.reorder',
    sheetId: input.sheetId,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    targetIndex: normalizeOptionalIndex(input.targetIndex ?? null),
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function isSheetMutationOperation(
  operation: SpreadsheetOperationIntent,
): operation is
  | AddSheetOperationIntent
  | DeleteSheetOperationIntent
  | RenameSheetOperationIntent
  | ReorderSheetOperationIntent {
  return (
    operation.kind === 'sheet.add' ||
    operation.kind === 'sheet.delete' ||
    operation.kind === 'sheet.rename' ||
    operation.kind === 'sheet.reorder'
  )
}

export function getOperationSheetIds(operation: SpreadsheetOperationIntent): string[] {
  switch (operation.kind) {
    case 'cell.set-input':
    case 'row.insert':
    case 'row.delete':
    case 'column.insert':
    case 'column.delete':
    case 'sheet.delete':
    case 'sheet.rename':
    case 'sheet.reorder':
      return [operation.sheetId]
    case 'sheet.add':
      return []
    default:
      return []
  }
}

export function getOperationCellRange(operation: SpreadsheetOperationIntent): CellRange | null {
  if (operation.kind !== 'cell.set-input') {
    return null
  }

  return {
    rowStart: operation.row,
    rowEnd: operation.row,
    colStart: operation.col,
    colEnd: operation.col,
  }
}

function createRowOperation<K extends 'row.insert' | 'row.delete'>(
  kind: K,
  input: RowOperationInput,
): K extends 'row.insert' ? InsertRowsOperationIntent : DeleteRowsOperationIntent {
  const count = normalizeCount(input.count)

  return {
    kind,
    sheetId: input.sheetId,
    rowIndex: normalizeIndex(input.rowIndex),
    count,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  } as K extends 'row.insert' ? InsertRowsOperationIntent : DeleteRowsOperationIntent
}

function createColumnOperation<K extends 'column.insert' | 'column.delete'>(
  kind: K,
  input: ColumnOperationInput,
): K extends 'column.insert' ? InsertColumnsOperationIntent : DeleteColumnsOperationIntent {
  const count = normalizeCount(input.count)

  return {
    kind,
    sheetId: input.sheetId,
    colIndex: normalizeIndex(input.colIndex),
    count,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  } as K extends 'column.insert' ? InsertColumnsOperationIntent : DeleteColumnsOperationIntent
}

function normalizeSheetName(name: string): string | null {
  const trimmed = name.trim()

  return trimmed.length === 0 ? null : trimmed
}

function normalizeIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('Indices must be non-negative integers.')
  }

  return index
}

function normalizeCount(count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Counts must be positive integers.')
  }

  return count
}

function normalizeOptionalIndex(index: number | null): number | null {
  if (index === null) {
    return null
  }

  return normalizeIndex(index)
}

export type StructureOperationIntent =
  | InsertRowsOperationIntent
  | DeleteRowsOperationIntent
  | InsertColumnsOperationIntent
  | DeleteColumnsOperationIntent

export type StructureOperationRequest =
  | (InsertRowsRequest & { readonly requestId: ProjectionRequestId })
  | (DeleteRowsRequest & { readonly requestId: ProjectionRequestId })
  | (InsertColumnsRequest & { readonly requestId: ProjectionRequestId })
  | (DeleteColumnsRequest & { readonly requestId: ProjectionRequestId })

/** Framework-neutral effect port. Core never retains the adapter object. */
export interface StructureOperationControllerPort {
  insertRows?: (request: InsertRowsRequest) => Promise<BackendMutationResult>
  deleteRows?: (request: DeleteRowsRequest) => Promise<BackendMutationResult>
  insertColumns?: (request: InsertColumnsRequest) => Promise<BackendMutationResult>
  deleteColumns?: (request: DeleteColumnsRequest) => Promise<BackendMutationResult>
}

export type StructureOperationLifecycleStatus =
  | 'idle'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'completed'
  | 'refresh-failed'
  | 'rejected'
  | 'unsupported'
  | 'outcome-unknown'
  | 'stale'

export interface StructureOperationLifecycleState {
  readonly status: StructureOperationLifecycleStatus
  readonly operation: StructureOperationIntent['kind'] | null
  readonly sheetId: string | null
  readonly transactionId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly acknowledgedRevision: ProjectionRevision | null
  readonly error: string
}

export type StructureOperationCommandOutcome =
  | 'completed'
  | 'refresh-failed'
  | 'rejected'
  | 'unsupported'
  | 'outcome-unknown'
  | 'stale'

export interface RunStructureOperationInput {
  readonly intent: StructureOperationIntent
  readonly source: StructureOperationControllerPort
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Mutation and refresh timeout. Defaults to `DEFAULT_STRUCTURE_OPERATION_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export interface RetryStructureOperationRefreshInput {
  readonly refreshProjection: (sheetId: string) => Promise<void>
  /** Refresh-only retry timeout. Defaults to `DEFAULT_STRUCTURE_OPERATION_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export const DEFAULT_STRUCTURE_OPERATION_TIMEOUT_MS = 15_000
export const STRUCTURE_OPERATION_REJECTED_ERROR =
  'Structure operation intent or refresh effect is invalid.'
export const STRUCTURE_OPERATION_UNSUPPORTED_ERROR =
  'Structure operation is unavailable because the workbook does not provide the required transport.'
export const STRUCTURE_OPERATION_ACKNOWLEDGEMENT_ERROR =
  'Structure operation acknowledgement did not exactly match the active ticket.'
export const STRUCTURE_OPERATION_OUTCOME_UNKNOWN_ERROR =
  'Structure operation result is unknown. Reload or reconcile workbook data before another structural mutation.'
export const STRUCTURE_OPERATION_HISTORY_ERROR =
  'Structure operation was acknowledged, but its history entry could not be recorded.'

interface StructureOperationTicket {
  readonly intent: StructureOperationIntent
  readonly request: StructureOperationRequest
  readonly requestId: ProjectionRequestId
  readonly transactionId: string
}

interface StructureOperationAcknowledgement {
  readonly revision: ProjectionRevision
  readonly affectedRange?: Readonly<CellRange>
  readonly structuralShift?: Readonly<BackendStructuralShift>
}

type StructureOperationExecutor = (
  request: StructureOperationRequest,
) => Promise<BackendMutationResult>

const INITIAL_STRUCTURE_OPERATION_LIFECYCLE: StructureOperationLifecycleState = Object.freeze({
  status: 'idle',
  operation: null,
  sheetId: null,
  transactionId: null,
  requestId: null,
  acknowledgedRevision: null,
  error: '',
})

function structureLifecycleFor(
  status: StructureOperationLifecycleStatus,
  input: {
    readonly operation?: StructureOperationIntent['kind'] | null
    readonly sheetId?: string | null
    readonly transactionId?: string | null
    readonly requestId?: ProjectionRequestId | null
    readonly acknowledgedRevision?: ProjectionRevision | null
    readonly error?: string
  } = {},
): StructureOperationLifecycleState {
  return Object.freeze({
    status,
    operation: input.operation ?? null,
    sheetId: input.sheetId ?? null,
    transactionId: input.transactionId ?? null,
    requestId: input.requestId ?? null,
    acknowledgedRevision: input.acknowledgedRevision ?? null,
    error: input.error ?? '',
  })
}

function structureLifecycleForTicket(
  status: StructureOperationLifecycleStatus,
  ticket: StructureOperationTicket,
  acknowledgedRevision: ProjectionRevision | null = null,
  error = '',
): StructureOperationLifecycleState {
  return structureLifecycleFor(status, {
    operation: ticket.intent.kind,
    sheetId: ticket.intent.sheetId,
    transactionId: ticket.transactionId,
    requestId: ticket.requestId,
    acknowledgedRevision,
    error,
  })
}

function isProjectionRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function sameIndexArrays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, offset) => value === right[offset])
}

function sameOutlineGroupArrays(
  left: readonly OutlineGroup[],
  right: readonly OutlineGroup[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (group, offset) =>
        group.start === right[offset].start &&
        group.end === right[offset].end &&
        group.collapsed === right[offset].collapsed,
    )
  )
}

function snapshotStructureOperationIntent(value: unknown): StructureOperationIntent | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const input = value as Partial<StructureOperationIntent>
    if (typeof input.sheetId !== 'string' || input.sheetId.length === 0) return null
    if (input.revision !== undefined && !isProjectionRevision(input.revision)) return null

    switch (input.kind) {
      case 'row.insert':
      case 'row.delete':
        if (
          typeof input.rowIndex !== 'number' ||
          !Number.isInteger(input.rowIndex) ||
          input.rowIndex < 0 ||
          typeof input.count !== 'number' ||
          !Number.isInteger(input.count) ||
          input.count < 1
        ) {
          return null
        }
        return Object.freeze({
          kind: input.kind,
          sheetId: input.sheetId,
          rowIndex: input.rowIndex,
          count: input.count,
          source: input.source,
          revision: input.revision,
        })
      case 'column.insert':
      case 'column.delete':
        if (
          typeof input.colIndex !== 'number' ||
          !Number.isInteger(input.colIndex) ||
          input.colIndex < 0 ||
          typeof input.count !== 'number' ||
          !Number.isInteger(input.count) ||
          input.count < 1
        ) {
          return null
        }
        return Object.freeze({
          kind: input.kind,
          sheetId: input.sheetId,
          colIndex: input.colIndex,
          count: input.count,
          source: input.source,
          revision: input.revision,
        })
      default:
        return null
    }
  } catch {
    return null
  }
}

export function nextStructureOperationRequestId(sequence: number): ProjectionRequestId | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

function buildStructureOperationRequest(
  intent: StructureOperationIntent,
  requestId: ProjectionRequestId,
): StructureOperationRequest {
  switch (intent.kind) {
    case 'row.insert':
      return Object.freeze({
        kind: 'insert-rows',
        sheetId: intent.sheetId,
        rowIndex: intent.rowIndex,
        count: intent.count,
        requestId,
        revision: intent.revision,
      })
    case 'row.delete':
      return Object.freeze({
        kind: 'delete-rows',
        sheetId: intent.sheetId,
        rowIndex: intent.rowIndex,
        count: intent.count,
        requestId,
        revision: intent.revision,
      })
    case 'column.insert':
      return Object.freeze({
        kind: 'insert-columns',
        sheetId: intent.sheetId,
        colIndex: intent.colIndex,
        count: intent.count,
        requestId,
        revision: intent.revision,
      })
    case 'column.delete':
      return Object.freeze({
        kind: 'delete-columns',
        sheetId: intent.sheetId,
        colIndex: intent.colIndex,
        count: intent.count,
        requestId,
        revision: intent.revision,
      })
  }
}

function structureOperationExecutor(
  source: StructureOperationControllerPort,
  kind: StructureOperationIntent['kind'],
): StructureOperationExecutor | null {
  try {
    const execute =
      kind === 'row.insert'
        ? source.insertRows
        : kind === 'row.delete'
          ? source.deleteRows
          : kind === 'column.insert'
            ? source.insertColumns
            : source.deleteColumns
    return typeof execute === 'function' ? (execute as unknown as StructureOperationExecutor) : null
  } catch {
    return null
  }
}

function acknowledgedStructureOperation(
  value: unknown,
  ticket: StructureOperationTicket,
): StructureOperationAcknowledgement | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const result = value as Partial<BackendMutationResult>
    if (
      result.sheetId !== ticket.intent.sheetId ||
      result.requestId !== ticket.requestId ||
      !isProjectionRevision(result.revision)
    ) {
      return null
    }

    const affectedRange = snapshotAffectedRange(result.affectedRange)
    const structuralShift = snapshotStructuralShift(result.structuralShift)
    return Object.freeze({
      revision: result.revision,
      ...(affectedRange ? { affectedRange } : {}),
      ...(structuralShift ? { structuralShift } : {}),
    })
  } catch {
    return null
  }
}

function snapshotStructuralShift(value: unknown): Readonly<BackendStructuralShift> | null {
  if (typeof value !== 'object' || value === null) return null
  const shift = value as Partial<BackendStructuralShift>
  if (
    (shift.axis !== 'row' && shift.axis !== 'column') ||
    (shift.kind !== 'insert' && shift.kind !== 'delete') ||
    !Number.isSafeInteger(shift.index) ||
    (shift.index as number) < 0 ||
    !Number.isSafeInteger(shift.count) ||
    (shift.count as number) <= 0
  ) {
    return null
  }
  return Object.freeze({
    axis: shift.axis,
    kind: shift.kind,
    index: shift.index as number,
    count: shift.count as number,
  })
}

function snapshotAffectedRange(value: unknown): Readonly<CellRange> | null {
  if (typeof value !== 'object' || value === null) return null
  const range = value as Partial<CellRange>
  if (
    !Number.isInteger(range.rowStart) ||
    !Number.isInteger(range.rowEnd) ||
    !Number.isInteger(range.colStart) ||
    !Number.isInteger(range.colEnd) ||
    (range.rowStart as number) < 0 ||
    (range.colStart as number) < 0 ||
    (range.rowEnd as number) < (range.rowStart as number) ||
    (range.colEnd as number) < (range.colStart as number)
  ) {
    return null
  }
  return Object.freeze({
    rowStart: range.rowStart as number,
    rowEnd: range.rowEnd as number,
    colStart: range.colStart as number,
    colEnd: range.colEnd as number,
  })
}

function structureOperationErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown structure operation transport failure.'
  }
}

function normalizeStructureOperationTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_STRUCTURE_OPERATION_TIMEOUT_MS
}

async function withStructureOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

const structureOperationLifecycleBackingAtom = atom<StructureOperationLifecycleState>(
  INITIAL_STRUCTURE_OPERATION_LIFECYCLE,
)
structureOperationLifecycleBackingAtom.debugLabel =
  'spreadsheet.operations.structure.lifecycleBacking'

const activeStructureOperationTicketAtom = atom<StructureOperationTicket | null>(null)
activeStructureOperationTicketAtom.debugLabel = 'spreadsheet.operations.structure.activeTicket'

const structureOperationTransportReservationAtom = atom<StructureOperationTicket | null>(null)
structureOperationTransportReservationAtom.debugLabel =
  'spreadsheet.operations.structure.transportReservation'

const structureOperationRequestSequenceAtom = atom<ProjectionRequestId>(0)
structureOperationRequestSequenceAtom.debugLabel =
  'spreadsheet.operations.structure.requestSequence'

/** Read-only lifecycle projection. The pending ticket remains Core-private. */
export const structureOperationLifecycleAtom: Atom<StructureOperationLifecycleState> = atom((get) =>
  get(structureOperationLifecycleBackingAtom),
)
structureOperationLifecycleAtom.debugLabel = 'spreadsheet.operations.structure.lifecycle'

export const structureOperationInFlightAtom = atom((get) => {
  const status = get(structureOperationLifecycleBackingAtom).status
  return status === 'pending' || status === 'local-acknowledged' || status === 'refreshing'
})
structureOperationInFlightAtom.debugLabel = 'spreadsheet.operations.structure.inFlight'

export const structureOperationCanRetryRefreshAtom = atom((get) => {
  const ticket = get(activeStructureOperationTicketAtom)
  const lifecycle = get(structureOperationLifecycleBackingAtom)
  return (
    ticket !== null &&
    lifecycle.status === 'refresh-failed' &&
    lifecycle.operation === ticket.intent.kind &&
    lifecycle.sheetId === ticket.intent.sheetId &&
    lifecycle.transactionId === ticket.transactionId &&
    lifecycle.requestId === ticket.requestId &&
    lifecycle.acknowledgedRevision !== null
  )
})
structureOperationCanRetryRefreshAtom.debugLabel =
  'spreadsheet.operations.structure.canRetryRefresh'

function structureOperationTicketIsCurrent(get: Getter, ticket: StructureOperationTicket): boolean {
  const lifecycle = get(structureOperationLifecycleBackingAtom)
  return (
    get(activeStructureOperationTicketAtom) === ticket &&
    lifecycle.operation === ticket.intent.kind &&
    lifecycle.sheetId === ticket.intent.sheetId &&
    lifecycle.transactionId === ticket.transactionId &&
    lifecycle.requestId === ticket.requestId
  )
}

async function runStructureOperation(
  get: Getter,
  set: Setter,
  input: RunStructureOperationInput,
): Promise<StructureOperationCommandOutcome> {
  if (
    get(activeStructureOperationTicketAtom) !== null ||
    get(structureOperationTransportReservationAtom) !== null
  ) {
    return 'stale'
  }

  const intent = snapshotStructureOperationIntent(input?.intent)
  if (intent === null || typeof input?.refreshProjection !== 'function') {
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleFor('rejected', { error: STRUCTURE_OPERATION_REJECTED_ERROR }),
    )
    return 'rejected'
  }

  const source = input.source
  const execute = source ? structureOperationExecutor(source, intent.kind) : null
  if (execute === null) {
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleFor('unsupported', {
        operation: intent.kind,
        sheetId: intent.sheetId,
        error: STRUCTURE_OPERATION_UNSUPPORTED_ERROR,
      }),
    )
    return 'unsupported'
  }

  const requestId = nextStructureOperationRequestId(get(structureOperationRequestSequenceAtom))
  if (requestId === null) {
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleFor('rejected', {
        operation: intent.kind,
        sheetId: intent.sheetId,
        error: 'Structure operation request identity space is exhausted.',
      }),
    )
    return 'rejected'
  }

  const ticket: StructureOperationTicket = Object.freeze({
    intent,
    request: buildStructureOperationRequest(intent, requestId),
    requestId,
    transactionId: nextHistoryTransactionId('structure'),
  })
  set(structureOperationRequestSequenceAtom, requestId)
  set(activeStructureOperationTicketAtom, ticket)
  set(structureOperationLifecycleBackingAtom, structureLifecycleForTicket('pending', ticket))

  // Publish the immutable reservation before launching transport. Same-tick re-entry is inert.
  await Promise.resolve()
  if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
  // Einfach publishes the first async-write flush on a post-await setter.
  set(structureOperationLifecycleBackingAtom, get(structureOperationLifecycleBackingAtom))

  set(structureOperationTransportReservationAtom, ticket)
  const transport = Promise.resolve().then(() => execute.call(source, ticket.request))
  const releaseTransportReservation = () => {
    if (get(structureOperationTransportReservationAtom) === ticket) {
      set(structureOperationTransportReservationAtom, null)
    }
  }
  void transport.then(releaseTransportReservation, releaseTransportReservation)

  let result: unknown
  try {
    result = await withStructureOperationTimeout(
      transport,
      normalizeStructureOperationTimeout(input.timeoutMs),
      'Structure operation mutation',
    )
  } catch (error) {
    if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket(
        'outcome-unknown',
        ticket,
        null,
        `${STRUCTURE_OPERATION_OUTCOME_UNKNOWN_ERROR} Backend detail: ${structureOperationErrorMessage(error)}`,
      ),
    )
    return 'outcome-unknown'
  }

  if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
  const acknowledgement = acknowledgedStructureOperation(result, ticket)
  if (acknowledgement === null) {
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket(
        'outcome-unknown',
        ticket,
        null,
        `${STRUCTURE_OPERATION_OUTCOME_UNKNOWN_ERROR} ${STRUCTURE_OPERATION_ACKNOWLEDGEMENT_ERROR}`,
      ),
    )
    return 'outcome-unknown'
  }

  // W3 structural-shift contract: displaced index space moves UI-core
  // canonical view facts (freeze band, hidden index sets) before anything
  // else reads post-mutation coordinates. The pre/post snapshots become
  // history side payloads: inverting a delete cannot restore hidden index
  // membership, so undo/redo of this backend transaction replays the
  // exact recorded view facts instead (see HistoryEntry.localSidePayloads).
  const sheetId = ticket.intent.sheetId
  const freezeBefore = getViewportFreezeForSheet(get(viewportFreezeAtom), sheetId)
  const hiddenStateBefore = get(viewportHiddenAtom)
  const hiddenRowsBefore = getHiddenRowsForSheet(hiddenStateBefore, sheetId)
  const hiddenColsBefore = getHiddenColumnsForSheet(hiddenStateBefore, sheetId)
  const outlineStateBefore = get(outlineAtom)
  const outlineRowsBefore = getOutlineGroupsForSheet(outlineStateBefore, sheetId, 'row')
  const outlineColsBefore = getOutlineGroupsForSheet(outlineStateBefore, sheetId, 'column')
  if (acknowledgement.structuralShift) {
    set(applyViewportFreezeStructuralShiftAtom, {
      sheetId,
      shift: acknowledgement.structuralShift,
    })
    set(applyViewportHiddenStructuralShiftAtom, {
      sheetId,
      shift: acknowledgement.structuralShift,
    })
    set(applyOutlineStructuralShiftAtom, {
      sheetId,
      shift: acknowledgement.structuralShift,
    })
  }
  const localSidePayloads: HistoryLocalReplayPayload[] = []
  const freezeAfter = getViewportFreezeForSheet(get(viewportFreezeAtom), sheetId)
  if (
    (freezeBefore === null) !== (freezeAfter === null) ||
    (freezeBefore !== null &&
      freezeAfter !== null &&
      (freezeBefore.rows !== freezeAfter.rows || freezeBefore.cols !== freezeAfter.cols))
  ) {
    localSidePayloads.push({
      applyKey: VIEWPORT_FREEZE_REPLAY_KEY,
      sheetId,
      before: freezeBefore,
      after: freezeAfter,
    })
  }
  const hiddenStateAfter = get(viewportHiddenAtom)
  const hiddenRowsAfter = getHiddenRowsForSheet(hiddenStateAfter, sheetId)
  const hiddenColsAfter = getHiddenColumnsForSheet(hiddenStateAfter, sheetId)
  if (
    !sameIndexArrays(hiddenRowsBefore, hiddenRowsAfter) ||
    !sameIndexArrays(hiddenColsBefore, hiddenColsAfter)
  ) {
    localSidePayloads.push({
      applyKey: VIEWPORT_HIDDEN_REPLAY_KEY,
      sheetId,
      before: { rows: [...hiddenRowsBefore], cols: [...hiddenColsBefore] },
      after: { rows: [...hiddenRowsAfter], cols: [...hiddenColsAfter] },
    })
  }
  const outlineStateAfter = get(outlineAtom)
  const outlineRowsAfter = getOutlineGroupsForSheet(outlineStateAfter, sheetId, 'row')
  const outlineColsAfter = getOutlineGroupsForSheet(outlineStateAfter, sheetId, 'column')
  if (
    !sameOutlineGroupArrays(outlineRowsBefore, outlineRowsAfter) ||
    !sameOutlineGroupArrays(outlineColsBefore, outlineColsAfter)
  ) {
    localSidePayloads.push({
      applyKey: OUTLINE_REPLAY_KEY,
      sheetId,
      before: { rows: [...outlineRowsBefore], cols: [...outlineColsBefore] },
      after: { rows: [...outlineRowsAfter], cols: [...outlineColsAfter] },
    })
  }

  const historyRecorded = set(pushHistoryAtom, {
    transactionId: ticket.transactionId,
    kind: ticket.intent.kind,
    sheetId: ticket.intent.sheetId,
    projectionRevision: acknowledgement.revision,
    ...(acknowledgement.affectedRange ? { affectedRange: acknowledgement.affectedRange } : {}),
    ...(localSidePayloads.length > 0 ? { localSidePayloads } : {}),
  })
  if (!historyRecorded) {
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket(
        'outcome-unknown',
        ticket,
        acknowledgement.revision,
        `${STRUCTURE_OPERATION_OUTCOME_UNKNOWN_ERROR} ${STRUCTURE_OPERATION_HISTORY_ERROR}`,
      ),
    )
    return 'outcome-unknown'
  }

  set(
    structureOperationLifecycleBackingAtom,
    structureLifecycleForTicket('local-acknowledged', ticket, acknowledgement.revision),
  )

  await Promise.resolve()
  if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
  set(
    structureOperationLifecycleBackingAtom,
    structureLifecycleForTicket('refreshing', ticket, acknowledgement.revision),
  )
  try {
    await withStructureOperationTimeout(
      Promise.resolve().then(() => input.refreshProjection(ticket.intent.sheetId)),
      normalizeStructureOperationTimeout(input.timeoutMs),
      'Structure operation refresh',
    )
  } catch (error) {
    if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket(
        'refresh-failed',
        ticket,
        acknowledgement.revision,
        `Structure operation was acknowledged, but refresh failed: ${structureOperationErrorMessage(error)}`,
      ),
    )
    return 'refresh-failed'
  }

  if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
  set(activeStructureOperationTicketAtom, null)
  set(
    structureOperationLifecycleBackingAtom,
    structureLifecycleForTicket('completed', ticket, acknowledgement.revision),
  )
  return 'completed'
}

export const runStructureOperationAtom = atom(
  null,
  (get, set, input: RunStructureOperationInput): Promise<StructureOperationCommandOutcome> =>
    runStructureOperation(get, set, input),
)
runStructureOperationAtom.debugLabel = 'spreadsheet.operations.structure.run'

export const retryStructureOperationRefreshAtom = atom(
  null,
  async (
    get,
    set,
    input: RetryStructureOperationRefreshInput,
  ): Promise<StructureOperationCommandOutcome> => {
    if (typeof input?.refreshProjection !== 'function') return 'rejected'
    const ticket = get(activeStructureOperationTicketAtom)
    const lifecycle = get(structureOperationLifecycleBackingAtom)
    if (
      ticket === null ||
      lifecycle.status !== 'refresh-failed' ||
      lifecycle.operation !== ticket.intent.kind ||
      lifecycle.sheetId !== ticket.intent.sheetId ||
      lifecycle.transactionId !== ticket.transactionId ||
      lifecycle.requestId !== ticket.requestId ||
      lifecycle.acknowledgedRevision === null
    ) {
      return 'stale'
    }

    const acknowledgedRevision = lifecycle.acknowledgedRevision
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket('refreshing', ticket, acknowledgedRevision),
    )
    try {
      await withStructureOperationTimeout(
        Promise.resolve().then(() => input.refreshProjection(ticket.intent.sheetId)),
        normalizeStructureOperationTimeout(input.timeoutMs),
        'Structure operation refresh',
      )
    } catch (error) {
      if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
      set(
        structureOperationLifecycleBackingAtom,
        structureLifecycleForTicket(
          'refresh-failed',
          ticket,
          acknowledgedRevision,
          `Structure operation was acknowledged, but refresh failed: ${structureOperationErrorMessage(error)}`,
        ),
      )
      return 'refresh-failed'
    }

    if (!structureOperationTicketIsCurrent(get, ticket)) return 'stale'
    set(activeStructureOperationTicketAtom, null)
    set(
      structureOperationLifecycleBackingAtom,
      structureLifecycleForTicket('completed', ticket, acknowledgedRevision),
    )
    return 'completed'
  },
)
retryStructureOperationRefreshAtom.debugLabel = 'spreadsheet.operations.structure.retryRefresh'

/** Invalidate the current ticket after an explicit host reconcile/reset. */
export const resetStructureOperationLifecycleAtom = atom(null, (get, set): boolean => {
  const ticket = get(activeStructureOperationTicketAtom)
  if (ticket === null) {
    if (get(structureOperationTransportReservationAtom) !== null) return false
    set(structureOperationLifecycleBackingAtom, INITIAL_STRUCTURE_OPERATION_LIFECYCLE)
    return false
  }
  const acknowledgedRevision = get(structureOperationLifecycleBackingAtom).acknowledgedRevision
  set(activeStructureOperationTicketAtom, null)
  set(
    structureOperationLifecycleBackingAtom,
    structureLifecycleForTicket(
      'stale',
      ticket,
      acknowledgedRevision,
      'Structure operation ticket was invalidated by an explicit host reconcile/reset.',
    ),
  )
  return true
})
resetStructureOperationLifecycleAtom.debugLabel = 'spreadsheet.operations.structure.resetLifecycle'

export * from './format'
