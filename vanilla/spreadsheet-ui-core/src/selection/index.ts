import { atom } from '@einfach/core'
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

export const DEFAULT_SELECTION_BOUNDS: SelectionBounds = {
  rowCount: EXCEL_MAX_ROWS,
  colCount: EXCEL_MAX_COLS,
}

export const DEFAULT_SELECTION_STATE: CellSelection = {
  kind: 'cell',
  sheetId: '',
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 0 },
}

const DEFAULT_MULTI_SELECTION_STATE: MultiRangeSelectionState = {
  regions: [DEFAULT_SELECTION_STATE],
  primaryIndex: 0,
}

export function normalizeSelectionBounds(bounds: SelectionBounds): SelectionBounds {
  return {
    rowCount: normalizeCount(bounds.rowCount),
    colCount: normalizeCount(bounds.colCount),
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
      return selection
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

export const selectionBoundsAtom = atom<SelectionBounds>(DEFAULT_SELECTION_BOUNDS)
selectionBoundsAtom.debugLabel = 'spreadsheet.selection.bounds'

const _multiSelectionAtom = atom<MultiRangeSelectionState>(DEFAULT_MULTI_SELECTION_STATE)
_multiSelectionAtom.debugLabel = 'spreadsheet.selection._multi'

export const selectionAtom = atom(
  (get): SelectionState => getPrimaryRegion(get(_multiSelectionAtom)),
  (get, set, state: SelectionState) => {
    set(_multiSelectionAtom, toMultiRange(normalizeSelection(state, get(selectionBoundsAtom))))
  },
)
selectionAtom.debugLabel = 'spreadsheet.selection.state'

export const selectionRegionsAtom = atom(
  (get): SelectionState[] => get(_multiSelectionAtom).regions,
)
selectionRegionsAtom.debugLabel = 'spreadsheet.selection.regions'

export const primarySelectionRegionAtom = atom(
  (get): SelectionState => getPrimaryRegion(get(_multiSelectionAtom)),
)
primarySelectionRegionAtom.debugLabel = 'spreadsheet.selection.primaryRegion'

export const activeCellAtom = atom((get): ActiveSelectionCell => {
  return getActiveCell(get(selectionAtom), get(selectionBoundsAtom))
})
activeCellAtom.debugLabel = 'spreadsheet.selection.activeCell'

export const selectionRangeAtom = atom((get): CellRange => {
  return getSelectionRange(get(selectionAtom), get(selectionBoundsAtom))
})
selectionRangeAtom.debugLabel = 'spreadsheet.selection.range'

export const selectionSnapshotAtom = atom((get): SelectionSnapshot => {
  const selection = normalizeSelection(get(selectionAtom), get(selectionBoundsAtom))

  return {
    selection,
    activeCell: getActiveCell(selection, get(selectionBoundsAtom)),
    range: getSelectionRange(selection, get(selectionBoundsAtom)),
  }
})
selectionSnapshotAtom.debugLabel = 'spreadsheet.selection.snapshot'

export const setSelectionBoundsAtom = atom(
  (get) => get(selectionBoundsAtom),
  (get, set, bounds: SelectionBounds) => {
    const normalizedBounds = normalizeSelectionBounds(bounds)
    set(selectionBoundsAtom, normalizedBounds)
    const multi = get(_multiSelectionAtom)
    set(_multiSelectionAtom, {
      regions: multi.regions.map((r) => normalizeSelection(r, normalizedBounds)),
      primaryIndex: multi.primaryIndex,
    })
  },
)
setSelectionBoundsAtom.debugLabel = 'spreadsheet.selection.setBounds'

export const setSelectionAtom = atom(
  (get) => get(selectionAtom),
  (get, set, selection: SelectionState) => {
    set(selectionAtom, selection)
  },
)
setSelectionAtom.debugLabel = 'spreadsheet.selection.set'

export const selectCellAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectCellInput) => {
    const bounds = get(selectionBoundsAtom)
    const current = normalizeSelection(get(selectionAtom), bounds)
    const sheetId = input.sheetId ?? current.sheetId
    const coord = clampCellCoord(input.coord, bounds)

    if (!input.extend || sheetId !== current.sheetId) {
      set(selectionAtom, {
        kind: 'cell',
        sheetId,
        anchor: coord,
        focus: coord,
      })
      return
    }

    set(
      selectionAtom,
      normalizeSelection(
        {
          kind: 'range',
          sheetId,
          anchor: getSelectionAnchorCell(current, bounds),
          focus: coord,
        },
        bounds,
      ),
    )
  },
)
selectCellAtom.debugLabel = 'spreadsheet.selection.selectCell'

export const selectRowsAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectRowsInput) => {
    const current = get(selectionAtom)
    const rowFocus = input.rowFocus ?? input.rowAnchor

    set(
      selectionAtom,
      normalizeSelection(
        {
          kind: 'row',
          sheetId: input.sheetId ?? current.sheetId,
          rowAnchor: input.rowAnchor,
          rowFocus,
        },
        get(selectionBoundsAtom),
      ),
    )
  },
)
selectRowsAtom.debugLabel = 'spreadsheet.selection.selectRows'

export const selectColumnsAtom = atom(
  (get) => get(selectionAtom),
  (get, set, input: SelectColumnsInput) => {
    const current = get(selectionAtom)
    const colFocus = input.colFocus ?? input.colAnchor

    set(
      selectionAtom,
      normalizeSelection(
        {
          kind: 'column',
          sheetId: input.sheetId ?? current.sheetId,
          colAnchor: input.colAnchor,
          colFocus,
        },
        get(selectionBoundsAtom),
      ),
    )
  },
)
selectColumnsAtom.debugLabel = 'spreadsheet.selection.selectColumns'

export const selectAllAtom = atom(
  (get) => get(selectionAtom),
  (get, set, sheetId?: string) => {
    const current = get(selectionAtom)
    set(selectionAtom, {
      kind: 'all',
      sheetId: sheetId ?? current.sheetId,
    })
  },
)
selectAllAtom.debugLabel = 'spreadsheet.selection.selectAll'

export const setPrimaryRegionAtom = atom(
  (get) => getPrimaryRegion(get(_multiSelectionAtom)),
  (get, set, state: SelectionState) => {
    const multi = get(_multiSelectionAtom)
    const normalized = normalizeSelection(state, get(selectionBoundsAtom))
    const regions = multi.regions.slice()
    regions[multi.primaryIndex] = normalized
    set(_multiSelectionAtom, { regions, primaryIndex: multi.primaryIndex })
  },
)
setPrimaryRegionAtom.debugLabel = 'spreadsheet.selection.setPrimaryRegion'

export const addSelectionRegionAtom = atom(
  (get) => get(_multiSelectionAtom),
  (get, set, input: AddSelectionRegionInput) => {
    const bounds = get(selectionBoundsAtom)
    const multi = get(_multiSelectionAtom)
    const region = normalizeSelection(input.region, bounds) as SelectionRegion
    const regions = [...multi.regions, region]
    const primaryIndex = input.makePrimary === false ? multi.primaryIndex : regions.length - 1
    set(_multiSelectionAtom, { regions, primaryIndex })
  },
)
addSelectionRegionAtom.debugLabel = 'spreadsheet.selection.addRegion'

export const clearNonPrimaryRegionsAtom = atom(
  (get) => get(_multiSelectionAtom),
  (get, set, input?: ClearSelectionRegionsInput) => {
    if (input?.keepPrimary) {
      const primary = getPrimaryRegion(get(_multiSelectionAtom))
      set(_multiSelectionAtom, { regions: [primary], primaryIndex: 0 })
      return
    }

    set(_multiSelectionAtom, { regions: [DEFAULT_SELECTION_STATE], primaryIndex: 0 })
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

function getSelectionAnchorCell(
  selection: SelectionState,
  bounds: SelectionBounds,
): CellCoord {
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

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }

  return Math.max(1, Math.trunc(value))
}

function clampIndex(value: number, maxExclusive: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(Math.trunc(value), maxExclusive - 1))
}

function sameCoord(left: CellCoord, right: CellCoord): boolean {
  return left.row === right.row && left.col === right.col
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selection state: ${JSON.stringify(value)}`)
}
