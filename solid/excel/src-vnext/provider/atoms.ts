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

/**
 * Derived capability flag: true iff the active backend implements
 * `removeRows`. Remove Duplicates calls `backend.removeRows` with the
 * duplicate row indices at confirm time; without it the dialog has no
 * way to commit, so the Data → Remove Duplicates menu entry hides
 * entirely (`isAvailable: 'capability'`).
 */
export const removeDuplicatesSupportedAtom = atom((get) => {
  const backend = get(spreadsheetBackendAtom)
  return Boolean(backend?.removeRows)
})
removeDuplicatesSupportedAtom.debugLabel = 'spreadsheet.vnext.removeDuplicates.supported'

/**
 * Derived capability flag: true iff the active backend implements both
 * `registerCustomFormula` and `unregisterCustomFormula`. Wave 8 — used
 * by the host provider's effect to decide whether to forward registry
 * mutations to the worker. No menu entry hangs off this in MVP;
 * registration is programmatic.
 */
export const customFormulasSupportedAtom = atom((get) => {
  const backend = get(spreadsheetBackendAtom)
  return Boolean(backend?.registerCustomFormula && backend?.unregisterCustomFormula)
})
customFormulasSupportedAtom.debugLabel = 'spreadsheet.vnext.customFormulas.supported'

/**
 * Sheet snapshot captured when the Remove Duplicates dialog opens. The
 * menubar dispatcher writes the current sheetId BEFORE flipping the open
 * flag so the confirm flow operates on the sheet that was active at
 * open-time, even if the user navigates to another sheet mid-dialog
 * (HIGH bug: wrong-sheet deletion race).
 *
 * Lives in the Solid host layer (not in `spreadsheet-ui-core`'s remove-
 * duplicates module) because sheetId is a workbook-backend concept;
 * leaking it into the framework-agnostic UI core would force-import
 * workbook semantics. `null` means "no sheet captured" — the confirm
 * flow refuses to commit in that case.
 */
export const removeDuplicatesSheetIdAtom = atom<string | null>(null)
removeDuplicatesSheetIdAtom.debugLabel = 'spreadsheet.removeDuplicates.sheetId'

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
