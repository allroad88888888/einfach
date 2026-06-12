/**
 * Public surface of `@einfach/excel-core-ts`.
 *
 * Phase 0: only re-exports the frozen type contracts (`types.ts`).
 * Subsequent phases add: workbook factory, parser, evaluator, function
 * registry, custom formula host hooks.
 */

export type {
  // 1. Addressing
  CellKey,
  CellCoord,
  CellRange,

  // 2. Errors
  ErrorCode,

  // 3. Value
  Value,

  // 4. Cell
  Cell,
  CellFormat,

  // 5. AST
  Expr,
  NumberLiteral,
  StringLiteral,
  BooleanLiteral,
  ErrorLiteral,
  ReferenceExpr,
  RangeExpr,
  DynamicRangeExpr,
  SpillReferenceExpr,
  CrossSheetExpr,
  MultiAreaExpr,
  NameExpr,
  UnaryExpr,
  BinaryExpr,
  BinaryOp,
  PercentExpr,
  CallExpr,
  LambdaCallExpr,
  ArrayLiteralExpr,

  // 6. Mutations
  SheetMutation,
  SetCellMutation,
  ClearCellMutation,
  BulkApplyMutation,
  SetFormatMutation,

  // 7. EvalContext + names
  EvalContext,
  NameBinding,

  // 8. FunctionImpl
  FunctionImpl,

  // 9. Staged
  Workbook,
  WorkbookSheet,
} from './types'

export { ERROR_CODES, BLANK } from './types'

// Wave B / B3 — A1 + range helpers. Pure functions; safe to re-export
// from the package root.
export {
  EXCEL_MAX_COL,
  EXCEL_MAX_ROW,
  EXPAND_MAX_CELLS,
  RangeTooLargeError,
  cellKey,
  colIndexToName,
  colNameToIndex,
  expandRange,
  formatA1,
  iterateRange,
  normalizeRange,
  parseA1,
  parseRange,
  parseRangeString,
  rangeContains,
  rangesIntersect,
} from './refs'
export type { FormatA1Input, ParsedA1 } from './refs'

// Wave B / B1 — public formula parser entry point.
export { parseFormula } from './parser'

// Wave B / B2 — workbook + sheet + minimal evaluator.
export { createWorkbook } from './workbook'
export type {
  CreateWorkbookOptions,
  SheetSeed,
  BulkCellInput,
  BulkTypedCellInput,
  FormulaCacheState,
} from './workbook'
export { createSheet, keyFor, applyCell } from './sheet'
export type { SheetState, SheetResolvers, SheetDebugProviders } from './sheet'
export {
  evaluate,
  toNumber,
  toBoolean,
  valueToString,
  propagateError,
  parseRefToKey,
  parseRefToCoord,
} from './eval'
export type { CoerceResult, CoerceOk, CoerceErr } from './eval'

// Wave C — built-in function registry (math / logical / lookup / text /
// date / stats). Evaluator dispatches against `BUILTIN_FUNCTIONS`.
export {
  BUILTIN_FUNCTIONS,
  getBuiltinFunction,
  listBuiltinNames,
} from './eval/functions'
