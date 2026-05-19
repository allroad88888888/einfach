export type StatusBarAggregateKey =
  | 'sum'
  | 'average'
  | 'count'
  | 'numericCount'
  | 'min'
  | 'max'

export interface SelectionAggregates {
  sum: number
  average: number
  count: number
  numericCount: number
  min: number
  max: number
  truncated: boolean
}

export type StatusBarAggregateConfig = Readonly<Record<StatusBarAggregateKey, boolean>>

export type StatusBarViewMode = 'normal' | 'page-break-preview' | 'page-layout'

export type StatusBarInputMode = 'ready' | 'edit' | 'enter' | 'point'

export const STATUS_BAR_AGGREGATE_KEYS: readonly StatusBarAggregateKey[] = [
  'sum',
  'average',
  'count',
  'numericCount',
  'min',
  'max',
] as const

export const DEFAULT_STATUS_BAR_AGGREGATE_CONFIG: StatusBarAggregateConfig = Object.freeze({
  sum: true,
  average: true,
  count: true,
  numericCount: false,
  min: false,
  max: false,
})

export const ZOOM_LEVEL_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export const ZOOM_LEVEL_MIN = 0.25
export const ZOOM_LEVEL_MAX = 4
export const ZOOM_LEVEL_DEFAULT = 1
