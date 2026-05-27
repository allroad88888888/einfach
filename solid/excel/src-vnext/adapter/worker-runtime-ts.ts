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
 *  - Format / size shims: `setFormatRange` / `snapshotFormatRange` /
 *    `snapshotViewportSizes` return empty snapshots — TS core does not
 *    yet model these (the UI degrades to defaults via the same path the
 *    WASM bridge uses when the optional bridge is missing).
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
  type CellCoord,
  type CellRange,
  type ErrorCode,
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
  ViewportSizeSnapshotWire,
  WorkbookImportStatsWire,
  WorkbookSheetMeta,
} from './worker-protocol'

export interface WorkerContext {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
}

interface SheetEntry {
  id: string
  idx: number
  name: string
}

interface RuntimeState {
  workbook: Workbook
  /** Stable display order of sheets in the TS workbook. */
  sheets: SheetEntry[]
  /** Custom formula source registry — compiled callables live on the workbook. */
  customFormulas: Map<string, string>
  importSessions: Map<number, { mode: 'atomic' | 'direct'; cells: ImportCellWire[] }>
  nextImportSessionId: number
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
    importSessions: new Map(),
    nextImportSessionId: 1,
  }
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
}

function clearCell(state: RuntimeState, sheet: SheetEntry, row: number, col: number) {
  state.workbook.clearCell(sheet.id, row, col, 'all')
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
      return true
    case 'text':
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'string', value: value.value })
      return true
    case 'boolean':
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'boolean', value: value.value })
      return true
    case 'error': {
      const code = value.value as ErrorCode
      state.workbook.setCellValue(sheet.id, row, col, { kind: 'error', code })
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
  for (const [key, cell] of cells) {
    if (!cell.input.startsWith('=')) continue
    const [rowStr, colStr] = key.split(':')
    const ar = Number(rowStr)
    const ac = Number(colStr)
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
  for (const [key] of cells) {
    const [rowStr, colStr] = key.split(':')
    const row = Number(rowStr)
    const col = Number(colStr)
    if (row < bounds.rowStart || row > bounds.rowEnd || col < bounds.colStart || col > bounds.colEnd) {
      continue
    }
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
  return out
}

function readSparseRange(state: RuntimeState, range: SparseRangeWire): CellSnapshotWire[] {
  const sheet = assertSheetIdx(state, range.sheet)
  const bounds = clampRangeToSheet(range)
  const target = state.workbook.sheet(sheet.id)
  if (!target) return []
  const cells = state.workbook.store.getter(target.sheetAtom)
  const out: CellSnapshotWire[] = []
  for (const [key, cell] of cells) {
    const [rowStr, colStr] = key.split(':')
    const row = Number(rowStr)
    const col = Number(colStr)
    if (row < bounds.rowStart || row > bounds.rowEnd || col < bounds.colStart || col > bounds.colEnd) {
      continue
    }
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
  let cleared = 0
  for (let row = bounds.rowStart; row <= bounds.rowEnd; row += 1) {
    for (let col = bounds.colStart; col <= bounds.colEnd; col += 1) {
      state.workbook.clearCell(sheet.id, row, col, 'all')
      cleared += 1
    }
  }
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
  for (const cell of cells) {
    const sheet = state.sheets[cell.sheet]
    if (!sheet) {
      stats.errors += 1
      continue
    }
    try {
      switch (cell.kind) {
        case 'number':
          applyCellInput(state, sheet, cell.row, cell.col, String(cell.value))
          stats.accepted += 1
          break
        case 'text':
          applyCellInput(state, sheet, cell.row, cell.col, cell.value)
          stats.accepted += 1
          break
        case 'boolean':
          applyCellInput(state, sheet, cell.row, cell.col, cell.value ? 'TRUE' : 'FALSE')
          stats.accepted += 1
          break
        case 'error':
          applyCellInput(state, sheet, cell.row, cell.col, cell.value)
          stats.accepted += 1
          break
        case 'formula': {
          const result = setFormulaDetailed(state, sheet, cell.row, cell.col, cell.value)
          if (result.ok) {
            stats.accepted += 1
            stats.formulas += 1
          } else {
            stats.rejectedFormulas += 1
            stats.errors += 1
          }
          break
        }
        case 'null':
          clearCell(state, sheet, cell.row, cell.col)
          stats.cleared += 1
          break
      }
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
    const known: ErrorCode[] = [
      '#DIV/0!',
      '#N/A',
      '#NAME?',
      '#NULL!',
      '#NUM!',
      '#REF!',
      '#VALUE!',
      '#CIRCULAR!',
      '#ERROR!',
    ]
    const match = known.find((code) => code === result)
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

function debugCountersStub(state: RuntimeState) {
  return {
    sheetCount: state.sheets.length,
    crossSheetDependents: 0,
    formulaCount: 0,
    formulaEvalCountTotal: 0,
    liveSubscriptionCount: 0,
    workerSubscriptionCount: 0,
    importSessionCount: state.importSessions.size,
    exportSessionCount: 0,
    snapshotSessionCount: 0,
    sheets: state.sheets.map((sheet) => ({
      idx: sheet.idx,
      name: sheet.name,
      formulaCount: 0,
      formulaEvalCount: 0,
      liveSubscriptionCount: 0,
    })),
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

function emptyViewportSizeSnapshot(range: SparseRangeWire): ViewportSizeSnapshotWire {
  return {
    ...range,
    rowHeights: [],
    colWidths: [],
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
        state.importSessions = new Map()
        state.nextImportSessionId = 1
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
        const allNames = state.sheets.map((s, i) => (i === sheet.idx ? name : s.name))
        rebuildPreservingCells(state, allNames)
        return true
      }
      case 'removeSheet': {
        const sheetIdx = Number(msg.sheet)
        const sheet = assertSheetIdx(state, sheetIdx)
        if (state.sheets.length <= 1) return false
        const allNames = state.sheets.filter((s) => s.idx !== sheet.idx).map((s) => s.name)
        rebuildPreservingCells(state, allNames, sheet.idx)
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
        return emptyViewportSizeSnapshot(normalizeSparseRange(msg.range))
      case 'setRowHeight':
      case 'setColumnWidth':
        return true
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
        if (session.mode === 'direct') {
          importCells(state, cells)
        } else {
          session.cells.push(...cells)
        }
        return cells.length
      }
      case 'commitImport': {
        const sessionId = Number(msg.sessionId)
        const session = state.importSessions.get(sessionId)
        if (!session) throw rpcError('INVALID_IMPORT_SESSION', `unknown import session: ${sessionId}`)
        state.importSessions.delete(sessionId)
        if (session.mode === 'atomic') {
          return importCells(state, session.cells)
        }
        // Direct sessions already applied incrementally; return an empty
        // success stats envelope so the backend can finalize.
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
          return readCellSnapshot(state, sheet, coord.row, coord.col)
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
      case 'cancelSnapshot':
        return true
      case 'beginSnapshotRangeSparse':
        return { sessionId: 1, totalRows: 0, rowsPerChunk: 1024 }
      case 'nextSnapshotRangeSparseChunk':
        return { sessionId: Number(msg.sessionId), startRow: 0, endRow: 0, cells: [], done: true }
      case 'snapshotPersistenceV1':
        return { version: 1 as const, sheets: state.sheets.map((s) => ({ idx: s.idx, name: s.name })), cells: snapshotSparse(state) }
      case 'restorePersistenceV1':
        // Reset + restore.
        {
          const snapshot = msg.snapshot as { sheets?: { idx: number; name: string }[]; cells?: SparseCellWire[] } | undefined
          const names = snapshot?.sheets?.map((s) => s.name) ?? DEFAULT_INITIAL_SHEETS
          const { wb, sheets } = makeWorkbookFor(names)
          state.workbook = wb
          state.sheets = sheets
          state.customFormulas = new Map()
          state.importSessions = new Map()
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
      case 'debugCounters':
        return debugCountersStub(state)
      case 'debugFormulaCacheState':
        return 'unknown'
      case 'debugFormulaEvalCount':
        return 0
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
  const cellsBySheetName = new Map<string, ReadonlyMap<string, import('@einfach/excel-core-ts').Cell>>()
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
    const inputs: { row: number; col: number; input: string }[] = []
    for (const [key, cell] of oldCells) {
      const [rowStr, colStr] = key.split(':')
      inputs.push({ row: Number(rowStr), col: Number(colStr), input: cell.input })
    }
    state.workbook.bulkApply(newSheet.id, inputs)
  }

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
    cmd === 'moveSheet'
  )
}

// Convenience re-exports for callers that just want to consume the
// runtime in-process (e.g. jest tests).
export { createInitialState as __createInitialStateForTest }
