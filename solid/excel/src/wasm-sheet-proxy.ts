import type { CellValue, ISheet } from './types'

/**
 * 7C Step 1 — main-thread proxy around a Web Worker that owns the real
 * WasmSheet. Implements `ISheet` so it's a drop-in replacement for
 * `createWasmSheet()` in `sheet-store.ts`.
 *
 * Sync reads are served from a local cache populated by:
 *   1. **optimistic** write-through on `set_*` / `clear_cell` — value
 *      lands in the cache the same tick the call returns, so the UI sees
 *      it without waiting for the worker.
 *   2. **definitive** push from the worker on a `change` message — Step 2
 *      will wire this; Step 1 leaves the channel open but unused.
 *
 * The optimistic path is "best-guess display": `String(value)` for
 * numbers, the literal text for set_text, etc. The worker's eventual
 * push corrects any formatting drift (e.g. number → currency on a
 * formatted cell). For formulas, optimism only records the formula
 * source; display stays empty until the worker computes it.
 *
 * Structural edits (`insert_row` / `delete_row` / `insert_col` /
 * `delete_col`) invalidate the entire cache because every cell in the
 * shifted band could move. Step 2's push channel will re-hydrate
 * impacted addresses; until then, post-structural reads return empty
 * until the user touches a cell again.
 */

type CellType = CellValue['type']

type CachedCell = {
  display: string
  type: CellType
  isError: boolean
  formula: string
}

const EMPTY_CELL: CachedCell = {
  display: '',
  type: 'null',
  isError: false,
  formula: '',
}

/** Minimal duck-type for `Worker` so tests can inject a fake. */
export interface WorkerLike {
  postMessage(msg: unknown): void
  addEventListener(
    type: 'message',
    listener: (e: MessageEvent) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (e: MessageEvent) => void,
  ): void
  terminate(): void
}

export interface WorkerSheetOptions {
  /**
   * Worker factory. The proxy itself is framework-agnostic and never
   * references `import.meta.url` (which would otherwise break Jest's
   * CommonJS transform). Demos that want the real worker import the
   * companion helper `defaultWorkerFactory` from
   * `./wasm-sheet-worker-factory.ts` and pass it in here. Tests inject
   * an in-process fake.
   */
  workerFactory: () => WorkerLike
}

/**
 * Build the main-thread proxy. The returned object satisfies `ISheet`,
 * so `createSheetStore(createWorkerSheet({ workerFactory }))` is the
 * worker-backed equivalent of
 * `createSheetStore(await createWasmSheet())`.
 *
 * Unlike `createWasmSheet`, this factory is **sync** — the worker
 * spins up asynchronously in the background, and writes posted before
 * its wasm finishes initializing are queued by the worker's own message
 * loop. Reads always hit the local cache, so callers never see a
 * "not yet ready" race.
 */
export function createWorkerSheet(opts: WorkerSheetOptions): ISheet {
  const worker: WorkerLike = opts.workerFactory()

  const cache = new Map<string, CachedCell>()

  function readCache(addr: string): CachedCell {
    return cache.get(addr.toUpperCase()) ?? EMPTY_CELL
  }

  function writeCache(addr: string, patch: Partial<CachedCell>) {
    const a = addr.toUpperCase()
    const cur = cache.get(a) ?? { ...EMPTY_CELL }
    cache.set(a, { ...cur, ...patch })
  }

  // === Hydration ===
  // First-time reads of an addr we've never subscribed to or written to
  // post a `read_initial` cmd so the worker pushes back the current
  // value. Tracked per-addr so we issue the request at most once. Both
  // `subscribe` (which triggers the worker's auto-backfill) and any
  // local write also flip the addr into `requested`, so the read-side
  // path never double-fires.
  const requested = new Set<string>()

  function ensureHydration(addr: string) {
    const a = addr.toUpperCase()
    if (requested.has(a)) return
    requested.add(a)
    post('read_initial', { addr: a })
  }

  // === Subscriptions ===
  // Listener bookkeeping mirrors the worker's: at most one
  // `WasmSheet.subscribe` per addr, ref-counted so multiple Solid signals
  // on the same cell share the worker-side wire. Tokens are allocated
  // here and routed via the addr lookup; the worker never sees the
  // token, only `{cmd:'subscribe',addr}` / `{cmd:'unsubscribe',addr}`
  // when the per-addr count enters or exits zero.
  let nextToken = 1
  const tokenToAddr = new Map<number, string>()
  const listenersByAddr = new Map<string, Map<number, () => void>>()

  function fireListeners(addr: string) {
    const map = listenersByAddr.get(addr)
    if (!map) return
    for (const cb of map.values()) cb()
  }

  // Worker → main pushes. A 'change' event is the canonical signal — it
  // updates the cache AND fires per-addr listeners. Main-side optimistic
  // writes do NOT fire listeners on their own; the worker's
  // `WasmSheet.subscribe` callback (running inside the worker thread) is
  // the source of truth for "this address changed". This keeps the
  // ordering deterministic: every visible change to a cell is exactly
  // one worker push.
  //
  // The listener is captured into a named ref so `dispose()` can detach
  // it on teardown — an anonymous arrow would leave the worker holding
  // a callback into a now-stale closure (cache map, listenersByAddr,
  // etc.) and keep the proxy alive for GC.
  const onWorkerMessage = (e: MessageEvent) => {
    const msg = (e.data ?? {}) as { event?: string; [k: string]: unknown }
    if (msg.event === 'change') {
      const a = String(msg.addr).toUpperCase()
      writeCache(a, {
        display: String(msg.display ?? ''),
        type: (msg.type as CellType) ?? 'null',
        isError: !!msg.isError,
        formula: String(msg.formula ?? ''),
      })
      fireListeners(a)
    }
  }
  worker.addEventListener('message', onWorkerMessage)

  function post(cmd: string, payload: Record<string, unknown>) {
    worker.postMessage({ cmd, ...payload })
  }

  /** Best-guess display for an optimistic numeric write. Rust's
   * `Value::Number` `Display` impl renders integers without a decimal
   * point (e.g. 42 → "42") and floats with `to_string` semantics
   * (0.1 + 0.2 → "0.30000000000000004"). `String(value)` in JS lands
   * on the same shape for both, so the optimistic display matches the
   * worker's `get_display` until a formatted-display upgrade replaces
   * it via a 'change' push. */
  function optimisticNumberDisplay(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
    return String(n)
  }

  return {
    set_number(addr, value) {
      requested.add(addr.toUpperCase())
      writeCache(addr, {
        display: optimisticNumberDisplay(value),
        type: 'number',
        isError: false,
        formula: '',
      })
      post('set_number', { addr, value })
    },

    set_text(addr, value) {
      requested.add(addr.toUpperCase())
      writeCache(addr, {
        display: value,
        // Empty text and explicit set_text('') collapse to 'null' on the
        // Rust side too (clear via empty primitive).
        type: value === '' ? 'null' : 'text',
        isError: false,
        formula: '',
      })
      post('set_text', { addr, value })
    },

    set_boolean(addr, value) {
      requested.add(addr.toUpperCase())
      writeCache(addr, {
        display: value ? 'TRUE' : 'FALSE',
        type: 'boolean',
        isError: false,
        formula: '',
      })
      post('set_boolean', { addr, value })
    },

    set_error(addr, value) {
      requested.add(addr.toUpperCase())
      writeCache(addr, {
        display: value,
        type: 'error',
        isError: true,
        formula: '',
      })
      post('set_error', { addr, value })
    },

    set_formula(addr, formula) {
      // Optimism for formulas only records the source — we can't compute
      // the result on the main thread without re-implementing the
      // evaluator. The worker pushes a 'change' with the real display
      // once it computes. Cycle detection happens on the worker too;
      // Step 1 returns `true` unconditionally and a Step 2 reply path
      // will surface the real bool when needed by undo bookkeeping.
      requested.add(addr.toUpperCase())
      writeCache(addr, { formula })
      post('set_formula', { addr, formula })
      return true
    },

    clear_cell(addr) {
      requested.add(addr.toUpperCase())
      cache.delete(addr.toUpperCase())
      post('clear_cell', { addr })
    },

    get_display(addr) {
      ensureHydration(addr)
      return readCache(addr).display
    },
    get_number(addr) {
      ensureHydration(addr)
      const c = readCache(addr)
      if (c.type !== 'number') return 0
      const n = Number(c.display)
      return Number.isFinite(n) ? n : 0
    },
    get_type(addr) {
      ensureHydration(addr)
      return readCache(addr).type
    },
    is_error(addr) {
      ensureHydration(addr)
      return readCache(addr).isError
    },
    get_formula(addr) {
      ensureHydration(addr)
      return readCache(addr).formula
    },

    insert_row(at, count) {
      // Cache invalidation: row inserts move every cell at-or-below; we
      // don't know which ones from the proxy. Subsequent reads will
      // re-trigger `read_initial` so the cache repopulates lazily as
      // cells come back into view. Active subscribers also see fresh
      // pushes via the worker's own subscription bookkeeping.
      cache.clear()
      requested.clear()
      post('insert_row', { at, count })
    },
    delete_row(at, count) {
      cache.clear()
      requested.clear()
      post('delete_row', { at, count })
    },
    insert_col(at, count) {
      cache.clear()
      requested.clear()
      post('insert_col', { at, count })
    },
    delete_col(at, count) {
      cache.clear()
      requested.clear()
      post('delete_col', { at, count })
    },

    subscribe(addr, cb) {
      const a = addr.toUpperCase()
      const tok = nextToken++
      tokenToAddr.set(tok, a)
      let map = listenersByAddr.get(a)
      if (!map) {
        map = new Map()
        listenersByAddr.set(a, map)
        // First listener on this addr — wire it through to the worker.
        // Worker ref-counts internally so a second subscribe(addr,_) on
        // main would still only result in one underlying WasmSheet
        // subscriber, but we short-circuit here to avoid even the
        // wire-traffic.
        post('subscribe', { addr: a })
        // The worker auto-pushes the current value after subscribing,
        // so we don't also need a `read_initial`. Mark the addr hydrated
        // so a subsequent `get_display` doesn't fire a redundant request.
        requested.add(a)
      }
      map.set(tok, cb)
      return tok
    },

    unsubscribe(token) {
      const a = tokenToAddr.get(token)
      if (!a) return
      tokenToAddr.delete(token)
      const map = listenersByAddr.get(a)
      if (!map) return
      map.delete(token)
      if (map.size === 0) {
        listenersByAddr.delete(a)
        post('unsubscribe', { addr: a })
      }
    },

    non_empty_addrs() {
      // Cache-derived best-effort: only addresses the proxy has seen
      // (either via a local write or a worker push). The worker's actual
      // non-empty set may be larger if the seed happened before the proxy
      // subscribed. Step 3 (lazy hydration) will flush this gap by
      // routing structural-undo's snapshot through a 'list_non_empty'
      // reply.
      const out: string[] = []
      for (const [addr, c] of cache) {
        if (c.type !== 'null' || c.formula !== '') out.push(addr)
      }
      return out
    },

    /**
     * Terminate the worker and drop every retained reference. After
     * `dispose` the proxy is unusable — calling any other method is a
     * silent no-op against an empty cache.
     *
     * Reproduces the in-process backends' "the host GCs me" lifecycle
     * for the worker case: without this, repeatedly mounting / unmounting
     * `DemoWorker` (e.g. tabbing between demos) leaks one Worker thread
     * per visit, since the message listener captures the cache + lookup
     * maps and keeps the worker reachable.
     */
    dispose() {
      worker.removeEventListener('message', onWorkerMessage)
      cache.clear()
      requested.clear()
      tokenToAddr.clear()
      listenersByAddr.clear()
      worker.terminate()
    },
  }
}

/** Exposed for tests to detach without keeping a reference to the worker. */
export type WorkerSheet = ReturnType<typeof createWorkerSheet>
