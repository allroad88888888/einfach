import type { Store } from '@einfach/core'
import {
  redoHistoryAtom,
  resolveHistoryAtom,
  undoHistoryAtom,
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
): Promise<void> {
  if (!backend.readVisibleProjection) return
  const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
  if (!isVisibleProjectionResult(snapshot.result)) return
  const window = snapshot.result.window
  const sheetId = snapshot.result.sheetId
  const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
  try {
    const result = await backend.readVisibleProjection({
      kind: 'visible-window',
      sheetId,
      requestId,
      reason: 'toolbar',
      window,
    })
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request: {
        kind: 'visible-window',
        sheetId,
        requestId,
        reason: 'toolbar',
        window,
      },
      result,
      error: undefined,
    })
  } catch {
    // Leave the existing snapshot in place on read failure.
  }
}

export async function dispatchUndo(
  store: Store,
  backend: SpreadsheetBackend,
): Promise<boolean> {
  const entry = store.setter(undoHistoryAtom)
  if (!entry) return false
  if (!backend.undoTransaction) {
    store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: true })
    return true
  }
  try {
    const result = await backend.undoTransaction({
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
  const entry = store.setter(redoHistoryAtom)
  if (!entry) return false
  if (!backend.redoTransaction) {
    store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: true })
    return true
  }
  try {
    const result = await backend.redoTransaction({
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
