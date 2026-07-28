import type { Store } from '@einfach/core'
import {
  beginProjectionAtom,
  rejectProjectionAtom,
  resolveProjectionAtom,
  type ProjectionRequestReason,
  type SpreadsheetBackend,
  type VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import { isVisibleProjectionResult, spreadsheetProjectionSnapshotAtom } from './atoms'

/**
 * Owns the single visible-projection transport and drains the store-local
 * latest-only successor queue. Callers must pass only a request returned as
 * `started`; requests returned as `queued` are drained by the active owner.
 *
 * The returned promise represents the whole drained batch: an older failure
 * with a successor is superseded, while a terminal failure from the final
 * request is rethrown.
 */
export async function runVisibleProjectionTransport(
  store: Store,
  backend: SpreadsheetBackend,
  initialRequest: VisibleProjectionRequest,
): Promise<void> {
  let request = initialRequest

  while (true) {
    try {
      const result = await backend.readVisibleProjection(request)
      const outcome = store.setter(resolveProjectionAtom, { request, result })
      if (outcome.nextRequest) {
        request = outcome.nextRequest
        continue
      }
      return
    } catch (error) {
      const outcome = store.setter(rejectProjectionAtom, { request, error })
      if (outcome.status === 'rejected' && outcome.nextRequest) {
        request = outcome.nextRequest
        continue
      }
      throw error
    }
  }
}

export async function refreshVisibleProjection(
  store: Store,
  backend: SpreadsheetBackend,
  sheetId?: string,
  reason: ProjectionRequestReason = 'toolbar',
): Promise<void> {
  const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
  const window = isVisibleProjectionResult(snapshot.result)
    ? snapshot.result.window
    : snapshot.request?.kind === 'visible-window'
      ? snapshot.request.window
      : undefined
  const resolvedSheetId =
    sheetId ??
    (isVisibleProjectionResult(snapshot.result)
      ? snapshot.result.sheetId
      : snapshot.request?.kind === 'visible-window'
        ? snapshot.request.sheetId
        : undefined)
  if (!window || !resolvedSheetId) return

  const begin = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: resolvedSheetId,
    window,
    reason,
    retainResult: true,
  })
  if (begin.status !== 'started' || begin.request.kind !== 'visible-window') return
  await runVisibleProjectionTransport(store, backend, begin.request)
}
