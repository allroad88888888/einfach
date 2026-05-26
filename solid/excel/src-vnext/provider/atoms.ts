import { atom } from '@einfach/core'
import type {
  ProjectionSnapshot,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

export const spreadsheetBackendAtom = atom<SpreadsheetBackend | null>(null)
spreadsheetBackendAtom.debugLabel = 'spreadsheet.vnext.backend'

/**
 * Derived capability flag: true iff the active backend implements the
 * optional `pasteRange` port. Wave 7.3 wires this into the Edit menu's
 * Paste Special entry (`isAvailable: 'capability'`) so the option hides
 * when the host backend cannot fulfil it.
 */
export const pasteSpecialSupportedAtom = atom((get) => {
  const backend = get(spreadsheetBackendAtom)
  return Boolean(backend?.pasteRange)
})
pasteSpecialSupportedAtom.debugLabel = 'spreadsheet.vnext.pasteSpecial.supported'

/**
 * Derived capability flag: true iff the active backend implements
 * `importCellChunks`. Text to Columns rewrites the source column via
 * this port; without it, the wizard cannot commit, so the menu entry
 * hides entirely (`isAvailable: 'capability'`).
 */
export const textToColumnsSupportedAtom = atom((get) => {
  const backend = get(spreadsheetBackendAtom)
  return Boolean(backend?.importCellChunks)
})
textToColumnsSupportedAtom.debugLabel = 'spreadsheet.vnext.textToColumns.supported'

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
