import type { CellCoord, SpreadsheetError } from '../shared'
import type { ProjectionRevision } from '../backend'

export type FormulaBarStatus = 'idle' | 'focused' | 'editing' | 'error'

export type FormulaBarSyncSource = 'selection' | 'editing' | 'backend' | 'paste'

export type FormulaBarDiagnosticLevel = 'info' | 'warning' | 'error'

export interface FormulaBarDiagnostic {
  code: string
  message: string
  level: FormulaBarDiagnosticLevel
}

export interface FormulaBarSyncInput {
  sheetId: string
  cell: CellCoord
  draft: string
  source: FormulaBarSyncSource
  revision?: ProjectionRevision
  diagnostic?: FormulaBarDiagnostic | null
  error?: SpreadsheetError | null
}

export interface FormulaBarState {
  status: FormulaBarStatus
  focused: boolean
  sheetId: string | null
  cell: CellCoord | null
  draft: string
  syncedDraft: string
  syncSource: FormulaBarSyncSource | null
  revision: ProjectionRevision | null
  diagnostic: FormulaBarDiagnostic | null
  error: SpreadsheetError | null
}
