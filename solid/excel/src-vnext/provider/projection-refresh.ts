import type { Store } from '@einfach/core'
import {
  createVisibleProjectionRequest,
  type ProjectionRequestReason,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
  spreadsheetProjectionSnapshotAtom,
} from './atoms'

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

  const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
  const request = createVisibleProjectionRequest({
    sheetId: resolvedSheetId,
    window,
    requestId,
    reason,
  })
  store.setter(spreadsheetProjectionSnapshotAtom, {
    status: 'loading',
    request,
    result: snapshot.result,
    error: undefined,
  })

  const result = await backend.readVisibleProjection(request)
  if (store.getter(spreadsheetProjectionSnapshotAtom).request?.requestId !== requestId) return
  store.setter(spreadsheetProjectionSnapshotAtom, {
    status: 'ready',
    request,
    result,
    error: undefined,
  })
}
