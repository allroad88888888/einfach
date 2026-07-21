import { atom, type Getter } from '@einfach/core'
import type { RangeProjectionRequest, RangeProjectionResult } from '../backend'
import {
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  setMultiRegionSelectionAtom,
  setSelectionAtom,
  type SelectionRegion,
} from '../selection'
import { sheetTabsSheetsAtom } from '../sheet-tabs'
import type { CellRange } from '../shared'
import { effectiveHiddenAtom, viewportMetricsAtom } from '../viewport'
import { workspaceActiveSheetAuthorityWitnessAtom, workspaceSessionAtom } from '../workspace'
import { runGoToSpecialScan } from './locator-engine'
import {
  DEFAULT_GO_TO_LOCATOR,
  GO_TO_HISTORY_MAX,
  GO_TO_REGION_CAP,
  GO_TO_SCAN_MAX_CELLS,
  type GoToCandidateCell,
  type GoToErrorDetails,
  type GoToLocator,
  type GoToMode,
  type GoToScanResult,
  type GoToSpecialCapability,
  type GoToSpecialLifecycle,
  type GoToSpecialWarning,
  type GoToTarget,
  type RunGoToSpecialScanInput,
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

interface GoToSpecialScanState {
  status: 'idle' | 'scanning'
  sessionId: number
  requestId: number | null
  sheetId: string | null
  locator: GoToLocator | null
  workspaceWitness: unknown
  selectionWitness: unknown
}

interface GoToSpecialReservation {
  sessionId: number
  workspaceWitness: unknown
  selectionWitness: unknown
}

const EMPTY_GO_TO_ERROR: GoToErrorDetails = Object.freeze({
  code: null,
  params: null,
  message: null,
})

const IDLE_SPECIAL_SCAN: GoToSpecialScanState = Object.freeze({
  status: 'idle',
  sessionId: 0,
  requestId: null,
  sheetId: null,
  locator: null,
  workspaceWitness: null,
  selectionWitness: null,
})

const goToErrorStateAtom = atom<GoToErrorDetails>(EMPTY_GO_TO_ERROR)
goToErrorStateAtom.debugLabel = 'spreadsheet.goTo.internal.errorState'

const goToSessionSequenceAtom = atom(0)
goToSessionSequenceAtom.debugLabel = 'spreadsheet.goTo.internal.sessionSequence'

const goToSpecialRequestSequenceAtom = atom(0)
goToSpecialRequestSequenceAtom.debugLabel = 'spreadsheet.goTo.internal.specialRequestSequence'

const goToSpecialScanStateAtom = atom<GoToSpecialScanState>(IDLE_SPECIAL_SCAN)
goToSpecialScanStateAtom.debugLabel = 'spreadsheet.goTo.internal.specialScanState'

const goToSpecialReservationAtom = atom<GoToSpecialReservation | null>(null)
goToSpecialReservationAtom.debugLabel = 'spreadsheet.goTo.internal.specialReservation'

const goToSpecialCapabilityStateAtom = atom<GoToSpecialCapability>('unknown')
goToSpecialCapabilityStateAtom.debugLabel = 'spreadsheet.goTo.internal.specialCapability'

const goToSpecialWarningStateAtom = atom<GoToSpecialWarning | null>(null)
goToSpecialWarningStateAtom.debugLabel = 'spreadsheet.goTo.internal.specialWarning'

/**
 * Last error code surfaced by `confirmGoToAtom` — `null` when the previous
 * commit succeeded. The Solid dialog binds this for the inline error band.
 */
export const goToErrorAtom = atom(
  (get) => get(goToErrorStateAtom).code,
  (_get, set, code: string | null) => {
    set(
      goToErrorStateAtom,
      code === null ? EMPTY_GO_TO_ERROR : Object.freeze({ code, params: null, message: null }),
    )
  },
)
goToErrorAtom.debugLabel = 'spreadsheet.goTo.error'

export const goToErrorParamsAtom = atom((get) => get(goToErrorStateAtom).params)
goToErrorParamsAtom.debugLabel = 'spreadsheet.goTo.errorParams'

export const goToErrorMessageAtom = atom((get) => get(goToErrorStateAtom).message)
goToErrorMessageAtom.debugLabel = 'spreadsheet.goTo.errorMessage'

export const goToSpecialCapabilityAtom = atom((get) => get(goToSpecialCapabilityStateAtom))
goToSpecialCapabilityAtom.debugLabel = 'spreadsheet.goTo.specialCapability'

export const goToSpecialPendingAtom = atom((get) => {
  const reservation = get(goToSpecialReservationAtom)
  return (
    reservation !== null &&
    get(goToOpenAtom) &&
    get(goToModeAtom) === 'special' &&
    reservation.sessionId === get(goToSessionSequenceAtom) &&
    reservation.workspaceWitness === get(workspaceActiveSheetAuthorityWitnessAtom) &&
    reservation.selectionWitness === get(selectionAuthorityWitnessAtom)
  )
})
goToSpecialPendingAtom.debugLabel = 'spreadsheet.goTo.specialPending'

export const goToSpecialWarningAtom = atom((get) => get(goToSpecialWarningStateAtom))
goToSpecialWarningAtom.debugLabel = 'spreadsheet.goTo.specialWarning'

export const goToSpecialLifecycleAtom = atom((get): GoToSpecialLifecycle => {
  const sessionId = get(goToSessionSequenceAtom)
  const capability = get(goToSpecialCapabilityStateAtom)
  if (!get(goToOpenAtom)) {
    return Object.freeze({ phase: 'closed', sessionId, capability })
  }
  const scan = get(goToSpecialScanStateAtom)
  if (
    scan.status === 'scanning' &&
    scan.sessionId === sessionId &&
    scan.requestId !== null &&
    scan.sheetId !== null &&
    scan.locator !== null &&
    scan.workspaceWitness === get(workspaceActiveSheetAuthorityWitnessAtom) &&
    scan.selectionWitness === get(selectionAuthorityWitnessAtom)
  ) {
    return Object.freeze({
      phase: 'scanning',
      sessionId,
      requestId: scan.requestId,
      sheetId: scan.sheetId,
      locator: snapshotLocator(scan.locator),
      capability,
    })
  }
  const mode = get(goToModeAtom)
  const warning = get(goToSpecialWarningStateAtom)
  if (mode === 'special' && warning !== null) {
    return Object.freeze({ phase: 'open-warning', sessionId, capability, mode, warning })
  }
  const error = get(goToErrorStateAtom)
  if (error.code !== null || error.message !== null) {
    return Object.freeze({ phase: 'open-error', sessionId, capability, mode, error })
  }
  return Object.freeze({ phase: 'open', sessionId, capability, mode })
})
goToSpecialLifecycleAtom.debugLabel = 'spreadsheet.goTo.specialLifecycle'

export const openGoToAtom = atom(
  (get) => get(goToOpenAtom),
  (get, set) => {
    const sessionId = nextGoToSessionId(get(goToSessionSequenceAtom))
    if (sessionId === null) {
      set(goToOpenAtom, false)
      set(goToSpecialWarningStateAtom, null)
      set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
      set(goToSpecialReservationAtom, null)
      set(
        goToErrorStateAtom,
        explicitSpecialError(
          'goTo.error.identityExhausted',
          'Go To cannot open because its session identity space is exhausted.',
        ),
      )
      return
    }
    set(goToSessionSequenceAtom, sessionId)
    set(goToOpenAtom, true)
    set(goToModeAtom, 'simple')
    set(goToInputAtom, '')
    set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
    set(goToSpecialWarningStateAtom, null)
    set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
    set(goToSpecialReservationAtom, null)
  },
)
openGoToAtom.debugLabel = 'spreadsheet.goTo.openCommand'

export const closeGoToAtom = atom(
  (get) => get(goToOpenAtom),
  (get, set) => {
    const sessionId = nextGoToSessionId(get(goToSessionSequenceAtom))
    if (sessionId !== null) {
      set(goToSessionSequenceAtom, sessionId)
    }
    set(goToOpenAtom, false)
    set(
      goToErrorStateAtom,
      sessionId === null
        ? explicitSpecialError(
            'goTo.error.identityExhausted',
            'Go To closed because its session identity space is exhausted.',
          )
        : EMPTY_GO_TO_ERROR,
    )
    set(goToInputAtom, '')
    set(goToSpecialWarningStateAtom, null)
    set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
    set(goToSpecialReservationAtom, null)
  },
)
closeGoToAtom.debugLabel = 'spreadsheet.goTo.close'

export const setGoToModeAtom = atom(
  (get) => get(goToModeAtom),
  (get, set, mode: GoToMode) => {
    set(goToModeAtom, mode)
    set(goToSpecialWarningStateAtom, null)
    set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
    set(goToSpecialReservationAtom, null)
    if (mode === 'special' && get(goToSpecialCapabilityStateAtom) === 'unavailable') {
      set(goToErrorStateAtom, unavailableSpecialError())
      return
    }
    set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
  },
)
setGoToModeAtom.debugLabel = 'spreadsheet.goTo.setMode'

export const setGoToInputAtom = atom(
  (get) => get(goToInputAtom),
  (_get, set, input: string) => {
    set(goToInputAtom, input)
    set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
  },
)
setGoToInputAtom.debugLabel = 'spreadsheet.goTo.setInput'

export const setGoToLocatorAtom = atom(
  (get) => get(goToLocatorAtom),
  (_get, set, locator: GoToLocator) => {
    set(goToLocatorAtom, snapshotLocator(locator))
    set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
    set(goToSpecialWarningStateAtom, null)
    set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
    set(goToSpecialReservationAtom, null)
  },
)
setGoToLocatorAtom.debugLabel = 'spreadsheet.goTo.setLocator'

/**
 * Push a (deduplicated) entry to the front of the recent-jumps list and
 * trim at GO_TO_HISTORY_MAX.
 */
export const pushGoToHistoryAtom = atom(null, (get, set, entry: string) => {
  const trimmed = entry.trim()
  if (trimmed.length === 0) return
  const existing = get(goToHistoryAtom)
  const filtered = existing.filter((e) => e.toLowerCase() !== trimmed.toLowerCase())
  const next = [trimmed, ...filtered].slice(0, GO_TO_HISTORY_MAX)
  set(goToHistoryAtom, next)
})
pushGoToHistoryAtom.debugLabel = 'spreadsheet.goTo.pushHistory'

export const setGoToErrorAtom = atom(
  (get) => get(goToErrorAtom),
  (_get, set, code: string | null) => {
    set(goToErrorAtom, code)
  },
)
setGoToErrorAtom.debugLabel = 'spreadsheet.goTo.setError'

export const setGoToErrorDetailsAtom = atom(
  (get) => get(goToErrorStateAtom),
  (_get, set, details: GoToErrorDetails) => {
    set(goToErrorStateAtom, snapshotError(details))
  },
)
setGoToErrorDetailsAtom.debugLabel = 'spreadsheet.goTo.setErrorDetails'

export const setGoToSpecialCapabilityAtom = atom(
  (get) => get(goToSpecialCapabilityStateAtom),
  (get, set, capability: GoToSpecialCapability) => {
    set(goToSpecialCapabilityStateAtom, capability)
    if (!get(goToOpenAtom) || get(goToModeAtom) !== 'special') return
    const error = get(goToErrorStateAtom)
    if (capability === 'unavailable') {
      set(goToErrorStateAtom, unavailableSpecialError())
    } else if (error.code === 'goTo.error.capabilityUnavailable') {
      set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
    }
  },
)
setGoToSpecialCapabilityAtom.debugLabel = 'spreadsheet.goTo.setSpecialCapability'

/**
 * Apply a parsed Go To target to the workbook selection. Single-cell targets
 * route through `setSelectionAtom` as a 'cell' selection; range targets as
 * 'range'. The dialog calls this from its commit handler after parsing.
 */
export const applyGoToTargetAtom = atom(null, (_get, set, target: GoToTarget) => {
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
})
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
 * Owns the complete async Go To Special scan lifecycle. The framework adapter
 * supplies only the projection port; request/session authority, scan scope,
 * locator evaluation, stale-result rejection, selection commit and visible
 * warning/error state all remain in Core.
 */
export const runGoToSpecialScanAtom = atom(
  null,
  async (get, set, input: RunGoToSpecialScanInput): Promise<void> => {
    const sessionId = get(goToSessionSequenceAtom)
    const workspaceWitness = get(workspaceActiveSheetAuthorityWitnessAtom)
    const launchSelectionWitness = get(selectionAuthorityWitnessAtom)
    const existingReservation = get(goToSpecialReservationAtom)
    if (
      existingReservation !== null &&
      existingReservation.sessionId === sessionId &&
      existingReservation.workspaceWitness === workspaceWitness &&
      existingReservation.selectionWitness === launchSelectionWitness
    ) {
      return
    }
    if (!get(goToOpenAtom) || get(goToModeAtom) !== 'special') return

    const reservation = Object.freeze({
      sessionId,
      workspaceWitness,
      selectionWitness: launchSelectionWitness,
    })
    set(goToSpecialReservationAtom, reservation)

    try {
      const readRangeProjection = input?.port?.readRangeProjection
      if (typeof readRangeProjection !== 'function') {
        set(goToSpecialCapabilityStateAtom, 'unavailable')
        if (goToSpecialLaunchIsCurrent(get, sessionId, workspaceWitness, launchSelectionWitness)) {
          set(goToErrorStateAtom, unavailableSpecialError())
        }
        return
      }
      set(goToSpecialCapabilityStateAtom, 'available')

      const workspace = get(workspaceSessionAtom)
      const sheets = get(sheetTabsSheetsAtom)
      const selection = get(selectionSnapshotAtom)
      const selectionWitness = get(selectionAuthorityWitnessAtom)
      if (selectionWitness !== launchSelectionWitness) return
      const sheetId = workspace.activeSheetId ?? selection.selection.sheetId ?? sheets[0]?.id ?? ''
      if (sheetId.length === 0) {
        if (goToSpecialLaunchIsCurrent(get, sessionId, workspaceWitness, launchSelectionWitness)) {
          set(
            goToErrorStateAtom,
            explicitSpecialError(
              'goTo.error.noActiveSheet',
              'Go To Special needs an active worksheet.',
            ),
          )
        }
        return
      }

      const locator = snapshotLocator(get(goToLocatorAtom))
      const selectionRange = selection.range
      const differenceLocator =
        locator.kind === 'row-differences' || locator.kind === 'column-differences'
      const metrics = get(viewportMetricsAtom)
      const unclippedRange = differenceLocator
        ? selectionRange
        : computeGoToScanRange(metrics.rowCount, metrics.colCount)
      const range = clipGoToScanRange(unclippedRange)
      const rangeWasClipped = !sameRange(range, unclippedRange)
      const requestId = nextGoToSpecialRequestId(get(goToSpecialRequestSequenceAtom))
      if (requestId === null) {
        if (goToSpecialLaunchIsCurrent(get, sessionId, workspaceWitness, launchSelectionWitness)) {
          set(
            goToErrorStateAtom,
            explicitSpecialError(
              'goTo.error.identityExhausted',
              'Go To Special cannot scan because its request identity space is exhausted.',
            ),
          )
        }
        return
      }
      set(goToSpecialRequestSequenceAtom, requestId)
      const request: RangeProjectionRequest = Object.freeze({
        kind: 'range',
        sheetId,
        range: Object.freeze({ ...range }),
        requestId,
        reason: 'diagnostics',
      })
      const scanState: GoToSpecialScanState = Object.freeze({
        status: 'scanning',
        sessionId,
        requestId,
        sheetId,
        locator,
        workspaceWitness,
        selectionWitness,
      })
      set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
      set(goToSpecialWarningStateAtom, null)
      set(goToSpecialScanStateAtom, scanState)

      let projection: RangeProjectionResult
      try {
        projection = await readRangeProjection.call(input.port, request)
      } catch (error) {
        if (goToSpecialTicketIsCurrent(get, scanState, workspaceWitness, selectionWitness)) {
          set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
          set(
            goToErrorStateAtom,
            explicitSpecialError(
              'goTo.error.scanFailed',
              `Go To Special could not read the worksheet: ${errorMessage(error)}`,
            ),
          )
        }
        return
      }

      if (!goToSpecialTicketIsCurrent(get, scanState, workspaceWitness, selectionWitness)) {
        return
      }
      if (!projectionMatchesRequest(projection, request)) {
        set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
        set(
          goToErrorStateAtom,
          explicitSpecialError(
            'goTo.error.projectionMismatch',
            'Go To Special received a projection for a different request or worksheet.',
          ),
        )
        return
      }

      if (projection.truncated === true) {
        // Sparse absence only means "blank" when the projection is complete.
        // A backend-truncated payload can omit occupied cells, so running any
        // locator (especially blanks/region/difference locators) could commit a
        // false selection. Fail closed until a complete continuation exists.
        set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
        set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
        set(
          goToSpecialWarningStateAtom,
          Object.freeze({ reason: 'cells', limit: GO_TO_SCAN_MAX_CELLS }),
        )
        return
      }

      const incompleteResultMustFailClosed =
        rangeWasClipped &&
        (differenceLocator || locator.kind === 'last-cell' || locator.kind === 'current-region')
      if (incompleteResultMustFailClosed) {
        // Difference locators need every cell in the selected rect, while
        // last-cell/current-region need the complete worksheet scan scope.
        // A clipped request cannot produce an exact result for those locators.
        set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
        set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
        set(
          goToSpecialWarningStateAtom,
          Object.freeze({ reason: 'cells', limit: GO_TO_SCAN_MAX_CELLS }),
        )
        return
      }

      // Union (manual ∪ filter): `Go To Special → Visible cells only` asks a
      // pure visibility question, and a row is invisible whichever set put it
      // there. Excluding filter-hidden rows here is what keeps the locator
      // from selecting rows the user cannot see.
      const hidden = get(effectiveHiddenAtom)
      const activeCell = differenceLocator
        ? {
            row: range.rowStart,
            col: range.colStart,
          }
        : selection.activeCell
      const scan = runGoToSpecialScan(locator, {
        sheetId,
        activeCell,
        cells: projection.cells
          .filter((cell) => cellIsInsideRange(cell, range))
          .map(toGoToCandidate),
        searchRect: range,
        selectionRect: differenceLocator ? range : selectionRange,
        hiddenRows: hidden.rowsBySheet[sheetId] ?? [],
        hiddenCols: hidden.colsBySheet[sheetId] ?? [],
      })

      if (!goToSpecialTicketIsCurrent(get, scanState, workspaceWitness, selectionWitness)) {
        return
      }
      const warning: GoToSpecialWarning | null = scan.truncated
        ? Object.freeze({ reason: 'regions', limit: GO_TO_REGION_CAP })
        : rangeWasClipped
          ? Object.freeze({ reason: 'cells', limit: GO_TO_SCAN_MAX_CELLS })
          : null
      if (scan.totalMatchCount === 0) {
        set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
        if (warning !== null) {
          // A bounded projection cannot prove that the locator has no matches.
          // Keep the current selection and leave the dialog open with an explicit
          // incomplete-scan witness instead of reporting a definitive no-match.
          set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
          set(goToSpecialWarningStateAtom, warning)
          return
        }
        set(
          goToErrorStateAtom,
          Object.freeze({
            code: 'goTo.error.noMatches',
            params: null,
            message: null,
          }),
        )
        return
      }

      set(applyGoToSpecialResultAtom, { result: scan, sheetId })
      set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
      set(goToErrorStateAtom, EMPTY_GO_TO_ERROR)
      if (warning !== null) {
        set(goToSpecialWarningStateAtom, warning)
        return
      }
      set(closeGoToAtom)
    } catch (error) {
      if (goToSpecialLaunchIsCurrent(get, sessionId, workspaceWitness, launchSelectionWitness)) {
        set(goToSpecialScanStateAtom, IDLE_SPECIAL_SCAN)
        set(
          goToErrorStateAtom,
          explicitSpecialError(
            'goTo.error.scanFailed',
            `Go To Special could not complete the scan: ${errorMessage(error)}`,
          ),
        )
      }
    } finally {
      if (get(goToSpecialReservationAtom) === reservation) {
        set(goToSpecialReservationAtom, null)
      }
    }
  },
)
runGoToSpecialScanAtom.debugLabel = 'spreadsheet.goTo.runSpecialScan'

/**
 * High-level "confirm" command used by the dialog footer / Enter handler.
 *
 * Simple-mode parsing remains a pure adapter concern. Special-mode adapters
 * dispatch `runGoToSpecialScanAtom`; the pre-resolved `special-result` arm is
 * retained for compatibility with existing callers.
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

export const confirmGoToAtom = atom(null, (get, set, input: ConfirmGoToInput) => {
  switch (input.kind) {
    case 'simple-target':
      set(applyGoToTargetAtom, input.target)
      if (input.historyEntry !== undefined) {
        set(pushGoToHistoryAtom, input.historyEntry)
      }
      set(closeGoToAtom)
      return
    case 'special-result':
      set(applyGoToSpecialResultAtom, {
        result: input.result,
        sheetId: input.sheetId,
      })
      set(closeGoToAtom)
      return
    case 'parse-error':
      set(goToErrorAtom, input.code)
      return
  }
  // Compile-time exhaustiveness check — `get` is unused but referenced
  // so the closure type-checks against the readonly setter signature.
  void get
})
confirmGoToAtom.debugLabel = 'spreadsheet.goTo.confirm'

function snapshotLocator(locator: GoToLocator): GoToLocator {
  if (locator.kind === 'formulas' || locator.kind === 'constants') {
    return Object.freeze({ kind: locator.kind, valueKind: locator.valueKind })
  }
  return Object.freeze({ kind: locator.kind }) as GoToLocator
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

/** Pure production plan; no writable session authority is exposed. */
export function nextGoToSessionId(sessionId: number): number | null {
  return nextSafeMonotonicIdentity(sessionId)
}

/** Pure production plan; no writable request authority is exposed. */
export function nextGoToSpecialRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function sameLocator(left: GoToLocator, right: GoToLocator): boolean {
  if (left.kind !== right.kind) return false
  if (
    (left.kind === 'formulas' || left.kind === 'constants') &&
    (right.kind === 'formulas' || right.kind === 'constants')
  ) {
    return left.valueKind === right.valueKind
  }
  return true
}

function snapshotError(details: GoToErrorDetails): GoToErrorDetails {
  return Object.freeze({
    code: details.code,
    params: details.params === null ? null : Object.freeze({ ...details.params }),
    message: details.message,
  })
}

function explicitSpecialError(code: string, message: string): GoToErrorDetails {
  return Object.freeze({ code, params: null, message })
}

function unavailableSpecialError(): GoToErrorDetails {
  return explicitSpecialError(
    'goTo.error.capabilityUnavailable',
    'Go To Special is unavailable because range projection is not supported.',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function computeGoToScanRange(rowCount: number, colCount: number): CellRange {
  const rows = Math.max(1, Math.trunc(rowCount) || 1)
  const cols = Math.max(1, Math.trunc(colCount) || 1)
  return Object.freeze({
    rowStart: 0,
    rowEnd: rows - 1,
    colStart: 0,
    colEnd: cols - 1,
  })
}

function clipGoToScanRange(range: CellRange): CellRange {
  const columns = range.colEnd - range.colStart + 1
  const rows = range.rowEnd - range.rowStart + 1
  if (columns <= 0 || rows <= 0) return range
  const clippedColumns = Math.min(columns, GO_TO_SCAN_MAX_CELLS)
  const maxRows = Math.max(1, Math.floor(GO_TO_SCAN_MAX_CELLS / clippedColumns))
  const clippedRows = Math.min(rows, maxRows)
  if (clippedColumns === columns && clippedRows === rows) return range
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowStart + clippedRows - 1,
    colStart: range.colStart,
    colEnd: range.colStart + clippedColumns - 1,
  })
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function cellIsInsideRange(
  cell: RangeProjectionResult['cells'][number],
  range: CellRange,
): boolean {
  return (
    cell.row >= range.rowStart &&
    cell.row <= range.rowEnd &&
    cell.col >= range.colStart &&
    cell.col <= range.colEnd
  )
}

function projectionMatchesRequest(
  projection: RangeProjectionResult,
  request: RangeProjectionRequest,
): boolean {
  return (
    projection.kind === request.kind &&
    projection.requestId === request.requestId &&
    projection.sheetId === request.sheetId &&
    sameRange(projection.range, request.range)
  )
}

function toGoToCandidate(cell: RangeProjectionResult['cells'][number]): GoToCandidateCell {
  return {
    row: cell.row,
    col: cell.col,
    displayValue: cell.displayValue ?? '',
    valueKind: cell.valueKind,
    formula: cell.formula,
    commentThreadId: cell.commentThreadId,
    conditionalFormat: cell.conditionalFormat,
    validation: cell.validation,
    originalRow: cell.originalRow,
  }
}

function goToSpecialLaunchIsCurrent(
  get: Getter,
  sessionId: number,
  workspaceWitness: unknown,
  selectionWitness: unknown,
): boolean {
  return (
    get(goToOpenAtom) &&
    get(goToModeAtom) === 'special' &&
    get(goToSessionSequenceAtom) === sessionId &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === workspaceWitness &&
    get(selectionAuthorityWitnessAtom) === selectionWitness
  )
}

function goToSpecialTicketIsCurrent(
  get: Getter,
  ticket: GoToSpecialScanState,
  workspaceWitness: unknown,
  selectionWitness: unknown,
): boolean {
  const live = get(goToSpecialScanStateAtom)
  const activeSheetId =
    get(workspaceSessionAtom).activeSheetId ??
    get(selectionSnapshotAtom).selection.sheetId ??
    get(sheetTabsSheetsAtom)[0]?.id ??
    ''
  return (
    goToSpecialLaunchIsCurrent(get, ticket.sessionId, workspaceWitness, selectionWitness) &&
    live.status === 'scanning' &&
    live.sessionId === ticket.sessionId &&
    live.requestId === ticket.requestId &&
    live.sheetId === ticket.sheetId &&
    live.locator !== null &&
    ticket.locator !== null &&
    sameLocator(live.locator, ticket.locator) &&
    sameLocator(get(goToLocatorAtom), ticket.locator) &&
    activeSheetId === ticket.sheetId &&
    get(selectionAuthorityWitnessAtom) === selectionWitness
  )
}
