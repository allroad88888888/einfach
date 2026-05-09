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
  /** Returns false if the formula failed to parse or would cycle. */
  set_formula(addr: string, formula: string): boolean
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
   * Structural edits (phase 4 backend). All update referenced formulas to
   * follow the data; references inside the deleted band become #REF!.
   */
  insert_row?(at: number, count: number): void
  delete_row?(at: number, count: number): void
  insert_col?(at: number, count: number): void
  delete_col?(at: number, count: number): void
}

export type CellValue = {
  display: string
  type: 'number' | 'text' | 'boolean' | 'null' | 'error'
  isError: boolean
}
