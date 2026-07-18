import type { CellRange, SheetRef, SpreadsheetErrorSeverity } from '../shared'
import type { ProjectionRequestId, ProjectionRevision } from '../backend'

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
  readonly status: 'closed' | 'editing'
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly targetSheetId: string | null
  readonly range?: Readonly<CellRange>
  /** Presence metadata only; the rule value is always derived from `form`. */
  readonly hasRuleDraft: boolean
  readonly form: Readonly<ValidationRuleFormState>
  readonly pending: boolean
  readonly error: string | null
}

export interface ValidationRuleFormState {
  kind: ValidationRuleKind
  mode: ValidationMode
  listValues: string
  listDropdown: boolean
  rangeMin: string
  rangeMax: string
  rangeIntegerOnly: boolean
  regexPattern: string
  regexFlags: string
  formulaText: string
}

export interface OpenValidationRuleEditorInput {
  range?: CellRange
  draft?: ValidationRule
  mode?: ValidationMode
}

export type DataValidationOperationAction = 'save' | 'clear'

/**
 * Fulfilled ports are only acknowledged locally. They do not prove a
 * canonical backend outcome.
 */
export type DataValidationOperationAttemptStatus = 'pending' | 'acknowledged' | 'outcome-unknown'

/** Bounded local request evidence; unresolved attempts are never evicted. */
export interface DataValidationOperationAttempt {
  readonly operationId: string
  readonly requestId: ProjectionRequestId
  readonly sessionId: number
  readonly action: DataValidationOperationAction
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly baseRevision: ProjectionRevision | null
  readonly status: DataValidationOperationAttemptStatus
  readonly resultRevision?: ProjectionRevision
  readonly error?: string
}

export interface DataValidationMutationAcknowledgement extends SheetRef {
  readonly sheetId: string
  readonly requestId: ProjectionRequestId
  readonly revision?: ProjectionRevision
  readonly affectedRange?: Readonly<CellRange>
}

export interface RunDataValidationMutationInput {
  action: DataValidationOperationAction
  sheetId?: string
  setRule?: (request: SetValidationRuleRequest) => Promise<unknown>
  clearRule?: (request: ClearValidationRuleRequest) => Promise<unknown>
  /** Accepts a fulfilled response without claiming it is canonical. */
  acceptAcknowledgedResult?: (result: DataValidationMutationAcknowledgement) => Promise<void> | void
}

export interface SetValidationRuleRequest extends SheetRef {
  kind: 'set-validation-rule'
  range: CellRange
  rule: ValidationRule
  mode: ValidationMode
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ClearValidationRuleRequest extends SheetRef {
  kind: 'clear-validation-rule'
  range: CellRange
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
