import type { Store } from '@einfach/core'
import {
  pushHistoryAtom,
  retryHistoryRefreshAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  setViewportFilterHiddenRowsAtom,
  type HistoryEntry,
  type SheetHiddenStateRequest,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import { isVisibleProjectionResult, spreadsheetProjectionSnapshotAtom } from './atoms'
import { refreshVisibleProjection } from './projection-refresh'

/** The sheet id the visible projection is currently showing, if any. */
function activeProjectionSheetId(store: Store): string | undefined {
  const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
  if (isVisibleProjectionResult(snapshot.result)) return snapshot.result.sheetId
  return snapshot.request?.kind === 'visible-window' ? snapshot.request.sheetId : undefined
}

/**
 * Re-hydrate the FILTER-hidden render cache from the engine after an undo/redo
 * (design-engine-hidden-rows §6.3, E8). Since E8 the filter-hidden set carries
 * NO UI-core history side payload: a structural undo/redo restores the engine's
 * OWNED filter through its own `restoreFilters` snapshot (worker) or the
 * full-sheet capture (static), and this read pulls the restored set back into
 * `viewportFilterHiddenAtom` so the grid, navigation and copy all see the rows
 * the engine now hides. Manual-hidden rows keep their own local-replay re-feed,
 * so only the filter axis is written here. A backend without
 * `readSheetHiddenState` (the TS worker, which fails filter closed) has no
 * filter to restore, so the read is skipped. Best-effort: the transaction is
 * already committed, so a read failure never rolls it back.
 */
async function reconcileFilterHiddenFromEngine(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<void> {
  if (typeof backend.readSheetHiddenState !== 'function') return
  const sheetId = activeProjectionSheetId(store)
  if (!sheetId) return
  let result: Awaited<ReturnType<NonNullable<SpreadsheetBackend['readSheetHiddenState']>>>
  try {
    result = await backend.readSheetHiddenState({
      kind: 'sheet-hidden-state',
      sheetId,
    } satisfies SheetHiddenStateRequest)
  } catch {
    return
  }
  if (
    typeof result !== 'object' ||
    result === null ||
    result.sheetId !== sheetId ||
    !Array.isArray(result.filterRows)
  ) {
    return
  }
  store.setter(setViewportFilterHiddenRowsAtom, { sheetId, rows: [...result.filterRows] })
}

/**
 * The refresh a history undo/redo runs after the backend acknowledges: pull the
 * engine's restored filter-hidden set back into the render cache, then refetch
 * the visible projection so SUBTOTAL 101-111 and withheld rows both surface.
 */
async function refreshAfterHistory(store: Store, backend: SpreadsheetBackend): Promise<void> {
  await reconcileFilterHiddenFromEngine(store, backend)
  await refreshVisibleProjection(store, backend)
}

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
    refreshProjection: () => refreshAfterHistory(store, backend),
  })
  return outcome === 'completed'
}

export async function dispatchRedo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const outcome = await store.setter(runRedoHistoryAtom, {
    source: backend,
    refreshProjection: () => refreshAfterHistory(store, backend),
  })
  return outcome === 'completed'
}

export async function retryHistoryRefresh(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const outcome = await store.setter(retryHistoryRefreshAtom, {
    refreshProjection: () => refreshAfterHistory(store, backend),
  })
  return outcome === 'completed'
}
