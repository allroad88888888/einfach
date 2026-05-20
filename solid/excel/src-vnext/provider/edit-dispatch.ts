import type { Store } from '@einfach/core'
import {
  commitEditingAtom,
  cancelEditingAtom,
  editingDraftAtom,
  editingSessionAtom,
  enterFormulaReferenceAtom,
  exitFormulaReferenceAtom,
  formulaReferenceCaretAtom,
  formulaReferenceSessionAtom,
  nextHistoryTransactionId,
  pushHistoryAtom,
  shouldEnterFormulaReferenceMode,
  type EditingCommitMove,
  type FormulaReferenceExitReason,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import {
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
  spreadsheetProjectionSnapshotAtom,
} from './atoms'

async function refreshVisibleProjection(
  store: Store,
  backend: SpreadsheetBackend,
  sheetId: string,
): Promise<void> {
  if (!backend.readVisibleProjection) return
  const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
  if (!isVisibleProjectionResult(snapshot.result)) return
  const window = snapshot.result.window
  const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
  try {
    const result = await backend.readVisibleProjection({
      kind: 'visible-window',
      sheetId,
      requestId,
      reason: 'formula-bar',
      window,
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId,
        requestId,
        reason: 'formula-bar',
        window,
      },
      result,
      error: undefined,
    })
  } catch {
    // Leave existing snapshot on read failure.
  }
}

/**
 * Commit the active editing session by pulling the latest draft, running it
 * through the backend setCellInput port, pushing a history entry and
 * refreshing the visible projection. Used by both the formula bar and the
 * grid in-cell editor so the two paths share identical post-commit wiring.
 *
 * Returns true if a commit was actually dispatched. Returns false when no
 * editing session was active (i.e. commitEditingAtom returned null).
 */
export async function dispatchEditingCommit(
  store: Store,
  backend: SpreadsheetBackend,
  options: { move?: EditingCommitMove; source?: 'cell' | 'formula-bar' | 'keyboard' | 'paste' } = {},
): Promise<boolean> {
  // Clear any active formula-reference pick session before committing —
  // otherwise the next pointer click after commit would still route to
  // pickFormulaReferenceAtom and silently mutate an empty draft.
  if (store.getter(formulaReferenceSessionAtom) !== null) {
    store.setter(exitFormulaReferenceAtom, 'commit' as FormulaReferenceExitReason)
  }
  const draft = store.getter(editingDraftAtom)
  const intent = store.setter(commitEditingAtom, {
    input: draft,
    move: options.move ?? 'none',
    source: options.source ?? 'cell',
  })
  if (!intent) return false

  const result = await backend.setCellInput({
    kind: 'set-cell-input',
    sheetId: intent.sheetId,
    row: intent.cell.row,
    col: intent.cell.col,
    input: intent.input,
  })
  const revision =
    typeof result?.revision === 'number'
      ? result.revision
      : Number(result?.revision ?? 0) || 0
  store.setter(pushHistoryAtom, {
    transactionId: nextHistoryTransactionId(),
    kind: 'cell.set-input',
    sheetId: intent.sheetId,
    projectionRevision: revision,
    affectedRange: result?.affectedRange ?? {
      rowStart: intent.cell.row,
      rowEnd: intent.cell.row,
      colStart: intent.cell.col,
      colEnd: intent.cell.col,
    },
  })
  await refreshVisibleProjection(store, backend, intent.sheetId)
  return true
}

/**
 * Cancel the active editing session. Returns true if a session was active.
 */
export function dispatchEditingCancel(store: Store): boolean {
  // Make sure any in-flight formula-reference session is also cleared so the
  // grid does not stay in pick mode after the cell editor exits.
  if (store.getter(formulaReferenceSessionAtom) !== null) {
    store.setter(exitFormulaReferenceAtom, 'cancel' as FormulaReferenceExitReason)
  }
  const intent = store.setter(cancelEditingAtom)
  return intent !== null
}

/**
 * Update the formula-reference caret index based on the live DOM selection
 * inside the editing input. Also handles auto-entering formula-reference mode
 * when the character before the caret is a trigger (=, +, -, *, /, ^, &, (, ,,
 * <, >, %) and the character at the caret is end-of-string or ')'.
 *
 * The host calls this on every selectionchange / input event from the formula
 * bar or in-cell editor while editing is active.
 */
export function syncFormulaReferenceCaret(store: Store, caret: number): void {
  store.setter(formulaReferenceCaretAtom, caret)
  const session = store.getter(editingSessionAtom)
  if (session.status !== 'drafting' || !session.source) return
  const draft = store.getter(editingDraftAtom)
  const active = store.getter(formulaReferenceSessionAtom) !== null
  if (active) return
  if (!shouldEnterFormulaReferenceMode(draft, caret)) return
  store.setter(enterFormulaReferenceAtom, {
    anchorCell: session.source.cell,
    sheetId: session.source.sheetId,
    insertionCaret: caret,
    draft,
  })
}
