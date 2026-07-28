import { atom, type Getter, type Setter } from '@einfach/core'
import type {
  ProjectionRequestId,
  ProjectionRevision,
  ViewportColumnWidth,
  ViewportRowHeight,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '../backend/types'
import type { CellCoord, CellRange } from '../shared'
import type {
  CellViewportRect,
  FrozenWindows,
  ScrollToCellInput,
  ViewportCellAlign,
  ViewportMetrics,
  ViewportScrollPosition,
  ViewportSizeOverrideState,
  VisibleWindow,
  SetViewportColumnWidthInput,
  SetViewportRowHeightInput,
} from './types'

export const DEFAULT_VIEWPORT_METRICS: ViewportMetrics = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 0,
  viewportWidth: 0,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 0,
  colCount: 0,
  overscanRows: 2,
  overscanCols: 2,
}

export const MIN_VIEWPORT_ROW_HEIGHT = 16
export const MAX_VIEWPORT_ROW_HEIGHT = 512
export const MIN_VIEWPORT_COL_WIDTH = 40
export const MAX_VIEWPORT_COL_WIDTH = 1024

export const DEFAULT_VIEWPORT_SIZE_OVERRIDES: ViewportSizeOverrideState = {
  rowHeightsBySheet: {},
  colWidthsBySheet: {},
}

function clampIndex(value: number, maxExclusive: number) {
  if (maxExclusive <= 0) {
    return 0
  }
  if (value < 0) {
    return 0
  }
  if (value >= maxExclusive) {
    return maxExclusive - 1
  }
  return value
}

function normalizeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return value
}

function normalizeCount(value: number): number {
  return Math.max(0, Math.trunc(normalizeNumber(value, 0)))
}

function normalizePositive(value: number, fallback: number): number {
  return Math.max(1, normalizeNumber(value, fallback))
}

function normalizeDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.max(min, Math.min(max, Math.round(value)))
}

function normalizeRowHeight(value: number): number {
  return normalizeDimension(value, MIN_VIEWPORT_ROW_HEIGHT, MAX_VIEWPORT_ROW_HEIGHT)
}

function normalizeColWidth(value: number): number {
  return normalizeDimension(value, MIN_VIEWPORT_COL_WIDTH, MAX_VIEWPORT_COL_WIDTH)
}

function normalizeFallbackDimension(value: number, fallback: number): number {
  return Math.max(1, Math.round(normalizeNumber(value, fallback)))
}

function normalizeFallbackRowHeight(value: number): number {
  return normalizeFallbackDimension(value, DEFAULT_VIEWPORT_METRICS.rowHeight)
}

function normalizeFallbackColWidth(value: number): number {
  return normalizeFallbackDimension(value, DEFAULT_VIEWPORT_METRICS.colWidth)
}

function normalizeSparseIndex(value: number): number | null {
  if (!Number.isInteger(value) || value < 0) {
    return null
  }

  return value
}

function normalizeOverscan(value: number): number {
  return Math.max(0, Math.trunc(normalizeNumber(value, 0)))
}

function clampOffset(value: number, max: number): number {
  return Math.max(0, Math.min(normalizeNumber(value, 0), Math.max(0, max)))
}

export function normalizeViewportMetrics(metrics: ViewportMetrics): ViewportMetrics {
  const rowHeight = normalizePositive(metrics.rowHeight, DEFAULT_VIEWPORT_METRICS.rowHeight)
  const colWidth = normalizePositive(metrics.colWidth, DEFAULT_VIEWPORT_METRICS.colWidth)
  const rowCount = normalizeCount(metrics.rowCount)
  const colCount = normalizeCount(metrics.colCount)
  const viewportHeight = Math.max(0, normalizeNumber(metrics.viewportHeight, 0))
  const viewportWidth = Math.max(0, normalizeNumber(metrics.viewportWidth, 0))

  return {
    scrollTop: clampOffset(metrics.scrollTop, rowCount * rowHeight - viewportHeight),
    scrollLeft: clampOffset(metrics.scrollLeft, colCount * colWidth - viewportWidth),
    viewportHeight,
    viewportWidth,
    rowHeight,
    colWidth,
    rowCount,
    colCount,
    overscanRows: normalizeOverscan(metrics.overscanRows),
    overscanCols: normalizeOverscan(metrics.overscanCols),
  }
}

// getVisibleWindow returns the unhidden window math. Callers that
// need hidden-aware visible windows should use
// getVisibleWindowWithHidden together with getHiddenRowsForSheet /
// getHiddenColumnsForSheet.
export function getVisibleWindow(metrics: ViewportMetrics): VisibleWindow {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const rowHeight = normalizedMetrics.rowHeight
  const colWidth = normalizedMetrics.colWidth
  const rowCount = normalizedMetrics.rowCount
  const colCount = normalizedMetrics.colCount

  if (rowCount === 0 || colCount === 0) {
    return {
      rowStart: 0,
      rowEnd: -1,
      colStart: 0,
      colEnd: -1,
    }
  }

  const rawRowStart = Math.floor(normalizedMetrics.scrollTop / rowHeight)
  const rawColStart = Math.floor(normalizedMetrics.scrollLeft / colWidth)
  const visibleRows = Math.ceil(normalizedMetrics.viewportHeight / rowHeight)
  const visibleCols = Math.ceil(normalizedMetrics.viewportWidth / colWidth)

  const rowStart = clampIndex(rawRowStart - normalizedMetrics.overscanRows, rowCount)
  const colStart = clampIndex(rawColStart - normalizedMetrics.overscanCols, colCount)
  const rowEnd = clampIndex(
    rawRowStart + Math.max(1, visibleRows) + normalizedMetrics.overscanRows - 1,
    rowCount,
  )
  const colEnd = clampIndex(
    rawColStart + Math.max(1, visibleCols) + normalizedMetrics.overscanCols - 1,
    colCount,
  )

  return {
    rowStart,
    rowEnd,
    colStart,
    colEnd,
  }
}

/** Returns the count of indices in [start, end] that are NOT in hidden (assumed sorted). */
export function countVisibleIndices(start: number, end: number, hidden: number[]): number {
  if (start > end) return 0
  let hiddenCount = 0
  for (const h of hidden) {
    if (h < start) continue
    if (h > end) break
    hiddenCount++
  }
  return end - start + 1 - hiddenCount
}

/**
 * Like getVisibleWindow but inflates rowEnd / colEnd to account for hidden rows/cols,
 * so the window always contains the same number of *visible* indices as the unhidden
 * window span (base.rowEnd - base.rowStart + 1) would have if no rows were hidden.
 */
export function getVisibleWindowWithHidden(
  metrics: ViewportMetrics,
  hidden: { rows: number[]; cols: number[] },
): VisibleWindow {
  const base = getVisibleWindow(metrics)
  const m = normalizeViewportMetrics(metrics)

  if (m.rowCount === 0 || m.colCount === 0) return base

  // Target: how many visible rows/cols should the inflated window contain —
  // same as the unhidden span (base already factors in clamp/overscan).
  const targetRows = base.rowEnd - base.rowStart + 1
  const targetCols = base.colEnd - base.colStart + 1

  // Inflate rowEnd: walk from rowStart forward, counting visible (non-hidden)
  // indices until we've seen targetRows visible ones or hit the last row.
  let rowEnd = base.rowStart - 1
  let seenRows = 0
  for (let r = base.rowStart; r < m.rowCount && seenRows < targetRows; r++) {
    rowEnd = r
    if (!hidden.rows.includes(r)) seenRows++
  }
  if (rowEnd < base.rowStart) rowEnd = Math.min(base.rowStart, m.rowCount - 1)

  let colEnd = base.colStart - 1
  let seenCols = 0
  for (let c = base.colStart; c < m.colCount && seenCols < targetCols; c++) {
    colEnd = c
    if (!hidden.cols.includes(c)) seenCols++
  }
  if (colEnd < base.colStart) colEnd = Math.min(base.colStart, m.colCount - 1)

  return { rowStart: base.rowStart, rowEnd, colStart: base.colStart, colEnd }
}

export function isCellInVisibleWindow(coord: CellCoord, visibleWindow: VisibleWindow): boolean {
  return (
    visibleWindow.rowStart <= visibleWindow.rowEnd &&
    visibleWindow.colStart <= visibleWindow.colEnd &&
    coord.row >= visibleWindow.rowStart &&
    coord.row <= visibleWindow.rowEnd &&
    coord.col >= visibleWindow.colStart &&
    coord.col <= visibleWindow.colEnd
  )
}

export function getCellViewportRect(coord: CellCoord, metrics: ViewportMetrics): CellViewportRect {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const row = clampIndex(coord.row, normalizedMetrics.rowCount)
  const col = clampIndex(coord.col, normalizedMetrics.colCount)

  return {
    row,
    col,
    top: row * normalizedMetrics.rowHeight - normalizedMetrics.scrollTop,
    left: col * normalizedMetrics.colWidth - normalizedMetrics.scrollLeft,
    height: normalizedMetrics.rowHeight,
    width: normalizedMetrics.colWidth,
  }
}

export function getViewportScrollForCell(
  metrics: ViewportMetrics,
  input: ScrollToCellInput,
): ViewportScrollPosition {
  const normalizedMetrics = normalizeViewportMetrics(metrics)
  const row = clampIndex(input.coord.row, normalizedMetrics.rowCount)
  const col = clampIndex(input.coord.col, normalizedMetrics.colCount)
  const cellTop = row * normalizedMetrics.rowHeight
  const cellLeft = col * normalizedMetrics.colWidth
  const maxScrollTop = normalizedMetrics.rowCount * normalizedMetrics.rowHeight
  const maxScrollLeft = normalizedMetrics.colCount * normalizedMetrics.colWidth

  return {
    scrollTop: getAlignedScrollOffset({
      align: input.rowAlign ?? 'nearest',
      current: normalizedMetrics.scrollTop,
      viewportSize: normalizedMetrics.viewportHeight,
      cellStart: cellTop,
      cellSize: normalizedMetrics.rowHeight,
      totalSize: maxScrollTop,
    }),
    scrollLeft: getAlignedScrollOffset({
      align: input.colAlign ?? 'nearest',
      current: normalizedMetrics.scrollLeft,
      viewportSize: normalizedMetrics.viewportWidth,
      cellStart: cellLeft,
      cellSize: normalizedMetrics.colWidth,
      totalSize: maxScrollLeft,
    }),
  }
}

export function getViewportRowHeight(
  state: ViewportSizeOverrideState,
  sheetId: string,
  rowIndex: number,
  fallback: number,
): number {
  const row = normalizeSparseIndex(rowIndex)
  if (row === null) {
    return normalizeFallbackRowHeight(fallback)
  }

  return state.rowHeightsBySheet[sheetId]?.[String(row)] ?? normalizeFallbackRowHeight(fallback)
}

export function getViewportColumnWidth(
  state: ViewportSizeOverrideState,
  sheetId: string,
  colIndex: number,
  fallback: number,
): number {
  const col = normalizeSparseIndex(colIndex)
  if (col === null) {
    return normalizeFallbackColWidth(fallback)
  }

  return state.colWidthsBySheet[sheetId]?.[String(col)] ?? normalizeFallbackColWidth(fallback)
}

export function setViewportRowHeight(
  state: ViewportSizeOverrideState,
  input: SetViewportRowHeightInput,
): ViewportSizeOverrideState {
  const row = normalizeSparseIndex(input.rowIndex)
  if (row === null || input.sheetId.length === 0) {
    return state
  }

  const sheetRows = state.rowHeightsBySheet[input.sheetId] ?? {}
  return {
    ...state,
    rowHeightsBySheet: {
      ...state.rowHeightsBySheet,
      [input.sheetId]: {
        ...sheetRows,
        [String(row)]: normalizeRowHeight(input.heightPx),
      },
    },
  }
}

export function setViewportColumnWidth(
  state: ViewportSizeOverrideState,
  input: SetViewportColumnWidthInput,
): ViewportSizeOverrideState {
  const col = normalizeSparseIndex(input.colIndex)
  if (col === null || input.sheetId.length === 0) {
    return state
  }

  const sheetCols = state.colWidthsBySheet[input.sheetId] ?? {}
  return {
    ...state,
    colWidthsBySheet: {
      ...state.colWidthsBySheet,
      [input.sheetId]: {
        ...sheetCols,
        [String(col)]: normalizeColWidth(input.widthPx),
      },
    },
  }
}

export const viewportMetricsAtom = atom<ViewportMetrics>(DEFAULT_VIEWPORT_METRICS)
viewportMetricsAtom.debugLabel = 'spreadsheet.viewport.metrics'

export const viewportSizeOverridesAtom = atom<ViewportSizeOverrideState>(
  DEFAULT_VIEWPORT_SIZE_OVERRIDES,
)
viewportSizeOverridesAtom.debugLabel = 'spreadsheet.viewport.sizeOverrides'

const viewportMetadataProjectionIdentityAtom = atom<Readonly<object>>(Object.freeze({}))
viewportMetadataProjectionIdentityAtom.debugLabel =
  'spreadsheet.viewport.metadataProjectionIdentity'

function rotateViewportMetadataProjectionIdentity(set: Setter) {
  set(viewportMetadataProjectionIdentityAtom, Object.freeze({}))
}

export const visibleWindowAtom = atom((get): VisibleWindow => {
  return getVisibleWindow(get(viewportMetricsAtom))
})
visibleWindowAtom.debugLabel = 'spreadsheet.viewport.visibleWindow'

export const setViewportMetricsAtom = atom(
  (get) => get(viewportMetricsAtom),
  (_get, set, metrics: ViewportMetrics) => {
    set(viewportMetricsAtom, normalizeViewportMetrics(metrics))
  },
)
setViewportMetricsAtom.debugLabel = 'spreadsheet.viewport.setMetrics'

export const scrollToCellAtom = atom(
  (get) => get(viewportMetricsAtom),
  (get, set, input: ScrollToCellInput): ViewportScrollPosition => {
    const metrics = get(viewportMetricsAtom)
    const scrollPosition = getViewportScrollForCell(metrics, input)

    set(viewportMetricsAtom, {
      ...metrics,
      ...scrollPosition,
    })

    return scrollPosition
  },
)
scrollToCellAtom.debugLabel = 'spreadsheet.viewport.scrollToCell'

export const setViewportRowHeightAtom = atom(
  (get) => get(viewportSizeOverridesAtom),
  (get, set, input: SetViewportRowHeightInput): ViewportSizeOverrideState => {
    const state = get(viewportSizeOverridesAtom)
    const nextState = setViewportRowHeight(state, input)
    set(viewportSizeOverridesAtom, nextState)
    if (nextState !== state) rotateViewportMetadataProjectionIdentity(set)
    return nextState
  },
)
setViewportRowHeightAtom.debugLabel = 'spreadsheet.viewport.setRowHeight'

export const setViewportColumnWidthAtom = atom(
  (get) => get(viewportSizeOverridesAtom),
  (get, set, input: SetViewportColumnWidthInput): ViewportSizeOverrideState => {
    const state = get(viewportSizeOverridesAtom)
    const nextState = setViewportColumnWidth(state, input)
    set(viewportSizeOverridesAtom, nextState)
    if (nextState !== state) rotateViewportMetadataProjectionIdentity(set)
    return nextState
  },
)
setViewportColumnWidthAtom.debugLabel = 'spreadsheet.viewport.setColumnWidth'

/** Framework-neutral transport for the windowed row-height / column-width hydration. */
export interface ViewportSizeProjectionPort {
  readViewportSizeProjection?: (
    request: ViewportSizeProjectionRequest,
  ) => Promise<ViewportSizeProjectionResult>
}

export interface HydrateViewportSizeProjectionInput {
  readonly source: ViewportSizeProjectionPort
  readonly sheetId: string
  readonly window: Readonly<CellRange>
}

export type ViewportSizeHydrationOutcome = 'ready' | 'blocked' | 'unsupported' | 'stale'

type ViewportSizeHydrationTicket = Readonly<{
  source: ViewportSizeProjectionPort
  sheetId: string
  window: Readonly<CellRange>
  requestId: ProjectionRequestId
  metadataIdentity: Readonly<object>
}>

const activeViewportSizeTicketAtom = atom<ViewportSizeHydrationTicket | null>(null)
activeViewportSizeTicketAtom.debugLabel = 'spreadsheet.viewport.sizeActiveTicket'

const viewportSizeRequestSequenceAtom = atom<ProjectionRequestId>(0)
viewportSizeRequestSequenceAtom.debugLabel = 'spreadsheet.viewport.sizeRequestSequence'

function nextViewportSizeRequestId(sequence: ProjectionRequestId): ProjectionRequestId | null {
  return Number.isSafeInteger(sequence) && sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : null
}

function snapshotSizeWindow(value: unknown): Readonly<CellRange> | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<CellRange>
  const { rowStart, rowEnd, colStart, colEnd } = candidate
  if (
    typeof rowStart !== 'number' ||
    typeof rowEnd !== 'number' ||
    typeof colStart !== 'number' ||
    typeof colEnd !== 'number' ||
    !Number.isSafeInteger(rowStart) ||
    !Number.isSafeInteger(rowEnd) ||
    !Number.isSafeInteger(colStart) ||
    !Number.isSafeInteger(colEnd) ||
    rowStart < 0 ||
    colStart < 0 ||
    rowStart > rowEnd ||
    colStart > colEnd
  ) {
    return null
  }
  return Object.freeze({ rowStart, rowEnd, colStart, colEnd })
}

function sizeWindowsMatch(left: Readonly<CellRange>, right: Readonly<CellRange>): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function isSizeRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

type CanonicalViewportSizes = Readonly<{
  rowHeights: readonly Readonly<ViewportRowHeight>[]
  colWidths: readonly Readonly<ViewportColumnWidth>[]
}>

function snapshotCanonicalRowHeights(
  value: unknown,
  range: Readonly<CellRange>,
): readonly Readonly<ViewportRowHeight>[] | null {
  if (!Array.isArray(value)) return null
  const canonical: Readonly<ViewportRowHeight>[] = []
  let previousIndex = -1
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const { rowIndex, heightPx } = entry as Partial<ViewportRowHeight>
    if (
      typeof rowIndex !== 'number' ||
      !Number.isSafeInteger(rowIndex) ||
      rowIndex <= previousIndex ||
      rowIndex < range.rowStart ||
      rowIndex > range.rowEnd ||
      typeof heightPx !== 'number' ||
      !Number.isFinite(heightPx) ||
      heightPx < MIN_VIEWPORT_ROW_HEIGHT ||
      heightPx > MAX_VIEWPORT_ROW_HEIGHT
    ) {
      return null
    }
    canonical.push(Object.freeze({ rowIndex, heightPx }))
    previousIndex = rowIndex
  }
  return Object.freeze(canonical)
}

function snapshotCanonicalColumnWidths(
  value: unknown,
  range: Readonly<CellRange>,
): readonly Readonly<ViewportColumnWidth>[] | null {
  if (!Array.isArray(value)) return null
  const canonical: Readonly<ViewportColumnWidth>[] = []
  let previousIndex = -1
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const { colIndex, widthPx } = entry as Partial<ViewportColumnWidth>
    if (
      typeof colIndex !== 'number' ||
      !Number.isSafeInteger(colIndex) ||
      colIndex <= previousIndex ||
      colIndex < range.colStart ||
      colIndex > range.colEnd ||
      typeof widthPx !== 'number' ||
      !Number.isFinite(widthPx) ||
      widthPx < MIN_VIEWPORT_COL_WIDTH ||
      widthPx > MAX_VIEWPORT_COL_WIDTH
    ) {
      return null
    }
    canonical.push(Object.freeze({ colIndex, widthPx }))
    previousIndex = colIndex
  }
  return Object.freeze(canonical)
}

function matchingCanonicalViewportSizes(
  value: unknown,
  ticket: ViewportSizeHydrationTicket,
): CanonicalViewportSizes | null {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<ViewportSizeProjectionResult>
  const range = ticket.window
  if (
    result.kind !== 'viewport-size' ||
    result.sheetId !== ticket.sheetId ||
    result.requestId !== ticket.requestId ||
    !isSizeRevision(result.revision) ||
    !result.window ||
    !sizeWindowsMatch(result.window, range)
  ) {
    return null
  }

  const rowHeights = snapshotCanonicalRowHeights(result.rowHeights, range)
  const colWidths = snapshotCanonicalColumnWidths(result.colWidths, range)
  if (!rowHeights || !colWidths) return null
  // Hidden rows/columns are UI-core canonical (viewport/hidden.ts); any
  // hidden slices on the sizes projection are ignored here — they only
  // feed the one-shot `hydrateViewportHiddenAtom` seed.
  return Object.freeze({ rowHeights, colWidths })
}

function reconcileRowHeightWindow(
  current: Readonly<Record<string, number>>,
  canonical: readonly Readonly<ViewportRowHeight>[],
  lower: number,
  upper: number,
): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [key, value] of Object.entries(current)) {
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < lower || index > upper) next[key] = value
  }
  for (const entry of canonical) next[String(entry.rowIndex)] = entry.heightPx
  return next
}

function reconcileColumnWidthWindow(
  current: Readonly<Record<string, number>>,
  canonical: readonly Readonly<ViewportColumnWidth>[],
  lower: number,
  upper: number,
): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [key, value] of Object.entries(current)) {
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < lower || index > upper) next[key] = value
  }
  for (const entry of canonical) next[String(entry.colIndex)] = entry.widthPx
  return next
}

function viewportSizeTicketIsCurrent(get: Getter, ticket: ViewportSizeHydrationTicket): boolean {
  return get(activeViewportSizeTicketAtom) === ticket
}

/**
 * Hydrates the exact row-height / column-width window from the backend
 * sizes projection. Both slices are validated before one synchronous
 * projection commit. Hidden rows/columns are UI-core canonical and are
 * not read here (see viewport/hidden.ts for the one-shot hidden seed).
 */
export const hydrateViewportSizeProjectionAtom = atom(
  null,
  async (
    get,
    set,
    input: HydrateViewportSizeProjectionInput,
  ): Promise<ViewportSizeHydrationOutcome> => {
    const window = snapshotSizeWindow(input.window)
    if (!input.sheetId || !window) return 'blocked'

    const read = input.source.readViewportSizeProjection
    if (!read) return 'unsupported'

    const requestId = nextViewportSizeRequestId(get(viewportSizeRequestSequenceAtom))
    if (requestId === null) return 'blocked'
    const ticket: ViewportSizeHydrationTicket = Object.freeze({
      source: input.source,
      sheetId: input.sheetId,
      window,
      requestId,
      metadataIdentity: get(viewportMetadataProjectionIdentityAtom),
    })
    set(viewportSizeRequestSequenceAtom, requestId)
    set(activeViewportSizeTicketAtom, ticket)

    let result: unknown
    try {
      result = await read({
        kind: 'viewport-size',
        sheetId: ticket.sheetId,
        window: ticket.window,
        requestId: ticket.requestId,
      } satisfies ViewportSizeProjectionRequest)
    } catch {
      if (!viewportSizeTicketIsCurrent(get, ticket)) return 'stale'
      set(activeViewportSizeTicketAtom, null)
      return 'blocked'
    }
    if (!viewportSizeTicketIsCurrent(get, ticket)) return 'stale'

    const canonical = matchingCanonicalViewportSizes(result, ticket)
    if (!canonical) {
      set(activeViewportSizeTicketAtom, null)
      return 'blocked'
    }
    if (get(viewportMetadataProjectionIdentityAtom) !== ticket.metadataIdentity) {
      set(activeViewportSizeTicketAtom, null)
      return 'stale'
    }

    const range = ticket.window
    const sizeState = get(viewportSizeOverridesAtom)
    const nextSizeState: ViewportSizeOverrideState = {
      rowHeightsBySheet: {
        ...sizeState.rowHeightsBySheet,
        [ticket.sheetId]: reconcileRowHeightWindow(
          sizeState.rowHeightsBySheet[ticket.sheetId] ?? {},
          canonical.rowHeights,
          range.rowStart,
          range.rowEnd,
        ),
      },
      colWidthsBySheet: {
        ...sizeState.colWidthsBySheet,
        [ticket.sheetId]: reconcileColumnWidthWindow(
          sizeState.colWidthsBySheet[ticket.sheetId] ?? {},
          canonical.colWidths,
          range.colStart,
          range.colEnd,
        ),
      },
    }

    set(viewportSizeOverridesAtom, nextSizeState)
    rotateViewportMetadataProjectionIdentity(set)
    set(activeViewportSizeTicketAtom, null)
    return 'ready'
  },
)
hydrateViewportSizeProjectionAtom.debugLabel = 'spreadsheet.viewport.hydrateSizeProjection'

const EMPTY_WINDOW: VisibleWindow = { rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 }

export function getFrozenWindows(
  metrics: ViewportMetrics,
  freeze: { rows: number; cols: number },
): FrozenWindows {
  const m = normalizeViewportMetrics(metrics)
  const frozenRows = Math.max(0, Math.min(Math.trunc(freeze.rows), m.rowCount))
  const frozenCols = Math.max(0, Math.min(Math.trunc(freeze.cols), m.colCount))

  const full = getVisibleWindow(metrics)

  const scrollRowStart = Math.max(frozenRows, full.rowStart)
  const scrollRowEnd = full.rowEnd
  const scrollColStart = Math.max(frozenCols, full.colStart)
  const scrollColEnd = full.colEnd

  const hasTopRows = frozenRows > 0
  const hasLeftCols = frozenCols > 0
  const hasScrollRows = scrollRowStart <= scrollRowEnd
  const hasScrollCols = scrollColStart <= scrollColEnd

  const topLeft: VisibleWindow =
    hasTopRows && hasLeftCols
      ? { rowStart: 0, rowEnd: frozenRows - 1, colStart: 0, colEnd: frozenCols - 1 }
      : { ...EMPTY_WINDOW }

  const topRight: VisibleWindow =
    hasTopRows && hasScrollCols
      ? { rowStart: 0, rowEnd: frozenRows - 1, colStart: scrollColStart, colEnd: scrollColEnd }
      : { ...EMPTY_WINDOW }

  const bottomLeft: VisibleWindow =
    hasScrollRows && hasLeftCols
      ? { rowStart: scrollRowStart, rowEnd: scrollRowEnd, colStart: 0, colEnd: frozenCols - 1 }
      : { ...EMPTY_WINDOW }

  const bottomRight: VisibleWindow =
    hasScrollRows && hasScrollCols
      ? {
          rowStart: scrollRowStart,
          rowEnd: scrollRowEnd,
          colStart: scrollColStart,
          colEnd: scrollColEnd,
        }
      : { ...EMPTY_WINDOW }

  return { topLeft, topRight, bottomLeft, bottomRight }
}

function getAlignedScrollOffset(input: {
  align: ViewportCellAlign
  current: number
  viewportSize: number
  cellStart: number
  cellSize: number
  totalSize: number
}): number {
  const cellEnd = input.cellStart + input.cellSize
  const viewportEnd = input.current + input.viewportSize
  let next = input.current

  switch (input.align) {
    case 'start':
      next = input.cellStart
      break
    case 'center':
      next = input.cellStart - (input.viewportSize - input.cellSize) / 2
      break
    case 'end':
      next = cellEnd - input.viewportSize
      break
    case 'nearest':
      if (input.cellStart < input.current) {
        next = input.cellStart
      } else if (cellEnd > viewportEnd) {
        next = cellEnd - input.viewportSize
      }
      break
    default:
      assertNever(input.align)
  }

  return clampOffset(next, input.totalSize - input.viewportSize)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled viewport alignment: ${value}`)
}
