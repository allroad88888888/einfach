import type { ISheet } from './types'

export interface WasmWorkbookApi {
  sheet_count(): number
  sheet_name(idx: number): string
  add_sheet(name: string): number
  rename_sheet(idx: number, name: string): boolean
  remove_sheet(idx: number): boolean
  set_number(sheetIdx: number, addr: string, value: number): void
  set_text(sheetIdx: number, addr: string, value: string): void
  set_boolean(sheetIdx: number, addr: string, value: boolean): void
  set_error(sheetIdx: number, addr: string, value: string): void
  set_formula(sheetIdx: number, addr: string, formula: string): boolean
  clear_cell(sheetIdx: number, addr: string): void
  clear_range(
    sheetIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): number
  insert_row(sheetIdx: number, at: number, count: number): void
  delete_row(sheetIdx: number, at: number, count: number): void
  insert_col(sheetIdx: number, at: number, count: number): void
  delete_col(sheetIdx: number, at: number, count: number): void
  get_display(sheetIdx: number, addr: string): string
  get_number(sheetIdx: number, addr: string): number
  get_type(sheetIdx: number, addr: string): string
  is_error(sheetIdx: number, addr: string): boolean
  get_formula(sheetIdx: number, addr: string): string
  debug_formula_cache_state(sheetIdx: number, addr: string): string
}

interface WasmModule {
  default: () => Promise<void>
  WasmSheet: new () => unknown
  WasmWorkbook: new () => WasmWorkbookApi
}

let wasmModulePromise: Promise<WasmModule> | undefined

async function loadWasmModule(): Promise<WasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const wasm = await import('../wasm-pkg/einfach_wasm.js')
      const mod = wasm as unknown as WasmModule
      await mod.default()
      return mod
    })()
  }
  return wasmModulePromise
}

/**
 * Real Rust + WASM backend for the Excel demos.
 *
 * The wasm-pack output (../wasm-pkg) is a normal ES module — `init()` returns
 * a promise that resolves once the .wasm binary is fetched + instantiated.
 * We hide that wait inside this factory and return an `ISheet`-shaped object
 * once it's ready, so call sites can `await createWasmSheet()` and forget.
 *
 * The `WasmSheet` class produced by wasm-bindgen already matches `ISheet`
 * one-for-one (set_number / set_text / set_boolean / set_error / set_formula
 * / get_display / get_number / get_type / is_error / get_formula / subscribe
 * / unsubscribe / clear_cell / insert_row / delete_row / insert_col /
 * delete_col). The only TS-level gap: `subscribe`'s callback is typed as
 * `Function` (not `() => void`), but `() => void` is assignable to it.
 *
 * Build prerequisites (run from repo root):
 *   1. `rustup target add wasm32-unknown-unknown` (one-time)
 *   2. `npm run build:wasm -w @einfach/solid-excel` — emits `wasm-pkg/`
 *
 * Other demos (Budget / Grades / Sales / Blank) still use `createJSSheet`
 * for now; switching is a one-line swap of the factory passed to
 * `createSheetStore`. Jest tests stay on the JS mock — `createWasmSheet`
 * needs the WASM toolchain and a browser-ish environment.
 */
export async function createWasmSheet(): Promise<ISheet> {
  const wasm = await loadWasmModule()
  return new wasm.WasmSheet() as unknown as ISheet
}

export async function createWasmWorkbook(): Promise<WasmWorkbookApi> {
  const wasm = await loadWasmModule()
  return new wasm.WasmWorkbook()
}
