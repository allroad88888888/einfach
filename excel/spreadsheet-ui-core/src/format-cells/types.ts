import type { CellRange } from '../shared'
import type {
  BackendMutationResult,
  SetFormatRangeRequest,
  SpreadsheetBorderSpec,
  SpreadsheetBorderStyle,
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '../backend'

/**
 * The 12 number-format categories defined by Excel / Luckysheet. The dialog
 * always renders all 12 entries in the category radio list so users can see
 * the full surface. Wave 6.3 widens `SpreadsheetNumberFormat` to cover the
 * full set; unsupported categories (in particular `'special'`) still surface
 * a "coming soon" notice when the engine hasn't wired them through.
 */
export type FormatCellsNumberCategory =
  | 'general'
  | 'number'
  | 'currency'
  | 'accounting'
  | 'date'
  | 'time'
  | 'percentage'
  | 'fraction'
  | 'scientific'
  | 'text'
  | 'special'
  | 'custom'

/** Identifier for a tab inside the Format Cells modal. */
export type FormatCellsTabId = 'number' | 'alignment' | 'font' | 'border' | 'fill'

/**
 * Editor-only draft fields not (yet) part of `SpreadsheetCellFormat`.
 *
 * Wave 6.1 expands the formatting surface beyond what 6.2 and 6.3 land on the
 * core type. The fields below are stored on the editor draft only; backends
 * that don't know about them ignore them when echoing the format back through
 * the projection. They are kept in `FormatCellsDraft` rather than the core
 * type to avoid breaking package-boundary tests on adapters that have not yet
 * widened.
 */
export interface FormatCellsDraftExtras {
  /** Cell-padding indent in increments (>= 0). Mirrors `SpreadsheetCellFormat.indent`. */
  textDirection?: 'context' | 'ltr' | 'rtl'
  /** Underline-style detail (`underline` flag remains canonical). */
  underlineStyle?: 'single' | 'double' | 'accounting'
  /** Vertical-script offset for the text run. */
  verticalScript?: 'superscript' | 'subscript'
  /** Font family stack for the cell. */
  fontFamily?: string
  /** Fill pattern when the cell renders with a non-solid pattern. */
  fillPattern?: 'solid' | 'lined' | 'dotted' | 'crosshatch'
  /** Two-stop linear gradient fill. */
  fillGradient?: FormatCellsGradient
}

export interface FormatCellsGradient {
  from: string
  to: string
  angle: 0 | 45 | 90 | 180
}

/** Forward-compatible cell-format draft used inside the editor. */
export type FormatCellsDraft = SpreadsheetCellFormat & FormatCellsDraftExtras

/** Open-state seed for `openFormatCellsAtom`. */
export interface OpenFormatCellsInput {
  range: CellRange
  sheetId: string
  initialFormat?: SpreadsheetCellFormat | null
  initialTab?: FormatCellsTabId
}

export interface FormatCellsEditorOpenState {
  status: 'open'
  sheetId: string
  range: CellRange
  /** Per-store dialog generation. Late settlements may only close their own generation. */
  sessionId: number
  phase: FormatCellsSavePhase
  requestId: number | null
  pending: boolean
  error: string | null
  activeTab: FormatCellsTabId
  draft: FormatCellsDraft
  dirty: boolean
}

export interface FormatCellsEditorClosedState {
  status: 'closed'
}

export type FormatCellsEditorState = FormatCellsEditorOpenState | FormatCellsEditorClosedState

export type FormatCellsDialogId = 'format-cells' | 'number-format'

/** Subscriber-visible save lifecycle owned by the framework-free core. */
export type FormatCellsSavePhase =
  | 'editing'
  | 'validating'
  | 'pending-published'
  | 'error-open'
  | 'outcome-unknown-blocked'

export interface FormatCellsSaveRequest {
  readonly kind: 'save-format-range'
  readonly dialog: FormatCellsDialogId
  readonly sheetId: string
  /** Logical selection range. A host may fan this out to source projection ranges. */
  readonly range: CellRange
  readonly format: SpreadsheetCellFormat
  readonly sessionId: number
  readonly requestId: number
}

/**
 * A host-local acknowledgement. It means every local port/projection step
 * fulfilled; it deliberately does not claim canonical or durable apply.
 */
export interface FormatCellsLocalAcknowledgement {
  readonly kind: 'local-acknowledged'
  readonly dialog: FormatCellsDialogId
  readonly sheetId: string
  readonly range: CellRange
  readonly sessionId: number
  readonly requestId: number
}

export type FormatCellsResolveSourceRangesPort = (
  sheetId: string,
  range: CellRange,
) => Promise<unknown> | unknown

export type FormatCellsSetFormatRangePort = (
  request: SetFormatRangeRequest,
) => Promise<BackendMutationResult | unknown> | BackendMutationResult | unknown

export type FormatCellsRefreshProjectionPort = (sheetId: string) => Promise<unknown> | unknown

export type FormatCellsReadVisibleProjectionPort = (
  request: VisibleProjectionRequest,
) => Promise<VisibleProjectionResult> | VisibleProjectionResult

/** Provider surface read once at Solid component initialization by a Core command. */
export interface FormatCellsBackendCapabilitySource {
  readonly setFormatRange?: FormatCellsSetFormatRangePort
  readonly readVisibleProjection?: FormatCellsReadVisibleProjectionPort
}

export interface FormatCellsBackendCapabilities {
  readonly setFormatRange?: FormatCellsSetFormatRangePort
  readonly readVisibleProjection?: FormatCellsReadVisibleProjectionPort
}

export interface RunFormatCellsSaveInput {
  /** Ports are captured once. Core owns fan-out, response interpretation and settlement. */
  readonly resolveSourceRanges?: FormatCellsResolveSourceRangesPort
  readonly setFormatRange?: FormatCellsSetFormatRangePort
  readonly refreshProjection?: FormatCellsRefreshProjectionPort
  /** Bounded by Core; tests/hosts may lower it without moving timeout authority into Solid. */
  readonly timeoutMs?: number
}

export type FormatCellsSaveResult =
  | 'blocked'
  | 'error-open'
  | 'local-acknowledged'
  | 'outcome-unknown'
  | 'stale'

export type FormatCellsSaveAttemptStatus = 'pending' | 'local-acknowledged' | 'outcome-unknown'

export interface FormatCellsSaveAttempt {
  readonly operationId: string
  readonly dialog: FormatCellsDialogId
  readonly sheetId: string
  readonly range: CellRange
  readonly sessionId: number
  readonly requestId: number
  readonly status: FormatCellsSaveAttemptStatus
  readonly error?: string
}

/** Re-exports for callers that import draft helpers. */
export type {
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
  SpreadsheetBorderSpec,
  SpreadsheetBorderStyle,
}
