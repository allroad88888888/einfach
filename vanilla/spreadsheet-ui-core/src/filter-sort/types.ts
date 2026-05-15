import type { SheetRef } from '../shared'
import type { ProjectionRequestId, ProjectionRevision } from '../backend/types'

export type SortDirection = 'asc' | 'desc'

export interface SortDirective {
  colIndex: number
  direction: SortDirection
}

export type ColumnFilterRule =
  | { kind: 'equals'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'contains'; colIndex: number; value: string; caseSensitive?: boolean }
  | { kind: 'range'; colIndex: number; min?: number; max?: number }
  | { kind: 'list'; colIndex: number; values: readonly string[] }

export interface FilterSortState {
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
}

export type FilterSortStateBySheet = Record<string, FilterSortState>

export interface FilterDropdownState {
  status: 'closed' | 'open'
  sheetId?: string
  colIndex?: number
}

export interface SetFilterSortRequest extends SheetRef {
  kind: 'set-filter-sort'
  rules: readonly ColumnFilterRule[]
  directives: readonly SortDirective[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
