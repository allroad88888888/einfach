/**
 * Wave B/B2 minimal evaluator.
 *
 * Walks the `Expr` AST and produces a `Value`. Wave C will add the function
 * registry; Wave E will add named ranges, LAMBDA, array spill, and
 * cross-sheet range materialization. For now:
 *
 *  - Literals (number / string / boolean / error) → trivial.
 *  - `ref` → `ctx.refLookup` (which the workbook wires to walk through
 *    `ctx.cells` with cycle detection).
 *  - `range` → `ctx.rangeLookup`; this evaluator returns the materialized
 *    2-D array as `{ kind: 'array', value }`. Useful for `=A1:A3` cells
 *    and (later) for being passed as a function argument.
 *  - `crossSheet` → resolves the other sheet via `ctx.crossSheetCells`,
 *    then does a ref/range lookup against that snapshot.
 *  - `name` → resolves through `ctx.resolveName`; for now only
 *    `kind: 'value'` and `kind: 'range'` are handled, LAMBDA returns
 *    `#NAME?` (Wave E).
 *  - `unary` (`-`, `+`) → arithmetic coercion + sign.
 *  - `binary` → arithmetic / comparison / concat with Excel coercion.
 *  - `percent` (`50%` → `0.5`) → arithmetic coercion + divide by 100.
 *  - `arrayLiteral` → materialize inner exprs into `{ kind: 'array' }`.
 *  - `call` → dispatches via `getBuiltinFunction(name)` first; falls
 *    through to host custom formula; finally to `#NAME?`.
 *
 * Critical invariant: this function never touches the atom store. It only
 * reads from `ctx.cells` (or `ctx.crossSheetCells(...)` for cross-sheet),
 * which were snapshotted by the caller (the formula-cell derive) with a
 * single `get(sheetAtom)`. That's how the "broad dep, fine lookup" model
 * stays honest — every formula derive registers exactly ONE dep on its
 * own sheet's atom (plus one per referenced cross-sheet).
 */

import type {
  BinaryOp,
  CellKey,
  ErrorCode,
  EvalContext,
  Expr,
  Value,
} from '../types'
import { getBuiltinFunction } from './functions'
import { BLANK } from '../types'
import { cellKey, iterateRange, parseA1, parseRange, RangeTooLargeError } from '../refs'
import { propagateError, toNumber, toString as toStr } from './coerce'

const ERR = (code: ErrorCode, message?: string): Value =>
  message === undefined ? { kind: 'error', code } : { kind: 'error', code, message }

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
      return { kind: 'array', value: rows }
    }

    case 'crossSheet': {
      const sheetCells = ctx.crossSheetCells(ast.sheetName)
      if (!sheetCells) return ERR('#REF!')
      return evaluateInForeignSheet(ast.inner, ctx, sheetCells)
    }

    case 'name': {
      const binding = ctx.resolveName(ast.name)
      if (!binding) return ERR('#NAME?')
      switch (binding.kind) {
        case 'value':
          return binding.value
        case 'range': {
          // For now we always resolve range names against the current sheet.
          // Wave E will support cross-sheet named ranges via binding.sheetName.
          const rows = ctx.rangeLookup(binding.start, binding.end)
          if (rows.length === 0 || rows[0].length === 0) return ERR('#REF!')
          return { kind: 'array', value: rows }
        }
        case 'lambda':
          return ERR('#NAME?', 'LAMBDA names are not implemented yet (Wave E)')
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
          inner.push(evaluate(cell, ctx))
        }
        out.push(inner)
      }
      if (out.length === 0 || out[0].length === 0) return ERR('#VALUE!')
      return { kind: 'array', value: out }
    }

    case 'call': {
      // Dispatch order: built-in registry → host custom formula → #NAME?.
      // Built-ins shadow customs by convention (custom formulas refuse
      // registration with a builtin name on the host side).
      const argValues: Value[] = ast.args.map((a) => evaluate(a, ctx))
      const builtin = getBuiltinFunction(ast.name)
      if (builtin) return builtin(argValues, ctx)
      const custom = ctx.callCustom(ast.name, argValues)
      if (custom !== undefined) return custom
      return ERR('#NAME?', `function '${ast.name}' is not registered`)
    }
  }
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
  foreignCells: ReadonlyMap<CellKey, import('../types').Cell>,
): Value {
  const shim: EvalContext = {
    cells: foreignCells,
    currentlyEvaluating: parent.currentlyEvaluating,
    refLookup: (a1) => refLookupGeneric(a1, foreignCells, shim),
    rangeLookup: (start, end) => rangeLookupGeneric(start, end, foreignCells, shim),
    crossSheetCells: parent.crossSheetCells,
    callCustom: parent.callCustom,
    resolveName: parent.resolveName,
  }
  return evaluate(inner, shim)
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
  cells: ReadonlyMap<CellKey, import('../types').Cell>,
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
  cells: ReadonlyMap<CellKey, import('../types').Cell>,
  ctx: EvalContext,
): Value[][] {
  const range = parseRange(start, end)
  if (!range) return [[ERR('#REF!')]]
  const rowCount = range.rowEnd - range.rowStart + 1
  const colCount = range.colEnd - range.colStart + 1
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
function tagFor(cells: ReadonlyMap<CellKey, import('../types').Cell>): string {
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
  cells: ReadonlyMap<CellKey, import('../types').Cell>,
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
 */
function resolveCell(
  key: CellKey,
  cells: ReadonlyMap<CellKey, import('../types').Cell>,
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
    }
    return evaluate(cell.ast, sub)
  } finally {
    ctx.currentlyEvaluating.delete(guardKey)
  }
}

/**
 * Apply a binary operator. Errors propagate (left-first per Excel).
 * Comparisons return `boolean` Value. Concat returns `string`. Numeric
 * ops return `number`.
 *
 * NOTE: array operands collapse to top-left scalar via `toNumber` /
 * `toString`. Wave E will add broadcast semantics.
 */
function applyBinary(op: BinaryOp, left: Value, right: Value): Value {
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

export function parseRefToKey(a1: string): CellKey | null {
  const parsed = parseA1(a1)
  if (!parsed) return null
  return cellKey(parsed)
}
