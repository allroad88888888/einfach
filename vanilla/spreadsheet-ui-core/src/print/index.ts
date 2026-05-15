import { atom } from '@einfach/core'
import type { PrintConfig, ManualPageBreak } from './types'

export * from './types'

export const DEFAULT_PRINT_CONFIG: PrintConfig = {
  manualPageBreaks: [],
  scale: { kind: 'percent', percent: 100 },
  orientation: 'portrait',
}

export const printConfigStateAtom = atom<Record<string, PrintConfig>>({})
printConfigStateAtom.debugLabel = 'spreadsheet.print.config'

export const printPreviewOpenAtom = atom(false)
printPreviewOpenAtom.debugLabel = 'spreadsheet.print.previewOpen'

export const pageSetupDialogOpenAtom = atom(false)
pageSetupDialogOpenAtom.debugLabel = 'spreadsheet.print.pageSetupOpen'

export const setPrintConfigAtom = atom(
  null,
  (_get, set, input: { sheetId: string; config: PrintConfig }) => {
    set(printConfigStateAtom, (prev) => ({ ...prev, [input.sheetId]: input.config }))
  },
)
setPrintConfigAtom.debugLabel = 'spreadsheet.print.setConfig'

export const clearPrintConfigAtom = atom(null, (_get, set, sheetId: string) => {
  set(printConfigStateAtom, (prev) => {
    const next = { ...prev }
    delete next[sheetId]
    return next
  })
})
clearPrintConfigAtom.debugLabel = 'spreadsheet.print.clearConfig'

export const togglePrintPreviewAtom = atom(null, (get, set) => {
  set(printPreviewOpenAtom, !get(printPreviewOpenAtom))
})
togglePrintPreviewAtom.debugLabel = 'spreadsheet.print.togglePreview'

export const togglePageSetupDialogAtom = atom(null, (get, set) => {
  set(pageSetupDialogOpenAtom, !get(pageSetupDialogOpenAtom))
})
togglePageSetupDialogAtom.debugLabel = 'spreadsheet.print.togglePageSetup'

/**
 * Shift manual page break indices after row/column insertions or deletions.
 *
 * Breaks on the given axis with index >= fromIndex are shifted by delta.
 * Breaks on other axes are returned unchanged.
 * Returns the input array unchanged when delta is 0.
 */
export function shiftManualPageBreaks(
  breaks: ManualPageBreak[],
  axis: 'row' | 'column',
  fromIndex: number,
  delta: number,
): ManualPageBreak[] {
  if (delta === 0) return breaks

  return breaks.map((brk) => {
    if (brk.axis !== axis || brk.index < fromIndex) return brk
    return { axis: brk.axis, index: brk.index + delta }
  })
}
