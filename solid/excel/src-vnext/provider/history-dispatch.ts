import type { Store } from '@einfach/core'
import {
  pushHistoryAtom,
  retryHistoryRefreshAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
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
  return store.setter(pushHistoryAtom, entry)
}

export async function dispatchUndo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const outcome = await store.setter(runUndoHistoryAtom, {
    source: backend,
    refreshProjection: () => refreshVisibleProjection(store, backend),
  })
  return outcome === 'completed'
}

export async function dispatchRedo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const outcome = await store.setter(runRedoHistoryAtom, {
    source: backend,
    refreshProjection: () => refreshVisibleProjection(store, backend),
  })
  return outcome === 'completed'
}

export async function retryHistoryRefresh(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const outcome = await store.setter(retryHistoryRefreshAtom, {
    refreshProjection: () => refreshVisibleProjection(store, backend),
  })
  return outcome === 'completed'
}
