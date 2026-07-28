import type { SelectionKind } from '../selection'
import type { EditingSessionStatus } from '../editing/types'
import type {
  BackendMutationResult,
  MergeRangeRequest,
  ProjectionRequestId,
  ProjectionRevision,
  SetFormatRangeRequest,
  SpreadsheetCellFormat,
  UnmergeRangeRequest,
} from '../backend/types'
import type { CellRange } from '../shared'

export type ToolbarSurfaceKind = 'dropdown' | 'palette'

export type ToolbarDropdownKind =
  | 'alignment'
  | 'vertical-alignment'
  | 'number-format'
  | 'border'
  | 'merge'
  | 'font-family'
  | 'font-size'
  | 'rotation'
  | 'sort'

export type ToolbarPaletteKind = 'text-color' | 'fill-color'

export type ToolbarSurfaceId = ToolbarDropdownKind | ToolbarPaletteKind

export interface ToolbarActiveSurface {
  readonly kind: ToolbarSurfaceKind
  readonly id: ToolbarSurfaceId
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
  | 'rotation'
  | 'indent-increase'
  | 'indent-decrease'
  | 'border'
  | 'font-family'
  | 'font-size'
  | 'font-size-up'
  | 'font-size-down'

export interface ToolbarUiState {
  readonly activeSurface: ToolbarActiveSurface | null
}

export interface ToolbarAvailabilitySnapshot {
  readonly sheetId: string | null
  readonly selectionKind: SelectionKind
  readonly editingMode: EditingSessionStatus
}

export interface ToolbarCommandAvailability extends ToolbarAvailabilitySnapshot {
  readonly bold: boolean
  readonly italic: boolean
  readonly textColor: boolean
  readonly fillColor: boolean
  readonly numberFormat: boolean
  readonly alignment: boolean
  readonly verticalAlignment: boolean
  readonly underline: boolean
  readonly strikethrough: boolean
  readonly wrap: boolean
  readonly rotation: boolean
  readonly indent: boolean
  readonly border: boolean
  readonly fontFamily: boolean
  readonly fontSize: boolean
}

export interface ToolbarSurfaceOpenIntent {
  readonly type: 'toolbar.surface.open'
  readonly source: 'toolbar'
  readonly surface: ToolbarActiveSurface
}

export interface ToolbarSurfaceCloseIntent {
  readonly type: 'toolbar.surface.close'
  readonly source: 'toolbar'
}

export interface ToolbarFormatCommandIntent {
  readonly type: 'toolbar.format.command'
  readonly source: 'toolbar'
  readonly sheetId: string
  readonly selectionKind: SelectionKind
  readonly command: ToolbarFormatCommandKind
  readonly value: string | null
}

export type ToolbarIntent =
  | ToolbarSurfaceOpenIntent
  | ToolbarSurfaceCloseIntent
  | ToolbarFormatCommandIntent

export interface OpenToolbarDropdownInput {
  readonly dropdown: ToolbarDropdownKind
}

export interface OpenToolbarPaletteInput {
  readonly palette: ToolbarPaletteKind
}

export interface ToolbarFormatCommandInput {
  sheetId?: string | null
  command: ToolbarFormatCommandKind
  value?: string | null
}

export type ToolbarMutationOperation = 'format' | 'border-batch' | 'merge' | 'unmerge'

export type ToolbarMutationLifecycleStatus =
  | 'ready'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'refresh-failed'
  | 'outcome-unknown'

export interface ToolbarMutationLifecycleState {
  readonly status: ToolbarMutationLifecycleStatus
  readonly sessionId: number
  readonly operation: ToolbarMutationOperation | null
  readonly sheetId: string | null
  readonly requestId: ProjectionRequestId | null
  readonly affectedRange: Readonly<CellRange> | null
  readonly acknowledgedRevision: ProjectionRevision | null
  readonly acknowledgedCount: number
  readonly totalCount: number
  /** True only while Core still owns a refresh-only recovery ticket. */
  readonly canRetryRefresh: boolean
  readonly error: string
}

export type ToolbarMutationStep =
  | {
      readonly kind: 'set-format-range'
      readonly range: Readonly<CellRange>
      readonly format: SpreadsheetCellFormat | null
    }
  | {
      readonly kind: 'merge-range'
      readonly range: Readonly<CellRange>
    }
  | {
      readonly kind: 'unmerge-range'
      readonly range: Readonly<CellRange>
    }

export type ToolbarBackendMutationKind =
  | SetFormatRangeRequest['kind']
  | MergeRangeRequest['kind']
  | UnmergeRangeRequest['kind']

/**
 * Feature-local strict acknowledgement shape. Keeping `kind` here lets the
 * toolbar validate its own transport without widening the shared backend
 * result contract solely for one controller.
 */
export interface ToolbarBackendMutationResult extends BackendMutationResult {
  readonly kind?: ToolbarBackendMutationKind
}

/** Framework-neutral mutation transport. Core snapshots the selected methods at dispatch. */
export interface ToolbarMutationControllerPort {
  setFormatRange?: (request: SetFormatRangeRequest) => Promise<ToolbarBackendMutationResult>
  mergeRange?: (request: MergeRangeRequest) => Promise<ToolbarBackendMutationResult>
  unmergeRange?: (request: UnmergeRangeRequest) => Promise<ToolbarBackendMutationResult>
}

export interface ToolbarMutationIdentityPlan {
  readonly sessionId: number
  readonly requestIds: readonly ProjectionRequestId[]
  readonly requestSequence: number
}

export interface RunToolbarMutationInput {
  readonly source: ToolbarMutationControllerPort
  readonly sheetId: string
  readonly operation: ToolbarMutationOperation
  /** User-visible range recorded in the single history entry after every strict ACK. */
  readonly affectedRange: Readonly<CellRange>
  readonly steps: readonly ToolbarMutationStep[]
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export type ToolbarMutationOutcome =
  | 'completed'
  | 'blocked'
  | 'refresh-failed'
  | 'outcome-unknown'
  | 'stale'
