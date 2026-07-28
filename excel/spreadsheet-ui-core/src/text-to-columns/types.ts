import type {
  BackendMutationResult,
  ImportCellChunksRequest,
  ProjectionRequestId,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../backend/types'
import type { CellCoord, CellRange } from '../shared'

export type TextToColumnsMode = 'delimited' | 'fixed'

export type TextToColumnsDelimiter = 'tab' | 'semicolon' | 'comma' | 'space' | 'other'

export type TextToColumnsTextQualifier = '"' | "'" | 'none'

export type TextToColumnsColumnFormat = 'general' | 'text' | 'date' | 'skip'

export interface TextToColumnsStep1State {
  readonly step: 'step-1'
  readonly mode: TextToColumnsMode
}

export interface TextToColumnsDelimitedConfig {
  readonly delimiters: ReadonlySet<TextToColumnsDelimiter>
  readonly otherChar: string
  readonly treatConsecutiveAsOne: boolean
  readonly textQualifier: TextToColumnsTextQualifier
}

export interface TextToColumnsStep2DelimitedState {
  readonly step: 'step-2-delimited'
  readonly mode: 'delimited'
  readonly delimited: TextToColumnsDelimitedConfig
}

export interface TextToColumnsFixedConfig {
  readonly breakpoints: readonly number[]
}

export interface TextToColumnsStep2FixedState {
  readonly step: 'step-2-fixed'
  readonly mode: 'fixed'
  readonly fixed: TextToColumnsFixedConfig
}

export interface TextToColumnsStep3State {
  readonly step: 'step-3'
  readonly mode: TextToColumnsMode
  readonly delimited: TextToColumnsDelimitedConfig
  readonly fixed: TextToColumnsFixedConfig
  readonly formats: readonly TextToColumnsColumnFormat[]
}

export type TextToColumnsWizardState =
  | TextToColumnsStep1State
  | TextToColumnsStep2DelimitedState
  | TextToColumnsStep2FixedState
  | TextToColumnsStep3State

/**
 * One row's worth of split tokens. `tokens.length` may differ between rows
 * before the dialog normalizes / pads columns at commit time.
 */
export interface TextToColumnsPreviewRow {
  readonly sourceRow: number
  readonly tokens: readonly string[]
}

export interface TextToColumnsSourceRow {
  readonly sourceRow: number
  readonly text: string
}

export type TextToColumnsLifecycleStatus =
  | 'closed'
  | 'editing'
  | 'blocked'
  | 'pending'
  | 'local-acknowledged'
  | 'refreshing'
  | 'error'
  | 'outcome-unknown'

/** Core-owned lifecycle for one frozen Text to Columns session. */
export interface TextToColumnsLifecycleState {
  readonly status: TextToColumnsLifecycleStatus
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly sheetId: string | null
}

/**
 * Immutable source identity captured when the wizard opens. Later sheet,
 * selection, or dialog sessions cannot redirect an in-flight import.
 */
export interface TextToColumnsSessionSnapshot {
  readonly sessionId: number
  readonly sheetId: string
  readonly anchor: CellCoord
  readonly sourceRange: CellRange
  readonly rows: readonly TextToColumnsSourceRow[]
}

export type TextToColumnsNextBlockReason =
  | 'already-final'
  | 'delimiter-required'
  | 'breakpoint-required'
  | null

/** Every wizard mutation exposed to framework adapters. */
export type TextToColumnsIntent =
  | { readonly kind: 'back' }
  | { readonly kind: 'next' }
  | { readonly kind: 'set-mode'; readonly mode: TextToColumnsMode }
  | { readonly kind: 'toggle-delimiter'; readonly delimiter: TextToColumnsDelimiter }
  | { readonly kind: 'set-other-char'; readonly value: string }
  | { readonly kind: 'set-treat-consecutive'; readonly value: boolean }
  | {
      readonly kind: 'set-text-qualifier'
      readonly value: TextToColumnsTextQualifier
    }
  | { readonly kind: 'set-fixed-breakpoints'; readonly value: string }
  | {
      readonly kind: 'set-column-format'
      readonly columnIndex: number
      readonly format: TextToColumnsColumnFormat
    }

/**
 * Compatibility read model returned by `confirmTextToColumnsAtom`. The
 * actual mutation lifecycle belongs to `runTextToColumnsFinishAtom`.
 */
export interface TextToColumnsCommitPlan {
  readonly sheetId: string
  /** Anchor coordinate (top-left of the source column). */
  readonly anchor: CellCoord
  /** Single-column source range used for affected-range bookkeeping. */
  readonly sourceRange: CellRange
  /** Number of output columns (after skip removal). */
  readonly outputColumnCount: number
  readonly cells: readonly ImportCellPlan[]
}

export interface ImportCellPlan {
  readonly row: number
  readonly col: number
  readonly input: string
  readonly preserveAsText?: boolean
}

/** Minimum backend capability consumed by the framework-neutral Core command. */
export interface TextToColumnsControllerPort {
  importCellChunks?(request: ImportCellChunksRequest): Promise<BackendMutationResult>
}

/** Framework-neutral projection port used to hydrate the default menu entrypoint. */
export interface TextToColumnsEntrypointPort {
  readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult>
}

export type TextToColumnsEntrypointStatus = 'idle' | 'blocked' | 'loading' | 'error' | 'stale'

/** Frozen single-column target captured before the projection request launches. */
export interface TextToColumnsEntrypointTarget {
  readonly sheetId: string
  readonly range: CellRange
  readonly anchor: CellCoord
}

/** Core-owned lifecycle for projection hydration before the TTC-C0 dialog opens. */
export interface TextToColumnsEntrypointState {
  readonly status: TextToColumnsEntrypointStatus
  readonly operationId: number | null
  readonly requestId: ProjectionRequestId | null
  readonly sessionId: number | null
  readonly target: TextToColumnsEntrypointTarget | null
  readonly attempt: number
  readonly error: string
}

/** Public read-only projection consumed by framework adapters. */
export interface TextToColumnsEntrypointProjection extends TextToColumnsEntrypointState {
  readonly pending: boolean
  readonly canRun: boolean
  readonly canRetry: boolean
  readonly disabled: boolean
  readonly disabledReason: string | null
}

/** Typed command input for the default Text to Columns entrypoint. */
export interface RunTextToColumnsEntrypointInput {
  readonly source: TextToColumnsEntrypointPort
}

export type TextToColumnsEntrypointOutcome = 'opened' | 'blocked' | 'loading' | 'error' | 'stale'

/** Adapter input for one finish or refresh-only retry dispatch. */
export interface RunTextToColumnsFinishInput {
  readonly source: TextToColumnsControllerPort
  readonly sessionId: number
  readonly refreshProjection: (sheetId: string) => Promise<void>
}

export type TextToColumnsMutationOutcome =
  | 'completed'
  | 'blocked'
  | 'error'
  | 'outcome-unknown'
  | 'stale'
