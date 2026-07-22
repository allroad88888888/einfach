import { atom } from '@einfach/core'
import type { Atom, Getter } from '@einfach/core'
import type {
  ProjectionRequestId,
  SortRangeRejectionCode,
  SortRangeRequest,
  SortRangeResult,
} from '../backend/types'
import type { CellRange } from '../shared'
import { nextHistoryTransactionId, pushHistoryAtom, type HistoryEntry } from '../history'
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
export const FILTER_SORT_REAPPLY_NO_RULES_ERROR =
  'Reapply needs an active filter on this sheet.'

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
}

interface FilterSortEntrypointTicket {
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
  readonly next: FilterSortState
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
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
  const authorityIsCurrent =
    active === null ||
    (get(selectionAuthorityWitnessAtom) === active.selectionWitness &&
      get(workspaceActiveSheetAuthorityWitnessAtom) === active.workspaceWitness &&
      sameFilterSortTarget(target, active.target))
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
reconcileFilterSortRulesFromEngineAtom.debugLabel = 'spreadsheet.filterSort.reconcileRulesFromEngine'

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

/**
 * Filter-hidden source rows carried by a `setFilterSort` ACK, or `[]`.
 *
 * Defensive by construction: the acknowledgement crosses a host boundary, and
 * a malformed payload must degrade to "nothing hidden" (rules recorded, every
 * row painted) rather than hide rows on garbage. Entry-level sanitation is left
 * to `setViewportFilterHiddenRowsAtom`, which owns the canonical shape.
 */
function readAckHiddenRowIndices(acknowledgement: unknown): readonly number[] {
  try {
    const rows = (acknowledgement as { hiddenRowIndices?: unknown }).hiddenRowIndices
    return Array.isArray(rows) ? (rows as readonly number[]) : []
  } catch {
    return []
  }
}

/**
 * Push the ONE UI-core history entry that pairs with the ONE adapter
 * transaction record a filter apply / clear produced, gated on the backend's
 * `historyRecorded` verdict so the two undo stacks align entry-for-entry.
 *
 * The backend is the single decision-maker: it pushed a record iff the apply /
 * clear actually changed the committed filter, and only then does
 * `historyRecorded` read `true`. Recording here on a no-op (or on a legacy
 * backend that omits the field) would offset the stacks by one — every later
 * Ctrl+Z would then revert a step older than the UI believes — so a falsy
 * verdict pushes nothing. The entry carries no local-replay payload: undo/redo
 * restores the engine's owned filter through its own snapshot and the provider
 * re-hydrates the rules + hidden render caches from the engine afterwards.
 */
function recordFilterSortHistory(
  set: (atomToSet: typeof pushHistoryAtom, value: HistoryEntry) => boolean,
  acknowledgement: unknown,
  sheetId: string,
): void {
  let recorded = false
  let revision: unknown
  try {
    recorded = (acknowledgement as { historyRecorded?: unknown }).historyRecorded === true
    revision = (acknowledgement as { revision?: unknown }).revision
  } catch {
    return
  }
  if (!recorded) return
  set(pushHistoryAtom, {
    transactionId: nextHistoryTransactionId(),
    kind: 'filter.set',
    sheetId,
    projectionRevision: revision as HistoryEntry['projectionRevision'],
  })
}

export const runFilterSortMutationAtom = atom(
  null,
  async (get, set, input: RunFilterSortMutationInput): Promise<void> => {
    if (get(activeFilterSortMutationAtom) !== null) return
    // Toolbar/MenuBar and dropdown mutations target the same backend state.
    // Keep one transport lane so acknowledgements cannot commit in a
    // different order from the backend writes.
    if (get(activeFilterSortEntrypointAtom) !== null) return
    const dropdown = get(filterDropdownAtom)
    const draft = get(filterSortDraftAtom)
    const lifecycle = get(filterSortLifecycleAtom)
    if (
      dropdown.status !== 'open' ||
      input.sessionId !== draft.sessionId ||
      lifecycle.sessionId !== draft.sessionId ||
      dropdown.sheetId !== draft.sheetId ||
      dropdown.colIndex !== draft.colIndex ||
      lifecycle.status === 'pending' ||
      lifecycle.status === 'local-acknowledged' ||
      lifecycle.status === 'refreshing'
    ) {
      return
    }

    let execute: FilterSortControllerPort['setFilterSort']
    try {
      execute = input.source?.setFilterSort
    } catch {
      execute = undefined
    }
    if (typeof execute !== 'function') {
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
    const derived = deriveMutationState(current, draft, input.intent)
    if (derived.state === null) {
      set(filterSortErrorBackingAtom, derived.error ?? FILTER_SORT_INVALID_INPUT_ERROR)
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('blocked', draft.sessionId, sheetId, colIndex),
      )
      return
    }
    if (typeof input.refreshProjection !== 'function') {
      set(filterSortErrorBackingAtom, FILTER_SORT_INVALID_INPUT_ERROR)
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
    const ticket: FilterSortMutationTicket = Object.freeze({
      sessionId: draft.sessionId,
      requestId,
      sheetId,
      colIndex,
      next: normalizeState(derived.state),
    })
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortMutationAtom, ticket)
    set(filterSortErrorBackingAtom, '')
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('pending', ticket.sessionId, sheetId, colIndex, requestId),
    )

    const isCurrent = (): boolean => {
      const currentDropdown = get(filterDropdownAtom)
      const currentLifecycle = get(filterSortLifecycleAtom)
      return (
        get(activeFilterSortMutationAtom) === ticket &&
        currentDropdown.status === 'open' &&
        currentDropdown.sheetId === ticket.sheetId &&
        currentDropdown.colIndex === ticket.colIndex &&
        get(filterSortSessionIdAtom) === ticket.sessionId &&
        currentLifecycle.sessionId === ticket.sessionId &&
        currentLifecycle.requestId === ticket.requestId
      )
    }

    // Expose the reservation before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!isCurrent()) return
    // Einfach defers the first flush of an async write until a post-await setter runs.
    // Re-set the owned lifecycle value to publish the already-reserved pending state
    // before the transport can settle, without introducing framework-local state.
    set(filterSortLifecycleBackingAtom, get(filterSortLifecycleAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await execute.call(input.source, {
        kind: 'set-filter-sort',
        sheetId,
        rules: ticket.next.rules,
        requestId,
        // Excel parity: an apply / clear that actually changes the committed
        // filter is undoable. The backend judges "changed" and echoes its
        // verdict in `historyRecorded`, which we mirror below with one paired
        // entry (`recordFilterSortHistory`) so the stacks stay aligned.
        recordHistory: true,
      })
    } catch (error) {
      if (!isCurrent()) return
      set(filterSortErrorBackingAtom, outcomeUnknownError(errorMessage(error)))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }

    if (!isCurrent()) return
    let acknowledgementMatches = false
    try {
      acknowledgementMatches =
        typeof acknowledgement === 'object' &&
        acknowledgement !== null &&
        (acknowledgement as { sheetId?: unknown }).sheetId === sheetId &&
        (acknowledgement as { requestId?: unknown }).requestId === requestId
    } catch {
      acknowledgementMatches = false
    }
    if (!acknowledgementMatches) {
      set(filterSortErrorBackingAtom, outcomeUnknownError(FILTER_SORT_ACKNOWLEDGEMENT_ERROR))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('outcome-unknown', ticket.sessionId, sheetId, colIndex, requestId),
      )
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
    // A host that returns no `hiddenRowIndices` CLEARS the set instead of
    // keeping a stale one: after the rules change, yesterday's answer is not a
    // conservative fallback, it hides the wrong rows.
    set(setViewportFilterHiddenRowsAtom, {
      sheetId,
      rows: readAckHiddenRowIndices(acknowledgement),
    })
    // Excel-parity undo: pair the committed apply / clear with one history
    // entry iff the backend recorded a matching transaction (`historyRecorded`).
    recordFilterSortHistory(set, acknowledgement, sheetId)
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
    if (!isCurrent()) return
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('refreshing', ticket.sessionId, sheetId, colIndex, requestId),
    )
    try {
      await input.refreshProjection(sheetId)
    } catch (error) {
      if (!isCurrent()) return
      set(filterSortErrorBackingAtom, refreshFailureError(error))
      set(
        filterSortLifecycleBackingAtom,
        lifecycleFor('refresh-failed', ticket.sessionId, sheetId, colIndex, requestId),
      )
      return
    }
    if (!isCurrent()) return
    set(activeFilterSortMutationAtom, null)
    set(filterSortErrorBackingAtom, '')
    set(
      filterSortLifecycleBackingAtom,
      lifecycleFor('editing', ticket.sessionId, sheetId, colIndex),
    )
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

/**
 * Re-run the active sheet's committed filter rules and re-commit the answer.
 *
 * NOT in the undo stack, and no `pushHistoryAtom`. Reapply is an IDENTITY
 * re-run of the already-committed rules — it never changes WHAT is filtered,
 * only which rows currently satisfy it — so it is not an undo step: a Reapply
 * entry would be a Ctrl+Z whose counterpart the user never issued. It passes
 * `recordHistory: false` so the backend records nothing either (a `true` there
 * would let the engine's before≠after verdict push a record UI core never
 * pairs, skewing the stacks). This is DISTINCT from Apply / Clear, which since
 * the 2026-07-22 filter-undo flip ARE undoable (`runFilterSortMutationAtom`
 * pairs a `filter.set` entry on the backend's `historyRecorded` verdict) —
 * matching Excel, where applying or clearing an AutoFilter is Ctrl+Z-able.
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
    let available = false
    try {
      available = typeof input.source?.setFilterSort === 'function'
    } catch {
      available = false
    }
    set(filterSortCapabilityBackingAtom, available)
    if (!available) return
    if (input.entrypoint !== 'toolbar' && input.entrypoint !== 'menu-bar') return
    if (typeof input.refreshProjection !== 'function') return
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
          entrypoint: input.entrypoint,
          target,
          attempt: 1,
          error: 'Filter and sort command identity space is exhausted.',
        }),
      )
      return
    }

    const previous = get(filterSortEntrypointStateBackingAtom)
    const ticket: FilterSortEntrypointTicket = Object.freeze({
      operationId,
      requestId,
      entrypoint: input.entrypoint,
      target,
      direction: null,
      attempt: nextEntrypointAttempt(previous, input.entrypoint, target, null),
      // Identity: Reapply never changes what is filtered, only which rows
      // currently satisfy it. The committed rules go out and come back.
      next: normalizeState(committed),
      selectionWitness: get(selectionAuthorityWitnessAtom),
      workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
    })
    set(filterSortEntrypointOperationIdStateAtom, operationId)
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortEntrypointAtom, ticket)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('pending', ticket))

    const ownsTicket = (): boolean => get(activeFilterSortEntrypointAtom) === ticket

    // Publish the reservation before transport launch so same-tick re-entry is
    // inert; re-set the owned pending value to flush it (Einfach defers the
    // first flush of an async write until a post-await setter runs).
    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, get(filterSortEntrypointStateBackingAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await input.source.setFilterSort!.call(input.source, {
        kind: 'set-filter-sort',
        sheetId: target.sheetId,
        rules: ticket.next.rules,
        requestId,
        // Reapply is NEVER an undo step (identity re-run of committed rules):
        // it pushes no history entry here, so it must tell the backend not to
        // record one either, or the two stacks would skew by one.
        recordHistory: false,
      })
    } catch (error) {
      if (!ownsTicket()) return
      set(activeFilterSortEntrypointAtom, null)
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(errorMessage(error)),
        ),
      )
      return
    }

    if (!ownsTicket()) return
    let acknowledgementMatches = false
    try {
      acknowledgementMatches =
        typeof acknowledgement === 'object' &&
        acknowledgement !== null &&
        (acknowledgement as { sheetId?: unknown }).sheetId === target.sheetId &&
        (acknowledgement as { requestId?: unknown }).requestId === requestId
    } catch {
      acknowledgementMatches = false
    }
    if (!acknowledgementMatches) {
      set(activeFilterSortEntrypointAtom, null)
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
      sheetId: target.sheetId,
      rows: readAckHiddenRowIndices(acknowledgement),
    })
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('local-acknowledged', ticket),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('refreshing', ticket))
    try {
      await input.refreshProjection(target.sheetId)
    } catch (error) {
      if (!ownsTicket()) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('refresh-failed', ticket, refreshFailureError(error)),
      )
      return
    }
    if (!ownsTicket()) return
    set(activeFilterSortEntrypointAtom, null)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', ticket))
  },
)
reapplyFilterAtom.debugLabel = 'spreadsheet.filterSort.reapply'

export const retryFilterSortRefreshAtom = atom(
  null,
  async (get, set, input: RetryFilterSortRefreshInput): Promise<void> => {
    if (typeof input.refreshProjection !== 'function') return

    const mutationTicket = get(activeFilterSortMutationAtom)
    const mutationLifecycle = get(filterSortLifecycleAtom)
    if (
      mutationTicket !== null &&
      mutationLifecycle.status === 'refresh-failed' &&
      mutationLifecycle.sessionId === mutationTicket.sessionId &&
      mutationLifecycle.requestId === mutationTicket.requestId
    ) {
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
      try {
        await input.refreshProjection(mutationTicket.sheetId)
      } catch (error) {
        if (get(activeFilterSortMutationAtom) !== mutationTicket) return
        set(filterSortErrorBackingAtom, refreshFailureError(error))
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
      if (get(activeFilterSortMutationAtom) !== mutationTicket) return
      set(activeFilterSortMutationAtom, null)
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
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('refreshing', entrypointTicket),
    )
    try {
      await input.refreshProjection(entrypointTicket.target.sheetId)
    } catch (error) {
      if (get(activeFilterSortEntrypointAtom) !== entrypointTicket) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('refresh-failed', entrypointTicket, refreshFailureError(error)),
      )
      return
    }
    if (get(activeFilterSortEntrypointAtom) !== entrypointTicket) return
    set(activeFilterSortEntrypointAtom, null)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', entrypointTicket))
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

function normalizeSortRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

function sanitizeExplicitSortTarget(
  target: FilterSortEntrypointTarget | undefined,
): FilterSortEntrypointTarget | null {
  if (!target || typeof target.sheetId !== 'string' || target.sheetId.length === 0) return null
  if (!Number.isSafeInteger(target.colIndex) || target.colIndex < 0) return null
  return Object.freeze({ sheetId: target.sheetId, colIndex: target.colIndex })
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

    const port = readSortRangePort(input.source)
    set(sortRangeCapabilityBackingAtom, port !== undefined)

    // The dropdown supplies its own target (its column, not the selection's);
    // the toolbar / menu omit it and stay selection-authoritative.
    const target =
      sanitizeExplicitSortTarget(input.target) ?? resolveFilterSortEntrypointTarget(get)
    const range = input.range === null ? null : normalizeSortRange(input.range)
    const rangeIsValid = range !== null && isValidSortRange(range)
    const columnInRange =
      rangeIsValid &&
      target !== null &&
      target.colIndex >= range!.colStart &&
      target.colIndex <= range!.colEnd

    const directionIsValid = input.direction === 'asc' || input.direction === 'desc'
    const entrypointIsValid = input.entrypoint === 'toolbar' || input.entrypoint === 'menu-bar'

    // Fail-closed, no fallback (#24): a host without `sortRange` cannot sort.
    // Filter-active sheets DO sort physically — the filtered-out rows ride in
    // `excludedRows` (design §2.2 / §6.1) so they stay in place.
    const rejection: PhysicalSortDiagnosticCode | null =
      port === undefined
        ? 'unsupported'
        : !directionIsValid || !entrypointIsValid || typeof input.refreshProjection !== 'function'
          ? 'invalid-payload'
          : target === null
            ? 'empty-keys'
            : !rangeIsValid || range === null
              ? 'invalid-range'
              : !columnInRange
                ? 'key-out-of-range'
                : null

    if (rejection !== null || port === undefined || target === null || range === null) {
      const code = rejection ?? 'invalid-range'
      const message = physicalSortRejectionMessage(code)
      set(physicalSortDiagnosticBackingAtom, Object.freeze({ code, message }))
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: entrypointIsValid ? input.entrypoint : null,
          target,
          direction: directionIsValid ? input.direction : null,
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
          entrypoint: input.entrypoint,
          target,
          direction: input.direction,
          attempt: 1,
          error: 'Filter and sort command identity space is exhausted.',
        }),
      )
      return
    }

    const previous = get(filterSortEntrypointStateBackingAtom)
    const currentState = get(filterSortStateAtom)[target.sheetId] ?? EMPTY_FILTER_SORT_STATE
    const ticket: FilterSortEntrypointTicket = Object.freeze({
      operationId,
      requestId,
      entrypoint: input.entrypoint,
      target,
      direction: input.direction,
      attempt: nextEntrypointAttempt(previous, input.entrypoint, target, input.direction),
      // Identity — the physical path never commits sort directives; the field
      // only exists so the shared entrypoint ticket type is satisfied.
      next: normalizeState(currentState),
      selectionWitness: get(selectionAuthorityWitnessAtom),
      workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
    })
    set(filterSortEntrypointOperationIdStateAtom, operationId)
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortEntrypointAtom, ticket)
    set(physicalSortDiagnosticBackingAtom, null)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('pending', ticket))

    const ownsTicket = (): boolean => get(activeFilterSortEntrypointAtom) === ticket

    // Publish the reservation before transport launch so same-tick re-entry
    // is inert; re-set the owned pending value to flush it (see the display
    // entrypoint for the same Einfach deferral note).
    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, get(filterSortEntrypointStateBackingAtom))

    const request: SortRangeRequest = {
      kind: 'sort-range',
      sheetId: target.sheetId,
      range,
      keys: [{ col: target.colIndex, direction: input.direction }],
      excludedRows: buildSortExcludedRows(get, target.sheetId, range),
      requestId,
    }

    let result: SortRangeResult
    try {
      result = await port.call(input.source, request)
    } catch (error) {
      if (!ownsTicket()) return
      set(activeFilterSortEntrypointAtom, null)
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket(
          'outcome-unknown',
          ticket,
          outcomeUnknownError(errorMessage(error)),
        ),
      )
      return
    }

    if (!ownsTicket()) return

    // Structured rejection (a gated request resolves, it does NOT reject the
    // promise): nothing was written, no undo entry recorded, no history push.
    if (!result || result.applied === false) {
      const code: SortRangeRejectionCode = result ? result.code : 'invalid-payload'
      const message = physicalSortRejectionMessage(code, result?.message)
      set(activeFilterSortEntrypointAtom, null)
      set(
        physicalSortDiagnosticBackingAtom,
        Object.freeze({
          code,
          message,
          ...(result && result.anchor !== undefined ? { anchor: result.anchor } : {}),
        }),
      )
      set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('error', ticket, message))
      return
    }

    // Applied. A no-op (movedRows === 0) resolves successfully but records NO
    // history entry — an identity sort is not an undo step (design §7).
    if (result.movedRows > 0) {
      set(pushHistoryAtom, {
        transactionId: `range-sort-${target.sheetId}-${requestId}`,
        kind: 'range.sort',
        sheetId: target.sheetId,
        projectionRevision: result.revision ?? requestId,
        affectedRange: result.affectedRange ?? range,
      })
    }
    set(physicalSortDiagnosticBackingAtom, null)
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('local-acknowledged', ticket),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('refreshing', ticket))
    try {
      await input.refreshProjection(target.sheetId)
    } catch (error) {
      if (!ownsTicket()) return
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('refresh-failed', ticket, refreshFailureError(error)),
      )
      return
    }
    if (!ownsTicket()) return
    set(activeFilterSortEntrypointAtom, null)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('idle', ticket))
  },
)
runPhysicalSortAtom.debugLabel = 'spreadsheet.sort.runPhysical'
