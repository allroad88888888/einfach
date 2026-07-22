/**
 * TS filter predicate — the ADAPTER-LAYER copy (design
 * `design-engine-hidden-rows.md` §5.2, slice E4).
 *
 * WHY THIS LIVES HERE AND NOT IN `spreadsheet-ui-core`
 *
 * Filter predicate evaluation is sinking into the Rust engine (`SUBTOTAL`
 * 1-11 vs 101-111 read the filter-hidden set, so "which rows the predicate
 * hid" is a real evaluation input, not a view fact). Under the rule "state
 * that affects calculation belongs to the engine", the predicate must not
 * live in `spreadsheet-ui-core`: that package is the framework-agnostic UI
 * atom layer, and a predicate sitting there reads as canonical. UI-core now
 * has ZERO predicate knowledge — it keeps only the `ColumnFilterRule` WIRE
 * TYPE (`filter-sort/types.ts`).
 *
 * The correct reading of "the engine is the single source of truth" is ONE
 * PREDICATE PER ENGINE, not one predicate globally. `static-backend` is
 * itself a second engine (it has its own `evaluateFormula`), so it legitimately
 * carries a TS predicate; this module is that engine's internal implementation.
 *
 * SCOPE (as-built after E5)
 *
 * Now static-only: E5 deleted the worker adapter's
 * `computeFilterSortDisplayRows` layer (`worker-workbook-backend.ts` no longer
 * imports this module — the worker feeds the engine's `applyFilter` instead),
 * so `static-backend.ts` is the sole importer. The design's slice table calls
 * for renaming this to `static-filter-predicate.ts`; that rename is deferred
 * (it would touch the one importer plus tests for zero behavioural gain) and
 * tracked as available cleanup, not done here.
 *
 * This file is a VERBATIM move out of
 * `vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts` — matching
 * semantics are unchanged, deliberately. Two known-inconsistent behaviours are
 * reproduced as-is and must NOT be "tidied up" here (the Rust predicate in E3
 * has to copy them, and any silent fix would diverge the two engines):
 *
 *  - `list` compares values EXACTLY (`rule.values.includes(value)`) with no
 *    case folding, while `equals` / `contains` honour `caseSensitive`.
 *  - `range` against a non-numeric cell yields `false` (not "no opinion").
 */

import type { ColumnFilterRule, FilterSortState } from '@einfach/spreadsheet-ui-core'
import { filterSortHasEffect, numericValue } from '@einfach/spreadsheet-ui-core'

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

export interface FilterSortOptions {
  /**
   * Row index that holds the header. When provided, the output array sets
   * `rows[headerRow] = headerRow` so callers that include the header row in
   * their projection see it as a pass-through. Omit to skip header marking
   * (e.g. when the projection range does not include the header).
   */
  headerRow?: number
  /** Inclusive lower bound for data rows scanned. */
  startRow: number
  /** Exclusive upper bound for data rows scanned (summary row, if any, is `endRow - 1`). */
  endRow: number
}

export function isFilterSortSummaryRow(
  readValue: (row: number, col: number) => string,
  row: number,
): boolean {
  const label = readValue(row, 0).trim().toLocaleLowerCase()
  return row > 1 && (label === 'total' || label === 'summary')
}

export function rowMatchesFilterSortRules(
  readValue: (row: number, col: number) => string,
  row: number,
  rules: readonly ColumnFilterRule[],
): boolean {
  for (const rule of rules) {
    if (!filterRuleMatchesValue(rule, readValue(row, rule.colIndex))) return false
  }
  return true
}

/**
 * Filter VISIBILITY permutation — never a sort. The display-permutation sort
 * branch was retired with parity #29 / #24: sorting is a physical engine data
 * mutation (`sortRange`). Row order is always source order.
 *
 * NOTE (#27): the permutation this returns is NO LONGER a projection layout.
 * Filtering hides rows instead of compacting them, so display row IS source
 * row and nothing lays cells out by `rows[displayRow]` any more. Both adapters
 * call this purely as an intermediate and immediately fold it into the
 * FILTER-HIDDEN ROW SET via `filterHiddenRowsFromDisplayRows` — the gaps in
 * this sparse array are the answer they actually want. The name and the
 * `number[]` return type are historical; treat the output as "which rows
 * survived the predicate", not as a display order.
 */
export function buildFilterSortDisplayRows(
  state: FilterSortState | undefined,
  options: FilterSortOptions,
  readValue: (row: number, col: number) => string,
): number[] | null {
  if (!filterSortHasEffect(state)) return null

  // Header must sit strictly before the data scan range — otherwise the data row
  // writes at `rows[dataRowStart + index]` below would clobber `rows[headerRow]`.
  if (options.headerRow !== undefined && options.headerRow >= options.startRow) {
    throw new Error(
      `buildFilterSortDisplayRows: headerRow (${options.headerRow}) must be < startRow (${options.startRow})`,
    )
  }

  const maxRow = options.endRow - 1
  if (maxRow < options.startRow) {
    if (options.headerRow === undefined || maxRow < options.headerRow) return []
  }

  const rows: number[] = []
  if (options.headerRow !== undefined) rows[options.headerRow] = options.headerRow

  const hasSummary = maxRow >= options.startRow && isFilterSortSummaryRow(readValue, maxRow)
  const summaryRows = hasSummary ? [maxRow] : []
  const dataRowStart = options.startRow
  const dataRowEnd = hasSummary ? maxRow - 1 : maxRow

  const dataRows: number[] = []
  for (let row = dataRowStart; row <= dataRowEnd; row += 1) {
    if (rowMatchesFilterSortRules(readValue, row, state!.rules)) dataRows.push(row)
  }

  dataRows.forEach((row, index) => {
    rows[dataRowStart + index] = row
  })
  for (const row of summaryRows) rows[row] = row
  return rows
}
