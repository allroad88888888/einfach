import type { CellRange, SheetRef } from '../shared'
import type { ProjectionRevision, ProjectionRequestId } from '../backend/types'
import type { ClipboardPayloadDescriptor, ClipboardRangeDescriptor } from '../clipboard/types'

/**
 * What aspect of the clipboard payload to apply to the target range.
 *
 * - `'values'` — write only the displayed (or evaluated) values, ignoring
 *   formatting and comments.
 * - `'formats'` — apply only the source cell formats (number format, bold,
 *   colors, borders, etc.); leave existing values untouched.
 * - `'values-and-formats'` — values + formats; this is the closest analogue
 *   to a plain paste minus formulas and comments.
 * - `'all'` — same as a plain paste (values + formats + formulas + comments).
 * - `'transpose'` — values written transposed (rows↔columns).
 * - `'column-widths'` — copy source column widths to the target columns.
 * - `'comments'` — copy comments / notes only.
 */
export type PasteSpecialKind =
  | 'values'
  | 'formats'
  | 'values-and-formats'
  | 'all'
  | 'transpose'
  | 'column-widths'
  | 'comments'

/**
 * Arithmetic operation applied between source value and existing target
 * value during paste. `'none'` (default) just writes the source value.
 */
export type PasteSpecialOp = 'none' | 'add' | 'subtract' | 'multiply' | 'divide'

/**
 * Per-instance Paste Special dialog state. Backed by an atom (not a Solid
 * signal) so the dialog survives Solid 1.9.12 provider re-mounts triggered
 * by sibling atom mutations.
 */
export interface PasteSpecialOptions {
  kind: PasteSpecialKind
  op: PasteSpecialOp
  transpose: boolean
  skipBlanks: boolean
}

export const DEFAULT_PASTE_SPECIAL_OPTIONS: PasteSpecialOptions = Object.freeze({
  kind: 'values-and-formats',
  op: 'none',
  transpose: false,
  skipBlanks: false,
})

export type PasteSpecialLifecycleStatus =
  | 'closed'
  | 'editing'
  | 'blocked'
  | 'pending'
  | 'outcome-unknown'
  | 'local-acknowledged'
  | 'refreshing'
  | 'error'

/** Core-owned lifecycle metadata for one frozen Paste Special session. */
export interface PasteSpecialLifecycleState {
  readonly status: PasteSpecialLifecycleStatus
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly sheetId: string | null
}

/**
 * Immutable snapshot captured by `openPasteSpecialAtom`. Selection and
 * clipboard changes after open cannot redirect an in-flight paste.
 */
export interface PasteSpecialSessionSnapshot {
  readonly sessionId: number
  readonly sheetId: string | null
  readonly target: CellRange | null
  readonly source: ClipboardRangeDescriptor | null
  readonly payload: ClipboardPayloadDescriptor | null
  readonly options: PasteSpecialOptions
}

/**
 * Backend request body for an in-place paste-special operation. Carries the
 * source range descriptor + payload, the target range, and the mode flags.
 */
export interface PasteRangeRequest extends SheetRef {
  kind: 'paste-range'
  target: CellRange
  source: {
    sheetId: string
    range: CellRange
    payload?: ClipboardPayloadDescriptor | null
  }
  pasteKind: PasteSpecialKind
  op: PasteSpecialOp
  transpose: boolean
  skipBlanks: boolean
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface PasteRangeResult extends SheetRef {
  kind: 'paste-range'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  affectedRange?: CellRange
}

/** Minimum backend capability consumed by the framework-neutral Core command. */
export interface PasteSpecialControllerPort {
  pasteRange?(request: PasteRangeRequest): Promise<PasteRangeResult>
}

/** Adapter input for one confirm/retry dispatch. */
export interface ConfirmPasteSpecialInput {
  readonly source: PasteSpecialControllerPort
  readonly sessionId: number
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export type PasteSpecialMutationOutcome =
  | 'completed'
  | 'blocked'
  | 'error'
  | 'outcome-unknown'
  | 'stale'

/**
 * Mirror of the input the host adapter receives when wiring a Paste Special
 * confirm. The UI core builds this from the clipboard state and selection
 * snapshot, hands it to whichever backend implements `pasteRange`.
 */
export interface PasteSpecialDispatchInput {
  sheetId: string
  target: CellRange
  source: ClipboardRangeDescriptor
  payload?: ClipboardPayloadDescriptor | null
  options: PasteSpecialOptions
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
