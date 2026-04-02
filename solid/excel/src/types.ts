/** Interface matching the WasmSheet API from einfach-wasm */
export interface ISheet {
  set_number(addr: string, value: number): void
  set_text(addr: string, value: string): void
  set_formula(addr: string, formula: string): void
  get_display(addr: string): string
  get_number(addr: string): number
  get_type(addr: string): string
  is_error(addr: string): boolean
}

export type CellValue = {
  display: string
  type: 'number' | 'text' | 'boolean' | 'null' | 'error'
  isError: boolean
}
