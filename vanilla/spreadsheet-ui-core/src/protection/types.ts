import type { CellRange, SheetRef } from '../shared'
import type { ProjectionRevision } from '../backend/types'

export type SheetProtectionMode = 'open' | 'protected'

export interface SheetProtectionState {
  readonly mode: SheetProtectionMode
  readonly unlockedRanges: readonly Readonly<CellRange>[]
}

export type SheetProtectionBySheet = Readonly<Record<string, SheetProtectionState>>

// Sheet protection is UI-core canonical (CANONICAL_OWNERSHIP flip #40).
// The request/result shapes below survive only as the wire format of the
// optional backend persistence hook: `setSheetProtection` / `setRangeLock`
// mirror local commits fire-and-forget and `readSheetProtection` seeds a
// one-shot hydration. They carry no authority — UI-core never waits for
// them, correlates them, or rolls local state back on their outcome.

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
