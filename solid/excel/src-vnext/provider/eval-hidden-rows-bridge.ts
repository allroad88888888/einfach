import type { Store } from '@einfach/core'
import { viewportHiddenAtom, type SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection } from './projection-refresh'

/**
 * Engine hidden-row eval-input bridge (parity #23).
 *
 * Hidden rows are a UI-core canonical VIEW fact (`viewportHiddenAtom`).
 * The formula engine's SUBTOTAL 101-111 variants must exclude manually
 * hidden data rows, so this bridge mirrors the per-sheet hidden set into
 * the engine through the optional `setEvalHiddenRows` port whenever the
 * canonical set changes.
 *
 * Discipline:
 *  - Whole-set REPLACE, idempotent: the last-pushed set per sheet is
 *    tracked and an unchanged set is never re-pushed. A sheet whose hidden
 *    rows clear pushes an empty set once, then drops out of the ledger.
 *  - Port-absent (or capability-withheld on the TS runtime, where the port
 *    reads `undefined` post-handshake) → the push is silently skipped and
 *    SUBTOTAL 101-111 degrades to "does not exclude". The port is re-read
 *    on every fire so the async capability witness is respected.
 *  - After the push ACKs, the active visible projection is refreshed once:
 *    the engine's paired epoch bump recomputes the 101-111 formulas, and
 *    the grid's own hidden re-render does not refetch cell values. Awaiting
 *    the push before the read guarantees the worker (FIFO) applies the
 *    hidden set before the projection is read.
 *
 * The latest Provider for a store owns the bridge (single-instance
 * invariant), so a replaced Provider cannot keep pushing after a newer
 * lifecycle has started.
 */
interface EvalHiddenBridgeOwner {
  active: boolean
  unsubscribe: (() => void) | null
  readonly lastPushed: Map<string, string>
}

const bridgeOwnerByStore = new WeakMap<Store, EvalHiddenBridgeOwner>()

function serializeRows(rows: readonly number[]): string {
  return rows.length ? rows.join(',') : ''
}

async function pushHiddenDelta(
  store: Store,
  backend: SpreadsheetBackend,
  owner: EvalHiddenBridgeOwner,
): Promise<void> {
  if (!owner.active || bridgeOwnerByStore.get(store) !== owner) return
  const port = backend.setEvalHiddenRows
  if (typeof port !== 'function') return

  const state = store.getter(viewportHiddenAtom)
  const current = state.rowsBySheet
  const sheetIds = new Set<string>([...owner.lastPushed.keys(), ...Object.keys(current)])
  const pushes: Array<Promise<void> | void> = []
  let changed = false

  for (const sheetId of sheetIds) {
    const rows = current[sheetId] ?? []
    const key = serializeRows(rows)
    const prev = owner.lastPushed.get(sheetId) ?? ''
    if (key === prev) continue
    if (key === '') owner.lastPushed.delete(sheetId)
    else owner.lastPushed.set(sheetId, key)
    changed = true
    try {
      pushes.push(port.call(backend, { kind: 'set-eval-hidden-rows', sheetId, rows: [...rows] }))
    } catch {
      // Fire-and-forget eval-input push: never rolls back the canonical view.
    }
  }

  if (!changed) return
  try {
    await Promise.all(pushes)
  } catch {
    // Fire-and-forget: a rejected push leaves SUBTOTAL 101-111 unexcluded.
  }
  if (!owner.active || bridgeOwnerByStore.get(store) !== owner) return
  await refreshVisibleProjection(store, backend).catch(() => {})
}

export function attachEvalHiddenRowsBridge(store: Store, backend: SpreadsheetBackend): () => void {
  const previousOwner = bridgeOwnerByStore.get(store)
  if (previousOwner) {
    previousOwner.active = false
    previousOwner.unsubscribe?.()
  }

  const owner: EvalHiddenBridgeOwner = {
    active: true,
    unsubscribe: null,
    lastPushed: new Map<string, string>(),
  }
  bridgeOwnerByStore.set(store, owner)

  owner.unsubscribe = store.sub(viewportHiddenAtom, () => {
    void pushHiddenDelta(store, backend, owner)
  })
  // One-shot reconcile: covers a remount where hidden rows already exist.
  // No-op against the empty initial set (the engine default matches).
  void pushHiddenDelta(store, backend, owner)

  return () => {
    if (!owner.active) return
    owner.active = false
    owner.unsubscribe?.()
    owner.unsubscribe = null
    if (bridgeOwnerByStore.get(store) !== owner) return
    bridgeOwnerByStore.delete(store)
  }
}
