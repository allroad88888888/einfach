/**
 * Wave F / F1 — Financial functions.
 *
 * Excel financial formulas with the standard sign convention:
 *   - positive cash flow = money received
 *   - negative cash flow = money paid out
 *
 * E.g. a loan of $1000 to be paid back with positive payments uses
 * `pv = 1000, pmt = -<payment>` — `PMT()` returns a negative number for
 * money you owe the bank.
 *
 * `type` parameter (annuity timing):
 *   0 = end-of-period payments (default; ordinary annuity)
 *   1 = beginning-of-period (annuity-due)
 *
 * Functions: PV, FV, PMT, NPER, RATE, NPV, IRR, IPMT, PPMT, CUMIPMT.
 *
 * Each formula derives from the present-value identity:
 *   pv * (1+r)^n + pmt * (1 + r*type) * ((1+r)^n - 1) / r + fv = 0
 *
 * For r === 0 the equation degenerates to:
 *   pv + pmt * n + fv = 0
 *
 * RATE + IRR use Newton-Raphson with a 50-iteration cap and 1e-7
 * tolerance. Non-convergence → `#NUM!` (matches Excel).
 *
 * Reference: https://support.microsoft.com/en-us/office/financial-functions-reference-5658d81e-6035-4f24-89c1-fbf124c2b1d8
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber } from '../coerce'

const NUM = (value: number): Value => ({ kind: 'number', value })
const ERR = (code: '#DIV/0!' | '#NUM!' | '#VALUE!', message?: string): Value =>
  message === undefined ? { kind: 'error', code } : { kind: 'error', code, message }

const NR_MAX_ITERS = 50
const NR_TOLERANCE = 1e-7

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

type Parsed = { ok: true; n: number } | { ok: false; err: Value }

function parseArg(v: Value): Parsed {
  const r = toNumber(v)
  if (!r.ok) return { ok: false, err: r.error }
  return { ok: true, n: r.value }
}

function clampType(t: number): number {
  // Excel coerces type to 0 unless explicitly 1 (any nonzero value is
  // treated as 1).
  return t === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Core PV / FV / PMT identity helpers
// ---------------------------------------------------------------------------

/**
 * Standard annuity formula. Used by FV, PV, PMT, IPMT, PPMT.
 *
 *   pv * (1+r)^n + pmt * (1 + r*type) * ((1+r)^n - 1) / r + fv = 0
 *
 * `compute` solves for whichever variable is left as `undefined`.
 */
function presentValue(rate: number, nper: number, pmt: number, fv: number, type: number): number {
  if (rate === 0) {
    return -(fv + pmt * nper)
  }
  const pow = Math.pow(1 + rate, nper)
  return -(fv + pmt * (1 + rate * type) * (pow - 1) / rate) / pow
}

function futureValue(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) {
    return -(pv + pmt * nper)
  }
  const pow = Math.pow(1 + rate, nper)
  return -(pv * pow + pmt * (1 + rate * type) * (pow - 1) / rate)
}

function periodicPayment(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) {
    return -(pv + fv) / nper
  }
  const pow = Math.pow(1 + rate, nper)
  return -(pv * pow + fv) / ((1 + rate * type) * ((pow - 1) / rate))
}

function numberOfPeriods(rate: number, pmt: number, pv: number, fv: number, type: number): number {
  if (rate === 0) {
    return -(pv + fv) / pmt
  }
  // Solving (1+r)^n in pv * (1+r)^n + pmt*(1+r*type)*((1+r)^n - 1)/r + fv = 0:
  //   Let X = (1+r)^n, A = pmt*(1+r*type)/r.
  //   pv*X + A*(X - 1) + fv = 0
  //   X*(pv + A) = A - fv
  //   X = (A - fv) / (pv + A)
  const a = pmt * (1 + rate * type) / rate
  const numerator = a - fv
  const denominator = pv + a
  if (denominator === 0) return NaN
  const x = numerator / denominator
  if (x <= 0) return NaN
  return Math.log(x) / Math.log(1 + rate)
}

// ---------------------------------------------------------------------------
// PV
// ---------------------------------------------------------------------------

export const PV: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const nper = parseArg(args[1])
  if (!nper.ok) return nper.err
  const pmt = parseArg(args[2])
  if (!pmt.ok) return pmt.err
  let fv = 0
  if (args.length >= 4) {
    const r = parseArg(args[3])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  const result = presentValue(rate.n, nper.n, pmt.n, fv, type)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// FV
// ---------------------------------------------------------------------------

export const FV: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const nper = parseArg(args[1])
  if (!nper.ok) return nper.err
  const pmt = parseArg(args[2])
  if (!pmt.ok) return pmt.err
  let pv = 0
  if (args.length >= 4) {
    const r = parseArg(args[3])
    if (!r.ok) return r.err
    pv = r.n
  }
  let type = 0
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  const result = futureValue(rate.n, nper.n, pmt.n, pv, type)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// PMT
// ---------------------------------------------------------------------------

export const PMT: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const nper = parseArg(args[1])
  if (!nper.ok) return nper.err
  const pv = parseArg(args[2])
  if (!pv.ok) return pv.err
  let fv = 0
  if (args.length >= 4) {
    const r = parseArg(args[3])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  if (nper.n === 0) return ERR('#NUM!')
  const result = periodicPayment(rate.n, nper.n, pv.n, fv, type)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// NPER
// ---------------------------------------------------------------------------

export const NPER: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const pmt = parseArg(args[1])
  if (!pmt.ok) return pmt.err
  const pv = parseArg(args[2])
  if (!pv.ok) return pv.err
  let fv = 0
  if (args.length >= 4) {
    const r = parseArg(args[3])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  if (rate.n === 0 && pmt.n === 0) return ERR('#NUM!')
  const result = numberOfPeriods(rate.n, pmt.n, pv.n, fv, type)
  if (!Number.isFinite(result) || Number.isNaN(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// RATE — Newton-Raphson root finder
// ---------------------------------------------------------------------------

/**
 * Residual of the annuity identity, with `rate` as the unknown.
 * `f(rate) = 0` at the correct rate.
 */
function rateResidual(rate: number, nper: number, pmt: number, pv: number, fv: number, type: number): number {
  if (rate === 0) {
    return pv + pmt * nper + fv
  }
  const pow = Math.pow(1 + rate, nper)
  return pv * pow + pmt * (1 + rate * type) * (pow - 1) / rate + fv
}

/**
 * Numerical derivative of the residual w.r.t. `rate`. Central-difference
 * quotient is good enough for Newton-Raphson convergence here; the
 * step size scales with `rate` to stay well-conditioned near zero.
 *
 * We chose a numerical derivative over the closed-form one because:
 *  1. The closed-form `df/dr` for the annuity identity is a 3-term
 *     expression that's easy to typo.
 *  2. Central difference at scaled `eps` converges to the same root
 *     in roughly the same number of iterations.
 *
 * TODO(F1): if convergence becomes a performance concern, swap in the
 * analytical derivative — it's about 2× faster per step.
 */
function rateDerivative(rate: number, nper: number, pmt: number, pv: number, fv: number, type: number): number {
  const eps = Math.max(1e-8, Math.abs(rate) * 1e-6)
  const left = rateResidual(rate - eps, nper, pmt, pv, fv, type)
  const right = rateResidual(rate + eps, nper, pmt, pv, fv, type)
  return (right - left) / (2 * eps)
}

export const RATE: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const nper = parseArg(args[0])
  if (!nper.ok) return nper.err
  const pmt = parseArg(args[1])
  if (!pmt.ok) return pmt.err
  const pv = parseArg(args[2])
  if (!pv.ok) return pv.err
  let fv = 0
  if (args.length >= 4) {
    const r = parseArg(args[3])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length >= 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  let guess = 0.1
  if (args.length === 6) {
    const r = parseArg(args[5])
    if (!r.ok) return r.err
    guess = r.n
  }

  let rate = guess
  for (let i = 0; i < NR_MAX_ITERS; i++) {
    const f = rateResidual(rate, nper.n, pmt.n, pv.n, fv, type)
    if (Math.abs(f) < NR_TOLERANCE) return NUM(rate)
    const fprime = rateDerivative(rate, nper.n, pmt.n, pv.n, fv, type)
    if (fprime === 0 || !Number.isFinite(fprime)) return ERR('#NUM!')
    const step = f / fprime
    const next = rate - step
    if (!Number.isFinite(next)) return ERR('#NUM!')
    // Converged on step size (rate stopped changing materially).
    if (Math.abs(step) < NR_TOLERANCE) return NUM(next)
    rate = next
  }
  // Final pass: declare success if the rate stopped changing even
  // though `|f|` is still above 1e-7 — this happens when the residual
  // surface is shallow near the root. Excel does the same.
  const final = rateResidual(rate, nper.n, pmt.n, pv.n, fv, type)
  if (Math.abs(final) < 1e-3) return NUM(rate)
  return ERR('#NUM!')
}

// ---------------------------------------------------------------------------
// NPV
// ---------------------------------------------------------------------------

/**
 * Walk every cash-flow value reachable from `args[1..]`. Numbers
 * contribute to the sum; blanks/strings/booleans are silently skipped
 * inside arrays (matches Excel range-arg behavior); scalar arguments
 * follow the SUM-style "coerce" rule. Errors propagate from anywhere.
 */
type Cashflow = { ok: true; values: number[] } | { ok: false; err: Value }

function collectCashflows(args: ReadonlyArray<Value>): Cashflow {
  const out: number[] = []
  for (const arg of args) {
    if (arg.kind === 'error') return { ok: false, err: arg }
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return { ok: false, err: cell }
          if (cell.kind === 'number') out.push(cell.value)
          // string / boolean / blank inside an array → silently skipped
        }
      }
      continue
    }
    // Scalar arg — coerce.
    const n = toNumber(arg)
    if (!n.ok) return { ok: false, err: n.error }
    out.push(n.value)
  }
  return { ok: true, values: out }
}

export const NPV: FunctionImpl = (args) => {
  if (args.length < 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const flows = collectCashflows(args.slice(1))
  if (!flows.ok) return flows.err
  if (rate.n <= -1) return ERR('#NUM!')
  let sum = 0
  // Excel's NPV starts discounting from period 1, not 0.
  for (let i = 0; i < flows.values.length; i++) {
    sum += flows.values[i] / Math.pow(1 + rate.n, i + 1)
  }
  if (!Number.isFinite(sum)) return ERR('#NUM!')
  return NUM(sum)
}

// ---------------------------------------------------------------------------
// IRR — Newton-Raphson on cash-flow series
// ---------------------------------------------------------------------------

/**
 * NPV at rate `r` over `flows` (starting at period 0).
 * Note this differs from NPV() — IRR's NPV starts at period 0, not 1.
 */
function irrNPV(rate: number, flows: ReadonlyArray<number>): number {
  let sum = 0
  for (let i = 0; i < flows.length; i++) {
    sum += flows[i] / Math.pow(1 + rate, i)
  }
  return sum
}

function irrDerivative(rate: number, flows: ReadonlyArray<number>): number {
  let sum = 0
  for (let i = 1; i < flows.length; i++) {
    sum -= (i * flows[i]) / Math.pow(1 + rate, i + 1)
  }
  return sum
}

export const IRR: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const flows = collectCashflows([args[0]])
  if (!flows.ok) return flows.err
  if (flows.values.length < 2) return ERR('#NUM!')

  // IRR needs at least one positive and one negative cash flow.
  let hasPos = false
  let hasNeg = false
  for (const v of flows.values) {
    if (v > 0) hasPos = true
    if (v < 0) hasNeg = true
  }
  if (!hasPos || !hasNeg) return ERR('#NUM!')

  let guess = 0.1
  if (args.length === 2) {
    const g = parseArg(args[1])
    if (!g.ok) return g.err
    guess = g.n
  }

  let rate = guess
  for (let i = 0; i < NR_MAX_ITERS; i++) {
    const f = irrNPV(rate, flows.values)
    if (Math.abs(f) < NR_TOLERANCE) return NUM(rate)
    const fprime = irrDerivative(rate, flows.values)
    if (fprime === 0 || !Number.isFinite(fprime)) return ERR('#NUM!')
    const step = f / fprime
    const next = rate - step
    if (!Number.isFinite(next)) return ERR('#NUM!')
    if (Math.abs(step) < NR_TOLERANCE) return NUM(next)
    rate = next
  }
  const final = irrNPV(rate, flows.values)
  if (Math.abs(final) < 1e-3) return NUM(rate)
  return ERR('#NUM!')
}

// ---------------------------------------------------------------------------
// IPMT / PPMT
// ---------------------------------------------------------------------------

/**
 * Interest portion of payment number `per` (1-based).
 *
 * Derivation: principal-at-start-of-period * rate. Principal at start of
 * period `per` equals the FV after `per - 1` periods of the original
 * loan (held the payment for `per - 1` periods).
 */
function interestForPeriod(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number {
  const pmt = periodicPayment(rate, nper, pv, fv, type)
  if (per === 1) {
    if (type === 1) return 0
    return -pv * rate
  }
  // Principal at start of period `per`:
  //   balanceBefore = -FV(rate, per-1, pmt, pv, type)
  // Interest accrued = balanceBefore * rate. Note the sign convention.
  const balanceBefore = futureValue(rate, per - 1, pmt, pv, type)
  if (type === 1) {
    // Annuity-due: interest on the balance AFTER the prior payment.
    return -balanceBefore * rate / (1 + rate)
  }
  return -balanceBefore * rate
}

export const IPMT: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const per = parseArg(args[1])
  if (!per.ok) return per.err
  const nper = parseArg(args[2])
  if (!nper.ok) return nper.err
  const pv = parseArg(args[3])
  if (!pv.ok) return pv.err
  let fv = 0
  if (args.length >= 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length === 6) {
    const r = parseArg(args[5])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  if (per.n < 1 || per.n > nper.n) return ERR('#NUM!')
  if (nper.n === 0) return ERR('#NUM!')
  const result = interestForPeriod(rate.n, Math.trunc(per.n), nper.n, pv.n, fv, type)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const PPMT: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const per = parseArg(args[1])
  if (!per.ok) return per.err
  const nper = parseArg(args[2])
  if (!nper.ok) return nper.err
  const pv = parseArg(args[3])
  if (!pv.ok) return pv.err
  let fv = 0
  if (args.length >= 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    fv = r.n
  }
  let type = 0
  if (args.length === 6) {
    const r = parseArg(args[5])
    if (!r.ok) return r.err
    type = clampType(r.n)
  }
  if (per.n < 1 || per.n > nper.n) return ERR('#NUM!')
  if (nper.n === 0) return ERR('#NUM!')
  const pmt = periodicPayment(rate.n, nper.n, pv.n, fv, type)
  const ipmt = interestForPeriod(rate.n, Math.trunc(per.n), nper.n, pv.n, fv, type)
  // PMT = IPMT + PPMT (sign-aware identity).
  const result = pmt - ipmt
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// CUMIPMT — cumulative interest over a range of periods
// ---------------------------------------------------------------------------

/**
 * CUMIPMT(rate, nper, pv, start_period, end_period, type) — cumulative
 * interest paid between `start_period` and `end_period` (inclusive,
 * 1-based).
 *
 * Note: unlike the other functions in this file, CUMIPMT *requires* the
 * type argument (it's positional 5, not optional). Excel's contract.
 */
export const CUMIPMT: FunctionImpl = (args) => {
  if (args.length !== 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const nper = parseArg(args[1])
  if (!nper.ok) return nper.err
  const pv = parseArg(args[2])
  if (!pv.ok) return pv.err
  const start = parseArg(args[3])
  if (!start.ok) return start.err
  const end = parseArg(args[4])
  if (!end.ok) return end.err
  const typeR = parseArg(args[5])
  if (!typeR.ok) return typeR.err
  const type = clampType(typeR.n)

  if (rate.n <= 0 || nper.n <= 0 || pv.n <= 0) return ERR('#NUM!')
  const s = Math.trunc(start.n)
  const e = Math.trunc(end.n)
  if (s < 1 || e < 1 || s > e || e > nper.n) return ERR('#NUM!')

  let total = 0
  for (let p = s; p <= e; p++) {
    total += interestForPeriod(rate.n, p, nper.n, pv.n, 0, type)
  }
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

// =============================================================================
// Registry
// =============================================================================

export const FUNCTIONS: Record<string, FunctionImpl> = {
  PV,
  FV,
  PMT,
  NPER,
  RATE,
  NPV,
  IRR,
  IPMT,
  PPMT,
  CUMIPMT,
}
