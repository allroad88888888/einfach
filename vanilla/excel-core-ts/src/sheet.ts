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

export function createSheet(
  id: string,
  name: string,
  resolvers: SheetResolvers,
): WorkbookSheet {
  const sheetAtom: AtomEntity<SheetState> = atom<SheetState>(new Map())
  sheetAtom.debugLabel = `excel-core.sheet.${id}.cells`

  // Per-key derived atom cache. Map (not WeakMap) — keys are short strings.
  const formulaAtomCache = new Map<CellKey, AtomEntity<Value>>()

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
      }
    }) as AtomEntity<Value>
    a.debugLabel = `excel-core.sheet.${id}.formulaCell.${key}`
    formulaAtomCache.set(key, a)
    return a
  }

  return {
    id,
    name,
    sheetAtom,
    formulaCellAtom,
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
