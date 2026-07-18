import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import {
  EXCEL_MAX_COLS,
  EXCEL_MAX_ROWS,
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  setSelectionWithAuthorityReceiptAtom,
} from '../selection'
import type {
  SelectionAuthorityReceipt,
  SelectionAuthorityWitness,
  SelectionState,
} from '../selection'
import { scrollToCellAtom } from '../viewport'
import { workspaceActiveSheetAuthorityWitnessAtom, workspaceSessionAtom } from '../workspace'
import type { WorkspaceActiveSheetAuthorityWitness } from '../workspace'
import type { ProjectionRevision } from '../backend/types'
import type { CellCoord, CellRange, SpreadsheetError } from '../shared'
import type {
  FindCursorState,
  FindReplaceCapability,
  FindReplaceCapabilityProjection,
  FindReplaceControllerPort,
  FindMatch,
  FindReplaceFormState,
  FindReplaceLifecycleState,
  FindReplaceOperationAction,
  FindReplaceOperationDiagnosticStatus,
  FindReplaceOperationDiagnostics,
  FindReplaceQuery,
  FindReplaceRefreshRecoveryPhase,
  FindReplaceRefreshRecoveryState,
  FindReplaceTarget,
  ReplaceAllCapInfo,
  ReplaceMatchesNotAppliedResult,
  ReplaceMatchesRequest,
  ReplaceMatchesResponse,
  ReplaceMatchesResult,
  RunFindReplaceMutationInput,
  RunFindReplaceRefreshRecoveryInput,
  RunFindReplaceSearchInput,
  SearchRangeRequest,
  SearchRangeResult,
} from './types'

export * from './types'

export const MAX_FIND_PAGE = 500

const MAX_OPERATION_LEDGER_ENTRIES = 32
const DEFAULT_TRANSPORT_TIMEOUT_MS = 15_000
const MAX_TRANSPORT_TIMEOUT_MS = 2_147_483_647

export const DEFAULT_FIND_REPLACE_FORM_STATE: Readonly<FindReplaceFormState> = Object.freeze({
  activeTab: 'find',
  needle: '',
  replacement: '',
  caseSensitive: false,
  wholeMatch: false,
  regex: false,
  searchFormulas: false,
  scope: 'sheet',
})

const INITIAL_CURSOR: Readonly<FindCursorState> = Object.freeze({
  status: 'idle',
  currentIndex: 0,
  totalCount: 0,
  pageMatches: Object.freeze([]),
})

const INITIAL_REFRESH_RECOVERY: Readonly<FindReplaceRefreshRecoveryState> = Object.freeze({
  status: 'idle',
  operationId: null,
  phase: null,
})

interface SearchTicket {
  readonly sessionId: number
  readonly requestId: number
  readonly request: Readonly<SearchRangeRequest>
  readonly workspaceSheetId: string
  readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
  readonly selection: Readonly<SelectionState>
  readonly selectionRange: Readonly<CellRange>
  readonly selectionWitness: SelectionAuthorityWitness
}

type TicketedFindMatch = Omit<FindMatch, 'target'> & {
  readonly target: FindReplaceTarget | null
}

interface SearchResultTicket {
  readonly search: SearchTicket
  readonly revision: ProjectionRevision | undefined
  readonly matches: readonly TicketedFindMatch[]
  readonly totalCount: number
}

interface OwnedFocus {
  readonly searchRequestId: number
  readonly receipt: SelectionAuthorityReceipt
}

interface PendingMutation {
  readonly operationId: string
  readonly requestId: number
  readonly action: FindReplaceOperationAction
  readonly requestedCount: number
  readonly request: Readonly<ReplaceMatchesRequest>
  readonly resultTicket: SearchResultTicket
  readonly dispatched: boolean
}

interface RefreshRecoveryBase {
  readonly status: 'required' | 'refreshing'
  readonly operationId: string
  readonly phase: FindReplaceRefreshRecoveryPhase
  readonly mutationRequest: Readonly<ReplaceMatchesRequest>
  readonly sourceSearch: SearchTicket
  readonly error: SpreadsheetError | null
}

type RefreshRecoveryInternal = RefreshRecoveryBase &
  (
    | {
        readonly kind: 'acknowledged'
        readonly mutationResult: Readonly<ReplaceMatchesResult>
      }
    | {
        readonly kind: 'outcome-unknown'
        readonly phase: 'search'
        readonly mutationResult: null
      }
  )

interface FindReplaceSessionState {
  readonly open: boolean
  readonly sessionId: number
  readonly activeSearchTicket: SearchTicket | null
  readonly resultTicket: SearchResultTicket | null
  readonly cursorOwnerTicket: SearchTicket | null
  readonly compatibilityCursor: boolean
  readonly pendingMutation: PendingMutation | null
  readonly recovery: RefreshRecoveryInternal | null
  readonly ownedFocus: OwnedFocus | null
  readonly availabilityError: SpreadsheetError | null
  readonly authorityUnavailable: boolean
}

interface FindReplaceOperationAttempt {
  readonly operationId: string
  readonly requestedCount: number
  readonly status: FindReplaceOperationDiagnosticStatus
  readonly reconciled: boolean
  readonly target: FindReplaceReconciliationTarget
}

interface FindReplaceReconciliationTarget {
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly query: Readonly<FindReplaceQuery>
}

interface MutationPreparation {
  readonly ticket: PendingMutation
  readonly replaceMatches: NonNullable<RunFindReplaceMutationInput['replaceMatches']>
  readonly searchRange: NonNullable<RunFindReplaceMutationInput['searchRange']>
  readonly acceptAcknowledgedResult: RunFindReplaceMutationInput['acceptAcknowledgedResult']
  readonly timeoutMs: number
}

interface RefreshPorts {
  readonly searchRange: NonNullable<RunFindReplaceRefreshRecoveryInput['searchRange']>
  readonly acceptAcknowledgedResult: RunFindReplaceRefreshRecoveryInput['acceptAcknowledgedResult']
  readonly timeoutMs: number
}

type TransportOutcome<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

const INITIAL_SESSION: Readonly<FindReplaceSessionState> = Object.freeze({
  open: false,
  sessionId: 0,
  activeSearchTicket: null,
  resultTicket: null,
  cursorOwnerTicket: null,
  compatibilityCursor: false,
  pendingMutation: null,
  recovery: null,
  ownedFocus: null,
  availabilityError: null,
  authorityUnavailable: false,
})

export interface FindReplaceMutationIdentityPlan {
  readonly requestId: number
  readonly operationId: string
}

export function nextFindReplaceSessionId(sessionId: number): number | null {
  return Number.isSafeInteger(sessionId) && sessionId >= 0 && sessionId < Number.MAX_SAFE_INTEGER
    ? sessionId + 1
    : null
}

export function nextFindReplaceSearchRequestId(sequence: number): number | null {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence < Number.MAX_SAFE_INTEGER
    ? sequence + 1
    : null
}

export function planFindReplaceMutationIdentity(
  sequence: number,
): Readonly<FindReplaceMutationIdentityPlan> | null {
  const requestId = nextFindReplaceSearchRequestId(sequence)
  return requestId === null
    ? null
    : Object.freeze({ requestId, operationId: `find-replace-${requestId}` })
}

function copyRange(range: CellRange): CellRange {
  return { ...range }
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function sameCoord(left: CellCoord, right: CellCoord): boolean {
  return left.row === right.row && left.col === right.col
}

function copySelection(selection: SelectionState): SelectionState {
  switch (selection.kind) {
    case 'cell':
    case 'range':
      return { ...selection, anchor: { ...selection.anchor }, focus: { ...selection.focus } }
    case 'row':
    case 'column':
    case 'all':
      return { ...selection }
  }
}

function sameSelection(left: SelectionState, right: SelectionState): boolean {
  if (left.kind !== right.kind || left.sheetId !== right.sheetId) return false
  switch (left.kind) {
    case 'cell':
    case 'range':
      return (
        right.kind === left.kind &&
        sameCoord(left.anchor, right.anchor) &&
        sameCoord(left.focus, right.focus)
      )
    case 'row':
      return (
        right.kind === 'row' &&
        left.rowAnchor === right.rowAnchor &&
        left.rowFocus === right.rowFocus
      )
    case 'column':
      return (
        right.kind === 'column' &&
        left.colAnchor === right.colAnchor &&
        left.colFocus === right.colFocus
      )
    case 'all':
      return right.kind === 'all'
  }
}

function copyQuery(query: FindReplaceQuery): FindReplaceQuery {
  return {
    needle: query.needle,
    ...(query.replacement === undefined ? {} : { replacement: query.replacement }),
    options: { ...query.options },
  }
}

function freezeQuery(query: FindReplaceQuery): Readonly<FindReplaceQuery> {
  return Object.freeze({ ...copyQuery(query), options: Object.freeze({ ...query.options }) })
}

function sameQuery(left: FindReplaceQuery, right: FindReplaceQuery): boolean {
  return (
    left.needle === right.needle &&
    left.replacement === right.replacement &&
    left.options.scope === right.options.scope &&
    Boolean(left.options.caseSensitive) === Boolean(right.options.caseSensitive) &&
    Boolean(left.options.wholeMatch) === Boolean(right.options.wholeMatch) &&
    Boolean(left.options.regex) === Boolean(right.options.regex) &&
    Boolean(left.options.searchFormulas) === Boolean(right.options.searchFormulas)
  )
}

function copyMatch(match: FindMatch | TicketedFindMatch): FindMatch {
  return {
    coord: { ...match.coord },
    sheetId: match.sheetId,
    matchStart: match.matchStart,
    matchEnd: match.matchEnd,
    ...(match.target === undefined || match.target === null ? {} : { target: match.target }),
  }
}

function copyCursor(cursor: FindCursorState): FindCursorState {
  return {
    status: cursor.status,
    currentIndex: cursor.currentIndex,
    totalCount: cursor.totalCount,
    pageMatches: cursor.pageMatches.map(copyMatch),
    ...(cursor.error === undefined ? {} : { error: { ...cursor.error } }),
  }
}

function freezeCursor(cursor: FindCursorState): Readonly<FindCursorState> {
  return Object.freeze({
    ...cursor,
    pageMatches: Object.freeze(
      cursor.pageMatches.map((match) =>
        Object.freeze({ ...copyMatch(match), coord: Object.freeze({ ...match.coord }) }),
      ),
    ),
    ...(cursor.error === undefined ? {} : { error: Object.freeze({ ...cursor.error }) }),
  })
}

function queryFromForm(form: FindReplaceFormState): FindReplaceQuery {
  return {
    needle: form.needle,
    ...(form.replacement === '' ? {} : { replacement: form.replacement }),
    options: {
      caseSensitive: form.caseSensitive,
      wholeMatch: form.wholeMatch,
      regex: form.regex,
      searchFormulas: form.searchFormulas,
      scope: form.scope,
    },
  }
}

function searchQueryFromForm(form: FindReplaceFormState): FindReplaceQuery {
  return {
    needle: form.needle,
    options: {
      caseSensitive: form.caseSensitive,
      wholeMatch: form.wholeMatch,
      regex: form.regex,
      searchFormulas: form.searchFormulas,
      scope: form.scope,
    },
  }
}

function error(
  code: string,
  message: string,
  source: SpreadsheetError['source'],
): SpreadsheetError {
  return { code, message, source }
}

function normalizeError(value: unknown): SpreadsheetError {
  if (value instanceof Error) {
    return error(
      'BACKEND_ERROR',
      value.message || 'Find/replace backend request failed',
      'transport',
    )
  }
  if (typeof value === 'string') return error('BACKEND_ERROR', value, 'transport')
  if (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string') {
    const source = isSpreadsheetErrorSource(value.source) ? value.source : 'transport'
    return error(value.code, value.message, source)
  }
  return error('BACKEND_ERROR', 'Find/replace backend request failed', 'transport')
}

function isSpreadsheetErrorSource(value: unknown): value is SpreadsheetError['source'] {
  return (
    value === 'parse' ||
    value === 'runtime' ||
    value === 'permission' ||
    value === 'transport' ||
    value === 'validation' ||
    value === 'projection' ||
    value === 'unknown'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProjectionRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFindReplaceTarget(value: unknown): value is FindReplaceTarget {
  return value === 'displayValue' || value === 'formula'
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TRANSPORT_TIMEOUT_MS
    ? value
    : DEFAULT_TRANSPORT_TIMEOUT_MS
}

async function waitForTransport<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TransportOutcome<T>> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const transport = promise.then<TransportOutcome<T>, TransportOutcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (transportError) => ({ kind: 'rejected', error: transportError }),
  )
  const timeout = new Promise<TransportOutcome<T>>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  const outcome = await Promise.race([transport, timeout])
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  return outcome
}

function validateRegex(form: FindReplaceFormState): SpreadsheetError | null {
  if (!form.regex || form.needle.length === 0) return null
  try {
    new RegExp(form.needle, form.caseSensitive ? '' : 'i')
    return null
  } catch (regexError) {
    return error(
      'FIND_REPLACE_INVALID_REGEX',
      `Invalid regular expression: ${regexError instanceof Error ? regexError.message : 'invalid'}`,
      'validation',
    )
  }
}

function effectiveSheetId(
  get: Getter,
  scope: FindReplaceQuery['options']['scope'],
): string | SpreadsheetError {
  const workspaceSheetId = get(workspaceSessionAtom).activeSheetId ?? ''
  const selectionSheetId = get(selectionSnapshotAtom).selection.sheetId
  if (workspaceSheetId.length === 0) {
    return error(
      'FIND_REPLACE_SHEET_UNAVAILABLE',
      'Find and replace requires an active workspace sheet',
      'validation',
    )
  }
  if (scope === 'current-selection' && selectionSheetId.length === 0) {
    return error(
      'FIND_REPLACE_SELECTION_UNAVAILABLE',
      'Selection search requires a selection on the active sheet',
      'validation',
    )
  }
  if (selectionSheetId.length > 0 && selectionSheetId !== workspaceSheetId) {
    return error(
      'FIND_REPLACE_SHEET_MISMATCH',
      'The active workspace sheet and selection sheet do not match',
      'validation',
    )
  }
  return workspaceSheetId
}

function liveSelectionMatchesTicket(get: Getter, ticket: SearchTicket): boolean {
  const snapshot = get(selectionSnapshotAtom)
  if (
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    sameSelection(snapshot.selection, ticket.selection) &&
    sameRange(snapshot.range, ticket.selectionRange)
  ) {
    return true
  }
  const ownedFocus = get(findReplaceSessionStateAtom).ownedFocus
  return (
    ownedFocus !== null &&
    ownedFocus.searchRequestId === ticket.requestId &&
    get(selectionAuthorityWitnessAtom) === ownedFocus.receipt.witness &&
    sameSelection(snapshot.selection, ownedFocus.receipt.selection) &&
    sameRange(snapshot.range, ownedFocus.receipt.range)
  )
}

function liveWitnessMatchesTicket(get: Getter, ticket: SearchTicket): boolean {
  const scope = ticket.request.query.options.scope
  const sheetId = effectiveSheetId(get, scope)
  if (typeof sheetId !== 'string' || sheetId !== ticket.request.sheetId) return false
  if (
    get(workspaceSessionAtom).activeSheetId !== ticket.workspaceSheetId ||
    get(workspaceActiveSheetAuthorityWitnessAtom) !== ticket.workspaceWitness
  ) {
    return false
  }
  return scope !== 'current-selection' || liveSelectionMatchesTicket(get, ticket)
}

function ticketInputsCurrent(get: Getter, ticket: SearchTicket): boolean {
  const session = get(findReplaceSessionStateAtom)
  return (
    session.open &&
    session.sessionId === ticket.sessionId &&
    sameQuery(searchQueryFromForm(get(findReplaceFormStateAtom)), ticket.request.query) &&
    liveWitnessMatchesTicket(get, ticket)
  )
}

function isResultTicketCurrent(get: Getter, ticket: SearchResultTicket): boolean {
  const session = get(findReplaceSessionStateAtom)
  return session.resultTicket === ticket && ticketInputsCurrent(get, ticket.search)
}

function cursorVisible(get: Getter, session: FindReplaceSessionState): boolean {
  return (
    session.compatibilityCursor ||
    session.cursorOwnerTicket === null ||
    ticketInputsCurrent(get, session.cursorOwnerTicket)
  )
}

function publicCursor(get: Getter): FindCursorState {
  const session = get(findReplaceSessionStateAtom)
  return cursorVisible(get, session)
    ? copyCursor(get(findReplaceCursorStateAtom))
    : copyCursor(INITIAL_CURSOR)
}

function allocateRequestId(get: Getter, set: Setter): number | null {
  const requestId = nextFindReplaceSearchRequestId(get(findReplaceRequestSequenceAtom))
  if (requestId !== null) set(findReplaceRequestSequenceAtom, requestId)
  return requestId
}

function settleAttempt(
  ledger: readonly FindReplaceOperationAttempt[],
  operationId: string,
  status: FindReplaceOperationDiagnosticStatus,
): FindReplaceOperationAttempt[] {
  return ledger.map((attempt) =>
    attempt.operationId === operationId ? { ...attempt, status } : attempt,
  )
}

function reconciliationTarget(ticket: SearchTicket): FindReplaceReconciliationTarget {
  return {
    sheetId: ticket.request.sheetId,
    range: Object.freeze(copyRange(ticket.request.range)),
    query: freezeQuery(ticket.request.query),
  }
}

function sameReconciliationTarget(
  target: FindReplaceReconciliationTarget,
  ticket: SearchTicket,
): boolean {
  return (
    target.sheetId === ticket.request.sheetId &&
    sameRange(target.range, ticket.request.range) &&
    sameQuery(target.query, ticket.request.query)
  )
}

function reconcileUnknownAttemptsForTarget(
  ledger: readonly FindReplaceOperationAttempt[],
  ticket: SearchTicket,
): FindReplaceOperationAttempt[] {
  return ledger.map((attempt) =>
    attempt.status === 'outcome-unknown' &&
    !attempt.reconciled &&
    sameReconciliationTarget(attempt.target, ticket)
      ? { ...attempt, reconciled: true }
      : attempt,
  )
}

function attemptBlocksMutationForTarget(
  attempt: FindReplaceOperationAttempt,
  ticket: SearchTicket,
): boolean {
  return (
    attempt.status === 'pending' ||
    (attempt.status === 'outcome-unknown' &&
      !attempt.reconciled &&
      sameReconciliationTarget(attempt.target, ticket))
  )
}

function removeAttempt(
  ledger: readonly FindReplaceOperationAttempt[],
  operationId: string,
): FindReplaceOperationAttempt[] {
  return ledger.filter((attempt) => attempt.operationId !== operationId)
}

function reserveAttempt(
  ledger: readonly FindReplaceOperationAttempt[],
  attempt: FindReplaceOperationAttempt,
): FindReplaceOperationAttempt[] | null {
  const compacted = [...ledger]
  while (compacted.length >= MAX_OPERATION_LEDGER_ENTRIES) {
    const evictableIndex = compacted.findIndex(
      (entry) => entry.status === 'acknowledged' || entry.reconciled,
    )
    if (evictableIndex < 0) return null
    compacted.splice(evictableIndex, 1)
  }
  compacted.push(attempt)
  return compacted
}

function cancelPendingMutation(set: Setter, pending: PendingMutation | null): void {
  if (pending === null) return
  set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
    pending.dispatched
      ? settleAttempt(ledger, pending.operationId, 'outcome-unknown')
      : removeAttempt(ledger, pending.operationId),
  )
}

function rotateLifecycle(get: Getter, set: Setter, open: boolean): FindReplaceSessionState {
  const previous = get(findReplaceSessionStateAtom)
  cancelPendingMutation(set, previous.pendingMutation)
  const sessionId = nextFindReplaceSessionId(previous.sessionId)
  if (sessionId === null) {
    const unavailable: FindReplaceSessionState = {
      ...INITIAL_SESSION,
      sessionId: previous.sessionId,
      availabilityError: error(
        'FIND_REPLACE_SESSION_IDENTITY_UNAVAILABLE',
        'Find/replace session identity is exhausted',
        'validation',
      ),
      authorityUnavailable: true,
    }
    set(findReplaceSessionStateAtom, unavailable)
    return unavailable
  }
  const next: FindReplaceSessionState = { ...INITIAL_SESSION, open, sessionId }
  set(findReplaceSessionStateAtom, next)
  return next
}

function resetDisplay(set: Setter): void {
  set(findReplaceQueryStateAtom, null)
  set(findReplaceCursorStateAtom, copyCursor(INITIAL_CURSOR))
  set(findReplaceCommandErrorStateAtom, null)
  set(replaceAllCappedStateAtom, null)
}

function invalidateAuthority(get: Getter, set: Setter): void {
  const previous = get(findReplaceSessionStateAtom)
  cancelPendingMutation(set, previous.pendingMutation)
  const sessionId = nextFindReplaceSessionId(previous.sessionId)
  if (sessionId === null) {
    rotateLifecycle(get, set, false)
    resetDisplay(set)
    return
  }
  set(findReplaceSessionStateAtom, {
    ...INITIAL_SESSION,
    open: previous.open,
    sessionId,
  })
  resetDisplay(set)
}

function synchronizeFindReplaceTarget(get: Getter, set: Setter): boolean {
  const session = get(findReplaceSessionStateAtom)
  const tickets = [
    session.activeSearchTicket,
    session.resultTicket?.search ?? null,
    session.pendingMutation?.resultTicket.search ?? null,
    session.recovery?.sourceSearch ?? null,
  ].filter((ticket): ticket is SearchTicket => ticket !== null)
  if (tickets.every((ticket) => ticketInputsCurrent(get, ticket))) return false
  invalidateAuthority(get, set)
  return true
}

function setCommandError(set: Setter, value: SpreadsheetError): void {
  set(findReplaceCommandErrorStateAtom, { ...value })
}

function failSearchBeforeDispatch(set: Setter, value: SpreadsheetError): void {
  set(findReplaceCursorStateAtom, {
    status: 'error',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
    error: { ...value },
  })
  set(findReplaceCommandErrorStateAtom, { ...value })
  set(findReplaceSessionStateAtom, (session) => ({
    ...session,
    activeSearchTicket: null,
    resultTicket: null,
    cursorOwnerTicket: null,
    compatibilityCursor: true,
    availabilityError: value.source === 'validation' ? { ...value } : null,
  }))
}

function resolveSearchRange(get: Getter, scope: FindReplaceQuery['options']['scope']): CellRange {
  if (scope === 'sheet') {
    return { rowStart: 0, rowEnd: EXCEL_MAX_ROWS - 1, colStart: 0, colEnd: EXCEL_MAX_COLS - 1 }
  }
  const session = get(findReplaceSessionStateAtom)
  if (
    scope === 'current-selection' &&
    session.resultTicket !== null &&
    session.ownedFocus !== null &&
    isResultTicketCurrent(get, session.resultTicket)
  ) {
    return copyRange(session.resultTicket.search.request.range)
  }
  return copyRange(get(selectionSnapshotAtom).range)
}

function createSearchTicket(
  get: Getter,
  requestId: number,
  query: FindReplaceQuery,
  range: CellRange,
  revision?: ProjectionRevision,
): SearchTicket {
  const session = get(findReplaceSessionStateAtom)
  const workspace = get(workspaceSessionAtom)
  const selection = get(selectionSnapshotAtom)
  const request: SearchRangeRequest = {
    kind: 'search-range',
    sheetId: workspace.activeSheetId!,
    range: copyRange(range),
    query: copyQuery(query),
    pageStart: 0,
    pageSize: MAX_FIND_PAGE,
    requestId,
    ...(revision === undefined ? {} : { revision }),
  }
  return {
    sessionId: session.sessionId,
    requestId,
    request: Object.freeze(request),
    workspaceSheetId: workspace.activeSheetId!,
    workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
    selection: Object.freeze(copySelection(selection.selection)),
    selectionRange: Object.freeze(copyRange(selection.range)),
    selectionWitness: get(selectionAuthorityWitnessAtom),
  }
}

function validateSearchResult(
  value: unknown,
  ticket: SearchTicket,
): { readonly result: SearchRangeResult; readonly matches: readonly TicketedFindMatch[] } | null {
  if (
    !isRecord(value) ||
    value.kind !== 'search-range' ||
    value.sheetId !== ticket.request.sheetId ||
    value.requestId !== ticket.requestId ||
    value.pageStart !== ticket.request.pageStart ||
    !Array.isArray(value.matches) ||
    value.matches.length > MAX_FIND_PAGE ||
    !isSafeIndex(value.totalCount) ||
    value.totalCount < value.matches.length ||
    (value.revision !== undefined && !isProjectionRevision(value.revision)) ||
    (ticket.request.revision !== undefined && value.revision !== ticket.request.revision)
  ) {
    return null
  }

  const matches: TicketedFindMatch[] = []
  const intervalsByCell = new Map<string, Array<{ start: number; end: number }>>()
  for (const candidate of value.matches) {
    if (!isRecord(candidate) || !isRecord(candidate.coord)) return null
    const row = candidate.coord.row
    const col = candidate.coord.col
    const matchStart = candidate.matchStart
    const matchEnd = candidate.matchEnd
    if (
      candidate.sheetId !== ticket.request.sheetId ||
      !isSafeIndex(row) ||
      !isSafeIndex(col) ||
      row < ticket.request.range.rowStart ||
      row > ticket.request.range.rowEnd ||
      col < ticket.request.range.colStart ||
      col > ticket.request.range.colEnd ||
      !isSafeIndex(matchStart) ||
      !isSafeIndex(matchEnd) ||
      matchEnd <= matchStart ||
      (candidate.target !== undefined && !isFindReplaceTarget(candidate.target)) ||
      (candidate.target === 'formula' && !ticket.request.query.options.searchFormulas)
    ) {
      return null
    }
    const key = `${row}:${col}`
    const intervals = intervalsByCell.get(key) ?? []
    if (intervals.some((interval) => matchStart < interval.end && matchEnd > interval.start)) {
      return null
    }
    intervals.push({ start: matchStart, end: matchEnd })
    intervalsByCell.set(key, intervals)
    matches.push(
      Object.freeze({
        coord: Object.freeze({ row, col }),
        sheetId: candidate.sheetId,
        matchStart,
        matchEnd,
        target: isFindReplaceTarget(candidate.target) ? candidate.target : null,
      }),
    )
  }

  const result: SearchRangeResult = {
    kind: 'search-range',
    sheetId: value.sheetId,
    requestId: value.requestId,
    pageStart: value.pageStart,
    matches: matches.map(copyMatch),
    totalCount: value.totalCount,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  }
  return { result, matches: Object.freeze(matches) }
}

function acceptSearchResult(
  set: Setter,
  ticket: SearchTicket,
  accepted: ReturnType<typeof validateSearchResult> & {},
  clearReplaceAllCap = true,
): void {
  const resultTicket: SearchResultTicket = {
    search: ticket,
    revision: accepted.result.revision,
    matches: accepted.matches,
    totalCount: accepted.result.totalCount,
  }
  const firstMatch = accepted.matches[0]
  let ownedFocus: OwnedFocus | null = null
  if (firstMatch !== undefined) {
    const receipt = set(setSelectionWithAuthorityReceiptAtom, {
      kind: 'cell',
      sheetId: firstMatch.sheetId,
      anchor: { ...firstMatch.coord },
      focus: { ...firstMatch.coord },
    })
    if (receipt !== null) {
      ownedFocus = { searchRequestId: ticket.requestId, receipt }
      set(scrollToCellAtom, { coord: { ...firstMatch.coord } })
    }
  }
  set(findReplaceCursorStateAtom, {
    status: 'ready',
    currentIndex: 0,
    totalCount: accepted.result.totalCount,
    pageMatches: accepted.matches.map(copyMatch),
  })
  set(findReplaceQueryStateAtom, copyQuery(ticket.request.query))
  set(findReplaceCommandErrorStateAtom, null)
  if (clearReplaceAllCap) set(replaceAllCappedStateAtom, null)
  set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
    reconcileUnknownAttemptsForTarget(ledger, ticket),
  )
  set(findReplaceSessionStateAtom, (session) => ({
    ...session,
    activeSearchTicket: null,
    resultTicket,
    cursorOwnerTicket: ticket,
    compatibilityCursor: false,
    ownedFocus,
    recovery: null,
    availabilityError: null,
  }))
}

const findReplaceQueryStateAtom = atom<FindReplaceQuery | null>(null)
const findReplaceCursorStateAtom = atom<FindCursorState>(copyCursor(INITIAL_CURSOR))
const findReplaceFormStateAtom = atom<FindReplaceFormState>({ ...DEFAULT_FIND_REPLACE_FORM_STATE })
const findReplaceSessionStateAtom = atom<FindReplaceSessionState>({ ...INITIAL_SESSION })
const findReplaceRequestSequenceAtom = atom(0)
const findReplaceOperationAttemptLedgerStateAtom = atom<readonly FindReplaceOperationAttempt[]>([])
const findReplaceCommandErrorStateAtom = atom<SpreadsheetError | null>(null)
const replaceAllCappedStateAtom = atom<ReplaceAllCapInfo | null>(null)
const findReplaceCapabilityStateAtom = atom<FindReplaceCapability>('unknown')

findReplaceSessionStateAtom.debugLabel = 'spreadsheet.findReplace.internal.sessionState'
findReplaceRequestSequenceAtom.debugLabel = 'spreadsheet.findReplace.internal.requestSequence'
findReplaceOperationAttemptLedgerStateAtom.debugLabel =
  'spreadsheet.findReplace.internal.operationAttemptLedger'
findReplaceCapabilityStateAtom.debugLabel = 'spreadsheet.findReplace.internal.capabilityState'

export const findReplaceQueryAtom: Atom<Readonly<FindReplaceQuery> | null> = atom((get) => {
  const query = get(findReplaceQueryStateAtom)
  return query === null ? null : freezeQuery(query)
})
findReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.query'

export const findReplaceCursorAtom: Atom<Readonly<FindCursorState>> = atom((get) =>
  freezeCursor(publicCursor(get)),
)
findReplaceCursorAtom.debugLabel = 'spreadsheet.findReplace.cursor'

export const findReplaceFormAtom: Atom<Readonly<FindReplaceFormState>> = atom((get) =>
  Object.freeze({ ...get(findReplaceFormStateAtom) }),
)
findReplaceFormAtom.debugLabel = 'spreadsheet.findReplace.form'

export const findReplaceSessionAtom: Atom<Readonly<FindReplaceLifecycleState>> = atom((get) => {
  const session = get(findReplaceSessionStateAtom)
  return Object.freeze({
    open: session.open,
    sessionId: session.sessionId,
    searchPending: session.activeSearchTicket !== null,
    mutationPending: session.pendingMutation !== null,
    refreshPending: session.recovery?.status === 'refreshing',
    refreshRecoveryRequired: session.recovery?.status === 'required',
    hasTicketedResult:
      session.resultTicket !== null && isResultTicketCurrent(get, session.resultTicket),
  })
})
findReplaceSessionAtom.debugLabel = 'spreadsheet.findReplace.session'

export const findReplaceCapabilityProjectionAtom: Atom<Readonly<FindReplaceCapabilityProjection>> =
  atom((get) => {
    const capability = get(findReplaceCapabilityStateAtom)
    return Object.freeze({
      capability,
      findEnabled: capability === 'find-only' || capability === 'find-and-replace',
      replaceEnabled: capability === 'find-and-replace',
    })
  })
findReplaceCapabilityProjectionAtom.debugLabel = 'spreadsheet.findReplace.capabilityProjection'

export const findReplaceRefreshRecoveryAtom: Atom<Readonly<FindReplaceRefreshRecoveryState>> = atom(
  (get) => {
    const recovery = get(findReplaceSessionStateAtom).recovery
    if (recovery === null || !ticketInputsCurrent(get, recovery.sourceSearch)) {
      return INITIAL_REFRESH_RECOVERY
    }
    return Object.freeze({
      status: recovery.status,
      operationId: recovery.operationId,
      phase: recovery.phase,
      ...(recovery.error === null ? {} : { error: Object.freeze({ ...recovery.error }) }),
    })
  },
)
findReplaceRefreshRecoveryAtom.debugLabel = 'spreadsheet.findReplace.refreshRecovery'

export const syncFindReplaceTargetAtom = atom(null, (get, set): void => {
  synchronizeFindReplaceTarget(get, set)
})
syncFindReplaceTargetAtom.debugLabel = 'spreadsheet.findReplace.syncTarget'

export const findReplaceOperationDiagnosticsAtom: Atom<Readonly<FindReplaceOperationDiagnostics>> =
  atom((get) => {
    const entries = get(findReplaceOperationAttemptLedgerStateAtom).map((attempt) =>
      Object.freeze({
        operationId: attempt.operationId,
        requestedCount: attempt.requestedCount,
        status: attempt.status,
        reconciled: attempt.reconciled,
      }),
    )
    return Object.freeze({
      count: entries.length,
      pendingCount: entries.filter((entry) => entry.status === 'pending').length,
      acknowledgedCount: entries.filter((entry) => entry.status === 'acknowledged').length,
      outcomeUnknownCount: entries.filter((entry) => entry.status === 'outcome-unknown').length,
      unreconciledOutcomeUnknownCount: entries.filter(
        (entry) => entry.status === 'outcome-unknown' && !entry.reconciled,
      ).length,
      entries: Object.freeze(entries),
    })
  })
findReplaceOperationDiagnosticsAtom.debugLabel = 'spreadsheet.findReplace.operationDiagnostics'

export const replaceAllCappedAtom: Atom<Readonly<ReplaceAllCapInfo> | null> = atom((get) => {
  const value = get(replaceAllCappedStateAtom)
  return value === null ? null : Object.freeze({ ...value })
})
replaceAllCappedAtom.debugLabel = 'spreadsheet.findReplace.replaceAllCapped'

export const findReplaceFormQueryAtom: Atom<Readonly<FindReplaceQuery>> = atom((get) =>
  freezeQuery(queryFromForm(get(findReplaceFormStateAtom))),
)
findReplaceFormQueryAtom.debugLabel = 'spreadsheet.findReplace.formQuery'

export const findReplaceOpenAtom: Atom<boolean> = atom(
  (get) => get(findReplaceSessionStateAtom).open,
)
findReplaceOpenAtom.debugLabel = 'spreadsheet.findReplace.open'

function setFindReplaceOpen(get: Getter, set: Setter, open: boolean): void {
  if (open === get(findReplaceSessionStateAtom).open) return
  rotateLifecycle(get, set, open)
  set(findReplaceFormStateAtom, { ...DEFAULT_FIND_REPLACE_FORM_STATE })
  resetDisplay(set)
}

export const findReplaceAvailabilityErrorAtom: Atom<Readonly<SpreadsheetError> | null> = atom(
  (get) => {
    const value = get(findReplaceSessionStateAtom).availabilityError
    return value === null ? null : Object.freeze({ ...value })
  },
)
findReplaceAvailabilityErrorAtom.debugLabel = 'spreadsheet.findReplace.availabilityError'

export const findReplaceErrorAtom: Atom<Readonly<SpreadsheetError> | null> = atom((get) => {
  const commandError = get(findReplaceCommandErrorStateAtom)
  if (commandError !== null) return Object.freeze({ ...commandError })
  const cursor = publicCursor(get)
  return cursor.error === undefined ? null : Object.freeze({ ...cursor.error })
})
findReplaceErrorAtom.debugLabel = 'spreadsheet.findReplace.error'

export const findReplacePendingAtom: Atom<boolean> = atom((get) => {
  const session = get(findReplaceSessionStateAtom)
  return (
    session.activeSearchTicket !== null ||
    session.pendingMutation !== null ||
    session.recovery?.status === 'refreshing'
  )
})
findReplacePendingAtom.debugLabel = 'spreadsheet.findReplace.pending'

export const findReplaceMutationBlockedAtom: Atom<boolean> = atom((get) => {
  const session = get(findReplaceSessionStateAtom)
  const cursor = publicCursor(get)
  const resultTicket = session.resultTicket
  return (
    !session.open ||
    session.pendingMutation !== null ||
    session.activeSearchTicket !== null ||
    session.recovery !== null ||
    resultTicket === null ||
    get(findReplaceOperationAttemptLedgerStateAtom).some((attempt) =>
      attemptBlocksMutationForTarget(attempt, resultTicket.search),
    ) ||
    !isResultTicketCurrent(get, resultTicket) ||
    cursor.status !== 'ready' ||
    cursor.pageMatches.length === 0
  )
})
findReplaceMutationBlockedAtom.debugLabel = 'spreadsheet.findReplace.mutationBlocked'

export const updateFindReplaceFormAtom = atom(
  null,
  (get, set, patch: Partial<FindReplaceFormState>): void => {
    if (synchronizeFindReplaceTarget(get, set)) return
    const previous = get(findReplaceFormStateAtom)
    const next = { ...previous, ...patch }
    const searchChanged =
      next.needle !== previous.needle ||
      next.caseSensitive !== previous.caseSensitive ||
      next.wholeMatch !== previous.wholeMatch ||
      next.regex !== previous.regex ||
      next.searchFormulas !== previous.searchFormulas ||
      next.scope !== previous.scope
    set(findReplaceFormStateAtom, next)
    set(findReplaceCommandErrorStateAtom, null)
    if (searchChanged) invalidateAuthority(get, set)
  },
)
updateFindReplaceFormAtom.debugLabel = 'spreadsheet.findReplace.updateForm'

export const captureFindReplaceCapabilityAtom = atom(
  null,
  (_get, set, source: FindReplaceControllerPort): void => {
    let hasSearch = false
    let hasReplace = false
    try {
      hasSearch = typeof source?.searchRange === 'function'
      hasReplace = typeof source?.replaceMatches === 'function'
    } catch {
      hasSearch = false
      hasReplace = false
    }

    set(
      findReplaceCapabilityStateAtom,
      !hasSearch ? 'unsupported' : hasReplace ? 'find-and-replace' : 'find-only',
    )
  },
)
captureFindReplaceCapabilityAtom.debugLabel = 'spreadsheet.findReplace.captureCapability'

export const openFindReplaceAtom = atom(null, (get, set): void => {
  setFindReplaceOpen(get, set, true)
})
openFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.openCommand'

export const openFindReplaceFromEntrypointAtom = atom(null, (get, set): boolean => {
  if (!get(findReplaceCapabilityProjectionAtom).findEnabled) return false
  setFindReplaceOpen(get, set, true)
  return true
})
openFindReplaceFromEntrypointAtom.debugLabel = 'spreadsheet.findReplace.openFromEntrypoint'

export const closeFindReplaceAtom = atom(null, (get, set): void => {
  setFindReplaceOpen(get, set, false)
})
closeFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.closeCommand'

export const commitFindReplaceQueryAtom = atom(null, (get, set, query: FindReplaceQuery): void => {
  const form = get(findReplaceFormStateAtom)
  set(updateFindReplaceFormAtom, {
    needle: query.needle,
    replacement: query.replacement ?? form.replacement,
    caseSensitive: Boolean(query.options.caseSensitive),
    wholeMatch: Boolean(query.options.wholeMatch),
    regex: Boolean(query.options.regex),
    searchFormulas: Boolean(query.options.searchFormulas),
    scope: query.options.scope,
  })
  set(findReplaceQueryStateAtom, copyQuery(query))
})
commitFindReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.commitQuery'

export const markReplaceAllCappedAtom = atom(null, (_get, set, info: ReplaceAllCapInfo): void => {
  set(replaceAllCappedStateAtom, { ...info })
})
markReplaceAllCappedAtom.debugLabel = 'spreadsheet.findReplace.markReplaceAllCapped'

export const setFindMatchesAtom = atom(null, (get, set, result: SearchRangeResult): void => {
  invalidateAuthority(get, set)
  const matches = Array.isArray(result.matches)
    ? result.matches.slice(0, MAX_FIND_PAGE).map(copyMatch)
    : []
  set(findReplaceCursorStateAtom, {
    status: 'ready',
    currentIndex: 0,
    totalCount:
      Number.isSafeInteger(result.totalCount) && result.totalCount >= matches.length
        ? result.totalCount
        : matches.length,
    pageMatches: matches,
  })
  set(findReplaceSessionStateAtom, (session) => ({
    ...session,
    compatibilityCursor: true,
  }))
})
setFindMatchesAtom.debugLabel = 'spreadsheet.findReplace.setMatches'

export const setFindReplaceErrorAtom = atom(null, (_get, set, value: unknown): void => {
  const normalized = normalizeError(value)
  set(findReplaceCommandErrorStateAtom, normalized)
  set(findReplaceCursorStateAtom, {
    status: 'error',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
    error: normalized,
  })
  set(findReplaceSessionStateAtom, (session) => ({ ...session, compatibilityCursor: true }))
})
setFindReplaceErrorAtom.debugLabel = 'spreadsheet.findReplace.setError'

export const advanceFindCursorAtom = atom(null, (get, set, direction: 1 | -1): void => {
  if (direction !== 1 && direction !== -1) return
  const cursor = publicCursor(get)
  if (cursor.pageMatches.length === 0) return
  const currentIndex =
    (cursor.currentIndex + direction + cursor.pageMatches.length) % cursor.pageMatches.length
  set(findReplaceCursorStateAtom, { ...cursor, currentIndex })
})
advanceFindCursorAtom.debugLabel = 'spreadsheet.findReplace.advanceCursor'

async function executeSearch(
  get: Getter,
  set: Setter,
  ticket: SearchTicket,
  searchRange: NonNullable<RunFindReplaceSearchInput['searchRange']>,
  timeoutMs: number,
): Promise<void> {
  await Promise.resolve()
  const sessionBeforeDispatch = get(findReplaceSessionStateAtom)
  if (sessionBeforeDispatch.activeSearchTicket !== ticket || !ticketInputsCurrent(get, ticket)) {
    return
  }

  let promise: Promise<SearchRangeResult>
  try {
    promise = Promise.resolve(searchRange(ticket.request as SearchRangeRequest))
  } catch (transportError) {
    const normalized = normalizeError(transportError)
    if (get(findReplaceSessionStateAtom).activeSearchTicket === ticket) {
      failSearchBeforeDispatch(set, normalized)
    }
    return
  }
  const outcome = await waitForTransport(promise, timeoutMs)
  if (
    get(findReplaceSessionStateAtom).activeSearchTicket !== ticket ||
    !ticketInputsCurrent(get, ticket)
  ) {
    return
  }
  if (outcome.kind === 'timeout') {
    failSearchBeforeDispatch(
      set,
      error('FIND_REPLACE_TIMEOUT', 'Find/replace search timed out', 'transport'),
    )
    return
  }
  if (outcome.kind === 'rejected') {
    failSearchBeforeDispatch(set, normalizeError(outcome.error))
    return
  }
  const accepted = validateSearchResult(outcome.value, ticket)
  if (accepted === null) {
    failSearchBeforeDispatch(
      set,
      error('FIND_REPLACE_PROTOCOL_ERROR', 'Search response failed exact correlation', 'transport'),
    )
    return
  }
  acceptSearchResult(set, ticket, accepted)
}

export const runFindReplaceSearchAtom = atom(
  null,
  (get, set, input: RunFindReplaceSearchInput): Promise<void> | void => {
    if (synchronizeFindReplaceTarget(get, set)) return
    const session = get(findReplaceSessionStateAtom)
    if (
      !session.open ||
      session.authorityUnavailable ||
      session.activeSearchTicket !== null ||
      session.pendingMutation !== null ||
      session.recovery !== null
    ) {
      return
    }
    const form = get(findReplaceFormStateAtom)
    if (form.needle.length === 0) {
      failSearchBeforeDispatch(
        set,
        error('FIND_REPLACE_EMPTY_NEEDLE', 'Enter text to find', 'validation'),
      )
      return
    }
    const regexError = validateRegex(form)
    if (regexError !== null) {
      failSearchBeforeDispatch(set, regexError)
      return
    }
    if (form.scope === 'workbook') {
      failSearchBeforeDispatch(
        set,
        error(
          'FIND_REPLACE_WORKBOOK_UNAVAILABLE',
          'Workbook search is not available in this backend contract',
          'validation',
        ),
      )
      return
    }
    const sheetId = effectiveSheetId(get, form.scope)
    if (typeof sheetId !== 'string') {
      failSearchBeforeDispatch(set, sheetId)
      return
    }
    if (typeof input?.searchRange !== 'function') {
      failSearchBeforeDispatch(
        set,
        error(
          'FIND_REPLACE_SEARCH_UNAVAILABLE',
          'The search backend port is unavailable',
          'validation',
        ),
      )
      return
    }
    if (input.revision !== undefined && !isProjectionRevision(input.revision)) {
      failSearchBeforeDispatch(
        set,
        error('FIND_REPLACE_REVISION_MISMATCH', 'Search revision is invalid', 'validation'),
      )
      return
    }
    const requestId = allocateRequestId(get, set)
    if (requestId === null) {
      failSearchBeforeDispatch(
        set,
        error(
          'FIND_REPLACE_REQUEST_IDENTITY_UNAVAILABLE',
          'Find/replace request identity is exhausted',
          'validation',
        ),
      )
      return
    }
    const query = searchQueryFromForm(form)
    const ticket = createSearchTicket(
      get,
      requestId,
      query,
      resolveSearchRange(get, form.scope),
      input.revision,
    )
    set(findReplaceQueryStateAtom, copyQuery(query))
    set(findReplaceCursorStateAtom, {
      status: 'searching',
      currentIndex: 0,
      totalCount: 0,
      pageMatches: [],
    })
    set(findReplaceCommandErrorStateAtom, null)
    set(findReplaceSessionStateAtom, {
      ...session,
      activeSearchTicket: ticket,
      resultTicket: null,
      cursorOwnerTicket: ticket,
      compatibilityCursor: false,
      availabilityError: null,
    })
    return executeSearch(get, set, ticket, input.searchRange, normalizeTimeoutMs(input.timeoutMs))
  },
)
runFindReplaceSearchAtom.debugLabel = 'spreadsheet.findReplace.runSearch'

export const stepFindReplaceAtom = atom(
  null,
  (
    get,
    set,
    input: RunFindReplaceSearchInput & { readonly direction: 1 | -1 },
  ): Promise<void> | void => {
    if (synchronizeFindReplaceTarget(get, set)) return
    if (get(findReplacePendingAtom)) return
    const cursor = publicCursor(get)
    if (cursor.pageMatches.length === 0) {
      return set(runFindReplaceSearchAtom, input)
    }
    if (input.direction !== 1 && input.direction !== -1) return
    const currentIndex =
      (cursor.currentIndex + input.direction + cursor.pageMatches.length) %
      cursor.pageMatches.length
    const match = cursor.pageMatches[currentIndex]
    const resultTicket = get(findReplaceSessionStateAtom).resultTicket
    const resultTicketWasCurrent = resultTicket !== null && isResultTicketCurrent(get, resultTicket)
    const receipt = set(setSelectionWithAuthorityReceiptAtom, {
      kind: 'cell',
      sheetId: match.sheetId,
      anchor: { ...match.coord },
      focus: { ...match.coord },
    })
    if (receipt === null) {
      setCommandError(
        set,
        error(
          'FIND_REPLACE_FOCUS_STALE',
          'The match could not become the active selection',
          'validation',
        ),
      )
      return
    }
    set(scrollToCellAtom, { coord: { ...match.coord } })
    set(findReplaceCursorStateAtom, { ...cursor, currentIndex })
    if (resultTicket !== null && resultTicketWasCurrent) {
      set(findReplaceSessionStateAtom, (session) => ({
        ...session,
        ownedFocus: { searchRequestId: resultTicket.search.requestId, receipt },
      }))
    }
  },
)
stepFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.step'

function validateNotAppliedResult(
  value: unknown,
  requestId: number,
): ReplaceMatchesNotAppliedResult | null {
  if (
    !isRecord(value) ||
    value.kind !== 'replace-matches-not-applied' ||
    value.applied !== false ||
    value.requestId !== requestId ||
    !isRecord(value.error) ||
    typeof value.error.code !== 'string' ||
    typeof value.error.message !== 'string'
  ) {
    return null
  }
  return {
    kind: 'replace-matches-not-applied',
    applied: false,
    requestId,
    error: normalizeError(value.error),
  }
}

function validateAcknowledgement(
  value: unknown,
  ticket: PendingMutation,
): ReplaceMatchesResult | null {
  if (
    !isRecord(value) ||
    value.requestId !== ticket.requestId ||
    !isSafeIndex(value.replacedCount) ||
    value.replacedCount > ticket.requestedCount ||
    !isProjectionRevision(value.revision)
  ) {
    return null
  }
  return {
    requestId: ticket.requestId,
    replacedCount: value.replacedCount,
    revision: value.revision,
  }
}

function currentMutationMatches(get: Getter, ticket: PendingMutation): boolean {
  const session = get(findReplaceSessionStateAtom)
  return (
    session.pendingMutation?.operationId === ticket.operationId &&
    ticketInputsCurrent(get, ticket.resultTicket.search)
  )
}

function prepareMutation(
  get: Getter,
  set: Setter,
  input: RunFindReplaceMutationInput,
): MutationPreparation | null {
  if (synchronizeFindReplaceTarget(get, set)) return null
  const session = get(findReplaceSessionStateAtom)
  if (!session.open || session.pendingMutation !== null || session.activeSearchTicket !== null) {
    return null
  }
  if (session.recovery !== null) {
    setCommandError(
      set,
      session.recovery.kind === 'outcome-unknown'
        ? error(
            'FIND_REPLACE_OUTCOME_UNKNOWN',
            'Run a read-only reconciliation Find before replacing again',
            'transport',
          )
        : error(
            'FIND_REPLACE_REFRESH_RECOVERY_REQUIRED',
            'Finish the read-only refresh recovery before replacing again',
            'projection',
          ),
    )
    return null
  }
  if (input.action !== 'replace-current' && input.action !== 'replace-all') return null
  if (typeof input.replaceMatches !== 'function') {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_REPLACE_UNAVAILABLE',
        'The replace backend port is unavailable',
        'validation',
      ),
    )
    return null
  }
  if (typeof input.searchRange !== 'function') {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_SEARCH_UNAVAILABLE',
        'Replace requires the refresh search port',
        'validation',
      ),
    )
    return null
  }
  const resultTicket = session.resultTicket
  const cursor = publicCursor(get)
  if (resultTicket === null || !isResultTicketCurrent(get, resultTicket)) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_TICKETED_RESULT_REQUIRED',
        'Replace requires a current Core-owned search result',
        'validation',
      ),
    )
    return null
  }
  if (
    get(findReplaceOperationAttemptLedgerStateAtom).some((attempt) =>
      attemptBlocksMutationForTarget(attempt, resultTicket.search),
    )
  ) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_OUTCOME_UNKNOWN',
        'A previous replace outcome for this target is unknown; automatic resend is blocked',
        'transport',
      ),
    )
    return null
  }
  if (cursor.status !== 'ready' || cursor.pageMatches.length === 0) {
    setCommandError(
      set,
      error('FIND_REPLACE_RESULT_REQUIRED', 'Replace requires a current match', 'validation'),
    )
    return null
  }
  if (resultTicket.revision === undefined) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_RESULT_REVISION_REQUIRED',
        'Replace requires a response-owned projection revision',
        'validation',
      ),
    )
    return null
  }
  if (input.revision !== undefined && input.revision !== resultTicket.revision) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_REVISION_MISMATCH',
        'The expected revision does not match the accepted search result',
        'validation',
      ),
    )
    return null
  }
  const selectedMatches =
    input.action === 'replace-all'
      ? resultTicket.matches
      : [resultTicket.matches[cursor.currentIndex] ?? resultTicket.matches[0]]
  if (selectedMatches.length === 0) return null
  if (selectedMatches.some((match) => match.target === null)) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_TARGET_PROVENANCE_REQUIRED',
        'Replace requires canonical display/formula target provenance',
        'validation',
      ),
    )
    return null
  }
  const plan = planFindReplaceMutationIdentity(get(findReplaceRequestSequenceAtom))
  if (plan === null) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_REQUEST_IDENTITY_UNAVAILABLE',
        'Find/replace request identity is exhausted',
        'validation',
      ),
    )
    return null
  }
  const attempt: FindReplaceOperationAttempt = {
    operationId: plan.operationId,
    requestedCount: selectedMatches.length,
    status: 'pending',
    reconciled: false,
    target: reconciliationTarget(resultTicket.search),
  }
  const nextLedger = reserveAttempt(get(findReplaceOperationAttemptLedgerStateAtom), attempt)
  if (nextLedger === null) {
    setCommandError(
      set,
      error(
        'FIND_REPLACE_LEDGER_FULL',
        'Replace evidence ledger is full; unresolved entries prevent dispatch',
        'transport',
      ),
    )
    return null
  }
  const request: ReplaceMatchesRequest = {
    kind: 'replace-matches',
    coords: selectedMatches.map((match) => ({
      sheetId: match.sheetId,
      coord: { ...match.coord },
      matchStart: match.matchStart,
      matchEnd: match.matchEnd,
      target: match.target!,
    })),
    replacement: get(findReplaceFormStateAtom).replacement,
    requestId: plan.requestId,
    revision: resultTicket.revision,
  }
  const ticket: PendingMutation = {
    operationId: plan.operationId,
    requestId: plan.requestId,
    action: input.action,
    requestedCount: selectedMatches.length,
    request: Object.freeze(request),
    resultTicket,
    dispatched: false,
  }
  set(findReplaceRequestSequenceAtom, plan.requestId)
  set(findReplaceOperationAttemptLedgerStateAtom, nextLedger)
  set(findReplaceCommandErrorStateAtom, null)
  set(findReplaceSessionStateAtom, {
    ...session,
    pendingMutation: ticket,
  })
  return {
    ticket,
    replaceMatches: input.replaceMatches,
    searchRange: input.searchRange,
    acceptAcknowledgedResult: input.acceptAcknowledgedResult,
    timeoutMs: normalizeTimeoutMs(input.timeoutMs),
  }
}

function copyReplaceRequest(request: ReplaceMatchesRequest): ReplaceMatchesRequest {
  return {
    ...request,
    coords: request.coords.map((entry) => ({ ...entry, coord: { ...entry.coord } })),
  }
}

function markMutationUnknown(
  get: Getter,
  set: Setter,
  ticket: PendingMutation,
  value: SpreadsheetError,
): void {
  set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
    settleAttempt(ledger, ticket.operationId, 'outcome-unknown'),
  )
  const session = get(findReplaceSessionStateAtom)
  if (session.pendingMutation?.operationId !== ticket.operationId) return
  if (!ticketInputsCurrent(get, ticket.resultTicket.search)) {
    set(findReplaceSessionStateAtom, { ...session, pendingMutation: null })
    return
  }
  const recovery: RefreshRecoveryInternal = {
    kind: 'outcome-unknown',
    status: 'required',
    operationId: ticket.operationId,
    phase: 'search',
    mutationRequest: Object.freeze(copyReplaceRequest(ticket.request)),
    mutationResult: null,
    sourceSearch: ticket.resultTicket.search,
    error: value,
  }
  set(findReplaceSessionStateAtom, {
    ...session,
    pendingMutation: null,
    resultTicket: null,
    recovery,
  })
  set(findReplaceCursorStateAtom, {
    status: 'error',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
    error: value,
  })
  setCommandError(set, value)
}

function settleLateExactAcknowledgement(
  get: Getter,
  set: Setter,
  ticket: PendingMutation,
  value: ReplaceMatchesResponse,
  phase: FindReplaceRefreshRecoveryPhase,
): void {
  const acknowledgement = validateAcknowledgement(value, ticket)
  if (acknowledgement === null) return
  const session = get(findReplaceSessionStateAtom)
  const attempt = get(findReplaceOperationAttemptLedgerStateAtom).find(
    (entry) => entry.operationId === ticket.operationId,
  )
  if (
    attempt?.status !== 'outcome-unknown' ||
    attempt.reconciled ||
    session.pendingMutation !== null ||
    session.activeSearchTicket !== null ||
    session.recovery?.kind !== 'outcome-unknown' ||
    session.recovery.operationId !== ticket.operationId ||
    session.recovery.status !== 'required' ||
    !ticketInputsCurrent(get, ticket.resultTicket.search)
  ) {
    return
  }
  const recoveryError = error(
    'FIND_REPLACE_LATE_ACK_REFRESH_REQUIRED',
    'Replace was acknowledged after timeout; explicit refresh recovery is required',
    'projection',
  )
  const recovery: RefreshRecoveryInternal = {
    kind: 'acknowledged',
    status: 'required',
    operationId: ticket.operationId,
    phase,
    mutationRequest: Object.freeze(copyReplaceRequest(ticket.request)),
    mutationResult: Object.freeze({ ...acknowledgement }),
    sourceSearch: ticket.resultTicket.search,
    error: recoveryError,
  }
  set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
    settleAttempt(ledger, ticket.operationId, 'acknowledged'),
  )
  set(findReplaceSessionStateAtom, {
    ...session,
    resultTicket: null,
    recovery,
  })
  set(findReplaceCursorStateAtom, {
    status: 'error',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
    error: recoveryError,
  })
  setCommandError(set, recoveryError)
}

async function executeRefreshSearch(
  get: Getter,
  set: Setter,
  recovery: RefreshRecoveryInternal,
  ports: RefreshPorts,
): Promise<void> {
  const requestId = allocateRequestId(get, set)
  if (requestId === null) {
    requireRefreshRecovery(
      get,
      set,
      recovery,
      'search',
      error(
        'FIND_REPLACE_REQUEST_IDENTITY_UNAVAILABLE',
        'Refresh search request identity is exhausted',
        'validation',
      ),
    )
    return
  }
  const ticket = createSearchTicket(
    get,
    requestId,
    recovery.sourceSearch.request.query,
    recovery.sourceSearch.request.range,
    recovery.kind === 'acknowledged' ? recovery.mutationResult.revision : undefined,
  )
  const searching: RefreshRecoveryInternal = {
    ...recovery,
    status: 'refreshing',
    phase: 'search',
    error: null,
  }
  set(findReplaceCursorStateAtom, {
    status: 'searching',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
  })
  set(findReplaceSessionStateAtom, (session) => ({
    ...session,
    activeSearchTicket: ticket,
    cursorOwnerTicket: ticket,
    compatibilityCursor: false,
    recovery: searching,
  }))
  await Promise.resolve()
  if (
    get(findReplaceSessionStateAtom).activeSearchTicket !== ticket ||
    !ticketInputsCurrent(get, ticket)
  ) {
    return
  }
  let promise: Promise<SearchRangeResult>
  try {
    promise = Promise.resolve(ports.searchRange(ticket.request as SearchRangeRequest))
  } catch (transportError) {
    requireRefreshRecovery(get, set, searching, 'search', normalizeError(transportError))
    return
  }
  const outcome = await waitForTransport(promise, ports.timeoutMs)
  if (
    get(findReplaceSessionStateAtom).activeSearchTicket !== ticket ||
    !ticketInputsCurrent(get, ticket)
  ) {
    return
  }
  if (outcome.kind === 'timeout') {
    requireRefreshRecovery(
      get,
      set,
      searching,
      'search',
      error('FIND_REPLACE_TIMEOUT', 'Refresh search timed out', 'transport'),
    )
    return
  }
  if (outcome.kind === 'rejected') {
    requireRefreshRecovery(get, set, searching, 'search', normalizeError(outcome.error))
    return
  }
  const accepted = validateSearchResult(outcome.value, ticket)
  if (accepted === null) {
    requireRefreshRecovery(
      get,
      set,
      searching,
      'search',
      error('FIND_REPLACE_PROTOCOL_ERROR', 'Refresh search failed exact correlation', 'transport'),
    )
    return
  }
  acceptSearchResult(set, ticket, accepted, false)
}

function requireRefreshRecovery(
  get: Getter,
  set: Setter,
  recovery: RefreshRecoveryInternal,
  phase: FindReplaceRefreshRecoveryPhase,
  value: SpreadsheetError,
): void {
  const session = get(findReplaceSessionStateAtom)
  if (session.recovery?.operationId !== recovery.operationId) return
  const requiredRecovery: RefreshRecoveryInternal =
    recovery.kind === 'outcome-unknown'
      ? { ...recovery, status: 'required', phase: 'search', error: value }
      : { ...recovery, status: 'required', phase, error: value }
  set(findReplaceSessionStateAtom, {
    ...session,
    activeSearchTicket: null,
    resultTicket: null,
    recovery: requiredRecovery,
  })
  set(findReplaceCursorStateAtom, {
    status: 'error',
    currentIndex: 0,
    totalCount: 0,
    pageMatches: [],
    error: value,
  })
  setCommandError(set, value)
}

async function continueRefreshRecovery(
  get: Getter,
  set: Setter,
  recovery: RefreshRecoveryInternal,
  ports: RefreshPorts,
): Promise<void> {
  if (
    get(findReplaceSessionStateAtom).recovery?.operationId !== recovery.operationId ||
    !ticketInputsCurrent(get, recovery.sourceSearch)
  ) {
    return
  }
  let searchRecovery = recovery
  if (recovery.kind === 'acknowledged' && recovery.phase === 'projection') {
    if (typeof ports.acceptAcknowledgedResult !== 'function') {
      requireRefreshRecovery(
        get,
        set,
        recovery,
        'projection',
        error(
          'FIND_REPLACE_PROJECTION_REFRESH_UNAVAILABLE',
          'Projection refresh acceptance is unavailable',
          'projection',
        ),
      )
      return
    }
    let promise: Promise<void>
    try {
      promise = Promise.resolve(
        ports.acceptAcknowledgedResult(
          { ...recovery.mutationResult },
          copyReplaceRequest(recovery.mutationRequest),
        ),
      )
    } catch (projectionError) {
      requireRefreshRecovery(get, set, recovery, 'projection', normalizeError(projectionError))
      return
    }
    const outcome = await waitForTransport(promise, ports.timeoutMs)
    if (
      get(findReplaceSessionStateAtom).recovery?.operationId !== recovery.operationId ||
      !ticketInputsCurrent(get, recovery.sourceSearch)
    ) {
      return
    }
    if (outcome.kind === 'timeout') {
      requireRefreshRecovery(
        get,
        set,
        recovery,
        'projection',
        error(
          'FIND_REPLACE_CALLBACK_TIMEOUT',
          'Projection refresh acceptance timed out',
          'projection',
        ),
      )
      return
    }
    if (outcome.kind === 'rejected') {
      requireRefreshRecovery(get, set, recovery, 'projection', normalizeError(outcome.error))
      return
    }
    searchRecovery = { ...recovery, phase: 'search', status: 'refreshing', error: null }
    set(findReplaceSessionStateAtom, (session) => ({ ...session, recovery: searchRecovery }))
  }
  await executeRefreshSearch(get, set, searchRecovery, ports)
}

async function executeMutation(
  get: Getter,
  set: Setter,
  preparation: MutationPreparation,
): Promise<void> {
  const originalTicket = preparation.ticket
  await Promise.resolve()
  if (!currentMutationMatches(get, originalTicket)) return
  const dispatchedTicket: PendingMutation = { ...originalTicket, dispatched: true }
  set(findReplaceSessionStateAtom, (session) => ({
    ...session,
    pendingMutation: dispatchedTicket,
  }))

  let promise: Promise<ReplaceMatchesResponse>
  try {
    promise = Promise.resolve(
      preparation.replaceMatches(copyReplaceRequest(dispatchedTicket.request)),
    )
  } catch (transportError) {
    markMutationUnknown(get, set, dispatchedTicket, normalizeError(transportError))
    return
  }
  const outcome = await waitForTransport(promise, preparation.timeoutMs)
  if (outcome.kind === 'timeout') {
    markMutationUnknown(
      get,
      set,
      dispatchedTicket,
      error(
        'FIND_REPLACE_OUTCOME_UNKNOWN',
        'Replace timed out after dispatch; automatic resend is blocked',
        'transport',
      ),
    )
    void promise.then(
      (lateValue) =>
        settleLateExactAcknowledgement(
          get,
          set,
          dispatchedTicket,
          lateValue,
          preparation.acceptAcknowledgedResult === undefined ? 'search' : 'projection',
        ),
      () => undefined,
    )
    return
  }
  if (outcome.kind === 'rejected') {
    markMutationUnknown(
      get,
      set,
      dispatchedTicket,
      error(
        'FIND_REPLACE_OUTCOME_UNKNOWN',
        'Replace rejected after dispatch without exact not-applied evidence',
        'transport',
      ),
    )
    return
  }

  const notApplied = validateNotAppliedResult(outcome.value, dispatchedTicket.requestId)
  if (notApplied !== null) {
    set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
      removeAttempt(ledger, dispatchedTicket.operationId),
    )
    const session = get(findReplaceSessionStateAtom)
    if (session.pendingMutation?.operationId === dispatchedTicket.operationId) {
      set(findReplaceSessionStateAtom, { ...session, pendingMutation: null })
      setCommandError(set, { ...notApplied.error })
    }
    return
  }

  const acknowledgement = validateAcknowledgement(outcome.value, dispatchedTicket)
  if (acknowledgement === null) {
    markMutationUnknown(
      get,
      set,
      dispatchedTicket,
      error(
        'FIND_REPLACE_OUTCOME_UNKNOWN',
        'Replace returned a malformed or wrongly correlated acknowledgement',
        'transport',
      ),
    )
    return
  }

  const session = get(findReplaceSessionStateAtom)
  if (
    session.pendingMutation?.operationId !== dispatchedTicket.operationId ||
    !ticketInputsCurrent(get, dispatchedTicket.resultTicket.search)
  ) {
    if (session.pendingMutation?.operationId === dispatchedTicket.operationId) {
      set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
        settleAttempt(ledger, dispatchedTicket.operationId, 'outcome-unknown'),
      )
      set(findReplaceSessionStateAtom, { ...session, pendingMutation: null })
    }
    return
  }
  set(findReplaceOperationAttemptLedgerStateAtom, (ledger) =>
    settleAttempt(ledger, dispatchedTicket.operationId, 'acknowledged'),
  )
  const recovery: RefreshRecoveryInternal = {
    kind: 'acknowledged',
    status: 'refreshing',
    operationId: dispatchedTicket.operationId,
    phase: preparation.acceptAcknowledgedResult === undefined ? 'search' : 'projection',
    mutationRequest: Object.freeze(copyReplaceRequest(dispatchedTicket.request)),
    mutationResult: Object.freeze({ ...acknowledgement }),
    sourceSearch: dispatchedTicket.resultTicket.search,
    error: null,
  }
  set(findReplaceSessionStateAtom, {
    ...session,
    pendingMutation: null,
    resultTicket: null,
    recovery,
  })
  if (
    dispatchedTicket.action === 'replace-all' &&
    dispatchedTicket.requestedCount < dispatchedTicket.resultTicket.totalCount
  ) {
    set(replaceAllCappedStateAtom, {
      acknowledgedProjectionCount: acknowledgement.replacedCount,
      totalCount: dispatchedTicket.resultTicket.totalCount,
    })
  }
  await continueRefreshRecovery(get, set, recovery, {
    searchRange: preparation.searchRange,
    acceptAcknowledgedResult: preparation.acceptAcknowledgedResult,
    timeoutMs: preparation.timeoutMs,
  })
}

export const runFindReplaceMutationAtom = atom(
  null,
  (get, set, input: RunFindReplaceMutationInput): Promise<void> | void => {
    const preparation = prepareMutation(get, set, input)
    if (preparation === null) return
    return executeMutation(get, set, preparation)
  },
)
runFindReplaceMutationAtom.debugLabel = 'spreadsheet.findReplace.runMutation'

export const runFindReplaceRefreshRecoveryAtom = atom(
  null,
  (get, set, input: RunFindReplaceRefreshRecoveryInput): Promise<void> | void => {
    if (synchronizeFindReplaceTarget(get, set)) return
    const session = get(findReplaceSessionStateAtom)
    const recovery = session.recovery
    if (recovery === null || recovery.status !== 'required') return
    if (typeof input.searchRange !== 'function') {
      requireRefreshRecovery(
        get,
        set,
        recovery,
        recovery.phase,
        error(
          'FIND_REPLACE_SEARCH_UNAVAILABLE',
          'Refresh recovery requires the search backend port',
          'validation',
        ),
      )
      return
    }
    const refreshing: RefreshRecoveryInternal = {
      ...recovery,
      status: 'refreshing',
      error: null,
    }
    set(findReplaceCommandErrorStateAtom, null)
    set(findReplaceSessionStateAtom, { ...session, recovery: refreshing })
    return continueRefreshRecovery(get, set, refreshing, {
      searchRange: input.searchRange,
      acceptAcknowledgedResult: input.acceptAcknowledgedResult,
      timeoutMs: normalizeTimeoutMs(input.timeoutMs),
    })
  },
)
runFindReplaceRefreshRecoveryAtom.debugLabel = 'spreadsheet.findReplace.runRefreshRecovery'
