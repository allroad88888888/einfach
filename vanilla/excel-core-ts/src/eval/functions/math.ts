/**
 * Wave C / C1 — math built-in functions.
 *
 * Implements the Phase-3 v1 math set from `docs/PLAN.md §6.1`:
 * SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN,
 * INT, MOD, ABS, POWER, SQRT, SIGN.
 *
 * Discipline (from `docs/AGENT_COLLABORATION.md` Wave C):
 *  - Pure: never mutate args/ctx/captured state.
 *  - Total: every input returns a Value (errors are encoded, not thrown).
 *  - Coerce only via `../coerce`; never re-derive number/boolean casts.
 *  - First-error-wins: a positional `kind: 'error'` arg is returned
 *    verbatim by every function in this file. (Excel's IFERROR / IFNA
 *    families opt out — they live in `logical.ts`.)
 *
 * Excel aggregation semantics (the only really subtle part of this file):
 *
 *  - When an argument is *passed directly* (a scalar literal or a single
 *    cell ref the dispatcher pre-resolved into a scalar `Value`), Excel
 *    **coerces** it: `SUM("5", 3)` → 8, `SUM(TRUE, 1)` → 2.
 *    Non-coercible scalars are `#VALUE!`.
 *
 *  - When an argument is an *array / range* (Value with `kind: 'array'`),
 *    Excel **ignores** anything that isn't a number — strings,
 *    booleans, and blanks are skipped silently. Errors in array cells
 *    still propagate as the function's result (first error wins).
 *
 *  This split matters: `SUM(A1:A3)` over `[1, "x", 3]` is 4, while
 *  `SUM(1, "x", 3)` is `#VALUE!`. The helpers `forEachNumericArg` and
 *  `forEachCountArg` below encode the split exactly.
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber } from '../coerce'

const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!', message?: string): Value =>
  message === undefined ? { kind: 'error', code } : { kind: 'error', code, message }

const NUM = (value: number): Value => ({ kind: 'number', value })

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Result of walking an aggregation argument list. Either an error
 * (propagated verbatim) or the visitor finished cleanly.
 */
type WalkResult = { ok: true } | { ok: false; error: Value & { kind: 'error' } }

/**
 * Iterate every numeric value reachable from `args`, applying Excel's
 * scalar-vs-array coercion rules:
 *  - scalar arg: must coerce to number via `toNumber`; if not, return
 *    the coerce error.
 *  - array arg: walk every cell; numbers count, strings/booleans/blanks
 *    are skipped; errors propagate.
 *
 * `visit` is called for each emitted numeric. Returning early on the
 * first error mirrors Excel's "first error wins" rule.
 */
function forEachNumericArg(
  args: ReadonlyArray<Value>,
  visit: (n: number) => void,
): WalkResult {
  for (const arg of args) {
    if (arg.kind === 'error') return { ok: false, error: arg }
    if (arg.kind === 'array') {
      const walk = forEachNumericInArray(arg.value, visit)
      if (!walk.ok) return walk
      continue
    }
    // Scalar argument — coerce strictly.
    const n = toNumber(arg)
    if (!n.ok) return { ok: false, error: n.error }
    visit(n.value)
  }
  return { ok: true }
}

function forEachNumericInArray(
  rows: ReadonlyArray<ReadonlyArray<Value>>,
  visit: (n: number) => void,
): WalkResult {
  for (const row of rows) {
    for (const cell of row) {
      if (cell.kind === 'error') return { ok: false, error: cell }
      if (cell.kind === 'number') {
        visit(cell.value)
        continue
      }
      if (cell.kind === 'array') {
        // Nested arrays are flattened recursively (rare — only happens
        // when a function returns an array which is then fed into
        // another aggregator).
        const inner = forEachNumericInArray(cell.value, visit)
        if (!inner.ok) return inner
        continue
      }
      // string / boolean / blank inside an array/range → ignored.
    }
  }
  return { ok: true }
}

/**
 * COUNT-style iterator: only `number` cells count, regardless of
 * whether they came from a scalar arg or an array. Strings (even
 * numeric-looking ones), booleans, blanks are all skipped.
 * Errors inside an array propagate; errors in a scalar arg propagate
 * too (handled by the caller's `propagateError`).
 */
function forEachCountNumber(
  args: ReadonlyArray<Value>,
  visit: () => void,
): WalkResult {
  for (const arg of args) {
    if (arg.kind === 'error') return { ok: false, error: arg }
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return { ok: false, error: cell }
          if (cell.kind === 'number') visit()
        }
      }
      continue
    }
    if (arg.kind === 'number') visit()
    // string / boolean / blank scalar → skipped by COUNT.
  }
  return { ok: true }
}

/**
 * COUNTA: count every non-blank. Errors in arrays count too (they are
 * not blank). Scalar errors still propagate via `propagateError`.
 */
function forEachCountANonBlank(
  args: ReadonlyArray<Value>,
  visit: () => void,
): void {
  for (const arg of args) {
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          if (cell.kind !== 'blank') visit()
        }
      }
      continue
    }
    if (arg.kind !== 'blank') visit()
  }
}

// ---------------------------------------------------------------------------
// Function implementations
// ---------------------------------------------------------------------------

export const SUM: FunctionImpl = (args) => {
  let total = 0
  const walk = forEachNumericArg(args, (n) => {
    total += n
  })
  if (!walk.ok) return walk.error
  return NUM(total)
}

export const AVERAGE: FunctionImpl = (args) => {
  let total = 0
  let count = 0
  const walk = forEachNumericArg(args, (n) => {
    total += n
    count += 1
  })
  if (!walk.ok) return walk.error
  if (count === 0) return ERR('#DIV/0!')
  return NUM(total / count)
}

export const COUNT: FunctionImpl = (args) => {
  // Scalar errors propagate (matches Excel — `=COUNT(#REF!)` returns
  // `#REF!`, not 0).
  const propagated = propagateError(args)
  if (propagated) return propagated
  let count = 0
  const walk = forEachCountNumber(args, () => {
    count += 1
  })
  if (!walk.ok) return walk.error
  return NUM(count)
}

export const COUNTA: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  let count = 0
  forEachCountANonBlank(args, () => {
    count += 1
  })
  return NUM(count)
}

export const MIN: FunctionImpl = (args) => {
  let best = Number.POSITIVE_INFINITY
  let seen = false
  const walk = forEachNumericArg(args, (n) => {
    if (n < best) best = n
    seen = true
  })
  if (!walk.ok) return walk.error
  // Excel quirk: MIN() with no numeric values returns 0, not an error.
  if (!seen) return NUM(0)
  return NUM(best)
}

export const MAX: FunctionImpl = (args) => {
  let best = Number.NEGATIVE_INFINITY
  let seen = false
  const walk = forEachNumericArg(args, (n) => {
    if (n > best) best = n
    seen = true
  })
  if (!walk.ok) return walk.error
  if (!seen) return NUM(0)
  return NUM(best)
}

/**
 * Banker's? No — Excel's ROUND is **away-from-zero** half rounding
 * (so ROUND(2.5, 0) = 3, ROUND(-2.5, 0) = -3). JS's `Math.round` rounds
 * half toward positive infinity (Math.round(-2.5) = -2). We re-derive
 * the sign-aware version below.
 */
function roundHalfAwayFromZero(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const factor = Math.pow(10, digits)
  // Using Math.sign to avoid -0 issues.
  return (x >= 0 ? Math.floor(x * factor + 0.5) : -Math.floor(-x * factor + 0.5)) / factor
}

function roundAwayFromZero(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const factor = Math.pow(10, digits)
  return (x >= 0 ? Math.ceil(x * factor) : -Math.ceil(-x * factor)) / factor
}

function truncTowardZero(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const factor = Math.pow(10, digits)
  return (x >= 0 ? Math.floor(x * factor) : -Math.floor(-x * factor)) / factor
}

function unaryRounder(args: ReadonlyArray<Value>, fn: (n: number, d: number) => number): Value {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  let digits = 0
  if (args.length === 2) {
    const d = toNumber(args[1])
    if (!d.ok) return d.error
    digits = Math.trunc(d.value)
  }
  const out = fn(v.value, digits)
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

export const ROUND: FunctionImpl = (args) => unaryRounder(args, roundHalfAwayFromZero)
export const ROUNDUP: FunctionImpl = (args) => unaryRounder(args, roundAwayFromZero)
export const ROUNDDOWN: FunctionImpl = (args) => unaryRounder(args, truncTowardZero)

export const INT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  // Excel INT rounds toward NEGATIVE INFINITY (floor), not toward zero.
  return NUM(Math.floor(v.value))
}

export const MOD: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const b = toNumber(args[1])
  if (!b.ok) return b.error
  if (b.value === 0) return ERR('#DIV/0!')
  // Excel MOD: a - b * INT(a / b) — INT here is floor, so the sign of
  // the result follows the divisor's sign (not JS `%` which follows
  // the dividend).
  const out = a.value - b.value * Math.floor(a.value / b.value)
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

export const ABS: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  return NUM(Math.abs(v.value))
}

export const POWER: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const base = toNumber(args[0])
  if (!base.ok) return base.error
  const exp = toNumber(args[1])
  if (!exp.ok) return exp.error
  if (base.value === 0 && exp.value === 0) {
    // Excel: POWER(0, 0) is #NUM! (matches the engine's treatment of
    // 0^0 as undefined). JS would return 1.
    return ERR('#NUM!')
  }
  if (base.value === 0 && exp.value < 0) {
    return ERR('#DIV/0!')
  }
  const out = Math.pow(base.value, exp.value)
  // POWER(-2, 0.5) → NaN → #NUM!
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

export const SQRT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  if (v.value < 0) return ERR('#NUM!')
  return NUM(Math.sqrt(v.value))
}

export const SIGN: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  if (v.value > 0) return NUM(1)
  if (v.value < 0) return NUM(-1)
  return NUM(0)
}

// ---------------------------------------------------------------------------
// Registry
//
// `index.ts` (assembled by CC after all C tracks finish) imports
// FUNCTIONS, merges with logical/lookup/text/date/stats maps, and exposes
// a single `Map<string, FunctionImpl>` to the evaluator's call dispatch.
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  SUM,
  AVERAGE,
  COUNT,
  COUNTA,
  MIN,
  MAX,
  ROUND,
  ROUNDUP,
  ROUNDDOWN,
  INT,
  MOD,
  ABS,
  POWER,
  SQRT,
  SIGN,
}

