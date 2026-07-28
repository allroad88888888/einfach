import type { CellRange, SheetRef } from '../shared'

export type FillSeriesKind =
  | 'copy'
  | 'integer-step'
  | 'decimal-step'
  | 'linear-trend'
  | 'date-day'
  | 'date-week'
  | 'date-month'
  | 'text-number'
  | 'weekday-name'
  | 'month-name'
  | 'custom-list'

export interface FillSeriesTextPattern {
  prefix: string
  suffix: string
  /** Fixed digit width. Zero means that the source did not establish padding. */
  width: number
}

export interface FillSeriesListWitness {
  listName: string
  values: readonly string[]
  /**
   * Canonical BCP-47 locale used to fold and compare every list value.
   * Optional only for wire/type compatibility; new detectors always emit it
   * and execution boundaries reject a missing or invalid locale.
   */
  locale?: string
}

export interface FillSeriesDetectionResult {
  kind: FillSeriesKind
  step?: number
  previewLast?: string
  custom?: { listName: string }
  textPattern?: FillSeriesTextPattern
  list?: FillSeriesListWitness
}

export interface FillSeriesLocaleOptions {
  /** BCP-47 locale used for locale-sensitive list matching. Defaults to `en`. */
  locale?: string
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
  textPattern?: FillSeriesTextPattern
  list?: FillSeriesListWitness
  requestId?: number
  revision?: number | string
}
