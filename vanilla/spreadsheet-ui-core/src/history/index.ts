import { atom } from '@einfach/core'
import type { HistoryEntry, HistoryResolveResult, HistoryStackState } from './types'

export * from './types'

export const DEFAULT_HISTORY_CAP = 100

const DEFAULT_HISTORY_STACK_STATE: HistoryStackState = {
  entries: [],
  cursor: 0,
  inFlight: false,
}

export const historyStackAtom = atom<HistoryStackState>(DEFAULT_HISTORY_STACK_STATE)
historyStackAtom.debugLabel = 'spreadsheet.history.stack'

export const historyInFlightAtom = atom((get) => get(historyStackAtom).inFlight)
historyInFlightAtom.debugLabel = 'spreadsheet.history.inFlight'

export const canUndoAtom = atom((get) => {
  const { entries, cursor, inFlight } = get(historyStackAtom)
  return entries.length > 0 && cursor > 0 && !inFlight
})
canUndoAtom.debugLabel = 'spreadsheet.history.canUndo'

export const canRedoAtom = atom((get) => {
  const { entries, cursor, inFlight } = get(historyStackAtom)
  return cursor < entries.length && !inFlight
})
canRedoAtom.debugLabel = 'spreadsheet.history.canRedo'

export const pushHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set, entry: HistoryEntry): void => {
    const state = get(historyStackAtom)
    // Truncate redo tail then append
    const base = state.entries.slice(0, state.cursor)
    const next = [...base, entry]
    // Evict oldest when over cap
    const capped = next.length > DEFAULT_HISTORY_CAP ? next.slice(next.length - DEFAULT_HISTORY_CAP) : next
    set(historyStackAtom, {
      entries: capped,
      cursor: capped.length,
      inFlight: false,
    })
  },
)
pushHistoryAtom.debugLabel = 'spreadsheet.history.pushEntry'

export const undoHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set): HistoryEntry | null => {
    const state = get(historyStackAtom)
    if (state.inFlight || state.cursor === 0 || state.entries.length === 0) return null
    const entry = state.entries[state.cursor - 1]
    set(historyStackAtom, { ...state, cursor: state.cursor - 1, inFlight: true })
    return entry
  },
)
undoHistoryAtom.debugLabel = 'spreadsheet.history.undo'

export const redoHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set): HistoryEntry | null => {
    const state = get(historyStackAtom)
    if (state.inFlight || state.cursor >= state.entries.length) return null
    const entry = state.entries[state.cursor]
    set(historyStackAtom, { ...state, cursor: state.cursor + 1, inFlight: true })
    return entry
  },
)
redoHistoryAtom.debugLabel = 'spreadsheet.history.redo'

export const resolveHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (get, set, result: HistoryResolveResult): void => {
    const state = get(historyStackAtom)
    if (!state.inFlight) return

    if (result.ok) {
      set(historyStackAtom, { ...state, inFlight: false })
    } else {
      // Revert cursor: failed undo moves cursor back up, failed redo moves cursor back down.
      // We don't know direction here; clear the whole stack to avoid corrupted cursor state.
      set(historyStackAtom, DEFAULT_HISTORY_STACK_STATE)
    }
  },
)
resolveHistoryAtom.debugLabel = 'spreadsheet.history.resolve'

export const clearHistoryAtom = atom(
  (get) => get(historyStackAtom),
  (_get, set): void => {
    set(historyStackAtom, DEFAULT_HISTORY_STACK_STATE)
  },
)
clearHistoryAtom.debugLabel = 'spreadsheet.history.clear'
