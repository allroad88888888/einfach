import type { Store } from '@einfach/core'
import {
  redoHistoryAtom,
  resolveHistoryAtom,
  undoHistoryAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import { refreshVisibleProjection } from './projection-refresh'

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
