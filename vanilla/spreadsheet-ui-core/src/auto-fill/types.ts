import type { CellRange, SheetRef } from '../shared'

export type FillSeriesKind =
  | 'copy'
  | 'integer-step'
  | 'decimal-step'
  | 'date-day'
  | 'date-week'
  | 'date-month'
  | 'weekday-name'
  | 'month-name'
  | 'custom-list'

export interface FillSeriesDetectionResult {
  kind: FillSeriesKind
  step?: number
  previewLast?: string
  custom?: { listName: string }
}

export interface FillSeriesLocaleOptions {
  weekdayNames?: string[]
  monthNames?: string[]
  customLists?: Record<string, string[]>
}

/** Sibling of FillRangeRequest; backend discriminates on kind. */
export interface FillSeriesRequest extends SheetRef {
  kind: 'fill-series'
  sourceRange: CellRange
  targetRange: CellRange
  direction: 'up' | 'down' | 'left' | 'right'
  series: FillSeriesKind
  step?: number
  requestId?: number
  revision?: number | string
}
