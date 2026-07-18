import { atom } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
import {
  nameRegistryCacheAtom,
  normalizeNamedRangeName,
  runNamedRangeMutationAtom,
  type NamedRange,
} from '../named-ranges'
import {
  EXCEL_MAX_COLS,
  EXCEL_MAX_ROWS,
  primarySelectionRegionAtom,
  selectionSnapshotAtom,
  setSelectionAtom,
  selectCellAtom,
} from '../selection'
import type {
  NameBoxCommitInput,
  NameBoxCommitTarget,
  NameBoxMode,
  NameBoxSessionInput,
  UpdateNameBoxInput,
} from './types'

export * from './types'

const COLUMN_LABEL_PATTERN = /^([A-Za-z]+)(\d+)$/

export const nameBoxInputAtom = atom<string>('')
nameBoxInputAtom.debugLabel = 'spreadsheet.nameBox.input'

export const nameBoxModeAtom = atom<NameBoxMode>('idle')
nameBoxModeAtom.debugLabel = 'spreadsheet.nameBox.mode'

export const nameBoxErrorAtom = atom<boolean>(false)
nameBoxErrorAtom.debugLabel = 'spreadsheet.nameBox.error'

export const nameBoxFocusedAtom = atom<boolean>(false)
nameBoxFocusedAtom.debugLabel = 'spreadsheet.nameBox.focused'

export const nameBoxLastCommittedAtom = atom<string>('')
nameBoxLastCommittedAtom.debugLabel = 'spreadsheet.nameBox.lastCommitted'

export const nameBoxSessionIdAtom = atom<number>(0)
nameBoxSessionIdAtom.debugLabel = 'spreadsheet.nameBox.sessionId'

function columnLabelToIndex(letters: string): number {
  if (letters.length === 0) return -1
  let col = 0
  for (let index = 0; index < letters.length; index += 1) {
    const code = letters.toUpperCase().charCodeAt(index) - 64
    if (code < 1 || code > 26) return -1
    col = col * 26 + code
  }
  return col - 1
}

function indexToColumnLabel(col: number): string {
  let current = col
  let label = ''
  do {
    label = String.fromCharCode(65 + (current % 26)) + label
    current = Math.floor(current / 26) - 1
  } while (current >= 0)
  return label
}

export function coordToA1(coord: CellCoord): string {
  return `${indexToColumnLabel(coord.col)}${coord.row + 1}`
}

export function rangeToA1(range: CellRange): string {
  if (range.rowStart === range.rowEnd && range.colStart === range.colEnd) {
    return coordToA1({ row: range.rowStart, col: range.colStart })
  }
  const start = coordToA1({ row: range.rowStart, col: range.colStart })
  const end = coordToA1({ row: range.rowEnd, col: range.colEnd })
  return `${start}:${end}`
}

export function parseA1Cell(input: string): CellCoord | null {
  const match = COLUMN_LABEL_PATTERN.exec(input.trim())
  if (!match) return null
  const col = columnLabelToIndex(match[1])
  const rowOneBased = Number(match[2])
  if (col < 0 || col >= EXCEL_MAX_COLS) return null
  if (!Number.isInteger(rowOneBased) || rowOneBased < 1 || rowOneBased > EXCEL_MAX_ROWS) {
    return null
  }
  return { row: rowOneBased - 1, col }
}

export function parseA1Range(input: string): CellRange | null {
  const trimmed = input.trim()
  const colonIndex = trimmed.indexOf(':')
  if (colonIndex < 0) return null
  const start = parseA1Cell(trimmed.slice(0, colonIndex))
  const end = parseA1Cell(trimmed.slice(colonIndex + 1))
  if (!start || !end) return null
  return {
    rowStart: Math.min(start.row, end.row),
    rowEnd: Math.max(start.row, end.row),
    colStart: Math.min(start.col, end.col),
    colEnd: Math.max(start.col, end.col),
  }
}

export function isValidName(input: string): boolean {
  const normalized = normalizeNamedRangeName(input)
  if (normalized === null) return false
  // Reserve A1-style addresses — they would parse as cell refs instead.
  if (COLUMN_LABEL_PATTERN.test(normalized)) return false
  return true
}

function refersToCoord(refersTo: NamedRange['refersTo']): {
  sheetId: string
  range?: CellRange
  coord?: CellCoord
} | null {
  if (refersTo.kind !== 'range') return null
  const range = parseA1Range(refersTo.address)
  if (range) {
    return { sheetId: refersTo.sheetId, range }
  }
  const coord = parseA1Cell(refersTo.address)
  if (coord) {
    return { sheetId: refersTo.sheetId, coord }
  }
  return null
}

export function findNamedRange(
  registry: readonly NamedRange[],
  name: string,
  currentSheetId?: string,
): NamedRange | undefined {
  const lookup = name.trim()
  if (lookup.length === 0) return undefined
  const lower = lookup.toLowerCase()
  const matches = registry.filter((entry) => entry.name.toLowerCase() === lower)
  if (currentSheetId !== undefined) {
    const currentSheetMatch = matches.find(
      (entry) => entry.scope !== 'workbook' && entry.scope.sheetId === currentSheetId,
    )
    if (currentSheetMatch) return currentSheetMatch
    return matches.find((entry) => entry.scope === 'workbook')
  }
  // Legacy callers without sheet context retain their prior first-match behavior.
  return matches[0]
}

/**
 * Derived display. Returns the registered name when the primary selection range
 * matches a defined name, otherwise the A1 address of the active cell (or the
 * primary range, when the user has a multi-cell region).
 */
export const nameBoxDisplayAtom = atom((get): string => {
  const snapshot = get(selectionSnapshotAtom)
  const registry = get(nameRegistryCacheAtom)
  const sheetId = snapshot.selection.sheetId
  const rangeAddress = rangeToA1(snapshot.range)

  if (rangeAddress.length > 0 && registry.length > 0) {
    const matches = registry.filter((entry) => {
      if (entry.refersTo.kind !== 'range') return false
      if (entry.refersTo.sheetId !== sheetId) return false
      if (entry.scope !== 'workbook' && entry.scope.sheetId !== sheetId) {
        return false
      }
      return entry.refersTo.address.toUpperCase() === rangeAddress.toUpperCase()
    })
    const match =
      matches.find((entry) => entry.scope !== 'workbook' && entry.scope.sheetId === sheetId) ??
      matches.find((entry) => entry.scope === 'workbook')
    if (match) return match.name
  }

  if (
    snapshot.range.rowStart === snapshot.range.rowEnd &&
    snapshot.range.colStart === snapshot.range.colEnd
  ) {
    return coordToA1(snapshot.activeCell)
  }
  return rangeAddress
})
nameBoxDisplayAtom.debugLabel = 'spreadsheet.nameBox.display'

/**
 * Parse the input into a discriminated commit target. Pure: no side effects.
 */
export function classifyNameBoxInput(
  raw: string,
  registry: readonly NamedRange[],
  context: { sheetId: string; selectionRange: CellRange },
): NameBoxCommitTarget {
  const value = raw.trim()
  if (value.length === 0) {
    return { kind: 'invalid', reason: 'empty' }
  }

  const cell = parseA1Cell(value)
  if (cell) {
    return { kind: 'cell', sheetId: context.sheetId, coord: cell }
  }

  const range = parseA1Range(value)
  if (range) {
    return { kind: 'range', sheetId: context.sheetId, range }
  }

  const named = findNamedRange(registry, value, context.sheetId)
  if (named) {
    const target = refersToCoord(named.refersTo)
    if (target) {
      return {
        kind: 'named-range',
        sheetId: target.sheetId,
        name: named.name,
        range: target.range,
        coord: target.coord,
      }
    }
    return { kind: 'invalid', reason: 'named-range-not-resolvable' }
  }

  if (isValidName(value)) {
    return {
      kind: 'define-name',
      sheetId: context.sheetId,
      name: value,
      range: context.selectionRange,
    }
  }

  return { kind: 'invalid', reason: 'unrecognized' }
}

/**
 * Command atom. Classifies the input via {@link classifyNameBoxInput} and
 * dispatches the matching selection mutation. A new name enters the shared
 * named-range mutation command; the framework layer never calls the port.
 */
export const commitNameBoxAtom = atom(
  null,
  (get, set, input: NameBoxCommitInput): NameBoxCommitTarget => {
    const currentSessionId = get(nameBoxSessionIdAtom)
    if (input.sessionId !== undefined && input.sessionId !== currentSessionId) {
      return { kind: 'invalid', reason: 'stale-session' }
    }
    set(nameBoxModeAtom, 'committing')
    const snapshot = get(selectionSnapshotAtom)
    const registry = get(nameRegistryCacheAtom)
    const sheetId = input.sheetId ?? snapshot.selection.sheetId
    const target = classifyNameBoxInput(input.input, registry, {
      sheetId,
      selectionRange: snapshot.range,
    })

    switch (target.kind) {
      case 'cell': {
        set(selectCellAtom, { sheetId: target.sheetId, coord: target.coord })
        set(nameBoxErrorAtom, false)
        set(nameBoxModeAtom, 'idle')
        return target
      }
      case 'range': {
        set(setSelectionAtom, {
          kind: 'range',
          sheetId: target.sheetId,
          anchor: { row: target.range.rowStart, col: target.range.colStart },
          focus: { row: target.range.rowEnd, col: target.range.colEnd },
        })
        set(nameBoxErrorAtom, false)
        set(nameBoxModeAtom, 'idle')
        return target
      }
      case 'named-range': {
        if (target.range) {
          set(setSelectionAtom, {
            kind: 'range',
            sheetId: target.sheetId,
            anchor: { row: target.range.rowStart, col: target.range.colStart },
            focus: { row: target.range.rowEnd, col: target.range.colEnd },
          })
        } else if (target.coord) {
          set(selectCellAtom, { sheetId: target.sheetId, coord: target.coord })
        }
        set(nameBoxErrorAtom, false)
        set(nameBoxModeAtom, 'idle')
        return target
      }
      case 'define-name': {
        if (input.source) {
          void set(runNamedRangeMutationAtom, {
            source: input.source,
            origin: 'name-box',
            sessionId: currentSessionId,
            mutation: {
              action: 'set',
              name: target.name,
              scope: 'workbook',
              refersTo: {
                kind: 'range',
                sheetId: target.sheetId,
                address: rangeToA1(target.range),
              },
            },
          })
        }
        set(nameBoxErrorAtom, input.source === undefined)
        set(nameBoxModeAtom, 'idle')
        return target
      }
      case 'invalid':
      default: {
        set(nameBoxErrorAtom, true)
        set(nameBoxInputAtom, get(nameBoxDisplayAtom))
        set(nameBoxModeAtom, 'idle')
        return target
      }
    }
  },
)
commitNameBoxAtom.debugLabel = 'spreadsheet.nameBox.commit'

/** Starts a new edit session and snapshots the canonical display. */
export const focusNameBoxAtom = atom(null, (get, set): number => {
  const current = get(nameBoxSessionIdAtom)
  const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
  const display = get(nameBoxDisplayAtom)
  set(nameBoxSessionIdAtom, next)
  set(nameBoxFocusedAtom, true)
  set(nameBoxLastCommittedAtom, display)
  set(nameBoxInputAtom, display)
  set(nameBoxErrorAtom, false)
  set(nameBoxModeAtom, 'typing')
  return next
})
focusNameBoxAtom.debugLabel = 'spreadsheet.nameBox.focus'

/** Updates input only when the originating edit session is still active. */
export const updateNameBoxInputAtom = atom(null, (get, set, input: UpdateNameBoxInput): boolean => {
  if (input.sessionId !== undefined && input.sessionId !== get(nameBoxSessionIdAtom)) {
    return false
  }
  set(nameBoxInputAtom, input.input)
  set(nameBoxErrorAtom, false)
  set(nameBoxModeAtom, 'typing')
  return true
})
updateNameBoxInputAtom.debugLabel = 'spreadsheet.nameBox.updateInput'

/** Records the DOM blur without committing or replaying an older session. */
export const blurNameBoxAtom = atom(null, (get, set, input?: NameBoxSessionInput): boolean => {
  if (input?.sessionId !== undefined && input.sessionId !== get(nameBoxSessionIdAtom)) {
    return false
  }
  set(nameBoxFocusedAtom, false)
  set(nameBoxModeAtom, 'idle')
  return true
})
blurNameBoxAtom.debugLabel = 'spreadsheet.nameBox.blur'

/** Resets the input to the current display and clears any error flash. */
export const revertNameBoxAtom = atom(null, (get, set, input?: NameBoxSessionInput): boolean => {
  if (input?.sessionId !== undefined && input.sessionId !== get(nameBoxSessionIdAtom)) {
    return false
  }
  const display = get(nameBoxDisplayAtom)
  set(nameBoxInputAtom, display)
  set(nameBoxLastCommittedAtom, display)
  set(nameBoxErrorAtom, false)
  set(nameBoxModeAtom, 'idle')
  return true
})
revertNameBoxAtom.debugLabel = 'spreadsheet.nameBox.revert'

/** Convenience getter exposed for tests / debug surfaces. */
export const nameBoxStateAtom = atom((get) => ({
  input: get(nameBoxInputAtom),
  mode: get(nameBoxModeAtom),
  display: get(nameBoxDisplayAtom),
  error: get(nameBoxErrorAtom),
  focused: get(nameBoxFocusedAtom),
  lastCommitted: get(nameBoxLastCommittedAtom),
  sessionId: get(nameBoxSessionIdAtom),
  primaryRegion: get(primarySelectionRegionAtom),
}))
nameBoxStateAtom.debugLabel = 'spreadsheet.nameBox.state'
