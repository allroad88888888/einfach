import { atom } from '@einfach/core'
import type { Atom, Getter, Setter } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
import type {
  ActiveSelectionCell,
  AddSelectionRegionInput,
  ClearSelectionRegionsInput,
  CellSelection,
  MoveSelectionInput,
  MultiRangeSelectionState,
  RangeSelection,
  SelectCellInput,
  SelectColumnsInput,
  SelectionBounds,
  SelectionRegion,
  SelectionSnapshot,
  SelectionState,
  SelectRowsInput,
} from './types'

export * from './types'

export const EXCEL_MAX_ROWS = 1_048_576
export const EXCEL_MAX_COLS = 16_384

export const DEFAULT_SELECTION_BOUNDS: SelectionBounds = Object.freeze({
  rowCount: EXCEL_MAX_ROWS,
  colCount: EXCEL_MAX_COLS,
})

export const DEFAULT_SELECTION_STATE: CellSelection = Object.freeze({
  kind: 'cell',
  sheetId: '',
  anchor: Object.freeze({ row: 0, col: 0 }),
  focus: Object.freeze({ row: 0, col: 0 }),
})

declare const selectionAuthorityWitnessBrand: unique symbol

/**
 * Opaque identity for the primary-selection target context. Consumers may
 * retain and compare it by reference; only the selection write funnel can
 * rotate it.
 */
export interface SelectionAuthorityWitness {
  readonly [selectionAuthorityWitnessBrand]: true
}

/**
 * Immutable receipt returned by the guarded selection write command. A
 * caller can consume it inside the same @einfach/core writer without
 * re-reading derived selection atoms before the outer transaction flushes.
 */
export interface SelectionAuthorityReceipt {
  readonly selection: SelectionState
  readonly range: CellRange
  readonly witness: SelectionAuthorityWitness
}

const DEFAULT_MULTI_SELECTION_STATE: MultiRangeSelectionState = Object.freeze({
  regions: Object.freeze([copySelection(DEFAULT_SELECTION_STATE)]),
  primaryIndex: 0,
})

export function normalizeSelectionBounds(bounds: SelectionBounds): SelectionBounds {
  return {
    rowCount: normalizeCount(bounds.rowCount, EXCEL_MAX_ROWS),
    colCount: normalizeCount(bounds.colCount, EXCEL_MAX_COLS),
  }
}

export function clampCellCoord(coord: CellCoord, bounds: SelectionBounds): CellCoord {
  const normalizedBounds = normalizeSelectionBounds(bounds)

  return {
    row: clampIndex(coord.row, normalizedBounds.rowCount),
    col: clampIndex(coord.col, normalizedBounds.colCount),
  }
}

export function normalizeSelection(
  selection: SelectionState,
  bounds: SelectionBounds = DEFAULT_SELECTION_BOUNDS,
): SelectionState {
  const normalizedBounds = normalizeSelectionBounds(bounds)

  switch (selection.kind) {
    case 'cell': {
      const cell = clampCellCoord(selection.focus, normalizedBounds)
      return {
        kind: 'cell',
        sheetId: selection.sheetId,
        anchor: cell,
        focus: cell,
      }
    }
    case 'range': {
      const anchor = clampCellCoord(selection.anchor, normalizedBounds)
      const focus = clampCellCoord(selection.focus, normalizedBounds)

      if (sameCoord(anchor, focus)) {
        return {
          kind: 'cell',
          sheetId: selection.sheetId,
          anchor,
          focus,
        }
      }

      return {
        kind: 'range',
        sheetId: selection.sheetId,
        anchor,
        focus,
      }
    }
    case 'row':
      return {
        kind: 'row',
        sheetId: selection.sheetId,
        rowAnchor: clampIndex(selection.rowAnchor, normalizedBounds.rowCount),
        rowFocus: clampIndex(selection.rowFocus, normalizedBounds.rowCount),
      }
    case 'column':
      return {
        kind: 'column',
        sheetId: selection.sheetId,
        colAnchor: clampIndex(selection.colAnchor, normalizedBounds.colCount),
        colFocus: clampIndex(selection.colFocus, normalizedBounds.colCount),
      }
    case 'all':
      return {
        kind: 'all',
        sheetId: selection.sheetId,
      }
    default:
      return assertNever(selection)
  }
}

export function getSelectionRange(
  selection: SelectionState,
  bounds: SelectionBounds = DEFAULT_SELECTION_BOUNDS,
): CellRange {
  const normalizedBounds = normalizeSelectionBounds(bounds)
  const normalizedSelection = normalizeSelection(selection, normalizedBounds)

  switch (normalizedSelection.kind) {
    case 'cell':
    case 'range':
      return normalizeCellRange(normalizedSelection.anchor, normalizedSelection.focus)
    case 'row': {
      const rowStart = Math.min(normalizedSelection.rowAnchor, normalizedSelection.rowFocus)
      const rowEnd = Math.max(normalizedSelection.rowAnchor, normalizedSelection.rowFocus)

      return {
        rowStart,
        rowEnd,
        colStart: 0,
        colEnd: normalizedBounds.colCount - 1,
      }
    }
    case 'column': {
      const colStart = Math.min(normalizedSelection.colAnchor, normalizedSelection.colFocus)
      const colEnd = Math.max(normalizedSelection.colAnchor, normalizedSelection.colFocus)

      return {
        rowStart: 0,
        rowEnd: normalizedBounds.rowCount - 1,
        colStart,
        colEnd,
      }
    }
    case 'all':
      return {
        rowStart: 0,
        rowEnd: normalizedBounds.rowCount - 1,
        colStart: 0,
        colEnd: normalizedBounds.colCount - 1,
      }
    default:
      return assertNever(normalizedSelection)
  }
}

export function getActiveCell(
  selection: SelectionState,
  bounds: SelectionBounds = DEFAULT_SELECTION_BOUNDS,
): ActiveSelectionCell {
  const normalizedSelection = normalizeSelection(selection, bounds)

  switch (normalizedSelection.kind) {
    case 'cell':
    case 'range':
      return {
        sheetId: normalizedSelection.sheetId,
        row: normalizedSelection.focus.row,
        col: normalizedSelection.focus.col,
      }
    case 'row':
      return {
        sheetId: normalizedSelection.sheetId,
        row: normalizedSelection.rowFocus,
        col: 0,
      }
    case 'column':
      return {
        sheetId: normalizedSelection.sheetId,
        row: 0,
        col: normalizedSelection.colFocus,
      }
    case 'all':
      return {
        sheetId: normalizedSelection.sheetId,
        row: 0,
        col: 0,
      }
    default:
      return assertNever(normalizedSelection)
  }
}

export function moveSelection(
  selection: SelectionState,
  bounds: SelectionBounds,
  input: MoveSelectionInput,
): SelectionState {
  const normalizedSelection = normalizeSelection(selection, bounds)
  const activeCell = getActiveCell(normalizedSelection, bounds)
  const target = clampCellCoord(
    {
      row: input.row ?? activeCell.row + (input.rowDelta ?? 0),
      col: input.col ?? activeCell.col + (input.colDelta ?? 0),
    },
    bounds,
  )

  if (!input.extend) {
    return {
      kind: 'cell',
      sheetId: normalizedSelection.sheetId,
      anchor: target,
      focus: target,
    }
  }

  const anchor = getSelectionAnchorCell(normalizedSelection, bounds)
  const nextSelection: RangeSelection = {
    kind: 'range',
    sheetId: normalizedSelection.sheetId,
    anchor,
    focus: target,
  }

  return normalizeSelection(nextSelection, bounds)
}

function toMultiRange(state: SelectionState): MultiRangeSelectionState {
  return { regions: [state], primaryIndex: 0 }
}

function getPrimaryRegion(multi: MultiRangeSelectionState): SelectionState {
  return multi.regions[multi.primaryIndex] ?? multi.regions[0]
}

function copySelection(selection: SelectionState): SelectionState {
  switch (selection.kind) {
    case 'cell':
      return Object.freeze({
        kind: 'cell',
        sheetId: selection.sheetId,
        anchor: Object.freeze({ ...selection.anchor }),
        focus: Object.freeze({ ...selection.focus }),
      })
    case 'range':
      return Object.freeze({
        kind: 'range',
        sheetId: selection.sheetId,
        anchor: Object.freeze({ ...selection.anchor }),
        focus: Object.freeze({ ...selection.focus }),
      })
    case 'row':
      return Object.freeze({
        kind: 'row',
        sheetId: selection.sheetId,
        rowAnchor: selection.rowAnchor,
        rowFocus: selection.rowFocus,
      })
    case 'column':
      return Object.freeze({
        kind: 'column',
        sheetId: selection.sheetId,
        colAnchor: selection.colAnchor,
        colFocus: selection.colFocus,
      })
    case 'all':
      return Object.freeze({
        kind: 'all',
        sheetId: selection.sheetId,
      })
    default:
      return assertNever(selection)
  }
}

function copySelectionRegions(regions: readonly SelectionState[]): readonly SelectionState[] {
  return Object.freeze(regions.map(copySelection))
}

function snapshotSelectionBounds(bounds: SelectionBounds): SelectionBounds {
  return Object.freeze({
    rowCount: bounds.rowCount,
    colCount: bounds.colCount,
  })
}

function snapshotMultiSelectionState(state: MultiRangeSelectionState): MultiRangeSelectionState {
  return Object.freeze({
    regions: copySelectionRegions(state.regions),
    primaryIndex: state.primaryIndex,
  })
}

function sameNormalizedSelectionBounds(left: SelectionBounds, right: SelectionBounds): boolean {
  const normalizedLeft = normalizeSelectionBounds(left)
  const normalizedRight = normalizeSelectionBounds(right)
  return (
    normalizedLeft.rowCount === normalizedRight.rowCount &&
    normalizedLeft.colCount === normalizedRight.colCount
  )
}

interface SelectionTargetContext {
  readonly selection: SelectionState
  readonly range: CellRange
}

interface SelectionAuthorityState {
  readonly bounds: SelectionBounds
  readonly multi: MultiRangeSelectionState
  readonly witness: SelectionAuthorityWitness
}

interface SelectionWriteAuthority extends SelectionAuthorityState {
  readonly authority: SelectionAuthorityState
}

type SelectionInputSnapshot<T> =
  | { readonly kind: 'valid'; readonly value: T }
  | { readonly kind: 'invalid' }

const MAX_SELECTION_REGIONS = 10_000
const MAX_SELECTION_SHEET_ID_LENGTH = 512

function validSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function snapshotCellCoordInput(candidate: unknown): SelectionInputSnapshot<CellCoord> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const row = record.row
    const col = record.col
    if (!validSafeInteger(row) || !validSafeInteger(col)) return { kind: 'invalid' }
    return { kind: 'valid', value: Object.freeze({ row, col }) }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotSelectionBoundsInput(candidate: unknown): SelectionInputSnapshot<SelectionBounds> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const rowCount = record.rowCount
    const colCount = record.colCount
    if (
      !validSafeInteger(rowCount) ||
      rowCount < 1 ||
      rowCount > EXCEL_MAX_ROWS ||
      !validSafeInteger(colCount) ||
      colCount < 1 ||
      colCount > EXCEL_MAX_COLS
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({ rowCount, colCount }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotSelectionInput(candidate: unknown): SelectionInputSnapshot<SelectionState> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const kind = record.kind
    const sheetId = record.sheetId
    if (typeof sheetId !== 'string' || sheetId.length > MAX_SELECTION_SHEET_ID_LENGTH) {
      return { kind: 'invalid' }
    }
    if (kind === 'cell' || kind === 'range') {
      const anchor = snapshotCellCoordInput(record.anchor)
      const focus = snapshotCellCoordInput(record.focus)
      if (anchor.kind === 'invalid' || focus.kind === 'invalid') return { kind: 'invalid' }
      return {
        kind: 'valid',
        value: Object.freeze({ kind, sheetId, anchor: anchor.value, focus: focus.value }),
      }
    }
    if (kind === 'row') {
      const rowAnchor = record.rowAnchor
      const rowFocus = record.rowFocus
      if (!validSafeInteger(rowAnchor) || !validSafeInteger(rowFocus)) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'valid',
        value: Object.freeze({ kind, sheetId, rowAnchor, rowFocus }),
      }
    }
    if (kind === 'column') {
      const colAnchor = record.colAnchor
      const colFocus = record.colFocus
      if (!validSafeInteger(colAnchor) || !validSafeInteger(colFocus)) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'valid',
        value: Object.freeze({ kind, sheetId, colAnchor, colFocus }),
      }
    }
    if (kind === 'all') {
      return { kind: 'valid', value: Object.freeze({ kind, sheetId }) }
    }
    return { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotCellRangeInput(candidate: unknown): SelectionInputSnapshot<CellRange> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const rowStart = record.rowStart
    const rowEnd = record.rowEnd
    const colStart = record.colStart
    const colEnd = record.colEnd
    if (
      !validSafeInteger(rowStart) ||
      !validSafeInteger(rowEnd) ||
      !validSafeInteger(colStart) ||
      !validSafeInteger(colEnd) ||
      rowStart < 0 ||
      rowEnd < rowStart ||
      colStart < 0 ||
      colEnd < colStart
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({ rowStart, rowEnd, colStart, colEnd }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotOptionalSheetId(candidate: unknown): SelectionInputSnapshot<string | undefined> {
  return candidate === undefined ||
    (typeof candidate === 'string' && candidate.length <= MAX_SELECTION_SHEET_ID_LENGTH)
    ? { kind: 'valid', value: candidate }
    : { kind: 'invalid' }
}

function snapshotOptionalBoolean(candidate: unknown): SelectionInputSnapshot<boolean | undefined> {
  return candidate === undefined || typeof candidate === 'boolean'
    ? { kind: 'valid', value: candidate }
    : { kind: 'invalid' }
}

interface SelectCellInputSnapshot {
  readonly coord: CellCoord
  readonly sheetId?: string
  readonly extend?: boolean
}

function snapshotSelectCellInput(
  candidate: unknown,
): SelectionInputSnapshot<SelectCellInputSnapshot> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const coord = snapshotCellCoordInput(record.coord)
    const sheetId = snapshotOptionalSheetId(record.sheetId)
    const extend = snapshotOptionalBoolean(record.extend)
    if (coord.kind === 'invalid' || sheetId.kind === 'invalid' || extend.kind === 'invalid') {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({
        coord: coord.value,
        sheetId: sheetId.value,
        extend: extend.value,
      }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

interface SelectRowsInputSnapshot {
  readonly rowAnchor: number
  readonly rowFocus?: number
  readonly sheetId?: string
}

function snapshotSelectRowsInput(
  candidate: unknown,
): SelectionInputSnapshot<SelectRowsInputSnapshot> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const rowAnchor = record.rowAnchor
    const rowFocus = record.rowFocus
    const sheetId = snapshotOptionalSheetId(record.sheetId)
    if (
      !validSafeInteger(rowAnchor) ||
      (rowFocus !== undefined && !validSafeInteger(rowFocus)) ||
      sheetId.kind === 'invalid'
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({ rowAnchor, rowFocus, sheetId: sheetId.value }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

interface SelectColumnsInputSnapshot {
  readonly colAnchor: number
  readonly colFocus?: number
  readonly sheetId?: string
}

function snapshotSelectColumnsInput(
  candidate: unknown,
): SelectionInputSnapshot<SelectColumnsInputSnapshot> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const colAnchor = record.colAnchor
    const colFocus = record.colFocus
    const sheetId = snapshotOptionalSheetId(record.sheetId)
    if (
      !validSafeInteger(colAnchor) ||
      (colFocus !== undefined && !validSafeInteger(colFocus)) ||
      sheetId.kind === 'invalid'
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({ colAnchor, colFocus, sheetId: sheetId.value }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

interface AddSelectionRegionInputSnapshot {
  readonly region: SelectionRegion
  readonly makePrimary?: boolean
}

function snapshotAddSelectionRegionInput(
  candidate: unknown,
): SelectionInputSnapshot<AddSelectionRegionInputSnapshot> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const region = snapshotSelectionInput(record.region)
    const makePrimary = snapshotOptionalBoolean(record.makePrimary)
    if (
      region.kind === 'invalid' ||
      region.value.kind === 'all' ||
      makePrimary.kind === 'invalid'
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      value: Object.freeze({
        region: region.value,
        makePrimary: makePrimary.value,
      }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

interface SetMultiRegionSelectionInputSnapshot {
  readonly regions: readonly SelectionState[]
  readonly primaryIndex?: number
}

function snapshotSetMultiRegionSelectionInput(
  candidate: unknown,
): SelectionInputSnapshot<SetMultiRegionSelectionInputSnapshot> {
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const record = candidate as Record<string, unknown>
    const primaryIndex = record.primaryIndex
    if (primaryIndex !== undefined && (!validSafeInteger(primaryIndex) || primaryIndex < 0)) {
      return { kind: 'invalid' }
    }
    const regionCandidates = record.regions
    if (!Array.isArray(regionCandidates)) return { kind: 'invalid' }
    const regionCount = regionCandidates.length
    if (
      !validSafeInteger(regionCount) ||
      regionCount > MAX_SELECTION_REGIONS ||
      (primaryIndex !== undefined &&
        (regionCount === 0 ? primaryIndex !== 0 : primaryIndex >= regionCount))
    ) {
      return { kind: 'invalid' }
    }
    const regions: SelectionState[] = []
    for (let index = 0; index < regionCount; index += 1) {
      const region = snapshotSelectionInput(regionCandidates[index])
      if (region.kind === 'invalid') return { kind: 'invalid' }
      regions.push(region.value)
    }
    return {
      kind: 'valid',
      value: Object.freeze({
        regions: Object.freeze(regions),
        primaryIndex,
      }),
    }
  } catch {
    return { kind: 'invalid' }
  }
}

function snapshotClearSelectionRegionsInput(
  candidate: unknown,
): SelectionInputSnapshot<Readonly<ClearSelectionRegionsInput> | undefined> {
  if (candidate === undefined) return { kind: 'valid', value: undefined }
  if (candidate === null || typeof candidate !== 'object') return { kind: 'invalid' }
  try {
    const keepPrimary = snapshotOptionalBoolean((candidate as Record<string, unknown>).keepPrimary)
    return keepPrimary.kind === 'invalid'
      ? { kind: 'invalid' }
      : { kind: 'valid', value: Object.freeze({ keepPrimary: keepPrimary.value }) }
  } catch {
    return { kind: 'invalid' }
  }
}

function captureSelectionTargetContext(
  multi: MultiRangeSelectionState,
  bounds: SelectionBounds,
): SelectionTargetContext {
  const normalizedBounds = normalizeSelectionBounds(bounds)
  const selection = normalizeSelection(getPrimaryRegion(multi), normalizedBounds)
  return {
    selection,
    range: getSelectionRange(selection, normalizedBounds),
  }
}

function sameSelectionState(left: SelectionState, right: SelectionState): boolean {
  if (left.kind !== right.kind || left.sheetId !== right.sheetId) return false

  switch (left.kind) {
    case 'cell':
    case 'range':
      return (
        (right.kind === 'cell' || right.kind === 'range') &&
        sameCoord(left.anchor, right.anchor) &&
        sameCoord(left.focus, right.focus)
      )
    case 'row':
      return (
        right.kind === 'row' &&
        left.rowAnchor === right.rowAnchor &&
        left.rowFocus === right.rowFocus
      )
    case 'column':
      return (
        right.kind === 'column' &&
        left.colAnchor === right.colAnchor &&
        left.colFocus === right.colFocus
      )
    case 'all':
      return right.kind === 'all'
    default:
      return assertNever(left)
  }
}

function sameSelectionTargetContext(
  left: SelectionTargetContext,
  right: SelectionTargetContext,
): boolean {
  return (
    sameSelectionState(left.selection, right.selection) &&
    left.range.rowStart === right.range.rowStart &&
    left.range.rowEnd === right.range.rowEnd &&
    left.range.colStart === right.range.colStart &&
    left.range.colEnd === right.range.colEnd
  )
}

function createSelectionAuthorityWitness(): SelectionAuthorityWitness {
  return Object.freeze({}) as SelectionAuthorityWitness
}

type SelectionBoundsUpdate = SelectionBounds | ((previous: SelectionBounds) => SelectionBounds)

function createSelectionAuthorityState(
  bounds: SelectionBounds,
  multi: MultiRangeSelectionState,
  witness: SelectionAuthorityWitness,
): SelectionAuthorityState {
  return Object.freeze({ bounds, multi, witness })
}

const selectionAuthorityStateAtom = atom<SelectionAuthorityState>(
  createSelectionAuthorityState(
    snapshotSelectionBounds(DEFAULT_SELECTION_BOUNDS),
    snapshotMultiSelectionState(DEFAULT_MULTI_SELECTION_STATE),
    createSelectionAuthorityWitness(),
  ),
)
selectionAuthorityStateAtom.debugLabel = 'spreadsheet.selection.internal.authorityState'

const selectionBoundsStateAtom: Atom<SelectionBounds> = atom(
  (get) => get(selectionAuthorityStateAtom).bounds,
)
selectionBoundsStateAtom.debugLabel = 'spreadsheet.selection.internal.boundsState'

const _multiSelectionAtom: Atom<MultiRangeSelectionState> = atom(
  (get) => get(selectionAuthorityStateAtom).multi,
)
_multiSelectionAtom.debugLabel = 'spreadsheet.selection._multi'

function captureSelectionWriteAuthority(get: Getter): SelectionWriteAuthority {
  const authority = get(selectionAuthorityStateAtom)
  return {
    authority,
    bounds: authority.bounds,
    multi: authority.multi,
    witness: authority.witness,
  }
}

function selectionWriteAuthorityIsCurrent(get: Getter, captured: SelectionWriteAuthority): boolean {
  return get(selectionAuthorityStateAtom) === captured.authority
}

export const selectionAuthorityWitnessAtom: Atom<SelectionAuthorityWitness> = atom(
  (get) => get(selectionAuthorityStateAtom).witness,
)
selectionAuthorityWitnessAtom.debugLabel = 'spreadsheet.selection.authorityWitness'

function commitMultiSelectionState(
  get: Getter,
  set: Setter,
  nextState: MultiRangeSelectionState,
): SelectionAuthorityState {
  const nextSnapshot = snapshotMultiSelectionState(nextState)
  const liveAuthority = get(selectionAuthorityStateAtom)
  const previousTarget = captureSelectionTargetContext(liveAuthority.multi, liveAuthority.bounds)
  const nextTarget = captureSelectionTargetContext(nextSnapshot, liveAuthority.bounds)
  const witness = sameSelectionTargetContext(previousTarget, nextTarget)
    ? liveAuthority.witness
    : createSelectionAuthorityWitness()
  const nextAuthority = createSelectionAuthorityState(liveAuthority.bounds, nextSnapshot, witness)
  set(selectionAuthorityStateAtom, nextAuthority)
  return nextAuthority
}

function createSelectionAuthorityReceipt(
  authority: SelectionAuthorityState,
): SelectionAuthorityReceipt {
  const target = captureSelectionTargetContext(authority.multi, authority.bounds)
  return Object.freeze({
    selection: copySelection(target.selection),
    range: Object.freeze({ ...target.range }),
    witness: authority.witness,
  })
}

/**
 * Controlled facade preserving direct AtomEntity-style writes, including
 * updater functions. Any normalized sheet-size change rotates selection
 * authority because a ticketed range may be larger than the owned focus that
 * is currently projected into the public selection.
 */
export const selectionBoundsAtom = atom(
  (get) => snapshotSelectionBounds(get(selectionBoundsStateAtom)),
  (get, set, update: SelectionBoundsUpdate): void => {
    const captured = captureSelectionWriteAuthority(get)
    let proposedBounds: unknown
    try {
      proposedBounds =
        typeof update === 'function' ? update(snapshotSelectionBounds(captured.bounds)) : update
    } catch {
      return
    }
    const nextBounds = snapshotSelectionBoundsInput(proposedBounds)
    if (nextBounds.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const witness = sameNormalizedSelectionBounds(captured.bounds, nextBounds.value)
      ? captured.witness
      : createSelectionAuthorityWitness()
    set(
      selectionAuthorityStateAtom,
      createSelectionAuthorityState(nextBounds.value, captured.multi, witness),
    )
  },
)
selectionBoundsAtom.debugLabel = 'spreadsheet.selection.bounds'

export const selectionAtom = atom(
  (get): SelectionState => copySelection(getPrimaryRegion(get(_multiSelectionAtom))),
  (get, set, state: SelectionState) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextSelection = snapshotSelectionInput(state)
    if (nextSelection.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    commitMultiSelectionState(
      get,
      set,
      toMultiRange(normalizeSelection(nextSelection.value, captured.bounds)),
    )
  },
)
selectionAtom.debugLabel = 'spreadsheet.selection.state'

export const selectionRegionsAtom = atom((get): readonly SelectionState[] =>
  copySelectionRegions(get(_multiSelectionAtom).regions),
)
selectionRegionsAtom.debugLabel = 'spreadsheet.selection.regions'

export const primarySelectionRegionAtom = atom(
  (get): SelectionState => copySelection(getPrimaryRegion(get(_multiSelectionAtom))),
)
primarySelectionRegionAtom.debugLabel = 'spreadsheet.selection.primaryRegion'

export const activeCellAtom = atom((get): ActiveSelectionCell => {
  const bounds = get(selectionBoundsStateAtom)
  return Object.freeze(getActiveCell(getPrimaryRegion(get(_multiSelectionAtom)), bounds))
})
activeCellAtom.debugLabel = 'spreadsheet.selection.activeCell'

export const selectionRangeAtom = atom((get): CellRange => {
  const bounds = get(selectionBoundsStateAtom)
  return Object.freeze(getSelectionRange(getPrimaryRegion(get(_multiSelectionAtom)), bounds))
})
selectionRangeAtom.debugLabel = 'spreadsheet.selection.range'

export const selectionSnapshotAtom = atom((get): SelectionSnapshot => {
  const bounds = get(selectionBoundsStateAtom)
  const selection = copySelection(
    normalizeSelection(getPrimaryRegion(get(_multiSelectionAtom)), bounds),
  )

  return Object.freeze({
    selection,
    activeCell: Object.freeze(getActiveCell(selection, bounds)),
    range: Object.freeze(getSelectionRange(selection, bounds)),
  })
})
selectionSnapshotAtom.debugLabel = 'spreadsheet.selection.snapshot'

export const setSelectionBoundsAtom = atom(
  (get) => get(selectionBoundsAtom),
  (get, set, bounds: SelectionBounds) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextBounds = snapshotSelectionBoundsInput(bounds)
    if (nextBounds.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const nextMulti = snapshotMultiSelectionState({
      regions: captured.multi.regions.map((region) => normalizeSelection(region, nextBounds.value)),
      primaryIndex: captured.multi.primaryIndex,
    })
    const boundsChanged = !sameNormalizedSelectionBounds(captured.bounds, nextBounds.value)
    const targetChanged = !sameSelectionTargetContext(
      captureSelectionTargetContext(captured.multi, captured.bounds),
      captureSelectionTargetContext(nextMulti, nextBounds.value),
    )
    const witness =
      boundsChanged || targetChanged ? createSelectionAuthorityWitness() : captured.witness
    set(
      selectionAuthorityStateAtom,
      createSelectionAuthorityState(nextBounds.value, nextMulti, witness),
    )
  },
)
setSelectionBoundsAtom.debugLabel = 'spreadsheet.selection.setBounds'

export const setSelectionAtom = atom(
  (get) => get(selectionAtom),
  (get, set, selection: SelectionState) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextSelection = snapshotSelectionInput(selection)
    if (nextSelection.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    commitMultiSelectionState(
      get,
      set,
      toMultiRange(normalizeSelection(nextSelection.value, captured.bounds)),
    )
  },
)
setSelectionAtom.debugLabel = 'spreadsheet.selection.set'

/**
 * Guarded selection command for core features that must retain ownership of
 * the selection they just projected. The receipt is sourced from the private
 * authority state written by this command, so it remains coherent inside the
 * current @einfach/core transaction before derived atoms are flushed.
 */
export const setSelectionWithAuthorityReceiptAtom = atom(
  null,
  (get, set, selection: SelectionState): SelectionAuthorityReceipt | null => {
    const captured = captureSelectionWriteAuthority(get)
    const nextSelection = snapshotSelectionInput(selection)
    if (nextSelection.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return null
    }
    const authority = commitMultiSelectionState(
      get,
      set,
      toMultiRange(normalizeSelection(nextSelection.value, captured.bounds)),
    )
    return createSelectionAuthorityReceipt(authority)
  },
)
setSelectionWithAuthorityReceiptAtom.debugLabel = 'spreadsheet.selection.setWithAuthorityReceipt'

/**
 * Validates a guarded-write receipt against the private authority aggregate.
 * This command intentionally avoids derived selection projections: callers
 * may need to validate immediately after a guarded write, before the outer
 * @einfach/core transaction has flushed derived atom caches.
 */
export const selectionAuthorityReceiptIsCurrentAtom = atom(
  null,
  (get, _set, receipt: SelectionAuthorityReceipt): boolean => {
    const authorityAtStart = get(selectionAuthorityStateAtom)
    let witness: unknown
    let selectionCandidate: unknown
    let rangeCandidate: unknown
    try {
      witness = receipt.witness
      selectionCandidate = receipt.selection
      rangeCandidate = receipt.range
    } catch {
      return false
    }
    const selection = snapshotSelectionInput(selectionCandidate)
    const range = snapshotCellRangeInput(rangeCandidate)
    if (
      selection.kind === 'invalid' ||
      range.kind === 'invalid' ||
      get(selectionAuthorityStateAtom) !== authorityAtStart ||
      witness !== authorityAtStart.witness
    ) {
      return false
    }
    return sameSelectionTargetContext(
      captureSelectionTargetContext(authorityAtStart.multi, authorityAtStart.bounds),
      { selection: selection.value, range: range.value },
    )
  },
)
selectionAuthorityReceiptIsCurrentAtom.debugLabel =
  'spreadsheet.selection.authorityReceiptIsCurrent'

export const selectCellAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectCellInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotSelectCellInput(input)
    if (nextInput.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const current = normalizeSelection(getPrimaryRegion(captured.multi), captured.bounds)
    const sheetId = nextInput.value.sheetId ?? current.sheetId
    const coord = clampCellCoord(nextInput.value.coord, captured.bounds)

    if (!nextInput.value.extend || sheetId !== current.sheetId) {
      commitMultiSelectionState(get, set, {
        regions: [{ kind: 'cell', sheetId, anchor: coord, focus: coord }],
        primaryIndex: 0,
      })
      return
    }

    commitMultiSelectionState(get, set, {
      regions: [
        normalizeSelection(
          {
            kind: 'range',
            sheetId,
            anchor: getSelectionAnchorCell(current, captured.bounds),
            focus: coord,
          },
          captured.bounds,
        ),
      ],
      primaryIndex: 0,
    })
  },
)
selectCellAtom.debugLabel = 'spreadsheet.selection.selectCell'

export const selectRowsAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectRowsInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotSelectRowsInput(input)
    if (nextInput.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const current = getPrimaryRegion(captured.multi)
    const rowFocus = nextInput.value.rowFocus ?? nextInput.value.rowAnchor
    commitMultiSelectionState(get, set, {
      regions: [
        normalizeSelection(
          {
            kind: 'row',
            sheetId: nextInput.value.sheetId ?? current.sheetId,
            rowAnchor: nextInput.value.rowAnchor,
            rowFocus,
          },
          captured.bounds,
        ),
      ],
      primaryIndex: 0,
    })
  },
)
selectRowsAtom.debugLabel = 'spreadsheet.selection.selectRows'

export const selectColumnsAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectColumnsInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotSelectColumnsInput(input)
    if (nextInput.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const current = getPrimaryRegion(captured.multi)
    const colFocus = nextInput.value.colFocus ?? nextInput.value.colAnchor
    commitMultiSelectionState(get, set, {
      regions: [
        normalizeSelection(
          {
            kind: 'column',
            sheetId: nextInput.value.sheetId ?? current.sheetId,
            colAnchor: nextInput.value.colAnchor,
            colFocus,
          },
          captured.bounds,
        ),
      ],
      primaryIndex: 0,
    })
  },
)
selectColumnsAtom.debugLabel = 'spreadsheet.selection.selectColumns'

export const selectAllAtom = atom(
  (get) => get(selectionAtom),
  (get, set, sheetId?: string) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextSheetId = snapshotOptionalSheetId(sheetId)
    if (nextSheetId.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const current = getPrimaryRegion(captured.multi)
    commitMultiSelectionState(get, set, {
      regions: [{ kind: 'all', sheetId: nextSheetId.value ?? current.sheetId }],
      primaryIndex: 0,
    })
  },
)
selectAllAtom.debugLabel = 'spreadsheet.selection.selectAll'

export const setPrimaryRegionAtom = atom(
  (get) => copySelection(getPrimaryRegion(get(_multiSelectionAtom))),
  (get, set, state: SelectionState) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextSelection = snapshotSelectionInput(state)
    if (nextSelection.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    const regions = captured.multi.regions.slice()
    regions[captured.multi.primaryIndex] = normalizeSelection(nextSelection.value, captured.bounds)
    commitMultiSelectionState(get, set, {
      regions,
      primaryIndex: captured.multi.primaryIndex,
    })
  },
)
setPrimaryRegionAtom.debugLabel = 'spreadsheet.selection.setPrimaryRegion'

export const addSelectionRegionAtom = atom(
  (get) => snapshotMultiSelectionState(get(_multiSelectionAtom)),
  (get, set, input: AddSelectionRegionInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotAddSelectionRegionInput(input)
    if (
      nextInput.kind === 'invalid' ||
      captured.multi.regions.length >= MAX_SELECTION_REGIONS ||
      !selectionWriteAuthorityIsCurrent(get, captured)
    ) {
      return
    }
    const region = normalizeSelection(nextInput.value.region, captured.bounds) as SelectionRegion
    const regions = [...captured.multi.regions, region]
    const primaryIndex =
      nextInput.value.makePrimary === false ? captured.multi.primaryIndex : regions.length - 1
    commitMultiSelectionState(get, set, { regions, primaryIndex })
  },
)
addSelectionRegionAtom.debugLabel = 'spreadsheet.selection.addRegion'

/**
 * Replace the entire selection with a list of regions in one atomic write.
 * Used by features like Go To Special that need to surface N matches as a
 * single multi-region selection without N separate add-region writes — each
 * of which would fire a separate atom-change notification and re-render
 * subscribers N times.
 *
 * `primaryIndex` defaults to 0 when omitted. Empty input falls back to the
 * default empty cell selection at (0,0) of the current selection's sheet so
 * subscribers always observe a well-formed primary region.
 */
export interface SetMultiRegionSelectionInput {
  readonly regions: readonly SelectionState[]
  readonly primaryIndex?: number
}

export const setMultiRegionSelectionAtom = atom(
  (get) => snapshotMultiSelectionState(get(_multiSelectionAtom)),
  (get, set, input: SetMultiRegionSelectionInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotSetMultiRegionSelectionInput(input)
    if (nextInput.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    if (nextInput.value.regions.length === 0) {
      const currentSheet =
        getPrimaryRegion(captured.multi)?.sheetId ?? DEFAULT_SELECTION_STATE.sheetId
      commitMultiSelectionState(get, set, {
        regions: [{ ...DEFAULT_SELECTION_STATE, sheetId: currentSheet }],
        primaryIndex: 0,
      })
      return
    }
    const regions = nextInput.value.regions.map((region) =>
      normalizeSelection(region, captured.bounds),
    )
    const primaryIndex = nextInput.value.primaryIndex ?? 0
    commitMultiSelectionState(get, set, { regions, primaryIndex })
  },
)
setMultiRegionSelectionAtom.debugLabel = 'spreadsheet.selection.setMultiRegion'

export const clearNonPrimaryRegionsAtom = atom(
  (get) => snapshotMultiSelectionState(get(_multiSelectionAtom)),
  (get, set, input?: ClearSelectionRegionsInput) => {
    const captured = captureSelectionWriteAuthority(get)
    const nextInput = snapshotClearSelectionRegionsInput(input)
    if (nextInput.kind === 'invalid' || !selectionWriteAuthorityIsCurrent(get, captured)) {
      return
    }
    if (nextInput.value?.keepPrimary) {
      const primary = copySelection(getPrimaryRegion(captured.multi))
      commitMultiSelectionState(get, set, { regions: [primary], primaryIndex: 0 })
      return
    }

    commitMultiSelectionState(get, set, {
      regions: [DEFAULT_SELECTION_STATE],
      primaryIndex: 0,
    })
  },
)
clearNonPrimaryRegionsAtom.debugLabel = 'spreadsheet.selection.clearNonPrimary'

function normalizeCellRange(anchor: CellCoord, focus: CellCoord): CellRange {
  return {
    rowStart: Math.min(anchor.row, focus.row),
    rowEnd: Math.max(anchor.row, focus.row),
    colStart: Math.min(anchor.col, focus.col),
    colEnd: Math.max(anchor.col, focus.col),
  }
}

function getSelectionAnchorCell(selection: SelectionState, bounds: SelectionBounds): CellCoord {
  const normalizedSelection = normalizeSelection(selection, bounds)

  switch (normalizedSelection.kind) {
    case 'cell':
    case 'range':
      return normalizedSelection.anchor
    case 'row':
      return {
        row: normalizedSelection.rowAnchor,
        col: 0,
      }
    case 'column':
      return {
        row: 0,
        col: normalizedSelection.colAnchor,
      }
    case 'all':
      return {
        row: 0,
        col: 0,
      }
    default:
      return assertNever(normalizedSelection)
  }
}

function normalizeCount(value: number, max: number): number {
  if (!Number.isSafeInteger(value)) {
    return 1
  }

  return Math.max(1, Math.min(value, max))
}

function clampIndex(value: number, maxExclusive: number): number {
  if (!Number.isSafeInteger(value)) {
    return 0
  }

  return Math.max(0, Math.min(value, maxExclusive - 1))
}

function sameCoord(left: CellCoord, right: CellCoord): boolean {
  return left.row === right.row && left.col === right.col
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selection state: ${JSON.stringify(value)}`)
}
