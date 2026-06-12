/**
 * Workbook root.
 *
 * `createWorkbook` builds a `Workbook` handle that owns:
 *  - a vanilla/core `Store` (created internally — host code can opt-in to a
 *    pre-existing store via `options.store`).
 *  - one `WorkbookSheet` per `initialSheets` entry. Each sheet owns ONE
 *    live cell map for its lifetime (storage-primary, see
 *    `docs/KEY_GRANULAR_INVALIDATION.md`).
 *  - a workbook-level `DepGraph` (`./deps.ts`) — the reverse dependency
 *    index built lazily as formulas evaluate. Mutations write storage in
 *    place, then dirty O(dependents-of-written-keys) via BFS over the
 *    graph and bump exactly those formulas' epoch atoms (audit C-1/C-2).
 *  - a `parseFormula` injectable (defaults to the real parser at
 *    `./parser`). Tests can inject a mock so they don't depend on B1.
 *
 * Mutations route through `postWrite` (the centralized choke point). We
 * never expose raw storage mutation to the outside world — the public API
 * is `setCell`, `clearCell`, `bulkApply`, `setFormat`, name registration,
 * and custom formula registration.
 *
 * Recalc / F9 (PLAN §4.4): `recalc()` bumps EVERY cached formula's epoch
 * atom (explicit full invalidation — registry-driven breadth is the
 * documented contract here, in contrast to the key-granular cell path) →
 * volatile values come out fresh.
 */

import type { Store } from '@einfach/core'
import { createStore } from '@einfach/core'

import { parseFormula as defaultParseFormula } from './parser'
import { createPropagation, type WriteRecord } from './propagation'
import { parseA1 } from './refs'
import {
  createSheet,
  keyFor,
  type SheetResolvers,
  type SheetState,
  type WorkbookSheet,
} from './sheet'
import { ERROR_CODES } from './types'
import type {
  Cell,
  CellFormat,
  CellRange,
  ErrorCode,
  Expr,
  NameBinding,
  Value,
} from './types'

/** Cache-state vocabulary returned by `debugFormulaCacheState`. Mirrors
 * the Rust side's `Sheet::debug_formula_cache_state` return values so the
 * e2e probe suite reads identically against either backend. */
export type FormulaCacheState = 'dirty' | 'computing' | 'clean' | 'none' | 'invalid'

export interface CreateWorkbookOptions {
  /**
   * Inject a parser. Defaults to `parseFormula` from `./parser`.
   * Tests use this to seed pre-parsed ASTs without spinning up the real
   * tokenizer; production code should leave it unset.
   */
  parser?: (input: string) => Expr
  /**
   * Inject a vanilla/core `Store`. Defaults to a fresh `createStore()`.
   * Pass-in is the seam adapters use to share a store with surrounding
   * UI code.
   */
  store?: Store
}

export interface BulkCellInput {
  readonly row: number
  readonly col: number
  readonly input: string
}

const ERROR_CODE_SET = new Set<string>(ERROR_CODES)

export interface Workbook {
  readonly store: Store
  readonly sheets: ReadonlyArray<WorkbookSheet>
  sheet(id: string): WorkbookSheet | undefined
  sheetByName(name: string): WorkbookSheet | undefined
  /** Mutate a single cell. Parses formula input on the fly. */
  setCell(sheetId: string, row: number, col: number, input: string): void
  /**
   * Write a cell with an already-typed `Value`. Used by paste / import
   * paths that arrive with already-classified values (e.g. wire-typed
   * `{ type: 'text', value: '=A1' }` must NOT be re-parsed as a formula,
   * and `{ type: 'text', value: '00123' }` must NOT lose its leading zero).
   *
   * Distinct from `setCell` which always runs the formula parser +
   * numeric inference on the input string.
   */
  setCellValue(sheetId: string, row: number, col: number, value: Value): void
  /**
   * Clear a single cell. `target` controls whether format also clears
   * (mirrors the `ClearCellMutation` envelope in `types.ts`).
   */
  clearCell(
    sheetId: string,
    row: number,
    col: number,
    target?: 'value' | 'format' | 'all',
  ): void
  /**
   * Clear every EXISTING cell intersecting `range` in one pass (audit
   * D-1/C-4 — the sparse bulk-clear primitive). Walks the live cell
   * map's keys, so cost is O(existing cells in range), never O(area):
   * a full-column clear (rowEnd 1_048_575) on a 100-cell sheet touches
   * at most 100 cells. All cleared keys propagate through ONE
   * `postWrite` batch (one revision bump, one dirty BFS) — same batch
   * shape as `bulkApply`.
   *
   * `target` semantics match `clearCell` per cell. Returns the number
   * of existing cells touched (0 on an empty intersection, in which
   * case nothing propagates — clearing blanks is a value no-op).
   *
   * Spill semantics (W1.1 mirror): spill targets are virtual in the TS
   * engine (no map entry), so a range covering only spill-projected
   * cells touches nothing and the anchor keeps spilling; a range
   * covering the anchor deletes it, tearing the whole spill down.
   */
  clearRange(
    sheetId: string,
    range: CellRange,
    target?: 'value' | 'format' | 'all',
  ): number
  /** Apply many cells in one atom write (paste / fill / import). */
  bulkApply(sheetId: string, cells: ReadonlyArray<BulkCellInput>): void
  /** Apply a format patch to a rectangular range. */
  setFormat(sheetId: string, range: CellRange, format: Partial<CellFormat>): void
  /** Manual F9 — bump every sheetAtom to a fresh Map reference. */
  recalc(): void
  /**
   * Get the active workbook locale as a BCP-47 tag (e.g. `'en-US'`).
   * Defaults to `'en-US'` on a freshly created workbook.
   */
  getLocale(): string
  /**
   * Switch the active workbook locale. Triggers a sheet-wide recalc so
   * formulas that depend on locale-sensitive output (TEXT, DOLLAR, FIXED)
   * re-evaluate against the new separators / currency. Respects
   * `withBatch()` — inside a batch, the recalc defers to the outermost
   * exit.
   *
   * Validation: any non-empty string is accepted. We do not validate
   * BCP-47 syntax up front; downstream Intl.* calls fall back to en-US
   * shape on bad input (see `getNumberFormatParts` in `text.ts`).
   */
  setLocale(locale: string): void
  /**
   * Register a named range / value / LAMBDA.
   */
  defineName(name: string, binding: NameBinding): void
  /** Remove a previously defined name. */
  undefineName(name: string): boolean
  /** Register a host custom formula. Synchronous callback only for B2. */
  registerCustomFormula(name: string, fn: (args: Value[]) => Value): void
  unregisterCustomFormula(name: string): boolean
  /**
   * Run `fn` inside a batch window. While the batch is open, calls to
   * `defineName`, `undefineName`, `registerCustomFormula`, and
   * `unregisterCustomFormula` defer their normal post-mutation
   * `recalculateAllSheets()` pass. When the OUTERMOST batch exits
   * normally, a single recalc fires if any participating mutation
   * occurred — collapsing N name/custom-formula registrations into one
   * sheet-wide invalidation pass.
   *
   * Scope: ONLY the four name / custom-formula registration methods
   * plus `setLocale` participate. Cell-level mutations (`setCell`,
   * `setCellValue`, `clearCell`, `bulkApply`, `setFormat`) write through
   * the existing `writeSheetState` path and are unaffected by the batch
   * flag.
   *
   * Nesting: nested `withBatch` calls share the same pending flag; only
   * the outermost exit triggers the deferred recalc.
   *
   * Exceptions: if `fn` throws, the batch ABORTS — the name and
   * custom-formula registries and the locale are rolled back to their
   * state at outermost batch entry, and the pending-recalc flag is
   * cleared without firing (nothing changed, so nothing to invalidate).
   * A throw from a nested batch aborts the whole batch as it unwinds.
   * The exception propagates to the caller.
   */
  withBatch<T>(fn: () => T): T
  /**
   * Probe the cache state of a formula cell WITHOUT triggering an
   * evaluation. Returns one of `'dirty' | 'computing' | 'clean' | 'none'
   * | 'invalid'`. Mirrors Rust `Sheet::debug_formula_cache_state` so the
   * e2e parity suite can compare TS-core and WASM backends identically.
   *
   *  - `'invalid'`: `addrStr` failed A1 parsing
   *  - `'none'`:    no cell at the address, OR cell is literal-only
   *  - `'computing'`: the formula derive is currently on the JS stack
   *  - `'clean'`:   the formula's last eval ran under the current
   *                  workbook revision
   *  - `'dirty'`:   the cell has a formula but its last eval (if any)
   *                  predates the current revision
   *
   * @internal
   */
  debugFormulaCacheState(sheetIdx: number, addrStr: string): FormulaCacheState
  /**
   * Cumulative count of formula evaluations on `sheetIdx`. Bumped once
   * per cache-miss derive run. Resets to zero only on workbook
   * re-creation. Mirrors Rust `Sheet::debug_formula_eval_count`.
   *
   * Cross-sheet semantics: the counter belongs to the sheet that owns
   * the anchor formula (whose `formulaCellAtom` runs), NOT the sheet
   * the formula's deps live on. E.g. `Sheet2!A1=Sheet1!A1` increments
   * Sheet2's counter when read.
   *
   * Returns 0 for an out-of-range sheet index (matches the Rust
   * adapter's safe-fallback behavior).
   *
   * @internal
   */
  debugFormulaEvalCount(sheetIdx: number): number
  /**
   * Count of formula cells (cells with a parsed AST) on `sheetIdx`.
   * Mirrors Rust `Sheet::debug_formula_count` so the worker-side
   * `debugCounters` RPC can report formulaCount accurately on the
   * TS backend.
   *
   * Returns 0 for an out-of-range sheet index.
   *
   * @internal
   */
  debugFormulaCount(sheetIdx: number): number
}

export interface SheetSeed {
  readonly id: string
  readonly name: string
}

export function createWorkbook(
  initialSheets: ReadonlyArray<SheetSeed>,
  options: CreateWorkbookOptions = {},
): Workbook {
  const store = options.store ?? createStore()
  const parser = options.parser ?? defaultParseFormula

  // Names + custom formula tables live on the workbook root. They are
  // looked up from every sheet's resolver hook. Registration changes
  // invalidate formulas through the existing broad sheetAtom recalc path.
  const names = new Map<string, NameBinding>()
  const customFormulas = new Map<string, (args: Value[]) => Value>()
  const canonicalName = (name: string): string => name.toUpperCase()

  // Live-cell-map identity → owning sheet. Map identities are stable for
  // the workbook's lifetime, so this resolves the `onFormulaEvaluated`
  // hook's `cells` argument (which may be a foreign sheet's map) back to
  // a sheet without threading sheet names through the evaluator.
  const sheetsByCellsMap = new Map<ReadonlyMap<string, Cell>, WorkbookSheet>()

  // Active workbook locale. Read by every sheet via `resolvers.locale()`
  // and threaded into each EvalContext. Mutated only via `setLocale`,
  // which routes through the same `requestRecalc` deferral as named-range
  // and custom-formula registration so a host can batch changes.
  let currentLocale = 'en-US'

  // Batch state for `withBatch`. `batchDepth` tracks nested invocations
  // so only the outermost exit triggers the deferred recalc.
  // `pendingRecalc` is sticky across the batch — any participating
  // mutation flips it true; the outermost exit reads + clears it.
  let batchDepth = 0
  let pendingRecalc = false

  // Snapshot of the batch-participating registries, taken when the
  // OUTERMOST batch opens (depth 0→1) and restored if the batch aborts
  // via throw (audit C-5). These are small, bounded registries — names,
  // custom-formula callbacks, and the locale tag — NOT cell maps, so a
  // shallow Map copy is cheap. Cell mutations do not participate in
  // `withBatch` and are never rolled back.
  let batchSnapshot: {
    names: Map<string, NameBinding>
    customFormulas: Map<string, (args: Value[]) => Value>
    locale: string
  } | null = null

  // Build the sheet handles eagerly. The `sheets` array order matches
  // `initialSheets` for deterministic iteration.
  const sheetsList: WorkbookSheet[] = []
  const sheetsById = new Map<string, WorkbookSheet>()
  const sheetsByName = new Map<string, WorkbookSheet>()

  // Dep graph + dirty propagation (KEY_GRANULAR_INVALIDATION, audit
  // C-1/C-2/C-6). Owns the reverse dependency index, the per-formula
  // epoch bumps, and the workbook revision counter.
  const propagation = createPropagation({
    store,
    sheetsList,
    sheetsById,
    sheetsByName,
    resolveName: (lookup) => names.get(canonicalName(lookup)),
  })

  function requestRecalc(): void {
    if (batchDepth > 0) {
      pendingRecalc = true
    } else {
      propagation.recalculateAllSheets()
    }
  }

  const resolvers: SheetResolvers = {
    // Plain storage read — cross-sheet invalidation flows through the
    // workbook DepGraph, not vanilla/core dep registration (the unused
    // `get` parameter is kept on the TYPE for signature compatibility).
    crossSheetCells(sheetName) {
      const target = sheetsByName.get(sheetName)
      if (!target) return undefined
      return target._internal.cells
    },
    onFormulaEvaluated(cells, key, ast) {
      const owner = sheetsByCellsMap.get(cells)
      // Unknown map identity (e.g. an evaluator driven against a
      // detached snapshot in tests) → nothing to index.
      if (!owner) return
      propagation.installDepsFor(owner, key, ast)
    },
    callCustom(name, args) {
      const fn = customFormulas.get(name.toUpperCase())
      if (!fn) return undefined
      return fn(args)
    },
    resolveName(name) {
      return names.get(canonicalName(name))
    },
    sheetIndexOf(sheetName) {
      const idx = sheetsList.findIndex((sheet) => sheet.name === sheetName)
      return idx >= 0 ? idx : undefined
    },
    sheetCount() {
      return sheetsList.length
    },
    locale() {
      return currentLocale
    },
  }

  // Workbook-scope revision read shared across every sheet's debug
  // probe (owned by the propagation module).
  const readRevision = (): number => propagation.revision()

  for (const seed of initialSheets) {
    // Each sheet's debug helpers need a live revision read and a live
    // SheetState read. The revision is workbook-scope; the cells are
    // per-sheet — we close over the sheet handle inside a tiny
    // attach-helper that takes the handle as an argument so the
    // closure body never references a mutable loop-local.
    const sheetRef: { current: WorkbookSheet | null } = { current: null }
    const debugProviders = {
      revisionProvider: readRevision,
      cellsProvider: (): SheetState => {
        const target = sheetRef.current
        if (!target) return new Map<string, Cell>() as SheetState
        return store.getter(target.sheetAtom) as SheetState
      },
    }
    const sheet = createSheet(seed.id, seed.name, resolvers, debugProviders)
    sheetRef.current = sheet
    sheetsList.push(sheet)
    sheetsById.set(seed.id, sheet)
    sheetsByName.set(seed.name, sheet)
    sheetsByCellsMap.set(sheet._internal.cells, sheet)
  }

  function requireSheet(sheetId: string): WorkbookSheet {
    const sheet = sheetsById.get(sheetId)
    if (!sheet) {
      throw new Error(`Workbook: unknown sheet id '${sheetId}'`)
    }
    return sheet
  }


  function setCellInternal(
    sheet: WorkbookSheet,
    row: number,
    col: number,
    input: string,
  ): void {
    const key = keyFor(row, col)
    const cells = sheet._internal.cells
    const prev = cells.get(key)
    cells.set(key, buildCell(parser, input, prev))
    propagation.postWrite(sheet, [{ key, prevAst: prev?.ast, valueChanged: true }])
  }

  return {
    store,
    get sheets() {
      return sheetsList
    },
    sheet(id) {
      return sheetsById.get(id)
    },
    sheetByName(name) {
      return sheetsByName.get(name)
    },
    setCell(sheetId, row, col, input) {
      const sheet = requireSheet(sheetId)
      setCellInternal(sheet, row, col, input)
    },
    setCellValue(sheetId, row, col, value) {
      const sheet = requireSheet(sheetId)
      const key = keyFor(row, col)
      const cells = sheet._internal.cells
      const existing = cells.get(key)
      if (value.kind === 'blank') {
        if (!existing) {
          // Nothing stored and nothing to store — still propagate (a
          // dependent range may aggregate over the blank coordinate).
          propagation.postWrite(sheet, [{ key, prevAst: undefined, valueChanged: true }])
          return
        }
        if (existing.format) {
          cells.set(key, { input: '', value: { kind: 'blank' }, format: existing.format })
        } else {
          cells.delete(key)
        }
        propagation.postWrite(sheet, [{ key, prevAst: existing.ast, valueChanged: true }])
        return
      }
      // Keep `input` as the canonical string repr so things like the
      // formula bar still surface something readable, but the parsed
      // `value` overrides any inference the parser might otherwise do.
      let input: string
      switch (value.kind) {
        case 'number':
          input = String(value.value)
          break
        case 'string':
          input = value.value
          break
        case 'boolean':
          input = value.value ? 'TRUE' : 'FALSE'
          break
        case 'error':
          input = value.code
          break
        case 'array':
          // Array-typed literals don't have a single-cell representation;
          // collapse to top-left for display, keep the array as the value.
          input = ''
          break
      }
      cells.set(key, { input, value, format: existing?.format })
      propagation.postWrite(sheet, [{ key, prevAst: existing?.ast, valueChanged: true }])
    },
    clearCell(sheetId, row, col, target = 'value') {
      const sheet = requireSheet(sheetId)
      const key = keyFor(row, col)
      const cells = sheet._internal.cells
      const existing = cells.get(key)
      if (!existing) {
        propagation.postWrite(sheet, [{ key, prevAst: undefined, valueChanged: true }])
        return
      }
      if (target === 'format') {
        // Drop format only; keep value/formula/ast intact (same AST
        // object → no dep teardown, no formula dirtying).
        if (existing.format) {
          const { format: _format, ...rest } = existing
          void _format
          cells.set(key, { ...rest })
        }
        propagation.postWrite(sheet, [{ key, prevAst: existing.ast, valueChanged: false }])
        return
      }
      if (target === 'all' || !existing.format) {
        cells.delete(key)
      } else {
        // target === 'value' — clear value+formula, keep format.
        cells.set(key, { input: '', value: { kind: 'blank' }, format: existing.format })
      }
      propagation.postWrite(sheet, [{ key, prevAst: existing.ast, valueChanged: true }])
    },
    clearRange(sheetId, range, target = 'value') {
      const sheet = requireSheet(sheetId)
      const records = clearRangeInPlace(sheet._internal.cells, range, target)
      if (records.length === 0) return 0
      // ONE batched propagation: dep teardown + dirty BFS + epoch bumps
      // + eviction + a single revision bump for the whole range.
      propagation.postWrite(sheet, records)
      return records.length
    },
    bulkApply(sheetId, cells) {
      const sheet = requireSheet(sheetId)
      if (cells.length === 0) return
      const live = sheet._internal.cells
      const records: WriteRecord[] = new Array(cells.length)
      for (let i = 0; i < cells.length; i += 1) {
        const entry = cells[i]
        const key = keyFor(entry.row, entry.col)
        const prev = live.get(key)
        live.set(key, buildCell(parser, entry.input, prev))
        records[i] = { key, prevAst: prev?.ast, valueChanged: true }
      }
      // ONE storage pass, ONE propagation pass (the dirty BFS bails out
      // immediately while the dep graph is empty — fresh bulk imports
      // stay O(cells)).
      propagation.postWrite(sheet, records)
    },
    setFormat(sheetId, range, format) {
      const sheet = requireSheet(sheetId)
      const live = sheet._internal.cells
      const records: WriteRecord[] = []
      for (let r = range.rowStart; r <= range.rowEnd; r += 1) {
        for (let c = range.colStart; c <= range.colEnd; c += 1) {
          const key = keyFor(r, c)
          const existing = live.get(key)
          if (existing) {
            // Same AST object — format-only swap, no formula dirtying.
            live.set(key, {
              ...existing,
              format: { ...existing.format, ...format },
            })
          } else {
            // No cell yet — stamp a blank cell with format only.
            live.set(key, {
              input: '',
              value: { kind: 'blank' },
              format: { ...format },
            })
          }
          records.push({ key, prevAst: existing?.ast, valueChanged: false })
        }
      }
      propagation.postWrite(sheet, records)
    },
    recalc() {
      propagation.recalculateAllSheets()
    },
    getLocale() {
      return currentLocale
    },
    setLocale(locale) {
      if (typeof locale !== 'string' || locale.length === 0) {
        throw new Error(
          `Workbook.setLocale: locale must be a non-empty string, got ${String(locale)}`,
        )
      }
      if (currentLocale === locale) return
      currentLocale = locale
      // Locale change is a workbook-level recalc trigger. Route through
      // the same `requestRecalc` path so `withBatch` coalesces it with
      // other registration ops.
      requestRecalc()
    },
    defineName(name, binding) {
      names.set(canonicalName(name), binding)
      requestRecalc()
    },
    undefineName(name) {
      const removed = names.delete(canonicalName(name))
      if (removed) requestRecalc()
      return removed
    },
    registerCustomFormula(name, fn) {
      customFormulas.set(name.toUpperCase(), fn)
      requestRecalc()
    },
    unregisterCustomFormula(name) {
      const removed = customFormulas.delete(name.toUpperCase())
      if (removed) requestRecalc()
      return removed
    },
    withBatch(fn) {
      if (batchDepth === 0) {
        batchSnapshot = {
          names: new Map(names),
          customFormulas: new Map(customFormulas),
          locale: currentLocale,
        }
      }
      batchDepth += 1
      try {
        const result = fn()
        // Successful exit: only the outermost frame drains the pending
        // flag and fires the deferred recalc. Inner frames just decrement.
        if (batchDepth === 1 && pendingRecalc) {
          pendingRecalc = false
          propagation.recalculateAllSheets()
        }
        return result
      } catch (err) {
        // Throw aborts the host's intent — make the abort REAL (audit
        // C-5): the outermost frame restores the registries to their
        // pre-batch snapshot so registry state and cached derives never
        // disagree, then clears pending without firing. A throw from a
        // nested batch unwinds through every frame, so the rollback
        // covers the whole batch. Re-raise unchanged.
        if (batchDepth === 1) {
          const snap = batchSnapshot!
          names.clear()
          for (const [key, binding] of snap.names) names.set(key, binding)
          customFormulas.clear()
          for (const [key, callback] of snap.customFormulas) customFormulas.set(key, callback)
          currentLocale = snap.locale
          pendingRecalc = false
        }
        throw err
      } finally {
        batchDepth -= 1
        if (batchDepth === 0) batchSnapshot = null
      }
    },
    debugFormulaCacheState(sheetIdx, addrStr) {
      if (!Number.isInteger(sheetIdx) || sheetIdx < 0 || sheetIdx >= sheetsList.length) {
        return 'invalid'
      }
      const parsed = parseA1(addrStr)
      if (!parsed) return 'invalid'
      const sheet = sheetsList[sheetIdx]
      return sheet._debug.cellState(keyFor(parsed.row, parsed.col))
    },
    debugFormulaEvalCount(sheetIdx) {
      if (!Number.isInteger(sheetIdx) || sheetIdx < 0 || sheetIdx >= sheetsList.length) {
        return 0
      }
      return sheetsList[sheetIdx]._debug.evalCount()
    },
    debugFormulaCount(sheetIdx) {
      if (!Number.isInteger(sheetIdx) || sheetIdx < 0 || sheetIdx >= sheetsList.length) {
        return 0
      }
      return sheetsList[sheetIdx]._debug.formulaCount()
    },
  }
}

/**
 * Storage pass of `Workbook.clearRange` (audit D-1/C-4): walk the live
 * map (the source of truth), NOT the coordinate rectangle — cost is
 * O(existing cells), never O(area). Mutates `live` in place (deleting /
 * overwriting the entry under iteration is Map-iteration safe) and
 * returns one `WriteRecord` per touched cell for the caller's single
 * `postWrite` batch. Per-cell semantics mirror `clearCell`'s `target`
 * branches exactly.
 */
function clearRangeInPlace(
  live: Map<string, Cell>,
  range: CellRange,
  target: 'value' | 'format' | 'all',
): WriteRecord[] {
  const records: WriteRecord[] = []
  for (const [key, existing] of live) {
    const sep = key.indexOf(':')
    const row = Number(key.slice(0, sep))
    const col = Number(key.slice(sep + 1))
    if (row < range.rowStart || row > range.rowEnd) continue
    if (col < range.colStart || col > range.colEnd) continue
    if (target === 'format') {
      // Drop format only; same AST object → no dep teardown, no
      // formula dirtying (mirrors clearCell's 'format' branch).
      if (existing.format) {
        const { format: _format, ...rest } = existing
        void _format
        live.set(key, { ...rest })
      }
      records.push({ key, prevAst: existing.ast, valueChanged: false })
      continue
    }
    if (target === 'all' || !existing.format) {
      live.delete(key)
    } else {
      // target === 'value' — clear value+formula, keep format.
      live.set(key, { input: '', value: { kind: 'blank' }, format: existing.format })
    }
    records.push({ key, prevAst: existing.ast, valueChanged: true })
  }
  return records
}

/**
 * Build a `Cell` record from raw user input: `''` clears the value but
 * keeps format, a leading `=` parses to an AST (lazily evaluated — the
 * formula-cell atom runs on first sub/read), anything else classifies
 * through `parseLiteral`.
 */
function buildCell(
  parser: (input: string) => Expr,
  input: string,
  existing: Cell | undefined,
): Cell {
  if (input.length === 0) {
    return {
      input: '',
      value: { kind: 'blank' },
      format: existing?.format,
    }
  }
  if (input[0] === '=') {
    const ast = parser(input)
    return {
      input,
      ast,
      value: { kind: 'blank' },
      format: existing?.format,
    }
  }
  return {
    input,
    value: parseLiteral(input),
    format: existing?.format,
  }
}

/**
 * Parse a literal cell input into a `Value`. Excel rules:
 *  - `""` → blank (the empty-string case is handled in `buildCell`).
 *  - `TRUE` / `FALSE` (case-insensitive) → boolean.
 *  - finite number → number.
 *  - error literal (`#REF!`, `#VALUE!`, ...) → error.
 *  - otherwise → string.
 */
function parseLiteral(input: string): Value {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { kind: 'string', value: input }
  const upper = trimmed.toUpperCase()
  if (upper === 'TRUE') return { kind: 'boolean', value: true }
  if (upper === 'FALSE') return { kind: 'boolean', value: false }
  if (ERROR_CODE_SET.has(upper)) return { kind: 'error', code: upper as ErrorCode }
  const num = Number(trimmed)
  if (Number.isFinite(num) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return { kind: 'number', value: num }
  }
  return { kind: 'string', value: input }
}
