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
import { propagateError, toNumber, toString } from '../coerce'

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
  if (args.length !== 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const d = toNumber(args[1])
  if (!d.ok) return d.error
  const digits = Math.trunc(d.value)
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
// Wave F / F1 — CEILING / FLOOR / TRUNC / SUMPRODUCT / PRODUCT
// ---------------------------------------------------------------------------

/**
 * CEILING(value, [significance=1]) — Excel's CEILING.MATH semantics:
 * round `value` UP (away from zero for positives, toward zero for
 * negatives by default) to the nearest multiple of `significance`.
 *
 * If `significance === 0`, Excel returns 0 (not #DIV/0!).
 * Negative significance flips the rounding direction for negative
 * values; for the canonical CEILING (no mode arg), the *magnitude* is
 * what matters — we use `Math.abs(significance)` and round toward
 * positive infinity. Matches CEILING.MATH default behavior.
 */
export const CEILING: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  let sig = 1
  if (args.length === 2) {
    const s = toNumber(args[1])
    if (!s.ok) return s.error
    sig = s.value
  }
  if (sig === 0) return NUM(0)
  const absSig = Math.abs(sig)
  const out = Math.ceil(v.value / absSig) * absSig
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

/**
 * FLOOR(value, [significance=1]) — round DOWN (toward negative
 * infinity) to the nearest multiple of `significance`.
 *
 * Excel's classic FLOOR signals #NUM! when `value > 0` and
 * `significance < 0` (or vice-versa). FLOOR.MATH relaxes that.
 * We follow FLOOR.MATH's relaxed behavior (matches the CEILING side
 * of this pair).
 */
export const FLOOR: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  let sig = 1
  if (args.length === 2) {
    const s = toNumber(args[1])
    if (!s.ok) return s.error
    sig = s.value
  }
  if (sig === 0) return NUM(0)
  const absSig = Math.abs(sig)
  const out = Math.floor(v.value / absSig) * absSig
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

/**
 * TRUNC(value, [digits=0]) — truncate toward zero, preserving the first
 * `digits` decimal places. Same shape as ROUNDDOWN but locked at 1-2
 * args (Excel uses identical semantics here; the two functions exist
 * for historical reasons).
 */
export const TRUNC: FunctionImpl = (args) => {
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
  return NUM(truncTowardZero(v.value, digits))
}

/**
 * SUMPRODUCT(array1, [array2], ...) — element-wise product summed.
 *
 *   SUMPRODUCT([1,2,3], [4,5,6]) = 1*4 + 2*5 + 3*6 = 32
 *
 * Excel rules:
 *  - All arrays must have the same shape (rows × cols). Mismatch → `#VALUE!`.
 *  - Non-numeric cells inside arrays are treated as 0 (NOT propagated as
 *    `#VALUE!` like a normal multiply would be). This is Excel's documented
 *    quirk — text in a SUMPRODUCT range zeroes the row, doesn't poison it.
 *  - Errors anywhere still propagate.
 *  - Scalar (non-array) args are accepted and treated as 1×1 arrays;
 *    they multiply through every row.
 */
export const SUMPRODUCT: FunctionImpl = (args) => {
  if (args.length === 0) return ERR('#VALUE!')
  const propagated = propagateError(args)
  if (propagated) return propagated

  // Normalize every arg to a 2-D Value[][] grid. Scalars become 1×1.
  const grids: Value[][][] = []
  for (const arg of args) {
    if (arg.kind === 'array') {
      grids.push(arg.value as Value[][])
    } else {
      grids.push([[arg]])
    }
  }

  // Determine the "broadcast" shape — use the largest dims and require
  // every other grid to either match or be 1×1 (Excel-compatible).
  let rows = 0
  let cols = 0
  for (const g of grids) {
    const r = g.length
    const c = g[0]?.length ?? 0
    if (r > rows) rows = r
    if (c > cols) cols = c
  }
  if (rows === 0 || cols === 0) return ERR('#VALUE!')

  // Strict-shape mode (matches Excel): all grids must be exactly
  // (rows × cols) OR be a 1×1 broadcast scalar. Anything else → #VALUE!.
  for (const g of grids) {
    const gr = g.length
    const gc = g[0]?.length ?? 0
    if (gr === 1 && gc === 1) continue
    if (gr !== rows || gc !== cols) return ERR('#VALUE!')
  }

  let total = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let product = 1
      for (const g of grids) {
        const gr = g.length
        const gc = g[0]?.length ?? 0
        const cell = gr === 1 && gc === 1 ? g[0][0] : g[r][c]
        if (cell.kind === 'error') return cell
        if (cell.kind === 'number') {
          product *= cell.value
        } else {
          // Non-numeric → treated as 0 (Excel SUMPRODUCT quirk).
          product = 0
          break
        }
      }
      total += product
    }
  }
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

/**
 * PRODUCT(...args) — multiply all numeric args together. Same
 * scalar-coerce / array-ignore split as SUM. Empty product → 0
 * (Excel's documented behavior — divergence from math but a long-
 * standing quirk).
 */
export const PRODUCT: FunctionImpl = (args) => {
  let total = 1
  let seen = false
  const walk = forEachNumericArg(args, (n) => {
    total *= n
    seen = true
  })
  if (!walk.ok) return walk.error
  if (!seen) return NUM(0)
  return NUM(total)
}

// ---------------------------------------------------------------------------
// Phase 8 additions — trig, log, rounding, combinatorics, constants
// ---------------------------------------------------------------------------

/** Generic 1-arg numeric helper. */
function unaryNumber(args: ReadonlyArray<Value>, fn: (n: number) => number): Value {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const out = fn(v.value)
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

/** Generic 2-arg numeric helper. */
function binaryNumber(args: ReadonlyArray<Value>, fn: (a: number, b: number) => number): Value {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const b = toNumber(args[1])
  if (!b.ok) return b.error
  const out = fn(a.value, b.value)
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

// Trig & inverse trig
export const SIN: FunctionImpl = (args) => unaryNumber(args, Math.sin)
export const COS: FunctionImpl = (args) => unaryNumber(args, Math.cos)
export const TAN: FunctionImpl = (args) => unaryNumber(args, Math.tan)
export const ASIN: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n < -1 || n > 1) return Number.NaN
  return Math.asin(n)
})
export const ACOS: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n < -1 || n > 1) return Number.NaN
  return Math.acos(n)
})
export const ATAN: FunctionImpl = (args) => unaryNumber(args, Math.atan)
export const ATAN2: FunctionImpl = (args) =>
  // Excel: ATAN2(x, y) — note arg order is (x, y), not Math.atan2's (y, x).
  binaryNumber(args, (x, y) => {
    if (x === 0 && y === 0) return Number.NaN
    return Math.atan2(y, x)
  })

// Hyperbolic
export const SINH: FunctionImpl = (args) => unaryNumber(args, Math.sinh)
export const COSH: FunctionImpl = (args) => unaryNumber(args, Math.cosh)
export const TANH: FunctionImpl = (args) => unaryNumber(args, Math.tanh)
export const ASINH: FunctionImpl = (args) => unaryNumber(args, Math.asinh)
export const ACOSH: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n < 1) return Number.NaN
  return Math.acosh(n)
})
export const ATANH: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n <= -1 || n >= 1) return Number.NaN
  return Math.atanh(n)
})

// Reciprocal trig
export const CSC: FunctionImpl = (args) => unaryNumber(args, (n) => {
  const s = Math.sin(n)
  if (s === 0) return Number.NaN
  return 1 / s
})
export const SEC: FunctionImpl = (args) => unaryNumber(args, (n) => {
  const c = Math.cos(n)
  if (c === 0) return Number.NaN
  return 1 / c
})
export const COT: FunctionImpl = (args) => unaryNumber(args, (n) => {
  const t = Math.tan(n)
  if (t === 0) return Number.NaN
  return 1 / t
})

// Reciprocal hyperbolic
export const CSCH: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const s = Math.sinh(v.value)
  if (s === 0) return ERR('#DIV/0!')
  const out = 1 / s
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

export const SECH: FunctionImpl = (args) => unaryNumber(args, (n) => 1 / Math.cosh(n))

export const COTH: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const t = Math.tanh(v.value)
  if (t === 0) return ERR('#DIV/0!')
  const out = 1 / t
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

// Inverse reciprocal trig
export const ACSC: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  if (v.value === 0) return ERR('#DIV/0!')
  if (Math.abs(v.value) < 1) return ERR('#NUM!')
  const out = Math.asin(1 / v.value)
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

export const ASEC: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  if (v.value === 0) return ERR('#DIV/0!')
  if (Math.abs(v.value) < 1) return ERR('#NUM!')
  const out = Math.acos(1 / v.value)
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

export const ACOT: FunctionImpl = (args) =>
  unaryNumber(args, (n) => Math.PI / 2 - Math.atan(n))

export const ACOTH: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (Math.abs(n) <= 1) return Number.NaN
  return 0.5 * Math.log((n + 1) / (n - 1))
})

// Angle conversion
export const RADIANS: FunctionImpl = (args) => unaryNumber(args, (d) => (d * Math.PI) / 180)
export const DEGREES: FunctionImpl = (args) => unaryNumber(args, (r) => (r * 180) / Math.PI)

// Exponential / logarithmic
export const EXP: FunctionImpl = (args) => unaryNumber(args, Math.exp)
export const LN: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n <= 0) return Number.NaN
  return Math.log(n)
})
export const LOG10: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n <= 0) return Number.NaN
  return Math.log10(n)
})
/** LOG(number, [base=10]) — like LOG10 by default; second arg = base. */
export const LOG: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const n = toNumber(args[0])
  if (!n.ok) return n.error
  if (n.value <= 0) return ERR('#NUM!')
  let base = 10
  if (args.length === 2) {
    const b = toNumber(args[1])
    if (!b.ok) return b.error
    if (b.value <= 0 || b.value === 1) return ERR('#NUM!')
    base = b.value
  }
  return NUM(Math.log(n.value) / Math.log(base))
}

// Constants
export const PI: FunctionImpl = (args) => {
  if (args.length !== 0) return ERR('#VALUE!')
  return NUM(Math.PI)
}

// Random
export const RAND: FunctionImpl = (args) => {
  if (args.length !== 0) return ERR('#VALUE!')
  return NUM(Math.random())
}

export const RANDBETWEEN: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const lo = toNumber(args[0])
  if (!lo.ok) return lo.error
  const hi = toNumber(args[1])
  if (!hi.ok) return hi.error
  const low = Math.ceil(lo.value)
  const high = Math.floor(hi.value)
  if (low > high) return ERR('#NUM!')
  return NUM(Math.floor(Math.random() * (high - low + 1)) + low)
}

// Other rounding
/** MROUND(number, multiple) — round to nearest multiple. */
export const MROUND: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const n = toNumber(args[0])
  if (!n.ok) return n.error
  const m = toNumber(args[1])
  if (!m.ok) return m.error
  if (m.value === 0) return NUM(0)
  // Excel requires same sign.
  if ((n.value > 0 && m.value < 0) || (n.value < 0 && m.value > 0)) return ERR('#NUM!')
  return NUM(Math.round(n.value / m.value) * m.value)
}

/** QUOTIENT(numerator, denominator) — integer division (truncate toward zero). */
export const QUOTIENT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const b = toNumber(args[1])
  if (!b.ok) return b.error
  if (b.value === 0) return ERR('#DIV/0!')
  return NUM(Math.trunc(a.value / b.value))
}

/** EVEN(n) — round away from zero to next even integer. */
export const EVEN: FunctionImpl = (args) => unaryNumber(args, (n) => {
  const sign = n >= 0 ? 1 : -1
  const abs = Math.abs(n)
  const ceiled = Math.ceil(abs)
  return sign * (ceiled % 2 === 0 ? ceiled : ceiled + 1)
})

/** ODD(n) — round away from zero to next odd integer. */
export const ODD: FunctionImpl = (args) => unaryNumber(args, (n) => {
  const sign = n >= 0 ? 1 : -1
  const abs = Math.abs(n)
  const ceiled = Math.ceil(abs)
  return sign * (ceiled % 2 === 1 ? ceiled : ceiled + 1)
})

function floorCeilingMath(args: ReadonlyArray<Value>, isFloor: boolean): Value {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 3) return ERR('#VALUE!')

  const n = toNumber(args[0])
  if (!n.ok) return n.error

  let significance = 1
  if (args.length >= 2) {
    const sig = toNumber(args[1])
    if (!sig.ok) return sig.error
    significance = sig.value
  }

  let mode = 0
  if (args.length === 3) {
    const m = toNumber(args[2])
    if (!m.ok) return m.error
    mode = m.value
  }

  if (significance === 0) return NUM(0)
  const s = Math.abs(significance)
  const scaled = n.value / s
  const out = isFloor
    ? (n.value < 0 && mode !== 0 ? Math.ceil(scaled) : Math.floor(scaled)) * s
    : (n.value < 0 && mode !== 0 ? Math.floor(scaled) : Math.ceil(scaled)) * s
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

function floorCeilingPrecise(args: ReadonlyArray<Value>, isFloor: boolean): Value {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')

  const n = toNumber(args[0])
  if (!n.ok) return n.error

  let significance = 1
  if (args.length === 2) {
    const sig = toNumber(args[1])
    if (!sig.ok) return sig.error
    significance = sig.value
  }

  if (significance === 0) return NUM(0)
  const s = Math.abs(significance)
  const scaled = n.value / s
  const out = (isFloor ? Math.floor(scaled) : Math.ceil(scaled)) * s
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

export const FLOOR_MATH: FunctionImpl = (args) => floorCeilingMath(args, true)
export const CEILING_MATH: FunctionImpl = (args) => floorCeilingMath(args, false)
export const FLOOR_PRECISE: FunctionImpl = (args) => floorCeilingPrecise(args, true)
export const CEILING_PRECISE: FunctionImpl = (args) => floorCeilingPrecise(args, false)
export const ISO_CEILING: FunctionImpl = CEILING_PRECISE

// Combinatorics
/** FACT(n) — n factorial. n must be >= 0. Truncates fractional. */
export const FACT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const n = Math.trunc(v.value)
  if (n < 0) return ERR('#NUM!')
  if (n > 170) return ERR('#NUM!') // overflow past Number.MAX_VALUE
  let out = 1
  for (let i = 2; i <= n; i++) out *= i
  return NUM(out)
}

/** FACTDOUBLE(n) — double factorial n!! */
export const FACTDOUBLE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const n = Math.trunc(v.value)
  if (n < -1) return ERR('#NUM!')
  if (n <= 0) return NUM(1)
  let out = 1
  for (let i = n; i > 0; i -= 2) out *= i
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

/** COMBIN(n, k) — combinations C(n, k). */
export const COMBIN: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const nv = toNumber(args[0])
  if (!nv.ok) return nv.error
  const kv = toNumber(args[1])
  if (!kv.ok) return kv.error
  const n = Math.trunc(nv.value)
  const k = Math.trunc(kv.value)
  if (n < 0 || k < 0 || k > n) return ERR('#NUM!')
  if (k === 0 || k === n) return NUM(1)
  // Compute C(n,k) iteratively to avoid overflow as long as possible.
  const r = Math.min(k, n - k)
  let out = 1
  for (let i = 0; i < r; i++) {
    out = (out * (n - i)) / (i + 1)
  }
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(Math.round(out))
}

/** PERMUT(n, k) — n! / (n-k)! */
export const PERMUT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const nv = toNumber(args[0])
  if (!nv.ok) return nv.error
  const kv = toNumber(args[1])
  if (!kv.ok) return kv.error
  const n = Math.trunc(nv.value)
  const k = Math.trunc(kv.value)
  if (n < 0 || k < 0 || k > n) return ERR('#NUM!')
  let out = 1
  for (let i = 0; i < k; i++) out *= n - i
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

function factorialFinite(n: number): number | null {
  if (n > 170) return null
  let out = 1
  for (let i = 2; i <= n; i += 1) {
    out *= i
    if (!Number.isFinite(out)) return null
  }
  return out
}

/** COMBINA(n, k) — combinations with repetition. */
export const COMBINA: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const nv = toNumber(args[0])
  if (!nv.ok) return nv.error
  const kv = toNumber(args[1])
  if (!kv.ok) return kv.error
  const n = Math.trunc(nv.value)
  const k = Math.trunc(kv.value)
  if (n < 0 || k < 0) return ERR('#NUM!')
  if (n === 0 && k === 0) return NUM(1)
  const top = n + k - 1
  const pick = Math.min(k, top - k)
  let out = 1
  for (let i = 1; i <= pick; i += 1) {
    out = (out * (top - i + 1)) / i
    if (!Number.isFinite(out)) return ERR('#NUM!')
  }
  return NUM(Math.round(out))
}

/** PERMUTATIONA(n, k) — permutations with repetition, n^k. */
export const PERMUTATIONA: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const nv = toNumber(args[0])
  if (!nv.ok) return nv.error
  const kv = toNumber(args[1])
  if (!kv.ok) return kv.error
  const n = Math.trunc(nv.value)
  const k = Math.trunc(kv.value)
  if (n < 0 || k < 0) return ERR('#NUM!')
  if (n === 0 && k === 0) return NUM(1)
  const out = Math.pow(n, k)
  if (!Number.isFinite(out) || Number.isNaN(out)) return ERR('#NUM!')
  return NUM(out)
}

/** MULTINOMIAL(n1, n2, ...) — (sum n)! / product(n!). */
export const MULTINOMIAL: FunctionImpl = (args) => {
  if (args.length === 0) return ERR('#VALUE!')
  const nums: number[] = []
  const walk = forEachNumericArg(args, (n) => {
    nums.push(Math.trunc(n))
  })
  if (!walk.ok) return walk.error
  if (nums.length === 0) return ERR('#VALUE!')
  if (nums.some((n) => n < 0)) return ERR('#NUM!')
  const total = nums.reduce((a, b) => a + b, 0)
  const numerator = factorialFinite(total)
  if (numerator === null) return ERR('#NUM!')
  let denominator = 1
  for (const n of nums) {
    const f = factorialFinite(n)
    if (f === null) return ERR('#NUM!')
    denominator *= f
    if (!Number.isFinite(denominator) || denominator === 0) return ERR('#NUM!')
  }
  return NUM(numerator / denominator)
}

/** BASE(number, radix, [min_length]) — convert integer to a base 2..36 string. */
export const BASE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!')
  const nv = toNumber(args[0])
  if (!nv.ok) return nv.error
  const rv = toNumber(args[1])
  if (!rv.ok) return rv.error
  const number = Math.trunc(nv.value)
  const radix = Math.trunc(rv.value)
  if (number < 0 || radix < 2 || radix > 36) return ERR('#NUM!')
  let minLength = 0
  if (args.length === 3) {
    const lv = toNumber(args[2])
    if (!lv.ok) return lv.error
    minLength = Math.trunc(lv.value)
    if (minLength < 0) return ERR('#NUM!')
  }
  return { kind: 'string', value: number.toString(radix).toUpperCase().padStart(minLength, '0') }
}

/** DECIMAL(text, radix) — parse a base 2..36 integer string. */
export const DECIMAL: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const sv = toString(args[0])
  if (!sv.ok) return sv.error
  const rv = toNumber(args[1])
  if (!rv.ok) return rv.error
  const radix = Math.trunc(rv.value)
  if (radix < 2 || radix > 36) return ERR('#NUM!')
  const text = sv.value.trim()
  if (text.length === 0) return ERR('#NUM!')
  let out = 0
  for (const ch of text.toUpperCase()) {
    const digit = Number.parseInt(ch, 36)
    if (!Number.isInteger(digit) || digit < 0 || digit >= radix) return ERR('#NUM!')
    out = out * radix + digit
    if (!Number.isSafeInteger(out)) return ERR('#NUM!')
  }
  return NUM(out)
}

function gridForPair(value: Value): Value[][] | null {
  if (value.kind === 'array') {
    if (value.value.length === 0 || (value.value[0]?.length ?? 0) === 0) return null
    return value.value
  }
  if (value.kind === 'blank') return null
  return [[value]]
}

type PairNumbersResult =
  | { ok: true; pairs: [number, number][] }
  | { ok: false; error: Value & { kind: 'error' } }

function pairedNumbers(args: ReadonlyArray<Value>): PairNumbersResult {
  const propagated = propagateError(args)
  if (propagated) return { ok: false, error: propagated }
  if (args.length !== 2) return { ok: false, error: ERR('#VALUE!') as Value & { kind: 'error' } }
  const a = gridForPair(args[0])
  const b = gridForPair(args[1])
  if (!a || !b) return { ok: false, error: ERR('#VALUE!') as Value & { kind: 'error' } }
  const rows = a.length
  const cols = a[0].length
  if (b.length !== rows || b[0].length !== cols) {
    return { ok: false, error: ERR('#VALUE!') as Value & { kind: 'error' } }
  }
  const pairs: [number, number][] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const av = a[r][c]
      const bv = b[r][c]
      if (av.kind === 'error') return { ok: false, error: av }
      if (bv.kind === 'error') return { ok: false, error: bv }
      if (av.kind === 'number' && bv.kind === 'number') pairs.push([av.value, bv.value])
    }
  }
  return { ok: true, pairs }
}

function sumPairImpl(args: ReadonlyArray<Value>, fn: (x: number, y: number) => number): Value {
  const pairs = pairedNumbers(args)
  if (!pairs.ok) return pairs.error
  let total = 0
  for (const [x, y] of pairs.pairs) total += fn(x, y)
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

export const SUMX2MY2: FunctionImpl = (args) => sumPairImpl(args, (x, y) => x * x - y * y)
export const SUMX2PY2: FunctionImpl = (args) => sumPairImpl(args, (x, y) => x * x + y * y)
export const SUMXMY2: FunctionImpl = (args) => sumPairImpl(args, (x, y) => (x - y) * (x - y))

type NumericMatrixResult =
  | { ok: true; matrix: number[][] }
  | { ok: false; error: Value & { kind: 'error' } }

function numericMatrix(value: Value): NumericMatrixResult {
  const grid = value.kind === 'array' ? value.value : [[value]]
  if (grid.length === 0 || (grid[0]?.length ?? 0) === 0) {
    return { ok: false, error: ERR('#VALUE!') as Value & { kind: 'error' } }
  }
  const width = grid[0].length
  const matrix: number[][] = []
  for (const row of grid) {
    if (row.length !== width) return { ok: false, error: ERR('#VALUE!') as Value & { kind: 'error' } }
    const outRow: number[] = []
    for (const cell of row) {
      const n = toNumber(cell)
      if (!n.ok) return { ok: false, error: n.error }
      outRow.push(n.value)
    }
    matrix.push(outRow)
  }
  return { ok: true, matrix }
}

/** MUNIT(dimension) — identity matrix. */
export const MUNIT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!')
  const dv = toNumber(args[0])
  if (!dv.ok) return dv.error
  const dim = Math.trunc(dv.value)
  if (dim < 1) return ERR('#VALUE!')
  const rows: Value[][] = []
  for (let r = 0; r < dim; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < dim; c += 1) row.push(NUM(r === c ? 1 : 0))
    rows.push(row)
  }
  return { kind: 'array', value: rows }
}

/** MMULT(array1, array2) — matrix product. */
export const MMULT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 2) return ERR('#VALUE!')
  const a = numericMatrix(args[0])
  if (!a.ok) return a.error
  const b = numericMatrix(args[1])
  if (!b.ok) return b.error
  const aRows = a.matrix.length
  const aCols = a.matrix[0].length
  const bRows = b.matrix.length
  const bCols = b.matrix[0].length
  if (aCols !== bRows) return ERR('#VALUE!')
  const out: Value[][] = []
  for (let r = 0; r < aRows; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < bCols; c += 1) {
      let total = 0
      for (let k = 0; k < aCols; k += 1) total += a.matrix[r][k] * b.matrix[k][c]
      row.push(NUM(total))
    }
    out.push(row)
  }
  return { kind: 'array', value: out }
}

function determinant(matrix: number[][]): number {
  const n = matrix.length
  const m = matrix.map((row) => row.slice())
  let det = 1
  for (let i = 0; i < n; i += 1) {
    let pivot = i
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r
    }
    if (Math.abs(m[pivot][i]) < 1e-12) return 0
    if (pivot !== i) {
      ;[m[pivot], m[i]] = [m[i], m[pivot]]
      det *= -1
    }
    const pv = m[i][i]
    det *= pv
    for (let r = i + 1; r < n; r += 1) {
      const factor = m[r][i] / pv
      for (let c = i; c < n; c += 1) m[r][c] -= factor * m[i][c]
    }
  }
  return det
}

/** MDETERM(array) — matrix determinant. */
export const MDETERM: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR('#VALUE!')
  const m = numericMatrix(args[0])
  if (!m.ok) return m.error
  if (m.matrix.length !== m.matrix[0].length) return ERR('#VALUE!')
  return NUM(determinant(m.matrix))
}

/** MINVERSE(array) — inverse of a square numeric matrix. */
export const MINVERSE: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR('#VALUE!')
  const parsed = numericMatrix(args[0])
  if (!parsed.ok) return parsed.error
  const input = parsed.matrix
  const n = input.length
  if (n !== input[0].length) return ERR('#VALUE!')
  const aug = input.map((row, r) => [
    ...row,
    ...Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)),
  ])
  for (let c = 0; c < n; c += 1) {
    let pivot = c
    for (let r = c + 1; r < n; r += 1) {
      if (Math.abs(aug[r][c]) > Math.abs(aug[pivot][c])) pivot = r
    }
    if (Math.abs(aug[pivot][c]) < 1e-12) return ERR('#NUM!')
    if (pivot !== c) {
      ;[aug[pivot], aug[c]] = [aug[c], aug[pivot]]
    }
    const pv = aug[c][c]
    for (let j = 0; j < 2 * n; j += 1) aug[c][j] /= pv
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue
      const factor = aug[r][c]
      for (let j = 0; j < 2 * n; j += 1) aug[r][j] -= factor * aug[c][j]
    }
  }
  return {
    kind: 'array',
    value: aug.map((row) => row.slice(n).map((value) => NUM(value))),
  }
}

/** GCD(a, b, ...) — greatest common divisor. */
export const GCD: FunctionImpl = (args) => {
  if (args.length === 0) return ERR('#VALUE!')
  const propagated = propagateError(args)
  if (propagated) return propagated
  const nums: number[] = []
  let hasNegative = false
  const walk = forEachNumericArg(args, (n) => {
    if (n < 0) hasNegative = true
    nums.push(Math.trunc(Math.abs(n)))
  })
  if (!walk.ok) return walk.error
  if (hasNegative) return ERR('#NUM!')
  if (nums.length === 0) return NUM(0)
  const gcd2 = (a: number, b: number): number => {
    while (b !== 0) {
      ;[a, b] = [b, a % b]
    }
    return a
  }
  let g = nums[0]
  for (let i = 1; i < nums.length; i++) g = gcd2(g, nums[i])
  return NUM(g)
}

/** LCM(a, b, ...) — least common multiple. */
export const LCM: FunctionImpl = (args) => {
  if (args.length === 0) return ERR('#VALUE!')
  const propagated = propagateError(args)
  if (propagated) return propagated
  const nums: number[] = []
  let hasNegative = false
  const walk = forEachNumericArg(args, (n) => {
    if (n < 0) hasNegative = true
    nums.push(Math.trunc(Math.abs(n)))
  })
  if (!walk.ok) return walk.error
  if (hasNegative) return ERR('#NUM!')
  if (nums.length === 0) return NUM(0)
  if (nums.some((n) => n === 0)) return NUM(0)
  const gcd2 = (a: number, b: number): number => {
    while (b !== 0) {
      ;[a, b] = [b, a % b]
    }
    return a
  }
  let l = nums[0]
  for (let i = 1; i < nums.length; i++) {
    l = (l / gcd2(l, nums[i])) * nums[i]
    if (!Number.isFinite(l)) return ERR('#NUM!')
  }
  return NUM(l)
}

/** COUNTBLANK(range) — count blank cells in a range. */
export const COUNTBLANK: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR('#VALUE!')
  const arg = args[0]
  let count = 0
  if (arg.kind === 'error') return arg
  if (arg.kind === 'array') {
    for (const row of arg.value) {
      for (const cell of row) {
        if (cell.kind === 'blank') count++
        // Excel also counts empty strings as blank for COUNTBLANK.
        else if (cell.kind === 'string' && cell.value === '') count++
      }
    }
  } else {
    if (arg.kind === 'blank') count = 1
    else if (arg.kind === 'string' && arg.value === '') count = 1
  }
  return NUM(count)
}

/** SUMSQ(...args) — sum of squares. */
export const SUMSQ: FunctionImpl = (args) => {
  let total = 0
  const walk = forEachNumericArg(args, (n) => {
    total += n * n
  })
  if (!walk.ok) return walk.error
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

function collectSeriesCoefficients(value: Value, out: number[]): Value & { kind: 'error' } | undefined {
  if (value.kind === 'array') {
    for (const row of value.value) {
      for (const cell of row) {
        const err = collectSeriesCoefficients(cell, out)
        if (err) return err
      }
    }
    return undefined
  }
  if (value.kind === 'error') return value
  const n = toNumber(value)
  if (!n.ok) return n.error
  out.push(n.value)
  return undefined
}

/** SERIESSUM(x, n, m, coefficients) — sum c_i * x^(n + i*m). */
export const SERIESSUM: FunctionImpl = (args) => {
  const propagated = propagateError(args.slice(0, 3))
  if (propagated) return propagated
  if (args.length !== 4) return ERR('#VALUE!')
  const x = toNumber(args[0])
  if (!x.ok) return x.error
  const n = toNumber(args[1])
  if (!n.ok) return n.error
  const m = toNumber(args[2])
  if (!m.ok) return m.error
  const coefficients: number[] = []
  const coefficientError = collectSeriesCoefficients(args[3], coefficients)
  if (coefficientError) return coefficientError
  if (coefficients.length === 0) return ERR('#VALUE!')
  let total = 0
  for (let i = 0; i < coefficients.length; i += 1) {
    const term = coefficients[i] * Math.pow(x.value, n.value + i * m.value)
    if (!Number.isFinite(term) || Number.isNaN(term)) return ERR('#NUM!')
    total += term
  }
  if (!Number.isFinite(total) || Number.isNaN(total)) return ERR('#NUM!')
  return NUM(total)
}

function flattenSubtotalValues(
  args: ReadonlyArray<Value>,
  ignoreErrors: boolean,
): { ok: true; values: Value[] } | { ok: false; error: Value & { kind: 'error' } } {
  const values: Value[] = []
  const visit = (value: Value): Value & { kind: 'error' } | undefined => {
    if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) {
          const err = visit(cell)
          if (err) return err
        }
      }
      return undefined
    }
    if (value.kind === 'error') {
      if (ignoreErrors) return undefined
      return value
    }
    values.push(value)
    return undefined
  }
  for (const arg of args) {
    const err = visit(arg)
    if (err) return { ok: false, error: err }
  }
  return { ok: true, values }
}

function numericSubtotalValues(
  args: ReadonlyArray<Value>,
  ignoreErrors: boolean,
): { ok: true; nums: number[] } | { ok: false; error: Value & { kind: 'error' } } {
  const flat = flattenSubtotalValues(args, ignoreErrors)
  if (!flat.ok) return flat
  return {
    ok: true,
    nums: flat.values.flatMap((value) => (value.kind === 'number' ? [value.value] : [])),
  }
}

function varianceFromNumbers(nums: number[], sample: boolean): Value {
  const min = sample ? 2 : 1
  if (nums.length < min) return ERR('#DIV/0!')
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const denom = sample ? nums.length - 1 : nums.length
  return NUM(nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / denom)
}

function percentileInclusive(sorted: number[], k: number): Value {
  if (!Number.isFinite(k) || k < 0 || k > 1 || sorted.length === 0) return ERR('#VALUE!')
  const pos = k * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return NUM(sorted[lo])
  return NUM(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
}

function percentileExclusive(sorted: number[], k: number): Value {
  if (!Number.isFinite(k) || k <= 0 || k >= 1 || sorted.length === 0) return ERR('#VALUE!')
  const pos = k * (sorted.length + 1)
  if (pos < 1 || pos > sorted.length) return ERR('#VALUE!')
  const zero = pos - 1
  const lo = Math.floor(zero)
  const hi = Math.ceil(zero)
  if (lo === hi) return NUM(sorted[lo])
  return NUM(sorted[lo] + (sorted[hi] - sorted[lo]) * (zero - lo))
}

function runSubtotalFunction(
  fnNum: number,
  dataArgs: ReadonlyArray<Value>,
  ignoreErrors: boolean,
  k?: number,
): Value {
  const numsResult = numericSubtotalValues(dataArgs, ignoreErrors)
  if (!numsResult.ok) return numsResult.error
  const nums = numsResult.nums

  switch (fnNum) {
    case 1:
      if (nums.length === 0) return ERR('#DIV/0!')
      return NUM(nums.reduce((a, b) => a + b, 0) / nums.length)
    case 2:
      return NUM(nums.length)
    case 3: {
      const flat = flattenSubtotalValues(dataArgs, ignoreErrors)
      if (!flat.ok) return flat.error
      return NUM(flat.values.filter((value) => value.kind !== 'blank').length)
    }
    case 4:
      return nums.length === 0 ? NUM(0) : NUM(Math.max(...nums))
    case 5:
      return nums.length === 0 ? NUM(0) : NUM(Math.min(...nums))
    case 6:
      return nums.length === 0 ? NUM(0) : NUM(nums.reduce((a, b) => a * b, 1))
    case 7: {
      const v = varianceFromNumbers(nums, true)
      return v.kind === 'number' ? NUM(Math.sqrt(v.value)) : v
    }
    case 8: {
      const v = varianceFromNumbers(nums, false)
      return v.kind === 'number' ? NUM(Math.sqrt(v.value)) : v
    }
    case 9:
      return NUM(nums.reduce((a, b) => a + b, 0))
    case 10:
      return varianceFromNumbers(nums, true)
    case 11:
      return varianceFromNumbers(nums, false)
    case 12: {
      if (nums.length === 0) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 1 ? NUM(sorted[mid]) : NUM((sorted[mid - 1] + sorted[mid]) / 2)
    }
    case 13: {
      if (nums.length === 0) return ERR('#VALUE!')
      let best = nums[0]
      let bestCount = 0
      for (let i = 0; i < nums.length; i += 1) {
        let count = 0
        for (const n of nums) if (n === nums[i]) count += 1
        if (count > bestCount) {
          best = nums[i]
          bestCount = count
        }
      }
      return bestCount <= 1 ? ERR('#VALUE!') : NUM(best)
    }
    case 14:
    case 15: {
      if (k === undefined || k < 1 || Math.trunc(k) !== k || k > nums.length) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => (fnNum === 14 ? b - a : a - b))
      return NUM(sorted[k - 1])
    }
    case 16:
    case 18: {
      if (k === undefined) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      return fnNum === 16 ? percentileInclusive(sorted, k) : percentileExclusive(sorted, k)
    }
    case 17:
    case 19: {
      if (k === undefined || Math.trunc(k) !== k) return ERR('#VALUE!')
      if (fnNum === 17 && (k < 0 || k > 4)) return ERR('#VALUE!')
      if (fnNum === 19 && (k < 1 || k > 3)) return ERR('#VALUE!')
      const sorted = nums.slice().sort((a, b) => a - b)
      const fraction = k / 4
      return fnNum === 17 ? percentileInclusive(sorted, fraction) : percentileExclusive(sorted, fraction)
    }
    default:
      return ERR('#VALUE!')
  }
}

/** SUBTOTAL(function_num, ref1, ...) — ordinary range aggregation subset. */
export const SUBTOTAL: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2) return ERR('#VALUE!')
  const fnValue = toNumber(args[0])
  if (!fnValue.ok) return fnValue.error
  const raw = Math.trunc(fnValue.value)
  const fnNum = raw >= 101 && raw <= 111 ? raw - 100 : raw
  if (fnNum < 1 || fnNum > 11) return ERR('#VALUE!')
  return runSubtotalFunction(fnNum, args.slice(1), false)
}

/** AGGREGATE(function_num, options, ref1, [ref2...], [k]). */
export const AGGREGATE: FunctionImpl = (args) => {
  const propagated = propagateError(args.slice(0, 2))
  if (propagated) return propagated
  if (args.length < 3) return ERR('#VALUE!')
  const fnValue = toNumber(args[0])
  if (!fnValue.ok) return fnValue.error
  const optionValue = toNumber(args[1])
  if (!optionValue.ok) return optionValue.error
  const fnNum = Math.trunc(fnValue.value)
  const options = Math.trunc(optionValue.value)
  if (fnNum < 1 || fnNum > 19 || options < 0 || options > 7) return ERR('#VALUE!')
  const ignoreErrors = (options & 2) !== 0
  if (fnNum >= 14) {
    if (args.length < 4) return ERR('#VALUE!')
    const kValue = toNumber(args[args.length - 1])
    if (!kValue.ok) return kValue.error
    return runSubtotalFunction(fnNum, args.slice(2, -1), ignoreErrors, kValue.value)
  }
  return runSubtotalFunction(fnNum, args.slice(2), ignoreErrors)
}

/** SQRTPI(n) — sqrt(n * π). */
export const SQRTPI: FunctionImpl = (args) => unaryNumber(args, (n) => {
  if (n < 0) return Number.NaN
  return Math.sqrt(n * Math.PI)
})

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
  // Wave F / F1 additions
  CEILING,
  FLOOR,
  TRUNC,
  SUMPRODUCT,
  PRODUCT,
  // Phase 8 additions
  SIN,
  COS,
  TAN,
  ASIN,
  ACOS,
  ATAN,
  ATAN2,
  SINH,
  COSH,
  TANH,
  ASINH,
  ACOSH,
  ATANH,
  CSC,
  SEC,
  COT,
  CSCH,
  SECH,
  COTH,
  ACSC,
  ASEC,
  ACOT,
  ACOTH,
  RADIANS,
  DEGREES,
  EXP,
  LN,
  LOG,
  LOG10,
  PI,
  RAND,
  RANDBETWEEN,
  MROUND,
  QUOTIENT,
  EVEN,
  ODD,
  'FLOOR.MATH': FLOOR_MATH,
  'CEILING.MATH': CEILING_MATH,
  'FLOOR.PRECISE': FLOOR_PRECISE,
  'CEILING.PRECISE': CEILING_PRECISE,
  'ISO.CEILING': ISO_CEILING,
  FACT,
  FACTDOUBLE,
  COMBIN,
  PERMUT,
  COMBINA,
  PERMUTATIONA,
  MULTINOMIAL,
  BASE,
  DECIMAL,
  SUMX2MY2,
  SUMX2PY2,
  SUMXMY2,
  MUNIT,
  MMULT,
  MDETERM,
  MINVERSE,
  GCD,
  LCM,
  COUNTBLANK,
  SUMSQ,
  SERIESSUM,
  SUBTOTAL,
  AGGREGATE,
  SQRTPI,
}
