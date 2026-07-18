import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  HideColumnsRequest,
  HideRowsRequest,
  ProjectionRequestId,
  ProjectionRevision,
  ReadFreezeConfigRequest,
  ReadFreezeConfigResult,
  SetFreezeConfigRequest,
  UnhideColumnsRequest,
  UnhideRowsRequest,
  ViewportFreezeConfig,
  ViewportColumnWidth,
  ViewportRowHeight,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
} from '../backend/types'
import { selectionRegionsAtom, selectionSnapshotAtom } from '../selection'
import type { CellCoord, CellRange } from '../shared'
import type {
  CellViewportRect,
  FrozenWindows,
  ScrollToCellInput,
  SetViewportFreezeInput,
  SetViewportHiddenInput,
  ViewportCellAlign,
  ViewportFreezeState,
  ViewportHiddenState,
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

export const DEFAULT_VIEWPORT_FREEZE_STATE: ViewportFreezeState = {
  rowsBySheet: {},
  colsBySheet: {},
}

const viewportFreezeBackingAtom = atom<ViewportFreezeState>(DEFAULT_VIEWPORT_FREEZE_STATE)
viewportFreezeBackingAtom.debugLabel = 'spreadsheet.viewport.freezeBacking'

/** Read-only projection of the workbook authority. Product code must mutate through the controller. */
export const viewportFreezeAtom = atom((get) => get(viewportFreezeBackingAtom))
viewportFreezeAtom.debugLabel = 'spreadsheet.viewport.freeze'

/** Framework-neutral authority port. Worker backends may omit both methods. */
export interface ViewportFreezeControllerPort {
  readFreezeConfig?: (request: ReadFreezeConfigRequest) => Promise<ReadFreezeConfigResult>
  setFreezeConfig?: (request: SetFreezeConfigRequest) => Promise<BackendMutationResult>
}

export interface ViewportFreezeProjectionAuthorityState {
  readonly source: ViewportFreezeControllerPort | null
  readonly sheetId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly revision: ProjectionRevision | null
  readonly ready: boolean
}

export function supportsViewportFreezeAuthority(source: ViewportFreezeControllerPort): boolean {
  return (
    typeof source.readFreezeConfig === 'function' && typeof source.setFreezeConfig === 'function'
  )
}

export function isViewportFreezeProjectionReady(
  authority: ViewportFreezeProjectionAuthorityState,
  source: ViewportFreezeControllerPort,
  sheetId: string,
): boolean {
  return (
    supportsViewportFreezeAuthority(source) &&
    authority.ready &&
    authority.source === source &&
    authority.sheetId === sheetId &&
    authority.revision !== null
  )
}

export type ViewportFreezeLifecycleStatus =
  | 'idle'
  | 'validating'
  | 'mutating'
  | 'canonical-reading'
  | 'committed'
  | 'error'
  | 'recovery-required'
  | 'unsupported'

export interface ViewportFreezeLifecycleState {
  readonly status: ViewportFreezeLifecycleStatus
  readonly sheetId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly canonical: Readonly<ViewportFreezeConfig> | null
  readonly error: string
}

export type ViewportFreezeCommandOutcome =
  | 'committed'
  | 'error'
  | 'recovery-required'
  | 'unsupported'
  | 'stale'

export interface RunViewportFreezeMutationInput extends SetViewportFreezeInput {
  readonly source: ViewportFreezeControllerPort
}

export interface ReadViewportFreezeCanonicalInput {
  readonly sheetId: string
  readonly source: ViewportFreezeControllerPort
}

type ViewportFreezeTicket = Readonly<{
  mode: 'read' | 'mutation'
  sheetId: string
  requestId: ProjectionRequestId
  source: ViewportFreezeControllerPort
}>

const VIEWPORT_FREEZE_UNSUPPORTED_ERROR =
  'Freeze panes are unavailable because this workbook backend does not provide canonical freeze transport.'
const VIEWPORT_FREEZE_INVALID_ERROR =
  'Freeze panes require a valid sheet and non-negative integer counts.'
const VIEWPORT_FREEZE_RECOVERY_ERROR =
  'The freeze mutation may have been applied, but canonical state could not be confirmed. Read the workbook authority before retrying.'

const INITIAL_VIEWPORT_FREEZE_LIFECYCLE: ViewportFreezeLifecycleState = Object.freeze({
  status: 'idle',
  sheetId: null,
  requestId: null,
  canonical: null,
  error: '',
})

function setViewportFreezeLifecycle(
  set: Setter,
  status: ViewportFreezeLifecycleStatus,
  sheetId: string | null,
  requestId: ProjectionRequestId | null = null,
  canonical: Readonly<ViewportFreezeConfig> | null = null,
  error = '',
) {
  set(viewportFreezeLifecycleBackingAtom, { status, sheetId, requestId, canonical, error })
}

function isFreezeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function snapshotCanonicalFreeze(value: unknown): Readonly<ViewportFreezeConfig> | null {
  if (typeof value !== 'object' || value === null) return null
  const freeze = value as Partial<ViewportFreezeConfig>
  return isFreezeCount(freeze.rows) && isFreezeCount(freeze.cols)
    ? Object.freeze({ rows: freeze.rows, cols: freeze.cols })
    : null
}

function isFreezeRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function nextViewportFreezeRequestId(sequence: ProjectionRequestId): ProjectionRequestId | null {
  return Number.isSafeInteger(sequence) && sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : null
}

function freezeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

function matchingFreezeAcknowledgement(value: unknown, ticket: ViewportFreezeTicket) {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<BackendMutationResult>
  return result.sheetId === ticket.sheetId &&
    result.requestId === ticket.requestId &&
    isFreezeRevision(result.revision)
    ? result.revision
    : null
}

function matchingCanonicalFreeze(
  value: unknown,
  ticket: ViewportFreezeTicket,
  expectedRevision: ProjectionRevision | null,
): { freeze: Readonly<ViewportFreezeConfig>; revision: ProjectionRevision } | null {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<ReadFreezeConfigResult>
  const freeze = snapshotCanonicalFreeze(result.freeze)
  if (
    result.kind !== 'freeze-config' ||
    result.sheetId !== ticket.sheetId ||
    result.requestId !== ticket.requestId ||
    !isFreezeRevision(result.revision) ||
    (expectedRevision !== null && result.revision !== expectedRevision) ||
    freeze === null
  ) {
    return null
  }
  return { freeze, revision: result.revision }
}

const viewportFreezeLifecycleBackingAtom = atom<ViewportFreezeLifecycleState>(
  INITIAL_VIEWPORT_FREEZE_LIFECYCLE,
)
viewportFreezeLifecycleBackingAtom.debugLabel = 'spreadsheet.viewport.freezeLifecycleBacking'

const activeViewportFreezeTicketAtom = atom<ViewportFreezeTicket | null>(null)
activeViewportFreezeTicketAtom.debugLabel = 'spreadsheet.viewport.freezeActiveTicket'

const viewportFreezeRequestSequenceAtom = atom<ProjectionRequestId>(0)
viewportFreezeRequestSequenceAtom.debugLabel = 'spreadsheet.viewport.freezeRequestSequence'

const INITIAL_VIEWPORT_FREEZE_PROJECTION_AUTHORITY: ViewportFreezeProjectionAuthorityState =
  Object.freeze({
    source: null,
    sheetId: null,
    requestId: null,
    revision: null,
    ready: false,
  })

const viewportFreezeProjectionAuthorityBackingAtom = atom<ViewportFreezeProjectionAuthorityState>(
  INITIAL_VIEWPORT_FREEZE_PROJECTION_AUTHORITY,
)
viewportFreezeProjectionAuthorityBackingAtom.debugLabel =
  'spreadsheet.viewport.freezeProjectionAuthorityBacking'

/** Read-only identity/readiness gate for consumers of the canonical freeze projection. */
export const viewportFreezeProjectionAuthorityAtom = atom((get) =>
  get(viewportFreezeProjectionAuthorityBackingAtom),
)
viewportFreezeProjectionAuthorityAtom.debugLabel = 'spreadsheet.viewport.freezeProjectionAuthority'

export const viewportFreezeLifecycleAtom = atom((get) => get(viewportFreezeLifecycleBackingAtom))
viewportFreezeLifecycleAtom.debugLabel = 'spreadsheet.viewport.freezeLifecycle'

function issueViewportFreezeTicket(
  get: Getter,
  set: Setter,
  mode: ViewportFreezeTicket['mode'],
  sheetId: string,
  source: ViewportFreezeControllerPort,
): ViewportFreezeTicket | null {
  const requestId = nextViewportFreezeRequestId(get(viewportFreezeRequestSequenceAtom))
  if (requestId === null) return null
  const ticket = Object.freeze({ mode, sheetId, requestId, source })
  set(viewportFreezeRequestSequenceAtom, requestId)
  set(activeViewportFreezeTicketAtom, ticket)
  return ticket
}

function viewportFreezeTicketIsCurrent(get: Getter, ticket: ViewportFreezeTicket): boolean {
  return get(activeViewportFreezeTicketAtom) === ticket
}

function commitCanonicalFreeze(
  get: Getter,
  set: Setter,
  ticket: ViewportFreezeTicket,
  canonical: Readonly<ViewportFreezeConfig>,
  revision: ProjectionRevision,
): ViewportFreezeCommandOutcome {
  const state = get(viewportFreezeBackingAtom)
  set(viewportFreezeBackingAtom, {
    rowsBySheet: { ...state.rowsBySheet, [ticket.sheetId]: canonical.rows },
    colsBySheet: { ...state.colsBySheet, [ticket.sheetId]: canonical.cols },
  })
  set(viewportFreezeProjectionAuthorityBackingAtom, {
    source: ticket.source,
    sheetId: ticket.sheetId,
    requestId: ticket.requestId,
    revision,
    ready: true,
  })
  set(activeViewportFreezeTicketAtom, null)
  setViewportFreezeLifecycle(set, 'committed', ticket.sheetId, ticket.requestId, canonical)
  return 'committed'
}

function markViewportFreezeProjectionUnconfirmed(
  set: Setter,
  source: ViewportFreezeControllerPort,
  sheetId: string,
  requestId: ProjectionRequestId | null = null,
) {
  set(viewportFreezeProjectionAuthorityBackingAtom, {
    source,
    sheetId,
    requestId,
    revision: null,
    ready: false,
  })
}

function failViewportFreezeTicket(
  set: Setter,
  ticket: ViewportFreezeTicket,
  status: 'error' | 'recovery-required',
  error: string,
): ViewportFreezeCommandOutcome {
  set(activeViewportFreezeTicketAtom, null)
  setViewportFreezeLifecycle(set, status, ticket.sheetId, ticket.requestId, null, error)
  return status
}

export const readViewportFreezeCanonicalAtom = atom(
  null,
  async (
    get,
    set,
    input: ReadViewportFreezeCanonicalInput,
  ): Promise<ViewportFreezeCommandOutcome> => {
    // A mount/backend/sheet read is authoritative and must supersede an older
    // in-flight mutation. The old ticket will observe that it is no longer
    // current and cannot commit into this shared store.
    set(activeViewportFreezeTicketAtom, null)

    const sheetId = input.sheetId
    setViewportFreezeLifecycle(set, 'validating', sheetId)
    if (!sheetId) {
      setViewportFreezeLifecycle(set, 'error', sheetId, null, null, VIEWPORT_FREEZE_INVALID_ERROR)
      return 'error'
    }
    markViewportFreezeProjectionUnconfirmed(set, input.source, sheetId)
    if (!supportsViewportFreezeAuthority(input.source)) {
      setViewportFreezeLifecycle(
        set,
        'unsupported',
        sheetId,
        null,
        null,
        VIEWPORT_FREEZE_UNSUPPORTED_ERROR,
      )
      return 'unsupported'
    }
    const read = input.source.readFreezeConfig!
    const ticket = issueViewportFreezeTicket(get, set, 'read', sheetId, input.source)
    if (!ticket) {
      setViewportFreezeLifecycle(
        set,
        'error',
        sheetId,
        null,
        null,
        'Freeze request identity space is exhausted.',
      )
      return 'error'
    }
    markViewportFreezeProjectionUnconfirmed(set, input.source, sheetId, ticket.requestId)
    await Promise.resolve()
    if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
    setViewportFreezeLifecycle(set, 'canonical-reading', sheetId, ticket.requestId)

    let result: unknown
    try {
      result = await read({
        kind: 'read-freeze-config',
        sheetId,
        requestId: ticket.requestId,
      } satisfies ReadFreezeConfigRequest)
    } catch (error) {
      if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
      return failViewportFreezeTicket(set, ticket, 'error', freezeErrorMessage(error))
    }
    if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
    const canonical = matchingCanonicalFreeze(result, ticket, null)
    return canonical
      ? commitCanonicalFreeze(get, set, ticket, canonical.freeze, canonical.revision)
      : failViewportFreezeTicket(
          set,
          ticket,
          'error',
          'Canonical freeze response did not exactly match the active request.',
        )
  },
)
readViewportFreezeCanonicalAtom.debugLabel = 'spreadsheet.viewport.readCanonicalFreeze'

export const runViewportFreezeMutationAtom = atom(
  null,
  async (
    get,
    set,
    input: RunViewportFreezeMutationInput,
  ): Promise<ViewportFreezeCommandOutcome> => {
    if (get(activeViewportFreezeTicketAtom)?.mode === 'mutation') {
      return 'stale'
    }
    set(activeViewportFreezeTicketAtom, null)

    const sheetId = input.sheetId
    const hasRows = input.rows !== undefined
    const hasCols = input.cols !== undefined
    const explicitRequested =
      hasRows && hasCols ? snapshotCanonicalFreeze({ rows: input.rows, cols: input.cols }) : null
    setViewportFreezeLifecycle(set, 'validating', sheetId)
    if (
      !sheetId ||
      (!hasRows && !hasCols) ||
      (hasRows && !isFreezeCount(input.rows)) ||
      (hasCols && !isFreezeCount(input.cols)) ||
      (hasRows && hasCols && !explicitRequested)
    ) {
      setViewportFreezeLifecycle(set, 'error', sheetId, null, null, VIEWPORT_FREEZE_INVALID_ERROR)
      return 'error'
    }
    const mutate = input.source.setFreezeConfig
    const read = input.source.readFreezeConfig
    if (!mutate || !read) {
      markViewportFreezeProjectionUnconfirmed(set, input.source, sheetId)
      setViewportFreezeLifecycle(
        set,
        'unsupported',
        sheetId,
        null,
        null,
        VIEWPORT_FREEZE_UNSUPPORTED_ERROR,
      )
      return 'unsupported'
    }
    const ticket = issueViewportFreezeTicket(get, set, 'mutation', sheetId, input.source)
    if (!ticket) {
      setViewportFreezeLifecycle(
        set,
        'error',
        sheetId,
        null,
        null,
        'Freeze request identity space is exhausted.',
      )
      return 'error'
    }
    await Promise.resolve()
    if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'

    let requested = explicitRequested
    let preconditionRevision: ProjectionRevision | undefined
    if (!requested) {
      setViewportFreezeLifecycle(set, 'canonical-reading', sheetId, ticket.requestId)
      let preflightResult: unknown
      try {
        preflightResult = await read({
          kind: 'read-freeze-config',
          sheetId,
          requestId: ticket.requestId,
        } satisfies ReadFreezeConfigRequest)
      } catch (error) {
        if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
        return failViewportFreezeTicket(set, ticket, 'error', freezeErrorMessage(error))
      }
      if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
      const canonical = matchingCanonicalFreeze(preflightResult, ticket, null)
      if (!canonical) {
        return failViewportFreezeTicket(
          set,
          ticket,
          'error',
          'Canonical freeze response did not exactly match the active request.',
        )
      }
      requested = Object.freeze({
        rows: hasRows ? input.rows! : canonical.freeze.rows,
        cols: hasCols ? input.cols! : canonical.freeze.cols,
      })
      preconditionRevision = canonical.revision
    }

    markViewportFreezeProjectionUnconfirmed(set, input.source, sheetId, ticket.requestId)
    setViewportFreezeLifecycle(set, 'mutating', sheetId, ticket.requestId)

    let mutationResult: unknown
    try {
      mutationResult = await mutate({
        kind: 'set-freeze-config',
        sheetId,
        requestId: ticket.requestId,
        freeze: requested,
        ...(preconditionRevision === undefined ? {} : { revision: preconditionRevision }),
      } satisfies SetFreezeConfigRequest)
    } catch (error) {
      if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
      return failViewportFreezeTicket(
        set,
        ticket,
        'recovery-required',
        `${VIEWPORT_FREEZE_RECOVERY_ERROR} Backend detail: ${freezeErrorMessage(error)}`,
      )
    }
    if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
    const acknowledgedRevision = matchingFreezeAcknowledgement(mutationResult, ticket)
    if (acknowledgedRevision === null) {
      return failViewportFreezeTicket(
        set,
        ticket,
        'recovery-required',
        VIEWPORT_FREEZE_RECOVERY_ERROR,
      )
    }
    setViewportFreezeLifecycle(set, 'canonical-reading', sheetId, ticket.requestId)

    let result: unknown
    try {
      result = await read({
        kind: 'read-freeze-config',
        sheetId,
        requestId: ticket.requestId,
        revision: acknowledgedRevision,
      } satisfies ReadFreezeConfigRequest)
    } catch (error) {
      if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
      return failViewportFreezeTicket(
        set,
        ticket,
        'recovery-required',
        `${VIEWPORT_FREEZE_RECOVERY_ERROR} Backend detail: ${freezeErrorMessage(error)}`,
      )
    }
    if (!viewportFreezeTicketIsCurrent(get, ticket)) return 'stale'
    const canonical = matchingCanonicalFreeze(result, ticket, acknowledgedRevision)
    return canonical
      ? commitCanonicalFreeze(get, set, ticket, canonical.freeze, canonical.revision)
      : failViewportFreezeTicket(set, ticket, 'recovery-required', VIEWPORT_FREEZE_RECOVERY_ERROR)
  },
)
runViewportFreezeMutationAtom.debugLabel = 'spreadsheet.viewport.runFreezeMutation'

export const DEFAULT_VIEWPORT_HIDDEN_STATE: ViewportHiddenState = {
  rowsBySheet: {},
  colsBySheet: {},
}

function sanitizeIndices(indices: readonly number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const v of indices) {
    if (Number.isSafeInteger(v) && v >= 0 && !seen.has(v)) {
      seen.add(v)
      result.push(v)
    }
  }
  result.sort((a, b) => a - b)
  return result
}

export function isRowHidden(
  state: ViewportHiddenState,
  sheetId: string,
  rowIndex: number,
): boolean {
  return (state.rowsBySheet[sheetId] ?? []).includes(rowIndex)
}

export function isColumnHidden(
  state: ViewportHiddenState,
  sheetId: string,
  colIndex: number,
): boolean {
  return (state.colsBySheet[sheetId] ?? []).includes(colIndex)
}

export function getHiddenRowsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.rowsBySheet[sheetId] ?? []
}

export function getHiddenColumnsForSheet(state: ViewportHiddenState, sheetId: string): number[] {
  return state.colsBySheet[sheetId] ?? []
}

const viewportHiddenBackingAtom = atom<ViewportHiddenState>(DEFAULT_VIEWPORT_HIDDEN_STATE)
viewportHiddenBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenBacking'

const viewportHiddenProjectionIdentityAtom = atom<Readonly<object>>(Object.freeze({}))
viewportHiddenProjectionIdentityAtom.debugLabel = 'spreadsheet.viewport.hiddenProjectionIdentity'

export const viewportHiddenAtom: Atom<ViewportHiddenState> = atom((get) =>
  get(viewportHiddenBackingAtom),
)
viewportHiddenAtom.debugLabel = 'spreadsheet.viewport.hidden'

export const setViewportHiddenAtom = atom(
  (get) => get(viewportHiddenBackingAtom),
  (get, set, input: SetViewportHiddenInput) => {
    if (!input.sheetId || input.sheetId.length === 0) return
    const state = get(viewportHiddenBackingAtom)
    const rows =
      input.rows !== undefined
        ? sanitizeIndices(input.rows)
        : (state.rowsBySheet[input.sheetId] ?? [])
    const cols =
      input.cols !== undefined
        ? sanitizeIndices(input.cols)
        : (state.colsBySheet[input.sheetId] ?? [])
    set(viewportHiddenBackingAtom, {
      rowsBySheet: { ...state.rowsBySheet, [input.sheetId]: rows },
      colsBySheet: { ...state.colsBySheet, [input.sheetId]: cols },
    })
    set(viewportHiddenProjectionIdentityAtom, Object.freeze({}))
    rotateViewportMetadataProjectionIdentity(set)
    invalidateViewportHiddenProjectionAuthority(set)
  },
)
setViewportHiddenAtom.debugLabel = 'spreadsheet.viewport.setHidden'

export type ViewportHiddenMutationAction =
  | 'hide-rows'
  | 'unhide-rows'
  | 'hide-columns'
  | 'unhide-columns'

/** Framework-neutral transport required to mutate and confirm canonical hidden state. */
export interface ViewportHiddenControllerPort {
  readViewportSizeProjection?: (
    request: ViewportSizeProjectionRequest,
  ) => Promise<ViewportSizeProjectionResult>
  hideRows?: (request: HideRowsRequest) => Promise<BackendMutationResult>
  unhideRows?: (request: UnhideRowsRequest) => Promise<BackendMutationResult>
  hideColumns?: (request: HideColumnsRequest) => Promise<BackendMutationResult>
  unhideColumns?: (request: UnhideColumnsRequest) => Promise<BackendMutationResult>
}

export interface RunViewportHiddenMutationInput {
  readonly source: ViewportHiddenControllerPort
  readonly sheetId: string
  readonly action: ViewportHiddenMutationAction
  readonly indices: readonly number[]
  readonly window: Readonly<CellRange>
}

export type ViewportHiddenSelectionMutationAction = 'unhide-rows' | 'unhide-columns'

export interface RunViewportHiddenSelectionMutationInput {
  readonly source: ViewportHiddenControllerPort
  readonly action: ViewportHiddenSelectionMutationAction
}

export interface HydrateViewportSizeProjectionInput {
  readonly source: ViewportHiddenControllerPort
  readonly sheetId: string
  readonly window: Readonly<CellRange>
}

export type ViewportSizeHydrationOutcome =
  | 'ready'
  | 'sizes-only'
  | 'blocked'
  | 'unsupported'
  | 'stale'

export type ViewportHiddenLifecycleStatus =
  | 'idle'
  | 'pending'
  | 'local-acknowledged'
  | 'canonical-reading'
  | 'ready'
  | 'blocked'
  | 'recovery-required'
  | 'unsupported'

export interface ViewportHiddenLifecycleState {
  readonly status: ViewportHiddenLifecycleStatus
  readonly action: ViewportHiddenMutationAction | null
  readonly sheetId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly revision: ProjectionRevision | null
  readonly window: Readonly<CellRange> | null
  readonly error: string
}

export type ViewportHiddenCommandOutcome =
  | 'ready'
  | 'blocked'
  | 'recovery-required'
  | 'unsupported'
  | 'stale'

export interface ViewportHiddenProjectionAuthorityState {
  readonly source: ViewportHiddenControllerPort | null
  readonly sheetId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly revision: ProjectionRevision | null
  readonly window: Readonly<CellRange> | null
  readonly ready: boolean
}

type ViewportHiddenMutationTicket = Readonly<{
  mode: 'mutation'
  source: ViewportHiddenControllerPort
  sheetId: string
  action: ViewportHiddenMutationAction
  indices: readonly number[]
  window: Readonly<CellRange>
  requestId: ProjectionRequestId
  revision: ProjectionRevision | null
  projectionIdentity: Readonly<object>
}>

type ViewportSizeHydrationTicket = Readonly<{
  mode: 'hydrate'
  source: ViewportHiddenControllerPort
  sheetId: string
  window: Readonly<CellRange>
  requestId: ProjectionRequestId
  metadataIdentity: Readonly<object>
}>

type ViewportHiddenTicket = ViewportHiddenMutationTicket | ViewportSizeHydrationTicket

const VIEWPORT_HIDDEN_INVALID_ERROR =
  'Hidden rows and columns require a valid sheet, window, and at least one in-window index.'
const VIEWPORT_HIDDEN_UNSUPPORTED_ERROR =
  'Hidden rows and columns are unavailable because this workbook backend does not provide canonical mutation and readback transport.'
const VIEWPORT_HIDDEN_RECOVERY_ERROR =
  'The hidden rows or columns mutation may have been applied, but canonical state could not be confirmed. Read the workbook authority before retrying.'
const VIEWPORT_HIDDEN_SELECTION_BLOCKED_ERROR =
  'Unhiding rows or columns requires one selection covered by confirmed canonical hidden state.'

const INITIAL_VIEWPORT_HIDDEN_LIFECYCLE: ViewportHiddenLifecycleState = Object.freeze({
  status: 'idle',
  action: null,
  sheetId: null,
  requestId: null,
  revision: null,
  window: null,
  error: '',
})

const INITIAL_VIEWPORT_HIDDEN_PROJECTION_AUTHORITY: ViewportHiddenProjectionAuthorityState =
  Object.freeze({
    source: null,
    sheetId: null,
    requestId: null,
    revision: null,
    window: null,
    ready: false,
  })

const viewportHiddenLifecycleBackingAtom = atom<ViewportHiddenLifecycleState>(
  INITIAL_VIEWPORT_HIDDEN_LIFECYCLE,
)
viewportHiddenLifecycleBackingAtom.debugLabel = 'spreadsheet.viewport.hiddenLifecycleBacking'

/** Read-only mutation lifecycle projection. */
export const viewportHiddenLifecycleAtom = atom((get) => get(viewportHiddenLifecycleBackingAtom))
viewportHiddenLifecycleAtom.debugLabel = 'spreadsheet.viewport.hiddenLifecycle'

const viewportHiddenProjectionAuthorityBackingAtom = atom<ViewportHiddenProjectionAuthorityState>(
  INITIAL_VIEWPORT_HIDDEN_PROJECTION_AUTHORITY,
)
viewportHiddenProjectionAuthorityBackingAtom.debugLabel =
  'spreadsheet.viewport.hiddenProjectionAuthorityBacking'

/** Read-only identity/readiness gate for the canonical hidden projection. */
export const viewportHiddenProjectionAuthorityAtom = atom((get) =>
  get(viewportHiddenProjectionAuthorityBackingAtom),
)
viewportHiddenProjectionAuthorityAtom.debugLabel = 'spreadsheet.viewport.hiddenProjectionAuthority'

function invalidateViewportHiddenProjectionAuthority(set: Setter) {
  set(viewportHiddenProjectionAuthorityBackingAtom, INITIAL_VIEWPORT_HIDDEN_PROJECTION_AUTHORITY)
}

const activeViewportHiddenTicketAtom = atom<ViewportHiddenTicket | null>(null)
activeViewportHiddenTicketAtom.debugLabel = 'spreadsheet.viewport.hiddenActiveTicket'

const viewportHiddenRequestSequenceAtom = atom<ProjectionRequestId>(0)
viewportHiddenRequestSequenceAtom.debugLabel = 'spreadsheet.viewport.hiddenRequestSequence'

function nextViewportHiddenRequestId(sequence: ProjectionRequestId): ProjectionRequestId | null {
  return Number.isSafeInteger(sequence) && sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : null
}

function isViewportHiddenMutationAction(value: unknown): value is ViewportHiddenMutationAction {
  return (
    value === 'hide-rows' ||
    value === 'unhide-rows' ||
    value === 'hide-columns' ||
    value === 'unhide-columns'
  )
}

function snapshotHiddenWindow(value: unknown): Readonly<CellRange> | null {
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

function hiddenWindowsMatch(left: Readonly<CellRange>, right: Readonly<CellRange>): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function isHiddenRevision(value: unknown): value is ProjectionRevision {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0)
  )
}

function setViewportHiddenLifecycle(
  set: Setter,
  status: ViewportHiddenLifecycleStatus,
  input: {
    readonly action?: ViewportHiddenMutationAction | null
    readonly sheetId?: string | null
    readonly requestId?: ProjectionRequestId | null
    readonly revision?: ProjectionRevision | null
    readonly window?: Readonly<CellRange> | null
    readonly error?: string
  } = {},
) {
  set(viewportHiddenLifecycleBackingAtom, {
    status,
    action: input.action ?? null,
    sheetId: input.sheetId ?? null,
    requestId: input.requestId ?? null,
    revision: input.revision ?? null,
    window: input.window ?? null,
    error: input.error ?? '',
  })
}

function supportsViewportHiddenMutation(
  source: ViewportHiddenControllerPort,
  action: ViewportHiddenMutationAction,
): boolean {
  switch (action) {
    case 'hide-rows':
      return typeof source.hideRows === 'function'
    case 'unhide-rows':
      return typeof source.unhideRows === 'function'
    case 'hide-columns':
      return typeof source.hideColumns === 'function'
    case 'unhide-columns':
      return typeof source.unhideColumns === 'function'
  }
}

function matchingHiddenAcknowledgement(value: unknown, ticket: ViewportHiddenMutationTicket) {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<BackendMutationResult>
  return result.sheetId === ticket.sheetId &&
    result.requestId === ticket.requestId &&
    isHiddenRevision(result.revision)
    ? result.revision
    : null
}

function snapshotCanonicalHiddenSlice(
  value: unknown,
  lower: number,
  upper: number,
): readonly number[] | null {
  if (!Array.isArray(value)) return null
  const canonical = sanitizeIndices(value)
  if (
    canonical.length !== value.length ||
    canonical.some((index, offset) => index !== value[offset]) ||
    canonical.some((index) => index < lower || index > upper)
  ) {
    return null
  }
  return Object.freeze(canonical)
}

function matchingCanonicalHiddenProjection(
  value: unknown,
  ticket: ViewportHiddenMutationTicket,
  revision: ProjectionRevision,
): { rows: readonly number[]; cols: readonly number[] } | null {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<ViewportSizeProjectionResult>
  const range = ticket.window
  if (
    result.kind !== 'viewport-size' ||
    result.sheetId !== ticket.sheetId ||
    result.requestId !== ticket.requestId ||
    result.revision !== revision ||
    !result.window ||
    !hiddenWindowsMatch(result.window, range) ||
    !Array.isArray(result.rowHeights) ||
    !Array.isArray(result.colWidths)
  ) {
    return null
  }
  const rows = snapshotCanonicalHiddenSlice(result.hiddenRowIndices, range.rowStart, range.rowEnd)
  const cols = snapshotCanonicalHiddenSlice(result.hiddenColIndices, range.colStart, range.colEnd)
  return rows && cols ? { rows, cols } : null
}

function reconcileHiddenWindow(
  current: readonly number[],
  canonical: readonly number[],
  lower: number,
  upper: number,
): number[] {
  return sanitizeIndices([
    ...current.filter((index) => index < lower || index > upper),
    ...canonical,
  ])
}

type CanonicalViewportMetadata = Readonly<{
  rowHeights: readonly Readonly<ViewportRowHeight>[]
  colWidths: readonly Readonly<ViewportColumnWidth>[]
  revision: ProjectionRevision
  hidden:
    | Readonly<{
        kind: 'full'
        rows: readonly number[]
        cols: readonly number[]
      }>
    | Readonly<{ kind: 'absent' }>
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

function matchingCanonicalViewportMetadata(
  value: unknown,
  ticket: ViewportSizeHydrationTicket,
): CanonicalViewportMetadata | null {
  if (typeof value !== 'object' || value === null) return null
  const result = value as Partial<ViewportSizeProjectionResult>
  const range = ticket.window
  if (
    result.kind !== 'viewport-size' ||
    result.sheetId !== ticket.sheetId ||
    result.requestId !== ticket.requestId ||
    !isHiddenRevision(result.revision) ||
    !result.window ||
    !hiddenWindowsMatch(result.window, range)
  ) {
    return null
  }

  const rowHeights = snapshotCanonicalRowHeights(result.rowHeights, range)
  const colWidths = snapshotCanonicalColumnWidths(result.colWidths, range)
  if (!rowHeights || !colWidths) return null

  const rowsAbsent = result.hiddenRowIndices === undefined
  const colsAbsent = result.hiddenColIndices === undefined
  if (rowsAbsent !== colsAbsent) return null
  if (rowsAbsent) {
    return Object.freeze({
      rowHeights,
      colWidths,
      revision: result.revision,
      hidden: Object.freeze({ kind: 'absent' }),
    })
  }

  const rows = snapshotCanonicalHiddenSlice(result.hiddenRowIndices, range.rowStart, range.rowEnd)
  const cols = snapshotCanonicalHiddenSlice(result.hiddenColIndices, range.colStart, range.colEnd)
  if (!rows || !cols) return null
  return Object.freeze({
    rowHeights,
    colWidths,
    revision: result.revision,
    hidden: Object.freeze({ kind: 'full', rows, cols }),
  })
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

function markViewportHiddenProjectionUnconfirmed(
  set: Setter,
  ticket: ViewportHiddenTicket,
  revision: ProjectionRevision | null = null,
) {
  set(viewportHiddenProjectionAuthorityBackingAtom, {
    source: ticket.source,
    sheetId: ticket.sheetId,
    requestId: ticket.requestId,
    revision,
    window: ticket.window,
    ready: false,
  })
}

function failViewportHiddenTicket(
  set: Setter,
  ticket: ViewportHiddenMutationTicket,
  error = VIEWPORT_HIDDEN_RECOVERY_ERROR,
  revision: ProjectionRevision | null = null,
): ViewportHiddenCommandOutcome {
  set(activeViewportHiddenTicketAtom, null)
  markViewportHiddenProjectionUnconfirmed(set, ticket, revision)
  setViewportHiddenLifecycle(set, 'recovery-required', {
    action: ticket.action,
    sheetId: ticket.sheetId,
    requestId: ticket.requestId,
    revision,
    window: ticket.window,
    error,
  })
  return 'recovery-required'
}

function hiddenErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

function viewportHiddenTicketIsCurrent(get: Getter, ticket: ViewportHiddenTicket): boolean {
  return get(activeViewportHiddenTicketAtom) === ticket
}

function hiddenMutationRequest(ticket: ViewportHiddenMutationTicket) {
  const common = {
    sheetId: ticket.sheetId,
    requestId: ticket.requestId,
    ...(ticket.revision === null ? {} : { revision: ticket.revision }),
  }
  switch (ticket.action) {
    case 'hide-rows':
      return {
        ...common,
        kind: 'hide-rows',
        rowIndices: [...ticket.indices],
      } satisfies HideRowsRequest
    case 'unhide-rows':
      return {
        ...common,
        kind: 'unhide-rows',
        rowIndices: [...ticket.indices],
      } satisfies UnhideRowsRequest
    case 'hide-columns':
      return {
        ...common,
        kind: 'hide-columns',
        colIndices: [...ticket.indices],
      } satisfies HideColumnsRequest
    case 'unhide-columns':
      return {
        ...common,
        kind: 'unhide-columns',
        colIndices: [...ticket.indices],
      } satisfies UnhideColumnsRequest
  }
}

function dispatchViewportHiddenMutation(
  ticket: ViewportHiddenMutationTicket,
): Promise<BackendMutationResult> {
  const request = hiddenMutationRequest(ticket)
  switch (ticket.action) {
    case 'hide-rows':
      return ticket.source.hideRows!(request as HideRowsRequest)
    case 'unhide-rows':
      return ticket.source.unhideRows!(request as UnhideRowsRequest)
    case 'hide-columns':
      return ticket.source.hideColumns!(request as HideColumnsRequest)
    case 'unhide-columns':
      return ticket.source.unhideColumns!(request as UnhideColumnsRequest)
  }
}

/**
 * Hydrates the exact viewport metadata window from workbook authority.
 * All four metadata slices are validated before one synchronous projection commit.
 */
export const hydrateViewportSizeProjectionAtom = atom(
  null,
  async (
    get,
    set,
    input: HydrateViewportSizeProjectionInput,
  ): Promise<ViewportSizeHydrationOutcome> => {
    const activeTicket = get(activeViewportHiddenTicketAtom)
    if (activeTicket?.mode === 'mutation') return 'blocked'

    const window = snapshotHiddenWindow(input.window)
    if (!input.sheetId || !window) {
      if (activeTicket?.mode === 'hydrate') set(activeViewportHiddenTicketAtom, null)
      return 'blocked'
    }

    const read = input.source.readViewportSizeProjection
    if (!read) {
      if (activeTicket?.mode === 'hydrate') set(activeViewportHiddenTicketAtom, null)
      return 'unsupported'
    }

    const requestId = nextViewportHiddenRequestId(get(viewportHiddenRequestSequenceAtom))
    if (requestId === null) {
      if (activeTicket?.mode === 'hydrate') set(activeViewportHiddenTicketAtom, null)
      return 'blocked'
    }
    const ticket: ViewportSizeHydrationTicket = Object.freeze({
      mode: 'hydrate',
      source: input.source,
      sheetId: input.sheetId,
      window,
      requestId,
      metadataIdentity: get(viewportMetadataProjectionIdentityAtom),
    })
    set(viewportHiddenRequestSequenceAtom, requestId)
    set(activeViewportHiddenTicketAtom, ticket)

    let result: unknown
    try {
      result = await read({
        kind: 'viewport-size',
        sheetId: ticket.sheetId,
        window: ticket.window,
        requestId: ticket.requestId,
      } satisfies ViewportSizeProjectionRequest)
    } catch {
      if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'
      set(activeViewportHiddenTicketAtom, null)
      return 'blocked'
    }
    if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'

    const canonical = matchingCanonicalViewportMetadata(result, ticket)
    if (!canonical) {
      set(activeViewportHiddenTicketAtom, null)
      return 'blocked'
    }
    if (get(viewportMetadataProjectionIdentityAtom) !== ticket.metadataIdentity) {
      set(activeViewportHiddenTicketAtom, null)
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

    let nextHiddenState: ViewportHiddenState | null = null
    if (canonical.hidden.kind === 'full') {
      const hiddenState = get(viewportHiddenBackingAtom)
      nextHiddenState = {
        rowsBySheet: {
          ...hiddenState.rowsBySheet,
          [ticket.sheetId]: reconcileHiddenWindow(
            hiddenState.rowsBySheet[ticket.sheetId] ?? [],
            canonical.hidden.rows,
            range.rowStart,
            range.rowEnd,
          ),
        },
        colsBySheet: {
          ...hiddenState.colsBySheet,
          [ticket.sheetId]: reconcileHiddenWindow(
            hiddenState.colsBySheet[ticket.sheetId] ?? [],
            canonical.hidden.cols,
            range.colStart,
            range.colEnd,
          ),
        },
      }
    }

    set(viewportSizeOverridesAtom, nextSizeState)
    if (nextHiddenState) {
      set(viewportHiddenBackingAtom, nextHiddenState)
      set(viewportHiddenProjectionIdentityAtom, Object.freeze({}))
    }
    rotateViewportMetadataProjectionIdentity(set)
    set(viewportHiddenProjectionAuthorityBackingAtom, {
      source: ticket.source,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: canonical.revision,
      window: ticket.window,
      ready: canonical.hidden.kind === 'full',
    })
    set(activeViewportHiddenTicketAtom, null)
    return canonical.hidden.kind === 'full' ? 'ready' : 'sizes-only'
  },
)
hydrateViewportSizeProjectionAtom.debugLabel = 'spreadsheet.viewport.hydrateSizeProjection'

export function isViewportHiddenProjectionReady(
  authority: ViewportHiddenProjectionAuthorityState,
  source: ViewportHiddenControllerPort,
  sheetId: string,
  window: Readonly<CellRange>,
): boolean {
  return (
    authority.ready &&
    authority.source === source &&
    authority.sheetId === sheetId &&
    authority.revision !== null &&
    authority.window !== null &&
    hiddenWindowsMatch(authority.window, window)
  )
}

/**
 * Mutates workbook authority first, then reconciles only the exact canonical readback range.
 * The local projection is never updated optimistically.
 */
export const runViewportHiddenMutationAtom = atom(
  null,
  async (
    get,
    set,
    input: RunViewportHiddenMutationInput,
  ): Promise<ViewportHiddenCommandOutcome> => {
    if (get(activeViewportHiddenTicketAtom)?.mode === 'mutation') return 'blocked'

    const action = isViewportHiddenMutationAction(input.action) ? input.action : null
    const window = snapshotHiddenWindow(input.window)
    const hasValidRawIndices =
      Array.isArray(input.indices) &&
      input.indices.every((index) => Number.isSafeInteger(index) && index >= 0)
    const indices = hasValidRawIndices ? sanitizeIndices(input.indices) : []
    const lower =
      action === 'hide-rows' || action === 'unhide-rows' ? window?.rowStart : window?.colStart
    const upper =
      action === 'hide-rows' || action === 'unhide-rows' ? window?.rowEnd : window?.colEnd
    if (
      !action ||
      !input.sheetId ||
      !window ||
      !hasValidRawIndices ||
      indices.length === 0 ||
      lower === undefined ||
      upper === undefined ||
      indices.some((index) => index < lower || index > upper)
    ) {
      setViewportHiddenLifecycle(set, 'blocked', {
        action,
        sheetId: input.sheetId || null,
        window,
        error: VIEWPORT_HIDDEN_INVALID_ERROR,
      })
      return 'blocked'
    }

    const read = input.source.readViewportSizeProjection
    if (!supportsViewportHiddenMutation(input.source, action) || !read) {
      set(viewportHiddenProjectionAuthorityBackingAtom, {
        source: input.source,
        sheetId: input.sheetId,
        requestId: null,
        revision: null,
        window,
        ready: false,
      })
      setViewportHiddenLifecycle(set, 'unsupported', {
        action,
        sheetId: input.sheetId,
        window,
        error: VIEWPORT_HIDDEN_UNSUPPORTED_ERROR,
      })
      return 'unsupported'
    }

    const requestId = nextViewportHiddenRequestId(get(viewportHiddenRequestSequenceAtom))
    if (requestId === null) {
      setViewportHiddenLifecycle(set, 'blocked', {
        action,
        sheetId: input.sheetId,
        window,
        error: 'Hidden-state request identity space is exhausted.',
      })
      return 'blocked'
    }
    const authority = get(viewportHiddenProjectionAuthorityBackingAtom)
    const revision =
      authority.ready && authority.source === input.source && authority.sheetId === input.sheetId
        ? authority.revision
        : null
    const ticket: ViewportHiddenMutationTicket = Object.freeze({
      mode: 'mutation',
      source: input.source,
      sheetId: input.sheetId,
      action,
      indices: Object.freeze(indices),
      window,
      requestId,
      revision,
      projectionIdentity: get(viewportHiddenProjectionIdentityAtom),
    })
    set(viewportHiddenRequestSequenceAtom, requestId)
    set(activeViewportHiddenTicketAtom, ticket)
    markViewportHiddenProjectionUnconfirmed(set, ticket, revision)
    setViewportHiddenLifecycle(set, 'pending', {
      action: ticket.action,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: ticket.revision,
      window: ticket.window,
    })

    let acknowledgement: unknown
    try {
      acknowledgement = await dispatchViewportHiddenMutation(ticket)
    } catch (error) {
      if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'
      return failViewportHiddenTicket(
        set,
        ticket,
        `${VIEWPORT_HIDDEN_RECOVERY_ERROR} Backend detail: ${hiddenErrorMessage(error)}`,
      )
    }
    if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'
    const revisionAfterMutation = matchingHiddenAcknowledgement(acknowledgement, ticket)
    if (revisionAfterMutation === null) return failViewportHiddenTicket(set, ticket)
    setViewportHiddenLifecycle(set, 'local-acknowledged', {
      action: ticket.action,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: revisionAfterMutation,
      window: ticket.window,
    })
    setViewportHiddenLifecycle(set, 'canonical-reading', {
      action: ticket.action,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: revisionAfterMutation,
      window: ticket.window,
    })

    let projection: unknown
    try {
      projection = await read({
        kind: 'viewport-size',
        sheetId: ticket.sheetId,
        window: ticket.window,
        requestId: ticket.requestId,
        revision: revisionAfterMutation,
      } satisfies ViewportSizeProjectionRequest)
    } catch (error) {
      if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'
      return failViewportHiddenTicket(
        set,
        ticket,
        `${VIEWPORT_HIDDEN_RECOVERY_ERROR} Backend detail: ${hiddenErrorMessage(error)}`,
        revisionAfterMutation,
      )
    }
    if (!viewportHiddenTicketIsCurrent(get, ticket)) return 'stale'
    const canonical = matchingCanonicalHiddenProjection(projection, ticket, revisionAfterMutation)
    if (!canonical) {
      return failViewportHiddenTicket(
        set,
        ticket,
        VIEWPORT_HIDDEN_RECOVERY_ERROR,
        revisionAfterMutation,
      )
    }
    if (get(viewportHiddenProjectionIdentityAtom) !== ticket.projectionIdentity) {
      return failViewportHiddenTicket(
        set,
        ticket,
        `${VIEWPORT_HIDDEN_RECOVERY_ERROR} The local canonical projection changed while the request was in flight.`,
        revisionAfterMutation,
      )
    }

    const state = get(viewportHiddenBackingAtom)
    const range = ticket.window
    const rows = reconcileHiddenWindow(
      state.rowsBySheet[ticket.sheetId] ?? [],
      canonical.rows,
      range.rowStart,
      range.rowEnd,
    )
    const cols = reconcileHiddenWindow(
      state.colsBySheet[ticket.sheetId] ?? [],
      canonical.cols,
      range.colStart,
      range.colEnd,
    )
    set(setViewportHiddenAtom, { sheetId: ticket.sheetId, rows, cols })
    set(viewportHiddenProjectionAuthorityBackingAtom, {
      source: ticket.source,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: revisionAfterMutation,
      window: ticket.window,
      ready: true,
    })
    set(activeViewportHiddenTicketAtom, null)
    setViewportHiddenLifecycle(set, 'ready', {
      action: ticket.action,
      sheetId: ticket.sheetId,
      requestId: ticket.requestId,
      revision: revisionAfterMutation,
      window: ticket.window,
    })
    return 'ready'
  },
)
runViewportHiddenMutationAtom.debugLabel = 'spreadsheet.viewport.runHiddenMutation'

type ViewportHiddenSelectionMutationResolution =
  | Readonly<{ kind: 'ready'; input: RunViewportHiddenMutationInput }>
  | Readonly<{
      kind: 'blocked'
      action: ViewportHiddenSelectionMutationAction | null
      sheetId: string | null
      window: Readonly<CellRange> | null
    }>

function isViewportHiddenSelectionMutationAction(
  value: unknown,
): value is ViewportHiddenSelectionMutationAction {
  return value === 'unhide-rows' || value === 'unhide-columns'
}

function resolveViewportHiddenSelectionMutation(
  get: Getter,
  input: RunViewportHiddenSelectionMutationInput,
): ViewportHiddenSelectionMutationResolution {
  const action = isViewportHiddenSelectionMutationAction(input?.action) ? input.action : null
  const source = input?.source
  const regions = get(selectionRegionsAtom)
  const snapshot = get(selectionSnapshotAtom)
  const sheetId = snapshot.selection.sheetId || null
  const selectionWindow = snapshotHiddenWindow(snapshot.range)
  const authority = get(viewportHiddenProjectionAuthorityBackingAtom)
  const authorityWindow = snapshotHiddenWindow(authority.window)
  const blocked = (): ViewportHiddenSelectionMutationResolution =>
    Object.freeze({
      kind: 'blocked',
      action,
      sheetId,
      window: authorityWindow,
    })

  if (
    !action ||
    !source ||
    regions.length !== 1 ||
    !sheetId ||
    regions[0]?.sheetId !== sheetId ||
    !selectionWindow ||
    !authority.ready ||
    authority.source !== source ||
    authority.sheetId !== sheetId ||
    !isHiddenRevision(authority.revision) ||
    !authorityWindow
  ) {
    return blocked()
  }

  const selectsRows = action === 'unhide-rows'
  const selectionStart = selectsRows ? selectionWindow.rowStart : selectionWindow.colStart
  const selectionEnd = selectsRows ? selectionWindow.rowEnd : selectionWindow.colEnd
  const authorityStart = selectsRows ? authorityWindow.rowStart : authorityWindow.colStart
  const authorityEnd = selectsRows ? authorityWindow.rowEnd : authorityWindow.colEnd
  if (authorityStart > selectionStart || authorityEnd < selectionEnd) return blocked()

  const hidden = get(viewportHiddenBackingAtom)
  const canonicalIndices = selectsRows
    ? (hidden.rowsBySheet[sheetId] ?? [])
    : (hidden.colsBySheet[sheetId] ?? [])
  const indices = sanitizeIndices(canonicalIndices).filter(
    (index) => index >= selectionStart && index <= selectionEnd,
  )
  if (indices.length === 0) return blocked()

  return Object.freeze({
    kind: 'ready',
    input: Object.freeze({
      source,
      sheetId,
      action,
      indices: Object.freeze(indices),
      window: authorityWindow,
    }),
  })
}

/** Resolves an Unhide command from canonical selection and hidden-state authority. */
export const runViewportHiddenSelectionMutationAtom = atom(
  null,
  async (
    get,
    set,
    input: RunViewportHiddenSelectionMutationInput,
  ): Promise<ViewportHiddenCommandOutcome> => {
    if (get(activeViewportHiddenTicketAtom)?.mode === 'mutation') return 'blocked'

    const resolution = resolveViewportHiddenSelectionMutation(get, input)
    if (resolution.kind === 'blocked') {
      setViewportHiddenLifecycle(set, 'blocked', {
        action: resolution.action,
        sheetId: resolution.sheetId,
        window: resolution.window,
        error: VIEWPORT_HIDDEN_SELECTION_BLOCKED_ERROR,
      })
      return 'blocked'
    }

    return set(runViewportHiddenMutationAtom, resolution.input)
  },
)
runViewportHiddenSelectionMutationAtom.debugLabel =
  'spreadsheet.viewport.runHiddenSelectionMutation'

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
