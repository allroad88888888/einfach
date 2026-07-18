import type { CellCoord, CellRange, SheetRef } from '../shared'
import type { SelectionState } from '../selection'
import type { RangeProjectionRequest, RangeProjectionResult } from '../backend'

/**
 * The "simple" vs "special" panes of the Go To dialog.
 */
export type GoToMode = 'simple' | 'special'

/**
 * Sub-filter applied on the `formulas` / `constants` locators. Mirrors the
 * checkboxes Excel surfaces beneath each radio.
 *
 * `null` = no sub-filter (match every value kind).
 */
export type GoToValueKindFilter = 'number' | 'text' | 'logical' | 'error' | null

/**
 * Catalogue of Go To Special selection criteria.
 *
 * `precedents` / `dependents` are listed for UI completeness but inert until a
 * dependency-graph backend port exists; the dialog disables those radios with
 * a tooltip pointing at Wave 9.
 */
export type GoToLocator =
  | { kind: 'formulas'; valueKind: GoToValueKindFilter }
  | { kind: 'constants'; valueKind: GoToValueKindFilter }
  | { kind: 'blanks' }
  | { kind: 'comments' }
  | { kind: 'conditional-format' }
  | { kind: 'data-validation' }
  | { kind: 'last-cell' }
  | { kind: 'current-region' }
  | { kind: 'visible-cells-only' }
  | { kind: 'row-differences' }
  | { kind: 'column-differences' }
  | { kind: 'precedents' }
  | { kind: 'dependents' }

export type GoToLocatorKind = GoToLocator['kind']

/**
 * Default locator surfaced when the dialog opens in Special mode.
 */
export const DEFAULT_GO_TO_LOCATOR: GoToLocator = { kind: 'blanks' }

/**
 * Bound for the recent-jumps history. The 11th entry pushes the oldest out.
 */
export const GO_TO_HISTORY_MAX = 10

/**
 * Bound for Go To Special used-range scans. A 1M-row workbook would freeze
 * the worker if we scanned the entire used range, so we cap the scan-rect
 * cell budget at 100,000 cells and surface an incomplete warning. The Core
 * async orchestrator clips the requested search rect to this budget before
 * invoking the locator engine.
 */
export const GO_TO_SCAN_MAX_CELLS = 100_000

/**
 * Bound for the number of regions packed into a Go To Special result.
 *
 * The grid selection renderer iterates `regions × cells-in-viewport` on every
 * paint, so a worst-case input that can't be coalesced (e.g. a checkerboard
 * blank pattern) must still produce a renderable result. We coalesce
 * contiguous matches into rectangles, and if more than this many distinct
 * regions remain we truncate and set `truncated: true`.
 */
export const GO_TO_REGION_CAP = 500

/**
 * Discriminated-union result of parsing a Go To text input.
 */
export type GoToParseResult =
  | {
      ok: true
      target: GoToTarget
    }
  | {
      ok: false
      reason: GoToParseReason
    }

export type GoToParseReason = 'empty' | 'invalid-address' | 'unknown-name'

export interface GoToTarget extends SheetRef {
  coord?: CellCoord
  range?: CellRange
}

/**
 * Source structure handed to the GoTo parser. The host adapter provides the
 * registered-names list, the active sheet id, and (optionally) the active
 * cell for relative R1C1 resolution. The parser stays pure.
 *
 * `activeCell` defaults to `{ row: 0, col: 0 }` when the host omits it —
 * relative R1C1 references (`R[2]C[-1]`, `RC`, `R[3]C`) are resolved
 * relative to this anchor. Absolute R1C1 (`R3C5`) ignores the anchor.
 */
export interface GoToParseContext {
  activeSheetId: string
  sheets: readonly { id: string; name: string }[]
  registry: readonly NamedRangeLite[]
  activeCell?: CellCoord
}

/**
 * Slim view of a NamedRange the parser actually needs (avoids a circular
 * import between go-to and named-ranges).
 *
 * Mirrors the full `NamedRangeRefersTo` union from `../named-ranges/types`
 * so a `NamedRange` is structurally assignable to `NamedRangeLite`. The
 * Go-To locator silently skips entries whose refersTo isn't a `'range'` —
 * a `'lambda'` binding has no addressable target, and `'constant'` is
 * routed through value parsing in the locator engine.
 */
export interface NamedRangeLite {
  name: string
  scope: { sheetId: string } | 'workbook'
  refersTo:
    | { kind: 'range'; sheetId: string; address: string }
    | { kind: 'constant'; value: string }
    | { kind: 'lambda'; params: string[]; body: string }
}

/**
 * Source DisplayCell shape consumed by the Go To Special predicates. Mirrors
 * the small subset of `DisplayCell` the locators inspect — declared locally
 * so the locator engine stays decoupled from the full projection type.
 *
 * IMPORTANT: this list reflects the host backend's *sparse* projection —
 * blank cells are NOT emitted by `readVisibleProjection` / `readRangeProjection`.
 * The locator engine treats every coord inside `searchRect` that is NOT in
 * `cells` as a blank.
 */
export interface GoToCandidateCell {
  row: number
  col: number
  displayValue: string
  valueKind?: 'blank' | 'number' | 'string' | 'boolean' | 'error'
  formula?: string
  commentThreadId?: string
  conditionalFormat?: unknown
  validation?: unknown
  /** Filter-driven originalRow echo from the projection. */
  originalRow?: number
}

/**
 * Output of the locator scan: a list of selection regions plus an indication
 * of whether the packed result was truncated by `GO_TO_REGION_CAP`. Search
 * rectangle completeness is tracked separately by the async orchestrator.
 */
export interface GoToScanResult {
  regions: readonly SelectionState[]
  truncated: boolean
  totalMatchCount: number
}

/**
 * Context passed into `runGoToSpecialScan`. The engine needs:
 *
 * - `sheetId`            — emitted onto every output SelectionRegion.
 * - `activeCell`         — comparison anchor for row/column differences,
 *                          seed for current-region expansion.
 * - `cells`              — *sparse* candidate cells from the projection (no
 *                          blanks). Blank-coord emission is driven by
 *                          `searchRect` instead.
 * - `searchRect`         — rect to walk for blanks / visible-cells-only.
 *                          Required for those locators; ignored for others
 *                          that walk `cells` directly. For row/column
 *                          differences this is the actual projected slice of
 *                          the normalized current selection, not the used
 *                          range, and MUST stay within
 *                          `GO_TO_SCAN_MAX_CELLS`.
 * - `selectionRect`      — current selection rect, used as the scope for
 *                          row/column differences. The async orchestrator
 *                          passes the same actual projection rect here and in
 *                          `searchRect`; direct pure callers fall back to
 *                          `searchRect` when absent.
 * - `hiddenRows`/`Cols`  — sheet-level hidden indices (from the backend's
 *                          hidden-state port, or projection echo). Drives
 *                          the visible-cells-only filter; blanks in hidden
 *                          rows/cols are excluded.
 */
export interface GoToScanContext {
  sheetId: string
  activeCell: CellCoord
  cells: readonly GoToCandidateCell[]
  searchRect?: CellRange
  selectionRect?: CellRange
  hiddenRows?: readonly number[]
  hiddenCols?: readonly number[]
}

/** Runtime availability of the range-projection port used by Special scans. */
export type GoToSpecialCapability = 'unknown' | 'available' | 'unavailable'

/** Inline error payload owned by Core and projected by framework adapters. */
export interface GoToErrorDetails {
  code: string | null
  params: Readonly<Record<string, unknown>> | null
  message: string | null
}

/** A bounded/incomplete scan keeps the dialog open with this warning. */
export interface GoToSpecialWarning {
  reason: 'regions' | 'cells'
  limit: number
}

/**
 * Framework-neutral read port for the async Go To Special command.
 *
 * The method is optional so Core can expose an explicit unavailable state when
 * an older or partial host adapter has not implemented range projection yet.
 */
export interface GoToSpecialScanPort {
  readRangeProjection?: (request: RangeProjectionRequest) => Promise<RangeProjectionResult>
}

export interface RunGoToSpecialScanInput {
  port: GoToSpecialScanPort | null | undefined
}

/** Public state-machine projection used by adapters and transition tests. */
export type GoToSpecialLifecycle =
  | {
      phase: 'closed'
      sessionId: number
      capability: GoToSpecialCapability
    }
  | {
      phase: 'open'
      sessionId: number
      capability: GoToSpecialCapability
      mode: GoToMode
    }
  | {
      phase: 'scanning'
      sessionId: number
      requestId: number
      sheetId: string
      locator: GoToLocator
      capability: GoToSpecialCapability
    }
  | {
      phase: 'open-error'
      sessionId: number
      capability: GoToSpecialCapability
      mode: GoToMode
      error: GoToErrorDetails
    }
  | {
      phase: 'open-warning'
      sessionId: number
      capability: GoToSpecialCapability
      mode: 'special'
      warning: GoToSpecialWarning
    }
