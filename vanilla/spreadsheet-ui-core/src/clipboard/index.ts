import { atom } from '@einfach/core'
import type {
  ClipboardIntent,
  ClipboardOperation,
  ClipboardPayloadDescriptor,
  ClipboardPayloadInput,
  ClipboardState,
  ClipboardTargetDescriptor,
  ClipboardTransferInput,
  ClipboardTransferRequest,
} from './types'

export * from './types'

function copyRange(range: ClipboardTargetDescriptor['range']): ClipboardTargetDescriptor['range'] {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function rangeCellCount(range: ClipboardTargetDescriptor['range']): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) {
    return 0
  }

  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

export function createClipboardState(): ClipboardState {
  return {
    status: 'idle',
    intent: null,
    source: null,
    target: null,
    payload: null,
    error: null,
  }
}

export function createClipboardPayloadDescriptor(
  input: ClipboardPayloadInput,
): ClipboardPayloadDescriptor {
  const cellCount = rangeCellCount(input.source.range)

  return {
    kind: 'range',
    source: {
      sheetId: input.source.sheetId,
      range: copyRange(input.source.range),
    },
    serialization: input.serialization ?? 'tab-separated',
    cellCount,
    estimatedBytes: input.estimatedBytes ?? cellCount * 8,
    truncated: input.truncated ?? false,
    includesFormulas: input.includesFormulas ?? false,
    includesErrors: input.includesErrors ?? false,
  }
}

export function createClipboardTransferRequest(
  operation: ClipboardOperation,
  input: ClipboardTransferInput,
): ClipboardTransferRequest {
  return {
    operation,
    source: {
      sheetId: input.source.sheetId,
      range: copyRange(input.source.range),
    },
    payload: createClipboardPayloadDescriptor(input),
    target: input.target
      ? {
          sheetId: input.target.sheetId,
          range: copyRange(input.target.range),
        }
      : null,
    revision: input.revision ?? null,
  }
}

export function createClipboardIntent(
  operation: ClipboardOperation,
  input: ClipboardTransferInput,
): ClipboardIntent {
  return {
    type: `clipboard.${operation}` as ClipboardIntent['type'],
    request: createClipboardTransferRequest(operation, input),
  }
}

export function copyClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('copy', input)
  return {
    status: 'copying',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function cutClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('cut', input)
  return {
    status: 'cutting',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function pasteClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('paste', input)
  return {
    status: 'pasting',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function markClipboardReadyState(state: ClipboardState): ClipboardState {
  if (state.payload === null) {
    return state
  }

  return {
    ...state,
    status: 'ready',
  }
}

export function setClipboardErrorState(
  state: ClipboardState,
  error: ClipboardState['error'],
): ClipboardState {
  return {
    ...state,
    status: error === null ? 'idle' : 'error',
    error,
  }
}

export function clearClipboardState(): ClipboardState {
  return createClipboardState()
}

export const clipboardStateAtom = atom<ClipboardState>(createClipboardState())
clipboardStateAtom.debugLabel = 'spreadsheet.clipboard.state'

export const clipboardIntentAtom = atom<ClipboardIntent | null>(null)
clipboardIntentAtom.debugLabel = 'spreadsheet.clipboard.intent'

export const copyClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = copyClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
copyClipboardAtom.debugLabel = 'spreadsheet.clipboard.copy'

export const cutClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = cutClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
cutClipboardAtom.debugLabel = 'spreadsheet.clipboard.cut'

export const pasteClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = pasteClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
pasteClipboardAtom.debugLabel = 'spreadsheet.clipboard.paste'

export const clearClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (_get, set) => {
    set(clipboardStateAtom, clearClipboardState())
    set(clipboardIntentAtom, null)
  },
)
clearClipboardAtom.debugLabel = 'spreadsheet.clipboard.clear'

export const markClipboardReadyAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set) => {
    set(clipboardStateAtom, markClipboardReadyState(get(clipboardStateAtom)))
  },
)
markClipboardReadyAtom.debugLabel = 'spreadsheet.clipboard.ready'
