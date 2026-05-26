/**
 * Logical built-in functions (Wave C / track C2).
 *
 * Implements the v1 logical set: IF, IFERROR, IFNA, AND, OR, NOT, IFS,
 * SWITCH, TRUE, FALSE.
 *
 * Excel semantics notes:
 *
 *  - **IF(cond, then, else?)**: `cond` is coerced via `toBoolean`. `else`
 *    defaults to FALSE (Excel returns `FALSE`, not blank, when the else
 *    branch is missing). Error propagation **only** applies to `cond` —
 *    the chosen branch may itself be an error and is returned verbatim.
 *
 *  - **IFERROR(value, fallback)**: returns `value` unless `value.kind ===
 *    'error'`, in which case it returns `fallback`. Critically, **does
 *    not** propagate errors from the first argument (that's the whole
 *    point). It **does** propagate if `fallback` is an error and `value`
 *    was already an error.
 *
 *  - **IFNA(value, fallback)**: like IFERROR but only catches `#N/A`.
 *    Other errors pass through.
 *
 *  - **AND / OR**: variadic; each arg coerced via `toBoolean`. Blank
 *    args are ignored (Excel skips them). Empty → `#VALUE!`. Any error
 *    in any positional arg propagates.
 *
 *  - **NOT**: exactly one arg. Multiple args → `#VALUE!`. Propagates
 *    errors.
 *
 *  - **IFS(cond1, val1, cond2, val2, ...)**: returns the first val whose
 *    cond is TRUE. No match → `#N/A`. Odd arg count → `#N/A` (the dangling
 *    cond's "val" is missing). Errors in evaluated conds propagate; errors
 *    in unreached vals do **not**.
 *
 *  - **SWITCH(expr, case1, val1, case2, val2, ..., default?)**: matches
 *    `expr` (after coercion) against each case using Excel equality
 *    rules (numbers compared as numbers, strings case-insensitive). The
 *    last unpaired arg is the default. No match + no default → `#N/A`.
 *
 *  - **TRUE() / FALSE()**: zero-arg, return the constant boolean.
 *
 * Discipline: all impls are pure, total, never throw. Errors come back
 * as `{ kind: 'error', code: ... }` values.
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toBoolean } from '../coerce'

const TRUE_VALUE: Value = { kind: 'boolean', value: true }
const FALSE_VALUE: Value = { kind: 'boolean', value: false }
const ERR_VALUE: Value = { kind: 'error', code: '#VALUE!' }
const ERR_NA: Value = { kind: 'error', code: '#N/A' }

// =============================================================================
// IF
// =============================================================================

/**
 * `IF(cond, then, else?)`
 *
 * Only propagates errors from `cond`. The then/else branches may be
 * errors and are returned verbatim — that's how `=IF(FALSE, 1/0, "ok")`
 * yields `"ok"`.
 */
export const IF: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR_VALUE
  const cond = args[0]
  if (cond.kind === 'error') return cond
  const coerced = toBoolean(cond)
  if (!coerced.ok) return coerced.error
  if (coerced.value) return args[1]
  return args.length === 3 ? args[2] : FALSE_VALUE
}

// =============================================================================
// IFERROR
// =============================================================================

/**
 * `IFERROR(value, fallback)` — returns `fallback` if `value` is any
 * error; otherwise returns `value`. Does NOT propagate from `value`.
 */
export const IFERROR: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VALUE
  const value = args[0]
  if (value.kind === 'error') return args[1]
  return value
}

// =============================================================================
// IFNA
// =============================================================================

/**
 * `IFNA(value, fallback)` — returns `fallback` only if `value` is
 * `#N/A`. Other errors pass through.
 */
export const IFNA: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VALUE
  const value = args[0]
  if (value.kind === 'error' && value.code === '#N/A') return args[1]
  return value
}

// =============================================================================
// AND
// =============================================================================

/**
 * `AND(arg1, arg2, ...)` — all truthy → TRUE.
 *
 * Excel rules:
 *  - At least one non-blank arg required; all-blank or empty → `#VALUE!`.
 *  - Each arg coerced via `toBoolean`; coercion failure → propagate that error.
 *  - Errors in any positional arg propagate (first one wins).
 *
 * `array` args: top-left scalar is used (matches `toBoolean`'s behavior).
 */
export const AND: FunctionImpl = (args) => {
  if (args.length === 0) return ERR_VALUE
  const errFirst = propagateError(args)
  if (errFirst) return errFirst
  let sawAny = false
  for (const a of args) {
    if (a.kind === 'blank') continue
    sawAny = true
    const c = toBoolean(a)
    if (!c.ok) return c.error
    if (!c.value) return FALSE_VALUE
  }
  if (!sawAny) return ERR_VALUE
  return TRUE_VALUE
}

// =============================================================================
// OR
// =============================================================================

/**
 * `OR(arg1, arg2, ...)` — any truthy → TRUE.
 *
 * Same blank/empty/error rules as AND.
 */
export const OR: FunctionImpl = (args) => {
  if (args.length === 0) return ERR_VALUE
  const errFirst = propagateError(args)
  if (errFirst) return errFirst
  let sawAny = false
  for (const a of args) {
    if (a.kind === 'blank') continue
    sawAny = true
    const c = toBoolean(a)
    if (!c.ok) return c.error
    if (c.value) return TRUE_VALUE
  }
  if (!sawAny) return ERR_VALUE
  return FALSE_VALUE
}

// =============================================================================
// NOT
// =============================================================================

/**
 * `NOT(arg)` — single-arg only. Multiple args → `#VALUE!`.
 */
export const NOT: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VALUE
  const a = args[0]
  if (a.kind === 'error') return a
  const c = toBoolean(a)
  if (!c.ok) return c.error
  return c.value ? FALSE_VALUE : TRUE_VALUE
}

// =============================================================================
// IFS
// =============================================================================

/**
 * `IFS(cond1, val1, cond2, val2, ...)` — pairs of (cond, val).
 *
 * Returns the val whose cond is the first TRUE. No match → `#N/A`.
 *
 * Excel quirk: an odd arg count is technically a syntax error in Excel
 * itself, but when the engine evaluates a malformed IFS at runtime it
 * surfaces `#N/A` after exhausting the valid pairs (the dangling cond
 * without a val is treated as "no match"). We follow that behavior.
 *
 * Errors in evaluated conds propagate. Errors in *unreached* vals do
 * not — only the matched val is returned.
 */
export const IFS: FunctionImpl = (args) => {
  if (args.length === 0) return ERR_VALUE
  // Walk pairs; only inspect the cond + matched val (Excel doesn't
  // evaluate later vals — args here are already evaluated by the
  // dispatcher, so we just don't *return* unreached errors).
  const pairCount = Math.floor(args.length / 2)
  for (let i = 0; i < pairCount; i++) {
    const cond = args[i * 2]
    if (cond.kind === 'error') return cond
    const c = toBoolean(cond)
    if (!c.ok) return c.error
    if (c.value) return args[i * 2 + 1]
  }
  // No match (including the dangling-cond case).
  return ERR_NA
}

// =============================================================================
// SWITCH
// =============================================================================

/**
 * `SWITCH(expr, case1, val1, case2, val2, ..., default?)`.
 *
 * Matches `expr` against each case using Excel equality:
 *  - numbers compared by JS `===` after coercion
 *  - strings compared case-insensitively
 *  - booleans compared directly
 *  - blank vs blank → equal
 *  - error in `expr` or any inspected case propagates
 *  - if `args.length - 1` is odd (i.e., one trailing unpaired arg), that
 *    arg is the default; otherwise no default and no match → `#N/A`.
 */
export const SWITCH: FunctionImpl = (args) => {
  if (args.length < 3) return ERR_VALUE
  const expr = args[0]
  if (expr.kind === 'error') return expr
  const rest = args.length - 1
  const pairCount = Math.floor(rest / 2)
  const hasDefault = rest % 2 === 1
  for (let i = 0; i < pairCount; i++) {
    const caseVal = args[1 + i * 2]
    if (caseVal.kind === 'error') return caseVal
    if (excelEquals(expr, caseVal)) return args[1 + i * 2 + 1]
  }
  if (hasDefault) return args[args.length - 1]
  return ERR_NA
}

// =============================================================================
// TRUE / FALSE
// =============================================================================

/** Zero-arg constant. Extra args → `#VALUE!`. */
export const TRUE: FunctionImpl = (args) => {
  if (args.length !== 0) return ERR_VALUE
  return TRUE_VALUE
}

/** Zero-arg constant. Extra args → `#VALUE!`. */
export const FALSE: FunctionImpl = (args) => {
  if (args.length !== 0) return ERR_VALUE
  return FALSE_VALUE
}

// =============================================================================
// Equality helper (SWITCH)
// =============================================================================

/**
 * Excel-style equality used by SWITCH/MATCH. Distinct from the binary
 * `=` operator (which coerces numerically); SWITCH matches *exactly*
 * within each value-kind, except strings compare case-insensitively.
 *
 * Mixed-kind comparisons:
 *  - `blank` matches `blank` only (does not unify with 0 or "").
 *    Excel actually treats blank as 0 for arithmetic-equality, but
 *    SWITCH is a discriminator, not arithmetic — preserving blank as a
 *    distinct case is the more predictable choice and aligns with how
 *    Rust eval handles it (no implicit blank-to-0 inside SWITCH).
 *  - everything else: mismatched kinds → not equal.
 */
function excelEquals(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'blank':
      return true
    case 'number':
      return a.value === (b as { kind: 'number'; value: number }).value
    case 'boolean':
      return a.value === (b as { kind: 'boolean'; value: boolean }).value
    case 'string':
      return (
        a.value.toUpperCase() === (b as { kind: 'string'; value: string }).value.toUpperCase()
      )
    case 'error':
      // Same code → "equal" for matching purposes. (SWITCH never reaches
      // here in practice because we short-circuit on error args above.)
      return a.code === (b as { kind: 'error'; code: string }).code
    case 'array':
      return false
  }
}

// =============================================================================
// Registry
// =============================================================================

export const FUNCTIONS: Record<string, FunctionImpl> = {
  IF,
  IFERROR,
  IFNA,
  AND,
  OR,
  NOT,
  IFS,
  SWITCH,
  TRUE,
  FALSE,
}
