import { atom } from '@einfach/core'
import type {
  ColumnFilterRule,
  FilterDropdownState,
  FilterSortState,
  FilterSortStateBySheet,
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
