import type { CellRange, SheetRef } from '../shared'
import type { ProjectionRevision } from '../backend/types'

export type SheetProtectionMode = 'open' | 'protected'

export interface SheetProtectionState {
  mode: SheetProtectionMode
  unlockedRanges: CellRange[]
}

export type SheetProtectionBySheet = Record<string, SheetProtectionState>

export interface SetSheetProtectionRequest extends SheetRef {
  kind: 'set-sheet-protection'
  mode: SheetProtectionMode
  unlockedRanges: CellRange[]
  requestId?: number
  revision?: ProjectionRevision
}

export interface SetRangeLockRequest extends SheetRef {
  kind: 'set-range-lock'
  range: CellRange
  locked: boolean
  requestId?: number
  revision?: ProjectionRevision
}
