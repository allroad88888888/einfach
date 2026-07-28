/**
 * Public parser entry point.
 *
 * `parseFormula(text)` is **total** — it never throws. Any unrecoverable
 * tokenizer or parser error is collapsed into an `ErrorLiteral` AST node so
 * the evaluator can surface the same error code the user would expect from
 * Excel.
 *
 * Mapping:
 *   - empty / whitespace-only input    → `{ kind: 'error', code: '#NAME?' }`
 *   - tokenizer error                  → `{ kind: 'error', code: '#VALUE!' }`
 *   - structural parser error          → `{ kind: 'error', code: '#VALUE!' }`
 *
 * The leading `=` is optional. Callers can pass either the raw user input
 * (`=A1+1`) or the body (`A1+1`).
 */

import type { Expr } from '../types'
import { tokenize } from './tokenizer'
import { ParseError, parseTokens } from './parser'

export { tokenize } from './tokenizer'
export { parseTokens, ParseError } from './parser'
export type { Token, OpLexeme } from './tokenizer'

export function parseFormula(text: string): Expr {
  if (typeof text !== 'string') {
    return { kind: 'error', code: '#VALUE!' }
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { kind: 'error', code: '#NAME?' }
  }
  const body = trimmed.startsWith('=') ? trimmed.slice(1) : trimmed
  if (body.trim().length === 0) {
    return { kind: 'error', code: '#NAME?' }
  }
  try {
    const tokens = tokenize(body)
    return parseTokens(tokens)
  } catch (err) {
    if (err instanceof ParseError) {
      return { kind: 'error', code: '#VALUE!' }
    }
    return { kind: 'error', code: '#VALUE!' }
  }
}
