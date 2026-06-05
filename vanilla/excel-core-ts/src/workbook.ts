/**
 * Workbook root.
 *
 * `createWorkbook` builds a `Workbook` handle that owns:
 *  - a vanilla/core `Store` (created internally — host code can opt-in to a
 *    pre-existing store via `options.store`).
 *  - one `WorkbookSheet` per `initialSheets` entry. Each sheet owns a
 *    single `sheetAtom`, per PLAN §4.1.
 *  - a `parseFormula` injectable (defaults to the real parser at
 *    `./parser`). Tests can inject a mock so they don't depend on B1.
 *
 * Mutations always route through the writable `sheetAtom`. We never expose
 * the raw setter to the outside world — the public API is `setCell`,
 * `clearCell`, `bulkApply`, `setFormat`, name registration, and custom
 * formula registration. Each data mutation parses input when needed and
 * produces a new `Map` reference.
 *
 * Recalc / F9 (PLAN §4.4): `recalc()` bumps every sheet's atom to a fresh
 * `Map` clone. Same contents, new identity → vanilla/core marks every
 * formula derive dirty → volatile values come out fresh on next read.
 */

import type { Store } from '@einfach/core'
import { createStore } from '@einfach/core'

import { parseFormula as defaultParseFormula } from './parser'
import { parseA1 } from './refs'
import { applyCell, createSheet, keyFor, type SheetResolvers, type SheetState, type WorkbookSheet } from './sheet'
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
  /** Apply many cells in one atom write (paste / fill / import). */
  bulkApply(sheetId: string, cells: ReadonlyArray<BulkCellInput>): void
  /** Apply a format patch to a rectangular range. */
  setFormat(sheetId: string, range: CellRange, format: Partial<CellFormat>): void
  /** Manual F9 — bump every sheetAtom to a fresh Map reference. */
  recalc(): void
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
   * participate. Cell-level mutations (`setCell`, `setCellValue`,
   * `clearCell`, `bulkApply`, `setFormat`) write through the existing
   * `writeSheetState` path and are unaffected by the batch flag.
   *
   * Nesting: nested `withBatch` calls share the same pending flag; only
   * the outermost exit triggers the deferred recalc.
   *
   * Exceptions: if `fn` throws, the batch depth still unwinds and the
   * pending-recalc flag is cleared without firing a recalc — the throw
   * is treated as the host aborting its intent. The exception
   * propagates to the caller.
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

  // Workbook-scope revision counter. Bumped once per mutation in
  // `writeSheetState` (the centralized choke point). Sheets read it via
  // the `revisionProvider` callback to stamp `lastEvalRevision` on each
  // formula derive run. One global counter (not per-sheet) so a Sheet1
  // mutation also marks Sheet2 formulas dirty — over-conservative but
  // correct, and matches vanilla/core's broad dirty propagation.
  let revisionCounter = 0

  // Batch state for `withBatch`. `batchDepth` tracks nested invocations
  // so only the outermost exit triggers the deferred recalc.
  // `pendingRecalc` is sticky across the batch — any participating
  // mutation flips it true; the outermost exit reads + clears it.
  let batchDepth = 0
  let pendingRecalc = false

  function requestRecalc(): void {
    if (batchDepth > 0) {
      pendingRecalc = true
    } else {
      recalculateAllSheets()
    }
  }

  // Build the sheet handles eagerly. The `sheets` array order matches
  // `initialSheets` for deterministic iteration.
  const sheetsList: WorkbookSheet[] = []
  const sheetsById = new Map<string, WorkbookSheet>()
  const sheetsByName = new Map<string, WorkbookSheet>()

  const resolvers: SheetResolvers = {
    crossSheetCells(sheetName, get) {
      const target = sheetsByName.get(sheetName)
      if (!target) return undefined
      // Registers a dep on the foreign sheet's atom via the captured getter.
      return get(target.sheetAtom)
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
  }

  // Workbook-scope revision read shared across every sheet's debug
  // probe. Wrapped in a function so the loop below doesn't capture
  // `revisionCounter` directly (which would trip
  // `no-loop-func` for `let`-mutated state).
  const readRevision = (): number => revisionCounter

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
  }

  function requireSheet(sheetId: string): WorkbookSheet {
    const sheet = sheetsById.get(sheetId)
    if (!sheet) {
      throw new Error(`Workbook: unknown sheet id '${sheetId}'`)
    }
    return sheet
  }

  function writeSheetState(sheet: WorkbookSheet, next: SheetState): void {
    // Bump the workbook revision BEFORE writing. The order matters
    // because vanilla/core's `setter` synchronously runs `flushPending`,
    // which walks every back-dep and re-evaluates any cached formula
    // derive whose dep value changed (`store.ts` `dependenciesChange`).
    //
    // That auto-flush is the central engine difference between TS-core
    // and Rust-core: Rust is purely lazy — a formula goes dirty on dep
    // change and stays dirty until the next read — while TS eagerly
    // re-derives cached formulas at the moment of mutation. For probe
    // semantics that means:
    //
    //   * "Never-read" formulas stay dirty across writes (their derive
    //     isn't in the cache, so `flushPending` doesn't touch them).
    //   * "Already-read" formulas auto-recover to clean on every
    //     mutation. The probe will report `'clean'` post-mutation, not
    //     `'dirty'`.
    //
    // The bulk-load → snapshot → restore → probe use case (the main
    // consumer of this probe in the WAVE3 plan) only ever observes
    // never-read formulas, so it lines up with Rust's reported state.
    // Tests that catch the engine mid-flight (mutate then probe before
    // re-read) will see TS-core report `'clean'` where Rust reports
    // `'dirty'` — see `excel-core-ts-debug-probes.test.ts` for the
    // pinned behavior.
    revisionCounter += 1
    store.setter(sheet.sheetAtom, next)
  }

  function recalculateAllSheets(): void {
    for (const sheet of sheetsList) {
      const prev = store.getter(sheet.sheetAtom) as SheetState
      // Clone to a fresh Map identity — every derive sees a new dep value
      // and marks dirty.
      writeSheetState(sheet, new Map(prev))
    }
  }

  function buildCell(input: string, existing: Cell | undefined): Cell {
    if (input.length === 0) {
      // Treat empty input as "clear value but keep format" path.
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
        // Initial value before first eval is BLANK; the formula derive
        // computes the real one. We do NOT eagerly evaluate here — the
        // formula-cell atom will run on first sub/read.
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

  function setCellInternal(
    sheet: WorkbookSheet,
    row: number,
    col: number,
    input: string,
  ): void {
    const key = keyFor(row, col)
    const prev = store.getter(sheet.sheetAtom) as SheetState
    const next = applyCell(prev, key, (existing) => buildCell(input, existing))
    writeSheetState(sheet, next)
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
      const prev = store.getter(sheet.sheetAtom) as SheetState
      const next = applyCell(prev, key, (existing) => {
        if (value.kind === 'blank') {
          if (!existing) return undefined
          if (existing.format) {
            return { input: '', value: { kind: 'blank' }, format: existing.format }
          }
          return undefined
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
        return {
          input,
          value,
          format: existing?.format,
        }
      })
      writeSheetState(sheet, next)
    },
    clearCell(sheetId, row, col, target = 'value') {
      const sheet = requireSheet(sheetId)
      const key = keyFor(row, col)
      const prev = store.getter(sheet.sheetAtom) as SheetState
      const next = applyCell(prev, key, (existing) => {
        if (!existing) return undefined
        if (target === 'all') return undefined
        if (target === 'format') {
          // Drop format only; keep value/formula/ast intact.
          if (!existing.format) return existing
          const { format: _format, ...rest } = existing
          void _format
          return { ...rest }
        }
        // target === 'value' — clear value+formula, keep format.
        if (existing.format) {
          return { input: '', value: { kind: 'blank' }, format: existing.format }
        }
        return undefined
      })
      writeSheetState(sheet, next)
    },
    bulkApply(sheetId, cells) {
      const sheet = requireSheet(sheetId)
      if (cells.length === 0) return
      const prev = store.getter(sheet.sheetAtom) as SheetState
      // Build a single new Map so dependents see one atom write.
      const next = new Map(prev)
      for (const entry of cells) {
        const key = keyFor(entry.row, entry.col)
        next.set(key, buildCell(entry.input, prev.get(key)))
      }
      writeSheetState(sheet, next)
    },
    setFormat(sheetId, range, format) {
      const sheet = requireSheet(sheetId)
      const prev = store.getter(sheet.sheetAtom) as SheetState
      const next = new Map(prev)
      for (let r = range.rowStart; r <= range.rowEnd; r += 1) {
        for (let c = range.colStart; c <= range.colEnd; c += 1) {
          const key = keyFor(r, c)
          const existing = prev.get(key)
          if (existing) {
            next.set(key, {
              ...existing,
              format: { ...existing.format, ...format },
            })
          } else {
            // No cell yet — stamp a blank cell with format only.
            next.set(key, {
              input: '',
              value: { kind: 'blank' },
              format: { ...format },
            })
          }
        }
      }
      writeSheetState(sheet, next)
    },
    recalc() {
      recalculateAllSheets()
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
      batchDepth += 1
      try {
        const result = fn()
        // Successful exit: only the outermost frame drains the pending
        // flag and fires the deferred recalc. Inner frames just decrement.
        if (batchDepth === 1 && pendingRecalc) {
          pendingRecalc = false
          recalculateAllSheets()
        }
        return result
      } catch (err) {
        // Throw aborts the host's intent — clear pending without firing
        // so we don't leak a half-applied batch's recalc out to the
        // caller. Re-raise unchanged.
        if (batchDepth === 1) {
          pendingRecalc = false
        }
        throw err
      } finally {
        batchDepth -= 1
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
