import { atom, type Getter, type Setter } from '@einfach/core'
import type {
  AutoFillMutationResult,
  BackendMutationResult,
  DisplayCell,
  FillRangeRequest,
  ImportCellsRequest,
  ProjectionRevision,
  RangeProjectionResult,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
} from '../backend/types'
import { shiftFormulaRefs } from '../clipboard'
import { resolveContentMutationAtom } from '../editing/mutation-gateway'
import { filterSortStateAtom } from '../filter-sort'
import {
  acquireHistoryProducerReservationAtom,
  nextHistoryTransactionId,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  type HistoryProducerReservation,
} from '../history'
import { getFillHandleSourceCoord, getFillHandleWriteRange } from '../pointer'
import {
  primarySelectionRegionAtom,
  selectionAuthorityWitnessAtom,
  selectionRangeAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import type { CellCoord, CellRange, SheetRef } from '../shared'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'
import { detectFillSeries, fillSeriesLocaleAtom } from './detector'
import type { FillSeriesDetectionResult, FillSeriesRequest } from './types'

export const MAX_UI_FILL_FALLBACK_CELLS = 200

export type AutoFillDirection = 'up' | 'down' | 'left' | 'right'

export interface AutoFillIntent extends SheetRef {
  sourceRange: CellRange
  targetRange: CellRange
  direction: AutoFillDirection
  copyOnly?: boolean
}

/**
 * Framework adapter consumed by the shared command. Range reads deliberately
 * stay behind this port so a host can keep its projection request lane and
 * stale-result arbitration; all fill decisions remain in UI core.
 */
export interface AutoFillControllerPort {
  readRangeProjection(
    sheetId: string,
    range: Readonly<CellRange>,
  ): Promise<RangeProjectionResult | null>
  fillSeries?(request: FillSeriesRequest): Promise<AutoFillMutationResult>
  fillRange?(request: FillRangeRequest): Promise<AutoFillMutationResult>
  importCells?(request: ImportCellsRequest): Promise<BackendMutationResult>
  setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult>
  resolveDataEdge?(request: ResolveDataEdgeRequest): Promise<ResolveDataEdgeResult>
}

interface AutoFillCommandBase {
  source: AutoFillControllerPort
  refreshProjection(sheetId: string): Promise<void>
}

export interface RunAutoFillIntentInput extends AutoFillCommandBase {
  entrypoint: 'fill-handle'
  intent: AutoFillIntent
}

export interface RunAutoFillCommandInput extends AutoFillCommandBase, SheetRef {
  entrypoint: 'fill-command'
  selectionRange: CellRange
  direction: AutoFillDirection
}

export interface RunAutoFillDoubleClickInput extends AutoFillCommandBase, SheetRef {
  entrypoint: 'double-click'
  sourceRange: CellRange
  bounds: {
    rowCount: number
    colCount: number
  }
}

export type RunAutoFillInput =
  | RunAutoFillIntentInput
  | RunAutoFillCommandInput
  | RunAutoFillDoubleClickInput

export interface RetryAutoFillRefreshInput {
  refreshProjection(sheetId: string): Promise<void>
}

export type AutoFillMutationPath = 'fill-series' | 'fill-range' | 'import-cells' | 'set-cell-input'

export type AutoFillNoOpReason =
  | 'no-write-range'
  | 'sheet-boundary'
  | 'no-guide'
  | 'guide-ended'
  | 'backend-no-op'

export type AutoFillBlockedReason =
  | 'busy'
  | 'active-filter'
  | 'invalid-target'
  | 'locked'
  | 'selection-mismatch'
  | 'active-sheet-mismatch'
  | 'missing-data-edge-capability'

export type AutoFillUnknownReason =
  | 'transport-rejected'
  | 'invalid-acknowledgement'
  | 'history-rejected'
  | 'committed-stale'

export type AutoFillOutcome =
  | {
      status: 'completed'
      path: AutoFillMutationPath
      affectedRange: Readonly<CellRange>
      historyEntries: number
      committedStale?: true
    }
  | { status: 'no-op'; reason: AutoFillNoOpReason }
  | { status: 'blocked'; reason: AutoFillBlockedReason }
  | { status: 'unsupported'; reason: 'fallback-cell-limit' }
  | { status: 'stale' }
  | { status: 'failed'; phase: 'read' | 'data-edge' }
  | {
      status: 'outcome-unknown'
      path: AutoFillMutationPath
      reason: AutoFillUnknownReason
    }
  | { status: 'refresh-failed'; path: AutoFillMutationPath }

interface AutoFillTicket {
  readonly id: number
  readonly sheetId: string
  readonly sourceRange: Readonly<CellRange>
  readonly authorityRange: Readonly<CellRange>
  readonly requiresUnfiltered: boolean
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
  readonly historyReservation: HistoryProducerReservation
}

interface MutationSuccess {
  readonly path: AutoFillMutationPath
  readonly affectedRange: Readonly<CellRange>
  readonly historyEntries: number
  readonly committedStale?: boolean
}

interface ProjectionWitness {
  readonly requestId: RangeProjectionResult['requestId']
  readonly revision: ProjectionRevision
}

type AutoFillPendingRecovery =
  | {
      readonly kind: 'acknowledged'
      readonly settled: true
      readonly ticket: AutoFillTicket
      readonly success: MutationSuccess
    }
  | {
      readonly kind: 'outcome-unknown'
      readonly settled: true
      readonly ticket: AutoFillTicket
      readonly outcome: Extract<AutoFillOutcome, { status: 'outcome-unknown' }>
    }

type MutationAttempt =
  | { readonly kind: 'not-used'; readonly fillRangeWitness?: ProjectionWitness }
  | { readonly kind: 'success'; readonly value: MutationSuccess }
  | { readonly kind: 'terminal'; readonly outcome: AutoFillOutcome }

const autoFillSequenceAtom = atom(0)
autoFillSequenceAtom.debugLabel = 'spreadsheet.autoFill.internal.sequence'

const activeAutoFillTicketAtom = atom<AutoFillTicket | null>(null)
activeAutoFillTicketAtom.debugLabel = 'spreadsheet.autoFill.internal.activeTicket'

/**
 * Exists only after the original transport promise settled. Recovery therefore
 * owns refresh/reconciliation exclusively and can never resend that mutation.
 */
const pendingAutoFillRecoveryAtom = atom<AutoFillPendingRecovery | null>(null)
pendingAutoFillRecoveryAtom.debugLabel = 'spreadsheet.autoFill.internal.pendingRecovery'

const activeAutoFillRecoveryAtom = atom<AutoFillPendingRecovery | null>(null)
activeAutoFillRecoveryAtom.debugLabel = 'spreadsheet.autoFill.internal.activeRecovery'

function sameRange(left: Readonly<CellRange>, right: Readonly<CellRange>): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function copyRange(range: Readonly<CellRange>): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function normalizeRange(range: Readonly<CellRange>): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

function createFillCommandIntent(
  sheetId: string,
  selectionRange: Readonly<CellRange>,
  direction: AutoFillDirection,
): AutoFillIntent {
  const targetRange = normalizeRange(selectionRange)
  let sourceRange: CellRange
  switch (direction) {
    case 'down':
      sourceRange = {
        rowStart: targetRange.rowStart,
        rowEnd: targetRange.rowStart,
        colStart: targetRange.colStart,
        colEnd: targetRange.colEnd,
      }
      break
    case 'up':
      sourceRange = {
        rowStart: targetRange.rowEnd,
        rowEnd: targetRange.rowEnd,
        colStart: targetRange.colStart,
        colEnd: targetRange.colEnd,
      }
      break
    case 'right':
      sourceRange = {
        rowStart: targetRange.rowStart,
        rowEnd: targetRange.rowEnd,
        colStart: targetRange.colStart,
        colEnd: targetRange.colStart,
      }
      break
    case 'left':
      sourceRange = {
        rowStart: targetRange.rowStart,
        rowEnd: targetRange.rowEnd,
        colStart: targetRange.colEnd,
        colEnd: targetRange.colEnd,
      }
      break
  }
  return {
    sheetId,
    sourceRange,
    targetRange,
    direction,
    copyOnly: true,
  }
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

function rangeCellCount(range: Readonly<CellRange>): number {
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function revisionForHistory(revision: ProjectionRevision | undefined): ProjectionRevision | null {
  if (
    (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) ||
    (typeof revision === 'string' && revision.length > 0)
  ) {
    return revision
  }
  return null
}

type ExactMutationAcknowledgement =
  | {
      readonly kind: 'applied'
      readonly affectedRange: CellRange
      readonly revision: ProjectionRevision
    }
  | { readonly kind: 'invalid' }

function classifyExactMutationAcknowledgement(
  value: unknown,
  sheetId: string,
  expectedAffectedRange: Readonly<CellRange>,
): ExactMutationAcknowledgement {
  try {
    if (typeof value !== 'object' || value === null) {
      return { kind: 'invalid' }
    }
    const result = value as Record<string, unknown>
    const resultSheetId = result.sheetId
    const revision = revisionForHistory(result.revision as ProjectionRevision | undefined)
    const affectedRangeValue = result.affectedRange
    if (
      resultSheetId !== sheetId ||
      revision === null ||
      typeof affectedRangeValue !== 'object' ||
      affectedRangeValue === null
    ) {
      return { kind: 'invalid' }
    }
    const affectedRange = copyRange(affectedRangeValue as Readonly<CellRange>)
    if (!sameRange(affectedRange, expectedAffectedRange)) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'applied',
      affectedRange,
      revision,
    }
  } catch {
    return { kind: 'invalid' }
  }
}

type CompactAutoFillAcknowledgement =
  | {
      readonly kind: 'applied'
      readonly result: Extract<AutoFillMutationResult, { readonly applied: true }>
      readonly revision: ProjectionRevision
    }
  | { readonly kind: 'no-op' }
  | { readonly kind: 'invalid' }

/**
 * Compact fills mirror one backend transaction into one UI history entry.
 * The count and disposition are transaction witnesses, not an undoability
 * shortcut: both `undoable` and `not-undoable` require one positional entry.
 * Missing legacy fields and contradictory combinations are deliberately not
 * guessed because retrying either case could duplicate an already-applied
 * fill.
 */
function classifyCompactAutoFillAcknowledgement(
  value: unknown,
  sheetId: string,
  expectedAffectedRange: Readonly<CellRange>,
): CompactAutoFillAcknowledgement {
  try {
    if (typeof value !== 'object' || value === null) {
      return { kind: 'invalid' }
    }
    const result = value as Record<string, unknown>
    const structuralShift = result.structuralShift
    if (structuralShift !== undefined) {
      return { kind: 'invalid' }
    }
    const resultSheetId = result.sheetId
    const applied = result.applied
    const historyTransactionCount = result.historyTransactionCount
    const historyDisposition = result.historyDisposition
    const affectedRangeValue = result.affectedRange
    const hasRevision = 'revision' in result
    const revision = revisionForHistory(result.revision as ProjectionRevision | undefined)
    if (
      resultSheetId !== sheetId ||
      typeof applied !== 'boolean' ||
      typeof historyTransactionCount !== 'number' ||
      !Number.isSafeInteger(historyTransactionCount) ||
      (historyTransactionCount !== 0 && historyTransactionCount !== 1) ||
      (historyDisposition !== 'none' &&
        historyDisposition !== 'undoable' &&
        historyDisposition !== 'not-undoable')
    ) {
      return { kind: 'invalid' }
    }
    if (
      applied === false &&
      historyTransactionCount === 0 &&
      historyDisposition === 'none' &&
      affectedRangeValue === undefined
    ) {
      return !hasRevision || revision !== null ? { kind: 'no-op' } : { kind: 'invalid' }
    }
    if (
      applied !== true ||
      historyTransactionCount !== 1 ||
      (historyDisposition !== 'undoable' && historyDisposition !== 'not-undoable') ||
      typeof affectedRangeValue !== 'object' ||
      affectedRangeValue === null
    ) {
      return { kind: 'invalid' }
    }
    const affectedRange = copyRange(affectedRangeValue as Readonly<CellRange>)
    if (!sameRange(affectedRange, expectedAffectedRange) || revision === null) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'applied',
      result: {
        sheetId,
        applied: true,
        historyTransactionCount: 1,
        historyDisposition,
        revision,
        affectedRange,
      },
      revision,
    }
  } catch {
    return { kind: 'invalid' }
  }
}

function ticketIsCurrent(get: Getter, ticket: AutoFillTicket): boolean {
  return get(activeAutoFillTicketAtom) === ticket
}

function ticketAuthorityIsCurrent(get: Getter, ticket: AutoFillTicket): boolean {
  return (
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === ticket.workspaceWitness &&
    get(primarySelectionRegionAtom).sheetId === ticket.sheetId &&
    get(workspaceSessionAtom).activeSheetId === ticket.sheetId &&
    sameRange(get(selectionRangeAtom), ticket.authorityRange)
  )
}

function ticketFilterAllowsMutation(get: Getter, ticket: AutoFillTicket): boolean {
  return (
    !ticket.requiresUnfiltered ||
    (get(filterSortStateAtom)[ticket.sheetId]?.rules.length ?? 0) === 0
  )
}

function ticketMutationContextIsCurrent(get: Getter, ticket: AutoFillTicket): boolean {
  return (
    ticketIsCurrent(get, ticket) &&
    ticketAuthorityIsCurrent(get, ticket) &&
    ticketFilterAllowsMutation(get, ticket)
  )
}

function blockedAuthorityReason(
  get: Getter,
  sheetId: string,
  authorityRange: Readonly<CellRange>,
): AutoFillOutcome | null {
  if (
    get(primarySelectionRegionAtom).sheetId !== sheetId ||
    !sameRange(get(selectionRangeAtom), authorityRange)
  ) {
    return { status: 'blocked', reason: 'selection-mismatch' }
  }
  if (get(workspaceSessionAtom).activeSheetId !== sheetId) {
    return { status: 'blocked', reason: 'active-sheet-mismatch' }
  }
  return null
}

function finishTicket(set: Setter, get: Getter, ticket: AutoFillTicket): boolean {
  if (!ticketIsCurrent(get, ticket)) return false
  if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) return false
  set(activeAutoFillTicketAtom, null)
  return true
}

function snapshotMutationSuccess(success: MutationSuccess): MutationSuccess {
  return Object.freeze({
    path: success.path,
    affectedRange: Object.freeze(copyRange(success.affectedRange)),
    historyEntries: success.historyEntries,
    ...(success.committedStale === true ? { committedStale: true } : {}),
  })
}

function acknowledgedRecovery(
  ticket: AutoFillTicket,
  success: MutationSuccess,
): AutoFillPendingRecovery {
  return Object.freeze({
    kind: 'acknowledged',
    settled: true,
    ticket,
    success: snapshotMutationSuccess(success),
  })
}

function unknownRecovery(
  ticket: AutoFillTicket,
  outcome: Extract<AutoFillOutcome, { status: 'outcome-unknown' }>,
): AutoFillPendingRecovery {
  return Object.freeze({
    kind: 'outcome-unknown',
    settled: true,
    ticket,
    outcome: Object.freeze({ ...outcome }),
  })
}

function recoveryIsCurrent(get: Getter, recovery: AutoFillPendingRecovery): boolean {
  return (
    recovery.settled === true &&
    get(activeAutoFillTicketAtom) === recovery.ticket &&
    get(pendingAutoFillRecoveryAtom) === recovery &&
    get(activeAutoFillRecoveryAtom) === recovery
  )
}

/**
 * Reconciliation is deliberately refresh-only. A pending recovery can only be
 * created after the original transport settled, and this function has no
 * mutation port, so neither the old mutation nor a newly supplied intent can
 * be sent while the projection is ambiguous.
 */
async function recoverAutoFillProjection(
  get: Getter,
  set: Setter,
  input: RetryAutoFillRefreshInput,
): Promise<AutoFillOutcome> {
  if (typeof input.refreshProjection !== 'function') {
    return { status: 'blocked', reason: 'busy' }
  }
  const ticket = get(activeAutoFillTicketAtom)
  const recovery = get(pendingAutoFillRecoveryAtom)
  if (
    ticket === null ||
    recovery === null ||
    recovery.settled !== true ||
    recovery.ticket !== ticket ||
    get(activeAutoFillRecoveryAtom) !== null
  ) {
    return { status: 'blocked', reason: 'busy' }
  }

  set(activeAutoFillRecoveryAtom, recovery)
  try {
    // Make the synchronously reserved lane observable to duplicate handlers.
    await Promise.resolve()
    if (!recoveryIsCurrent(get, recovery)) {
      return { status: 'blocked', reason: 'busy' }
    }

    const contextBeforeRefresh =
      recovery.kind === 'acknowledged' &&
      recovery.success.committedStale !== true &&
      ticketMutationContextIsCurrent(get, ticket)
    try {
      await input.refreshProjection(ticket.sheetId)
    } catch {
      if (!recoveryIsCurrent(get, recovery)) {
        return { status: 'blocked', reason: 'busy' }
      }
      return recovery.kind === 'acknowledged'
        ? { status: 'refresh-failed', path: recovery.success.path }
        : recovery.outcome
    }

    if (!recoveryIsCurrent(get, recovery)) {
      return { status: 'blocked', reason: 'busy' }
    }
    const contextAfterRefresh = ticketMutationContextIsCurrent(get, ticket)
    if (recovery.kind === 'outcome-unknown') {
      // Refresh is observational only for ambiguous commits. It may update the
      // projection, but it can never reconcile the mutation or release either
      // ownership gate.
      return recovery.outcome
    }
    const committedStale = !contextBeforeRefresh || !contextAfterRefresh
    if (!finishTicket(set, get, ticket)) {
      const outcome = Object.freeze({
        status: 'outcome-unknown' as const,
        path: recovery.success.path,
        reason: 'history-rejected' as const,
      })
      set(pendingAutoFillRecoveryAtom, unknownRecovery(ticket, outcome))
      return outcome
    }
    set(pendingAutoFillRecoveryAtom, null)
    return {
      status: 'completed',
      path: recovery.success.path,
      affectedRange: copyRange(recovery.success.affectedRange),
      historyEntries: recovery.success.historyEntries,
      ...(committedStale ? { committedStale: true as const } : {}),
    }
  } finally {
    if (get(activeAutoFillRecoveryAtom) === recovery) {
      set(activeAutoFillRecoveryAtom, null)
    }
  }
}

function isExactProjection(
  projection: RangeProjectionResult,
  sheetId: string,
  range: Readonly<CellRange>,
): boolean {
  return (
    projection.kind === 'range' &&
    projection.sheetId === sheetId &&
    sameRange(projection.range, range) &&
    projection.truncated !== true
  )
}

function isBoundedSeriesSource(
  sourceRange: Readonly<CellRange>,
  direction: AutoFillIntent['direction'],
): boolean {
  if (direction === 'down' || direction === 'up') {
    return sourceRange.colStart === sourceRange.colEnd
  }
  return sourceRange.rowStart === sourceRange.rowEnd
}

function orderedSeriesCells(
  projection: RangeProjectionResult,
  sourceRange: Readonly<CellRange>,
  direction: AutoFillIntent['direction'],
): DisplayCell[] | null {
  const expected =
    direction === 'down' || direction === 'up'
      ? sourceRange.rowEnd - sourceRange.rowStart + 1
      : sourceRange.colEnd - sourceRange.colStart + 1
  if (projection.cells.length !== expected) return null

  const cells = new Map<string, DisplayCell>()
  for (const cell of projection.cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      !Number.isSafeInteger(cell.col) ||
      cell.row < sourceRange.rowStart ||
      cell.row > sourceRange.rowEnd ||
      cell.col < sourceRange.colStart ||
      cell.col > sourceRange.colEnd
    ) {
      return null
    }
    const key = cellKey(cell.row, cell.col)
    if (cells.has(key)) return null
    cells.set(key, cell)
  }

  const ordered: DisplayCell[] = []
  if (direction === 'down' || direction === 'up') {
    for (let row = sourceRange.rowStart; row <= sourceRange.rowEnd; row += 1) {
      const cell = cells.get(cellKey(row, sourceRange.colStart))
      if (!cell) return null
      ordered.push(cell)
    }
  } else {
    for (let col = sourceRange.colStart; col <= sourceRange.colEnd; col += 1) {
      const cell = cells.get(cellKey(sourceRange.rowStart, col))
      if (!cell) return null
      ordered.push(cell)
    }
  }
  return ordered
}

function isExecutableSeries(
  detected: FillSeriesDetectionResult,
): detected is FillSeriesDetectionResult & { step: number } {
  if (
    detected.kind === 'copy' ||
    typeof detected.step !== 'number' ||
    !Number.isFinite(detected.step) ||
    detected.step === 0
  ) {
    return false
  }
  if (detected.kind === 'text-number' && detected.textPattern === undefined) return false
  if (
    (detected.kind === 'weekday-name' ||
      detected.kind === 'month-name' ||
      detected.kind === 'custom-list') &&
    detected.list === undefined
  ) {
    return false
  }
  return true
}

function pushCompactHistory(
  set: Setter,
  ticket: AutoFillTicket,
  sheetId: string,
  result: Extract<AutoFillMutationResult, { readonly applied: true }>,
  revision: ProjectionRevision,
): boolean {
  return set(pushReservedHistoryAtom, {
    reservation: ticket.historyReservation,
    entry: {
      transactionId: nextHistoryTransactionId(),
      kind: 'range.fill',
      sheetId,
      projectionRevision: revision,
      affectedRange: copyRange(result.affectedRange),
    },
  })
}

async function trySeries(
  get: Getter,
  set: Setter,
  ticket: AutoFillTicket,
  intent: AutoFillIntent,
  writeRange: Readonly<CellRange>,
  source: AutoFillControllerPort,
  planningWitness?: ProjectionWitness,
): Promise<MutationAttempt> {
  if (
    intent.copyOnly ||
    !source.fillSeries ||
    !isBoundedSeriesSource(intent.sourceRange, intent.direction)
  ) {
    return { kind: 'not-used' }
  }

  let projection: RangeProjectionResult | null
  try {
    projection = await source.readRangeProjection(intent.sheetId, intent.sourceRange)
  } catch {
    if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
      return { kind: 'terminal', outcome: { status: 'stale' } }
    }
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return {
        kind: 'terminal',
        outcome: { status: 'blocked', reason: 'active-filter' },
      }
    }
    return { kind: 'terminal', outcome: { status: 'failed', phase: 'read' } }
  }
  if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
    return { kind: 'terminal', outcome: { status: 'stale' } }
  }
  if (!ticketFilterAllowsMutation(get, ticket)) {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: 'active-filter' },
    }
  }
  if (projection === null || !isExactProjection(projection, intent.sheetId, intent.sourceRange)) {
    return { kind: 'not-used' }
  }
  const projectionRevision = revisionForHistory(projection.revision)
  if (projectionRevision === null) return { kind: 'not-used' }
  if (planningWitness && planningWitness.revision !== projectionRevision) {
    return { kind: 'terminal', outcome: { status: 'stale' } }
  }
  const cells = orderedSeriesCells(projection, intent.sourceRange, intent.direction)
  if (cells === null) return { kind: 'not-used' }

  const detected = detectFillSeries(cells, get(fillSeriesLocaleAtom))
  if (!isExecutableSeries(detected)) {
    return {
      kind: 'not-used',
      fillRangeWitness: {
        requestId: projection.requestId,
        revision: projectionRevision,
      },
    }
  }
  if (!ticketFilterAllowsMutation(get, ticket)) {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: 'active-filter' },
    }
  }

  let result: unknown
  try {
    result = await source.fillSeries({
      kind: 'fill-series',
      sheetId: intent.sheetId,
      sourceRange: copyRange(intent.sourceRange),
      targetRange: copyRange(intent.targetRange),
      direction: intent.direction,
      series: detected.kind,
      step: detected.step,
      ...(detected.textPattern ? { textPattern: { ...detected.textPattern } } : {}),
      ...(detected.list
        ? {
            list: {
              listName: detected.list.listName,
              values: [...detected.list.values],
              locale: detected.list.locale,
            },
          }
        : {}),
      requestId: projection.requestId,
      revision: projectionRevision,
    })
  } catch {
    const committedStale = !ticketMutationContextIsCurrent(get, ticket)
    return {
      kind: 'terminal',
      outcome: {
        status: 'outcome-unknown',
        path: 'fill-series',
        reason: committedStale ? 'committed-stale' : 'transport-rejected',
      },
    }
  }
  const authorityCurrent = ticketMutationContextIsCurrent(get, ticket)
  const acknowledgement = classifyCompactAutoFillAcknowledgement(result, intent.sheetId, writeRange)
  if (acknowledgement.kind === 'invalid') {
    return {
      kind: 'terminal',
      outcome: {
        status: 'outcome-unknown',
        path: 'fill-series',
        reason: 'invalid-acknowledgement',
      },
    }
  }
  if (acknowledgement.kind === 'no-op') {
    return authorityCurrent
      ? { kind: 'terminal', outcome: { status: 'no-op', reason: 'backend-no-op' } }
      : { kind: 'terminal', outcome: { status: 'stale' } }
  }
  if (
    !pushCompactHistory(
      set,
      ticket,
      intent.sheetId,
      acknowledgement.result,
      acknowledgement.revision,
    )
  ) {
    return {
      kind: 'terminal',
      outcome: {
        status: 'outcome-unknown',
        path: 'fill-series',
        reason: 'history-rejected',
      },
    }
  }
  return {
    kind: 'success',
    value: {
      path: 'fill-series',
      affectedRange: copyRange(acknowledgement.result.affectedRange!),
      historyEntries: 1,
      committedStale: !authorityCurrent,
    },
  }
}

function cellInputForFill(
  cell: DisplayCell | undefined,
  source: CellCoord,
  target: CellCoord,
): string {
  if (cell?.formula) {
    return shiftFormulaRefs(cell.formula, target.row - source.row, target.col - source.col)
  }
  return cell?.displayValue ?? ''
}

function affectedRangeForWrites(writes: readonly { row: number; col: number }[]): CellRange | null {
  const first = writes[0]
  if (!first) return null
  const range = {
    rowStart: first.row,
    rowEnd: first.row,
    colStart: first.col,
    colEnd: first.col,
  }
  for (const write of writes.slice(1)) {
    range.rowStart = Math.min(range.rowStart, write.row)
    range.rowEnd = Math.max(range.rowEnd, write.row)
    range.colStart = Math.min(range.colStart, write.col)
    range.colEnd = Math.max(range.colEnd, write.col)
  }
  return range
}

function validatedSparseSourceCells(
  projection: RangeProjectionResult,
  sourceRange: Readonly<CellRange>,
): Map<string, DisplayCell> | null {
  const cells = new Map<string, DisplayCell>()
  for (const cell of projection.cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      !Number.isSafeInteger(cell.col) ||
      cell.row < sourceRange.rowStart ||
      cell.row > sourceRange.rowEnd ||
      cell.col < sourceRange.colStart ||
      cell.col > sourceRange.colEnd
    ) {
      return null
    }
    const key = cellKey(cell.row, cell.col)
    if (cells.has(key)) return null
    cells.set(key, cell)
  }
  return cells
}

async function runFallback(
  get: Getter,
  set: Setter,
  ticket: AutoFillTicket,
  intent: AutoFillIntent,
  writeRange: Readonly<CellRange>,
  source: AutoFillControllerPort,
): Promise<MutationAttempt> {
  if (!source.importCells && rangeCellCount(writeRange) > MAX_UI_FILL_FALLBACK_CELLS) {
    return {
      kind: 'terminal',
      outcome: { status: 'unsupported', reason: 'fallback-cell-limit' },
    }
  }

  let projection: RangeProjectionResult | null
  try {
    projection = await source.readRangeProjection(intent.sheetId, intent.sourceRange)
  } catch {
    if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
      return { kind: 'terminal', outcome: { status: 'stale' } }
    }
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return {
        kind: 'terminal',
        outcome: { status: 'blocked', reason: 'active-filter' },
      }
    }
    return { kind: 'terminal', outcome: { status: 'failed', phase: 'read' } }
  }
  if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
    return { kind: 'terminal', outcome: { status: 'stale' } }
  }
  if (!ticketFilterAllowsMutation(get, ticket)) {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: 'active-filter' },
    }
  }
  if (projection === null || !isExactProjection(projection, intent.sheetId, intent.sourceRange)) {
    return { kind: 'terminal', outcome: { status: 'failed', phase: 'read' } }
  }

  const sourceCells = validatedSparseSourceCells(projection, intent.sourceRange)
  if (sourceCells === null) {
    return { kind: 'terminal', outcome: { status: 'failed', phase: 'read' } }
  }
  const writes: Array<{ row: number; col: number; input: string }> = []
  for (let row = writeRange.rowStart; row <= writeRange.rowEnd; row += 1) {
    for (let col = writeRange.colStart; col <= writeRange.colEnd; col += 1) {
      const resolution = set(resolveContentMutationAtom, {
        kind: 'fill-range',
        sheetId: intent.sheetId,
        cell: { row, col },
      })
      if (resolution.status === 'blocked' || resolution.cell === undefined) {
        return {
          kind: 'terminal',
          outcome: {
            status: 'blocked',
            reason: resolution.status === 'blocked' ? resolution.reason : 'invalid-target',
          },
        }
      }
      const sourceCoord = getFillHandleSourceCoord(intent.sourceRange, { row, col })
      writes.push({
        row: resolution.cell.row,
        col: resolution.cell.col,
        input: cellInputForFill(
          sourceCells.get(cellKey(sourceCoord.row, sourceCoord.col)),
          sourceCoord,
          { row, col },
        ),
      })
    }
  }
  const affectedRange = affectedRangeForWrites(writes)
  if (affectedRange === null) {
    return { kind: 'terminal', outcome: { status: 'no-op', reason: 'no-write-range' } }
  }

  if (source.importCells) {
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return {
        kind: 'terminal',
        outcome: { status: 'blocked', reason: 'active-filter' },
      }
    }
    let result: unknown
    try {
      result = await source.importCells({
        kind: 'import-cells',
        sheetId: intent.sheetId,
        cells: writes,
        range: affectedRange,
      })
    } catch {
      const committedStale = !ticketMutationContextIsCurrent(get, ticket)
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'import-cells',
          reason: committedStale ? 'committed-stale' : 'transport-rejected',
        },
      }
    }
    const authorityCurrent = ticketMutationContextIsCurrent(get, ticket)
    const acknowledgement = classifyExactMutationAcknowledgement(
      result,
      intent.sheetId,
      affectedRange,
    )
    if (acknowledgement.kind === 'invalid') {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'import-cells',
          reason: 'invalid-acknowledgement',
        },
      }
    }
    if (
      !set(pushReservedHistoryAtom, {
        reservation: ticket.historyReservation,
        entry: {
          transactionId: nextHistoryTransactionId(),
          kind: 'range.fill',
          sheetId: intent.sheetId,
          projectionRevision: acknowledgement.revision,
          affectedRange: copyRange(acknowledgement.affectedRange),
        },
      })
    ) {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'import-cells',
          reason: 'history-rejected',
        },
      }
    }
    return {
      kind: 'success',
      value: {
        path: 'import-cells',
        affectedRange: copyRange(acknowledgement.affectedRange),
        historyEntries: 1,
        committedStale: !authorityCurrent,
      },
    }
  }

  let historyEntries = 0
  for (const write of writes) {
    const authorityCurrentBeforeWrite =
      ticketIsCurrent(get, ticket) && ticketAuthorityIsCurrent(get, ticket)
    const filterAllowsWrite = ticketFilterAllowsMutation(get, ticket)
    if (!authorityCurrentBeforeWrite || !filterAllowsWrite) {
      if (historyEntries > 0) {
        const committedRange = affectedRangeForWrites(writes.slice(0, historyEntries))
        return {
          kind: 'success',
          value: {
            path: 'set-cell-input',
            affectedRange: copyRange(committedRange!),
            historyEntries,
            committedStale: true,
          },
        }
      }
      return {
        kind: 'terminal',
        outcome: !authorityCurrentBeforeWrite
          ? { status: 'stale' }
          : {
              status: 'blocked',
              reason: 'active-filter',
            },
      }
    }
    let result: unknown
    try {
      result = await source.setCellInput({
        kind: 'set-cell-input',
        sheetId: intent.sheetId,
        row: write.row,
        col: write.col,
        input: write.input,
      })
    } catch {
      const committedStale = !ticketMutationContextIsCurrent(get, ticket)
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'set-cell-input',
          reason: committedStale ? 'committed-stale' : 'transport-rejected',
        },
      }
    }
    const authorityCurrent = ticketMutationContextIsCurrent(get, ticket)
    const expectedAffectedRange = {
      rowStart: write.row,
      rowEnd: write.row,
      colStart: write.col,
      colEnd: write.col,
    }
    const acknowledgement = classifyExactMutationAcknowledgement(
      result,
      intent.sheetId,
      expectedAffectedRange,
    )
    if (acknowledgement.kind === 'invalid') {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'set-cell-input',
          reason: 'invalid-acknowledgement',
        },
      }
    }
    if (
      !set(pushReservedHistoryAtom, {
        reservation: ticket.historyReservation,
        entry: {
          transactionId: nextHistoryTransactionId(),
          kind: 'cell.set-input',
          sheetId: intent.sheetId,
          projectionRevision: acknowledgement.revision,
          affectedRange: copyRange(acknowledgement.affectedRange),
        },
      })
    ) {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'set-cell-input',
          reason: 'history-rejected',
        },
      }
    }
    historyEntries += 1
    if (!authorityCurrent) {
      const committedRange = affectedRangeForWrites(writes.slice(0, historyEntries))
      return {
        kind: 'success',
        value: {
          path: 'set-cell-input',
          affectedRange: copyRange(committedRange!),
          historyEntries,
          committedStale: true,
        },
      }
    }
  }
  return {
    kind: 'success',
    value: {
      path: 'set-cell-input',
      affectedRange: copyRange(affectedRange),
      historyEntries,
    },
  }
}

async function executeIntent(
  get: Getter,
  set: Setter,
  ticket: AutoFillTicket,
  intent: AutoFillIntent,
  source: AutoFillControllerPort,
  planningWitness?: ProjectionWitness,
): Promise<MutationAttempt> {
  const writeRange = getFillHandleWriteRange(
    intent.sourceRange,
    intent.targetRange,
    intent.direction,
  )
  if (writeRange === null) {
    return { kind: 'terminal', outcome: { status: 'no-op', reason: 'no-write-range' } }
  }
  if (!ticketFilterAllowsMutation(get, ticket)) {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: 'active-filter' },
    }
  }

  const writeResolution = set(resolveContentMutationAtom, {
    kind: 'fill-range',
    sheetId: intent.sheetId,
    range: writeRange,
  })
  if (writeResolution.status === 'blocked') {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: writeResolution.reason },
    }
  }
  const sourceResolution = set(resolveContentMutationAtom, {
    kind: 'fill-range',
    sheetId: intent.sheetId,
    range: intent.sourceRange,
    protectionGate: false,
  })
  if (sourceResolution.status === 'blocked') {
    return {
      kind: 'terminal',
      outcome: { status: 'blocked', reason: sourceResolution.reason },
    }
  }

  const series = await trySeries(get, set, ticket, intent, writeRange, source, planningWitness)
  if (series.kind !== 'not-used') return series
  if (
    planningWitness &&
    series.fillRangeWitness &&
    planningWitness.revision !== series.fillRangeWitness.revision
  ) {
    return { kind: 'terminal', outcome: { status: 'stale' } }
  }
  const fillRangeWitness = planningWitness ?? series.fillRangeWitness

  if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
    return { kind: 'terminal', outcome: { status: 'stale' } }
  }
  if (source.fillRange) {
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return {
        kind: 'terminal',
        outcome: { status: 'blocked', reason: 'active-filter' },
      }
    }
    let result: unknown
    try {
      result = await source.fillRange({
        kind: 'fill-range',
        sheetId: intent.sheetId,
        sourceRange: copyRange(intent.sourceRange),
        targetRange: copyRange(intent.targetRange),
        direction: intent.direction,
        ...(fillRangeWitness
          ? {
              requestId: fillRangeWitness.requestId,
              revision: fillRangeWitness.revision,
            }
          : {}),
      })
    } catch {
      const committedStale = !ticketMutationContextIsCurrent(get, ticket)
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'fill-range',
          reason: committedStale ? 'committed-stale' : 'transport-rejected',
        },
      }
    }
    const authorityCurrent = ticketMutationContextIsCurrent(get, ticket)
    const acknowledgement = classifyCompactAutoFillAcknowledgement(
      result,
      intent.sheetId,
      writeRange,
    )
    if (acknowledgement.kind === 'invalid') {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'fill-range',
          reason: 'invalid-acknowledgement',
        },
      }
    }
    if (acknowledgement.kind === 'no-op') {
      return authorityCurrent
        ? { kind: 'terminal', outcome: { status: 'no-op', reason: 'backend-no-op' } }
        : { kind: 'terminal', outcome: { status: 'stale' } }
    }
    if (
      !pushCompactHistory(
        set,
        ticket,
        intent.sheetId,
        acknowledgement.result,
        acknowledgement.revision,
      )
    ) {
      return {
        kind: 'terminal',
        outcome: {
          status: 'outcome-unknown',
          path: 'fill-range',
          reason: 'history-rejected',
        },
      }
    }
    return {
      kind: 'success',
      value: {
        path: 'fill-range',
        affectedRange: copyRange(acknowledgement.result.affectedRange!),
        historyEntries: 1,
        committedStale: !authorityCurrent,
      },
    }
  }
  return runFallback(get, set, ticket, intent, writeRange, source)
}

function nonBlank(cell: DisplayCell | undefined): boolean {
  return cell !== undefined && (cell.formula !== undefined || cell.displayValue.length > 0)
}

function exactGuideProjection(
  projection: RangeProjectionResult | null,
  sheetId: string,
  range: Readonly<CellRange>,
): projection is RangeProjectionResult {
  if (
    projection === null ||
    !isExactProjection(projection, sheetId, range) ||
    revisionForHistory(projection.revision) === null ||
    projection.cells.length !== 2
  ) {
    return false
  }
  const byCoord = new Map<string, DisplayCell>()
  for (const cell of projection.cells) {
    if (cell.col !== range.colStart || (cell.row !== range.rowStart && cell.row !== range.rowEnd)) {
      return false
    }
    const key = cellKey(cell.row, cell.col)
    if (byCoord.has(key)) return false
    byCoord.set(key, cell)
  }
  return (
    nonBlank(byCoord.get(cellKey(range.rowStart, range.colStart))) &&
    nonBlank(byCoord.get(cellKey(range.rowEnd, range.colStart)))
  )
}

async function resolveDoubleClickIntent(
  get: Getter,
  ticket: AutoFillTicket,
  input: RunAutoFillDoubleClickInput,
): Promise<
  { intent: AutoFillIntent; fillRangeWitness: ProjectionWitness } | { outcome: AutoFillOutcome }
> {
  if ((get(filterSortStateAtom)[input.sheetId]?.rules.length ?? 0) > 0) {
    return { outcome: { status: 'blocked', reason: 'active-filter' } }
  }
  if (input.sourceRange.rowEnd >= input.bounds.rowCount - 1) {
    return { outcome: { status: 'no-op', reason: 'sheet-boundary' } }
  }
  if (!input.source.resolveDataEdge) {
    return {
      outcome: { status: 'blocked', reason: 'missing-data-edge-capability' },
    }
  }

  const candidates: number[] = []
  if (input.sourceRange.colStart > 0) candidates.push(input.sourceRange.colStart - 1)
  if (input.sourceRange.colEnd + 1 < input.bounds.colCount) {
    candidates.push(input.sourceRange.colEnd + 1)
  }

  let guideProjection: RangeProjectionResult | null = null
  let guideCol: number | null = null
  for (const col of candidates) {
    const guideRange = {
      rowStart: input.sourceRange.rowEnd,
      rowEnd: input.sourceRange.rowEnd + 1,
      colStart: col,
      colEnd: col,
    }
    try {
      guideProjection = await input.source.readRangeProjection(input.sheetId, guideRange)
    } catch {
      if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
        return { outcome: { status: 'stale' } }
      }
      if (!ticketFilterAllowsMutation(get, ticket)) {
        return { outcome: { status: 'blocked', reason: 'active-filter' } }
      }
      return { outcome: { status: 'failed', phase: 'read' } }
    }
    if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
      return { outcome: { status: 'stale' } }
    }
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return { outcome: { status: 'blocked', reason: 'active-filter' } }
    }
    if (exactGuideProjection(guideProjection, input.sheetId, guideRange)) {
      guideCol = col
      break
    }
  }
  if (guideCol === null || guideProjection === null) {
    return { outcome: { status: 'no-op', reason: 'no-guide' } }
  }
  const guideRevision = revisionForHistory(guideProjection.revision)
  if (guideRevision === null) {
    return { outcome: { status: 'no-op', reason: 'no-guide' } }
  }
  const guideWitness: ProjectionWitness = {
    requestId: guideProjection.requestId,
    revision: guideRevision,
  }

  let edge: unknown
  try {
    edge = await input.source.resolveDataEdge({
      kind: 'resolve-data-edge',
      sheetId: input.sheetId,
      from: { row: input.sourceRange.rowEnd, col: guideCol },
      direction: 'down',
      bounds: {
        rowCount: input.bounds.rowCount,
        colCount: input.bounds.colCount,
      },
      requestId: guideWitness.requestId,
      revision: guideWitness.revision,
    })
  } catch {
    if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
      return { outcome: { status: 'stale' } }
    }
    if (!ticketFilterAllowsMutation(get, ticket)) {
      return { outcome: { status: 'blocked', reason: 'active-filter' } }
    }
    return { outcome: { status: 'failed', phase: 'data-edge' } }
  }
  if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
    return { outcome: { status: 'stale' } }
  }
  if (!ticketFilterAllowsMutation(get, ticket)) {
    return { outcome: { status: 'blocked', reason: 'active-filter' } }
  }
  if (
    typeof edge !== 'object' ||
    edge === null ||
    (edge as { sheetId?: unknown }).sheetId !== input.sheetId ||
    (edge as { requestId?: unknown }).requestId !== guideWitness.requestId ||
    (edge as { revision?: unknown }).revision !== guideWitness.revision
  ) {
    return { outcome: { status: 'failed', phase: 'data-edge' } }
  }
  const target = (edge as { target?: Partial<CellCoord> }).target
  if (
    !target ||
    !Number.isSafeInteger(target.row) ||
    !Number.isSafeInteger(target.col) ||
    target.col !== guideCol ||
    target.row! < input.sourceRange.rowEnd ||
    target.row! >= input.bounds.rowCount
  ) {
    return { outcome: { status: 'failed', phase: 'data-edge' } }
  }
  if (target.row === input.sourceRange.rowEnd) {
    return { outcome: { status: 'no-op', reason: 'guide-ended' } }
  }
  return {
    intent: {
      sheetId: input.sheetId,
      sourceRange: copyRange(input.sourceRange),
      targetRange: {
        rowStart: input.sourceRange.rowStart,
        rowEnd: target.row!,
        colStart: input.sourceRange.colStart,
        colEnd: input.sourceRange.colEnd,
      },
      direction: 'down',
    },
    fillRangeWitness: guideWitness,
  }
}

async function refreshSuccess(
  get: Getter,
  ticket: AutoFillTicket,
  input: RunAutoFillInput,
  success: MutationSuccess,
): Promise<AutoFillOutcome> {
  const contextBeforeRefresh =
    success.committedStale !== true && ticketMutationContextIsCurrent(get, ticket)
  try {
    await input.refreshProjection(ticket.sheetId)
  } catch {
    return { status: 'refresh-failed', path: success.path }
  }
  const committedStale = !contextBeforeRefresh || !ticketMutationContextIsCurrent(get, ticket)
  return {
    status: 'completed',
    path: success.path,
    affectedRange: copyRange(success.affectedRange),
    historyEntries: success.historyEntries,
    ...(committedStale ? { committedStale: true as const } : {}),
  }
}

export const runAutoFillAtom = atom(
  null,
  async (get, set, input: RunAutoFillInput): Promise<AutoFillOutcome> => {
    const activeTicket = get(activeAutoFillTicketAtom)
    if (activeTicket !== null) {
      const recovery = get(pendingAutoFillRecoveryAtom)
      if (recovery !== null && recovery.settled === true && recovery.ticket === activeTicket) {
        // This invocation is consumed by refresh-only recovery. It never
        // proceeds to execute the newly supplied intent.
        return recoverAutoFillProjection(get, set, input)
      }
      return { status: 'blocked', reason: 'busy' }
    }
    if (get(pendingAutoFillRecoveryAtom) !== null) {
      return { status: 'blocked', reason: 'busy' }
    }

    const fillCommandIntent =
      input.entrypoint === 'fill-command'
        ? createFillCommandIntent(input.sheetId, input.selectionRange, input.direction)
        : null
    const sheetId = input.entrypoint === 'fill-handle' ? input.intent.sheetId : input.sheetId
    const sourceRange =
      input.entrypoint === 'fill-handle'
        ? input.intent.sourceRange
        : input.entrypoint === 'fill-command'
          ? fillCommandIntent!.sourceRange
          : input.sourceRange
    const authorityRange =
      input.entrypoint === 'fill-command' ? fillCommandIntent!.targetRange : sourceRange
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      return { status: 'blocked', reason: 'busy' }
    }

    let ownedTicket: AutoFillTicket | null = null
    let pendingRecovery: AutoFillPendingRecovery | null = null
    try {
      const authorityBlock = blockedAuthorityReason(get, sheetId, authorityRange)
      if (authorityBlock) return authorityBlock

      const previousId = get(autoFillSequenceAtom)
      const nextId = previousId < Number.MAX_SAFE_INTEGER ? previousId + 1 : 1
      const ticket: AutoFillTicket = Object.freeze({
        id: nextId,
        sheetId,
        sourceRange: Object.freeze(copyRange(sourceRange)),
        authorityRange: Object.freeze(copyRange(authorityRange)),
        requiresUnfiltered: input.entrypoint === 'double-click',
        selectionWitness: get(selectionAuthorityWitnessAtom),
        workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
        historyReservation,
      })
      ownedTicket = ticket
      set(autoFillSequenceAtom, nextId)
      set(activeAutoFillTicketAtom, ticket)

      const outcome = await (async (): Promise<AutoFillOutcome> => {
        // Both ownership gates are visible before yielding, so same-tick
        // mutation/history handlers cannot launch competing transports.
        await Promise.resolve()
        if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
          return { status: 'stale' }
        }

        let intent: AutoFillIntent
        let fillRangeWitness: ProjectionWitness | undefined
        if (input.entrypoint === 'double-click') {
          const planned = await resolveDoubleClickIntent(get, ticket, input)
          if ('outcome' in planned) return planned.outcome
          intent = planned.intent
          fillRangeWitness = planned.fillRangeWitness
        } else if (input.entrypoint === 'fill-command') {
          intent = {
            sheetId: fillCommandIntent!.sheetId,
            sourceRange: copyRange(fillCommandIntent!.sourceRange),
            targetRange: copyRange(fillCommandIntent!.targetRange),
            direction: fillCommandIntent!.direction,
            copyOnly: true,
          }
        } else {
          intent = {
            sheetId: input.intent.sheetId,
            sourceRange: copyRange(input.intent.sourceRange),
            targetRange: copyRange(input.intent.targetRange),
            direction: input.intent.direction,
            copyOnly: input.intent.copyOnly,
          }
        }

        if (!ticketIsCurrent(get, ticket) || !ticketAuthorityIsCurrent(get, ticket)) {
          return { status: 'stale' }
        }
        if (!ticketFilterAllowsMutation(get, ticket)) {
          return { status: 'blocked', reason: 'active-filter' }
        }
        const attempted = await executeIntent(
          get,
          set,
          ticket,
          intent,
          input.source,
          fillRangeWitness,
        )
        if (attempted.kind === 'terminal') {
          if (attempted.outcome.status === 'outcome-unknown') {
            pendingRecovery = unknownRecovery(ticket, attempted.outcome)
          }
          return attempted.outcome
        }
        if (attempted.kind === 'not-used') {
          return { status: 'failed', phase: 'read' }
        }
        const refreshed = await refreshSuccess(get, ticket, input, attempted.value)
        if (refreshed.status === 'refresh-failed') {
          pendingRecovery = acknowledgedRecovery(ticket, attempted.value)
        }
        return refreshed
      })()
      if (pendingRecovery !== null) {
        set(pendingAutoFillRecoveryAtom, pendingRecovery)
      }
      return outcome
    } finally {
      if (pendingRecovery === null) {
        if (ownedTicket === null) {
          set(releaseHistoryProducerReservationAtom, historyReservation)
        } else {
          finishTicket(set, get, ownedTicket)
        }
      }
    }
  },
)
runAutoFillAtom.debugLabel = 'spreadsheet.autoFill.run.command'

/** Explicit refresh-only exit for a settled ambiguous or refresh-failed fill. */
export const retryAutoFillRefreshAtom = atom(
  null,
  async (get, set, input: RetryAutoFillRefreshInput): Promise<AutoFillOutcome> =>
    recoverAutoFillProjection(get, set, input),
)
retryAutoFillRefreshAtom.debugLabel = 'spreadsheet.autoFill.retryRefresh'
