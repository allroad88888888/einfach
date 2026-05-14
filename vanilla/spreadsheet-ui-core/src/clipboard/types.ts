import type { CellRange, SpreadsheetError, SheetRef } from '../shared'
import type { ProjectionRevision } from '../backend'

export type ClipboardOperation = 'copy' | 'cut' | 'paste'

export type ClipboardPayloadKind = 'range' | 'text'

export type ClipboardPayloadSerialization = 'plain-text' | 'tab-separated' | 'json'

export type ClipboardStatus = 'idle' | 'copying' | 'cutting' | 'pasting' | 'ready' | 'error'

export interface ClipboardRangeDescriptor extends SheetRef {
  range: CellRange
}

export interface ClipboardPayloadDescriptor {
  kind: ClipboardPayloadKind
  source: ClipboardRangeDescriptor
  serialization: ClipboardPayloadSerialization
  cellCount: number
  estimatedBytes: number
  truncated: boolean
  includesFormulas: boolean
  includesErrors: boolean
}

export interface ClipboardTextData {
  /** Row-major tabular text fields. */
  cells: string[][]
  /** A1 address of the copied range top-left. */
  originAddr: string
}

export interface ClipboardTargetDescriptor extends SheetRef {
  range: CellRange
}

export interface ClipboardTransferRequest {
  operation: ClipboardOperation
  source: ClipboardRangeDescriptor
  payload: ClipboardPayloadDescriptor
  target: ClipboardTargetDescriptor | null
  revision: ProjectionRevision | null
}

export interface ClipboardIntent {
  type: 'clipboard.copy' | 'clipboard.cut' | 'clipboard.paste'
  request: ClipboardTransferRequest
}

export interface ClipboardState {
  status: ClipboardStatus
  intent: ClipboardIntent | null
  source: ClipboardRangeDescriptor | null
  target: ClipboardTargetDescriptor | null
  payload: ClipboardPayloadDescriptor | null
  error: SpreadsheetError | null
}

export interface ClipboardPayloadInput {
  source: ClipboardRangeDescriptor
  serialization?: ClipboardPayloadSerialization
  includesFormulas?: boolean
  includesErrors?: boolean
  truncated?: boolean
  estimatedBytes?: number
}

export interface ClipboardTransferInput extends ClipboardPayloadInput {
  target?: ClipboardTargetDescriptor | null
  revision?: ProjectionRevision | null
}
