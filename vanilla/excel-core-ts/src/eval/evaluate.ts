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
  Cell,
  CellKey,
  ErrorCode,
  EvalContext,
  Expr,
  Value,
} from '../types'
import { getBuiltinFunction } from './functions'
import { BLANK, MAX_LAMBDA_CALL_DEPTH } from '../types'
import { cellKey, iterateRange, parseA1, parseRange, RangeTooLargeError } from '../refs'
import { propagateError, toBoolean, toNumber, toString as toStr } from './coerce'

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
      // LAMBDA scope wins over workbook-level names — a parameter name
      // shadowing a defined name is the whole point of LAMBDA parameters.
      // See ARCH §9 / types.ts `EvalContext.lambdaScope`.
      if (ctx.lambdaScope) {
        const scoped = ctx.lambdaScope.get(ast.name)
        if (scoped !== undefined) return scoped
      }
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
          inner.push(evaluate(cell, ctx))
        }
        out.push(inner)
      }
      if (out.length === 0 || out[0].length === 0) return ERR('#VALUE!')
      return { kind: 'array', value: out }
    }

    case 'call': {
      // ---------------------------------------------------------------
      // Lazy short-circuit: `IF` must NOT pre-evaluate both branches.
      //
      // Without this, a textbook recursive LAMBDA like
      //   FACT(n) = IF(n<=1, 1, n*FACT(n-1))
      // recurses into the unreachable else-branch on every call and
      // blows the JS stack. Special-casing `IF` here matches the Rust
      // engine (see `rust/excel-core/src/eval.rs` § `"IF"`) which
      // receives raw `&[Expr]` and lazily evaluates the chosen branch.
      //
      // Only `IF` is short-circuited for now. `IFS`, `SWITCH`,
      // `IFERROR`, `IFNA`, `AND`, `OR` are also short-circuit in Excel
      // but no existing fixture currently depends on their laziness;
      // see report notes for the deferred list.
      // ---------------------------------------------------------------
      const upper = ast.name.toUpperCase()
      if (upper === 'IF') {
        if (ast.args.length < 2 || ast.args.length > 3) {
          return ERR('#VALUE!', 'IF expects 2 or 3 arguments')
        }
        const cond = evaluate(ast.args[0], ctx)
        if (cond.kind === 'error') return cond
        const coerced = toBoolean(cond)
        if (!coerced.ok) return coerced.error
        if (coerced.value) return evaluate(ast.args[1], ctx)
        return ast.args.length === 3
          ? evaluate(ast.args[2], ctx)
          : { kind: 'boolean', value: false }
      }

      // Dispatch order: built-in registry → workbook LAMBDA name →
      // host custom formula → #NAME?. Built-ins shadow customs by
      // convention (custom formulas refuse registration with a builtin
      // name on the host side). LAMBDA names sit between built-ins and
      // customs so user-defined names can't override SUM but a custom
      // host callback can't override a LAMBDA definition either.
      const argValues: Value[] = ast.args.map((a) => evaluate(a, ctx))
      const builtin = getBuiltinFunction(ast.name)
      if (builtin) return builtin(argValues, ctx)

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
        const depth = ctx.lambdaCallDepth ?? { count: 0 }
        if (depth.count >= MAX_LAMBDA_CALL_DEPTH) {
          return ERR(
            '#NUM!',
            `LAMBDA recursion depth exceeded (${MAX_LAMBDA_CALL_DEPTH}); aborting to avoid stack overflow`,
          )
        }
        const scope = new Map<string, Value>(ctx.lambdaScope ?? [])
        for (let i = 0; i < binding.params.length; i += 1) {
          const argVal: Value = argValues[i] ?? BLANK
          scope.set(binding.params[i], argVal)
        }
        const subCtx: EvalContext = {
          ...ctx,
          lambdaScope: scope,
          lambdaCallDepth: depth,
        }
        depth.count += 1
        try {
          return evaluate(binding.body, subCtx)
        } finally {
          depth.count -= 1
        }
      }

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
 * `lambdaScope`, `lambdaCallDepth`); only the ref / range / crossSheet
 * lookups are intercepted to consult the cache instead of recursing.
 *
 * `currentlyEvaluating` is still passed through for compatibility with
 * any code path that wants to check it, but it's the trampoline's
 * `inProgress` set that actually drives cycle detection now.
 */
function makeTrampolineCtx(
  cells: ReadonlyMap<CellKey, Cell>,
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
    lambdaScope: hostCtx.lambdaScope,
    lambdaCallDepth: hostCtx.lambdaCallDepth,
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
  stack.push({ cells: rootCells, key: rootKey, guardKey: rootGuard })

  // Bound on iterations as a defense against accidental infinite
  // re-trying. Worst case the trampoline visits each cell `1 + deps`
  // times; for a 100k chain with single-ref formulas that's 2*100k =
  // 200k. Use a 10× margin (2M iterations) before bailing with a
  // diagnostic error — anything past that signals a logic bug in the
  // sentinel-retry loop, not a legitimate workload.
  const maxIter = 20_000_000
  let iter = 0

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
    const shimCtx = makeTrampolineCtx(top.cells, hostCtx, cache, inProgress)
    try {
      const value = evaluate(cell.ast, shimCtx)
      cache.set(top.guardKey, value)
      inProgress.delete(top.guardKey)
      stack.pop()
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
