import { atom } from '@einfach/core'
import {
  setMultiRegionSelectionAtom,
  setSelectionAtom,
  type SelectionRegion,
} from '../selection'
import {
  DEFAULT_GO_TO_LOCATOR,
  GO_TO_HISTORY_MAX,
  type GoToLocator,
  type GoToMode,
  type GoToScanResult,
  type GoToTarget,
} from './types'

export * from './types'
export { parseGoToReference } from './reference-parser'
export { runGoToSpecialScan } from './locator-engine'

/** Whether the dialog is shown. */
export const goToOpenAtom = atom<boolean>(false)
goToOpenAtom.debugLabel = 'spreadsheet.goTo.open'

/** Active dialog tab — simple Go To vs Go To Special. */
export const goToModeAtom = atom<GoToMode>('simple')
goToModeAtom.debugLabel = 'spreadsheet.goTo.mode'

/** Free-form text input for the simple-mode address / range / name field. */
export const goToInputAtom = atom<string>('')
goToInputAtom.debugLabel = 'spreadsheet.goTo.input'

/** Active radio in the Go To Special pane. */
export const goToLocatorAtom = atom<GoToLocator>(DEFAULT_GO_TO_LOCATOR)
goToLocatorAtom.debugLabel = 'spreadsheet.goTo.locator'

/**
 * Recent-jumps history (most recent first). Bounded at GO_TO_HISTORY_MAX
 * entries; duplicates are deduplicated (the existing slot moves to the
 * front).
 */
export const goToHistoryAtom = atom<readonly string[]>([])
goToHistoryAtom.debugLabel = 'spreadsheet.goTo.history'

/**
 * Last error code surfaced by `confirmGoToAtom` — `null` when the previous
 * commit succeeded. The Solid dialog binds this for the inline error band.
 */
export const goToErrorAtom = atom<string | null>(null)
goToErrorAtom.debugLabel = 'spreadsheet.goTo.error'

export const openGoToAtom = atom(
  (get) => get(goToOpenAtom),
  (_get, set) => {
    set(goToOpenAtom, true)
    set(goToErrorAtom, null)
  },
)
openGoToAtom.debugLabel = 'spreadsheet.goTo.openCommand'

export const closeGoToAtom = atom(
  (get) => get(goToOpenAtom),
  (_get, set) => {
    set(goToOpenAtom, false)
    set(goToErrorAtom, null)
    set(goToInputAtom, '')
  },
)
closeGoToAtom.debugLabel = 'spreadsheet.goTo.close'

export const setGoToModeAtom = atom(
  (get) => get(goToModeAtom),
  (_get, set, mode: GoToMode) => {
    set(goToModeAtom, mode)
    set(goToErrorAtom, null)
  },
)
setGoToModeAtom.debugLabel = 'spreadsheet.goTo.setMode'

export const setGoToInputAtom = atom(
  (get) => get(goToInputAtom),
  (_get, set, input: string) => {
    set(goToInputAtom, input)
    set(goToErrorAtom, null)
  },
)
setGoToInputAtom.debugLabel = 'spreadsheet.goTo.setInput'

export const setGoToLocatorAtom = atom(
  (get) => get(goToLocatorAtom),
  (_get, set, locator: GoToLocator) => {
    set(goToLocatorAtom, locator)
  },
)
setGoToLocatorAtom.debugLabel = 'spreadsheet.goTo.setLocator'

/**
 * Push a (deduplicated) entry to the front of the recent-jumps list and
 * trim at GO_TO_HISTORY_MAX.
 */
export const pushGoToHistoryAtom = atom(
  null,
  (get, set, entry: string) => {
    const trimmed = entry.trim()
    if (trimmed.length === 0) return
    const existing = get(goToHistoryAtom)
    const filtered = existing.filter((e) => e.toLowerCase() !== trimmed.toLowerCase())
    const next = [trimmed, ...filtered].slice(0, GO_TO_HISTORY_MAX)
    set(goToHistoryAtom, next)
  },
)
pushGoToHistoryAtom.debugLabel = 'spreadsheet.goTo.pushHistory'

export const setGoToErrorAtom = atom(
  (get) => get(goToErrorAtom),
  (_get, set, code: string | null) => {
    set(goToErrorAtom, code)
  },
)
setGoToErrorAtom.debugLabel = 'spreadsheet.goTo.setError'

/**
 * Apply a parsed Go To target to the workbook selection. Single-cell targets
 * route through `setSelectionAtom` as a 'cell' selection; range targets as
 * 'range'. The dialog calls this from its commit handler after parsing.
 */
export const applyGoToTargetAtom = atom(
  null,
  (_get, set, target: GoToTarget) => {
    if (target.range) {
      const r = target.range
      if (r.rowStart === r.rowEnd && r.colStart === r.colEnd) {
        set(setSelectionAtom, {
          kind: 'cell',
          sheetId: target.sheetId,
          anchor: { row: r.rowStart, col: r.colStart },
          focus: { row: r.rowStart, col: r.colStart },
        })
      } else {
        set(setSelectionAtom, {
          kind: 'range',
          sheetId: target.sheetId,
          anchor: { row: r.rowStart, col: r.colStart },
          focus: { row: r.rowEnd, col: r.colEnd },
        })
      }
      return
    }
    if (target.coord) {
      set(setSelectionAtom, {
        kind: 'cell',
        sheetId: target.sheetId,
        anchor: target.coord,
        focus: target.coord,
      })
    }
  },
)
applyGoToTargetAtom.debugLabel = 'spreadsheet.goTo.applyTarget'

/**
 * Surface a Go To Special locator scan as the workbook selection. Routes
 * through `setMultiRegionSelectionAtom` so N matches emit a single atom
 * notification — adding regions one-by-one with `addSelectionRegionAtom`
 * would notify subscribers N times and trigger O(N) re-renders.
 *
 * Empty scans collapse to a single-cell selection at (0,0) of the source
 * sheet (the multi-region setter's fallback) so the active cell remains
 * defined. Use the scan's `totalMatchCount === 0` to flag "no cells found".
 */
export const applyGoToSpecialResultAtom = atom(
  null,
  (_get, set, input: { result: GoToScanResult; sheetId: string }) => {
    if (input.result.regions.length === 0) {
      set(setSelectionAtom, {
        kind: 'cell',
        sheetId: input.sheetId,
        anchor: { row: 0, col: 0 },
        focus: { row: 0, col: 0 },
      })
      return
    }
    set(setMultiRegionSelectionAtom, {
      regions: input.result.regions as readonly SelectionRegion[],
      primaryIndex: 0,
    })
  },
)
applyGoToSpecialResultAtom.debugLabel = 'spreadsheet.goTo.applySpecialResult'

/**
 * High-level "confirm" command used by the dialog footer / Enter handler.
 *
 * The Solid host owns the asynchronous read-range projection, so this atom
 * does NOT contact the backend. It takes a pre-resolved payload from the
 * caller (parse outcome or scan result) and applies it:
 *
 *   - `kind: 'simple-target'` → `applyGoToTargetAtom`
 *     History entry: caller-supplied (`historyEntry` field).
 *
 *   - `kind: 'special-result'` → `applyGoToSpecialResultAtom`
 *
 *   - `kind: 'parse-error'` → push the error code into `goToErrorAtom`
 *     and leave the dialog open.
 */
export type ConfirmGoToInput =
  | {
      kind: 'simple-target'
      target: GoToTarget
      historyEntry?: string
    }
  | {
      kind: 'special-result'
      sheetId: string
      result: GoToScanResult
    }
  | {
      kind: 'parse-error'
      code: string
    }

export const confirmGoToAtom = atom(
  null,
  (get, set, input: ConfirmGoToInput) => {
    switch (input.kind) {
      case 'simple-target':
        set(applyGoToTargetAtom, input.target)
        if (input.historyEntry !== undefined) {
          set(pushGoToHistoryAtom, input.historyEntry)
        }
        set(goToErrorAtom, null)
        set(goToOpenAtom, false)
        set(goToInputAtom, '')
        return
      case 'special-result':
        set(applyGoToSpecialResultAtom, {
          result: input.result,
          sheetId: input.sheetId,
        })
        set(goToErrorAtom, null)
        set(goToOpenAtom, false)
        return
      case 'parse-error':
        set(goToErrorAtom, input.code)
        return
    }
    // Compile-time exhaustiveness check — `get` is unused but referenced
    // so the closure type-checks against the readonly setter signature.
    void get
  },
)
confirmGoToAtom.debugLabel = 'spreadsheet.goTo.confirm'
