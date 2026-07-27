import type { Store } from '@einfach/core'
import {
  historyStackAtom,
  pushHistoryAtom,
  reconcileFilterSortRulesFromEngineAtom,
  retryHistoryRefreshAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  setViewportFilterHiddenRowsAtom,
  type HistoryAction,
  type HistoryCommandOutcome,
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
 * The sheet the entry an undo/redo will replay belongs to — the sheet whose
 * engine filter the whole-workbook `restoreFilters`/reverse-delta REPLACE
 * actually flips. Read SYNCHRONOUSLY before the dispatch, from the same stack
 * witness `runHistoryAction` selects the entry from (undo pops `cursor - 1`,
 * redo replays `cursor`), so it is exactly that entry's sheet. `null` when the
 * stack has nothing to replay (the dispatch blocks and never refreshes) or the
 * entry is workbook-scoped (`sheetId: null`), where only the active sheet is
 * reconciled — matching the pre-fix behavior.
 */
function peekHistoryTargetSheetId(store: Store, action: HistoryAction): string | null {
  const stack = store.getter(historyStackAtom)
  const entry = action === 'undo' ? stack.entries[stack.cursor - 1] : stack.entries[stack.cursor]
  return entry?.sheetId ?? null
}

/**
 * The sheet a history undo/redo targeted, remembered per store so a
 * `retryHistoryRefresh` — which runs AFTER the stack cursor has already moved,
 * so it can no longer peek the entry — reconciles the SAME (possibly
 * off-screen) sheet the failed refresh was for. Written only inside
 * `refreshAfterHistory`, i.e. only when a refresh is actually attempted, so a
 * blocked dispatch (which never refreshes) can never poison it for a later
 * retry.
 */
const lastHistoryRefreshTargetSheetId = new WeakMap<Store, string | null>()

/**
 * Re-hydrate the FILTER render caches from the engine after an undo/redo
 * (design-engine-hidden-rows §6.3, E8; extended 2026-07-22 for filter
 * apply/clear undo). The engine OWNS the filter (rules + derived hidden set)
 * and a structural / filter undo/redo restores it through the engine's own
 * `restoreFilters` snapshot (worker) or the delta (static). This read pulls
 * BOTH restored halves back into UI core's render caches:
 *   - `viewportFilterHiddenAtom` (the grid's paint / navigation / copy source),
 *   - `filterSortStateAtom` (the dropdown funnel indicator + Reapply gate),
 * via `reconcileFilterSortRulesFromEngineAtom` (set-or-remove so an undone
 * apply leaves no stale rules and an undone clear brings them back).
 *
 * Which sheets? The UNION of the currently ACTIVE projection sheet and the
 * sheet the undone/redone entry belongs to (`targetSheetId`). Reconciling only
 * the active sheet (the pre-fix behavior) diverged the moment the two differed:
 * a filter applied on sheet A, then Ctrl+Z while VIEWING sheet B, cleared A's
 * engine filter (the REPLACE flips exactly the entry's sheet) but left A's
 * render caches pinned to a ghost filter that never re-synced — switching back
 * to A still painted the stale set and `buildSortExcludedRows(A)` still pinned
 * rows the engine no longer filters. The entry's sheet is the one that flips
 * because every recorded transaction (filter.set and structural alike) mutates
 * exactly ONE sheet, so exactly one sheet's filter changes per undo/redo. The
 * active sheet stays in the union so a same-sheet undo still repaints and an
 * off-screen undo still reconciles the sheet in view (a no-op when unaffected).
 *
 * Restoring rules matters ONLY for the new apply/clear undo — a STRUCTURAL undo
 * never displaces rules, so re-hydrating them there writes the same rules back
 * (a harmless no-op). Manual-hidden rows keep their own local-replay re-feed, so
 * only the filter axis is written here. A backend without `readSheetHiddenState`
 * (the TS worker, which fails filter closed) has no filter to restore, so the
 * read is skipped. Best-effort: the transaction is already committed, so a read
 * failure on any one sheet never rolls it back.
 */
async function reconcileFilterHiddenFromEngine(
  store: Store,
  backend: SpreadsheetBackend,
  targetSheetId: string | null,
): Promise<void> {
  const read = backend.readSheetHiddenState
  if (typeof read !== 'function') return
  const sheetIds = new Set<string>()
  const active = activeProjectionSheetId(store)
  if (active) sheetIds.add(active)
  if (targetSheetId) sheetIds.add(targetSheetId)
  for (const sheetId of sheetIds) {
    let result: Awaited<ReturnType<NonNullable<SpreadsheetBackend['readSheetHiddenState']>>>
    try {
      result = await read.call(backend, {
        kind: 'sheet-hidden-state',
        sheetId,
      } satisfies SheetHiddenStateRequest)
    } catch {
      continue
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      result.sheetId !== sheetId ||
      !Array.isArray(result.filterRows)
    ) {
      continue
    }
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId, rows: [...result.filterRows] })
    // The rules half re-hydrates only when the backend reports it (E8's static
    // read and the worker both return `filterRules`); an older backend that
    // omits it leaves the rules cache untouched rather than clearing a live
    // filter.
    if (Array.isArray(result.filterRules)) {
      store.setter(reconcileFilterSortRulesFromEngineAtom, {
        sheetId,
        rules: [...result.filterRules],
      })
    }
  }
}

/**
 * The refresh a history undo/redo runs after the backend acknowledges: pull the
 * engine's restored filter-hidden set for the entry's sheet (and the active
 * sheet) back into the render caches, then refetch the visible projection so
 * SUBTOTAL 101-111 and withheld rows both surface. `targetSheetId` is the sheet
 * the replayed entry belongs to; it is also stashed per store so a
 * `retryHistoryRefresh` can reconcile the same sheet after the cursor moved.
 */
async function refreshAfterHistory(
  store: Store,
  backend: SpreadsheetBackend,
  targetSheetId: string | null,
): Promise<void> {
  lastHistoryRefreshTargetSheetId.set(store, targetSheetId)
  await reconcileFilterHiddenFromEngine(store, backend, targetSheetId)
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

const HISTORY_LANE_RETRY_ATTEMPTS = 5

function historyStackWitness(store: Store): { cursor: number; entries: unknown } {
  const stack = store.getter(historyStackAtom)
  return { cursor: stack.cursor, entries: stack.entries }
}

/**
 * `runUndoHistoryAtom` / `runRedoHistoryAtom` return `blocked` as soon as
 * another producer (auto-fill, editing, …) still owns the shared history
 * producer-reservation lane — and it can hold that lane for a few
 * microtasks even after ITS OWN UI-visible result (grid text, history
 * entry) is already showing, because the reservation is released only
 * after that producer's own refresh settles. A Ctrl+Z/Ctrl+Y fired in that
 * narrow window would otherwise see one `blocked` result and never retry,
 * silently dropping the keystroke — a real user-visible undo regression.
 * Retry a bounded number of times, yielding a macrotask between attempts,
 * but only while the stack witness (cursor + entries identity) this
 * dispatch is targeting stays exactly what it started with — any other
 * `blocked` reason (missing capability, invalid revision, nothing to undo)
 * reproduces identically on every attempt and exhausts the retry budget
 * harmlessly.
 */
async function runHistoryDispatchWithLaneRetry(
  store: Store,
  run: () => Promise<HistoryCommandOutcome>,
): Promise<HistoryCommandOutcome> {
  const witness = historyStackWitness(store)
  let outcome = await run()
  let attempt = 0
  while (
    outcome === 'blocked' &&
    attempt < HISTORY_LANE_RETRY_ATTEMPTS &&
    historyStackWitness(store).cursor === witness.cursor &&
    historyStackWitness(store).entries === witness.entries
  ) {
    attempt += 1
    // A macrotask yield, not just a microtask: the producer releasing the
    // lane may itself be waiting on a macrotask-scheduled continuation
    // (e.g. a real transport round-trip), which a `Promise.resolve()`
    // microtask yield would not wait out.
    await new Promise((resolve) => setTimeout(resolve, 0))
    outcome = await run()
  }
  return outcome
}

export async function dispatchUndo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const targetSheetId = peekHistoryTargetSheetId(store, 'undo')
  const outcome = await runHistoryDispatchWithLaneRetry(store, () =>
    store.setter(runUndoHistoryAtom, {
      source: backend,
      refreshProjection: () => refreshAfterHistory(store, backend, targetSheetId),
    }),
  )
  return outcome === 'completed'
}

export async function dispatchRedo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const targetSheetId = peekHistoryTargetSheetId(store, 'redo')
  const outcome = await runHistoryDispatchWithLaneRetry(store, () =>
    store.setter(runRedoHistoryAtom, {
      source: backend,
      refreshProjection: () => refreshAfterHistory(store, backend, targetSheetId),
    }),
  )
  return outcome === 'completed'
}

export async function retryHistoryRefresh(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const targetSheetId = lastHistoryRefreshTargetSheetId.get(store) ?? null
  const outcome = await store.setter(retryHistoryRefreshAtom, {
    refreshProjection: () => refreshAfterHistory(store, backend, targetSheetId),
  })
  return outcome === 'completed'
}
