// REMOTE_FORMULA_PUMP.ts — Worker-side remote formula pump
//
// Create at: solid/excel/src-vnext/adapter/remote-pump.ts
// Design: rust/excel-core/docs/REMOTE_FORMULAS_DESIGN.md §3.2
//
// This module mirrors async-custom-pump.ts but for =REMOTE(url, args) calls.
// It should be wired into the worker command handler's convergence loop
// alongside the existing async custom pump:
//
//   // After every mutation/read entry point:
//   await pumpCustoms(engine)    // existing — local callbacks
//   await pumpRemotes(engine)   // NEW — network fetches
//   // Repeat both until neither settled anything.
//
// Merge pattern: extend createAsyncCustomPump's convergence loop, or create
// a separate pump that the worker calls immediately after the custom pump.

import type {
  PendingRemoteCallWire,
  RemoteErrorKindWire,
} from './worker-protocol'

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000
export const MAX_REMOTE_PUMP_ROUNDS = 8 // same as MAX_ASYNC_PUMP_ROUNDS

// ============================================================================
// Worker-side engine interface
// ============================================================================

/**
 * Narrow interface the worker runtime needs on the engine to drain and
 * settle remote calls. Both the WASM runtime (`WasmWorkbook`) and the
 * TS runtime (`EinfachExcelCore`) implement these.
 */
export interface RemotePumpEngine {
  /** Drain the pending remote queue. Returns [] when empty or unsupported. */
  drainRemotePending?(): PendingRemoteCallWire[]

  /** Settle a successful remote call. Returns false when stale. */
  fulfillRemote?(callId: number, result: unknown): boolean

  /** Reject a remote call with an error kind. Returns false when stale. */
  rejectRemote?(callId: number, kind: RemoteErrorKindWire): boolean

  /** Force-recompute all REMOTE() cells (optional). */
  invalidateRemoteCache?(): void
}

// ============================================================================
// Remote pump
// ============================================================================

export interface RemotePumpHooks {
  /** Override the default fetch. The pump uses bare fetch() when absent. */
  fetchFn?: (url: string, args: unknown[], signal: AbortSignal) => Promise<unknown>

  /** Called when a call settles (fulfill or reject succeeds). */
  onSettled?: (callId: number, ok: boolean) => void

  /** Called when the engine rejects a settle as stale. */
  onStale?: (callId: number) => void
}

/**
 * Drain and settle one round of pending remote calls.
 * Returns true if any call was settled (triggering potential re-evaluation).
 */
export async function pumpRemoteCalls(
  engine: RemotePumpEngine,
  timeoutMs: number = DEFAULT_REMOTE_TIMEOUT_MS,
  hooks: RemotePumpHooks = {},
): Promise<boolean> {
  const drainFn = engine.drainRemotePending
  if (typeof drainFn !== 'function') return false

  const requests = drainFn.call(engine)
  if (!Array.isArray(requests) || requests.length === 0) return false

  let anySettled = false
  const fetchFn = hooks.fetchFn ?? defaultFetch

  await Promise.all(
    requests.map(async (req: PendingRemoteCallWire) => {
      let outcome: unknown
      try {
        const controller = new AbortController()
        const timer = timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined
        try {
          outcome = await fetchFn(req.url, req.args, controller.signal)
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } catch (err: unknown) {
        const kind = classifyFetchError(err)
        const settled = engine.rejectRemote?.call(engine, req.callId, kind) ?? false
        if (!settled) {
          hooks.onStale?.(req.callId)
        }
        hooks.onSettled?.(req.callId, false)
        if (settled) anySettled = true
        return
      }

      // Fulfill with the parsed response.
      const settled = engine.fulfillRemote?.call(engine, req.callId, outcome) ?? false
      if (!settled) {
        hooks.onStale?.(req.callId)
      }
      hooks.onSettled?.(req.callId, settled)
      if (settled) anySettled = true
    }),
  )

  return anySettled
}

/**
 * Full convergence loop: pump remote calls until the queue is empty
 * or the round limit is reached.
 */
export async function pumpRemoteCallsUntilIdle(
  engine: RemotePumpEngine,
  timeoutMs?: number,
  hooks?: RemotePumpHooks,
): Promise<void> {
  for (let round = 0; round < MAX_REMOTE_PUMP_ROUNDS; round++) {
    const anySettled = await pumpRemoteCalls(engine, timeoutMs, hooks)
    if (!anySettled) break
  }
}

// ============================================================================
// Default fetch implementation
// ============================================================================

async function defaultFetch(
  url: string,
  args: unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal,
  })

  if (!response.ok) {
    // Non-2xx status → surface as a structured error for the reject path.
    throw new FetchHttpError(response.status, response.statusText)
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType.includes('application/json')) {
    return response.json()
  }
  return response.text()
}

class FetchHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`HTTP ${status}: ${statusText}`)
    this.name = 'FetchHttpError'
  }
}

// ============================================================================
// Error classification
// ============================================================================

function classifyFetchError(err: unknown): RemoteErrorKindWire {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'timeout'
  }
  if (err instanceof FetchHttpError) {
    return err.status >= 500 ? 'server-error' : 'network'
  }
  if (err instanceof TypeError) {
    // fetch() throws TypeError for network failures, DNS, CORS, etc.
    return 'network'
  }
  if (err instanceof SyntaxError) {
    // JSON parse failure
    return 'parse-error'
  }
  return 'network'
}

// ============================================================================
// Integration pattern (merge into worker-runtime.ts / worker-runtime-ts.ts)
// ============================================================================
//
// After every worker command that may trigger formula evaluation:
//
//   import { pumpAsyncCustomCalls } from './async-custom-pump'
//   import { pumpRemoteCalls } from './remote-pump'
//
//   async function pumpAll(engine: WasmWorkbookRuntime): Promise<void> {
//     for (let round = 0; round < 8; round++) {
//       const customsSettled = await pumpAsyncCustomCalls(engine)
//       const remotesSettled = await pumpRemoteCalls(engine)
//       if (!customsSettled && !remotesSettled) break
//     }
//   }
//
// The convergence loop ensures:
//   1. Customs settle first (they may produce values that feed into REMOTE args)
//   2. Remotes settle next (network responses may trigger further eval)
//   3. Repeat until both queues are empty
