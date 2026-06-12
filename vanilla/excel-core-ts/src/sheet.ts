/**
 * Per-sheet reactive state.
 *
 * Storage-primary layout (see `docs/KEY_GRANULAR_INVALIDATION.md`,
 * audit C-1/C-2): each sheet owns
 *
 *  - ONE live `Map<CellKey, Cell>` for its whole lifetime. `sheetAtom`
 *    holds that same map forever — mutators write into it in place
 *    (O(changed cells), no clones), so the Map identity is pure storage,
 *    NOT a change signal.
 *  - a `revisionAtom` (number) the workbook bumps once per mutation
 *    batch — the subscription point for "this sheet changed" consumers
 *    (projection refresh, batch-coalescing tests).
 *  - a per-sheet `formulaCellAtom(key)` factory that lazily builds a
 *    PAIR per accessed cell: a tiny primitive *epoch atom* and the
 *    derived value atom. The derive's only reactive dep is
 *    `get(epochAtom)`; cells are read from the live map via closure.
 *    The workbook dirties a formula by bumping its epoch atom —
 *    vanilla/core's normal flush then re-derives exactly that formula.
 *    Mutation cost is O(true dependents), not O(cached formulas).
 *
 * Cycle detection lives in `evaluate` (`currentlyEvaluating` set seeded
 * fresh on every derive run). It is NOT a vanilla/core concern.
 *
 * Format storage: per ARCH §2.2 we co-locate `format?: CellFormat` on the
 * same `Cell` record, not in a parallel atom. A format-only write swaps
 * the cell record but preserves `value` / `formula` / `ast` (same AST
 * object identity — the workbook uses that to skip dep teardown).
 */

import { atom, type AtomEntity } from '@einfach/core'

import type { Cell, CellKey, EvalContext, Expr, NameBinding, Value } from './types'
import { BLANK } from './types'
import {
  evaluateCellTrampolined,
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
 * read *other* sheets' cell maps when a formula crosses sheets (the
 * cross-sheet dependency edges live in the workbook's DepGraph, not in
 * vanilla/core).
 */
export interface WorkbookSheet {
  readonly id: string
  readonly name: string
  /**
   * Holds the sheet's live cell map. The Map identity is STABLE for the
   * sheet's lifetime (storage-primary, audit C-1) — subscribe to
   * `revisionAtom` for change notification, and never retain the map as
   * an immutable snapshot.
   */
  readonly sheetAtom: AtomEntity<SheetState>
  /**
   * Bumps once per mutation batch that touched this sheet (including
   * registry-driven recalc passes). The per-sheet "something changed"
   * signal that the old clone-per-write Map identity used to carry.
   */
  readonly revisionAtom: AtomEntity<number>
  /**
   * Lazy factory; cached by CellKey. The atom's deriver pulls the live
   * cell map and walks the formula AST against it; its only reactive
   * dep is the cell's epoch atom.
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
   *  - `'clean'` when the cell has been evaluated at least once (cached
   *    derives are re-derived synchronously when a dependency changes,
   *    so an evaluated formula is never stale at rest)
   *  - `'dirty'` when the cell has a formula that has never been
   *    anchor-evaluated (transitive inline evaluation doesn't stamp)
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
  /**
   * Workbook-facing internals (mutation + invalidation plumbing). NOT
   * public API — shapes may change without notice.
   * @internal
   */
  readonly _internal: {
    /** The live cell storage `sheetAtom` wraps. Mutate in place. */
    readonly cells: Map<CellKey, Cell>
    /** Epoch atom for `key`, or undefined when no derive is cached. */
    epochAtomIfCached(key: CellKey): AtomEntity<number> | undefined
    /** Keys with cached derives (for registry-driven full invalidation). */
    cachedFormulaKeys(): IterableIterator<CellKey>
    /**
     * Drop the cached derive + epoch atom + eval stamp for `key`
     * (audit C-6 eviction — called after a formula cell is overwritten
     * by a non-formula). Safe no-op when nothing is cached.
     */
    evict(key: CellKey): void
  }
}

/**
 * Resolver hook a workbook injects when constructing a sheet. The sheet
 * itself doesn't know about peer sheets, the names registry, or custom
 * formulas — those are workbook-level concerns. By keeping the seam
 * narrow we can unit-test a sheet in isolation.
 */
export interface SheetResolvers {
  /**
   * Look up another sheet's cells map. The `get` parameter is retained
   * for signature compatibility; the workbook implementation no longer
   * registers a vanilla/core dep (cross-sheet invalidation flows through
   * the workbook DepGraph instead).
   */
  crossSheetCells(
    sheetName: string,
    get: <T>(atom: AtomEntity<T>) => T,
  ): ReadonlyMap<CellKey, Cell> | undefined
  /** Resolve a custom-formula host call. */
  callCustom(name: string, args: Value[]): Value | undefined
  /** Resolve a named range / defined name. */
  resolveName(name: string): NameBinding | undefined
  /** Resolve a sheet name to its 0-based workbook index. */
  sheetIndexOf?(sheetName: string): number | undefined
  /** Current workbook sheet count. */
  sheetCount?(): number
  /**
   * Current workbook locale (BCP-47 tag). Threaded into every
   * `EvalContext` so locale-sensitive functions (TEXT / DOLLAR / FIXED)
   * pick the right separators / currency symbol. Optional so unit tests
   * that construct a sheet without a workbook still work — consumers
   * default to `'en-US'`.
   */
  locale?(): string
  /**
   * Lazy dep-install hook threaded into every `EvalContext` (see
   * `EvalContext.onFormulaEvaluated`). Optional so direct-sheet unit
   * tests run without a dep graph.
   */
  onFormulaEvaluated?(cells: ReadonlyMap<CellKey, Cell>, key: CellKey, ast: Expr): void
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
  // THE storage. One Map for the sheet's lifetime; sheetAtom wraps it.
  const liveCells = new Map<CellKey, Cell>()
  const sheetAtom: AtomEntity<SheetState> = atom<SheetState>(liveCells)
  sheetAtom.debugLabel = `excel-core.sheet.${id}.cells`

  const revisionAtom: AtomEntity<number> = atom(0)
  revisionAtom.debugLabel = `excel-core.sheet.${id}.revision`

  // Per-key derived atom cache + the paired epoch atoms. Maps (not
  // WeakMaps) — keys are short strings; entries are evicted when the
  // workbook overwrites a formula with a non-formula (audit C-6).
  const formulaAtomCache = new Map<CellKey, AtomEntity<Value>>()
  const epochAtoms = new Map<CellKey, AtomEntity<number>>()

  // Debug-probe side tables. None participate in vanilla/core dependency
  // tracking — they're pure observation, modeled after Rust's
  // `FormulaCache` and `formula_eval_count`.
  //
  //  - `computing`: cells whose derive is currently on the JS stack.
  //  - `lastEvalRevision`: revision at the time the derive last completed.
  //    Presence of a stamp means "anchor-evaluated at least once" — with
  //    key-granular invalidation a cached derive is re-derived
  //    synchronously whenever a true dependency changes, so a stamped
  //    cell is `clean` at rest.
  //  - `evalCount`: cache-miss counter. Each derive run bumps it — this
  //    includes both the first read of a formula AND the synchronous
  //    re-derives the workbook triggers for true dependents on mutation
  //    (see workbook.ts `postWrite`). Tests should treat `evalCount` as
  //    "derive runs performed", not "explicit user reads."
  const computing = new Set<CellKey>()
  const lastEvalRevision = new Map<CellKey, number>()
  let evalCount = 0

  const revisionProvider = debugProviders?.revisionProvider ?? (() => 0)
  const cellsProvider = debugProviders?.cellsProvider

  function formulaCellAtom(key: CellKey): AtomEntity<Value> {
    const cached = formulaAtomCache.get(key)
    if (cached) return cached
    // The epoch atom is the derive's ONLY reactive dep. The workbook
    // bumps it to invalidate this one formula; nothing else in the
    // store graph points at the derive.
    const epochAtom: AtomEntity<number> = atom(0)
    epochAtom.debugLabel = `excel-core.sheet.${id}.formulaCell.${key}.epoch`
    epochAtoms.set(key, epochAtom)
    const a = atom((get) => {
      // ←── the ONLY reactive dep registered by the derive.
      get(epochAtom)
      const cells: SheetState = liveCells
      const cell = cells.get(key)
      if (!cell) return BLANK
      if (!cell.ast) return cell.value
      // Probe accounting: we're entering a real formula evaluation. This
      // is a vanilla/core cache miss by definition (the derive only runs
      // when a tracked dep changed). Bump the counter and mark this cell
      // `computing` so a probe taken mid-eval reads `'computing'`.
      computing.add(key)
      evalCount += 1
      // Fresh cycle set per derive run. Note that with the trampolined
      // entry path (`evaluateCellTrampolined`), cycle detection is
      // driven by the trampoline's internal `inProgress` set; the
      // shared `currentlyEvaluating` Set is preserved here for the
      // benefit of host-supplied `refLookup` / `rangeLookup` callbacks
      // that may still consult it.
      const currentlyEvaluating = new Set<CellKey>()
      const ctx: EvalContext = {
        cells,
        currentlyEvaluating,
        refLookup: (a1) => refLookupGeneric(a1, cells, ctx),
        rangeLookup: (start, end) => rangeLookupGeneric(start, end, cells, ctx),
        crossSheetCells: (sheetName) => resolvers.crossSheetCells(sheetName, get),
        callCustom: resolvers.callCustom,
        resolveName: resolvers.resolveName,
        currentSheetName: name,
        currentSheetIndex: resolvers.sheetIndexOf?.(name),
        sheetCount: resolvers.sheetCount?.(),
        sheetIndexOf: resolvers.sheetIndexOf,
        locale: resolvers.locale?.(),
        onFormulaEvaluated: resolvers.onFormulaEvaluated,
      }
      try {
        // The trampoline removes cross-cell recursion that previously
        // blew V8's ~1 MB call stack on deep dependency chains (the
        // canonical `=A(n-1)+1` reproducer past ~1000 cells). See the
        // long comment block in `eval/evaluate.ts` near
        // `evaluateCellTrampolined` for the design rationale.
        return evaluateCellTrampolined(key, cells, ctx)
      } finally {
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
    // A stamp means the derive completed at least once. Key-granular
    // invalidation re-derives cached formulas synchronously inside the
    // mutator whenever a true dependency changes, so a stamped formula
    // is clean at rest — no revision comparison needed (a NON-dependent
    // keeps its valid cache and stays clean across unrelated writes).
    return lastEvalRevision.has(key) ? 'clean' : 'dirty'
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
    revisionAtom,
    formulaCellAtom,
    _debug: {
      cellState,
      evalCount: () => evalCount,
      formulaCount,
    },
    _internal: {
      cells: liveCells,
      epochAtomIfCached(key) {
        return epochAtoms.get(key)
      },
      cachedFormulaKeys() {
        return formulaAtomCache.keys()
      },
      evict(key) {
        formulaAtomCache.delete(key)
        epochAtoms.delete(key)
        lastEvalRevision.delete(key)
        computing.delete(key)
      },
    },
  }
}

/**
 * Immutably stamp a single cell into a sheet snapshot. Returns a fresh
 * `Map` reference even when the cell already matches.
 *
 * NOTE (KEY_GRANULAR_INVALIDATION): the engine no longer uses this
 * internally — sheet storage is mutated in place and invalidation flows
 * through the workbook dep graph, so `setter(sheetAtom, applyCell(...))`
 * is NOT a supported invalidation path. Kept as a pure utility for
 * external callers that build cell maps of their own.
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
