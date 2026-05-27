/**
 * Wave B/B2: per-sheet reactive state.
 *
 * Each sheet owns:
 *  - a single `sheetAtom` holding `ReadonlyMap<CellKey, Cell>` (PLAN §4.1,
 *    ARCH §2.3). Every cell mutation produces a new Map identity so
 *    vanilla/core's reference-equality dep cache invalidates correctly.
 *  - a per-sheet `formulaCellAtom(key)` factory that lazily builds derived
 *    atoms for each accessed cell. The derive captures the sheet snapshot
 *    once via `get(sheetAtom)`, then walks refs through that snapshot
 *    via plain `Map.get` — preserving the "one sheetAtom dep per formula
 *    derive" invariant (ARCH §4).
 *
 * Cycle detection lives in `evaluate` (`currentlyEvaluating` set seeded
 * fresh on every derive run). It is NOT a vanilla/core concern.
 *
 * Format storage: per ARCH §2.2 we co-locate `format?: CellFormat` on the
 * same `Cell` record, not in a parallel atom. A format-only write swaps
 * the cell record but preserves `value` / `formula` / `ast`. That keeps
 * the sheetAtom the single source of truth (and avoids a second atom
 * the evaluator would otherwise have to ignore).
 */

import { atom, type AtomEntity } from '@einfach/core'

import type { Cell, CellKey, Value } from './types'
import { BLANK } from './types'
import {
  cycleGuardKey,
  evaluate,
  rangeLookupGeneric,
  refLookupGeneric,
} from './eval/evaluate'

export type SheetState = ReadonlyMap<CellKey, Cell>

export const keyFor = (row: number, col: number): CellKey => `${row}:${col}`

/**
 * A handle a workbook hands out for each sheet. The `formulaCellAtom`
 * function caches per-key derives so repeat `sub` calls hit the same atom.
 *
 * The `crossSheet` callback is wired by the workbook so the derive can
 * register deps on *other* sheet atoms when a formula crosses sheets.
 * Implementation deferred to Wave E for full coverage; B2 wires the seam.
 */
export interface WorkbookSheet {
  readonly id: string
  readonly name: string
  readonly sheetAtom: AtomEntity<SheetState>
  /**
   * Lazy factory; cached by CellKey. The atom's deriver pulls the sheet
   * snapshot once and walks the formula AST against that snapshot.
   */
  formulaCellAtom(key: CellKey): AtomEntity<Value>
  /**
   * Internal debug accessors used by the worker-side probes
   * (`debugFormulaCacheState` / `debugFormulaEvalCount`). Not part of the
   * documented public API and not for production reads — they only exist
   * so the e2e parity probe spec can verify lazy evaluation against the
   * TS backend the same way it does against Rust.
   *
   * `cellState`:
   *  - `'computing'` while the formula derive is on the stack for `key`
   *  - `'none'` when no cell exists at `key`, or the cell has no AST
   *    (literal-only — matches Rust `formula_cells.get` returning `None`)
   *  - `'clean'` when the cell has been evaluated against the current
   *    workbook revision
   *  - `'dirty'` when the cell has a formula but was last evaluated under
   *    an older workbook revision (or has never been evaluated)
   *
   * `formulaCount`: count of cells in the current snapshot whose `ast` is
   * defined (i.e. the cell has a parsed formula). Mirrors Rust's
   * `Sheet::debug_formula_count` (size of `formula_cells`). Returns 0 if
   * the sheet was constructed without a `cellsProvider`.
   *
   * @internal
   */
  readonly _debug: {
    cellState(key: CellKey): 'dirty' | 'computing' | 'clean' | 'none'
    evalCount(): number
    formulaCount(): number
  }
}

/**
 * Resolver hook a workbook injects when constructing a sheet. The sheet
 * itself doesn't know about peer sheets, the names registry, or custom
 * formulas — those are workbook-level concerns. By keeping the seam
 * narrow we can unit-test a sheet in isolation.
 */
export interface SheetResolvers {
  /** Look up another sheet's cells map; also registers a dep via the getter. */
  crossSheetCells(
    sheetName: string,
    get: <T>(atom: AtomEntity<T>) => T,
  ): ReadonlyMap<CellKey, Cell> | undefined
  /** Resolve a custom-formula host call. Wave C/E wires this. */
  callCustom(name: string, args: Value[]): Value | undefined
  /** Resolve a named range / defined name. Wave E wires this. */
  resolveName(name: string): import('./types').NameBinding | undefined
}

/**
 * Optional debug-probe wiring. The workbook injects both providers; tests
 * exercising `createSheet` directly can leave them off, in which case the
 * sheet still works — `_debug.cellState` reports `'none'` for everything
 * (no live cell snapshot) and `_debug.evalCount()` still tracks runs.
 */
export interface SheetDebugProviders {
  /** Current workbook revision (bumped on every mutation). */
  revisionProvider: () => number
  /** Current SheetState (read via the host store, NOT via the atom getter). */
  cellsProvider: () => SheetState
}

export function createSheet(
  id: string,
  name: string,
  resolvers: SheetResolvers,
  debugProviders?: SheetDebugProviders,
): WorkbookSheet {
  const sheetAtom: AtomEntity<SheetState> = atom<SheetState>(new Map())
  sheetAtom.debugLabel = `excel-core.sheet.${id}.cells`

  // Per-key derived atom cache. Map (not WeakMap) — keys are short strings.
  const formulaAtomCache = new Map<CellKey, AtomEntity<Value>>()

  // Debug-probe side tables. None participate in vanilla/core dependency
  // tracking — they're pure observation, modeled after Rust's
  // `FormulaCache` and `formula_eval_count`.
  //
  //  - `computing`: cells whose derive is currently on the JS stack.
  //  - `lastEvalRevision`: revision at the time the derive last completed.
  //    A `clean` cell is one whose entry equals the current revision.
  //  - `evalCount`: cache-miss counter. Each derive run bumps it — this
  //    includes both the first read of a formula AND vanilla/core's
  //    eager `flushPending` re-runs that happen synchronously on dep
  //    mutation (see workbook.ts `writeSheetState` for the order-of-
  //    operations discussion). Tests should treat `evalCount` as
  //    "derive runs performed", not "explicit user reads."
  const computing = new Set<CellKey>()
  const lastEvalRevision = new Map<CellKey, number>()
  let evalCount = 0

  const revisionProvider = debugProviders?.revisionProvider ?? (() => 0)
  const cellsProvider = debugProviders?.cellsProvider

  function formulaCellAtom(key: CellKey): AtomEntity<Value> {
    const cached = formulaAtomCache.get(key)
    if (cached) return cached
    // The derived atom registers exactly ONE dep on `sheetAtom` per run
    // (plus deps registered transitively via `crossSheetCells`).
    const a = atom((get) => {
      // ←── the ONLY get(sheetAtom) call inside the derive.
      const cells = get(sheetAtom)
      const cell = cells.get(key)
      if (!cell) return BLANK
      if (!cell.ast) return cell.value
      // Probe accounting: we're entering a real formula evaluation. This
      // is a vanilla/core cache miss by definition (the derive only runs
      // when a tracked dep changed). Bump the counter and mark this cell
      // `computing` so a probe taken mid-eval reads `'computing'`.
      computing.add(key)
      evalCount += 1
      // Fresh cycle set per derive run. Seed it with the entry-point
      // cell using a cells-tagged composite key so cross-sheet evals
      // don't false-collide on `0:0`.
      const currentlyEvaluating = new Set<CellKey>()
      const seed = cycleGuardKey(cells, key)
      currentlyEvaluating.add(seed)
      const ctx: import('./types').EvalContext = {
        cells,
        currentlyEvaluating,
        refLookup: (a1) => refLookupGeneric(a1, cells, ctx),
        rangeLookup: (start, end) => rangeLookupGeneric(start, end, cells, ctx),
        crossSheetCells: (sheetName) => resolvers.crossSheetCells(sheetName, get),
        callCustom: resolvers.callCustom,
        resolveName: resolvers.resolveName,
      }
      try {
        return evaluate(cell.ast, ctx)
      } finally {
        currentlyEvaluating.delete(seed)
        computing.delete(key)
        // Stamp the revision AFTER the derive completed. A probe that
        // catches the derive mid-stack sees `computing.has(key) === true`
        // and short-circuits to `'computing'` before reading the stamp.
        lastEvalRevision.set(key, revisionProvider())
      }
    }) as AtomEntity<Value>
    a.debugLabel = `excel-core.sheet.${id}.formulaCell.${key}`
    formulaAtomCache.set(key, a)
    return a
  }

  function cellState(key: CellKey): 'dirty' | 'computing' | 'clean' | 'none' {
    // Computing must win — a probe taken while the derive is on the
    // stack should see `'computing'` regardless of the stamp's value.
    if (computing.has(key)) return 'computing'
    if (!cellsProvider) return 'none'
    const cells = cellsProvider()
    const cell = cells.get(key)
    // No cell, or cell is literal-only (no AST): Rust's
    // `formula_cells.get(addr)` returns `None` for literals — we match
    // that with `'none'`. Probes thus distinguish "this cell isn't a
    // formula" from "this formula hasn't been evaluated yet."
    if (!cell || !cell.ast) return 'none'
    const stamped = lastEvalRevision.get(key)
    if (stamped === undefined) return 'dirty'
    return stamped === revisionProvider() ? 'clean' : 'dirty'
  }

  function formulaCount(): number {
    if (!cellsProvider) return 0
    const cells = cellsProvider()
    let n = 0
    for (const c of cells.values()) {
      if (c.ast) n += 1
    }
    return n
  }

  return {
    id,
    name,
    sheetAtom,
    formulaCellAtom,
    _debug: {
      cellState,
      evalCount: () => evalCount,
      formulaCount,
    },
  }
}

/**
 * Immutably stamp a single cell into a sheet snapshot. Returns a fresh
 * `Map` reference even when the cell already matches, so callers can
 * unconditionally `setter(sheetAtom, applyCell(...))` for blunt-force
 * F9-style recalc paths.
 *
 * For a key already present, `updater` receives the existing Cell;
 * returning the same object skips no work — we still produce a new Map
 * to keep reference-equality semantics consistent.
 */
export function applyCell(
  prev: SheetState,
  key: CellKey,
  updater: (existing: Cell | undefined) => Cell | undefined,
): SheetState {
  const next = new Map(prev)
  const updated = updater(prev.get(key))
  if (updated === undefined) {
    next.delete(key)
  } else {
    next.set(key, updated)
  }
  return next
}
