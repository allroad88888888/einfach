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
  sheetId: string | null
  rules: readonly ConditionalFormatRuleEntry[]
}

export interface ConditionalFormatEditorState {
  open: boolean
  ruleId: ConditionalFormatRuleId | null
  draft: ConditionalFormatRuleEntry | null
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
  rules: ConditionalFormatRuleEntry[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
