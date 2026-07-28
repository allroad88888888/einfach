/**
 * Formula evaluator.
 *
 * Walks the parsed `Expr` tree and produces a public `Value`. Evaluator-owned
 * functions that need raw expressions are intercepted before ordinary built-in
 * dispatch, including lazy logical selectors, LET/LAMBDA, dynamic-array LAMBDA
 * callbacks, reference-aware metadata functions, INDIRECT/OFFSET, and
 * multi-area reference materialization for function arguments.
 *
 * Critical invariant: this function never touches the atom store. It only reads
 * from `ctx.cells` (or `ctx.crossSheetCells(...)` for cross-sheet), which were
 * snapshotted by the caller with a single `get(sheetAtom)`. That's how the
 * broad-dep, fine-lookup model stays honest: each formula derive registers one
 * dependency on its own sheet atom, plus one per referenced cross-sheet.
 */

import type {
  BinaryOp,
  CallExpr,
  Cell,
  CellCoord,
  CellKey,
  CellRange,
  ErrorCode,
  EvalContext,
  Expr,
  LambdaBinding,
  LambdaReferenceBinding,
  Value,
} from '../types'
import { getBuiltinFunction } from './functions'
import { excelEquals } from './functions/logical'
import { resolveXLookupValue, type XLookupCoreResult } from './functions/lookup'
import { makeCriterionMatcher } from './functions/stats'
import { BLANK, MAX_LAMBDA_CALL_DEPTH } from '../types'
import {
  EXCEL_MAX_COL,
  EXCEL_MAX_ROW,
  cellKey,
  formatA1,
  iterateRange,
  parseA1,
  parseRange,
  normalizeRange,
  RangeTooLargeError,
} from '../refs'
import { propagateError, toBoolean, toNumber, toString as toStr } from './coerce'

const ERR = (code: ErrorCode, message?: string): Value =>
  message === undefined ? { kind: 'error', code } : { kind: 'error', code, message }

const ARRAY_CELL_CAP = 1_048_576
const MAX_ARRAY_ROWS = EXCEL_MAX_ROW + 1
const MAX_ARRAY_COLS = EXCEL_MAX_COL + 1
const MATERIALIZED_RANGE_CELL_CAP = 100_000

function canonicalName(name: string): string {
  return name.toUpperCase()
}

interface LambdaResolveResult {
  readonly lambda?: LambdaBinding
  readonly error?: Value
}

interface LambdaArgumentValue {
  readonly kind: 'lambdaArgument'
  readonly lambda: LambdaBinding
}

interface ReferenceArgumentValue {
  readonly kind: 'referenceArgument'
  readonly ref: RuntimeRef
}

type LambdaArgument = Value | LambdaArgumentValue | ReferenceArgumentValue

type LambdaContextResult =
  | { readonly ok: true; readonly subCtx: EvalContext; readonly depth: { count: number } }
  | { readonly ok: false; readonly error: Value }

interface Grid {
  readonly rows: number
  readonly cols: number
  readonly cells: Value[][]
}

type RuntimeRef = LambdaReferenceBinding

type IntegerArgResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: Value }

type SliceRangeResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly error: Value }

type SelectedExprResult =
  | { readonly ok: true; readonly expr: Expr }
  | { readonly ok: false; readonly error: Value }

function arrayShapeError(
  rows: number,
  cols: number,
  label: string,
  capMessage = `${label} exceeds array cell cap`,
): Value | undefined {
  if (rows < 1 || cols < 1 || !Number.isFinite(rows) || !Number.isFinite(cols)) {
    return ERR('#VALUE!')
  }
  // Excel bounds the worksheet at 1,048,576 rows × 16,384 columns (XFD).
  // Requests beyond either axis surface `#NUM!` (Excel-compatible) — the
  // engine cell-cap (`ARRAY_CELL_CAP`) is a softer cap that keeps engine
  // memory bounded and surfaces `#VALUE!`.
  if (rows > MAX_ARRAY_ROWS || cols > MAX_ARRAY_COLS) {
    return ERR('#NUM!', `${label} exceeds Excel grid limits`)
  }
  if (rows * cols > ARRAY_CELL_CAP) return ERR('#VALUE!', capMessage)
  return undefined
}

function scalarCellError(value: Value): Value | undefined {
  return value.kind === 'array' ? ERR('#CALC!', 'array result was not expanded') : undefined
}

function matrixScalarCellError(matrix: Value[][]): Value | undefined {
  for (const row of matrix) {
    for (const cell of row) {
      const error = scalarCellError(cell)
      if (error) return error
    }
  }
  return undefined
}

function arrayResult(matrix: Value[][], label = 'array result'): Value {
  const cols = matrix[0]?.length ?? 0
  const shapeError = arrayShapeError(matrix.length, cols, label)
  if (shapeError) return shapeError
  for (const row of matrix) {
    if (row.length !== cols) return ERR('#VALUE!', 'array rows must be rectangular')
  }
  return matrixScalarCellError(matrix) ?? { kind: 'array', value: matrix }
}

export function evaluate(ast: Expr, ctx: EvalContext): Value {
  switch (ast.kind) {
    case 'number':
      return { kind: 'number', value: ast.value }
    case 'string':
      return { kind: 'string', value: ast.value }
    case 'boolean':
      return { kind: 'boolean', value: ast.value }
    case 'error':
      return { kind: 'error', code: ast.code }

    case 'ref':
      return ctx.refLookup(ast.a1)

    case 'range': {
      const rows = ctx.rangeLookup(ast.start, ast.end)
      // Empty range is invalid input — surface #REF!.
      if (rows.length === 0 || rows[0].length === 0) {
        return ERR('#REF!')
      }
      return arrayResult(rows, 'range result')
    }

    case 'dynamicRange': {
      const resolved = runtimeRefFromExpr(ast, ctx)
      if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
      return evaluateRuntimeRef(resolved.ref, ctx)
    }

    case 'spillRef':
      return evaluateSpillRef(ast, ctx)

    case 'crossSheet': {
      const sheetCells = ctx.crossSheetCells(ast.sheetName)
      if (!sheetCells) return ERR('#REF!')
      return evaluateInForeignSheet(ast.inner, ctx, sheetCells, ast.sheetName)
    }

    case 'multiArea':
      return ERR('#VALUE!', 'multi-area references are only supported by evaluator-aware functions')

    case 'name': {
      // LAMBDA scope wins over workbook-level names — a parameter name
      // shadowing a defined name is the whole point of LAMBDA parameters.
      // See ARCH §9 / types.ts `EvalContext.lambdaScope`.
      const name = canonicalName(ast.name)
      if (ctx.lambdaScope) {
        const scoped = ctx.lambdaScope.get(name)
        if (scoped !== undefined) return scoped
      }
      const scopedRef = ctx.lambdaRefScope?.get(name)
      if (scopedRef) return evaluateRuntimeRef(scopedRef, ctx)
      if (ctx.lambdaFunctionScope?.has(name)) {
        return ERR(
          '#CALC!',
          `LAMBDA '${ast.name}' must be invoked or passed to an evaluator-aware function`,
        )
      }
      const binding = ctx.resolveName(ast.name)
      if (!binding) return ERR('#NAME?')
      switch (binding.kind) {
        case 'value':
          return binding.value
        case 'range': {
          if (binding.sheetName !== undefined) {
            const sheetCells = ctx.crossSheetCells(binding.sheetName)
            if (!sheetCells) return ERR('#REF!')
            return evaluateInForeignSheet(
              { kind: 'range', start: binding.start, end: binding.end },
              ctx,
              sheetCells,
              binding.sheetName,
            )
          }
          const rows = ctx.rangeLookup(binding.start, binding.end)
          if (rows.length === 0 || rows[0].length === 0) return ERR('#REF!')
          return arrayResult(rows, 'range result')
        }
        case 'lambda':
          // A LAMBDA name referenced without a call site is a bare
          // function value. Excel surfaces `#CALC!` (the calc engine
          // cannot reduce a function value to a scalar).
          return ERR(
            '#CALC!',
            `LAMBDA '${ast.name}' must be invoked with arguments (e.g. =${ast.name}(...))`,
          )
      }
      // Exhaustiveness fallback.
      return ERR('#NAME?')
    }

    case 'unary': {
      const inner = evaluate(ast.operand, ctx)
      const propagated = propagateError([inner])
      if (propagated) return propagated
      const n = toNumber(inner)
      if (!n.ok) return n.error
      return { kind: 'number', value: ast.op === '-' ? -n.value : n.value }
    }

    case 'percent': {
      const inner = evaluate(ast.operand, ctx)
      const propagated = propagateError([inner])
      if (propagated) return propagated
      const n = toNumber(inner)
      if (!n.ok) return n.error
      return { kind: 'number', value: n.value / 100 }
    }

    case 'binary': {
      const left = evaluate(ast.left, ctx)
      const right = evaluate(ast.right, ctx)
      return applyBinary(ast.op, left, right)
    }

    case 'arrayLiteral': {
      const out: Value[][] = []
      for (const row of ast.rows) {
        const inner: Value[] = []
        for (const cell of row) {
          const value = evaluate(cell, ctx)
          const scalarError = scalarCellError(value)
          if (scalarError) return scalarError
          inner.push(value)
        }
        out.push(inner)
      }
      if (out.length === 0 || out[0].length === 0) return ERR('#VALUE!')
      return arrayResult(out, 'array literal')
    }

    case 'lambdaCall': {
      const resolved = resolveLambdaExpr(ast.callee, ctx)
      if (resolved.error) return resolved.error
      if (!resolved.lambda) {
        const callee = evaluate(ast.callee, ctx)
        if (callee.kind === 'error') return callee
        return ERR('#VALUE!', 'expected LAMBDA')
      }
      const argValues: LambdaArgument[] = ast.args.map((a) => evaluateLambdaArg(a, ctx))
      return applyLambda(resolved.lambda, argValues, ctx)
    }

    case 'call': {
      // ---------------------------------------------------------------
      // Lazy short-circuit: logical selector/error-handler functions must
      // not pre-evaluate unreachable branches.
      //
      // Without this, a textbook recursive LAMBDA like
      //   FACT(n) = IF(n<=1, 1, n*FACT(n-1))
      // recurses into the unreachable else-branch on every call and
      // blows the JS stack. Special-casing these here matches the Rust
      // engine (see `rust/excel-core/src/eval.rs` § `"IF"`) which
      // receives raw `&[Expr]` and lazily evaluates the chosen branch.
      // ---------------------------------------------------------------
      const upper = ast.name.toUpperCase()
      switch (upper) {
        case 'IF':
          return evaluateIf(ast.args, ctx)
        case 'IFERROR':
          return evaluateIfError(ast.args, ctx)
        case 'IFNA':
          return evaluateIfNa(ast.args, ctx)
        case 'IFS':
          return evaluateIfs(ast.args, ctx)
        case 'SWITCH':
          return evaluateSwitch(ast.args, ctx)
        case 'SUM': {
          const streamed = evaluateSparseSum(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'COUNT': {
          const streamed = evaluateSparseNumericAggregate(ast.args, ctx, 'count')
          if (streamed !== undefined) return streamed
          break
        }
        case 'COUNTA': {
          const streamed = evaluateSparseCountA(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'COUNTBLANK': {
          const streamed = evaluateSparseCountBlank(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'AVERAGE': {
          const streamed = evaluateSparseNumericAggregate(ast.args, ctx, 'average')
          if (streamed !== undefined) return streamed
          break
        }
        case 'MIN': {
          const streamed = evaluateSparseNumericAggregate(ast.args, ctx, 'min')
          if (streamed !== undefined) return streamed
          break
        }
        case 'MAX': {
          const streamed = evaluateSparseNumericAggregate(ast.args, ctx, 'max')
          if (streamed !== undefined) return streamed
          break
        }
        case 'COUNTIF': {
          const streamed = evaluateSparseCountIf(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'SUMIF': {
          const streamed = evaluateSparseSumIf(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'AVERAGEIF': {
          const streamed = evaluateSparseAverageIf(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'COUNTIFS': {
          const streamed = evaluateSparseCountIfs(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'SUMIFS': {
          const streamed = evaluateSparseSumIfs(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'AVERAGEIFS': {
          const streamed = evaluateSparseAverageIfs(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'MAXIFS': {
          const streamed = evaluateSparseMinMaxIfs(ast.args, ctx, 'max')
          if (streamed !== undefined) return streamed
          break
        }
        case 'MINIFS': {
          const streamed = evaluateSparseMinMaxIfs(ast.args, ctx, 'min')
          if (streamed !== undefined) return streamed
          break
        }
        case 'SUBTOTAL': {
          const streamed = evaluateSparseSubtotal(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
        case 'AGGREGATE': {
          const streamed = evaluateSparseAggregate(ast.args, ctx)
          if (streamed !== undefined) return streamed
          break
        }
      }

      switch (upper) {
        case 'LET':
          return evaluateLet(ast.args, ctx)
        case 'LAMBDA':
          return ERR('#CALC!', 'LAMBDA must be invoked or passed to a higher-order function')
        case 'ISOMITTED':
          return evaluateIsOmitted(ast.args, ctx)
        case 'MAP':
          return evaluateMap(ast.args, ctx)
        case 'REDUCE':
          return evaluateReduce(ast.args, ctx)
        case 'SCAN':
          return evaluateScan(ast.args, ctx)
        case 'BYROW':
          return evaluateByRow(ast.args, ctx)
        case 'BYCOL':
          return evaluateByCol(ast.args, ctx)
        case 'MAKEARRAY':
          return evaluateMakeArray(ast.args, ctx)
        case 'FILTER':
          return evaluateFilter(ast.args, ctx)
        case 'TOCOL': {
          const sparse = evaluateTocolSparse(ast.args, ctx)
          if (sparse !== undefined) return sparse
          break
        }
        case 'TAKE': {
          const sliced = evaluateTakeDrop(ast.args, ctx, 'take')
          if (sliced !== undefined) return sliced
          break
        }
        case 'DROP': {
          const sliced = evaluateTakeDrop(ast.args, ctx, 'drop')
          if (sliced !== undefined) return sliced
          break
        }
        case 'CHOOSE':
          return evaluateChoose(ast.args, ctx)
        case 'XLOOKUP':
          return evaluateXLookup(ast.args, ctx)
        case 'INDEX':
          return evaluateIndex(ast.args, ctx)
        case 'ISFORMULA':
          return evaluateIsFormula(ast.args, ctx)
        case 'ISREF':
          return evaluateIsRef(ast.args, ctx)
        case 'SHEET':
          return evaluateSheet(ast.args, ctx)
        case 'SHEETS':
          return evaluateSheets(ast.args, ctx)
        case 'AREAS':
          return evaluateAreas(ast.args, ctx)
        case 'FORMULATEXT':
          return evaluateFormulaText(ast.args, ctx)
        case 'CELL':
          return evaluateCellInfo(ast.args, ctx)
        case 'INDIRECT':
          return evaluateIndirect(ast.args, ctx)
        case 'OFFSET':
          return evaluateOffset(ast.args, ctx)
        case 'ROW':
          return evaluateRow(ast.args, ctx)
        case 'COLUMN':
          return evaluateColumn(ast.args, ctx)
        case 'ROWS':
          return evaluateRows(ast.args, ctx)
        case 'COLUMNS':
          return evaluateColumns(ast.args, ctx)
      }

      // Dispatch order: built-in registry → workbook LAMBDA name →
      // host custom formula → #NAME?. Built-ins shadow customs by
      // convention (custom formulas refuse registration with a builtin
      // name on the host side). LAMBDA names sit between built-ins and
      // customs so user-defined names can't override SUM but a custom
      // host callback can't override a LAMBDA definition either.
      const builtin = getBuiltinFunction(ast.name)
      if (builtin) {
        const argValues: Value[] = ast.args.map((a) => evaluateFunctionArg(a, ctx))
        return builtin(argValues, ctx)
      }

      const scopedLambda = ctx.lambdaFunctionScope?.get(canonicalName(ast.name))
      if (scopedLambda) {
        const argValues: LambdaArgument[] = ast.args.map((a) => evaluateLambdaArg(a, ctx))
        return applyLambda(scopedLambda, argValues, ctx)
      }

      // LAMBDA dispatch: a `NameBinding` of `kind:'lambda'` registered
      // via `Workbook.defineName(...)` can be invoked with positional
      // args. The body re-evaluates against the current `ctx` plus a
      // scope that maps each declared param to its argument value.
      // Missing args bind to BLANK so partial-application errors surface
      // inside the body rather than at call site (matches Excel).
      //
      // Recursion guard: each LAMBDA application bumps a shared depth
      // counter and surfaces `#NUM!` past `MAX_LAMBDA_CALL_DEPTH` (Rust
      // parity, see `NAMED_CALL_DEPTH` in `rust/excel-core/src/eval.rs`).
      // Without this, a pathological recursion like `bad(n) = bad(n)`
      // would blow the JS stack instead of yielding a sensible error.
      const binding = ctx.resolveName(ast.name)
      if (binding && binding.kind === 'lambda') {
        const argValues: LambdaArgument[] = ast.args.map((a) => evaluateLambdaArg(a, ctx))
        return applyLambda(binding, argValues, ctx)
      }

      const argValues: Value[] = ast.args.map((a) => evaluateFunctionArg(a, ctx))
      const custom = ctx.callCustom(ast.name, argValues, {
        sheetName: ctx.currentSheetName,
        cell: ctx.currentCell,
      })
      if (custom !== undefined) return custom
      return ERR('#NAME?', `function '${ast.name}' is not registered`)
    }
  }
}

function evaluateSheet(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length > 1) return ERR('#VALUE!', 'SHEET expects 0 or 1 arguments')
  if (args.length === 0) return currentSheetNumber(ctx)
  const arg = args[0]
  if (arg.kind === 'ref' || arg.kind === 'range') return currentSheetNumber(ctx)
  if (arg.kind === 'crossSheet') {
    const idx = ctx.sheetIndexOf?.(arg.sheetName)
    return idx === undefined ? ERR('#REF!') : { kind: 'number', value: idx + 1 }
  }
  if (arg.kind === 'multiArea') {
    if (arg.areas.length === 0) return ERR('#VALUE!')
    const error = validateReferenceExpr(arg, ctx)
    if (error) return error
    return evaluateSheet([arg.areas[0]], ctx)
  }
  return ERR('#VALUE!')
}

function currentSheetNumber(ctx: EvalContext): Value {
  return ctx.currentSheetIndex === undefined
    ? ERR('#REF!')
    : { kind: 'number', value: ctx.currentSheetIndex + 1 }
}

function evaluateSheets(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length > 1) return ERR('#VALUE!', 'SHEETS expects 0 or 1 arguments')
  if (args.length === 0) return { kind: 'number', value: ctx.sheetCount ?? 1 }
  const arg = args[0]
  if (arg.kind === 'ref' || arg.kind === 'range') {
    return { kind: 'number', value: 1 }
  }
  if (arg.kind === 'crossSheet') {
    const error = validateReferenceExpr(arg, ctx)
    return error ?? { kind: 'number', value: 1 }
  }
  return ERR('#VALUE!')
}

function evaluateAreas(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!', 'AREAS expects 1 argument')
  const arg = args[0]
  if (arg.kind === 'multiArea') {
    const error = validateReferenceExpr(arg, ctx)
    if (error) return error
    return { kind: 'number', value: arg.areas.length }
  }
  const resolved = runtimeRefFromExpr(arg, ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
  return validateRuntimeRefSheet(resolved.ref, ctx) ?? { kind: 'number', value: 1 }
}

function evaluateIsFormula(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (!resolved.ok) return { kind: 'boolean', value: false }
  const target = cellForRuntimeRef(topLeftRuntimeRef(resolved.ref), ctx)
  if (target.error) return { kind: 'boolean', value: false }
  return { kind: 'boolean', value: target.cell?.ast !== undefined }
}

function evaluateIsRef(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!')
  if (args[0].kind === 'multiArea') {
    return { kind: 'boolean', value: validateReferenceExpr(args[0], ctx) === undefined }
  }
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (!resolved.ok) return { kind: 'boolean', value: false }
  const sheetError = validateRuntimeRefSheet(resolved.ref, ctx)
  return { kind: 'boolean', value: sheetError === undefined }
}

function validateReferenceExpr(expr: Expr, ctx: EvalContext): Value | undefined {
  if (expr.kind === 'multiArea') {
    for (const area of expr.areas) {
      const error = validateReferenceExpr(area, ctx)
      if (error) return error
    }
    return undefined
  }
  const resolved = runtimeRefFromExpr(expr, ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
  return validateRuntimeRefSheet(resolved.ref, ctx)
}

function evaluateFunctionArg(expr: Expr, ctx: EvalContext): Value {
  if (expr.kind === 'multiArea') {
    return evaluateMultiAreaArg(expr.areas, ctx)
  }
  return evaluate(expr, ctx)
}

function evaluateLambdaArg(expr: Expr, ctx: EvalContext): LambdaArgument {
  const resolved = resolveLambdaExpr(expr, ctx)
  if (resolved.error) return resolved.error
  if (resolved.lambda) return { kind: 'lambdaArgument', lambda: resolved.lambda }
  const ref = runtimeRefFromExpr(expr, ctx)
  if (ref.ok) return { kind: 'referenceArgument', ref: ref.ref }
  if (ref.error) return ref.error
  return evaluateFunctionArg(expr, ctx)
}

function isLambdaArgument(value: LambdaArgument | undefined): value is LambdaArgumentValue {
  return value?.kind === 'lambdaArgument'
}

function isReferenceArgument(value: LambdaArgument | undefined): value is ReferenceArgumentValue {
  return value?.kind === 'referenceArgument'
}

function evaluateIf(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 2 || args.length > 3) {
    return ERR('#VALUE!', 'IF expects 2 or 3 arguments')
  }
  const cond = evaluateFunctionArg(args[0], ctx)
  if (cond.kind === 'error') return cond
  if (cond.kind === 'array') return evaluateArrayIf(cond, args, ctx)
  const coerced = toBoolean(cond)
  if (!coerced.ok) return coerced.error
  if (coerced.value) return evaluateFunctionArg(args[1], ctx)
  return args.length === 3
    ? evaluateFunctionArg(args[2], ctx)
    : { kind: 'boolean', value: false }
}

function evaluateIfError(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 2) return ERR('#VALUE!')
  const value = evaluateFunctionArg(args[0], ctx)
  if (value.kind === 'array') return evaluateArrayIfError(value, args[1], ctx, () => true)
  return value.kind === 'error' ? evaluateFunctionArg(args[1], ctx) : value
}

function evaluateIfNa(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 2) return ERR('#VALUE!')
  const value = evaluateFunctionArg(args[0], ctx)
  if (value.kind === 'array') {
    return evaluateArrayIfError(value, args[1], ctx, (error) => error.code === '#N/A')
  }
  return value.kind === 'error' && value.code === '#N/A'
    ? evaluateFunctionArg(args[1], ctx)
    : value
}

function evaluateIfs(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length === 0 || args.length % 2 !== 0) return ERR('#VALUE!')
  const pairCount = Math.floor(args.length / 2)
  for (let i = 0; i < pairCount; i += 1) {
    const cond = evaluateFunctionArg(args[i * 2], ctx)
    if (cond.kind === 'error') return cond
    if (cond.kind === 'array') return evaluateArrayIfs(args, ctx, i, cond)
    const coerced = toBoolean(cond)
    if (!coerced.ok) return coerced.error
    if (coerced.value) return evaluateFunctionArg(args[i * 2 + 1], ctx)
  }
  return ERR('#N/A')
}

function evaluateSwitch(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 3) return ERR('#VALUE!')
  const expr = evaluateFunctionArg(args[0], ctx)
  if (expr.kind === 'error') return expr
  if (expr.kind === 'array') return evaluateArraySwitch(expr, args, ctx)
  const rest = args.length - 1
  const pairCount = Math.floor(rest / 2)
  const hasDefault = rest % 2 === 1
  for (let i = 0; i < pairCount; i += 1) {
    const caseValue = evaluateFunctionArg(args[1 + i * 2], ctx)
    if (caseValue.kind === 'error') return caseValue
    if (excelEquals(expr, caseValue)) return evaluateFunctionArg(args[1 + i * 2 + 1], ctx)
  }
  return hasDefault ? evaluateFunctionArg(args[args.length - 1], ctx) : ERR('#N/A')
}

/**
 * Expand any `multiArea` args into their constituent sub-areas so the sparse
 * aggregators below can route each whole-column / whole-row sub-area through
 * the existing sparse-iteration path. Non-multiArea args pass through unchanged.
 * Without this, `SUM((A:A,C:C))` would fall through to the materializing path
 * and trip the per-range materialization cap.
 */
function expandSparseArgs(args: ReadonlyArray<Expr>): ReadonlyArray<Expr> {
  let hasMultiArea = false
  for (const arg of args) {
    if (arg.kind === 'multiArea') {
      hasMultiArea = true
      break
    }
  }
  if (!hasMultiArea) return args
  const expanded: Expr[] = []
  for (const arg of args) {
    if (arg.kind === 'multiArea') {
      for (const area of arg.areas) expanded.push(area)
    } else {
      expanded.push(arg)
    }
  }
  return expanded
}

function evaluateSparseSum(rawArgs: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  const args = expandSparseArgs(rawArgs)
  let usedSparseRef = false
  let total = 0

  const addRangeCell = (cell: Value): Value | undefined => {
    if (cell.kind === 'error') return cell
    if (cell.kind === 'number') total += cell.value
    if (cell.kind === 'array') return addArray(cell)
    return undefined
  }

  const addArray = (value: Value & { kind: 'array' }): Value | undefined => {
    for (const row of value.value) {
      for (const cell of row) {
        const error = addRangeCell(cell)
        if (error) return error
      }
    }
    return undefined
  }

  const addEvaluatedArg = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'array') return addArray(value)
    const n = toNumber(value)
    if (!n.ok) return n.error
    total += n.value
    return undefined
  }

  for (const arg of args) {
    const ref = runtimeRefFromExpr(arg, ctx)
    if (ref.ok && canSparseIterate(ref.ref)) {
      usedSparseRef = true
      const sparse = sparseValuesForRef(ref.ref, ctx)
      if (!sparse.ok) return sparse.error
      for (const { value } of sparse.values) {
        const error = addRangeCell(value)
        if (error) return error
      }
      continue
    }

    const error = addEvaluatedArg(evaluateFunctionArg(arg, ctx))
    if (error) return error
  }

  return usedSparseRef ? { kind: 'number', value: total } : undefined
}

type SparseAggregateKind = 'count' | 'average' | 'min' | 'max'

function evaluateSparseNumericAggregate(
  rawArgs: ReadonlyArray<Expr>,
  ctx: EvalContext,
  kind: SparseAggregateKind,
): Value | undefined {
  const args = expandSparseArgs(rawArgs)
  let usedSparseRef = false
  let total = 0
  let count = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const visitNumber = (value: number): void => {
    total += value
    count += 1
    if (value < min) min = value
    if (value > max) max = value
  }

  const addRangeCell = (cell: Value): Value | undefined => {
    if (cell.kind === 'error') return cell
    if (cell.kind === 'number') visitNumber(cell.value)
    if (cell.kind === 'array') return addArray(cell)
    return undefined
  }

  const addArray = (value: Value & { kind: 'array' }): Value | undefined => {
    for (const row of value.value) {
      for (const cell of row) {
        const error = addRangeCell(cell)
        if (error) return error
      }
    }
    return undefined
  }

  const addScalar = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'array') return addArray(value)
    if (kind === 'count') {
      if (value.kind === 'number') visitNumber(value.value)
      return undefined
    }
    const n = toNumber(value)
    if (!n.ok) return n.error
    visitNumber(n.value)
    return undefined
  }

  for (const arg of args) {
    const ref = runtimeRefFromExpr(arg, ctx)
    if (ref.ok && canSparseIterate(ref.ref)) {
      usedSparseRef = true
      const sparse = sparseValuesForRef(ref.ref, ctx)
      if (!sparse.ok) return sparse.error
      for (const { value } of sparse.values) {
        const error = addRangeCell(value)
        if (error) return error
      }
      continue
    }

    const error = addScalar(evaluateFunctionArg(arg, ctx))
    if (error) return error
  }

  if (!usedSparseRef) return undefined
  switch (kind) {
    case 'count':
      return { kind: 'number', value: count }
    case 'average':
      return count === 0 ? ERR('#DIV/0!') : { kind: 'number', value: total / count }
    case 'min':
      return { kind: 'number', value: count === 0 ? 0 : min }
    case 'max':
      return { kind: 'number', value: count === 0 ? 0 : max }
  }
}

function evaluateSparseCountA(rawArgs: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  const args = expandSparseArgs(rawArgs)
  let usedSparseRef = false
  let count = 0

  const addArray = (value: Value & { kind: 'array' }): void => {
    for (const row of value.value) {
      for (const cell of row) {
        if (cell.kind !== 'blank') count += 1
      }
    }
  }

  const addScalar = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'array') {
      addArray(value)
    } else if (value.kind !== 'blank') {
      count += 1
    }
    return undefined
  }

  for (const arg of args) {
    const ref = runtimeRefFromExpr(arg, ctx)
    if (ref.ok && canSparseIterate(ref.ref)) {
      usedSparseRef = true
      const sparse = sparseValuesForRef(ref.ref, ctx)
      if (!sparse.ok) return sparse.error
      for (const { value } of sparse.values) {
        if (value.kind !== 'blank') count += 1
      }
      continue
    }

    const error = addScalar(evaluateFunctionArg(arg, ctx))
    if (error) return error
  }

  return usedSparseRef ? { kind: 'number', value: count } : undefined
}

function evaluateSparseCountBlank(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length !== 1) return undefined
  const ref = runtimeRefFromExpr(args[0], ctx)
  if (!ref.ok || !canSparseIterate(ref.ref)) return undefined

  const sparse = sparseValuesForRef(ref.ref, ctx)
  if (!sparse.ok) return sparse.error

  let count = rangeCellCount(ref.ref.range) - sparse.values.length
  for (const { value } of sparse.values) {
    if (value.kind === 'blank' || (value.kind === 'string' && value.value === '')) count += 1
  }
  return { kind: 'number', value: count }
}

function evaluateSparseCountIf(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length !== 2) return undefined

  // Multi-area first arg: COUNTIF((A:A,C:C), crit) = COUNTIF(A:A, crit) + COUNTIF(C:C, crit).
  if (args[0].kind === 'multiArea') {
    let total = 0
    for (const area of args[0].areas) {
      const sub = evaluateSparseCountIf([area, args[1]], ctx)
      if (sub === undefined) return undefined
      if (sub.kind === 'error') return sub
      if (sub.kind !== 'number') return undefined
      total += sub.value
    }
    return { kind: 'number', value: total }
  }

  const ref = runtimeRefFromExpr(args[0], ctx)
  if (!ref.ok || !canSparseIterate(ref.ref)) return undefined

  const criterion = evaluateFunctionArg(args[1], ctx)
  const matcher = makeCriterionMatcher(criterion)
  if (!matcher.ok) return matcher.error

  const sparse = sparseValuesForRef(ref.ref, ctx)
  if (!sparse.ok) return sparse.error

  let count = matcher.matchesBlank ? rangeCellCount(ref.ref.range) - sparse.values.length : 0
  for (const { value } of sparse.values) {
    if (matcher.matches(value)) count += 1
  }
  return { kind: 'number', value: count }
}

function evaluateSparseSumIf(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 2 || args.length > 3) return undefined

  // Multi-area check range: SUMIF((A:A,C:C), crit) = SUMIF(A:A, crit) + SUMIF(C:C, crit).
  // For 3-arg form, the sum-range may also be multi-area with matching shape.
  if (args[0].kind === 'multiArea') {
    const checkAreas = args[0].areas
    let sumAreas: ReadonlyArray<Expr> | undefined
    if (args.length === 3) {
      if (args[2].kind !== 'multiArea') return undefined
      if (args[2].areas.length !== checkAreas.length) return undefined
      sumAreas = args[2].areas
    }
    let total = 0
    for (let i = 0; i < checkAreas.length; i += 1) {
      const subArgs: Expr[] = [checkAreas[i], args[1]]
      if (sumAreas) subArgs.push(sumAreas[i])
      const sub = evaluateSparseSumIf(subArgs, ctx)
      if (sub === undefined) return undefined
      if (sub.kind === 'error') return sub
      if (sub.kind !== 'number') return undefined
      total += sub.value
    }
    return { kind: 'number', value: total }
  }

  const checkRef = runtimeRefFromExpr(args[0], ctx)
  if (!checkRef.ok || !canSparseIterate(checkRef.ref)) return undefined

  const criterion = evaluateFunctionArg(args[1], ctx)
  const matcher = makeCriterionMatcher(criterion)
  if (!matcher.ok) return matcher.error

  const sumRef = args.length === 3 ? runtimeRefFromExpr(args[2], ctx) : checkRef
  if (!sumRef.ok) return undefined
  if (sumRef.ref.materialized) return undefined

  const sparse = sparseValuesForRef(checkRef.ref, ctx)
  if (!sparse.ok) return sparse.error
  if (matcher.matchesBlank) {
    const sumSparse = sumRef === checkRef ? sparse : sparseValuesForRef(sumRef.ref, ctx)
    if (!sumSparse.ok) return sumSparse.error
    return sumBlankMatchedTargets(
      checkRef.ref,
      sumRef.ref,
      sparse.values,
      sumSparse.values,
      matcher.matches,
      ctx,
    )
  }

  let total = 0
  for (const { coord, value } of sparse.values) {
    if (!matcher.matches(value)) continue
    const targetCoord = relativeCoord(checkRef.ref.range, sumRef.ref.range, coord)
    if (!targetCoord) return ERR('#REF!')
    const target = valueAtRuntimeCoord(sumRef.ref.sheetName, targetCoord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) total += n.value
  }
  return { kind: 'number', value: total }
}

function sumBlankMatchedTargets(
  checkRef: RuntimeRef,
  sumRef: RuntimeRef,
  checkValues: ReadonlyArray<{ readonly coord: CellCoord; readonly value: Value }>,
  sumValues: ReadonlyArray<{ readonly coord: CellCoord; readonly value: Value }>,
  matches: (value: Value) => boolean,
  ctx: EvalContext,
): Value {
  const candidates = new Map<CellKey, CellCoord>()
  for (const { coord } of checkValues) candidates.set(cellKey(coord), coord)
  for (const { coord } of sumValues) {
    const checkCoord = inverseRelativeCoord(checkRef.range, sumRef.range, coord)
    if (checkCoord) candidates.set(cellKey(checkCoord), checkCoord)
  }

  let total = 0
  for (const coord of candidates.values()) {
    const checkValue = valueAtRuntimeCoord(checkRef.sheetName, coord, ctx)
    if (checkValue.kind === 'error') continue
    if (!matches(checkValue)) continue
    const targetCoord = relativeCoord(checkRef.range, sumRef.range, coord)
    if (!targetCoord) return ERR('#REF!')
    const target = valueAtRuntimeCoord(sumRef.sheetName, targetCoord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) total += n.value
  }
  return { kind: 'number', value: total }
}

function evaluateSparseAverageIf(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 2 || args.length > 3) return undefined
  const checkRef = runtimeRefFromExpr(args[0], ctx)
  if (!checkRef.ok) return undefined

  const averageRef = args.length === 3 ? runtimeRefFromExpr(args[2], ctx) : checkRef
  if (!averageRef.ok) return undefined
  if (checkRef.ref.materialized || averageRef.ref.materialized) return undefined
  if (
    !canSparseIterate(checkRef.ref) &&
    !canSparseIterate(averageRef.ref)
  ) {
    return undefined
  }
  if (!sameRangeShape(checkRef.ref.range, averageRef.ref.range)) return ERR('#VALUE!')

  const criterion = evaluateFunctionArg(args[1], ctx)
  const matcher = makeCriterionMatcher(criterion)
  if (!matcher.ok) return matcher.error

  const sparse = sparseValuesForRef(checkRef.ref, ctx)
  if (!sparse.ok) return sparse.error
  if (matcher.matchesBlank) {
    const averageSparse =
      averageRef === checkRef ? sparse : sparseValuesForRef(averageRef.ref, ctx)
    if (!averageSparse.ok) return averageSparse.error
    return averageBlankMatchedTargets(
      checkRef.ref,
      averageRef.ref,
      sparse.values,
      averageSparse.values,
      matcher.matches,
      ctx,
    )
  }

  let total = 0
  let count = 0
  for (const { coord, value } of sparse.values) {
    if (value.kind === 'error') return value
    if (!matcher.matches(value)) continue
    const targetCoord = relativeCoord(checkRef.ref.range, averageRef.ref.range, coord)
    if (!targetCoord) return ERR('#REF!')
    const target = valueAtRuntimeCoord(averageRef.ref.sheetName, targetCoord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) {
      total += n.value
      count += 1
    }
  }
  return count === 0 ? ERR('#DIV/0!') : { kind: 'number', value: total / count }
}

function averageBlankMatchedTargets(
  checkRef: RuntimeRef,
  averageRef: RuntimeRef,
  checkValues: ReadonlyArray<{ readonly coord: CellCoord; readonly value: Value }>,
  averageValues: ReadonlyArray<{ readonly coord: CellCoord; readonly value: Value }>,
  matches: (value: Value) => boolean,
  ctx: EvalContext,
): Value {
  const candidates = new Map<CellKey, CellCoord>()
  for (const { coord } of checkValues) candidates.set(cellKey(coord), coord)
  for (const { coord } of averageValues) {
    const checkCoord = inverseRelativeCoord(checkRef.range, averageRef.range, coord)
    if (checkCoord) candidates.set(cellKey(checkCoord), checkCoord)
  }

  let total = 0
  let count = 0
  for (const coord of candidates.values()) {
    const checkValue = valueAtRuntimeCoord(checkRef.sheetName, coord, ctx)
    if (checkValue.kind === 'error') return checkValue
    if (!matches(checkValue)) continue
    const targetCoord = relativeCoord(checkRef.range, averageRef.range, coord)
    if (!targetCoord) return ERR('#REF!')
    const target = valueAtRuntimeCoord(averageRef.sheetName, targetCoord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) {
      total += n.value
      count += 1
    }
  }
  return count === 0 ? ERR('#DIV/0!') : { kind: 'number', value: total / count }
}

function evaluateSparseCountIfs(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 2 || args.length % 2 !== 0) return undefined
  const criteria = sparseCriteriaPairs(args, ctx)
  if (criteria.kind === 'fallback') return undefined
  if (criteria.kind === 'error') return criteria.error
  if (!criteria.usesSparse) return undefined
  const shapeError = validateCriteriaShapes(criteria.pairs)
  if (shapeError) return shapeError

  const candidates = countIfsCandidateCoords(criteria.pairs, ctx)
  if (!candidates.ok) return candidates.error

  return countMatchingCriteria(candidates, criteria.pairs, ctx)
}

function evaluateSparseSumIfs(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 3 || args.length % 2 === 0) return undefined
  const sumRef = runtimeRefFromExpr(args[0], ctx)
  if (!sumRef.ok) return undefined
  if (sumRef.ref.materialized) return undefined

  const criteria = sparseCriteriaPairs(args.slice(1), ctx)
  if (criteria.kind === 'fallback') return undefined
  if (criteria.kind === 'error') return criteria.error
  if (!criteria.usesSparse && !canSparseIterate(sumRef.ref)) return undefined
  const shapeError = validateCriteriaShapes(criteria.pairs, sumRef.ref.range)
  if (shapeError) return shapeError

  const candidates = sumIfsCandidateCoords(criteria.pairs, sumRef.ref, ctx)
  if (!candidates.ok) return candidates.error
  const base = criteria.pairs[0].ref.range

  let total = 0
  for (const coord of candidates.coords) {
    const match = matchesAllCriteria(coord, criteria.pairs, ctx)
    if (!match.ok) return match.error
    if (!match.matches) continue
    const target = valueAtRelativeCoord(base, sumRef.ref, coord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) total += n.value
  }
  return { kind: 'number', value: total }
}

function evaluateSparseAverageIfs(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 3 || args.length % 2 === 0) return undefined
  const averageRef = runtimeRefFromExpr(args[0], ctx)
  if (!averageRef.ok) return undefined
  if (averageRef.ref.materialized) return undefined

  const criteria = sparseCriteriaPairs(args.slice(1), ctx)
  if (criteria.kind === 'fallback') return undefined
  if (criteria.kind === 'error') return criteria.error
  if (!criteria.usesSparse && !canSparseIterate(averageRef.ref)) return undefined
  const shapeError = validateCriteriaShapes(criteria.pairs, averageRef.ref.range)
  if (shapeError) return shapeError

  const candidates = sumIfsCandidateCoords(criteria.pairs, averageRef.ref, ctx)
  if (!candidates.ok) return candidates.error
  const base = criteria.pairs[0].ref.range

  let total = 0
  let count = 0
  for (const coord of candidates.coords) {
    const match = matchesAllCriteria(coord, criteria.pairs, ctx)
    if (!match.ok) return match.error
    if (!match.matches) continue
    const target = valueAtRelativeCoord(base, averageRef.ref, coord, ctx)
    if (target.kind === 'error') return target
    const n = toNumber(target)
    if (n.ok) {
      total += n.value
      count += 1
    }
  }
  return count === 0 ? ERR('#DIV/0!') : { kind: 'number', value: total / count }
}

function evaluateSparseMinMaxIfs(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
  kind: 'min' | 'max',
): Value | undefined {
  if (args.length < 3 || args.length % 2 === 0) return undefined
  const targetRef = runtimeRefFromExpr(args[0], ctx)
  if (!targetRef.ok) return undefined
  if (targetRef.ref.materialized) return undefined

  const criteria = sparseCriteriaPairs(args.slice(1), ctx)
  if (criteria.kind === 'fallback') return undefined
  if (criteria.kind === 'error') return criteria.error
  if (!criteria.usesSparse && !canSparseIterate(targetRef.ref)) return undefined
  const shapeError = validateCriteriaShapes(criteria.pairs, targetRef.ref.range)
  if (shapeError) return shapeError

  const candidates = sumIfsCandidateCoords(criteria.pairs, targetRef.ref, ctx)
  if (!candidates.ok) return candidates.error
  const base = criteria.pairs[0].ref.range

  let seen = false
  let best = kind === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  for (const coord of candidates.coords) {
    const match = matchesAllCriteria(coord, criteria.pairs, ctx)
    if (!match.ok) return match.error
    if (!match.matches) continue
    const target = valueAtRelativeCoord(base, targetRef.ref, coord, ctx)
    if (target.kind === 'error') return target
    if (target.kind !== 'number') continue
    best = kind === 'min' ? Math.min(best, target.value) : Math.max(best, target.value)
    seen = true
  }
  return { kind: 'number', value: seen ? best : 0 }
}

function evaluateSparseSubtotal(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 2) return undefined
  const dataArgs = args.slice(1)
  if (!subtotalHasSparseRef(dataArgs, ctx)) return undefined

  const fnArg = evaluateFunctionArg(args[0], ctx)
  if (fnArg.kind === 'error') return fnArg
  const fnValue = toNumber(fnArg)
  if (!fnValue.ok) return fnValue.error
  const raw = Math.trunc(fnValue.value)
  const fnNum = raw >= 101 && raw <= 111 ? raw - 100 : raw
  if (fnNum < 1 || fnNum > 11) return ERR('#VALUE!')
  return runSparseSubtotalFunction(fnNum, dataArgs, ctx, false)
}

function evaluateSparseAggregate(args: ReadonlyArray<Expr>, ctx: EvalContext): Value | undefined {
  if (args.length < 3) return undefined
  if (!subtotalHasSparseRef(args.slice(2), ctx)) return undefined

  const fnArg = evaluateFunctionArg(args[0], ctx)
  if (fnArg.kind === 'error') return fnArg
  const fnValue = toNumber(fnArg)
  if (!fnValue.ok) return fnValue.error

  const optionArg = evaluateFunctionArg(args[1], ctx)
  if (optionArg.kind === 'error') return optionArg
  const optionValue = toNumber(optionArg)
  if (!optionValue.ok) return optionValue.error

  const fnNum = Math.trunc(fnValue.value)
  const options = Math.trunc(optionValue.value)
  if (fnNum < 1 || fnNum > 19 || options < 0 || options > 7) return ERR('#VALUE!')
  const ignoreErrors = (options & 2) !== 0

  if (fnNum >= 14) {
    if (args.length < 4) return ERR('#VALUE!')
    const dataArgs = args.slice(2, -1)
    if (!subtotalHasSparseRef(dataArgs, ctx)) return undefined
    const kArg = evaluateFunctionArg(args[args.length - 1], ctx)
    if (kArg.kind === 'error') return kArg
    const kValue = toNumber(kArg)
    if (!kValue.ok) return kValue.error
    return runSparseSubtotalFunction(fnNum, dataArgs, ctx, ignoreErrors, kValue.value)
  }

  const dataArgs = args.slice(2)
  if (!subtotalHasSparseRef(dataArgs, ctx)) return undefined
  return runSparseSubtotalFunction(fnNum, dataArgs, ctx, ignoreErrors)
}

function subtotalHasSparseRef(args: ReadonlyArray<Expr>, ctx: EvalContext): boolean {
  for (const arg of args) {
    const ref = runtimeRefFromExpr(arg, ctx)
    if (ref.ok && canSparseIterate(ref.ref)) return true
  }
  return false
}

function flattenSparseSubtotalValues(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
  ignoreErrors: boolean,
): { readonly ok: true; readonly values: Value[] } | {
  readonly ok: false
  readonly error: Value
} {
  const values: Value[] = []

  const visit = (value: Value): (Value & { kind: 'error' }) | undefined => {
    if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) {
          const error = visit(cell)
          if (error) return error
        }
      }
      return undefined
    }
    if (value.kind === 'error') return ignoreErrors ? undefined : value
    values.push(value)
    return undefined
  }

  for (const arg of args) {
    const ref = runtimeRefFromExpr(arg, ctx)
    if (ref.ok && canSparseIterate(ref.ref)) {
      const sparse = sparseValuesForRef(ref.ref, ctx)
      if (!sparse.ok) return { ok: false, error: sparse.error }
      for (const { value } of sparse.values) {
        const error = visit(value)
        if (error) return { ok: false, error }
      }
      continue
    }

    const error = visit(evaluateFunctionArg(arg, ctx))
    if (error) return { ok: false, error }
  }

  return { ok: true, values }
}

function runSparseSubtotalFunction(
  fnNum: number,
  dataArgs: ReadonlyArray<Expr>,
  ctx: EvalContext,
  ignoreErrors: boolean,
  k?: number,
): Value {
  const flat = flattenSparseSubtotalValues(dataArgs, ctx, ignoreErrors)
  if (!flat.ok) return flat.error
  const nums = flat.values.flatMap((value) => (value.kind === 'number' ? [value.value] : []))

  switch (fnNum) {
    case 1:
      return nums.length === 0
        ? ERR('#DIV/0!')
        : { kind: 'number', value: nums.reduce((a, b) => a + b, 0) / nums.length }
    case 2:
      return { kind: 'number', value: nums.length }
    case 3:
      return {
        kind: 'number',
        value: flat.values.filter((value) => value.kind !== 'blank').length,
      }
    case 4:
      return {
        kind: 'number',
        value: nums.length === 0 ? 0 : nums.reduce((best, n) => Math.max(best, n), nums[0]),
      }
    case 5:
      return {
        kind: 'number',
        value: nums.length === 0 ? 0 : nums.reduce((best, n) => Math.min(best, n), nums[0]),
      }
    case 6:
      return {
        kind: 'number',
        value: nums.length === 0 ? 0 : nums.reduce((a, b) => a * b, 1),
      }
    case 7: {
      const variance = varianceFromSparseSubtotalNumbers(nums, true)
      return variance.kind === 'number'
        ? { kind: 'number', value: Math.sqrt(variance.value) }
        : variance
    }
    case 8: {
      const variance = varianceFromSparseSubtotalNumbers(nums, false)
      return variance.kind === 'number'
        ? { kind: 'number', value: Math.sqrt(variance.value) }
        : variance
    }
    case 9:
      return { kind: 'number', value: nums.reduce((a, b) => a + b, 0) }
    case 10:
      return varianceFromSparseSubtotalNumbers(nums, true)
    case 11:
      return varianceFromSparseSubtotalNumbers(nums, false)
    case 12: {
      if (nums.length === 0) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return {
        kind: 'number',
        value: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      }
    }
    case 13: {
      if (nums.length === 0) return ERR('#VALUE!')
      let best = nums[0]
      let bestCount = 0
      for (let i = 0; i < nums.length; i += 1) {
        let count = 0
        for (const n of nums) if (n === nums[i]) count += 1
        if (count > bestCount) {
          best = nums[i]
          bestCount = count
        }
      }
      return bestCount <= 1 ? ERR('#VALUE!') : { kind: 'number', value: best }
    }
    case 14:
    case 15: {
      if (k === undefined || k < 1 || Math.trunc(k) !== k || k > nums.length) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => (fnNum === 14 ? b - a : a - b))
      return { kind: 'number', value: sorted[k - 1] }
    }
    case 16:
    case 18: {
      if (k === undefined) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      return fnNum === 16
        ? percentileInclusiveSparseSubtotal(sorted, k)
        : percentileExclusiveSparseSubtotal(sorted, k)
    }
    case 17:
    case 19: {
      if (k === undefined || Math.trunc(k) !== k) return ERR('#VALUE!')
      if (fnNum === 17 && (k < 0 || k > 4)) return ERR('#VALUE!')
      if (fnNum === 19 && (k < 1 || k > 3)) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      return fnNum === 17
        ? percentileInclusiveSparseSubtotal(sorted, k / 4)
        : percentileExclusiveSparseSubtotal(sorted, k / 4)
    }
    default:
      return ERR('#VALUE!')
  }
}

function varianceFromSparseSubtotalNumbers(nums: ReadonlyArray<number>, sample: boolean): Value {
  const min = sample ? 2 : 1
  if (nums.length < min) return ERR('#DIV/0!')
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const denom = sample ? nums.length - 1 : nums.length
  return {
    kind: 'number',
    value: nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / denom,
  }
}

function percentileInclusiveSparseSubtotal(sorted: ReadonlyArray<number>, k: number): Value {
  if (!Number.isFinite(k) || k < 0 || k > 1 || sorted.length === 0) return ERR('#VALUE!')
  const pos = k * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return { kind: 'number', value: sorted[lo] }
  return {
    kind: 'number',
    value: sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo),
  }
}

function percentileExclusiveSparseSubtotal(sorted: ReadonlyArray<number>, k: number): Value {
  if (!Number.isFinite(k) || k <= 0 || k >= 1 || sorted.length === 0) return ERR('#VALUE!')
  const pos = k * (sorted.length + 1)
  if (pos < 1 || pos > sorted.length) return ERR('#VALUE!')
  const zero = pos - 1
  const lo = Math.floor(zero)
  const hi = Math.ceil(zero)
  if (lo === hi) return { kind: 'number', value: sorted[lo] }
  return {
    kind: 'number',
    value: sorted[lo] + (sorted[hi] - sorted[lo]) * (zero - lo),
  }
}

function evaluateMultiAreaArg(
  areas: ReadonlyArray<Expr>,
  ctx: EvalContext,
): Value {
  const rows: Value[][] = []
  for (const area of areas) {
    const resolved = runtimeRefFromExpr(area, ctx)
    if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
    const value = evaluateRuntimeRef(resolved.ref, ctx)
    if (value.kind === 'error') return value
    if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) rows.push([cell])
      }
    } else {
      rows.push([value])
    }
  }
  if (rows.length === 0) return ERR('#VALUE!')
  return arrayResult(rows, 'multi-area result')
}

function evaluateIndex(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const ref = runtimeRefFromIndexArgs(args, ctx)
  if (ref.ok) return evaluateRuntimeRef(ref.ref, ctx)
  if (ref.error && isIndexReferenceSource(args[0], ctx)) return ref.error

  const builtin = getBuiltinFunction('INDEX')
  if (!builtin) return ERR('#NAME?', "function 'INDEX' is not registered")
  const argValues: Value[] = args.map((a) => evaluateFunctionArg(a, ctx))
  return builtin(argValues, ctx)
}

function isIndexReferenceSource(expr: Expr | undefined, ctx: EvalContext): boolean {
  if (!expr) return false
  if (
    expr.kind === 'ref' ||
    expr.kind === 'range' ||
    expr.kind === 'dynamicRange' ||
    expr.kind === 'spillRef' ||
    expr.kind === 'crossSheet' ||
    expr.kind === 'multiArea'
  ) {
    return true
  }
  if (expr.kind === 'name') {
    const name = canonicalName(expr.name)
    if (ctx.lambdaScope?.get(name) !== undefined) return false
    if (ctx.lambdaRefScope?.has(name)) return true
    return ctx.resolveName(expr.name)?.kind === 'range'
  }
  if (expr.kind !== 'call') return false
  const upper = expr.name.toUpperCase()
  return upper === 'OFFSET' || upper === 'INDIRECT' || upper === 'CHOOSE'
}

function evaluateRow(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length === 0) {
    return { kind: 'number', value: (ctx.currentCell?.row ?? 0) + 1 }
  }
  if (args.length !== 1) return ERR('#VALUE!', 'ROW expects 0 or 1 arguments')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (resolved.ok) return verticalSequence(resolved.ref.range.rowStart, resolved.ref.range.rowEnd)
  if (resolved.error) return resolved.error
  const value = evaluate(args[0], ctx)
  if (value.kind === 'error') return value
  if (value.kind === 'array') return verticalSequence(0, value.value.length - 1)
  return { kind: 'number', value: 1 }
}

function evaluateColumn(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length === 0) {
    return { kind: 'number', value: (ctx.currentCell?.col ?? 0) + 1 }
  }
  if (args.length !== 1) return ERR('#VALUE!', 'COLUMN expects 0 or 1 arguments')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (resolved.ok) return horizontalSequence(resolved.ref.range.colStart, resolved.ref.range.colEnd)
  if (resolved.error) return resolved.error
  const value = evaluate(args[0], ctx)
  if (value.kind === 'error') return value
  if (value.kind === 'array') return horizontalSequence(0, (value.value[0]?.length ?? 1) - 1)
  return { kind: 'number', value: 1 }
}

function evaluateRows(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!', 'ROWS expects 1 argument')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (resolved.ok) {
    return { kind: 'number', value: resolved.ref.range.rowEnd - resolved.ref.range.rowStart + 1 }
  }
  if (resolved.error) return resolved.error
  const value = evaluate(args[0], ctx)
  if (value.kind === 'error') return value
  if (value.kind === 'array') return { kind: 'number', value: value.value.length }
  return { kind: 'number', value: 1 }
}

function evaluateColumns(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!', 'COLUMNS expects 1 argument')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (resolved.ok) {
    return { kind: 'number', value: resolved.ref.range.colEnd - resolved.ref.range.colStart + 1 }
  }
  if (resolved.error) return resolved.error
  const value = evaluate(args[0], ctx)
  if (value.kind === 'error') return value
  if (value.kind === 'array') return { kind: 'number', value: value.value[0]?.length ?? 0 }
  return { kind: 'number', value: 1 }
}

function verticalSequence(start: number, end: number): Value {
  if (start === end) return { kind: 'number', value: start + 1 }
  const rows: Value[][] = []
  for (let row = start; row <= end; row += 1) {
    rows.push([{ kind: 'number', value: row + 1 }])
  }
  return arrayResult(rows, 'ROW result')
}

function horizontalSequence(start: number, end: number): Value {
  if (start === end) return { kind: 'number', value: start + 1 }
  const row: Value[] = []
  for (let col = start; col <= end; col += 1) {
    row.push({ kind: 'number', value: col + 1 })
  }
  return arrayResult([row], 'COLUMN result')
}

function evaluateFormulaText(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!', 'FORMULATEXT expects 1 argument')
  const resolved = runtimeRefFromExpr(args[0], ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
  const cell = cellForRuntimeRef(resolved.ref, ctx)
  if (cell.error) return cell.error
  if (!cell.cell?.ast) return ERR('#N/A')
  return { kind: 'string', value: cell.cell.input }
}

function evaluateCellInfo(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!', 'CELL expects 1 or 2 arguments')
  const infoValue = evaluate(args[0], ctx)
  if (infoValue.kind === 'error') return infoValue
  if (infoValue.kind !== 'string') return ERR('#VALUE!')
  const infoType = infoValue.value.toLowerCase()

  let target: RuntimeRef
  if (args.length === 2) {
    const resolved = runtimeRefFromExpr(args[1], ctx)
    if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
    target = topLeftRuntimeRef(resolved.ref)
  } else {
    if (!ctx.currentCell) return ERR('#REF!')
    target = {
      range: {
        rowStart: ctx.currentCell.row,
        rowEnd: ctx.currentCell.row,
        colStart: ctx.currentCell.col,
        colEnd: ctx.currentCell.col,
      },
    }
  }
  const sheetError = validateRuntimeRefSheet(target, ctx)
  if (sheetError) return sheetError

  switch (infoType) {
    case 'address':
      return {
        kind: 'string',
        value: formatCellAddress(target),
      }
    case 'row':
      return { kind: 'number', value: target.range.rowStart + 1 }
    case 'col':
    case 'column':
      return { kind: 'number', value: target.range.colStart + 1 }
    case 'contents':
      return evaluateRuntimeRef(target, ctx, true)
    case 'type': {
      const value = evaluateRuntimeRef(target, ctx, true)
      if (value.kind === 'blank') return { kind: 'string', value: 'b' }
      if (value.kind === 'string') return { kind: 'string', value: 'l' }
      return { kind: 'string', value: 'v' }
    }
    case 'prefix': {
      const value = evaluateRuntimeRef(target, ctx, true)
      return { kind: 'string', value: value.kind === 'string' ? "'" : '' }
    }
    case 'width':
      return { kind: 'number', value: 8 }
    case 'protect':
      return { kind: 'number', value: 1 }
    case 'color':
    case 'parentheses':
      return { kind: 'number', value: 0 }
    case 'format':
      return { kind: 'string', value: 'G' }
    case 'filename':
      return { kind: 'string', value: '' }
    default:
      return ERR('#VALUE!')
  }
}

function formatCellAddress(ref: RuntimeRef): string {
  const address = formatA1({
    row: ref.range.rowStart,
    col: ref.range.colStart,
    absRow: true,
    absCol: true,
  })
  if (!ref.sheetName) return address
  return `${formatSheetAddressPrefix(ref.sheetName)}!${address}`
}

function formatSheetAddressPrefix(sheetName: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName)) return sheetName
  return `'${sheetName.replace(/'/g, "''")}'`
}

function evaluateIndirect(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const resolved = runtimeRefFromIndirectArgs(args, ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#REF!')
  return evaluateRuntimeRef(resolved.ref, ctx)
}

function evaluateOffset(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const resolved = runtimeRefFromOffsetArgs(args, ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#VALUE!')
  return evaluateRuntimeRef(resolved.ref, ctx)
}

function runtimeRefFromIndirectArgs(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  if (args.length < 1 || args.length > 2) {
    return { ok: false, error: ERR('#VALUE!', 'INDIRECT expects 1 or 2 arguments') }
  }
  const textValue = evaluate(args[0], ctx)
  if (textValue.kind === 'error') return { ok: false, error: textValue }
  const text = toStr(textValue)
  if (!text.ok) return { ok: false, error: text.error }

  let a1Style = true
  if (args.length === 2) {
    const styleValue = evaluate(args[1], ctx)
    if (styleValue.kind === 'error') return { ok: false, error: styleValue }
    const style = toBoolean(styleValue)
    if (!style.ok) return { ok: false, error: style.error }
    a1Style = style.value
  }

  const ref = parseIndirectReference(text.value, a1Style, ctx.currentCell)
  return ref ? { ok: true, ref } : { ok: false, error: ERR('#REF!') }
}

function runtimeRefFromOffsetArgs(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  if (args.length < 3 || args.length > 5) {
    return { ok: false, error: ERR('#VALUE!', 'OFFSET expects 3 to 5 arguments') }
  }
  const anchor = runtimeRefFromExpr(args[0], ctx)
  if (!anchor.ok) return { ok: false, error: anchor.error ?? ERR('#VALUE!') }

  const rowOffset = evaluateIntegerArg(args[1], ctx)
  if (!rowOffset.ok) return { ok: false, error: rowOffset.error }
  const colOffset = evaluateIntegerArg(args[2], ctx)
  if (!colOffset.ok) return { ok: false, error: colOffset.error }

  const anchorRows = anchor.ref.range.rowEnd - anchor.ref.range.rowStart + 1
  const anchorCols = anchor.ref.range.colEnd - anchor.ref.range.colStart + 1
  const height: IntegerArgResult = args.length >= 4
    ? evaluatePositiveIntegerArg(args[3], ctx)
    : { ok: true, value: anchorRows }
  if (!height.ok) return { ok: false, error: height.error }
  const width: IntegerArgResult = args.length === 5
    ? evaluatePositiveIntegerArg(args[4], ctx)
    : { ok: true, value: anchorCols }
  if (!width.ok) return { ok: false, error: width.error }

  const rowStart = anchor.ref.range.rowStart + rowOffset.value
  const colStart = anchor.ref.range.colStart + colOffset.value
  const rowEnd = rowStart + height.value - 1
  const colEnd = colStart + width.value - 1
  if (
    rowStart < 0 ||
    colStart < 0 ||
    rowEnd > EXCEL_MAX_ROW ||
    colEnd > EXCEL_MAX_COL
  ) {
    return { ok: false, error: ERR('#REF!') }
  }
  return {
    ok: true,
    ref: {
      sheetName: anchor.ref.sheetName,
      range: { rowStart, rowEnd, colStart, colEnd },
    },
  }
}

function runtimeRefFromIndexArgs(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  if (args.length < 2 || args.length > 4) {
    return { ok: false, error: ERR('#VALUE!', 'INDEX expects 2 to 4 arguments') }
  }
  const source = runtimeRefFromIndexSource(args, ctx)
  if (!source.ok) return source.error ? { ok: false, error: source.error } : { ok: false }

  const row = evaluateIntegerArg(args[1], ctx)
  if (!row.ok) return { ok: false, error: row.error }
  const colExplicit = args.length >= 3
  const col: IntegerArgResult = colExplicit
    ? evaluateIntegerArg(args[2], ctx)
    : { ok: true, value: 0 }
  if (!col.ok) return { ok: false, error: col.error }
  if (row.value < 0 || col.value < 0) return { ok: false, error: ERR('#VALUE!') }

  const range = source.ref.range
  const height = range.rowEnd - range.rowStart + 1
  const width = range.colEnd - range.colStart + 1

  const refAt = (
    rowStartOffset: number,
    rowEndOffset: number,
    colStartOffset: number,
    colEndOffset: number,
  ): { readonly ok: true; readonly ref: RuntimeRef } => {
    const materialized = source.ref.materialized
      ? sliceMaterialized(
          source.ref.materialized,
          rowStartOffset,
          rowEndOffset,
          colStartOffset,
          colEndOffset,
        )
      : undefined
    return {
      ok: true,
      ref: {
        sheetName: source.ref.sheetName,
        range: {
          rowStart: range.rowStart + rowStartOffset,
          rowEnd: range.rowStart + rowEndOffset,
          colStart: range.colStart + colStartOffset,
          colEnd: range.colStart + colEndOffset,
        },
        ...(materialized ? { materialized } : {}),
      },
    }
  }

  if (!colExplicit) {
    if (height === 1 && width > 1) {
      if (row.value === 0) return refAt(0, 0, 0, width - 1)
      if (row.value < 1 || row.value > width) return { ok: false, error: ERR('#REF!') }
      const colOffset = row.value - 1
      return refAt(0, 0, colOffset, colOffset)
    }
    if (width === 1 && height > 1) {
      if (row.value === 0) return refAt(0, height - 1, 0, 0)
      if (row.value < 1 || row.value > height) return { ok: false, error: ERR('#REF!') }
      const rowOffset = row.value - 1
      return refAt(rowOffset, rowOffset, 0, 0)
    }
    if (height === 1 && width === 1) {
      if (row.value === 0 || row.value === 1) return refAt(0, 0, 0, 0)
      return { ok: false, error: ERR('#REF!') }
    }
  }

  if (row.value > height || col.value > width) return { ok: false, error: ERR('#REF!') }

  if (row.value === 0 && col.value === 0) return refAt(0, height - 1, 0, width - 1)
  if (row.value === 0) {
    const colOffset = col.value - 1
    return refAt(0, height - 1, colOffset, colOffset)
  }
  if (col.value === 0) {
    const rowOffset = row.value - 1
    return refAt(rowOffset, rowOffset, 0, width - 1)
  }
  return refAt(row.value - 1, row.value - 1, col.value - 1, col.value - 1)
}

function runtimeRefFromIndexSource(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  const sourceExpr = args[0]
  if (sourceExpr.kind === 'multiArea') {
    const area = evaluateIndexAreaArg(args[3], ctx, sourceExpr.areas.length)
    if (!area.ok) return { ok: false, error: area.error }
    return runtimeRefFromExpr(sourceExpr.areas[area.value - 1], ctx)
  }

  const source = runtimeRefFromExpr(sourceExpr, ctx)
  if (!source.ok) return source
  if (args.length < 4) return source

  const area = evaluateIndexAreaArg(args[3], ctx, 1)
  if (!area.ok) return { ok: false, error: area.error }
  return source
}

function evaluateIndexAreaArg(
  expr: Expr | undefined,
  ctx: EvalContext,
  areaCount: number,
): IntegerArgResult {
  if (expr === undefined) return { ok: true, value: 1 }
  const area = evaluateIntegerArg(expr, ctx)
  if (!area.ok) return area
  if (area.value < 1) return { ok: false, error: ERR('#VALUE!') }
  if (area.value > areaCount) return { ok: false, error: ERR('#REF!') }
  return area
}

function evaluateIntegerArg(
  expr: Expr,
  ctx: EvalContext,
): IntegerArgResult {
  const value = evaluate(expr, ctx)
  if (value.kind === 'error') return { ok: false, error: value }
  const n = toNumber(value)
  if (!n.ok) return { ok: false, error: n.error }
  const integer = Math.trunc(n.value)
  if (!Number.isFinite(integer)) return { ok: false, error: ERR('#REF!') }
  return { ok: true, value: integer }
}

function evaluatePositiveIntegerArg(
  expr: Expr,
  ctx: EvalContext,
): IntegerArgResult {
  const value = evaluateIntegerArg(expr, ctx)
  if (!value.ok) return value
  if (value.value < 1) return { ok: false, error: ERR('#REF!') }
  return value
}

function topLeftRuntimeRef(ref: RuntimeRef): RuntimeRef {
  const materialized = ref.materialized ? [[ref.materialized[0]?.[0] ?? BLANK]] : undefined
  return {
    sheetName: ref.sheetName,
    range: {
      rowStart: ref.range.rowStart,
      rowEnd: ref.range.rowStart,
      colStart: ref.range.colStart,
      colEnd: ref.range.colStart,
    },
    ...(materialized ? { materialized } : {}),
  }
}

function evaluateRuntimeRef(ref: RuntimeRef, ctx: EvalContext, scalarTopLeft = false): Value {
  if (ref.materialized) {
    if (
      scalarTopLeft ||
      (ref.materialized.length === 1 && (ref.materialized[0]?.length ?? 0) === 1)
    ) {
      return ref.materialized[0]?.[0] ?? BLANK
    }
    return arrayResult(ref.materialized, 'range result')
  }
  const range = ref.range
  const start = formatA1({ row: range.rowStart, col: range.colStart })
  const isSingle = range.rowStart === range.rowEnd && range.colStart === range.colEnd
  if (isSingle || scalarTopLeft) {
    if (!ref.sheetName) return ctx.refLookup(start)
    const cells = ctx.crossSheetCells(ref.sheetName)
    if (!cells) return ERR('#REF!')
    return evaluateInForeignSheet(
      { kind: 'ref', a1: start, absCol: false, absRow: false },
      ctx,
      cells,
      ref.sheetName,
    )
  }

  const end = formatA1({ row: range.rowEnd, col: range.colEnd })
  if (!ref.sheetName) {
    const rows = ctx.rangeLookup(start, end)
    if (rows.length === 0 || rows[0].length === 0) return ERR('#REF!')
    return arrayResult(rows, 'range result')
  }
  const cells = ctx.crossSheetCells(ref.sheetName)
  if (!cells) return ERR('#REF!')
  return evaluateInForeignSheet({ kind: 'range', start, end }, ctx, cells, ref.sheetName)
}

function cellForRuntimeRef(
  ref: RuntimeRef,
  ctx: EvalContext,
): { readonly cell: Cell | undefined; readonly error?: undefined } | { readonly error: Value } {
  const cells = ref.sheetName ? ctx.crossSheetCells(ref.sheetName) : ctx.cells
  if (!cells) return { error: ERR('#REF!') }
  return {
    cell: cells.get(cellKey({ row: ref.range.rowStart, col: ref.range.colStart })),
  }
}

function shouldSparseIterate(range: CellRange): boolean {
  const wholeColumns = range.rowStart === 0 && range.rowEnd === EXCEL_MAX_ROW
  const wholeRows = range.colStart === 0 && range.colEnd === EXCEL_MAX_COL
  return wholeColumns || wholeRows || rangeCellCount(range) > MATERIALIZED_RANGE_CELL_CAP
}

function canSparseIterate(ref: RuntimeRef): boolean {
  return !ref.materialized && shouldSparseIterate(ref.range)
}

function rangeCellCount(range: CellRange): number {
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function sparseValuesForRef(
  ref: RuntimeRef,
  ctx: EvalContext,
):
  | {
      readonly ok: true
      readonly values: ReadonlyArray<{ readonly coord: CellCoord; readonly value: Value }>
    }
  | {
      readonly ok: false
      readonly error: Value
    } {
  const cells = ref.sheetName ? ctx.crossSheetCells(ref.sheetName) : ctx.cells
  if (!cells) return { ok: false, error: ERR('#REF!') }

  const coords: CellCoord[] = []
  for (const key of cells.keys()) {
    const coord = cellCoordFromKey(key)
    if (coord && rangeContainsCoord(ref.range, coord)) coords.push(coord)
  }
  coords.sort((a, b) => a.row - b.row || a.col - b.col)

  // Per-cell resolution discipline (scale-suite S3/S4 finding,
  // 2026-06-12 — pre-fix, whole-column aggregates over N existing cells
  // were O(N² log N): every uncached cell's refLookup threw NeedsDep
  // under the trampoline shim, restarting this whole scan-and-sort once
  // per cell; SUM(A:A) measured 458 ms @ 1k, 1.83 s @ 2k, 7.3 s @ 4k,
  // ~hours @ 100k):
  //
  //  1. LITERAL cells resolve straight from storage (`coords` came from
  //     this very map) — O(1), semantics-preserving (refLookup returns
  //     exactly `cell.value` for them; see `valueAtRuntimeCoord`).
  //  2. FORMULA cells keep the refLookup path (trampoline evaluation,
  //     cycle detection, lazy dep install) — but their NeedsDep faults
  //     are ACCUMULATED and rethrown as ONE batch, mirroring the shim's
  //     `rangeLookup` batching, so a column dense with formula cells
  //     costs one retry of the calling formula, not one restart per
  //     cell. Under the recursive (non-shim) path refLookup never
  //     throws and the try/catch is inert.
  const missing: Array<{
    cells: ReadonlyMap<CellKey, Cell>
    key: CellKey
    guardKey: CellKey
  }> = []
  const values: Array<{ coord: CellCoord; value: Value }> = new Array(coords.length)
  for (let i = 0; i < coords.length; i += 1) {
    const coord = coords[i]
    const cell = cells.get(cellKey(coord))
    if (cell && !cell.ast) {
      values[i] = { coord, value: cell.value }
      continue
    }
    try {
      values[i] = { coord, value: valueAtRuntimeCoord(ref.sheetName, coord, ctx) }
    } catch (err) {
      if (err instanceof NeedsDep) {
        // Placeholder never observed: the merged NeedsDep below aborts
        // the caller before `values` is returned.
        missing.push(...err.deps)
        values[i] = { coord, value: BLANK }
        continue
      }
      throw err
    }
  }
  if (missing.length > 0) throw new NeedsDep(missing)
  return { ok: true, values }
}

function rangeContainsCoord(range: CellRange, coord: CellCoord): boolean {
  return (
    coord.row >= range.rowStart &&
    coord.row <= range.rowEnd &&
    coord.col >= range.colStart &&
    coord.col <= range.colEnd
  )
}

function relativeCoord(
  source: CellRange,
  target: CellRange,
  coord: CellCoord,
): CellCoord | undefined {
  const row = target.rowStart + (coord.row - source.rowStart)
  const col = target.colStart + (coord.col - source.colStart)
  if (row < 0 || row > EXCEL_MAX_ROW || col < 0 || col > EXCEL_MAX_COL) return undefined
  return { row, col }
}

function inverseRelativeCoord(
  source: CellRange,
  target: CellRange,
  coord: CellCoord,
): CellCoord | undefined {
  const row = source.rowStart + (coord.row - target.rowStart)
  const col = source.colStart + (coord.col - target.colStart)
  if (
    row < source.rowStart ||
    row > source.rowEnd ||
    col < source.colStart ||
    col > source.colEnd
  ) {
    return undefined
  }
  return { row, col }
}

function valueAtRuntimeCoord(
  sheetName: string | undefined,
  coord: CellCoord,
  ctx: EvalContext,
): Value {
  // Literal / missing cells resolve straight from storage — O(1), no
  // trampoline fault. Routing them through `refLookup` made every
  // per-cell read inside the sparse aggregates THROW NeedsDep under the
  // trampoline shim, restarting the calling formula's whole evaluation
  // once per cell (scale-suite S3/S4 finding, 2026-06-12: SUM(A:A) over
  // N literals was O(N² log N); SUMIF(A:A, crit) re-ran once per
  // MATCHING cell — 1.86 s @ 50k). The direct read is semantics-
  // preserving: for a literal, `refLookup` returns exactly `cell.value`,
  // and for a missing cell, BLANK. Formula cells keep the original
  // paths (trampoline evaluation, cycle detection, lazy dep install)
  // untouched, as do out-of-bounds coords (#REF! via the parse failure).
  if (
    coord.row >= 0 &&
    coord.row <= EXCEL_MAX_ROW &&
    coord.col >= 0 &&
    coord.col <= EXCEL_MAX_COL
  ) {
    const storage = sheetName ? ctx.crossSheetCells(sheetName) : ctx.cells
    if (storage) {
      const cell = storage.get(cellKey(coord))
      if (!cell) return BLANK
      if (!cell.ast) return cell.value
    }
  }
  const a1 = formatA1(coord)
  if (!sheetName) return ctx.refLookup(a1)
  const cells = ctx.crossSheetCells(sheetName)
  if (!cells) return ERR('#REF!')
  return evaluateInForeignSheet(
    { kind: 'ref', a1, absCol: false, absRow: false },
    ctx,
    cells,
    sheetName,
  )
}

interface SparseCriterionPair {
  readonly ref: RuntimeRef
  readonly matches: (value: Value) => boolean
  readonly matchesBlank: boolean
}

type SparseCriteriaResult =
  | { readonly kind: 'ok'; readonly pairs: SparseCriterionPair[]; readonly usesSparse: boolean }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'error'; readonly error: Value }

function sparseCriteriaPairs(args: ReadonlyArray<Expr>, ctx: EvalContext): SparseCriteriaResult {
  const pairs: SparseCriterionPair[] = []
  let usesSparse = false

  for (let i = 0; i < args.length; i += 2) {
    const ref = runtimeRefFromExpr(args[i], ctx)
    if (!ref.ok) return ref.error ? { kind: 'error', error: ref.error } : { kind: 'fallback' }
    if (ref.ref.materialized) return { kind: 'fallback' }

    const matcher = makeCriterionMatcher(evaluateFunctionArg(args[i + 1], ctx))
    if (!matcher.ok) return { kind: 'error', error: matcher.error }

    usesSparse = usesSparse || canSparseIterate(ref.ref)
    pairs.push({ ref: ref.ref, matches: matcher.matches, matchesBlank: matcher.matchesBlank })
  }

  return { kind: 'ok', pairs, usesSparse }
}

function countIfsCandidateCoords(
  pairs: ReadonlyArray<SparseCriterionPair>,
  ctx: EvalContext,
): {
  readonly ok: true;
  readonly coords: ReadonlyArray<CellCoord>;
  readonly implicitCount: number
} | {
  readonly ok: false
  readonly error: Value
} {
  const base = pairs[0].ref.range
  const nonBlankDriver = pairs.find((pair) => !pair.matchesBlank)
  if (nonBlankDriver) {
    const sparse = sparseValuesForRef(nonBlankDriver.ref, ctx)
    if (!sparse.ok) return sparse
    const coords = new Map<CellKey, CellCoord>()
    for (const { coord, value } of sparse.values) {
      if (!nonBlankDriver.matches(value)) continue
      const baseCoord = inverseRelativeCoord(base, nonBlankDriver.ref.range, coord)
      if (baseCoord) coords.set(cellKey(baseCoord), baseCoord)
    }
    const errorCandidates = sparseCriteriaErrorCoords(pairs, ctx)
    if (!errorCandidates.ok) return errorCandidates
    for (const coord of errorCandidates.coords) coords.set(cellKey(coord), coord)
    return { ok: true, coords: [...coords.values()], implicitCount: 0 }
  }

  const candidates = new Map<CellKey, CellCoord>()
  for (const pair of pairs) {
    const sparse = sparseValuesForRef(pair.ref, ctx)
    if (!sparse.ok) return sparse
    for (const { coord } of sparse.values) {
      const baseCoord = inverseRelativeCoord(base, pair.ref.range, coord)
      if (baseCoord) candidates.set(cellKey(baseCoord), baseCoord)
    }
  }

  const implicitCount = rangeCellCount(base) - candidates.size
  return { ok: true, coords: [...candidates.values()], implicitCount }
}

function sumIfsCandidateCoords(
  pairs: ReadonlyArray<SparseCriterionPair>,
  sumRef: RuntimeRef,
  ctx: EvalContext,
): { readonly ok: true; readonly coords: ReadonlyArray<CellCoord> } | {
  readonly ok: false
  readonly error: Value
} {
  const base = pairs[0].ref.range
  const nonBlankDriver = pairs.find((pair) => !pair.matchesBlank)
  if (nonBlankDriver) {
    const sparse = sparseValuesForRef(nonBlankDriver.ref, ctx)
    if (!sparse.ok) return sparse
    const coords = new Map<CellKey, CellCoord>()
    for (const { coord, value } of sparse.values) {
      if (!nonBlankDriver.matches(value)) continue
      const baseCoord = inverseRelativeCoord(base, nonBlankDriver.ref.range, coord)
      if (baseCoord) coords.set(cellKey(baseCoord), baseCoord)
    }
    const errorCandidates = sparseCriteriaErrorCoords(pairs, ctx)
    if (!errorCandidates.ok) return errorCandidates
    for (const coord of errorCandidates.coords) coords.set(cellKey(coord), coord)
    return { ok: true, coords: [...coords.values()] }
  }

  const candidates = new Map<CellKey, CellCoord>()
  for (const pair of pairs) {
    const sparse = sparseValuesForRef(pair.ref, ctx)
    if (!sparse.ok) return sparse
    for (const { coord } of sparse.values) {
      const baseCoord = inverseRelativeCoord(base, pair.ref.range, coord)
      if (baseCoord) candidates.set(cellKey(baseCoord), baseCoord)
    }
  }
  const sumSparse = sparseValuesForRef(sumRef, ctx)
  if (!sumSparse.ok) return sumSparse
  for (const { coord } of sumSparse.values) {
    const baseCoord = inverseRelativeCoord(base, sumRef.range, coord)
    if (baseCoord) candidates.set(cellKey(baseCoord), baseCoord)
  }
  return { ok: true, coords: [...candidates.values()] }
}

function countMatchingCriteria(
  candidates: { readonly coords: ReadonlyArray<CellCoord>; readonly implicitCount: number },
  pairs: ReadonlyArray<SparseCriterionPair>,
  ctx: EvalContext,
): Value {
  let count = candidates.implicitCount
  for (const coord of candidates.coords) {
    const match = matchesAllCriteria(coord, pairs, ctx)
    if (!match.ok) return match.error
    if (match.matches) count += 1
  }
  return { kind: 'number', value: count }
}

function matchesAllCriteria(
  coord: CellCoord,
  pairs: ReadonlyArray<SparseCriterionPair>,
  ctx: EvalContext,
): { readonly ok: true; readonly matches: boolean }
  | { readonly ok: false; readonly error: Value } {
  const base = pairs[0].ref.range
  for (const pair of pairs) {
    const cell = valueAtRelativeCoord(base, pair.ref, coord, ctx)
    if (cell.kind === 'error') return { ok: false, error: cell }
    if (!pair.matches(cell)) return { ok: true, matches: false }
  }
  return { ok: true, matches: true }
}

function sparseCriteriaErrorCoords(
  pairs: ReadonlyArray<SparseCriterionPair>,
  ctx: EvalContext,
): { readonly ok: true; readonly coords: ReadonlyArray<CellCoord> } | {
  readonly ok: false
  readonly error: Value
} {
  const base = pairs[0].ref.range
  const coords = new Map<CellKey, CellCoord>()
  for (const pair of pairs) {
    const sparse = sparseValuesForRef(pair.ref, ctx)
    if (!sparse.ok) return sparse
    for (const { coord, value } of sparse.values) {
      if (value.kind !== 'error') continue
      const baseCoord = inverseRelativeCoord(base, pair.ref.range, coord)
      if (baseCoord) coords.set(cellKey(baseCoord), baseCoord)
    }
  }
  return { ok: true, coords: [...coords.values()] }
}

function validateCriteriaShapes(
  pairs: ReadonlyArray<SparseCriterionPair>,
  expected?: CellRange,
): Value | undefined {
  const base = expected ?? pairs[0]?.ref.range
  if (!base) return ERR('#VALUE!')
  for (const pair of pairs) {
    if (!sameRangeShape(base, pair.ref.range)) return ERR('#VALUE!')
  }
  return undefined
}

function sameRangeShape(a: CellRange, b: CellRange): boolean {
  return (
    a.rowEnd - a.rowStart === b.rowEnd - b.rowStart &&
    a.colEnd - a.colStart === b.colEnd - b.colStart
  )
}

function valueAtRelativeCoord(
  source: CellRange,
  target: RuntimeRef,
  coord: CellCoord,
  ctx: EvalContext,
): Value {
  const targetCoord = relativeCoord(source, target.range, coord)
  return targetCoord ? valueAtRuntimeCoord(target.sheetName, targetCoord, ctx) : ERR('#REF!')
}

function validateRuntimeRefSheet(ref: RuntimeRef, ctx: EvalContext): Value | undefined {
  if (!ref.sheetName) return undefined
  return ctx.crossSheetCells(ref.sheetName) ? undefined : ERR('#REF!')
}

function runtimeRefFromExpr(
  expr: Expr,
  ctx?: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  switch (expr.kind) {
    case 'ref': {
      const parsed = parseA1(expr.a1)
      if (!parsed) return { ok: false, error: ERR('#REF!') }
      return {
        ok: true,
        ref: {
          range: {
            rowStart: parsed.row,
            rowEnd: parsed.row,
            colStart: parsed.col,
            colEnd: parsed.col,
          },
        },
      }
    }
    case 'range': {
      const range = parseRange(expr.start, expr.end)
      if (!range) return { ok: false, error: ERR('#REF!') }
      return { ok: true, ref: { range } }
    }
    case 'dynamicRange': {
      if (!ctx) return { ok: false }
      return runtimeRefFromDynamicRange(expr, ctx)
    }
    case 'spillRef': {
      if (!ctx) return { ok: false }
      return runtimeRefFromSpillRef(expr, ctx)
    }
    case 'crossSheet': {
      const inner = runtimeRefFromExpr(expr.inner, ctx)
      if (!inner.ok) return inner
      return {
        ok: true,
        ref: {
          sheetName: expr.sheetName,
          range: inner.ref.range,
        },
      }
    }
    case 'name': {
      if (!ctx) return { ok: false }
      const name = canonicalName(expr.name)
      if (ctx.lambdaScope?.get(name) !== undefined) return { ok: false }
      const scopedRef = ctx.lambdaRefScope?.get(name)
      if (scopedRef) return { ok: true, ref: scopedRef }
      const binding = ctx.resolveName(expr.name)
      if (binding?.kind !== 'range') return { ok: false }
      const range = parseRange(binding.start, binding.end)
      if (!range) return { ok: false, error: ERR('#REF!') }
      return { ok: true, ref: { sheetName: binding.sheetName, range } }
    }
    case 'call': {
      if (!ctx) return { ok: false }
      const upper = expr.name.toUpperCase()
      if (upper === 'OFFSET') return runtimeRefFromOffsetArgs(expr.args, ctx)
      if (upper === 'INDIRECT') return runtimeRefFromIndirectArgs(expr.args, ctx)
      if (upper === 'INDEX') return runtimeRefFromIndexArgs(expr.args, ctx)
      if (upper === 'CHOOSE') {
        const selected = chooseSelectedExpr(expr.args, ctx)
        if (!selected.ok) return { ok: false, error: selected.error }
        return runtimeRefFromExpr(selected.expr, ctx)
      }
      return { ok: false }
    }
    default:
      return { ok: false }
  }
}

function runtimeRefFromDynamicRange(
  expr: Extract<Expr, { readonly kind: 'dynamicRange' }>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  const start = runtimeRefFromExpr(expr.start, ctx)
  if (!start.ok) return start.error ? { ok: false, error: start.error } : { ok: false }
  const end = runtimeRefFromExpr(expr.end, ctx)
  if (!end.ok) return end.error ? { ok: false, error: end.error } : { ok: false, error: ERR('#VALUE!') }

  const sheet = combinedRuntimeRefSheet(start.ref, end.ref, ctx)
  if (!sheet.ok) return { ok: false, error: sheet.error }

  return {
    ok: true,
    ref: {
      sheetName: sheet.sheetName,
      range: normalizeRange({
        rowStart: start.ref.range.rowStart,
        rowEnd: end.ref.range.rowEnd,
        colStart: start.ref.range.colStart,
        colEnd: end.ref.range.colEnd,
      }),
    },
  }
}

function combinedRuntimeRefSheet(
  start: RuntimeRef,
  end: RuntimeRef,
  ctx: EvalContext,
): { readonly ok: true; readonly sheetName?: string }
  | { readonly ok: false; readonly error: Value } {
  const lhs = start.sheetName ?? ctx.currentSheetName
  const rhs = end.sheetName ?? ctx.currentSheetName
  if (lhs !== undefined && rhs !== undefined && lhs !== rhs) {
    return { ok: false, error: ERR('#VALUE!', 'range endpoints must be on the same sheet') }
  }
  return { ok: true, sheetName: start.sheetName ?? end.sheetName }
}

function evaluateSpillRef(
  expr: Extract<Expr, { readonly kind: 'spillRef' }>,
  ctx: EvalContext,
): Value {
  const resolved = runtimeRefFromSpillRef(expr, ctx)
  if (!resolved.ok) return resolved.error ?? ERR('#REF!')
  if (resolved.ref.materialized) return arrayResult(resolved.ref.materialized, 'range result')
  return evaluateRuntimeRef(resolved.ref, ctx)
}

function runtimeRefFromSpillRef(
  expr: Extract<Expr, { readonly kind: 'spillRef' }>,
  ctx: EvalContext,
): { readonly ok: true; readonly ref: RuntimeRef } | {
  readonly ok: false
  readonly error?: Value
} {
  const anchor = runtimeRefFromExpr(expr.anchor, ctx)
  if (!anchor.ok) return anchor.error ? { ok: false, error: anchor.error } : { ok: false }
  const value = spillAnchorValue(expr, ctx)
  if (value.kind === 'error') return { ok: false, error: value }
  if (value.kind !== 'array') {
    return { ok: false, error: ERR('#REF!', 'spill reference anchor is not an array') }
  }
  const rows = value.value.length
  const cols = value.value[0]?.length ?? 0
  if (rows < 1 || cols < 1) return { ok: false, error: ERR('#REF!') }
  const rowEnd = anchor.ref.range.rowStart + rows - 1
  const colEnd = anchor.ref.range.colStart + cols - 1
  if (rowEnd > EXCEL_MAX_ROW || colEnd > EXCEL_MAX_COL) return { ok: false, error: ERR('#REF!') }
  return {
    ok: true,
    ref: {
      sheetName: anchor.ref.sheetName,
      range: {
        rowStart: anchor.ref.range.rowStart,
        rowEnd,
        colStart: anchor.ref.range.colStart,
        colEnd,
      },
      materialized: value.value,
    },
  }
}

function sliceMaterialized(
  cells: Value[][],
  rowStartOffset: number,
  rowEndOffset: number,
  colStartOffset: number,
  colEndOffset: number,
): Value[][] {
  const out: Value[][] = []
  for (let r = rowStartOffset; r <= rowEndOffset; r += 1) {
    out.push(cells[r].slice(colStartOffset, colEndOffset + 1))
  }
  return out
}

function spillAnchorValue(
  expr: Extract<Expr, { readonly kind: 'spillRef' }>,
  ctx: EvalContext,
): Value {
  const anchor = runtimeRefFromExpr(expr.anchor, ctx)
  if (!anchor.ok) return anchor.error ?? ERR('#REF!')
  const range = anchor.ref.range
  if (range.rowStart !== range.rowEnd || range.colStart !== range.colEnd) return ERR('#REF!')
  return valueAtRuntimeCoord(
    anchor.ref.sheetName,
    { row: range.rowStart, col: range.colStart },
    ctx,
  )
}

function parseIndirectReference(
  text: string,
  a1Style = true,
  base?: CellCoord,
): RuntimeRef | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  let sheetName: string | undefined
  let body = trimmed
  if (trimmed[0] === "'") {
    const quoted = readQuotedSheetName(trimmed)
    if (!quoted || trimmed[quoted.next] !== '!') return undefined
    sheetName = quoted.name
    body = trimmed.slice(quoted.next + 1)
  } else {
    const bang = trimmed.indexOf('!')
    if (bang >= 0) {
      sheetName = trimmed.slice(0, bang)
      if (sheetName.length === 0) return undefined
      body = trimmed.slice(bang + 1)
    }
  }
  if (body.length === 0) return undefined

  const range = parseIndirectBody(body, a1Style, base)
  return range ? { sheetName, range } : undefined
}

function parseIndirectBody(
  body: string,
  a1Style: boolean,
  base?: CellCoord,
): CellRange | undefined {
  const colon = body.indexOf(':')
  if (colon < 0) {
    const parsed = a1Style ? parseA1(body) : parseR1C1(body, base)
    if (!parsed) return undefined
    return {
      rowStart: parsed.row,
      rowEnd: parsed.row,
      colStart: parsed.col,
      colEnd: parsed.col,
    }
  }
  if (body.indexOf(':', colon + 1) >= 0) return undefined
  const parsePart = (part: string): CellCoord | null =>
    a1Style ? parseA1(part) : parseR1C1(part, base)
  const startStr = body.slice(0, colon).trim()
  const endStr = body.slice(colon + 1).trim()
  if (a1Style) {
    const wholeColumn = expandWholeColumn(startStr, endStr)
    if (wholeColumn) return wholeColumn
    const wholeRow = expandWholeRow(startStr, endStr)
    if (wholeRow) return wholeRow
  }
  const start = parsePart(startStr)
  const end = parsePart(endStr)
  if (!start || !end) return undefined
  return {
    rowStart: Math.min(start.row, end.row),
    rowEnd: Math.max(start.row, end.row),
    colStart: Math.min(start.col, end.col),
    colEnd: Math.max(start.col, end.col),
  }
}

const WHOLE_COLUMN_PART_RE = /^\$?[A-Za-z]{1,3}$/
const WHOLE_ROW_PART_RE = /^\$?\d+$/

function expandWholeColumn(startStr: string, endStr: string): CellRange | undefined {
  if (!WHOLE_COLUMN_PART_RE.test(startStr) || !WHOLE_COLUMN_PART_RE.test(endStr)) {
    return undefined
  }
  const startCol = parseA1(`${startStr}1`)
  const endCol = parseA1(`${endStr}1`)
  if (!startCol || !endCol) return undefined
  return {
    rowStart: 0,
    rowEnd: EXCEL_MAX_ROW,
    colStart: Math.min(startCol.col, endCol.col),
    colEnd: Math.max(startCol.col, endCol.col),
  }
}

function expandWholeRow(startStr: string, endStr: string): CellRange | undefined {
  if (!WHOLE_ROW_PART_RE.test(startStr) || !WHOLE_ROW_PART_RE.test(endStr)) {
    return undefined
  }
  const startRow = parseA1(`A${startStr}`)
  const endRow = parseA1(`A${endStr}`)
  if (!startRow || !endRow) return undefined
  return {
    rowStart: Math.min(startRow.row, endRow.row),
    rowEnd: Math.max(startRow.row, endRow.row),
    colStart: 0,
    colEnd: EXCEL_MAX_COL,
  }
}

function parseR1C1(text: string, base?: CellCoord): CellCoord | null {
  const match = /^R(\[[-+]?\d+\]|\d*)C(\[[-+]?\d+\]|\d*)$/i.exec(text.trim())
  if (!match) return null
  const row = resolveR1C1Axis(match[1], base?.row, EXCEL_MAX_ROW)
  const col = resolveR1C1Axis(match[2], base?.col, EXCEL_MAX_COL)
  if (row === undefined || col === undefined) return null
  return { row, col }
}

function resolveR1C1Axis(
  spec: string,
  base: number | undefined,
  max: number,
): number | undefined {
  if (spec.length === 0) return base
  if (spec[0] === '[') {
    if (base === undefined || spec[spec.length - 1] !== ']') return undefined
    const offset = Number(spec.slice(1, -1))
    if (!Number.isInteger(offset)) return undefined
    const resolved = base + offset
    return resolved < 0 || resolved > max ? undefined : resolved
  }
  const oneBased = Number(spec)
  if (!Number.isInteger(oneBased) || oneBased < 1) return undefined
  const resolved = oneBased - 1
  return resolved > max ? undefined : resolved
}

function readQuotedSheetName(
  text: string,
): { readonly name: string; readonly next: number } | undefined {
  let i = 1
  let name = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      if (text[i + 1] === "'") {
        name += "'"
        i += 2
        continue
      }
      return { name, next: i + 1 }
    }
    name += ch
    i += 1
  }
  return undefined
}

function evaluateLet(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 3 || args.length % 2 === 0) {
    return ERR('#VALUE!', 'LET expects name/value pairs plus a result expression')
  }

  const valueScope = new Map<string, Value>(ctx.lambdaScope ?? [])
  const refScope = new Map<string, RuntimeRef>(ctx.lambdaRefScope ?? [])
  const functionScope = new Map<string, LambdaBinding>(ctx.lambdaFunctionScope ?? [])
  const omitted = ctx.lambdaOmittedParams
    ? new Set<string>(ctx.lambdaOmittedParams)
    : undefined
  const subCtx: EvalContext = {
    ...ctx,
    lambdaScope: valueScope,
    lambdaRefScope: refScope,
    lambdaFunctionScope: functionScope,
    lambdaOmittedParams: omitted,
  }

  for (let i = 0; i < args.length - 1; i += 2) {
    const nameExpr = args[i]
    if (nameExpr.kind !== 'name') {
      return ERR('#NAME?', 'LET binding name must be an identifier')
    }
    const name = canonicalName(nameExpr.name)
    const lambda = resolveLambdaExpr(args[i + 1], subCtx)
    if (lambda.error) return lambda.error
    if (lambda.lambda) {
      const recursive = bindLambdaSelf(name, lambda.lambda)
      functionScope.set(name, recursive)
      valueScope.delete(name)
      refScope.delete(name)
      omitted?.delete(name)
      continue
    }

    const ref = runtimeRefFromExpr(args[i + 1], subCtx)
    if (ref.ok) {
      const sheetError = validateRuntimeRefSheet(ref.ref, subCtx)
      if (sheetError) return sheetError
      refScope.set(name, ref.ref)
      valueScope.delete(name)
      functionScope.delete(name)
      omitted?.delete(name)
      continue
    }
    if (ref.error) return ref.error

    const value = evaluate(args[i + 1], subCtx)
    if (value.kind === 'error') return value
    valueScope.set(name, value)
    refScope.delete(name)
    functionScope.delete(name)
    omitted?.delete(name)
  }

  return evaluate(args[args.length - 1], subCtx)
}

function evaluateIsOmitted(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 1) return ERR('#VALUE!', 'ISOMITTED expects 1 argument')
  if (!ctx.lambdaOmittedParams) return ERR('#NAME?')
  const arg = args[0]
  if (arg.kind === 'name' && ctx.lambdaOmittedParams?.has(canonicalName(arg.name))) {
    return { kind: 'boolean', value: true }
  }
  const value = evaluate(arg, ctx)
  if (value.kind === 'error') return value
  return { kind: 'boolean', value: false }
}

function evaluateMap(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 2) return ERR('#VALUE!', 'MAP expects at least 2 arguments')
  const lambda = requireLambda(args[args.length - 1], ctx, args.length - 1)
  if (lambda.error) return lambda.error

  // Whole-column / whole-row inputs (e.g. `MAP(A:A, ...)`) would force a
  // 1,048,576-row materialization through `evaluateGrid` and trip the
  // range-materialization cap. Detect a single-arg sparse ref and
  // iterate only the non-empty cells from the sheet snapshot.
  if (args.length === 2) {
    const sparseResult = evaluateMapSparse(args[0], lambda.lambda, ctx)
    if (sparseResult) return sparseResult
  }

  const grids: Grid[] = []
  for (const arg of args.slice(0, -1)) {
    const grid = evaluateGrid(arg, ctx)
    if (grid.error) return grid.error
    grids.push(grid.grid)
  }
  const first = grids[0]
  if (!first || first.rows === 0 || first.cols === 0) return ERR('#VALUE!')
  const shapeError = arrayShapeError(first.rows, first.cols, 'MAP result')
  if (shapeError) return shapeError
  for (const grid of grids.slice(1)) {
    if (grid.rows !== first.rows || grid.cols !== first.cols) {
      return ERR('#VALUE!', 'MAP input arrays must have the same shape')
    }
  }
  const out = makeMatrix(first.rows, first.cols)
  for (let r = 0; r < first.rows; r += 1) {
    for (let c = 0; c < first.cols; c += 1) {
      const values = grids.map((grid) => grid.cells[r][c])
      const result = applyLambdaForArrayCell(lambda.lambda, values, ctx)
      if (!result.ok) return result.error
      out[r][c] = result.value
    }
  }
  return arrayResult(out, 'MAP result')
}

/**
 * Sparse MAP path: when the single source argument is a whole-column or
 * whole-row reference, iterate only the non-empty cells from the sheet
 * snapshot. Returns `undefined` to defer to the materialized path when
 * the input does not qualify.
 *
 * The result is a 1-column vector of mapped non-empty values, in
 * row-major coord order of the sheet — we deliberately drop blank cells
 * rather than producing a 1,048,576-row sparse result.
 */
function evaluateMapSparse(
  expr: Expr,
  lambda: LambdaBinding,
  ctx: EvalContext,
): Value | undefined {
  const ref = runtimeRefFromExpr(expr, ctx)
  if (!ref.ok) return undefined
  if (!canSparseIterate(ref.ref)) return undefined
  const sheetError = validateRuntimeRefSheet(ref.ref, ctx)
  if (sheetError) return sheetError

  const sparse = sparseValuesForRef(ref.ref, ctx)
  if (!sparse.ok) return sparse.error

  const out: Value[][] = []
  for (const { value } of sparse.values) {
    if (value.kind === 'blank') continue
    const result = applyLambdaForArrayCell(lambda, [value], ctx)
    if (!result.ok) return result.error
    out.push([result.value])
  }
  if (out.length === 0) return ERR('#CALC!', 'MAP produced no rows')
  return arrayResult(out, 'MAP result')
}

function evaluateReduce(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 3) return ERR('#VALUE!', 'REDUCE expects 3 arguments')
  const initial = evaluate(args[0], ctx)
  if (initial.kind === 'error') return initial
  const grid = evaluateGrid(args[1], ctx)
  if (grid.error) return grid.error
  const shapeError = arrayShapeError(grid.grid.rows, grid.grid.cols, 'REDUCE input')
  if (shapeError) return shapeError
  const lambda = requireLambda(args[2], ctx, 2)
  if (lambda.error) return lambda.error
  let acc: Value = initial
  for (let r = 0; r < grid.grid.rows; r += 1) {
    for (let c = 0; c < grid.grid.cols; c += 1) {
      acc = applyLambda(lambda.lambda, [acc, grid.grid.cells[r][c]], ctx)
      if (acc.kind === 'error') return acc
    }
  }
  return acc
}

function evaluateScan(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 3) return ERR('#VALUE!', 'SCAN expects 3 arguments')
  const initial = evaluate(args[0], ctx)
  if (initial.kind === 'error') return initial
  const grid = evaluateGrid(args[1], ctx)
  if (grid.error) return grid.error
  const lambda = requireLambda(args[2], ctx, 2)
  if (lambda.error) return lambda.error
  const shapeError = arrayShapeError(grid.grid.rows, grid.grid.cols, 'SCAN result')
  if (shapeError) return shapeError
  const out = makeMatrix(grid.grid.rows, grid.grid.cols)
  let acc: Value = initial
  for (let r = 0; r < grid.grid.rows; r += 1) {
    for (let c = 0; c < grid.grid.cols; c += 1) {
      const result = applyLambdaForArrayCell(lambda.lambda, [acc, grid.grid.cells[r][c]], ctx)
      if (!result.ok) return result.error
      acc = result.value
      out[r][c] = result.value
    }
  }
  return arrayResult(out, 'SCAN result')
}

function evaluateByRow(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 2) return ERR('#VALUE!', 'BYROW expects 2 arguments')
  const grid = evaluateGrid(args[0], ctx)
  if (grid.error) return grid.error
  const inputShapeError = arrayShapeError(grid.grid.rows, grid.grid.cols, 'BYROW input')
  if (inputShapeError) return inputShapeError
  const outputShapeError = arrayShapeError(grid.grid.rows, 1, 'BYROW result')
  if (outputShapeError) return outputShapeError
  const lambda = requireLambda(args[1], ctx, 1)
  if (lambda.error) return lambda.error
  const out = makeMatrix(grid.grid.rows, 1)
  for (let r = 0; r < grid.grid.rows; r += 1) {
    const rowArray: Value = { kind: 'array', value: [grid.grid.cells[r].slice()] }
    const result = applyLambdaForArrayCell(lambda.lambda, [rowArray], ctx)
    if (!result.ok) return result.error
    out[r][0] = result.value
  }
  return arrayResult(out, 'BYROW result')
}

function evaluateByCol(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 2) return ERR('#VALUE!', 'BYCOL expects 2 arguments')
  const grid = evaluateGrid(args[0], ctx)
  if (grid.error) return grid.error
  const inputShapeError = arrayShapeError(grid.grid.rows, grid.grid.cols, 'BYCOL input')
  if (inputShapeError) return inputShapeError
  const outputShapeError = arrayShapeError(1, grid.grid.cols, 'BYCOL result')
  if (outputShapeError) return outputShapeError
  const lambda = requireLambda(args[1], ctx, 1)
  if (lambda.error) return lambda.error
  const out = makeMatrix(1, grid.grid.cols)
  for (let c = 0; c < grid.grid.cols; c += 1) {
    const col: Value[][] = []
    for (let r = 0; r < grid.grid.rows; r += 1) {
      col.push([grid.grid.cells[r][c]])
    }
    const result = applyLambdaForArrayCell(lambda.lambda, [{ kind: 'array', value: col }], ctx)
    if (!result.ok) return result.error
    out[0][c] = result.value
  }
  return arrayResult(out, 'BYCOL result')
}

function evaluateMakeArray(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length !== 3) return ERR('#VALUE!', 'MAKEARRAY expects 3 arguments')
  const rowsValue = evaluate(args[0], ctx)
  if (rowsValue.kind === 'error') return rowsValue
  const colsValue = evaluate(args[1], ctx)
  if (colsValue.kind === 'error') return colsValue
  const rowsNumber = toNumber(rowsValue)
  if (!rowsNumber.ok) return rowsNumber.error
  const colsNumber = toNumber(colsValue)
  if (!colsNumber.ok) return colsNumber.error
  const rows = Math.trunc(rowsNumber.value)
  const cols = Math.trunc(colsNumber.value)
  if (rows < 1 || cols < 1 || !Number.isFinite(rows) || !Number.isFinite(cols)) {
    return ERR('#VALUE!', 'MAKEARRAY dimensions must be positive')
  }
  const shapeError = arrayShapeError(rows, cols, 'MAKEARRAY result')
  if (shapeError) return shapeError
  const lambda = requireLambda(args[2], ctx, 2)
  if (lambda.error) return lambda.error
  const out = makeMatrix(rows, cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const result = applyLambdaForArrayCell(
        lambda.lambda,
        [
          { kind: 'number', value: r + 1 },
          { kind: 'number', value: c + 1 },
        ],
        ctx,
      )
      if (!result.ok) return result.error
      out[r][c] = result.value
    }
  }
  return arrayResult(out, 'MAKEARRAY result')
}

function evaluateFilter(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'FILTER needs 2-3 args')

  // Whole-column / whole-row inputs (e.g. `FILTER(A:A, A:A > 1)`) would
  // force 1M-row materialization on both args. Detect the case where
  // the array arg and the include arg share the same sparse-iterable
  // ref (typical shape: `FILTER(R, R op scalar)`) and iterate only the
  // non-empty cells from the sheet snapshot.
  const sparseResult = evaluateFilterSparse(args, ctx)
  if (sparseResult) return sparseResult

  const filtered = selectFilterRows(args[0], args[1], ctx)
  if (!filtered.ok) return filtered.error
  if (filtered.rows.length === 0 || filtered.rows[0]?.length === 0) {
    if (args.length === 3) return evaluateFunctionArg(args[2], ctx)
    return ERR('#CALC!', 'FILTER returned empty result')
  }
  return arrayResult(filtered.rows, 'FILTER result')
}

/**
 * Sparse FILTER path: returns a value when the array arg is a sparse
 * ref and the include arg is a `binary` comparison whose operands are
 * (the same ref) and (a scalar). For each non-empty cell we materialize
 * a 1×1 array binary against the scalar and check truthiness. Returns
 * `undefined` to fall back to the materializing path.
 */
function evaluateFilterSparse(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): Value | undefined {
  if (args.length < 2) return undefined
  const arrayRef = runtimeRefFromExpr(args[0], ctx)
  if (!arrayRef.ok) return undefined
  if (!canSparseIterate(arrayRef.ref)) return undefined
  const sheetError = validateRuntimeRefSheet(arrayRef.ref, ctx)
  if (sheetError) return sheetError

  const include = args[1]
  if (include.kind !== 'binary') return undefined
  // Identify which side is the same ref as the array arg, and which is
  // the scalar. The ref-side need not be byte-identical but must be a
  // runtime ref to the same range (so `A:A > 1` and `$A:$A > 1` both work).
  const leftRef = runtimeRefFromExpr(include.left, ctx)
  const rightRef = runtimeRefFromExpr(include.right, ctx)
  let scalarExpr: Expr
  if (leftRef.ok && sameRuntimeRefRange(leftRef.ref, arrayRef.ref)) {
    scalarExpr = include.right
  } else if (rightRef.ok && sameRuntimeRefRange(rightRef.ref, arrayRef.ref)) {
    scalarExpr = include.left
  } else {
    return undefined
  }
  const scalar = evaluate(scalarExpr, ctx)
  if (scalar.kind === 'error') return scalar
  if (scalar.kind === 'array') return undefined

  const sparse = sparseValuesForRef(arrayRef.ref, ctx)
  if (!sparse.ok) return sparse.error

  const out: Value[][] = []
  const leftIsRef = leftRef.ok && sameRuntimeRefRange(leftRef.ref, arrayRef.ref)
  for (const { value } of sparse.values) {
    if (value.kind === 'blank') continue
    const cmp = leftIsRef
      ? applyBinary(include.op, value, scalar)
      : applyBinary(include.op, scalar, value)
    if (cmp.kind === 'error') return cmp
    const bool = toBoolean(cmp)
    if (!bool.ok) return bool.error
    if (bool.value) out.push([value])
  }
  if (out.length === 0) {
    if (args.length === 3) return evaluateFunctionArg(args[2], ctx)
    return ERR('#CALC!', 'FILTER returned empty result')
  }
  return arrayResult(out, 'FILTER result')
}

function sameRuntimeRefRange(a: RuntimeRef, b: RuntimeRef): boolean {
  if (a.sheetName !== b.sheetName) return false
  return (
    a.range.rowStart === b.range.rowStart &&
    a.range.rowEnd === b.range.rowEnd &&
    a.range.colStart === b.range.colStart &&
    a.range.colEnd === b.range.colEnd
  )
}

/**
 * Sparse TOCOL path: when the source argument is a whole-column or
 * whole-row reference, iterate only the non-empty cells from the sheet
 * snapshot. The `ignore` and `scan_by_column` modes are forwarded
 * unchanged; for a 1-D ref the scan direction does not matter.
 *
 * Returns `undefined` to fall back to the regular built-in dispatch
 * when the input does not qualify (e.g. inline array literal).
 */
function evaluateTocolSparse(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): Value | undefined {
  if (args.length < 1 || args.length > 3) return undefined
  const ref = runtimeRefFromExpr(args[0], ctx)
  if (!ref.ok) return undefined
  if (!canSparseIterate(ref.ref)) return undefined
  const sheetError = validateRuntimeRefSheet(ref.ref, ctx)
  if (sheetError) return sheetError

  // Resolve ignore mode (0 = keep all; 1 = ignore blanks; 2 = ignore
  // errors; 3 = ignore both). Sparse iteration already skips blanks
  // implicitly because the snapshot only contains stored cells; for
  // modes 0 and 2 we re-introduce blanks would be wrong, so we keep
  // the sparse behavior — blanks were never authored, so dropping
  // them matches what Excel would render for `TOCOL(A:A, 0)` once it
  // ran out of column-length budget.
  let ignoreMode = 0
  if (args.length >= 2) {
    const v = evaluateFunctionArg(args[1], ctx)
    if (v.kind === 'error') return v
    const num = toNumber(v)
    if (!num.ok) return num.error
    const m = Math.trunc(num.value)
    if (m < 0 || m > 3) return ERR('#VALUE!')
    ignoreMode = m
  }

  const sparse = sparseValuesForRef(ref.ref, ctx)
  if (!sparse.ok) return sparse.error

  const ignoreError = ignoreMode === 2 || ignoreMode === 3
  const out: Value[] = []
  for (const { value } of sparse.values) {
    if (value.kind === 'blank') continue
    if (ignoreError && value.kind === 'error') continue
    out.push(value)
  }
  if (out.length === 0) return ERR('#CALC!')
  return arrayResult(out.map((v) => [v]), 'TOCOL result')
}

function evaluateTakeDrop(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
  mode: 'take' | 'drop',
): Value | undefined {
  if (args.length < 2 || args.length > 3) {
    return ERR('#VALUE!', `${mode.toUpperCase()} needs 2-3 args`)
  }

  const source = runtimeRefFromExpr(args[0], ctx)
  if (!source.ok) return source.error ?? undefined
  const sheetError = validateRuntimeRefSheet(source.ref, ctx)
  if (sheetError) return sheetError

  const rows = source.ref.range.rowEnd - source.ref.range.rowStart + 1
  const cols = source.ref.range.colEnd - source.ref.range.colStart + 1
  const rowCount = evaluateArrayIntegerArg(args[1], ctx)
  if (!rowCount.ok) return rowCount.error
  const rowRange = mode === 'take'
    ? takeSliceRange(rows, rowCount.value)
    : dropSliceRange(rows, rowCount.value)
  if (!rowRange.ok) return rowRange.error

  let colStart = 0
  let colEnd = cols
  if (args.length === 3) {
    const colCount = evaluateArrayIntegerArg(args[2], ctx)
    if (!colCount.ok) return colCount.error
    const colRange = mode === 'take'
      ? takeSliceRange(cols, colCount.value)
      : dropSliceRange(cols, colCount.value)
    if (!colRange.ok) return colRange.error
    colStart = colRange.start
    colEnd = colRange.end
  }

  const outRows = rowRange.end - rowRange.start
  const outCols = colEnd - colStart
  const shapeError = arrayShapeError(outRows, outCols, `${mode.toUpperCase()} result`)
  if (shapeError) return shapeError

  return arrayResult(
    materializeRuntimeRefSlice(
      source.ref,
      rowRange.start,
      rowRange.end,
      colStart,
      colEnd,
      ctx,
    ),
    `${mode.toUpperCase()} result`,
  )
}

function evaluateArrayIntegerArg(
  expr: Expr,
  ctx: EvalContext,
): IntegerArgResult {
  const value = evaluateFunctionArg(expr, ctx)
  if (value.kind === 'error') return { ok: false, error: value }
  const n = toNumber(value)
  if (!n.ok) return { ok: false, error: n.error }
  if (!Number.isFinite(n.value)) return { ok: false, error: ERR('#NUM!') }
  return { ok: true, value: Math.trunc(n.value) }
}

function takeSliceRange(size: number, count: number): SliceRangeResult {
  if (count === 0) return { ok: false, error: ERR('#CALC!') }
  const n = Math.min(Math.abs(count), size)
  if (n === 0) return { ok: false, error: ERR('#CALC!') }
  if (count > 0) return { ok: true, start: 0, end: n }
  return { ok: true, start: size - n, end: size }
}

function dropSliceRange(size: number, count: number): SliceRangeResult {
  if (count === 0) return { ok: false, error: ERR('#CALC!') }
  if (count > 0) {
    const start = Math.min(count, size)
    if (start >= size) return { ok: false, error: ERR('#CALC!') }
    return { ok: true, start, end: size }
  }
  const end = Math.max(0, size + count)
  if (end <= 0) return { ok: false, error: ERR('#CALC!') }
  return { ok: true, start: 0, end }
}

function materializeRuntimeRefSlice(
  ref: RuntimeRef,
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
  ctx: EvalContext,
): Value[][] {
  const out: Value[][] = []
  for (let r = rowStart; r < rowEnd; r += 1) {
    const row: Value[] = []
    for (let c = colStart; c < colEnd; c += 1) {
      if (ref.materialized) {
        row.push(ref.materialized[r]?.[c] ?? BLANK)
      } else {
        row.push(valueAtRuntimeCoord(
          ref.sheetName,
          { row: ref.range.rowStart + r, col: ref.range.colStart + c },
          ctx,
        ))
      }
    }
    out.push(row)
  }
  return out
}

function evaluateChoose(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  if (args.length < 2) return ERR('#VALUE!')
  const indexValue = evaluateFunctionArg(args[0], ctx)
  if (indexValue.kind === 'error') return indexValue
  if (indexValue.kind === 'array') return evaluateArrayChoose(indexValue, args, ctx)
  const selected = chooseSelectedExpr(args, ctx)
  if (!selected.ok) return selected.error
  return evaluateFunctionArg(selected.expr, ctx)
}

function evaluateXLookup(args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const result = evaluateXLookupMatch(args, ctx)
  switch (result.kind) {
    case 'value':
      return result.value
    case 'error':
      return result.error
    case 'notFound':
      if (args.length >= 4) return evaluateFunctionArg(args[3], ctx)
      return ERR('#N/A')
  }
}

function evaluateXLookupMatch(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): XLookupCoreResult {
  if (args.length < 3 || args.length > 6) return { kind: 'error', error: ERR('#VALUE!') }

  const needle = evaluateFunctionArg(args[0], ctx)
  if (needle.kind === 'error') return { kind: 'error', error: needle }
  const lookupValue = evaluateFunctionArg(args[1], ctx)
  if (lookupValue.kind === 'error') return { kind: 'error', error: lookupValue }
  const returnValue = evaluateFunctionArg(args[2], ctx)
  if (returnValue.kind === 'error') return { kind: 'error', error: returnValue }
  const matchMode = args.length >= 5 ? evaluateFunctionArg(args[4], ctx) : undefined
  if (matchMode?.kind === 'error') return { kind: 'error', error: matchMode }
  const searchMode = args.length >= 6 ? evaluateFunctionArg(args[5], ctx) : undefined
  if (searchMode?.kind === 'error') return { kind: 'error', error: searchMode }

  return resolveXLookupValue(needle, lookupValue, returnValue, matchMode, searchMode)
}

function evaluateArrayIf(cond: Value, args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const condGrid = valueToGrid(cond)
  if (condGrid.error) return condGrid.error
  const rows = condGrid.grid.rows
  const cols = condGrid.grid.cols
  const conds: Array<Array<
    | { readonly kind: 'then' }
    | { readonly kind: 'else' }
    | { readonly kind: 'error'; readonly error: Value }
  >> = new Array(rows)
  let needsThen = false
  let needsElse = false

  for (let r = 0; r < rows; r += 1) {
    conds[r] = new Array(cols)
    for (let c = 0; c < cols; c += 1) {
      const coerced = toBoolean(condGrid.grid.cells[r][c])
      if (!coerced.ok) {
        conds[r][c] = { kind: 'error', error: coerced.error }
      } else if (coerced.value) {
        conds[r][c] = { kind: 'then' }
        needsThen = true
      } else {
        conds[r][c] = { kind: 'else' }
        needsElse = true
      }
    }
  }

  const thenGrid = needsThen
    ? evaluateBroadcastGrid(args[1], ctx, rows, cols)
    : undefined
  if (thenGrid?.error) return thenGrid.error
  const elseGrid = needsElse
    ? args.length === 3
      ? evaluateBroadcastGrid(args[2], ctx, rows, cols)
      : valueBroadcastGrid({ kind: 'boolean', value: false }, rows, cols)
    : undefined
  if (elseGrid?.error) return elseGrid.error

  const out = makeMatrix(rows, cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const selected = conds[r][c]
      switch (selected.kind) {
        case 'error':
          out[r][c] = selected.error
          break
        case 'then':
          out[r][c] = pickBroadcastCell(thenGrid!.grid, r, c)
          break
        case 'else':
          out[r][c] = pickBroadcastCell(elseGrid!.grid, r, c)
          break
      }
    }
  }
  return arrayResult(out, 'IF result')
}

function evaluateArrayIfError(
  value: Value,
  fallback: Expr,
  ctx: EvalContext,
  catches: (error: Value & { kind: 'error' }) => boolean,
): Value {
  const valueGrid = valueToGrid(value)
  if (valueGrid.error) return valueGrid.error
  const rows = valueGrid.grid.rows
  const cols = valueGrid.grid.cols
  let needsFallback = false
  for (const row of valueGrid.grid.cells) {
    for (const cell of row) {
      if (cell.kind === 'error' && catches(cell)) needsFallback = true
    }
  }
  if (!needsFallback) return value

  const fallbackGrid = evaluateBroadcastGrid(fallback, ctx, rows, cols)
  if (fallbackGrid.error) return fallbackGrid.error
  const out = makeMatrix(rows, cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cell = valueGrid.grid.cells[r][c]
      out[r][c] = cell.kind === 'error' && catches(cell)
        ? pickBroadcastCell(fallbackGrid.grid, r, c)
        : cell
    }
  }
  return arrayResult(out, 'IFERROR result')
}

function evaluateArrayChoose(
  indexValue: Value,
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): Value {
  const indexGrid = valueToGrid(indexValue)
  if (indexGrid.error) return indexGrid.error
  const rows = indexGrid.grid.rows
  const cols = indexGrid.grid.cols
  const choices = new Map<number, { readonly grid?: Grid; readonly error?: Value }>()
  const out = makeMatrix(rows, cols)

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const indexCell = indexGrid.grid.cells[r][c]
      if (indexCell.kind === 'error') {
        out[r][c] = indexCell
        continue
      }
      const indexNumber = toNumber(indexCell)
      if (!indexNumber.ok) {
        out[r][c] = indexNumber.error
        continue
      }
      const index = Math.trunc(indexNumber.value)
      if (index < 1 || index > args.length - 1) {
        out[r][c] = ERR('#VALUE!')
        continue
      }

      let choice = choices.get(index)
      if (!choice) {
        const broadcast = evaluateBroadcastGrid(args[index], ctx, rows, cols)
        choice = broadcast.error ? { error: broadcast.error } : { grid: broadcast.grid }
        choices.set(index, choice)
      }
      out[r][c] = choice.error ?? pickBroadcastCell(choice.grid!, r, c)
    }
  }
  return arrayResult(out, 'CHOOSE result')
}

function evaluateArrayIfs(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
  startPair: number,
  firstCond: Value,
): Value {
  const firstGrid = valueToGrid(firstCond)
  if (firstGrid.error) return firstGrid.error
  const rows = firstGrid.grid.rows
  const cols = firstGrid.grid.cols
  const pairCount = Math.floor(args.length / 2)
  const selected = makeSelectionMatrix(rows, cols)
  const selectedPairs = new Set<number>()
  let pending = rows * cols

  for (let i = startPair; i < pairCount && pending > 0; i += 1) {
    const condValue = i === startPair ? firstCond : evaluateFunctionArg(args[i * 2], ctx)
    const condGrid = valueBroadcastGrid(condValue, rows, cols)
    if (condGrid.error) return condGrid.error

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (selected[r][c].kind !== 'pending') continue
        const coerced = toBoolean(pickBroadcastCell(condGrid.grid, r, c))
        if (!coerced.ok) {
          selected[r][c] = { kind: 'error', error: coerced.error }
          pending -= 1
        } else if (coerced.value) {
          selected[r][c] = { kind: 'value', index: i }
          selectedPairs.add(i)
          pending -= 1
        }
      }
    }
  }

  return materializeSelections(selected, selectedPairs, (index) => args[index * 2 + 1], ctx)
}

function evaluateArraySwitch(exprValue: Value, args: ReadonlyArray<Expr>, ctx: EvalContext): Value {
  const exprGrid = valueToGrid(exprValue)
  if (exprGrid.error) return exprGrid.error
  const rows = exprGrid.grid.rows
  const cols = exprGrid.grid.cols
  const rest = args.length - 1
  const pairCount = Math.floor(rest / 2)
  const hasDefault = rest % 2 === 1
  const selected = makeSelectionMatrix(rows, cols)
  const selectedPairs = new Set<number>()
  let pending = rows * cols

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const exprCell = exprGrid.grid.cells[r][c]
      if (exprCell.kind === 'error') {
        selected[r][c] = { kind: 'error', error: exprCell }
        pending -= 1
      }
    }
  }

  for (let i = 0; i < pairCount && pending > 0; i += 1) {
    const caseValue = evaluateFunctionArg(args[1 + i * 2], ctx)
    const caseGrid = valueBroadcastGrid(caseValue, rows, cols)
    if (caseGrid.error) return caseGrid.error

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (selected[r][c].kind !== 'pending') continue
        const caseCell = pickBroadcastCell(caseGrid.grid, r, c)
        if (caseCell.kind === 'error') {
          selected[r][c] = { kind: 'error', error: caseCell }
          pending -= 1
        } else if (excelEquals(exprGrid.grid.cells[r][c], caseCell)) {
          selected[r][c] = { kind: 'value', index: i }
          selectedPairs.add(i)
          pending -= 1
        }
      }
    }
  }

  if (pending > 0) {
    const defaultIndex = hasDefault ? pairCount : -1
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (selected[r][c].kind !== 'pending') continue
        if (hasDefault) {
          selected[r][c] = { kind: 'value', index: defaultIndex }
          selectedPairs.add(defaultIndex)
        } else {
          selected[r][c] = { kind: 'error', error: ERR('#N/A') }
        }
      }
    }
  }

  return materializeSelections(
    selected,
    selectedPairs,
    (index) => (index === pairCount ? args[args.length - 1] : args[1 + index * 2 + 1]),
    ctx,
  )
}

type ArraySelection =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly index: number }
  | { readonly kind: 'error'; readonly error: Value }

function makeSelectionMatrix(rows: number, cols: number): ArraySelection[][] {
  const selected: ArraySelection[][] = new Array(rows)
  for (let r = 0; r < rows; r += 1) {
    selected[r] = new Array(cols)
    for (let c = 0; c < cols; c += 1) selected[r][c] = { kind: 'pending' }
  }
  return selected
}

function materializeSelections(
  selected: ReadonlyArray<ReadonlyArray<ArraySelection>>,
  selectedPairs: ReadonlySet<number>,
  exprForIndex: (index: number) => Expr,
  ctx: EvalContext,
): Value {
  const rows = selected.length
  const cols = selected[0]?.length ?? 0
  const grids = new Map<number, { readonly grid?: Grid; readonly error?: Value }>()

  for (const index of selectedPairs) {
    const broadcast = evaluateBroadcastGrid(exprForIndex(index), ctx, rows, cols)
    grids.set(index, broadcast.error ? { error: broadcast.error } : { grid: broadcast.grid })
  }

  const out = makeMatrix(rows, cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const choice = selected[r][c]
      if (choice.kind === 'error') {
        out[r][c] = choice.error
      } else if (choice.kind === 'value') {
        const grid = grids.get(choice.index)!
        out[r][c] = grid.error ?? pickBroadcastCell(grid.grid!, r, c)
      } else {
        out[r][c] = ERR('#N/A')
      }
    }
  }
  return arrayResult(out, 'selector result')
}

function evaluateBroadcastGrid(
  expr: Expr,
  ctx: EvalContext,
  rows: number,
  cols: number,
): { readonly grid: Grid; readonly error?: undefined } | { readonly error: Value } {
  return valueBroadcastGrid(evaluateFunctionArg(expr, ctx), rows, cols)
}

function valueBroadcastGrid(
  value: Value,
  rows: number,
  cols: number,
): { readonly grid: Grid; readonly error?: undefined } | { readonly error: Value } {
  const grid = valueToGrid(value)
  if (grid.error) return { error: grid.error }
  if (
    broadcastExtent(grid.grid.rows, rows) !== rows ||
    broadcastExtent(grid.grid.cols, cols) !== cols
  ) {
    return { error: ERR('#VALUE!') }
  }
  return { grid: grid.grid }
}

type FilterRowsResult =
  | { readonly ok: true; readonly rows: Value[][] }
  | { readonly ok: false; readonly error: Value }

function selectFilterRows(arrayExpr: Expr, includeExpr: Expr, ctx: EvalContext): FilterRowsResult {
  const arrayGrid = evaluateGrid(arrayExpr, ctx)
  if (arrayGrid.error) return { ok: false, error: arrayGrid.error }
  const includeGrid = evaluateGrid(includeExpr, ctx)
  if (includeGrid.error) return { ok: false, error: includeGrid.error }

  const rows = arrayGrid.grid.rows
  const cols = arrayGrid.grid.cols
  const maskRows = includeGrid.grid.rows
  const maskCols = includeGrid.grid.cols
  const outRows: Value[][] = []

  if (maskRows === rows && maskCols === 1) {
    for (let r = 0; r < rows; r += 1) {
      const coerced = toBoolean(includeGrid.grid.cells[r][0])
      if (!coerced.ok) return { ok: false, error: coerced.error }
      if (coerced.value) outRows.push(arrayGrid.grid.cells[r].slice())
    }
    return { ok: true, rows: outRows }
  }

  if (maskCols === cols && maskRows === 1) {
    const keptCols: number[] = []
    for (let c = 0; c < cols; c += 1) {
      const coerced = toBoolean(includeGrid.grid.cells[0][c])
      if (!coerced.ok) return { ok: false, error: coerced.error }
      if (coerced.value) keptCols.push(c)
    }
    return {
      ok: true,
      rows: arrayGrid.grid.cells.map((row) => keptCols.map((c) => row[c])),
    }
  }

  return { ok: false, error: ERR('#VALUE!', 'FILTER mask shape mismatch') }
}

function requireLambda(
  expr: Expr,
  ctx: EvalContext,
  arity: number,
): { readonly lambda: LambdaBinding; readonly error?: undefined } | { readonly error: Value } {
  const resolved = resolveLambdaExpr(expr, ctx)
  if (resolved.error) return { error: resolved.error }
  if (!resolved.lambda) return { error: ERR('#VALUE!', 'expected LAMBDA') }
  if (resolved.lambda.params.length !== arity) {
    return { error: ERR('#VALUE!', `LAMBDA expects ${arity} parameters`) }
  }
  return { lambda: resolved.lambda }
}

function resolveLambdaExpr(expr: Expr, ctx: EvalContext): LambdaResolveResult {
  if (expr.kind === 'call' && expr.name.toUpperCase() === 'LAMBDA') {
    return makeLambdaBinding(expr.args, ctx)
  }
  if (expr.kind === 'lambdaCall') {
    return resolveLambdaCallResult(expr.callee, expr.args, ctx)
  }
  if (expr.kind === 'name') {
    const scoped = ctx.lambdaFunctionScope?.get(canonicalName(expr.name))
    if (scoped) return { lambda: scoped }
    const binding = ctx.resolveName(expr.name)
    if (binding?.kind === 'lambda') return { lambda: binding }
    return {}
  }
  if (expr.kind === 'call') {
    return resolveLambdaReturningCall(expr, ctx)
  }
  return {}
}

function resolveLambdaCallResult(
  callee: Expr,
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  const resolved = resolveLambdaExpr(callee, ctx)
  if (resolved.error) return resolved
  if (!resolved.lambda) {
    const value = evaluate(callee, ctx)
    return value.kind === 'error' ? { error: value } : {}
  }

  return resolveAppliedLambdaResult(resolved.lambda, args, ctx)
}

function resolveLambdaReturningCall(call: CallExpr, ctx: EvalContext): LambdaResolveResult {
  const upper = call.name.toUpperCase()
  switch (upper) {
    case 'IF':
      return resolveIfResultAsLambda(call.args, ctx)
    case 'IFERROR':
      return resolveIfErrorResultAsLambda(call.args, ctx)
    case 'IFNA':
      return resolveIfNaResultAsLambda(call.args, ctx)
    case 'IFS':
      return resolveIfsResultAsLambda(call.args, ctx)
    case 'SWITCH':
      return resolveSwitchResultAsLambda(call.args, ctx)
    case 'CHOOSE':
      return resolveChooseResultAsLambda(call.args, ctx)
    case 'FILTER':
      return resolveFilterResultAsLambda(call.args, ctx)
    case 'XLOOKUP':
      return resolveXLookupResultAsLambda(call.args, ctx)
    case 'LET':
      return resolveLetResultAsLambda(call.args, ctx)
  }

  const scoped = ctx.lambdaFunctionScope?.get(canonicalName(call.name))
  if (scoped) return resolveAppliedLambdaResult(scoped, call.args, ctx)
  const binding = ctx.resolveName(call.name)
  if (binding?.kind === 'lambda') return resolveAppliedLambdaResult(binding, call.args, ctx)
  return {}
}

function resolveIfResultAsLambda(args: ReadonlyArray<Expr>, ctx: EvalContext): LambdaResolveResult {
  if (args.length < 2 || args.length > 3) {
    return { error: ERR('#VALUE!', 'IF expects 2 or 3 arguments') }
  }
  const cond = evaluate(args[0], ctx)
  if (cond.kind === 'error') return { error: cond }
  const coerced = toBoolean(cond)
  if (!coerced.ok) return { error: coerced.error }
  if (coerced.value) return resolveLambdaOrValueError(args[1], ctx)
  return args.length === 3 ? resolveLambdaOrValueError(args[2], ctx) : {}
}

function resolveIfErrorResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length !== 2) return { error: ERR('#VALUE!') }
  const valueLambda = resolveLambdaExpr(args[0], ctx)
  if (valueLambda.lambda) return valueLambda
  if (valueLambda.error) return resolveLambdaOrValueError(args[1], ctx)
  const value = evaluateFunctionArg(args[0], ctx)
  return value.kind === 'error' ? resolveLambdaOrValueError(args[1], ctx) : {}
}

function resolveIfNaResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length !== 2) return { error: ERR('#VALUE!') }
  const valueLambda = resolveLambdaExpr(args[0], ctx)
  if (valueLambda.lambda) return valueLambda
  if (valueLambda.error) {
    return valueLambda.error.kind === 'error' && valueLambda.error.code === '#N/A'
      ? resolveLambdaOrValueError(args[1], ctx)
      : valueLambda
  }
  const value = evaluateFunctionArg(args[0], ctx)
  return value.kind === 'error' && value.code === '#N/A'
    ? resolveLambdaOrValueError(args[1], ctx)
    : {}
}

function resolveIfsResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length === 0) return { error: ERR('#VALUE!') }
  const pairCount = Math.floor(args.length / 2)
  for (let i = 0; i < pairCount; i += 1) {
    const cond = evaluateFunctionArg(args[i * 2], ctx)
    if (cond.kind === 'error') return { error: cond }
    const coerced = toBoolean(cond)
    if (!coerced.ok) return { error: coerced.error }
    if (coerced.value) return resolveLambdaOrValueError(args[i * 2 + 1], ctx)
  }
  return { error: ERR('#N/A') }
}

function resolveSwitchResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length < 3) return { error: ERR('#VALUE!') }
  const expr = evaluateFunctionArg(args[0], ctx)
  if (expr.kind === 'error') return { error: expr }
  const rest = args.length - 1
  const pairCount = Math.floor(rest / 2)
  const hasDefault = rest % 2 === 1
  for (let i = 0; i < pairCount; i += 1) {
    const caseValue = evaluateFunctionArg(args[1 + i * 2], ctx)
    if (caseValue.kind === 'error') return { error: caseValue }
    if (excelEquals(expr, caseValue)) return resolveLambdaOrValueError(args[1 + i * 2 + 1], ctx)
  }
  return hasDefault ? resolveLambdaOrValueError(args[args.length - 1], ctx) : { error: ERR('#N/A') }
}

function resolveChooseResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  const selected = chooseSelectedExpr(args, ctx)
  if (!selected.ok) return { error: selected.error }
  return resolveLambdaOrValueError(selected.expr, ctx)
}

function chooseSelectedExpr(args: ReadonlyArray<Expr>, ctx: EvalContext): SelectedExprResult {
  if (args.length < 2) return { ok: false, error: ERR('#VALUE!') }
  const indexValue = evaluate(args[0], ctx)
  if (indexValue.kind === 'error') return { ok: false, error: indexValue }
  const indexNumber = toNumber(indexValue)
  if (!indexNumber.ok) return { ok: false, error: indexNumber.error }
  const index = Math.trunc(indexNumber.value)
  if (index < 1 || index > args.length - 1) return { ok: false, error: ERR('#VALUE!') }
  return { ok: true, expr: args[index] }
}

function resolveFilterResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length < 2 || args.length > 3) {
    return { error: ERR('#VALUE!', 'FILTER needs 2-3 args') }
  }
  const filtered = selectFilterRows(args[0], args[1], ctx)
  if (!filtered.ok) return { error: filtered.error }
  if (filtered.rows.length === 0 || filtered.rows[0]?.length === 0) {
    return args.length === 3
      ? resolveLambdaOrValueError(args[2], ctx)
      : { error: ERR('#CALC!', 'FILTER returned empty result') }
  }
  return {}
}

function resolveXLookupResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  const result = evaluateXLookupMatch(args, ctx)
  switch (result.kind) {
    case 'value':
      return {}
    case 'error':
      return { error: result.error }
    case 'notFound':
      return args.length >= 4 ? resolveLambdaOrValueError(args[3], ctx) : { error: ERR('#N/A') }
  }
}

function resolveLetResultAsLambda(
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  if (args.length < 3 || args.length % 2 === 0) {
    return { error: ERR('#VALUE!', 'LET expects name/value pairs plus a result expression') }
  }

  const valueScope = new Map<string, Value>(ctx.lambdaScope ?? [])
  const refScope = new Map<string, RuntimeRef>(ctx.lambdaRefScope ?? [])
  const functionScope = new Map<string, LambdaBinding>(ctx.lambdaFunctionScope ?? [])
  const omitted = ctx.lambdaOmittedParams
    ? new Set<string>(ctx.lambdaOmittedParams)
    : undefined
  const subCtx: EvalContext = {
    ...ctx,
    lambdaScope: valueScope,
    lambdaRefScope: refScope,
    lambdaFunctionScope: functionScope,
    lambdaOmittedParams: omitted,
  }

  for (let i = 0; i < args.length - 1; i += 2) {
    const nameExpr = args[i]
    if (nameExpr.kind !== 'name') {
      return { error: ERR('#NAME?', 'LET binding name must be an identifier') }
    }
    const name = canonicalName(nameExpr.name)
    const lambda = resolveLambdaExpr(args[i + 1], subCtx)
    if (lambda.error) return lambda
    if (lambda.lambda) {
      const recursive = bindLambdaSelf(name, lambda.lambda)
      functionScope.set(name, recursive)
      valueScope.delete(name)
      refScope.delete(name)
      omitted?.delete(name)
      continue
    }

    const ref = runtimeRefFromExpr(args[i + 1], subCtx)
    if (ref.ok) {
      const sheetError = validateRuntimeRefSheet(ref.ref, subCtx)
      if (sheetError) return { error: sheetError }
      refScope.set(name, ref.ref)
      valueScope.delete(name)
      functionScope.delete(name)
      omitted?.delete(name)
      continue
    }
    if (ref.error) return { error: ref.error }

    const value = evaluateFunctionArg(args[i + 1], subCtx)
    if (value.kind === 'error') return { error: value }
    valueScope.set(name, value)
    refScope.delete(name)
    functionScope.delete(name)
    omitted?.delete(name)
  }

  return resolveLambdaOrValueError(args[args.length - 1], subCtx)
}

function resolveAppliedLambdaResult(
  lambda: LambdaBinding,
  args: ReadonlyArray<Expr>,
  ctx: EvalContext,
): LambdaResolveResult {
  const argValues: LambdaArgument[] = args.map((arg) => evaluateLambdaArg(arg, ctx))
  const prepared = prepareLambdaContext(lambda, argValues, ctx)
  if (!prepared.ok) return { error: prepared.error }
  prepared.depth.count += 1
  try {
    return resolveLambdaOrValueError(lambda.body, prepared.subCtx)
  } finally {
    prepared.depth.count -= 1
  }
}

function resolveLambdaOrValueError(expr: Expr, ctx: EvalContext): LambdaResolveResult {
  const resolved = resolveLambdaExpr(expr, ctx)
  if (resolved.error || resolved.lambda) return resolved
  const value = evaluate(expr, ctx)
  return value.kind === 'error' ? { error: value } : {}
}

function makeLambdaBinding(args: ReadonlyArray<Expr>, ctx: EvalContext): LambdaResolveResult {
  if (args.length === 0) {
    return { error: ERR('#VALUE!', 'LAMBDA expects a body expression') }
  }
  const params: string[] = []
  for (const arg of args.slice(0, -1)) {
    if (arg.kind !== 'name') {
      return { error: ERR('#NAME?', 'LAMBDA parameter must be an identifier') }
    }
    params.push(canonicalName(arg.name))
  }
  return {
    lambda: {
      params,
      body: args[args.length - 1],
      closureScope: new Map(ctx.lambdaScope ?? []),
      closureRefScope: new Map(ctx.lambdaRefScope ?? []),
      closureFunctionScope: new Map(ctx.lambdaFunctionScope ?? []),
      closureOmittedParams: new Set(ctx.lambdaOmittedParams ?? []),
    },
  }
}

function bindLambdaSelf(name: string, lambda: LambdaBinding): LambdaBinding {
  const functionScope = new Map<string, LambdaBinding>(lambda.closureFunctionScope ?? [])
  const recursive: LambdaBinding = {
    ...lambda,
    closureFunctionScope: functionScope,
  }
  functionScope.set(canonicalName(name), recursive)
  return recursive
}

function applyLambda(
  lambda: LambdaBinding,
  args: ReadonlyArray<LambdaArgument>,
  ctx: EvalContext,
): Value {
  const prepared = prepareLambdaContext(lambda, args, ctx)
  if (!prepared.ok) return prepared.error
  prepared.depth.count += 1
  try {
    return evaluate(lambda.body, prepared.subCtx)
  } finally {
    prepared.depth.count -= 1
  }
}

function applyLambdaForArrayCell(
  lambda: LambdaBinding,
  args: ReadonlyArray<LambdaArgument>,
  ctx: EvalContext,
): { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Value } {
  const prepared = prepareLambdaContext(lambda, args, ctx)
  if (!prepared.ok) return { ok: false, error: prepared.error }
  prepared.depth.count += 1
  try {
    const value = evaluate(lambda.body, prepared.subCtx)
    if (value.kind === 'array') {
      return { ok: false, error: ERR('#CALC!', 'array result was not expanded') }
    }
    return { ok: true, value }
  } finally {
    prepared.depth.count -= 1
  }
}

function prepareLambdaContext(
  lambda: LambdaBinding,
  args: ReadonlyArray<LambdaArgument>,
  ctx: EvalContext,
): LambdaContextResult {
  const depth = ctx.lambdaCallDepth ?? { count: 0 }
  if (args.length > lambda.params.length) {
    return { ok: false, error: ERR('#VALUE!') }
  }
  if (depth.count >= MAX_LAMBDA_CALL_DEPTH) {
    return {
      ok: false,
      error: ERR(
        '#NUM!',
        `LAMBDA recursion depth exceeded (${MAX_LAMBDA_CALL_DEPTH}); aborting to avoid stack overflow`,
      ),
    }
  }
  const scope = new Map<string, Value>(lambda.closureScope ?? [])
  const refScope = new Map<string, RuntimeRef>(lambda.closureRefScope ?? [])
  const functionScope = new Map<string, LambdaBinding>(
    lambda.closureFunctionScope ?? [],
  )
  const omitted = new Set<string>(lambda.closureOmittedParams ?? [])
  for (let i = 0; i < lambda.params.length; i += 1) {
    const name = canonicalName(lambda.params[i])
    const hasArg = i < args.length
    const arg = hasArg ? args[i] : undefined
    if (isLambdaArgument(arg)) {
      functionScope.set(name, arg.lambda)
      scope.delete(name)
      refScope.delete(name)
    } else if (isReferenceArgument(arg)) {
      refScope.set(name, arg.ref)
      scope.delete(name)
      functionScope.delete(name)
    } else {
      scope.set(name, arg ?? BLANK)
      refScope.delete(name)
      functionScope.delete(name)
    }
    if (hasArg) {
      omitted.delete(name)
    } else {
      omitted.add(name)
    }
  }
  const subCtx: EvalContext = {
    ...ctx,
    lambdaScope: scope,
    lambdaRefScope: refScope,
    lambdaFunctionScope: functionScope,
    lambdaOmittedParams: omitted,
    lambdaCallDepth: depth,
  }
  return { ok: true, subCtx, depth }
}

function evaluateGrid(
  expr: Expr,
  ctx: EvalContext,
): { readonly grid: Grid; readonly error?: undefined } | { readonly error: Value } {
  const value = evaluate(expr, ctx)
  if (value.kind === 'error') return { error: value }
  return valueToGrid(value)
}

function valueToGrid(
  value: Value,
): { readonly grid: Grid; readonly error?: undefined } | { readonly error: Value } {
  if (value.kind !== 'array') {
    return { grid: { rows: 1, cols: 1, cells: [[value]] } }
  }
  const rows = value.value.length
  const cols = value.value[0]?.length ?? 0
  const shapeError = arrayShapeError(rows, cols, 'array result', 'array result exceeds cell cap')
  if (shapeError) return { error: shapeError }
  for (const row of value.value) {
    if (row.length !== cols) return { error: ERR('#VALUE!', 'array rows must be rectangular') }
  }
  const scalarError = matrixScalarCellError(value.value)
  if (scalarError) return { error: scalarError }
  return { grid: { rows, cols, cells: value.value } }
}

function makeMatrix(rows: number, cols: number): Value[][] {
  const out: Value[][] = new Array(rows)
  for (let r = 0; r < rows; r += 1) {
    out[r] = new Array(cols)
  }
  return out
}

/**
 * Evaluate `inner` (a `ref` or `range` expression) against a *foreign*
 * sheet's cell snapshot. We build a tiny shim EvalContext whose `cells`
 * points at the foreign Map, but keep the rest of `ctx` (cycle set,
 * resolveName, etc.) intact.
 *
 * The shim's `refLookup` re-uses `ctx.currentlyEvaluating` so circular
 * detection still works across sheets. Cross-sheet keys are namespaced
 * with the sheet name so `A1` on Sheet1 doesn't collide with `A1` on
 * Sheet2 in the cycle set.
 */
function evaluateInForeignSheet(
  inner: Expr,
  parent: EvalContext,
  foreignCells: ReadonlyMap<CellKey, Cell>,
  sheetName?: string,
): Value {
  const sheetIndex = sheetName === undefined ? undefined : parent.sheetIndexOf?.(sheetName)
  const shim: EvalContext = {
    cells: foreignCells,
    currentlyEvaluating: parent.currentlyEvaluating,
    refLookup: (a1) => refLookupGeneric(a1, foreignCells, shim),
    rangeLookup: (start, end) => rangeLookupTrampolined(start, end, foreignCells, shim),
    crossSheetCells: parent.crossSheetCells,
    callCustom: parent.callCustom,
    resolveName: parent.resolveName,
    currentSheetName: sheetName,
    currentSheetIndex: sheetIndex,
    sheetCount: parent.sheetCount,
    sheetIndexOf: parent.sheetIndexOf,
    locale: parent.locale,
    onFormulaEvaluated: parent.onFormulaEvaluated,
  }
  if (inner.kind === 'ref') {
    const key = parseRefToKey(inner.a1)
    if (!key) return ERR('#REF!')
    return evaluateCellTrampolined(key, foreignCells, shim)
  }
  return evaluate(inner, shim)
}

function rangeLookupTrampolined(
  start: string,
  end: string,
  cells: ReadonlyMap<CellKey, Cell>,
  ctx: EvalContext,
): Value[][] {
  const range = parseRange(start, end)
  if (!range) return [[ERR('#REF!')]]
  const rowCount = range.rowEnd - range.rowStart + 1
  const colCount = range.colEnd - range.colStart + 1
  const totalCells = rowCount * colCount
  if (totalCells > MATERIALIZED_RANGE_CELL_CAP) {
    return [[ERR('#NUM!', rangeTooLargeMessage(rowCount, colCount, totalCells))]]
  }

  const rows: Value[][] = new Array(rowCount)
  try {
    let rIdx = 0
    let buf: Value[] | null = null
    let lastRow = -1
    for (const coord of iterateRange(range)) {
      if (coord.row !== lastRow) {
        buf = new Array(colCount)
        rows[rIdx] = buf
        rIdx += 1
        lastRow = coord.row
      }
      buf![coord.col - range.colStart] = evaluateCellTrampolined(cellKey(coord), cells, ctx)
    }
  } catch (err) {
    if (err instanceof RangeTooLargeError) {
      return [[ERR('#NUM!', err.message)]]
    }
    throw err
  }
  return rows
}

function rangeTooLargeMessage(rowCount: number, colCount: number, totalCells: number): string {
  return `range too large to materialize (${rowCount}x${colCount} = ${totalCells} cells; cap 100000)`
}

/**
 * Generic ref-lookup shared between the per-sheet ctx (workbook wires it)
 * and the cross-sheet shim. Pulled into evaluator-internal scope so cycle
 * detection lives in exactly one place.
 *
 * Returns `BLANK` when the cell does not exist (Excel behavior — an
 * unwritten cell reads as blank, not as `#REF!`).
 */
export function refLookupGeneric(
  a1: string,
  cells: ReadonlyMap<CellKey, Cell>,
  ctx: EvalContext,
): Value {
  const coord = parseRefToKey(a1)
  if (!coord) return ERR('#REF!')
  return resolveCell(coord, cells, ctx)
}

/**
 * Generic range lookup. Returns a row-major 2-D `Value[][]`. Blank cells
 * stay blank rather than being omitted.
 *
 * For whole-row / whole-col ranges (`A:A`, `1:1`) the range expands to
 * the Excel max bounds via `parseRange` → could be ~1M rows. We guard
 * against materializing those with `RangeTooLargeError` and surface
 * `#NUM!`. Wave E will add a streaming iterator so SUM / AVERAGE can
 * still consume them without allocating the entire 2-D array.
 */
export function rangeLookupGeneric(
  start: string,
  end: string,
  cells: ReadonlyMap<CellKey, Cell>,
  ctx: EvalContext,
): Value[][] {
  const range = parseRange(start, end)
  if (!range) return [[ERR('#REF!')]]
  const rowCount = range.rowEnd - range.rowStart + 1
  const colCount = range.colEnd - range.colStart + 1
  // Bound materialization. `iterateRange` is uncapped (it's a lazy
  // generator), and `expandRange`'s `RangeTooLargeError` doesn't fire
  // when we walk via iterateRange. Materializing `A:XFD` (16M cells)
  // or `A:A` (1M cells) here would hang the worker. We surface `#NUM!`
  // with a hint instead — formulas that need to scan an entire column
  // must use COUNTIF / SUMIF (which iterate the existing cell map, not
  // the abstract range) for now.
  const totalCells = rowCount * colCount
  // Use the same 100k cap as expandRange (refs/ranges.ts EXPAND_MAX_CELLS).
  // Picked to match Go-To-Special's convention across the codebase.
  if (totalCells > 100_000) {
    return [[ERR('#NUM!', `range too large to materialize (${rowCount}x${colCount} = ${totalCells} cells; cap 100000)`)]]
  }
  const rows: Value[][] = new Array(rowCount)
  try {
    let rIdx = 0
    let buf: Value[] | null = null
    let lastRow = -1
    for (const coord of iterateRange(range)) {
      if (coord.row !== lastRow) {
        buf = new Array(colCount)
        rows[rIdx] = buf
        rIdx += 1
        lastRow = coord.row
      }
      buf![coord.col - range.colStart] = resolveCell(cellKey(coord), cells, ctx)
    }
  } catch (err) {
    if (err instanceof RangeTooLargeError) {
      return [[ERR('#NUM!', err.message)]]
    }
    throw err
  }
  return rows
}

/**
 * Tag a cells-Map identity so the cycle set can distinguish
 * `Sheet1!A1` from `Sheet2!A1`. The tag is stable across calls within
 * a single derive (since the same `cells` Map reference flows through),
 * and lives in a WeakMap so unused tags get GC'd with the Map.
 */
const cellsMapTags = new WeakMap<object, string>()
let cellsMapTagCounter = 0
function tagFor(cells: ReadonlyMap<CellKey, Cell>): string {
  const existing = cellsMapTags.get(cells)
  if (existing !== undefined) return existing
  cellsMapTagCounter += 1
  const tag = `m${cellsMapTagCounter}`
  cellsMapTags.set(cells, tag)
  return tag
}

/**
 * Build the composite cycle-set key for `(cells, cellKey)`. Exported so
 * `sheet.ts` can seed the set with the entry-point cell before invoking
 * `evaluate` directly (the entry doesn't flow through `resolveCell` and
 * would otherwise re-enter unguarded).
 */
export function cycleGuardKey(
  cells: ReadonlyMap<CellKey, Cell>,
  key: CellKey,
): CellKey {
  return `${tagFor(cells)}:${key}`
}

/**
 * Resolve a single CellKey within `cells`. Handles:
 *  - cell missing → BLANK
 *  - literal cell (no AST) → stored value
 *  - formula cell (with AST) → recursive `evaluate`, guarded against
 *    cycles via `ctx.currentlyEvaluating`.
 *
 * The cycle-set key is composite — `<mapTag>:<cellKey>` — so the same
 * `0:0` CellKey on different sheets doesn't false-positive.
 *
 * **Recursion note (Chain-eval bug):** prior to the trampoline introduced
 * in `evaluateCellTrampolined`, a 1000-deep dependency chain
 * (`A2=A1+1, A3=A2+1, …`) blew V8's ~1 MB call stack here, because every
 * `ref` lookup walked back through `evaluate → refLookupGeneric →
 * resolveCell → evaluate` on the JS stack. This recursive `resolveCell`
 * is preserved for cycle-detection compatibility and for the
 * cross-sheet shim's foreign-sheet entry path, but the per-cell entry
 * point in `sheet.ts` now goes through `evaluateCellTrampolined`, which
 * processes the same dependency graph using an explicit work stack
 * (Option B in the bug report).
 */
function resolveCell(
  key: CellKey,
  cells: ReadonlyMap<CellKey, Cell>,
  ctx: EvalContext,
): Value {
  const tag = tagFor(cells)
  const guardKey: CellKey = `${tag}:${key}`
  if (ctx.currentlyEvaluating.has(guardKey)) {
    return ERR('#CIRCULAR!')
  }
  const cell = cells.get(key)
  if (!cell) return BLANK
  if (!cell.ast) return cell.value
  ctx.currentlyEvaluating.add(guardKey)
  try {
    // Use a sub-context bound to the same `cells` so nested ref lookups
    // go through the same snapshot (no recursion into the parent shim).
    const sub: EvalContext = {
      cells,
      currentlyEvaluating: ctx.currentlyEvaluating,
      refLookup: (a1) => refLookupGeneric(a1, cells, sub),
      rangeLookup: (start, end) => rangeLookupGeneric(start, end, cells, sub),
      crossSheetCells: ctx.crossSheetCells,
      callCustom: ctx.callCustom,
      resolveName: ctx.resolveName,
      currentCell: cellCoordFromKey(key),
      currentSheetName: ctx.currentSheetName,
      currentSheetIndex: ctx.currentSheetIndex,
      sheetCount: ctx.sheetCount,
      sheetIndexOf: ctx.sheetIndexOf,
      locale: ctx.locale,
      onFormulaEvaluated: ctx.onFormulaEvaluated,
    }
    const value = evaluate(cell.ast, sub)
    // Lazy dep install (KEY_GRANULAR_INVALIDATION): this formula was
    // really evaluated — let the workbook record its reverse edges.
    ctx.onFormulaEvaluated?.(cells, key, cell.ast)
    return value
  } finally {
    ctx.currentlyEvaluating.delete(guardKey)
  }
}

// ----------------------------------------------------------------------------
// Trampolined per-cell evaluation (Chain-eval fix).
//
// Goal: evaluate the formula at `rootKey` against `rootCells` without
// blowing V8's ~1 MB call stack on deep cross-cell dependency chains
// (e.g. `A2=A1+1, A3=A2+1, …, A1000=A999+1`).
//
// Strategy (Option B from the bug report): keep an explicit work stack
// of cells to resolve. When the in-flight evaluation of a cell's AST
// reaches a `ref` / `range` / `crossSheet` whose value is not yet in the
// `cache`, throw a `NeedsDep` sentinel. The trampoline catches it,
// pushes the missing deps onto the work stack, and re-attempts the
// current cell on the next iteration once those deps have been
// resolved. Each cell's AST is evaluated at most `1 + (# of distinct
// refs it depends on)` times in the worst case; for the canonical
// `=A(n-1)+1` chain that's 2 evaluations per cell.
//
// AST traversal inside a single cell still uses the existing recursive
// `evaluate`, but since AST depth is bounded by formula complexity (not
// chain length), it never touches the deep-recursion ceiling. The
// trampoline only flattens the *cross-cell* recursion that was the
// source of the stack overflow.
//
// Cycle detection moves from `currentlyEvaluating` (the set passed
// through nested `evaluate` calls) to the trampoline's `inProgress`
// set, keyed by the same `cycleGuardKey(cells, key)` so cross-sheet
// chains remain disjoint. A cycle is detected when a `refLookup` hits a
// dep whose guard key is already in `inProgress` — that dep is stamped
// `#CIRCULAR!` in the cache and short-circuits future lookups.
//
// Crucially, dep discovery is *lazy* — we throw on the first missing
// dep encountered during AST walk, not by pre-walking the AST to
// collect every reference. This preserves `IF`'s short-circuit
// semantics: a `=IF(TRUE, 0, A1)` cell will never request `A1` because
// the AST walk never reaches the else branch. Pre-walking would
// regress that.
// ----------------------------------------------------------------------------

/**
 * Sentinel thrown by the trampoline's shim `refLookup` / `rangeLookup`
 * to signal "this dep isn't in the cache yet; please resolve it first
 * and retry the current cell." Carries the list of missing deps so a
 * single `rangeLookup` covering N cells can request all of them at
 * once instead of forcing N retries.
 */
class NeedsDep {
  constructor(
    readonly deps: ReadonlyArray<{
      readonly cells: ReadonlyMap<CellKey, Cell>
      readonly key: CellKey
      readonly guardKey: CellKey
    }>,
  ) {}
}

interface TrampolineFrame {
  readonly cells: ReadonlyMap<CellKey, Cell>
  readonly key: CellKey
  readonly guardKey: CellKey
}

/**
 * Build the trampoline's shim `EvalContext`. The shim is a thin wrapper
 * around the host `ctx` (which still owns `callCustom`, `resolveName`,
 * `lambdaScope`, `lambdaRefScope`, `lambdaCallDepth`); only the ref / range / crossSheet
 * lookups are intercepted to consult the cache instead of recursing.
 *
 * `currentlyEvaluating` is still passed through for compatibility with
 * any code path that wants to check it, but it's the trampoline's
 * `inProgress` set that actually drives cycle detection now.
 */
function makeTrampolineCtx(
  cells: ReadonlyMap<CellKey, Cell>,
  currentKey: CellKey,
  hostCtx: EvalContext,
  cache: Map<CellKey, Value>,
  inProgress: Set<CellKey>,
): EvalContext {
  const lookupKey = (
    targetCells: ReadonlyMap<CellKey, Cell>,
    key: CellKey,
  ): Value => {
    const guardKey = cycleGuardKey(targetCells, key)
    const cached = cache.get(guardKey)
    if (cached !== undefined) return cached
    if (inProgress.has(guardKey)) {
      // The dep is still on the work stack — by definition, evaluating
      // it again here would recurse into a cycle. Stamp it #CIRCULAR!
      // so the in-flight cell sees the error this iteration; the dep's
      // own work-stack frame will pick up the same cached value when it
      // pops.
      const circ = ERR('#CIRCULAR!')
      cache.set(guardKey, circ)
      return circ
    }
    throw new NeedsDep([{ cells: targetCells, key, guardKey }])
  }

  const ctx: EvalContext = {
    cells,
    currentlyEvaluating: hostCtx.currentlyEvaluating,
    refLookup: (a1) => {
      const coord = parseRefToKey(a1)
      if (!coord) return ERR('#REF!')
      return lookupKey(cells, coord)
    },
    rangeLookup: (start, end) => {
      const range = parseRange(start, end)
      if (!range) return [[ERR('#REF!')]]
      const rowCount = range.rowEnd - range.rowStart + 1
      const colCount = range.colEnd - range.colStart + 1
      const totalCells = rowCount * colCount
      if (totalCells > 100_000) {
        const msg =
          `range too large to materialize (${rowCount}x${colCount} = ` +
          `${totalCells} cells; cap 100000)`
        return [[ERR('#NUM!', msg)]]
      }
      // Walk the range twice if needed: first collect every missing
      // dep into one NeedsDep batch (so a SUM(A1:A100) on a chained
      // column doesn't fault 100 times — once is enough). Only resort
      // to actual materialization once every cell in the range is
      // resolved.
      const missing: { cells: typeof cells; key: CellKey; guardKey: CellKey }[] = []
      for (const coord of iterateRange(range)) {
        const k = cellKey(coord)
        const gk = cycleGuardKey(cells, k)
        if (cache.has(gk) || inProgress.has(gk)) continue
        // We need this dep. Only push if the cell exists with an AST —
        // literal / missing cells resolve inline below.
        const cell = cells.get(k)
        if (cell && cell.ast) {
          missing.push({ cells, key: k, guardKey: gk })
        }
      }
      if (missing.length > 0) {
        throw new NeedsDep(missing)
      }
      const rows: Value[][] = new Array(rowCount)
      try {
        let rIdx = 0
        let buf: Value[] | null = null
        let lastRow = -1
        for (const coord of iterateRange(range)) {
          if (coord.row !== lastRow) {
            buf = new Array(colCount)
            rows[rIdx] = buf
            rIdx += 1
            lastRow = coord.row
          }
          const k = cellKey(coord)
          // Either the cell is a non-ast literal/missing (resolve
          // inline) or its value is in cache (via the previous pass).
          const cell = cells.get(k)
          if (!cell) {
            buf![coord.col - range.colStart] = BLANK
          } else if (!cell.ast) {
            buf![coord.col - range.colStart] = cell.value
          } else {
            const gk = cycleGuardKey(cells, k)
            const cached = cache.get(gk)
            if (cached !== undefined) {
              buf![coord.col - range.colStart] = cached
            } else if (inProgress.has(gk)) {
              const circ = ERR('#CIRCULAR!')
              cache.set(gk, circ)
              buf![coord.col - range.colStart] = circ
            } else {
              // Shouldn't happen — we just verified above. Defensive
              // fallback: throw NeedsDep so the trampoline pushes it.
              throw new NeedsDep([{ cells, key: k, guardKey: gk }])
            }
          }
        }
      } catch (err) {
        if (err instanceof RangeTooLargeError) {
          return [[ERR('#NUM!', err.message)]]
        }
        throw err
      }
      return rows
    },
    crossSheetCells: hostCtx.crossSheetCells,
    callCustom: hostCtx.callCustom,
    resolveName: hostCtx.resolveName,
    currentCell: cellCoordFromKey(currentKey) ?? hostCtx.currentCell,
    currentSheetName: hostCtx.currentSheetName,
    currentSheetIndex: hostCtx.currentSheetIndex,
    sheetCount: hostCtx.sheetCount,
    sheetIndexOf: hostCtx.sheetIndexOf,
    lambdaScope: hostCtx.lambdaScope,
    lambdaRefScope: hostCtx.lambdaRefScope,
    lambdaFunctionScope: hostCtx.lambdaFunctionScope,
    lambdaOmittedParams: hostCtx.lambdaOmittedParams,
    lambdaCallDepth: hostCtx.lambdaCallDepth,
    locale: hostCtx.locale,
    onFormulaEvaluated: hostCtx.onFormulaEvaluated,
  }
  return ctx
}

/**
 * Public entry: evaluate the cell at `rootKey` inside `rootCells` to a
 * concrete `Value`. The trampoline removes the cross-cell recursion
 * that previously blew V8's stack on deep dependency chains.
 *
 * If `rootKey` does not exist in `rootCells`, returns `BLANK` (Excel
 * convention). If the cell exists but has no AST, returns the stored
 * literal value verbatim — no trampoline machinery is involved in that
 * common case.
 *
 * `hostCtx` provides the host-level pieces the trampoline can't
 * synthesize: `crossSheetCells`, `callCustom`, `resolveName`, and the
 * shared `currentlyEvaluating` set (kept for back-compat, though cycle
 * detection is driven by `inProgress` internally).
 */
export function evaluateCellTrampolined(
  rootKey: CellKey,
  rootCells: ReadonlyMap<CellKey, Cell>,
  hostCtx: EvalContext,
): Value {
  const rootCell = rootCells.get(rootKey)
  if (!rootCell) return BLANK
  if (!rootCell.ast) return rootCell.value

  const cache = new Map<CellKey, Value>()
  // `inProgress` marks cells whose AST is currently mid-walk (started
  // evaluating but waiting on deps before it can finish). A cycle is
  // detected when `refLookup` hits a dep already in `inProgress`.
  //
  // Subtle: cells that have been *pushed* onto the work stack but not
  // yet started must NOT be in `inProgress`. Otherwise, when a single
  // range-lookup batch (`SUM(B1:B100)`) pushes 99 deps at once, every
  // pair within that batch would mark each other as in-progress and
  // false-positive a cycle. Membership in `inProgress` is bound to
  // "AST eval has started but not finished for this guard key."
  //
  // We do NOT maintain a separate `queued` "already pushed" set. An
  // earlier revision tried to skip re-pushing deps already on the
  // stack, but that broke a corner case: when a range batch like
  // `=SUM(B1:B3)` with `B1=B2+1, B2=B3+1, B3=1` pre-pushes [B3, B2, B1]
  // (B1 on top), B1's AST walk faults on B2 — which is queued lower on
  // the stack but hasn't started yet. Short-circuiting the re-push left
  // B1 stuck on top, retrying forever until `maxIter`. The correctness
  // invariant is the cache check at the top of the loop: re-pushing a
  // dep that's already in the stack costs O(1) per duplicate pop (the
  // cache-hit branch immediately drops it), and the duplicate count is
  // bounded by the number of distinct refs in each in-flight cell's
  // AST — not by chain depth.
  const inProgress = new Set<CellKey>()
  const stack: TrampolineFrame[] = []

  const rootGuard = cycleGuardKey(rootCells, rootKey)
  if (hostCtx.currentlyEvaluating.has(rootGuard)) return ERR('#CIRCULAR!')
  hostCtx.currentlyEvaluating.add(rootGuard)

  // Bound on iterations as a defense against accidental infinite
  // re-trying. Worst case the trampoline visits each cell `1 + deps`
  // times; for a 100k chain with single-ref formulas that's 2*100k =
  // 200k. Use a 10× margin (2M iterations) before bailing with a
  // diagnostic error — anything past that signals a logic bug in the
  // sentinel-retry loop, not a legitimate workload.
  const maxIter = 20_000_000
  let iter = 0

  stack.push({ cells: rootCells, key: rootKey, guardKey: rootGuard })

  try {
  while (stack.length > 0) {
    iter += 1
    if (iter > maxIter) {
      return ERR(
        '#NUM!',
        `evaluateCellTrampolined exceeded ${maxIter} work-stack iterations (possible logic bug)`,
      )
    }
    const top = stack[stack.length - 1]
    if (cache.has(top.guardKey)) {
      inProgress.delete(top.guardKey)
      stack.pop()
      // Lazy dep install for frames whose value was cached OUT FROM
      // UNDER them by cycle detection: when `refLookup` / `rangeLookup`
      // hits an in-progress ancestor it stamps that ancestor's cache
      // entry with #CIRCULAR!, so the ancestor's frame lands here and
      // never reaches the post-`evaluate` hook below. Without this, a
      // cycle member's reverse edges are missing and breaking the cycle
      // never re-derives it (codex P1 #2). Repeat pops of duplicate
      // frames are O(1): `installDepsFor` skips when the AST identity
      // and names revision are unchanged.
      if (hostCtx.onFormulaEvaluated) {
        const cachedCell = top.cells.get(top.key)
        if (cachedCell?.ast) hostCtx.onFormulaEvaluated(top.cells, top.key, cachedCell.ast)
      }
      continue
    }
    const cell = top.cells.get(top.key)
    if (!cell) {
      cache.set(top.guardKey, BLANK)
      inProgress.delete(top.guardKey)
      stack.pop()
      continue
    }
    if (!cell.ast) {
      cache.set(top.guardKey, cell.value)
      inProgress.delete(top.guardKey)
      stack.pop()
      continue
    }
    // About to start (or resume) walking this cell's AST — mark
    // inProgress so a back-edge through this guard key surfaces
    // #CIRCULAR! instead of falling into infinite re-trying.
    inProgress.add(top.guardKey)
    const shimCtx = makeTrampolineCtx(top.cells, top.key, hostCtx, cache, inProgress)
    try {
      const result = validateSpillAnchorValue(evaluate(cell.ast, shimCtx), top.cells, top.key)
      cache.set(top.guardKey, result.value)
      inProgress.delete(top.guardKey)
      stack.pop()
      // Lazy dep install (KEY_GRANULAR_INVALIDATION): every formula the
      // trampoline finishes — the root anchor AND transitively-visited
      // dependency cells — reports to the workbook so its reverse edges
      // exist before any of its dependents cache a value derived from it.
      hostCtx.onFormulaEvaluated?.(top.cells, top.key, cell.ast, {
        ranges: result.spillRange ? [{ range: result.spillRange }] : [],
      })
    } catch (err) {
      if (err instanceof NeedsDep) {
        // The cell isn't done — it faulted out partway through AST
        // evaluation when it hit a dep that wasn't in the cache yet.
        // Leave it in `inProgress` (it's a paused ancestor whose work
        // depends on the deps about to be pushed); when one of those
        // deps tries to refer back to us, the refLookup shim will
        // surface #CIRCULAR! against this still-in-progress entry.
        // Push deps in *reverse* iteration order so the first dep in
        // `err.deps` ends up on TOP of the stack (LIFO → processed
        // next). This matters for range batches whose deps form a
        // chain: `SUM(B1:B100)` with `B(k)=B(k-1)+1` lists deps as
        // [B2, B3, …, B100]; to evaluate them bottom-up we want B2
        // popped first, so push B100 first and B2 last.
        //
        // We deliberately do NOT skip deps already on the stack — see
        // the comment near `inProgress` for the corner case (range
        // batch faulting on a queued-but-not-started dep). Duplicates
        // are O(1) at pop time via the cache-hit branch.
        for (let i = err.deps.length - 1; i >= 0; i -= 1) {
          const dep = err.deps[i]
          if (cache.has(dep.guardKey)) continue
          stack.push({ cells: dep.cells, key: dep.key, guardKey: dep.guardKey })
        }
        // Loop continues; the newly-pushed deps will be evaluated
        // first, and `top` will be retried once they cache out.
        continue
      }
      // Any other throw is a real bug — surface it.
      inProgress.delete(top.guardKey)
      throw err
    }
  }

  return cache.get(rootGuard) ?? BLANK
  } finally {
    hostCtx.currentlyEvaluating.delete(rootGuard)
  }
}

function validateSpillAnchorValue(
  value: Value,
  cells: ReadonlyMap<CellKey, Cell>,
  key: CellKey,
): { readonly value: Value; readonly spillRange?: CellRange } {
  if (value.kind !== 'array') return { value }
  const anchor = cellCoordFromKey(key)
  if (!anchor) return { value }
  const rows = value.value.length
  const cols = value.value[0]?.length ?? 0
  const rowEnd = anchor.row + rows - 1
  const colEnd = anchor.col + cols - 1
  if (rowEnd > EXCEL_MAX_ROW || colEnd > EXCEL_MAX_COL) {
    return { value: ERR('#SPILL!', 'spill range exceeds sheet bounds') }
  }

  const spillRange: CellRange = {
    rowStart: anchor.row,
    rowEnd,
    colStart: anchor.col,
    colEnd,
  }
  for (const [candidateKey, candidate] of cells) {
    if (candidateKey === key || !cellBlocksSpill(candidate)) continue
    const coord = cellCoordFromKey(candidateKey)
    if (coord && rangeContainsCoord(spillRange, coord)) {
      return { value: ERR('#SPILL!', 'spill range is not blank'), spillRange }
    }
  }
  return { value, spillRange }
}

function cellBlocksSpill(cell: Cell): boolean {
  return cell.ast !== undefined || cell.input.length > 0 || cell.value.kind !== 'blank'
}

/**
 * Apply a binary operator. Errors propagate (left-first per Excel).
 * Comparisons return `boolean` Value. Concat returns `string`. Numeric
 * ops return `number`.
 */
function applyBinary(op: BinaryOp, left: Value, right: Value): Value {
  if (left.kind === 'array' || right.kind === 'array') {
    return applyBroadcastBinary(op, left, right)
  }
  return applyScalarBinary(op, left, right)
}

function applyBroadcastBinary(op: BinaryOp, left: Value, right: Value): Value {
  const leftGrid = valueToGrid(left)
  if (leftGrid.error) return leftGrid.error
  const rightGrid = valueToGrid(right)
  if (rightGrid.error) return rightGrid.error

  const rows = broadcastExtent(leftGrid.grid.rows, rightGrid.grid.rows)
  const cols = broadcastExtent(leftGrid.grid.cols, rightGrid.grid.cols)
  if (rows === undefined || cols === undefined) return ERR('#VALUE!')
  const shapeError = arrayShapeError(rows, cols, 'array result', 'array result exceeds cell cap')
  if (shapeError) return shapeError

  const out = makeMatrix(rows, cols)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out[r][c] = applyScalarBinary(
        op,
        pickBroadcastCell(leftGrid.grid, r, c),
        pickBroadcastCell(rightGrid.grid, r, c),
      )
    }
  }
  return arrayResult(out, 'array result')
}

function pickBroadcastCell(grid: Grid, row: number, col: number): Value {
  return grid.cells[grid.rows === 1 ? 0 : row][grid.cols === 1 ? 0 : col]
}

function broadcastExtent(left: number, right: number): number | undefined {
  if (left === right) return left
  if (left === 1) return right
  if (right === 1) return left
  return undefined
}

function applyScalarBinary(op: BinaryOp, left: Value, right: Value): Value {
  const propagated = propagateError([left, right])
  if (propagated) return propagated

  if (op === '&') {
    const ls = toStr(left)
    if (!ls.ok) return ls.error
    const rs = toStr(right)
    if (!rs.ok) return rs.error
    return { kind: 'string', value: ls.value + rs.value }
  }

  // Comparison ops support mixed types: numbers compared with numbers,
  // strings with strings (lex order), booleans coerced to 0/1.
  if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    return compareValues(op, left, right)
  }

  // Arithmetic ops — coerce both sides to number.
  const ln = toNumber(left)
  if (!ln.ok) return ln.error
  const rn = toNumber(right)
  if (!rn.ok) return rn.error
  const l = ln.value
  const r = rn.value
  switch (op) {
    case '+':
      return { kind: 'number', value: l + r }
    case '-':
      return { kind: 'number', value: l - r }
    case '*':
      return { kind: 'number', value: l * r }
    case '/':
      if (r === 0) return ERR('#DIV/0!')
      return { kind: 'number', value: l / r }
    case '^': {
      const res = Math.pow(l, r)
      if (!Number.isFinite(res)) return ERR('#NUM!')
      return { kind: 'number', value: res }
    }
  }
}

/**
 * Excel comparison semantics:
 *  - `blank` compares as 0 (numeric) or "" (string) — we model it as
 *    coerce to the *other* side's type.
 *  - cross-type compares: number < string in Excel's collation order.
 *    For Wave B parity we only need the cases that real formulas hit:
 *    same-type compares + blank-vs-anything. Skip the exotic ordering.
 *  - boolean compares to number via coerce, to boolean directly.
 */
function compareValues(op: BinaryOp, l: Value, r: Value): Value {
  let cmp: number
  if (l.kind === 'blank' && r.kind === 'blank') {
    cmp = 0
  } else if (l.kind === 'string' && r.kind === 'string') {
    cmp = l.value < r.value ? -1 : l.value > r.value ? 1 : 0
  } else if (l.kind === 'boolean' && r.kind === 'boolean') {
    cmp = (l.value ? 1 : 0) - (r.value ? 1 : 0)
  } else {
    // Default: coerce both to number.
    const ln = toNumber(l)
    if (!ln.ok) return ln.error
    const rn = toNumber(r)
    if (!rn.ok) return rn.error
    cmp = ln.value < rn.value ? -1 : ln.value > rn.value ? 1 : 0
  }
  let result: boolean
  switch (op) {
    case '=':
      result = cmp === 0
      break
    case '<>':
      result = cmp !== 0
      break
    case '<':
      result = cmp < 0
      break
    case '<=':
      result = cmp <= 0
      break
    case '>':
      result = cmp > 0
      break
    case '>=':
      result = cmp >= 0
      break
    default:
      return ERR('#ERROR!')
  }
  return { kind: 'boolean', value: result }
}

// ----------------------------------------------------------------------------
// A1 helpers — thin shims around refs/a1 + refs/ranges for the evaluator.
//
// Kept named so worker / adapter / future-Wave code can reach a "Value
// engine-side cell coord" without re-importing `refs/`.
// ----------------------------------------------------------------------------

export function parseRefToCoord(a1: string): { row: number; col: number } | null {
  const parsed = parseA1(a1)
  if (!parsed) return null
  return { row: parsed.row, col: parsed.col }
}

function cellCoordFromKey(key: CellKey): CellCoord | undefined {
  const sep = key.indexOf(':')
  if (sep < 0) return undefined
  const row = Number(key.slice(0, sep))
  const col = Number(key.slice(sep + 1))
  if (!Number.isInteger(row) || !Number.isInteger(col)) return undefined
  return { row, col }
}

export function parseRefToKey(a1: string): CellKey | null {
  const parsed = parseA1(a1)
  if (!parsed) return null
  return cellKey(parsed)
}
