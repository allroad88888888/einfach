/**
 * Barrel for the `refs/` subpackage. Public surface used by:
 *  - parser (B1) — `parseA1` / `parseRangeString`
 *  - evaluator (B2) — `parseA1` for refLookup; `iterateRange` /
 *    `cellKey` for range materialization
 *  - Wave C functions — `iterateRange`, `rangesIntersect`, etc.
 *
 * All exports are pure functions / constants / error classes. No state,
 * no side effects, no `@einfach/core` imports.
 */

export {
  EXCEL_MAX_COL,
  EXCEL_MAX_ROW,
  colIndexToName,
  colNameToIndex,
  formatA1,
  parseA1,
} from './a1'
export type { FormatA1Input, ParsedA1 } from './a1'

export {
  EXPAND_MAX_CELLS,
  RangeTooLargeError,
  cellKey,
  expandRange,
  iterateRange,
  normalizeRange,
  parseRange,
  parseRangeString,
  rangeContains,
  rangesIntersect,
} from './ranges'
