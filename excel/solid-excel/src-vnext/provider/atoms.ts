import { atom } from '@einfach/core'
import {
  issueProjectionRequestIdAtom,
  pasteSpecialCapabilityAtom,
  projectionRequestIdAtom,
  projectionSnapshotAtom,
  type ProjectionSnapshot,
  type SpreadsheetBackend,
  type VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

export const spreadsheetBackendAtom = atom<SpreadsheetBackend | null>(null)
spreadsheetBackendAtom.debugLabel = 'spreadsheet.vnext.backend'

/** @deprecated Use UI-core's canonical read-only `pasteSpecialCapabilityAtom`. */
export const pasteSpecialSupportedAtom = pasteSpecialCapabilityAtom

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

/** Solid compatibility aliases; projection state is owned by UI-core. */
export const spreadsheetProjectionSnapshotAtom = projectionSnapshotAtom
export const spreadsheetProjectionRequestIdAtom = projectionRequestIdAtom

/** @deprecated Dispatch projection work through UI-core's lifecycle atoms. */
export const advanceSpreadsheetProjectionRequestIdAtom = issueProjectionRequestIdAtom

export function isVisibleProjectionResult(
  result: ProjectionSnapshot['result'],
): result is VisibleProjectionResult {
  return result?.kind === 'visible-window'
}
