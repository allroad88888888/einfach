/**
 * Workbook root.
 *
 * `createWorkbook` builds a `Workbook` handle that owns:
 *  - a core/core `Store` (created internally — host code can opt-in to a
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
import { cellKey } from './refs/ranges'
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
  CustomCallOrigin,
  ErrorCode,
  Expr,
  NameBinding,
  Value,
} from './types'

/** Cache-state vocabulary returned by `debugFormulaCacheState`. Mirrors
 * the Rust side's `Sheet::debug_formula_cache_state` return values so the
 * e2e probe suite reads identically against either backend. */
export type FormulaCacheState = 'dirty' | 'computing' | 'clean' | 'none' | 'invalid'

/** One drained async custom-formula request (see `registerCustomFormula`). */
export interface PendingAsyncCustomCall {
  readonly callId: number
  readonly name: string
  readonly args: Value[]
}

export interface CreateWorkbookOptions {
  /**
   * Inject a parser. Defaults to `parseFormula` from `./parser`.
   * Tests use this to seed pre-parsed ASTs without spinning up the real
   * tokenizer; production code should leave it unset.
   */
  parser?: (input: string) => Expr
  /**
   * Inject a core/core `Store`. Defaults to a fresh `createStore()`.
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

/**
 * Typed bulk entry (audit C-8). Carries an already-classified `Value`
 * through the bulk fast path so the wire type survives — text `'00123'`
 * stays a string instead of being re-inferred to number 123 by
 * `parseLiteral`, exactly like the single-cell `setCellValue` path.
 * Mixed arrays (`BulkCellInput | BulkTypedCellInput`) are accepted by
 * `bulkApply`; entries with `value` skip the parser entirely.
 */
export interface BulkTypedCellInput {
  readonly row: number
  readonly col: number
  readonly value: Value
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
  /**
   * Apply many cells in one atom write (paste / fill / import).
   *
   * Entries come in two shapes (audit C-8):
   *  - `BulkCellInput` (`input: string`) — runs the formula parser +
   *    `parseLiteral` inference, exactly like `setCell`.
   *  - `BulkTypedCellInput` (`value: Value`) — installs the typed value
   *    verbatim, exactly like `setCellValue` (no re-inference; text
   *    `'00123'` keeps its leading zeros, text `'=A1'` stays literal).
   */
  bulkApply(sheetId: string, cells: ReadonlyArray<BulkCellInput | BulkTypedCellInput>): void
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
   * ⚠️ Perf (audit C-3): like the four registry mutators below, each
   * call OUTSIDE `withBatch` fires a FULL registry-breadth recalc —
   * wrap multi-step registration sequences in `withBatch`. Measured
   * numbers on `defineName`'s doc.
   *
   * Validation: any non-empty string is accepted. We do not validate
   * BCP-47 syntax up front; downstream Intl.* calls fall back to en-US
   * shape on bad input (see `getNumberFormatParts` in `text.ts`).
   */
  setLocale(locale: string): void
  /**
   * Register a named range / value / LAMBDA.
   *
   * ⚠️ Perf (audit C-3, deliberate-broad contract): registry changes
   * invalidate EVERY cached formula on every sheet — names can be
   * referenced from anywhere, so registry-driven invalidation is
   * intentionally registry-breadth, not key-granular (see
   * `docs/KEY_GRANULAR_INVALIDATION.md` § C-3). Each call outside
   * `withBatch` therefore pays a full recalc pass: measured on
   * 3 sheets × 100k cells, one `defineName` = 15–21 ms; 50 names
   * INSIDE one `withBatch` = 15–21 ms total (coalesced); 50 names
   * OUTSIDE = ~800 ms (~50×). Always wrap multi-registration
   * sequences (imports, template setup, host boot) in `withBatch`.
   */
  defineName(name: string, binding: NameBinding): void
  /**
   * Remove a previously defined name.
   *
   * ⚠️ Perf (audit C-3): full registry-breadth recalc per call outside
   * `withBatch` — batch multi-step registry changes (see `defineName`).
   */
  undefineName(name: string): boolean
  /**
   * Register a host custom formula.
   *
   * Sync (default): `fn` is invoked inline during evaluation.
   *
   * `options.isAsync`: `fn` is NEVER invoked by the engine. Evaluation
   * memoizes per (name, args): a miss enqueues a pending call and the
   * cell holds `#BUSY!`; the host drains via
   * `drainPendingAsyncCustomCalls`, runs its own (possibly Promise-
   * returning) callback, and settles with `resolveAsyncCustomCall` —
   * which re-derives exactly the formulas that observed the pending
   * value. Memoized results live until the NEXT registry change
   * (register/unregister of ANY custom formula), matching the Rust
   * engine's contract.
   *
   * ⚠️ Perf (audit C-3): full registry-breadth recalc per call outside
   * `withBatch` — batch multi-step registry changes (see `defineName`).
   */
  registerCustomFormula(
    name: string,
    fn: (args: Value[]) => Value,
    options?: { isAsync?: boolean },
  ): void
  /**
   * Remove a host custom formula.
   *
   * ⚠️ Perf (audit C-3): full registry-breadth recalc per call outside
   * `withBatch` — batch multi-step registry changes (see `defineName`).
   */
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
   * Drain async custom-formula calls queued by evaluation since the
   * last drain. The host settles each via `resolveAsyncCustomCall`.
   */
  drainPendingAsyncCustomCalls(): PendingAsyncCustomCall[]
  /**
   * Settle an async custom-formula call. `resolved: false` means the
   * call was unknown or stale (a registry change invalidated it) and
   * the value was dropped. `touched` lists the formula cells that were
   * re-derived so a worker runtime can forward dirty notifications.
   */
  resolveAsyncCustomCall(
    callId: number,
    value: Value,
  ): { resolved: boolean; touched: Array<{ sheetId: string; key: string }> }
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
  /**
   * Size probe over the workbook DepGraph (TS mirror of Rust's
   * `debug_dep_graph_stats`). Used by the always-on scale suite to
   * assert that edges installed for dead formulas are torn down
   * (audit C-6) — pure observation, never mutates the graph.
   *
   * @internal
   */
  debugDepGraphStats(): {
    installed: number
    pointKeys: number
    rangeEntries: number
    broad: number
  }
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
  const customFormulas = new Map<string, { fn: (args: Value[]) => Value; isAsync: boolean }>()
  const canonicalName = (name: string): string => name.toUpperCase()

  // Async custom-formula memo (Wave 8.2, Rust parity — see
  // `excel/rust/excel-core/src/CUSTOM_FORMULAS.md` § Async). Entries are
  // content-addressed by (name, canonicalized args); `observers` are the
  // formula cells that read the entry while pending, re-derived via
  // `propagation.postWrite` on settle. Any registry change clears the
  // whole state and bumps `generation` so in-flight settles are dropped.
  type AsyncCustomEntry = {
    state: 'pending' | 'settled'
    value?: Value
    callId: number
    generation: number
    observers: Set<string> // `${sheetId}::${cellKey}`
    coarse: boolean // an observer without cell identity → settle falls back to full recalc
  }
  const asyncCustom = {
    entries: new Map<string, AsyncCustomEntry>(),
    byCallId: new Map<number, string>(),
    pending: [] as PendingAsyncCustomCall[],
    nextCallId: 1,
    generation: 0,
  }
  /** Bounded cache: settled, unobserved-at-sweep entries beyond the cap
   * are dropped oldest-insertion-first at drain time. */
  const ASYNC_CUSTOM_RESULT_CACHE_CAP = 512

  function resetAsyncCustomState(): void {
    asyncCustom.entries.clear()
    asyncCustom.byCallId.clear()
    asyncCustom.pending.length = 0
    asyncCustom.generation += 1
  }

  /** Content-addressed key. Must agree with structural Value equality:
   * numbers via String() (NaN normalized; note ±0 both print '0'),
   * text length-prefixed so concatenation cannot alias across args. */
  function canonicalCustomCallKey(name: string, args: Value[]): string {
    const parts: string[] = [name]
    const writeValue = (v: Value): string => {
      switch (v.kind) {
        case 'number':
          return `N:${String(v.value)}`
        case 'string':
          return `T:${v.value.length}:${v.value}`
        case 'boolean':
          return v.value ? 'B:1' : 'B:0'
        case 'blank':
          return 'Z'
        case 'error':
          return `E:${v.code}`
        case 'array':
          return `A:${v.value.length}x${v.value[0]?.length ?? 0}:${v.value
            .flat()
            .map(writeValue)
            .join(',')}`
      }
    }
    for (const v of args) parts.push(writeValue(v))
    return parts.join('|')
  }

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
    customFormulas: Map<string, { fn: (args: Value[]) => Value; isAsync: boolean }>
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
    // workbook DepGraph, not core/core dep registration (the unused
    // `get` parameter is kept on the TYPE for signature compatibility).
    crossSheetCells(sheetName) {
      const target = sheetsByName.get(sheetName)
      if (!target) return undefined
      return target._internal.cells
    },
    onFormulaEvaluated(cells, key, ast, runtimeDeps) {
      const owner = sheetsByCellsMap.get(cells)
      // Unknown map identity (e.g. an evaluator driven against a
      // detached snapshot in tests) → nothing to index.
      if (!owner) return
      propagation.installDepsFor(owner, key, ast, runtimeDeps)
    },
    callCustom(name, args, origin) {
      const entry = customFormulas.get(name.toUpperCase())
      if (!entry) return undefined
      if (!entry.isAsync) return entry.fn(args)
      // Async dispatch never invokes the callback here. Error args
      // short-circuit without touching the memo (Rust parity: the
      // registry never sees Value errors and junk keys never cache).
      for (const arg of args) {
        if (arg.kind === 'error') return arg
      }
      return asyncCustomResult(name.toUpperCase(), args, origin)
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

  function asyncCustomResult(name: string, args: Value[], origin?: CustomCallOrigin): Value {
    const memoKey = canonicalCustomCallKey(name, args)
    let entry = asyncCustom.entries.get(memoKey)
    if (entry && entry.generation !== asyncCustom.generation) {
      // Defensive: reset clears the map, so stale generations should not
      // survive — but never serve a value across a registry change.
      asyncCustom.entries.delete(memoKey)
      entry = undefined
    }
    if (!entry) {
      entry = {
        state: 'pending',
        callId: asyncCustom.nextCallId++,
        generation: asyncCustom.generation,
        observers: new Set(),
        coarse: false,
      }
      asyncCustom.entries.set(memoKey, entry)
      asyncCustom.byCallId.set(entry.callId, memoKey)
      asyncCustom.pending.push({ callId: entry.callId, name, args: args.slice() })
    }
    if (entry.state === 'settled') return entry.value!
    // Record who observed the pending value — exactly these cells (plus
    // their dependents via postWrite's BFS) re-derive on settle.
    const ownerSheet = origin?.sheetName ? sheetsByName.get(origin.sheetName) : undefined
    if (ownerSheet && origin?.cell) {
      entry.observers.add(`${ownerSheet.id}::${cellKey(origin.cell)}`)
    } else {
      entry.coarse = true
    }
    return { kind: 'error', code: '#BUSY!', message: `async custom formula ${name} is pending` }
  }

  /** Bounded-cache sweep at drain time: drop oldest settled entries with
   * no pending observers once the memo exceeds the cap. A dropped entry
   * simply re-enqueues (and re-executes) on its next read. */
  function sweepAsyncCustomEntries(): void {
    if (asyncCustom.entries.size <= ASYNC_CUSTOM_RESULT_CACHE_CAP) return
    for (const [memoKey, entry] of asyncCustom.entries) {
      if (asyncCustom.entries.size <= ASYNC_CUSTOM_RESULT_CACHE_CAP) break
      if (entry.state !== 'settled') continue
      asyncCustom.entries.delete(memoKey)
      asyncCustom.byCallId.delete(entry.callId)
    }
  }

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
      cells.set(key, { input: canonicalInputFor(value), value, format: existing?.format })
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
        if ('value' in entry) {
          // Typed entry (audit C-8): mirror `setCellValue` exactly — no
          // parser, no `parseLiteral` re-inference. Blank values clear
          // the entry (keeping format when present), same as the
          // single-cell path.
          const value = entry.value
          if (value.kind === 'blank') {
            if (prev?.format) {
              live.set(key, { input: '', value: { kind: 'blank' }, format: prev.format })
            } else {
              live.delete(key)
            }
          } else {
            live.set(key, { input: canonicalInputFor(value), value, format: prev?.format })
          }
        } else {
          live.set(key, buildCell(parser, entry.input, prev))
        }
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
    registerCustomFormula(name, fn, registration) {
      customFormulas.set(name.toUpperCase(), { fn, isAsync: registration?.isAsync === true })
      // Any registry change invalidates the async memo wholesale and
      // strands in-flight settles (generation bump) — Rust parity.
      resetAsyncCustomState()
      requestRecalc()
    },
    unregisterCustomFormula(name) {
      const removed = customFormulas.delete(name.toUpperCase())
      if (removed) {
        resetAsyncCustomState()
        requestRecalc()
      }
      return removed
    },
    drainPendingAsyncCustomCalls() {
      sweepAsyncCustomEntries()
      return asyncCustom.pending.splice(0, asyncCustom.pending.length)
    },
    resolveAsyncCustomCall(callId, value) {
      const memoKey = asyncCustom.byCallId.get(callId)
      if (memoKey === undefined) return { resolved: false, touched: [] }
      asyncCustom.byCallId.delete(callId)
      const entry = asyncCustom.entries.get(memoKey)
      if (!entry || entry.callId !== callId || entry.generation !== asyncCustom.generation) {
        return { resolved: false, touched: [] }
      }
      entry.state = 'settled'
      entry.value = value
      const coarse = entry.coarse
      const observers = [...entry.observers]
      entry.observers.clear()
      entry.coarse = false

      const touched: Array<{ sheetId: string; key: string }> = []
      const bySheet = new Map<string, string[]>()
      for (const observer of observers) {
        const sep = observer.indexOf('::')
        const sheetId = observer.slice(0, sep)
        const obsKey = observer.slice(sep + 2)
        let keys = bySheet.get(sheetId)
        if (!keys) {
          keys = []
          bySheet.set(sheetId, keys)
        }
        keys.push(obsKey)
        touched.push({ sheetId, key: obsKey })
      }
      if (coarse) {
        // At least one observer had no cell identity — we cannot target
        // the bump, so fall back to the registry-breadth recalc.
        propagation.recalculateAllSheets()
      } else {
        for (const [sheetId, keys] of bySheet) {
          const owner = sheetsById.get(sheetId)
          if (!owner) continue
          const records: WriteRecord[] = keys.map((obsKey) => ({
            key: obsKey,
            prevAst: undefined,
            valueChanged: true,
          }))
          propagation.postWrite(owner, records)
        }
      }
      return { resolved: true, touched }
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
          // The registry just changed shape (rollback) — same async
          // memo invalidation as a forward registry change.
          resetAsyncCustomState()
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
    debugDepGraphStats() {
      return propagation.debugDepGraphStats()
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
 * Canonical string repr for an already-typed `Value` (shared by
 * `setCellValue` and `bulkApply`'s typed entries — audit C-8). The
 * stored `value` is authoritative; `input` only exists so the formula
 * bar surfaces something readable.
 */
function canonicalInputFor(value: Exclude<Value, { kind: 'blank' }>): string {
  switch (value.kind) {
    case 'number':
      return String(value.value)
    case 'string':
      return value.value
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE'
    case 'error':
      return value.code
    case 'array':
      // Array-typed literals don't have a single-cell representation;
      // collapse to top-left for display, keep the array as the value.
      return ''
  }
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
