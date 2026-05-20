import { atom } from '@einfach/core'
import type { CellCoord } from '../shared'
import { editingDraftAtom, editingSessionAtom } from '../editing'
import { keyboardModeAtom } from '../keyboard'
import { parseFormulaReferences } from './parser'
import type {
  EnterFormulaReferenceInput,
  FormulaReferenceExitReason,
  FormulaReferencePickInput,
  FormulaReferenceSession,
  FormulaReferenceTokenRange,
} from './types'

export * from './parser'
export * from './types'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function indexToColumnLabel(col: number): string {
  let current = col
  let label = ''

  do {
    label = String.fromCharCode(65 + (current % 26)) + label
    current = Math.floor(current / 26) - 1
  } while (current >= 0)

  return label
}

export function serializeCellRef(coord: CellCoord): string {
  return `${indexToColumnLabel(coord.col)}${coord.row + 1}`
}

export function serializeRangeRef(anchor: CellCoord, focus: CellCoord): string {
  const rowStart = Math.min(anchor.row, focus.row)
  const rowEnd = Math.max(anchor.row, focus.row)
  const colStart = Math.min(anchor.col, focus.col)
  const colEnd = Math.max(anchor.col, focus.col)

  const topLeft: CellCoord = { row: rowStart, col: colStart }
  const bottomRight: CellCoord = { row: rowEnd, col: colEnd }

  if (rowStart === rowEnd && colStart === colEnd) {
    return serializeCellRef(topLeft)
  }

  return `${serializeCellRef(topLeft)}:${serializeCellRef(bottomRight)}`
}

export function spliceDraft(
  draft: string,
  tokenRange: FormulaReferenceTokenRange | null,
  insertionCaret: number,
  token: string,
): { draft: string; end: number } {
  if (tokenRange === null) {
    const before = draft.slice(0, insertionCaret)
    const after = draft.slice(insertionCaret)
    const next = before + token + after
    return { draft: next, end: insertionCaret + token.length }
  }

  const before = draft.slice(0, tokenRange.start)
  const after = draft.slice(tokenRange.end)
  const next = before + token + after
  return { draft: next, end: tokenRange.start + token.length }
}

const TRIGGER_CHARS = new Set(['=', '+', '-', '*', '/', '^', '&', '(', ',', '<', '>', '%'])

export function shouldEnterFormulaReferenceMode(draft: string, caret: number): boolean {
  if (caret === 0) return false

  const charBefore = draft[caret - 1]
  if (!TRIGGER_CHARS.has(charBefore)) return false

  const charAt = draft[caret]
  if (charAt !== undefined && charAt !== ')') return false

  return true
}

// ---------------------------------------------------------------------------
// Source atoms
// ---------------------------------------------------------------------------

export const formulaReferenceSessionAtom = atom<FormulaReferenceSession | null>(null)
formulaReferenceSessionAtom.debugLabel = 'spreadsheet.formulaReference.session'

export const formulaReferenceCaretAtom = atom<number>(-1)
formulaReferenceCaretAtom.debugLabel = 'spreadsheet.formulaReference.caret'

// ---------------------------------------------------------------------------
// Derived atoms
// ---------------------------------------------------------------------------

export const formulaReferenceActiveAtom = atom(
  (get) => get(formulaReferenceSessionAtom) !== null,
)
formulaReferenceActiveAtom.debugLabel = 'spreadsheet.formulaReference.active'

export const formulaReferenceTokenRangeAtom = atom(
  (get) => get(formulaReferenceSessionAtom)?.tokenRange ?? null,
)
formulaReferenceTokenRangeAtom.debugLabel = 'spreadsheet.formulaReference.tokenRange'

/**
 * Parsed reference tokens for the current editing draft. Returns an empty
 * array when not drafting or when the draft does not start with '='. Hosts
 * subscribe to this to paint colored frames in the grid overlay.
 */
export const formulaReferenceTokensAtom = atom((get) => {
  const session = get(editingSessionAtom)
  if (session.status !== 'drafting') return []
  const draft = get(editingDraftAtom)
  if (!draft.startsWith('=')) return []
  return parseFormulaReferences(draft, session.source?.sheetId ?? null)
})
formulaReferenceTokensAtom.debugLabel = 'spreadsheet.formulaReference.tokens'

// ---------------------------------------------------------------------------
// Command atoms
// ---------------------------------------------------------------------------

export const enterFormulaReferenceAtom = atom(
  null,
  (_get, set, input: EnterFormulaReferenceInput) => {
    set(formulaReferenceSessionAtom, {
      anchorCell: { row: input.anchorCell.row, col: input.anchorCell.col },
      sheetId: input.sheetId,
      insertionCaret: input.insertionCaret,
      tokenRange: null,
      dragging: false,
    })
    set(keyboardModeAtom, 'formula-reference')
  },
)
enterFormulaReferenceAtom.debugLabel = 'spreadsheet.formulaReference.enter'

export const pickFormulaReferenceAtom = atom(
  null,
  (get, set, input: FormulaReferencePickInput) => {
    const session = get(formulaReferenceSessionAtom)
    if (session === null) return

    const token = serializeRangeRef(input.pickAnchor, input.pickFocus)
    const currentDraft = get(editingSessionAtom).draft
    const spliced = spliceDraft(currentDraft, session.tokenRange, session.insertionCaret, token)

    set(editingDraftAtom, { draft: spliced.draft })

    set(formulaReferenceSessionAtom, {
      ...session,
      tokenRange: { start: session.tokenRange?.start ?? session.insertionCaret, end: spliced.end },
      dragging: input.dragging,
    })
  },
)
pickFormulaReferenceAtom.debugLabel = 'spreadsheet.formulaReference.pick'

export const exitFormulaReferenceAtom = atom(
  null,
  (get, set, _reason: FormulaReferenceExitReason) => {
    set(formulaReferenceSessionAtom, null)
    // Restore the keyboard mode to whichever phase logically follows: if an
    // editing session is still active, fall back to 'editing'; otherwise
    // 'navigation'. Callers committing/cancelling editing flip the mode
    // themselves so the explicit reset here only handles operator/paren exits.
    const editing = get(editingSessionAtom)
    set(keyboardModeAtom, editing.status === 'drafting' ? 'editing' : 'navigation')
  },
)
exitFormulaReferenceAtom.debugLabel = 'spreadsheet.formulaReference.exit'
