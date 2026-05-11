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
// Protocol (Step 3):
//   Main → Worker  { cmd: 'set_number' | 'set_text' | 'set_boolean'
//                    | 'set_error' | 'set_formula' | 'clear_cell'
//                    | 'insert_row' | 'delete_row' | 'insert_col'
//                    | 'delete_col' | 'subscribe' | 'unsubscribe'
//                    | 'read_initial',
//                    ...payload }
//   Worker → Main  { event: 'change', addr, display, type, isError,
//                    formula } whenever a subscribed address's value
//                  changes. Also fired:
//                    - immediately after a `subscribe` on a fresh addr
//                      (initial backfill — primes the main-side cache so
//                      seed values become visible after the proxy
//                      subscribes),
//                    - once per `read_initial` request (cache hydration
//                      for ad-hoc reads without a permanent subscription).

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

/**
 * Per-address subscription bookkeeping. The underlying `WasmSheet.subscribe`
 * runs at most once per addr regardless of how many main-side listeners
 * register for the same cell — we ref-count and only unwire when the count
 * hits zero. The token is whatever `WasmSheet.subscribe` returns.
 */
const subRefs = new Map<string, { token: number; count: number }>()

function pushChange(s: WasmSheet, addr: string) {
  const display = s.get_display(addr)
  const type = s.get_type(addr)
  const isError = s.is_error(addr)
  const formula = s.get_formula(addr)
  ctx.postMessage({
    event: 'change',
    addr,
    display,
    type,
    isError,
    formula,
  })
}

function subscribeAddr(s: WasmSheet, addr: string) {
  const a = addr.toUpperCase()
  const existing = subRefs.get(a)
  if (existing) {
    existing.count += 1
    // Second+ subscribe on the same addr: don't re-push. The first
    // subscribe already hydrated main's cache, and the second listener
    // (on main) is sharing the same cache entry — no replay needed.
    return
  }
  const token = s.subscribe(a, () => pushChange(s, a))
  subRefs.set(a, { token, count: 1 })
  // Initial backfill: push the cell's current state so the proxy's
  // cache hydrates immediately after subscribe. Without this, a seed
  // sheet (preloaded with values before the main side ever subscribed)
  // would only become visible the next time those cells change.
  pushChange(s, a)
}

function unsubscribeAddr(s: WasmSheet, addr: string) {
  const a = addr.toUpperCase()
  const ref = subRefs.get(a)
  if (!ref) return
  ref.count -= 1
  if (ref.count <= 0) {
    s.unsubscribe(ref.token)
    subRefs.delete(a)
  }
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
      case 'subscribe':
        subscribeAddr(s, msg.addr as string)
        break
      case 'unsubscribe':
        unsubscribeAddr(s, msg.addr as string)
        break
      case 'read_initial':
        // One-shot push without registering a subscription. Used by the
        // proxy for ad-hoc reads (e.g. formula-bar inspection, structural-
        // undo's `non_empty_addrs` walk) where a permanent subscriber
        // would be wasteful.
        pushChange(s, (msg.addr as string).toUpperCase())
        break
      default:
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
