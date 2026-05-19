/**
 * Interface matching the WasmSheet API from einfach-wasm.
 *
 * Two implementations are expected:
 *   - createWasmSheet(): real Rust + WASM backend (production)
 *   - createJSSheet():    pure JS mock used in jest tests / dev fallback
 */
export interface ISheet {
  set_number(addr: string, value: number): void
  set_text(addr: string, value: string): void
  set_boolean?(addr: string, value: boolean): void
  set_error?(addr: string, value: string): void
  /** Returns false if the formula failed to parse or would cycle. */
  set_formula(addr: string, formula: string): boolean
  /** Generalized formula commit result for authoritative backends. */
  set_formula_detailed_async?(
    addr: string,
    formula: string,
  ): Promise<FormulaMutationResult>
  /**
   * Optional authoritative formula mutation. Worker-backed sheets use this
   * to surface parse/cycle rejection after the worker reply instead of
   * permanently reporting optimistic success through the synchronous
   * compatibility method.
   */
  set_formula_async?(addr: string, formula: string): Promise<boolean>
  get_display(addr: string): string
  get_number(addr: string): number
  get_type(addr: string): string
  is_error(addr: string): boolean
  /**
   * Original formula text, or empty string for non-formula cells.
   * Required by the Cell edit flow so users edit `=A1*2`, not `20` (D.11).
   */
  get_formula(addr: string): string
  /**
   * Subscribe to value changes on a cell. Returns an opaque token to pass
   * to `unsubscribe`. The callback fires whenever the cell's value
   * changes — including transitively through formula dependencies.
   */
  subscribe(addr: string, callback: () => void): number
  unsubscribe(token: number): void
  /** Clear a cell back to its initial empty / Null state. */
  clear_cell(addr: string): void
  /**
   * Optional range-native clear. Coordinates are zero-based and inclusive.
   * Backends that implement this must scan sparse state rather than
   * expecting the UI to materialize every address in the rectangle.
   */
  clear_range?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): number | void | Promise<number | void>
  /**
   * Optional no-eval sparse range snapshot. Used for large-range undo so the
   * UI records only non-empty cells and formula sources without forcing
   * formula calculation.
   */
  snapshot_range_sparse?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): SparseCellSnapshot[] | Promise<SparseCellSnapshot[]>
  /**
   * Optional range-native clipboard export. Coordinates are zero-based and
   * inclusive. Implementations should stream/scan sparse backend state and
   * preserve formula sources without evaluating lazy formulas.
   */
  export_range_tsv?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): string | Promise<string>
  /**
   * Optional chunked TSV export. Chunks are row-aligned and should be
   * concatenated with a single "\n" between adjacent chunks. This is a
   * non-transactional read unless the backend explicitly freezes writes
   * for the export session.
   */
  export_range_tsv_chunks?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    rowsPerChunk?: number,
  ): string[] | Promise<string[]>
  /** Restore records produced by `snapshot_range_sparse`. */
  restore_sparse?(cells: SparseCellSnapshot[]): number | void | Promise<number | void>
  /**
   * Structural edits (phase 4 backend). All update referenced formulas to
   * follow the data; references inside the deleted band become #REF!.
   */
  insert_row?(at: number, count: number): void
  delete_row?(at: number, count: number): void
  insert_col?(at: number, count: number): void
  delete_col?(at: number, count: number): void
  /**
   * Debug-only (WasmSheet only): arm a one-shot panic in the next
   * subscriber callback. Used by `regression.spec.ts` (Discovered #E.2)
   * to verify console_error_panic_hook surfaces panics without taking
   * down the wasm instance. Absent on JS mock.
   */
  __debugPanicNextCallback?(): void
  /**
   * Every address with either a primitive value or a formula. Empty
   * cells are skipped. Used by structural-undo (see
   * `docs/STRUCTURAL_UNDO.md`) to snapshot only what needs restoring.
   */
  non_empty_addrs?(): string[]

  // === Phase 6 — cell formatting ===

  /** Apply a format to a cell. Pass `undefined` / `null` / `{}` to clear. */
  set_format?(addr: string, fmt: CellFormatJSON | null | undefined): void
  /**
   * Optional range-native format. Coordinates are zero-based and inclusive.
   * Implementations must keep this sparse/range-backed and must not require
   * callers to materialize every address in a large rectangle.
   */
  set_format_range?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fmt: CellFormatJSON | null | undefined,
  ): number | void | Promise<number | void>
  /** Snapshot sparse formatting metadata for large-range undo. */
  snapshot_format_range?(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): FormatRangeSnapshot | Promise<FormatRangeSnapshot>
  /** Restore records produced by `snapshot_format_range`. */
  restore_format_snapshot?(
    snapshot: FormatRangeSnapshot,
  ): number | void | Promise<number | void>
  /** Base format (no conditional rule overrides). */
  get_format?(addr: string): CellFormatJSON
  /** Base + first matching conditional rule. */
  get_effective_format?(addr: string): CellFormatJSON
  /**
   * Display string with the effective format applied. Returns the same as
   * `get_display` for non-numeric cells; numeric cells are routed through
   * the number-format formatter.
   */
  formatted_display?(addr: string): string

  /**
   * Optional teardown. The in-process backends (WasmSheet, createJSSheet)
   * have nothing to clean up — JS GC handles them once the sheet falls
   * out of scope — but the worker proxy needs an explicit termination:
   * remove the message listener, clear the address/subscription maps,
   * and call `worker.terminate()`. `SheetStore.dispose` forwards here.
   */
  dispose?(): void
}

export type FormulaMutationErrorCode = 'INVALID_FORMULA' | 'FORMULA_CYCLE' | 'FORMULA_REJECTED'

export type FormulaMutationResult =
  | { ok: true }
  | { ok: false; code: FormulaMutationErrorCode; message: string; display?: string }

export type CellValue = {
  display: string
  type: 'number' | 'text' | 'boolean' | 'null' | 'error'
  isError: boolean
}

export type SparseCellSnapshot =
  | { addr: string; row: number; col: number; kind: 'number'; value: number }
  | { addr: string; row: number; col: number; kind: 'text'; value: string }
  | { addr: string; row: number; col: number; kind: 'boolean'; value: boolean }
  | { addr: string; row: number; col: number; kind: 'error'; value: string }
  | { addr: string; row: number; col: number; kind: 'formula'; value: string }

export interface CellFormatSnapshot {
  addr: string
  format: CellFormatJSON
}

export interface RangeFormatLayerSnapshot {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  format: CellFormatJSON
}

export interface FormatRangeSnapshot {
  sheet?: number
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  cellFormats: CellFormatSnapshot[]
  rangeFormats: RangeFormatLayerSnapshot[]
}

/** Wire-format for a per-cell style. Mirrors the Rust `CellFormatJSON`. */
export interface CellFormatJSON {
  numberFormat?: NumberFormatJSON
  bold?: boolean
  italic?: boolean
  align?: 'default' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'distributed'
  fontSize?: number
  /** Foreground / text color. */
  fgColor?: string
  /** Background color. */
  bgColor?: string
}

/**
 * Wave 6.3 widening: `NumberFormatJSON` now mirrors the canonical
 * `SpreadsheetNumberFormat` discriminated union from `@einfach/spreadsheet-ui-core`.
 * The alias is kept so existing call sites continue to compile.
 */
export type NumberFormatJSON =
  import('@einfach/spreadsheet-ui-core').SpreadsheetNumberFormat

/** Empty format → equivalent to the default (no styling, General number). */
export const EMPTY_FORMAT: CellFormatJSON = {}

/** True when both formats produce identical styling. Order-independent. */
export function formatsEqual(a: CellFormatJSON, b: CellFormatJSON): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    (a.align ?? 'default') === (b.align ?? 'default') &&
    (a.fgColor ?? '') === (b.fgColor ?? '') &&
    (a.bgColor ?? '') === (b.bgColor ?? '') &&
    numberFormatsEqual(a.numberFormat, b.numberFormat)
  )
}

function numberFormatsEqual(a?: NumberFormatJSON, b?: NumberFormatJSON): boolean {
  const ak = a?.kind ?? 'general'
  const bk = b?.kind ?? 'general'
  if (ak !== bk) return false
  // Use a loose any-cast for property comparison; the discriminant gate above
  // already guarantees both variants carry the same optional fields.
  const av = a as unknown as Record<string, unknown> | undefined
  const bv = b as unknown as Record<string, unknown> | undefined
  if (ak === 'decimal' || ak === 'number') {
    return (
      ((av?.digits as number | undefined) ?? 2) === ((bv?.digits as number | undefined) ?? 2) &&
      !!av?.thousands === !!bv?.thousands
    )
  }
  if (ak === 'percent' || ak === 'percentage') {
    return ((av?.digits as number | undefined) ?? 0) === ((bv?.digits as number | undefined) ?? 0)
  }
  if (ak === 'currency') {
    return (
      ((av?.digits as number | undefined) ?? 2) === ((bv?.digits as number | undefined) ?? 2) &&
      ((av?.symbol as string | undefined) ?? '$') === ((bv?.symbol as string | undefined) ?? '$')
    )
  }
  if (ak === 'accounting') {
    return (
      ((av?.digits as number | undefined) ?? 2) === ((bv?.digits as number | undefined) ?? 2) &&
      ((av?.symbol as string | undefined) ?? '$') === ((bv?.symbol as string | undefined) ?? '$')
    )
  }
  if (ak === 'date') {
    return (
      ((av?.pattern as string | undefined) ?? 'yyyy-mm-dd') ===
      ((bv?.pattern as string | undefined) ?? 'yyyy-mm-dd')
    )
  }
  if (ak === 'time') {
    return (
      ((av?.pattern as string | undefined) ?? 'hh:mm:ss') ===
      ((bv?.pattern as string | undefined) ?? 'hh:mm:ss')
    )
  }
  if (ak === 'fraction') {
    return (av?.denominator ?? 'one-digit') === (bv?.denominator ?? 'one-digit')
  }
  if (ak === 'scientific') {
    return ((av?.digits as number | undefined) ?? 2) === ((bv?.digits as number | undefined) ?? 2)
  }
  if (ak === 'special') {
    return (av?.preset as string | undefined) === (bv?.preset as string | undefined)
  }
  if (ak === 'custom') {
    return (av?.pattern as string | undefined) === (bv?.pattern as string | undefined)
  }
  return true
}
