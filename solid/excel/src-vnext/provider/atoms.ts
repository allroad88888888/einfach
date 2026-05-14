import { atom } from '@einfach/core'
import type {
  ProjectionSnapshot,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

export const spreadsheetBackendAtom = atom<SpreadsheetBackend | null>(null)
spreadsheetBackendAtom.debugLabel = 'spreadsheet.vnext.backend'

export const spreadsheetProjectionSnapshotAtom = atom<ProjectionSnapshot>({
  status: 'idle',
  request: undefined,
  result: undefined,
  error: undefined,
})
spreadsheetProjectionSnapshotAtom.debugLabel = 'spreadsheet.vnext.projection.snapshot'

export const spreadsheetProjectionRequestIdAtom = atom(0)
spreadsheetProjectionRequestIdAtom.debugLabel = 'spreadsheet.vnext.projection.requestId'

export const advanceSpreadsheetProjectionRequestIdAtom = atom(
  (get) => get(spreadsheetProjectionRequestIdAtom),
  (get, set) => {
    const next = get(spreadsheetProjectionRequestIdAtom) + 1
    set(spreadsheetProjectionRequestIdAtom, next)
    return next
  },
)
advanceSpreadsheetProjectionRequestIdAtom.debugLabel =
  'spreadsheet.vnext.projection.advanceRequestId'

export function isVisibleProjectionResult(
  result: ProjectionSnapshot['result'],
): result is VisibleProjectionResult {
  return result?.kind === 'visible-window'
}
