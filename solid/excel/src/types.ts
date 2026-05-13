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

/** Wire-format for a per-cell style. Mirrors the Rust `CellFormatJSON`. */
export interface CellFormatJSON {
  numberFormat?: NumberFormatJSON
  bold?: boolean
  italic?: boolean
  align?: 'default' | 'left' | 'center' | 'right'
  fontSize?: number
  /** Foreground / text color. */
  fgColor?: string
  /** Background color. */
  bgColor?: string
}

export interface NumberFormatJSON {
  kind: 'general' | 'decimal' | 'percent' | 'currency' | 'date'
  digits?: number
  symbol?: string
  pattern?: string
  thousands?: boolean
}

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
  if (ak === 'decimal') {
    return (a?.digits ?? 2) === (b?.digits ?? 2) && !!a?.thousands === !!b?.thousands
  }
  if (ak === 'percent') return (a?.digits ?? 0) === (b?.digits ?? 0)
  if (ak === 'currency') {
    return (a?.digits ?? 2) === (b?.digits ?? 2) && (a?.symbol ?? '$') === (b?.symbol ?? '$')
  }
  if (ak === 'date') {
    return (a?.pattern ?? 'yyyy-mm-dd') === (b?.pattern ?? 'yyyy-mm-dd')
  }
  return true
}
