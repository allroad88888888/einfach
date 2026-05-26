import type { Store } from '@einfach/core'
import {
  pushHistoryAtom,
  redoHistoryAtom,
  resolveHistoryAtom,
  undoHistoryAtom,
  type HistoryEntry,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import { refreshVisibleProjection } from './projection-refresh'

/**
 * True when `backend` exposes the transaction-level undo/redo port that
 * `dispatchUndo` / `dispatchRedo` round-trip through. Hosts that record
 * a history entry for a mutation should gate the push on this — if the
 * backend can't undo the mutation, recording an entry would leave Ctrl+Z
 * lying about its outcome (HIGH #6).
 */
export function backendSupportsUndo(backend: SpreadsheetBackend): boolean {
  return typeof backend.undoTransaction === 'function'
}

export function backendSupportsRedo(backend: SpreadsheetBackend): boolean {
  return typeof backend.redoTransaction === 'function'
}

/**
 * Push a history entry only when the backend can actually replay it.
 * Returns `true` when pushed, `false` when the backend can't undo and
 * the entry was dropped. Hosts should treat `false` as "the mutation
 * stuck but it cannot be reverted" — typically nothing else needs to
 * happen, but a debug log helps diagnose missing-port surprises.
 *
 * Use this from any dispatcher that records an entry tied to a backend
 * mutation (paste-special, remove-duplicates, fill, etc.). It mirrors
 * the same capability check `dispatchUndo` does at undo time, so the
 * "recorded entry → undo silently succeeds without restoring data"
 * regression cannot happen.
 */
export function recordHistoryEntry(
  store: Store,
  backend: SpreadsheetBackend,
  entry: HistoryEntry,
): boolean {
  if (!backendSupportsUndo(backend)) {
    return false
  }
  store.setter(pushHistoryAtom, entry)
  return true
}

export async function dispatchUndo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  // Capability check FIRST: if the backend can't undo, we must not
  // pop the entry — otherwise the entry vanishes from the stack
  // while the workbook stays mutated, which is exactly the silent-
  // success bug (HIGH #6). The dialog should gate its push via
  // `recordHistoryEntry`, but defending here too keeps a stale entry
  // recoverable if a future backend swap loses the undoTransaction
  // port mid-session.
  if (!backendSupportsUndo(backend)) {
    return false
  }
  const entry = store.setter(undoHistoryAtom)
  if (!entry) return false
  try {
    // backendSupportsUndo confirmed undoTransaction is defined; the
    // non-null assertion below is therefore safe at runtime.
    const result = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: entry.transactionId,
    })
    store.setter(resolveHistoryAtom, {
      transactionId: entry.transactionId,
      ok: true,
      revision: result.revision,
    })
    await refreshVisibleProjection(store, backend)
    return true
  } catch {
    store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: false })
    return false
  }
}

export async function dispatchRedo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  if (!backendSupportsRedo(backend)) {
    return false
  }
  const entry = store.setter(redoHistoryAtom)
  if (!entry) return false
  try {
    const result = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: entry.transactionId,
    })
    store.setter(resolveHistoryAtom, {
      transactionId: entry.transactionId,
      ok: true,
      revision: result.revision,
    })
    await refreshVisibleProjection(store, backend)
    return true
  } catch {
    store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: false })
    return false
  }
}
