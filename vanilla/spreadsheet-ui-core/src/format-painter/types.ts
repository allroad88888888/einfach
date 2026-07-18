import type {
  BackendMutationResult,
  DisplayCell,
  SetFormatRangeRequest,
  SpreadsheetCellFormat,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '../backend'
import type { CellRange, SpreadsheetError } from '../shared'

export type FormatPainterState = 'idle' | 'armed' | 'sticky'

/**
 * Captured base-format payload held by Core while the painter is armed.
 *
 * W0 deliberately applies only `format`. `conditionalFormat` remains on the
 * compatibility payload so callers do not lose source evidence, but it is
 * never translated into a backend mutation until a dedicated conditional-
 * format port and acknowledgement protocol exist.
 */
export interface CapturedFormat {
  format: SpreadsheetCellFormat
  conditionalFormat?: DisplayCell['conditionalFormat']
}

export interface FormatPainterRangeRef {
  readonly sheetId: string
  readonly range: Readonly<CellRange>
}

export type FormatPainterOperationPhase =
  | 'idle'
  | 'ready'
  | 'pending'
  | 'local-acknowledged'
  | 'outcome-unknown-blocked'
  | 'honest-local-projection-unknown'

/** Immutable mutation authority issued by Core immediately before dispatch. */
export interface FormatPainterMutationTicket {
  readonly operationId: string
  readonly sessionId: number
  readonly requestId: number
  readonly mode: Exclude<FormatPainterState, 'idle'>
  readonly source: FormatPainterRangeRef
  /** User-visible selection that caused this attempt. */
  readonly logicalTarget: FormatPainterRangeRef
  /** Single contiguous backend/source-projection target. */
  readonly target: FormatPainterRangeRef
  readonly format: Readonly<SpreadsheetCellFormat>
}

export type FormatPainterAttemptStatus =
  | 'pending'
  | 'local-acknowledged'
  | 'outcome-unknown'
  | 'honest-local-projection-unknown'

export type FormatPainterLateEvidence =
  | 'late-exact-acknowledgement'
  | 'late-mismatched-acknowledgement'
  | 'late-rejection'

export interface FormatPainterMutationAttempt extends FormatPainterMutationTicket {
  readonly status: FormatPainterAttemptStatus
  readonly error?: string
  /** Evidence only: it must never regain current-session UI authority. */
  readonly lateEvidence?: FormatPainterLateEvidence
}

/** Subscriber-facing aggregate. Every field is committed atomically by Core. */
export interface FormatPainterControllerState {
  readonly state: FormatPainterState
  readonly phase: FormatPainterOperationPhase
  readonly clipboard: Readonly<CapturedFormat> | null
  readonly sessionId: number | null
  readonly source: FormatPainterRangeRef | null
  readonly lastTarget: FormatPainterRangeRef | null
  readonly pendingTicket: FormatPainterMutationTicket | null
  readonly error: Readonly<SpreadsheetError> | null
  readonly blocked: boolean
}

export type FormatPainterResolveTargetRangesPort = (sheetId: string, range: CellRange) => unknown

export type FormatPainterSetFormatRangePort = (
  request: SetFormatRangeRequest,
) => Promise<BackendMutationResult | unknown> | BackendMutationResult | unknown

export type FormatPainterRefreshProjectionPort = (sheetId: string) => Promise<unknown> | unknown

export type FormatPainterReadVisibleProjectionPort = (
  request: VisibleProjectionRequest,
) => Promise<VisibleProjectionResult> | VisibleProjectionResult

/** Provider surface read exactly once by the Core capability-capture command. */
export interface FormatPainterBackendCapabilitySource {
  readonly setFormatRange?: FormatPainterSetFormatRangePort
  readonly readVisibleProjection?: FormatPainterReadVisibleProjectionPort
}

export interface FormatPainterBackendCapabilities {
  readonly setFormatRange?: FormatPainterSetFormatRangePort
  readonly readVisibleProjection?: FormatPainterReadVisibleProjectionPort
}

/**
 * Thin-host ports. Core reads the logical selection and all operation state
 * itself; Solid supplies capabilities only.
 */
export interface ApplyFormatPainterInput {
  readonly resolveTargetRanges?: FormatPainterResolveTargetRangesPort
  readonly setFormatRange?: FormatPainterSetFormatRangePort
  readonly refreshProjection?: FormatPainterRefreshProjectionPort
  readonly timeoutMs?: number
}

export type FormatPainterApplyResult =
  | 'blocked'
  | 'preflight-failed'
  | 'local-acknowledged'
  | 'outcome-unknown'
  | 'honest-local-projection-unknown'
  | 'stale'
