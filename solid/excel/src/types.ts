/** Interface matching the WasmSheet API from einfach-wasm */
export interface ISheet {
  set_number(addr: string, value: number): void
  set_text(addr: string, value: string): void
  set_formula(addr: string, formula: string): void
  clear_cell(addr: string): void
  batch_set_inputs(addrs: string[], inputs: string[]): boolean
  get_display(addr: string): string
  get_input(addr: string): string
  get_number(addr: string): number
  get_type(addr: string): string
  is_error(addr: string): boolean
}

export type SheetMetadata = {
  rowCount: number
  colCount: number
  freezeTopRow: boolean
  freezeFirstColumn: boolean
}

export type SheetStateSnapshot = {
  name: string
  metadata: SheetMetadata
  rowHeights: Array<[number, number]>
  colWidths: Array<[number, number]>
  cells: Array<[string, { type: string; value: number | string | boolean | null }]>
  formulas: Array<[string, string]>
}

export type WorkbookSnapshot = {
  activeSheetIndex: number
  sheets: SheetStateSnapshot[]
}

export interface IWorkbook extends ISheet {
  sheet_count(): number
  sheet_name(index: number): string
  active_sheet_index(): number
  set_active_sheet(index: number): boolean
  add_sheet(name?: string): string
  remove_sheet(index: number): boolean
  rename_sheet(index: number, nextName: string): boolean
  row_count(): number
  col_count(): number
  row_height(index: number): number
  col_width(index: number): number
  set_row_height(index: number, height: number): void
  set_col_width(index: number, width: number): void
  freeze_top_row(): boolean
  freeze_first_column(): boolean
  set_freeze_top_row(value: boolean): void
  set_freeze_first_column(value: boolean): void
  insert_row(index: number, count?: number): void
  delete_row(index: number, count?: number): void
  insert_col(index: number, count?: number): void
  delete_col(index: number, count?: number): void
  snapshot(): WorkbookSnapshot
  restore(snapshot: WorkbookSnapshot): void
}

export type CellValue = {
  display: string
  type: 'number' | 'text' | 'boolean' | 'null' | 'error'
  isError: boolean
}
