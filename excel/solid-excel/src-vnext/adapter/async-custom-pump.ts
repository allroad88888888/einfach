/**
 * Wave 8.2 — shared async custom-formula pump.
 *
 * Both worker runtimes (`worker-runtime.ts` over the WASM engine and
 * `worker-runtime-ts.ts` over `@einfach/excel-core-ts`) drive async
 * custom formulas the same way: after every command, drain the engine's
 * pending-call queue, invoke the host-registered async callback on the
 * worker event loop, await it, and settle the result back into the
 * engine. Settling can cascade — a recompute may enqueue new calls
 * (`=MYA2(MYA1(A1))`) — so the pump loops until a drain comes back
 * empty. The queue is content-addressed (the engine memoizes per
 * (name, args) and never re-enqueues a live call), so the loop
 * converges; `MAX_ASYNC_PUMP_ROUNDS` is a safety fuse, not a scheduler.
 *
 * Engine identity guard: every drained batch is bound to the engine it
 * was drained from. If the runtime swaps engines (initWorkbook /
 * restore) while a Promise is in flight, the settle is dropped — the
 * new engine never sees a stale value. The engine's own call_id /
 * generation guard covers the registry-change case; this guard covers
 * whole-engine replacement, which the engine cannot see.
 */

export type AsyncCustomArg = number | string | boolean | null | AsyncCustomArg[][]

export type AsyncCustomRequest = {
  callId: number
  name: string
  args: AsyncCustomArg[]
}

export type AsyncCustomCallable = (args: AsyncCustomArg[]) => unknown

export type AsyncCustomPumpHooks<TEngine> = {
  /** Current engine, or undefined before init. Compared by identity. */
  currentEngine(): TEngine | undefined
  /** Destructively drain the engine's pending async calls. */
  drain(engine: TEngine): AsyncCustomRequest[]
  /** Settle one call. Returns false when the call is unknown/stale. */
  resolve(engine: TEngine, callId: number, value: unknown): boolean
  /** The worker-local compiled callback for an async name, if any. */
  lookup(name: string): AsyncCustomCallable | undefined
  /**
   * Optional diagnostic warning hook.
   * Workers inject `console.warn` here so pump warnings reach worker
   * devtools without the pump itself importing `console`.
   */
  warn?(message: string, detail?: unknown): void
}

/**
 * Safety fuse for the cascade loop. A legitimate chain of async calls
 * is bounded by formula nesting depth (each round settles one layer);
 * hitting this cap means something is re-enqueueing pathologically.
 */
export const MAX_ASYNC_PUMP_ROUNDS = 1000

export type AsyncCustomPump = {
  /**
   * Fire-and-forget: drain + invoke + settle until the queue is dry.
   * Reentrancy-latched — calling while a pump is running coalesces
   * into one extra pass instead of racing a second loop.
   */
  pump(): void
  /** Test hook: resolves when the current pump pass (if any) is done. */
  idle(): Promise<void>
}

export function createAsyncCustomPump<TEngine>(
  hooks: AsyncCustomPumpHooks<TEngine>,
): AsyncCustomPump {
  let running: Promise<void> | undefined
  let repump = false

  async function run(): Promise<void> {
    for (let round = 0; round < MAX_ASYNC_PUMP_ROUNDS; round++) {
      const engine = hooks.currentEngine()
      if (!engine) return
      const requests = hooks.drain(engine)
      if (requests.length === 0) return
      let anySettled = false
      await Promise.all(
        requests.map(async (request) => {
          let outcome: unknown
          try {
            const fn = hooks.lookup(request.name)
            if (!fn) {
              // Registered async in the engine but missing locally —
              // a replace/unregister raced the drain. #NAME? matches
              // what a fresh evaluation of the formula would surface.
              outcome = { error: '#NAME?' }
            } else {
              outcome = await fn(request.args)
            }
          } catch (err) {
            // Throw and Promise-reject map to #VALUE!, same as a sync
            // callback throw. The message survives via console for
            // devtools; the cell only carries the token.
            hooks.warn?.(
              `[einfach custom formula] async ${request.name} failed:`,
              err,
            )
            outcome = { error: '#VALUE!' }
          }
          if (hooks.currentEngine() !== engine) return
          if (hooks.resolve(engine, request.callId, outcome)) anySettled = true
        }),
      )
      if (!anySettled) return
    }
    hooks.warn?.(
      `[einfach custom formula] async pump exceeded ${MAX_ASYNC_PUMP_ROUNDS} rounds; abandoning cascade`,
    )
  }

  function pump(): void {
    if (running) {
      repump = true
      return
    }
    running = (async () => {
      try {
        do {
          repump = false
          await run()
        } while (repump)
      } catch (err) {
        // drain/resolve throwing is an engine-contract violation, not a
        // user-callback failure (those are caught per-request in run).
        // Swallow so the worker doesn't die on an unhandled rejection.
        hooks.warn?.('[einfach custom formula] async pump crashed:', err)
      } finally {
        // Clear synchronously at the end of the async body (not via
        // .finally) so there is no microtask gap in which a pump()
        // call could set `repump` against an already-exited loop.
        running = undefined
      }
    })()
  }

  return {
    pump,
    idle: () => running ?? Promise.resolve(),
  }
}
