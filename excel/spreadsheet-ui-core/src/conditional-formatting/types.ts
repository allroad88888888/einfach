import type { CellRange, SheetRef } from '../shared'
import type { ProjectionRequestId, ProjectionRevision, SpreadsheetCellFormat } from '../backend'

export type ConditionalFormatRuleId = string

export type ConditionalFormatRuleKind =
  | 'cell-value'
  | 'formula'
  | 'data-bar'
  | 'color-scale'
  | 'top-bottom'

export interface ConditionalFormatScope {
  range: CellRange
}

export interface CellValueRule {
  kind: 'cell-value'
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'not-between'
  value: string
  value2?: string
  format: SpreadsheetCellFormat
}

export interface FormulaRule {
  kind: 'formula'
  formula: string
  format: SpreadsheetCellFormat
}

export interface DataBarRule {
  kind: 'data-bar'
  minColor?: string
  maxColor?: string
}

export interface ColorScaleRule {
  kind: 'color-scale'
  minColor: string
  midColor?: string
  maxColor: string
}

export interface TopBottomRule {
  kind: 'top-bottom'
  direction: 'top' | 'bottom'
  count: number
  percent?: boolean
  format: SpreadsheetCellFormat
}

export type ConditionalFormatRule =
  | CellValueRule
  | FormulaRule
  | DataBarRule
  | ColorScaleRule
  | TopBottomRule

export interface ConditionalFormatRuleEntry {
  id: ConditionalFormatRuleId
  scope: ConditionalFormatScope
  priority: number
  rule: ConditionalFormatRule
}

export interface ConditionalFormatRulesState {
  readonly sheetId: string | null
  readonly rules: readonly ConditionalFormatRuleEntry[]
  /** Revision attached to the latest guarded rules-list response. */
  readonly revision?: ProjectionRevision
}

export interface ConditionalFormatEditorState {
  readonly open: boolean
  readonly sessionId: number
  readonly requestId: ProjectionRequestId | null
  readonly ruleId: ConditionalFormatRuleId | null
  readonly draft: ConditionalFormatRuleEntry | null
  readonly selectedKind: ConditionalFormatRuleKind
  readonly pending: boolean
  readonly error: string | null
}

export type ConditionalFormatOperationAction = 'save' | 'remove'

/**
 * `acknowledged` only records that the current backend port fulfilled. It is
 * not canonical evidence that the mutation was durably applied.
 */
export type ConditionalFormatOperationAttemptStatus = 'pending' | 'acknowledged' | 'outcome-unknown'

/**
 * Bounded local attempt evidence. Pending and outcome-unknown entries remain
 * unresolved and cannot be evicted to make room for a new dispatch.
 */
export interface ConditionalFormatOperationAttempt {
  readonly operationId: string
  readonly requestId: ProjectionRequestId
  readonly sessionId: number
  readonly action: ConditionalFormatOperationAction
  readonly sheetId: string
  readonly ruleId: ConditionalFormatRuleId | null
  readonly scope: ConditionalFormatScope | null
  readonly baseRevision: ProjectionRevision | null
  readonly status: ConditionalFormatOperationAttemptStatus
  readonly resultRevision?: ProjectionRevision
  readonly error?: string
}

export interface ConditionalFormatMutationAcknowledgement extends SheetRef {
  readonly requestId?: ProjectionRequestId
  readonly revision?: ProjectionRevision
}

export interface RunConditionalFormatMutationInput {
  action: ConditionalFormatOperationAction
  /** Explicit targets bypass workspace / selection fallback reads. */
  sheetId?: string
  scope?: ConditionalFormatScope
  setRule?: (
    request: SetConditionalFormatRuleRequest,
  ) => Promise<ConditionalFormatMutationAcknowledgement>
  removeRule?: (
    request: RemoveConditionalFormatRuleRequest,
  ) => Promise<ConditionalFormatMutationAcknowledgement>
  listRules?: (request: ListConditionalFormatRulesRequest) => Promise<ConditionalFormatRulesResult>
  /**
   * Accepts a fulfilled backend response without upgrading it to canonical
   * applied/reconciled evidence.
   */
  acceptAcknowledgedResult?: (
    result: ConditionalFormatMutationAcknowledgement,
  ) => Promise<void> | void
}

export interface SetConditionalFormatRuleRequest extends SheetRef {
  kind: 'set-conditional-format-rule'
  ruleId?: ConditionalFormatRuleId
  scope: ConditionalFormatScope
  priority?: number
  rule: ConditionalFormatRule
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RemoveConditionalFormatRuleRequest extends SheetRef {
  kind: 'remove-conditional-format-rule'
  ruleId: ConditionalFormatRuleId
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ListConditionalFormatRulesRequest extends SheetRef {
  kind: 'list-conditional-format-rules'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ConditionalFormatRulesResult extends SheetRef {
  readonly rules: readonly ConditionalFormatRuleEntry[]
  readonly requestId?: ProjectionRequestId
  readonly revision?: ProjectionRevision
}
