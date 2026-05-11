/// <reference lib="WebWorker" />
//
// 7C Step 1 — Worker that owns the Rust WasmSheet instance.
//
// One sheet per worker; Workbook / multi-sheet is deferred to Step 5. The
// worker is loaded by `wasm-sheet-proxy.ts` via
//   `new Worker(new URL('./wasm-sheet-worker.ts', import.meta.url),
//                { type: 'module' })`
// which Vite bundles separately at build time.
//
// Protocol (this commit, Step 1):
//   Main → Worker  { cmd: 'set_number' | 'set_text' | 'set_boolean'
//                    | 'set_error' | 'set_formula' | 'clear_cell'
//                    | 'insert_row' | 'delete_row' | 'insert_col'
//                    | 'delete_col', ...payload }
//   Worker → Main  (none yet — Step 2 adds 'change' / 'reply' pushes)
//
// Optimistic cache on the main side handles sync reads until the matching
// 'change' push arrives, so Step 1 alone is enough to demonstrate the
// `set → read same value` round-trip even without subscribe wiring.

import init, { WasmSheet } from '../wasm-pkg/einfach_wasm.js'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let sheet: WasmSheet | undefined
let initPromise: Promise<void> | undefined

async function ensureSheet(): Promise<WasmSheet> {
  if (sheet) return sheet
  if (!initPromise) initPromise = (async () => { await init() })()
  await initPromise
  if (!sheet) sheet = new WasmSheet()
  return sheet
}

ctx.addEventListener('message', async (e: MessageEvent) => {
  const msg = e.data as { cmd?: string; [k: string]: unknown }
  const s = await ensureSheet()

  try {
    switch (msg.cmd) {
      case 'set_number':
        s.set_number(msg.addr as string, msg.value as number)
        break
      case 'set_text':
        s.set_text(msg.addr as string, msg.value as string)
        break
      case 'set_boolean':
        s.set_boolean(msg.addr as string, msg.value as boolean)
        break
      case 'set_error':
        s.set_error(msg.addr as string, msg.value as string)
        break
      case 'set_formula':
        s.set_formula(msg.addr as string, msg.formula as string)
        break
      case 'clear_cell':
        s.clear_cell(msg.addr as string)
        break
      case 'insert_row':
        s.insert_row(msg.at as number, msg.count as number)
        break
      case 'delete_row':
        s.delete_row(msg.at as number, msg.count as number)
        break
      case 'insert_col':
        s.insert_col(msg.at as number, msg.count as number)
        break
      case 'delete_col':
        s.delete_col(msg.at as number, msg.count as number)
        break
      default:
        // Unknown command — ignored. Step 2 will add subscribe / reply
        // commands and a sentinel reply for unknown cmds.
        break
    }
  } catch (err) {
    // Errors in the worker would otherwise be swallowed; surface via
    // console.error so console_error_panic_hook (which is installed inside
    // wasm) plus our message log together give a complete picture.
    // eslint-disable-next-line no-console
    console.error('[einfach worker]', err)
  }
})
