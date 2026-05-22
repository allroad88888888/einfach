import type { CellRange } from '../shared'
import type { ColumnFilterRule, FilterSortState } from '../filter-sort/types'
import type { ConditionalFormatRuleEntry } from '../conditional-formatting/types'
import type { NamedRange } from '../named-ranges/types'
import type { SpreadsheetCellFormat } from './types'

export function cloneFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...format }
  if (format.numberFormat) clone.numberFormat = { ...format.numberFormat }
  return clone
}

export function cloneRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

export function normalizeRange(range: CellRange): CellRange {
  return {
    rowStart: Math.min(range.rowStart, range.rowEnd),
    rowEnd: Math.max(range.rowStart, range.rowEnd),
    colStart: Math.min(range.colStart, range.colEnd),
    colEnd: Math.max(range.colStart, range.colEnd),
  }
}

export function cloneNamedRange(range: NamedRange): NamedRange {
  return {
    name: range.name,
    scope: range.scope === 'workbook' ? 'workbook' : { sheetId: range.scope.sheetId },
    refersTo: { ...range.refersTo },
  }
}

export function cloneFilterSortRule(rule: ColumnFilterRule): ColumnFilterRule {
  switch (rule.kind) {
    case 'list':
      return { ...rule, values: [...rule.values] }
    default:
      return { ...rule }
  }
}

export function cloneFilterSortState(state: FilterSortState): FilterSortState {
  return {
    rules: state.rules.map(cloneFilterSortRule),
    directives: state.directives.map((directive) => ({ ...directive })),
  }
}

export function filterSortHasEffect(state: FilterSortState | undefined): boolean {
  return !!state && (state.rules.length > 0 || state.directives.length > 0)
}

export function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

export function isCoordInsideRange(
  row: number,
  col: number,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): boolean {
  return (
    row >= range.rowStart &&
    row <= range.rowEnd &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

export function numericValue(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export function normalizeFilterText(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? value : value.toLocaleLowerCase()
}

export function filterRuleMatchesValue(rule: ColumnFilterRule, value: string): boolean {
  switch (rule.kind) {
    case 'equals':
      return (
        normalizeFilterText(value, rule.caseSensitive) ===
        normalizeFilterText(rule.value, rule.caseSensitive)
      )
    case 'contains':
      return normalizeFilterText(value, rule.caseSensitive).includes(
        normalizeFilterText(rule.value, rule.caseSensitive),
      )
    case 'range': {
      const numeric = numericValue(value)
      if (numeric === null) return false
      if (rule.min !== undefined && numeric < rule.min) return false
      if (rule.max !== undefined && numeric > rule.max) return false
      return true
    }
    case 'list':
      return rule.values.includes(value)
  }
}

export function nextConditionalFormatRuleId(rules: readonly ConditionalFormatRuleEntry[]): string {
  const used = new Set(rules.map((rule) => rule.id))
  let index = rules.length + 1
  let id = `cf-${index}`
  while (used.has(id)) {
    index += 1
    id = `cf-${index}`
  }
  return id
}

export function normalizeDimensionSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.round(value))
}

export function estimateUtf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length
  }
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
  }
  return bytes
}
