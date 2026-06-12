/// <reference lib="WebWorker" />

/**
 * Wave D — TypeScript-backed worker runtime.
 *
 * This module is the TS-core counterpart to `worker-runtime.ts` (WASM).
 * It owns a `@einfach/excel-core-ts` `Workbook` and decodes the same
 * `postMessage` RPC envelope the WASM runtime accepts, so the existing
 * solid-side `createWorkerWorkbookSpreadsheetBackend` shim can route
 * through us unchanged.
 *
 * Scope (Phase 4 / Wave D):
 *  - Sheet lifecycle: `initWorkbook`, `sheetList`, `addSheet`,
 *    `renameSheet`, `removeSheet`, `moveSheet`.
 *  - Cell I/O: `setCell`, `setFormula`, `setFormulaDetailed`, `clearCell`,
 *    `clearRange`.
 *  - Projection reads: `readSparseRange`, `snapshotRangeSparse`,
 *    `snapshotSparse`, `listNonEmpty`, `readCells`.
 *  - Format shims: `setFormatRange` / `snapshotFormatRange` return empty
 *    snapshots — TS core does not yet model formats.
 *  - Size metadata: row heights / column widths live in this worker runtime
 *    so `snapshotViewportSizes` and persistence v1 match the WASM RPC shape.
 *  - Structural ops `insertRows` / `deleteRows` / `insertColumns` /
 *    `deleteColumns` are stubbed to no-ops returning `true` — the TS
 *    core has no native band shift yet.
 *  - Import sessions: minimal pass-through. `beginImport` opens a session,
 *    `importChunk` applies cells via `workbook.bulkApply`, `commitImport`
 *    closes it; `cancelImport` discards.
 *  - Export: `exportRangeTsv` builds a tab-separated string by walking
 *    the rendered cells via the engine's display path.
 *  - Custom formulas: `registerCustomFormula` compiles the source via
 *    `new Function('args', source)` and binds the resulting callable on
 *    the engine. (Same string-source contract as the WASM bridge so the
 *    Solid-side host atom hooks need no changes.)
 *  - Subscriptions / cellsDirty: every successful mutation broadcasts a
 *    coarse `cellsDirty` event covering the touched cell. The TS core
 *    does not yet wire fine-grained per-cell `sub` propagation back to
 *    the worker boundary, so the dirty event is the projection refresh
 *    trigger; the UI's projection-cursor revives the next render.
 *
 * NOT in scope here (left for Wave E+ tracks):
 *  - Persistence v1 import / export.
 *  - Subscribe cell-list with hydrated payload.
 *  - Debug counters / formula-eval / formula-cache state.
 *  - Streaming snapshot / export sessions (chunked).
 *
 * Hard rules:
 *  - This file is consumed by the worker entry script
 *    (`worker-entry-ts.ts`) which calls `installWorkerRuntimeTs()`.
 *  - The runtime can also be exercised directly from jest by passing a
 *    mock `WorkerContext` to `createWorkerRuntimeTs()` — that's how we
 *    cover the end-to-end round-trip without spinning a real Worker.
 *  - No imports from `wasm-pkg/`, `solid-js`, or React. Direct deps:
 *    `@einfach/excel-core-ts` + adapter-local protocol types.
 */

import {
  createWorkbook,
  formatA1,
  parseA1,
  parseFormula,
  type BulkCellInput,
  type BulkTypedCellInput,
  type Cell,
  type CellCoord,
  type CellRange,
  type ErrorCode,
  type NameBinding,
  type Value,
  type Workbook,
} from '@einfach/excel-core-ts'
import { sparseRangeToTSV } from './range-tsv'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  FormatRangeSnapshot,
  FormulaMutationResultWire,
  ImportCellWire,
  RpcErrorWire,
  RpcResponseWire,
  SparseCellWire,
  SparseRangeWire,
  ViewportColumnWidthWire,
  ViewportRowHeightWire,
  ViewportSizeSnapshotWire,
  WorkbookImportStatsWire,
  WorkbookPersistenceSnapshotWire,
  WorkbookSheetMeta,
} from './worker-protocol'

const CUSTOM_FORMULA_ERROR_CODES: readonly ErrorCode[] = [
  '#NULL!',
  '#DIV/0!',
  '#N/A',
  '#REF!',
  '#VALUE!',
  '#NAME?',
  '#NUM!',
  '#CYCLE!',
  '#TYPE!',
  '#ARGS!',
  '#SPILL!',
  '#CALC!',
]

export interface WorkerContext {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
}

interface SheetEntry {
  id: string
  idx: number
  name: string
}

interface SnapshotSession {
  range: SparseRangeWire
  rowsPerChunk: number
  totalRows: number
  nextRow: number
}

interface RuntimeState {
  workbook: Workbook
  /** Stable display order of sheets in the TS workbook. */
  sheets: SheetEntry[]
  /** Custom formula source registry — compiled callables live on the workbook. */
  customFormulas: Map<string, string>
  rowHeightsBySheetName: Map<string, Map<number, number>>
  colWidthsBySheetName: Map<string, Map<number, number>>
  importSessions: Map<number, { mode: 'atomic' | 'direct'; cells: ImportCellWire[] }>
  nextImportSessionId: number
  snapshotSessions: Map<number, SnapshotSession>
  nextSnapshotSessionId: number
  /**
   * Set of formula-cell addresses (`${sheetIdx}:${row}:${col}`) that have
   * been read via a client-facing RPC since their last write/clear.
   *
   * The TS engine evaluates a formula eagerly whenever its atom is read,
   * including the internal cycle-check read in `setFormulaDetailed` — so
   * the engine's own `debugFormulaCacheState` cannot distinguish "never
   * read by the host" from "auto-evaluated during a write". The WASM
   * engine has a true dirty/clean state machine; to mirror its semantics
   * at the worker boundary we mark a cell 'dirty' whenever the host
   * hasn't observed it since the last mutation. Reads add entries here;
   * writes/clears remove them.
   */
  readFormulaCells: Set<string>
}

function makeReadKey(sheetIdx: number, row: number, col: number): string {
  return `${sheetIdx}:${row}:${col}`
}

type RequestMessage = {
  id?: number
  cmd?: string
  [key: string]: unknown
}

const DEFAULT_INITIAL_SHEETS = ['Sheet1']

function newSheetId(idx: number): string {
  return `sheet-${idx + 1}`
}

function makeWorkbookFor(sheetNames: ReadonlyArray<string>): { wb: Workbook; sheets: SheetEntry[] } {
  const names = sheetNames.length > 0 ? sheetNames : DEFAULT_INITIAL_SHEETS
  const seeds = names.map((name, idx) => ({ id: newSheetId(idx), name }))
  const wb = createWorkbook(seeds)
  const sheets: SheetEntry[] = seeds.map((seed, idx) => ({ id: seed.id, idx, name: seed.name }))
  return { wb, sheets }
}

function createInitialState(): RuntimeState {
  const { wb, sheets } = makeWorkbookFor(DEFAULT_INITIAL_SHEETS)
  return {
    workbook: wb,
    sheets,
    customFormulas: new Map(),
    rowHeightsBySheetName: new Map(),
    colWidthsBySheetName: new Map(),
    importSessions: new Map(),
    nextImportSessionId: 1,
    snapshotSessions: new Map(),
    nextSnapshotSessionId: 1,
    readFormulaCells: new Set(),
  }
}

const DEFAULT_ROWS_PER_CHUNK = 2048
const MIN_ROWS_PER_CHUNK = 1
const MAX_ROWS_PER_CHUNK = 10_000

function clampRowsPerChunk(value: unknown): number {
  const normalized = Math.floor(Number(value))
  if (!Number.isFinite(normalized)) return DEFAULT_ROWS_PER_CHUNK
  if (normalized < MIN_ROWS_PER_CHUNK) return MIN_ROWS_PER_CHUNK
  if (normalized > MAX_ROWS_PER_CHUNK) return MAX_ROWS_PER_CHUNK
  return normalized
}

function rangeTotalRows(range: SparseRangeWire): number {
  return Math.max(0, range.endRow - range.startRow + 1)
}


function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function normalizeAddr(addr: unknown): string {
  return String(addr ?? '').toUpperCase()
}

function assertSheetIdx(state: RuntimeState, sheet: number): SheetEntry {
  if (!Number.isInteger(sheet) || sheet < 0 || sheet >= state.sheets.length) {
    throw rpcError('INVALID_SHEET', `invalid sheet index: ${sheet}`)
  }
  return state.sheets[sheet]
}

function valueKindToCellType(v: Value): CellSnapshotWire['type'] {
  switch (v.kind) {
    case 'number':
      return 'number'
    case 'string':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'error':
      return 'error'
    case 'blank':
      return 'null'
    case 'array': {
      // Match the WASM convention: arrays collapse to top-left at the
      // projection boundary. Empty array → blank.
      const row = v.value[0]
      if (!row || row.length === 0) return 'null'
      return valueKindToCellType(row[0])
    }
  }
}

function valueDisplay(v: Value): string {
  switch (v.kind) {
    case 'number':
      // Match Excel's "as short as possible" string rep for numbers.
      // Number.prototype.toString already trims trailing zeros.
      return String(v.value)
    case 'string':
      return v.value
    case 'boolean':
      return v.value ? 'TRUE' : 'FALSE'
    case 'error':
      return v.code
    case 'blank':
      return ''
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return ''
      return valueDisplay(row[0])
    }
  }
}

/**
 * Walk up + left within a bounded window looking for a spill anchor whose
 * `kind:'array'` covers the target. If found, return the projected scalar;
 * otherwise undefined. The window cap (`SPILL_LOOKBACK`) keeps reads O(1)
 * even on dense sheets — anchors farther than this aren't projectable.
 */
const SPILL_LOOKBACK = 200
function getSpillProjectedValue(
  state: RuntimeState,
  sheet: SheetEntry,
  row: number,
  col: number,
): Value | undefined {
  const target = state.workbook.sheet(sheet.id)
  if (!target) return undefined
  const cells = state.workbook.store.getter(target.sheetAtom)
  // Self-check: if (row,col) has its own cell, it isn't a spill target.
  if (cells.has(`${row}:${col}`)) return undefined

  const rowMin = Math.max(0, row - SPILL_LOOKBACK)
  const colMin = Math.max(0, col - SPILL_LOOKBACK)
  for (let r = row; r >= rowMin; r -= 1) {
    for (let c = col; c >= colMin; c -= 1) {
      if (r === row && c === col) continue
      const anchor = cells.get(`${r}:${c}`)
      if (!anchor || !anchor.input?.startsWith('=')) continue
      const atom = target.formulaCellAtom(`${r}:${c}`)
      const v = state.workbook.store.getter(atom)
      if (v.kind !== 'array') continue
      const dr = row - r
      const dc = col - c
      if (dr < v.value.length && dc < (v.value[dr]?.length ?? 0)) {
        return v.value[dr][dc]
      }
      // Anchor exists but its array doesn't cover us — keep searching.
    }
  }
  return undefined
}

function readCellValue(state: RuntimeState, sheet: SheetEntry, row: number, col: number): Value {
  const target = state.workbook.sheet(sheet.id)
  if (!target) return { kind: 'blank' }
  const key = `${row}:${col}`
  const cells = state.workbook.store.getter(target.sheetAtom)
  if (cells.has(key)) {
    // The cell has its own formula / literal. Read the atom and collapse
    // any returned array to its top-left scalar at the boundary (mirrors
    // the WASM convention — UI cells project one scalar each).
    const atom = target.formulaCellAtom(key)
    const v = state.workbook.store.getter(atom)
    if (v.kind === 'array') {
      return v.value[0]?.[0] ?? { kind: 'blank' }
    }
    return v
  }
  // Empty cell — check if a nearby anchor's array projects into us.
  const spilled = getSpillProjectedValue(state, sheet, row, col)
  if (spilled) return spilled
  return { kind: 'blank' }
}

function readCellSnapshot(
  state: RuntimeState,
  sheet: SheetEntry,
  row: number,
  col: number,
): CellSnapshotWire {
  const value = readCellValue(state, sheet, row, col)
  const target = state.workbook.sheet(sheet.id)
  const cells = target ? state.workbook.store.getter(target.sheetAtom) : undefined
  const cell = cells?.get(`${row}:${col}`)
  // A cell is a formula iff its parsed `ast` is set — NOT just because
  // the raw `input` starts with `=`. Text cells (P1.1 codex fix) can
  // carry a literal `=A1` string and must report formula:'' so the UI
  // doesn't misclassify them as formulas.
  const formula = cell?.ast ? cell.input : ''
  return {
    sheet: sheet.idx,
    addr: formatA1({ row, col }),
    display: valueDisplay(value),
    type: valueKindToCellType(value),
    isError: value.kind === 'error',
    formula,
  }
}

function readSparseCell(
  state: RuntimeState,
  sheet: SheetEntry,
  row: number,
  col: number,
): SparseCellWire | undefined {
  const target = state.workbook.sheet(sheet.id)
  if (!target) return undefined
  const cells = state.workbook.store.getter(target.sheetAtom)
  const cell = cells.get(`${row}:${col}`)
  // Formula cells emit a 'formula' SparseCellWire with the source so the
  // backend layer can detect formula-vs-literal — matches the WASM path.
  // Key off `cell.ast` (not `cell.input.startsWith('=')`) so a text cell
  // whose value happens to be `"=A1"` (P1.1 codex fix) stays text.
  if (cell && cell.ast) {
    return {
      sheet: sheet.idx,
      addr: formatA1({ row, col }),
      row,
      col,
      kind: 'formula',
      value: cell.input,
    }
  }
  // If `cell` is undefined this may be a spill target (no own entry but
  // a nearby anchor's array covers (row, col)). `readCellValue` already
  // handles that — fall through and let it return the projected scalar.
  // If `readCellValue` then returns blank, we drop the cell (sparse
  // snapshots omit blanks; that's the existing contract).
  const value = readCellValue(state, sheet, row, col)
  switch (value.kind) {
    case 'number':
      return { sheet: sheet.idx, addr: formatA1({ row, col }), row, col, kind: 'number', value: value.value }
    case 'string':
      return { sheet: sheet.idx, addr: formatA1({ row, col }), row, col, kind: 'text', value: value.value }
    case 'boolean':
      return { sheet: sheet.idx, addr: formatA1({ row, col }), row, col, kind: 'boolean', value: value.value }
    case 'error':
      return { sheet: sheet.idx, addr: formatA1({ row, col }), row, col, kind: 'error', value: value.code }
    case 'array':
    case 'blank':
      return undefined
  }
}

function listSheetMeta(state: RuntimeState): WorkbookSheetMeta[] {
  return state.sheets.map((sheet) => ({ idx: sheet.idx, name: sheet.name }))
}

function applyCellInput(state: RuntimeState, sheet: SheetEntry, row: number, col: number, input: string) {
  state.workbook.setCell(sheet.id, row, col, input)
  // After any mutation, dependent formulas may have been auto-flushed by
  // the engine. We invalidate the host-read tracking for every formula
  // cell on this sheet so the next `debugFormulaCacheState` reports
  // 'dirty' until the host re-observes the cell — matching WASM, where
  // dep-changes mark cells dirty until re-read.
  invalidateReadOnMutation(state, sheet.idx)
}

function clearCell(state: RuntimeState, sheet: SheetEntry, row: number, col: number) {
  state.workbook.clearCell(sheet.id, row, col, 'all')
  invalidateReadOnMutation(state, sheet.idx)
}

function invalidateReadOnMutation(state: RuntimeState, sheetIdx: number) {
  // Coarse invalidation matching the WASM engine's broad dirty-bump:
  // any mutation on a sheet marks every formula cell on that sheet as
  // unread, regardless of dependency edges. The `debugFormulaCacheState`
  // probe checks the host-read set; reads after the mutation re-mark
  // cells clean. Cross-sheet ripple is matched implicitly because the
  // probe sees 'dirty' for any cell the host hasn't re-read.
  const prefix = `${sheetIdx}:`
  for (const key of state.readFormulaCells) {
    if (key.startsWith(prefix)) state.readFormulaCells.delete(key)
  }
}

function setCellFromWire(
  state: RuntimeState,
  sheet: SheetEntry,
  row: number,
  col: number,
  value: CellWire,
): boolean {
  // Pre-classified wires must go through `setCellValue`, NOT
  // `setCell(input)`. Otherwise text like `"00123"`, `"TRUE"`, `"#N/A"`,
  // or `"=A1"` gets re-inferred by the parser and corrupted:
  //  - `00123` → number 123 (leading zero lost)
  //  - `TRUE`  → boolean (intent was a string)
  //  - `#N/A`  → error literal (intent was a string)
  //  - `=A1`   → formula (intent was a string)
  // The wire type carries the producer's classification — respect it.
  switch (value.type) {
    case 'number':
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'number', value: value.value })
      invalidateReadOnMutation(state, sheet.idx)
      return true
    case 'text':
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'string', value: value.value })
      invalidateReadOnMutation(state, sheet.idx)
      return true
    case 'boolean':
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'boolean', value: value.value })
      invalidateReadOnMutation(state, sheet.idx)
      return true
    case 'error': {
      const code = value.value as ErrorCode
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'error', code })
      invalidateReadOnMutation(state, sheet.idx)
      return true
    }
    case 'null':
      clearCell(state, sheet, row, col)
      return true
    default:
      throw rpcError('INVALID_CELL_VALUE', 'unsupported cell wire value')
  }
}

function setFormulaDetailed(
  state: RuntimeState,
  sheet: SheetEntry,
  row: number,
  col: number,
  formula: unknown,
): FormulaMutationResultWire {
  if (typeof formula !== 'string') {
    return { ok: false, code: 'INVALID_FORMULA', message: 'formula must be a string' }
  }
  const source = formula.startsWith('=') ? formula : `=${formula}`
  try {
    applyCellInput(state, sheet, row, col, source)
    // Read the resulting value to surface cycle errors. Formulas that
    // evaluate to a normal Excel error (`=1/0`, `=NA()`, `=#REF!`,
    // lookups returning `#N/A`, etc.) are **valid formulas** — the cell
    // is supposed to display the error code. Only structural failures
    // (cycle, parse error caught upstream) should reject the mutation.
    const value = readCellValue(state, sheet, row, col)
    if (value.kind === 'error' && value.code === '#CIRCULAR!') {
      return { ok: false, code: 'FORMULA_CYCLE', message: 'formula would create a cycle', display: value.code }
    }
    // A formula that evaluates to an error is still a valid mutation —
    // the cell projects the error code at the read boundary. We
    // intentionally do NOT carry a `display` in the result envelope
    // (the protocol's `ok:true` variant doesn't have that field; the
    // cell read path delivers the display).
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_FORMULA',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function normalizeSparseRange(range: unknown): SparseRangeWire {
  const r = (range ?? {}) as Partial<SparseRangeWire>
  return {
    sheet: Number(r.sheet ?? 0),
    startRow: Number(r.startRow ?? 0),
    startCol: Number(r.startCol ?? 0),
    endRow: Number(r.endRow ?? 0),
    endCol: Number(r.endCol ?? 0),
  }
}

function clampRangeToSheet(range: SparseRangeWire): CellRange {
  // The TS workbook's per-cell `formulaCellAtom` is fine to invoke on
  // any coord — blank cells return BLANK. But we cap whole-column /
  // whole-row queries at the sparse extent so we don't materialize
  // millions of empty cells per snapshot request.
  return {
    rowStart: Math.max(0, range.startRow),
    rowEnd: Math.max(0, range.endRow),
    colStart: Math.max(0, range.startCol),
    colEnd: Math.max(0, range.endCol),
  }
}

/**
 * Audit D-8: enumerate existing cells intersecting `bounds` in
 * O(min(window area, existing cells)) instead of always walking the
 * whole live map. Viewport-sized windows probe their coordinates
 * directly (one `Map.get` per coord — cost independent of sheet size);
 * huge windows (full-column reads with rowEnd 1_048_575,
 * `snapshotSparse`'s MAX_SAFE_INTEGER sentinel) fall back to the sparse
 * map walk, which is O(existing cells) — the same shape the engine's
 * `clearRange` primitive uses (W2.4 / audit D-1).
 */
function collectCellsInBounds(
  cells: ReadonlyMap<string, Cell>,
  bounds: CellRange,
): Array<{ key: string; row: number; col: number; cell: Cell }> {
  const out: Array<{ key: string; row: number; col: number; cell: Cell }> = []
  const rowCount = bounds.rowEnd - bounds.rowStart + 1
  const colCount = bounds.colEnd - bounds.colStart + 1
  if (rowCount <= 0 || colCount <= 0) return out
  if (rowCount * colCount <= cells.size) {
    for (let row = bounds.rowStart; row <= bounds.rowEnd; row += 1) {
      for (let col = bounds.colStart; col <= bounds.colEnd; col += 1) {
        const key = `${row}:${col}`
        const cell = cells.get(key)
        if (cell) out.push({ key, row, col, cell })
      }
    }
    return out
  }
  for (const [key, cell] of cells) {
    const sep = key.indexOf(':')
    const row = Number(key.slice(0, sep))
    const col = Number(key.slice(sep + 1))
    if (row < bounds.rowStart || row > bounds.rowEnd || col < bounds.colStart || col > bounds.colEnd) {
      continue
    }
    out.push({ key, row, col, cell })
  }
  return out
}

/**
 * Enumerate the (row, col) coords of *spill targets* — cells with no own
 * formula/literal that fall inside the array-region of an anchor in this
 * sheet. Used by the range projectors so a spilled SEQUENCE/TRANSPOSE/SORT
 * surface in `readSparseRange` / `snapshotRangeSparse`, not just at the
 * boundary read path (`readCellValue`).
 *
 * The enumeration walks every formula cell once and consults its computed
 * value through `formulaCellAtom`; if it returns `kind:'array'`, every
 * coord *other than* the anchor itself that lies inside `bounds` becomes
 * a target. Cells that have their own entry in `cells` are skipped
 * (they're handled by the existing loop, which projects via
 * `readCellValue`'s top-left-collapse).
 */
function collectSpillTargets(
  state: RuntimeState,
  sheet: SheetEntry,
  bounds: CellRange,
): Array<{ row: number; col: number }> {
  const target = state.workbook.sheet(sheet.id)
  if (!target) return []
  const cells = state.workbook.store.getter(target.sheetAtom)
  const out: Array<{ row: number; col: number }> = []
  // Lazy contract: spill target collection must NEVER force evaluation
  // of a formula whose atom has not been read yet. Eager evaluation
  // defeats the WASM-mirror eval-count contract that bulk-paste tests
  // probe (an import of 10 000 cells must add at most one eval-count
  // tick). We only consult formulas the engine has already cached
  // ('clean'); a formula that is still 'dirty' cannot have produced a
  // spill the host needs to surface yet, so skipping it is safe.
  //
  // Audit D-8: the anchor scan is bounded too. Arrays spill DOWN and
  // RIGHT, so only anchors at or before the bounds end can project in;
  // when `collectCellsInBounds` takes its probe path (huge sheets,
  // small windows) the up-left search is additionally capped at
  // SPILL_LOOKBACK — the same documented projectability cap the
  // single-cell boundary read (`getSpillProjectedValue`) applies. On
  // sheets smaller than the expanded probe area the sparse map walk
  // runs instead and finds every anchor (today's behavior).
  const anchorBounds: CellRange = {
    rowStart: Math.max(0, bounds.rowStart - SPILL_LOOKBACK),
    rowEnd: bounds.rowEnd,
    colStart: Math.max(0, bounds.colStart - SPILL_LOOKBACK),
    colEnd: bounds.colEnd,
  }
  for (const { key, row: ar, col: ac, cell } of collectCellsInBounds(cells, anchorBounds)) {
    if (!cell.input.startsWith('=')) continue
    // Skip non-clean formulas to avoid forcing a fresh derive run. A
    // formula that was never read by the host yet will be 'dirty' here;
    // its spill (if any) will surface once the host actually requests
    // the value through `readCells` / `readSparseRange`.
    const cacheState = target._debug.cellState(key)
    if (cacheState !== 'clean') continue
    const atom = target.formulaCellAtom(key)
    const v = state.workbook.store.getter(atom)
    if (v.kind !== 'array') continue
    const rows = v.value.length
    const cols = v.value[0]?.length ?? 0
    // The anchor itself is already in the `cells` map and handled by the
    // outer loop's read pass; we only emit *projected* coords here.
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (r === 0 && c === 0) continue // anchor
        const tr = ar + r
        const tc = ac + c
        if (tr < bounds.rowStart || tr > bounds.rowEnd) continue
        if (tc < bounds.colStart || tc > bounds.colEnd) continue
        if (cells.has(`${tr}:${tc}`)) continue // explicit cell shadows the spill
        out.push({ row: tr, col: tc })
      }
    }
  }
  return out
}

function snapshotRangeSparse(state: RuntimeState, range: SparseRangeWire): SparseCellWire[] {
  const sheet = assertSheetIdx(state, range.sheet)
  const bounds = clampRangeToSheet(range)
  const target = state.workbook.sheet(sheet.id)
  if (!target) return []
  const cells = state.workbook.store.getter(target.sheetAtom)
  const out: SparseCellWire[] = []
  // Audit D-8: O(window ∩ existing) enumeration, not a full map walk.
  for (const { row, col } of collectCellsInBounds(cells, bounds)) {
    const sparse = readSparseCell(state, sheet, row, col)
    if (sparse) out.push(sparse)
  }
  // Add spill-projected cells from in-bounds anchors.
  for (const { row, col } of collectSpillTargets(state, sheet, bounds)) {
    const sparse = readSparseCell(state, sheet, row, col)
    if (sparse) out.push(sparse)
  }
  // Stable order: row-major.
  out.sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row))
  // NOTE: we deliberately do NOT mark these cells as host-read.
  // snapshotRangeSparse emits formula SOURCE for formula cells (it does
  // not evaluate the atom), so it doesn't count as "has the host
  // observed the value yet?" for the cache-state probe. Compare with
  // `readSparseRange` and `readCells`, which DO compute a display and
  // therefore mark the formula clean.
  return out
}

function readSparseRange(state: RuntimeState, range: SparseRangeWire): CellSnapshotWire[] {
  const sheet = assertSheetIdx(state, range.sheet)
  const bounds = clampRangeToSheet(range)
  const target = state.workbook.sheet(sheet.id)
  if (!target) return []
  const cells = state.workbook.store.getter(target.sheetAtom)
  const out: CellSnapshotWire[] = []
  // Audit D-8: O(window ∩ existing) enumeration, not a full map walk.
  for (const { row, col, cell } of collectCellsInBounds(cells, bounds)) {
    // Skip blank-format-only cells in the snapshot (matches the WASM
    // backend's "non-empty" semantics; the projection-builder fills
    // these in via fillBlankFormatOnlyCells using the format snapshot).
    const value = readCellValue(state, sheet, row, col)
    if (value.kind === 'blank' && !cell.input.startsWith('=')) continue
    out.push(readCellSnapshot(state, sheet, row, col))
  }
  // Include spill-projected cells (Wave E1 spill from anchors with arrays).
  for (const { row, col } of collectSpillTargets(state, sheet, bounds)) {
    out.push(readCellSnapshot(state, sheet, row, col))
  }
  out.sort((left, right) => {
    const la = parseA1(left.addr)
    const ra = parseA1(right.addr)
    if (!la || !ra) return 0
    if (la.row !== ra.row) return la.row - ra.row
    return la.col - ra.col
  })
  // Track host-observed formula cells so debugFormulaCacheState can
  // report 'clean' for cells the host has read since the last mutation.
  for (const snapshot of out) {
    if (snapshot.formula) {
      const coord = parseA1(snapshot.addr)
      if (coord) state.readFormulaCells.add(makeReadKey(sheet.idx, coord.row, coord.col))
    }
  }
  return out
}

function snapshotSparse(state: RuntimeState): SparseCellWire[] {
  const out: SparseCellWire[] = []
  for (const sheet of state.sheets) {
    out.push(
      ...snapshotRangeSparse(state, {
        sheet: sheet.idx,
        startRow: 0,
        startCol: 0,
        endRow: Number.MAX_SAFE_INTEGER,
        endCol: Number.MAX_SAFE_INTEGER,
      }),
    )
  }
  return out
}

function clearRange(state: RuntimeState, range: SparseRangeWire): number {
  const sheet = assertSheetIdx(state, range.sheet)
  const bounds = clampRangeToSheet(range)
  // W2.4 (audit D-1): ONE engine call that walks the sheet's EXISTING
  // cells intersecting the rect — never the dense coordinate rectangle.
  // A full-column selection (rowEnd = 1_048_575) costs O(existing cells),
  // not ~1M per-coordinate clearCell calls. The returned count is the
  // number of existing cells touched, matching the WASM engine's sparse
  // `clear_range` semantics.
  const cleared = state.workbook.clearRange(sheet.id, bounds, 'all')
  invalidateReadOnMutation(state, sheet.idx)
  return cleared
}

function importCells(state: RuntimeState, cells: ImportCellWire[]): WorkbookImportStatsWire {
  const stats: WorkbookImportStatsWire = {
    accepted: 0,
    formulas: 0,
    rejectedFormulas: 0,
    cleared: 0,
    errors: 0,
  }

  // Group writes by sheet and collapse them into a single `bulkApply`
  // call per sheet. The TS engine's eager-flush behavior re-evaluates
  // every cached formula on each `setCell` write, so a paste of N
  // text cells multiplies into ~N × M formula re-runs. Mirroring WASM's
  // lazy semantics requires that bulk-import perform ONE atom write per
  // sheet, after which a single flush re-evaluates dependents at most
  // once. Cycle detection for formula cells is deferred to first read
  // (it surfaces as `#CIRCULAR!` then) — same lazy contract WASM has.
  //
  // Wire typing (audit C-8, FIXED): non-formula wires are forwarded as
  // TYPED bulk entries (`BulkTypedCellInput`), so the producer's
  // classification survives the bulk fast path exactly like the
  // single-cell `setCell` RPC (which routes through `setCellValue`).
  // Text `'00123'` keeps its leading zeros, text `'TRUE'` stays a
  // string, text `'=A1'` stays literal. Only `kind:'formula'` wires go
  // through the parser via input strings.
  type Batch = {
    sheet: SheetEntry
    inputs: (BulkCellInput | BulkTypedCellInput)[]
    clears: { row: number; col: number }[]
  }
  const batches = new Map<number, Batch>()
  function batchFor(sheetIdx: number): Batch | undefined {
    const sheet = state.sheets[sheetIdx]
    if (!sheet) return undefined
    let batch = batches.get(sheetIdx)
    if (!batch) {
      batch = { sheet, inputs: [], clears: [] }
      batches.set(sheetIdx, batch)
    }
    return batch
  }

  for (const cell of cells) {
    const batch = batchFor(cell.sheet)
    if (!batch) {
      stats.errors += 1
      continue
    }
    try {
      switch (cell.kind) {
        case 'number':
          batch.inputs.push({
            row: cell.row,
            col: cell.col,
            value: { kind: 'number', value: cell.value },
          })
          stats.accepted += 1
          break
        case 'text':
          batch.inputs.push({
            row: cell.row,
            col: cell.col,
            value: { kind: 'string', value: cell.value },
          })
          stats.accepted += 1
          break
        case 'boolean':
          batch.inputs.push({
            row: cell.row,
            col: cell.col,
            value: { kind: 'boolean', value: cell.value },
          })
          stats.accepted += 1
          break
        case 'error':
          batch.inputs.push({
            row: cell.row,
            col: cell.col,
            value: { kind: 'error', code: cell.value as ErrorCode },
          })
          stats.accepted += 1
          break
        case 'formula': {
          const source =
            typeof cell.value === 'string' && cell.value.startsWith('=')
              ? cell.value
              : `=${cell.value}`
          batch.inputs.push({ row: cell.row, col: cell.col, input: source })
          stats.accepted += 1
          stats.formulas += 1
          break
        }
        case 'null':
          batch.clears.push({ row: cell.row, col: cell.col })
          stats.cleared += 1
          break
      }
    } catch {
      stats.errors += 1
    }
  }

  for (const batch of batches.values()) {
    try {
      if (batch.inputs.length > 0) {
        state.workbook.bulkApply(batch.sheet.id, batch.inputs)
      }
      // `clearCell` removes the entry entirely (where bulkApply with an
      // empty input would leave a blank-format-only cell). Walk the
      // clears individually — uncommon path, no batch primitive exists.
      for (const c of batch.clears) {
        state.workbook.clearCell(batch.sheet.id, c.row, c.col, 'all')
      }
      // One coarse read-invalidation per sheet, matching the WASM
      // behavior where bulk import flips every formula on the sheet
      // back to 'dirty' until the host re-observes the cell.
      invalidateReadOnMutation(state, batch.sheet.idx)
    } catch {
      stats.errors += 1
    }
  }

  return stats
}

function exportRangeTsv(state: RuntimeState, range: SparseRangeWire): string {
  // Validate the sheet index up-front so the caller sees a clean error.
  assertSheetIdx(state, range.sheet)
  const cells = snapshotRangeSparse(state, range)
  return sparseRangeToTSV(
    cells.map((c) => ({
      row: c.row,
      col: c.col,
      kind: c.kind,
      value: c.kind === 'formula' ? c.value : (c.value as string | number | boolean),
    })),
    {
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: range.endRow,
      endCol: range.endCol,
    },
  )
}

function registerCustomFormulaInWorker(state: RuntimeState, name: string, source: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    throw rpcError('INVALID_CUSTOM_FORMULA_NAME', 'custom formula name must be a non-empty string')
  }
  if (typeof source !== 'string') {
    throw rpcError('INVALID_CUSTOM_FORMULA_SOURCE', 'custom formula source must be a string')
  }
  // `new Function('args', source)` compiles a host callback. The body
  // sees `args` (a runtime-shaped array — scalars are unwrapped to JS
  // primitives; range args arrive as 2-D JS arrays).
  // eslint-disable-next-line no-new-func
  const compiled = new Function('args', source) as (args: unknown[]) => unknown
  state.customFormulas.set(name.toUpperCase(), source)
  state.workbook.registerCustomFormula(name, (args: Value[]) => {
    const unwrapped = args.map(unwrapForCustom)
    let result: unknown
    try {
      result = compiled(unwrapped)
    } catch (err) {
      return { kind: 'error', code: '#VALUE!', message: err instanceof Error ? err.message : String(err) }
    }
    return wrapCustomResult(result)
  })
  return true
}

function unregisterCustomFormulaInWorker(state: RuntimeState, name: unknown): boolean {
  if (typeof name !== 'string') return false
  state.customFormulas.delete(name.toUpperCase())
  return state.workbook.unregisterCustomFormula(name)
}

/**
 * Wave F follow-up — wire `defineName` from the host through the worker
 * to the engine. The wire `binding` carries lambda bodies as a **formula
 * source string** (AST cannot cross postMessage); we parse the body via
 * `parseFormula` here and forward the resulting `NameBinding`.
 *
 * After registration we bump every sheet via `recalc()` so formulas that
 * already reference the name re-evaluate. Cheap — just a Map clone per
 * sheet — and matches the engine's broad-invalidation discipline (PLAN
 * §4.4).
 */
function defineNameInWorker(state: RuntimeState, name: string, rawBinding: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    throw rpcError('INVALID_NAME', 'name must be a non-empty string')
  }
  if (!rawBinding || typeof rawBinding !== 'object') {
    throw rpcError('INVALID_NAME_BINDING', 'binding must be an object')
  }
  const binding = rawBinding as { kind?: unknown }
  let parsed: NameBinding
  switch (binding.kind) {
    case 'range': {
      const b = rawBinding as { sheetName?: unknown; start?: unknown; end?: unknown }
      if (typeof b.start !== 'string' || typeof b.end !== 'string') {
        throw rpcError('INVALID_NAME_BINDING', 'range binding requires start + end strings')
      }
      parsed = {
        kind: 'range',
        sheetName: typeof b.sheetName === 'string' ? b.sheetName : undefined,
        start: b.start,
        end: b.end,
      }
      break
    }
    case 'value': {
      const b = rawBinding as { literal?: unknown }
      const literal = typeof b.literal === 'string' ? b.literal : String(b.literal ?? '')
      // Inference matches the workbook's literal coercion: prefer numeric,
      // then boolean, then string. Empty string → blank.
      let value: Value
      if (literal.length === 0) {
        value = { kind: 'blank' }
      } else if (/^-?\d+(?:\.\d+)?$/.test(literal)) {
        value = { kind: 'number', value: Number(literal) }
      } else if (literal.toUpperCase() === 'TRUE' || literal.toUpperCase() === 'FALSE') {
        value = { kind: 'boolean', value: literal.toUpperCase() === 'TRUE' }
      } else {
        value = { kind: 'string', value: literal }
      }
      parsed = { kind: 'value', value }
      break
    }
    case 'lambda': {
      const b = rawBinding as { params?: unknown; body?: unknown }
      if (!Array.isArray(b.params) || b.params.some((p) => typeof p !== 'string')) {
        throw rpcError('INVALID_NAME_BINDING', 'lambda binding requires params: string[]')
      }
      if (typeof b.body !== 'string' || b.body.length === 0) {
        throw rpcError('INVALID_NAME_BINDING', 'lambda binding requires body: non-empty string')
      }
      const params = (b.params as string[]).map((p) => p.trim()).filter((p) => p.length > 0)
      // `parseFormula` accepts a source string with or without the leading
      // `=` — the host UI may pass either form. Normalize so the parser
      // sees a formula start.
      const body = b.body.startsWith('=') ? b.body : `=${b.body}`
      let ast
      try {
        ast = parseFormula(body)
      } catch (err) {
        throw rpcError(
          'INVALID_LAMBDA_BODY',
          err instanceof Error ? err.message : `failed to parse lambda body: ${String(err)}`,
        )
      }
      // `parseFormula` is total — it returns an `ErrorLiteral` AST on
      // parse failure instead of throwing. Surface that as a structured
      // RPC error so the host UI can show a meaningful message instead
      // of silently storing a name that always evaluates to `#VALUE!`.
      if (ast.kind === 'error') {
        throw rpcError(
          'INVALID_LAMBDA_BODY',
          `failed to parse lambda body: ${ast.code}`,
        )
      }
      parsed = { kind: 'lambda', params, body: ast }
      break
    }
    default:
      throw rpcError('INVALID_NAME_BINDING', `unknown binding kind: ${String(binding.kind)}`)
  }
  state.workbook.defineName(name, parsed)
  // Force every formula derive to dirty so cells that already reference
  // the new name pick it up. The TS engine's `defineName` itself does not
  // bump any atom (names live outside the sheet atoms), so we must trigger
  // the recompute here.
  state.workbook.recalc()
  return true
}

function undefineNameInWorker(state: RuntimeState, name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  const removed = state.workbook.undefineName(name)
  if (removed) state.workbook.recalc()
  return removed
}

function unwrapForCustom(value: Value): unknown {
  switch (value.kind) {
    case 'blank':
      return null
    case 'number':
    case 'string':
    case 'boolean':
      return value.value
    case 'error':
      return value.code
    case 'array':
      return value.value.map((row) => row.map(unwrapForCustom))
  }
}

function wrapCustomResult(result: unknown): Value {
  if (result === null || result === undefined) return { kind: 'blank' }
  if (typeof result === 'number') return { kind: 'number', value: result }
  if (typeof result === 'boolean') return { kind: 'boolean', value: result }
  if (typeof result === 'string') {
    // Treat strings that match the known error literal set as errors,
    // matching the WASM convention (custom formulas can return
    // '#VALUE!' to surface a deliberate error).
    const match = CUSTOM_FORMULA_ERROR_CODES.find((code) => code === result)
    if (match !== undefined) return { kind: 'error', code: match }
    return { kind: 'string', value: result }
  }
  if (Array.isArray(result)) {
    // 2-D array marshalling.
    const rows: Value[][] = result.map((row) => (Array.isArray(row) ? row.map(wrapCustomResult) : [wrapCustomResult(row)]))
    return { kind: 'array', value: rows }
  }
  return { kind: 'string', value: String(result) }
}

function debugCountersFor(state: RuntimeState) {
  // Mirror the WASM debugCounters shape so tooling reading either
  // backend's payload sees identical keys. Subscription counters,
  // crossSheetDependents, exportSessionCount and snapshotSessionCount
  // remain 0 — those features aren't tracked by the TS runtime, but
  // the wire shape stays stable for the dashboard.
  let formulaCountTotal = 0
  let formulaEvalCountTotal = 0
  const sheets = state.sheets.map((sheet) => {
    const formulaCount = state.workbook.debugFormulaCount(sheet.idx)
    const formulaEvalCount = state.workbook.debugFormulaEvalCount(sheet.idx)
    formulaCountTotal += formulaCount
    formulaEvalCountTotal += formulaEvalCount
    return {
      idx: sheet.idx,
      name: sheet.name,
      formulaCount,
      formulaEvalCount,
      liveSubscriptionCount: 0,
    }
  })
  return {
    sheetCount: state.sheets.length,
    crossSheetDependents: 0,
    formulaCount: formulaCountTotal,
    formulaEvalCountTotal,
    liveSubscriptionCount: 0,
    workerSubscriptionCount: 0,
    importSessionCount: state.importSessions.size,
    exportSessionCount: 0,
    snapshotSessionCount: state.snapshotSessions.size,
    sheets,
  }
}

function emptyFormatSnapshot(range: SparseRangeWire): FormatRangeSnapshot {
  return {
    sheet: range.sheet,
    startRow: range.startRow,
    startCol: range.startCol,
    endRow: range.endRow,
    endCol: range.endCol,
    cellFormats: [],
    rangeFormats: [],
  }
}

const FULL_SHEET_SIZE_BOUND = 0xffffffff

function normalizeDimensionRange(range: SparseRangeWire): SparseRangeWire {
  return {
    sheet: range.sheet,
    startRow: Math.min(range.startRow, range.endRow),
    startCol: Math.min(range.startCol, range.endCol),
    endRow: Math.max(range.startRow, range.endRow),
    endCol: Math.max(range.startCol, range.endCol),
  }
}

function normalizeStructuralIndex(value: unknown, name: string): number {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) {
    throw rpcError('INVALID_STRUCTURAL_EDIT', `invalid ${name}`)
  }
  return index
}

function normalizeDimensionPx(value: unknown, name: string): number {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) {
    throw rpcError('INVALID_DIMENSION_SIZE', `invalid ${name}`)
  }
  return Math.max(1, Math.round(size))
}

function getDimensionMap(
  maps: Map<string, Map<number, number>>,
  sheetName: string,
): Map<number, number> {
  let sizes = maps.get(sheetName)
  if (!sizes) {
    sizes = new Map()
    maps.set(sheetName, sizes)
  }
  return sizes
}

function renameDimensionSheet(
  maps: Map<string, Map<number, number>>,
  oldName: string,
  newName: string,
) {
  if (oldName === newName) return
  const sizes = maps.get(oldName)
  if (!sizes) return
  maps.delete(oldName)
  maps.set(newName, sizes)
}

function sortedDimensionEntries(
  sizes: ReadonlyMap<number, number> | undefined,
  start: number,
  end: number,
): Array<[number, number]> {
  if (!sizes) return []
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  return [...sizes.entries()]
    .filter(([index]) => index >= lo && index <= hi)
    .sort(([a], [b]) => a - b)
}

function rowHeightsFor(
  state: RuntimeState,
  sheet: SheetEntry,
  startRow: number,
  endRow: number,
): ViewportRowHeightWire[] {
  return sortedDimensionEntries(
    state.rowHeightsBySheetName.get(sheet.name),
    startRow,
    endRow,
  ).map(([rowIndex, heightPx]) => ({ rowIndex, heightPx }))
}

function colWidthsFor(
  state: RuntimeState,
  sheet: SheetEntry,
  startCol: number,
  endCol: number,
): ViewportColumnWidthWire[] {
  return sortedDimensionEntries(
    state.colWidthsBySheetName.get(sheet.name),
    startCol,
    endCol,
  ).map(([colIndex, widthPx]) => ({ colIndex, widthPx }))
}

function snapshotViewportSizes(
  state: RuntimeState,
  range: SparseRangeWire,
): ViewportSizeSnapshotWire {
  const sheet = assertSheetIdx(state, range.sheet)
  const normalized = normalizeDimensionRange(range)
  return {
    ...normalized,
    rowHeights: rowHeightsFor(state, sheet, normalized.startRow, normalized.endRow),
    colWidths: colWidthsFor(state, sheet, normalized.startCol, normalized.endCol),
  }
}

function setRowHeight(
  state: RuntimeState,
  sheetValue: unknown,
  rowIndexValue: unknown,
  heightPxValue: unknown,
): boolean {
  const sheet = assertSheetIdx(state, normalizeStructuralIndex(sheetValue, 'sheet index'))
  const rowIndex = normalizeStructuralIndex(rowIndexValue, 'row index')
  const heightPx = normalizeDimensionPx(heightPxValue, 'row height')
  getDimensionMap(state.rowHeightsBySheetName, sheet.name).set(rowIndex, heightPx)
  return true
}

function setColumnWidth(
  state: RuntimeState,
  sheetValue: unknown,
  colIndexValue: unknown,
  widthPxValue: unknown,
): boolean {
  const sheet = assertSheetIdx(state, normalizeStructuralIndex(sheetValue, 'sheet index'))
  const colIndex = normalizeStructuralIndex(colIndexValue, 'column index')
  const widthPx = normalizeDimensionPx(widthPxValue, 'column width')
  getDimensionMap(state.colWidthsBySheetName, sheet.name).set(colIndex, widthPx)
  return true
}

function snapshotPersistenceSizes(state: RuntimeState): ViewportSizeSnapshotWire[] {
  const out: ViewportSizeSnapshotWire[] = []
  for (const sheet of state.sheets) {
    const rowHeights = rowHeightsFor(state, sheet, 0, FULL_SHEET_SIZE_BOUND)
    const colWidths = colWidthsFor(state, sheet, 0, FULL_SHEET_SIZE_BOUND)
    if (rowHeights.length === 0 && colWidths.length === 0) continue
    out.push({
      sheet: sheet.idx,
      startRow: 0,
      startCol: 0,
      endRow: FULL_SHEET_SIZE_BOUND,
      endCol: FULL_SHEET_SIZE_BOUND,
      rowHeights,
      colWidths,
    })
  }
  return out
}

function restorePersistenceSizes(
  state: RuntimeState,
  snapshot: Pick<WorkbookPersistenceSnapshotWire, 'sizes'> | undefined,
) {
  state.rowHeightsBySheetName = new Map()
  state.colWidthsBySheetName = new Map()
  for (const sizeSnapshot of snapshot?.sizes ?? []) {
    const sheet = assertSheetIdx(state, Number(sizeSnapshot.sheet))
    const range = normalizeDimensionRange(normalizeSparseRange(sizeSnapshot))
    for (const row of sizeSnapshot.rowHeights ?? []) {
      const rowIndex = normalizeStructuralIndex(row.rowIndex, 'row index')
      if (rowIndex < range.startRow || rowIndex > range.endRow) {
        throw rpcError('INVALID_DIMENSION_SIZE', `row height outside snapshot range: ${rowIndex}`)
      }
      const heightPx = normalizeDimensionPx(row.heightPx, 'row height')
      getDimensionMap(state.rowHeightsBySheetName, sheet.name).set(rowIndex, heightPx)
    }
    for (const col of sizeSnapshot.colWidths ?? []) {
      const colIndex = normalizeStructuralIndex(col.colIndex, 'column index')
      if (colIndex < range.startCol || colIndex > range.endCol) {
        throw rpcError('INVALID_DIMENSION_SIZE', `column width outside snapshot range: ${colIndex}`)
      }
      const widthPx = normalizeDimensionPx(col.widthPx, 'column width')
      getDimensionMap(state.colWidthsBySheetName, sheet.name).set(colIndex, widthPx)
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface — handle, dispatch, install.
// ---------------------------------------------------------------------------

export interface ExcelCoreTsWorkerRuntime {
  /** Handle one decoded RPC request. Exported for jest tests. */
  handle(msg: RequestMessage): Promise<{ id: number; ok: true; result: unknown } | { id: number; ok: false; error: RpcErrorWire }>
  /** Resets to a fresh empty workbook (mostly for tests). */
  reset(): void
  /** Current state, for tests that need to introspect. */
  state(): RuntimeState
}

export function createWorkerRuntimeTs(): ExcelCoreTsWorkerRuntime {
  let state: RuntimeState = createInitialState()

  function reset() {
    state = createInitialState()
  }

  async function handle(msg: RequestMessage) {
    if (typeof msg.id !== 'number') {
      throw rpcError('INVALID_RPC', 'rpc message missing id')
    }
    const id = msg.id
    try {
      const result = await dispatch(msg)
      return { id, ok: true as const, result }
    } catch (err) {
      const rpcErr: RpcErrorWire =
        err instanceof Error
          ? { code: String((err as Error & { code?: string }).code ?? 'WORKER_ERROR'), message: err.message }
          : { code: 'WORKER_ERROR', message: String(err) }
      return { id, ok: false as const, error: rpcErr }
    }
  }

  async function dispatch(msg: RequestMessage): Promise<unknown> {
    switch (msg.cmd) {
      case 'initWorkbook': {
        const names = Array.isArray(msg.sheets) ? msg.sheets.map(String) : DEFAULT_INITIAL_SHEETS
        const { wb, sheets } = makeWorkbookFor(names)
        state.workbook = wb
        state.sheets = sheets
        state.customFormulas = new Map()
        state.rowHeightsBySheetName = new Map()
        state.colWidthsBySheetName = new Map()
        state.importSessions = new Map()
        state.nextImportSessionId = 1
        state.snapshotSessions = new Map()
        state.nextSnapshotSessionId = 1
        state.readFormulaCells = new Set()
        return listSheetMeta(state)
      }
      case 'sheetList':
        return listSheetMeta(state)
      case 'addSheet': {
        const name = String(msg.name ?? `Sheet${state.sheets.length + 1}`)
        const idx = state.sheets.length
        // TS workbook doesn't have an addSheet helper yet — we re-seed.
        // To preserve identities, rebuild from existing cell maps + the
        // new empty sheet at the end.
        const existingNames = state.sheets.map((s) => s.name)
        const allNames = [...existingNames, name]
        rebuildPreservingCells(state, allNames)
        return idx
      }
      case 'renameSheet': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        const name = String(msg.name ?? '').trim()
        if (name.length === 0) return false
        const oldName = sheet.name
        const allNames = state.sheets.map((s, i) => (i === sheet.idx ? name : s.name))
        rebuildPreservingCells(state, allNames)
        renameDimensionSheet(state.rowHeightsBySheetName, oldName, name)
        renameDimensionSheet(state.colWidthsBySheetName, oldName, name)
        return true
      }
      case 'removeSheet': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        if (state.sheets.length <= 1) return false
        const allNames = state.sheets.filter((s) => s.idx !== sheet.idx).map((s) => s.name)
        rebuildPreservingCells(state, allNames, sheet.idx)
        state.rowHeightsBySheetName.delete(sheet.name)
        state.colWidthsBySheetName.delete(sheet.name)
        return true
      }
      case 'moveSheet': {
        const from = Number(msg.from)
        const to = Number(msg.to)
        assertSheetIdx(state, from)
        if (!Number.isInteger(to) || to < 0 || to >= state.sheets.length) {
          throw rpcError('INVALID_SHEET', `invalid target sheet index: ${to}`)
        }
        if (from === to) return true
        const allNames = state.sheets.map((s) => s.name)
        const [moved] = allNames.splice(from, 1)
        allNames.splice(to, 0, moved)
        rebuildPreservingCells(state, allNames)
        return true
      }
      case 'setCell': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        const coord = parseA1(normalizeAddr(msg.addr))
        if (!coord) throw rpcError('INVALID_ADDR', `invalid cell address: ${String(msg.addr)}`)
        return setCellFromWire(state, sheet, coord.row, coord.col, msg.value as CellWire)
      }
      case 'setFormula':
      case 'setFormulaDetailed': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        const coord = parseA1(normalizeAddr(msg.addr))
        if (!coord) throw rpcError('INVALID_ADDR', `invalid cell address: ${String(msg.addr)}`)
        const result = setFormulaDetailed(state, sheet, coord.row, coord.col, msg.formula)
        if (msg.cmd === 'setFormula') return result.ok
        return result
      }
      case 'clearCell': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        const coord = parseA1(normalizeAddr(msg.addr))
        if (!coord) throw rpcError('INVALID_ADDR', `invalid cell address: ${String(msg.addr)}`)
        clearCell(state, sheet, coord.row, coord.col)
        return true
      }
      case 'clearRange': {
        return clearRange(state, normalizeSparseRange(msg.range))
      }
      case 'insertRows':
      case 'deleteRows':
      case 'insertColumns':
      case 'deleteColumns':
        // Wave E will implement band shifts. For Phase 4, no-op true.
        return true
      case 'setFormatRange':
        // Formats not modelled yet — succeed with 0 cells affected.
        return 0
      case 'snapshotFormatRange':
        return emptyFormatSnapshot(normalizeSparseRange(msg.range))
      case 'restoreFormatSnapshot':
        return 0
      case 'snapshotViewportSizes':
        return snapshotViewportSizes(state, normalizeSparseRange(msg.range))
      case 'setRowHeight':
        return setRowHeight(state, msg.sheet, msg.rowIndex, msg.heightPx)
      case 'setColumnWidth':
        return setColumnWidth(state, msg.sheet, msg.colIndex, msg.widthPx)
      case 'beginImport': {
        const sessionId = Number.isFinite(Number(msg.sessionId))
          ? Number(msg.sessionId)
          : state.nextImportSessionId++
        const mode = (msg.mode === 'direct' ? 'direct' : 'atomic') as 'atomic' | 'direct'
        state.importSessions.set(sessionId, { mode, cells: [] })
        return sessionId
      }
      case 'importChunk': {
        const sessionId = Number(msg.sessionId)
        const session = state.importSessions.get(sessionId)
        if (!session) throw rpcError('INVALID_IMPORT_SESSION', `unknown import session: ${sessionId}`)
        const cells = Array.isArray(msg.cells) ? (msg.cells as ImportCellWire[]) : []
        // Both 'direct' and 'atomic' modes buffer per-chunk cells until
        // commit, then apply them in a single `bulkApply` per sheet. This
        // collapses N atom-writes into one and mirrors WASM's lazy
        // semantics for the eval-count probe: each cached formula
        // re-evaluates at most once per import, regardless of how many
        // chunks the host streamed. The 'direct' vs 'atomic' distinction
        // affects commit stats reporting only — the worker doesn't
        // surface inter-chunk dirty events to the UI either way (see
        // `isMutatingCommand`: `importChunk` is not in the list).
        session.cells.push(...cells)
        return cells.length
      }
      case 'commitImport': {
        const sessionId = Number(msg.sessionId)
        const session = state.importSessions.get(sessionId)
        if (!session) throw rpcError('INVALID_IMPORT_SESSION', `unknown import session: ${sessionId}`)
        state.importSessions.delete(sessionId)
        const stats = importCells(state, session.cells)
        if (session.mode === 'atomic') return stats
        // Direct mode returns an empty stats envelope so the backend can
        // finalize; per-chunk stats accounting isn't exposed by this
        // runtime yet (matches the previous direct-mode contract).
        return { accepted: 0, formulas: 0, rejectedFormulas: 0, cleared: 0, errors: 0 }
      }
      case 'cancelImport': {
        const sessionId = Number(msg.sessionId)
        return state.importSessions.delete(sessionId)
      }
      case 'snapshotSparse':
        return snapshotSparse(state)
      case 'snapshotRangeSparse':
        return snapshotRangeSparse(state, normalizeSparseRange(msg.range))
      case 'readSparseRange':
        return readSparseRange(state, normalizeSparseRange(msg.range))
      case 'readCells': {
        const cells = Array.isArray(msg.cells) ? (msg.cells as CellRefWire[]) : []
        return cells.map((ref) => {
          const sheet = assertSheetIdx(state, Number(ref.sheet))
          const coord = parseA1(normalizeAddr(ref.addr))
          if (!coord) {
            return {
              sheet: sheet.idx,
              addr: normalizeAddr(ref.addr),
              display: '',
              type: 'null' as const,
              isError: false,
              formula: '',
            }
          }
          const snapshot = readCellSnapshot(state, sheet, coord.row, coord.col)
          if (snapshot.formula) {
            state.readFormulaCells.add(makeReadKey(sheet.idx, coord.row, coord.col))
          }
          return snapshot
        })
      }
      case 'listNonEmpty': {
        const out: CellRefWire[] = []
        for (const sheet of state.sheets) {
          const target = state.workbook.sheet(sheet.id)
          if (!target) continue
          const cells = state.workbook.store.getter(target.sheetAtom)
          for (const [key] of cells) {
            const [rowStr, colStr] = key.split(':')
            const coord: CellCoord = { row: Number(rowStr), col: Number(colStr) }
            out.push({ sheet: sheet.idx, addr: formatA1(coord) })
          }
        }
        return out
      }
      case 'restoreSparse': {
        const cells = Array.isArray(msg.cells) ? (msg.cells as SparseCellWire[]) : []
        const importable: ImportCellWire[] = cells.map((c) => {
          switch (c.kind) {
            case 'formula':
              return { sheet: c.sheet, row: c.row, col: c.col, kind: 'formula', value: c.value }
            case 'number':
              return { sheet: c.sheet, row: c.row, col: c.col, kind: 'number', value: c.value }
            case 'text':
              return { sheet: c.sheet, row: c.row, col: c.col, kind: 'text', value: c.value }
            case 'boolean':
              return { sheet: c.sheet, row: c.row, col: c.col, kind: 'boolean', value: c.value }
            case 'error':
              return { sheet: c.sheet, row: c.row, col: c.col, kind: 'error', value: c.value }
          }
        })
        importCells(state, importable)
        return importable.length
      }
      case 'exportRangeTsv':
        return exportRangeTsv(state, normalizeSparseRange(msg.range))
      case 'beginExportRangeTsv': {
        // Single-chunk fallback — emit the whole rectangle in one go.
        return {
          sessionId: 1,
          totalRows: Math.max(0, Number(normalizeSparseRange(msg.range).endRow) - Number(normalizeSparseRange(msg.range).startRow) + 1),
          rowsPerChunk: 1024,
        }
      }
      case 'nextExportRangeTsvChunk': {
        // Stubbed: emit empty chunk with done=true so callers wind down.
        return { sessionId: Number(msg.sessionId), startRow: 0, endRow: 0, chunk: '', done: true }
      }
      case 'cancelExport':
        return true
      case 'cancelSnapshot': {
        const sessionId = Number(msg.sessionId)
        const existed = state.snapshotSessions.delete(sessionId)
        return existed
      }
      case 'beginSnapshotRangeSparse': {
        const range = normalizeSparseRange(msg.range)
        assertSheetIdx(state, range.sheet)
        const rowsPerChunk = clampRowsPerChunk(msg.rowsPerChunk)
        const totalRows = rangeTotalRows(range)
        const sessionId = state.nextSnapshotSessionId++
        state.snapshotSessions.set(sessionId, {
          range,
          rowsPerChunk,
          totalRows,
          nextRow: range.startRow,
        })
        return { sessionId, totalRows, rowsPerChunk }
      }
      case 'nextSnapshotRangeSparseChunk': {
        const sessionId = Number(msg.sessionId)
        const session = state.snapshotSessions.get(sessionId)
        if (!session) {
          throw rpcError('SNAPSHOT_SESSION_MISSING', `missing snapshot session: ${sessionId}`)
        }
        const { range } = session
        if (session.totalRows === 0 || session.nextRow > range.endRow) {
          state.snapshotSessions.delete(sessionId)
          return {
            sessionId,
            startRow: range.startRow,
            endRow: range.startRow - 1,
            cells: [],
            done: true,
          }
        }
        const startRow = session.nextRow
        const endRow = Math.min(range.endRow, startRow + session.rowsPerChunk - 1)
        const cells = snapshotRangeSparse(state, {
          sheet: range.sheet,
          startRow,
          startCol: range.startCol,
          endRow,
          endCol: range.endCol,
        })
        session.nextRow = endRow + 1
        const done = session.nextRow > range.endRow
        if (done) state.snapshotSessions.delete(sessionId)
        return { sessionId, startRow, endRow, cells, done }
      }
      case 'snapshotPersistenceV1':
        return {
          version: 1 as const,
          sheets: state.sheets.map((s) => ({ idx: s.idx, name: s.name })),
          cells: snapshotSparse(state),
          sizes: snapshotPersistenceSizes(state),
        }
      case 'restorePersistenceV1':
        // Reset + restore.
        {
          const snapshot = msg.snapshot as WorkbookPersistenceSnapshotWire | undefined
          const names = snapshot?.sheets?.map((s) => s.name) ?? DEFAULT_INITIAL_SHEETS
          const { wb, sheets } = makeWorkbookFor(names)
          state.workbook = wb
          state.sheets = sheets
          state.customFormulas = new Map()
          state.rowHeightsBySheetName = new Map()
          state.colWidthsBySheetName = new Map()
          state.importSessions = new Map()
          state.snapshotSessions = new Map()
          state.nextSnapshotSessionId = 1
          state.readFormulaCells = new Set()
          const cells = snapshot?.cells ?? []
          const importable: ImportCellWire[] = cells.map((c) => {
            switch (c.kind) {
              case 'formula':
                return { sheet: c.sheet, row: c.row, col: c.col, kind: 'formula', value: c.value }
              case 'number':
                return { sheet: c.sheet, row: c.row, col: c.col, kind: 'number', value: c.value }
              case 'text':
                return { sheet: c.sheet, row: c.row, col: c.col, kind: 'text', value: c.value }
              case 'boolean':
                return { sheet: c.sheet, row: c.row, col: c.col, kind: 'boolean', value: c.value }
              case 'error':
                return { sheet: c.sheet, row: c.row, col: c.col, kind: 'error', value: c.value }
            }
          })
          importCells(state, importable)
          restorePersistenceSizes(state, snapshot)
          return { restored_cells: importable.length, restored_formats: 0, sheets: state.sheets.length }
        }
      case 'subscribeCells':
        // No fine-grained sub propagation in Phase 4 — just acknowledge.
        return true
      case 'unsubscribeCells':
        return true
      case 'registerCustomFormula':
        return registerCustomFormulaInWorker(state, String(msg.name ?? ''), String(msg.source ?? ''))
      case 'unregisterCustomFormula':
        return unregisterCustomFormulaInWorker(state, msg.name)
      case 'defineName':
        return defineNameInWorker(state, String(msg.name ?? ''), msg.binding)
      case 'undefineName':
        return undefineNameInWorker(state, String(msg.name ?? ''))
      case 'debugCounters':
        return debugCountersFor(state)
      case 'debugFormulaCacheState': {
        // The TS engine evaluates formulas eagerly the first time their
        // atom is read — including the internal cycle-check read in
        // `setFormulaDetailed`. By the time the host probes the cell, the
        // engine has already stamped it 'clean'. The WASM engine doesn't:
        // it has a true dirty/clean state machine driven by writes and
        // reads.
        //
        // To match WASM semantics at the worker boundary we override the
        // engine's 'clean' to 'dirty' for any formula cell the host hasn't
        // observed via a client-facing read RPC since the last write. The
        // override is purely a probe-shape simulation — the engine itself
        // still operates eagerly. Other workbook states ('none',
        // 'computing', 'invalid', or 'dirty') pass through unchanged.
        const sheetIdx = Number(msg.sheet)
        const addrStr = String(msg.addr ?? '')
        const engineState = state.workbook.debugFormulaCacheState(sheetIdx, addrStr)
        // 'none' (literal/empty), 'invalid' (bad addr/sheet), and
        // 'computing' (mid-evaluation) pass through unchanged — those
        // shapes don't fit the dirty/clean dichotomy this override
        // simulates. Only 'clean' / 'dirty' from the engine are
        // reinterpreted via the host-read set.
        if (engineState === 'none' || engineState === 'invalid' || engineState === 'computing') {
          return engineState
        }
        const coord = parseA1(addrStr)
        if (!coord) return engineState
        // Engine reports a real formula cell ('clean' or 'dirty'). The
        // engine's stamp doesn't always refresh on read — a cached derive
        // whose deps didn't change returns the cached value WITHOUT
        // re-running the derive, so `lastEvalRevision` stays stale and
        // the engine still says 'dirty' even though the value is valid.
        // We use the host-read set as the authoritative observation
        // signal: if the host has read the cell since the last mutation
        // on this sheet, the host has observed a value the engine just
        // produced → 'clean'. Otherwise 'dirty'.
        const key = makeReadKey(sheetIdx, coord.row, coord.col)
        return state.readFormulaCells.has(key) ? 'clean' : 'dirty'
      }
      case 'debugFormulaEvalCount':
        return state.workbook.debugFormulaEvalCount(Number(msg.sheet))
      default:
        throw rpcError('UNKNOWN_COMMAND', `unknown command: ${String(msg.cmd)}`)
    }
  }

  return {
    handle,
    reset,
    state: () => state,
  }
}

/**
 * Rebuild the workbook preserving cell content from sheets that survive.
 * Used for addSheet / removeSheet / renameSheet / moveSheet since the TS
 * workbook factory doesn't yet expose live structural mutations.
 *
 * `removedIdx` (if provided) is the original idx of a sheet being dropped.
 */
function rebuildPreservingCells(
  state: RuntimeState,
  nextNames: ReadonlyArray<string>,
  removedIdx?: number,
) {
  // Snapshot the cell maps from the surviving sheets.
  const previousSheets = state.sheets
  const previousWorkbook = state.workbook
  const cellsBySheetName = new Map<string, ReadonlyMap<string, Cell>>()
  for (const sheet of previousSheets) {
    if (removedIdx !== undefined && sheet.idx === removedIdx) continue
    const handle = previousWorkbook.sheet(sheet.id)
    if (!handle) continue
    cellsBySheetName.set(sheet.name, previousWorkbook.store.getter(handle.sheetAtom))
  }

  const { wb, sheets } = makeWorkbookFor(nextNames)
  state.workbook = wb
  state.sheets = sheets

  // Re-apply each surviving sheet's cells under its (renamed) sheet id.
  // We key by NAME — never by positional index — because move/reorder
  // changes positions but keeps names. Zipping `survivingPreviousNames`
  // against `nextNames` by index would swap contents on a move.
  for (const newSheet of sheets) {
    const oldCells = cellsBySheetName.get(newSheet.name)
    if (!oldCells || oldCells.size === 0) continue
    const inputs: (BulkCellInput | BulkTypedCellInput)[] = []
    for (const [key, cell] of oldCells) {
      const [rowStr, colStr] = key.split(':')
      const row = Number(rowStr)
      const col = Number(colStr)
      // Formulas re-parse from source; literals carry their TYPED value
      // (audit C-8) so a sheet op cannot re-classify e.g. a text cell
      // '00123' into number 123 through parseLiteral.
      if (cell.ast) {
        inputs.push({ row, col, input: cell.input })
      } else {
        inputs.push({ row, col, value: cell.value })
      }
    }
    state.workbook.bulkApply(newSheet.id, inputs)
  }

  // Audit D-5: the rebuild swapped in a FRESH workbook — every cached
  // formula value was dropped and sheet indices may have shifted. Sheet-
  // index-keyed host state must not survive the op:
  //  - `readFormulaCells`: stale `${oldIdx}:r:c` keys would make
  //    `debugFormulaCacheState` report 'clean' for a never-observed
  //    formula on whichever sheet shifted into the old slot.
  //  - `importSessions`: staged `ImportCellWire.sheet` indices would
  //    land buffered cells on the wrong sheet at commit.
  //  - `snapshotSessions`: in-flight chunk cursors would read the wrong
  //    sheet's rows in later chunks.
  // Dropping the sessions makes the next session RPC fail loudly with
  // INVALID_IMPORT_SESSION / SNAPSHOT_SESSION_MISSING so the host
  // restarts against the new sheet layout. The session-id counters keep
  // counting up, so a stale id can never collide with a new session.
  state.readFormulaCells = new Set()
  state.importSessions = new Map()
  state.snapshotSessions = new Map()

  // Restore custom formulas on the new workbook (they live on the
  // workbook handle, not the sheets).
  for (const [name, source] of state.customFormulas) {
    try {
      registerCustomFormulaInWorker(state, name, source)
    } catch {
      // Ignore — keep previous registration semantics best-effort.
    }
  }
}

/**
 * Install the runtime against the host worker context. Decodes incoming
 * `message` events, dispatches via `handle`, and replies via
 * `postMessage` using the standard `RpcResponseWire` envelope.
 */
export function installWorkerRuntimeTs(target?: WorkerContext): ExcelCoreTsWorkerRuntime {
  const runtime = createWorkerRuntimeTs()
  const ctx: WorkerContext = target ?? (self as unknown as WorkerContext)
  ctx.addEventListener('message', async (e: MessageEvent) => {
    const msg = e.data as RequestMessage
    if (typeof msg.id !== 'number') return
    const response = await runtime.handle(msg)
    const wire: RpcResponseWire = response.ok
      ? { id: response.id, ok: true, result: response.result }
      : { id: response.id, ok: false, error: response.error }
    ctx.postMessage(wire)

    // Coarse cellsDirty broadcast on mutating commands. The
    // WorkerWorkbookClient uses cellsDirty as a refresh trigger; the UI
    // refetches the projection on every dirty event, so we don't need
    // fine-grained per-cell delta yet.
    if (response.ok && isMutatingCommand(msg.cmd)) {
      const sheet = Number((msg as { sheet?: unknown }).sheet ?? 0)
      const addr = typeof (msg as { addr?: unknown }).addr === 'string' ? normalizeAddr((msg as { addr: string }).addr) : 'A1'
      ctx.postMessage({ event: 'cellsDirty', cells: [{ sheet, addr }] })
    }
  })

  return runtime
}

function isMutatingCommand(cmd: unknown): boolean {
  return (
    cmd === 'setCell' ||
    cmd === 'setFormula' ||
    cmd === 'setFormulaDetailed' ||
    cmd === 'clearCell' ||
    cmd === 'clearRange' ||
    cmd === 'commitImport' ||
    cmd === 'restoreSparse' ||
    cmd === 'restorePersistenceV1' ||
    cmd === 'insertRows' ||
    cmd === 'deleteRows' ||
    cmd === 'insertColumns' ||
    cmd === 'deleteColumns' ||
    cmd === 'addSheet' ||
    cmd === 'removeSheet' ||
    cmd === 'renameSheet' ||
    cmd === 'moveSheet' ||
    cmd === 'defineName' ||
    cmd === 'undefineName'
  )
}

// Convenience re-exports for callers that just want to consume the
// runtime in-process (e.g. jest tests).
export { createInitialState as __createInitialStateForTest }
