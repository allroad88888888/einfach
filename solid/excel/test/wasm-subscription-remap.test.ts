/**
 * Pin for the codex P2 on audit D-6: `WasmWorkbook` must remap its
 * token → `(sheet_idx, sub)` subscription entries when `remove_sheet`
 * shifts indices (mirroring the existing `move_sheet` remap), or a
 * later `unsubscribe_cell` resolves the stale index against the WRONG
 * sheet — the engine-side callback stays alive and keeps emitting
 * dirty events with a pre-removal index. The worker-runtime D-6 tests
 * cover the adapter against a MOCK workbook; this file pins the real
 * wasm binding (node-side wasm-pkg, no browser, no Worker — same
 * loading pattern as scale-parity.test.ts).
 *
 * Always-on: three tests against a 3-sheet workbook, milliseconds.
 */
import { describe, expect, test, beforeAll, beforeEach, afterEach } from '@jest/globals'
import { existsSync, readFileSync } from 'node:fs'
import { TextDecoder, TextEncoder } from 'node:util'
import path from 'node:path'

// jsdom under jest doesn't expose TextDecoder/TextEncoder; the wasm-bindgen
// glue grabs them at module-load time, so patch globals BEFORE importing
// the wasm module (same trick as scale-parity.test.ts).
const g = globalThis as unknown as {
  TextDecoder: typeof TextDecoder
  TextEncoder: typeof TextEncoder
}
if (!g.TextDecoder) g.TextDecoder = TextDecoder
if (!g.TextEncoder) g.TextEncoder = TextEncoder

const WASM_PKG_JS = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm.js')
const WASM_PKG_BIN = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm_bg.wasm')

interface WasmWorkbookLike {
  rename_sheet(idx: number, name: string): boolean
  add_sheet(name: string): number
  remove_sheet(idx: number): boolean
  set_cell_number(sheetIdx: number, addr: string, value: number): void
  subscribe_cell(sheetName: string, addr: string, cb: () => void): number
  unsubscribe_cell(token: number): void
  free(): void
}

interface WasmModuleShape {
  default: (init?: { module_or_path: ArrayBufferLike }) => Promise<unknown>
  WasmWorkbook: new () => WasmWorkbookLike
}

let WasmModule: WasmModuleShape | undefined

// JsCallbackListener::on_change queues the JS callback as a microtask
// (firing synchronously inside the wasm-bindgen &mut borrow would drop
// the notification — see rust/wasm/src/lib.rs). Flush with a macrotask
// so assertions observe the queued fires regardless of queue flavor.
const flushCallbacks = () => new Promise((resolve) => setTimeout(resolve, 0))

async function loadWasmModule(): Promise<WasmModuleShape> {
  if (WasmModule) return WasmModule
  if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
    throw new Error(
      `wasm-subscription-remap: wasm-pkg missing at ${WASM_PKG_JS} — run \`npm --prefix solid/excel run build:wasm\``,
    )
  }
  const mod = (await import(WASM_PKG_JS)) as WasmModuleShape
  const bytes = readFileSync(WASM_PKG_BIN)
  await mod.default({
    module_or_path: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  WasmModule = mod
  return mod
}

describe('WasmWorkbook subscription token remap across remove_sheet', () => {
  let wb: WasmWorkbookLike

  beforeAll(async () => {
    await loadWasmModule()
  }, 30_000)

  beforeEach(() => {
    const mod = WasmModule as WasmModuleShape
    wb = new mod.WasmWorkbook()
    wb.rename_sheet(0, 'First')
    wb.add_sheet('Data')
    wb.add_sheet('Last')
  })

  afterEach(() => {
    wb.free()
  })

  test('unsubscribe after removing an EARLIER sheet kills the real callback (the P2 repro)', async () => {
    let fires = 0
    const token = wb.subscribe_cell('Data', 'A1', () => {
      fires += 1
    })
    wb.set_cell_number(1, 'A1', 1)
    await flushCallbacks()
    expect(fires).toBe(1)

    expect(wb.remove_sheet(0)).toBe(true)
    // Data shifted 1 → 0. Pre-fix the entry still said 1 ('Last'), so this
    // unsubscribe hit the wrong sheet and Data's callback stayed alive.
    wb.unsubscribe_cell(token)

    wb.set_cell_number(0, 'A1', 2)
    await flushCallbacks()
    expect(fires).toBe(1)
  })

  test('subscription on a shifted sheet still fires until unsubscribed', async () => {
    let fires = 0
    wb.subscribe_cell('Data', 'A1', () => {
      fires += 1
    })
    expect(wb.remove_sheet(0)).toBe(true)
    wb.set_cell_number(0, 'A1', 7)
    await flushCallbacks()
    expect(fires).toBe(1)
  })

  test('token on the REMOVED sheet is dropped: unsubscribe no-ops and spares neighbours', async () => {
    let removedFires = 0
    let neighbourFires = 0
    const removedToken = wb.subscribe_cell('First', 'A1', () => {
      removedFires += 1
    })
    wb.subscribe_cell('Data', 'A1', () => {
      neighbourFires += 1
    })

    expect(wb.remove_sheet(0)).toBe(true)
    // Pre-fix this stale token resolved against the shifted 'Data' sheet
    // and could cancel the neighbour's engine-side subscription.
    wb.unsubscribe_cell(removedToken)

    wb.set_cell_number(0, 'A1', 3)
    await flushCallbacks()
    expect(neighbourFires).toBe(1)
    expect(removedFires).toBe(0)
  })
})
