import type { CellCoord, CellRange } from '../shared'
import type { FillSeriesDetectionResult } from '../auto-fill/types'

export type PointerSource =
  | 'pointer'
  | 'mouse'
  | 'touch'
  | 'pen'
  | 'keyboard'
  | 'programmatic'
  | 'test'

export type PointerInteractionKind =
  | 'drag-selection'
  | 'fill-handle'
  | 'row-resize'
  | 'column-resize'

export type PointerAutoscrollEdge = 'top' | 'bottom' | 'left' | 'right'

export interface PointerAutoscrollState {
  active: boolean
  edge: PointerAutoscrollEdge | null
  deltaX: number
  deltaY: number
}

export interface PointerSelectionStartInput {
  kind: 'drag-selection'
  sheetId: string
  anchor: CellCoord
  focus?: CellCoord
  append?: boolean
  source?: PointerSource
}

export interface PointerSelectionUpdateInput {
  kind: 'drag-selection'
  focus: CellCoord
  source?: PointerSource
  autoscroll?: PointerAutoscrollInput | null
}

export type PointerFillDirection = 'up' | 'down' | 'left' | 'right'

export interface PointerFillHandleStartInput {
  kind: 'fill-handle'
  sheetId: string
  sourceRange: CellRange
  focus?: CellCoord
  previewRange?: CellRange | null
  direction?: PointerFillDirection | null
  source?: PointerSource
}

export interface PointerFillHandleUpdateInput {
  kind: 'fill-handle'
  focus?: CellCoord
  previewRange?: CellRange | null
  direction?: PointerFillDirection | null
  source?: PointerSource
  autoscroll?: PointerAutoscrollInput | null
}

export interface PointerRowResizeStartInput {
  kind: 'row-resize'
  sheetId: string
  rowIndex: number
  startSizePx?: number | null
  previewSizePx?: number | null
  source?: PointerSource
}

export interface PointerRowResizeUpdateInput {
  kind: 'row-resize'
  previewSizePx?: number | null
  source?: PointerSource
  autoscroll?: PointerAutoscrollInput | null
}

export interface PointerColumnResizeStartInput {
  kind: 'column-resize'
  sheetId: string
  colIndex: number
  startSizePx?: number | null
  previewSizePx?: number | null
  source?: PointerSource
}

export interface PointerColumnResizeUpdateInput {
  kind: 'column-resize'
  previewSizePx?: number | null
  source?: PointerSource
  autoscroll?: PointerAutoscrollInput | null
}

export type PointerStartInput =
  | PointerSelectionStartInput
  | PointerFillHandleStartInput
  | PointerRowResizeStartInput
  | PointerColumnResizeStartInput

export type PointerUpdateInput =
  | PointerSelectionUpdateInput
  | PointerFillHandleUpdateInput
  | PointerRowResizeUpdateInput
  | PointerColumnResizeUpdateInput

export interface PointerAutoscrollInput {
  edge?: PointerAutoscrollEdge | null
  deltaX?: number
  deltaY?: number
  active?: boolean
}

export interface PointerDragSelectionSession {
  kind: 'drag-selection'
  sheetId: string
  anchor: CellCoord
  focus: CellCoord
  range: CellRange
  append?: boolean
}

export interface PointerFillHandleSession {
  kind: 'fill-handle'
  sheetId: string
  sourceRange: CellRange
  focus: CellCoord | null
  previewRange: CellRange | null
  direction: PointerFillDirection | null
  copyOnly?: boolean
  seriesPreview?: FillSeriesDetectionResult | null
}

export interface PointerRowResizeSession {
  kind: 'row-resize'
  sheetId: string
  rowIndex: number
  startSizePx: number | null
  previewSizePx: number | null
}

export interface PointerColumnResizeSession {
  kind: 'column-resize'
  sheetId: string
  colIndex: number
  startSizePx: number | null
  previewSizePx: number | null
}

export type PointerInteractionState =
  | PointerDragSelectionSession
  | PointerFillHandleSession
  | PointerRowResizeSession
  | PointerColumnResizeSession

export interface PointerSessionState {
  status: 'idle' | 'active'
  source: PointerSource | null
  interaction: PointerInteractionState | null
  autoscroll: PointerAutoscrollState | null
}

export interface PointerDragSelectionCommitIntent {
  type: 'pointer.drag-selection.commit'
  sheetId: string
  source: PointerSource | null
  anchor: CellCoord
  focus: CellCoord
  range: CellRange
  append?: boolean
}

export interface PointerFillHandleCommitIntent {
  type: 'pointer.fill-handle.commit'
  sheetId: string
  source: PointerSource | null
  sourceRange: CellRange
  targetRange: CellRange
  focus: CellCoord | null
  direction: PointerFillDirection | null
  copyOnly?: boolean
}

export interface PointerRowResizeCommitIntent {
  type: 'pointer.row-resize.commit'
  sheetId: string
  source: PointerSource | null
  rowIndex: number
  startSizePx: number | null
  previewSizePx: number
}

export interface PointerColumnResizeCommitIntent {
  type: 'pointer.column-resize.commit'
  sheetId: string
  source: PointerSource | null
  colIndex: number
  startSizePx: number | null
  previewSizePx: number
}

export type PointerCommitIntent =
  | PointerDragSelectionCommitIntent
  | PointerFillHandleCommitIntent
  | PointerRowResizeCommitIntent
  | PointerColumnResizeCommitIntent

export type PointerIntent = PointerCommitIntent
