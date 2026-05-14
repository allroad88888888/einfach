import { atom } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
import type {
  PointerAutoscrollInput,
  PointerAutoscrollState,
  PointerColumnResizeSession,
  PointerColumnResizeStartInput,
  PointerColumnResizeUpdateInput,
  PointerCommitIntent,
  PointerDragSelectionSession,
  PointerFillHandleSession,
  PointerFillHandleStartInput,
  PointerFillHandleUpdateInput,
  PointerInteractionState,
  PointerIntent,
  PointerRowResizeSession,
  PointerRowResizeStartInput,
  PointerRowResizeUpdateInput,
  PointerSelectionStartInput,
  PointerSelectionUpdateInput,
  PointerSessionState,
  PointerStartInput,
  PointerUpdateInput,
} from './types'

export * from './types'

function copyCellCoord(coord: CellCoord): CellCoord {
  return {
    row: coord.row,
    col: coord.col,
  }
}

function copyCellRange(range: CellRange): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function normalizeCellRange(anchor: CellCoord, focus: CellCoord): CellRange {
  return {
    rowStart: Math.min(anchor.row, focus.row),
    rowEnd: Math.max(anchor.row, focus.row),
    colStart: Math.min(anchor.col, focus.col),
    colEnd: Math.max(anchor.col, focus.col),
  }
}

function patchAutoscrollState(
  state: PointerAutoscrollState | null,
  input?: PointerAutoscrollInput | null,
): PointerAutoscrollState | null {
  if (input === undefined) {
    return state
  }

  if (input === null) {
    return null
  }

  return {
    active: input.active === undefined ? state?.active ?? true : input.active,
    edge: input.edge === undefined ? state?.edge ?? null : input.edge,
    deltaX: input.deltaX === undefined ? state?.deltaX ?? 0 : input.deltaX,
    deltaY: input.deltaY === undefined ? state?.deltaY ?? 0 : input.deltaY,
  }
}

function createIdlePointerState(): PointerSessionState {
  return {
    status: 'idle',
    source: null,
    interaction: null,
    autoscroll: null,
  }
}

function isDragSelectionInput(input: PointerStartInput | PointerUpdateInput): input is PointerSelectionStartInput | PointerSelectionUpdateInput {
  return input.kind === 'drag-selection'
}

function isFillHandleInput(
  input: PointerStartInput | PointerUpdateInput,
): input is PointerFillHandleStartInput | PointerFillHandleUpdateInput {
  return input.kind === 'fill-handle'
}

function isRowResizeInput(
  input: PointerStartInput | PointerUpdateInput,
): input is PointerRowResizeStartInput | PointerRowResizeUpdateInput {
  return input.kind === 'row-resize'
}

function isColumnResizeInput(
  input: PointerStartInput | PointerUpdateInput,
): input is PointerColumnResizeStartInput | PointerColumnResizeUpdateInput {
  return input.kind === 'column-resize'
}

function buildDragSelectionSession(
  input: PointerSelectionStartInput,
): PointerDragSelectionSession {
  const anchor = copyCellCoord(input.anchor)
  const focus = copyCellCoord(input.focus ?? input.anchor)

  return {
    kind: 'drag-selection',
    sheetId: input.sheetId,
    anchor,
    focus,
    range: normalizeCellRange(anchor, focus),
  }
}

function buildFillHandleSession(
  input: PointerFillHandleStartInput,
): PointerFillHandleSession {
  return {
    kind: 'fill-handle',
    sheetId: input.sheetId,
    sourceRange: copyCellRange(input.sourceRange),
    focus: input.focus ? copyCellCoord(input.focus) : null,
    previewRange: input.previewRange ? copyCellRange(input.previewRange) : null,
    direction: input.direction ?? null,
  }
}

function buildRowResizeSession(
  input: PointerRowResizeStartInput,
): PointerRowResizeSession {
  return {
    kind: 'row-resize',
    sheetId: input.sheetId,
    rowIndex: input.rowIndex,
    startSizePx: input.startSizePx ?? null,
    previewSizePx: input.previewSizePx ?? null,
  }
}

function buildColumnResizeSession(
  input: PointerColumnResizeStartInput,
): PointerColumnResizeSession {
  return {
    kind: 'column-resize',
    sheetId: input.sheetId,
    colIndex: input.colIndex,
    startSizePx: input.startSizePx ?? null,
    previewSizePx: input.previewSizePx ?? null,
  }
}

function buildInteraction(input: PointerStartInput): PointerInteractionState {
  if (isDragSelectionInput(input)) {
    return buildDragSelectionSession(input)
  }
  if (isFillHandleInput(input)) {
    return buildFillHandleSession(input)
  }
  if (isRowResizeInput(input)) {
    return buildRowResizeSession(input)
  }
  if (isColumnResizeInput(input)) {
    return buildColumnResizeSession(input)
  }

  throw new Error('Unsupported pointer input')
}

function patchInteraction(
  state: PointerInteractionState,
  input: PointerUpdateInput,
): PointerInteractionState {
  if (state.kind !== input.kind) {
    return state
  }

  if (state.kind === 'drag-selection' && input.kind === 'drag-selection') {
    const focus = copyCellCoord(input.focus)
    return {
      ...state,
      focus,
      range: normalizeCellRange(state.anchor, focus),
    }
  }

  if (state.kind === 'fill-handle' && input.kind === 'fill-handle') {
    return {
      ...state,
      focus: input.focus ? copyCellCoord(input.focus) : state.focus,
      previewRange: input.previewRange === undefined
        ? state.previewRange
        : input.previewRange === null
          ? null
          : copyCellRange(input.previewRange),
      direction: input.direction ?? state.direction,
    }
  }

  if (state.kind === 'row-resize' && input.kind === 'row-resize') {
    return {
      ...state,
      previewSizePx:
        input.previewSizePx === undefined ? state.previewSizePx : input.previewSizePx,
    }
  }

  if (state.kind === 'column-resize' && input.kind === 'column-resize') {
    return {
      ...state,
      previewSizePx:
        input.previewSizePx === undefined ? state.previewSizePx : input.previewSizePx,
    }
  }

  return state
}

export function createPointerSessionState(): PointerSessionState {
  return createIdlePointerState()
}

export function startPointerSessionState(
  _state: PointerSessionState,
  input: PointerStartInput,
): PointerSessionState {
  return {
    status: 'active',
    source: input.source ?? 'pointer',
    interaction: buildInteraction(input),
    autoscroll: null,
  }
}

export function updatePointerSessionState(
  state: PointerSessionState,
  input: PointerUpdateInput,
): PointerSessionState {
  if (state.status !== 'active' || state.interaction === null) {
    return state
  }

  return {
    status: 'active',
    source: input.source ?? state.source,
    interaction: patchInteraction(state.interaction, input),
    autoscroll: patchAutoscrollState(state.autoscroll, input.autoscroll),
  }
}

function clearPointerSessionState(): PointerSessionState {
  return createIdlePointerState()
}

export function createPointerCommitIntent(
  state: PointerSessionState,
): PointerCommitIntent | null {
  if (state.status !== 'active' || state.interaction === null) {
    return null
  }

  switch (state.interaction.kind) {
    case 'drag-selection':
      return {
        type: 'pointer.drag-selection.commit',
        sheetId: state.interaction.sheetId,
        source: state.source,
        anchor: copyCellCoord(state.interaction.anchor),
        focus: copyCellCoord(state.interaction.focus),
        range: copyCellRange(state.interaction.range),
      }
    case 'fill-handle':
      if (state.interaction.previewRange === null) {
        return null
      }

      return {
        type: 'pointer.fill-handle.commit',
        sheetId: state.interaction.sheetId,
        source: state.source,
        sourceRange: copyCellRange(state.interaction.sourceRange),
        targetRange: copyCellRange(state.interaction.previewRange),
        focus: state.interaction.focus ? copyCellCoord(state.interaction.focus) : null,
        direction: state.interaction.direction,
      }
    case 'row-resize':
      if (state.interaction.previewSizePx === null) {
        return null
      }

      return {
        type: 'pointer.row-resize.commit',
        sheetId: state.interaction.sheetId,
        source: state.source,
        rowIndex: state.interaction.rowIndex,
        startSizePx: state.interaction.startSizePx,
        previewSizePx: state.interaction.previewSizePx,
      }
    case 'column-resize':
      if (state.interaction.previewSizePx === null) {
        return null
      }

      return {
        type: 'pointer.column-resize.commit',
        sheetId: state.interaction.sheetId,
        source: state.source,
        colIndex: state.interaction.colIndex,
        startSizePx: state.interaction.startSizePx,
        previewSizePx: state.interaction.previewSizePx,
      }
    default:
      return null
  }
}

export function commitPointerSessionState(
  state: PointerSessionState,
): PointerSessionState {
  if (state.status !== 'active') {
    return state
  }

  return clearPointerSessionState()
}

export function cancelPointerSessionState(
  state: PointerSessionState,
): PointerSessionState {
  if (state.status === 'idle' && state.interaction === null) {
    return state
  }

  return clearPointerSessionState()
}

export const pointerSessionAtom = atom<PointerSessionState>(createPointerSessionState())
pointerSessionAtom.debugLabel = 'spreadsheet.pointer.session'

export const pointerIntentAtom = atom<PointerIntent | null>(null)
pointerIntentAtom.debugLabel = 'spreadsheet.pointer.intent'

export const pointerIsActiveAtom = atom((get) => get(pointerSessionAtom).status === 'active')
pointerIsActiveAtom.debugLabel = 'spreadsheet.pointer.isActive'

export const startPointerAtom = atom(
  (get) => get(pointerSessionAtom),
  (get, set, input: PointerStartInput) => {
    set(pointerSessionAtom, startPointerSessionState(get(pointerSessionAtom), input))
    set(pointerIntentAtom, null)
  },
)
startPointerAtom.debugLabel = 'spreadsheet.pointer.start'

export const updatePointerAtom = atom(
  (get) => get(pointerSessionAtom),
  (get, set, input: PointerUpdateInput) => {
    set(pointerSessionAtom, updatePointerSessionState(get(pointerSessionAtom), input))
  },
)
updatePointerAtom.debugLabel = 'spreadsheet.pointer.update'

export const commitPointerAtom = atom(
  (get) => get(pointerSessionAtom),
  (get, set) => {
    const state = get(pointerSessionAtom)
    const intent = createPointerCommitIntent(state)
    if (intent === null) {
      return null
    }

    set(pointerIntentAtom, intent)
    set(pointerSessionAtom, commitPointerSessionState(state))
    return intent
  },
)
commitPointerAtom.debugLabel = 'spreadsheet.pointer.commit'

export const cancelPointerAtom = atom(
  (get) => get(pointerSessionAtom),
  (get, set) => {
    const state = get(pointerSessionAtom)
    if (state.status === 'idle' && state.interaction === null) {
      return null
    }

    set(pointerSessionAtom, cancelPointerSessionState(state))
    set(pointerIntentAtom, null)
    return null
  },
)
cancelPointerAtom.debugLabel = 'spreadsheet.pointer.cancel'
