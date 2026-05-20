/**
 * Caret-relative parse helpers for autocomplete + signature support.
 *
 * Both are pure string lookups — no atoms, no host bindings. The derived
 * atoms in `index.ts` call into these and feed the result into the
 * editing-session reactive graph.
 */

const NAME_HEAD = /[A-Za-z_]/
const NAME_REST = /[A-Za-z0-9_]/

/**
 * Locate the function-name fragment immediately to the left of the caret.
 *
 * The fragment is a run of `[A-Za-z_][A-Za-z0-9_]*` characters ending at
 * `caret - 1`. We return null when:
 *   - there's no fragment (caret sits on a delimiter or at index 0)
 *   - the character right after the fragment is `(` — that means the
 *     function already opened its paren and we should be in signature
 *     mode, not autocomplete
 *   - the character at the caret is a name-rest char (we are mid-name,
 *     do not autocomplete against a partial slice)
 *
 * The fragment is what the autocomplete suggestions UI matches against.
 */
export function findFunctionNameFragmentAtCaret(
  draft: string,
  caret: number,
): { start: number; end: number; text: string } | null {
  if (caret <= 0 || caret > draft.length) return null
  const end = caret
  const charAt = draft[end]
  if (charAt !== undefined && NAME_REST.test(charAt)) return null
  if (charAt === '(') return null

  let start = end
  while (start > 0 && NAME_REST.test(draft[start - 1])) start -= 1
  if (start === end) return null
  if (!NAME_HEAD.test(draft[start])) return null

  return { start, end, text: draft.slice(start, end) }
}

/**
 * Walk backwards from the caret, counting parens, to find the innermost
 * un-closed `(` and the function name that opened it. Returns the
 * function name (upper-cased), the index right after the `(`, and the
 * count of top-level commas between that paren and the caret (which
 * becomes the active arg index).
 *
 * Returns null when the caret is not inside any function call (e.g. the
 * draft is `=B2+` with caret at 4 — no open paren to the left).
 *
 * Skips contents inside double-quoted string literals so a comma inside
 * text doesn't bump the arg counter.
 */
export function findEnclosingFunctionCall(
  draft: string,
  caret: number,
): { name: string; openParen: number; activeArgIndex: number } | null {
  if (caret <= 0 || caret > draft.length) return null

  let depth = 0
  let commaCount = 0
  let inString = false
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = draft[i]
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === ')') {
      depth += 1
      continue
    }
    if (ch === '(') {
      if (depth === 0) {
        const nameEnd = i
        let nameStart = nameEnd
        while (nameStart > 0 && NAME_REST.test(draft[nameStart - 1])) nameStart -= 1
        if (nameStart === nameEnd) return null
        if (!NAME_HEAD.test(draft[nameStart])) return null
        const name = draft.slice(nameStart, nameEnd).toUpperCase()
        return { name, openParen: nameEnd + 1, activeArgIndex: commaCount }
      }
      depth -= 1
      continue
    }
    if (ch === ',' && depth === 0) {
      commaCount += 1
    }
  }
  return null
}
