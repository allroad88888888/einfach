import type { CellRange, SheetRef } from '../shared'
import type { ProjectionRevision } from '../backend/types'

export type SheetProtectionMode = 'open' | 'protected'

export interface SheetProtectionState {
  readonly mode: SheetProtectionMode
  readonly unlockedRanges: readonly Readonly<CellRange>[]
}

export type SheetProtectionBySheet = Readonly<Record<string, SheetProtectionState>>

export interface SetSheetProtectionRequest extends SheetRef {
  readonly kind: 'set-sheet-protection'
  readonly mode: SheetProtectionMode
  readonly unlockedRanges: readonly CellRange[]
  readonly requestId?: number
  readonly revision?: ProjectionRevision
}

export interface SetRangeLockRequest extends SheetRef {
  readonly kind: 'set-range-lock'
  readonly range: CellRange
  readonly locked: boolean
  readonly requestId?: number
  readonly revision?: ProjectionRevision
}

export interface SetRangeLockIdentity extends SheetRef {
  readonly kind: 'set-range-lock'
  readonly requestId: number
  readonly affectedRange: CellRange
}

export interface SetRangeLockAcknowledgedResult extends SetRangeLockIdentity {
  readonly outcome: 'acknowledged'
  /** Canonical sheet revision produced by this applied mutation. */
  readonly revision: ProjectionRevision
}

export interface SetRangeLockConfirmedNotAppliedResult extends SetRangeLockIdentity {
  readonly outcome: 'confirmed-not-applied'
  readonly code: 'PERMISSION_DENIED' | 'CONFIRMED_NOT_APPLIED'
  readonly message?: string
}

export interface SetRangeLockOutcomeUnknownResult extends SetRangeLockIdentity {
  readonly outcome: 'outcome-unknown'
  readonly message?: string
}

/** Mutation-only result. It intentionally does not widen BackendMutationResult. */
export type SetRangeLockResult =
  | SetRangeLockAcknowledgedResult
  | SetRangeLockConfirmedNotAppliedResult
  | SetRangeLockOutcomeUnknownResult

interface SetRangeLockPortErrorIdentity extends Error, SheetRef {
  readonly kind: 'set-range-lock-error'
  readonly requestId: number
  readonly affectedRange: CellRange
}

export interface SetRangeLockConfirmedNotAppliedError extends SetRangeLockPortErrorIdentity {
  readonly outcome: 'confirmed-not-applied'
  readonly code: 'PERMISSION_DENIED' | 'CONFIRMED_NOT_APPLIED'
}

export interface SetRangeLockOutcomeUnknownError extends SetRangeLockPortErrorIdentity {
  readonly outcome: 'outcome-unknown'
  readonly code: 'OUTCOME_UNKNOWN'
}

export type SetRangeLockPortError =
  | SetRangeLockConfirmedNotAppliedError
  | SetRangeLockOutcomeUnknownError

export interface ReadSheetProtectionRequest extends SheetRef {
  readonly kind: 'read-sheet-protection'
  readonly requestId: number
}

export interface ReadSheetProtectionResult extends SheetRef {
  readonly kind: 'read-sheet-protection'
  readonly requestId: number
  readonly revision: ProjectionRevision
  readonly protection: SheetProtectionState
}

export type SheetProtectionLoadPhase = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'

/**
 * Readiness for the currently targeted sheet protection projection.
 *
 * Consumers must require `phase === 'ready'` for the same `sheetId` before
 * treating the per-sheet protection snapshot as current backend state.
 */
export interface SheetProtectionLoadState {
  readonly phase: SheetProtectionLoadPhase
  readonly sheetId: string | null
  readonly requestId: number | null
  readonly revision: ProjectionRevision | null
  readonly pending: boolean
  readonly error: string | null
}
