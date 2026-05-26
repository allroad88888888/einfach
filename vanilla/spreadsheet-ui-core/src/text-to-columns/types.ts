import type { CellCoord, CellRange } from '../shared'

export type TextToColumnsMode = 'delimited' | 'fixed'

export type TextToColumnsDelimiter = 'tab' | 'semicolon' | 'comma' | 'space' | 'other'

export type TextToColumnsTextQualifier = '"' | "'" | 'none'

export type TextToColumnsColumnFormat = 'general' | 'text' | 'date' | 'skip'

export interface TextToColumnsStep1State {
  step: 'step-1'
  mode: TextToColumnsMode
}

export interface TextToColumnsDelimitedConfig {
  delimiters: ReadonlySet<TextToColumnsDelimiter>
  otherChar: string
  treatConsecutiveAsOne: boolean
  textQualifier: TextToColumnsTextQualifier
}

export interface TextToColumnsStep2DelimitedState {
  step: 'step-2-delimited'
  mode: 'delimited'
  delimited: TextToColumnsDelimitedConfig
}

export interface TextToColumnsFixedConfig {
  breakpoints: readonly number[]
}

export interface TextToColumnsStep2FixedState {
  step: 'step-2-fixed'
  mode: 'fixed'
  fixed: TextToColumnsFixedConfig
}

export interface TextToColumnsStep3State {
  step: 'step-3'
  mode: TextToColumnsMode
  delimited: TextToColumnsDelimitedConfig
  fixed: TextToColumnsFixedConfig
  formats: readonly TextToColumnsColumnFormat[]
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
  sourceRow: number
  tokens: readonly string[]
}

export interface TextToColumnsSourceRow {
  sourceRow: number
  text: string
}

/**
 * Result of `commitTextToColumnsAtom`. The host adapter consumes this and
 * forwards it through `importCellChunks`.
 */
export interface TextToColumnsCommitPlan {
  sheetId: string
  /** Anchor coordinate (top-left of the source column). */
  anchor: CellCoord
  /** Single-column source range used for affected-range bookkeeping. */
  sourceRange: CellRange
  /** Number of output columns (after skip removal). */
  outputColumnCount: number
  cells: readonly ImportCellPlan[]
}

export interface ImportCellPlan {
  row: number
  col: number
  input: string
  preserveAsText?: boolean
}
