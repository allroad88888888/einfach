import { atom } from '@einfach/core'
import type {
  ColumnFilterRule,
  FilterDropdownState,
  FilterSortState,
  FilterSortStateBySheet,
  SortDirection,
  SortDirective,
} from './types'

export * from './types'

export const MAX_FILTER_LIST_VALUES = 10000

function normalizeRules(rules: readonly ColumnFilterRule[]): readonly ColumnFilterRule[] {
  return rules.map((rule) => {
    if (rule.kind === 'list' && rule.values.length > MAX_FILTER_LIST_VALUES) {
      // Truncate list values to MAX_FILTER_LIST_VALUES. Oversized lists are silently capped
      // to avoid sending unbounded payloads to the backend.
      return { ...rule, values: rule.values.slice(0, MAX_FILTER_LIST_VALUES) }
    }
    return rule
  })
}

export const filterSortStateAtom = atom<FilterSortStateBySheet>({})
filterSortStateAtom.debugLabel = 'spreadsheet.filterSort.state'

export const filterDropdownAtom = atom<FilterDropdownState>({ status: 'closed' })
filterDropdownAtom.debugLabel = 'spreadsheet.filterSort.dropdown'

export const filterSortErrorAtom = atom<string>('')
filterSortErrorAtom.debugLabel = 'spreadsheet.filterSort.error'

export const filterSortSyncTicketAtom = atom<number>(0)
filterSortSyncTicketAtom.debugLabel = 'spreadsheet.filterSort.syncTicket'

export const issueFilterSortSyncTicketAtom = atom(null, (get, set) => {
  const next = get(filterSortSyncTicketAtom) + 1
  set(filterSortSyncTicketAtom, next)
  return next
})
issueFilterSortSyncTicketAtom.debugLabel = 'spreadsheet.filterSort.issueSyncTicket'

export const setFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, { sheetId, state }: { sheetId: string; state: FilterSortState }) => {
    const normalizedRules = normalizeRules(state.rules)
    const normalized: FilterSortState = { ...state, rules: normalizedRules }
    const current = get(filterSortStateAtom)
    set(filterSortStateAtom, { ...current, [sheetId]: normalized })
  },
)
setFilterSortAtom.debugLabel = 'spreadsheet.filterSort.set'

export const setFilterSortErrorAtom = atom(
  null,
  (_get, set, error: unknown) => {
    if (error == null) {
      set(filterSortErrorAtom, '')
      return
    }
    set(filterSortErrorAtom, error instanceof Error ? error.message : String(error))
  },
)
setFilterSortErrorAtom.debugLabel = 'spreadsheet.filterSort.setError'

export const clearFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, sheetId: string) => {
    const current = get(filterSortStateAtom)
    const next = { ...current }
    delete next[sheetId]
    set(filterSortStateAtom, next)
    set(filterDropdownAtom, { status: 'closed' })
  },
)
clearFilterSortAtom.debugLabel = 'spreadsheet.filterSort.clear'

export const clearColumnFilterSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (get, set, { sheetId, colIndex }: { sheetId: string; colIndex: number }) => {
    const current = get(filterSortStateAtom)
    const sheetState = current[sheetId]
    if (!sheetState) return
    const nextRules = sheetState.rules.filter((r) => r.colIndex !== colIndex)
    const nextDirectives = sheetState.directives.filter((d) => d.colIndex !== colIndex)
    const unchanged =
      nextRules.length === sheetState.rules.length &&
      nextDirectives.length === sheetState.directives.length
    if (unchanged) return
    set(filterSortStateAtom, {
      ...current,
      [sheetId]: { rules: nextRules, directives: nextDirectives },
    })
  },
)
clearColumnFilterSortAtom.debugLabel = 'spreadsheet.filterSort.clearColumn'

export const openFilterDropdownAtom = atom(
  (get) => get(filterDropdownAtom),
  (_get, set, { sheetId, colIndex }: { sheetId: string; colIndex: number }) => {
    set(filterDropdownAtom, { status: 'open', sheetId, colIndex })
  },
)
openFilterDropdownAtom.debugLabel = 'spreadsheet.filterSort.openDropdown'

export const closeFilterDropdownAtom = atom(
  (get) => get(filterDropdownAtom),
  (_get, set) => {
    set(filterDropdownAtom, { status: 'closed' })
  },
)
closeFilterDropdownAtom.debugLabel = 'spreadsheet.filterSort.closeDropdown'

// Replaces (or appends) the sort directive on `colIndex` with `direction`.
// Other columns' directives are preserved untouched. Filters are unchanged.
// Returns the next FilterSortState so the host can sync it to the backend.
export const dispatchSortAtom = atom(
  (get) => get(filterSortStateAtom),
  (
    get,
    set,
    input: { sheetId: string; colIndex: number; direction: SortDirection },
  ): FilterSortState => {
    if (!input.sheetId || input.sheetId.length === 0) {
      return { rules: [], directives: [] }
    }
    const current = get(filterSortStateAtom)
    const sheetState: FilterSortState = current[input.sheetId] ?? { rules: [], directives: [] }
    const nextDirective: SortDirective = {
      colIndex: input.colIndex,
      direction: input.direction,
    }
    const otherDirectives = sheetState.directives.filter((d) => d.colIndex !== input.colIndex)
    const next: FilterSortState = {
      rules: sheetState.rules,
      directives: [...otherDirectives, nextDirective],
    }
    set(filterSortStateAtom, { ...current, [input.sheetId]: next })
    return next
  },
)
dispatchSortAtom.debugLabel = 'spreadsheet.filterSort.dispatchSort'

// Host adapter calls this when the workspace active sheet changes so
// an open dropdown for a now-background sheet closes cleanly.
// filterSortStateAtom is unaffected (per-sheet state persists).
export const notifyActiveSheetChangedAtom = atom(
  (get) => get(filterDropdownAtom),
  (get, set, nextSheetId: string | null) => {
    const dropdown = get(filterDropdownAtom)
    if (dropdown.status === 'open' && dropdown.sheetId !== nextSheetId) {
      set(filterDropdownAtom, { status: 'closed' })
    }
  },
)
notifyActiveSheetChangedAtom.debugLabel = 'spreadsheet.filterSort.notifyActiveSheet'
