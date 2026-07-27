import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type {
  BackendStructuralShift,
  DisplayCell,
  ProjectionRequestId,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../backend/types'
import { resolveContentMutationAtom } from '../editing/mutation-gateway'
import {
  acquireHistoryProducerReservationAtom,
  pushReservedHistoryAtom,
  releaseHistoryProducerReservationAtom,
} from '../history'
import type { HistoryLocalReplayPayload, HistoryProducerReservation } from '../history'
import {
  primarySelectionRegionAtom,
  selectionAuthorityWitnessAtom,
  selectionRangeAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import type { CellRange } from '../shared'
import {
  applyViewportFreezeStructuralShiftAtom,
  getViewportFreezeForSheet,
  VIEWPORT_FREEZE_REPLAY_KEY,
  viewportFreezeAtom,
} from '../viewport/freeze'
import {
  applyViewportFilterHiddenStructuralShiftAtom,
  getFilterHiddenRowsForSheet,
  viewportFilterHiddenAtom,
} from '../viewport/effective-hidden'
import {
  applyViewportHiddenStructuralShiftAtom,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  VIEWPORT_HIDDEN_REPLAY_KEY,
  viewportHiddenAtom,
} from '../viewport/hidden'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'
import { findDuplicateRows } from './algorithm'
import type {
  OpenRemoveDuplicatesInput,
  RemoveDuplicatesCapabilityState,
  RemoveDuplicatesComparison,
  RemoveDuplicatesControllerPort,
  RemoveDuplicatesIntent,
  RemoveDuplicatesLifecycleState,
  RemoveDuplicatesMutationOutcome,
  RemoveDuplicatesMutationTarget,
  RemoveDuplicatesRange,
  RemoveDuplicatesReadOutcome,
  RemoveDuplicatesScanResult,
  RemoveDuplicatesSessionSnapshot,
  RunRemoveDuplicatesConfirmInput,
  RemoveRowsExactRequest,
  RemoveRowsExactResult,
} from './types'

export * from './types'
export { findDuplicateRows } from './algorithm'

export const REMOVE_DUPLICATES_READ_CAPABILITY_ERROR =
  'Remove Duplicates cannot read the selected range with this workbook backend.'
export const REMOVE_DUPLICATES_REMOVE_CAPABILITY_ERROR =
  'Remove Duplicates is unavailable because this workbook does not provide removeRowsExact.'
export const REMOVE_DUPLICATES_READ_FAILED_ERROR =
  'Remove Duplicates could not load a complete projection for the selected range.'
export const REMOVE_DUPLICATES_READ_STALE_ERROR =
  'The selected range changed while Remove Duplicates was loading. Retry from the current selection.'
export const REMOVE_DUPLICATES_OUTCOME_UNKNOWN_ERROR =
  'Rows may have been removed, but the backend did not return a matching acknowledgement. Refresh or reload the workbook before trying again.'
export const REMOVE_DUPLICATES_REFRESH_ERROR_PREFIX =
  'Rows were removed, but the workbook projection could not be refreshed: '
export const REMOVE_DUPLICATES_HISTORY_BUSY_ERROR =
  'Remove Duplicates is blocked while another mutation owns the history lane.'
export const DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS = 15_000

interface RemoveDuplicatesReadTicket {
  readonly sessionId: number
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceActiveSheetWitness: WorkspaceActiveSheetAuthorityWitness
  readonly source: RemoveDuplicatesControllerPort
  readonly execute: NonNullable<RemoveDuplicatesControllerPort['readRangeProjection']>
  readonly request: Readonly<RangeProjectionRequest>
  readonly timeoutMs: number
}

interface RemoveDuplicatesMutationTicket {
  readonly sessionId: number
  readonly selectionWitness: SelectionAuthorityWitness
  readonly workspaceActiveSheetWitness: WorkspaceActiveSheetAuthorityWitness
  readonly target: RemoveDuplicatesMutationTarget
  readonly request: RemoveRowsExactRequest
  readonly historyReservation: HistoryProducerReservation
  readonly acknowledgement: RemoveRowsExactResult | null
  readonly source: RemoveDuplicatesControllerPort
  readonly execute: NonNullable<RemoveDuplicatesControllerPort['removeRowsExact']>
  readonly refreshProjection: (sheetId: string) => Promise<void>
  readonly timeoutMs: number
  readonly readRequestId: ProjectionRequestId | null
}

type ExactRemoveRowsAcknowledgement = Omit<RemoveRowsExactResult, 'affectedRange'> & {
  readonly affectedRange: NonNullable<RemoveRowsExactResult['affectedRange']>
  readonly historyRecorded: boolean
}

/** `Object.freeze(new Set())` is still writable; expose a mutation-free facade. */
class ImmutableReadonlySet<Value> {
  private readonly items: readonly Value[]

  constructor(values: Iterable<Value>) {
    this.items = Object.freeze(Array.from(new Set(values)))
    Object.freeze(this)
  }

  get size(): number {
    return this.items.length
  }

  has(value: Value): boolean {
    return this.items.includes(value)
  }

  forEach(
    callback: (value: Value, valueAgain: Value, set: ReadonlySet<Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.items) {
      callback.call(thisArg, value, value, this as unknown as ReadonlySet<Value>)
    }
  }

  entries(): IterableIterator<[Value, Value]> {
    return this.items.map((value): [Value, Value] => [value, value]).values()
  }

  keys(): IterableIterator<Value> {
    return this.items.values()
  }

  values(): IterableIterator<Value> {
    return this.items.values()
  }

  [Symbol.iterator](): IterableIterator<Value> {
    return this.items.values()
  }
}

Object.freeze(ImmutableReadonlySet.prototype)

function immutableReadonlySet<Value>(values: Iterable<Value>): ReadonlySet<Value> {
  return new ImmutableReadonlySet(values) as unknown as ReadonlySet<Value>
}

const EMPTY_CELLS: readonly DisplayCell[] = Object.freeze([])
const EMPTY_KEY_COLUMNS: ReadonlySet<number> = immutableReadonlySet([])
const INITIAL_CAPABILITY: RemoveDuplicatesCapabilityState = Object.freeze({
  canRead: false,
  canRemove: false,
})
const INITIAL_LIFECYCLE: RemoveDuplicatesLifecycleState = Object.freeze({
  status: 'closed',
  sessionId: 0,
  readRequestId: null,
  mutationRequestId: null,
  sheetId: null,
})

function snapshotRuntimeValue<Value>(value: Value, seen = new WeakMap<object, unknown>()): Value {
  if (value === null || typeof value !== 'object') return value
  const object = value as unknown as object
  const cached = seen.get(object)
  if (cached !== undefined) return cached as Value
  if (Array.isArray(value)) {
    const clone: unknown[] = []
    seen.set(object, clone)
    for (const item of value) clone.push(snapshotRuntimeValue(item, seen))
    return Object.freeze(clone) as Value
  }
  const clone: Record<string, unknown> = {}
  seen.set(object, clone)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = snapshotRuntimeValue(item, seen)
  }
  return Object.freeze(clone) as Value
}

function snapshotCells(cells: readonly DisplayCell[]): readonly DisplayCell[] {
  return snapshotRuntimeValue(Array.from(cells))
}

function snapshotRange(range: CellRange): Readonly<CellRange> {
  return Object.freeze({
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  })
}

function snapshotRemoveDuplicatesRange(range: RemoveDuplicatesRange): RemoveDuplicatesRange {
  return Object.freeze({
    startRow: range.startRow,
    endRow: range.endRow,
    startCol: range.startCol,
    endCol: range.endCol,
  })
}

function toRemoveDuplicatesRange(range: CellRange): RemoveDuplicatesRange {
  return snapshotRemoveDuplicatesRange({
    startRow: range.rowStart,
    endRow: range.rowEnd,
    startCol: range.colStart,
    endCol: range.colEnd,
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

function validRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowStart <= range.rowEnd &&
    range.colStart <= range.colEnd
  )
}

function validRevision(revision: unknown): revision is ProjectionRevision {
  return (
    (typeof revision === 'number' && Number.isFinite(revision)) ||
    (typeof revision === 'string' && revision.length > 0)
  )
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message
      if (message.length > 0) return message
    }
  } catch {
    return 'Unknown transport failure.'
  }
  try {
    return String(error)
  } catch {
    return 'Unknown transport failure.'
  }
}

async function withRemoveDuplicatesTimeout<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  label: string,
): Promise<Value> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

function normalizeRemoveDuplicatesTimeout(timeoutMs: unknown): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS
}

function lifecycleFor(
  status: RemoveDuplicatesLifecycleState['status'],
  sessionId: number,
  sheetId: string | null,
  readRequestId: ProjectionRequestId | null = null,
  mutationRequestId: ProjectionRequestId | null = null,
): RemoveDuplicatesLifecycleState {
  return Object.freeze({
    status,
    sessionId,
    readRequestId,
    mutationRequestId,
    sheetId,
  })
}

function snapshotScanResult(result: RemoveDuplicatesScanResult): RemoveDuplicatesScanResult {
  return Object.freeze({
    ...result,
    duplicateRows: Object.freeze(Array.from(result.duplicateRows)),
    ignoredColumns: Object.freeze(Array.from(result.ignoredColumns)),
  })
}

function allColumnsInRange(range: RemoveDuplicatesRange): ReadonlySet<number> {
  const columns: number[] = []
  if (range.startCol <= range.endCol) {
    for (let col = range.startCol; col <= range.endCol; col += 1) columns.push(col)
  }
  return immutableReadonlySet(columns)
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

export function nextRemoveDuplicatesSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextRemoveDuplicatesReadRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextRemoveDuplicatesMutationRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

// Private writable product state. Public names below are read-only projections.
const removeDuplicatesOpenStateAtom = atom(false)
const removeDuplicatesRangeStateAtom = atom<RemoveDuplicatesRange | null>(null)
const removeDuplicatesCellsStateAtom = atom<readonly DisplayCell[]>(EMPTY_CELLS)
const removeDuplicatesKeyColumnsStateAtom = atom<ReadonlySet<number>>(EMPTY_KEY_COLUMNS)
const removeDuplicatesComparisonStateAtom = atom<RemoveDuplicatesComparison>('exact')
const removeDuplicatesExcludeHeaderStateAtom = atom(true)
const removeDuplicatesSessionSequenceStateAtom = atom(0)
const removeDuplicatesReadSequenceStateAtom = atom(0)
const removeDuplicatesMutationSequenceStateAtom = atom(0)
const removeDuplicatesSessionStateAtom = atom<RemoveDuplicatesSessionSnapshot | null>(null)
const removeDuplicatesLifecycleStateAtom = atom<RemoveDuplicatesLifecycleState>(INITIAL_LIFECYCLE)
const removeDuplicatesCapabilityStateAtom =
  atom<RemoveDuplicatesCapabilityState>(INITIAL_CAPABILITY)
const removeDuplicatesErrorStateAtom = atom('')
const activeRemoveDuplicatesReadAtom = atom<RemoveDuplicatesReadTicket | null>(null)
const activeRemoveDuplicatesMutationAtom = atom<RemoveDuplicatesMutationTicket | null>(null)

removeDuplicatesOpenStateAtom.debugLabel = 'spreadsheet.removeDuplicates.open.state'
removeDuplicatesRangeStateAtom.debugLabel = 'spreadsheet.removeDuplicates.range.state'
removeDuplicatesCellsStateAtom.debugLabel = 'spreadsheet.removeDuplicates.cells.state'
removeDuplicatesKeyColumnsStateAtom.debugLabel = 'spreadsheet.removeDuplicates.keyColumns.state'
removeDuplicatesComparisonStateAtom.debugLabel = 'spreadsheet.removeDuplicates.comparison.state'
removeDuplicatesExcludeHeaderStateAtom.debugLabel =
  'spreadsheet.removeDuplicates.excludeHeader.state'
removeDuplicatesSessionStateAtom.debugLabel = 'spreadsheet.removeDuplicates.session.state'
removeDuplicatesLifecycleStateAtom.debugLabel = 'spreadsheet.removeDuplicates.lifecycle.state'
activeRemoveDuplicatesReadAtom.debugLabel = 'spreadsheet.removeDuplicates.activeRead'
activeRemoveDuplicatesMutationAtom.debugLabel = 'spreadsheet.removeDuplicates.activeMutation'

export const removeDuplicatesOpenAtom: Atom<boolean> = atom((get) =>
  get(removeDuplicatesOpenStateAtom),
)
export const removeDuplicatesRangeAtom: Atom<RemoveDuplicatesRange | null> = atom((get) =>
  get(removeDuplicatesRangeStateAtom),
)
export const removeDuplicatesScanInputCellsAtom: Atom<readonly DisplayCell[]> = atom((get) =>
  get(removeDuplicatesCellsStateAtom),
)
export const removeDuplicatesKeyColumnsAtom: Atom<ReadonlySet<number>> = atom((get) =>
  get(removeDuplicatesKeyColumnsStateAtom),
)
export const removeDuplicatesComparisonAtom: Atom<RemoveDuplicatesComparison> = atom((get) =>
  get(removeDuplicatesComparisonStateAtom),
)
export const removeDuplicatesExcludeHeaderAtom: Atom<boolean> = atom((get) =>
  get(removeDuplicatesExcludeHeaderStateAtom),
)
export const removeDuplicatesSessionAtom: Atom<RemoveDuplicatesSessionSnapshot | null> = atom(
  (get) => get(removeDuplicatesSessionStateAtom),
)
export const removeDuplicatesLifecycleAtom: Atom<RemoveDuplicatesLifecycleState> = atom((get) =>
  get(removeDuplicatesLifecycleStateAtom),
)
export const removeDuplicatesCapabilityAtom: Atom<RemoveDuplicatesCapabilityState> = atom((get) =>
  get(removeDuplicatesCapabilityStateAtom),
)
export const removeDuplicatesErrorAtom: Atom<string> = atom((get) =>
  get(removeDuplicatesErrorStateAtom),
)
export const removeDuplicatesSessionIdAtom: Atom<number> = atom((get) =>
  get(removeDuplicatesSessionSequenceStateAtom),
)
export const removeDuplicatesReadRequestIdAtom: Atom<number> = atom((get) =>
  get(removeDuplicatesReadSequenceStateAtom),
)
export const removeDuplicatesMutationRequestIdAtom: Atom<number> = atom((get) =>
  get(removeDuplicatesMutationSequenceStateAtom),
)
export const removeDuplicatesMutationTargetAtom: Atom<RemoveDuplicatesMutationTarget | null> = atom(
  (get) => get(activeRemoveDuplicatesMutationAtom)?.target ?? null,
)

removeDuplicatesOpenAtom.debugLabel = 'spreadsheet.removeDuplicates.open'
removeDuplicatesRangeAtom.debugLabel = 'spreadsheet.removeDuplicates.range'
removeDuplicatesScanInputCellsAtom.debugLabel = 'spreadsheet.removeDuplicates.scanInputCells'
removeDuplicatesKeyColumnsAtom.debugLabel = 'spreadsheet.removeDuplicates.keyColumns'
removeDuplicatesComparisonAtom.debugLabel = 'spreadsheet.removeDuplicates.comparison'
removeDuplicatesExcludeHeaderAtom.debugLabel = 'spreadsheet.removeDuplicates.excludeHeader'
removeDuplicatesSessionAtom.debugLabel = 'spreadsheet.removeDuplicates.session'
removeDuplicatesLifecycleAtom.debugLabel = 'spreadsheet.removeDuplicates.lifecycle'
removeDuplicatesCapabilityAtom.debugLabel = 'spreadsheet.removeDuplicates.capability'
removeDuplicatesErrorAtom.debugLabel = 'spreadsheet.removeDuplicates.error'

export const removeDuplicatesPreviewAtom: Atom<RemoveDuplicatesScanResult | null> = atom(
  (get): RemoveDuplicatesScanResult | null => {
    if (!get(removeDuplicatesOpenAtom)) return null
    const range = get(removeDuplicatesRangeAtom)
    if (range === null) return null
    const keyColumns = get(removeDuplicatesKeyColumnsAtom)
    const excludeHeader = get(removeDuplicatesExcludeHeaderAtom)
    const ignoredColumns: number[] = []
    let inRangeCount = 0
    for (const col of keyColumns) {
      if (col >= range.startCol && col <= range.endCol) inRangeCount += 1
      else ignoredColumns.push(col)
    }
    ignoredColumns.sort((left, right) => left - right)
    if (inRangeCount === 0) {
      return snapshotScanResult({
        duplicateRows: [],
        scannedRows: 0,
        uniqueRows: 0,
        ignoredColumns,
        headerRow: excludeHeader && range.startRow <= range.endRow ? range.startRow : null,
        noKeyColumns: true,
      })
    }
    // Filter-hidden rows only. Manually hidden rows keep their real values in
    // the projection and, per Excel, still take part in Remove Duplicates —
    // excluding them here would silently shrink the operation. Filter-hidden
    // rows contribute no cells at all, so the dense walk would read them as
    // all-blank duplicates and delete data the user cannot see (§8.1).
    const sheetId = get(removeDuplicatesLifecycleAtom).sheetId
    const hiddenRows =
      sheetId === null ? [] : getFilterHiddenRowsForSheet(get(viewportFilterHiddenAtom), sheetId)
    return snapshotScanResult(
      findDuplicateRows({
        cells: get(removeDuplicatesScanInputCellsAtom),
        range,
        keyColumns,
        comparison: get(removeDuplicatesComparisonAtom),
        excludeHeader,
        hiddenRows,
      }),
    )
  },
)
removeDuplicatesPreviewAtom.debugLabel = 'spreadsheet.removeDuplicates.preview'

function blocksClose(status: RemoveDuplicatesLifecycleState['status']): boolean {
  return (
    status === 'mutation-pending' ||
    status === 'local-acknowledged' ||
    status === 'refreshing' ||
    status === 'refresh-failed' ||
    status === 'outcome-unknown'
  )
}

export const removeDuplicatesCanEditAtom = atom((get) => {
  return (
    get(removeDuplicatesOpenAtom) &&
    get(removeDuplicatesLifecycleAtom).status === 'editing' &&
    get(activeRemoveDuplicatesMutationAtom) === null
  )
})

export const removeDuplicatesCanCloseAtom = atom((get) => {
  return (
    get(removeDuplicatesOpenAtom) &&
    get(activeRemoveDuplicatesMutationAtom) === null &&
    !blocksClose(get(removeDuplicatesLifecycleAtom).status)
  )
})

export const removeDuplicatesCanRetryReadAtom = atom((get) => {
  const status = get(removeDuplicatesLifecycleAtom).status
  return status === 'read-stale' || status === 'read-failed'
})

export const removeDuplicatesBusyAtom = atom((get) => {
  const status = get(removeDuplicatesLifecycleAtom).status
  return (
    status === 'read-pending' ||
    status === 'mutation-pending' ||
    status === 'local-acknowledged' ||
    status === 'refreshing'
  )
})

export const removeDuplicatesCanConfirmAtom = atom((get) => {
  const lifecycle = get(removeDuplicatesLifecycleAtom)
  const active = get(activeRemoveDuplicatesMutationAtom)
  if (
    lifecycle.status === 'refresh-failed' &&
    active !== null &&
    active.acknowledgement !== null &&
    active.sessionId === lifecycle.sessionId
  ) {
    return true
  }
  if (
    lifecycle.status !== 'editing' ||
    active !== null ||
    get(removeDuplicatesSessionAtom) === null ||
    !get(removeDuplicatesCapabilityAtom).canRemove
  ) {
    return false
  }
  const preview = get(removeDuplicatesPreviewAtom)
  return preview !== null && !preview.noKeyColumns && preview.duplicateRows.length > 0
})

function closeSession(get: Getter, set: Setter): void {
  const activeRead = get(activeRemoveDuplicatesReadAtom)
  const activeMutation = get(activeRemoveDuplicatesMutationAtom)
  const nextSessionId = nextRemoveDuplicatesSessionId(get(removeDuplicatesSessionSequenceStateAtom))
  if (nextSessionId !== null) set(removeDuplicatesSessionSequenceStateAtom, nextSessionId)
  const sessionId = nextSessionId ?? get(removeDuplicatesSessionSequenceStateAtom)
  set(removeDuplicatesOpenStateAtom, false)
  set(removeDuplicatesRangeStateAtom, null)
  set(removeDuplicatesCellsStateAtom, EMPTY_CELLS)
  set(removeDuplicatesKeyColumnsStateAtom, EMPTY_KEY_COLUMNS)
  set(removeDuplicatesSessionStateAtom, null)
  set(removeDuplicatesErrorStateAtom, '')
  set(removeDuplicatesLifecycleStateAtom, lifecycleFor('closed', sessionId, null))
  // Clearing an active ticket is the final observable write. A synchronous
  // subscriber may start a replacement operation from this notification.
  if (activeRead !== null) set(activeRemoveDuplicatesReadAtom, null)
  else if (activeMutation !== null) set(activeRemoveDuplicatesMutationAtom, null)
}

export const closeRemoveDuplicatesAtom = atom(null, (get, set): boolean => {
  if (!get(removeDuplicatesCanCloseAtom)) return false
  closeSession(get, set)
  return true
})
closeRemoveDuplicatesAtom.debugLabel = 'spreadsheet.removeDuplicates.close.command'

export const captureRemoveDuplicatesCapabilityAtom = atom(
  null,
  (_get, set, source: RemoveDuplicatesControllerPort): RemoveDuplicatesCapabilityState => {
    let canRead = false
    let canRemove = false
    try {
      canRead = typeof source?.readRangeProjection === 'function'
      canRemove = typeof source?.removeRowsExact === 'function'
    } catch {
      canRead = false
      canRemove = false
    }
    const capability = Object.freeze({ canRead, canRemove })
    set(removeDuplicatesCapabilityStateAtom, capability)
    return capability
  },
)
captureRemoveDuplicatesCapabilityAtom.debugLabel = 'spreadsheet.removeDuplicates.captureCapability'

export const dispatchRemoveDuplicatesIntentAtom = atom(
  null,
  (get, set, intent: RemoveDuplicatesIntent): boolean => {
    if (!get(removeDuplicatesCanEditAtom)) return false
    const range = get(removeDuplicatesRangeAtom)
    if (range === null) return false
    switch (intent.kind) {
      case 'toggle-key-column': {
        if (
          !Number.isSafeInteger(intent.column) ||
          intent.column < range.startCol ||
          intent.column > range.endCol
        ) {
          return false
        }
        const next = new Set(get(removeDuplicatesKeyColumnsAtom))
        if (next.has(intent.column)) next.delete(intent.column)
        else next.add(intent.column)
        set(removeDuplicatesKeyColumnsStateAtom, immutableReadonlySet(next))
        return true
      }
      case 'select-all-key-columns':
        set(removeDuplicatesKeyColumnsStateAtom, allColumnsInRange(range))
        return true
      case 'deselect-all-key-columns':
        set(removeDuplicatesKeyColumnsStateAtom, EMPTY_KEY_COLUMNS)
        return true
      case 'set-comparison':
        set(removeDuplicatesComparisonStateAtom, intent.comparison)
        return true
      case 'set-exclude-header':
        set(removeDuplicatesExcludeHeaderStateAtom, intent.excludeHeader)
        return true
    }
  },
)
dispatchRemoveDuplicatesIntentAtom.debugLabel = 'spreadsheet.removeDuplicates.dispatchIntent'

// Compatibility commands remain typed write funnels; public product atoms are read-only.
export const toggleKeyColumnAtom = atom(null, (_get, set, column: number): boolean =>
  set(dispatchRemoveDuplicatesIntentAtom, { kind: 'toggle-key-column', column }),
)
export const selectAllKeyColumnsAtom = atom(null, (_get, set): boolean =>
  set(dispatchRemoveDuplicatesIntentAtom, { kind: 'select-all-key-columns' }),
)
export const deselectAllKeyColumnsAtom = atom(null, (_get, set): boolean =>
  set(dispatchRemoveDuplicatesIntentAtom, { kind: 'deselect-all-key-columns' }),
)

/**
 * Temporary RD-C1 compatibility entry. It can render a preview but has no
 * sheet/revision/selection witness and therefore can never commit rows.
 */
export const openRemoveDuplicatesAtom = atom(
  null,
  (get, set, range: RemoveDuplicatesRange, cells: readonly DisplayCell[]): number | null => {
    const lifecycle = get(removeDuplicatesLifecycleAtom)
    if (
      get(activeRemoveDuplicatesReadAtom) !== null ||
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      lifecycle.status === 'read-pending' ||
      blocksClose(lifecycle.status)
    ) {
      return null
    }
    const sessionId = nextRemoveDuplicatesSessionId(get(removeDuplicatesSessionSequenceStateAtom))
    if (sessionId === null) return null
    const rangeSnapshot = snapshotRemoveDuplicatesRange(range)
    set(removeDuplicatesSessionSequenceStateAtom, sessionId)
    set(removeDuplicatesSessionStateAtom, null)
    set(removeDuplicatesRangeStateAtom, rangeSnapshot)
    set(removeDuplicatesCellsStateAtom, snapshotCells(cells))
    set(removeDuplicatesKeyColumnsStateAtom, allColumnsInRange(rangeSnapshot))
    set(removeDuplicatesErrorStateAtom, '')
    set(removeDuplicatesLifecycleStateAtom, lifecycleFor('editing', sessionId, null))
    set(removeDuplicatesOpenStateAtom, true)
    return sessionId
  },
)
openRemoveDuplicatesAtom.debugLabel = 'spreadsheet.removeDuplicates.open.compatibility'

function readTicketContextIsCurrent(get: Getter, ticket: RemoveDuplicatesReadTicket): boolean {
  const active = get(activeRemoveDuplicatesReadAtom)
  const lifecycle = get(removeDuplicatesLifecycleAtom)
  return (
    active === ticket &&
    get(removeDuplicatesOpenAtom) &&
    lifecycle.status === 'read-pending' &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.readRequestId === ticket.requestId &&
    lifecycle.sheetId === ticket.sheetId
  )
}

function readTicketAuthorityIsCurrent(get: Getter, ticket: RemoveDuplicatesReadTicket): boolean {
  return (
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === ticket.workspaceActiveSheetWitness &&
    get(primarySelectionRegionAtom).sheetId === ticket.sheetId &&
    get(workspaceSessionAtom).activeSheetId === ticket.sheetId &&
    sameRange(get(selectionRangeAtom), ticket.range)
  )
}

function markReadStale(
  set: Setter,
  ticket: RemoveDuplicatesReadTicket,
): RemoveDuplicatesReadOutcome {
  set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_READ_STALE_ERROR)
  set(
    removeDuplicatesLifecycleStateAtom,
    lifecycleFor('read-stale', ticket.sessionId, ticket.sheetId, ticket.requestId),
  )
  set(activeRemoveDuplicatesReadAtom, null)
  return 'stale'
}

interface ExactReadAcknowledgementSnapshot {
  readonly kind: 'range'
  readonly requestId: ProjectionRequestId
  readonly sheetId: string
  readonly range: Readonly<CellRange>
  readonly revision: ProjectionRevision
  readonly truncated: boolean | undefined
  readonly cells: readonly DisplayCell[]
}

type ReadAcknowledgementClassification =
  | Readonly<{
      status: 'exact'
      acknowledgement: ExactReadAcknowledgementSnapshot
    }>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'failed'; retainTicket: boolean }>

const STALE_READ_ACKNOWLEDGEMENT: ReadAcknowledgementClassification = Object.freeze({
  status: 'stale',
})
const FAILED_READ_ACKNOWLEDGEMENT: ReadAcknowledgementClassification = Object.freeze({
  status: 'failed',
  retainTicket: false,
})
const THREW_READING_READ_ACKNOWLEDGEMENT: ReadAcknowledgementClassification = Object.freeze({
  status: 'failed',
  retainTicket: true,
})

function validDisplayCellValueKind(value: unknown): value is DisplayCell['valueKind'] {
  return (
    value === undefined ||
    value === 'blank' ||
    value === 'number' ||
    value === 'string' ||
    value === 'boolean' ||
    value === 'error'
  )
}

function classifyReadAcknowledgement(
  acknowledgement: unknown,
  ticket: RemoveDuplicatesReadTicket,
): ReadAcknowledgementClassification {
  try {
    if (typeof acknowledgement !== 'object' || acknowledgement === null) {
      return FAILED_READ_ACKNOWLEDGEMENT
    }
    const result = acknowledgement as RangeProjectionResult
    // Snapshot every caller-owned top-level field exactly once before
    // classification. No downstream consumer may touch `result` again.
    const kind = result.kind
    const requestId = result.requestId
    const sheetId = result.sheetId
    const rangeValue = result.range
    const revision = result.revision
    const truncated = result.truncated
    const cellsValue = result.cells

    if (typeof rangeValue !== 'object' || rangeValue === null) {
      return FAILED_READ_ACKNOWLEDGEMENT
    }
    const range = snapshotRange(rangeValue)
    if (
      kind !== 'range' ||
      !Number.isSafeInteger(requestId) ||
      typeof sheetId !== 'string' ||
      !validRange(range)
    ) {
      return FAILED_READ_ACKNOWLEDGEMENT
    }
    if (
      (truncated !== undefined && typeof truncated !== 'boolean') ||
      truncated === true ||
      !validRevision(revision) ||
      !Array.isArray(cellsValue)
    ) {
      return FAILED_READ_ACKNOWLEDGEMENT
    }

    const length = cellsValue.length
    if (!Number.isSafeInteger(length) || length < 0) return FAILED_READ_ACKNOWLEDGEMENT
    const cells: DisplayCell[] = []
    const seenCoordinates = new Set<string>()
    for (let index = 0; index < length; index += 1) {
      const cellValue = cellsValue[index]
      if (typeof cellValue !== 'object' || cellValue === null) {
        return FAILED_READ_ACKNOWLEDGEMENT
      }
      const row = cellValue.row
      const col = cellValue.col
      const displayValue = cellValue.displayValue
      const valueKind = cellValue.valueKind
      if (
        typeof row !== 'number' ||
        !Number.isSafeInteger(row) ||
        typeof col !== 'number' ||
        !Number.isSafeInteger(col) ||
        row < ticket.range.rowStart ||
        row > ticket.range.rowEnd ||
        col < ticket.range.colStart ||
        col > ticket.range.colEnd ||
        typeof displayValue !== 'string' ||
        !validDisplayCellValueKind(valueKind)
      ) {
        return FAILED_READ_ACKNOWLEDGEMENT
      }
      const coordinateKey = `${row}:${col}`
      if (seenCoordinates.has(coordinateKey)) return FAILED_READ_ACKNOWLEDGEMENT
      seenCoordinates.add(coordinateKey)
      cells.push(
        valueKind === undefined
          ? Object.freeze({ row, col, displayValue })
          : Object.freeze({ row, col, displayValue, valueKind }),
      )
    }
    if (
      requestId !== ticket.requestId ||
      sheetId !== ticket.sheetId ||
      !sameRange(range, ticket.range)
    ) {
      return STALE_READ_ACKNOWLEDGEMENT
    }
    return Object.freeze({
      status: 'exact',
      acknowledgement: Object.freeze({
        kind,
        requestId,
        sheetId,
        range,
        revision,
        truncated,
        cells: Object.freeze(cells),
      }),
    })
  } catch {
    return THREW_READING_READ_ACKNOWLEDGEMENT
  }
}

export const openRemoveDuplicatesFromSelectionAtom = atom(
  null,
  async (get, set, input: OpenRemoveDuplicatesInput): Promise<RemoveDuplicatesReadOutcome> => {
    const lifecycle = get(removeDuplicatesLifecycleAtom)
    const initialActiveRead = get(activeRemoveDuplicatesReadAtom)
    if (
      initialActiveRead !== null ||
      lifecycle.status === 'read-pending' ||
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      blocksClose(lifecycle.status)
    ) {
      return 'blocked'
    }

    const sessionId = nextRemoveDuplicatesSessionId(get(removeDuplicatesSessionSequenceStateAtom))
    const requestId = nextRemoveDuplicatesReadRequestId(get(removeDuplicatesReadSequenceStateAtom))
    const range = snapshotRange(get(selectionRangeAtom))
    const selectionWitness = get(selectionAuthorityWitnessAtom)
    const selectionSheetId = get(primarySelectionRegionAtom).sheetId
    const workspaceActiveSheetWitness = get(workspaceActiveSheetAuthorityWitnessAtom)
    const workspaceActiveSheetId = get(workspaceSessionAtom).activeSheetId
    const initialOpen = get(removeDuplicatesOpenAtom)

    let source: RemoveDuplicatesControllerPort | undefined
    let compatibilitySheetId: string | undefined
    let execute: RemoveDuplicatesControllerPort['readRangeProjection']
    let removeExecute: RemoveDuplicatesControllerPort['removeRowsExact']
    let timeoutMs = DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS
    let captureFailed = false
    try {
      // Caller-owned accessors are a capture boundary. Every value used after
      // this point is a detached local and every transport port is read once.
      source = input.source
      compatibilitySheetId = input.sheetId
      timeoutMs = normalizeRemoveDuplicatesTimeout(input.timeoutMs)
      execute = source?.readRangeProjection
      removeExecute = source?.removeRowsExact
    } catch {
      captureFailed = true
    }

    const invocationIsCurrent =
      get(removeDuplicatesLifecycleAtom) === lifecycle &&
      get(activeRemoveDuplicatesReadAtom) === initialActiveRead &&
      get(activeRemoveDuplicatesMutationAtom) === null &&
      get(removeDuplicatesOpenAtom) === initialOpen &&
      get(selectionAuthorityWitnessAtom) === selectionWitness &&
      get(workspaceActiveSheetAuthorityWitnessAtom) === workspaceActiveSheetWitness &&
      get(primarySelectionRegionAtom).sheetId === selectionSheetId &&
      get(workspaceSessionAtom).activeSheetId === workspaceActiveSheetId &&
      sameRange(get(selectionRangeAtom), range)
    if (!invocationIsCurrent) return 'blocked'

    const compatibilitySheetMatches =
      compatibilitySheetId === undefined ||
      (typeof compatibilitySheetId === 'string' && compatibilitySheetId === selectionSheetId)
    if (
      captureFailed ||
      sessionId === null ||
      requestId === null ||
      selectionSheetId.length === 0 ||
      selectionSheetId !== workspaceActiveSheetId ||
      !compatibilitySheetMatches ||
      !validRange(range)
    ) {
      set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_READ_FAILED_ERROR)
      set(
        removeDuplicatesLifecycleStateAtom,
        lifecycleFor('read-failed', lifecycle.sessionId, null),
      )
      return 'failed'
    }

    const canRead = typeof execute === 'function'
    const canRemove = typeof removeExecute === 'function'
    const removeDuplicatesRange = toRemoveDuplicatesRange(range)
    set(removeDuplicatesCapabilityStateAtom, Object.freeze({ canRead, canRemove }))
    set(removeDuplicatesSessionSequenceStateAtom, sessionId)
    set(removeDuplicatesReadSequenceStateAtom, requestId)
    set(removeDuplicatesSessionStateAtom, null)
    set(removeDuplicatesRangeStateAtom, removeDuplicatesRange)
    set(removeDuplicatesCellsStateAtom, EMPTY_CELLS)
    set(removeDuplicatesKeyColumnsStateAtom, allColumnsInRange(removeDuplicatesRange))
    set(removeDuplicatesOpenStateAtom, true)
    set(removeDuplicatesErrorStateAtom, '')

    if (!canRead || execute === undefined || source === undefined) {
      set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_READ_CAPABILITY_ERROR)
      set(
        removeDuplicatesLifecycleStateAtom,
        lifecycleFor('read-failed', sessionId, selectionSheetId, requestId),
      )
      return 'failed'
    }

    const request: Readonly<RangeProjectionRequest> = Object.freeze({
      kind: 'range',
      sheetId: selectionSheetId,
      range,
      requestId,
      reason: 'selection',
    })
    const ticket: RemoveDuplicatesReadTicket = Object.freeze({
      sessionId,
      requestId,
      sheetId: selectionSheetId,
      range,
      selectionWitness,
      workspaceActiveSheetWitness,
      source,
      execute,
      request,
      timeoutMs,
    })
    set(
      removeDuplicatesLifecycleStateAtom,
      lifecycleFor('read-pending', sessionId, ticket.sheetId, requestId),
    )
    set(activeRemoveDuplicatesReadAtom, ticket)

    await Promise.resolve()
    if (!readTicketContextIsCurrent(get, ticket)) return 'stale'
    if (!readTicketAuthorityIsCurrent(get, ticket)) return markReadStale(set, ticket)
    set(removeDuplicatesLifecycleStateAtom, get(removeDuplicatesLifecycleAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await withRemoveDuplicatesTimeout(
        Reflect.apply(ticket.execute, ticket.source, [ticket.request]),
        ticket.timeoutMs,
        'Remove Duplicates read',
      )
    } catch (error) {
      const detail = errorMessage(error)
      if (!readTicketContextIsCurrent(get, ticket)) return 'stale'
      if (!readTicketAuthorityIsCurrent(get, ticket)) {
        return markReadStale(set, ticket)
      }
      set(removeDuplicatesErrorStateAtom, `${REMOVE_DUPLICATES_READ_FAILED_ERROR} ${detail}`)
      set(
        removeDuplicatesLifecycleStateAtom,
        lifecycleFor('read-failed', sessionId, ticket.sheetId, requestId),
      )
      set(activeRemoveDuplicatesReadAtom, null)
      return 'failed'
    }

    if (!readTicketContextIsCurrent(get, ticket)) return 'stale'
    if (!readTicketAuthorityIsCurrent(get, ticket)) return markReadStale(set, ticket)
    const classification = classifyReadAcknowledgement(acknowledgement, ticket)
    if (!readTicketContextIsCurrent(get, ticket)) return 'stale'
    if (!readTicketAuthorityIsCurrent(get, ticket)) return markReadStale(set, ticket)
    if (classification.status !== 'exact') {
      set(
        removeDuplicatesErrorStateAtom,
        classification.status === 'stale'
          ? REMOVE_DUPLICATES_READ_STALE_ERROR
          : REMOVE_DUPLICATES_READ_FAILED_ERROR,
      )
      set(
        removeDuplicatesLifecycleStateAtom,
        lifecycleFor(
          classification.status === 'stale' ? 'read-stale' : 'read-failed',
          sessionId,
          ticket.sheetId,
          requestId,
        ),
      )
      set(activeRemoveDuplicatesReadAtom, null)
      return classification.status
    }

    const exactAcknowledgement = classification.acknowledgement
    const rangeSnapshot = toRemoveDuplicatesRange(exactAcknowledgement.range)
    const session: RemoveDuplicatesSessionSnapshot = Object.freeze({
      sessionId,
      sheetId: exactAcknowledgement.sheetId,
      range: rangeSnapshot,
      selectionWitness: ticket.selectionWitness,
      workspaceActiveSheetWitness: ticket.workspaceActiveSheetWitness,
      projectionRevision: exactAcknowledgement.revision,
      cells: exactAcknowledgement.cells,
    })
    set(removeDuplicatesSessionStateAtom, session)
    set(removeDuplicatesRangeStateAtom, session.range)
    set(removeDuplicatesCellsStateAtom, session.cells)
    set(removeDuplicatesKeyColumnsStateAtom, allColumnsInRange(session.range))
    set(removeDuplicatesErrorStateAtom, '')
    set(
      removeDuplicatesLifecycleStateAtom,
      lifecycleFor('editing', sessionId, ticket.sheetId, requestId),
    )
    set(activeRemoveDuplicatesReadAtom, null)
    return 'editing'
  },
)
openRemoveDuplicatesFromSelectionAtom.debugLabel = 'spreadsheet.removeDuplicates.openFromSelection'

/** Retry captures a new selection witness and allocates a fresh session/read id. */
export const retryRemoveDuplicatesReadAtom = openRemoveDuplicatesFromSelectionAtom

function canonicalRows(rows: readonly number[]): readonly number[] | null {
  if (rows.some((row) => !Number.isSafeInteger(row) || row < 0)) return null
  return Object.freeze(Array.from(new Set(rows)).sort((left, right) => left - right))
}

function targetRangeFor(
  range: RemoveDuplicatesRange,
  rows: readonly number[],
): Readonly<CellRange> | null {
  if (rows.length === 0) return null
  return snapshotRange({
    rowStart: Math.min(range.startRow, rows[0]),
    rowEnd: Math.max(range.endRow, rows[rows.length - 1]),
    colStart: range.startCol,
    colEnd: range.endCol,
  })
}

function targetKeyFor(
  sheetId: string,
  targetRange: CellRange,
  revision: ProjectionRevision,
  rows: readonly number[],
): string {
  return JSON.stringify([
    sheetId,
    targetRange.rowStart,
    targetRange.rowEnd,
    targetRange.colStart,
    targetRange.colEnd,
    typeof revision,
    revision,
    rows,
  ])
}

function mutationTicketIsCurrent(get: Getter, ticket: RemoveDuplicatesMutationTicket): boolean {
  const lifecycle = get(removeDuplicatesLifecycleAtom)
  const active = get(activeRemoveDuplicatesMutationAtom)
  return (
    active === ticket &&
    get(removeDuplicatesOpenAtom) &&
    get(removeDuplicatesSessionAtom)?.sessionId === ticket.sessionId &&
    lifecycle.sessionId === ticket.sessionId &&
    lifecycle.mutationRequestId === ticket.target.requestId
  )
}

function sessionAuthorityIsCurrent(get: Getter, session: RemoveDuplicatesSessionSnapshot): boolean {
  const selectionRange = get(selectionRangeAtom)
  return (
    get(selectionAuthorityWitnessAtom) === session.selectionWitness &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === session.workspaceActiveSheetWitness &&
    get(primarySelectionRegionAtom).sheetId === session.sheetId &&
    get(workspaceSessionAtom).activeSheetId === session.sheetId &&
    selectionRange.rowStart === session.range.startRow &&
    selectionRange.rowEnd === session.range.endRow &&
    selectionRange.colStart === session.range.startCol &&
    selectionRange.colEnd === session.range.endCol
  )
}

function mutationTicketAuthorityIsCurrent(
  get: Getter,
  ticket: RemoveDuplicatesMutationTicket,
): boolean {
  return (
    get(selectionAuthorityWitnessAtom) === ticket.selectionWitness &&
    get(workspaceActiveSheetAuthorityWitnessAtom) === ticket.workspaceActiveSheetWitness &&
    get(primarySelectionRegionAtom).sheetId === ticket.target.sheetId &&
    get(workspaceSessionAtom).activeSheetId === ticket.target.sheetId
  )
}

function markMutationStaleBeforeTransport(
  get: Getter,
  set: Setter,
  ticket: RemoveDuplicatesMutationTicket,
  readRequestId: ProjectionRequestId | null,
): RemoveDuplicatesMutationOutcome {
  if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
    return markOutcomeUnknown(
      set,
      ticket,
      'History ownership could not be reconciled before transport.',
    )
  }
  if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
  set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_READ_STALE_ERROR)
  set(
    removeDuplicatesLifecycleStateAtom,
    lifecycleFor('read-stale', ticket.sessionId, ticket.target.sheetId, readRequestId),
  )
  set(activeRemoveDuplicatesMutationAtom, null)
  return 'stale'
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Collapse strictly-ascending removed row indices into contiguous delete
 * bands, returned in bottom-up application order. Applying the bands
 * descending keeps every band's `index` valid in the pre-mutation
 * coordinate space — the same order the exact backend removes them — so
 * each band reuses the single-shift `BackendStructuralShift` delete
 * semantics that `runStructureOperationAtom` already dispatches.
 */
function descendingRowDeleteShifts(
  rows: readonly number[],
): readonly Readonly<BackendStructuralShift>[] {
  const shifts: BackendStructuralShift[] = []
  for (const row of rows) {
    const band = shifts[0]
    if (band !== undefined && row === band.index + band.count) {
      band.count += 1
    } else {
      shifts.unshift({ axis: 'row', kind: 'delete', index: row, count: 1 })
    }
  }
  return shifts
}

function snapshotCellRangeValue(value: unknown): Readonly<CellRange> | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const range = value as CellRange
    const rowStart = range.rowStart
    const rowEnd = range.rowEnd
    const colStart = range.colStart
    const colEnd = range.colEnd
    const snapshot = Object.freeze({ rowStart, rowEnd, colStart, colEnd })
    return validRange(snapshot) ? snapshot : null
  } catch {
    return null
  }
}

function snapshotRemovedRows(value: unknown): readonly number[] | null {
  try {
    if (!Array.isArray(value)) return null
    const length = value.length
    if (!Number.isSafeInteger(length) || length < 0) return null
    const rows: number[] = []
    let previous = -1
    for (let index = 0; index < length; index += 1) {
      const row = value[index]
      if (!Number.isSafeInteger(row) || row < 0 || row <= previous) return null
      rows.push(row)
      previous = row
    }
    return Object.freeze(rows)
  } catch {
    return null
  }
}

function snapshotAffectedRangeValue(value: unknown): RemoveRowsExactResult['affectedRange'] {
  try {
    if (typeof value !== 'object' || value === null) return null
    const range = value as NonNullable<RemoveRowsExactResult['affectedRange']>
    const startRow = range.startRow
    const endRow = range.endRow
    const startCol = range.startCol
    const endCol = range.endCol
    if (
      !Number.isSafeInteger(startRow) ||
      !Number.isSafeInteger(endRow) ||
      !Number.isSafeInteger(startCol) ||
      !Number.isSafeInteger(endCol) ||
      startRow < 0 ||
      startCol < 0 ||
      startRow > endRow ||
      startCol > endCol
    ) {
      return null
    }
    return Object.freeze({ startRow, endRow, startCol, endCol })
  } catch {
    return null
  }
}

function snapshotAcknowledgement(
  acknowledgement: unknown,
  ticket: RemoveDuplicatesMutationTicket,
): ExactRemoveRowsAcknowledgement | null {
  try {
    if (typeof acknowledgement !== 'object' || acknowledgement === null) return null
    const result = acknowledgement as RemoveRowsExactResult
    const requestId = result.requestId
    const sheetId = result.sheetId
    const targetRangeValue = result.targetRange
    const removedRowIndicesValue = result.removedRowIndices
    const removedRows = result.removedRows
    const affectedRangeValue = result.affectedRange
    const revision = result.revision
    const historyRecordedValue = result.historyRecorded
    const targetRange = snapshotCellRangeValue(targetRangeValue)
    const rows = snapshotRemovedRows(removedRowIndicesValue)
    const affectedRange = snapshotAffectedRangeValue(affectedRangeValue)
    if (
      requestId !== ticket.target.requestId ||
      sheetId !== ticket.target.sheetId ||
      targetRange === null ||
      !sameRange(targetRange, ticket.target.targetRange) ||
      rows === null ||
      !sameNumberList(rows, ticket.target.removedRowIndices) ||
      removedRows !== rows.length ||
      affectedRange === null ||
      !validRevision(revision) ||
      (historyRecordedValue !== undefined && typeof historyRecordedValue !== 'boolean') ||
      Object.is(revision, ticket.target.projectionRevision)
    ) {
      return null
    }
    if (
      rows.length === 0 ||
      affectedRange.startRow !== rows[0] ||
      affectedRange.endRow !== ticket.target.targetRange.rowEnd ||
      affectedRange.startCol !== ticket.target.targetRange.colStart ||
      affectedRange.endCol !== ticket.target.targetRange.colEnd
    ) {
      return null
    }
    return Object.freeze({
      requestId,
      sheetId,
      targetRange,
      removedRowIndices: rows,
      removedRows,
      affectedRange,
      revision,
      historyRecorded: historyRecordedValue ?? true,
    })
  } catch {
    return null
  }
}

function markOutcomeUnknown(
  set: Setter,
  ticket: RemoveDuplicatesMutationTicket,
  detail = '',
): RemoveDuplicatesMutationOutcome {
  set(
    removeDuplicatesErrorStateAtom,
    `${REMOVE_DUPLICATES_OUTCOME_UNKNOWN_ERROR}${detail.length > 0 ? ` ${detail}` : ''}`,
  )
  set(
    removeDuplicatesLifecycleStateAtom,
    lifecycleFor(
      'outcome-unknown',
      ticket.sessionId,
      ticket.target.sheetId,
      null,
      ticket.target.requestId,
    ),
  )
  return 'outcome-unknown'
}

async function refreshAcknowledgedMutation(
  get: Getter,
  set: Setter,
  ticket: RemoveDuplicatesMutationTicket,
): Promise<RemoveDuplicatesMutationOutcome> {
  if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
  if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
    return markOutcomeUnknown(set, ticket)
  }
  set(removeDuplicatesErrorStateAtom, '')
  set(
    removeDuplicatesLifecycleStateAtom,
    lifecycleFor(
      'refreshing',
      ticket.sessionId,
      ticket.target.sheetId,
      null,
      ticket.target.requestId,
    ),
  )
  await Promise.resolve()
  if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
  if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
    return markOutcomeUnknown(set, ticket)
  }
  set(removeDuplicatesLifecycleStateAtom, get(removeDuplicatesLifecycleAtom))
  try {
    await withRemoveDuplicatesTimeout(
      Reflect.apply(ticket.refreshProjection, undefined, [ticket.target.sheetId]),
      ticket.timeoutMs,
      'Remove Duplicates refresh',
    )
  } catch (error) {
    const detail = errorMessage(error)
    if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
      return markOutcomeUnknown(set, ticket)
    }
    set(removeDuplicatesErrorStateAtom, `${REMOVE_DUPLICATES_REFRESH_ERROR_PREFIX}${detail}`)
    set(
      removeDuplicatesLifecycleStateAtom,
      lifecycleFor(
        'refresh-failed',
        ticket.sessionId,
        ticket.target.sheetId,
        null,
        ticket.target.requestId,
      ),
    )
    return 'refresh-failed'
  }
  if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
  if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
    return markOutcomeUnknown(set, ticket)
  }
  if (!set(releaseHistoryProducerReservationAtom, ticket.historyReservation)) {
    return markOutcomeUnknown(
      set,
      ticket,
      'History ownership could not be reconciled after refresh.',
    )
  }
  if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
  if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
    return markOutcomeUnknown(set, ticket)
  }
  closeSession(get, set)
  return 'completed'
}

export const runRemoveDuplicatesConfirmAtom = atom(
  null,
  async (
    get,
    set,
    input: RunRemoveDuplicatesConfirmInput,
  ): Promise<RemoveDuplicatesMutationOutcome> => {
    const active = get(activeRemoveDuplicatesMutationAtom)
    const lifecycle = get(removeDuplicatesLifecycleAtom)
    if (active !== null) {
      if (active.acknowledgement !== null && lifecycle.status === 'refresh-failed') {
        if (!mutationTicketIsCurrent(get, active)) return 'stale'
        if (!mutationTicketAuthorityIsCurrent(get, active)) {
          return markOutcomeUnknown(set, active)
        }

        let retrySessionId: number | undefined
        let refreshProjection: RunRemoveDuplicatesConfirmInput['refreshProjection'] | undefined
        let timeoutMs = DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS
        let captureFailed = false
        try {
          // A retry is refresh-only: source and mutation ports are deliberately
          // not observed again.
          retrySessionId = input.sessionId
          refreshProjection = input.refreshProjection
          timeoutMs = normalizeRemoveDuplicatesTimeout(input.timeoutMs)
        } catch {
          captureFailed = true
        }

        if (
          get(activeRemoveDuplicatesMutationAtom) !== active ||
          get(removeDuplicatesLifecycleAtom) !== lifecycle ||
          !mutationTicketIsCurrent(get, active) ||
          !mutationTicketAuthorityIsCurrent(get, active)
        ) {
          return 'stale'
        }
        if (
          captureFailed ||
          retrySessionId !== active.sessionId ||
          typeof refreshProjection !== 'function'
        ) {
          if (captureFailed) {
            set(
              removeDuplicatesErrorStateAtom,
              `${REMOVE_DUPLICATES_REFRESH_ERROR_PREFIX}Invalid retry transport input.`,
            )
          }
          return captureFailed ? 'refresh-failed' : 'stale'
        }

        const retryTicket: RemoveDuplicatesMutationTicket = Object.freeze({
          ...active,
          refreshProjection,
          timeoutMs,
        })
        // The status transition closes the retry gate before publishing the
        // replacement immutable ticket.
        set(
          removeDuplicatesLifecycleStateAtom,
          lifecycleFor(
            'refreshing',
            active.sessionId,
            active.target.sheetId,
            null,
            active.target.requestId,
          ),
        )
        set(activeRemoveDuplicatesMutationAtom, retryTicket)
        return refreshAcknowledgedMutation(get, set, retryTicket)
      }
      return lifecycle.status === 'outcome-unknown' ? 'outcome-unknown' : 'stale'
    }

    const session = get(removeDuplicatesSessionAtom)
    if (
      session === null ||
      !get(removeDuplicatesOpenAtom) ||
      lifecycle.status !== 'editing' ||
      lifecycle.sessionId !== session.sessionId
    ) {
      return 'stale'
    }
    if (!sessionAuthorityIsCurrent(get, session)) {
      set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_READ_STALE_ERROR)
      set(
        removeDuplicatesLifecycleStateAtom,
        lifecycleFor('read-stale', session.sessionId, session.sheetId, lifecycle.readRequestId),
      )
      return 'stale'
    }

    const initialOpen = get(removeDuplicatesOpenAtom)
    let source: RemoveDuplicatesControllerPort | undefined
    let capturedSessionId: number | undefined
    let execute: RemoveDuplicatesControllerPort['removeRowsExact']
    let refreshProjection: RunRemoveDuplicatesConfirmInput['refreshProjection'] | undefined
    let timeoutMs = DEFAULT_REMOVE_DUPLICATES_TIMEOUT_MS
    let captureFailed = false
    try {
      source = input.source
      capturedSessionId = input.sessionId
      refreshProjection = input.refreshProjection
      timeoutMs = normalizeRemoveDuplicatesTimeout(input.timeoutMs)
      execute = source?.removeRowsExact
    } catch {
      captureFailed = true
    }

    if (
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      get(removeDuplicatesLifecycleAtom) !== lifecycle ||
      get(removeDuplicatesSessionAtom) !== session ||
      get(removeDuplicatesOpenAtom) !== initialOpen ||
      !sessionAuthorityIsCurrent(get, session)
    ) {
      return 'stale'
    }
    if (captureFailed) {
      set(
        removeDuplicatesCapabilityStateAtom,
        Object.freeze({ ...get(removeDuplicatesCapabilityAtom), canRemove: false }),
      )
      set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_REMOVE_CAPABILITY_ERROR)
      return 'blocked'
    }
    if (capturedSessionId !== session.sessionId) {
      return 'stale'
    }
    if (typeof execute !== 'function' || source === undefined) {
      set(
        removeDuplicatesCapabilityStateAtom,
        Object.freeze({ ...get(removeDuplicatesCapabilityAtom), canRemove: false }),
      )
      set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_REMOVE_CAPABILITY_ERROR)
      return 'blocked'
    }
    if (typeof refreshProjection !== 'function') return 'blocked'

    const preview = get(removeDuplicatesPreviewAtom)
    const rows = preview === null ? null : canonicalRows(preview.duplicateRows)
    const targetRange = rows === null ? null : targetRangeFor(session.range, rows)
    if (
      preview === null ||
      preview.noKeyColumns ||
      rows === null ||
      rows.length === 0 ||
      targetRange === null ||
      !validRevision(session.projectionRevision)
    ) {
      return 'blocked'
    }

    const resolution = set(resolveContentMutationAtom, {
      kind: 'remove-rows',
      sheetId: session.sheetId,
      range: targetRange,
    })
    if (
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      get(removeDuplicatesLifecycleAtom) !== lifecycle ||
      get(removeDuplicatesSessionAtom) !== session ||
      !sessionAuthorityIsCurrent(get, session)
    ) {
      return 'stale'
    }
    if (resolution.status === 'blocked') {
      set(removeDuplicatesErrorStateAtom, resolution.diagnostic.message)
      return 'blocked'
    }
    const resolvedRanges = resolution.ranges
    const resolvedTargetRange =
      resolvedRanges?.length === 1 ? snapshotCellRangeValue(resolvedRanges[0]) : null
    if (resolvedTargetRange === null) {
      return 'blocked'
    }

    const requestId = nextRemoveDuplicatesMutationRequestId(
      get(removeDuplicatesMutationSequenceStateAtom),
    )
    if (requestId === null) {
      set(removeDuplicatesErrorStateAtom, 'Remove Duplicates request identity space is exhausted.')
      return 'blocked'
    }
    const target: RemoveDuplicatesMutationTarget = Object.freeze({
      requestId,
      sheetId: session.sheetId,
      targetRange: resolvedTargetRange,
      removedRowIndices: rows,
      projectionRevision: session.projectionRevision,
      targetKey: targetKeyFor(
        session.sheetId,
        resolvedTargetRange,
        session.projectionRevision,
        rows,
      ),
    })
    const request: RemoveRowsExactRequest = Object.freeze({
      kind: 'remove-rows',
      requestId,
      sheetId: target.sheetId,
      targetRange: target.targetRange,
      rows: target.removedRowIndices,
      revision: target.projectionRevision,
    })
    if (
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      get(removeDuplicatesLifecycleAtom) !== lifecycle ||
      get(removeDuplicatesSessionAtom) !== session ||
      !sessionAuthorityIsCurrent(get, session)
    ) {
      return 'stale'
    }
    const historyReservation = set(acquireHistoryProducerReservationAtom)
    if (historyReservation === null) {
      if (
        get(activeRemoveDuplicatesMutationAtom) === null &&
        get(removeDuplicatesLifecycleAtom) === lifecycle &&
        get(removeDuplicatesSessionAtom) === session &&
        sessionAuthorityIsCurrent(get, session)
      ) {
        set(removeDuplicatesErrorStateAtom, REMOVE_DUPLICATES_HISTORY_BUSY_ERROR)
      }
      return 'blocked'
    }
    const ticket: RemoveDuplicatesMutationTicket = Object.freeze({
      sessionId: session.sessionId,
      selectionWitness: session.selectionWitness,
      workspaceActiveSheetWitness: session.workspaceActiveSheetWitness,
      target,
      request,
      historyReservation,
      acknowledgement: null,
      source,
      execute,
      refreshProjection,
      timeoutMs,
      readRequestId: lifecycle.readRequestId,
    })
    if (
      get(activeRemoveDuplicatesMutationAtom) !== null ||
      get(removeDuplicatesLifecycleAtom) !== lifecycle ||
      get(removeDuplicatesSessionAtom) !== session ||
      !sessionAuthorityIsCurrent(get, session)
    ) {
      set(releaseHistoryProducerReservationAtom, historyReservation)
      return 'stale'
    }
    set(removeDuplicatesMutationSequenceStateAtom, requestId)
    set(removeDuplicatesErrorStateAtom, '')
    set(
      removeDuplicatesLifecycleStateAtom,
      lifecycleFor('mutation-pending', session.sessionId, session.sheetId, null, requestId),
    )
    set(activeRemoveDuplicatesMutationAtom, ticket)

    // Publish the immutable ticket before transport launch; same-tick re-entry is inert.
    await Promise.resolve()
    if (!mutationTicketIsCurrent(get, ticket)) {
      set(releaseHistoryProducerReservationAtom, ticket.historyReservation)
      return 'stale'
    }
    if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
      return markMutationStaleBeforeTransport(get, set, ticket, ticket.readRequestId)
    }
    set(removeDuplicatesLifecycleStateAtom, get(removeDuplicatesLifecycleAtom))

    let acknowledgement: unknown
    try {
      acknowledgement = await withRemoveDuplicatesTimeout(
        Reflect.apply(ticket.execute, ticket.source, [ticket.request]),
        ticket.timeoutMs,
        'Remove Duplicates mutation',
      )
    } catch (error) {
      const detail = errorMessage(error)
      if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
      if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
        return markOutcomeUnknown(set, ticket)
      }
      return markOutcomeUnknown(set, ticket, `Backend detail: ${detail}`)
    }
    if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
      return markOutcomeUnknown(set, ticket)
    }

    const exactAcknowledgement = snapshotAcknowledgement(acknowledgement, ticket)
    // Snapshotting hostile caller-owned acknowledgements may synchronously
    // re-enter Core. Reconcile only after the exact ticket and authority have
    // survived the complete capture boundary.
    if (!mutationTicketIsCurrent(get, ticket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, ticket)) {
      return markOutcomeUnknown(set, ticket)
    }
    if (exactAcknowledgement === null) return markOutcomeUnknown(set, ticket)
    const acknowledgedTicket: RemoveDuplicatesMutationTicket = Object.freeze({
      ...ticket,
      acknowledgement: exactAcknowledgement,
    })
    set(activeRemoveDuplicatesMutationAtom, acknowledgedTicket)
    if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
      return markOutcomeUnknown(set, acknowledgedTicket)
    }

    // W3 structural-shift contract, extended to the exact removal path:
    // the acknowledged removedRowIndices fully determine the row-space
    // displacement, so Core derives one delete shift per contiguous band
    // and replays them bottom-up through the same viewport appliers that
    // `runStructureOperationAtom` uses. The pre/post snapshots become
    // history side payloads: inverting a delete cannot restore hidden
    // index membership, so undo/redo of this backend transaction replays
    // the exact recorded view facts (see HistoryEntry.localSidePayloads).
    const mutatedSheetId = ticket.target.sheetId
    const freezeBefore = getViewportFreezeForSheet(get(viewportFreezeAtom), mutatedSheetId)
    const hiddenStateBefore = get(viewportHiddenAtom)
    const hiddenRowsBefore = getHiddenRowsForSheet(hiddenStateBefore, mutatedSheetId)
    const hiddenColsBefore = getHiddenColumnsForSheet(hiddenStateBefore, mutatedSheetId)
    for (const shift of descendingRowDeleteShifts(ticket.target.removedRowIndices)) {
      set(applyViewportFreezeStructuralShiftAtom, { sheetId: mutatedSheetId, shift })
      if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
      if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
        return markOutcomeUnknown(set, acknowledgedTicket)
      }
      set(applyViewportHiddenStructuralShiftAtom, { sheetId: mutatedSheetId, shift })
      if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
      if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
        return markOutcomeUnknown(set, acknowledgedTicket)
      }
      set(applyViewportFilterHiddenStructuralShiftAtom, { sheetId: mutatedSheetId, shift })
      if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
      if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
        return markOutcomeUnknown(set, acknowledgedTicket)
      }
    }
    const localSidePayloads: HistoryLocalReplayPayload[] = []
    const freezeAfter = getViewportFreezeForSheet(get(viewportFreezeAtom), mutatedSheetId)
    if (
      (freezeBefore === null) !== (freezeAfter === null) ||
      (freezeBefore !== null &&
        freezeAfter !== null &&
        (freezeBefore.rows !== freezeAfter.rows || freezeBefore.cols !== freezeAfter.cols))
    ) {
      localSidePayloads.push({
        applyKey: VIEWPORT_FREEZE_REPLAY_KEY,
        sheetId: mutatedSheetId,
        before: freezeBefore,
        after: freezeAfter,
      })
    }
    const hiddenStateAfter = get(viewportHiddenAtom)
    const hiddenRowsAfter = getHiddenRowsForSheet(hiddenStateAfter, mutatedSheetId)
    const hiddenColsAfter = getHiddenColumnsForSheet(hiddenStateAfter, mutatedSheetId)
    if (
      !sameNumberList(hiddenRowsBefore, hiddenRowsAfter) ||
      !sameNumberList(hiddenColsBefore, hiddenColsAfter)
    ) {
      localSidePayloads.push({
        applyKey: VIEWPORT_HIDDEN_REPLAY_KEY,
        sheetId: mutatedSheetId,
        before: { rows: [...hiddenRowsBefore], cols: [...hiddenColsBefore] },
        after: { rows: [...hiddenRowsAfter], cols: [...hiddenColsAfter] },
      })
    }
    // FILTER-hidden rows carry NO history side payload since E8 — the engine's
    // `restoreFilters` snapshot restores its owned filter on undo/redo and UI
    // core re-hydrates the render cache from the engine afterwards
    // (`readSheetHiddenState.filterRows`). The forward shift above is the
    // optimistic same-tick projection only.
    if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
      return markOutcomeUnknown(set, acknowledgedTicket)
    }
    if (exactAcknowledgement.historyRecorded) {
      const historyRecorded = set(pushReservedHistoryAtom, {
        reservation: ticket.historyReservation,
        entry: {
          transactionId: `remove-duplicates-${ticket.sessionId}-${ticket.target.requestId}`,
          kind: 'row.delete',
          sheetId: ticket.target.sheetId,
          projectionRevision: exactAcknowledgement.revision,
          affectedRange: {
            rowStart: exactAcknowledgement.affectedRange.startRow,
            rowEnd: exactAcknowledgement.affectedRange.endRow,
            colStart: exactAcknowledgement.affectedRange.startCol,
            colEnd: exactAcknowledgement.affectedRange.endCol,
          },
          ...(localSidePayloads.length > 0 ? { localSidePayloads } : {}),
        },
      })
      if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
      if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
        return markOutcomeUnknown(set, acknowledgedTicket)
      }
      if (!historyRecorded) {
        return markOutcomeUnknown(
          set,
          acknowledgedTicket,
          'The acknowledged mutation could not be recorded in history.',
        )
      }
    }
    if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
      return markOutcomeUnknown(set, acknowledgedTicket)
    }
    set(
      removeDuplicatesLifecycleStateAtom,
      lifecycleFor(
        'local-acknowledged',
        ticket.sessionId,
        ticket.target.sheetId,
        null,
        ticket.target.requestId,
      ),
    )
    await Promise.resolve()
    if (!mutationTicketIsCurrent(get, acknowledgedTicket)) return 'stale'
    if (!mutationTicketAuthorityIsCurrent(get, acknowledgedTicket)) {
      return markOutcomeUnknown(set, acknowledgedTicket)
    }
    return refreshAcknowledgedMutation(get, set, acknowledgedTicket)
  },
)
runRemoveDuplicatesConfirmAtom.debugLabel = 'spreadsheet.removeDuplicates.confirm'
