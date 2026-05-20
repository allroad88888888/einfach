import { atom } from '@einfach/core'
import { editingDraftAtom, editingSessionAtom } from '../editing'
import { formulaReferenceCaretAtom } from '../formula-reference'
import {
  FORMULA_FUNCTION_SPECS,
  getFormulaFunctionSpec,
  renderFormulaFunctionSignature,
} from './registry'
import { findEnclosingFunctionCall, findFunctionNameFragmentAtCaret } from './parse'
import type {
  FormulaFunctionSignatureState,
  FormulaFunctionSpec,
  FormulaFunctionSuggestion,
} from './types'

export * from './registry'
export * from './parse'
export * from './types'

/** Max rows to surface in the dropdown — keeps the UI compact. */
const SUGGESTION_LIMIT = 8

function rankSuggestions(
  fragment: string,
  specs: readonly FormulaFunctionSpec[],
): FormulaFunctionSpec[] {
  const upper = fragment.toUpperCase()
  const startsWith: FormulaFunctionSpec[] = []
  const contains: FormulaFunctionSpec[] = []
  for (const spec of specs) {
    if (spec.name === upper) {
      // Exact match goes first; user is probably about to hit `(`.
      startsWith.unshift(spec)
      continue
    }
    if (spec.name.startsWith(upper)) {
      startsWith.push(spec)
      continue
    }
    if (spec.name.includes(upper)) {
      contains.push(spec)
    }
  }
  return [...startsWith, ...contains].slice(0, SUGGESTION_LIMIT)
}

/**
 * Autocomplete suggestions derived from the editing draft + the live caret
 * tracked in `formulaReferenceCaretAtom`. Returns empty when:
 *   - editing is not drafting
 *   - draft doesn't start with '='
 *   - caret has no function-name fragment to its immediate left
 *   - the fragment has no matching specs
 *
 * The host renders this as a dropdown anchored to the active input.
 */
export const formulaFunctionSuggestionsAtom = atom<FormulaFunctionSuggestion[]>((get) => {
  const session = get(editingSessionAtom)
  if (session.status !== 'drafting') return []
  const draft = get(editingDraftAtom)
  if (!draft.startsWith('=')) return []
  const caret = get(formulaReferenceCaretAtom)
  if (caret < 0) return []
  const fragment = findFunctionNameFragmentAtCaret(draft, caret)
  if (!fragment) return []
  const matches = rankSuggestions(fragment.text, FORMULA_FUNCTION_SPECS)
  return matches.map((spec) => ({
    spec,
    fragmentStart: fragment.start,
    fragmentEnd: fragment.end,
    fragment: fragment.text.toUpperCase(),
  }))
})
formulaFunctionSuggestionsAtom.debugLabel = 'spreadsheet.formulaFunctions.suggestions'

/**
 * Signature state for the caret: when the caret sits inside a known
 * function's open paren, returns the spec + the active arg index. Null
 * otherwise. Used to render the signature tooltip below the input.
 */
export const formulaFunctionSignatureAtom = atom<FormulaFunctionSignatureState | null>(
  (get) => {
    const session = get(editingSessionAtom)
    if (session.status !== 'drafting') return null
    const draft = get(editingDraftAtom)
    if (!draft.startsWith('=')) return null
    const caret = get(formulaReferenceCaretAtom)
    if (caret < 0) return null
    const enclosing = findEnclosingFunctionCall(draft, caret)
    if (!enclosing) return null
    const spec = getFormulaFunctionSpec(enclosing.name)
    if (!spec) return null
    const lastIndex = spec.args.length - 1
    const activeArgIndex = Math.min(enclosing.activeArgIndex, lastIndex)
    return { spec, activeArgIndex }
  },
)
formulaFunctionSignatureAtom.debugLabel = 'spreadsheet.formulaFunctions.signature'

/**
 * Currently-selected suggestion index. Keyboard ArrowUp/Down move it;
 * pointer hover sets it; accepting the suggestion (Tab/Enter) reads it.
 * Reset to 0 whenever the suggestions list changes shape.
 */
export const formulaFunctionSuggestionCursorAtom = atom<number>(0)
formulaFunctionSuggestionCursorAtom.debugLabel = 'spreadsheet.formulaFunctions.cursor'

/**
 * Convenience derived atom — `true` when at least one suggestion exists.
 * Hosts use it to decide whether to intercept ArrowUp/Down/Tab/Enter.
 */
export const formulaFunctionSuggestionsActiveAtom = atom(
  (get) => get(formulaFunctionSuggestionsAtom).length > 0,
)
formulaFunctionSuggestionsActiveAtom.debugLabel =
  'spreadsheet.formulaFunctions.suggestionsActive'

/**
 * Per-arg signature rendering. Returns each argument slot with an
 * `active` flag so the UI can wrap the active arg in `<strong>` (or
 * equivalent) without parsing sentinel markers out of a string.
 */
export interface RenderedSignatureSlot {
  text: string
  active: boolean
}

export function renderActiveSignatureSlots(
  state: FormulaFunctionSignatureState,
): RenderedSignatureSlot[] {
  return state.spec.args.map((arg, i) => {
    const tail = arg.repeats ? `${arg.name}, ...` : arg.name
    const slot = arg.optional ? `[${tail}]` : tail
    return { text: slot, active: i === state.activeArgIndex }
  })
}

/** Re-export the plain renderer for tests / fallback rendering. */
export { renderFormulaFunctionSignature }
