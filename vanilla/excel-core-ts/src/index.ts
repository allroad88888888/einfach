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
  CrossSheetExpr,
  NameExpr,
  UnaryExpr,
  BinaryExpr,
  BinaryOp,
  PercentExpr,
  CallExpr,
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
