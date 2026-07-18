import { atom } from '@einfach/core'
import type { Atom, Getter } from '@einfach/core'
import type { ProjectionRequestId } from '../backend/types'
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
  RunFilterSortEntrypointInput,
  RunFilterSortMutationInput,
  RetryFilterSortRefreshInput,
  SortDirection,
  SortDirective,
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

const EMPTY_FILTER_SORT_STATE: FilterSortState = Object.freeze({
  rules: Object.freeze([]),
  directives: Object.freeze([]),
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
  readonly direction: SortDirection
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
  return Object.freeze({
    rules: normalizeRules(state.rules),
    directives: Object.freeze(state.directives.map((directive) => Object.freeze({ ...directive }))),
  })
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

function prioritizeSortDirective(
  directives: readonly SortDirective[],
  directive: SortDirective,
): SortDirective[] {
  return [directive, ...directives.filter((item) => item.colIndex !== directive.colIndex)]
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

  if (intent.kind === 'sort') {
    return {
      state: {
        rules: current.rules,
        directives: prioritizeSortDirective(current.directives, {
          colIndex,
          direction: intent.direction,
        }),
      },
      error: null,
    }
  }
  if (intent.kind === 'clear-sort') {
    return {
      state: {
        rules: current.rules,
        directives: current.directives.filter((directive) => directive.colIndex !== colIndex),
      },
      error: null,
    }
  }
  if (intent.kind === 'clear-filter') {
    return {
      state: {
        rules: current.rules.filter((rule) => rule.colIndex !== colIndex),
        directives: current.directives,
      },
      error: null,
    }
  }
  if (intent.kind === 'clear-column') {
    return {
      state: {
        rules: current.rules.filter((rule) => rule.colIndex !== colIndex),
        directives: current.directives.filter((directive) => directive.colIndex !== colIndex),
      },
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

  return { state: { rules, directives: current.directives }, error: null }
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
  direction: SortDirection,
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
    const nextDirectives = sheetState.directives.filter(
      (directive) => directive.colIndex !== colIndex,
    )
    if (
      nextRules.length === sheetState.rules.length &&
      nextDirectives.length === sheetState.directives.length
    ) {
      return
    }
    set(
      filterSortStateBackingAtom,
      stateStoreWith(get(filterSortStateBackingAtom), sheetId, {
        rules: nextRules,
        directives: nextDirectives,
      }),
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
      stateStoreWith(get(filterSortStateBackingAtom), sheetId, {
        rules: nextRules,
        directives: sheetState.directives,
      }),
    )
  },
)
clearColumnFilterRulesAtom.debugLabel = 'spreadsheet.filterSort.clearColumnRules'

export const clearColumnSortAtom = atom(
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
    const nextDirectives = sheetState.directives.filter(
      (directive) => directive.colIndex !== colIndex,
    )
    if (nextDirectives.length === sheetState.directives.length) return
    set(
      filterSortStateBackingAtom,
      stateStoreWith(get(filterSortStateBackingAtom), sheetId, {
        rules: sheetState.rules,
        directives: nextDirectives,
      }),
    )
  },
)
clearColumnSortAtom.debugLabel = 'spreadsheet.filterSort.clearColumnSort'

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
        directives: ticket.next.directives,
        requestId,
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

export const runFilterSortEntrypointAtom = atom(
  null,
  async (get, set, input: RunFilterSortEntrypointInput): Promise<void> => {
    // Authority drift is not transport cancellation. An already-launched
    // request retains the single-lane ticket until its own settlement, even
    // while the derived projection reports stale for the captured target.
    if (get(activeFilterSortEntrypointAtom) !== null) return

    // The filter dropdown owns the same setFilterSort transport lane. Its
    // ticket remains active through local acknowledgement and projection
    // refresh, so a toolbar/menu command must stay inert for that full span.
    if (get(activeFilterSortMutationAtom) !== null) return

    // A Core-owned dropdown draft is a live editing session. Starting a
    // toolbar/menu operation beside it would leave the draft based on the
    // pre-command committed state, so entrypoints stay inert until it closes.
    if (get(filterDropdownAtom).status === 'open') return

    const target = resolveFilterSortEntrypointTarget(get)
    const previous = get(filterSortEntrypointStateBackingAtom)
    const directionIsValid = input.direction === 'asc' || input.direction === 'desc'
    const entrypointIsValid = input.entrypoint === 'toolbar' || input.entrypoint === 'menu-bar'
    let execute: FilterSortControllerPort['setFilterSort']
    try {
      execute = input.source?.setFilterSort
    } catch {
      execute = undefined
    }
    if (typeof execute !== 'function') {
      set(filterSortCapabilityBackingAtom, false)
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: entrypointIsValid ? input.entrypoint : null,
          target,
          direction: directionIsValid ? input.direction : null,
          attempt:
            target !== null && entrypointIsValid && directionIsValid
              ? nextEntrypointAttempt(previous, input.entrypoint, target, input.direction)
              : 1,
          error: FILTER_SORT_CAPABILITY_ERROR,
        }),
      )
      return
    }
    set(filterSortCapabilityBackingAtom, true)

    if (
      target === null ||
      !directionIsValid ||
      !entrypointIsValid ||
      typeof input.refreshProjection !== 'function'
    ) {
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateFor('blocked', {
          entrypoint: entrypointIsValid ? input.entrypoint : null,
          target,
          direction: directionIsValid ? input.direction : null,
          attempt: 1,
          error: target === null ? FILTER_SORT_TARGET_ERROR : FILTER_SORT_INVALID_INPUT_ERROR,
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

    const currentState = get(filterSortStateAtom)[target.sheetId] ?? EMPTY_FILTER_SORT_STATE
    const next = normalizeState({
      rules: currentState.rules,
      directives: prioritizeSortDirective(currentState.directives, {
        colIndex: target.colIndex,
        direction: input.direction,
      }),
    })
    const ticket: FilterSortEntrypointTicket = Object.freeze({
      operationId,
      requestId,
      entrypoint: input.entrypoint,
      target,
      direction: input.direction,
      attempt: nextEntrypointAttempt(previous, input.entrypoint, target, input.direction),
      next,
      selectionWitness: get(selectionAuthorityWitnessAtom),
      workspaceWitness: get(workspaceActiveSheetAuthorityWitnessAtom),
    })
    set(filterSortEntrypointOperationIdStateAtom, operationId)
    set(filterSortSyncTicketBackingAtom, requestId)
    set(activeFilterSortEntrypointAtom, ticket)
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('pending', ticket))

    const ownsTicket = (): boolean => {
      const state = get(filterSortEntrypointStateBackingAtom)
      return (
        get(activeFilterSortEntrypointAtom) === ticket &&
        state.operationId === ticket.operationId &&
        state.requestId === ticket.requestId &&
        state.entrypoint === ticket.entrypoint &&
        state.direction === ticket.direction &&
        sameFilterSortTarget(state.target, ticket.target)
      )
    }
    const authorityIsCurrent = (): boolean =>
      get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
      get(workspaceActiveSheetAuthorityWitnessAtom) === ticket.workspaceWitness &&
      sameFilterSortTarget(resolveFilterSortEntrypointTarget(get), ticket.target)
    const rejectPrelaunchStaleTicket = (): void => {
      if (!ownsTicket() || authorityIsCurrent()) return
      set(activeFilterSortEntrypointAtom, null)
      set(
        filterSortEntrypointStateBackingAtom,
        entrypointStateForTicket('stale', ticket, FILTER_SORT_STALE_OPERATION_ERROR),
      )
    }
    // Publish the reservation before transport launch so same-tick re-entry is inert.
    await Promise.resolve()
    if (!ownsTicket()) return
    if (!authorityIsCurrent()) {
      // No transport exists yet, so this local reservation can be released.
      rejectPrelaunchStaleTicket()
      return
    }
    set(filterSortEntrypointStateBackingAtom, get(filterSortEntrypointStateBackingAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await execute.call(input.source, {
        kind: 'set-filter-sort',
        sheetId: ticket.target.sheetId,
        rules: ticket.next.rules,
        directives: ticket.next.directives,
        requestId: ticket.requestId,
      })
    } catch (error) {
      if (!ownsTicket()) return
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
        (acknowledgement as { sheetId?: unknown }).sheetId === ticket.target.sheetId &&
        (acknowledgement as { requestId?: unknown }).requestId === ticket.requestId
    } catch {
      acknowledgementMatches = false
    }
    if (!acknowledgementMatches) {
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

    const stateBeforeCommit = get(filterSortStateBackingAtom)
    set(
      filterSortStateBackingAtom,
      stateStoreWith(stateBeforeCommit, ticket.target.sheetId, ticket.next),
    )
    set(
      filterSortEntrypointStateBackingAtom,
      entrypointStateForTicket('local-acknowledged', ticket),
    )

    await Promise.resolve()
    if (!ownsTicket()) return
    set(filterSortEntrypointStateBackingAtom, entrypointStateForTicket('refreshing', ticket))
    try {
      await input.refreshProjection(ticket.target.sheetId)
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
runFilterSortEntrypointAtom.debugLabel = 'spreadsheet.filterSort.runEntrypoint'

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

// Legacy optimistic command retained for non-entrypoint compatibility consumers.
// Toolbar, MenuBar, and the dropdown use acknowledged Core-owned command lifecycles.
export const dispatchSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (
    get,
    set,
    input: { sheetId: string; colIndex: number; direction: SortDirection },
  ): FilterSortState => {
    if (!input.sheetId || input.sheetId.length === 0) return EMPTY_FILTER_SORT_STATE
    const current = get(filterSortStateAtom)
    const sheetState = current[input.sheetId] ?? EMPTY_FILTER_SORT_STATE
    const next: FilterSortState = {
      rules: sheetState.rules,
      directives: prioritizeSortDirective(sheetState.directives, {
        colIndex: input.colIndex,
        direction: input.direction,
      }),
    }
    const normalized = normalizeState(next)
    set(
      filterSortStateBackingAtom,
      stateStoreWith(get(filterSortStateBackingAtom), input.sheetId, normalized),
    )
    return normalized
  },
)
dispatchSortAtom.debugLabel = 'spreadsheet.filterSort.dispatchSort'

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
