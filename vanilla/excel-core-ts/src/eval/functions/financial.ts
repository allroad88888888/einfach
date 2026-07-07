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
 * Functions: PV, FV, PMT, NPER, RATE, NPV, IRR, IPMT, PPMT, CUMIPMT,
 * SLN, SYD, DB, DDB, VDB, CUMPRINC, EFFECT, NOMINAL, ISPMT, ACCRINT,
 * ACCRINTM, DISC, INTRATE, RECEIVED, DURATION, MDURATION, TBILLEQ,
 * TBILLPRICE, TBILLYIELD, DOLLARDE, DOLLARFR, COUPDAYBS, COUPDAYS,
 * COUPDAYSNC, COUPNCD, COUPNUM, COUPPCD, PRICE, PRICEDISC, PRICEMAT,
 * YIELD, YIELDDISC, YIELDMAT, ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD,
 * AMORDEGRC, AMORLINC, XIRR, XNPV, MIRR, PDURATION, RRI, FVSCHEDULE.
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
const RATE_RESIDUAL_REL_TOLERANCE = NR_TOLERANCE
const RATE_ZERO_RESIDUAL_REL_TOLERANCE = Number.EPSILON * 1024
const CASHFLOW_RESIDUAL_REL_TOLERANCE = 1e-10
const XIRR_MAX_ITERS = 100
const BOND_MAX_ITERS = 100

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

type Parsed = { ok: true; n: number } | { ok: false; err: Value }

function parseArg(v: Value): Parsed {
  const r = toNumber(v)
  if (!r.ok) return { ok: false, err: r.error }
  return { ok: true, n: r.value }
}

function parseTypeArg(v: Value): Parsed {
  const parsed = parseArg(v)
  if (!parsed.ok) return parsed
  const type = Math.trunc(parsed.n)
  return type === 0 || type === 1 ? { ok: true, n: type } : { ok: false, err: ERR('#VALUE!') }
}

function annuityCompound(rate: number, nper: number): number {
  if (rate === 0) return nper
  return (Math.pow(1 + rate, nper) - 1) / rate
}

function residualConverged(
  residual: number,
  scale: number,
  tolerance = CASHFLOW_RESIDUAL_REL_TOLERANCE,
): boolean {
  if (!Number.isFinite(residual) || !Number.isFinite(scale)) return false
  // Harvey P2 — floor the scale at 1 so tiny-cashflow inputs (where the
  // natural |scale| ≪ 1) don't get a sub-machine-epsilon tolerance threshold.
  // Without the floor, RATE/IRR/XIRR can accept a stuck-Newton step whose
  // residual is still significant relative to the cashflow scale. With the
  // floor, the threshold is `max(|scale|, 1) * tolerance` — Excel's behavior.
  const effectiveScale = Math.max(Math.abs(scale), 1)
  return Math.abs(residual) <= effectiveScale * tolerance
}

function rateResidualConverged(residual: number, scale: number): boolean {
  if (!Number.isFinite(residual) || !Number.isFinite(scale)) return false
  const absScale = Math.abs(scale)
  const relativeTolerance = absScale * RATE_RESIDUAL_REL_TOLERANCE
  const numericTolerance = Math.max(absScale, 1) * RATE_ZERO_RESIDUAL_REL_TOLERANCE
  return Math.abs(residual) <= Math.max(relativeTolerance, numericTolerance)
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
    const r = parseTypeArg(args[4])
    if (!r.ok) return r.err
    type = r.n
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
    const r = parseTypeArg(args[4])
    if (!r.ok) return r.err
    type = r.n
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
    const r = parseTypeArg(args[4])
    if (!r.ok) return r.err
    type = r.n
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
    const r = parseTypeArg(args[4])
    if (!r.ok) return r.err
    type = r.n
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

function rateResidualScale(
  rate: number,
  nper: number,
  pmt: number,
  pv: number,
  fv: number,
  type: number,
): number {
  if (rate === 0) {
    return Math.abs(pv) + Math.abs(pmt * nper) + Math.abs(fv)
  }
  const pow = Math.pow(1 + rate, nper)
  const pmtTerm = pmt * (1 + rate * type) * (pow - 1) / rate
  return Math.abs(pv * pow) + Math.abs(pmtTerm) + Math.abs(fv)
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
    const r = parseTypeArg(args[4])
    if (!r.ok) return r.err
    type = r.n
  }
  let guess = 0.1
  if (args.length === 6) {
    const r = parseArg(args[5])
    if (!r.ok) return r.err
    guess = r.n
  }

  const zeroResidual = rateResidual(0, nper.n, pmt.n, pv.n, fv, type)
  const zeroScale = rateResidualScale(0, nper.n, pmt.n, pv.n, fv, type)
  if ((args.length < 6 || guess === 0.1) && rateResidualConverged(zeroResidual, zeroScale)) {
    return NUM(0)
  }

  let rate = guess
  for (let i = 0; i < NR_MAX_ITERS; i++) {
    const f = rateResidual(rate, nper.n, pmt.n, pv.n, fv, type)
    const scale = rateResidualScale(rate, nper.n, pmt.n, pv.n, fv, type)
    if (rateResidualConverged(f, scale)) return NUM(rate)
    const fprime = rateDerivative(rate, nper.n, pmt.n, pv.n, fv, type)
    if (fprime === 0 || !Number.isFinite(fprime)) return ERR('#NUM!')
    const step = f / fprime
    const next = rate - step
    if (!Number.isFinite(next)) return ERR('#NUM!')
    // Converged on step size (rate stopped changing materially).
    if (Math.abs(step) < NR_TOLERANCE) {
      const nextResidual = rateResidual(next, nper.n, pmt.n, pv.n, fv, type)
      const nextScale = rateResidualScale(next, nper.n, pmt.n, pv.n, fv, type)
      return rateResidualConverged(nextResidual, nextScale)
        ? NUM(next)
        : ERR('#NUM!')
    }
    rate = next
  }
  // Final pass: declare success if the rate stopped changing even
  // though `|f|` is still above 1e-7 — this happens when the residual
  // surface is shallow near the root. Excel does the same.
  const final = rateResidual(rate, nper.n, pmt.n, pv.n, fv, type)
  const finalScale = rateResidualScale(rate, nper.n, pmt.n, pv.n, fv, type)
  if (rateResidualConverged(final, finalScale)) return NUM(rate)
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

function irrNPVScale(rate: number, flows: ReadonlyArray<number>): number {
  let sum = 0
  for (let i = 0; i < flows.length; i++) {
    sum += Math.abs(flows[i] / Math.pow(1 + rate, i))
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
    if (residualConverged(f, irrNPVScale(rate, flows.values))) return NUM(rate)
    const fprime = irrDerivative(rate, flows.values)
    if (fprime === 0 || !Number.isFinite(fprime)) return ERR('#NUM!')
    const step = f / fprime
    const next = rate - step
    if (!Number.isFinite(next)) return ERR('#NUM!')
    if (Math.abs(step) < NR_TOLERANCE) {
      const nextResidual = irrNPV(next, flows.values)
      return residualConverged(nextResidual, irrNPVScale(next, flows.values))
        ? NUM(next)
        : ERR('#NUM!')
    }
    rate = next
  }
  const final = irrNPV(rate, flows.values)
  if (residualConverged(final, irrNPVScale(rate, flows.values))) return NUM(rate)
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
  if (type === 1 && per === 1) return 0
  if (rate === 0) return 0
  const k = type === 1 ? per - 2 : per - 1
  const balance = pv * Math.pow(1 + rate, k) + pmt * annuityCompound(rate, k)
  return -balance * rate
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
    const r = parseTypeArg(args[5])
    if (!r.ok) return r.err
    type = r.n
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
    const r = parseTypeArg(args[5])
    if (!r.ok) return r.err
    type = r.n
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
  const typeR = parseTypeArg(args[5])
  if (!typeR.ok) return typeR.err
  const type = typeR.n

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

// ---------------------------------------------------------------------------
// Straight-line / accelerated depreciation
// ---------------------------------------------------------------------------

export const SLN: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const salvage = parseArg(args[1])
  if (!salvage.ok) return salvage.err
  const life = parseArg(args[2])
  if (!life.ok) return life.err
  if (life.n <= 0) return ERR('#DIV/0!')
  const result = (cost.n - salvage.n) / life.n
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const SYD: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const salvage = parseArg(args[1])
  if (!salvage.ok) return salvage.err
  const life = parseArg(args[2])
  if (!life.ok) return life.err
  const per = parseArg(args[3])
  if (!per.ok) return per.err
  if (life.n <= 0 || per.n < 1 || per.n > life.n) return ERR('#NUM!')
  const result = (cost.n - salvage.n) * (life.n - per.n + 1) * 2 / (life.n * (life.n + 1))
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const DB: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const salvage = parseArg(args[1])
  if (!salvage.ok) return salvage.err
  const life = parseArg(args[2])
  if (!life.ok) return life.err
  const period = parseArg(args[3])
  if (!period.ok) return period.err
  let month = 12
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    month = Math.trunc(r.n)
  }
  if (life.n <= 0 || period.n < 1 || month < 1 || month > 12) return ERR('#NUM!')
  if (cost.n === 0) return NUM(0)
  if (salvage.n < 0 || cost.n < 0 || (cost.n > 0 && salvage.n > cost.n)) return ERR('#NUM!')

  const rawRate = salvage.n === 0 ? 1 : 1 - Math.pow(salvage.n / cost.n, 1 / life.n)
  const rate = Math.round(rawRate * 1000) / 1000
  const lifeI = Math.trunc(life.n)
  const perI = Math.trunc(period.n)
  if (perI > lifeI + 1) return ERR('#NUM!')

  let total = 0
  let lastDep = 0
  const lastPeriod = Math.min(perI, lifeI + 1)
  for (let k = 1; k <= lastPeriod; k++) {
    const dep = k === 1
      ? cost.n * rate * month / 12
      : k === life.n + 1
        ? (cost.n - total) * rate * (12 - month) / 12
        : (cost.n - total) * rate
    lastDep = dep
    total += dep
  }
  if (!Number.isFinite(lastDep)) return ERR('#NUM!')
  return NUM(lastDep)
}

function ddbPeriod(cost: number, salvage: number, life: number, period: number, factor: number): number {
  const rate = factor / life
  let prior = 0
  const pInt = Math.floor(period)
  for (let k = 1; k < pInt; k++) {
    const dep = Math.max(Math.min((cost - prior) * rate, cost - salvage - prior), 0)
    prior += dep
  }
  return Math.max(Math.min((cost - prior) * rate, cost - salvage - prior), 0)
}

export const DDB: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const salvage = parseArg(args[1])
  if (!salvage.ok) return salvage.err
  const life = parseArg(args[2])
  if (!life.ok) return life.err
  const period = parseArg(args[3])
  if (!period.ok) return period.err
  let factor = 2
  if (args.length === 5) {
    const r = parseArg(args[4])
    if (!r.ok) return r.err
    factor = r.n
  }
  if (cost.n < 0 || salvage.n < 0 || life.n <= 0 || period.n < 1 || factor <= 0) {
    return ERR('#NUM!')
  }
  if (period.n > life.n + 1) return ERR('#NUM!')
  const result = ddbPeriod(cost.n, salvage.n, life.n, period.n, factor)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const VDB: FunctionImpl = (args) => {
  if (args.length < 5 || args.length > 7) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const salvage = parseArg(args[1])
  if (!salvage.ok) return salvage.err
  const life = parseArg(args[2])
  if (!life.ok) return life.err
  const start = parseArg(args[3])
  if (!start.ok) return start.err
  const end = parseArg(args[4])
  if (!end.ok) return end.err
  let factor = 2
  if (args.length >= 6) {
    const r = parseArg(args[5])
    if (!r.ok) return r.err
    factor = r.n
  }
  let noSwitch = false
  if (args.length === 7) {
    const r = parseArg(args[6])
    if (!r.ok) return r.err
    noSwitch = r.n !== 0
  }
  if (cost.n < 0 || salvage.n < 0 || life.n <= 0 || factor <= 0) return ERR('#NUM!')
  if (start.n < 0 || end.n < start.n || end.n > life.n) return ERR('#NUM!')

  const rate = factor / life.n
  const lifeI = Math.ceil(life.n)
  let prior = 0
  let switched = false
  const perDep: number[] = []
  for (let k = 1; k <= lifeI; k++) {
    const ddbDep = Math.max(Math.min((cost.n - prior) * rate, cost.n - salvage.n - prior), 0)
    let dep = ddbDep
    if (!noSwitch) {
      const remainingPeriods = life.n - (k - 1)
      const slDep = remainingPeriods > 0
        ? Math.max((cost.n - salvage.n - prior) / remainingPeriods, 0)
        : 0
      if (switched || slDep > ddbDep) {
        switched = true
        dep = slDep
      }
    }
    perDep.push(dep)
    prior += dep
  }

  let total = 0
  const sFloor = Math.floor(start.n)
  const eCeil = Math.ceil(end.n)
  for (let k = Math.max(sFloor + 1, 1); k <= Math.min(eCeil, lifeI); k++) {
    const idx = k - 1
    const periodStart = k - 1
    const periodEnd = k
    const sliceStart = Math.max(start.n, periodStart)
    const sliceEnd = Math.min(end.n, periodEnd)
    if (sliceEnd > sliceStart) {
      total += perDep[idx] * (sliceEnd - sliceStart) / (periodEnd - periodStart)
    }
  }
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

function amordegrcCoefficient(life: number): number {
  if (life > 6) return 2.5
  if (life > 4) return 2
  if (life > 3) return 1.5
  return 1
}

export const AMORDEGRC: FunctionImpl = (args) => {
  if (args.length < 6 || args.length > 7) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const purchased = parseArg(args[1])
  if (!purchased.ok) return purchased.err
  const firstPeriod = parseArg(args[2])
  if (!firstPeriod.ok) return firstPeriod.err
  const salvage = parseArg(args[3])
  if (!salvage.ok) return salvage.err
  const period = parseArg(args[4])
  if (!period.ok) return period.err
  const rate = parseArg(args[5])
  if (!rate.ok) return rate.err
  const basis = parseBasis(args, 6)
  if (!basis.ok) return basis.err

  const p = Math.trunc(period.n)
  if (
    cost.n <= 0 ||
    salvage.n < 0 ||
    salvage.n >= cost.n ||
    p < 0 ||
    rate.n <= 0 ||
    rate.n >= 1 ||
    purchased.n > firstPeriod.n
  ) {
    return ERR('#NUM!')
  }

  const life = 1 / rate.n
  const ddbRate = rate.n * amordegrcCoefficient(life)
  const lastPeriod = Math.ceil(life)
  if (p > lastPeriod) return NUM(0)

  const firstFrac = yearFracBasis(purchased.n, firstPeriod.n, basis.basis)
  const maxTotal = cost.n - salvage.n
  const firstDep = Math.max(Math.min(Math.round(cost.n * ddbRate * firstFrac), maxTotal), 0)
  if (p === 0) return finiteNumber(firstDep)

  let book = cost.n - firstDep
  let lastDep = firstDep
  for (let k = 1; k <= p; k += 1) {
    if (k === lastPeriod) {
      const remaining = Math.max(book - salvage.n, 0)
      lastDep = Math.max(Math.min(remaining * 1.5, remaining), 0)
      break
    }
    const ddbDep = Math.round(book * ddbRate)
    const remainingPeriods = Math.max(lastPeriod - k, 1)
    const slDep = Math.round((book - salvage.n) / remainingPeriods)
    let dep = slDep > ddbDep ? slDep : ddbDep
    dep = Math.max(Math.min(dep, Math.max(book - salvage.n, 0)), 0)
    lastDep = dep
    book -= dep
    if (book <= salvage.n) {
      if (k < p) lastDep = 0
      break
    }
  }

  return finiteNumber(lastDep)
}

export const AMORLINC: FunctionImpl = (args) => {
  if (args.length < 6 || args.length > 7) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const cost = parseArg(args[0])
  if (!cost.ok) return cost.err
  const purchased = parseArg(args[1])
  if (!purchased.ok) return purchased.err
  const firstPeriod = parseArg(args[2])
  if (!firstPeriod.ok) return firstPeriod.err
  const salvage = parseArg(args[3])
  if (!salvage.ok) return salvage.err
  const period = parseArg(args[4])
  if (!period.ok) return period.err
  const rate = parseArg(args[5])
  if (!rate.ok) return rate.err
  const basis = parseBasis(args, 6)
  if (!basis.ok) return basis.err

  const p = Math.trunc(period.n)
  if (cost.n <= 0 || rate.n <= 0 || p < 0 || salvage.n < 0 || salvage.n >= cost.n) {
    return ERR('#NUM!')
  }

  const firstFrac = yearFracBasis(purchased.n, firstPeriod.n, basis.basis)
  const annual = cost.n * rate.n
  const firstDep = Math.max(Math.min(Math.round(cost.n * rate.n * firstFrac), cost.n - salvage.n), 0)
  if (p === 0) return finiteNumber(firstDep)

  let book = cost.n - firstDep
  let lastDep = firstDep
  for (let k = 1; k <= p; k += 1) {
    if (book <= salvage.n) {
      lastDep = 0
      break
    }
    const dep = Math.max(Math.min(annual, book - salvage.n), 0)
    lastDep = dep
    book -= dep
  }

  return finiteNumber(lastDep)
}

// ---------------------------------------------------------------------------
// Additional financial aggregates and rates
// ---------------------------------------------------------------------------

export const CUMPRINC: FunctionImpl = (args) => {
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
  const typeR = parseTypeArg(args[5])
  if (!typeR.ok) return typeR.err
  const type = typeR.n

  if (rate.n <= 0 || nper.n <= 0 || pv.n <= 0) return ERR('#NUM!')
  const s = Math.trunc(start.n)
  const e = Math.trunc(end.n)
  if (s < 1 || e < 1 || s > e || e > nper.n) return ERR('#NUM!')

  const pmt = periodicPayment(rate.n, nper.n, pv.n, 0, type)
  if (!Number.isFinite(pmt)) return ERR('#NUM!')
  let total = 0
  for (let p = s; p <= e; p++) {
    total += pmt - interestForPeriod(rate.n, p, nper.n, pv.n, 0, type)
  }
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

export const EFFECT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const nominal = parseArg(args[0])
  if (!nominal.ok) return nominal.err
  const npery = parseArg(args[1])
  if (!npery.ok) return npery.err
  const n = Math.trunc(npery.n)
  if (nominal.n <= 0 || n < 1) return ERR('#NUM!')
  const result = Math.pow(1 + nominal.n / n, n) - 1
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const NOMINAL: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const effect = parseArg(args[0])
  if (!effect.ok) return effect.err
  const npery = parseArg(args[1])
  if (!npery.ok) return npery.err
  const n = Math.trunc(npery.n)
  if (effect.n <= 0 || n < 1) return ERR('#NUM!')
  const result = (Math.pow(1 + effect.n, 1 / n) - 1) * n
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const ISPMT: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR('#VALUE!')
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
  if (nper.n === 0) return ERR('#DIV/0!')
  const result = -pv.n * rate.n * (1 - per.n / nper.n)
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// Bond day-count helpers
// ---------------------------------------------------------------------------

type ParsedBasis = { ok: true; basis: number } | { ok: false; err: Value }
type ParsedFrequency = { ok: true; frequency: number } | { ok: false; err: Value }
type DateParts = { year: number; month: number; day: number }
type CouponSplit = { a: number; dsc: number; e: number }

const DATE_MS_PER_DAY = 86_400_000
const EXCEL_ANCHOR_UTC_MS = Date.UTC(1899, 11, 31)

function parseBasis(args: Value[], index: number): ParsedBasis {
  if (args.length <= index) return { ok: true, basis: 0 }
  const basis = parseArg(args[index])
  if (!basis.ok) return { ok: false, err: basis.err }
  // Harvey P2 — Excel returns `#NUM!` (not `#VALUE!`) for invalid basis, and
  // it rejects fractional / out-of-range values rather than silently truncating.
  if (!Number.isFinite(basis.n)) return { ok: false, err: ERR('#NUM!') }
  if (basis.n < 0 || basis.n >= 5) return { ok: false, err: ERR('#NUM!') }
  if (!Number.isInteger(basis.n)) return { ok: false, err: ERR('#NUM!') }
  return { ok: true, basis: basis.n }
}

function parseFrequency(value: Value): ParsedFrequency {
  const frequency = parseArg(value)
  if (!frequency.ok) return { ok: false, err: frequency.err }
  const normalized = Math.trunc(frequency.n)
  if (normalized !== 1 && normalized !== 2 && normalized !== 4) {
    return { ok: false, err: ERR('#NUM!') }
  }
  return { ok: true, frequency: normalized }
}

function serialDateToParts(serial: number): DateParts {
  const whole = Math.floor(serial)
  if (whole === 60) return { year: 1900, month: 2, day: 29 }
  const realDays = whole > 60 ? whole - 1 : whole
  const date = new Date(EXCEL_ANCHOR_UTC_MS + realDays * DATE_MS_PER_DAY)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

function serialFromDateParts(year: number, month: number, day: number): number {
  if (year === 1900 && month === 2 && day === 29) return 60
  const ms = Date.UTC(year, month - 1, day)
  const realDays = Math.floor((ms - EXCEL_ANCHOR_UTC_MS) / DATE_MS_PER_DAY)
  return realDays >= 60 ? realDays + 1 : realDays
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function daysInYear(year: number): number {
  return Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1) === 366 * DATE_MS_PER_DAY ? 366 : 365
}

function dayDiff(start: number, end: number): number {
  return Math.floor(end) - Math.floor(start)
}

function yearFracActualActual(start: number, end: number): number {
  const startParts = serialDateToParts(start)
  const endParts = serialDateToParts(end)
  let yearLength: number
  if (isGreaterThanOneYear(startParts, endParts)) {
    yearLength = averageYearLength(startParts.year, endParts.year)
  } else if (shouldCountFeb29(startParts, endParts)) {
    yearLength = 366
  } else {
    yearLength = 365
  }
  return (end - start) / yearLength
}

function averageYearLength(startYear: number, endYear: number): number {
  let days = 0
  for (let year = startYear; year <= endYear; year += 1) {
    days += daysInYear(year)
  }
  return days / (endYear - startYear + 1)
}

function isGreaterThanOneYear(
  start: ReturnType<typeof serialDateToParts>,
  end: ReturnType<typeof serialDateToParts>,
): boolean {
  if (start.year === end.year) return false
  if (start.year + 1 !== end.year) return true
  if (start.month > end.month) return false
  if (start.month < end.month) return true
  return start.day < end.day
}

function shouldCountFeb29(
  start: ReturnType<typeof serialDateToParts>,
  end: ReturnType<typeof serialDateToParts>,
): boolean {
  if (daysInYear(start.year) === 366) {
    if (start.year === end.year) return true
    return start.month <= 2
  }
  if (daysInYear(end.year) === 366) {
    if (end.month === 1) return false
    if (end.month === 2) return end.day === 29
    return true
  }
  return false
}

function isLastDayOfFeb(parts: { year: number; month: number; day: number }): boolean {
  if (parts.month !== 2) return false
  const lastDay = daysInYear(parts.year) === 366 ? 29 : 28
  return parts.day === lastDay
}

function yearFracBasis(start: number, end: number, basis: number): number {
  const lo = Math.floor(Math.min(start, end))
  const hi = Math.floor(Math.max(start, end))
  switch (basis) {
    case 0: {
      // Harvey P2 — Excel NASD 30/360 (basis 0) full rule:
      //   1. If start is last day of Feb AND end is last day of Feb, set end_day = 30.
      //   2. If start is last day of Feb, set start_day = 30.
      //   3. If start_day = 31, set start_day = 30.
      //   4. If end_day = 31 AND start_day (after step 3) = 30, set end_day = 30.
      const startParts = serialDateToParts(lo)
      const endParts = serialDateToParts(hi)
      let d1 = startParts.day
      let d2 = endParts.day
      if (isLastDayOfFeb(startParts)) {
        if (isLastDayOfFeb(endParts)) d2 = 30
        d1 = 30
      }
      if (d1 === 31) d1 = 30
      if (d1 === 30 && d2 === 31) d2 = 30
      const numerator =
        (endParts.year - startParts.year) * 360 +
        (endParts.month - startParts.month) * 30 +
        (d2 - d1)
      return numerator / 360
    }
    case 4: {
      // European 30/360 (basis 4): day-31 → 30 on both ends, no Feb EOM.
      const startParts = serialDateToParts(lo)
      const endParts = serialDateToParts(hi)
      const d1 = startParts.day === 31 ? 30 : startParts.day
      const d2 = endParts.day === 31 ? 30 : endParts.day
      const numerator =
        (endParts.year - startParts.year) * 360 +
        (endParts.month - startParts.month) * 30 +
        (d2 - d1)
      return numerator / 360
    }
    case 1:
      return yearFracActualActual(lo, hi)
    case 3:
      return (hi - lo) / 365
    case 2:
      return (hi - lo) / 360
    default:
      return Number.NaN
  }
}

function couponPeriodDays(frequency: number, basis: number): number {
  switch (basis) {
    case 0:
    case 2:
    case 4:
      return 360 / frequency
    case 3:
      return 365 / frequency
    case 1:
      return 365.25 / frequency
    default:
      return Number.NaN
  }
}

function couponDateFromMaturity(maturity: number, monthsOffset: number): number {
  const maturityParts = serialDateToParts(maturity)
  const monthIndex = maturityParts.year * 12 + (maturityParts.month - 1) + monthsOffset
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12 + 1
  const day = Math.min(maturityParts.day, daysInMonth(year, month))
  return serialFromDateParts(year, month, day)
}

function prevCouponDate(settlement: number, maturity: number, frequency: number): number {
  const monthsPerPeriod = 12 / frequency
  let periodsBack = 0
  while (periodsBack <= 4_000) {
    const serial = couponDateFromMaturity(maturity, -periodsBack * monthsPerPeriod)
    if (serial <= settlement) return serial
    periodsBack += 1
  }
  return couponDateFromMaturity(maturity, -periodsBack * monthsPerPeriod)
}

function nextCouponDate(settlement: number, maturity: number, frequency: number): number {
  const prev = prevCouponDate(settlement, maturity, frequency)
  const prevParts = serialDateToParts(prev)
  const monthsPerPeriod = 12 / frequency
  const monthIndex = prevParts.year * 12 + (prevParts.month - 1) + monthsPerPeriod
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12 + 1
  const day = Math.min(prevParts.day, daysInMonth(year, month))
  return serialFromDateParts(year, month, day)
}

function couponNumber(settlement: number, maturity: number, frequency: number): number {
  const monthsPerPeriod = 12 / frequency
  const settlementParts = serialDateToParts(settlement)
  const maturityParts = serialDateToParts(maturity)
  const monthsBetween =
    maturityParts.year * 12 +
    (maturityParts.month - 1) -
    (settlementParts.year * 12 + settlementParts.month - 1)
  return Math.max(Math.ceil(monthsBetween / monthsPerPeriod), 1)
}

function couponPeriodSplit(
  settlement: number,
  maturity: number,
  frequency: number,
  basis: number,
): CouponSplit {
  const previous = prevCouponDate(settlement, maturity, frequency)
  const next = nextCouponDate(settlement, maturity, frequency)
  const realPeriodDays = Math.max(dayDiff(previous, next), 1)
  const canonicalPeriodDays = couponPeriodDays(frequency, basis)
  const realA = Math.max(dayDiff(previous, settlement), 0)
  const realDsc = Math.max(dayDiff(settlement, next), 0)
  if (basis === 0 || basis === 2 || basis === 4) {
    const fraction = realPeriodDays > 0 ? realA / realPeriodDays : 0
    const a = canonicalPeriodDays * fraction
    return { a, dsc: canonicalPeriodDays - a, e: canonicalPeriodDays }
  }
  return { a: realA, dsc: realDsc, e: realPeriodDays }
}

function macaulayDuration(
  settlement: number,
  maturity: number,
  coupon: number,
  yld: number,
  frequency: number,
  basis: number,
): number {
  const { dsc, e } = couponPeriodSplit(settlement, maturity, frequency, basis)
  if (!Number.isFinite(e) || e <= 0) return Number.NaN
  const dscE = dsc / e
  const couponCount = couponNumber(settlement, maturity, frequency)
  const periodicCoupon = 100 * coupon / frequency
  const redemption = 100
  const onePlus = 1 + yld / frequency
  if (onePlus <= 0) return Number.NaN

  let weighted = 0
  let pvTotal = 0
  for (let k = 1; k <= couponCount; k += 1) {
    const periods = k - 1 + dscE
    const years = periods / frequency
    const pv = periodicCoupon / Math.pow(onePlus, periods)
    weighted += years * pv
    pvTotal += pv
  }

  const redemptionPeriods = couponCount - 1 + dscE
  const redemptionYears = redemptionPeriods / frequency
  const redemptionPv = redemption / Math.pow(onePlus, redemptionPeriods)
  weighted += redemptionYears * redemptionPv
  pvTotal += redemptionPv
  if (pvTotal === 0 || !Number.isFinite(pvTotal)) return Number.NaN
  return weighted / pvTotal
}

function priceFromYield(
  settlement: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): number {
  const { a, dsc, e } = couponPeriodSplit(settlement, maturity, frequency, basis)
  if (!Number.isFinite(e) || e <= 0) return Number.NaN
  const n = couponNumber(settlement, maturity, frequency)
  const dscE = Math.max(dsc / e, 0)
  const coupon = 100 * rate / frequency
  const onePlus = 1 + yld / frequency
  if (onePlus <= 0) return Number.NaN

  let couponsPv = 0
  const nInt = Math.trunc(n)
  for (let k = 1; k <= nInt; k += 1) {
    couponsPv += coupon / Math.pow(onePlus, k - 1 + dscE)
  }
  const redemptionPv = redemption / Math.pow(onePlus, n - 1 + dscE)
  const accrued = coupon * a / e
  return redemptionPv + couponsPv - accrued
}

function finiteNumber(value: number): Value {
  if (!Number.isFinite(value)) return ERR('#NUM!')
  return NUM(value)
}

function parseSettlementMaturityFrequencyBasis(
  args: Value[],
): { ok: true; settlement: number; maturity: number; frequency: number; basis: number } |
  { ok: false; err: Value } {
  const settlement = parseArg(args[0])
  if (!settlement.ok) return { ok: false, err: settlement.err }
  const maturity = parseArg(args[1])
  if (!maturity.ok) return { ok: false, err: maturity.err }
  const frequency = parseFrequency(args[2])
  if (!frequency.ok) return { ok: false, err: frequency.err }
  const basis = parseBasis(args, 3)
  if (!basis.ok) return { ok: false, err: basis.err }
  if (settlement.n >= maturity.n) return { ok: false, err: ERR('#NUM!') }
  return {
    ok: true,
    settlement: settlement.n,
    maturity: maturity.n,
    frequency: frequency.frequency,
    basis: basis.basis,
  }
}

export const DOLLARDE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const fracDollar = parseArg(args[0])
  if (!fracDollar.ok) return fracDollar.err
  const fraction = parseArg(args[1])
  if (!fraction.ok) return fraction.err
  const denominator = Math.trunc(fraction.n)
  if (denominator < 0) return ERR('#NUM!')
  if (denominator < 1) return ERR('#DIV/0!')
  const sign = fracDollar.n < 0 ? -1 : 1
  const absolute = Math.abs(fracDollar.n)
  const intPart = Math.trunc(absolute)
  const fracPart = absolute - intPart
  const scale = Math.pow(10, Math.ceil(Math.log10(denominator)))
  return finiteNumber(sign * (intPart + fracPart * scale / denominator))
}

export const DOLLARFR: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const decDollar = parseArg(args[0])
  if (!decDollar.ok) return decDollar.err
  const fraction = parseArg(args[1])
  if (!fraction.ok) return fraction.err
  const denominator = Math.trunc(fraction.n)
  if (denominator < 0) return ERR('#NUM!')
  if (denominator < 1) return ERR('#DIV/0!')
  const sign = decDollar.n < 0 ? -1 : 1
  const absolute = Math.abs(decDollar.n)
  const intPart = Math.trunc(absolute)
  const decPart = absolute - intPart
  const scale = Math.pow(10, Math.ceil(Math.log10(denominator)))
  return finiteNumber(sign * (intPart + decPart * denominator / scale))
}

export const ACCRINT: FunctionImpl = (args) => {
  if (args.length < 6 || args.length > 8) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const issue = parseArg(args[0])
  if (!issue.ok) return issue.err
  const firstInterest = parseArg(args[1])
  if (!firstInterest.ok) return firstInterest.err
  const settlement = parseArg(args[2])
  if (!settlement.ok) return settlement.err
  const rate = parseArg(args[3])
  if (!rate.ok) return rate.err
  const par = parseArg(args[4])
  if (!par.ok) return par.err
  const frequency = parseFrequency(args[5])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 6)
  if (!basis.ok) return basis.err
  let calcMethod = true
  if (args.length === 8) {
    const parsedCalcMethod = parseArg(args[7])
    if (!parsedCalcMethod.ok) return parsedCalcMethod.err
    calcMethod = parsedCalcMethod.n !== 0
  }
  if (rate.n <= 0 || par.n <= 0 || settlement.n <= issue.n) return ERR('#NUM!')
  const accrualStart = !calcMethod && settlement.n > firstInterest.n ? firstInterest.n : issue.n
  if (settlement.n <= accrualStart) return NUM(0)
  return finiteNumber(par.n * rate.n * yearFracBasis(accrualStart, settlement.n, basis.basis))
}

export const ACCRINTM: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const issue = parseArg(args[0])
  if (!issue.ok) return issue.err
  const settlement = parseArg(args[1])
  if (!settlement.ok) return settlement.err
  const rate = parseArg(args[2])
  if (!rate.ok) return rate.err
  const par = parseArg(args[3])
  if (!par.ok) return par.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (rate.n <= 0 || par.n <= 0 || settlement.n <= issue.n) return ERR('#NUM!')
  return finiteNumber(par.n * rate.n * yearFracBasis(issue.n, settlement.n, basis.basis))
}

export const DISC: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const pr = parseArg(args[2])
  if (!pr.ok) return pr.err
  const redemption = parseArg(args[3])
  if (!redemption.ok) return redemption.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (pr.n <= 0 || redemption.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const yf = yearFracBasis(settlement.n, maturity.n, basis.basis)
  if (yf === 0) return ERR('#DIV/0!')
  return finiteNumber((redemption.n - pr.n) / redemption.n / yf)
}

export const INTRATE: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const investment = parseArg(args[2])
  if (!investment.ok) return investment.err
  const redemption = parseArg(args[3])
  if (!redemption.ok) return redemption.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (investment.n <= 0 || redemption.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const yf = yearFracBasis(settlement.n, maturity.n, basis.basis)
  if (yf === 0) return ERR('#DIV/0!')
  return finiteNumber((redemption.n - investment.n) / investment.n / yf)
}

export const RECEIVED: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const investment = parseArg(args[2])
  if (!investment.ok) return investment.err
  const discount = parseArg(args[3])
  if (!discount.ok) return discount.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (investment.n <= 0 || discount.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const denom = 1 - discount.n * yearFracBasis(settlement.n, maturity.n, basis.basis)
  if (denom <= 0) return ERR('#NUM!')
  return finiteNumber(investment.n / denom)
}

export const TBILLEQ: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const discount = parseArg(args[2])
  if (!discount.ok) return discount.err
  if (discount.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const diff = dayDiff(settlement.n, maturity.n)
  if (diff > 365) return ERR('#NUM!')
  const denom = 360 - discount.n * diff
  if (denom <= 0) return ERR('#NUM!')
  return finiteNumber(365 * discount.n / denom)
}

export const TBILLPRICE: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const discount = parseArg(args[2])
  if (!discount.ok) return discount.err
  if (discount.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const diff = dayDiff(settlement.n, maturity.n)
  if (diff > 365) return ERR('#NUM!')
  return finiteNumber(100 * (1 - discount.n * diff / 360))
}

export const TBILLYIELD: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const pr = parseArg(args[2])
  if (!pr.ok) return pr.err
  if (pr.n <= 0 || maturity.n <= settlement.n) return ERR('#NUM!')
  const diff = dayDiff(settlement.n, maturity.n)
  if (diff <= 0 || diff > 365) return ERR('#NUM!')
  return finiteNumber((100 - pr.n) / pr.n * 360 / diff)
}

export const DURATION: FunctionImpl = (args) => {
  if (args.length < 5 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const coupon = parseArg(args[2])
  if (!coupon.ok) return coupon.err
  const yld = parseArg(args[3])
  if (!yld.ok) return yld.err
  const frequency = parseFrequency(args[4])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 5)
  if (!basis.ok) return basis.err
  if (coupon.n < 0 || yld.n < 0 || settlement.n >= maturity.n) return ERR('#NUM!')
  return finiteNumber(
    macaulayDuration(
      settlement.n,
      maturity.n,
      coupon.n,
      yld.n,
      frequency.frequency,
      basis.basis,
    ),
  )
}

export const MDURATION: FunctionImpl = (args) => {
  if (args.length < 5 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const coupon = parseArg(args[2])
  if (!coupon.ok) return coupon.err
  const yld = parseArg(args[3])
  if (!yld.ok) return yld.err
  const frequency = parseFrequency(args[4])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 5)
  if (!basis.ok) return basis.err
  if (coupon.n < 0 || yld.n < 0 || settlement.n >= maturity.n) return ERR('#NUM!')
  const denom = 1 + yld.n / frequency.frequency
  if (denom === 0) return ERR('#DIV/0!')
  const duration = macaulayDuration(
    settlement.n,
    maturity.n,
    coupon.n,
    yld.n,
    frequency.frequency,
    basis.basis,
  )
  return finiteNumber(duration / denom)
}

export const PRICE: FunctionImpl = (args) => {
  if (args.length < 6 || args.length > 7) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const rate = parseArg(args[2])
  if (!rate.ok) return rate.err
  const yld = parseArg(args[3])
  if (!yld.ok) return yld.err
  const redemption = parseArg(args[4])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[5])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 6)
  if (!basis.ok) return basis.err
  if (rate.n < 0 || yld.n < 0 || redemption.n <= 0 || settlement.n >= maturity.n) {
    return ERR('#NUM!')
  }
  return finiteNumber(
    priceFromYield(
      settlement.n,
      maturity.n,
      rate.n,
      yld.n,
      redemption.n,
      frequency.frequency,
      basis.basis,
    ),
  )
}

export const YIELD: FunctionImpl = (args) => {
  if (args.length < 6 || args.length > 7) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const rate = parseArg(args[2])
  if (!rate.ok) return rate.err
  const pr = parseArg(args[3])
  if (!pr.ok) return pr.err
  const redemption = parseArg(args[4])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[5])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 6)
  if (!basis.ok) return basis.err
  if (rate.n < 0 || pr.n <= 0 || redemption.n <= 0 || settlement.n >= maturity.n) {
    return ERR('#NUM!')
  }

  let yld = Math.max(rate.n, 0.05)
  for (let i = 0; i < BOND_MAX_ITERS; i += 1) {
    const price = priceFromYield(
      settlement.n,
      maturity.n,
      rate.n,
      yld,
      redemption.n,
      frequency.frequency,
      basis.basis,
    )
    const dy = 1e-6
    const price2 = priceFromYield(
      settlement.n,
      maturity.n,
      rate.n,
      yld + dy,
      redemption.n,
      frequency.frequency,
      basis.basis,
    )
    if (!Number.isFinite(price) || !Number.isFinite(price2)) return ERR('#NUM!')
    const diff = price - pr.n
    if (Math.abs(diff) < NR_TOLERANCE) return NUM(yld)
    const fp = (price2 - price) / dy
    if (fp === 0 || !Number.isFinite(fp)) return ERR('#NUM!')
    const next = yld - diff / fp
    if (!Number.isFinite(next)) return ERR('#NUM!')
    if (Math.abs(next - yld) < 1e-9) return NUM(next)
    yld = next
  }
  return ERR('#NUM!')
}

export const PRICEDISC: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const discount = parseArg(args[2])
  if (!discount.ok) return discount.err
  const redemption = parseArg(args[3])
  if (!redemption.ok) return redemption.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (discount.n <= 0 || redemption.n <= 0 || settlement.n >= maturity.n) return ERR('#NUM!')
  const yf = yearFracBasis(settlement.n, maturity.n, basis.basis)
  return finiteNumber(redemption.n * (1 - discount.n * yf))
}

export const YIELDDISC: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 5) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const pr = parseArg(args[2])
  if (!pr.ok) return pr.err
  const redemption = parseArg(args[3])
  if (!redemption.ok) return redemption.err
  const basis = parseBasis(args, 4)
  if (!basis.ok) return basis.err
  if (pr.n <= 0 || redemption.n <= 0 || settlement.n >= maturity.n) return ERR('#NUM!')
  const yf = yearFracBasis(settlement.n, maturity.n, basis.basis)
  if (yf === 0) return ERR('#DIV/0!')
  return finiteNumber((redemption.n - pr.n) / pr.n / yf)
}

export const PRICEMAT: FunctionImpl = (args) => {
  if (args.length < 5 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const issue = parseArg(args[2])
  if (!issue.ok) return issue.err
  const rate = parseArg(args[3])
  if (!rate.ok) return rate.err
  const yld = parseArg(args[4])
  if (!yld.ok) return yld.err
  const basis = parseBasis(args, 5)
  if (!basis.ok) return basis.err
  if (rate.n < 0 || yld.n < 0 || settlement.n >= maturity.n || issue.n >= settlement.n) {
    return ERR('#NUM!')
  }
  const dim = yearFracBasis(issue.n, maturity.n, basis.basis)
  const a = yearFracBasis(issue.n, settlement.n, basis.basis)
  const dsm = yearFracBasis(settlement.n, maturity.n, basis.basis)
  const denom = 1 + dsm * yld.n
  if (denom === 0) return ERR('#DIV/0!')
  return finiteNumber((100 + dim * rate.n * 100) / denom - a * rate.n * 100)
}

export const YIELDMAT: FunctionImpl = (args) => {
  if (args.length < 5 || args.length > 6) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const issue = parseArg(args[2])
  if (!issue.ok) return issue.err
  const rate = parseArg(args[3])
  if (!rate.ok) return rate.err
  const pr = parseArg(args[4])
  if (!pr.ok) return pr.err
  const basis = parseBasis(args, 5)
  if (!basis.ok) return basis.err
  if (rate.n < 0 || pr.n <= 0 || settlement.n >= maturity.n || issue.n >= settlement.n) {
    return ERR('#NUM!')
  }
  const dim = yearFracBasis(issue.n, maturity.n, basis.basis)
  const a = yearFracBasis(issue.n, settlement.n, basis.basis)
  const dsm = yearFracBasis(settlement.n, maturity.n, basis.basis)
  if (dsm === 0) return ERR('#DIV/0!')
  const denom = pr.n / 100 + a * rate.n
  if (denom === 0) return ERR('#DIV/0!')
  return finiteNumber(((1 + dim * rate.n) / denom - 1) / dsm)
}

function addCouponPeriods(quasiDate: number, frequency: number, periods: number): number {
  const monthsPerPeriod = 12 / frequency
  const parts = serialDateToParts(quasiDate)
  const monthIndex = parts.year * 12 + (parts.month - 1) + periods * monthsPerPeriod
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12 + 1
  const day = Math.min(parts.day, daysInMonth(year, month))
  return serialFromDateParts(year, month, day)
}

function ncQuasiDatesBetween(start: number, end: number, frequency: number): number {
  if (end <= start) return 0
  const monthsPerPeriod = 12 / frequency
  const endParts = serialDateToParts(end)
  let periods = 0
  while (periods <= 4_000) {
    const monthIndex = endParts.year * 12 + (endParts.month - 1) - periods * monthsPerPeriod
    const year = Math.floor(monthIndex / 12)
    const month = ((monthIndex % 12) + 12) % 12 + 1
    const day = Math.min(endParts.day, daysInMonth(year, month))
    const serial = serialFromDateParts(year, month, day)
    if (serial <= start) return periods
    periods += 1
  }
  return periods
}

function oddfpriceFromYield(
  settlement: number,
  maturity: number,
  issue: number,
  firstCoupon: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): number {
  const onePlus = 1 + yld / frequency
  if (onePlus <= 0) return Number.NaN
  const coupon = 100 * rate / frequency
  const nRegular = ncQuasiDatesBetween(firstCoupon, maturity, frequency)
  const nTotal = nRegular + 1
  const dsc = yearFracBasis(settlement, firstCoupon, basis) * frequency

  const prevQuasi = addCouponPeriods(firstCoupon, frequency, -1)
  let firstCouponPayment = 0
  let accrued = 0
  if (prevQuasi <= issue) {
    const dfc = yearFracBasis(issue, firstCoupon, basis) * frequency
    const a = yearFracBasis(issue, settlement, basis) * frequency
    firstCouponPayment = coupon * dfc
    accrued = coupon * a
  } else {
    const nq = Math.max(ncQuasiDatesBetween(issue, firstCoupon, frequency), 1)
    const quasiDates: number[] = []
    for (let i = 0; i <= nq; i += 1) {
      quasiDates.push(addCouponPeriods(firstCoupon, frequency, -i))
    }
    const qIssueLo = quasiDates[nq]
    const qIssueHi = quasiDates[nq - 1]
    const nlIssue = Math.max(qIssueHi - qIssueLo, 1)
    const dciFrac = Math.max(qIssueHi - issue, 0) / nlIssue
    const firstPeriodCouponFrac = dciFrac + nq - 1
    let accruedPeriods = 0
    if (settlement <= qIssueHi) {
      accruedPeriods = Math.max(settlement - issue, 0) / nlIssue
    } else {
      let frac = dciFrac
      let found = false
      for (let i = 1; i < nq; i += 1) {
        const qLo = quasiDates[nq - i]
        const qHi = quasiDates[nq - i - 1]
        if (settlement >= qLo && settlement <= qHi) {
          const nl = Math.max(qHi - qLo, 1)
          frac += Math.max(settlement - qLo, 0) / nl
          found = true
          break
        }
        frac += 1
      }
      accruedPeriods = found ? frac : firstPeriodCouponFrac
    }
    firstCouponPayment = coupon * firstPeriodCouponFrac
    accrued = coupon * accruedPeriods
  }

  let pv = firstCouponPayment / Math.pow(onePlus, dsc)
  for (let k = 2; k <= nTotal; k += 1) {
    pv += coupon / Math.pow(onePlus, dsc + k - 1)
  }
  const redemptionPv = redemption / Math.pow(onePlus, dsc + nTotal - 1)
  return pv + redemptionPv - accrued
}

export const ODDFPRICE: FunctionImpl = (args) => {
  if (args.length < 8 || args.length > 9) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const issue = parseArg(args[2])
  if (!issue.ok) return issue.err
  const firstCoupon = parseArg(args[3])
  if (!firstCoupon.ok) return firstCoupon.err
  const rate = parseArg(args[4])
  if (!rate.ok) return rate.err
  const yld = parseArg(args[5])
  if (!yld.ok) return yld.err
  const redemption = parseArg(args[6])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[7])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 8)
  if (!basis.ok) return basis.err
  if (
    rate.n < 0 ||
    yld.n < 0 ||
    redemption.n <= 0 ||
    issue.n >= settlement.n ||
    settlement.n >= firstCoupon.n ||
    firstCoupon.n >= maturity.n
  ) {
    return ERR('#NUM!')
  }
  return finiteNumber(
    oddfpriceFromYield(
      settlement.n,
      maturity.n,
      issue.n,
      firstCoupon.n,
      rate.n,
      yld.n,
      redemption.n,
      frequency.frequency,
      basis.basis,
    ),
  )
}

export const ODDFYIELD: FunctionImpl = (args) => {
  if (args.length < 8 || args.length > 9) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const issue = parseArg(args[2])
  if (!issue.ok) return issue.err
  const firstCoupon = parseArg(args[3])
  if (!firstCoupon.ok) return firstCoupon.err
  const rate = parseArg(args[4])
  if (!rate.ok) return rate.err
  const pr = parseArg(args[5])
  if (!pr.ok) return pr.err
  const redemption = parseArg(args[6])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[7])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 8)
  if (!basis.ok) return basis.err
  if (
    rate.n < 0 ||
    pr.n <= 0 ||
    redemption.n <= 0 ||
    issue.n >= settlement.n ||
    settlement.n >= firstCoupon.n ||
    firstCoupon.n >= maturity.n
  ) {
    return ERR('#NUM!')
  }

  let yld = Math.max(rate.n, 0.05)
  for (let i = 0; i < BOND_MAX_ITERS; i += 1) {
    const price = oddfpriceFromYield(
      settlement.n,
      maturity.n,
      issue.n,
      firstCoupon.n,
      rate.n,
      yld,
      redemption.n,
      frequency.frequency,
      basis.basis,
    )
    const dy = 1e-6
    const price2 = oddfpriceFromYield(
      settlement.n,
      maturity.n,
      issue.n,
      firstCoupon.n,
      rate.n,
      yld + dy,
      redemption.n,
      frequency.frequency,
      basis.basis,
    )
    if (!Number.isFinite(price) || !Number.isFinite(price2)) return ERR('#NUM!')
    const diff = price - pr.n
    if (Math.abs(diff) < NR_TOLERANCE) return NUM(yld)
    const fp = (price2 - price) / dy
    if (fp === 0 || !Number.isFinite(fp)) return ERR('#NUM!')
    const next = yld - diff / fp
    if (!Number.isFinite(next)) return ERR('#NUM!')
    if (Math.abs(next - yld) < 1e-9) return NUM(next)
    yld = next
  }
  return ERR('#NUM!')
}

function oddlpriceFromYield(
  settlement: number,
  maturity: number,
  lastInterest: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): number {
  let prevQuasi = lastInterest
  let periods = 1
  while (periods <= 4_000) {
    const nextQuasi = addCouponPeriods(lastInterest, frequency, periods)
    if (nextQuasi > settlement) break
    prevQuasi = nextQuasi
    periods += 1
  }
  if (periods > 4_000) return Number.NaN

  const aPeriods = yearFracBasis(prevQuasi, settlement, basis) * frequency
  const dsmPeriods = yearFracBasis(settlement, maturity, basis) * frequency
  const coupon = 100 * rate / frequency
  const factor = 1 + dsmPeriods * yld / frequency
  if (factor === 0 || !Number.isFinite(factor)) return Number.NaN
  return (dsmPeriods * coupon + redemption) / factor - aPeriods * coupon
}

export const ODDLPRICE: FunctionImpl = (args) => {
  if (args.length < 7 || args.length > 8) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const lastInterest = parseArg(args[2])
  if (!lastInterest.ok) return lastInterest.err
  const rate = parseArg(args[3])
  if (!rate.ok) return rate.err
  const yld = parseArg(args[4])
  if (!yld.ok) return yld.err
  const redemption = parseArg(args[5])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[6])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 7)
  if (!basis.ok) return basis.err
  if (
    rate.n < 0 ||
    yld.n < 0 ||
    redemption.n <= 0 ||
    lastInterest.n >= settlement.n ||
    settlement.n >= maturity.n
  ) {
    return ERR('#NUM!')
  }
  return finiteNumber(
    oddlpriceFromYield(
      settlement.n,
      maturity.n,
      lastInterest.n,
      rate.n,
      yld.n,
      redemption.n,
      frequency.frequency,
      basis.basis,
    ),
  )
}

export const ODDLYIELD: FunctionImpl = (args) => {
  if (args.length < 7 || args.length > 8) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const settlement = parseArg(args[0])
  if (!settlement.ok) return settlement.err
  const maturity = parseArg(args[1])
  if (!maturity.ok) return maturity.err
  const lastInterest = parseArg(args[2])
  if (!lastInterest.ok) return lastInterest.err
  const rate = parseArg(args[3])
  if (!rate.ok) return rate.err
  const pr = parseArg(args[4])
  if (!pr.ok) return pr.err
  const redemption = parseArg(args[5])
  if (!redemption.ok) return redemption.err
  const frequency = parseFrequency(args[6])
  if (!frequency.ok) return frequency.err
  const basis = parseBasis(args, 7)
  if (!basis.ok) return basis.err
  if (
    rate.n < 0 ||
    pr.n <= 0 ||
    redemption.n <= 0 ||
    lastInterest.n >= settlement.n ||
    settlement.n >= maturity.n
  ) {
    return ERR('#NUM!')
  }

  let prevQuasi = lastInterest.n
  let periods = 1
  while (periods <= 4_000) {
    const nextQuasi = addCouponPeriods(lastInterest.n, frequency.frequency, periods)
    if (nextQuasi > settlement.n) break
    prevQuasi = nextQuasi
    periods += 1
  }
  if (periods > 4_000) return ERR('#NUM!')

  const f = frequency.frequency
  const aPeriods = yearFracBasis(prevQuasi, settlement.n, basis.basis) * f
  const dsmPeriods = yearFracBasis(settlement.n, maturity.n, basis.basis) * f
  if (dsmPeriods === 0) return ERR('#DIV/0!')
  const coupon = 100 * rate.n / f
  const denom = pr.n + aPeriods * coupon
  if (denom === 0) return ERR('#DIV/0!')
  return finiteNumber(f / dsmPeriods * ((dsmPeriods * coupon + redemption.n) / denom - 1))
}

export const COUPDAYBS: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  return NUM(Math.max(dayDiff(
    prevCouponDate(parsed.settlement, parsed.maturity, parsed.frequency),
    parsed.settlement,
  ), 0))
}

export const COUPDAYS: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  if (parsed.basis === 1) {
    return NUM(dayDiff(
      prevCouponDate(parsed.settlement, parsed.maturity, parsed.frequency),
      nextCouponDate(parsed.settlement, parsed.maturity, parsed.frequency),
    ))
  }
  return finiteNumber(couponPeriodDays(parsed.frequency, parsed.basis))
}

export const COUPDAYSNC: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  const next = nextCouponDate(parsed.settlement, parsed.maturity, parsed.frequency)
  if (parsed.basis === 1) return NUM(Math.max(dayDiff(parsed.settlement, next), 0))
  const { dsc } = couponPeriodSplit(
    parsed.settlement,
    parsed.maturity,
    parsed.frequency,
    parsed.basis,
  )
  return finiteNumber(dsc)
}

export const COUPNCD: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  return NUM(nextCouponDate(parsed.settlement, parsed.maturity, parsed.frequency))
}

export const COUPNUM: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  return finiteNumber(couponNumber(parsed.settlement, parsed.maturity, parsed.frequency))
}

export const COUPPCD: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const parsed = parseSettlementMaturityFrequencyBasis(args)
  if (!parsed.ok) return parsed.err
  return NUM(prevCouponDate(parsed.settlement, parsed.maturity, parsed.frequency))
}

type NumberList = { ok: true; values: number[] } | { ok: false; err: Value }

function collectStrictNumbers(arg: Value, floorValues = false): NumberList {
  const out: number[] = []
  const visit = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) {
          const err = visit(cell)
          if (err) return err
        }
      }
      return undefined
    }
    if (value.kind === 'blank') return undefined
    if (value.kind !== 'number') return ERR('#VALUE!')
    if (!Number.isFinite(value.value)) return ERR('#NUM!')
    out.push(floorValues ? Math.floor(value.value) : value.value)
    return undefined
  }
  const err = visit(arg)
  if (err) return { ok: false, err }
  return { ok: true, values: out }
}

function collectScheduleRates(arg: Value): NumberList {
  const out: number[] = []
  const visit = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) {
          const err = visit(cell)
          if (err) return err
        }
      }
      return undefined
    }
    if (value.kind === 'blank') return undefined
    const n = toNumber(value)
    if (!n.ok) return n.error
    if (!Number.isFinite(n.value)) return ERR('#NUM!')
    out.push(n.value)
    return undefined
  }
  const err = visit(arg)
  if (err) return { ok: false, err }
  return { ok: true, values: out }
}

export const FVSCHEDULE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const principal = parseArg(args[0])
  if (!principal.ok) return principal.err
  const rates = collectScheduleRates(args[1])
  if (!rates.ok) return rates.err
  let product = principal.n
  for (const rate of rates.values) {
    product *= 1 + rate
  }
  if (!Number.isFinite(product)) return ERR('#NUM!')
  return NUM(product)
}

export const MIRR: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const flows = collectCashflows([args[0]])
  if (!flows.ok) return flows.err
  const financeRate = parseArg(args[1])
  if (!financeRate.ok) return financeRate.err
  const reinvestRate = parseArg(args[2])
  if (!reinvestRate.ok) return reinvestRate.err

  let hasPos = false
  let hasNeg = false
  for (const value of flows.values) {
    if (value > 0) hasPos = true
    if (value < 0) hasNeg = true
  }
  if (!hasPos || !hasNeg || flows.values.length < 2) return ERR('#DIV/0!')
  if (financeRate.n <= -1 || reinvestRate.n <= -1) return ERR('#NUM!')

  const n = flows.values.length
  let pvNeg = 0
  let fvPos = 0
  for (let i = 0; i < n; i++) {
    const value = flows.values[i]
    if (value < 0) {
      const denom = Math.pow(1 + financeRate.n, i)
      if (denom === 0 || !Number.isFinite(denom)) return ERR('#NUM!')
      pvNeg += value / denom
    } else if (value > 0) {
      const pow = Math.pow(1 + reinvestRate.n, n - 1 - i)
      if (!Number.isFinite(pow)) return ERR('#NUM!')
      fvPos += value * pow
    }
  }
  if (pvNeg === 0) return ERR('#DIV/0!')
  const ratio = -fvPos / pvNeg
  if (ratio <= 0 || !Number.isFinite(ratio)) return ERR('#NUM!')
  const result = Math.pow(ratio, 1 / (n - 1)) - 1
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

type XirrPair = { date: number; value: number }
type XirrPairs = { ok: true; pairs: XirrPair[] } | { ok: false; err: Value }

function collectXirrPairs(valuesArg: Value, datesArg: Value): XirrPairs {
  const values = collectStrictNumbers(valuesArg)
  if (!values.ok) return { ok: false, err: values.err }
  const dates = collectStrictNumbers(datesArg, true)
  if (!dates.ok) return { ok: false, err: dates.err }
  if (values.values.length !== dates.values.length || values.values.length < 2) {
    return { ok: false, err: ERR('#NUM!') }
  }
  const pairs = values.values.map((value, i) => ({ date: dates.values[i], value }))
  const startDate = pairs[0].date
  for (const pair of pairs) {
    if (pair.date < startDate) return { ok: false, err: ERR('#NUM!') }
  }
  return { ok: true, pairs }
}

export const XNPV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  if (rate.n <= -1) return ERR('#NUM!')
  const pairs = collectXirrPairs(args[1], args[2])
  if (!pairs.ok) return pairs.err
  const d0 = pairs.pairs[0].date
  const base = 1 + rate.n
  if (base <= 0 || !Number.isFinite(base)) return ERR('#NUM!')

  let total = 0
  for (const pair of pairs.pairs) {
    const t = (pair.date - d0) / 365
    const denom = Math.pow(base, t)
    if (denom === 0 || !Number.isFinite(denom)) return ERR('#NUM!')
    total += pair.value / denom
  }
  if (!Number.isFinite(total)) return ERR('#NUM!')
  return NUM(total)
}

export const XIRR: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const pairs = collectXirrPairs(args[0], args[1])
  if (!pairs.ok) return pairs.err

  let hasPos = false
  let hasNeg = false
  for (const pair of pairs.pairs) {
    if (pair.value > 0) hasPos = true
    if (pair.value < 0) hasNeg = true
  }
  if (!hasPos || !hasNeg) return ERR('#NUM!')

  let rate = 0.1
  if (args.length === 3) {
    const guess = parseArg(args[2])
    if (!guess.ok) return guess.err
    rate = guess.n
  }
  if (rate <= -1) return ERR('#NUM!')

  const d0 = pairs.pairs[0].date
  for (let i = 0; i < XIRR_MAX_ITERS; i++) {
    const base = 1 + rate
    if (base <= 0 || !Number.isFinite(base)) return ERR('#NUM!')
    let f = 0
    let fp = 0
    let scale = 0
    for (const pair of pairs.pairs) {
      const t = (pair.date - d0) / 365
      const denom = Math.pow(base, t)
      if (denom === 0 || !Number.isFinite(denom)) return ERR('#NUM!')
      const term = pair.value / denom
      f += term
      scale += Math.abs(term)
      fp += -t * pair.value / (denom * base)
    }
    if (!Number.isFinite(f) || !Number.isFinite(fp)) return ERR('#NUM!')
    if (residualConverged(f, scale)) return NUM(rate)
    if (fp === 0) return ERR('#NUM!')
    const next = rate - f / fp
    if (!Number.isFinite(next)) return ERR('#NUM!')
    if (Math.abs(next - rate) < NR_TOLERANCE) {
      const nextBase = 1 + next
      if (nextBase <= 0 || !Number.isFinite(nextBase)) return ERR('#NUM!')
      let nextResidual = 0
      let nextScale = 0
      for (const pair of pairs.pairs) {
        const t = (pair.date - d0) / 365
        const denom = Math.pow(nextBase, t)
        if (denom === 0 || !Number.isFinite(denom)) return ERR('#NUM!')
        const term = pair.value / denom
        nextResidual += term
        nextScale += Math.abs(term)
      }
      return residualConverged(nextResidual, nextScale) ? NUM(next) : ERR('#NUM!')
    }
    rate = next
  }
  const finalBase = 1 + rate
  if (finalBase <= 0 || !Number.isFinite(finalBase)) return ERR('#NUM!')
  let finalResidual = 0
  let finalScale = 0
  for (const pair of pairs.pairs) {
    const t = (pair.date - d0) / 365
    const denom = Math.pow(finalBase, t)
    if (denom === 0 || !Number.isFinite(denom)) return ERR('#NUM!')
    const term = pair.value / denom
    finalResidual += term
    finalScale += Math.abs(term)
  }
  if (residualConverged(finalResidual, finalScale)) return NUM(rate)
  return ERR('#NUM!')
}

export const PDURATION: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const rate = parseArg(args[0])
  if (!rate.ok) return rate.err
  const pv = parseArg(args[1])
  if (!pv.ok) return pv.err
  const fv = parseArg(args[2])
  if (!fv.ok) return fv.err
  if (rate.n <= 0 || pv.n <= 0 || fv.n <= 0) return ERR('#NUM!')
  const logBase = Math.log(1 + rate.n)
  if (logBase === 0) return ERR('#DIV/0!')
  const result = Math.log(fv.n / pv.n) / logBase
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

export const RRI: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR('#VALUE!')
  const err = propagateError(args)
  if (err) return err
  const nper = parseArg(args[0])
  if (!nper.ok) return nper.err
  const pv = parseArg(args[1])
  if (!pv.ok) return pv.err
  const fv = parseArg(args[2])
  if (!fv.ok) return fv.err
  if (nper.n <= 0 || pv.n <= 0 || fv.n <= 0) return ERR('#NUM!')
  const result = Math.pow(fv.n / pv.n, 1 / nper.n) - 1
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
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
  SLN,
  SYD,
  DB,
  DDB,
  VDB,
  AMORDEGRC,
  AMORLINC,
  CUMPRINC,
  EFFECT,
  NOMINAL,
  ISPMT,
  ACCRINT,
  ACCRINTM,
  DISC,
  INTRATE,
  RECEIVED,
  DURATION,
  MDURATION,
  TBILLEQ,
  TBILLPRICE,
  TBILLYIELD,
  PRICE,
  YIELD,
  PRICEDISC,
  YIELDDISC,
  PRICEMAT,
  YIELDMAT,
  ODDFPRICE,
  ODDFYIELD,
  ODDLPRICE,
  ODDLYIELD,
  DOLLARDE,
  DOLLARFR,
  COUPDAYBS,
  COUPDAYS,
  COUPDAYSNC,
  COUPNCD,
  COUPNUM,
  COUPPCD,
  XIRR,
  XNPV,
  MIRR,
  PDURATION,
  RRI,
  FVSCHEDULE,
}
