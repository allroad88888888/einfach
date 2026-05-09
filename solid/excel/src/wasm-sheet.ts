import type { ISheet } from './types'

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
  const wasm = await import('../wasm-pkg/einfach_wasm.js')
  // wasm-pack `--target web` exports an async default `init()`. It must be
  // awaited before the first WasmSheet construction or the wasm memory is
  // not yet bound to the JS class.
  await wasm.default()
  return new wasm.WasmSheet() as unknown as ISheet
}
