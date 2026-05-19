import { atom } from '@einfach/core'
import type { DisplayCell } from '../backend'
import {
  getSelectionRange,
  selectionBoundsAtom,
  selectionRegionsAtom,
  type SelectionBounds,
  type SelectionState,
} from '../selection'
import {
  DEFAULT_STATUS_BAR_AGGREGATE_CONFIG,
  STATUS_BAR_AGGREGATE_KEYS,
  ZOOM_LEVEL_DEFAULT,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_PRESETS,
  type SelectionAggregates,
  type StatusBarAggregateConfig,
  type StatusBarAggregateKey,
  type StatusBarViewMode,
} from './types'

export * from './types'

const EMPTY_AGGREGATES: SelectionAggregates = Object.freeze({
  sum: 0,
  average: 0,
  count: 0,
  numericCount: 0,
  min: 0,
  max: 0,
  truncated: false,
})

function isInRange(
  row: number,
  col: number,
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): boolean {
  return row >= rowStart && row <= rowEnd && col >= colStart && col <= colEnd
}

function isCellInAnyRegion(
  cell: DisplayCell,
  regions: readonly SelectionState[],
  bounds: SelectionBounds,
): boolean {
  for (const region of regions) {
    const range = getSelectionRange(region, bounds)
    if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) {
      continue
    }
    if (
      isInRange(cell.row, cell.col, range.rowStart, range.rowEnd, range.colStart, range.colEnd)
    ) {
      return true
    }
  }
  return false
}

function isNonEmpty(cell: DisplayCell): boolean {
  if (cell.valueKind === undefined) {
    return cell.displayValue.length > 0
  }
  return cell.valueKind !== 'blank'
}

function parseNumeric(cell: DisplayCell): number | null {
  if (cell.valueKind !== 'number') {
    return null
  }
  const value = Number(cell.displayValue)
  if (!Number.isFinite(value)) {
    return null
  }
  return value
}

/**
 * Pure derivation of selection aggregates over the supplied display cells.
 * Cells outside any selection region are ignored. `truncated` is propagated
 * from the caller (e.g. when the visible projection window doesn't fully
 * cover the selection).
 */
export function computeSelectionAggregates(
  cells: readonly DisplayCell[],
  regions: readonly SelectionState[],
  bounds: SelectionBounds,
  options: { truncated?: boolean } = {},
): SelectionAggregates {
  if (regions.length === 0 || cells.length === 0) {
    return options.truncated ? { ...EMPTY_AGGREGATES, truncated: true } : EMPTY_AGGREGATES
  }

  let count = 0
  let numericCount = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const cell of cells) {
    if (!isCellInAnyRegion(cell, regions, bounds)) {
      continue
    }
    if (!isNonEmpty(cell)) {
      continue
    }
    count += 1
    const numeric = parseNumeric(cell)
    if (numeric === null) {
      continue
    }
    numericCount += 1
    sum += numeric
    if (numeric < min) {
      min = numeric
    }
    if (numeric > max) {
      max = numeric
    }
  }

  const average = numericCount > 0 ? sum / numericCount : 0

  return {
    sum,
    average,
    count,
    numericCount,
    min: numericCount > 0 ? min : 0,
    max: numericCount > 0 ? max : 0,
    truncated: Boolean(options.truncated),
  }
}

/**
 * Host-provided display cells used by the aggregate derivation. Hosts mirror
 * the cells from their projection snapshot into this atom; this keeps the
 * vanilla aggregates atom independent of host-side projection storage.
 */
export const statusBarProjectionCellsAtom = atom<readonly DisplayCell[]>([])
statusBarProjectionCellsAtom.debugLabel = 'spreadsheet.statusBar.projectionCells'

/**
 * Truncation hint sourced from the host (e.g. when the selection exceeds the
 * visible projection window). The derivation surfaces this in
 * `selectionAggregatesAtom.truncated`.
 */
export const statusBarAggregateTruncatedAtom = atom<boolean>(false)
statusBarAggregateTruncatedAtom.debugLabel = 'spreadsheet.statusBar.aggregateTruncated'

export const selectionAggregatesAtom = atom<SelectionAggregates>((get) => {
  return computeSelectionAggregates(
    get(statusBarProjectionCellsAtom),
    get(selectionRegionsAtom),
    get(selectionBoundsAtom),
    { truncated: get(statusBarAggregateTruncatedAtom) },
  )
})
selectionAggregatesAtom.debugLabel = 'spreadsheet.statusBar.selectionAggregates'

export const statusBarAggregateConfigAtom = atom<StatusBarAggregateConfig>({
  ...DEFAULT_STATUS_BAR_AGGREGATE_CONFIG,
})
statusBarAggregateConfigAtom.debugLabel = 'spreadsheet.statusBar.aggregateConfig'

export const toggleStatusBarAggregateAtom = atom(
  (get) => get(statusBarAggregateConfigAtom),
  (get, set, key: StatusBarAggregateKey) => {
    const current = get(statusBarAggregateConfigAtom)
    set(statusBarAggregateConfigAtom, { ...current, [key]: !current[key] })
  },
)
toggleStatusBarAggregateAtom.debugLabel = 'spreadsheet.statusBar.toggleAggregate'

export const setStatusBarAggregateConfigAtom = atom(
  (get) => get(statusBarAggregateConfigAtom),
  (_get, set, config: StatusBarAggregateConfig) => {
    const next: Record<StatusBarAggregateKey, boolean> = {
      ...DEFAULT_STATUS_BAR_AGGREGATE_CONFIG,
    }
    for (const key of STATUS_BAR_AGGREGATE_KEYS) {
      if (typeof config[key] === 'boolean') {
        next[key] = config[key]
      }
    }
    set(statusBarAggregateConfigAtom, next)
  },
)
setStatusBarAggregateConfigAtom.debugLabel = 'spreadsheet.statusBar.setAggregateConfig'

function snapZoomLevel(value: number): number {
  if (!Number.isFinite(value)) {
    return ZOOM_LEVEL_DEFAULT
  }
  if (value < ZOOM_LEVEL_MIN) {
    return ZOOM_LEVEL_MIN
  }
  if (value > ZOOM_LEVEL_MAX) {
    return ZOOM_LEVEL_MAX
  }
  return value
}

export function snapZoomToPreset(value: number): number {
  if (!Number.isFinite(value)) {
    return ZOOM_LEVEL_DEFAULT
  }
  let best = ZOOM_LEVEL_PRESETS[0]
  let bestDelta = Math.abs(value - best)
  for (let i = 1; i < ZOOM_LEVEL_PRESETS.length; i += 1) {
    const candidate = ZOOM_LEVEL_PRESETS[i]
    const delta = Math.abs(value - candidate)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best
}

export const zoomLevelAtom = atom<number>(ZOOM_LEVEL_DEFAULT)
zoomLevelAtom.debugLabel = 'spreadsheet.zoom.level'

export const setZoomLevelAtom = atom(
  (get) => get(zoomLevelAtom),
  (_get, set, value: number) => {
    set(zoomLevelAtom, snapZoomLevel(value))
  },
)
setZoomLevelAtom.debugLabel = 'spreadsheet.zoom.setLevel'

export const resetZoomLevelAtom = atom(
  (get) => get(zoomLevelAtom),
  (_get, set) => {
    set(zoomLevelAtom, ZOOM_LEVEL_DEFAULT)
  },
)
resetZoomLevelAtom.debugLabel = 'spreadsheet.zoom.reset'

export const viewModeAtom = atom<StatusBarViewMode>('normal')
viewModeAtom.debugLabel = 'spreadsheet.viewMode'

export const setViewModeAtom = atom(
  (get) => get(viewModeAtom),
  (_get, set, mode: StatusBarViewMode) => {
    set(viewModeAtom, mode)
  },
)
setViewModeAtom.debugLabel = 'spreadsheet.viewMode.set'
