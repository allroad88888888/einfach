import type { SelectionKind } from '../selection'
import type { EditingSessionStatus } from '../editing/types'

export type ToolbarSurfaceKind = 'dropdown' | 'palette'

export type ToolbarDropdownKind = 'alignment' | 'number-format' | 'border'

export type ToolbarPaletteKind = 'text-color' | 'fill-color'

export type ToolbarSurfaceId = ToolbarDropdownKind | ToolbarPaletteKind

export interface ToolbarActiveSurface {
  kind: ToolbarSurfaceKind
  id: ToolbarSurfaceId
}

export type ToolbarFormatCommandKind =
  | 'bold'
  | 'italic'
  | 'text-color'
  | 'fill-color'
  | 'number-format'
  | 'alignment'
  | 'vertical-alignment'
  | 'underline'
  | 'strikethrough'
  | 'wrap'
  | 'indent-increase'
  | 'indent-decrease'
  | 'border'
  | 'font-family'
  | 'font-size'
  | 'font-size-up'
  | 'font-size-down'

export interface ToolbarUiState {
  activeSurface: ToolbarActiveSurface | null
}

export interface ToolbarAvailabilitySnapshot {
  sheetId: string | null
  selectionKind: SelectionKind
  editingMode: EditingSessionStatus
}

export interface ToolbarCommandAvailability extends ToolbarAvailabilitySnapshot {
  bold: boolean
  italic: boolean
  textColor: boolean
  fillColor: boolean
  numberFormat: boolean
  alignment: boolean
  verticalAlignment: boolean
  underline: boolean
  strikethrough: boolean
  wrap: boolean
  indent: boolean
  border: boolean
  fontFamily: boolean
  fontSize: boolean
}

export interface ToolbarSurfaceOpenIntent {
  type: 'toolbar.surface.open'
  source: 'toolbar'
  surface: ToolbarActiveSurface
}

export interface ToolbarSurfaceCloseIntent {
  type: 'toolbar.surface.close'
  source: 'toolbar'
}

export interface ToolbarFormatCommandIntent {
  type: 'toolbar.format.command'
  source: 'toolbar'
  sheetId: string
  selectionKind: SelectionKind
  command: ToolbarFormatCommandKind
  value: string | null
}

export type ToolbarIntent =
  | ToolbarSurfaceOpenIntent
  | ToolbarSurfaceCloseIntent
  | ToolbarFormatCommandIntent

export interface OpenToolbarDropdownInput {
  dropdown: ToolbarDropdownKind
}

export interface OpenToolbarPaletteInput {
  palette: ToolbarPaletteKind
}

export interface ToolbarFormatCommandInput {
  sheetId?: string | null
  command: ToolbarFormatCommandKind
  value?: string | null
}
