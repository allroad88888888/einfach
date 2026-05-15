export type HistoryTransactionId = string

export type HistoryEntryKind =
  | 'cell.set-input'
  | 'cells.import'
  | 'range.clear'
  | 'range.fill'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'
  | 'format.set'

export interface HistoryEntry {
  transactionId: HistoryTransactionId
  kind: HistoryEntryKind
  sheetId: string | null
  projectionRevision: number
  affectedRange?: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }
}

export interface HistoryStackState {
  entries: readonly HistoryEntry[]
  cursor: number
  inFlight: boolean
}

export interface HistoryResolveResult {
  transactionId: HistoryTransactionId
  ok: boolean
  revision?: number | string
}

export interface UndoRequest {
  kind: 'history.undo'
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
}

export interface RedoRequest {
  kind: 'history.redo'
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
}

export interface HistoryMutationResult {
  transactionId: HistoryTransactionId
  requestId?: number
  revision?: number | string
  ok: boolean
}
