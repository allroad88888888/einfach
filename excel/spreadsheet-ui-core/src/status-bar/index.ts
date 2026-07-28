import { atom } from '@einfach/core'
import type { Atom, WritableAtom } from '@einfach/core'
import type { DisplayCell } from '../backend'
import type { CellRange } from '../shared'
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

const EMPTY_STATUS_BAR_PROJECTION_CELLS: readonly DisplayCell[] = Object.freeze([])

/**
 * Hard command-boundary cap for status-bar snapshots. The status bar must not
 * trust every host to have applied the projection layer's independent limit.
 */
export const STATUS_BAR_PROJECTION_CELLS_MAX = 50_000

/**
 * Hard upper bound for point-in-selection checks during one aggregate
 * derivation. Keeping this separate from the projection cell cap makes the
 * work bound explicit even when a selection contains many regions.
 */
export const STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX = 50_000

interface StatusBarProjectionSnapshot {
  readonly sheetId: string | null
  readonly window: Readonly<CellRange> | null
  readonly cells: readonly DisplayCell[]
  readonly upstreamTruncated: boolean
  readonly cellsTruncated: boolean
}

export interface StatusBarProjectionSyncInput {
  readonly sheetId: string | null
  readonly window: CellRange | null
  readonly cells: readonly DisplayCell[]
  readonly truncated: boolean
}

const EMPTY_STATUS_BAR_PROJECTION: StatusBarProjectionSnapshot = Object.freeze({
  sheetId: null,
  window: null,
  cells: EMPTY_STATUS_BAR_PROJECTION_CELLS,
  upstreamTruncated: false,
  cellsTruncated: false,
})

function snapshotRuntimeValue<Value>(value: Value, seen = new WeakMap<object, unknown>()): Value {
  if (value === null || typeof value !== 'object') return value
  const object = value as unknown as object
  const cached = seen.get(object)
  if (cached !== undefined) return cached as Value

  if (Array.isArray(value)) {
    const clone: unknown[] = []
    seen.set(object, clone)
    for (const item of value) clone.push(snapshotRuntimeValue(item, seen))
    return Object.freeze(clone) as Value
  }

  const clone: Record<string, unknown> = {}
  seen.set(object, clone)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = snapshotRuntimeValue(item, seen)
  }
  return Object.freeze(clone) as Value
}

function snapshotStatusBarProjection(
  input: StatusBarProjectionSyncInput,
): StatusBarProjectionSnapshot {
  const exceedsLocalLimit = input.cells.length > STATUS_BAR_PROJECTION_CELLS_MAX
  return Object.freeze({
    sheetId: input.sheetId,
    window: input.window === null ? null : snapshotRuntimeValue(input.window),
    cells: snapshotRuntimeValue(input.cells.slice(0, STATUS_BAR_PROJECTION_CELLS_MAX)),
    upstreamTruncated: Boolean(input.truncated),
    cellsTruncated: exceedsLocalLimit,
  })
}

function snapshotStatusBarAggregateConfig(
  config: StatusBarAggregateConfig,
): StatusBarAggregateConfig {
  const next: Record<StatusBarAggregateKey, boolean> = {
    ...DEFAULT_STATUS_BAR_AGGREGATE_CONFIG,
  }
  for (const key of STATUS_BAR_AGGREGATE_KEYS) {
    if (typeof config[key] === 'boolean') next[key] = config[key]
  }
  return Object.freeze(next)
}

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

interface NormalizedSelectionRange {
  readonly sheetId: string
  readonly range: CellRange
}

function normalizeSelectionRanges(
  regions: readonly SelectionState[],
  bounds: SelectionBounds,
): readonly NormalizedSelectionRange[] {
  const ranges: NormalizedSelectionRange[] = []
  for (const region of regions) {
    const range = getSelectionRange(region, bounds)
    if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) continue
    ranges.push({ sheetId: region.sheetId, range })
  }
  return ranges
}

function rangeContains(outer: CellRange, inner: CellRange): boolean {
  return (
    outer.rowStart <= inner.rowStart &&
    outer.rowEnd >= inner.rowEnd &&
    outer.colStart <= inner.colStart &&
    outer.colEnd >= inner.colEnd
  )
}

function isNonEmpty(cell: DisplayCell): boolean {
  if (cell.valueKind === undefined) {
    return cell.displayValue.length > 0
  }
  return cell.valueKind !== 'blank'
}

function parseNumeric(cell: DisplayCell): number | null {
  if (cell.valueKind !== 'number' || !Number.isFinite(cell.numericValue)) {
    return null
  }
  return cell.numericValue!
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
  const ranges = normalizeSelectionRanges(regions, bounds).map((entry) => entry.range)
  return computeSelectionAggregatesFromRanges(cells, ranges, options)
}

function computeSelectionAggregatesFromRanges(
  cells: readonly DisplayCell[],
  ranges: readonly CellRange[],
  options: { truncated?: boolean } = {},
): SelectionAggregates {
  if (ranges.length === 0 || cells.length === 0) {
    return options.truncated
      ? Object.freeze({ ...EMPTY_AGGREGATES, truncated: true })
      : EMPTY_AGGREGATES
  }

  let count = 0
  let numericCount = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let membershipChecks = 0
  let membershipBudgetExhausted = false
  let numericProjectionIncomplete = false

  cellLoop: for (const cell of cells) {
    let selected = false
    for (const range of ranges) {
      // Check before consuming work. Reaching the exact limit on the final
      // required comparison is complete work, not truncation; only a further
      // required comparison exhausts the budget.
      if (membershipChecks >= STATUS_BAR_AGGREGATE_MEMBERSHIP_CHECKS_MAX) {
        membershipBudgetExhausted = true
        break cellLoop
      }
      membershipChecks += 1
      if (
        isInRange(cell.row, cell.col, range.rowStart, range.rowEnd, range.colStart, range.colEnd)
      ) {
        selected = true
        break
      }
    }
    if (!selected) continue
    if (!isNonEmpty(cell)) {
      continue
    }
    count += 1
    const numeric = parseNumeric(cell)
    if (numeric === null) {
      if (cell.valueKind === 'number') numericProjectionIncomplete = true
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

  return Object.freeze({
    sum,
    average,
    count,
    numericCount,
    min: numericCount > 0 ? min : 0,
    max: numericCount > 0 ? max : 0,
    truncated:
      Boolean(options.truncated) || membershipBudgetExhausted || numericProjectionIncomplete,
  })
}

function selectionCoverageIsTruncated(
  projection: StatusBarProjectionSnapshot,
  ranges: readonly NormalizedSelectionRange[],
): boolean {
  if (projection.upstreamTruncated || projection.cellsTruncated) return true
  if (ranges.length === 0) return false
  if (projection.sheetId === null || projection.window === null) return true

  for (const entry of ranges) {
    if (entry.sheetId !== projection.sheetId || !rangeContains(projection.window, entry.range)) {
      return true
    }
  }
  return false
}

/**
 * Private aggregate projection authority. Hosts synchronize one coherent
 * cells + truncation snapshot through `syncStatusBarProjectionAtom`.
 */
const statusBarProjectionBackingAtom = atom<StatusBarProjectionSnapshot>(
  EMPTY_STATUS_BAR_PROJECTION,
)
statusBarProjectionBackingAtom.debugLabel = 'spreadsheet.statusBar.projectionBacking'

/** Read-only display-cell projection consumed by aggregate derivations. */
export const statusBarProjectionCellsAtom: Atom<readonly DisplayCell[]> = atom(
  (get) => get(statusBarProjectionBackingAtom).cells,
)
statusBarProjectionCellsAtom.debugLabel = 'spreadsheet.statusBar.projectionCells'

export const syncStatusBarProjectionAtom: WritableAtom<null, [StatusBarProjectionSyncInput], void> =
  atom(null, (_get, set, input: StatusBarProjectionSyncInput) => {
    set(statusBarProjectionBackingAtom, snapshotStatusBarProjection(input))
  })
syncStatusBarProjectionAtom.debugLabel = 'spreadsheet.statusBar.syncProjection'

export const selectionAggregatesAtom: Atom<SelectionAggregates> = atom((get) => {
  const projection = get(statusBarProjectionBackingAtom)
  const ranges = normalizeSelectionRanges(get(selectionRegionsAtom), get(selectionBoundsAtom))
  const matchingRanges =
    projection.sheetId === null
      ? []
      : ranges.filter((entry) => entry.sheetId === projection.sheetId).map((entry) => entry.range)
  return computeSelectionAggregatesFromRanges(projection.cells, matchingRanges, {
    truncated: selectionCoverageIsTruncated(projection, ranges),
  })
})
selectionAggregatesAtom.debugLabel = 'spreadsheet.statusBar.selectionAggregates'

/**
 * Read-only aggregate truth, including upstream/local cell truncation,
 * selection coverage, sheet mismatch, and membership-budget exhaustion.
 */
export const statusBarAggregateTruncatedAtom: Atom<boolean> = atom(
  (get) => get(selectionAggregatesAtom).truncated,
)
statusBarAggregateTruncatedAtom.debugLabel = 'spreadsheet.statusBar.aggregateTruncated'

const statusBarAggregateConfigBackingAtom = atom<StatusBarAggregateConfig>(
  snapshotStatusBarAggregateConfig(DEFAULT_STATUS_BAR_AGGREGATE_CONFIG),
)
statusBarAggregateConfigBackingAtom.debugLabel = 'spreadsheet.statusBar.aggregateConfigBacking'

export const statusBarAggregateConfigAtom: Atom<StatusBarAggregateConfig> = atom((get) =>
  get(statusBarAggregateConfigBackingAtom),
)
statusBarAggregateConfigAtom.debugLabel = 'spreadsheet.statusBar.aggregateConfig'

export const toggleStatusBarAggregateAtom: WritableAtom<
  StatusBarAggregateConfig,
  [StatusBarAggregateKey],
  void
> = atom(
  (get) => get(statusBarAggregateConfigBackingAtom),
  (get, set, key: StatusBarAggregateKey) => {
    const current = get(statusBarAggregateConfigBackingAtom)
    set(
      statusBarAggregateConfigBackingAtom,
      snapshotStatusBarAggregateConfig({ ...current, [key]: !current[key] }),
    )
  },
)
toggleStatusBarAggregateAtom.debugLabel = 'spreadsheet.statusBar.toggleAggregate'

export const setStatusBarAggregateConfigAtom: WritableAtom<
  StatusBarAggregateConfig,
  [StatusBarAggregateConfig],
  void
> = atom(
  (get) => get(statusBarAggregateConfigBackingAtom),
  (_get, set, config: StatusBarAggregateConfig) => {
    set(statusBarAggregateConfigBackingAtom, snapshotStatusBarAggregateConfig(config))
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

const zoomLevelBackingAtom = atom<number>(ZOOM_LEVEL_DEFAULT)
zoomLevelBackingAtom.debugLabel = 'spreadsheet.zoom.levelBacking'

export const zoomLevelAtom: Atom<number> = atom((get) => get(zoomLevelBackingAtom))
zoomLevelAtom.debugLabel = 'spreadsheet.zoom.level'

export const setZoomLevelAtom: WritableAtom<number, [number], void> = atom(
  (get) => get(zoomLevelBackingAtom),
  (_get, set, value: number) => {
    set(zoomLevelBackingAtom, snapZoomLevel(value))
  },
)
setZoomLevelAtom.debugLabel = 'spreadsheet.zoom.setLevel'

export const resetZoomLevelAtom: WritableAtom<number, [], void> = atom(
  (get) => get(zoomLevelBackingAtom),
  (_get, set) => {
    set(zoomLevelBackingAtom, ZOOM_LEVEL_DEFAULT)
  },
)
resetZoomLevelAtom.debugLabel = 'spreadsheet.zoom.reset'

const viewModeBackingAtom = atom<StatusBarViewMode>('normal')
viewModeBackingAtom.debugLabel = 'spreadsheet.viewMode.backing'

export const viewModeAtom: Atom<StatusBarViewMode> = atom((get) => get(viewModeBackingAtom))
viewModeAtom.debugLabel = 'spreadsheet.viewMode'

export const setViewModeAtom: WritableAtom<StatusBarViewMode, [StatusBarViewMode], void> = atom(
  (get) => get(viewModeBackingAtom),
  (_get, set, mode: StatusBarViewMode) => {
    set(viewModeBackingAtom, mode)
  },
)
setViewModeAtom.debugLabel = 'spreadsheet.viewMode.set'
