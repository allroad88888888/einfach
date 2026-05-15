import type { CellRange, SheetRef, SpreadsheetErrorSeverity } from '../shared'

export type ValidationRuleKind = 'list' | 'range' | 'regex' | 'formula'

export type ValidationMode = 'warn' | 'reject'

export interface ValidationListRule {
  kind: 'list'
  values: string[]
  dropdown: boolean
}

export interface ValidationRangeRule {
  kind: 'range'
  min?: number
  max?: number
  integerOnly?: boolean
}

export interface ValidationRegexRule {
  kind: 'regex'
  pattern: string
  flags?: string
}

export interface ValidationFormulaRule {
  kind: 'formula'
  formula: string
}

export type ValidationRule =
  | ValidationListRule
  | ValidationRangeRule
  | ValidationRegexRule
  | ValidationFormulaRule

export interface ValidationOutcome {
  code: string
  severity: SpreadsheetErrorSeverity
  message: string
}

export interface ValidationRuleEditorState {
  status: 'closed' | 'editing'
  range?: CellRange
  draft?: ValidationRule
  mode?: ValidationMode
}

export interface SetValidationRuleRequest extends SheetRef {
  kind: 'set-validation-rule'
  range: CellRange
  rule: ValidationRule
  mode: ValidationMode
  requestId?: number
  revision?: number | string
}

export interface ClearValidationRuleRequest extends SheetRef {
  kind: 'clear-validation-rule'
  range: CellRange
  requestId?: number
  revision?: number | string
}
