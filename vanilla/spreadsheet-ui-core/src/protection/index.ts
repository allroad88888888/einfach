import { atom } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
import { selectionAtom, getActiveCell, getSelectionRange } from '../selection'
import type {
  SheetProtectionBySheet,
  SheetProtectionState,
} from './types'

export * from './types'

export const MAX_UNLOCKED_RANGES = 256

export const DEFAULT_SHEET_PROTECTION: SheetProtectionState = {
  mode: 'open',
  unlockedRanges: [],
}

// --- pure helpers ---

export function getSheetProtection(
  state: SheetProtectionBySheet,
  sheetId: string,
): SheetProtectionState {
  return state[sheetId] ?? DEFAULT_SHEET_PROTECTION
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return (
    a.rowStart <= b.rowEnd &&
    a.rowEnd >= b.rowStart &&
    a.colStart <= b.colEnd &&
    a.colEnd >= b.colStart
  )
}

export function isCoordUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  coord: CellCoord,
): boolean {
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return true
  return protection.unlockedRanges.some(
    (r) =>
      coord.row >= r.rowStart &&
      coord.row <= r.rowEnd &&
      coord.col >= r.colStart &&
      coord.col <= r.colEnd,
  )
}

/** True when every cell in range is covered by the union of unlockedRanges.
 *  Caps range area at 10 000 cells; larger ranges return false (hard reject). */
export function isRangeFullyUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  range: CellRange,
): boolean {
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return true
  if (protection.unlockedRanges.length === 0) return false

  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  if (rows * cols > 10_000) return false

  for (let r = range.rowStart; r <= range.rowEnd; r++) {
    for (let c = range.colStart; c <= range.colEnd; c++) {
      const inAny = protection.unlockedRanges.some(
        (u) => r >= u.rowStart && r <= u.rowEnd && c >= u.colStart && c <= u.colEnd,
      )
      if (!inAny) return false
    }
  }
  return true
}

/** True when protected and the range has at least one unlocked cell AND at least one locked cell. */
export function isRangePartiallyUnlocked(
  state: SheetProtectionBySheet,
  sheetId: string,
  range: CellRange,
): boolean {
  const protection = getSheetProtection(state, sheetId)
  if (protection.mode === 'open') return false

  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  const cap = Math.min(rows * cols, 10_001)

  let hasUnlocked = false
  let hasLocked = false
  let count = 0

  outer: for (let r = range.rowStart; r <= range.rowEnd; r++) {
    for (let c = range.colStart; c <= range.colEnd; c++) {
      const unlocked = protection.unlockedRanges.some(
        (u) => r >= u.rowStart && r <= u.rowEnd && c >= u.colStart && c <= u.colEnd,
      )
      if (unlocked) hasUnlocked = true
      else hasLocked = true
      if (hasUnlocked && hasLocked) return true
      count++
      if (count >= cap) break outer
    }
  }
  return false
}

// --- source atom ---

export const sheetProtectionAtom = atom<SheetProtectionBySheet>({})
sheetProtectionAtom.debugLabel = 'spreadsheet.protection.state'

// --- command atoms ---

/** Stores protection state per sheet. Truncates unlockedRanges at MAX_UNLOCKED_RANGES.
 *  Contract: caller must not exceed MAX_UNLOCKED_RANGES; excess entries are silently dropped. */
export const setSheetProtectionAtom = atom(
  (get) => get(sheetProtectionAtom),
  (get, set, input: { sheetId: string; state: SheetProtectionState }) => {
    const prev = get(sheetProtectionAtom)
    const truncated =
      input.state.unlockedRanges.length > MAX_UNLOCKED_RANGES
        ? input.state.unlockedRanges.slice(0, MAX_UNLOCKED_RANGES)
        : input.state.unlockedRanges
    set(sheetProtectionAtom, {
      ...prev,
      [input.sheetId]: { mode: input.state.mode, unlockedRanges: truncated },
    })
  },
)
setSheetProtectionAtom.debugLabel = 'spreadsheet.protection.set'

export const clearSheetProtectionAtom = atom(
  (get) => get(sheetProtectionAtom),
  (get, set, sheetId: string) => {
    const prev = get(sheetProtectionAtom)
    const next = { ...prev }
    delete next[sheetId]
    set(sheetProtectionAtom, next)
  },
)
clearSheetProtectionAtom.debugLabel = 'spreadsheet.protection.clear'

// --- derived atoms ---

export const activeCellLockedAtom = atom((get): boolean => {
  const selection = get(selectionAtom)
  const protection = get(sheetProtectionAtom)
  const sheetId = selection.sheetId
  const sheet = getSheetProtection(protection, sheetId)
  if (sheet.mode === 'open') return false
  const coord = getActiveCell(selection)
  return !isCoordUnlocked(protection, sheetId, coord)
})
activeCellLockedAtom.debugLabel = 'spreadsheet.protection.activeCellLocked'

export const selectionLockedAtom = atom((get): 'open' | 'locked' | 'partial' => {
  const selection = get(selectionAtom)
  const protection = get(sheetProtectionAtom)
  const sheetId = selection.sheetId
  const sheet = getSheetProtection(protection, sheetId)
  if (sheet.mode === 'open') return 'open'
  const range = getSelectionRange(selection)
  if (isRangeFullyUnlocked(protection, sheetId, range)) return 'open'
  if (isRangePartiallyUnlocked(protection, sheetId, range)) return 'partial'
  return 'locked'
})
selectionLockedAtom.debugLabel = 'spreadsheet.protection.selectionLocked'

// --- unlock dialog UI state ---

export interface ProtectionUnlockTarget {
  sheetId: string
  range?: CellRange
}

export interface ProtectionUnlockState {
  isOpen: boolean
  target: ProtectionUnlockTarget | null
  pending: boolean
  error: string | null
}

export const DEFAULT_PROTECTION_UNLOCK_STATE: ProtectionUnlockState = {
  isOpen: false,
  target: null,
  pending: false,
  error: null,
}

export const protectionUnlockStateAtom = atom<ProtectionUnlockState>(
  DEFAULT_PROTECTION_UNLOCK_STATE,
)
protectionUnlockStateAtom.debugLabel = 'spreadsheet.protection.unlockState'

export const protectionUnlockOpenAtom = atom((get) => get(protectionUnlockStateAtom).isOpen)
protectionUnlockOpenAtom.debugLabel = 'spreadsheet.protection.unlockOpen'

export const openProtectionUnlockAtom = atom(
  null,
  (_get, set, target: ProtectionUnlockTarget) => {
    set(protectionUnlockStateAtom, {
      isOpen: true,
      target,
      pending: false,
      error: null,
    })
  },
)
openProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.openUnlock'

export const closeProtectionUnlockAtom = atom(null, (_get, set) => {
  set(protectionUnlockStateAtom, DEFAULT_PROTECTION_UNLOCK_STATE)
})
closeProtectionUnlockAtom.debugLabel = 'spreadsheet.protection.closeUnlock'

export const setProtectionUnlockPendingAtom = atom(
  null,
  (get, set, pending: boolean) => {
    const prev = get(protectionUnlockStateAtom)
    set(protectionUnlockStateAtom, { ...prev, pending, error: pending ? null : prev.error })
  },
)
setProtectionUnlockPendingAtom.debugLabel = 'spreadsheet.protection.setUnlockPending'

export const setProtectionUnlockErrorAtom = atom(
  null,
  (get, set, error: string | null) => {
    const prev = get(protectionUnlockStateAtom)
    set(protectionUnlockStateAtom, { ...prev, error, pending: false })
  },
)
setProtectionUnlockErrorAtom.debugLabel = 'spreadsheet.protection.setUnlockError'
