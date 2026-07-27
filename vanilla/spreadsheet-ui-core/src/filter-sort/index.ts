import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type {
  ProjectionRequestId,
  SortRangeRejectionCode,
  SortRangeRequest,
} from '../backend/types'
import type { CellRange } from '../shared'
import {
  acquireHistoryProducerReservationAtom,
  nextHistoryTransactionId,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
  type HistoryEntry,
  type HistoryProducerReservation,
} from '../history'
import { getHiddenRowsForSheet, viewportHiddenAtom } from '../viewport/hidden'
import {
  getFilterHiddenRowsForSheet,
  setViewportFilterHiddenRowsAtom,
  viewportFilterHiddenAtom,
} from '../viewport/effective-hidden'
import {
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'
import type {
  ColumnFilterRule,
  FilterDropdownState,
  FilterSortControllerPort,
  FilterSortDraftPatch,
  FilterSortDraftState,
  FilterSortEntrypoint,
  FilterSortEntrypointProjection,
  FilterSortEntrypointState,
  FilterSortEntrypointTarget,
  FilterSortLifecycleState,
  FilterSortState,
  FilterSortStateBySheet,
  PhysicalSortControllerPort,
  PhysicalSortDiagnostic,
  PhysicalSortDiagnosticCode,
  ReapplyFilterInput,
  RunFilterSortMutationInput,
  RunPhysicalSortInput,
  RetryFilterSortRefreshInput,
  SetFilterSortRequest,
  SortDirection,
  UpdateFilterSortAvailableValuesInput,
  UpdateFilterSortDraftInput,
} from './types'

export * from './types'

export const MAX_FILTER_LIST_VALUES = 10000
export const MAX_FILTER_SORT_SHEETS = 256

export const FILTER_SORT_CAPABILITY_ERROR =
  'Filter and sort are unavailable because this workbook does not provide setFilterSort.'
export const FILTER_SORT_INVALID_INPUT_ERROR = 'Filter and sort input is invalid.'
export const FILTER_SORT_ACKNOWLEDGEMENT_ERROR =
  'Filter and sort acknowledgement did not match the active request.'
export const FILTER_SORT_TARGET_ERROR = 'Filter and sort require an active sheet and column.'
export const FILTER_SORT_PENDING_ERROR = 'Filter and sort is already in progress.'
export const FILTER_SORT_DROPDOWN_OPEN_ERROR =
  'Close the filter dropdown before sorting from the toolbar or menu.'
export const FILTER_SORT_STALE_OPERATION_ERROR =
  'Filter and sort was ignored because the active sheet or selection changed.'
export const FILTER_SORT_OUTCOME_UNKNOWN_ERROR =
  'Filter and sort result is unknown. Reload or reconcile workbook data before another change.'
export const FILTER_SORT_REAPPLY_NO_RULES_ERROR = 'Reapply needs an active filter on this sheet.'
export const FILTER_SORT_DEFAULT_TIMEOUT_MS = 15_000
export const FILTER_SORT_TRANSPORT_TIMEOUT_ERROR =
  'Filter and sort transport exceeded the Core deadline.'
export const FILTER_SORT_REFRESH_TIMEOUT_ERROR =
  'Filter and sort refresh exceeded the Core deadline.'

const EMPTY_FILTER_SORT_STATE: FilterSortState = Object.freeze({
  rules: Object.freeze([]),
})

const EMPTY_FILTER_SORT_STATE_BY_SHEET: FilterSortStateBySheet = Object.freeze({})

interface FilterSortStateStore {
  readonly stateBySheet: FilterSortStateBySheet
  readonly insertionOrder: readonly string[]
}

const EMPTY_FILTER_SORT_STATE_STORE: FilterSortStateStore = Object.freeze({
  stateBySheet: EMPTY_FILTER_SORT_STATE_BY_SHEET,
  insertionOrder: Object.freeze([]),
})

const CLOSED_FILTER_DROPDOWN_STATE: FilterDropdownState = Object.freeze({ status: 'closed' })

const INITIAL_FILTER_SORT_DRAFT: FilterSortDraftState = Object.freeze({
  sessionId: 0,
  sheetId: null,
  colIndex: null,
  searchInput: '',
  selectedValues: Object.freeze([]),
  selectionMode: 'all',
  conditionKind: 'none',
  equalsInput: '',
  containsInput: '',
  rangeMinInput: '',
  rangeMaxInput: '',
  availableValues: Object.freeze([]),
})

const INITIAL_FILTER_SORT_LIFECYCLE: FilterSortLifecycleState = Object.freeze({
  status: 'closed',
  sessionId: 0,
  requestId: null,
  sheetId: null,
  colIndex: null,
})

const INITIAL_FILTER_SORT_ENTRYPOINT_STATE: FilterSortEntrypointState = Object.freeze({
  status: 'idle',
  operationId: null,
  requestId: null,
  entrypoint: null,
  target: null,
  direction: null,
  attempt: 0,
  error: '',
})

interface FilterSortMutationTicket {
  readonly sessionId: number
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly colIndex: number
  readonly next: FilterSortState
  readonly request: SetFilterSortRequest
  readonly sourceWitness: FilterSortControllerPort
  readonly transport: NonNullable<FilterSortControllerPort['setFilterSort']>
  readonly refreshProjection: RunFilterSortMutationInput['refreshProjection']
  readonly timeoutMs: number
  readonly historyReservation: HistoryProducerReservation
}

interface FilterSortEntrypointTicketBase {
  readonly operationId: number
  readonly requestId: ProjectionRequestId
  readonly entrypoint: FilterSortEntrypoint
  readonly target: FilterSortEntrypointTarget
  /**
   * `null` for entrypoints that carry no direction. Reapply is the only one:
   * it re-runs committed filter rules and never sorts (see `reapplyFilterAtom`
   * for why the sort half of Excel's Reapply is inexpressible here).
   */
  readonly direction: SortDirection | null
  readonly attempt: number
  readonly selectionWitness: SelectionAuthorityWitness | null
  readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
  readonly targetAuthority: 'selection' | 'explicit'
  readonly refreshProjection:
    | ReapplyFilterInput['refreshProjection']
    | RunPhysicalSortInput['refreshProjection']
  readonly timeoutMs: number
  /**
   * Every backend-mutating entrypoint owns the shared history-producer lane.
   * Reapply produces zero descriptors, but it still changes filter visibility
   * and the backend revision, so it cannot overlap another producer.
   */
  readonly historyReservation: HistoryProducerReservation
}

interface ReapplyFilterTicket extends FilterSortEntrypointTicketBase {
  readonly kind: 'reapply-filter'
  readonly direction: null
  readonly targetAuthority: 'selection'
  readonly selectionWitness: SelectionAuthorityWitness
  readonly next: FilterSortState
  readonly request: SetFilterSortRequest
  readonly sourceWitness: FilterSortControllerPort
  readonly transport: NonNullable<FilterSortControllerPort['setFilterSort']>
}

interface PhysicalSortTicket extends FilterSortEntrypointTicketBase {
  readonly kind: 'physical-sort'
  readonly direction: SortDirection
  readonly request: SortRangeRequest
  readonly sourceWitness: PhysicalSortControllerPort
  readonly transport: NonNullable<PhysicalSortControllerPort['sortRange']>
}

type FilterSortEntrypointTicket = ReapplyFilterTicket | PhysicalSortTicket

type BoundedOperationResult<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

function snapshotTimeoutMs(value: unknown): number | null {
  if (value === undefined) return FILTER_SORT_DEFAULT_TIMEOUT_MS
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Own the timer and both promise continuations so a late settlement is inert
 * and a late rejection is always handled. The caller receives one immutable
 * terminal snapshot and never races the host promise directly.
 */
function runBoundedOperation<T>(
  launch: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedOperationResult<T>> {
  return new Promise((resolve) => {
    let active = true
    const finish = (result: BoundedOperationResult<T>): void => {
      if (!active) return
      active = false
      clearTimeout(timer)
      resolve(Object.freeze(result))
    }
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' })
    }, timeoutMs)

    let pending: Promise<T>
    try {
      pending = Promise.resolve(launch())
    } catch (error) {
      finish({ kind: 'rejected', error })
      return
    }
    pending.then(
      (value) => {
        finish({ kind: 'fulfilled', value })
      },
      (error) => {
        finish({ kind: 'rejected', error })
      },
    )
  })
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
    return 'Unknown filter and sort transport failure.'
  }
}

function outcomeUnknownError(detail: string): string {
  return `${FILTER_SORT_OUTCOME_UNKNOWN_ERROR} ${detail}`
}

function refreshFailureError(error: unknown): string {
  return `Filter and sort was acknowledged, but refresh failed: ${errorMessage(error)}`
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

export function nextFilterSortSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextFilterSortRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextFilterSortOperationId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function normalizeRules(rules: readonly ColumnFilterRule[]): readonly ColumnFilterRule[] {
  return Object.freeze(
    rules.map((rule): ColumnFilterRule => {
      if (rule.kind !== 'list') return Object.freeze({ ...rule })
      return Object.freeze({
        ...rule,
        values: Object.freeze(rule.values.slice(0, MAX_FILTER_LIST_VALUES)),
      })
    }),
  )
}

function normalizeState(state: FilterSortState): FilterSortState {
  return Object.freeze({ rules: normalizeRules(state.rules) })
}

function stateStoreWith(
  current: FilterSortStateStore,
  sheetId: string,
  state: FilterSortState,
): FilterSortStateStore {
  const updatingExisting = Object.prototype.hasOwnProperty.call(current.stateBySheet, sheetId)
  const nextStateBySheet = { ...current.stateBySheet }
  let nextInsertionOrder = current.insertionOrder

  if (!updatingExisting) {
    const oldestSheetId = current.insertionOrder[0]
    if (current.insertionOrder.length >= MAX_FILTER_SORT_SHEETS && oldestSheetId !== undefined) {
      delete nextStateBySheet[oldestSheetId]
      nextInsertionOrder = Object.freeze([...current.insertionOrder.slice(1), sheetId])
    } else {
      nextInsertionOrder = Object.freeze([...current.insertionOrder, sheetId])
    }
  }

  return Object.freeze({
    stateBySheet: Object.freeze({
      ...nextStateBySheet,
      [sheetId]: normalizeState(state),
    }),
    insertionOrder: nextInsertionOrder,
  })
}

function stateStoreWithout(current: FilterSortStateStore, sheetId: string): FilterSortStateStore {
  if (!Object.prototype.hasOwnProperty.call(current.stateBySheet, sheetId)) return current
  const nextStateBySheet = { ...current.stateBySheet }
  delete nextStateBySheet[sheetId]
  return Object.freeze({
    stateBySheet: Object.freeze(nextStateBySheet),
    insertionOrder: Object.freeze(current.insertionOrder.filter((id) => id !== sheetId)),
  })
}

function openFilterDropdownState(sheetId: string, colIndex: number): FilterDropdownState {
  return Object.freeze({ status: 'open', sheetId, colIndex })
}

function snapshotFilterSortDraft(draft: FilterSortDraftState): FilterSortDraftState {
  return Object.freeze({
    ...draft,
    selectedValues: Object.freeze([...draft.selectedValues]),
    availableValues: Object.freeze([...draft.availableValues]),
  })
}

function closedFilterSortDraft(sessionId: number): FilterSortDraftState {
  return snapshotFilterSortDraft({ ...INITIAL_FILTER_SORT_DRAFT, sessionId })
}

function sortFilterValues(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    if (left === '') return -1
    if (right === '') return 1
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function draftFromState(
  sessionId: number,
  sheetId: string,
  colIndex: number,
  state: FilterSortState,
  knownValues: readonly string[] = [],
): FilterSortDraftState {
  const rules = state.rules.filter((rule) => rule.colIndex === colIndex)
  const listRule = rules.find(
    (rule): rule is Extract<ColumnFilterRule, { kind: 'list' }> => rule.kind === 'list',
  )
  const equalsRule = rules.find(
    (rule): rule is Extract<ColumnFilterRule, { kind: 'equals' }> => rule.kind === 'equals',
  )
  const containsRule = rules.find(
    (rule): rule is Extract<ColumnFilterRule, { kind: 'contains' }> => rule.kind === 'contains',
  )
  const rangeRule = rules.find(
    (rule): rule is Extract<ColumnFilterRule, { kind: 'range' }> => rule.kind === 'range',
  )
  const availableValues = sortFilterValues([...(listRule?.values ?? []), ...knownValues])
  return snapshotFilterSortDraft({
    sessionId,
    sheetId,
    colIndex,
    searchInput: '',
    selectedValues: listRule ? sortFilterValues(listRule.values) : [...availableValues],
    selectionMode: listRule ? 'explicit' : 'all',
    conditionKind: equalsRule ? 'equals' : containsRule ? 'contains' : rangeRule ? 'range' : 'none',
    equalsInput: equalsRule?.value ?? '',
    containsInput: containsRule?.value ?? '',
    rangeMinInput: rangeRule?.min === undefined ? '' : String(rangeRule.min),
    rangeMaxInput: rangeRule?.max === undefined ? '' : String(rangeRule.max),
    availableValues,
  })
}

function parseNumberInput(value: string): { valid: boolean; value?: number } {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { valid: true }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? { valid: true, value: parsed } : { valid: false }
}

function deriveMutationState(
  current: FilterSortState,
  draft: FilterSortDraftState,
  intent: RunFilterSortMutationInput['intent'],
): { state: FilterSortState | null; error: string | null } {
  const colIndex = draft.colIndex
  if (colIndex === null || !Number.isSafeInteger(colIndex) || colIndex < 0) {
    return { state: null, error: FILTER_SORT_INVALID_INPUT_ERROR }
  }

  if (intent.kind === 'clear-filter' || intent.kind === 'clear-column') {
    return {
      state: { rules: current.rules.filter((rule) => rule.colIndex !== colIndex) },
      error: null,
    }
  }

  const rules: ColumnFilterRule[] = current.rules.filter((rule) => rule.colIndex !== colIndex)
  const selected = sortFilterValues(
    draft.selectedValues.filter((value) => draft.availableValues.includes(value)),
  )
  if (draft.availableValues.length > 0 && !sameValues(selected, draft.availableValues)) {
    rules.push({ kind: 'list', colIndex, values: selected })
  }

  if (draft.conditionKind === 'equals' && draft.equalsInput.length > 0) {
    rules.push({ kind: 'equals', colIndex, value: draft.equalsInput })
  } else if (draft.conditionKind === 'contains' && draft.containsInput.length > 0) {
    rules.push({ kind: 'contains', colIndex, value: draft.containsInput })
  } else if (draft.conditionKind === 'range') {
    const min = parseNumberInput(draft.rangeMinInput)
    const max = parseNumberInput(draft.rangeMaxInput)
    if (
      !min.valid ||
      !max.valid ||
      (min.value !== undefined && max.value !== undefined && min.value > max.value)
    ) {
      return { state: null, error: FILTER_SORT_INVALID_INPUT_ERROR }
    }
    if (min.value !== undefined || max.value !== undefined) {
      rules.push({
        kind: 'range',
        colIndex,
        ...(min.value === undefined ? {} : { min: min.value }),
        ...(max.value === undefined ? {} : { max: max.value }),
      })
    }
  }

  return { state: { rules }, error: null }
}

function lifecycleFor(
  status: FilterSortLifecycleState['status'],
  sessionId: number,
  sheetId: string | null,
  colIndex: number | null,
  requestId: ProjectionRequestId | null = null,
): FilterSortLifecycleState {
  return Object.freeze({ status, sessionId, requestId, sheetId, colIndex })
}

function resolveFilterSortEntrypointTarget(get: Getter): FilterSortEntrypointTarget | null {
  const selection = get(selectionSnapshotAtom)
  const activeSheetId = get(workspaceSessionAtom).activeSheetId
  const selectionSheetId = selection.activeCell.sheetId
  if (selectionSheetId && activeSheetId && selectionSheetId !== activeSheetId) return null
  const sheetId = selectionSheetId || activeSheetId
  const colIndex = selection.activeCell.col
  if (!sheetId || !Number.isSafeInteger(colIndex) || colIndex < 0) return null
  return Object.freeze({ sheetId, colIndex })
}

function sameFilterSortTarget(
  left: FilterSortEntrypointTarget | null,
  right: FilterSortEntrypointTarget | null,
): boolean {
  return left?.sheetId === right?.sheetId && left?.colIndex === right?.colIndex
}

function mutationTicketAuthorityIsCurrent(get: Getter, ticket: FilterSortMutationTicket): boolean {
  const dropdown = get(filterDropdownAtom)
  const draft = get(filterSortDraftAtom)
  const lifecycle = get(filterSortLifecycleAtom)
  return (
    dropdown.status === 'open' &&
    dropdown.sheetId === ticket.sheetId &&
    dropdown.colIndex === ticket.colIndex &&
    get(filterSortSessionIdAtom) === ticket.sessionId &&
    draft.sessionId === ticket.sessionId &&
    draft.sheetId === ticket.sheetId &&
    draft.colIndex === ticket.colIndex &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.sheetId === ticket.sheetId &&
    lifecycle.colIndex === ticket.colIndex &&
    lifecycle.requestId === ticket.requestId
  )
}

/**
 * Explicit dropdown targets are independent of the selection: only switching
 * the workspace's active sheet revokes them. Toolbar/menu targets are derived
 * from selection, so both authority witnesses and the re-resolved target must
 * still match.
 */
function entrypointTicketAuthorityIsCurrent(
  get: Getter,
  ticket: FilterSortEntrypointTicket,
): boolean {
  if (get(workspaceActiveSheetAuthorityWitnessAtom) !== ticket.workspaceWitness) return false
  if (ticket.targetAuthority === 'explicit') return true
  return (
    ticket.selectionWitness !== null &&
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    sameFilterSortTarget(resolveFilterSortEntrypointTarget(get), ticket.target)
  )
}

function entrypointStateFor(
  status: FilterSortEntrypointState['status'],
  input: {
    readonly operationId?: number | null
    readonly requestId?: ProjectionRequestId | null
    readonly entrypoint?: FilterSortEntrypoint | null
    readonly target?: FilterSortEntrypointTarget | null
    readonly direction?: SortDirection | null
    readonly attempt?: number
    readonly error?: string
  } = {},
): FilterSortEntrypointState {
  return Object.freeze({
    status,
    operationId: input.operationId ?? null,
    requestId: input.requestId ?? null,
    entrypoint: input.entrypoint ?? null,
    target: input.target ?? null,
    direction: input.direction ?? null,
    attempt: input.attempt ?? 0,
    error: input.error ?? '',
  })
}

function entrypointStateForTicket(
  status: FilterSortEntrypointState['status'],
  ticket: FilterSortEntrypointTicket,
  error = '',
): FilterSortEntrypointState {
  return entrypointStateFor(status, {
    operationId: ticket.operationId,
    requestId: ticket.requestId,
    entrypoint: ticket.entrypoint,
    target: ticket.target,
    direction: ticket.direction,
    attempt: ticket.attempt,
    error,
  })
}

function nextEntrypointAttempt(
  previous: FilterSortEntrypointState,
  entrypoint: FilterSortEntrypoint,
  target: FilterSortEntrypointTarget,
  direction: SortDirection | null,
): number {
  if (
    (previous.status === 'error' || previous.status === 'blocked' || previous.status === 'stale') &&
    previous.entrypoint === entrypoint &&
    previous.direction === direction &&
    sameFilterSortTarget(previous.target, target)
  ) {
    return previous.attempt < Number.MAX_SAFE_INTEGER ? previous.attempt + 1 : previous.attempt
  }
  return 1
}

const filterSortStateBackingAtom = atom<FilterSortStateStore>(EMPTY_FILTER_SORT_STATE_STORE)
filterSortStateBackingAtom.debugLabel = 'spreadsheet.filterSort.stateBacking'

/** Read-only committed state projection. Mutations go through Core command atoms. */
export const filterSortStateAtom: Atom<FilterSortStateBySheet> = atom(
  (get) => get(filterSortStateBackingAtom).stateBySheet,
)
filterSortStateAtom.debugLabel = 'spreadsheet.filterSort.state'

const filterDropdownBackingAtom = atom<FilterDropdownState>(CLOSED_FILTER_DROPDOWN_STATE)
filterDropdownBackingAtom.debugLabel = 'spreadsheet.filterSort.dropdownBacking'

/** Read-only dropdown projection. Open and close through Core command atoms. */
export const filterDropdownAtom: Atom<FilterDropdownState> = atom((get) =>
  get(filterDropdownBackingAtom),
)
filterDropdownAtom.debugLabel = 'spreadsheet.filterSort.dropdown'

const filterSortErrorBackingAtom = atom<string>('')
filterSortErrorBackingAtom.debugLabel = 'spreadsheet.filterSort.errorBacking'

/** Read-only error projection. Commands own error transitions. */
export const filterSortErrorAtom: Atom<string> = atom((get) => get(filterSortErrorBackingAtom))
filterSortErrorAtom.debugLabel = 'spreadsheet.filterSort.error'

const filterSortSyncTicketBackingAtom = atom<number>(0)
filterSortSyncTicketBackingAtom.debugLabel = 'spreadsheet.filterSort.syncTicketBacking'

/** Read-only request sequence projection. Only Core commands reserve tickets. */
export const filterSortSyncTicketAtom: Atom<number> = atom((get) =>
  get(filterSortSyncTicketBackingAtom),
)
filterSortSyncTicketAtom.debugLabel = 'spreadsheet.filterSort.syncTicket'

const filterSortSessionIdBackingAtom = atom<number>(0)
filterSortSessionIdBackingAtom.debugLabel = 'spreadsheet.filterSort.sessionIdBacking'

/** Read-only editing-session sequence projection. */
export const filterSortSessionIdAtom: Atom<number> = atom((get) =>
  get(filterSortSessionIdBackingAtom),
)
filterSortSessionIdAtom.debugLabel = 'spreadsheet.filterSort.sessionId'

const filterSortCapabilityBackingAtom = atom<boolean>(false)
filterSortCapabilityBackingAtom.debugLabel = 'spreadsheet.filterSort.capabilityBacking'

/** Read-only capability witness captured by Core commands. */
export const filterSortCapabilityAtom: Atom<boolean> = atom((get) =>
  get(filterSortCapabilityBackingAtom),
)
filterSortCapabilityAtom.debugLabel = 'spreadsheet.filterSort.capability'

const filterSortDraftBackingAtom = atom<FilterSortDraftState>(INITIAL_FILTER_SORT_DRAFT)
filterSortDraftBackingAtom.debugLabel = 'spreadsheet.filterSort.draftBacking'

/** Read-only immutable editor draft projection. */
export const filterSortDraftAtom: Atom<FilterSortDraftState> = atom((get) =>
  get(filterSortDraftBackingAtom),
)
filterSortDraftAtom.debugLabel = 'spreadsheet.filterSort.draft'

const filterSortLifecycleBackingAtom = atom<FilterSortLifecycleState>(INITIAL_FILTER_SORT_LIFECYCLE)
filterSortLifecycleBackingAtom.debugLabel = 'spreadsheet.filterSort.lifecycleBacking'

/** Read-only request lifecycle projection. Commands own every transition. */
export const filterSortLifecycleAtom: Atom<FilterSortLifecycleState> = atom((get) =>
  get(filterSortLifecycleBackingAtom),
)
filterSortLifecycleAtom.debugLabel = 'spreadsheet.filterSort.lifecycle'

const filterSortEntrypointOperationIdStateAtom = atom<number>(0)
filterSortEntrypointOperationIdStateAtom.debugLabel =
  'spreadsheet.filterSort.entrypointOperationIdState'

/** Read-only operation sequence projection. Only Core command atoms advance it. */
export const filterSortEntrypointOperationIdAtom: Atom<number> = atom((get) =>
  get(filterSortEntrypointOperationIdStateAtom),
)
filterSortEntrypointOperationIdAtom.debugLabel = 'spreadsheet.filterSort.entrypointOperationId'

const filterSortEntrypointStateBackingAtom = atom<FilterSortEntrypointState>(
  INITIAL_FILTER_SORT_ENTRYPOINT_STATE,
)
filterSortEntrypointStateBackingAtom.debugLabel = 'spreadsheet.filterSort.entrypointStateBacking'

/** Read-only lifecycle projection. Hosts dispatch commands instead of replacing Core state. */
export const filterSortEntrypointStateAtom: Atom<FilterSortEntrypointState> = atom((get) =>
  get(filterSortEntrypointStateBackingAtom),
)
filterSortEntrypointStateAtom.debugLabel = 'spreadsheet.filterSort.entrypointState'

const activeFilterSortMutationAtom = atom<FilterSortMutationTicket | null>(null)
activeFilterSortMutationAtom.debugLabel = 'spreadsheet.filterSort.activeMutation'

const activeFilterSortEntrypointAtom = atom<FilterSortEntrypointTicket | null>(null)
activeFilterSortEntrypointAtom.debugLabel = 'spreadsheet.filterSort.activeEntrypoint'

export const filterSortCanCloseAtom = atom((get): boolean => {
  const status = get(filterSortLifecycleAtom).status
  return (
    get(activeFilterSortMutationAtom) === null &&
    get(activeFilterSortEntrypointAtom) === null &&
    status !== 'pending' &&
    status !== 'local-acknowledged' &&
    status !== 'refreshing'
  )
})
filterSortCanCloseAtom.debugLabel = 'spreadsheet.filterSort.canClose'

export const filterSortEntrypointTargetAtom = atom((get) => resolveFilterSortEntrypointTarget(get))
filterSortEntrypointTargetAtom.debugLabel = 'spreadsheet.filterSort.entrypointTarget'

export const filterSortEntrypointProjectionAtom = atom((get): FilterSortEntrypointProjection => {
  const state = get(filterSortEntrypointStateBackingAtom)
  const target = resolveFilterSortEntrypointTarget(get)
  const capabilityAvailable = get(filterSortCapabilityAtom)
  const active = get(activeFilterSortEntrypointAtom)
  const entrypointTransportBusy = active !== null
  const dropdownTransportBusy = get(activeFilterSortMutationAtom) !== null
  const dropdownLifecycle = get(filterSortLifecycleAtom)
  const dropdownOutcomeUnknown =
    dropdownTransportBusy && dropdownLifecycle.status === 'outcome-unknown'
  const dropdownRefreshFailed =
    dropdownTransportBusy && dropdownLifecycle.status === 'refresh-failed'
  const entrypointOutcomeUnknown = entrypointTransportBusy && state.status === 'outcome-unknown'
  const entrypointRefreshFailed = entrypointTransportBusy && state.status === 'refresh-failed'
  const dropdownOpen = get(filterDropdownAtom).status === 'open'
  const authorityIsCurrent = active === null || entrypointTicketAuthorityIsCurrent(get, active)
  const pending = entrypointTransportBusy || dropdownTransportBusy
  const effectiveStatus = dropdownOutcomeUnknown
    ? 'outcome-unknown'
    : dropdownRefreshFailed
      ? 'refresh-failed'
      : dropdownTransportBusy
        ? 'pending'
        : entrypointOutcomeUnknown
          ? 'outcome-unknown'
          : entrypointRefreshFailed
            ? 'refresh-failed'
            : entrypointTransportBusy && !authorityIsCurrent
              ? 'stale'
              : state.status
  const effectiveError = dropdownOutcomeUnknown
    ? get(filterSortErrorAtom)
    : dropdownRefreshFailed
      ? get(filterSortErrorAtom)
      : entrypointOutcomeUnknown
        ? state.error
        : entrypointRefreshFailed
          ? state.error
          : entrypointTransportBusy && !authorityIsCurrent
            ? FILTER_SORT_STALE_OPERATION_ERROR
            : state.error
  const disabledReason =
    dropdownOutcomeUnknown ||
    entrypointOutcomeUnknown ||
    dropdownRefreshFailed ||
    entrypointRefreshFailed
      ? effectiveError || FILTER_SORT_OUTCOME_UNKNOWN_ERROR
      : !capabilityAvailable
        ? FILTER_SORT_CAPABILITY_ERROR
        : pending
          ? FILTER_SORT_PENDING_ERROR
          : target === null
            ? FILTER_SORT_TARGET_ERROR
            : dropdownOpen
              ? FILTER_SORT_DROPDOWN_OPEN_ERROR
              : null
  return Object.freeze({
    ...state,
    status: effectiveStatus,
    target,
    error: effectiveError,
    capabilityAvailable,
    disabled: disabledReason !== null,
    disabledReason,
    pending,
  })
})
filterSortEntrypointProjectionAtom.debugLabel = 'spreadsheet.filterSort.entrypointProjection'

export const issueFilterSortSyncTicketAtom = atom(null, (get, set) => {
  const current = get(filterSortSyncTicketAtom)
  const next = nextFilterSortRequestId(current)
  if (next === null) return current
  set(filterSortSyncTicketBackingAtom, next)
  return next
})
issueFilterSortSyncTicketAtom.debugLabel = 'spreadsheet.filterSort.issueSyncTicket'

export const setFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, { sheetId, state }: { sheetId: string; state: FilterSortState }) => {
    const current = get(filterSortStateBackingAtom)
    set(filterSortStateBackingAtom, stateStoreWith(current, sheetId, state))
  },
)
setFilterSortAtom.debugLabel = 'spreadsheet.filterSort.set'

/**
 * Re-hydrate the committed filter RULES render cache from the engine after an
 * undo/redo (design-engine-hidden-rows §6.3, extended for filter apply/clear
 * undo). The rules twin of `setViewportFilterHiddenRowsAtom`: the engine's own
 * snapshot restores its owned filter on the backend transaction, and the
 * provider reads `readSheetHiddenState.filterRules` back into this cache so the
 * dropdown funnel indicator, `sheetHasActiveFilterRules` and Reapply all agree
 * with what the engine now filters. SET-or-REMOVE — empty rules delete the
 * sheet entry (matching a fresh clear) instead of leaving an inert `{rules:[]}`
 * behind. Pure cache reconcile: no dropdown / lifecycle side effects, so it is
 * safe to run after every history undo/redo regardless of the active sheet's
 * filter state.
 */
export const reconcileFilterSortRulesFromEngineAtom = atom(
  null,
  (get, set, { sheetId, rules }: { sheetId: string; rules: readonly ColumnFilterRule[] }) => {
    const current = get(filterSortStateBackingAtom)
    set(
      filterSortStateBackingAtom,
      rules.length === 0
        ? stateStoreWithout(current, sheetId)
        : stateStoreWith(current, sheetId, { rules }),
    )
  },
)
reconcileFilterSortRulesFromEngineAtom.debugLabel =
  'spreadsheet.filterSort.reconcileRulesFromEngine'

export const setFilterSortErrorAtom = atom(null, (_get, set, error: unknown) => {
  set(filterSortErrorBackingAtom, error == null ? '' : errorMessage(error))
})
setFilterSortErrorAtom.debugLabel = 'spreadsheet.filterSort.setError'

export const captureFilterSortCapabilityAtom = atom(
  null,
  (get, set, source: FilterSortControllerPort) => {
    // A capability witness is not cancellation authority. Preserve the
    // captured source capability and ticket until the active transport settles.
    if (
      get(activeFilterSortMutationAtom) !== null ||
      get(activeFilterSortEntrypointAtom) !== null
    ) {
      return
    }
    let available = false
    try {
      available = typeof source?.setFilterSort === 'function'
    } catch {
      available = false
    }
    set(filterSortCapabilityBackingAtom, available)

    const dropdown = get(filterDropdownAtom)
    if (dropdown.status !== 'open') return
    const sessionId = get(filterSortSessionIdAtom)
    if (!available) {
      set(filterSortErrorBackingAtom, FILTER_SORT_CAPABILITY_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', sessionId, dropdown.sheetId!, dropdown.colIndex!),
      )
      return
    }
    const lifecycle = get(filterSortLifecycleAtom)
    if (
      lifecycle.status === 'blocked' &&
      get(filterSortErrorAtom) === FILTER_SORT_CAPABILITY_ERROR
    ) {
      set(filterSortErrorBackingAtom, '')
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('editing', sessionId, dropdown.sheetId!, dropdown.colIndex!),
      )
    }
  },
)
captureFilterSortCapabilityAtom.debugLabel = 'spreadsheet.filterSort.captureCapability'

export const clearFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, sheetId: string) => {
    // Clearing committed state also closes the dropdown, so it must not
    // invalidate an in-flight mutation/entrypoint ticket.
    if (!get(filterSortCanCloseAtom)) return
    const current = get(filterSortStateBackingAtom)
    const next = stateStoreWithout(current, sheetId)
    set(filterSortStateBackingAtom, next)
    const sessionId = nextFilterSortSessionId(get(filterSortSessionIdAtom))
    if (sessionId !== null) set(filterSortSessionIdBackingAtom, sessionId)
    set(filterDropdownBackingAtom, CLOSED_FILTER_DROPDOWN_STATE)
    set(
      filterSortDraftBackingAtom,
      closedFilterSortDraft(sessionId ?? get(filterSortSessionIdAtom)),
    )
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('closed', sessionId ?? get(filterSortSessionIdAtom), null, null),
    )
    set(filterSortErrorBackingAtom, '')
  },
)
clearFilterSortAtom.debugLabel = 'spreadsheet.filterSort.clear'

export const clearColumnFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, { sheetId, colIndex }: { sheetId: string; colIndex: number }) => {
    if (
      get(activeFilterSortMutationAtom) !== null ||
      get(activeFilterSortEntrypointAtom) !== null
    ) {
      return
    }
    const current = get(filterSortStateAtom)
    const sheetState = current[sheetId]
    if (!sheetState) return
    const nextRules = sheetState.rules.filter((rule) => rule.colIndex !== colIndex)
    if (nextRules.length === sheetState.rules.length) return
    set(
      filterSortStateBackingAtom,
      stateStoreWith(get(filterSortStateBackingAtom), sheetId, { rules: nextRules }),
    )
  },
)
clearColumnFilterSortAtom.debugLabel = 'spreadsheet.filterSort.clearColumn'

export const clearColumnFilterRulesAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, { sheetId, colIndex }: { sheetId: string; colIndex: number }) => {
    if (
      get(activeFilterSortMutationAtom) !== null ||
      get(activeFilterSortEntrypointAtom) !== null
    ) {
      return
    }
    const current = get(filterSortStateAtom)
    const sheetState = current[sheetId]
    if (!sheetState) return
    const nextRules = sheetState.rules.filter((rule) => rule.colIndex !== colIndex)
    if (nextRules.length === sheetState.rules.length) return
    set(
      filterSortStateBackingAtom,
      stateStoreWith(get(filterSortStateBackingAtom), sheetId, { rules: nextRules }),
    )
  },
)
clearColumnFilterRulesAtom.debugLabel = 'spreadsheet.filterSort.clearColumnRules'

export const openFilterDropdownAtom = atom(
  (get) => get(filterDropdownAtom),
  (get, set, { sheetId, colIndex }: { sheetId: string; colIndex: number }) => {
    // Opening a new draft must never invalidate either transport ticket.
    if (
      get(activeFilterSortMutationAtom) !== null ||
      get(activeFilterSortEntrypointAtom) !== null
    ) {
      return
    }
    if (!sheetId || !Number.isSafeInteger(colIndex) || colIndex < 0) return
    const sessionId = nextFilterSortSessionId(get(filterSortSessionIdAtom))
    if (sessionId === null) {
      set(filterSortErrorBackingAtom, 'Filter and sort session identity space is exhausted.')
      return
    }
    const available = get(filterSortCapabilityAtom)
    const state = get(filterSortStateAtom)[sheetId] ?? EMPTY_FILTER_SORT_STATE
    set(filterSortSessionIdBackingAtom, sessionId)
    set(filterDropdownBackingAtom, openFilterDropdownState(sheetId, colIndex))
    set(filterSortDraftBackingAtom, draftFromState(sessionId, sheetId, colIndex, state))
    set(filterSortErrorBackingAtom, available ? '' : FILTER_SORT_CAPABILITY_ERROR)
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor(available ? 'editing' : 'blocked', sessionId, sheetId, colIndex),
    )
  },
)
openFilterDropdownAtom.debugLabel = 'spreadsheet.filterSort.openDropdown'

export const openFilterDropdownFromEntrypointAtom = atom(
  null,
  (
    get,
    set,
    input: { readonly source: FilterSortControllerPort; readonly entrypoint: FilterSortEntrypoint },
  ) => {
    // A dropdown mutation and a toolbar/menu command share one backend lane.
    // Opening a new session here would otherwise clear the dropdown ticket
    // while its transport is still in flight.
    if (
      get(activeFilterSortMutationAtom) !== null ||
      get(activeFilterSortEntrypointAtom) !== null
    ) {
      return
    }

    let available = false
    try {
      available = typeof input.source?.setFilterSort === 'function'
    } catch {
      available = false
    }
    set(filterSortCapabilityBackingAtom, available)
    const target = resolveFilterSortEntrypointTarget(get)
    if (!available || target === null) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: input.entrypoint,
          target,
          attempt: 1,
          error: available ? FILTER_SORT_TARGET_ERROR : FILTER_SORT_CAPABILITY_ERROR,
        }),
      )
      return
    }

    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateFor('idle', { entrypoint: input.entrypoint, target }),
    )
    set(openFilterDropdownAtom, target)
  },
)
openFilterDropdownFromEntrypointAtom.debugLabel =
  'spreadsheet.filterSort.openDropdownFromEntrypoint'

export const closeFilterDropdownAtom = atom(
  (get) => get(filterDropdownAtom),
  (get, set) => {
    // Keep closing blocked for the full request lifecycle so UI affordances
    // and direct/external command callers observe the same active operation.
    if (!get(filterSortCanCloseAtom)) return
    const nextSessionId = nextFilterSortSessionId(get(filterSortSessionIdAtom))
    if (nextSessionId !== null) set(filterSortSessionIdBackingAtom, nextSessionId)
    const sessionId = nextSessionId ?? get(filterSortSessionIdAtom)
    set(filterDropdownBackingAtom, CLOSED_FILTER_DROPDOWN_STATE)
    set(filterSortDraftBackingAtom, closedFilterSortDraft(sessionId))
    set(filterSortLifecycleBackingAtom, lifecycleFor('closed', sessionId, null, null))
    set(filterSortErrorBackingAtom, '')
  },
)
closeFilterDropdownAtom.debugLabel = 'spreadsheet.filterSort.closeDropdown'

export const updateFilterSortDraftAtom = atom(
  null,
  (get, set, input: UpdateFilterSortDraftInput) => {
    const draft = get(filterSortDraftAtom)
    const lifecycle = get(filterSortLifecycleAtom)
    if (
      input.sessionId !== draft.sessionId ||
      lifecycle.sessionId !== draft.sessionId ||
      lifecycle.status === 'closed' ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing' ||
      lifecycle.status === 'refresh-failed' ||
      lifecycle.status === 'outcome-unknown'
    ) {
      return
    }
    const patch: FilterSortDraftPatch = {
      ...input.patch,
      ...(input.patch.selectedValues === undefined
        ? {}
        : { selectedValues: sortFilterValues(input.patch.selectedValues) }),
    }
    set(filterSortDraftBackingAtom, snapshotFilterSortDraft({ ...draft, ...patch }))
    if (lifecycle.status === 'error') {
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('editing', draft.sessionId, draft.sheetId, draft.colIndex),
      )
      set(filterSortErrorBackingAtom, '')
    }
  },
)
updateFilterSortDraftAtom.debugLabel = 'spreadsheet.filterSort.updateDraft'

export const updateFilterSortAvailableValuesAtom = atom(
  null,
  (get, set, input: UpdateFilterSortAvailableValuesInput) => {
    const draft = get(filterSortDraftAtom)
    if (
      input.sessionId !== draft.sessionId ||
      input.sheetId !== draft.sheetId ||
      input.colIndex !== draft.colIndex
    ) {
      return
    }
    const availableValues = sortFilterValues([...draft.availableValues, ...input.values])
    const selectedValues =
      draft.selectionMode === 'all' ? [...availableValues] : [...draft.selectedValues]
    if (
      sameValues(availableValues, draft.availableValues) &&
      sameValues(selectedValues, draft.selectedValues)
    ) {
      return
    }
    set(
      filterSortDraftBackingAtom,
      snapshotFilterSortDraft({
        ...draft,
        availableValues,
        selectedValues,
      }),
    )
  },
)
updateFilterSortAvailableValuesAtom.debugLabel = 'spreadsheet.filterSort.updateAvailableValues'

type FilterSortAcknowledgementSnapshot =
  | {
      readonly kind: 'matched'
      readonly sheetId: string
      readonly requestId: ProjectionRequestId
      readonly historyRecorded: boolean
      readonly revision: HistoryEntry['projectionRevision']
      readonly hiddenRowIndices: readonly number[]
    }
  | { readonly kind: 'invalid' }

function isValidProjectionRevision(value: unknown): value is HistoryEntry['projectionRevision'] {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function snapshotHiddenRowIndices(value: unknown, allowAbsent: boolean): readonly number[] | null {
  if (value === undefined && allowAbsent) return Object.freeze([])
  if (!Array.isArray(value)) return null

  // `value` is still host-owned (and may be a Proxy). Read its length and each
  // indexed item exactly once, then keep only the detached frozen copy.
  const length = value.length
  const snapshot = new Array<number>(length)
  for (let index = 0; index < length; index += 1) {
    const row = value[index] as unknown
    if (!Number.isSafeInteger(row) || (row as number) < 0) return null
    snapshot[index] = row as number
  }
  return Object.freeze(snapshot)
}

/**
 * Correlate and snapshot a set-filter-sort acknowledgement at the host
 * boundary. Every caller-owned top-level getter and hidden-row item is consumed
 * exactly once; downstream history and projection writes receive only this
 * detached frozen value.
 *
 * Apply / Clear requires the host's whole-column visibility answer. Reapply
 * keeps the established compatibility rule that an absent visibility answer
 * clears the old set, but its zero-history verdict is still explicit.
 */
function classifyFilterSortAcknowledgement(
  value: unknown,
  sheetId: string,
  requestId: ProjectionRequestId,
  options: {
    readonly expectedHistoryRecorded: boolean | null
    readonly allowAbsentHiddenRowIndices: boolean
  },
): FilterSortAcknowledgementSnapshot {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return Object.freeze({ kind: 'invalid' })
    }
    const result = value as Record<PropertyKey, unknown>
    const acknowledgementSheetId = result.sheetId
    const acknowledgementRequestId = result.requestId
    const historyRecorded = result.historyRecorded
    const revision = result.revision
    const hiddenRows = result.hiddenRowIndices
    if (
      acknowledgementSheetId !== sheetId ||
      acknowledgementRequestId !== requestId ||
      typeof historyRecorded !== 'boolean' ||
      (options.expectedHistoryRecorded !== null &&
        historyRecorded !== options.expectedHistoryRecorded) ||
      !isValidProjectionRevision(revision)
    ) {
      return Object.freeze({ kind: 'invalid' })
    }
    const hiddenRowIndices = snapshotHiddenRowIndices(
      hiddenRows,
      options.allowAbsentHiddenRowIndices,
    )
    if (hiddenRowIndices === null) return Object.freeze({ kind: 'invalid' })

    return Object.freeze({
      kind: 'matched',
      sheetId: acknowledgementSheetId,
      requestId: acknowledgementRequestId,
      historyRecorded,
      revision,
      hiddenRowIndices,
    })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

/**
 * Push the ONE UI-core history entry that pairs with the ONE adapter
 * transaction record a filter apply / clear produced, gated on the backend's
 * `historyRecorded` verdict so the two undo stacks align entry-for-entry.
 *
 * The backend is the single decision-maker: it pushed a record iff the apply /
 * clear actually changed the committed filter, and only then does
 * `historyRecorded` read `true`. Recording here on a no-op would offset the
 * stacks by one — every later Ctrl+Z would then revert a step older than the UI
 * believes — so an explicit `false` verdict pushes nothing. An absent or
 * malformed verdict is rejected before this helper. The entry carries no
 * local-replay payload: undo/redo restores the engine's owned filter through
 * its own snapshot and the provider re-hydrates the rules + hidden render
 * caches from the engine afterwards.
 */
function recordFilterSortHistory(
  set: Setter,
  acknowledgement: FilterSortAcknowledgementSnapshot & { readonly kind: 'matched' },
  sheetId: string,
  reservation: HistoryProducerReservation,
): boolean {
  if (!acknowledgement.historyRecorded) return true
  return set(pushReservedHistoryAtom, {
    reservation,
    entry: {
      transactionId: nextHistoryTransactionId(),
      kind: 'filter.set',
      sheetId,
      projectionRevision: acknowledgement.revision,
    },
  })
}

type CapturedFilterSortMutationInput =
  | {
      readonly kind: 'captured'
      readonly sourceWitness: FilterSortControllerPort
      readonly transport: FilterSortControllerPort['setFilterSort']
      readonly sessionId: number
      readonly intent: RunFilterSortMutationInput['intent']
      readonly refreshProjection: RunFilterSortMutationInput['refreshProjection']
      readonly timeoutMs: number
    }
  | { readonly kind: 'invalid' }

function captureFilterSortMutationInput(
  input: RunFilterSortMutationInput,
): CapturedFilterSortMutationInput {
  try {
    const sourceWitness = input.source
    const sessionId = input.sessionId
    const intentValue = input.intent
    const refreshProjection = input.refreshProjection
    const timeoutMs = snapshotTimeoutMs(input.timeoutMs)
    const intentKind = intentValue?.kind
    if (
      !Number.isSafeInteger(sessionId) ||
      typeof refreshProjection !== 'function' ||
      timeoutMs === null ||
      (intentKind !== 'clear-filter' &&
        intentKind !== 'clear-column' &&
        intentKind !== 'apply-draft')
    ) {
      return Object.freeze({ kind: 'invalid' })
    }
    let transport: FilterSortControllerPort['setFilterSort']
    try {
      transport = sourceWitness?.setFilterSort
    } catch {
      transport = undefined
    }
    return Object.freeze({
      kind: 'captured',
      sourceWitness,
      transport,
      sessionId,
      intent: Object.freeze({ kind: intentKind }),
      refreshProjection,
      timeoutMs,
    })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

export const runFilterSortMutationAtom = atom(
  null,
  async (get, set, input: RunFilterSortMutationInput): Promise<void> => {
    if (get(activeFilterSortMutationAtom) !== null) return
    // Toolbar/MenuBar and dropdown mutations target the same backend state.
    // Keep one transport lane so acknowledgements cannot commit in a
    // different order from the backend writes.
    if (get(activeFilterSortEntrypointAtom) !== null) return

    // Detach every caller-owned value before even considering a history
    // reservation. From this point on the command never reads `input` again.
    const captured = captureFilterSortMutationInput(input)
    // A hostile caller getter can synchronously re-enter this same command
    // while `captureFilterSortMutationInput` is reading the boundary. The
    // nested call may now own either shared lane; the superseded outer call
    // must become wholly inert before it writes capability/lifecycle state or
    // attempts a reservation.
    if (get(activeFilterSortMutationAtom) !== null) return
    if (get(activeFilterSortEntrypointAtom) !== null) return
    const dropdown = get(filterDropdownAtom)
    const draft = get(filterSortDraftAtom)
    const lifecycle = get(filterSortLifecycleAtom)
    if (captured.kind === 'invalid') {
      set(filterSortErrorBackingAtom, FILTER_SORT_INVALID_INPUT_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, draft.sheetId, draft.colIndex),
      )
      return
    }
    if (
      dropdown.status !== 'open' ||
      captured.sessionId !== draft.sessionId ||
      lifecycle.sessionId !== draft.sessionId ||
      dropdown.sheetId !== draft.sheetId ||
      dropdown.colIndex !== draft.colIndex ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing'
    ) {
      return
    }

    if (typeof captured.transport !== 'function') {
      set(filterSortCapabilityBackingAtom, false)
      set(filterSortErrorBackingAtom, FILTER_SORT_CAPABILITY_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, draft.sheetId, draft.colIndex),
      )
      return
    }
    set(filterSortCapabilityBackingAtom, true)

    const sheetId = draft.sheetId
    const colIndex = draft.colIndex
    if (sheetId === null || colIndex === null) return
    const current = get(filterSortStateAtom)[sheetId] ?? EMPTY_FILTER_SORT_STATE
    const derived = deriveMutationState(current, draft, captured.intent)
    if (derived.state === null) {
      set(filterSortErrorBackingAtom, derived.error ?? FILTER_SORT_INVALID_INPUT_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, sheetId, colIndex),
      )
      return
    }

    const requestId = nextFilterSortRequestId(get(filterSortSyncTicketAtom))
    if (requestId === null) {
      set(filterSortErrorBackingAtom, 'Filter and sort request identity space is exhausted.')
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, sheetId, colIndex),
      )
      return
    }
    const next = normalizeState(derived.state)
    const request: SetFilterSortRequest = Object.freeze({
      kind: 'set-filter-sort',
      sheetId,
      rules: next.rules,
      requestId,
      // Excel parity: an actual apply / clear is undoable. The host is the
      // change detector and echoes its exact history verdict in the ACK.
      recordHistory: true,
    })

    // All external values and the exact wire request now exist as immutable
    // snapshots. Reservation acquisition may synchronously notify observers;
    // none of them can change what this ticket will send.
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      set(filterSortErrorBackingAtom, FILTER_SORT_PENDING_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, sheetId, colIndex),
      )
      return
    }
    const ticket: FilterSortMutationTicket = Object.freeze({
      sessionId: draft.sessionId,
      requestId,
      sheetId,
      colIndex,
      next,
      request,
      sourceWitness: captured.sourceWitness,
      transport: captured.transport,
      refreshProjection: captured.refreshProjection,
      timeoutMs: captured.timeoutMs,
      historyReservation,
    })
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortMutationAtom, ticket)
    set(filterSortErrorBackingAtom, '')
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('pending', ticket.sessionId, sheetId, colIndex, requestId),
    )

    const ownsTicket = (): boolean => get(activeFilterSortMutationAtom) === ticket
    const ownsAuthority = (): boolean => mutationTicketAuthorityIsCurrent(get, ticket)
    const retainStaleAuthority = (): void => {
      if (!ownsTicket()) return
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_STALE_OPERATION_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
    }
    const releaseUnsentStaleAuthority = (): void => {
      if (!ownsTicket()) return
      if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
        set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
        set(
          filterSortLifecycleBackingAtom,
          lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
        )
        return
      }
      if (!ownsTicket()) return
      set(filterSortErrorBackingAtom, FILTER_SORT_STALE_OPERATION_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', ticket.sessionId, sheetId, colIndex),
      )
      // Clearing the lane can synchronously admit a replacement command, so
      // it is the final write performed by this invocation.
      set(activeFilterSortMutationAtom, null)
    }

    // Expose the reservation before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      releaseUnsentStaleAuthority()
      return
    }
    // Einfach defers the first flush of an async write until a post-await setter runs.
    // Re-set the owned lifecycle value to publish the already-reserved pending state
    // before the transport can settle, without introducing framework-local state.
    set(filterSortLifecycleBackingAtom, get(filterSortLifecycleAtom))

    const transportResult = await runBoundedOperation(
      () => ticket.transport.call(ticket.sourceWitness, ticket.request),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (transportResult.kind === 'timeout') {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_TRANSPORT_TIMEOUT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (transportResult.kind === 'rejected') {
      set(filterSortErrorBackingAtom, outcomeUnknownError(errorMessage(transportResult.error)))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    const acknowledgementSnapshot = classifyFilterSortAcknowledgement(
      transportResult.value,
      sheetId,
      requestId,
      {
        expectedHistoryRecorded: null,
        allowAbsentHiddenRowIndices: false,
      },
    )
    // ACK fields are caller-owned getters and may synchronously re-enter Core.
    // Never let their classifier commit, push, or release a replacement.
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (acknowledgementSnapshot.kind === 'invalid') {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (!ownsTicket() || !ownsAuthority()) {
      if (ownsTicket()) retainStaleAuthority()
      return
    }

    // Consume the backend's transaction verdict before committing any local
    // projection. A malformed verdict or a failed reserved push means the
    // positional stacks cannot be proven aligned; retain both ticket and
    // reservation for explicit reconciliation and never resend the mutation.
    if (
      !recordFilterSortHistory(set, acknowledgementSnapshot, sheetId, ticket.historyReservation)
    ) {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }

    const stateBeforeCommit = get(filterSortStateBackingAtom)
    set(filterSortStateBackingAtom, stateStoreWith(stateBeforeCommit, sheetId, ticket.next))
    // Visibility commits with the rules, in the same tick and only on a matched
    // ACK (`design-filter-hidden-rows` §4.2). This is the ONLY production writer
    // of the filter-hidden set: it is a whole-set replace taken from the host's
    // whole-column scan, and a SNAPSHOT — editing a cell afterwards does not
    // move a row in or out of view, which is Excel's model (`Data → Reapply`).
    //
    // Apply / Clear requires an explicit whole-column visibility snapshot.
    // Missing or malformed rows make the ACK uncertain before either rules or
    // visibility can commit.
    set(setViewportFilterHiddenRowsAtom, {
      sheetId,
      rows: acknowledgementSnapshot.hiddenRowIndices,
    })
    set(
      filterSortDraftBackingAtom,
      draftFromState(
        ticket.sessionId,
        sheetId,
        colIndex,
        ticket.next,
        get(filterSortDraftAtom).availableValues,
      ),
    )
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('local-acknowledged', ticket.sessionId, sheetId, colIndex, requestId),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('refreshing', ticket.sessionId, sheetId, colIndex, requestId),
    )
    const refreshResult = await runBoundedOperation(
      () => ticket.refreshProjection(sheetId),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (refreshResult.kind === 'timeout') {
      set(filterSortErrorBackingAtom, refreshFailureError(FILTER_SORT_REFRESH_TIMEOUT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('refresh-failed', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (refreshResult.kind === 'rejected') {
      set(filterSortErrorBackingAtom, refreshFailureError(refreshResult.error))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('refresh-failed', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_STALE_OPERATION_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      set(activeFilterSortMutationAtom, null)
      return
    }
    set(filterSortErrorBackingAtom, '')
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('editing', ticket.sessionId, sheetId, colIndex),
    )
    set(activeFilterSortMutationAtom, null)
  },
)
runFilterSortMutationAtom.debugLabel = 'spreadsheet.filterSort.runMutation'

// --- Data → Reapply (Excel Ctrl+Alt+L) --------------------------------------
//
// Filter visibility is a SNAPSHOT: it is computed once, when the rules are
// applied, and deliberately survives `bumpRevision()`, so editing a cell never
// moves its row in or out of view (`design-filter-hidden-rows` §4.3). Excel is
// the same, which is exactly why Excel ships Reapply. Without it our only
// refresh path was re-opening the column dropdown and re-confirming the rules.
//
// TRUTH SOURCE: Reapply re-dispatches the SAME `setFilterSort` the dropdown
// dispatches, carrying the sheet's already-committed rules, and commits the
// ACK through the SAME `setViewportFilterHiddenRowsAtom` sink. It adds no
// second computer and no second writer of filter visibility.
//
// The rejected alternative was a UI-core-local recompute (read the column back
// through a projection and evaluate the rule predicate here). UI-core no longer
// even has a predicate to call: it was moved out to the adapter layer
// (`src-vnext/adapter/filter-predicate.ts`) by the hidden-row sink-down (slice
// E4), leaving UI-core with only the `ColumnFilterRule` wire type. Three things
// are wrong with the alternative, in descending order of severity:
//   1. It would be a SECOND predicate evaluator. Apply and Reapply could then
//      disagree on the same rules over the same data — worse than no Reapply,
//      because the divergence is silent and rule-shape dependent.
//   2. A projection is a bounded window; a predicate needs the whole column.
//      This is the resurrected `deriveFilterHiddenRows` gap that #27 deleted:
//      rows below the fold would stay visible and, once scrolled to, disappear.
//   3. The whole-column scan budget (`MAX_FILTER_SORT_PREDICATE_CELLS`, with a
//      fail-closed `FILTER_SORT_SOURCE_TOO_LARGE` rejection) lives in the host.
//      A UI-core read path has no such guard and would silently truncate where
//      the host path refuses.
//
// This does NOT contradict CANONICAL_OWNERSHIP #29 ("filter visibility is a
// UI-core view fact; the backend port is an optional hook"). Ownership is about
// who HOLDS the fact, not who computes it: `viewportFilterHiddenAtom` stays the
// canonical answer to "is this row painted?", written only on a matched ACK,
// and the host stays an executor — the same shape as the TSV / image export
// ports, which take the hidden set as input rather than deriving it.

/**
 * Why `Data → Reapply` is unavailable right now, or `null` when it can run.
 *
 * A pure derivation, so the menu-bar gate needs no dispatch and no probe. The
 * host reads it exactly like the other menu gates
 * (`SpreadsheetMenuBar.disabledReasonForDispatch`).
 *
 * The load-bearing clause is the last one: with no committed rules on the
 * sheet there is nothing to re-run, so the entry is DISABLED rather than a
 * silent no-op.
 */
export const reapplyFilterDisabledReasonAtom = atom((get): string | null => {
  if (!get(filterSortCapabilityAtom)) return FILTER_SORT_CAPABILITY_ERROR
  if (get(activeFilterSortMutationAtom) !== null || get(activeFilterSortEntrypointAtom) !== null) {
    return FILTER_SORT_PENDING_ERROR
  }
  // The dropdown owns the same backend lane and can commit its own rules.
  if (get(filterDropdownAtom).status === 'open') return FILTER_SORT_DROPDOWN_OPEN_ERROR
  const target = resolveFilterSortEntrypointTarget(get)
  if (target === null) return FILTER_SORT_TARGET_ERROR
  if (!sheetHasActiveFilterRules(get, target.sheetId)) return FILTER_SORT_REAPPLY_NO_RULES_ERROR
  return null
})
reapplyFilterDisabledReasonAtom.debugLabel = 'spreadsheet.filterSort.reapplyDisabledReason'

type CapturedReapplyFilterInput =
  | {
      readonly kind: 'captured'
      readonly sourceWitness: FilterSortControllerPort
      readonly transport: FilterSortControllerPort['setFilterSort']
      readonly entrypoint: FilterSortEntrypoint
      readonly refreshProjection: ReapplyFilterInput['refreshProjection']
      readonly timeoutMs: number
    }
  | { readonly kind: 'invalid' }

function captureReapplyFilterInput(input: ReapplyFilterInput): CapturedReapplyFilterInput {
  try {
    const sourceWitness = input.source
    const entrypoint = input.entrypoint
    const refreshProjection = input.refreshProjection
    const timeoutMs = snapshotTimeoutMs(input.timeoutMs)
    if (
      (entrypoint !== 'toolbar' && entrypoint !== 'menu-bar') ||
      typeof refreshProjection !== 'function' ||
      timeoutMs === null
    ) {
      return Object.freeze({ kind: 'invalid' })
    }
    let transport: FilterSortControllerPort['setFilterSort']
    try {
      transport = sourceWitness?.setFilterSort
    } catch {
      transport = undefined
    }
    return Object.freeze({
      kind: 'captured',
      sourceWitness,
      transport,
      entrypoint,
      refreshProjection,
      timeoutMs,
    })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

/**
 * Re-run the active sheet's committed filter rules and re-commit the answer.
 *
 * NOT in the undo stack, and no history descriptor. Reapply is an IDENTITY
 * re-run of the already-committed rules — it never changes WHAT is filtered,
 * only which rows currently satisfy it — so it is not an undo step: a Reapply
 * entry would be a Ctrl+Z whose counterpart the user never issued. It passes
 * `recordHistory: false` so the backend records nothing either (a `true` there
 * would let the engine's before≠after verdict push a record UI core never
 * pairs, skewing the stacks). It nevertheless owns the shared producer
 * reservation for its full transport + refresh lifetime: the backend updates
 * filter/hidden state and bumps revision even without recording an undo
 * transaction, so overlap with another history producer would still destroy
 * revision ordering. This is DISTINCT from Apply / Clear, which since the
 * 2026-07-22 filter-undo flip ARE undoable (`runFilterSortMutationAtom` pairs a
 * `filter.set` entry on the backend's `historyRecorded` verdict) — matching
 * Excel, where applying or clearing an AutoFilter is Ctrl+Z-able.
 * Microsoft documents neither way for Reapply specifically (checked 2026-07-21:
 * the official "Reapply a filter and sort, or clear a filter" page is silent on
 * undo), so keeping Reapply out of the stack is a deliberate identity-not-an-
 * undo-step choice, the same rule the sort path applies to an identity sort.
 *
 * FILTER ONLY, despite the name. Excel's Reapply covers sort too — that IS
 * verified (Microsoft's page is literally titled "Reapply a filter *and sort*",
 * and Ctrl+Alt+L is documented as reapplying a column sort). It is
 * inexpressible here rather than skipped: sort stopped being view state with
 * #24, so there is no sort spec to re-run — `FilterSortState` holds `rules` and
 * nothing else. Re-running a physical sort would be a DATA MUTATION issued
 * behind a command the user invoked to refresh visibility, which is strictly
 * worse than not sorting.
 *
 * Pre-flight rejections write NO shared state — they are fully described by
 * `reapplyFilterDisabledReasonAtom`. Mirroring them into the entrypoint state
 * would let an inert Ctrl+Alt+L stomp the toolbar's filter/sort error display.
 * Once in flight the command DOES take the shared entrypoint ticket, because
 * from there on it genuinely shares the one backend lane.
 */
export const reapplyFilterAtom = atom(
  null,
  async (get, set, input: ReapplyFilterInput): Promise<void> => {
    if (get(activeFilterSortMutationAtom) !== null) return
    if (get(activeFilterSortEntrypointAtom) !== null) return

    const captured = captureReapplyFilterInput(input)
    // Caller getters are re-entrant. A nested mutation/entrypoint may have
    // claimed the lane while this input was being captured, including before
    // a getter throws. The old invocation must not overwrite its state.
    if (get(activeFilterSortMutationAtom) !== null) return
    if (get(activeFilterSortEntrypointAtom) !== null) return
    if (captured.kind === 'invalid') return
    if (typeof captured.transport !== 'function') {
      set(filterSortCapabilityBackingAtom, false)
      return
    }
    set(filterSortCapabilityBackingAtom, true)
    if (get(reapplyFilterDisabledReasonAtom) !== null) return

    const target = resolveFilterSortEntrypointTarget(get)
    if (target === null) return
    const committed = get(filterSortStateAtom)[target.sheetId]
    if (committed === undefined || committed.rules.length === 0) return

    const operationId = nextFilterSortOperationId(get(filterSortEntrypointOperationIdStateAtom))
    const requestId = nextFilterSortRequestId(get(filterSortSyncTicketAtom))
    if (operationId === null || requestId === null) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: captured.entrypoint,
          target,
          attempt: 1,
          error: 'Filter and sort command identity space is exhausted.',
        }),
      )
      return
    }

    const next = normalizeState(committed)
    const request: SetFilterSortRequest = Object.freeze({
      kind: 'set-filter-sort',
      sheetId: target.sheetId,
      rules: next.rules,
      requestId,
      // Reapply is NEVER an undo step (identity re-run of committed rules):
      // it pushes no history descriptor, so the backend must record none.
      recordHistory: false,
    })
    const previous = get(filterSortEntrypointStateBackingAtom)
    const attempt = nextEntrypointAttempt(previous, captured.entrypoint, target, null)
    const selectionWitness = get(selectionAuthorityWitnessAtom)
    const workspaceWitness = get(workspaceActiveSheetAuthorityWitnessAtom)

    // The complete transport request and every authority/caller witness are
    // detached before reservation acquisition. Acquiring the shared producer
    // lane may synchronously notify observers; none can alter this ticket.
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: captured.entrypoint,
          target,
          attempt: 1,
          error: FILTER_SORT_PENDING_ERROR,
        }),
      )
      return
    }

    const ticket: ReapplyFilterTicket = Object.freeze({
      kind: 'reapply-filter',
      operationId,
      requestId,
      entrypoint: captured.entrypoint,
      target,
      direction: null,
      attempt,
      // Identity: Reapply never changes what is filtered, only which rows
      // currently satisfy it. The committed rules go out and come back.
      next,
      request,
      sourceWitness: captured.sourceWitness,
      transport: captured.transport,
      refreshProjection: captured.refreshProjection,
      timeoutMs: captured.timeoutMs,
      selectionWitness,
      workspaceWitness,
      targetAuthority: 'selection',
      historyReservation,
    })
    set(filterSortEntrypointOperationIdStateAtom, operationId)
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortEntrypointAtom, ticket)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('pending', ticket))

    const ownsTicket = (): boolean => get(activeFilterSortEntrypointAtom) === ticket
    const ownsAuthority = (): boolean => entrypointTicketAuthorityIsCurrent(get, ticket)
    const retainStaleAuthority = (): void => {
      if (!ownsTicket()) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('stale', ticket, FILTER_SORT_STALE_OPERATION_ERROR),
      )
    }
    const releaseUnsentStaleAuthority = (): void => {
      if (!ownsTicket()) return
      if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
        set(
          filterSortEntrypointStateBackingAtom,
          entrypointStateForTicket(
            'outcome-unknown',
            ticket,
            outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
          ),
        )
        return
      }
      // Releasing an exact token may synchronously wake another producer.
      // Clear only if this exact ticket still owns the entrypoint lane.
      if (!ownsTicket()) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('stale', ticket, FILTER_SORT_STALE_OPERATION_ERROR),
      )
      set(activeFilterSortEntrypointAtom, null)
    }

    // Publish the reservation before transport launch so same-tick re-entry is
    // inert; re-set the owned pending value to flush it (Einfach defers the
    // first flush of an async write until a post-await setter runs).
    await Promise.resolve()
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      releaseUnsentStaleAuthority()
      return
    }
    set(filterSortEntrypointStateBackingAtom, get(filterSortEntrypointStateBackingAtom))

    const transportResult = await runBoundedOperation(
      () => ticket.transport.call(ticket.sourceWitness, ticket.request),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (transportResult.kind === 'timeout') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_TRANSPORT_TIMEOUT_ERROR),
        ),
      )
      return
    }
    if (transportResult.kind === 'rejected') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(errorMessage(transportResult.error)),
        ),
      )
      return
    }
    const acknowledgementSnapshot = classifyFilterSortAcknowledgement(
      transportResult.value,
      ticket.target.sheetId,
      ticket.requestId,
      {
        expectedHistoryRecorded: false,
        allowAbsentHiddenRowIndices: true,
      },
    )
    // Host-owned ACK getters may synchronously re-enter Core. A strict ACK is
    // useful only while this exact ticket and its authority remain current.
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (acknowledgementSnapshot.kind === 'invalid') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }

    // The one and only effect: the fresh whole-column answer replaces the
    // stale snapshot. Same sink, same whole-set-replace, same clear-on-absent
    // degradation as the dropdown path — Reapply is not a second writer with
    // its own rules, it is the same writer invoked again.
    set(setViewportFilterHiddenRowsAtom, {
      sheetId: ticket.target.sheetId,
      rows: acknowledgementSnapshot.hiddenRowIndices,
    })
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('local-acknowledged', ticket),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('refreshing', ticket))
    const refreshResult = await runBoundedOperation(
      () => ticket.refreshProjection(ticket.target.sheetId),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      retainStaleAuthority()
      return
    }
    if (refreshResult.kind === 'timeout') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          ticket,
          refreshFailureError(FILTER_SORT_REFRESH_TIMEOUT_ERROR),
        ),
      )
      return
    }
    if (refreshResult.kind === 'rejected') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          ticket,
          refreshFailureError(refreshResult.error),
        ),
      )
      return
    }
    if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }
    if (!ownsTicket()) return
    if (!ownsAuthority()) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('stale', ticket, FILTER_SORT_STALE_OPERATION_ERROR),
      )
      set(activeFilterSortEntrypointAtom, null)
      return
    }
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', ticket))
    set(activeFilterSortEntrypointAtom, null)
  },
)
reapplyFilterAtom.debugLabel = 'spreadsheet.filterSort.reapply'

type CapturedRetryFilterSortRefreshInput =
  | {
      readonly kind: 'captured'
      readonly refreshProjection: RetryFilterSortRefreshInput['refreshProjection']
      readonly timeoutMs: number
    }
  | { readonly kind: 'invalid' }

function captureRetryFilterSortRefreshInput(
  input: RetryFilterSortRefreshInput,
): CapturedRetryFilterSortRefreshInput {
  try {
    const refreshProjection = input.refreshProjection
    const timeoutMs = snapshotTimeoutMs(input.timeoutMs)
    if (typeof refreshProjection !== 'function' || timeoutMs === null) {
      return Object.freeze({ kind: 'invalid' })
    }
    return Object.freeze({ kind: 'captured', refreshProjection, timeoutMs })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

export const retryFilterSortRefreshAtom = atom(
  null,
  async (get, set, input: RetryFilterSortRefreshInput): Promise<void> => {
    // Select and witness the exact failed ticket before touching caller-owned
    // retry getters. A getter may synchronously run another retry and advance
    // this ticket to `refreshing`; the superseded invocation must not attach
    // its callback or deadline to that in-flight retry.
    const mutationTicket = get(activeFilterSortMutationAtom)
    const mutationLifecycle = get(filterSortLifecycleAtom)
    if (
      mutationTicket !== null &&
      mutationLifecycle.status === 'refresh-failed' &&
      mutationLifecycle.sessionId === mutationTicket.sessionId &&
      mutationLifecycle.requestId === mutationTicket.requestId
    ) {
      if (!mutationTicketAuthorityIsCurrent(get, mutationTicket)) return
      const captured = captureRetryFilterSortRefreshInput(input)
      if (get(activeFilterSortMutationAtom) !== mutationTicket) return
      if (get(filterSortLifecycleAtom) !== mutationLifecycle) return
      if (!mutationTicketAuthorityIsCurrent(get, mutationTicket)) return
      if (captured.kind === 'invalid') return
      set(filterSortErrorBackingAtom, '')
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor(
          'refreshing',
          mutationTicket.sessionId,
          mutationTicket.sheetId,
          mutationTicket.colIndex,
          mutationTicket.requestId,
        ),
      )
      if (get(activeFilterSortMutationAtom) !== mutationTicket) return
      if (!mutationTicketAuthorityIsCurrent(get, mutationTicket)) return
      const refreshResult = await runBoundedOperation(
        () => captured.refreshProjection(mutationTicket.sheetId),
        captured.timeoutMs,
      )
      if (get(activeFilterSortMutationAtom) !== mutationTicket) return
      if (!mutationTicketAuthorityIsCurrent(get, mutationTicket)) return
      if (refreshResult.kind === 'timeout') {
        set(filterSortErrorBackingAtom, refreshFailureError(FILTER_SORT_REFRESH_TIMEOUT_ERROR))
        set(
          filterSortLifecycleBackingAtom,
          lifecycleFor(
            'refresh-failed',
            mutationTicket.sessionId,
            mutationTicket.sheetId,
            mutationTicket.colIndex,
            mutationTicket.requestId,
          ),
        )
        return
      }
      if (refreshResult.kind === 'rejected') {
        set(filterSortErrorBackingAtom, refreshFailureError(refreshResult.error))
        set(
          filterSortLifecycleBackingAtom,
          lifecycleFor(
            'refresh-failed',
            mutationTicket.sessionId,
            mutationTicket.sheetId,
            mutationTicket.colIndex,
            mutationTicket.requestId,
          ),
        )
        return
      }
      if (!set(releaseHistoryProducerReservationAtom, mutationTicket.historyReservation)) {
        set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
        set(
          filterSortLifecycleBackingAtom,
          lifecycleFor(
            'outcome-unknown',
            mutationTicket.sessionId,
            mutationTicket.sheetId,
            mutationTicket.colIndex,
            mutationTicket.requestId,
          ),
        )
        return
      }
      if (get(activeFilterSortMutationAtom) !== mutationTicket) return
      if (!mutationTicketAuthorityIsCurrent(get, mutationTicket)) {
        set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_STALE_OPERATION_ERROR))
        set(
          filterSortLifecycleBackingAtom,
          lifecycleFor(
            'outcome-unknown',
            mutationTicket.sessionId,
            mutationTicket.sheetId,
            mutationTicket.colIndex,
            mutationTicket.requestId,
          ),
        )
        set(activeFilterSortMutationAtom, null)
        return
      }
      set(filterSortErrorBackingAtom, '')
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor(
          'editing',
          mutationTicket.sessionId,
          mutationTicket.sheetId,
          mutationTicket.colIndex,
        ),
      )
      set(activeFilterSortMutationAtom, null)
      return
    }

    const entrypointTicket = get(activeFilterSortEntrypointAtom)
    const entrypointState = get(filterSortEntrypointStateBackingAtom)
    if (
      entrypointTicket === null ||
      entrypointState.status !== 'refresh-failed' ||
      entrypointState.operationId !== entrypointTicket.operationId ||
      entrypointState.requestId !== entrypointTicket.requestId
    ) {
      return
    }
    const ownsTicket = (): boolean => get(activeFilterSortEntrypointAtom) === entrypointTicket
    // The retry replays the frozen ticket's captured sheet regardless of
    // current selection: authority drift does not gate this path (HEAD had
    // no authority check here). Only ticket ownership (a superseding
    // dispatch) still gates.
    const captured = captureRetryFilterSortRefreshInput(input)
    if (!ownsTicket()) return
    if (get(filterSortEntrypointStateBackingAtom) !== entrypointState) return
    if (captured.kind === 'invalid') return
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('refreshing', entrypointTicket),
    )
    if (!ownsTicket()) return
    const refreshResult = await runBoundedOperation(
      () => captured.refreshProjection(entrypointTicket.target.sheetId),
      captured.timeoutMs,
    )
    if (!ownsTicket()) return
    if (refreshResult.kind === 'timeout') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          entrypointTicket,
          refreshFailureError(FILTER_SORT_REFRESH_TIMEOUT_ERROR),
        ),
      )
      return
    }
    if (refreshResult.kind === 'rejected') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          entrypointTicket,
          refreshFailureError(refreshResult.error),
        ),
      )
      return
    }
    if (!set(releaseHistoryProducerReservationAtom, entrypointTicket.historyReservation)) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          entrypointTicket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', entrypointTicket))
    set(activeFilterSortEntrypointAtom, null)
  },
)
retryFilterSortRefreshAtom.debugLabel = 'spreadsheet.filterSort.retryRefresh'

export const notifyActiveSheetChangedAtom = atom(
  (get) => get(filterDropdownAtom),
  (get, set, nextSheetId: string | null) => {
    const dropdown = get(filterDropdownAtom)
    if (dropdown.status !== 'open' || dropdown.sheetId === nextSheetId) return
    // A sheet-change notification cannot cancel an already-sent request.
    if (!get(filterSortCanCloseAtom)) return
    set(closeFilterDropdownAtom)
  },
)
notifyActiveSheetChangedAtom.debugLabel = 'spreadsheet.filterSort.notifyActiveSheet'

// ===========================================================================
// Engine physical sort (design-engine-sort S5 / S6 / §10, parity #29)
//
// `runPhysicalSortAtom` is the ONLY sort command. It reorders engine DATA
// through the host `sortRange` port with host-orchestrated undo. There is no
// display-permutation fallback any more (#24): a host without `sortRange`
// simply has no sort — the command reports an `unsupported` diagnostic and
// hosts hide/disable the sort entrypoints off `sortRangeSupportedAtom`.
// It still shares the single backend lane (`activeFilterSort*`) with the
// filter dropdown so a filter mutation and a sort never overlap.
// ===========================================================================

/**
 * Fail-closed reason surfaced when the host backend exposes no `sortRange`
 * port. There is no display-permutation fallback (#24) — sorting simply does
 * not exist for that host, and its sort entrypoints stay hidden/disabled.
 */
export const PHYSICAL_SORT_CAPABILITY_ERROR =
  'Sort is unavailable because this workbook backend cannot reorder data.'

/** Structured-reject code → user-readable prompt (design §3/§5). */
export const PHYSICAL_SORT_REJECTION_MESSAGES: Readonly<
  Record<PhysicalSortDiagnosticCode, string>
> = Object.freeze({
  unsupported: PHYSICAL_SORT_CAPABILITY_ERROR,
  'invalid-range': 'Sort could not run: the sort range is invalid.',
  'empty-keys': 'Sort could not run: no sort column was provided.',
  'key-out-of-range': 'Sort could not run: the sort column is outside the sorted range.',
  'spill-in-range':
    'Sort could not run: the range overlaps a spilled array. Move or clear the array first.',
  'invalid-payload': 'Sort could not run: the sort request was malformed.',
  'source-too-large': 'Sort could not run: the range is too large to sort.',
  'merge-in-range':
    'Sort could not run: the range contains merged cells. Unmerge them before sorting.',
})

export function physicalSortRejectionMessage(
  code: PhysicalSortDiagnosticCode,
  fallback?: string,
): string {
  return PHYSICAL_SORT_REJECTION_MESSAGES[code] ?? fallback ?? 'Sort could not run.'
}

const sortRangeCapabilityBackingAtom = atom<boolean>(false)
sortRangeCapabilityBackingAtom.debugLabel = 'spreadsheet.sort.capabilityBacking'

/** Read-only witness of the physical-sort `sortRange` port (captured on dispatch). */
export const sortRangeSupportedAtom: Atom<boolean> = atom((get) =>
  get(sortRangeCapabilityBackingAtom),
)
sortRangeSupportedAtom.debugLabel = 'spreadsheet.sort.supported'

function readSortRangePort(
  source: PhysicalSortControllerPort,
): PhysicalSortControllerPort['sortRange'] {
  try {
    const port = source?.sortRange
    return typeof port === 'function' ? port : undefined
  } catch {
    return undefined
  }
}

/** Captures the `sortRange` capability witness without dispatching. */
export const captureSortRangeCapabilityAtom = atom(
  null,
  (_get, set, source: PhysicalSortControllerPort) => {
    set(sortRangeCapabilityBackingAtom, readSortRangePort(source) !== undefined)
  },
)
captureSortRangeCapabilityAtom.debugLabel = 'spreadsheet.sort.captureCapability'

const physicalSortDiagnosticBackingAtom = atom<PhysicalSortDiagnostic | null>(null)
physicalSortDiagnosticBackingAtom.debugLabel = 'spreadsheet.sort.diagnosticBacking'

/** Read-only last physical-sort rejection, user-readable. Cleared on the next dispatch. */
export const physicalSortDiagnosticAtom: Atom<PhysicalSortDiagnostic | null> = atom((get) =>
  get(physicalSortDiagnosticBackingAtom),
)
physicalSortDiagnosticAtom.debugLabel = 'spreadsheet.sort.diagnostic'

export const clearPhysicalSortDiagnosticAtom = atom(null, (_get, set) => {
  set(physicalSortDiagnosticBackingAtom, null)
})
clearPhysicalSortDiagnosticAtom.debugLabel = 'spreadsheet.sort.clearDiagnostic'

type CapturedPhysicalSortRange =
  | { readonly kind: 'range'; readonly value: CellRange }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }

type CapturedPhysicalSortTarget =
  | { readonly kind: 'selection' }
  | { readonly kind: 'explicit'; readonly value: FilterSortEntrypointTarget }
  | { readonly kind: 'invalid' }

type CapturedRunPhysicalSortInput =
  | {
      readonly kind: 'captured'
      readonly sourceWitness: PhysicalSortControllerPort
      readonly transport: PhysicalSortControllerPort['sortRange']
      readonly entrypoint: RunPhysicalSortInput['entrypoint']
      readonly direction: RunPhysicalSortInput['direction']
      readonly range: CapturedPhysicalSortRange
      readonly target: CapturedPhysicalSortTarget
      readonly refreshProjection: RunPhysicalSortInput['refreshProjection']
      readonly timeoutMs: number | null
    }
  | { readonly kind: 'invalid' }

/**
 * Consume every caller-owned getter once and detach all nested range/target
 * fields. A later reservation notification or async boundary therefore cannot
 * change the operation's authority, transport, payload, refresh, or deadline.
 */
function captureRunPhysicalSortInput(input: RunPhysicalSortInput): CapturedRunPhysicalSortInput {
  try {
    const sourceWitness = input.source
    let transport: PhysicalSortControllerPort['sortRange']
    try {
      transport = sourceWitness?.sortRange
    } catch {
      transport = undefined
    }
    const entrypoint = input.entrypoint
    const direction = input.direction
    const rangeValue = input.range
    const targetValue = input.target
    const refreshProjection = input.refreshProjection
    const timeoutMs = snapshotTimeoutMs(input.timeoutMs)

    let range: CapturedPhysicalSortRange
    if (rangeValue === null) {
      range = Object.freeze({ kind: 'absent' })
    } else if (typeof rangeValue !== 'object') {
      range = Object.freeze({ kind: 'invalid' })
    } else {
      const rowStart = rangeValue.rowStart
      const rowEnd = rangeValue.rowEnd
      const colStart = rangeValue.colStart
      const colEnd = rangeValue.colEnd
      if (
        !Number.isSafeInteger(rowStart) ||
        !Number.isSafeInteger(rowEnd) ||
        !Number.isSafeInteger(colStart) ||
        !Number.isSafeInteger(colEnd)
      ) {
        range = Object.freeze({ kind: 'invalid' })
      } else {
        range = Object.freeze({
          kind: 'range',
          value: Object.freeze({
            rowStart: Math.min(rowStart, rowEnd),
            rowEnd: Math.max(rowStart, rowEnd),
            colStart: Math.min(colStart, colEnd),
            colEnd: Math.max(colStart, colEnd),
          }),
        })
      }
    }

    let target: CapturedPhysicalSortTarget
    if (targetValue === undefined) {
      target = Object.freeze({ kind: 'selection' })
    } else if (typeof targetValue !== 'object' || targetValue === null) {
      target = Object.freeze({ kind: 'invalid' })
    } else {
      const sheetId = targetValue.sheetId
      const colIndex = targetValue.colIndex
      target =
        typeof sheetId === 'string' &&
        sheetId.length > 0 &&
        Number.isSafeInteger(colIndex) &&
        colIndex >= 0
          ? Object.freeze({
              kind: 'explicit',
              value: Object.freeze({ sheetId, colIndex }),
            })
          : Object.freeze({ kind: 'invalid' })
    }

    return Object.freeze({
      kind: 'captured',
      sourceWitness,
      transport,
      entrypoint,
      direction,
      range,
      target,
      refreshProjection,
      timeoutMs,
    })
  } catch {
    return Object.freeze({ kind: 'invalid' })
  }
}

function isValidSortRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowEnd >= range.rowStart &&
    range.colEnd >= range.colStart
  )
}

function sheetHasActiveFilterRules(get: Getter, sheetId: string): boolean {
  const state = get(filterSortStateAtom)[sheetId]
  return state !== undefined && state.rules.length > 0
}

type PhysicalSortAcknowledgement =
  | {
      readonly kind: 'applied'
      readonly movedRows: number
      readonly revision: HistoryEntry['projectionRevision']
      readonly affectedRange: CellRange
    }
  | {
      readonly kind: 'rejected'
      readonly code: SortRangeRejectionCode
      readonly message?: string
      readonly anchor?: string
    }
  | { readonly kind: 'invalid' }

function isSortRangeRejectionCode(value: unknown): value is SortRangeRejectionCode {
  return (
    value === 'invalid-range' ||
    value === 'empty-keys' ||
    value === 'key-out-of-range' ||
    value === 'spill-in-range' ||
    value === 'invalid-payload' ||
    value === 'source-too-large' ||
    value === 'merge-in-range'
  )
}

function sameSortRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

/**
 * Correlate and snapshot the untrusted sort ACK exactly once. The returned
 * object contains no host-owned getters, so later history/projection writes
 * cannot be changed by a second read or a re-entrant Proxy.
 */
function classifyPhysicalSortAcknowledgement(
  value: unknown,
  sheetId: string,
  requestId: ProjectionRequestId,
  requestedRange: CellRange,
): PhysicalSortAcknowledgement {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { kind: 'invalid' }
    }
    const result = value as Record<PropertyKey, unknown>
    const acknowledgementSheetId = result.sheetId
    const acknowledgementRequestId = result.requestId
    const applied = result.applied
    const kind = result.kind
    if (acknowledgementSheetId !== sheetId || acknowledgementRequestId !== requestId) {
      return { kind: 'invalid' }
    }
    if (applied === false) {
      const code = result.code
      const message = result.message
      const anchor = result.anchor
      if (
        kind !== 'sort-range-not-applied' ||
        !isSortRangeRejectionCode(code) ||
        (message !== undefined && typeof message !== 'string') ||
        (anchor !== undefined && typeof anchor !== 'string')
      ) {
        return { kind: 'invalid' }
      }
      return Object.freeze({
        kind: 'rejected',
        code,
        ...(message === undefined ? {} : { message }),
        ...(anchor === undefined ? {} : { anchor }),
      })
    }
    const movedRows = result.movedRows
    const movedCells = result.movedCells
    if (
      applied !== true ||
      kind !== 'sort-range' ||
      !Number.isSafeInteger(movedRows) ||
      (movedRows as number) < 0 ||
      !Number.isSafeInteger(movedCells) ||
      (movedCells as number) < 0
    ) {
      return { kind: 'invalid' }
    }
    const affectedRange = result.affectedRange
    const revision = result.revision
    if (typeof affectedRange !== 'object' || affectedRange === null) {
      return { kind: 'invalid' }
    }
    const affectedRangeRecord = affectedRange as Record<PropertyKey, unknown>
    const rowStart = affectedRangeRecord.rowStart
    const rowEnd = affectedRangeRecord.rowEnd
    const colStart = affectedRangeRecord.colStart
    const colEnd = affectedRangeRecord.colEnd
    if (
      !Number.isSafeInteger(rowStart) ||
      !Number.isSafeInteger(rowEnd) ||
      !Number.isSafeInteger(colStart) ||
      !Number.isSafeInteger(colEnd)
    ) {
      return { kind: 'invalid' }
    }
    const range: CellRange = Object.freeze({
      rowStart: rowStart as number,
      rowEnd: rowEnd as number,
      colStart: colStart as number,
      colEnd: colEnd as number,
    })
    if (
      !isValidSortRange(range) ||
      !sameSortRange(range, requestedRange) ||
      !isValidProjectionRevision(revision)
    ) {
      return { kind: 'invalid' }
    }
    return Object.freeze({
      kind: 'applied',
      movedRows: movedRows as number,
      revision,
      affectedRange: range,
    })
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * Excluded rows (0-based SOURCE space) the host hands the engine so they stay
 * in place while the visible rows reorder. The union of two UI-core canonical
 * facts, both clipped to the sort range:
 *   1. manually hidden rows (`viewportHiddenAtom`);
 *   2. filter-hidden rows (`viewportFilterHiddenAtom`).
 *
 * Both are now READ, not inferred. The predecessor derived the filter half by
 * looking for gaps in the source-row echoes the compacted projection carried,
 * which could only ever judge the rows the current viewport happened to cover
 * — a filtered row below the fold stayed in the reorder set and moved when
 * Excel would have pinned it (the documented v1 bounded-window gap). The
 * host's whole-column scan now
 * answers for the whole extent, so that gap is closed rather than narrowed, and
 * the two halves are finally the same shape.
 *
 * Summary-row pinning needs cell reads UI core does not own and remains a known
 * v1 gap (design §6.1).
 */
export function buildSortExcludedRows(get: Getter, sheetId: string, range: CellRange): number[] {
  const excluded = new Set<number>()
  const clip = (rows: readonly number[]): void => {
    for (const row of rows) {
      if (row >= range.rowStart && row <= range.rowEnd) excluded.add(row)
    }
  }
  clip(getHiddenRowsForSheet(get(viewportHiddenAtom), sheetId))
  // Guarded on the rules, not just on the set: a stale set left behind by a
  // cleared filter must never pin rows the user can see.
  if (sheetHasActiveFilterRules(get, sheetId)) {
    clip(getFilterHiddenRowsForSheet(get(viewportFilterHiddenAtom), sheetId))
  }
  return [...excluded].sort((a, b) => a - b)
}

export const runPhysicalSortAtom = atom(
  null,
  async (get, set, input: RunPhysicalSortInput): Promise<void> => {
    // Single backend lane: a filter mutation and a physical sort must never
    // overlap on the same sheet transport.
    if (get(activeFilterSortEntrypointAtom) !== null) return
    if (get(activeFilterSortMutationAtom) !== null) return
    // A live dropdown draft owns the same lane; stay inert until it closes.
    if (get(filterDropdownAtom).status === 'open') return

    const captured = captureRunPhysicalSortInput(input)
    // Recheck both lanes after consuming caller-owned getters. A getter may
    // synchronously dispatch a replacement command and then return or throw;
    // this superseded invocation must not publish a diagnostic/capability
    // value or a blocked state over the replacement ticket.
    if (get(activeFilterSortEntrypointAtom) !== null) return
    if (get(activeFilterSortMutationAtom) !== null) return
    if (captured.kind === 'invalid') {
      const message = physicalSortRejectionMessage('invalid-payload')
      set(physicalSortDiagnosticBackingAtom, Object.freeze({ code: 'invalid-payload', message }))
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', { attempt: 1, error: message }),
      )
      return
    }

    const portAvailable = typeof captured.transport === 'function'
    set(sortRangeCapabilityBackingAtom, portAvailable)

    // The dropdown supplies its own target (its column, not the selection's);
    // the toolbar / menu omit it and stay selection-authoritative.
    const explicitTarget = captured.target.kind === 'explicit' ? captured.target.value : null
    const target =
      captured.target.kind === 'selection' ? resolveFilterSortEntrypointTarget(get) : explicitTarget
    const range = captured.range.kind === 'range' ? captured.range.value : null
    const rangeIsValid = range !== null && isValidSortRange(range)
    const columnInRange =
      rangeIsValid &&
      target !== null &&
      target.colIndex >= range!.colStart &&
      target.colIndex <= range!.colEnd

    const directionIsValid = captured.direction === 'asc' || captured.direction === 'desc'
    const entrypointIsValid =
      captured.entrypoint === 'toolbar' || captured.entrypoint === 'menu-bar'
    const payloadIsValid =
      captured.target.kind !== 'invalid' &&
      captured.range.kind !== 'invalid' &&
      typeof captured.refreshProjection === 'function' &&
      captured.timeoutMs !== null

    // Fail-closed, no fallback (#24): a host without `sortRange` cannot sort.
    // Filter-active sheets DO sort physically — the filtered-out rows ride in
    // `excludedRows` (design §2.2 / §6.1) so they stay in place.
    const rejection: PhysicalSortDiagnosticCode | null = !portAvailable
      ? 'unsupported'
      : !payloadIsValid || !directionIsValid || !entrypointIsValid
        ? 'invalid-payload'
        : target === null
          ? 'empty-keys'
          : !rangeIsValid || range === null
            ? 'invalid-range'
            : !columnInRange
              ? 'key-out-of-range'
              : null

    if (
      rejection !== null ||
      typeof captured.transport !== 'function' ||
      target === null ||
      range === null ||
      captured.timeoutMs === null
    ) {
      const code = rejection ?? 'invalid-range'
      const message = physicalSortRejectionMessage(code)
      set(physicalSortDiagnosticBackingAtom, Object.freeze({ code, message }))
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: entrypointIsValid ? captured.entrypoint : null,
          target,
          direction: directionIsValid ? captured.direction : null,
          attempt: 1,
          error: message,
        }),
      )
      return
    }

    const operationId = nextFilterSortOperationId(get(filterSortEntrypointOperationIdStateAtom))
    const requestId = nextFilterSortRequestId(get(filterSortSyncTicketAtom))
    if (operationId === null || requestId === null) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: captured.entrypoint,
          target,
          direction: captured.direction,
          attempt: 1,
          error: 'Filter and sort command identity space is exhausted.',
        }),
      )
      return
    }

    const excludedRows = Object.freeze(buildSortExcludedRows(get, target.sheetId, range))
    const key = Object.freeze({ col: target.colIndex, direction: captured.direction })
    const keys = Object.freeze([key])
    const request: SortRangeRequest = Object.freeze({
      kind: 'sort-range',
      sheetId: target.sheetId,
      range,
      keys,
      excludedRows,
      requestId,
    })
    const previous = get(filterSortEntrypointStateBackingAtom)
    const attempt = nextEntrypointAttempt(previous, captured.entrypoint, target, captured.direction)
    const targetAuthority =
      captured.target.kind === 'explicit' ? ('explicit' as const) : ('selection' as const)
    // An explicit dropdown target is deliberately independent of selection.
    const selectionWitness =
      targetAuthority === 'selection' ? get(selectionAuthorityWitnessAtom) : null
    const workspaceWitness = get(workspaceActiveSheetAuthorityWitnessAtom)

    // Request, excluded-row snapshot, authority witnesses, caller transport,
    // refresh callback, and deadline are all finalized before lane acquisition.
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: captured.entrypoint,
          target,
          direction: captured.direction,
          attempt: 1,
          error: FILTER_SORT_PENDING_ERROR,
        }),
      )
      return
    }

    const ticket: PhysicalSortTicket = Object.freeze({
      kind: 'physical-sort',
      operationId,
      requestId,
      entrypoint: captured.entrypoint,
      target,
      direction: captured.direction,
      attempt,
      request,
      sourceWitness: captured.sourceWitness,
      transport: captured.transport,
      refreshProjection: captured.refreshProjection,
      timeoutMs: captured.timeoutMs,
      selectionWitness,
      workspaceWitness,
      targetAuthority,
      historyReservation,
    })
    set(filterSortEntrypointOperationIdStateAtom, operationId)
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortEntrypointAtom, ticket)
    set(physicalSortDiagnosticBackingAtom, null)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('pending', ticket))

    const ownsTicket = (): boolean => get(activeFilterSortEntrypointAtom) === ticket
    const ownsAuthority = (): boolean => entrypointTicketAuthorityIsCurrent(get, ticket)
    // Once the transport has been dispatched, authority drift never blocks
    // settling or leaks the lane (unlike the dropdown-mutation lane): a
    // well-formed matching ACK must still be processed to completion. The
    // authority gate below is only valid BEFORE dispatch.
    const releaseUnsentStaleAuthority = (): void => {
      if (!ownsTicket()) return
      if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
        set(
          filterSortEntrypointStateBackingAtom,
          entrypointStateForTicket(
            'outcome-unknown',
            ticket,
            outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
          ),
        )
        return
      }
      if (!ownsTicket()) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('stale', ticket, FILTER_SORT_STALE_OPERATION_ERROR),
      )
      set(activeFilterSortEntrypointAtom, null)
    }

    // Publish the reservation before transport launch so same-tick re-entry
    // is inert; re-set the owned pending value to flush it (see the display
    // entrypoint for the same Einfach deferral note).
    await Promise.resolve()
    if (!ownsTicket()) return
    // No backend effect is possible yet, so authority drift at this boundary
    // can release the exact reservation and clear only this unsent ticket.
    if (!ownsAuthority()) {
      releaseUnsentStaleAuthority()
      return
    }
    set(filterSortEntrypointStateBackingAtom, get(filterSortEntrypointStateBackingAtom))

    const transportResult = await runBoundedOperation(
      () => ticket.transport.call(ticket.sourceWitness, ticket.request),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (transportResult.kind === 'timeout') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_TRANSPORT_TIMEOUT_ERROR),
        ),
      )
      return
    }
    if (transportResult.kind === 'rejected') {
      // A transport-level rejection is positive proof nothing was sent to the
      // backend (matches the pre-refactor catch-block contract): release the
      // lane so the user can retry the mutation.
      set(activeFilterSortEntrypointAtom, null)
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(errorMessage(transportResult.error)),
        ),
      )
      return
    }

    const acknowledgement = classifyPhysicalSortAcknowledgement(
      transportResult.value,
      ticket.request.sheetId,
      ticket.requestId,
      ticket.request.range,
    )
    // Host getters can be re-entrant. Once transport began, authority drift
    // no longer gates a well-formed matching ACK — it must still be
    // processed to completion (history push, projection refresh, lane
    // release). Only ticket ownership (a superseding dispatch) still gates.
    if (!ownsTicket()) return
    if (acknowledgement.kind === 'invalid') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }

    // A strictly correlated structured rejection is positive proof that no
    // backend mutation or undo record exists. Release only this ticket's
    // reservation before clearing it; a failed exact release is uncertainty,
    // never permission to clear another producer's lane.
    if (acknowledgement.kind === 'rejected') {
      if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
        set(
          filterSortEntrypointStateBackingAtom,
          entrypointStateForTicket(
            'outcome-unknown',
            ticket,
            outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
          ),
        )
        return
      }
      if (!ownsTicket()) return
      const message = physicalSortRejectionMessage(acknowledgement.code, acknowledgement.message)
      set(
        physicalSortDiagnosticBackingAtom,
        Object.freeze({
          code: acknowledgement.code,
          message,
          ...(acknowledgement.anchor === undefined ? {} : { anchor: acknowledgement.anchor }),
        }),
      )
      set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('error', ticket, message))
      set(activeFilterSortEntrypointAtom, null)
      return
    }

    // Applied. A no-op (movedRows === 0) resolves successfully but records NO
    // history entry — an identity sort is not an undo step (design §7).
    if (
      acknowledgement.movedRows > 0 &&
      !set(pushReservedHistoryAtom, {
        reservation: ticket.historyReservation,
        entry: {
          transactionId: `range-sort-${ticket.target.sheetId}-${ticket.requestId}`,
          kind: 'range.sort',
          sheetId: ticket.target.sheetId,
          projectionRevision: acknowledgement.revision,
          affectedRange: acknowledgement.affectedRange,
        },
      })
    ) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }
    if (!ownsTicket()) return
    set(physicalSortDiagnosticBackingAtom, null)
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('local-acknowledged', ticket),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('refreshing', ticket))
    const refreshResult = await runBoundedOperation(
      () => ticket.refreshProjection(ticket.target.sheetId),
      ticket.timeoutMs,
    )
    if (!ownsTicket()) return
    if (refreshResult.kind === 'timeout') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          ticket,
          refreshFailureError(FILTER_SORT_REFRESH_TIMEOUT_ERROR),
        ),
      )
      return
    }
    if (refreshResult.kind === 'rejected') {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'refresh-failed',
          ticket,
          refreshFailureError(refreshResult.error),
        ),
      )
      return
    }
    if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR),
        ),
      )
      return
    }
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', ticket))
    set(activeFilterSortEntrypointAtom, null)
  },
)
runPhysicalSortAtom.debugLabel = 'spreadsheet.sort.runPhysical'
